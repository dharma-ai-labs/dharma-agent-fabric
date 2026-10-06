import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {mkdtemp, readFile, realpath, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';
import test from 'node:test';
import {compileFunction} from 'node:vm';
import ts from 'typescript';
import {canonicalize, sha256} from '@dharma-ai-labs/agent-fabric-contracts';
import {LocalVault, type LocalCodexSetupSessionRequest} from '@dharma-ai-labs/agent-fabric-local-vault';
import {runCodexSetupChildStartup, type CodexSetupChildScope} from './codexSetupChildStartup.js';
import {isNamedSessionOwnerReceipt} from './namedSessionTrust.js';

const uuid = (n: number) => `${String(n).padStart(8, '0')}-1111-4111-8111-111111111111`;
const digest = `sha256:${'a'.repeat(64)}`;

// Execute the actual nested provider initializer, not a reimplementation.
// Auth/server/provider responses are synthetic; no model or native Codex runs.
async function fixture(t: {after(fn: () => Promise<void>): void}) {
  const root = await realpath(await mkdtemp(resolve(tmpdir(), 'dharma-child-provider-'))), key = randomBytes(32);
  const vault = await LocalVault.open({root: resolve(root, 'vault'), masterKey: key}), controller = new AbortController();
  t.after(async () => {controller.abort(); vault.close(); key.fill(0); await rm(root, {recursive: true, force: true});});
  const request: LocalCodexSetupSessionRequest = {schema: 'dharma.local-codex-setup-session/v1', operationId: uuid(1),
    intentDigest: digest, setupReference: uuid(2), senderPid: process.pid, senderStartTicks: '1', organizationId: 'org_demo',
    membershipId: uuid(3), deviceId: uuid(4), workspaceId: uuid(5), repositoryBindingId: uuid(6), endpointId: uuid(7), provider: 'codex',
    origin: 'https://hq.example', repositoryFingerprint: digest, policyRevision: 'policy-v1', policyHash: digest,
    scopeDigest: digest, contractDigest: digest, name: 'reviewer', workspaceRoot: root, maximumCostCents: 1000,
    maximumTurnCostCents: 25, issuedAt: new Date(Date.now() - 1000).toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString()};
  const claim = vault.claimCodexSetupOperation(uuid(1), digest); if (claim.state !== 'acquired') throw new Error('synthetic_claim_missing');
  vault.stageCodexSetupSession(claim.leaseId, digest, request);
  vault.acceptCodexSetupSession(uuid(1), digest, sha256(canonicalize(request)));
  const config = {organizationId: request.organizationId, deviceId: request.deviceId, publicKeyEd25519: 'synthetic-public-key'};
  const role = {endpointId: request.endpointId, repositoryBindingId: request.repositoryBindingId};
  const remote: Record<string, unknown> = {bindingId: uuid(40), workspaceId: request.workspaceId,
    endpointId: request.endpointId, repositoryBindingId: request.repositoryBindingId, deviceId: request.deviceId,
    membershipId: request.membershipId, provider: 'codex', mode: 'bridge_owned', state: 'attached', revision: 1,
    leaseUntil: new Date(Date.now() + 60_000).toISOString(), replay: false};
  const response = {ok: true, organizationId: request.organizationId, correlationId: uuid(90), registration: remote};
  const effects: string[] = [], mutations: Record<string, () => void> = {};
  let inspectTransport: (() => {close(): Promise<void>} | undefined) | undefined;
  const fabric = {config, openSession: async () => {effects.push('fabric-session');}, signedPost: async () => {
    effects.push('attach'); mutations.attach?.(); return response;
  }};
  const dependencies: Record<string, unknown> = {Date, resolve, config, scope: role, vault, workspaceId: request.workspaceId,
    name: request.name, existing: null, item: {path: root}, paths: {root: resolve(root, 'session')}, VERSION: '0.2.153',
    process: {env: {}}, transport: undefined, AgentFabricClient: {open: async () => {effects.push('fabric-client'); return fabric;}},
    configPath: () => 'synthetic-config-path', currentBootstrapHostScope: () => undefined,
    createNamedSessionTrust: () => ({refresh: async () => {effects.push('trust');}}),
    refreshVerifiedWorkspacePolicyForTransmission: async () => ({tasks: {writePaths: ['src/**']}}),
    namedCodexEnvironment: () => ({}), dharmaHome: () => resolve(root, 'dharma'), homedir: () => resolve(root, 'home'),
    namedCodexFilesystem: async () => ({peer: 'synthetic-peer', work: 'synthetic-work'}),
    openCodexAppServerTransport: async () => {effects.push('transport'); mutations.transport?.(); return {close: async () => {effects.push('close-transport');}, request: async () => {
      effects.push('account-read'); mutations.account?.(); return {account: {type: 'synthetic'}};
    }};}, flags: new Map(), boundedInteger: (_raw: unknown, fallback: number) => fallback,
    randomUUID: () => uuid(40), UUID_PATTERN: /^[0-9a-f-]{36}$/, isNamedSessionOwnerReceipt, startNamedCodexThread: async () => {
      effects.push('thread-start'); mutations.thread?.(); return 'synthetic-thread';
    }, saveNamedSession: async () => {effects.push('save-registration');}};
  async function compile() {
    const source = await readFile(new URL('../src/index.ts', import.meta.url), 'utf8');
    const ast = ts.createSourceFile('index.ts', source, ts.ScriptTarget.Latest, true);
    const callers = ast.statements.filter(node => ts.isFunctionDeclaration(node) && node.name?.text === 'namedSessionCommand');
    assert.equal(callers.length, 1);
    const found: ts.VariableDeclaration[] = [];
    const visit = (node: ts.Node) => {if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)
      && node.name.text === 'startProvider') found.push(node); ts.forEachChild(node, visit);};
    visit(callers[0]!); assert.equal(found.length, 1);
    const output = ts.transpileModule(`const initialize = ${found[0]!.initializer!.getText(ast)};`,
      {compilerOptions: {target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.CommonJS}, reportDiagnostics: true});
    assert.equal(output.diagnostics?.filter(d => d.category === ts.DiagnosticCategory.Error).length, 0);
    const compiled = compileFunction(output.outputText + '\nreturn {initialize, inspectTransport: () => transport};', ['exports', ...Object.keys(dependencies)])(
      {}, ...Object.values(dependencies)) as {initialize: (scope?: CodexSetupChildScope) => Promise<any>;
        inspectTransport: () => {close(): Promise<void>} | undefined};
    inspectTransport = compiled.inspectTransport;
    return compiled.initialize;
  }
  const run = async () => runCodexSetupChildStartup({vault,
    message: {schema: 'dharma.codex-setup-child-start/v1', operationId: uuid(1), intentDigest: digest},
    name: request.name, workspaceId: request.workspaceId, signal: controller.signal, authorize: async () => true}, await compile());
  return {vault, request, claim, controller, effects, mutations, remote, response, dependencies, run,
    inspectTransport: () => inspectTransport?.()};
}

