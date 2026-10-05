import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import test from 'node:test';
import ts from 'typescript';
import { appendRecoveredWorkspace, resolveRegistryRecoveryProjection } from './workspaceRegistryRecovery.js';
import { bootstrapGrantMode } from './privateGrantInput.js';
import { assertBootstrapHostSource, currentBootstrapHostScope, runCodexBootstrapHost } from './bootstrapHostScope.js';

type Onboarding = Record<string, unknown>;
type Caller = (...args: unknown[]) => Promise<Record<string, unknown>>;

// Execute the actual function body, parsed by TypeScript rather than extracted
// by text matching. All I/O boundaries are injected: no enrollment, paid work,
// secret-store writes, daemon processes, or external requests can occur.
async function caller(name: string, dependencies: Record<string, unknown>): Promise<Caller> {
  const text = await readFile(fileURLToPath(new URL('../src/index.ts', import.meta.url)), 'utf8');
  const source = ts.createSourceFile('index.ts', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const nodes = source.statements.filter(node => ts.isFunctionDeclaration(node) && node.name?.text === name);
  assert.equal(nodes.length, 1, 'The named source function must resolve exactly once.');
  const compiled = ts.transpileModule(nodes[0]!.getText(source), {
    compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.None },
    reportDiagnostics: true,
  });
  assert.equal(compiled.diagnostics?.filter(item => item.category === ts.DiagnosticCategory.Error).length, 0);
  return runInNewContext(`${compiled.outputText}\n${name}`, {
    assertBootstrapHostSource, currentBootstrapHostScope, ...dependencies,
  }, {
    timeout: 1000, contextCodeGeneration: { strings: false, wasm: false },
  }) as Caller;
}

function bootstrapDependencies(onboarding: Onboarding) {
  const calls: string[] = [];
  const record = async (name: string) => { calls.push(name); };
  const dependencies: Record<string, unknown> = {
    bootstrapGrantMode,
    readPrivateBootstrapGrant: async () => { await record('private_grant'); return 'fixture_private_grant'; },
    normalizeHqUrl: (value: string) => value,
    portalUrl: () => 'https://fixture.invalid',
    required: (flags: Map<string, string | boolean>, key: string) => {
      const value = flags.get(key); if (typeof value !== 'string') throw new Error(`Missing fixture flag ${key}`); return value;
    },
    realpath: async (path: string) => path,
    preflightBootstrapWorkspaceIdentity: async () => {
      await record('preflight');
      return { fingerprint: `sha256:${'e'.repeat(64)}` };
    },
    isLocalProviderId: (provider: string) => provider === 'codex',
    readDeviceConfig: async () => null,
    configPath: () => '/fixture-config/device.json',
    process: { platform: 'linux', env: { USER: 'fixture' }, stderr: { write: () => true } },
    platform: async () => 'linux',
    loadOrCreateInstallationId: async () => '11111111-1111-4111-8111-111111111111',
    loadOrCreateDeviceIdentity: async () => ({ publicKeyEd25519: 'fixture_public_key' }),
    redeemBootstrapGrant: async () => ({ deviceId: 'fixture_device', serverPublicKeyEd25519: 'fixture_server_key',
      relayUrl: 'wss://fixture.invalid', organizationApiToken: 'fixture_token', organizationApiTokenScopes: [] }),
    openVerificationUri: async () => { await record('open_approval'); return true; },
    saveDeviceConfig: async () => record('save_device'),
    saveDeviceEnrollmentAnchor: async () => record('save_anchor'),
    saveOrganizationApiToken: async () => record('save_token'),
    loadOrganizationApiToken: async () => { await record('read_token'); return 'fixture_token'; },
    retryBootstrapOnboarding: async (operation: () => Promise<unknown>) => operation(),
    onboard: async () => { await record('onboard'); return {
      firstLearningEvidence: { state: 'synchronized', discovered: 0, disclosureReady: false,
        captured: 0, synced: 0 }, repositoryRole: { stage: 'registered' }, ...onboarding,
    }; },
    joinExistingRepository: async () => { await record('join_existing'); return {
      firstLearningEvidence: { state: 'shared_package_inherited', discovered: 0, disclosureReady: false },
      repositoryRole: { stage: 'registered' }, ...onboarding,
    }; },
    UUID_PATTERN: /^[0-9a-f-]{36}$/i,
    installStableRepositoryLauncher: async () => { await record('launcher');
      return { shell: '.dharma/bin/dharma', windows: '.dharma/bin/dharma.cmd' }; },
    dharmaHome: () => '/fixture-home',
    VERSION: '0.2.102',
    relayAutostartStatus: async () => ({ state: 'disabled', backend: null }),
    enableRelayAutostart: async () => { await record('autostart'); return { state: 'enabled', backend: 'systemd-user' }; },
    withRelayStartupMutation: async (operation: () => Promise<unknown>) => {
      await record('startup_lock'); return operation();
    },
    verifyAgentFabricSkillInstallation: async () => ({ ready: true }),
    resolve, dirname,
    evidencePreview: async () => { throw new Error('bootstrap must reuse the onboarding evidence receipt'); },
    startRelayDaemon: async () => { await record('relay'); return { started: true, state: 'running', probe: { ok: true } }; },
    withOnboardingStage: async (_stage: string, _workspaceId: string, _resume: string,
      operation: () => Promise<unknown>) => operation(),
    waitForRepositoryReadiness: async () => {
      await record('repository_readiness_wait');
      return { outcome: 'pending', state: 'accepted', ready: false, candidateId: 'candidate_fixture', attempts: 1 };
    },
    runOrganizationCommand: async () => ({ ok: true }),
    requireCompletedBootstrapEvidence: () => undefined,
    summarizeBootstrapOrganizationApi: () => ({ ok: true }),
    loadAgentFabricOnboardingContract: async () => ({ markdown: '# fixture', sha256: 'a'.repeat(64) }),
    namedSessionCommand: async () => { await record('named_session'); return { ok: true, state: 'running' }; },
  };
  return { dependencies, calls };
}

test('host onboarding cannot replace absent accepted enrollment with a legacy login', async () => {
  const f = bootstrapDependencies({}); let logins = 0;
  f.dependencies.login = async () => {logins++; return {status: 'pending'};};
  const onboard = await caller('onboard', f.dependencies);
  const workspace = resolve('/fixture', 'onboard');
  const flags = new Map<string, string | boolean>([['workspace', workspace],
    ['organization-id', 'org_fixture'], ['policy-revision', 'policy-v1']]);
  const uuid = '11111111-1111-4111-8111-111111111111', digest = `sha256:${'a'.repeat(64)}`;
  const now = Date.now();
  await assert.rejects(runCodexBootstrapHost({workspace, signal: new AbortController().signal, current: async () => true,
    intent: {schema: 'dharma.codex-setup-intent/v1', operationId: uuid, setupReference: uuid,
      organizationId: 'org_fixture', recipientMembershipId: uuid, origin: 'https://fixture.invalid',
      repositoryFingerprint: digest, policyRevision: 'policy-v1', scopeDigest: digest, contractDigest: digest,
      hostContextId: uuid, issuedAt: new Date(now - 1000).toISOString(), expiresAt: new Date(now + 60_000).toISOString()},
  }, async () => onboard(flags)), {message: 'codex_setup_host_enrollment_missing'});
  assert.equal(logins, 0);
  assert.equal((await onboard(flags)).stage, 'approve_device');
  assert.equal(logins, 1, 'ordinary legacy onboarding keeps its existing login path');
});

