import assert from 'node:assert/strict';
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {runInNewContext} from 'node:vm';
import test from 'node:test';
import ts from 'typescript';
import {canonicalize} from '@dharma-ai-labs/agent-fabric-contracts';
import {generateKeyPairSync, sign, randomUUID} from 'node:crypto';
import {verifyServerAuthorizedPolicy} from '@dharma-ai-labs/agent-fabric-policy';
import {AgentFabricClient, parseDeviceConfig, readDeviceConnectionPreference, saveDeviceConnectionPreference, loadOrCreateDeviceIdentity, saveDeviceEnrollmentAnchor, installTrustedServerSigningKeyset, type DeviceConfig, type SecureSecretStore} from '@dharma-ai-labs/agent-fabric-relay-client';
import {isIsolatedDeviceSession, runInIsolatedDeviceSession} from './connectionSessionScope.js';
import {assertConnectionScope, assertInstallationContinuity, assertUnenrolledHome, connectionPreference, resumeDeviceConnection} from './deviceConnection.js';
import {automaticBootstrapResume} from './deviceConnection.js';
import {bootstrapGrantMode} from './privateGrantInput.js';
import {selectDeviceWorkspace, workspaceIdForDevice} from './onboardingWorkspace.js';

// Execute the actual CLI caller. Only browser, network and OS-keychain effects
// are replaced; configuration reads/writes use real isolated filesystem state.
async function caller(name: string, deps: Record<string, unknown>, file = 'index.ts') {
  const source = await readFile(new URL(`../src/${file}`, import.meta.url), 'utf8');
  const ast = ts.createSourceFile('index.ts', source, ts.ScriptTarget.Latest, true);
  const declaration = ast.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === name);
  assert.ok(declaration);
  const compiled = ts.transpileModule(declaration.getText(ast).replace(/^export\s+/, ''), {
    compilerOptions: {target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.None}, reportDiagnostics: true,
  });
  assert.equal(compiled.diagnostics?.filter(d => d.category === ts.DiagnosticCategory.Error).length, 0);
  return runInNewContext(`${compiled.outputText}\n${name}`, deps, {timeout: 1000}) as
    (...args: unknown[]) => Promise<Record<string, unknown> | null>;
}

