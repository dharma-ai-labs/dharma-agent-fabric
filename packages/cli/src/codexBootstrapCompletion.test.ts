import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {constants as fsConstants} from 'node:fs';
import {mkdtemp, readFile, realpath, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';
import {compileFunction} from 'node:vm';
import test from 'node:test';
import ts from 'typescript';
import {canonicalize, sha256} from '@dharma-ai-labs/agent-fabric-contracts';
import {LocalVault} from '@dharma-ai-labs/agent-fabric-local-vault';
import {parseLocalCodexSetupReadiness, type LocalCodexSetupReadiness}
  from '@dharma-ai-labs/agent-fabric-local-vault/setup-readiness';
import {currentBootstrapHostScope, prepareCodexBootstrapHost, runCodexBootstrapHostScope} from './bootstrapHostScope.js';
import {assertCodexSetupExecutionLease, createCodexSetupAdmission} from './codexSetupAdmission.js';
import {createCodexSetupReadinessOwner} from './codexSetupReadiness.js';
import {isNamedSessionOwnerReceipt} from './namedSessionTrust.js';
import {parseNamedCodexSkillObservation} from './namedCodexSkillDiscovery.js';
import {discoverRepositoryRoleMetadata} from './repositoryRoleMetadata.js';
import {repositoryRelayObservationReady} from './repositoryRelaySupervisor.js';
import {selectDeviceWorkspace, workspaceIdForDevice} from './onboardingWorkspace.js';
import {startCodexSetupNativeHost} from './codexSetupNativeHost.js';
import {bootstrapFromCodexSetupScope, loadAgentFabricOnboardingContract} from './index.js';
import type {ScopedLocalVault} from '@dharma-ai-labs/agent-fabric-local-vault';
import type {CodexStdioTransport} from '@dharma-ai-labs/agent-fabric-provider-adapters/experimental/codex-transport';
import type {CodexToolHandler} from '@dharma-ai-labs/agent-fabric-provider-adapters/experimental/codex-session';

const id = (n: number) => `${String(n).padStart(8, '0')}-1111-4111-8111-111111111111`;
const hash = `sha256:${'a'.repeat(64)}`;

// Execute unchanged production declarations; only OS/server/native boundaries
// are fixtures. These tests do not establish Linux or production readiness.
async function declaration(name: string, dependencies: Record<string, unknown>) {
  const source = await readFile(new URL('../src/index.ts', import.meta.url), 'utf8');
  const ast = ts.createSourceFile('index.ts', source, ts.ScriptTarget.Latest, true);
  const matches = ast.statements.filter(node => ts.isFunctionDeclaration(node) && node.name?.text === name);
  assert.equal(matches.length, 1);
  const output = ts.transpileModule(matches[0]!.getText(ast), {compilerOptions: {
    target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.CommonJS}, reportDiagnostics: true});
  assert.equal(output.diagnostics?.filter(d => d.category === ts.DiagnosticCategory.Error).length, 0);
  const body = output.outputText.replaceAll('import.meta.url', 'ENTRY_URL');
  return compileFunction(`${body}\nreturn ${name};`, ['exports', ...Object.keys(dependencies)])(
    {}, ...Object.values(dependencies));
}

async function fixture(t: {after(fn: () => Promise<void>): void}) {
  const root = await realpath(await mkdtemp(resolve(tmpdir(), 'dharma-completion-'))), now = Date.now();
  const prepared = prepareCodexBootstrapHost({workspace: root, signal: new AbortController().signal, current: async () => true,
    intent: {schema: 'dharma.codex-setup-intent/v1', operationId: id(1), setupReference: id(2),
      organizationId: 'org_demo', recipientMembershipId: id(3), origin: 'https://hq.example',
      repositoryFingerprint: hash, policyRevision: 'policy-v1', scopeDigest: hash, contractDigest: hash,
      hostContextId: id(4), issuedAt: new Date(now - 1000).toISOString(), expiresAt: new Date(now + 600_000).toISOString()}});
  const vault = await LocalVault.open({root: resolve(root, 'vault'), masterKey: randomBytes(32)}, prepared.scope);
  t.after(async () => {prepared.scope.close(); await vault.close(); await rm(root, {recursive: true, force: true});});
  const profile = {roleName: 'Reviewer', description: 'Bounded synthetic code review.', questionCategories: ['code-review']};
  const workspaceId = workspaceIdForDevice({organizationId: 'org_demo', deviceId: id(5), path: root});
  const identity = {organizationId: 'org_demo', membershipId: id(3), deviceId: id(5), workspaceId,
    repositoryBindingId: id(7), endpointId: id(9), provider: 'codex'};
  const roleScope = {organizationId: 'org_demo', workspaceId, repositoryBindingId: id(7),
    repositoryAgentId: id(8), endpointId: id(9), sourceFingerprint: hash};
  const row = {...identity, path: root, routeHash: sha256(root), repositoryRemoteHash: hash, status: 'active', repositoryAgentId: id(8),
    repositoryRole: {revision: 1, profileHash: sha256(canonicalize(profile))}};
  const name = `codex-${workspaceId.slice(0, 8)}`, home = resolve(root, 'home'), entry = resolve(root, 'index.js');
  const policyPath = resolve(root, '.dharma', 'approved-policy.json');
  const policy = {revision: 'policy-v1', serverAuthorization: {workspaceId, expiresAt: prepared.intent.expiresAt}};
  const content = {bundleId: id(11), bundleHash: hash, manifestHash: hash, catalogHash: hash, skillsHash: hash};
  const binding = {...identity, owner: 'dharma_bridge', workspaceRoot: root, bindingId: id(10),
    sessionId: 'synthetic_session', expiresAt: prepared.intent.expiresAt};
  const native = {ok: true, ...identity, name, bindingId: id(10), sessionId: binding.sessionId,
    nativeSkill: {...content, schema: 'dharma.named-codex-skill-observation/v1', nativeDiscovered: true,
      observedAt: new Date(now).toISOString()}};
  const {organizationId, ...remoteIdentity} = identity;
  const remote = {ok: true, organizationId, correlationId: id(90), registration: {...remoteIdentity,
    bindingId: id(10), mode: 'bridge_owned', revision: 1, state: 'attached', replay: false,
    leaseUntil: new Date(now + 60_000).toISOString()}};
  const startup = {backend: 'container-entrypoint', version: '0.2.153', workspace: root, policy: policyPath,
    launcher: resolve(root, '.dharma', 'bin', 'dharma')};
  const startupState = {state: 'enabled', backend: startup.backend, version: startup.version, lifecycle: 'running'};
  const poll = {at: new Date(now).toISOString(), workspaceId, version: '0.2.153', pid: 102};
  const supervisor = {pid: 101, organizationId: 'org_demo', deviceId: id(5), policyPath,
    version: '0.2.153', standardRepositories: true};
  const processes = [
    {pid: 101, uid: 1000, parentPid: 1, processGroupId: 101, sessionId: 101, startTicks: '10',
      argv: ['synthetic-node', entry, 'relay', 'supervise', '--policy', policyPath]},
    {pid: 102, uid: 1000, parentPid: 101, processGroupId: 101, sessionId: 101, startTicks: '20',
      argv: ['synthetic-node', entry, 'relay', 'start', '--policy', policyPath]},
    {pid: 103, uid: 1000, parentPid: 1, processGroupId: 103, sessionId: 103, startTicks: '30',
      argv: ['synthetic-node', entry, 'sessions', 'serve', '--name', name, '--workspace-id', workspaceId, '--apply']},
  ];
  const paths = new Map<string, unknown>([
    [resolve(home, 'relay', 'supervisor.pid'), 101], [resolve(home, 'relay', 'relay.pid'), 102],
    [resolve(home, 'sessions', name, 'service.lock'), 103],
    [resolve(home, 'relay', 'supervisor-workspace.json'), supervisor],
    [resolve(home, 'relay', 'repositories', workspaceId, 'last-successful-poll.json'), poll],
  ]);
  const calls: string[] = [], mutations: Record<string, () => void> = {};
  const dependencies: Record<string, unknown> = {
    resolve, Date, canonicalize, sha256, selectDeviceWorkspace, parseLocalCodexSetupReadiness, parseNamedCodexSkillObservation,
    isNamedSessionOwnerReceipt, repositoryRelayObservationReady, discoverRepositoryRoleMetadata,
    ENTRY_URL: 'file:///synthetic/index.js', fileURLToPath: () => entry, VERSION: '0.2.153',
    process: {platform: 'linux', execPath: 'synthetic-node', getuid: () => 1000},
    preflightBootstrapWorkspaceIdentity: async () => ({fingerprint: hash}), assertBootstrapHostSource: async () => {},
    loadAgentFabricOnboardingContract: async () => ({sha256: 'a'.repeat(64)}),
    readDeviceConfig: async () => ({...identity, hqUrl: 'https://hq.example'}), normalizeHqUrl: (s: string) => s,
    loadDeviceEnrollmentAnchor: async () => ({devicePublicKeyEd25519: 'synthetic-public-key'}),
    enrolledDeviceIdentity: async () => ({publicKeyEd25519: 'synthetic-public-key'}), registry: async () => [row],
    repositoryRoleScope: () => roleScope, loadVerifiedWorkspacePolicy: async () => policy,
    verifyServerAuthorizedPolicy: () => {calls.push('verified-policy'); mutations.policy?.();},
    assertWorkspaceAuthorizationCurrent: async () => {calls.push('current-policy'); mutations.authorization?.();},
    activeSkillAuthorization: async () => ({...content, expiresAt: prepared.intent.expiresAt}),
    loadActiveSkillAuthorizationAnchor: async () => ({bundleId: id(11), receiptHash: hash}),
    verifyAgentFabricSkillInstallation: async () => {calls.push('installation'); mutations.installation?.(); return {ready: true};},
    readNamedSessionPackageContent: async () => ({...content}),
    client: async () => ({signedGet: async () => ({ok: true, organizationId: 'org_demo', correlationId: 'synthetic',
      discovery: {organizationId: roleScope.organizationId, workspaceId: roleScope.workspaceId,
        repositoryBindingId: roleScope.repositoryBindingId, repositoryAgentId: roleScope.repositoryAgentId,
        peers: [{endpointId: id(9), workspaceId, provider: 'codex', ...profile, revision: 1}],
        limit: 50, possiblyTruncated: false}}),
      signedPost: async () => remote}),
    dharmaHome: () => home, readNamedSession: async () => ({enabled: true, identity, bindingId: id(10)}),
    namedSessionCommand: async () => native, inspectOwnedRelayAutostart: async () => startup,
    relayAutostartStatus: async () => startupState,
    namedSessionPaths: () => ({root: resolve(home, 'sessions', name)}),
    readContainerProcessIdentity: async (pid: number) => {
      calls.push(`process-${pid}`); mutations.process?.(); return structuredClone(processes.find(p => p.pid === pid));
    },
    readBootstrapRuntimeJson: async (path: string, scope: typeof prepared.scope) => scope.step(async () => {
      calls.push('owned-state'); if (!paths.has(path)) throw new Error('fixture_path_unknown'); return structuredClone(paths.get(path));
    }),
  };
  const observe = await declaration('observeCodexBootstrapRuntime', dependencies) as (
    p: typeof prepared, v: {getProviderSessionBinding(): Promise<typeof binding | null>},
    first: LocalCodexSetupReadiness['firstLearning']) => Promise<LocalCodexSetupReadiness>;
  const providerVault = {getProviderSessionBinding: async () => binding};
  return {prepared, vault, observe, providerVault, calls, paths, mutations, row, profile, binding, native, remote,
    content, startup, startupState, policy, supervisor, poll, processes, dependencies};
}

async function siblingAnchor(f: Awaited<ReturnType<typeof fixture>>) {
  const path = resolve(f.row.path, 'sibling');
  const workspaceId = workspaceIdForDevice({organizationId: f.row.organizationId, deviceId: f.row.deviceId, path});
  const row = {...f.row, path, workspaceId, routeHash: sha256(path), repositoryRemoteHash: `sha256:${'b'.repeat(64)}`};
  const policy = {...f.policy, revision: 'sibling-policy', serverAuthorization: {...f.policy.serverAuthorization, workspaceId}};
  f.startup.workspace = path; f.startup.policy = resolve(path, '.dharma', 'approved-policy.json');
  f.startup.launcher = resolve(path, '.dharma', 'bin', 'dharma');
  f.supervisor.policyPath = f.startup.policy;
  f.processes[0]!.argv[5] = f.startup.policy; f.processes[1]!.argv[5] = f.startup.policy;
  f.dependencies.registry = async () => [f.row, row];
  f.dependencies.loadVerifiedWorkspacePolicy = async (path: string) => path === f.startup.policy ? policy : f.policy;
  const observe = await declaration('observeCodexBootstrapRuntime', f.dependencies) as typeof f.observe;
  return {row, policy, observe};
}

test('actual CLI producer accepts a verified same-device sibling startup anchor without retargeting it', async t => {
  const f = await fixture(t), sibling = await siblingAnchor(f);
  const before = structuredClone(f.startup);
  const result = await sibling.observe(f.prepared, f.providerVault, 'no_eligible_history');
  assert.equal(result.workspaceId, f.row.workspaceId); assert.equal(result.policyRevision, f.policy.revision);
  assert.deepEqual(f.startup, before);
});

for (const change of ['foreign-device', 'foreign-org', 'route', 'inactive', 'unregistered', 'policy',
  'supervisor', 'startup-change', 'state-change', 'route-change', 'policy-change', 'config-change', 'authorization'] as const) {
  test(`actual CLI producer rejects a sibling startup anchor with ${change}`, async t => {
    const f = await fixture(t), sibling = await siblingAnchor(f);
    if (change === 'foreign-device') sibling.row.workspaceId = workspaceIdForDevice({organizationId: 'org_demo', deviceId: id(99), path: sibling.row.path});
    if (change === 'foreign-org') sibling.row.organizationId = 'org_foreign';
    if (change === 'route') sibling.row.routeHash = `sha256:${'f'.repeat(64)}`;
    if (change === 'inactive') sibling.row.status = 'revoked';
    if (change === 'unregistered') f.dependencies.registry = async () => [f.row];
    if (change === 'policy') f.dependencies.verifyServerAuthorizedPolicy = ({workspaceId}: {workspaceId: string}) => {
      if (workspaceId === sibling.row.workspaceId) throw new Error('fixture_invalid_anchor_signature');
    };
    if (change === 'supervisor') f.supervisor.deviceId = id(99);
    if (change === 'authorization') f.dependencies.assertWorkspaceAuthorizationCurrent = async (workspaceId: string) => {
      if (workspaceId === sibling.row.workspaceId) throw new Error('fixture_anchor_authority_revoked');
    };
    let reads = 0;
    f.mutations.process = () => {
      if (++reads !== 4) return;
      if (change === 'startup-change') f.startup.launcher = resolve(f.row.path, 'foreign-launcher');
      if (change === 'state-change') f.startupState.lifecycle = 'stopped';
      if (change === 'route-change') sibling.row.repositoryRemoteHash = `sha256:${'f'.repeat(64)}`;
      if (change === 'policy-change') sibling.policy.revision = 'withdrawn';
    };
    if (change === 'config-change') f.dependencies.readDeviceConfig = async () => ({organizationId: 'org_demo',
      deviceId: reads >= 4 ? id(99) : id(5), hqUrl: 'https://hq.example'});
    const observe = await declaration('observeCodexBootstrapRuntime', f.dependencies) as typeof f.observe;
    const expected = change === 'policy' ? /fixture_invalid_anchor_signature/
      : change === 'authorization' ? /fixture_anchor_authority_revoked/
      : change === 'supervisor' ? /setup_runtime_process_unconfirmed/
      : change.endsWith('-change') ? /setup_runtime_startup_changed/ : /setup_runtime_startup_unconfirmed/;
    await assert.rejects(observe(f.prepared, f.providerVault, 'no_eligible_history'), expected);
  });
}

test('actual CLI producer joins scoped identity, server role, native package and creation-identity observations', async t => {
  const f = await fixture(t);
  const observation = await f.observe(f.prepared, f.providerVault, 'no_eligible_history');
  assert.equal(Object.isFrozen(observation), true); assert.equal(observation.endpointId, id(9));
  assert.equal(observation.catalogHash, hash); assert.equal(observation.firstLearning, 'no_eligible_history');
  assert.equal(f.calls.filter(c => c === 'current-policy').length, 4);
  assert.equal(f.calls.filter(c => c === 'process-102').length, 2);
  const claim = await f.vault.claimCodexSetupOperation(id(1), hash);
  assert.equal(claim.state, 'acquired'); if (claim.state !== 'acquired') throw new Error('fixture_claim_missing');
  const owner = createCodexSetupReadinessOwner({intent: f.prepared.intent, workspace: f.row.path,
    scope: f.prepared.scope, vault: f.vault, observe: () => f.observe(f.prepared, f.providerVault, 'no_eligible_history')});
  const receipt = await owner.record({leaseId: claim.leaseId, intentDigest: hash});
  assert.equal(await owner.verify(receipt.readinessReceiptId, f.prepared.intent, hash), true);
  f.native.sessionId = 'different_session';
  assert.equal(await owner.verify(receipt.readinessReceiptId, f.prepared.intent, hash), false);
});

for (const change of ['source', 'recipient', 'role', 'package', 'native', 'lease', 'startup', 'poll', 'process', 'withdrawn'] as const) {
  test(`actual CLI producer withholds readiness for ${change} mismatch`, async t => {
    const f = await fixture(t);
    if (change === 'source') f.row.repositoryRemoteHash = `sha256:${'b'.repeat(64)}`;
    if (change === 'recipient') f.binding.membershipId = id(99);
    if (change === 'role') f.row.repositoryRole.revision = 2;
    if (change === 'package') f.content.catalogHash = `sha256:${'b'.repeat(64)}`;
    if (change === 'native') f.native.nativeSkill.observedAt = new Date(Date.now() - 90_000).toISOString();
    if (change === 'lease') f.remote.registration.leaseUntil = new Date(Date.now() - 1).toISOString();
    if (change === 'startup') f.startupState.lifecycle = 'stopped';
    if (change === 'poll') f.poll.pid = 104;
    if (change === 'process') f.processes[1]!.parentPid = 999;
    if (change === 'withdrawn') f.prepared.scope.close();
    const expected = {source: 'setup_runtime_repository_unconfirmed', recipient: 'setup_runtime_session_unconfirmed',
      role: 'setup_runtime_role_unconfirmed', package: 'setup_runtime_session_unconfirmed', native: 'named_session_native_skill_invalid',
      lease: 'setup_runtime_session_unconfirmed', startup: 'setup_runtime_startup_unconfirmed', poll: 'setup_runtime_poll_unconfirmed',
      process: 'setup_runtime_process_unconfirmed', withdrawn: 'codex_setup_host_scope_unavailable'};
    await assert.rejects(f.observe(f.prepared, f.providerVault, 'no_eligible_history'), {message: expected[change]});
  });
}

test('actual CLI producer denies process reuse and policy withdrawal during readback', async t => {
  const f = await fixture(t); let processReads = 0;
  f.mutations.process = () => {if (++processReads === 4) f.processes[1]!.startTicks = '999';};
  await assert.rejects(f.observe(f.prepared, f.providerVault, 'no_eligible_history'), /process_changed/);
  delete f.mutations.process;
  f.mutations.authorization = () => {f.prepared.scope.close();};
  await assert.rejects(f.observe(f.prepared, f.providerVault, 'no_eligible_history'), /scope_unavailable/);
});

test('actual completion composition denies copied leases and retains the incomplete-execution guard', async t => {
  const f = await fixture(t); let executions = 0;
  const compose = await declaration('createCodexBootstrapCompletionOwner', {...f.dependencies,
    runCodexBootstrapHostScope, createCodexSetupReadinessOwner, assertCodexSetupExecutionLease,
    observeCodexBootstrapRuntime: f.observe,
    bootstrapFromCodexSetupScope: async () => {executions++; return {ok: false, stage: 'host_setup_unavailable',
      code: 'codex_setup_host_execution_unqualified', effects: false, grantRedeemed: false};},
  }) as (scope: typeof f.prepared.scope, vault: typeof f.vault) => Promise<{
    execute: (lease: {leaseId: string; intentDigest: string}) => Promise<unknown>;
    verify: ReturnType<typeof createCodexSetupReadinessOwner>['verify'];
  }>;
  const completion = await compose(f.prepared.scope, f.vault);
  await assert.rejects(completion.execute({leaseId: id(99), intentDigest: hash}), /execution_lease_unavailable/);
  assert.equal(executions, 0);
  const active = {connectionId: id(20), threadId: 'synthetic_thread', turnId: 'synthetic_turn', hostContextId: id(4)};
  const owner = createCodexSetupAdmission({...active, intent: f.prepared.intent,
    current: async () => ({...active, mode: 'setup'}), qualifyHost: async () => true,
    journal: {claim: async (operation, digest) => f.vault.claimCodexSetupOperation(operation, digest),
      finish: async (lease, digest, result) => f.vault.finishCodexSetupOperation(lease, digest, result)},
    execute: (_intent, _signal, _current, lease) => completion.execute(lease), verifyReadiness: completion.verify});
  try {
    const result = await owner.handler({threadId: active.threadId, turnId: active.turnId,
      callId: 'synthetic_call', tool: 'dharma_setup_reference', namespace: null,
      arguments: {operationId: id(1), setupReference: id(2)}}, {signal: new AbortController().signal});
    assert.equal(result.success, false); assert.equal(executions, 1);
    assert.equal(JSON.stringify(result).includes('readinessReceiptId'), false);
    assert.equal(f.calls.length, 0);
  } finally {owner.close(); await owner.settled;}
});

test('actual runtime-state reader enforces ownership, private mode, bounds and unchanged descriptor identity', async t => {
  const f = await fixture(t), bytes = Buffer.from('{"pid":102}\n');
  let opens = 0, closes = 0, changed = false, short = false;
  const stat = {dev: 1n, ino: 2n, nlink: 1n, size: BigInt(bytes.length), mtimeNs: 1n, ctimeNs: 1n,
    mode: 0o100600n, uid: 1000n, gid: 1000n, isFile: () => true, isSymbolicLink: () => false};
  const read = await declaration('readBootstrapRuntimeJson', {Buffer, JSON, fsConstants,
    process: {getuid: () => 1000},
    lstat: async () => ({...stat}),
    open: async (_path: string, flags: number) => {
      opens++; assert.equal(flags, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
      return {stat: async () => ({...stat, ino: changed ? 3n : stat.ino}),
        read: async (target: Buffer) => {bytes.copy(target); return {bytesRead: short ? bytes.length - 1 : bytes.length};},
        close: async () => {closes++;}};
    }}) as (path: string, scope: typeof f.prepared.scope) => Promise<unknown>;
  assert.deepEqual(await read('synthetic-owned-state', f.prepared.scope), {pid: 102});
  assert.equal(opens, 1); assert.equal(closes, 1);
  for (const change of [{uid: 999n}, {mode: 0o100640n}, {nlink: 2n}, {size: 32_769n}]) {
    const old = {...stat}; Object.assign(stat, change);
    await assert.rejects(read('synthetic-owned-state', f.prepared.scope), /state_unconfirmed/);
    assert.equal(opens, 1); Object.assign(stat, old);
  }
  changed = true;
  await assert.rejects(read('synthetic-owned-state', f.prepared.scope), /state_unconfirmed/);
  assert.equal(closes, 2);
  changed = false; short = true;
  await assert.rejects(read('synthetic-owned-state', f.prepared.scope), /state_unconfirmed/);
  assert.equal(closes, 3);
  f.prepared.scope.close();
  await assert.rejects(read('synthetic-owned-state', f.prepared.scope), /scope_unavailable/);
  assert.equal(opens, 3);
});

for (const withdrawAfterOpen of [false, true]) {
  test(`official composition owns the same protected vault and closes a denied opening (withdraw=${withdrawAfterOpen})`, async t => {
    const f = await fixture(t), key = randomBytes(32), home = resolve(f.row.path, 'native-home');
    let allowed = true, opens = 0, closes = 0, vault: ScopedLocalVault | undefined;
    let originalScope: typeof f.prepared.scope | undefined, handler: CodexToolHandler | undefined;
    const listeners = new Set<(value: unknown) => void>(), lifetime = new AbortController();
    t.after(() => {key.fill(0);});
    const transport: CodexStdioTransport = {
      signal: lifetime.signal, close: async () => {lifetime.abort();},
      onNotification: listener => {listeners.add(listener); return () => {listeners.delete(listener);};},
      onToolCall: callback => {handler = callback; return () => {handler = undefined;};},
      request: async (method: string) => {
        if (method === 'permissionProfile/list') return {data: [{id: 'dharma_bridge', allowed: true}]};
        if (method === 'config/read') return {config: {permissions: {dharma_bridge: {
          filesystem: {':minimal': 'read', ':workspace_roots': {'.': 'read'}}, network: {enabled: false}}}}};
        if (method === 'thread/start' || method === 'thread/read') return {thread: {
          id: 'synthetic_thread', cwd: f.row.path, name: 'reviewer', status: {type: 'idle'}}};
        if (method === 'thread/name/set' || method === 'turn/interrupt') return {};
        if (method === 'turn/start') return {turn: {id: 'synthetic_turn', status: 'inProgress'}};
        throw new Error('fixture_native_method_unexpected');
      },
    };
    const compose = await declaration('createCodexBootstrapCompletionOwner', {...f.dependencies,
      runCodexBootstrapHostScope, createCodexSetupReadinessOwner, assertCodexSetupExecutionLease,
      observeCodexBootstrapRuntime: f.observe, bootstrapFromCodexSetupScope,
    });
    const start = await declaration('startCodexBootstrapNativeHost', {resolve, dharmaHome: () => home,
      runCodexBootstrapHostScope, startCodexSetupNativeHost, createCodexBootstrapCompletionOwner: compose,
      openBootstrapVault: async (options: {root: string}) => {
        opens++; assert.equal(options.root, resolve(home, 'vault'));
        const scope = currentBootstrapHostScope(); assert.ok(scope); originalScope = scope;
        vault = await LocalVault.open({...options, masterKey: key}, scope);
        if (withdrawAfterOpen) allowed = false;
        const owned = vault;
        return {...owned, close: async () => {closes++; await owned.close();}};
      },
    }) as (input: Omit<Parameters<typeof startCodexSetupNativeHost>[0], 'openJournal' | 'execute' | 'verifyReadiness'>)
      => ReturnType<typeof startCodexSetupNativeHost>;
    const contract = await loadAgentFabricOnboardingContract();
    const input = {transport, workspace: f.row.path, name: 'reviewer',
      intent: {...f.prepared.intent, contractDigest: `sha256:${contract.sha256}`},
      signal: new AbortController().signal, current: async () => allowed,
      maximumProviderCostCents: 25, reserve: async () => true};
    if (withdrawAfterOpen) {
      await assert.rejects(start(input), {message: 'codex_setup_host_scope_unavailable'});
      assert.equal(opens, 1); assert.equal(closes, 1); assert.equal(handler, undefined);
      return;
    }
    const host = await start(input);
    try {
      assert.ok(handler); assert.ok(originalScope); assert.equal(await originalScope.current(), true);
      const response = await handler({threadId: 'synthetic_thread', turnId: 'synthetic_turn', callId: 'setup_call',
        tool: 'dharma_setup_reference', namespace: null, arguments: {operationId: id(1), setupReference: id(2)}},
      {signal: transport.signal});
      assert.equal(response.success, false);
      assert.equal(JSON.parse(response.contentItems[0]!.text).code, 'codex_setup_execution_unconfirmed');
      assert.equal(f.calls.length, 0, 'the guarded actual bootstrap cannot synthesize live readiness');
      assert.equal(opens, 1); assert.equal(closes, 0);
      for (const listener of listeners) listener({method: 'turn/completed',
        params: {threadId: 'synthetic_thread', turn: {id: 'synthetic_turn', status: 'completed'}}});
      await host.settled;
      assert.equal(closes, 1); assert.equal(await originalScope.current(), false);
      assert.equal(handler, undefined); assert.equal(listeners.size, 0);
    } finally {await host.close();}
    assert.equal(closes, 1);
  });
}