test('registry recovery command plans before applying one current-device anchor row', async () => {
  const workspace = resolve('/fixture', 'anchor');
  const policyPath = resolve(workspace, '.dharma', 'approved-policy.json');
  const launcher = resolve(workspace, '.dharma', 'bin', process.platform === 'win32' ? 'dharma.cmd' : 'dharma');
  const path = resolve('/fixture', 'home', 'registry', 'workspaces.json');
  const calls: string[] = [];
  const scope = { organizationId: 'org_fixture', deviceId: 'device_fixture', workspaceId: 'workspace_fixture',
    policyRevision: 'revision_fixture', repositoryFingerprint: 'sha256:remote_fixture' };
  const dependencies = {
    readDeviceConfig: async () => ({ organizationId: scope.organizationId, deviceId: scope.deviceId }),
    loadDeviceEnrollmentAnchor: async () => ({ serverPublicKeyEd25519: 'server_key' }),
    realpath: async () => workspace,
    dharmaHome: () => resolve('/fixture', 'home'),
    inspectOwnedRelayAutostart: async () => ({ workspace, policy: policyPath, launcher }),
    resolve, basename, createHash, process,
    loadOrganizationPolicy: async () => ({ organizationId: scope.organizationId, revision: scope.policyRevision,
      serverAuthorization: { workspaceId: scope.workspaceId } }),
    verifyServerAuthorizedPolicy: () => { calls.push('signed_policy'); },
    assertWorkspaceAuthorizationCurrent: async () => { calls.push('replay_state'); },
    gitValue: async () => 'git@github.com:fixture/anchor.git',
    sourceRepositoryFingerprint: () => ({ fingerprint: scope.repositoryFingerprint }),
    organizationApi: async () => ({
      listWorkspaces: async () => ({ ok: true, organizationId: scope.organizationId, workspaces: [{
        id: scope.workspaceId, device_id: scope.deviceId, status: 'active', policy_revision: scope.policyRevision,
        repository_binding_id: 'binding_fixture',
      }] }),
      listRepositoryAgents: async () => ({ ok: true, organizationId: scope.organizationId, repositoryAgents: [{
        id: 'binding_fixture', status: 'active', source_repository_fingerprint: scope.repositoryFingerprint,
        organization_agent_id: 'agent_fixture', control_branch: 'agent-fabric/control',
        agent: { id: 'agent_fixture', agent_key: 'agent_key' },
        workspaces: [{ id: scope.workspaceId, device_id: scope.deviceId,
          repository_binding_id: 'binding_fixture', status: 'active' }],
        endpoints: [{ id: 'endpoint_fixture', workspace_id: scope.workspaceId, device_id: scope.deviceId,
          organization_agent_id: 'agent_fixture', endpoint_kind: 'local_provider',
          credential_boundary: 'local_device', provider: 'codex', status: 'active' }],
      }] }),
    }),
    resolveRegistryRecoveryProjection,
    workspaceRegistryPath: () => path,
    inspectRegistryRecoveryFile: async () => ({ kind: 'corrupt_zero', hash: 'sha256:empty',
      bytes: Buffer.alloc(0), records: [] }),
    appendRecoveredWorkspace,
    acquirePidLock: async () => { calls.push('lock'); return async () => { calls.push('unlock'); }; },
    applyRegistryRecoveryFile: async (input: { entry: { workspaceId: string }; expectedHash: string }) => {
      assert.equal(input.entry.workspaceId, scope.workspaceId);
      assert.equal(input.expectedHash, 'sha256:empty');
      calls.push('apply');
      return { state: 'recovered', backup: 'private-backup', restoredCount: 1 };
    },
  };
  const command = await caller('workspaceRecoverRegistry', dependencies);
  const dryRun = await command(new Map<string, string | boolean>([['workspace', workspace], ['dry-run', true]]));
  assert.equal(dryRun.dryRun, true);
  assert.equal(dryRun.backupRequired, true);
  assert.equal(dryRun.serverMutation, false);
  assert.deepEqual(calls, ['signed_policy', 'replay_state']);
  const applied = await command(new Map<string, string | boolean>([['workspace', workspace], ['apply', true]]));
  assert.equal(applied.state, 'recovered');
  assert.equal(applied.serverMutation, false);
  assert.deepEqual(calls, ['signed_policy', 'replay_state', 'signed_policy', 'replay_state',
    'lock', 'apply', 'unlock']);
});

test('bootstrap preserves only a verified current-device startup anchor before enabling another repository', async () => {
  const f = bootstrapDependencies({ ok: true, stage: 'ready', localStage: 'ready', sharedRepositoryReady: true });
  f.dependencies.relayAutostartStatus = async () => ({ state: 'enabled', backend: 'systemd-user' });
  f.dependencies.inspectOwnedRelayAutostart = async () => ({ workspace: '/first', policy: resolve('/first', '.dharma', 'approved-policy.json') });
  let reads = 0;
  f.dependencies.readDeviceConfig = async () => ++reads === 1 ? null
    : { organizationId: 'org_fixture', deviceId: 'fixture_device' };
  f.dependencies.registry = async () => [{ workspaceId: 'fixture_first', organizationId: 'org_fixture',
    path: '/first', routeHash: 'route', repositoryRemoteHash: 'remote' }];
  f.dependencies.selectDeviceWorkspace = () => ({ workspaceId: 'fixture_first', routeHash: 'route', repositoryRemoteHash: 'remote' });
  f.dependencies.loadOrganizationPolicy = async () => ({ serverAuthorization: { workspaceId: 'fixture_first' } });
  f.dependencies.loadVerifiedWorkspacePolicy = async (_path: string, workspaceId: string) => {
    assert.equal(workspaceId, 'fixture_first'); f.calls.push('verify_existing_anchor');
  };
  f.dependencies.enableRelayAutostart = async (options: { preserveStandardAnchor: boolean }) => {
    assert.equal(options.preserveStandardAnchor, true); f.calls.push('autostart');
    return { state: 'enabled', backend: 'systemd-user' };
  };
  await (await caller('bootstrap', f.dependencies))(bootstrapFlags());
  assert.ok(f.calls.indexOf('verify_existing_anchor') < f.calls.indexOf('autostart'));
});