async function fixture(t: {after(fn: () => Promise<void>): void}) {
  const home = await mkdtemp(join(tmpdir(), 'dharma-resume-login-'));
  t.after(() => rm(home, {recursive: true, force: true}));
  const configPath = join(home, 'device.json');
  const config = {schema: 'dharma.device-config/v1', hqUrl: 'https://hq.example',
    organizationId: 'org_fixture', deviceId: '22222222-2222-4222-8222-222222222222', installationId: '11111111-1111-4111-8111-111111111111',
    deviceName: 'synthetic device', platform: 'linux', publicKeyEd25519: 'A'.repeat(43),
    serverPublicKeyEd25519: 'B'.repeat(43), relayUrl: 'wss://relay.example',
    enrolledAt: '2026-10-01T00:00:00.000Z', connectionMode: 'resume'};
  await writeFile(configPath, JSON.stringify(config), {mode: 0o600});
  const installationPath = join(home, 'installation.json');
  await writeFile(installationPath, JSON.stringify({schema: 'dharma.installation-identity/v1', installationId: config.installationId}));
  const effects: string[] = [];
  const deps: Record<string, unknown> = {
    readFile, writeFile, resolve, mkdir: async () => {}, rm: async () => {}, randomUUID, AbortSignal, fetch, setTimeout, URL,
    isIsolatedDeviceSession, runInIsolatedDeviceSession, saveDeviceConnectionPreference,
    configPath: () => configPath, pendingEnrollmentPath: () => join(home, 'pending.json'),
    workspaceRegistryPath: () => join(home, 'workspaces.json'), dharmaHome: () => home,
    currentBootstrapHostScope: () => undefined,
    installationIdentityPath: () => installationPath, protocolStatePath: () => join(home, 'state.json'),
    connectionPreference, assertConnectionScope, assertInstallationContinuity, assertUnenrolledHome, canonicalize,
    VERSION: '0.1.synthetic',
    resumeDeviceConnection: (input: Parameters<typeof resumeDeviceConnection>[0]) => resumeDeviceConnection({...input,
      openClient: async () => {
        const saved = parseDeviceConfig(await readFile(configPath, 'utf8'));
        return {config: saved, openSession: async () => ({ok: true, organizationId: saved.organizationId,
          relayUrl: saved.relayUrl, serverPublicKeyEd25519: saved.serverPublicKeyEd25519,
          deviceAuthority: {schema: 'dharma.device-admission/v1', deviceId: saved.deviceId,
            ownerMembershipId: '44444444-4444-4444-8444-444444444444', deviceStatus: 'active', memberStatus: 'active'}})};
      }}),
    acquirePidLock: async () => async () => {},
    normalizeHqUrl: (url: string) => url.replace(/\/$/, ''),
    portalUrl: () => config.hqUrl,
    required: (flags: Map<string, unknown>, key: string) => {
      const value = flags.get(key); if (!value) throw Error(`missing ${key}`); return value;
    },
    platform: async () => 'linux', loadOrCreateInstallationId: async () => config.installationId,
    loadOrCreateDeviceIdentity: async () => {effects.push('key-create-path'); return {publicKeyEd25519: config.publicKeyEd25519};},
    beginEnrollment: async () => {effects.push('enrollment'); return {deviceCode: 'synthetic', verificationUri: 'https://hq.example/approve', browserCode: 'synthetic', expiresInSeconds: 60};},
    openVerificationUri: async () => {effects.push('browser'); return true;},
    pollEnrollment: async () => ({status: 'approved', deviceId: '33333333-3333-4333-8333-333333333333', relayUrl: config.relayUrl, serverPublicKeyEd25519: config.serverPublicKeyEd25519}),
    saveDeviceConfig: async (_path: string, value: unknown) => writeFile(configPath, JSON.stringify(value)),
    saveDeviceEnrollmentAnchor: async () => {effects.push('anchor-write');},
    process: {env: {}, stderr: {write: () => {}}},
  };
  // Execute the real read helper with only filesystem read failures injectable.
  deps.readExistingDeviceConfig = async (path: string) => (await caller('readExistingDeviceConfig',
    {readFile: deps.readFile, parseDeviceConfig, readDeviceConnectionPreference}, 'deviceConnection.ts'))(path);
  deps.readDeviceConfig = async () => (await caller('readDeviceConfig', deps))();
  deps.reauthenticateExistingDevice = await caller('reauthenticateExistingDevice', deps);
  return {home, configPath, config, effects, deps};
}

test('ordinary opted-in login resumes the original identity without enrollment, keys or browser', async t => {
  const f = await fixture(t);
  const login = await caller('login', f.deps);
  const result = await login(new Map([['organization-id', f.config.organizationId]]));
  assert.equal(result?.status, 'resumed');
  assert.equal(result?.deviceId, f.config.deviceId);
  assert.equal(f.effects.includes('enrollment'), false);
  assert.equal(f.effects.includes('key-create-path'), false);
  assert.equal(f.effects.includes('browser'), false);
  assert.equal((JSON.parse(await readFile(f.configPath, 'utf8')) as {deviceId: string}).deviceId, f.config.deviceId);
});

test('corrupt existing config is a recovery failure instead of an absent installation', async t => {
  const f = await fixture(t);
  await writeFile(f.configPath, '{broken');
  const read = await caller('readDeviceConfig', f.deps);
  await assert.rejects(read(), /connection_config_corrupt/);
  assert.equal(await readFile(f.configPath, 'utf8'), '{broken');
});

test('an unreadable existing config cannot become first enrollment', async t => {
  const f = await fixture(t);
  f.deps.readFile = async () => {throw Object.assign(Error('synthetic denied'), {code: 'EACCES'});};
  const read = await caller('readDeviceConfig', f.deps);
  await assert.rejects(read(), /connection_config_unreadable/);
});

