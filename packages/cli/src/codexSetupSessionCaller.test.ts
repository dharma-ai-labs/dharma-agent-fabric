import assert from 'node:assert/strict';
import {spawn, type ChildProcess} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import {mkdtemp, readFile, realpath, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';
import test from 'node:test';
import {compileFunction} from 'node:vm';
import ts from 'typescript';
import {canonicalize, sha256} from '@dharma-ai-labs/agent-fabric-contracts';
import {LocalVault, type LocalCodexSetupSessionRequest} from '@dharma-ai-labs/agent-fabric-local-vault';
import {awaitCodexSetupSession, codexSetupSessionPolicyHash, consumeCodexSetupSessions, currentAcceptedSetupSessionScope,
  originalCodexSetupSessionSender, withCodexSetupSessionSender} from './codexSetupSessionHandoff.js';
import {assertBootstrapHostSource, inspectCodexBootstrapHostPreparation, prepareCodexBootstrapHost,
  runCodexBootstrapHostScope} from './bootstrapHostScope.js';
import {assertCodexSetupExecutionLease, createCodexSetupAdmission} from './codexSetupAdmission.js';
import {createNamedSessionChildOwner, currentNamedSessionChildOwner} from './namedSessionChildOwner.js';
import {watchOwnedChild} from './ownedChildLifecycle.js';
import {sendCodexSetupChildStart} from './codexSetupChildStartup.js';

const uuid = (n: number) => `${String(n).padStart(8, '0')}-1111-4111-8111-111111111111`;
const digest = `sha256:${'a'.repeat(64)}`;

// Production declarations execute unchanged. Registry/server/Linux boundaries
// are synthetic; real C-only SQLite and owned children do not prove native use.
async function declaration(name: string, dependencies: Record<string, unknown>) {
  const source = await readFile(new URL('../src/index.ts', import.meta.url), 'utf8');
  const ast = ts.createSourceFile('index.ts', source, ts.ScriptTarget.Latest, true);
  const functions = ast.statements.filter(node => ts.isFunctionDeclaration(node) && node.name?.text === name);
  assert.equal(functions.length, 1);
  const output = ts.transpileModule(functions[0]!.getText(ast), {compilerOptions: {
    target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.CommonJS}, reportDiagnostics: true});
  assert.equal(output.diagnostics?.filter(d => d.category === ts.DiagnosticCategory.Error).length, 0);
  return compileFunction(output.outputText.replaceAll('import.meta.url', '"file:///synthetic/index.js"') + `\nreturn ${name};`, ['exports', ...Object.keys(dependencies)])(
    {}, ...Object.values(dependencies));
}

async function fixture(t: {after(fn: () => Promise<void>): void}, managedCleanup = false) {
  const root = await realpath(await mkdtemp(resolve(tmpdir(), 'dharma-handoff-caller-'))), now = Date.now();
  if (!managedCleanup) t.after(() => rm(root, {recursive: true, force: true}));
  const request: LocalCodexSetupSessionRequest = {schema: 'dharma.local-codex-setup-session/v1',
    operationId: uuid(1), intentDigest: digest, setupReference: uuid(2), senderPid: process.pid, senderStartTicks: '10',
    organizationId: 'org_demo', membershipId: uuid(3), deviceId: uuid(4), workspaceId: uuid(5),
    repositoryBindingId: uuid(6), endpointId: uuid(7), provider: 'codex', origin: 'https://hq.example',
    repositoryFingerprint: digest, policyRevision: 'policy-v1', policyHash: digest, scopeDigest: digest, contractDigest: digest,
    name: `codex-${uuid(5).slice(0, 8)}`, workspaceRoot: root, maximumCostCents: 1000, maximumTurnCostCents: 25,
    issuedAt: new Date(now - 1000).toISOString(), expiresAt: new Date(now + 60_000).toISOString()};
  const config = {deviceId: request.deviceId, organizationId: request.organizationId, hqUrl: request.origin,
    setupClaimReference: request.setupReference, setupClaimRepositoryFingerprint: request.repositoryFingerprint};
  const row = {path: root, workspaceId: request.workspaceId, organizationId: request.organizationId,
    repositoryRemoteHash: request.repositoryFingerprint, status: 'active'};
  const policy = {revision: request.policyRevision, serverAuthorization: {
    issuedAt: request.issuedAt, expiresAt: request.expiresAt, signature: 'synthetic-envelope'}};
  request.policyHash = codexSetupSessionPolicyHash(policy as Parameters<typeof codexSetupSessionPolicyHash>[0]);
  const sender = {uid: 1000, startTicks: '10'};
  const dependencies: Record<string, unknown> = {process: {platform: 'linux', getuid: () => 1000},
    Date, resolve, canonicalize, sha256, codexSetupSessionPolicyHash, currentNamedSessionChildOwner,
    readDeviceConfig: async () => config, normalizeHqUrl: (value: string) => value,
    readContainerProcessIdentity: async (pid: number) => {assert.equal(pid, process.pid); return sender;},
    registry: async () => [row], repositoryRoleScope: () => ({repositoryBindingId: request.repositoryBindingId, endpointId: request.endpointId}),
    preflightBootstrapWorkspaceIdentity: async () => ({fingerprint: digest}), realpath: async () => root,
    loadAgentFabricOnboardingContract: async () => ({sha256: 'a'.repeat(64)}),
    loadDeviceEnrollmentAnchor: async () => ({devicePublicKeyEd25519: 'synthetic-public-key'}),
    enrolledDeviceIdentity: async () => ({publicKeyEd25519: 'synthetic-public-key'}),
    loadVerifiedWorkspacePolicy: async () => policy, verifyServerAuthorizedPolicy: () => {},
    assertWorkspaceAuthorizationCurrent: async () => {}, client: async () => ({}),
    fetchRepositorySourceAuthorization: async () => ({}), readNamedSession: async () => null, dharmaHome: () => root};
  const qualify = async () => declaration('qualifyCodexSetupSessionRequest', {...dependencies,
    qualifyCodexSetupSessionSource: await declaration('qualifyCodexSetupSessionSource', dependencies)}) as Promise<(request: LocalCodexSetupSessionRequest) => Promise<boolean>>;
  return {root, request, config, row, sender, policy, dependencies, qualify};
}

test('actual standing receiver qualifies the bound source and process context only inside its private owner', async t => {
  const f = await fixture(t), qualify = await f.qualify();
  assert.equal(await qualify(f.request), false);
  await createNamedSessionChildOwner(new AbortController().signal).run(async () => {
    assert.equal(await qualify(f.request), true);
  });
});

test('actual standing receiver admits only a freshly verified renewal with unchanged permissions', async t => {
  const f = await fixture(t); let signatures = 0, replayChecks = 0;
  f.dependencies.verifyServerAuthorizedPolicy = () => {signatures++;};
  f.dependencies.assertWorkspaceAuthorizationCurrent = async () => {replayChecks++;};
  const qualify = await f.qualify();
  await createNamedSessionChildOwner(new AbortController().signal).run(async () => {
    assert.equal(await qualify(f.request), true);
    f.policy.serverAuthorization.issuedAt = new Date().toISOString();
    f.policy.serverAuthorization.expiresAt = new Date(Date.now() + 3_600_000).toISOString();
    f.policy.serverAuthorization.signature = 'synthetic-renewed-envelope';
    assert.equal(await qualify(f.request), true);
    assert.equal(signatures, 2); assert.equal(replayChecks, 2);
    f.dependencies.assertWorkspaceAuthorizationCurrent = async () => {throw new Error('synthetic-revoked');};
  });
  // A new declaration reads the changed synthetic dependency, as production
  // performs fresh authorization rather than trusting the stable digest alone.
  const revoked = await f.qualify();
  await createNamedSessionChildOwner(new AbortController().signal).run(async () => {
    assert.equal(await revoked(f.request), false);
  });
});

for (const change of ['none', 'official-bin', 'systemd-bin', 'foreign-bin', 'foreign-index', 'parent-runtime',
  'parent-policy', 'parent-uid', 'parent-argv', 'backend', 'version', 'source', 'parent-unavailable'] as const) {
  test(`actual child startup verifies source and its own IPC parent (${change})`, async t => {
    const f = await fixture(t), parentPid = process.pid + 1;
    const startup = {backend: 'container-entrypoint', version: '0.2.153', policy: resolve(f.root, '.dharma', 'approved-policy.json')};
    const parent = {uid: 1000, argv: [process.execPath, '/synthetic/index.js', 'relay', 'supervise', '--policy', startup.policy]};
    if (change === 'official-bin' || change === 'systemd-bin') parent.argv[1] = '/synthetic/bin.js';
    if (change === 'systemd-bin') startup.backend = 'systemd-user';
    if (change === 'foreign-bin') parent.argv[1] = '/foreign/bin.js';
    if (change === 'foreign-index') parent.argv[1] = '/foreign/index.js';
    if (change === 'parent-runtime') parent.argv[0] = '/foreign/node';
    if (change === 'parent-policy') parent.argv[5] = resolve(f.root, 'foreign-policy.json');
    if (change === 'parent-uid') parent.uid = 999;
    if (change === 'parent-argv') parent.argv.push('--foreign');
    if (change === 'backend') startup.backend = 'foreign';
    if (change === 'version') startup.version = '0.2.1';
    if (change === 'source') f.config.setupClaimReference = uuid(99);
    const qualify = await declaration('qualifyCodexSetupChildRequest', {...f.dependencies,
      qualifyCodexSetupSessionSource: await declaration('qualifyCodexSetupSessionSource', f.dependencies),
      process: {platform: 'linux', ppid: parentPid, execPath: process.execPath, getuid: () => 1000}, VERSION: '0.2.153',
      fileURLToPath: (value: string | URL) => new URL(value).pathname, inspectOwnedRelayAutostart: async () => startup,
      readContainerProcessIdentity: async (pid: number) => {
        assert.equal(pid, parentPid); if (change === 'parent-unavailable') throw new Error('synthetic-parent-missing'); return parent;
      }});
    assert.equal(await qualify(f.request), ['none', 'official-bin', 'systemd-bin'].includes(change));
  });
}

for (const change of ['claim', 'device', 'organization', 'origin', 'fingerprint', 'sender-uid', 'sender-creation',
  'workspace', 'inactive', 'duplicate', 'name', 'role', 'source', 'canonical-path', 'contract', 'device-key',
  'policy', 'policy-signature', 'authorization', 'disclosure', 'member', 'expiry', 'budget'] as const) {
  test(`actual standing receiver denies ${change} before acceptance or startup`, async t => {
    const f = await fixture(t);
    if (change === 'claim') f.config.setupClaimReference = uuid(99);
    if (change === 'device') f.config.deviceId = uuid(99);
    if (change === 'organization') f.config.organizationId = 'org_foreign';
    if (change === 'origin') f.config.hqUrl = 'https://foreign.example';
    if (change === 'fingerprint') f.config.setupClaimRepositoryFingerprint = `sha256:${'b'.repeat(64)}`;
    if (change === 'sender-uid') f.sender.uid = 999;
    if (change === 'sender-creation') f.sender.startTicks = '11';
    if (change === 'workspace') f.row.workspaceId = uuid(99);
    if (change === 'inactive') f.row.status = 'revoked';
    if (change === 'duplicate') f.dependencies.registry = async () => [f.row, f.row];
    if (change === 'name') f.request.name = 'foreign';
    if (change === 'role') f.dependencies.repositoryRoleScope = () => ({repositoryBindingId: uuid(99), endpointId: uuid(7)});
    if (change === 'source') f.dependencies.preflightBootstrapWorkspaceIdentity = async () => ({fingerprint: `sha256:${'b'.repeat(64)}`});
    if (change === 'canonical-path') f.dependencies.realpath = async () => resolve(f.root, 'foreign');
    if (change === 'contract') f.dependencies.loadAgentFabricOnboardingContract = async () => ({sha256: 'b'.repeat(64)});
    if (change === 'device-key') f.dependencies.enrolledDeviceIdentity = async () => ({publicKeyEd25519: 'different-public-key'});
    if (change === 'policy') f.policy.revision = 'foreign-policy';
    if (change === 'policy-signature') f.dependencies.verifyServerAuthorizedPolicy = () => {throw new Error('synthetic-invalid-signature');};
    if (change === 'authorization') f.dependencies.assertWorkspaceAuthorizationCurrent = async () => {throw new Error('synthetic-revoked');};
    if (change === 'disclosure') f.dependencies.fetchRepositorySourceAuthorization = async () => {throw new Error('synthetic-disclosure-denied');};
    if (change === 'member') f.dependencies.readNamedSession = async () => ({identity: {...f.request, membershipId: uuid(99)}});
    if (change === 'expiry') f.request.expiresAt = new Date(Date.now() - 1).toISOString();
    if (change === 'budget') f.request.maximumCostCents++;
    const qualify = await f.qualify();
    await createNamedSessionChildOwner(new AbortController().signal).run(async () => {
      assert.equal(await qualify(f.request), false);
    });
  });
}

for (const failure of [null, 'named_session_startup_failed', 'private-secret-placeholder']) {
test(`actual supervisor consumes an encrypted request, drains its fresh child and sanitizes ${failure ?? 'success'}`, async t => {
  const f = await fixture(t, true), key = randomBytes(32), controller = new AbortController();
  const sender = await LocalVault.open({root: resolve(f.root, 'vault'), masterKey: key});
  let receiver: LocalVault | undefined, child: ChildProcess | undefined, starts = 0, closed = 0;
  const events: unknown[] = [];
  t.after(async () => {controller.abort(); if (child) await watchOwnedChild(child).stop({graceMs: 1000});
    receiver?.close(); sender.close(); key.fill(0); await rm(f.root, {recursive: true, force: true});});
  const claim = sender.claimCodexSetupOperation(f.request.operationId, digest);
  assert.equal(claim.state, 'acquired'); if (claim.state !== 'acquired') throw new Error('synthetic_claim_missing');
  sender.stageCodexSetupSession(claim.leaseId, digest, f.request);
  const supervise = await declaration('superviseNamedSessions', {process: {platform: 'linux', pid: process.pid,
    getuid: () => 1000, stderr: {write: (value: string) => {events.push(JSON.parse(value));}}}, resolve, setTimeout, clearTimeout,
    createNamedSessionChildOwner, consumeCodexSetupSessions, dharmaHome: () => f.root, access: async () => {},
    openBootstrapVault: async () => {
      receiver = await LocalVault.open({root: resolve(f.root, 'vault'), masterKey: key});
      return {listPendingCodexSetupSessions: () => receiver!.listPendingCodexSetupSessions(),
        readCodexSetupSession: (id: string, hash: string) => receiver!.readCodexSetupSession(id, hash),
        acceptCodexSetupSession: (id: string, hash: string, requestHash: string) => receiver!.acceptCodexSetupSession(id, hash, requestHash),
        close: () => {closed++; receiver!.close();}};
    }, qualifyCodexSetupSessionRequest: await f.qualify(),
    namedSessionCommand: async () => {
      const scope = currentAcceptedSetupSessionScope(); assert.ok(scope);
      const owner = currentNamedSessionChildOwner(); assert.ok(owner); starts++;
      child = await owner.spawn(scope.request.name, () => spawn(process.execPath,
        ['-e', 'setInterval(()=>{},1000)'], {cwd: f.root, stdio: 'ignore'}));
      if (failure) throw new Error(failure);
      return {ok: true, ...scope.request, bindingId: uuid(40), sessionId: 'synthetic-session'};
    }, readContainerProcessIdentity: async (pid: number) => ({uid: 1000, parentPid: process.pid,
      startTicks: pid === process.pid ? '20' : '30'}),
    readdir: async () => {controller.abort(); return [];}, readNamedSession: async () => null});
  await supervise(controller.signal);
  assert.equal(starts, 1); assert.equal(closed, 1);
  assert.ok(child); assert.ok(child.exitCode !== null || child.signalCode !== null);
  const observed = sender.readCodexSetupSession(f.request.operationId, digest);
  assert.equal(observed?.state, 'accepted'); assert.equal(observed?.result?.state, failure ? 'unconfirmed' : 'started');
  assert.deepEqual(events, failure ? [{event: 'named_session_setup_failure', diagnostic: {
    schema: 'dharma.codex-setup-failure-diagnostic/v1', stage: 'named_session',
    category: failure === 'private-secret-placeholder' ? 'setup_runtime_unclassified' : failure}}] : []);
  assert.equal(JSON.stringify(events).includes('secret-placeholder'), false);
  assert.deepEqual(sender.listPendingCodexSetupSessions(), []);
});
}

test('actual accepted session caller sends public handoff IDs only to its fresh IPC child', async t => {
  const f = await fixture(t, true), key = randomBytes(32), controller = new AbortController();
  const vault = await LocalVault.open({root: resolve(f.root, 'vault'), masterKey: key});
  let child: ChildProcess | undefined, statusCalls = 0, observed: unknown;
  const launches: Array<{argv: string[]; options: Record<string, unknown>}> = [];
  let received!: () => void;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const receipt = new Promise<void>((done, fail) => {received = () => {clearTimeout(timer); done();};
    timer = setTimeout(() => fail(new Error('synthetic_ipc_receipt_timeout')), 5000);});
  void receipt.catch(() => {});
  t.after(async () => {clearTimeout(timer); controller.abort(); if (child) await watchOwnedChild(child).stop({graceMs: 1000});
    vault.close(); key.fill(0); await rm(f.root, {recursive: true, force: true});});
  const claim = vault.claimCodexSetupOperation(f.request.operationId, digest);
  assert.equal(claim.state, 'acquired'); if (claim.state !== 'acquired') throw new Error('synthetic_claim_missing');
  vault.stageCodexSetupSession(claim.leaseId, digest, f.request);
  const session = await declaration('namedSessionCommand', {...f.dependencies,
    currentBootstrapHostScope: () => undefined, currentAcceptedSetupSessionScope, assertBootstrapHostSource,
    namedSessionPaths: () => ({root: resolve(f.root, 'sessions')}), sendCodexSetupChildStart,
    required: (flags: Map<string, unknown>, name: string) => flags.get(name),
    process: {platform: 'linux', execPath: process.execPath, env: {}}, fileURLToPath: () => '/synthetic/index.js',
    verifyAgentFabricSkillInstallation: async () => ({}), repositorySharedReady: async () => true,
    verifyNamedSessionVisibleSkill: async () => {}, setTimeout,
    spawn: (_command: string, argv: string[], options: Record<string, unknown>) => {
      launches.push({argv, options});
      child = spawn(process.execPath, ['-e', 'process.on("message", value => process.send(value));'],
        {cwd: f.root, stdio: ['ignore', 'ignore', 'ignore', 'ipc']});
      child.once('message', value => {observed = value; received();});
      return child;
    }, namedSessionRequest: async () => {
      if (++statusCalls === 1) throw new Error('synthetic-not-running');
      await receipt;
      return {ok: true, ...f.request, bindingId: uuid(40), sessionId: 'synthetic-session'};
    }});
  const owner = createNamedSessionChildOwner(controller.signal);
  await owner.run(async () => {
    await consumeCodexSetupSessions({vault, owner, signal: controller.signal, authorize: async () => true,
      start: async scope => {
        const result = await session('start', new Map<string, string | boolean>([
          ['name', scope.request.name], ['workspace-id', scope.request.workspaceId], ['apply', true]]));
        assert.equal(result.ok, true);
        assert.equal(owner.ownedPid(scope.request.name), child?.pid);
        return {state: 'started', bindingId: uuid(40), sessionId: 'synthetic-session', sessionPid: child!.pid!,
          supervisorPid: process.pid, sessionStartTicks: '30', supervisorStartTicks: '20'};
      }});
    assert.deepEqual(observed, {schema: 'dharma.codex-setup-child-start/v1',
      operationId: f.request.operationId, intentDigest: digest});
    assert.equal(launches.length, 1);
    assert.deepEqual(launches[0]!.argv, ['/synthetic/index.js', 'sessions', 'serve', '--name', f.request.name,
      '--workspace-id', f.request.workspaceId, '--apply', '--setup-handoff']);
    assert.equal(launches[0]!.options.detached, false);
    assert.deepEqual(launches[0]!.options.stdio, ['ignore', 'ignore', 'ignore', 'ipc']);
    assert.equal(child!.exitCode, null);
  });
  assert.ok(child!.exitCode !== null || child!.signalCode !== null);
  assert.equal(vault.readCodexSetupSession(f.request.operationId, digest)?.result?.state, 'started');
});

test('actual original sender stages and verifies the standing result without reentering context or spawning a child', async t => {
  const f = await fixture(t, true), key = randomBytes(32), controller = new AbortController();
  const vault = await LocalVault.open({root: resolve(f.root, 'vault'), masterKey: key});
  const prepared = prepareCodexBootstrapHost({workspace: f.root, signal: controller.signal, current: async () => true,
    intent: {schema: 'dharma.codex-setup-intent/v1', operationId: f.request.operationId, setupReference: f.request.setupReference,
      organizationId: f.request.organizationId, recipientMembershipId: f.request.membershipId, origin: f.request.origin,
      repositoryFingerprint: digest, policyRevision: f.request.policyRevision, scopeDigest: digest, contractDigest: digest,
      hostContextId: uuid(19), issuedAt: f.request.issuedAt, expiresAt: f.request.expiresAt}});
  const binding = {connectionId: uuid(20), threadId: 'synthetic_thread', turnId: 'synthetic_turn', hostContextId: uuid(19)};
  let staged!: () => void, complete!: () => void, result: unknown, starts = 0, executionError: unknown;
  const stagedGate = new Promise<void>(done => {staged = done;}), completeGate = new Promise<void>(done => {complete = done;});
  const childOwner = createNamedSessionChildOwner(controller.signal);
  // Created outside the setup ALS: the standing receiver owns its own lifetime.
  const receiving = childOwner.run(async () => {
    await stagedGate;
    await consumeCodexSetupSessions({vault, owner: childOwner, signal: controller.signal,
      authorize: async request => request.membershipId === f.request.membershipId && request.setupReference === f.request.setupReference,
      start: async scope => {
        starts++;
        const child = await childOwner.spawn(scope.request.name, () => spawn(process.execPath,
          ['-e', 'setInterval(()=>{},1000)'], {cwd: f.root, stdio: 'ignore'}));
        return {state: 'started', bindingId: uuid(40), sessionId: 'synthetic-session', sessionPid: child.pid!,
          supervisorPid: process.pid, sessionStartTicks: '30', supervisorStartTicks: '20'};
      }});
    await completeGate;
  });
  void receiving.catch(() => {});
  const senderVault = {async stageCodexSetupSession(...args: Parameters<LocalVault['stageCodexSetupSession']>) {
    const submission = vault.stageCodexSetupSession(...args); staged();
    return {async withdraw() {submission.withdraw();}};
  }, async readCodexSetupSession(...args: Parameters<LocalVault['readCodexSetupSession']>) {return vault.readCodexSetupSession(...args);}};
  const call = await declaration('requestBootstrapNamedSession', {...f.dependencies,
    originalCodexSetupSessionSender, inspectCodexBootstrapHostPreparation, assertBootstrapHostSource,
    awaitCodexSetupSession, assertCodexSetupExecutionLease,
    process: {platform: 'linux', pid: process.pid, getuid: () => 1000},
    required: (flags: Map<string, unknown>, key: string) => flags.get(key),
    namedSessionCommand: async () => ({ok: true, ...f.request, bindingId: uuid(40), sessionId: 'synthetic-session'})});
  const admission = createCodexSetupAdmission({...binding, intent: prepared.intent,
    current: async () => ({...binding, mode: 'setup'}), qualifyHost: async () => true,
    journal: {claim: async (id, hash) => vault.claimCodexSetupOperation(id, hash),
      read: async (id, hash) => vault.readCodexSetupOperation(id, hash), finish: async (id, hash, value) => vault.finishCodexSetupOperation(id, hash, value)},
    execute: async (_intent, _signal, _current, lease) => {
      try {await withCodexSetupSessionSender({scope: prepared.scope, vault: senderVault, lease}, async () => {
        result = await runCodexBootstrapHostScope(prepared.scope, () => call(prepared.scope,
          new Map<string, string | boolean>([['name', f.request.name], ['workspace-id', f.request.workspaceId], ['apply', true]])));
      });} catch (error) {executionError = error; throw error;}
      return {state: 'unconfirmed', code: 'setup_execution_unconfirmed'};
    }, verifyReadiness: async () => false});
  t.after(async () => {complete(); staged(); admission.close(); await admission.settled; prepared.scope.close();
    controller.abort(); await receiving; vault.close(); key.fill(0); await rm(f.root, {recursive: true, force: true});});
  await admission.handler({threadId: binding.threadId, turnId: binding.turnId, callId: 'synthetic_call',
    tool: 'dharma_setup_reference', namespace: null,
    arguments: {operationId: f.request.operationId, setupReference: f.request.setupReference}}, {signal: controller.signal});
  await admission.settled;
  if (executionError) throw executionError;
  assert.equal((result as Record<string, unknown>).ok, true); assert.equal(starts, 1);
  complete(); await receiving;
});