test('bootstrap selects the authorized remote before redeeming and reports its actual checkout', async () => {
  const f = bootstrapDependencies({ ok: true, stage: 'ready', localStage: 'ready', sharedRepositoryReady: true });
  f.dependencies.resolveBootstrapRepositoryWorkspace = async () => {
    f.calls.push('selected_checkout');
    return { workspace: '/managed/customer-jobs', selection: 'managed_cloned' };
  };
  f.dependencies.redeemBootstrapGrant = async () => {
    f.calls.push('redeem');
    return { deviceId: 'fixture_device', serverPublicKeyEd25519: 'fixture_server_key',
      relayUrl: 'wss://fixture.invalid', organizationApiToken: 'fixture_token', organizationApiTokenScopes: [] };
  };
  f.dependencies.dharmaHome = () => '/fixture-home';
  f.dependencies.normalizeGitRemoteIdentity = () => 'github.com/customer/jobs';
  f.dependencies.acquirePidLock = async () => async () => {};
  const flags = bootstrapFlags();
  flags.set('repository-url-base64url', Buffer.from('https://github.com/customer/jobs.git').toString('base64url'));
  const receipt = await (await caller('bootstrap', f.dependencies))(flags);
  assert.deepEqual(f.calls.slice(0, 3), ['selected_checkout', 'preflight', 'redeem']);
  assert.equal((receipt.repositorySelection as Record<string, unknown>).workspace, '/managed/customer-jobs');
  assert.equal((receipt.repositorySelection as Record<string, unknown>).selection, 'managed_cloned');
});

test('existing organization binding enrolls without a Git checkout or source inventory', async () => {
  const f = bootstrapDependencies({ ok: true, stage: 'ready', localStage: 'ready', sharedRepositoryReady: true });
  f.dependencies.redeemBootstrapGrant = async (input: { repositoryFingerprint: string }) => {
    assert.equal(input.repositoryFingerprint, '');
    f.calls.push('redeem');
    return { deviceId: 'fixture_device', serverPublicKeyEd25519: 'fixture_server_key',
      relayUrl: 'wss://fixture.invalid', organizationApiToken: 'fixture_token', organizationApiTokenScopes: [] };
  };
  const flags = bootstrapFlags();
  const bindingId = '22222222-2222-4222-8222-222222222222';
  flags.set('join-repository-binding-id', bindingId);
  flags.set('join-source-fingerprint', `sha256:${'a'.repeat(64)}`);
  const receipt = await (await caller('bootstrap', f.dependencies))(flags);
  assert.equal((receipt.repositorySelection as Record<string, unknown>).selection, 'existing_organization_binding');
  assert.ok(f.calls.indexOf('redeem') < f.calls.indexOf('join_existing'));
  assert.ok(!f.calls.includes('preflight'));
  assert.ok(!f.calls.includes('onboard'));
});

test('joining an existing package registers only a managed knowledge endpoint', async () => {
  const calls: string[] = [];
  const bindingId = '22222222-2222-4222-8222-222222222222';
  const fingerprint = `sha256:${'a'.repeat(64)}`;
  let item: Record<string, unknown> | null = null;
  const dependencies = {
    readDeviceConfig: async () => ({ organizationId: 'org_fixture', deviceId: 'device_fixture', hqUrl: 'https://fixture.invalid' }),
    required: (flags: Map<string, string>, name: string) => String(flags.get(name)),
    dharmaHome: () => '/fixture-home', resolve, realpath: async (path: string) => path,
    mkdir: async () => undefined,
    readFile: async () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); },
    readdir: async () => [],
    writeJsonAtomic: async () => { calls.push('marker'); },
    gitValue: async () => null,
    execFileAsync: async (_bin: string, args: string[]) => { calls.push(args.includes('init') ? 'managed_git_init' : 'managed_empty_commit'); },
    workspaceIdForDevice: () => '33333333-3333-4333-8333-333333333333',
    selectDeviceWorkspace: () => item,
    registry: async () => item ? [item] : [],
    createHash, canonicalize: (value: unknown) => JSON.stringify(value),
    sha256: (value: string) => `sha256:${createHash('sha256').update(value).digest('hex')}`,
    saveWorkspaceRecord: async (entry: Record<string, unknown>) => { item = entry; calls.push('registry'); },
    client: async () => ({}),
    syncWorkspacePolicy: async () => { calls.push('policy'); return { workspace: { id: item?.workspaceId, status: 'active' } }; },
    reconcileWorkspaceRegistration: () => item,
    bindRepositoryAgent: async (_fabric: unknown, entry: Record<string, unknown>, selected: string) => {
      assert.equal(selected, bindingId); calls.push('bind_existing');
      return { ...entry, repositoryBindingId: bindingId,
        repositoryAgentId: '44444444-4444-4444-8444-444444444444',
        repositoryAgentKey: `repo:${'a'.repeat(24)}`, controlBranch: 'agents/fixture-aaaaaaaa',
        endpointId: '55555555-5555-4555-8555-555555555555',
        repositoryPackage: { state: 'published' } };
    },
    repositoryRoleScope: () => ({}),
    registerRepositoryRoleMetadata: async () => ({ role: { revision: 1 } }),
    receiptAwareProviderCapabilities: async () => [{ provider: 'codex' }],
    selectedProviderAdapters: () => [{ capability: async () => ({ provider: 'codex' }) }],
    loadAgentFabricOnboardingContract: async () => ({ markdown: '# Joined operating contract' }),
    installRepositoryJoinConnection: async (input: Record<string, unknown>) => {
      assert.equal(input.bindingId, bindingId);
      assert.equal(input.sourceFingerprint, fingerprint);
      assert.equal(input.organizationId, 'org_fixture');
      assert.equal(input.workspaceId, '33333333-3333-4333-8333-333333333333');
      assert.equal(input.repositoryAgentId, '44444444-4444-4444-8444-444444444444');
      assert.equal(input.onboardingMarkdown, '# Joined operating contract');
      calls.push('join_connection');
    },
    installAvailableNativeAgentFabricBootstraps: async () => { calls.push('native_bootstrap'); return { installed: ['codex'], failures: [] }; },
    startRelayDaemon: async () => ({ state: 'running' }),
    repositorySharedReady: async () => true,
    isLocalProviderId: (value: string) => value === 'codex',
    basename,
  };
  const result = await (await caller('joinExistingRepository', dependencies))(
    new Map([['organization-id', 'org_fixture'], ['policy-revision', 'policy-v1'], ['provider', 'codex']]),
    bindingId, fingerprint);
  assert.equal(result.accessMode, 'knowledge_only');
  assert.equal(result.sharedRepositoryReady, true);
  assert.equal((result.firstLearningEvidence as Record<string, unknown>).state, 'shared_package_inherited');
  assert.deepEqual(calls.slice(0, 5), ['marker', 'managed_git_init', 'managed_empty_commit', 'registry', 'policy']);
  assert.ok(calls.includes('bind_existing'));
  assert.ok(calls.indexOf('bind_existing') < calls.indexOf('join_connection'));
  assert.ok(calls.indexOf('join_connection') < calls.indexOf('native_bootstrap'));
});