test('actual provider initializer validates exact recipient receipt before provider startup and persists the bound identity', async t => {
  const f = await fixture(t), result = await f.run();
  assert.equal(result.registration.identity.membershipId, f.request.membershipId);
  assert.ok(f.effects.indexOf('attach') < f.effects.indexOf('thread-start'));
  assert.ok(f.effects.indexOf('attach') < f.effects.indexOf('transport'));
  assert.equal(f.effects.filter(value => value === 'thread-start').length, 1);
  assert.equal((await f.vault.getProviderSessionBinding(uuid(40), result.registration.identity))?.sessionId, 'synthetic-thread');
});

for (const change of ['member', 'device', 'workspace', 'repository', 'endpoint', 'binding', 'organization', 'revision', 'state'] as const) {
  test(`actual provider initializer rejects ${change} receipt before provider startup, thread or local binding`, async t => {
    const f = await fixture(t);
    if (change === 'member') f.remote.membershipId = uuid(99);
    if (change === 'device') f.remote.deviceId = uuid(99);
    if (change === 'workspace') f.remote.workspaceId = uuid(99);
    if (change === 'repository') f.remote.repositoryBindingId = uuid(99);
    if (change === 'endpoint') f.remote.endpointId = uuid(99);
    if (change === 'binding') f.remote.bindingId = uuid(99);
    if (change === 'organization') f.response.organizationId = 'org_foreign';
    if (change === 'revision') f.remote.revision = 2;
    if (change === 'state') f.remote.state = 'revoked';
    await assert.rejects(f.run(), /registration_invalid/);
    assert.equal(f.effects.includes('transport'), false, 'recipient receipt must precede provider transport');
    assert.equal(f.effects.includes('thread-start'), false); assert.equal(f.effects.includes('save-registration'), false);
    assert.equal(f.effects.filter(value => value === 'attach').length, 1, 'a withheld attach reply is not a no-remote-effect claim');
  });
}