test('a foreign organization cannot silently re-enroll an opted-in installation', async t => {
  const f = await fixture(t);
  const login = await caller('login', f.deps);
  await assert.rejects(login(new Map([['organization-id', 'org_other']])), /connection_scope_mismatch/);
  assert.deepEqual(f.effects, []);
});

test('manual mode requires explicit resume or opt-in and never replaces the device', async t => {
  const f = await fixture(t);
  await writeFile(f.configPath, JSON.stringify({...f.config, connectionMode: 'manual'}));
  const login = await caller('login', f.deps);
  await assert.rejects(login(new Map()), /connection_resume_opt_in_required/);
  assert.deepEqual(f.effects, []);
});

test('returning dry-run has no enrollment, browser, key or configuration effects', async t => {
  const f = await fixture(t);
  const before = await readFile(f.configPath, 'utf8');
  const login = await caller('login', f.deps);
  const result = await login(new Map<string, string | boolean>([['dry-run', true], ['organization-id', f.config.organizationId]]));
  assert.equal(result?.status, 'plan');
  assert.deepEqual(f.effects, []);
  assert.equal(await readFile(f.configPath, 'utf8'), before);
});

test('ordinary opted-in bootstrap selects resume before demanding a new grant', async t => {
  const f = await fixture(t);
  f.deps.automaticBootstrapResume = automaticBootstrapResume;
  f.deps.bootstrapGrantMode = bootstrapGrantMode;
  f.deps.realpath = async () => {throw Error('reached_existing_scope_preflight');};
  const bootstrap = await caller('bootstrap', f.deps);
  const result = await bootstrap(new Map<string, string | boolean>([['organization-id', f.config.organizationId], ['complete', true]]));
  assert.equal(result?.stage, 'repository_selection');
  assert.equal(result?.message, 'Selected repository could not be verified; the grant was not redeemed.');
  assert.deepEqual(f.effects, []);
});

test('explicit opt-in and opt-out preserve the enrolled authority fields', async t => {
  const f = await fixture(t);
  await writeFile(f.configPath, JSON.stringify({...f.config, connectionMode: 'manual'}));
  const login = await caller('login', f.deps);
  const enabled = await login(new Map([['unattended', true]]));
  assert.equal(enabled?.status, 'resumed');
  assert.equal(enabled?.connectionMode, 'resume');
  const disabled = await login(new Map([['no-unattended', true]]));
  assert.equal(disabled?.connectionMode, 'manual');
  assert.equal(disabled?.connected, false);
  assert.deepEqual(JSON.parse(await readFile(f.configPath, 'utf8')), {...f.config, connectionMode: 'manual'});
  assert.deepEqual(f.effects, []);
});

test('two first-login callers serialize enrollment and the second reuses its approved result', async t => {
  const f = await fixture(t);
  await rm(f.configPath);
  await rm(join(f.home, 'installation.json'));
  f.deps.rm = rm;
  f.deps.loadOrCreateInstallationId = async () => {
    await writeFile(join(f.home, 'installation.json'), JSON.stringify({schema: 'dharma.installation-identity/v1', installationId: f.config.installationId}));
    return f.config.installationId;
  };
  const locks = new Map<string, Promise<void>>();
  f.deps.acquirePidLock = async (path: string) => {
    let release!: () => void;
    const next = new Promise<void>(resolve => {release = resolve;});
    const previous = locks.get(path) ?? Promise.resolve();
    locks.set(path, previous.then(() => next));
    await previous;
    return async () => release();
  };
  const login = await caller('login', f.deps);
  const flags = new Map<string, string | boolean>([['organization-id', f.config.organizationId], ['unattended', true], ['no-browser', true]]);
  const results = await Promise.all([login(flags), login(flags)]);
  assert.equal(f.effects.filter(effect => effect === 'enrollment').length, 1);
  assert.equal(f.effects.filter(effect => effect === 'key-create-path').length, 1);
  assert.deepEqual(results.map(result => result?.status).sort(), ['approved', 'resumed']);
});