test('knowledge-only workspaces cannot be promoted through source registration or inventory', async () => {
  const workspace = resolve('/fixture-home', 'joined-repositories', 'binding');
  const record = { path: workspace, organizationId: 'org_fixture', workspaceId: 'workspace_fixture',
    accessMode: 'knowledge_only' };
  const add = await caller('workspaceAdd', {
    realpath: async () => workspace, registry: async () => [record],
  });
  await assert.rejects(() => add(new Map(), [workspace]), /repository_join_source_operation_denied/);
  const snapshot = await caller('repositorySnapshotCommand', {
    registry: async () => [record], resolve,
  });
  await assert.rejects(() => snapshot(new Map([
    ['workspace', workspace], ['organization-id', 'org_fixture'], ['workspace-id', 'workspace_fixture'],
  ]), []), /repository_join_source_operation_denied/);
});

test('knowledge-only task preflight rejects writable authority before policy or provider access', async () => {
  const events: unknown[] = [];
  const task = { taskId: 'task_fixture', workspaceId: 'workspace_fixture', taskType: 'external_request',
    authority: { readPaths: ['.'], writePaths: ['src/**'], commands: [], network: 'deny' },
    acceptance: { commands: [], requiredArtifacts: [] } };
  const fabric = {
    pollTask: async () => ({ task: { envelope: task } }),
    postTaskEvent: async (...args: unknown[]) => { events.push(args); },
  };
  const run = await caller('executeOneTask', {
    registry: async () => [{ workspaceId: 'workspace_fixture', accessMode: 'knowledge_only' }],
    refreshVerifiedWorkspacePolicyForTransmission: async () => { throw new Error('must not read policy'); },
  });
  const result = await run(fabric, 30);
  assert.equal(result.code, 'knowledge_only_task_denied');
  assert.deepEqual(JSON.parse(JSON.stringify(events)), [['task_fixture', 'failed', {
    phase: 'preflight', code: 'knowledge_only_task_denied',
  }]]);
});

test('repository checkout failure returns a typed receipt without redeeming the grant', async () => {
  const f = bootstrapDependencies({ ok: true, stage: 'ready', localStage: 'ready', sharedRepositoryReady: true });
  f.dependencies.resolveBootstrapRepositoryWorkspace = async () => {
    throw new Error('repository_checkout_failed: helper exposed SECRET');
  };
  f.dependencies.dharmaHome = () => '/fixture-home';
  f.dependencies.normalizeGitRemoteIdentity = () => 'github.com/customer/jobs';
  f.dependencies.acquirePidLock = async () => async () => {};
  const flags = bootstrapFlags();
  flags.set('repository-url-base64url', Buffer.from('https://github.com/customer/jobs.git').toString('base64url'));
  const receipt = await (await caller('bootstrap', f.dependencies))(flags);
  assert.equal(receipt.ok, false);
  assert.equal(receipt.stage, 'repository_selection');
  assert.equal(receipt.code, 'repository_checkout_failed');
  assert.equal(receipt.grantRedeemed, false);
  assert.deepEqual(f.calls, []);
  assert.doesNotMatch(JSON.stringify(receipt), /SECRET|fixture_grant/);
});

test('bootstrap passes recipient approval to the verified browser opener before storing credentials', async () => {
  const f = bootstrapDependencies({ ok: true, stage: 'ready', localStage: 'ready', sharedRepositoryReady: true });
  f.dependencies.redeemBootstrapGrant = async (input: {
    onRecipientApprovalRequired: (approval: { url: string; expiresAt: string; fingerprint: string }) => Promise<void>;
  }) => {
    await input.onRecipientApprovalRequired({
      url: 'https://fixture.invalid/login?redirect_url=%2Fportal%2Fagent-fabric%2Fbootstrap-approval',
      expiresAt: '2026-09-19T00:15:00.000Z', fingerprint: `sha256:${'a'.repeat(64)}`,
    });
    return { deviceId: 'fixture_device', serverPublicKeyEd25519: 'fixture_server_key',
      relayUrl: 'wss://fixture.invalid', organizationApiToken: 'fixture_token', organizationApiTokenScopes: [] };
  };
  const actual = await (await caller('bootstrap', f.dependencies))(bootstrapFlags());
  const enrollment = actual.enrollment as Record<string, unknown>;
  const approval = enrollment.recipientApproval as Record<string, unknown>;
  assert.equal(approval.required, true);
  assert.equal(approval.browserOpened, true);
  assert.equal(f.calls.filter(item => item === 'open_approval').length, 1);
  assert.ok(f.calls.indexOf('open_approval') < f.calls.indexOf('save_token'));
  assert.ok(f.calls.indexOf('launcher') < f.calls.indexOf('autostart'));
  assert.ok(f.calls.indexOf('startup_lock') < f.calls.indexOf('autostart'));
});
function bootstrapFlags(complete = false) {
  const flags = new Map<string, string | boolean>([
    ['organization-id', 'org_fixture'], ['grant', 'fixture_grant'], ['workspace', '/fixture-repository'],
    ['policy-revision', 'fixture-policy'], ['provider', 'codex'],
  ]);
  if (complete) flags.set('complete', true);
  return flags;
}

test('private grant entry follows preflight, uses the unchanged redemption scope and stays out of onboard flags', async () => {
  const f = bootstrapDependencies({ ok: true, stage: 'ready', localStage: 'ready', sharedRepositoryReady: true });
  const flags = bootstrapFlags(); flags.delete('grant'); flags.set('grant-prompt', true);
  const originalOnboard = f.dependencies.onboard as (flags: Map<string, string | boolean>) => Promise<unknown>;
  f.dependencies.onboard = async (onboardFlags: Map<string, string | boolean>) => {
    assert.equal(onboardFlags.has('grant'), false);
    assert.equal(onboardFlags.has('grant-prompt'), false);
    return originalOnboard(onboardFlags);
  };
  f.dependencies.redeemBootstrapGrant = async (input: Record<string, unknown>) => {
    assert.equal(input.bootstrapToken, 'fixture_private_grant');
    assert.equal(input.organizationId, 'org_fixture');
    assert.equal(input.hqUrl, 'https://fixture.invalid');
    assert.equal(input.repositoryFingerprint, `sha256:${'e'.repeat(64)}`);
    assert.equal(typeof input.onRecipientApprovalRequired, 'function');
    f.calls.push('redeem');
    return { deviceId: 'fixture_device', serverPublicKeyEd25519: 'fixture_server_key',
      relayUrl: 'wss://fixture.invalid', organizationApiToken: 'fixture_token', organizationApiTokenScopes: [] };
  };
  await (await caller('bootstrap', f.dependencies))(flags);
  assert.ok(f.calls.indexOf('preflight') < f.calls.indexOf('private_grant'));
  assert.ok(f.calls.indexOf('private_grant') < f.calls.indexOf('redeem'));
});

test('foreign enrollment and grant-option conflict stop before private entry or redemption', async () => {
  for (const conflict of [false, true]) {
    const f = bootstrapDependencies({ ok: true });
    const flags = bootstrapFlags(); flags.set('grant-prompt', true);
    if (!conflict) {
      flags.delete('grant');
      f.dependencies.readDeviceConfig = async () => ({ organizationId: 'org_other', hqUrl: 'https://fixture.invalid' });
    }
    f.dependencies.redeemBootstrapGrant = async () => { throw new Error('must not redeem'); };
    await assert.rejects((await caller('bootstrap', f.dependencies))(flags), conflict
      ? /bootstrap_grant_options_invalid/ : /another organization or portal/);
    assert.equal(f.calls.includes('private_grant'), false);
  }
});

