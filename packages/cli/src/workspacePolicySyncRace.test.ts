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
import {currentBootstrapHostScope} from './bootstrapHostScope.js';
import {writeBootstrapHostJson} from './bootstrapHostFiles.js';
import {applyServerEvidencePolicy, pathExistsOrThrow} from './index.js';

// Issue 397. The real sync, apply, lock and verification bodies run against real
// files. Only the server and the rename and link boundaries are observable, so
// every ordering below is forced by a gate: nothing sleeps and nothing races.
const OLDER = '2026-10-31T18:59:16.731Z', NEWER = '2026-10-31T19:00:34.925Z';
const REFUSAL = 'Server workspace policy authorization is older than the last accepted authorization.';
const ORGANIZATION = 'org_demo', WORKSPACE = '00000005-1111-4111-8111-111111111111';
const COMPILED = ['materializeWorkspacePolicy', 'workspaceAuthorizationStatePath', 'assertWorkspaceAuthorizationCurrent',
  'applyWorkspaceAuthorizationAtomically', 'newEvidenceUploadLedger', 'assertEvidenceLedger',
  'evidenceLedgerForPolicyActivation', 'pathExists', 'acquirePidLock', 'withFileLock', 'writeJsonAtomic',
  'withWorkspacePolicyRefreshLock', 'reconcileWorkspaceRegistration', 'loadVerifiedWorkspacePolicy'];

type Turn = {issuedAt: string; signed?: () => void; respond?: Promise<void>};
type Hooks = {rename?: (from: string, to: string) => void | Promise<void>; contended?: (lockPath: string) => void};
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
  const names = [...COMPILED, ...functions.map(node => node.name?.text ?? '').filter(name => name.startsWith('syncWorkspacePolicy'))];
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
  const hooks: Hooks = {};
  const item = {workspaceId: WORKSPACE, organizationId: ORGANIZATION, name: 'demo', path: workspace,
    routeHash: `sha256:${'a'.repeat(64)}`, repositoryRemoteHash: `sha256:${'b'.repeat(64)}`, status: 'active'};
  const authorization = (issuedAt: string) => {
    const unsigned = {schema: 'dharma.workspace-policy-authorization/v1', organizationId: ORGANIZATION, workspaceId: WORKSPACE,
      policy: {revision: 'signed-test-policy', evidence: {automaticDisclosure: {mode: 'customer_authorized_content',
        consentReceiptId: 'synthetic-consent', allowedContentClasses: ['native_provider_payload']},
        maximumCapsuleBytes: 1000, maximumDailyUploadBytes: 10000, maximumExpansionBytes: 100,
        excludePaths: ['**/.env', '**/*.key'], pseudonymizeIdentity: true}},
      issuedAt, expiresAt: new Date(Date.now() + 86_400_000).toISOString(), keyVersion: 'synthetic'};
    return {...unsigned, signature: signCanonicalObject(unsigned, keys.privateKey)};
  };
  const server = {registerWorkspace: async () => {
    const turn = turns.shift();
    assert.ok(turn, 'the fixture server was asked for more authorizations than the test scripted');
    const signed = authorization(turn.issuedAt);
    turn.signed?.();
    await turn.respond;
    return {ok: true, organizationId: ORGANIZATION, organizationPolicyAuthorization: signed,
      workspace: {id: WORKSPACE, status: 'active', policyRevision: 'signed-test-policy'}};
  }};
  const compiled = await compile({...fs, dirname, resolve, createHash, randomUUID, Buffer, process, Date, setTimeout, structuredClone,
    exports: {}, currentBootstrapHostScope, writeBootstrapHostJson, pathExistsOrThrow, assertPolicy, loadOrganizationPolicy,
    applyServerEvidencePolicy, UUID_PATTERN: /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    dharmaHome: () => home, evidenceUploadLedgerPath: () => resolve(home, 'relay', 'evidence-upload-ledger.json'),
    receiptAwareProviderCapabilities: async () => [], selectedProviderAdapters: () => [], registry: async () => [item],
    readDeviceConfig: async () => ({organizationId: ORGANIZATION, serverPublicKeyEd25519: publicKey}),
    rename: async (from: string, to: string) => {await hooks.rename?.(from, to); return fs.rename(from, to);},
    link: async (from: string, to: string) => {
      try {return await fs.link(from, to);}
      catch (error) {if ((error as NodeJS.ErrnoException).code === 'EEXIST') hooks.contended?.(to); throw error;}
    }, ...overrides});
  const policyPath = resolve(workspace, '.dharma', 'approved-policy.json');
  const statePath = resolve(home, 'registry', 'workspace-authorizations', `${WORKSPACE}.json`);
  return {hooks, policyPath, statePath, sync: () => compiled.syncWorkspacePolicy!(server, item, 'policy-v1', true),
    observed: async () => ({
      replay: JSON.parse(await fs.readFile(statePath, 'utf8')).issuedAt as string,
      policy: (await loadOrganizationPolicy(policyPath)).serverAuthorization?.issuedAt,
      relayStart: await compiled.loadVerifiedWorkspacePolicy!(policyPath, WORKSPACE).then(() => 'verified', (error: Error) => error.message),
    })};
}

const outcome = (settled: PromiseSettledResult<unknown>) => settled.status === 'fulfilled' ? 'applied' : String(settled.reason?.message);

test('a policy write denied after the replay write leaves both records on the last accepted authorization', async t => {
  const f = await fixture(t, [{issuedAt: OLDER}, {issuedAt: NEWER}]);
  await f.sync();
  f.hooks.rename = (_from, to) => {
    if (to === f.policyPath) throw Object.assign(new Error('EPERM: operation not permitted, rename'), {code: 'EPERM'});
  };
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