async function bootstrapFixture(t: {after(fn: () => Promise<void>): void}) {
  const f = await fixture(t);
  const server = generateKeyPairSync('ed25519');
  const config = {...f.config, serverPublicKeyEd25519: server.publicKey.export({format: 'jwk'}).x!};
  await writeFile(f.configPath, JSON.stringify(config));
  const fingerprint = `sha256:${'a'.repeat(64)}`;
  const workspaceId = workspaceIdForDevice({organizationId: config.organizationId, deviceId: config.deviceId, path: f.home});
  const row = {workspaceId, organizationId: config.organizationId, path: f.home, repositoryRemoteHash: fingerprint,
    repositoryBindingId: 'binding-existing', endpointId: 'endpoint-existing'};
  const evidence = {automaticDisclosure: {mode: 'metadata_only'}, maximumCapsuleBytes: 1024,
    maximumDailyUploadBytes: 4096, maximumExpansionBytes: 1024, excludePaths: ['.git/**'], pseudonymizeIdentity: true};
  const authorization = {schema: 'dharma.workspace-policy-authorization/v1', organizationId: config.organizationId, workspaceId,
    policy: {revision: 'approved-1', evidence}, issuedAt: new Date(Date.now() - 1000).toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(), keyVersion: 'origin'};
  const policy = {organizationId: config.organizationId, revision: 'approved-1', evidence,
    serverAuthorization: {...authorization, signature: sign(null, Buffer.from(canonicalize(authorization)), server.privateKey).toString('base64url')}};
  Object.assign(f.deps, {automaticBootstrapResume, bootstrapGrantMode, selectDeviceWorkspace, verifyServerAuthorizedPolicy,
    realpath: async () => f.home, preflightBootstrapWorkspaceIdentity: async () => ({fingerprint}),
    assertBootstrapHostSource: async () => {}, detectBootstrapProvider: async () => 'codex', isLocalProviderId: () => true,
    registry: async () => [row], loadVerifiedWorkspacePolicy: async () => policy,
    assertWorkspaceAuthorizationCurrent: async () => {}, loadOrganizationApiToken: async () => null});
  f.deps.assertBootstrapResumeAuthority = await caller('assertBootstrapResumeAuthority', f.deps);
  const flags = new Map<string, string | boolean>([['organization-id', config.organizationId], ['complete', true],
    ['workspace', f.home], ['policy-revision', policy.revision]]);
  return {...f, flags, row, policy};
}

test('ordinary bootstrap keeps accepted identity and reaches existing credential recovery without enrollment', async t => {
  const f = await bootstrapFixture(t);
  const bootstrap = await caller('bootstrap', f.deps);
  const result = await bootstrap(f.flags);
  assert.equal(result?.stage, 'organization_api_credentials');
  assert.equal((result?.enrollment as {deviceId: string}).deviceId, f.config.deviceId);
  assert.deepEqual(f.effects, []);
});

test('automatic bootstrap rejects new repository, missing endpoint and new policy revision before setup effects', async t => {
  for (const state of ['repository', 'endpoint', 'revision']) {
    const f = await bootstrapFixture(t);
    if (state === 'repository') f.row.repositoryRemoteHash = `sha256:${'b'.repeat(64)}`;
    if (state === 'endpoint') f.row.endpointId = '';
    if (state === 'revision') f.flags.set('policy-revision', 'new-permissions');
    const bootstrap = await caller('bootstrap', f.deps);
    await assert.rejects(bootstrap(f.flags), /connection_new_scope_requires_approval/);
    assert.deepEqual(f.effects, []);
  }
});

test('automatic bootstrap dry-run verifies approved scope without connecting or changing credentials', async t => {
  const f = await bootstrapFixture(t);
  f.flags.set('dry-run', true);
  f.deps.resumeDeviceConnection = async () => {throw Error('unexpected_device_connection');};
  f.deps.loadOrganizationApiToken = async () => {throw Error('unexpected_credential_access');};
  const bootstrap = await caller('bootstrap', f.deps);
  const result = await bootstrap(f.flags);
  assert.equal(result?.stage, 'plan');
  assert.equal(result?.effects, false);
  assert.deepEqual(f.effects, []);
});