test('redemption failure never reflects private terminal input into an error', async () => {
  for (const message of ['reflected fixture_private_grant', 'grant_expired']) {
    const f = bootstrapDependencies({ ok: true });
    const flags = bootstrapFlags(); flags.delete('grant'); flags.set('grant-prompt', true);
    f.dependencies.redeemBootstrapGrant = async () => { throw new Error(message); };
    // The actual function runs in a separate VM realm; the Error need not share its constructor.
    await assert.rejects((await caller('bootstrap', f.dependencies))(flags), (error: unknown) => {
      const text = String(error);
      assert.equal(text.includes('fixture_private_grant'), false);
      assert.match(text, message === 'grant_expired' ? /grant_expired/ : /bootstrap_redemption_failed/);
      return true;
    });
    assert.equal(f.calls.includes('save_device'), false);
  }
});

async function resumeFixture() {
  const f = bootstrapDependencies({ ok: true, stage: 'ready', localStage: 'ready',
    sharedRepositoryReady: true, workspaceId: 'workspace_fixture' });
  f.dependencies.readDeviceConfig = async () => ({
    organizationId: 'org_fixture', hqUrl: 'https://fixture.invalid', deviceId: 'fixture_device',
    installationId: '11111111-1111-4111-8111-111111111111',
  });
  f.dependencies.assertBootstrapResumeAuthority = await caller('assertBootstrapResumeAuthority', {
    ...f.dependencies, exports: {},
  });
  const flags = bootstrapFlags(true);
  flags.delete('grant');
  flags.set('resume', true);
  return { ...f, flags };
}

test('resume with an absent organization credential stops before repository or runtime mutation', async () => {
  const f = await resumeFixture();
  f.dependencies.loadOrganizationApiToken = async () => null;
  const actual = await (await caller('bootstrap', f.dependencies))(f.flags);
  assert.equal(actual.ok, false);
  assert.equal(actual.stage, 'organization_api_credentials');
  assert.equal(actual.code, 'organization_api_credentials_required');
  assert.equal(actual.sharedRepositoryReady, false);
  assert.equal((actual.enrollment as Record<string, unknown>).organizationApiTokenStored, false);
  assert.equal((actual.enrollment as Record<string, unknown>).deviceId, 'fixture_device');
  assert.deepEqual(f.calls, ['preflight']);
  assert.doesNotMatch(JSON.stringify(actual), /fixture_grant|fixture_token/);
});

test('resume verifies its exact installation-scoped credential without repeating enrollment', async () => {
  const f = await resumeFixture();
  let requestedScope: unknown;
  f.dependencies.loadOrganizationApiToken = async (scope: unknown) => {
    requestedScope = scope; return 'fixture_token';
  };
  const actual = await (await caller('bootstrap', f.dependencies))(f.flags);
  assert.equal(actual.stage, 'complete');
  assert.equal((actual.enrollment as Record<string, unknown>).organizationApiTokenStored, true);
  assert.deepEqual(JSON.parse(JSON.stringify(requestedScope)), {
    hqUrl: 'https://fixture.invalid', organizationId: 'org_fixture',
    installationId: '11111111-1111-4111-8111-111111111111',
  });
  assert.equal(f.calls.includes('save_device'), false);
  assert.equal(f.calls.includes('save_token'), false);
  assert.doesNotMatch(JSON.stringify(actual), /fixture_token/);
});

test('an environment-only credential is usable but never reported as durably stored', async () => {
  const f = await resumeFixture();
  f.dependencies.loadOrganizationApiToken = async () => null;
  f.dependencies.process = { platform: 'linux', env: { DHARMA_ORG_API_TOKEN: 'fixture_environment_token' },
    stderr: { write: () => true } };
  const actual = await (await caller('bootstrap', f.dependencies))(f.flags);
  assert.equal(actual.stage, 'complete');
  assert.equal((actual.enrollment as Record<string, unknown>).organizationApiTokenStored, false);
  assert.equal(f.calls.includes('save_token'), false);
  assert.doesNotMatch(JSON.stringify(actual), /fixture_environment_token/);
});

test('a secure-store failure produces a safe credential-stage receipt before mutation', async () => {
  const f = await resumeFixture();
  f.dependencies.loadOrganizationApiToken = async () => { throw new Error('backend leaked fixture_sensitive_value'); };
  const actual = await (await caller('bootstrap', f.dependencies))(f.flags);
  assert.equal(actual.ok, false);
  assert.equal(actual.stage, 'organization_api_credentials');
  assert.equal(actual.code, 'organization_api_credential_store_unavailable');
  assert.equal((actual.enrollment as Record<string, unknown>).organizationApiTokenStored, false);
  assert.deepEqual(f.calls, ['preflight']);
  assert.doesNotMatch(JSON.stringify(actual), /fixture_sensitive_value/);
});

test('standard account rebind cannot archive Demo watch state or signal its processes', async () => {
  const calls: string[] = [];
  const record = async (name: string) => { calls.push(name); };
  const dependencies = { resolve, dirname, dharmaHome: () => '/fixture-home',
    listDemoWatchRegistrations: async () => [{ repositoryId: 'existing-demo-scope' }],
    withRelayStartupMutation: async (operation: () => Promise<unknown>) => operation(),
    readFile: async () => '0', process: { kill: () => calls.push('kill') },
    createHash: () => ({ update: () => ({ digest: () => 'a'.repeat(64) }) }),
    disableRelayAutostart: async () => record('disable'), mkdir: async () => record('mkdir'),
    pathExists: async () => false, rename: async () => record('rename'),
    writeJsonAtomic: async () => record('receipt'),
  };
  await assert.rejects((await caller('archiveEnrollmentForAuthorizedRebind', dependencies))({
    organizationId: 'org_previous', hqUrl: 'https://fixture.invalid',
  }), /demo_watch_standard_rebind_conflict/);
  assert.deepEqual(calls, []);
});

test('bootstrap propagates blocked repository onboarding without launcher or completion work', async () => {
  const onboarding = { ok: false, stage: 'repository_source_authorization_required',
    code: 'repository_source_policy_unavailable', sharedRepositoryReady: false };
  const f = bootstrapDependencies(onboarding);
  const actual = await (await caller('bootstrap', f.dependencies))(bootstrapFlags());
  assert.equal(actual.ok, false);
  assert.equal(actual.stage, onboarding.stage);
  assert.equal(actual.sharedRepositoryReady, false);
  assert.equal(f.calls.includes('launcher'), false);
  assert.equal(f.calls.includes('relay'), false);
});

