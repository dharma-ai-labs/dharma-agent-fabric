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
import {awaitCodexSetupSession, consumeCodexSetupSessions, currentAcceptedSetupSessionScope,
  originalCodexSetupSessionSender, withCodexSetupSessionSender} from './codexSetupSessionHandoff.js';
import {assertBootstrapHostSource, inspectCodexBootstrapHostPreparation, prepareCodexBootstrapHost,
  runCodexBootstrapHostScope} from './bootstrapHostScope.js';
import {assertCodexSetupExecutionLease, createCodexSetupAdmission} from './codexSetupAdmission.js';
import {createNamedSessionChildOwner, currentNamedSessionChildOwner} from './namedSessionChildOwner.js';
import {watchOwnedChild} from './ownedChildLifecycle.js';

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
  return compileFunction(output.outputText + `\nreturn ${name};`, ['exports', ...Object.keys(dependencies)])(
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
  const policy = {revision: request.policyRevision, serverAuthorization: {expiresAt: request.expiresAt}};
  request.policyHash = sha256(canonicalize(policy));
  const sender = {uid: 1000, startTicks: '10'};
  const dependencies: Record<string, unknown> = {process: {platform: 'linux', getuid: () => 1000},
    Date, resolve, canonicalize, sha256, currentNamedSessionChildOwner,
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
  const qualify = () => declaration('qualifyCodexSetupSessionRequest', dependencies) as Promise<(request: LocalCodexSetupSessionRequest) => Promise<boolean>>;
  return {root, request, config, row, sender, policy, dependencies, qualify};
}

test('actual standing receiver qualifies the bound source and process context only inside its private owner', async t => {
  const f = await fixture(t), qualify = await f.qualify();
  assert.equal(await qualify(f.request), false);
  await createNamedSessionChildOwner(new AbortController().signal).run(async () => {
    assert.equal(await qualify(f.request), true);
  });
});

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

test('actual supervisor consumes an encrypted pending request and drains only its fresh owned child', async t => {
  const f = await fixture(t, true), key = randomBytes(32), controller = new AbortController();
  const sender = await LocalVault.open({root: resolve(f.root, 'vault'), masterKey: key});
  let receiver: LocalVault | undefined, child: ChildProcess | undefined, starts = 0, closed = 0;
  t.after(async () => {controller.abort(); if (child) await watchOwnedChild(child).stop({graceMs: 1000});
    receiver?.close(); sender.close(); key.fill(0); await rm(f.root, {recursive: true, force: true});});
  const claim = sender.claimCodexSetupOperation(f.request.operationId, digest);
  assert.equal(claim.state, 'acquired'); if (claim.state !== 'acquired') throw new Error('synthetic_claim_missing');
  sender.stageCodexSetupSession(claim.leaseId, digest, f.request);
  const supervise = await declaration('superviseNamedSessions', {process: {platform: 'linux', pid: process.pid,
    getuid: () => 1000, stderr: {write: () => {}}}, resolve, setTimeout, clearTimeout,
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
      return {ok: true, ...scope.request, bindingId: uuid(40), sessionId: 'synthetic-session'};
    }, readContainerProcessIdentity: async (pid: number) => ({uid: 1000, parentPid: process.pid,
      startTicks: pid === process.pid ? '20' : '30'}),
    readdir: async () => {controller.abort(); return [];}, readNamedSession: async () => null});
  await supervise(controller.signal);
  assert.equal(starts, 1); assert.equal(closed, 1);
  assert.ok(child); assert.ok(child.exitCode !== null || child.signalCode !== null);
  const observed = sender.readCodexSetupSession(f.request.operationId, digest);
  assert.equal(observed?.state, 'accepted'); assert.equal(observed?.result?.state, 'started');
  assert.deepEqual(sender.listPendingCodexSetupSessions(), []);
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