test('explicit browser-approved legacy reauthentication preserves the original identity', async t => {
  const f = await fixture(t);
  await writeFile(f.configPath, JSON.stringify({...f.config, connectionMode: 'manual'}));
  f.deps.enrolledDeviceIdentity = async () => ({publicKeyEd25519: f.config.publicKeyEd25519});
  f.deps.pollEnrollment = async () => ({status: 'approved', organizationId: f.config.organizationId, deviceId: f.config.deviceId,
    relayUrl: f.config.relayUrl, serverPublicKeyEd25519: f.config.serverPublicKeyEd25519});
  const login = await caller('login', f.deps);
  const result = await login(new Map([['reauthenticate', true]]));
  assert.equal(result?.status, 'reauthenticated');
  assert.equal(result?.deviceId, f.config.deviceId);
  assert.deepEqual(f.effects, ['enrollment', 'browser', 'anchor-write']);
  assert.deepEqual(JSON.parse(await readFile(f.configPath, 'utf8')), {...f.config, connectionMode: 'manual'});
});

test('explicit reauthentication fails closed on missing private key or changed approval identity', async t => {
  for (const state of ['missing_key', 'replacement', 'denied'] as const) {
    const f = await fixture(t), bytes = await readFile(f.configPath, 'utf8');
    f.deps.enrolledDeviceIdentity = async () => {
      if (state === 'missing_key') throw Error('private-store-detail');
      return {publicKeyEd25519: f.config.publicKeyEd25519};
    };
    if (state === 'denied') f.deps.pollEnrollment = async () => ({status: 'denied'});
    const login = await caller('login', f.deps);
    await assert.rejects(login(new Map([['reauthenticate', true]])),
      state === 'missing_key' ? /connection_identity_requires_recovery/
        : state === 'denied' ? /connection_reauthentication_rejected/ : /connection_reauthentication_identity_mismatch/);
    assert.equal(await readFile(f.configPath, 'utf8'), bytes);
    assert.equal(f.effects.includes('anchor-write'), false);
    assert.equal(f.effects.includes('key-create-path'), false);
    if (state === 'missing_key') assert.deepEqual(f.effects, []);
  }
});

test('a delayed protected keyset installation cannot undo actual CLI opt-out', async t => {
  const f = await fixture(t), rootKey = generateKeyPairSync('ed25519');
  const config = {...f.config, serverPublicKeyEd25519: rootKey.publicKey.export({format: 'jwk'}).x!} as DeviceConfig;
  await writeFile(f.configPath, JSON.stringify(config));
  const values = new Map<string, string>();
  let notify!: () => void, unblock!: () => void;
  const delayed = new Promise<void>(resolve => {notify = resolve;}), released = new Promise<void>(resolve => {unblock = resolve;});
  const store: SecureSecretStore = {backend: 'windows-credential-manager', get: async account => values.get(account) ?? null,
    delete: async account => {values.delete(account);},
    put: async (account, value) => {
      if (JSON.parse(value).serverSigningKeyset) {notify(); await released;}
      values.set(account, value);
    }};
  await saveDeviceEnrollmentAnchor({config, store});
  const now = new Date(), unsigned = {schema: 'dharma.server-signing-keyset/v1' as const,
    organizationId: config.organizationId, generation: 1,
    keys: [{keyVersion: 'origin', publicKeyEd25519: config.serverPublicKeyEd25519, status: 'active' as const,
      notBefore: new Date(now.getTime() - 1000).toISOString(), notAfter: new Date(now.getTime() + 60_000).toISOString()}],
    signedByKeyVersion: 'origin', issuedAt: now.toISOString(), expiresAt: new Date(now.getTime() + 60_000).toISOString()};
  const candidate = {...unsigned, signature: sign(null, Buffer.from(canonicalize(unsigned)), rootKey.privateKey).toString('base64url')};
  const rotation = installTrustedServerSigningKeyset({configPath: f.configPath, candidate, store, now});
  await delayed;
  try {
    const login = await caller('login', f.deps);
    assert.equal((await login(new Map([['no-unattended', true]])))?.connectionMode, 'manual');
  } finally {unblock();}
  await rotation;
  const current = await (f.deps.readDeviceConfig as () => Promise<DeviceConfig>)();
  assert.equal(current.connectionMode, 'manual');
  assert.deepEqual(current.serverSigningKeyset, candidate);
  assert.equal(current.deviceId, config.deviceId);
});