test('bootstrap complete cannot report shared completion while its canonical repository package is pending', async () => {
  const onboarding = { ok: true, stage: 'shared_repository_pending', localStage: 'ready', sharedRepositoryReady: false };
  const f = bootstrapDependencies(onboarding);
  const actual = await (await caller('bootstrap', f.dependencies))(bootstrapFlags(true));
  assert.equal(actual.ok, false);
  assert.equal(actual.stage, 'shared_repository_pending');
  assert.equal(actual.localStage, 'complete');
  assert.equal(actual.sharedRepositoryReady, false);
  assert.equal(f.calls.includes('launcher'), true);
  assert.equal(f.calls.includes('relay'), true);
  assert.equal(f.calls.includes('repository_readiness_wait'), true);
});

test('bootstrap completes after the relay installs the signed shared release', async () => {
  const f = bootstrapDependencies({ ok: true, stage: 'shared_repository_pending', localStage: 'ready',
    sharedRepositoryReady: false, workspaceId: 'workspace_fixture' });
  f.dependencies.waitForRepositoryReadiness = async () => ({ outcome: 'ready', state: 'published',
    ready: true, candidateId: 'candidate_fixture', attempts: 3 });
  const actual = await (await caller('bootstrap', f.dependencies))(bootstrapFlags(true));
  assert.equal(actual.ok, true);
  assert.equal(actual.stage, 'complete');
  assert.equal(actual.sharedRepositoryReady, true);
  assert.equal((actual.repositoryReadiness as Record<string, unknown>).attempts, 3);
  assert.equal((actual.namedSession as Record<string, unknown>).state, 'running');
  assert.equal((actual.workflowReadiness as Record<string, unknown>).namedSession, 'ready');
  assert.equal(f.calls.filter(value => value === 'named_session').length, 1);
});

test('published-package secret denial stays visible without repeating evidence capture', async () => {
  const f = bootstrapDependencies({ ok: true, stage: 'ready', localStage: 'ready',
    sharedRepositoryReady: true, workspaceId: 'workspace_fixture',
    firstLearningEvidence: { state: 'denied_disclosure', discovered: 20, captured: null, synced: null,
      disclosureReady: true, reason: 'policy_boundary', errorCode: 'secret_disclosure_forbidden' } });
  const actual = await (await caller('bootstrap', f.dependencies))(bootstrapFlags(true));
  assert.equal(actual.ok, true);
  assert.equal(actual.stage, 'complete');
  assert.equal((actual.workflowReadiness as Record<string, unknown>).firstLearning, 'denied_disclosure');
  assert.equal(((actual.evidence as Record<string, unknown>).synchronized as Record<string, unknown>).errorCode,
    'secret_disclosure_forbidden');
});

test('missing first-learning disposition cannot produce a complete receipt', async () => {
  const f = bootstrapDependencies({ ok: true, stage: 'ready', localStage: 'ready',
    sharedRepositoryReady: true, workspaceId: 'workspace_fixture', firstLearningEvidence: null });
  const actual = await (await caller('bootstrap', f.dependencies))(bootstrapFlags(true));
  assert.equal(actual.ok, false);
  assert.equal(actual.stage, 'first_learning_pending');
});

test('bootstrap cannot report complete without a registered role, running relay, and startup', async () => {
  const missingRole = bootstrapDependencies({ ok: true, stage: 'ready', localStage: 'ready',
    sharedRepositoryReady: true, workspaceId: 'workspace_fixture', repositoryRole: null });
  const roleResult = await (await caller('bootstrap', missingRole.dependencies))(bootstrapFlags(true));
  assert.equal(roleResult.ok, false);
  assert.equal(roleResult.stage, 'role_registration_pending');

  const stoppedRelay = bootstrapDependencies({ ok: true, stage: 'ready', localStage: 'ready',
    sharedRepositoryReady: true, workspaceId: 'workspace_fixture' });
  stoppedRelay.dependencies.startRelayDaemon = async () => ({ started: false, state: 'stopped' });
  const relayResult = await (await caller('bootstrap', stoppedRelay.dependencies))(bootstrapFlags(true));
  assert.equal(relayResult.ok, false);
  assert.equal(relayResult.stage, 'synchronization_pending');

  const disabledStartup = bootstrapDependencies({ ok: true, stage: 'ready', localStage: 'ready',
    sharedRepositoryReady: true, workspaceId: 'workspace_fixture' });
  disabledStartup.dependencies.enableRelayAutostart = async () => ({ state: 'disabled', backend: null });
  const startupResult = await (await caller('bootstrap', disabledStartup.dependencies))(bootstrapFlags(true));
  assert.equal(startupResult.ok, false);
  assert.equal(startupResult.stage, 'autostart_pending');
});

test('a failed named session cannot produce a complete bootstrap receipt', async () => {
  const f = bootstrapDependencies({ ok: true, stage: 'ready', localStage: 'ready',
    sharedRepositoryReady: true, workspaceId: 'workspace_fixture' });
  f.dependencies.namedSessionCommand = async () => { throw new Error('named_session_provider_authentication_required'); };
  await assert.rejects((await caller('bootstrap', f.dependencies))(bootstrapFlags(true)), /provider_authentication_required/);
});

test('a stopped named session keeps an otherwise ready bootstrap incomplete', async () => {
  const f = bootstrapDependencies({ ok: true, stage: 'ready', localStage: 'ready',
    sharedRepositoryReady: true, workspaceId: 'workspace_fixture' });
  f.dependencies.namedSessionCommand = async () => ({ ok: true, state: 'stopped' });
  const actual = await (await caller('bootstrap', f.dependencies))(bootstrapFlags(true));
  assert.equal(actual.ok, false);
  assert.equal(actual.stage, 'named_session_pending');
  assert.equal((actual.workflowReadiness as Record<string, unknown>).namedSession, 'pending');
});

test('bootstrap reports a blocked repository candidate without replaying enrollment', async () => {
  const f = bootstrapDependencies({ ok: true, stage: 'shared_repository_pending', localStage: 'ready',
    sharedRepositoryReady: false, workspaceId: 'workspace_fixture' });
  f.dependencies.waitForRepositoryReadiness = async () => ({ outcome: 'blocked', state: 'blocked',
    ready: false, candidateId: 'candidate_fixture', attempts: 2 });
  const actual = await (await caller('bootstrap', f.dependencies))(bootstrapFlags(true));
  assert.equal(actual.ok, false);
  assert.equal(actual.stage, 'shared_repository_blocked');
  assert.equal(f.calls.filter(item => item === 'save_token').length, 1);
});

test('repository connect separates attempts and local readiness from shared connections', async () => {
  const pending = { ok: true, stage: 'shared_repository_pending', localStage: 'ready', sharedRepositoryReady: false };
  const blocked = { ok: false, stage: 'repository_source_authorization_required', sharedRepositoryReady: false };
  const actual = await (await caller('repositoriesConnect', {
    realpath: async (path: string) => path,
    repositoryKeyAssignments: () => new Map(), parseSelectedProviderIds: () => null,
    onboard: async (flags: Map<string, string | boolean>) => flags.get('workspace') === '/repo-a' ? pending : blocked,
  }))(new Map(), ['/repo-a', '/repo-b'], [], [], []);
  assert.equal(actual.ok, false);
  assert.equal(actual.requested, 2);
  assert.equal(actual.attempted, 2);
  assert.equal(actual.locallyReady, 1);
  assert.equal(actual.connected, 0);
  assert.equal(actual.blocked, 1);
  assert.equal(actual.pending, 1);
});

