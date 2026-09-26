import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import test from 'node:test';
import ts from 'typescript';

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
  return runInNewContext(`${compiled.outputText}\n${name}`, dependencies, {
    timeout: 1000, contextCodeGeneration: { strings: false, wasm: false },
  }) as Caller;
}

function bootstrapDependencies(onboarding: Onboarding) {
  const calls: string[] = [];
  const record = async (name: string) => { calls.push(name); };
  const dependencies: Record<string, unknown> = {
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
    retryBootstrapOnboarding: async (operation: () => Promise<unknown>) => operation(),
    onboard: async () => onboarding,
    installStableRepositoryLauncher: async () => { await record('launcher');
      return { shell: '.dharma/bin/dharma', windows: '.dharma/bin/dharma.cmd' }; },
    dharmaHome: () => '/fixture-home',
    VERSION: '0.2.102',
    enableRelayAutostart: async () => { await record('autostart'); return { state: 'enabled', backend: 'systemd-user' }; },
    withRelayStartupMutation: async (operation: () => Promise<unknown>) => {
      await record('startup_lock'); return operation();
    },
    verifyAgentFabricSkillInstallation: async () => ({ ready: true }),
    resolve, dirname,
    evidencePreview: async () => ({ trajectoryCount: 0, automaticDisclosure: { ready: false } }),
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
  };
  return { dependencies, calls };
}

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