test('concurrent actual bootstrap-to-onboard clients preserve a sibling durable outbox', async t => {
  const f = await bootstrapFixture(t), values = new Map<string, string>();
  const store: SecureSecretStore = {backend: 'windows-credential-manager', get: async account => values.get(account) ?? null,
    put: async (account, value) => {values.set(account, value);}, delete: async account => {values.delete(account);}};
  const identity = await loadOrCreateDeviceIdentity({hqUrl: f.config.hqUrl, organizationId: f.config.organizationId,
    installationId: f.config.installationId, store});
  const config = {...parseDeviceConfig(await readFile(f.configPath, 'utf8')), publicKeyEd25519: identity.publicKeyEd25519};
  await writeFile(f.configPath, JSON.stringify(config));
  await saveDeviceEnrollmentAnchor({config, store});
  const statePath = join(f.home, 'state.json'), pending = JSON.stringify({schema: 'dharma.protocol-state/v1',
    sessionId: 'sibling-original', nextSequence: 7, pending: {method: 'POST',
      pathname: `/api/v1/orgs/${config.organizationId}/agent-fabric/tasks/poll`, body: '{"leaseSeconds":120}', headers: {}}});
  await writeFile(statePath, pending);
  const protectedBefore = new Map(values);
  const requests: Array<{path: string; sessionId: string | null}> = [];
  Object.assign(f.deps, {
    AgentFabricClient: {open: (input: Parameters<typeof AgentFabricClient.open>[0]) => AgentFabricClient.open({...input, store,
      fetcher: async (url, init) => {
        requests.push({path: new URL(String(url)).pathname, sessionId: new Headers(init?.headers).get('x-dharma-session-id')});
        return new Response(JSON.stringify({ok: true}), {status: 201});
      }})},
    loadOrganizationApiToken: async () => 'synthetic-existing-token',
    parseSelectedProviderIds: () => ['codex'], inspectRegistryRecoveryFile: async () => ({kind: 'valid'}),
    registerWorkspaceBeforeRepositoryBind: async (fabric: AgentFabricClient) => {
      await fabric.registerWorkspace({workspaceId: f.row.workspaceId});
      return {registered: {...f.row, repositoryAgentId: 'agent-existing'}, synchronized: {localPolicy: f.policy}};
    },
    fetchRepositorySourceAuthorization: async () => {throw Error('bounded_scope_read_stop');},
    retryBootstrapOnboarding: (operation: () => unknown) => operation(),
  });
  f.deps.client = await caller('client', f.deps);
  f.deps.onboard = await caller('onboard', f.deps);
  const bootstrap = await caller('bootstrap', f.deps);
  const results = await Promise.all(Array.from({length: 4}, () => bootstrap(f.flags)));
  assert.equal(results.every(result => result?.stage === 'repository_source_authorization_required'), true);
  assert.equal(requests.some(request => request.path.endsWith('/tasks/poll')), false, 'No replay of the sibling request');
  const admissions = requests.filter(request => request.path.endsWith('/agent-fabric/sessions'));
  assert.equal(admissions.length, 4);
  assert.equal(new Set(admissions.map(request => request.sessionId)).size, 4);
  assert.equal(await readFile(statePath, 'utf8'), pending);
  assert.deepEqual(values, protectedBefore);
  assert.deepEqual(f.effects, []);
});