test('complete bootstrap stops before local completion work when repository onboarding is blocked', async () => {
  const f = bootstrapDependencies({ ok: false, stage: 'repository_source_authorization_required', sharedRepositoryReady: false });
  const actual = await (await caller('bootstrap', f.dependencies))(bootstrapFlags(true));
  assert.equal(actual.ok, false);
  assert.equal(actual.sharedRepositoryReady, false);
  assert.equal(f.calls.includes('launcher'), false);
  assert.equal(f.calls.includes('relay'), false);
});

test('bootstrap preserves device approval as a pending stage without starting completion work', async () => {
  const f = bootstrapDependencies({ ok: true, stage: 'approve_device' });
  const actual = await (await caller('bootstrap', f.dependencies))(bootstrapFlags(true));
  assert.equal(actual.stage, 'approve_device');
  assert.equal(actual.sharedRepositoryReady, false);
  assert.equal(f.calls.includes('launcher'), false);
  assert.equal(f.calls.includes('relay'), false);
});

test('bootstrap retains complete behavior for explicitly shared-ready repository onboarding', async () => {
  const f = bootstrapDependencies({ ok: true, stage: 'ready', localStage: 'ready', sharedRepositoryReady: true });
  const actual = await (await caller('bootstrap', f.dependencies))(bootstrapFlags(true));
  assert.equal(actual.stage, 'complete');
  assert.equal(actual.localStage, 'complete');
  assert.equal(actual.sharedRepositoryReady, true);
  assert.equal(f.calls.includes('relay'), true);
});

test('legacy local-ready bootstrap cannot imply shared repository readiness', async () => {
  const f = bootstrapDependencies({ ok: true, stage: 'ready' });
  const actual = await (await caller('bootstrap', f.dependencies))(bootstrapFlags());
  assert.equal(actual.stage, 'shared_repository_pending');
  assert.equal(actual.localStage, 'ready');
  assert.equal(actual.sharedRepositoryReady, false);
  assert.equal(f.calls.includes('launcher'), true);
});

test('repository connect preserves approval interruption and distinguishes legacy local readiness', async () => {
  const visited: string[] = [];
  const actual = await (await caller('repositoriesConnect', {
    realpath: async (path: string) => path,
    repositoryKeyAssignments: () => new Map(), parseSelectedProviderIds: () => null,
    onboard: async (flags: Map<string, string | boolean>) => {
      const path = String(flags.get('workspace')); visited.push(path);
      if (path === '/repo-a') return { ok: true, stage: 'ready', sharedRepositoryReady: true };
      if (path === '/repo-b') return { ok: true, stage: 'ready' };
      return { ok: true, stage: 'approve_device' };
    },
  }))(new Map(), ['/repo-a', '/repo-b', '/repo-c', '/repo-d'], [], [], []);
  assert.equal(actual.requested, 4);
  assert.equal(actual.attempted, 3);
  assert.equal(actual.connected, 1);
  assert.equal(actual.locallyReady, 2);
  assert.equal(actual.pending, 2);
  assert.equal(actual.blocked, 0);
  assert.equal(actual.sharedRepositoryReady, false);
  assert.deepEqual(visited, ['/repo-a', '/repo-b', '/repo-c']);
});

test('repository connect reports shared readiness only when every requested repository is shared-ready', async () => {
  const actual = await (await caller('repositoriesConnect', {
    realpath: async (path: string) => path,
    repositoryKeyAssignments: () => new Map(), parseSelectedProviderIds: () => null,
    onboard: async () => ({ ok: true, stage: 'ready', sharedRepositoryReady: true }),
  }))(new Map(), ['/repo-a', '/repo-b'], [], [], []);
  assert.equal(actual.ok, true);
  assert.equal(actual.connected, 2);
  assert.equal(actual.attempted, 2);
  assert.equal(actual.pending, 0);
  assert.equal(actual.blocked, 0);
  assert.equal(actual.sharedRepositoryReady, true);
});

test('repository onboarding registers the signed workspace before repository binding', async () => {
  const calls: string[] = [];
  const workspace = { workspaceId: 'workspace_fixture' };
  const actual = await (await caller('registerWorkspaceBeforeRepositoryBind', {
    registry: async () => [workspace],
    reconcileWorkspaceRegistration: () => workspace,
    syncWorkspacePolicy: async (_fabric: unknown, item: unknown, revision: string, apply: boolean, providers: string[]) => {
      calls.push('register_workspace');
      assert.equal(item, workspace);
      assert.equal(revision, 'policy_fixture');
      assert.equal(apply, true);
      assert.deepEqual(providers, ['codex']);
      return { ok: true, workspace: { id: 'workspace_fixture' } };
    },
    bindRepositoryAgent: async (_fabric: unknown, item: unknown) => {
      calls.push('bind_repository');
      assert.equal(item, workspace);
      return { ...workspace, repositoryAgentId: 'agent_fixture' };
    },
  }))({}, workspace, 'policy_fixture', ['codex']);
  assert.deepEqual(calls, ['register_workspace', 'bind_repository']);
  assert.equal((actual.registered as Record<string, unknown>).repositoryAgentId, 'agent_fixture');
  assert.equal((actual.synchronized as Record<string, unknown>).ok, true);
});

test('repository onboarding never binds when signed workspace registration fails', async () => {
  let bound = false;
  await assert.rejects(async () => (await caller('registerWorkspaceBeforeRepositoryBind', {
    syncWorkspacePolicy: async () => { throw new Error('workspace registration denied'); },
    bindRepositoryAgent: async () => { bound = true; return {}; },
  }))({}, {}, 'policy_fixture', null), /workspace registration denied/);
  assert.equal(bound, false);
});

test('truthy non-boolean onboarding readiness cannot imply shared readiness', async () => {
  const f = bootstrapDependencies({ ok: true, stage: 'ready', sharedRepositoryReady: 'true' });
  const actual = await (await caller('bootstrap', f.dependencies))(bootstrapFlags(true));
  assert.equal(actual.stage, 'shared_repository_pending');
  assert.equal(actual.sharedRepositoryReady, false);
});

test('repository connect deduplicates canonical paths before counting attempts and shared readiness', async () => {
  let calls = 0;
  const actual = await (await caller('repositoriesConnect', {
    realpath: async () => '/same-repository',
    repositoryKeyAssignments: () => new Map(), parseSelectedProviderIds: () => null,
    onboard: async () => { calls += 1; return { ok: true, stage: 'ready', sharedRepositoryReady: true }; },
  }))(new Map(), ['/alias-a', '/alias-b'], ['/alias-c'], [], []);
  assert.equal(actual.requested, 1);
  assert.equal(actual.attempted, 1);
  assert.equal(actual.connected, 1);
  assert.equal(actual.sharedRepositoryReady, true);
  assert.equal(calls, 1);
});

