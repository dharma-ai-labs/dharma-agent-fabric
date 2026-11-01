import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import {createHash, generateKeyPairSync, randomUUID} from 'node:crypto';
import {dirname, resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {runInNewContext} from 'node:vm';
import test from 'node:test';
import ts from 'typescript';
import {assertPolicy, loadOrganizationPolicy} from '@dharma-ai-labs/agent-fabric-policy';
import {signCanonicalObject} from '@dharma-ai-labs/agent-fabric-contracts';
import {AgentFabricClient, loadOrCreateDeviceIdentity, saveDeviceConfig, saveDeviceEnrollmentAnchor, withDeviceSigningControl,
  type DeviceConfig, type SecureSecretStore} from '@dharma-ai-labs/agent-fabric-relay-client';
import {currentBootstrapHostScope} from './bootstrapHostScope.js';
import {writeBootstrapHostJson} from './bootstrapHostFiles.js';
import {applyServerEvidencePolicy, pathExistsOrThrow} from './index.js';
import {withRepositoryRelayStage} from './repositoryRelaySupervisor.js';

// Issue 397. The real sync, apply, lock, signing control and verification bodies
// run against real files. Only the server, the provider probes and the rename and
// link boundaries are observable, so every ordering below is forced by a gate:
// nothing sleeps and nothing races.
const EARLIER = '2026-10-31T18:58:01.000Z', OLDER = '2026-10-31T18:59:16.731Z', NEWER = '2026-10-31T19:00:34.925Z';
const NEWEST = '2026-10-31T19:01:52.118Z';
const REFUSAL = 'Server workspace policy authorization is older than the last accepted authorization.';
const ORGANIZATION = 'org_demo', WORKSPACE = '00000005-1111-4111-8111-111111111111';
const COMPILED = ['materializeWorkspacePolicy', 'workspaceAuthorizationStatePath', 'assertWorkspaceAuthorizationCurrent',
  'applyWorkspaceAuthorizationAtomically', 'newEvidenceUploadLedger', 'assertEvidenceLedger',
  'evidenceLedgerForPolicyActivation', 'pathExists', 'acquirePidLock', 'withFileLock', 'writeJsonAtomic',
  'reconcileWorkspaceRegistration', 'relayStart', 'relayWorkspaceLoop'];

type Turn = {issuedAt: string; revision?: string; unreachable?: boolean; signed?: () => void; respond?: Promise<void>};
type Hooks = {rename?: (from: string, to: string) => void | Promise<void>; contended?: (lockPath: string) => void;
  probe?: () => Promise<void>; signing?: () => Promise<void>; request?: () => Promise<void>};
type Compiled = Record<string, (...args: any[]) => Promise<any>>;

function deferred() {
  let accept!: () => void;
  const promise = new Promise<void>(done => {accept = done;});
  return {promise, resolve: accept};
}

async function compile(context: Record<string, unknown>) {
  const source = await fs.readFile(new URL('../src/index.ts', import.meta.url), 'utf8');
  const ast = ts.createSourceFile('index.ts', source, ts.ScriptTarget.Latest, true);
  const functions = ast.statements.filter(ts.isFunctionDeclaration);
  const names = [...new Set([...COMPILED, ...functions.map(node => node.name?.text ?? '').filter(name => /workspacepolicy/i.test(name))])];
  const declarations = names.map(name => {
    const nodes = functions.filter(node => node.name?.text === name);
    assert.equal(nodes.length, 1, name);
    return nodes[0]!.getText(ast);
  });
  const output = ts.transpileModule(declarations.join('\n'), {compilerOptions: {
    target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.None}, reportDiagnostics: true});
  assert.equal(output.diagnostics?.filter(item => item.category === ts.DiagnosticCategory.Error).length, 0);
  return runInNewContext(`${output.outputText}\n({${names.join(',')}})`, context,
    {timeout: 1000, contextCodeGeneration: {strings: false, wasm: false}}) as Compiled;
}

async function fixture(t: {after(fn: () => Promise<void>): void}, turns: Turn[], overrides: Record<string, unknown> = {}) {
  const root = await fs.realpath(await fs.mkdtemp(resolve(tmpdir(), 'dharma-policy-sync-race-')));
  t.after(() => fs.rm(root, {recursive: true, force: true}));
  const workspace = resolve(root, 'workspace'), home = resolve(root, 'home');
  await fs.mkdir(workspace);
  await fs.writeFile(resolve(workspace, 'package.json'), JSON.stringify({scripts: {test: 'node --test'}}));
  const keys = generateKeyPairSync('ed25519'), publicKey = keys.publicKey.export({format: 'jwk'}).x!;
  const hooks: Hooks = {}, logged: string[] = [], ran: string[] = [];
  const policyPath = resolve(workspace, '.dharma', 'approved-policy.json');
  const statePath = resolve(home, 'registry', 'workspace-authorizations', `${WORKSPACE}.json`);
  const config = {hqUrl: 'https://www.dharma-ai.io', organizationId: ORGANIZATION, deviceId: randomUUID()};
  const signing = <T>(work: () => Promise<T>, timeoutMs?: number) =>
    withDeviceSigningControl({config, ...(timeoutMs ? {timeoutMs} : {})}, work);
  // The real primitive has no contention hook, so a short first attempt reports it.
  const signingWithContention = async <T>(input: Parameters<typeof withDeviceSigningControl>[0], work: () => Promise<T>) => {
    let entered = false;
    const run = () => {entered = true; return work();};
    try {return await withDeviceSigningControl({...input, timeoutMs: 50}, run);}
    catch (error) {
      if (entered || (error as Error).message !== 'connection_anchor_busy') throw error;
      hooks.contended?.('device signing control');
      return withDeviceSigningControl(input, run);
    }
  };
  const item = {workspaceId: WORKSPACE, organizationId: ORGANIZATION, name: 'demo', path: workspace,
    routeHash: `sha256:${'a'.repeat(64)}`, repositoryRemoteHash: `sha256:${'b'.repeat(64)}`, status: 'active'};
  const authorization = (issuedAt: string, revision = 'signed-test-policy') => {
    const unsigned = {schema: 'dharma.workspace-policy-authorization/v1', organizationId: ORGANIZATION, workspaceId: WORKSPACE,
      policy: {revision, evidence: {automaticDisclosure: {mode: 'customer_authorized_content',
        consentReceiptId: 'synthetic-consent', allowedContentClasses: ['native_provider_payload']},
        maximumCapsuleBytes: 1000, maximumDailyUploadBytes: 10000, maximumExpansionBytes: 100,
        excludePaths: ['**/.env', '**/*.key'], pseudonymizeIdentity: true}},
      issuedAt, expiresAt: new Date(Date.now() + 86_400_000).toISOString(), keyVersion: 'synthetic'};
    return {...unsigned, signature: signCanonicalObject(unsigned, keys.privateKey)};
  };
  let sessions = 0;
  // Like the real client, the request holds signing control and the reply does not.
  const server = {config, registerWorkspace: async () => {
    const turn = turns.shift();
    assert.ok(turn, 'the fixture server was asked for more authorizations than the test scripted');
    await hooks.request?.();
    const signed = await signing(async () => {
      if (turn.unreachable) throw new Error('fixture server unreachable');
      const value = authorization(turn.issuedAt, turn.revision);
      turn.signed?.();
      return value;
    });
    await turn.respond;
    return {ok: true, organizationId: ORGANIZATION, organizationPolicyAuthorization: signed,
      workspace: {id: WORKSPACE, status: 'active', policyRevision: 'signed-test-policy'}};
  }};
  const compiled = await compile({...fs, dirname, resolve, createHash, randomUUID, Buffer, Date, setTimeout, structuredClone,
    process: {platform: process.platform, pid: process.pid, kill: process.kill.bind(process), once() {}, removeListener() {},
      stderr: {write: (line: string) => logged.push(line)}},
    AbortController, performance, withRepositoryRelayStage,
    withDeviceSigningControl: async (input: Parameters<typeof withDeviceSigningControl>[0], work: () => Promise<unknown>) => {
      await hooks.signing?.();
      return signingWithContention(input, work);
    },
    required: (flags: Map<string, string>, name: string) => flags.get(name),
    client: async () => {sessions += 1; return server;}, acquireRelayProcessLease: async () => async () => undefined,
    selectRepositoryRelayRegistrations: async () => [{workspaceId: WORKSPACE, policyPath}],
    serializeRelayWork: () => (operation: () => Promise<unknown>) => operation(),
    RepositorySourceWatcher: class {}, BlockedRepositorySourceRetry: class {},
    rawLocalRetentionDays: (policy: {serverAuthorization: {issuedAt: string}}) => {ran.push(policy.serverAuthorization.issuedAt); return 1;},
    openBootstrapVault: async () => {throw RELAY_WORK_STARTS;},
    exports: {}, currentBootstrapHostScope, writeBootstrapHostJson, pathExistsOrThrow, assertPolicy, loadOrganizationPolicy,
    applyServerEvidencePolicy, UUID_PATTERN: /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    dharmaHome: () => home, evidenceUploadLedgerPath: () => resolve(home, 'relay', 'evidence-upload-ledger.json'),
    // The real step recovers enrollment under signing control and turns a busy control into a degraded receipt.
    receiptAwareProviderCapabilities: async (providers: unknown[]) => {
      await signingWithContention({config}, async () => undefined).catch(() => undefined);
      return providers;
    },
    selectedProviderAdapters: () => [{capability: async () => {await hooks.probe?.(); return {provider: 'codex'};}}],
    registry: async () => [item], canonicalFilesystemPath: async (path: string) => path,
    readDeviceConfig: async () => ({organizationId: ORGANIZATION, serverPublicKeyEd25519: publicKey}),
    rename: async (from: string, to: string) => {await hooks.rename?.(from, to); return fs.rename(from, to);},
    link: async (from: string, to: string) => {
      try {return await fs.link(from, to);}
      catch (error) {if ((error as NodeJS.ErrnoException).code === 'EEXIST') hooks.contended?.(to); throw error;}
    }, ...overrides});
  const relayOutcome = (run: () => Promise<unknown>) => run().then(() => 'relay returned', (error: Error) => {
    const cause = error.cause ?? error;
    return cause === RELAY_WORK_STARTS ? `running on ${ran.at(-1)}` : (cause as Error).message;
  });
  const denyPolicyWriteAndRestore = () => {
    let stateWrites = 0;
    hooks.rename = (_from, to) => {
      if (to === policyPath) throw Object.assign(new Error('EPERM: operation not permitted, rename'), {code: 'EPERM'});
      if (to === statePath && ++stateWrites === 2) throw Object.assign(new Error('EBUSY: resource busy, rename'), {code: 'EBUSY'});
    };
  };
  const sync = () => compiled.syncWorkspacePolicy!(server, item, 'policy-v1', true);
  return {hooks, policyPath, statePath, signing, sync, denyPolicyWriteAndRestore,
    namedTurn: <T>(work: () => Promise<T>) => signingWithContention({config}, work),
    refresh: () => compiled.refreshVerifiedWorkspacePolicyForTransmission!(policyPath, WORKSPACE, server),
    denyPolicyWrite: (denied: boolean) => {hooks.rename = denied ? (_from, to) => {
      if (to === policyPath) throw Object.assign(new Error('EPERM: operation not permitted, rename'), {code: 'EPERM'});
    } : undefined;},
    // A denied restore and a hard kill between the two renames leave these same bytes.
    strand: async () => {
      await sync();
      denyPolicyWriteAndRestore();
      await assert.rejects(sync());
      hooks.rename = undefined;
    },
    sessions: () => sessions, ran: () => ran.length, logged: () => logged.map(line => JSON.parse(line)),
    start: () => relayOutcome(() => compiled.relayStart!(new Map<string, string | boolean>([['policy', policyPath], ['once', true]]))),
    restart: () => relayOutcome(() => compiled.relayWorkspaceLoop!(new Map([['policy', policyPath]]), new AbortController().signal,
      (operation: () => Promise<unknown>) => operation())),
    observed: async () => ({
      replay: JSON.parse(await fs.readFile(statePath, 'utf8')).issuedAt as string,
      policy: (await loadOrganizationPolicy(policyPath)).serverAuthorization?.issuedAt,
      relayStart: await compiled.loadVerifiedWorkspacePolicy!(policyPath, WORKSPACE).then(() => 'verified', (error: Error) => error.message),
    })};
}

const outcome = (settled: PromiseSettledResult<unknown>) => settled.status === 'fulfilled' ? 'applied' : String(settled.reason?.message);
const RELAY_WORK_STARTS = new Error('fixture: the relay reached its first work step');

test('a policy write denied after the replay write leaves both records on the last accepted authorization', async t => {
  const f = await fixture(t, [{issuedAt: OLDER}, {issuedAt: NEWER}]);
  await f.sync();
  f.denyPolicyWrite(true);
  await assert.rejects(f.sync(), {code: 'EPERM'});
  assert.deepEqual(await f.observed(), {replay: OLDER, policy: OLDER, relayStart: 'verified'});
});

test('a reader holding the policy file open during a sync cannot leave the replay state ahead of it', async t => {
  // Every relay supervisor tick reads this file. Windows denies a rename onto a
  // file that is open; POSIX allows it. No failure is injected here.
  const f = await fixture(t, [{issuedAt: OLDER}, {issuedAt: NEWER}]);
  await f.sync();
  const reader = await fs.open(f.policyPath, 'r');
  const [second] = await Promise.allSettled([f.sync()]);
  await reader.close();
  const accepted = second.status === 'fulfilled' ? NEWER : OLDER;
  assert.deepEqual(await f.observed(), {replay: accepted, policy: accepted, relayStart: 'verified'});
});

test('overlapping syncs request and apply in one order, so neither is refused', async t => {
  const olderSigned = deferred(), newerMoved = deferred();
  const f = await fixture(t, [{issuedAt: OLDER, signed: olderSigned.resolve, respond: newerMoved.promise}, {issuedAt: NEWER}]);
  f.hooks.contended = newerMoved.resolve;
  const older = f.sync();
  await olderSigned.promise;
  const newer = f.sync();
  void newer.catch(() => undefined).finally(newerMoved.resolve);
  const [first, second] = await Promise.allSettled([older, newer]);
  assert.deepEqual({older: outcome(first), newer: outcome(second), ...await f.observed()},
    {older: 'applied', newer: 'applied', replay: NEWER, policy: NEWER, relayStart: 'verified'});
});

test('control: a newer sync cannot write between the replay and policy writes of an older sync', async t => {
  const olderWriting = deferred(), newerMoved = deferred(), writes: string[] = [];
  const f = await fixture(t, [{issuedAt: OLDER}, {issuedAt: NEWER}]);
  f.hooks.rename = async (from, to) => {
    if (to !== f.statePath && to !== f.policyPath) return;
    const value = JSON.parse(await fs.readFile(from, 'utf8'));
    if (to === f.statePath && !writes.length) {olderWriting.resolve(); await newerMoved.promise;}
    writes.push(to === f.statePath ? `replay ${value.issuedAt}` : `policy ${value.serverAuthorization.issuedAt}`);
  };
  f.hooks.contended = newerMoved.resolve;
  const older = f.sync();
  await olderWriting.promise;
  const newer = f.sync();
  void newer.catch(() => undefined).finally(newerMoved.resolve);
  await Promise.all([older, newer]);
  assert.deepEqual(writes, [`replay ${OLDER}`, `policy ${OLDER}`, `replay ${NEWER}`, `policy ${NEWER}`]);
  assert.deepEqual(await f.observed(), {replay: NEWER, policy: NEWER, relayStart: 'verified'});
});

for (const [name, replayed] of [['older', {issuedAt: OLDER}],
  ['same-time, differently signed', {issuedAt: NEWER, revision: 'same-time-other-grant'}]] as const) {
  test(`control: a genuinely ${name} authorization is still refused and writes nothing`, async t => {
    const f = await fixture(t, [{issuedAt: NEWER}, {...replayed}]);
    await f.sync();
    const policy = await fs.readFile(f.policyPath, 'utf8'), replay = await fs.readFile(f.statePath, 'utf8');
    await assert.rejects(f.sync(), {message: REFUSAL});
    assert.equal(await fs.readFile(f.policyPath, 'utf8'), policy);
    assert.equal(await fs.readFile(f.statePath, 'utf8'), replay);
    assert.equal((await f.observed()).relayStart, 'verified');
  });
}

test('control: after a denied policy write, older than the last accepted is still refused and the next sync repairs', async t => {
  const f = await fixture(t, [{issuedAt: OLDER}, {issuedAt: NEWER}, {issuedAt: EARLIER}, {issuedAt: NEWER}]);
  await f.sync();
  f.denyPolicyWrite(true);
  await assert.rejects(f.sync(), {code: 'EPERM'});
  f.denyPolicyWrite(false);
  await assert.rejects(f.sync(), {message: REFUSAL});
  assert.deepEqual(await f.observed(), {replay: OLDER, policy: OLDER, relayStart: 'verified'});
  await f.sync();
  assert.deepEqual(await f.observed(), {replay: NEWER, policy: NEWER, relayStart: 'verified'});
});

test('control: a denied first activation leaves no replay state behind', async t => {
  const f = await fixture(t, [{issuedAt: OLDER}, {issuedAt: NEWER}]);
  f.denyPolicyWrite(true);
  await assert.rejects(f.sync(), {code: 'EPERM'});
  await assert.rejects(fs.lstat(f.statePath), {code: 'ENOENT'});
  f.denyPolicyWrite(false);
  await f.sync();
  assert.deepEqual(await f.observed(), {replay: NEWER, policy: NEWER, relayStart: 'verified'});
});

test('control: a refresh lock left by a dead relay does not block the next sync', async t => {
  // The lock spans the server request, so a relay killed mid-request leaves this file behind.
  const dead = 2147483647;
  const f = await fixture(t, [{issuedAt: OLDER}], {process: {platform: process.platform, pid: process.pid,
    kill: (pid: number, signal: number) => {
      if (pid === dead) throw Object.assign(new Error('fixture dead owner'), {code: 'ESRCH'});
      return process.kill(pid, signal);
    }}});
  const lock = `${f.statePath}.refresh.lock`;
  await fs.mkdir(dirname(lock), {recursive: true});
  await fs.writeFile(lock, `${dead}\n`);
  await f.sync();
  await assert.rejects(fs.lstat(lock), {code: 'ENOENT'});
  assert.deepEqual(await f.observed(), {replay: OLDER, policy: OLDER, relayStart: 'verified'});
});

test('control: the transmission refresh keeps syncing under its own refresh lock', async t => {
  const f = await fixture(t, [{issuedAt: OLDER}, {issuedAt: NEWER}]);
  await f.sync();
  assert.equal((await f.refresh()).serverAuthorization.issuedAt, NEWER);
  assert.deepEqual(await f.observed(), {replay: NEWER, policy: NEWER, relayStart: 'verified'});
});

for (const side of ['sync', 'refresh'] as const) {
  for (const gap of ['probe', 'signing', 'request'] as const) {
    test(`a named turn and a relay ${side} stopped at its ${gap} step both finish`, async t => {
      // The named turn holds signing control for the whole turn and then refreshes.
      const relayStopped = deferred(), proceed = deferred();
      let stopped = false;
      const f = await fixture(t, [{issuedAt: OLDER}, {issuedAt: NEWER}, {issuedAt: NEWEST}]);
      await f.sync();
      f.hooks[gap] = async () => {f.hooks[gap] = undefined; stopped = true; relayStopped.resolve(); await proceed.promise;};
      f.hooks.contended = proceed.resolve;
      const relay = f[side]();
      await Promise.race([relayStopped.promise, relay.catch(() => undefined)]);
      const turn = f.namedTurn(async () => {proceed.resolve(); return f.refresh();});
      const [first, second] = await Promise.allSettled([relay, turn]);
      assert.deepEqual({stopped, relay: outcome(first), turn: outcome(second), ...await f.observed()},
        {stopped: true, relay: 'applied', turn: 'applied', replay: NEWEST, policy: NEWEST, relayStart: 'verified'});
    });
  }

  test(`provider probes during a relay ${side} hold neither lock`, async t => {
    // Six blocking spawns at 5 s each must not stall every signed request on the device.
    const probing = deferred(), checked = deferred();
    const f = await fixture(t, [{issuedAt: OLDER}, {issuedAt: NEWER}]);
    await f.sync();
    f.hooks.probe = async () => {f.hooks.probe = undefined; probing.resolve(); await checked.promise;};
    const relay = f[side]();
    await probing.promise;
    const held = {refresh: await fs.lstat(`${f.statePath}.refresh.lock`).then(() => 'held', () => 'free'),
      signing: await f.signing(async () => 'free', 50).catch((error: Error) => error.message)};
    checked.resolve();
    await relay;
    assert.deepEqual(held, {refresh: 'free', signing: 'free'});
  });
}

test('a denied restore keeps the write failure and reports that the replay state stayed ahead', async t => {
  const f = await fixture(t, [{issuedAt: OLDER}, {issuedAt: NEWER}]);
  await f.sync();
  f.denyPolicyWriteAndRestore();
  await assert.rejects(f.sync(), {code: 'EPERM'});
  assert.deepEqual(await f.observed(), {replay: NEWER, policy: OLDER, relayStart: REFUSAL});
  assert.deepEqual(f.logged(), [{event: 'workspace_policy_replay_restore_failed', workspaceId: WORKSPACE, code: 'EBUSY'}]);
});

for (const [name, entry] of [['relay start', 'start'], ['a restarted relay worker', 'restart']] as const) {
  test(`${name} re-syncs a replay state ahead of the policy file, then runs only on the verified policy`, async t => {
    const f = await fixture(t, [{issuedAt: OLDER}, {issuedAt: NEWER}, {issuedAt: NEWEST}]);
    await f.strand();
    assert.equal((await f.observed()).relayStart, REFUSAL);
    assert.equal(await f[entry](), `running on ${NEWEST}`);
    assert.deepEqual(await f.observed(), {replay: NEWEST, policy: NEWEST, relayStart: 'verified'});
    assert.equal(f.sessions(), 1);
  });
}

for (const [name, repair] of [['older', {issuedAt: OLDER}], ['same-time, differently signed', {issuedAt: NEWER, revision: 'same-time-other-grant'}],
  ['unreachable', {issuedAt: NEWEST, unreachable: true}]] as const) {
  test(`control: a repair that is ${name} leaves a stranded pair alone and the relay does not run`, async t => {
    const f = await fixture(t, [{issuedAt: OLDER}, {issuedAt: NEWER}, {...repair}]);
    await f.strand();
    const policy = await fs.readFile(f.policyPath, 'utf8'), replay = await fs.readFile(f.statePath, 'utf8');
    assert.doesNotMatch(await f.start(), /^running on/);
    assert.equal(f.ran(), 0);
    assert.equal(await fs.readFile(f.policyPath, 'utf8'), policy);
    assert.equal(await fs.readFile(f.statePath, 'utf8'), replay);
    assert.equal((await f.observed()).relayStart, REFUSAL);
  });
}

test('control: only a replay state ahead of the file re-syncs, so other refusals stay fatal with no server request', async t => {
  const missing = await fixture(t, [{issuedAt: OLDER}]);
  await missing.sync();
  await fs.rm(missing.statePath);
  assert.equal(await missing.start(), 'Workspace authorization replay state is missing or invalid; apply a fresh server policy.');
  assert.equal(missing.sessions(), 0);
  const tampered = await fixture(t, [{issuedAt: OLDER}]);
  await tampered.sync();
  const policy = JSON.parse(await fs.readFile(tampered.policyPath, 'utf8'));
  policy.serverAuthorization.signature = Buffer.alloc(64, 7).toString('base64url');
  await fs.writeFile(tampered.policyPath, JSON.stringify(policy));
  assert.doesNotMatch(await tampered.start(), /^running on/);
  assert.equal(tampered.sessions(), 0);
  assert.equal(tampered.ran(), 0);
});

test('control: a current pair starts with no extra server request', async t => {
  const f = await fixture(t, [{issuedAt: OLDER}]);
  await f.sync();
  assert.equal(await f.start(), `running on ${OLDER}`);
  assert.equal(f.sessions(), 1);
});

test('control: a signed request through the real client queue reuses the signing control its caller holds', async t => {
  // Otherwise a policy sync that holds the control would wait on its own lock until it timed out.
  const root = await fs.mkdtemp(resolve(tmpdir(), 'dharma-policy-sync-client-'));
  t.after(() => fs.rm(root, {recursive: true, force: true}));
  const values = new Map<string, string>();
  const store: SecureSecretStore = {backend: 'linux-secret-service', async get(account) {return values.get(account) ?? null;},
    async put(account, value) {values.set(account, value);}, async delete(account) {values.delete(account);}};
  const hqUrl = 'https://hq.example', organizationId = `org_fixture${randomUUID().replaceAll('-', '')}`;
  const identity = await loadOrCreateDeviceIdentity({hqUrl, organizationId, store});
  const config: DeviceConfig = {schema: 'dharma.device-config/v1', hqUrl, organizationId, deviceId: randomUUID(),
    deviceName: 'Synthetic', platform: 'linux', publicKeyEd25519: identity.publicKeyEd25519,
    serverPublicKeyEd25519: identity.publicKeyEd25519, relayUrl: 'wss://relay.example', enrolledAt: new Date().toISOString()};
  const configPath = resolve(root, 'device.json'), statePath = resolve(root, 'state.json');
  await saveDeviceConfig(configPath, config);
  await saveDeviceEnrollmentAnchor({config, store});
  const client = await AgentFabricClient.open({configPath, statePath, store,
    fetcher: async () => new Response(JSON.stringify({ok: true}), {status: 201})});
  await client.openSession();
  const reply = await withDeviceSigningControl({config: client.config}, async lease => {
    const response = await client.registerWorkspace({workspaceId: 'fixture'});
    await lease.assertHeld();
    return response;
  });
  assert.equal(reply.ok, true);
});