test('actual provider initializer refuses inherited foreign-member registration before protected startup', async t => {
  const f = await fixture(t); f.dependencies.existing = {identity: {membershipId: uuid(99)}};
  await assert.rejects(f.run(), /setup_child_unavailable/); assert.deepEqual(f.effects, []);
});

test('actual provider initializer stops before thread creation when the original operation terminates during account read', async t => {
  const f = await fixture(t);
  f.mutations.account = () => f.vault.finishCodexSetupOperation(f.claim.leaseId, digest,
    {state: 'unconfirmed', code: 'setup_execution_unconfirmed'});
  await assert.rejects(f.run(), /setup_child_unavailable/);
  assert.equal(f.effects.filter(value => value === 'attach').length, 1);
  assert.equal(f.effects.includes('thread-start'), false);
});

test('actual provider initializer refuses provider startup after withdrawal in the admitted server attach', async t => {
  const f = await fixture(t); f.mutations.attach = () => f.controller.abort();
  await assert.rejects(f.run(), /setup_child_unavailable/);
  assert.equal(f.effects.filter(value => value === 'attach').length, 1);
  assert.equal(f.effects.includes('transport'), false); assert.equal(f.effects.includes('thread-start'), false);
});

test('actual provider initializer rechecks the owner receipt deadline immediately before provider startup', async t => {
  const f = await fixture(t);
  f.dependencies.namedCodexFilesystem = async () => {
    f.remote.leaseUntil = new Date(Date.now() - 1).toISOString(); return {peer: 'synthetic-peer', work: 'synthetic-work'};
  };
  await assert.rejects(f.run(), /registration_invalid/);
  assert.equal(f.effects.filter(value => value === 'attach').length, 1);
  assert.equal(f.effects.includes('transport'), false); assert.equal(f.effects.includes('thread-start'), false);
});

for (const change of ['none', 'member', 'device', 'expiry', 'replay', 'missing'] as const) {
  test(`actual resumed provider initializer requires a current authenticated owner receipt before provider startup (${change})`, async t => {
    const f = await fixture(t);
    f.remote.leaseUntil = new Date(Date.now() + 60_000).toISOString(); f.remote.replay = false;
    const identity = {organizationId: f.request.organizationId, workspaceId: f.request.workspaceId,
      membershipId: f.request.membershipId, deviceId: f.request.deviceId, endpointId: f.request.endpointId,
      repositoryBindingId: f.request.repositoryBindingId, provider: 'codex'};
    f.dependencies.existing = {bindingId: uuid(40), identity, enabled: true};
    if (change === 'member') f.remote.membershipId = uuid(99);
    if (change === 'device') f.remote.deviceId = uuid(99);
    if (change === 'expiry') f.remote.leaseUntil = new Date(Date.now() - 1).toISOString();
    if (change === 'replay') f.remote.replay = true;
    if (change === 'missing') delete f.remote.membershipId;
    if (change === 'none') {await f.run(); assert.ok(f.effects.indexOf('attach') < f.effects.indexOf('transport'));}
    else {await assert.rejects(f.run(), /registration_invalid/); assert.equal(f.effects.includes('transport'), false);}
    assert.equal(f.effects.includes('thread-start'), false); assert.equal(f.effects.includes('save-registration'), false);
  });
}

test('actual provider initializer withholds a late thread result without persisting a binding or claiming rollback', async t => {
  const f = await fixture(t); f.mutations.thread = () => f.controller.abort();
  await assert.rejects(f.run(), /setup_child_unavailable/);
  assert.equal(f.effects.filter(value => value === 'thread-start').length, 1);
  assert.equal(f.effects.includes('save-registration'), false);
});

test('actual provider initializer captures an admitted transport before a post-start withdrawal can reject it', async t => {
  const f = await fixture(t); f.mutations.transport = () => f.controller.abort();
  await assert.rejects(f.run(), /setup_child_unavailable/);
  const transport = f.inspectTransport(); assert.ok(transport, 'admitted_transport_handle_must_be_retained_for_cleanup');
  await transport.close();
  assert.equal(f.effects.includes('close-transport'), true); assert.equal(f.effects.includes('thread-start'), false);
});