test('workspace synchronization validates policy against the server-returned canonical workspace', async () => {
  const { requested, canonical } = registrationFixture();
  const reconcile = await caller('reconcileWorkspaceRegistration', { UUID_PATTERN: /^[0-9a-f-]{36}$/i });
  const calls: string[] = [];
  const response = { ok: true, organizationId: 'org_fixture', workspace: {
    id: canonical.workspaceId, status: 'active', policyRevision: 'policy_fixture',
  }, organizationPolicyAuthorization: { workspaceId: canonical.workspaceId } };
  const fabric = { registerWorkspace: async () => { calls.push('register'); return response; } };
  const actual = await (await caller('syncWorkspacePolicy', {
    receiptAwareProviderCapabilities: async () => [], selectedProviderAdapters: () => [],
    registry: async () => [requested, canonical],
    reconcileWorkspaceRegistration: reconcile,
    readDeviceConfig: async () => ({ serverPublicKeyEd25519: 'fixture_key' }),
    materializeWorkspacePolicy: async (input: { workspaceId: string; dryRun: boolean }) => {
      calls.push('verify');
      assert.equal(input.workspaceId, canonical.workspaceId);
      assert.equal(input.dryRun, false);
      return { relativePath: '.dharma/approved-policy.json', applied: true,
        policy: { revision: 'policy_fixture', evidence: { automaticDisclosure: { mode: 'local_analysis' } } } };
    },
  }))(fabric, requested, 'policy_fixture', true, ['codex']);
  assert.deepEqual(calls, ['register', 'verify']);
  assert.equal((actual.workspace as Record<string, unknown>).id, canonical.workspaceId);
});

test('repository binding uses the canonical workspace after authenticated registration', async () => {
  const { requested, canonical, response } = registrationFixture();
  const reconcile = await caller('reconcileWorkspaceRegistration', { UUID_PATTERN: /^[0-9a-f-]{36}$/i });
  const actual = await (await caller('registerWorkspaceBeforeRepositoryBind', {
    registry: async () => [requested, canonical],
    reconcileWorkspaceRegistration: reconcile,
    syncWorkspacePolicy: async () => response,
    bindRepositoryAgent: async (_fabric: unknown, item: unknown) => {
      assert.equal(item, canonical);
      return { ...canonical, repositoryAgentId: 'agent_original' };
    },
  }))({}, requested, 'policy_fixture', ['codex']);
  assert.equal((actual.registered as Record<string, unknown>).workspaceId, canonical.workspaceId);
});

function registrationFixture() {
  const requested = { workspaceId: '11111111-1111-4111-8111-111111111111', organizationId: 'org_fixture',
    path: '/repo', routeHash: `sha256:${'a'.repeat(64)}`, repositoryRemoteHash: `sha256:${'b'.repeat(64)}`,
    status: 'active', repositoryBindingId: null };
  const canonical = { ...requested, workspaceId: '22222222-2222-4222-8222-222222222222',
    repositoryBindingId: 'binding_original', endpointId: 'endpoint_original',
    repositoryPackage: { state: 'published', localBaselineSnapshotHash: 'retained_snapshot' },
    repositoryRole: { revision: 3, profileHash: 'retained_role' } };
  const response = { ok: true, organizationId: requested.organizationId,
    workspace: { id: canonical.workspaceId, status: 'active' } };
  return { requested, canonical, response };
}

test('canonical registration preserves matching original repository, endpoint, package and role records', async () => {
  const f = registrationFixture();
  const reconcile = await caller('reconcileWorkspaceRegistration', { UUID_PATTERN: /^[0-9a-f-]{36}$/i });
  const actual = await reconcile([f.requested, f.canonical], f.requested, f.response);
  assert.equal(actual, f.canonical);
  assert.equal(f.requested.workspaceId, '11111111-1111-4111-8111-111111111111');
  assert.equal((actual.repositoryPackage as Record<string, unknown>).localBaselineSnapshotHash, 'retained_snapshot');
});

test('canonical registration restores a missing local row without inheriting workspace-specific state', async () => {
  const f = registrationFixture();
  const reconcile = await caller('reconcileWorkspaceRegistration', { UUID_PATTERN: /^[0-9a-f-]{36}$/i });
  const actual = await reconcile([], f.canonical, { ...f.response, workspace: { id: f.requested.workspaceId, status: 'active' } });
  assert.equal(actual.workspaceId, f.requested.workspaceId);
  assert.equal(actual.path, f.canonical.path);
  assert.equal(actual.repositoryRemoteHash, f.canonical.repositoryRemoteHash);
  assert.equal(actual.repositoryBindingId, null);
  assert.equal(actual.endpointId, null);
  assert.equal(actual.repositoryPackage, undefined);
  assert.equal(actual.repositoryRole, null);
  assert.equal(f.canonical.endpointId, 'endpoint_original');
});

test('canonical registration rejects foreign, inactive, malformed, conflicting and ambiguous responses', async () => {
  const f = registrationFixture();
  const reconcile = await caller('reconcileWorkspaceRegistration', { UUID_PATTERN: /^[0-9a-f-]{36}$/i });
  for (const response of [{ ...f.response, organizationId: 'org_foreign' }, { ...f.response, ok: false },
    { ...f.response, workspace: { id: 'invalid', status: 'active' } },
    { ...f.response, workspace: { id: f.canonical.workspaceId, status: 'revoked' } }]) {
    assert.throws(() => reconcile([f.canonical], f.requested, response), /scope_mismatch/);
  }
  for (const patch of [{ organizationId: 'org_foreign' }, { path: '/foreign' },
    { routeHash: 'foreign' }, { repositoryRemoteHash: 'foreign' }, { status: 'revoked' }]) {
    assert.throws(() => reconcile([{ ...f.canonical, ...patch }], f.requested, f.response), /scope_mismatch/);
  }
  assert.throws(() => reconcile([f.canonical, { ...f.canonical }], f.requested, f.response), /ambiguous/);
});

test('canonical registration cannot bypass signed-policy verification or bind after rejection', async () => {
  const f = registrationFixture();
  const reconcile = await caller('reconcileWorkspaceRegistration', { UUID_PATTERN: /^[0-9a-f-]{36}$/i });
  let bound = false;
  const synchronize = await caller('syncWorkspacePolicy', {
    receiptAwareProviderCapabilities: async () => [], selectedProviderAdapters: () => [],
    registry: async () => [f.canonical], reconcileWorkspaceRegistration: reconcile,
    readDeviceConfig: async () => ({ serverPublicKeyEd25519: 'fixture_key' }),
    materializeWorkspacePolicy: async () => { throw new Error('signature invalid'); },
  });
  const fabric = { registerWorkspace: async () => ({ ...f.response, organizationPolicyAuthorization: {} }) };
  await assert.rejects(async () => (await caller('registerWorkspaceBeforeRepositoryBind', {
    syncWorkspacePolicy: synchronize,
    bindRepositoryAgent: async () => { bound = true; return {}; },
  }))(fabric, f.requested, 'policy_fixture', ['codex']), /signature invalid/);
  assert.equal(bound, false);
});
