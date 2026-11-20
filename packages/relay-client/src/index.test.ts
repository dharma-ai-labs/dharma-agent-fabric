import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, createPublicKey, generateKeyPairSync, randomUUID, verify, type JsonWebKey } from 'node:crypto';
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { test } from 'node:test';
import {
  AgentFabricClient, RELAY_ACKNOWLEDGEMENT_TIMEOUT_MS,
  AgentFabricRequestError,
  beginEnrollment,
  deleteActiveSkillAuthorizationAnchor,
  loadActiveSkillAuthorizationAnchor,
  loadOrCreateDeviceIdentity,
  isContentBearingPath,
  isExplicitlyRebuiltPath,
  isDefinitiveAgentFabricRejection,
  installTrustedServerSigningKeyset,
  loadDeviceEnrollmentAnchor,
  assertDeviceEnrollmentAnchorAbsent,
  recoverDeviceEnrollmentConsistency,
  normalizeHqUrl,
  normalizeRelayUrl,
  redeemBootstrapGrant,
  saveDeviceConfig,
  saveActiveSkillAuthorizationAnchor,
  saveDeviceEnrollmentAnchor,
  loadOrganizationApiToken,
  saveOrganizationApiToken,
  deviceKeysetTelemetry,
  withDeviceSigningControl,
  withDeviceSigningLineSignal,
} from './index.js';
import * as relayClientModule from './index.js';
import {
  signCanonicalObject,
  type TrustedServerSigningKeyset,
} from '@dharma-ai-labs/agent-fabric-contracts';
import type { SecureSecretStore } from '@dharma-ai-labs/agent-fabric-secure-store';

function memoryStore(): SecureSecretStore {
  const values = new Map<string, string>();
  return {
    backend: 'linux-secret-service',
    async get(account) { return values.get(account) || null; },
    async put(account, value) { values.set(account, value); },
    async delete(account) { values.delete(account); },
  };
}

test('ordinary and exact study task polls use distinct signed payloads', async () => {
  const sent: Array<{ route: string; body: unknown }> = [];
  const receiver = {
    signedPost: async (route: string, body: unknown) => {
      sent.push({ route, body });
      return { ok: true, task: null };
    },
  };
  await AgentFabricClient.prototype.pollTask.call(receiver as unknown as AgentFabricClient, 120);
  await AgentFabricClient.prototype.pollTask.call(receiver as unknown as AgentFabricClient, 600,
    '3b671bac-7ec8-4809-b8f3-1ddfb3e08b20');
  assert.deepEqual(sent, [
    { route: '/agent-fabric/tasks/poll', body: { leaseSeconds: 120 } },
    { route: '/agent-fabric/tasks/poll', body: { leaseSeconds: 600,
      studyExpectedTaskId: '3b671bac-7ec8-4809-b8f3-1ddfb3e08b20' } },
  ]);
});

test('repository candidate uploads are content-bearing but status reads are not', () => {
  const root = '/api/v1/orgs/org_a/agent-fabric/repository-agents/57f61652-a5eb-46e4-930c-9478cd4a9c31/package-candidates';
  assert.equal(isContentBearingPath(root), true);
  assert.equal(isContentBearingPath(`${root}/77f61652-a5eb-46e4-930c-9478cd4a9c31`), false);
  assert.equal(isExplicitlyRebuiltPath('/api/v1/orgs/org_a/agent-fabric/repository-agents'), true);
  assert.equal(isContentBearingPath('/api/v1/orgs/org_a/agent-fabric/repository-agents'), false);
});

test('selected-session questions and answers require explicit disclosure revalidation before replay', () => {
  assert.equal(isContentBearingPath('/api/v1/orgs/org_test/agent-fabric/provider-session-questions'), true);
  assert.equal(isContentBearingPath('/api/v1/orgs/org_test/agent-fabric/provider-sessions'), false);
});

test('ambiguous selected-session content is never persisted or implicitly replayed on reconnect', async t => {
  for (const action of ['ask', 'reply']) await t.test(action, async () => {
    const store = memoryStore();
    const root = await mkdtemp(resolve(tmpdir(), 'fabric-session-content-'));
    const identity = await loadOrCreateDeviceIdentity({ hqUrl: 'https://hq.example', organizationId: 'org_a', store });
    const configPath = resolve(root, 'device.json'), statePath = resolve(root, 'state.json');
    await saveDeviceConfig(configPath, {
      schema: 'dharma.device-config/v1', hqUrl: 'https://hq.example', organizationId: 'org_a',
      deviceId: 'c72c7f13-e420-49f7-a818-c07f6f9d0915', deviceName: 'Test', platform: 'linux',
      publicKeyEd25519: identity.publicKeyEd25519, serverPublicKeyEd25519: identity.publicKeyEd25519,
      relayUrl: 'wss://relay.example', enrolledAt: new Date().toISOString(),
    });
    await anchorConfig(configPath, store);
    const calls: string[] = [];
    let fail = true;
    const fetcher = async (url: string | URL | Request) => {
      const path = new URL(String(url)).pathname; calls.push(path);
      if (fail && path.endsWith('/provider-session-questions')) {
        fail = false; throw new Error('unknown selected-session delivery');
      }
      return new Response(JSON.stringify({ ok: true }), { status: 201 });
    };
    const client = await AgentFabricClient.open({ configPath, statePath, store, fetcher });
    await client.openSession();
    await assert.rejects(client.signedPost('/agent-fabric/provider-session-questions', {
      action, [action === 'ask' ? 'question' : 'answer']: 'previously-authorized-private-content',
    }), /unknown selected-session delivery/);
    const persisted = await readFile(statePath, 'utf8');
    assert.doesNotMatch(persisted, /previously-authorized-private-content/);
    assert.equal(JSON.parse(persisted).pending, null);
    // A prior version may already have persisted an ambiguous request. Opening
    // a new session must discard it, not revive stale content authority.
    const state = JSON.parse(persisted);
    state.pending = { method: 'POST', pathname: '/api/v1/orgs/org_a/agent-fabric/provider-session-questions',
      body: JSON.stringify({ action, answer: 'previously-authorized-private-content' }), headers: {} };
    await writeFile(statePath, JSON.stringify(state));
    const restarted = await AgentFabricClient.open({ configPath, statePath, store, fetcher });
    await restarted.openSession();
    await restarted.registerWorkspace({ workspaceId: 'control-operation' });
    assert.equal(calls.filter(path => path.endsWith('/provider-session-questions')).length, 1);
    assert.doesNotMatch(await readFile(statePath, 'utf8'), /previously-authorized-private-content/);
  });
});

test('repository connect is rebuilt after current workspace registration instead of replayed', async () => {
  const store = memoryStore();
  const root = await mkdtemp(resolve(tmpdir(), 'fabric-repository-connect-rebuild-'));
  const identity = await loadOrCreateDeviceIdentity({ hqUrl: 'https://hq.example', organizationId: 'org_a', store });
  const configPath = resolve(root, 'device.json');
  const statePath = resolve(root, 'state.json');
  await saveDeviceConfig(configPath, {
    schema: 'dharma.device-config/v1', hqUrl: 'https://hq.example', organizationId: 'org_a',
    deviceId: 'c72c7f13-e420-49f7-a818-c07f6f9d0915', deviceName: 'Test', platform: 'linux',
    publicKeyEd25519: identity.publicKeyEd25519, serverPublicKeyEd25519: identity.publicKeyEd25519,
    relayUrl: 'wss://relay.example', enrolledAt: new Date().toISOString(),
  });
  await anchorConfig(configPath, store);
  const paths: string[] = [];
  let failConnect = true;
  const fetcher = async (url: string | URL | Request) => {
    const pathname = new URL(String(url)).pathname;
    paths.push(pathname);
    if (failConnect && pathname.endsWith('/agent-fabric/repository-agents')) {
      failConnect = false;
      throw new Error('unknown repository connect outcome');
    }
    return new Response(JSON.stringify({ ok: true }), { status: 201 });
  };
  const client = await AgentFabricClient.open({ configPath, statePath, store, fetcher });
  await client.openSession();
  await assert.rejects(
    client.connectRepositoryAgent({ workspaceId: 'stale-workspace' }),
    /unknown repository connect outcome/,
  );
  const durableState = JSON.parse(await readFile(statePath, 'utf8'));
  assert.equal(durableState.pending, null);
  assert.doesNotMatch(await readFile(statePath, 'utf8'), /stale-workspace/);

  const resumed = await AgentFabricClient.open({ configPath, statePath, store, fetcher });
  await resumed.openSession();
  assert.equal(paths.filter((path) => path.endsWith('/agent-fabric/repository-agents')).length, 1);
  await resumed.registerWorkspace({ workspaceId: 'current-workspace' });
  await resumed.connectRepositoryAgent({ workspaceId: 'current-workspace' });
  assert.deepEqual(paths.slice(-2).map((path) => path.split('/').at(-1)), ['workspaces', 'repository-agents']);
  assert.equal(paths.filter((path) => path.endsWith('/agent-fabric/repository-agents')).length, 2);
});

async function anchorConfig(configPath: string, store: SecureSecretStore) {
  const config = JSON.parse(await readFile(configPath, 'utf8'));
  await saveDeviceEnrollmentAnchor({ config, store });
}

test('opening an enrolled relay with a missing private key cannot create a replacement key', async () => {
  const store = memoryStore();
  const root = await mkdtemp(resolve(tmpdir(), 'fabric-enrolled-key-missing-'));
  const identity = await loadOrCreateDeviceIdentity({hqUrl: 'https://hq.example', organizationId: 'org_a', store});
  const configPath = resolve(root, 'device.json'), statePath = resolve(root, 'state.json');
  await saveDeviceConfig(configPath, {schema: 'dharma.device-config/v1', hqUrl: 'https://hq.example', organizationId: 'org_a',
    deviceId: 'c72c7f13-e420-49f7-a818-c07f6f9d0915', deviceName: 'Test', platform: 'linux',
    publicKeyEd25519: identity.publicKeyEd25519, serverPublicKeyEd25519: identity.publicKeyEd25519,
    relayUrl: 'wss://relay.example', enrolledAt: new Date().toISOString()});
  await anchorConfig(configPath, store);
  await store.delete(identity.account);
  const writes: string[] = [];
  const missing: SecureSecretStore = {...store, put: async account => {writes.push(account);}};
  await assert.rejects(AgentFabricClient.open({configPath, statePath, store: missing}), /relay_host_device_identity_unavailable/);
  assert.deepEqual(writes, [], 'A missing enrolled key is recovery state, never first enrollment');
});

test('isolated read client preserves durable pending mutations and cannot replay or submit application writes', async () => {
  const store = memoryStore();
  const root = await mkdtemp(resolve(tmpdir(), 'fabric-isolated-read-'));
  const identity = await loadOrCreateDeviceIdentity({ hqUrl: 'https://hq.example', organizationId: 'org_a', store });
  const configPath = resolve(root, 'device.json'), statePath = resolve(root, 'state.json');
  await saveDeviceConfig(configPath, { schema: 'dharma.device-config/v1', hqUrl: 'https://hq.example', organizationId: 'org_a',
    deviceId: 'c72c7f13-e420-49f7-a818-c07f6f9d0915', deviceName: 'Test', platform: 'linux',
    publicKeyEd25519: identity.publicKeyEd25519, serverPublicKeyEd25519: identity.publicKeyEd25519,
    relayUrl: 'wss://relay.example', enrolledAt: new Date().toISOString() });
  await anchorConfig(configPath, store);
  const original = JSON.stringify({ schema: 'dharma.protocol-state/v1', sessionId: 'original-session', nextSequence: 3,
    pending: { method: 'POST', pathname: '/api/v1/orgs/org_a/agent-fabric/tasks/poll', body: '{"leaseSeconds":120}', headers: {} } });
  await writeFile(statePath, original);
  const calls: Array<{ path: string; method: string }> = [];
  const fetcher = async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ path: new URL(String(url)).pathname, method: String(init?.method) });
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  };
  const readOnlyStore: SecureSecretStore = { backend: store.backend, get: store.get,
    put: async () => { throw new Error('unexpected_store_write'); }, delete: async () => { throw new Error('unexpected_store_delete'); } };
  const client = await AgentFabricClient.open({ configPath, statePath, store: readOnlyStore, fetcher,
    ...{ readOnly: true } });
  await client.openSession();
  await client.signedGet('/agent-fabric/repository-source-policy?workspaceId=fixture');
  assert.deepEqual(calls.map(call => [call.method, call.path.split('/').at(-1)]),
    [['POST', 'sessions'], ['GET', 'repository-source-policy']]);
  assert.equal(await readFile(statePath, 'utf8'), original);
  await assert.rejects(client.pollTask(), /read_only/);
  await assert.rejects(client.openSession(), /read_only/);
  assert.equal(calls.length, 2);
  const unavailable: SecureSecretStore = { ...readOnlyStore, get: async () => null };
  await assert.rejects(AgentFabricClient.open({ configPath, statePath, store: unavailable, fetcher, readOnly: true }),
    /relay_host_device_identity_unavailable/);
  assert.equal(calls.length, 2);
  const abort = new AbortController();
  const scoped = await AgentFabricClient.open({ configPath, statePath, store: readOnlyStore, fetcher, readOnly: true,
    hostScope: { signal: abort.signal, current: async () => !abort.signal.aborted } });
  await scoped.openSession();abort.abort();
  await assert.rejects(scoped.signedGet('/agent-fabric/repository-source-policy'), /relay_host_scope_unavailable/);
  assert.equal(calls.length, 3, 'Withdrawn read-only host must not admit another request.');
  assert.equal(await readFile(statePath, 'utf8'), original);
});

test('isolated reads do not implicitly retry an ambiguous response or persist it into another session', async () => {
  const store = memoryStore(), root = await mkdtemp(resolve(tmpdir(), 'fabric-isolated-read-failure-'));
  const identity = await loadOrCreateDeviceIdentity({ hqUrl: 'https://hq.example', organizationId: 'org_a', store });
  const configPath = resolve(root, 'device.json'), statePath = resolve(root, 'state.json');
  await saveDeviceConfig(configPath, { schema: 'dharma.device-config/v1', hqUrl: 'https://hq.example', organizationId: 'org_a',
    deviceId: 'c72c7f13-e420-49f7-a818-c07f6f9d0915', deviceName: 'Test', platform: 'linux',
    publicKeyEd25519: identity.publicKeyEd25519, serverPublicKeyEd25519: identity.publicKeyEd25519,
    relayUrl: 'wss://relay.example', enrolledAt: new Date().toISOString() });
  await anchorConfig(configPath, store);
  await writeFile(statePath, 'preserve-unrelated-durable-state-byte-for-byte');
  const calls: string[] = [];
  const client = await AgentFabricClient.open({ configPath, statePath, store, readOnly: true, fetcher: async (url, init) => {
    calls.push(String(init?.method));
    if (init?.method === 'GET') throw new Error('synthetic_ambiguous_read');
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  } });
  await client.openSession();
  await assert.rejects(client.signedGet('/agent-fabric/repository-source-policy'), /synthetic_ambiguous_read/);
  await assert.rejects(client.signedGet('/agent-fabric/repository-source-policy'), /read_only_pending/);
  await assert.rejects(client.openSession(), /read_only/);
  await assert.rejects(client.acknowledgeRecoveredTaskCompletion('fixture', 'fixture'), /read_only/);
  assert.deepEqual(calls, ['POST', 'GET']);
  assert.equal(await readFile(statePath, 'utf8'), 'preserve-unrelated-durable-state-byte-for-byte');
});

function keysetFixture(now: Date) {
  const first = generateKeyPairSync('ed25519');
  const second = generateKeyPairSync('ed25519');
  const firstPublic = (first.publicKey.export({ format: 'jwk' }) as JsonWebKey).x!;
  const secondPublic = (second.publicKey.export({ format: 'jwk' }) as JsonWebKey).x!;
  const notBefore = new Date(now.getTime() - 60_000).toISOString();
  const notAfter = new Date(now.getTime() + 60 * 60_000).toISOString();
  const initialUnsigned = {
    schema: 'dharma.server-signing-keyset/v1' as const,
    organizationId: 'org_a', generation: 1,
    keys: [{ keyVersion: 'kms/1', publicKeyEd25519: firstPublic, status: 'active' as const, notBefore, notAfter }],
    signedByKeyVersion: 'kms/1', issuedAt: now.toISOString(), expiresAt: notAfter,
  };
  const initial: TrustedServerSigningKeyset = {
    ...initialUnsigned, signature: signCanonicalObject(initialUnsigned, first.privateKey),
  };
  const rotatedUnsigned = {
    schema: 'dharma.server-signing-keyset/v1' as const,
    organizationId: 'org_a', generation: 2,
    keys: [
      { keyVersion: 'kms/1', publicKeyEd25519: firstPublic, status: 'overlap' as const, notBefore, notAfter },
      { keyVersion: 'kms/2', publicKeyEd25519: secondPublic, status: 'active' as const, notBefore, notAfter },
    ],
    signedByKeyVersion: 'kms/1', issuedAt: new Date(now.getTime() + 1_000).toISOString(), expiresAt: notAfter,
  };
  const rotated: TrustedServerSigningKeyset = {
    ...rotatedUnsigned, signature: signCanonicalObject(rotatedUnsigned, first.privateKey),
  };
  return { firstPublic, initial, rotated };
}

async function saveKeysetConfig(input: {
  configPath: string;
  publicKeyEd25519: string;
  devicePublicKeyEd25519?: string;
  keyset: TrustedServerSigningKeyset;
  now: Date;
}) {
  await saveDeviceConfig(input.configPath, {
    schema: 'dharma.device-config/v1', hqUrl: 'https://hq.example', organizationId: 'org_a',
    deviceId: 'c72c7f13-e420-49f7-a818-c07f6f9d0915', deviceName: 'Test', platform: 'linux',
    publicKeyEd25519: input.devicePublicKeyEd25519 ?? input.publicKeyEd25519,
    serverPublicKeyEd25519: input.publicKeyEd25519,
    serverSigningKeyset: input.keyset, relayUrl: 'wss://relay.example', enrolledAt: input.now.toISOString(),
  });
}

test('HQ and relay origins fail closed for deceptive hosts, credentials, and plaintext non-loopback transport', () => {
  assert.equal(normalizeHqUrl('https://www.dharma-ai.io/'), 'https://www.dharma-ai.io');
  assert.equal(normalizeHqUrl('http://localhost:3000'), 'http://localhost:3000');
  assert.equal(normalizeRelayUrl('wss://relay.dharma-ai.io/v1/connect'), 'wss://relay.dharma-ai.io');
  assert.throws(() => normalizeHqUrl('http://localhost.evil.example'), /HTTPS/);
  assert.throws(() => normalizeHqUrl('https://user:pass@hq.dharma-ai.io'), /credential-free/);
  assert.throws(() => normalizeRelayUrl('ws://relay.dharma-ai.io'), /WSS/);
  assert.throws(() => normalizeRelayUrl('wss://user:pass@relay.dharma-ai.io'), /credentials/);
});

test('device identity remains stable in the OS secret store', async () => {
  const store = memoryStore();
  const first = await loadOrCreateDeviceIdentity({ hqUrl: 'https://hq.example', organizationId: 'org_a', store });
  const second = await loadOrCreateDeviceIdentity({ hqUrl: 'https://hq.example', organizationId: 'org_a', store });
  assert.equal(first.publicKeyEd25519, second.publicKeyEd25519);
  assert.ok(first.privateJwk.d);
});

test('device identities are isolated by installation within one OS credential store', async () => {
  const store = memoryStore();
  const first = await loadOrCreateDeviceIdentity({
    hqUrl: 'https://hq.example', organizationId: 'org_a', installationId: '11111111-1111-4111-8111-111111111111', store,
  });
  const second = await loadOrCreateDeviceIdentity({
    hqUrl: 'https://hq.example', organizationId: 'org_a', installationId: '22222222-2222-4222-8222-222222222222', store,
  });
  const replay = await loadOrCreateDeviceIdentity({
    hqUrl: 'https://hq.example', organizationId: 'org_a', installationId: '11111111-1111-4111-8111-111111111111', store,
  });
  assert.notEqual(first.account, second.account);
  assert.notEqual(first.publicKeyEd25519, second.publicKeyEd25519);
  assert.equal(replay.publicKeyEd25519, first.publicKeyEd25519);
});

test('organization API tokens are isolated by installation while legacy enrollments remain readable', async () => {
  const store = memoryStore();
  const legacy = `dharma_org_${'a'.repeat(43)}`;
  const first = `dharma_org_${'b'.repeat(43)}`;
  const second = `dharma_org_${'c'.repeat(43)}`;
  await saveOrganizationApiToken({ hqUrl: 'https://hq.example', organizationId: 'org_a', token: legacy, store });
  await saveOrganizationApiToken({
    hqUrl: 'https://hq.example', organizationId: 'org_a', installationId: '11111111-1111-4111-8111-111111111111', token: first, store,
  });
  await saveOrganizationApiToken({
    hqUrl: 'https://hq.example', organizationId: 'org_a', installationId: '22222222-2222-4222-8222-222222222222', token: second, store,
  });
  assert.equal(await loadOrganizationApiToken({ hqUrl: 'https://hq.example', organizationId: 'org_a', store }), legacy);
  assert.equal(await loadOrganizationApiToken({
    hqUrl: 'https://hq.example', organizationId: 'org_a', installationId: '11111111-1111-4111-8111-111111111111', store,
  }), first);
  assert.equal(await loadOrganizationApiToken({
    hqUrl: 'https://hq.example', organizationId: 'org_a', installationId: '22222222-2222-4222-8222-222222222222', store,
  }), second);
});

test('bootstrap redemption is credential-free on the URL and returns device plus organization authority', async () => {
  const requests: Request[] = [];
  const result = await redeemBootstrapGrant({
    hqUrl: 'https://www.dharma-ai.io',
    organizationId: 'org_a',
    bootstrapToken: `dhab_${'a'.repeat(43)}`,
    name: 'Test device',
    platform: 'wsl',
    publicKeyEd25519: 'device-public-key',
    repositoryFingerprint: `sha256:${'e'.repeat(64)}`,
    fetcher: async (url, init) => {
      requests.push(new Request(url, init));
      return new Response(JSON.stringify({
        ok: true,
        status: 'approved',
        organizationId: 'org_a',
        deviceId: '11111111-1111-4111-8111-111111111111',
        relayUrl: 'wss://relay.dharma-ai.io',
        serverPublicKeyEd25519: 'server-public-key',
        organizationApiToken: `dharma_org_${'b'.repeat(43)}`,
        organizationApiTokenScopes: ['agents:read'],
      }), { status: 201, headers: { 'content-type': 'application/json' } });
    },
  });
  assert.equal(result.status, 'approved');
  assert.equal(new URL(requests[0]!.url).pathname, '/api/v1/agent-fabric/bootstrap');
  assert.equal(new URL(requests[0]!.url).search, '');
  const body = JSON.parse(await requests[0]!.text());
  assert.equal(body.bootstrapToken, `dhab_${'a'.repeat(43)}`);
  assert.equal(requests[0]!.headers.get('authorization'), null);
});

function bootstrapApprovedBody() {
  return {
    ok: true,
    status: 'approved',
    organizationId: 'org_a',
    deviceId: '11111111-1111-4111-8111-111111111111',
    relayUrl: 'wss://relay.dharma-ai.io',
    serverPublicKeyEd25519: 'server-public-key',
    organizationApiToken: `dharma_org_${'b'.repeat(43)}`,
    organizationApiTokenScopes: ['agents:read'],
  };
}

function bootstrapApprovalBody(input: { expiresAt: string; publicKey?: string; origin?: string }) {
  const origin = input.origin || 'https://www.dharma-ai.io';
  const destination = new URL('/portal/agent-fabric/bootstrap-approval', origin);
  destination.hash = new URLSearchParams({
    organizationId: 'org_a',
    publicKeyEd25519: input.publicKey || 'device-public-key',
    bootstrapTokenHash: 'c'.repeat(64),
    repositoryFingerprint: `sha256:${'e'.repeat(64)}`,
  }).toString();
  const approval = new URL('/login', origin);
  approval.searchParams.set('redirect_url', destination.toString());
  return {
    ok: false,
    status: 'recipient_approval_required',
    organizationId: 'org_a',
    error: { code: 'bootstrap_recipient_approval_required', retryable: true },
    approval: {
      url: approval.toString(),
      expiresAt: input.expiresAt,
      fingerprint: `sha256:${'d'.repeat(64)}`,
    },
  };
}

test('bootstrap opens one validated recipient approval and polls the immutable request to its original deadline', async () => {
  let clock = Date.parse('2026-09-19T00:00:00.000Z');
  const expiresAt = new Date(clock + 60_000).toISOString();
  const requests: Request[] = [];
  let attempt = 0;
  const approvals: Array<{ url: string; expiresAt: string; fingerprint: string; repositoryFingerprint: string }> = [];
  const result = await redeemBootstrapGrant({
    hqUrl: 'https://www.dharma-ai.io', organizationId: 'org_a',
    bootstrapToken: `dhab_${'a'.repeat(43)}`, name: 'Test device', platform: 'wsl',
    publicKeyEd25519: 'device-public-key', repositoryFingerprint: `sha256:${'e'.repeat(64)}`, now: () => clock,
    sleep: async milliseconds => { clock += milliseconds; }, pollIntervalMs: 250,
    onRecipientApprovalRequired: approval => { approvals.push(approval); },
    fetcher: async (url, init) => {
      requests.push(new Request(url, init));
      attempt += 1;
      const body = attempt < 3 ? bootstrapApprovalBody({ expiresAt }) : bootstrapApprovedBody();
      return new Response(JSON.stringify(body), {
        status: attempt < 3 ? 409 : 201,
        headers: { 'content-type': 'application/json' },
      });
    },
  });
  assert.equal(result.status, 'approved');
  assert.equal(approvals.length, 1);
  assert.equal(requests.length, 3);
  const serializedRequests = await Promise.all(requests.map(request => request.text()));
  assert.ok(serializedRequests.every(serialized => serialized === serializedRequests[0]));
  assert.equal(approvals[0]!.expiresAt, expiresAt);
  assert.equal(new URL(approvals[0]!.url).origin, 'https://www.dharma-ai.io');
});

test('knowledge-only join accepts an approval without a source fingerprint but rejects an injected one', async () => {
  const expiresAt = new Date(Date.now() + 60_000).toISOString();
  const body = bootstrapApprovalBody({ expiresAt });
  const approvalUrl = new URL(body.approval.url);
  const destination = new URL(approvalUrl.searchParams.get('redirect_url')!);
  const fragment = new URLSearchParams(destination.hash.slice(1));
  fragment.delete('repositoryFingerprint');
  destination.hash = fragment.toString();
  approvalUrl.searchParams.set('redirect_url', destination.toString());
  body.approval.url = approvalUrl.toString();
  let opened = 0;
  const input = {
    hqUrl: 'https://www.dharma-ai.io', organizationId: 'org_a',
    bootstrapToken: `dhab_${'a'.repeat(43)}`, name: 'Knowledge device', platform: 'linux' as const,
    publicKeyEd25519: 'device-public-key', repositoryFingerprint: '',
    onRecipientApprovalRequired: () => { opened += 1; },
  };
  let attempt = 0;
  const joined = await redeemBootstrapGrant({
    ...input,
    fetcher: async () => {
      attempt += 1;
      return new Response(JSON.stringify(attempt === 1 ? body : bootstrapApprovedBody()), {
        status: attempt === 1 ? 409 : 201,
      });
    },
    sleep: async () => undefined,
  });
  assert.equal(joined.status, 'approved');
  assert.equal(opened, 1);

  destination.hash = new URLSearchParams({ ...Object.fromEntries(fragment), repositoryFingerprint: `sha256:${'e'.repeat(64)}` }).toString();
  approvalUrl.searchParams.set('redirect_url', destination.toString());
  body.approval.url = approvalUrl.toString();
  opened = 0;
  await assert.rejects(() => redeemBootstrapGrant({
    ...input,
    fetcher: async () => new Response(JSON.stringify(body), { status: 409 }),
  }), /HTTP 409|bootstrap_recipient_approval_required/);
  assert.equal(opened, 0);
});

test('bootstrap rejects changed approval context and terminal errors without further polling', async () => {
  let clock = Date.parse('2026-09-19T00:00:00.000Z');
  const firstDeadline = new Date(clock + 60_000).toISOString();
  let attempt = 0;
  await assert.rejects(() => redeemBootstrapGrant({
    hqUrl: 'https://www.dharma-ai.io', organizationId: 'org_a',
    bootstrapToken: `dhab_${'a'.repeat(43)}`, name: 'Test device', platform: 'linux',
    publicKeyEd25519: 'device-public-key', repositoryFingerprint: `sha256:${'e'.repeat(64)}`, now: () => clock,
    sleep: async milliseconds => { clock += milliseconds; }, pollIntervalMs: 250,
    onRecipientApprovalRequired: () => undefined,
    fetcher: async () => {
      attempt += 1;
      return new Response(JSON.stringify(bootstrapApprovalBody({
        expiresAt: new Date(Date.parse(firstDeadline) + (attempt === 1 ? 0 : 1_000)).toISOString(),
      })), { status: 409, headers: { 'content-type': 'application/json' } });
    },
  }), /context changed/);
  assert.equal(attempt, 2);

  let terminalAttempts = 0;
  await assert.rejects(() => redeemBootstrapGrant({
    hqUrl: 'https://www.dharma-ai.io', organizationId: 'org_a',
    bootstrapToken: `dhab_${'a'.repeat(43)}`, name: 'Test device', platform: 'linux',
    publicKeyEd25519: 'device-public-key', repositoryFingerprint: `sha256:${'e'.repeat(64)}`, onRecipientApprovalRequired: () => undefined,
    fetcher: async () => {
      terminalAttempts += 1;
      return new Response(JSON.stringify({ error: { code: 'fabric_ownership_required', message: 'Denied.' } }), { status: 403 });
    },
  }), /fabric_ownership_required/);
  assert.equal(terminalAttempts, 1);
});

test('bootstrap rejects deceptive or bearer-bearing recipient approval URLs before opening them', async () => {
  const expiresAt = new Date(Date.now() + 60_000).toISOString();
  for (const body of [
    bootstrapApprovalBody({ expiresAt, origin: 'https://www.dharma-ai.io.evil.example' }),
    (() => {
      const value = bootstrapApprovalBody({ expiresAt });
      value.approval.url += `&grant=dhab_${'a'.repeat(43)}`;
      return value;
    })(),
    bootstrapApprovalBody({ expiresAt, publicKey: 'foreign-device-key' }),
  ]) {
    let opened = false;
    await assert.rejects(() => redeemBootstrapGrant({
      hqUrl: 'https://www.dharma-ai.io', organizationId: 'org_a',
      bootstrapToken: `dhab_${'a'.repeat(43)}`, name: 'Test device', platform: 'wsl',
      publicKeyEd25519: 'device-public-key', repositoryFingerprint: `sha256:${'e'.repeat(64)}`,
      onRecipientApprovalRequired: () => { opened = true; },
      fetcher: async () => new Response(JSON.stringify(body), { status: 409 }),
    }), /HTTP 409|bootstrap_recipient_approval_required/);
    assert.equal(opened, false);
  }
});

test('organization API tokens are stored and loaded only through the secure store', async () => {
  const store = memoryStore();
  const token = `dharma_org_${'c'.repeat(43)}`;
  await saveOrganizationApiToken({
    hqUrl: 'https://www.dharma-ai.io', organizationId: 'org_a', token, store,
  });
  assert.equal(await loadOrganizationApiToken({
    hqUrl: 'https://www.dharma-ai.io', organizationId: 'org_a', store,
  }), token);
  await assert.rejects(
    () => saveOrganizationApiToken({ hqUrl: 'https://www.dharma-ai.io', organizationId: 'org_a', token: 'invalid', store }),
    /invalid/,
  );
});

test('action enforcement acknowledgement uses the device-signed decision route', async () => {
  const store = memoryStore();
  const root = await mkdtemp(resolve(tmpdir(), 'fabric-action-enforcement-'));
  const identity = await loadOrCreateDeviceIdentity({ hqUrl: 'https://hq.example', organizationId: 'org_a', store });
  const configPath = resolve(root, 'device.json');
  const statePath = resolve(root, 'state.json');
  await saveDeviceConfig(configPath, {
    schema: 'dharma.device-config/v1', hqUrl: 'https://hq.example', organizationId: 'org_a',
    deviceId: 'c72c7f13-e420-49f7-a818-c07f6f9d0915', deviceName: 'Test', platform: 'linux',
    publicKeyEd25519: identity.publicKeyEd25519, serverPublicKeyEd25519: identity.publicKeyEd25519,
    relayUrl: 'wss://relay.example', enrolledAt: new Date().toISOString(),
  });
  await anchorConfig(configPath, store);
  const requests: Request[] = [];
  const client = await AgentFabricClient.open({
    configPath,
    statePath,
    store,
    fetcher: async (url, init) => {
      requests.push(new Request(url, init));
      return new Response(JSON.stringify({ ok: true }), { status: 201 });
    },
  });
  await client.openSession();
  const decisionId = '33333333-3333-4333-8333-333333333333';
  await client.postActionEnforcement(decisionId, {
    taskId: '11111111-1111-4111-8111-111111111111',
    endpointId: '22222222-2222-4222-8222-222222222222',
    actionDigest: `sha256:${'a'.repeat(64)}`,
    disposition: 'executed',
    externalIdempotencyKeyHash: 'b'.repeat(64),
    resultDigest: `sha256:${'c'.repeat(64)}`,
    acknowledgedAt: new Date().toISOString(),
  });
  const request = requests.at(-1)!;
  assert.equal(new URL(request.url).pathname, `/api/v1/orgs/org_a/agent-fabric/decisions/${decisionId}/enforcements`);
  assert.equal(request.headers.get('x-dharma-signature')?.length ? true : false, true);
});

test('stale action enforcement is refreshed and re-signed without changing its effect digests', async () => {
  const store = memoryStore();
  const root = await mkdtemp(resolve(tmpdir(), 'fabric-stale-action-enforcement-'));
  const identity = await loadOrCreateDeviceIdentity({ hqUrl: 'https://hq.example', organizationId: 'org_a', store });
  const configPath = resolve(root, 'device.json');
  const statePath = resolve(root, 'state.json');
  await saveDeviceConfig(configPath, {
    schema: 'dharma.device-config/v1', hqUrl: 'https://hq.example', organizationId: 'org_a',
    deviceId: 'c72c7f13-e420-49f7-a818-c07f6f9d0915', deviceName: 'Test', platform: 'linux',
    publicKeyEd25519: identity.publicKeyEd25519, serverPublicKeyEd25519: identity.publicKeyEd25519,
    relayUrl: 'wss://relay.example', enrolledAt: new Date().toISOString(),
  });
  await anchorConfig(configPath, store);
  const bodies: Array<Record<string, unknown>> = [];
  const client = await AgentFabricClient.open({
    configPath,
    statePath,
    store,
    fetcher: async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body || '{}')) as Record<string, unknown>);
      return new Response(JSON.stringify({ ok: true }), { status: 201 });
    },
  });
  await client.openSession();
  await client.postActionEnforcement('33333333-3333-4333-8333-333333333333', {
    taskId: '11111111-1111-4111-8111-111111111111',
    endpointId: '22222222-2222-4222-8222-222222222222',
    actionDigest: `sha256:${'a'.repeat(64)}`,
    disposition: 'executed',
    externalIdempotencyKeyHash: 'b'.repeat(64),
    resultDigest: `sha256:${'c'.repeat(64)}`,
    acknowledgedAt: '2026-01-01T00:00:00.000Z',
  });
  const sent = bodies.at(-1)!;
  assert.ok(Date.parse(String(sent.acknowledgedAt)) > Date.now() - 60_000);
  assert.equal(sent.actionDigest, `sha256:${'a'.repeat(64)}`);
  assert.equal(sent.externalIdempotencyKeyHash, 'b'.repeat(64));
  assert.equal(sent.resultDigest, `sha256:${'c'.repeat(64)}`);
});

test('trusted server signing keyset is verified against the secure enrollment root before installation', async () => {
  const store = memoryStore();
  const root = await mkdtemp(resolve(tmpdir(), 'fabric-signing-keyset-'));
  const configPath = resolve(root, 'device.json');
  const signing = generateKeyPairSync('ed25519');
  const publicKeyEd25519 = (signing.publicKey.export({ format: 'jwk' }) as JsonWebKey).x!;
  const now = new Date('2026-08-17T20:00:00.000Z');
  const unsigned = {
    schema: 'dharma.server-signing-keyset/v1' as const,
    organizationId: 'org_a',
    generation: 1,
    keys: [{
      keyVersion: 'kms/1', publicKeyEd25519, status: 'active' as const,
      notBefore: new Date(now.getTime() - 60_000).toISOString(),
      notAfter: new Date(now.getTime() + 60 * 60_000).toISOString(),
    }],
    signedByKeyVersion: 'kms/1',
    issuedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + 60 * 60_000).toISOString(),
  };
  const candidate: TrustedServerSigningKeyset = {
    ...unsigned,
    signature: signCanonicalObject(unsigned, signing.privateKey),
  };
  await saveDeviceConfig(configPath, {
    schema: 'dharma.device-config/v1', hqUrl: 'https://hq.example', organizationId: 'org_a',
    deviceId: 'c72c7f13-e420-49f7-a818-c07f6f9d0915', deviceName: 'Test', platform: 'linux',
    publicKeyEd25519, serverPublicKeyEd25519: publicKeyEd25519,
    relayUrl: 'wss://relay.example', enrolledAt: now.toISOString(),
  });
  await anchorConfig(configPath, store);
  const installed = await installTrustedServerSigningKeyset({ configPath, candidate, store, now });
  assert.deepEqual(installed.serverSigningKeyset, candidate);
  await assert.rejects(
    installTrustedServerSigningKeyset({
      configPath,
      candidate: { ...candidate, organizationId: 'org_other', generation: 2 },
      store,
      now,
    }),
    /organization_mismatch|bad_signature/,
  );
});

test('repeated canonical signing keysets are idempotent while same-generation substitutions fail closed', async () => {
  const store = memoryStore();
  const root = await mkdtemp(resolve(tmpdir(), 'fabric-signing-keyset-repeat-'));
  const configPath = resolve(root, 'device.json');
  const signing = generateKeyPairSync('ed25519');
  const replacement = generateKeyPairSync('ed25519');
  const publicKeyEd25519 = (signing.publicKey.export({ format: 'jwk' }) as JsonWebKey).x!;
  const replacementPublicKey = (replacement.publicKey.export({ format: 'jwk' }) as JsonWebKey).x!;
  const now = new Date('2026-08-17T20:00:00.000Z');
  const notBefore = new Date(now.getTime() - 60_000).toISOString();
  const notAfter = new Date(now.getTime() + 60 * 60_000).toISOString();
  const unsigned = {
    schema: 'dharma.server-signing-keyset/v1' as const,
    organizationId: 'org_a',
    generation: 1,
    keys: [{ keyVersion: 'kms/1', publicKeyEd25519, status: 'active' as const, notBefore, notAfter }],
    signedByKeyVersion: 'kms/1',
    issuedAt: now.toISOString(),
    expiresAt: notAfter,
  };
  const candidate: TrustedServerSigningKeyset = {
    ...unsigned,
    signature: signCanonicalObject(unsigned, signing.privateKey),
  };
  await saveDeviceConfig(configPath, {
    schema: 'dharma.device-config/v1', hqUrl: 'https://hq.example', organizationId: 'org_a',
    deviceId: 'c72c7f13-e420-49f7-a818-c07f6f9d0915', deviceName: 'Test', platform: 'linux',
    publicKeyEd25519, serverPublicKeyEd25519: publicKeyEd25519,
    relayUrl: 'wss://relay.example', enrolledAt: now.toISOString(),
  });
  await anchorConfig(configPath, store);
  await installTrustedServerSigningKeyset({ configPath, candidate, store, now });

  const before = await stat(configPath);
  const reordered: TrustedServerSigningKeyset = {
    signature: candidate.signature,
    expiresAt: candidate.expiresAt,
    issuedAt: candidate.issuedAt,
    signedByKeyVersion: candidate.signedByKeyVersion,
    keys: candidate.keys.map((key) => ({
      notAfter: key.notAfter,
      notBefore: key.notBefore,
      status: key.status,
      publicKeyEd25519: key.publicKeyEd25519,
      keyVersion: key.keyVersion,
    })),
    generation: candidate.generation,
    organizationId: candidate.organizationId,
    schema: candidate.schema,
  };
  const repeated = await installTrustedServerSigningKeyset({ configPath, candidate: reordered, store, now });
  const after = await stat(configPath);
  assert.deepEqual(repeated.serverSigningKeyset, candidate);
  assert.equal(after.ino, before.ino, 'idempotent delivery must not replace the device configuration');

  await assert.rejects(
    installTrustedServerSigningKeyset({
      configPath,
      candidate: {
        ...candidate,
        keys: [{ ...candidate.keys[0]!, publicKeyEd25519: replacementPublicKey }],
      },
      store,
      now,
    }),
    /generation_not_advanced/,
  );
  await assert.rejects(
    installTrustedServerSigningKeyset({
      configPath,
      candidate: {
        ...candidate,
        expiresAt: new Date(Date.parse(candidate.expiresAt) + 60_000).toISOString(),
      },
      store,
      now,
    }),
    /generation_not_advanced/,
  );
});

test('interrupted keyset installation recovers either verified write order without weakening trust', async () => {
  const now = new Date('2026-08-17T20:00:00.000Z');
  const fixture = keysetFixture(now);

  const anchorAheadStore = memoryStore();
  const anchorAheadRoot = await mkdtemp(resolve(tmpdir(), 'fabric-keyset-anchor-ahead-'));
  const anchorAheadPath = resolve(anchorAheadRoot, 'device.json');
  await saveKeysetConfig({ configPath: anchorAheadPath, publicKeyEd25519: fixture.firstPublic, keyset: fixture.initial, now });
  await anchorConfig(anchorAheadPath, anchorAheadStore);
  const anchorAheadConfig = JSON.parse(await readFile(anchorAheadPath, 'utf8'));
  await saveDeviceEnrollmentAnchor({ config: { ...anchorAheadConfig, serverSigningKeyset: fixture.rotated }, store: anchorAheadStore, now });
  const recoveredDisk = await recoverDeviceEnrollmentConsistency({ configPath: anchorAheadPath, store: anchorAheadStore, now });
  assert.equal(recoveredDisk.serverSigningKeyset?.generation, 2);
  assert.equal(JSON.parse(await readFile(anchorAheadPath, 'utf8')).serverSigningKeyset.generation, 2);

  const diskAheadStore = memoryStore();
  const diskAheadRoot = await mkdtemp(resolve(tmpdir(), 'fabric-keyset-disk-ahead-'));
  const diskAheadPath = resolve(diskAheadRoot, 'device.json');
  await saveKeysetConfig({ configPath: diskAheadPath, publicKeyEd25519: fixture.firstPublic, keyset: fixture.initial, now });
  await anchorConfig(diskAheadPath, diskAheadStore);
  await saveKeysetConfig({ configPath: diskAheadPath, publicKeyEd25519: fixture.firstPublic, keyset: fixture.rotated, now });
  const recoveredAnchor = await recoverDeviceEnrollmentConsistency({ configPath: diskAheadPath, store: diskAheadStore, now });
  assert.equal(recoveredAnchor.serverSigningKeyset?.generation, 2);
  assert.equal((await loadDeviceEnrollmentAnchor({ config: recoveredAnchor, store: diskAheadStore })).serverSigningKeyset?.generation, 2);
});

test('authenticated workspace responses can deliver only chain-verified periodic keysets', async () => {
  const now = new Date();
  const fixture = keysetFixture(now);
  const store = memoryStore();
  const root = await mkdtemp(resolve(tmpdir(), 'fabric-keyset-workspace-delivery-'));
  const configPath = resolve(root, 'device.json');
  const identity = await loadOrCreateDeviceIdentity({ hqUrl: 'https://hq.example', organizationId: 'org_a', store });
  await saveKeysetConfig({
    configPath, publicKeyEd25519: fixture.firstPublic,
    devicePublicKeyEd25519: identity.publicKeyEd25519, keyset: fixture.initial, now,
  });
  await anchorConfig(configPath, store);
  const client = await AgentFabricClient.open({
    configPath, statePath: resolve(root, 'state.json'), store,
    fetcher: async (url) => new Response(JSON.stringify(
      new URL(url).pathname.endsWith('/agent-fabric/workspaces')
        ? { workspaceId: 'workspace', serverSigningKeyset: fixture.rotated }
        : { ok: true },
    ), { status: 201 }),
  });
  await client.openSession();
  await client.registerWorkspace({ workspaceId: 'workspace' });
  assert.equal(client.config.serverSigningKeyset?.generation, 2);
  assert.equal(JSON.parse(await readFile(configPath, 'utf8')).serverSigningKeyset.generation, 2);

  const untrusted = { ...fixture.rotated, generation: 3, signature: 'invalid' };
  const rejectingClient = await AgentFabricClient.open({
    configPath, statePath: resolve(root, 'state-reject.json'), store,
    fetcher: async (url) => new Response(JSON.stringify(
      new URL(url).pathname.endsWith('/agent-fabric/workspaces')
        ? { workspaceId: 'workspace', serverSigningKeyset: untrusted }
        : { ok: true },
    ), { status: 201 }),
  });
  await rejectingClient.openSession();
  await assert.rejects(rejectingClient.registerWorkspace({ workspaceId: 'workspace' }), /Server signing keyset was rejected/);
  assert.equal(JSON.parse(await readFile(configPath, 'utf8')).serverSigningKeyset.generation, 2);
});

test('active skill authorization anchors can be restored or removed transactionally', async () => {
  const store = memoryStore();
  const config = {
    hqUrl: 'https://www.dharma-ai.io',
    organizationId: 'org_a',
    deviceId: 'c72c7f13-e420-49f7-a818-c07f6f9d0915',
  };
  const input = {
    config,
    workspaceId: 'workspace-a',
    organizationAgentId: '11111111-1111-4111-8111-111111111111',
    provider: 'codex' as const,
    bundleId: '22222222-2222-4222-8222-222222222222',
    receiptHash: `sha256:${'a'.repeat(64)}`,
    activatedAt: '2026-08-16T12:00:00.000Z',
    expiresAt: null,
    store,
  };
  await saveActiveSkillAuthorizationAnchor(input);
  assert.equal((await loadActiveSkillAuthorizationAnchor(input))?.bundleId, input.bundleId);
  await deleteActiveSkillAuthorizationAnchor({ config, workspaceId: input.workspaceId, provider: input.provider, store });
  assert.equal(await loadActiveSkillAuthorizationAnchor(input), null);
});

test('secure enrollment anchor rejects mutable device configuration substitution', async () => {
  const store = memoryStore();
  const root = await mkdtemp(resolve(tmpdir(), 'fabric-enrollment-anchor-'));
  const identity = await loadOrCreateDeviceIdentity({ hqUrl: 'https://hq.example', organizationId: 'org_a', store });
  const configPath = resolve(root, 'device.json');
  await saveDeviceConfig(configPath, {
    schema: 'dharma.device-config/v1', hqUrl: 'https://hq.example', organizationId: 'org_a',
    deviceId: 'c72c7f13-e420-49f7-a818-c07f6f9d0915', deviceName: 'Test', platform: 'linux',
    publicKeyEd25519: identity.publicKeyEd25519, serverPublicKeyEd25519: identity.publicKeyEd25519,
    relayUrl: 'wss://relay.example', enrolledAt: new Date().toISOString(),
  });
  await anchorConfig(configPath, store);
  const substituted = JSON.parse(await readFile(configPath, 'utf8'));
  substituted.serverPublicKeyEd25519 = generateKeyPairSync('ed25519').publicKey.export({ format: 'jwk' }).x;
  await writeFile(configPath, JSON.stringify(substituted));
  await assert.rejects(
    AgentFabricClient.open({ configPath, statePath: resolve(root, 'state.json'), store }),
    /does not match the secure enrollment anchor/,
  );
});

test('secure enrollment anchors coexist for multiple devices in one organization', async () => {
  const store = memoryStore();
  const identity = await loadOrCreateDeviceIdentity({ hqUrl: 'https://hq.example', organizationId: 'org_a', store });
  const base = {
    schema: 'dharma.device-config/v1' as const,
    hqUrl: 'https://hq.example',
    organizationId: 'org_a',
    deviceName: 'Test',
    platform: 'linux' as const,
    publicKeyEd25519: identity.publicKeyEd25519,
    serverPublicKeyEd25519: identity.publicKeyEd25519,
    relayUrl: 'wss://relay.example',
    enrolledAt: new Date().toISOString(),
  };
  const first = { ...base, deviceId: 'c72c7f13-e420-49f7-a818-c07f6f9d0915' };
  const second = { ...base, deviceId: 'd83d8f24-f531-4af8-b929-d18f7f0e1026' };
  await saveDeviceEnrollmentAnchor({ config: first, store });
  await saveDeviceEnrollmentAnchor({ config: second, store });
  assert.equal((await loadDeviceEnrollmentAnchor({ config: first, store })).deviceId, first.deviceId);
  assert.equal((await loadDeviceEnrollmentAnchor({ config: second, store })).deviceId, second.deviceId);
});

test('legacy production enrollment requires explicit re-login without contacting mutable relay metadata', async () => {
  const store = memoryStore();
  const root = await mkdtemp(resolve(tmpdir(), 'fabric-legacy-anchor-'));
  const hqUrl = 'https://www.dharma-ai.io';
  const organizationId = 'org_a';
  const identity = await loadOrCreateDeviceIdentity({ hqUrl, organizationId, store });
  const configPath = resolve(root, 'device.json');
  const statePath = resolve(root, 'state.json');
  const relayUrl = 'wss://relay.dharma-ai.io';
  await saveDeviceConfig(configPath, {
    schema: 'dharma.device-config/v1', hqUrl, organizationId,
    deviceId: 'c72c7f13-e420-49f7-a818-c07f6f9d0915', deviceName: 'Legacy', platform: 'linux',
    publicKeyEd25519: identity.publicKeyEd25519, serverPublicKeyEd25519: identity.publicKeyEd25519,
    relayUrl, enrolledAt: new Date().toISOString(),
  });
  let contacted = false;
  await assert.rejects(AgentFabricClient.open({
    configPath, statePath, store,
    fetcher: async () => { contacted = true; throw new Error('legacy enrollment must not contact mutable transport'); },
  }), /must be reauthenticated with dharma login/);
  assert.equal(contacted, false);
});

test('legacy enrollment never trusts a replacement server identity from device configuration', async () => {
  const store = memoryStore();
  const root = await mkdtemp(resolve(tmpdir(), 'fabric-legacy-mismatch-'));
  const hqUrl = 'https://www.dharma-ai.io';
  const organizationId = 'org_a';
  const identity = await loadOrCreateDeviceIdentity({ hqUrl, organizationId, store });
  const configPath = resolve(root, 'device.json');
  await saveDeviceConfig(configPath, {
    schema: 'dharma.device-config/v1', hqUrl, organizationId,
    deviceId: 'c72c7f13-e420-49f7-a818-c07f6f9d0915', deviceName: 'Legacy', platform: 'linux',
    publicKeyEd25519: identity.publicKeyEd25519, serverPublicKeyEd25519: identity.publicKeyEd25519,
    relayUrl: 'wss://relay.dharma-ai.io', enrolledAt: new Date().toISOString(),
  });
  await assert.rejects(AgentFabricClient.open({
    configPath, statePath: resolve(root, 'state.json'), store,
    fetcher: async () => { throw new Error('legacy enrollment must not contact mutable transport'); },
  }), /must be reauthenticated with dharma login/);
});

test('legacy enrollment on a custom origin requires explicit re-login', async () => {
  const store = memoryStore();
  const root = await mkdtemp(resolve(tmpdir(), 'fabric-legacy-custom-origin-'));
  const hqUrl = 'https://hq.example';
  const organizationId = 'org_a';
  const identity = await loadOrCreateDeviceIdentity({ hqUrl, organizationId, store });
  const configPath = resolve(root, 'device.json');
  await saveDeviceConfig(configPath, {
    schema: 'dharma.device-config/v1', hqUrl, organizationId,
    deviceId: 'c72c7f13-e420-49f7-a818-c07f6f9d0915', deviceName: 'Legacy', platform: 'linux',
    publicKeyEd25519: identity.publicKeyEd25519, serverPublicKeyEd25519: identity.publicKeyEd25519,
    relayUrl: 'wss://relay.example', enrolledAt: new Date().toISOString(),
  });
  await assert.rejects(AgentFabricClient.open({
    configPath, statePath: resolve(root, 'state.json'), store,
    fetcher: async () => { throw new Error('custom origin must not be contacted'); },
  }), /must be reauthenticated with dharma login/);
});

test('enrollment sends only the public device key and an idempotency key', async () => {
  const pair = generateKeyPairSync('ed25519');
  const jwk = pair.publicKey.export({ format: 'jwk' });
  let requestBody = '';
  const fetcher = async (_url: string | URL | Request, init?: RequestInit) => {
    requestBody = String(init?.body || '');
    assert.ok(new Headers(init?.headers).get('idempotency-key'));
    return new Response(JSON.stringify({ deviceCode: 'd', browserCode: 'b', verificationUri: 'https://hq/verify', expiresInSeconds: 600 }), { status: 201 });
  };
  await beginEnrollment({ hqUrl: 'https://hq.example', organizationId: 'org_a', name: 'Laptop', platform: 'linux', publicKeyEd25519: jwk.x!, fetcher });
  const parsed = JSON.parse(requestBody);
  assert.equal(parsed.publicKeyEd25519, jwk.x);
  assert.deepEqual(Object.keys(parsed).sort(), ['name', 'organizationId', 'platform', 'publicKeyEd25519']);
});

test('repository-agent connection uses the signed organization relay route', async () => {
  const store = memoryStore();
  const root = await mkdtemp(resolve(tmpdir(), 'fabric-repository-agent-client-'));
  const identity = await loadOrCreateDeviceIdentity({ hqUrl: 'https://hq.example', organizationId: 'org_a', store });
  const configPath = resolve(root, 'device.json');
  await saveDeviceConfig(configPath, {
    schema: 'dharma.device-config/v1', hqUrl: 'https://hq.example', organizationId: 'org_a',
    deviceId: 'c72c7f13-e420-49f7-a818-c07f6f9d0915', deviceName: 'Test', platform: 'linux',
    publicKeyEd25519: identity.publicKeyEd25519, serverPublicKeyEd25519: identity.publicKeyEd25519,
    relayUrl: 'wss://relay.example', enrolledAt: new Date().toISOString(),
  });
  await anchorConfig(configPath, store);
  const calls: Array<{ path: string; body: Record<string, unknown>; signed: boolean }> = [];
  const fetcher = async (url: string | URL | Request, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    calls.push({
      path: new URL(String(url)).pathname,
      body: JSON.parse(String(init?.body || '{}')) as Record<string, unknown>,
      signed: Boolean(headers.get('x-dharma-signature')),
    });
    return new Response(JSON.stringify({ ok: true }), { status: 201 });
  };
  const client = await AgentFabricClient.open({ configPath, statePath: resolve(root, 'state.json'), store, fetcher });
  await client.openSession();
  await client.connectRepositoryAgent({
    sourceFingerprint: `sha256:${'a'.repeat(64)}`,
    displayName: 'Northstar',
    defaultSourceRef: 'main',
  });
  assert.equal(calls.at(-1)?.path, '/api/v1/orgs/org_a/agent-fabric/repository-agents');
  assert.equal(calls.at(-1)?.signed, true);
  assert.equal(calls.at(-1)?.body.displayName, 'Northstar');
});

test('control-agent reads and chat turns use the enrolled device signature', async () => {
  const store = memoryStore();
  const root = await mkdtemp(resolve(tmpdir(), 'fabric-control-agent-client-'));
  const identity = await loadOrCreateDeviceIdentity({ hqUrl: 'https://hq.example', organizationId: 'org_a', store });
  const configPath = resolve(root, 'device.json');
  await saveDeviceConfig(configPath, {
    schema: 'dharma.device-config/v1', hqUrl: 'https://hq.example', organizationId: 'org_a',
    deviceId: 'c72c7f13-e420-49f7-a818-c07f6f9d0915', deviceName: 'Test', platform: 'linux',
    publicKeyEd25519: identity.publicKeyEd25519, serverPublicKeyEd25519: identity.publicKeyEd25519,
    relayUrl: 'wss://relay.example', enrolledAt: new Date().toISOString(),
  });
  await anchorConfig(configPath, store);
  const calls: Array<{
    method: string;
    pathname: string;
    search: string;
    body: unknown;
    signed: boolean;
    idempotencyKey: string | null;
    messageId: string;
  }> = [];
  const fetcher = async (url: string | URL | Request, init?: RequestInit) => {
    const parsed = new URL(String(url));
    const headers = new Headers(init?.headers);
    const serialized = init?.body == null ? '' : String(init.body);
    const messageId = headers.get('x-dharma-message-id')!;
    const signingPayload = Buffer.from(JSON.stringify({
      bodyHash: `sha256:${createHash('sha256').update(serialized).digest('hex')}`,
      deviceId: headers.get('x-dharma-device-id'),
      messageId,
      method: init?.method,
      nonce: headers.get('x-dharma-nonce'),
      organizationId: 'org_a',
      pathname: `${parsed.pathname}${parsed.search}`,
      sequence: Number(headers.get('x-dharma-sequence')),
      sessionId: headers.get('x-dharma-session-id'),
      timestamp: headers.get('x-dharma-timestamp'),
    }));
    assert.equal(verify(
      null,
      signingPayload,
      createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: identity.publicKeyEd25519 }, format: 'jwk' }),
      Buffer.from(headers.get('x-dharma-signature')!, 'base64url'),
    ), true);
    calls.push({
      method: String(init?.method), pathname: parsed.pathname, search: parsed.search,
      body: serialized ? JSON.parse(serialized) : null,
      signed: Boolean(headers.get('x-dharma-signature')),
      idempotencyKey: headers.get('idempotency-key'),
      messageId,
    });
    return new Response(JSON.stringify({ ok: true }), { status: parsed.pathname.endsWith('/sessions') && init?.method === 'POST' ? 201 : 200 });
  };
  const client = await AgentFabricClient.open({ configPath, statePath: resolve(root, 'state.json'), store, fetcher });
  await client.openSession();
  await client.createControlAgentSession('Operator session');
  await client.listControlAgentSessions('d327bcce-2314-4c92-a6b7-13ec5570c1ee');
  await client.submitControlAgentMessage('d327bcce-2314-4c92-a6b7-13ec5570c1ee', { message: 'Show agent status.' });
  await client.listControlAgentEvents('d327bcce-2314-4c92-a6b7-13ec5570c1ee', 7);

  assert.deepEqual(calls.slice(-4).map(({ method, pathname, search, signed }) => ({ method, pathname, search, signed })), [
    { method: 'POST', pathname: '/api/v1/orgs/org_a/control-agent/sessions', search: '', signed: true },
    { method: 'GET', pathname: '/api/v1/orgs/org_a/control-agent/sessions', search: '?sessionId=d327bcce-2314-4c92-a6b7-13ec5570c1ee', signed: true },
    { method: 'POST', pathname: '/api/v1/orgs/org_a/control-agent/sessions/d327bcce-2314-4c92-a6b7-13ec5570c1ee/messages', search: '', signed: true },
    { method: 'GET', pathname: '/api/v1/orgs/org_a/control-agent/sessions/d327bcce-2314-4c92-a6b7-13ec5570c1ee/events', search: '?afterSequence=7', signed: true },
  ]);
  assert.equal(calls.at(-3)?.body, null);
  assert.deepEqual(calls.at(-2)?.body, { message: 'Show agent status.' });
  assert.equal(calls.at(-4)?.idempotencyKey, calls.at(-4)?.messageId);
  assert.equal(calls.at(-3)?.idempotencyKey, null);
  assert.equal(calls.at(-2)?.idempotencyKey, calls.at(-2)?.messageId);
  assert.equal(calls.at(-1)?.idempotencyKey, null);
});

test('signed outbox retries the exact message after an unknown network outcome', async () => {
  const store = memoryStore();
  const root = await mkdtemp(resolve(tmpdir(), 'fabric-relay-client-'));
  const identity = await loadOrCreateDeviceIdentity({ hqUrl: 'https://hq.example', organizationId: 'org_a', store });
  const configPath = resolve(root, 'device.json');
  const statePath = resolve(root, 'state.json');
  await saveDeviceConfig(configPath, {
    schema: 'dharma.device-config/v1', hqUrl: 'https://hq.example', organizationId: 'org_a',
    deviceId: 'c72c7f13-e420-49f7-a818-c07f6f9d0915', deviceName: 'Test', platform: 'linux',
    publicKeyEd25519: identity.publicKeyEd25519, serverPublicKeyEd25519: identity.publicKeyEd25519,
    relayUrl: 'wss://relay.example', enrolledAt: new Date().toISOString(),
  });
  await anchorConfig(configPath, store);
  const messageIds: string[] = [];
  const idempotencyKeys: Array<string | null> = [];
  const timestamps: string[] = [];
  let failAfterAccept = false;
  const fetcher = async (url: string | URL | Request, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    const pathname = new URL(String(url)).pathname;
    const body = String(init?.body || '');
    const messageId = headers.get('x-dharma-message-id')!;
    messageIds.push(messageId);
    idempotencyKeys.push(headers.get('idempotency-key'));
    timestamps.push(headers.get('x-dharma-timestamp')!);
    const payload = Buffer.from(JSON.stringify({
      bodyHash: `sha256:${createHash('sha256').update(body).digest('hex')}`,
      deviceId: headers.get('x-dharma-device-id'), messageId, method: 'POST',
      nonce: headers.get('x-dharma-nonce'), organizationId: 'org_a', pathname,
      sequence: Number(headers.get('x-dharma-sequence')), sessionId: headers.get('x-dharma-session-id'),
      timestamp: headers.get('x-dharma-timestamp'),
    }));
    assert.equal(verify(null, payload, createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: identity.publicKeyEd25519 }, format: 'jwk' }), Buffer.from(headers.get('x-dharma-signature')!, 'base64url')), true);
    if (failAfterAccept) { failAfterAccept = false; throw new Error('socket closed after upstream accepted'); }
    return new Response(JSON.stringify({ ok: true, session: { id: headers.get('x-dharma-session-id') } }), { status: 201 });
  };
  const client = await AgentFabricClient.open(withOwner({ configPath, statePath, store, fetcher }, 'relay:restart'));
  await client.openSession();
  failAfterAccept = true;
  await assert.rejects(client.registerWorkspace({ workspaceId: 'workspace', name: 'Work' }), /socket closed/);
  const state = JSON.parse(await readFile(statePath, 'utf8'));
  state.outboxes['relay:restart'].pending.headers['x-dharma-timestamp'] = '2026-01-01T00:00:00.000Z';
  await writeFile(statePath, JSON.stringify(state));
  const resumed = await AgentFabricClient.open(withOwner({ configPath, statePath, store, fetcher }, 'relay:restart'));
  await resumed.registerWorkspace({ name: 'Work', workspaceId: 'workspace' });
  assert.equal(messageIds.at(-2), messageIds.at(-1));
  assert.equal(idempotencyKeys.at(-2), messageIds.at(-2));
  assert.equal(idempotencyKeys.at(-1), messageIds.at(-1));
  assert.notEqual(timestamps.at(-2), timestamps.at(-1));
});

for (const scenario of [
  { name: 'workspace body', oldMethod: 'POST', oldRoute: '/agent-fabric/skills/poll', oldBody: { workspaceId: 'first', provider: 'codex' }, method: 'POST', route: '/agent-fabric/skills/poll', body: { workspaceId: 'second', provider: 'codex' } },
  { name: 'route', oldMethod: 'POST', oldRoute: '/agent-fabric/tasks/poll', oldBody: {}, method: 'POST', route: '/agent-fabric/skills/poll', body: {} },
  { name: 'method', oldMethod: 'GET', oldRoute: '/agent-fabric/workspaces', oldBody: undefined, method: 'POST', route: '/agent-fabric/workspaces', body: {} },
  { name: 'query', oldMethod: 'GET', oldRoute: '/control-agent/sessions?sessionId=first', oldBody: undefined, method: 'GET', route: '/control-agent/sessions?sessionId=second', body: undefined },
] as const) {
  test(`signed outbox recovery binds the current ${scenario.name}`, async () => {
    const store = memoryStore();
    const root = await mkdtemp(resolve(tmpdir(), 'fabric-request-binding-'));
    const identity = await loadOrCreateDeviceIdentity({ hqUrl: 'https://hq.example', organizationId: 'org_a', store });
    const configPath = resolve(root, 'device.json');
    const statePath = resolve(root, 'state.json');
    await saveDeviceConfig(configPath, {
      schema: 'dharma.device-config/v1', hqUrl: 'https://hq.example', organizationId: 'org_a',
      deviceId: 'c72c7f13-e420-49f7-a818-c07f6f9d0915', deviceName: 'Test', platform: 'linux',
      publicKeyEd25519: identity.publicKeyEd25519, serverPublicKeyEd25519: identity.publicKeyEd25519,
      relayUrl: 'wss://relay.example', enrolledAt: new Date().toISOString(),
    });
    await anchorConfig(configPath, store);
    const calls: Array<{ method: string; route: string; body: string; messageId: string | null; sequence: number }> = [];
    let failures = 0;
    const fetcher = async (url: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      const parsed = new URL(String(url));
      const call = { method: init?.method || 'GET', route: parsed.pathname.replace('/api/v1/orgs/org_a', '') + parsed.search,
        body: String(init?.body || ''), messageId: headers.get('x-dharma-message-id'), sequence: Number(headers.get('x-dharma-sequence')) };
      calls.push(call);
      if (failures > 0) { failures -= 1; throw new Error('unknown delivery outcome'); }
      return new Response(JSON.stringify({ ok: true, organizationId: 'org_a', rollout: null, observed: call }), { status: 200 });
    };
    let client = await AgentFabricClient.open(withOwner({ configPath, statePath, store, fetcher }, 'relay:restart'));
    await client.openSession();
    const send = (method: string, route: string, body: unknown) => method === 'GET' ? client.signedGet(route) : client.signedPost(route, body);
    failures = 1;
    await assert.rejects(send(scenario.oldMethod, scenario.oldRoute, scenario.oldBody), /unknown delivery/);
    const original = calls.at(-1)!;
    client = await AgentFabricClient.open(withOwner({ configPath, statePath, store, fetcher }, 'relay:restart'));
    const pendingBytes = await readFile(statePath, 'utf8');
    const count = calls.length;
    const invalid: Record<string, unknown> = {};
    invalid.circular = invalid;
    await assert.rejects(client.signedPost('/agent-fabric/skills/poll', invalid));
    assert.equal(calls.length, count);
    assert.equal(await readFile(statePath, 'utf8'), pendingBytes);
    failures = 1;
    await assert.rejects(send(scenario.method, scenario.route, scenario.body), /unknown delivery/);
    assert.equal(calls.at(-1)?.messageId, original.messageId);
    assert.equal(JSON.parse(await readFile(statePath, 'utf8')).outboxes['relay:restart'].pending.pathname,
      `/api/v1/orgs/org_a${scenario.oldRoute}`);
    const [current, next] = await Promise.all([
      send(scenario.method, scenario.route, scenario.body),
      client.signedGet('/control-agent/sessions?sessionId=third'),
    ]);
    assert.deepEqual(calls.at(-3), original);
    const dispatched = calls.at(-2)!;
    assert.equal(dispatched.route, scenario.route);
    assert.equal(dispatched.method, scenario.method);
    assert.deepEqual(dispatched.body ? JSON.parse(dispatched.body) : undefined, scenario.body);
    assert.notEqual(dispatched.messageId, original.messageId);
    assert.equal(dispatched.sequence, original.sequence + 1);
    assert.deepEqual(current.observed, dispatched);
    assert.deepEqual(next.observed, calls.at(-1));
    assert.equal(calls.at(-1)?.route, '/control-agent/sessions?sessionId=third');
    assert.equal(JSON.parse(await readFile(statePath, 'utf8')).outboxes['relay:restart'].pending, null);
  });
}

for (const contentRoute of ['trajectories', 'codex-task-exports']) {
test(`content-bearing ${contentRoute} outbox is discarded before a new session can replay it`, async () => {
  const store = memoryStore();
  const root = await mkdtemp(resolve(tmpdir(), 'fabric-content-outbox-'));
  const identity = await loadOrCreateDeviceIdentity({ hqUrl: 'https://hq.example', organizationId: 'org_a', store });
  const configPath = resolve(root, 'device.json');
  const statePath = resolve(root, 'state.json');
  await saveDeviceConfig(configPath, {
    schema: 'dharma.device-config/v1', hqUrl: 'https://hq.example', organizationId: 'org_a',
    deviceId: 'c72c7f13-e420-49f7-a818-c07f6f9d0915', deviceName: 'Test', platform: 'linux',
    publicKeyEd25519: identity.publicKeyEd25519, serverPublicKeyEd25519: identity.publicKeyEd25519,
    relayUrl: 'wss://relay.example', enrolledAt: new Date().toISOString(),
  });
  await anchorConfig(configPath, store);
  const paths: string[] = [];
  let failTrajectory = true;
  const fetcher = async (url: string | URL | Request) => {
    const pathname = new URL(String(url)).pathname;
    paths.push(pathname);
    if (failTrajectory && pathname.endsWith(`/agent-fabric/${contentRoute}`)) {
      failTrajectory = false;
      throw new Error('unknown trajectory delivery outcome');
    }
    return new Response(JSON.stringify({ ok: true }), { status: 201 });
  };
  const client = await AgentFabricClient.open({ configPath, statePath, store, fetcher });
  await client.openSession();
  await assert.rejects(client.signedPost(`/agent-fabric/${contentRoute}`,
    { secret: 'authorized-at-the-time' }),
  /unknown trajectory delivery/);
  const durableState = JSON.parse(await readFile(statePath, 'utf8'));
  assert.equal(durableState.pending, null);
  assert.doesNotMatch(await readFile(statePath, 'utf8'), /authorized-at-the-time/);
  const resumed = await AgentFabricClient.open({ configPath, statePath, store, fetcher });
  await resumed.openSession();
  assert.equal(paths.filter((path) => path.endsWith(`/agent-fabric/${contentRoute}`)).length, 1);
  assert.equal(JSON.parse(await readFile(statePath, 'utf8')).pending, null);
});
}

test('trajectory head lookup is device signed without becoming a content-bearing replay', async () => {
  const store = memoryStore();
  const root = await mkdtemp(resolve(tmpdir(), 'fabric-trajectory-head-'));
  const identity = await loadOrCreateDeviceIdentity({ hqUrl: 'https://hq.example', organizationId: 'org_a', store });
  const configPath = resolve(root, 'device.json');
  const statePath = resolve(root, 'state.json');
  await saveDeviceConfig(configPath, {
    schema: 'dharma.device-config/v1', hqUrl: 'https://hq.example', organizationId: 'org_a',
    deviceId: 'c72c7f13-e420-49f7-a818-c07f6f9d0915', deviceName: 'Test', platform: 'linux',
    publicKeyEd25519: identity.publicKeyEd25519, serverPublicKeyEd25519: identity.publicKeyEd25519,
    relayUrl: 'wss://relay.example', enrolledAt: new Date().toISOString(),
  });
  await anchorConfig(configPath, store);
  let observedBody = '';
  const client = await AgentFabricClient.open({
    configPath, statePath, store,
    fetcher: async (url, init) => {
      const pathname = new URL(String(url)).pathname;
      if (pathname.endsWith('/agent-fabric/sessions')) {
        return new Response(JSON.stringify({ ok: true }), { status: 201 });
      }
      observedBody = String(init?.body || '');
      assert.match(pathname, /\/agent-fabric\/trajectories\/head$/);
      return new Response(JSON.stringify({
        ok: true,
        head: { revision: 3, capsuleHash: `sha256:${'a'.repeat(64)}` },
      }), { status: 200 });
    },
  });
  await client.openSession();
  const response = await client.getTrajectoryHead({
    trajectoryId: '11111111-1111-4111-8111-111111111111',
    workspaceId: '22222222-2222-4222-8222-222222222222',
  });
  assert.deepEqual(response.head, { revision: 3, capsuleHash: `sha256:${'a'.repeat(64)}` });
  assert.match(observedBody, /trajectoryId/);
});

test('accepted task completion replay preserves the server receipt until the CLI acknowledges it', async () => {
  const store = memoryStore();
  const root = await mkdtemp(resolve(tmpdir(), 'fabric-task-completion-retry-'));
  const identity = await loadOrCreateDeviceIdentity({ hqUrl: 'https://hq.example', organizationId: 'org_a', store });
  const configPath = resolve(root, 'device.json');
  const statePath = resolve(root, 'state.json');
  const taskId = 'd93ce685-113c-45f7-8ba0-334cc7b917f4';
  const trajectoryCapsuleHash = `sha256:${'a'.repeat(64)}`;
  const receiptHash = `sha256:${'b'.repeat(64)}`;
  await saveDeviceConfig(configPath, {
    schema: 'dharma.device-config/v1', hqUrl: 'https://hq.example', organizationId: 'org_a',
    deviceId: 'c72c7f13-e420-49f7-a818-c07f6f9d0915', deviceName: 'Test', platform: 'linux',
    publicKeyEd25519: identity.publicKeyEd25519, serverPublicKeyEd25519: identity.publicKeyEd25519,
    relayUrl: 'wss://relay.example', enrolledAt: new Date().toISOString(),
  });
  await anchorConfig(configPath, store);
  let interruptCompletion = true;
  let completionCalls = 0;
  const fetcher = async (url: string | URL | Request) => {
    const pathname = new URL(String(url)).pathname;
    if (pathname.endsWith(`/agent-fabric/tasks/${taskId}/events`)) {
      completionCalls += 1;
      if (interruptCompletion) {
        interruptCompletion = false;
        throw new Error('connection lost after task completion commit');
      }
      return new Response(JSON.stringify({ ok: true, receipt: { hash: receiptHash } }), { status: 201 });
    }
    return new Response(JSON.stringify({ ok: true }), { status: 201 });
  };
  const client = await AgentFabricClient.open(withOwner({ configPath, statePath, store, fetcher }, 'relay:restart'));
  await client.openSession();
  await assert.rejects(client.postTaskEvent(taskId, 'completed', { trajectoryCapsuleHash }), /connection lost/);
  assert.deepEqual(client.listRecoveredTaskCompletions(), []);

  const resumed = await AgentFabricClient.open(withOwner({ configPath, statePath, store, fetcher }, 'relay:restart'));
  await resumed.openSession();
  assert.equal(completionCalls, 2);
  assert.deepEqual(resumed.listRecoveredTaskCompletions().map(({ recoveredAt, ...item }) => item), [{
    taskId, trajectoryCapsuleHash, receiptHash,
  }]);

  const restarted = await AgentFabricClient.open({ configPath, statePath, store, fetcher });
  assert.equal(restarted.listRecoveredTaskCompletions().length, 1);
  await restarted.acknowledgeRecoveredTaskCompletion(taskId, receiptHash);
  assert.deepEqual(restarted.listRecoveredTaskCompletions(), []);
  const final = await AgentFabricClient.open({ configPath, statePath, store, fetcher });
  assert.deepEqual(final.listRecoveredTaskCompletions(), []);
});

test('an accepted task completion without staged trajectory evidence does not poison the outbox', async () => {
  const store = memoryStore();
  const root = await mkdtemp(resolve(tmpdir(), 'fabric-task-completion-without-evidence-'));
  const identity = await loadOrCreateDeviceIdentity({ hqUrl: 'https://hq.example', organizationId: 'org_a', store });
  const configPath = resolve(root, 'device.json');
  const statePath = resolve(root, 'state.json');
  const taskId = 'd93ce685-113c-45f7-8ba0-334cc7b917f4';
  const receiptHash = `sha256:${'b'.repeat(64)}`;
  await saveDeviceConfig(configPath, {
    schema: 'dharma.device-config/v1', hqUrl: 'https://hq.example', organizationId: 'org_a',
    deviceId: 'c72c7f13-e420-49f7-a818-c07f6f9d0915', deviceName: 'Test', platform: 'linux',
    publicKeyEd25519: identity.publicKeyEd25519, serverPublicKeyEd25519: identity.publicKeyEd25519,
    relayUrl: 'wss://relay.example', enrolledAt: new Date().toISOString(),
  });
  await anchorConfig(configPath, store);
  let calls = 0;
  const fetcher = async () => {
    calls += 1;
    return new Response(JSON.stringify({ ok: true, receipt: { hash: receiptHash } }), { status: 201 });
  };
  const client = await AgentFabricClient.open({ configPath, statePath, store, fetcher });
  await client.openSession();
  await client.postTaskEvent(taskId, 'completed', { status: 'completed' });
  assert.deepEqual(client.listRecoveredTaskCompletions(), []);
  const durableState = JSON.parse(await readFile(statePath, 'utf8'));
  assert.equal(durableState.pending, null);
  await assert.doesNotReject(client.signedPost('/agent-fabric/tasks/poll', { leaseSeconds: 30 }));
  assert.equal(calls, 3);
});

test('a malformed successful task acknowledgement remains pending until a durable receipt arrives', async () => {
  const store = memoryStore();
  const root = await mkdtemp(resolve(tmpdir(), 'fabric-task-completion-receipt-'));
  const identity = await loadOrCreateDeviceIdentity({ hqUrl: 'https://hq.example', organizationId: 'org_a', store });
  const configPath = resolve(root, 'device.json');
  const statePath = resolve(root, 'state.json');
  const taskId = 'd93ce685-113c-45f7-8ba0-334cc7b917f4';
  const trajectoryCapsuleHash = `sha256:${'a'.repeat(64)}`;
  const receiptHash = `sha256:${'b'.repeat(64)}`;
  await saveDeviceConfig(configPath, {
    schema: 'dharma.device-config/v1', hqUrl: 'https://hq.example', organizationId: 'org_a',
    deviceId: 'c72c7f13-e420-49f7-a818-c07f6f9d0915', deviceName: 'Test', platform: 'linux',
    publicKeyEd25519: identity.publicKeyEd25519, serverPublicKeyEd25519: identity.publicKeyEd25519,
    relayUrl: 'wss://relay.example', enrolledAt: new Date().toISOString(),
  });
  await anchorConfig(configPath, store);
  let validReceipt = false;
  let completionCalls = 0;
  const fetcher = async (url: string | URL | Request) => {
    const pathname = new URL(String(url)).pathname;
    if (pathname.endsWith(`/agent-fabric/tasks/${taskId}/events`)) {
      completionCalls += 1;
      return new Response(JSON.stringify(validReceipt
        ? { ok: true, receipt: { hash: receiptHash } }
        : { ok: true }), { status: 201 });
    }
    return new Response(JSON.stringify({ ok: true }), { status: 201 });
  };
  const client = await AgentFabricClient.open(withOwner({ configPath, statePath, store, fetcher }, 'relay:restart'));
  await client.openSession();
  await assert.rejects(
    client.postTaskEvent(taskId, 'completed', { trajectoryCapsuleHash }),
    /missing a valid durable receipt/,
  );
  const pending = JSON.parse(await readFile(statePath, 'utf8'));
  assert.match(pending.outboxes['relay:restart'].pending.pathname, new RegExp(`${taskId}/events$`));
  validReceipt = true;
  const resumed = await AgentFabricClient.open(withOwner({ configPath, statePath, store, fetcher }, 'relay:restart'));
  await resumed.openSession();
  assert.equal(completionCalls, 2);
  assert.equal(JSON.parse(await readFile(statePath, 'utf8')).pending, null);
  assert.equal(resumed.listRecoveredTaskCompletions()[0]?.receiptHash, receiptHash);
});

test('a full recovered completion queue stops before sending another completion', async () => {
  const store = memoryStore();
  const root = await mkdtemp(resolve(tmpdir(), 'fabric-task-completion-capacity-'));
  const identity = await loadOrCreateDeviceIdentity({ hqUrl: 'https://hq.example', organizationId: 'org_a', store });
  const configPath = resolve(root, 'device.json');
  const statePath = resolve(root, 'state.json');
  const taskId = 'd93ce685-113c-45f7-8ba0-334cc7b917f4';
  await saveDeviceConfig(configPath, {
    schema: 'dharma.device-config/v1', hqUrl: 'https://hq.example', organizationId: 'org_a',
    deviceId: 'c72c7f13-e420-49f7-a818-c07f6f9d0915', deviceName: 'Test', platform: 'linux',
    publicKeyEd25519: identity.publicKeyEd25519, serverPublicKeyEd25519: identity.publicKeyEd25519,
    relayUrl: 'wss://relay.example', enrolledAt: new Date().toISOString(),
  });
  await anchorConfig(configPath, store);
  await writeFile(statePath, JSON.stringify({
    schema: 'dharma.protocol-state/v1',
    sessionId: null,
    nextSequence: 1,
    pending: null,
    recoveredTaskCompletions: Array.from({ length: 1_000 }, (_, index) => ({
      taskId: `00000000-0000-4000-8000-${index.toString(16).padStart(12, '0')}`,
      trajectoryCapsuleHash: `sha256:${'a'.repeat(64)}`,
      receiptHash: `sha256:${'b'.repeat(64)}`,
      recoveredAt: '2026-08-16T00:00:00.000Z',
    })),
  }));
  let networkCalls = 0;
  const fetcher = async () => {
    networkCalls += 1;
    return new Response(JSON.stringify({ ok: true }), { status: 201 });
  };
  const client = await AgentFabricClient.open({ configPath, statePath, store, fetcher });
  await client.openSession();
  assert.equal(networkCalls, 1);
  const stateBefore = JSON.parse(await readFile(statePath, 'utf8'));
  await assert.rejects(
    client.postTaskEvent(taskId, 'completed', { trajectoryCapsuleHash: `sha256:${'c'.repeat(64)}` }),
    /queue is full/,
  );
  assert.equal(networkCalls, 1);
  const durableState = JSON.parse(await readFile(statePath, 'utf8'));
  assert.equal(durableState.pending, null);
  assert.equal(durableState.nextSequence, stateBefore.nextSequence);
  await assert.doesNotReject(client.signedPost('/agent-fabric/tasks/poll', { leaseSeconds: 30 }));
  assert.equal(networkCalls, 2);
});

test('corrupt recovered completion state is preserved and fails closed', async () => {
  const store = memoryStore();
  const root = await mkdtemp(resolve(tmpdir(), 'fabric-corrupt-recovery-'));
  const identity = await loadOrCreateDeviceIdentity({ hqUrl: 'https://hq.example', organizationId: 'org_a', store });
  const configPath = resolve(root, 'device.json');
  const statePath = resolve(root, 'state.json');
  await saveDeviceConfig(configPath, {
    schema: 'dharma.device-config/v1', hqUrl: 'https://hq.example', organizationId: 'org_a',
    deviceId: 'c72c7f13-e420-49f7-a818-c07f6f9d0915', deviceName: 'Test', platform: 'linux',
    publicKeyEd25519: identity.publicKeyEd25519, serverPublicKeyEd25519: identity.publicKeyEd25519,
    relayUrl: 'wss://relay.example', enrolledAt: new Date().toISOString(),
  });
  await anchorConfig(configPath, store);
  const corruptState = {
    schema: 'dharma.protocol-state/v1', sessionId: null, nextSequence: 1, pending: null,
    recoveredTaskCompletions: [{
      taskId: 'not-a-uuid',
      trajectoryCapsuleHash: `sha256:${'a'.repeat(64)}`,
      receiptHash: `sha256:${'b'.repeat(64)}`,
      recoveredAt: '2026-08-16T00:00:00.000Z',
    }],
  };
  await writeFile(statePath, JSON.stringify(corruptState));
  await assert.rejects(
    AgentFabricClient.open({ configPath, statePath, store, fetcher: async () => new Response('{}') }),
    /protocol state is invalid/,
  );
  assert.deepEqual(JSON.parse(await readFile(statePath, 'utf8')), corruptState);
});

test('a later operation cannot implicitly replay an ambiguous content request', async () => {
  const store = memoryStore();
  const root = await mkdtemp(resolve(tmpdir(), 'fabric-content-retry-'));
  const identity = await loadOrCreateDeviceIdentity({ hqUrl: 'https://hq.example', organizationId: 'org_a', store });
  const configPath = resolve(root, 'device.json');
  const statePath = resolve(root, 'state.json');
  await saveDeviceConfig(configPath, {
    schema: 'dharma.device-config/v1', hqUrl: 'https://hq.example', organizationId: 'org_a',
    deviceId: 'c72c7f13-e420-49f7-a818-c07f6f9d0915', deviceName: 'Test', platform: 'linux',
    publicKeyEd25519: identity.publicKeyEd25519, serverPublicKeyEd25519: identity.publicKeyEd25519,
    relayUrl: 'wss://relay.example', enrolledAt: new Date().toISOString(),
  });
  await anchorConfig(configPath, store);
  const calls: Array<{ path: string; body: string; sequence: number }> = [];
  let failTrajectory = true;
  const fetcher = async (url: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(url)).pathname;
    calls.push({
      path,
      body: String(init?.body || ''),
      sequence: Number(new Headers(init?.headers).get('x-dharma-sequence')),
    });
    if (failTrajectory && path.endsWith('/agent-fabric/trajectories')) {
      failTrajectory = false;
      throw new Error('unknown trajectory delivery outcome');
    }
    return new Response(JSON.stringify({ ok: true }), { status: 201 });
  };
  const client = await AgentFabricClient.open({ configPath, statePath, store, fetcher });
  await client.openSession();
  await assert.rejects(client.syncTrajectory({ secret: 'old-authorized-content' }), /unknown trajectory delivery/);
  await client.registerWorkspace({ workspaceId: 'new-control-operation' });
  assert.equal(calls.filter((call) => call.path.endsWith('/agent-fabric/trajectories')).length, 1);
  assert.match(calls.at(-1)?.body || '', /new-control-operation/);
  assert.deepEqual(calls.map((call) => call.sequence), [1, 2, 3]);
});

test('an ambiguous evidence response is neither persisted nor implicitly replayed', async () => {
  const store = memoryStore();
  const root = await mkdtemp(resolve(tmpdir(), 'fabric-evidence-response-outbox-'));
  const identity = await loadOrCreateDeviceIdentity({ hqUrl: 'https://hq.example', organizationId: 'org_a', store });
  const configPath = resolve(root, 'device.json');
  const statePath = resolve(root, 'state.json');
  await saveDeviceConfig(configPath, {
    schema: 'dharma.device-config/v1', hqUrl: 'https://hq.example', organizationId: 'org_a',
    deviceId: 'c72c7f13-e420-49f7-a818-c07f6f9d0915', deviceName: 'Test', platform: 'linux',
    publicKeyEd25519: identity.publicKeyEd25519, serverPublicKeyEd25519: identity.publicKeyEd25519,
    relayUrl: 'wss://relay.example', enrolledAt: new Date().toISOString(),
  });
  await anchorConfig(configPath, store);
  const paths: string[] = [];
  let failResponse = true;
  const fetcher = async (url: string | URL | Request) => {
    const pathname = new URL(String(url)).pathname;
    paths.push(pathname);
    if (failResponse && pathname.endsWith('/responses')) {
      failResponse = false;
      throw new Error('unknown evidence-response delivery outcome');
    }
    return new Response(JSON.stringify({ ok: true }), { status: 201 });
  };
  const client = await AgentFabricClient.open(withOwner({ configPath, statePath, store, fetcher }, 'relay:restart'));
  await client.openSession();
  await assert.rejects(
    client.postEvidenceResponse('request-1', { contentBase64: 'customer-content' }),
    /unknown evidence-response delivery/,
  );
  const persisted = await readFile(statePath, 'utf8');
  assert.doesNotMatch(persisted, /customer-content/);
  assert.equal(JSON.parse(persisted).outboxes['relay:restart'].nextSequence, 3);
  const resumed = await AgentFabricClient.open(withOwner({ configPath, statePath, store, fetcher }, 'relay:restart'));
  await resumed.registerWorkspace({ workspaceId: 'control-operation' });
  assert.equal(paths.filter((path) => path.endsWith('/responses')).length, 1);
});

test('deterministic client rejection advances the outbox instead of blocking the device', async () => {
  const store = memoryStore();
  const root = await mkdtemp(resolve(tmpdir(), 'fabric-relay-rejection-'));
  const identity = await loadOrCreateDeviceIdentity({ hqUrl: 'https://hq.example', organizationId: 'org_a', store });
  const configPath = resolve(root, 'device.json');
  const statePath = resolve(root, 'state.json');
  await saveDeviceConfig(configPath, {
    schema: 'dharma.device-config/v1', hqUrl: 'https://hq.example', organizationId: 'org_a',
    deviceId: 'c72c7f13-e420-49f7-a818-c07f6f9d0915', deviceName: 'Test', platform: 'linux',
    publicKeyEd25519: identity.publicKeyEd25519, serverPublicKeyEd25519: identity.publicKeyEd25519,
    relayUrl: 'wss://relay.example', enrolledAt: new Date().toISOString(),
  });
  await anchorConfig(configPath, store);
  const sequences: number[] = [];
  let rejectNext = false;
  const fetcher = async (_url: string | URL | Request, init?: RequestInit) => {
    sequences.push(Number(new Headers(init?.headers).get('x-dharma-sequence')));
    if (rejectNext) {
      rejectNext = false;
      return new Response(JSON.stringify({
        ok: false,
        error: { code: 'trajectory_capsule_too_large', message: 'Trajectory capsule exceeds the server limit.' },
      }), { status: 413 });
    }
    return new Response(JSON.stringify({ ok: true }), { status: 201 });
  };
  const client = await AgentFabricClient.open(withOwner({ configPath, statePath, store, fetcher }, 'relay:restart'));
  await client.openSession();
  rejectNext = true;
  await assert.rejects(client.registerWorkspace({ workspaceId: 'oversized' }), (error) => {
    assert.ok(error instanceof AgentFabricRequestError);
    assert.equal(error.status, 413);
    assert.equal((error as AgentFabricRequestError & { serverCode?: string }).serverCode, 'trajectory_capsule_too_large');
    assert.equal(isDefinitiveAgentFabricRejection(error), true);
    return true;
  });
  const state = JSON.parse(await readFile(statePath, 'utf8')).outboxes['relay:restart'];
  assert.equal(state.pending, null);
  assert.equal(state.nextSequence, 3);
  await client.registerWorkspace({ workspaceId: 'bounded' });
  assert.deepEqual(sequences, [1, 2, 3]);
});

test('retryable server rejection is an ambiguous delivery outcome', async () => {
  const store = memoryStore();
  const root = await mkdtemp(resolve(tmpdir(), 'fabric-relay-retryable-rejection-'));
  const identity = await loadOrCreateDeviceIdentity({ hqUrl: 'https://hq.example', organizationId: 'org_a', store });
  const configPath = resolve(root, 'device.json');
  const statePath = resolve(root, 'state.json');
  await saveDeviceConfig(configPath, {
    schema: 'dharma.device-config/v1', hqUrl: 'https://hq.example', organizationId: 'org_a',
    deviceId: 'c72c7f13-e420-49f7-a818-c07f6f9d0915', deviceName: 'Test', platform: 'linux',
    publicKeyEd25519: identity.publicKeyEd25519, serverPublicKeyEd25519: identity.publicKeyEd25519,
    relayUrl: 'wss://relay.example', enrolledAt: new Date().toISOString(),
  });
  await anchorConfig(configPath, store);
  let retryable = false;
  const fetcher = async () => new Response(JSON.stringify({
    ok: false, error: { code: 'upstream_unavailable', message: 'Try again.' },
  }), { status: retryable ? 503 : 201 });
  const client = await AgentFabricClient.open(withOwner({ configPath, statePath, store, fetcher }, 'relay:restart'));
  await client.openSession();
  retryable = true;
  await assert.rejects(client.registerWorkspace({ workspaceId: 'retryable' }), (error) => {
    assert.ok(error instanceof AgentFabricRequestError);
    assert.equal(error.status, 503);
    assert.equal((error as AgentFabricRequestError & { serverCode?: string }).serverCode, 'upstream_unavailable');
    assert.equal(isDefinitiveAgentFabricRejection(error), false);
    return true;
  });
  assert.notEqual(JSON.parse(await readFile(statePath, 'utf8')).outboxes['relay:restart'].pending, null);
});

test('evidence poll and response remain device-signed organization routes', async () => {
  const store = memoryStore();
  const root = await mkdtemp(resolve(tmpdir(), 'fabric-evidence-client-'));
  const identity = await loadOrCreateDeviceIdentity({ hqUrl: 'https://hq.example', organizationId: 'org_a', store });
  const configPath = resolve(root, 'device.json');
  await saveDeviceConfig(configPath, {
    schema: 'dharma.device-config/v1', hqUrl: 'https://hq.example', organizationId: 'org_a',
    deviceId: 'c72c7f13-e420-49f7-a818-c07f6f9d0915', deviceName: 'Test', platform: 'linux',
    publicKeyEd25519: identity.publicKeyEd25519, serverPublicKeyEd25519: identity.publicKeyEd25519,
    relayUrl: 'wss://relay.example', enrolledAt: new Date().toISOString(),
  });
  await anchorConfig(configPath, store);
  const paths: string[] = [];
  const fetcher = async (url: string | URL | Request) => {
    paths.push(new URL(String(url)).pathname);
    return new Response(JSON.stringify({ ok: true, request: null }), { status: 200 });
  };
  const client = await AgentFabricClient.open({ configPath, statePath: resolve(root, 'state.json'), store, fetcher });
  await client.openSession();
  await client.pollEvidence({ workspaceId: 'workspace-1' });
  await client.postEvidenceResponse('request-1', { responseId: 'response-1' });
  assert.deepEqual(paths.slice(-2), [
    '/api/v1/orgs/org_a/agent-fabric/evidence-requests/poll',
    '/api/v1/orgs/org_a/agent-fabric/evidence-requests/request-1/responses',
  ]);
});

test('relay acknowledgement settles once when close emits another socket event', async () => {
  const store = memoryStore();
  const root = await mkdtemp(resolve(tmpdir(), 'fabric-relay-close-'));
  const identity = await loadOrCreateDeviceIdentity({ hqUrl: 'https://hq.example', organizationId: 'org_a', store });
  const configPath = resolve(root, 'device.json');
  await saveDeviceConfig(configPath, {
    schema: 'dharma.device-config/v1', hqUrl: 'https://hq.example', organizationId: 'org_a',
    deviceId: 'c72c7f13-e420-49f7-a818-c07f6f9d0915', deviceName: 'Test', platform: 'linux',
    publicKeyEd25519: identity.publicKeyEd25519, serverPublicKeyEd25519: identity.publicKeyEd25519,
    relayUrl: 'wss://relay.example', enrolledAt: new Date().toISOString(),
  });
  await anchorConfig(configPath, store);

  const originalWebSocket = globalThis.WebSocket;
  let closeCalls = 0;
  class ClosingSocket {
    static readonly CONNECTING = 0;
    static readonly OPEN = 1;
    static readonly CLOSING = 2;
    static readonly CLOSED = 3;
    readyState = ClosingSocket.CONNECTING;
    readonly #listeners = new Map<string, Array<(event: { code?: number; data?: string }) => void>>();

    constructor(_url: string | URL) {
      queueMicrotask(() => {
        this.readyState = ClosingSocket.OPEN;
        this.#emit('open', {});
      });
    }

    addEventListener(type: string, listener: (event: { code?: number; data?: string }) => void) {
      const listeners = this.#listeners.get(type) || [];
      listeners.push(listener);
      this.#listeners.set(type, listeners);
    }

    #emit(type: string, event: { code?: number; data?: string }) {
      for (const listener of this.#listeners.get(type) || []) listener(event);
    }

    send(serialized: string) {
      const request = JSON.parse(serialized) as { requestId: string };
      queueMicrotask(() => this.#emit('message', {
        data: JSON.stringify({ requestId: request.requestId, status: 201, body: JSON.stringify({ ok: true }) }),
      }));
    }

    close(_code?: number) {
      closeCalls += 1;
      if (closeCalls > 1) throw new RangeError('recursive WebSocket close');
      this.readyState = ClosingSocket.CLOSING;
      this.#emit('error', {});
      this.readyState = ClosingSocket.CLOSED;
      this.#emit('close', { code: 1000 });
    }
  }

  Object.defineProperty(globalThis, 'WebSocket', {
    configurable: true,
    value: ClosingSocket,
    writable: true,
  });
  try {
    const client = await AgentFabricClient.open({
      configPath,
      statePath: resolve(root, 'state.json'),
      store,
    });
    const result = await client.openSession();
    assert.equal(result.ok, true);
    assert.equal(closeCalls, 1);
  } finally {
    Object.defineProperty(globalThis, 'WebSocket', {
      configurable: true,
      value: originalWebSocket,
      writable: true,
    });
  }
});

test('relay acknowledgement timeout accommodates managed runtime cold starts', () => {
  assert.equal(RELAY_ACKNOWLEDGEMENT_TIMEOUT_MS, 90_000);
});

test('a relay that never acknowledges fails with the stable relay_response_timeout code', async (t) => {
  const store = memoryStore();
  const root = await mkdtemp(resolve(tmpdir(), 'fabric-relay-timeout-'));
  const identity = await loadOrCreateDeviceIdentity({ hqUrl: 'https://hq.example', organizationId: 'org_a', store });
  const configPath = resolve(root, 'device.json');
  await saveDeviceConfig(configPath, {
    schema: 'dharma.device-config/v1', hqUrl: 'https://hq.example', organizationId: 'org_a',
    deviceId: 'c72c7f13-e420-49f7-a818-c07f6f9d0915', deviceName: 'Test', platform: 'linux',
    publicKeyEd25519: identity.publicKeyEd25519, serverPublicKeyEd25519: identity.publicKeyEd25519,
    relayUrl: 'wss://relay.example', enrolledAt: new Date().toISOString(),
  });
  await anchorConfig(configPath, store);

  const originalWebSocket = globalThis.WebSocket;
  // Opens and accepts the request, then never answers: only the acknowledgement timer can settle it.
  class SilentSocket {
    static readonly CONNECTING = 0;
    static readonly OPEN = 1;
    static readonly CLOSING = 2;
    static readonly CLOSED = 3;
    readyState = SilentSocket.CONNECTING;
    readonly #listeners = new Map<string, Array<(event: object) => void>>();
    constructor(_url: string | URL) {
      queueMicrotask(() => {
        this.readyState = SilentSocket.OPEN;
        for (const listener of this.#listeners.get('open') || []) listener({});
      });
    }
    addEventListener(type: string, listener: (event: object) => void) {
      this.#listeners.set(type, [...(this.#listeners.get(type) || []), listener]);
    }
    send(_serialized: string) { queueMicrotask(() => t.mock.timers.tick(RELAY_ACKNOWLEDGEMENT_TIMEOUT_MS)); }
    close(_code?: number) { this.readyState = SilentSocket.CLOSED; }
  }
  Object.defineProperty(globalThis, 'WebSocket', { configurable: true, value: SilentSocket, writable: true });
  try {
    const client = await AgentFabricClient.open({ configPath, statePath: resolve(root, 'state.json'), store });
    t.mock.timers.enable({ apis: ['setTimeout'] });
    await assert.rejects(client.openSession(), (error: Error & { code?: unknown }) => {
      assert.equal(error.code, 'relay_response_timeout');
      assert.equal(error.message, 'Relay response timed out.');
      return true;
    });
  } finally {
    t.mock.timers.reset();
    Object.defineProperty(globalThis, 'WebSocket', { configurable: true, value: originalWebSocket, writable: true });
  }
});

// #512: one signed relay request holds device signing control until it is acknowledged. The connect phase has its
// own, shorter limit: before the socket opens this attempt has sent nothing, so failing there is a clean failure and
// the kept request is sent on the next attempt, as after any other failure that keeps it. After the request is sent
// the 90 s acknowledgement window is unchanged.
function relayConnectTimeoutMs() {
  const value = (relayClientModule as unknown as { RELAY_CONNECT_TIMEOUT_MS?: unknown }).RELAY_CONNECT_TIMEOUT_MS;
  assert.equal(typeof value, 'number', 'the relay connect phase has no time limit of its own');
  return value as number;
}

type ScriptedSocket = {
  readonly sent: string[];
  closeCalls: number;
  open(): void;
  answer(status: number, body: unknown): void;
};

// A WebSocket double the test drives: onCreate runs after the client has set its timers, onSend after each send.
function scriptedRelay(script: { onCreate?: (socket: ScriptedSocket, index: number) => void;
  onSend?: (socket: ScriptedSocket, serialized: string) => void }) {
  const sockets: ScriptedSocket[] = [];
  class Socket implements ScriptedSocket {
    static readonly CONNECTING = 0;
    static readonly OPEN = 1;
    static readonly CLOSING = 2;
    static readonly CLOSED = 3;
    readyState = Socket.CONNECTING;
    readonly sent: string[] = [];
    closeCalls = 0;
    readonly #listeners = new Map<string, Array<(event: object) => void>>();
    constructor(_url: string | URL) {
      const index = sockets.push(this) - 1;
      queueMicrotask(() => script.onCreate?.(this, index));
    }
    addEventListener(type: string, listener: (event: object) => void) {
      this.#listeners.set(type, [...(this.#listeners.get(type) || []), listener]);
    }
    #emit(type: string, event: object) { for (const listener of this.#listeners.get(type) || []) listener(event); }
    open() { this.readyState = Socket.OPEN; this.#emit('open', {}); }
    answer(status: number, body: unknown) {
      const request = JSON.parse(this.sent.at(-1)!) as { requestId: string };
      this.#emit('message', { data: JSON.stringify({ requestId: request.requestId, status, body: JSON.stringify(body) }) });
    }
    send(serialized: string) { this.sent.push(serialized); queueMicrotask(() => script.onSend?.(this, serialized)); }
    close(_code?: number) { this.closeCalls += 1; this.readyState = Socket.CLOSED; }
  }
  return { Socket, sockets };
}

async function relayConnectFixture(prefix: string) {
  const store = memoryStore();
  const root = await mkdtemp(resolve(tmpdir(), prefix));
  const identity = await loadOrCreateDeviceIdentity({ hqUrl: 'https://hq.example', organizationId: 'org_a', store });
  const configPath = resolve(root, 'device.json'), statePath = resolve(root, 'state.json');
  const config = {
    schema: 'dharma.device-config/v1' as const, hqUrl: 'https://hq.example', organizationId: 'org_a',
    deviceId: 'c72c7f13-e420-49f7-a818-c07f6f9d0915', deviceName: 'Test', platform: 'linux' as const,
    publicKeyEd25519: identity.publicKeyEd25519, serverPublicKeyEd25519: identity.publicKeyEd25519,
    relayUrl: 'wss://relay.example', enrolledAt: new Date().toISOString(),
  };
  await saveDeviceConfig(configPath, config);
  await anchorConfig(configPath, store);
  return { store, configPath, statePath, config };
}

async function withRelaySocket<T>(Socket: unknown, work: () => Promise<T>) {
  const originalWebSocket = globalThis.WebSocket;
  Object.defineProperty(globalThis, 'WebSocket', { configurable: true, value: Socket, writable: true });
  try { return await work(); }
  finally { Object.defineProperty(globalThis, 'WebSocket', { configurable: true, value: originalWebSocket, writable: true }); }
}

type StoredPending = { pathname: string; body: string; headers: Record<string, string> };
async function storedPending(statePath: string) {
  const state = JSON.parse(await readFile(statePath, 'utf8')) as { outboxes?: Record<string, { pending: StoredPending | null }> };
  return Object.values(state.outboxes ?? {}).find(entry => entry.pending)?.pending ?? null;
}

function isConnectTimeout(error: Error & { code?: unknown }) {
  assert.equal(error.code, 'relay_connect_timeout');
  assert.equal(error.message, 'Relay connection timed out before the request was sent.');
  return true;
}

test('the relay connect limit is 30 s and shorter than the acknowledgement window', () => {
  assert.equal(relayConnectTimeoutMs(), 30_000);
  assert.ok(relayConnectTimeoutMs() < RELAY_ACKNOWLEDGEMENT_TIMEOUT_MS);
  assert.equal(RELAY_ACKNOWLEDGEMENT_TIMEOUT_MS, 90_000);
});

test('a relay that never accepts the connection fails at the connect limit, sends nothing and frees signing control', async (t) => {
  const limit = relayConnectTimeoutMs();
  const f = await relayConnectFixture('fabric-relay-connect-timeout-');
  const relay = scriptedRelay({ onCreate: () => t.mock.timers.tick(limit) });
  await withRelaySocket(relay.Socket, async () => {
    const client = await AgentFabricClient.open({ configPath: f.configPath, statePath: f.statePath, store: f.store });
    t.mock.timers.enable({ apis: ['setTimeout'] });
    try {
      await assert.rejects(client.openSession(), isConnectTimeout);
    } finally { t.mock.timers.reset(); }
  });
  assert.equal(relay.sockets.length, 1);
  assert.equal(relay.sockets[0]!.sent.length, 0, 'a connect timeout means the request was never sent');
  assert.equal(relay.sockets[0]!.closeCalls, 1);
  const pending = await storedPending(f.statePath);
  assert.match(pending?.pathname ?? '', /\/agent-fabric\/sessions$/, 'the signed request is kept for the next attempt');
  const started = Date.now();
  assert.equal(await withDeviceSigningControl({ config: f.config, timeoutMs: 1_000 }, async () => 'free'), 'free');
  assert.ok(Date.now() - started < 1_000, 'signing control is free once the connect limit fails the request');
});

test('a connection accepted just inside the limit keeps the full acknowledgement window', async (t) => {
  const limit = relayConnectTimeoutMs();
  const f = await relayConnectFixture('fabric-relay-connect-late-open-');
  const relay = scriptedRelay({
    onCreate: socket => { t.mock.timers.tick(limit - 1); socket.open(); },
    // Answers at 89 999 ms after the connection started: 1 ms before the unchanged acknowledgement deadline.
    onSend: socket => { t.mock.timers.tick(RELAY_ACKNOWLEDGEMENT_TIMEOUT_MS - limit); socket.answer(201, { ok: true }); },
  });
  await withRelaySocket(relay.Socket, async () => {
    const client = await AgentFabricClient.open({ configPath: f.configPath, statePath: f.statePath, store: f.store });
    t.mock.timers.enable({ apis: ['setTimeout'] });
    try {
      assert.deepEqual(await client.openSession(), { ok: true });
    } finally { t.mock.timers.reset(); }
  });
  assert.equal(relay.sockets[0]!.sent.length, 1);
  assert.equal(await storedPending(f.statePath), null);
});

test('a socket that opens after the connect limit never sends the request', async (t) => {
  const limit = relayConnectTimeoutMs();
  const f = await relayConnectFixture('fabric-relay-connect-open-after-');
  const relay = scriptedRelay({ onCreate: () => t.mock.timers.tick(limit) });
  await withRelaySocket(relay.Socket, async () => {
    const client = await AgentFabricClient.open({ configPath: f.configPath, statePath: f.statePath, store: f.store });
    t.mock.timers.enable({ apis: ['setTimeout'] });
    try {
      await assert.rejects(client.openSession(), isConnectTimeout);
    } finally { t.mock.timers.reset(); }
  });
  relay.sockets[0]!.open();
  await new Promise(accept => setImmediate(accept));
  assert.equal(relay.sockets[0]!.sent.length, 0);
});

test('retrying a request that hit the connect limit sends the original signed request exactly once', async (t) => {
  const limit = relayConnectTimeoutMs();
  const f = await relayConnectFixture('fabric-relay-connect-retry-');
  const relay = scriptedRelay({
    onCreate: (socket, index) => { if (index === 0) t.mock.timers.tick(limit); else socket.open(); },
    onSend: socket => socket.answer(201, { ok: true }),
  });
  await withRelaySocket(relay.Socket, async () => {
    const client = await AgentFabricClient.open({ configPath: f.configPath, statePath: f.statePath, store: f.store });
    t.mock.timers.enable({ apis: ['setTimeout'] });
    try {
      await assert.rejects(client.openSession(), isConnectTimeout);
    } finally { t.mock.timers.reset(); }
    const pending = await storedPending(f.statePath);
    assert.ok(pending, 'the signed request is kept after a connect timeout');
    assert.deepEqual(await client.signedPost('/agent-fabric/sessions', JSON.parse(pending.body)), { ok: true });
    const sends = relay.sockets.flatMap(socket => socket.sent)
      .map(serialized => JSON.parse(serialized) as { requestId: string; headers: Record<string, string> });
    assert.equal(sends.length, 1, 'the retry is the first and only send');
    assert.equal(sends[0]!.requestId, pending.headers['x-dharma-message-id']);
    assert.equal(sends[0]!.headers['x-dharma-message-id'], pending.headers['x-dharma-message-id']);
    assert.equal(sends[0]!.headers['x-dharma-nonce'], pending.headers['x-dharma-nonce']);
    assert.equal(sends[0]!.headers['x-dharma-signature'], pending.headers['x-dharma-signature']);
  });
  assert.equal(await storedPending(f.statePath), null);
});

test('a kept request already sent before a connect timeout is sent again unchanged on retry', async (t) => {
  const limit = relayConnectTimeoutMs();
  const f = await relayConnectFixture('fabric-relay-connect-resend-');
  const relay = scriptedRelay({
    onCreate: (socket, index) => { if (index === 1) t.mock.timers.tick(limit); else socket.open(); },
    onSend: socket => {
      if (socket === relay.sockets[0]) t.mock.timers.tick(RELAY_ACKNOWLEDGEMENT_TIMEOUT_MS);
      else socket.answer(201, { ok: true });
    },
  });
  await withRelaySocket(relay.Socket, async () => {
    const client = await AgentFabricClient.open({ configPath: f.configPath, statePath: f.statePath, store: f.store });
    t.mock.timers.enable({ apis: ['setTimeout'] });
    try {
      await assert.rejects(client.openSession(), (error: Error & { code?: unknown }) => error.code === 'relay_response_timeout');
    } finally { t.mock.timers.reset(); }
    const pending = (await storedPending(f.statePath))!;
    t.mock.timers.enable({ apis: ['setTimeout'] });
    try {
      await assert.rejects(client.signedPost('/agent-fabric/sessions', JSON.parse(pending.body)), isConnectTimeout);
    } finally { t.mock.timers.reset(); }
    assert.deepEqual(await client.signedPost('/agent-fabric/sessions', JSON.parse(pending.body)), { ok: true });
    const sends = relay.sockets.flatMap(socket => socket.sent)
      .map(serialized => JSON.parse(serialized) as { headers: Record<string, string> });
    assert.equal(relay.sockets[1]!.sent.length, 0, 'the connect-timeout attempt sent nothing');
    assert.equal(sends.length, 2, 'the retry is the second send of a request first sent before the response timeout');
    for (const header of ['x-dharma-message-id', 'x-dharma-nonce', 'x-dharma-signature']) {
      assert.equal(sends[1]!.headers[header], sends[0]!.headers[header], header);
    }
  });
  assert.equal(await storedPending(f.statePath), null);
});

test('the README describes only the signing-control guarantees the client provides (#512 review)', async () => {
  const readme = (await readFile(new URL('../README.md', import.meta.url), 'utf8')).replace(/\s+/g, ' ');
  const start = readme.indexOf('## How long one signed relay request holds device signing control');
  assert.ok(start >= 0, 'the #512 README section exists');
  const end = readme.indexOf(' ## ', start + 1);
  const section = readme.slice(start, end === -1 ? undefined : end);
  assert.doesNotMatch(section, /never in flight twice/, 'a kept request can be sent again after relay_response_timeout');
  assert.doesNotMatch(section, /first send/, 'a kept request may already have been sent by an earlier attempt');
  assert.match(section, /may be sent again/, 'the README says a kept signed request may be sent again');
});

test('missing-anchor restoration preserves current, legacy, corrupt, cached and unavailable protected state', async () => {
  const config = {schema: 'dharma.device-config/v1' as const, hqUrl: 'https://hq.example', organizationId: 'org_fixture',
    deviceId: '22222222-2222-4222-8222-222222222222', deviceName: 'Synthetic', platform: 'linux' as const,
    publicKeyEd25519: 'A'.repeat(43), serverPublicKeyEd25519: 'B'.repeat(43), relayUrl: 'wss://relay.example',
    enrolledAt: '2026-10-01T00:00:00.000Z'};
  const slot = (parts: string[]) => 'device-enrollment-' + createHash('sha256').update(parts.join(':')).digest('hex').slice(0, 32);
  const current = slot([config.hqUrl, config.organizationId, config.deviceId]), legacy = slot([config.hqUrl, config.organizationId]);
  for (const state of ['current', 'legacy', 'corrupt', 'empty', 'unavailable', 'missing']) {
    const values = new Map<string, string>(), writes: string[] = [];
    if (state !== 'missing' && state !== 'unavailable') values.set(state === 'legacy' ? legacy : current,
      state === 'empty' ? '' : state === 'corrupt' ? '{broken' : 'preexisting-protected-receipt');
    const before = new Map(values);
    const store: SecureSecretStore = {backend: 'windows-credential-manager',
      get: async () => null, // stale cache must never establish absence
      getFresh: async account => {if (state === 'unavailable') throw Error('private OS detail'); return values.get(account) ?? null;},
      put: async (account, value) => {writes.push(account); values.set(account, value);}, delete: async () => {}};
    if (state === 'missing') {
      await assertDeviceEnrollmentAnchorAbsent({config, store});
    } else {
      await assert.rejects(saveDeviceEnrollmentAnchor({config, store, requireAbsent: true}),
        state === 'unavailable' ? /connection_anchor_store_unavailable/ : /connection_existing_anchor_requires_recovery/);
      assert.deepEqual(values, before, state);
      assert.deepEqual(writes, [], state);
    }
  }
});

test('concurrent missing-anchor restoration preserves the first protected anchor', async () => {
  const config = {schema: 'dharma.device-config/v1' as const, hqUrl: 'https://race.example',
    organizationId: 'org_race', deviceId: '33333333-3333-4333-8333-333333333333',
    deviceName: 'Synthetic', platform: 'linux' as const, publicKeyEd25519: 'A'.repeat(43),
    serverPublicKeyEd25519: 'B'.repeat(43), relayUrl: 'wss://relay.example',
    enrolledAt: '2026-10-01T00:00:00.000Z'};
  const values = new Map<string, string>(), writes: string[] = [];
  const store: SecureSecretStore = {backend: 'linux-secret-service',
    get: async account => values.get(account) ?? null,
    getFresh: async account => values.get(account) ?? null,
    put: async (account, value) => {
      await new Promise(resolvePromise => setTimeout(resolvePromise, 40));
      writes.push(value); values.set(account, value);
    }, delete: async () => {throw Error('unexpected delete');}};
  const outcomes = await Promise.allSettled(['A', 'C'].map(key =>
    saveDeviceEnrollmentAnchor({config: {...config, publicKeyEd25519: key.repeat(43)}, store, requireAbsent: true})));
  assert.equal(writes.length, 1, 'a second writer must never overwrite the first protected anchor');
  assert.equal(outcomes.filter(outcome => outcome.status === 'fulfilled').length, 1);
  const rejected = outcomes.find(outcome => outcome.status === 'rejected');
  assert.equal(rejected?.status === 'rejected' && rejected.reason.message, 'connection_existing_anchor_requires_recovery');
  assert.equal([...values.values()][0], writes[0]);
});

test('keyset installation and restoration serialize in both writer orderings', async () => {
  const now = new Date(), keys = keysetFixture(now);
  for (const first of ['restore', 'install'] as const) {
    const root = await mkdtemp(resolve(tmpdir(), 'fabric-anchor-order-')), configPath = resolve(root, 'device.json');
    await saveKeysetConfig({configPath, publicKeyEd25519: keys.firstPublic, keyset: keys.initial, now});
    const config = JSON.parse(await readFile(configPath, 'utf8'));
    const values = new Map<string, string>(), writes: string[] = [];
    let pause = false, reached!: () => void, resume!: () => void;
    const entered = new Promise<void>(resolvePromise => reached = resolvePromise);
    const released = new Promise<void>(resolvePromise => resume = resolvePromise);
    const store: SecureSecretStore = {backend: 'linux-secret-service',
      get: async account => values.get(account) ?? null, getFresh: async account => values.get(account) ?? null,
      put: async (account, value) => {
        if (pause) {pause = false; reached(); await released;}
        writes.push(value); values.set(account, value);
      }, delete: async () => {throw Error('unexpected delete');}};
    if (first === 'install') await saveDeviceEnrollmentAnchor({config, store, now});
    writes.length = 0; pause = true;
    const operation = first === 'restore'
      ? saveDeviceEnrollmentAnchor({config, store, now, requireAbsent: true})
      : installTrustedServerSigningKeyset({configPath, candidate: keys.rotated, store, now});
    await entered;
    const competing = first === 'restore'
      ? installTrustedServerSigningKeyset({configPath, candidate: keys.rotated, store, now})
      : saveDeviceEnrollmentAnchor({config: {...config, publicKeyEd25519: 'C'.repeat(43)}, store, now, requireAbsent: true});
    resume();
    const outcomes = await Promise.allSettled([operation, competing]);
    assert.equal(outcomes[0]!.status, 'fulfilled');
    if (first === 'restore') {
      assert.equal(outcomes[1]!.status, 'fulfilled');
      assert.equal(writes.length, 2);
    } else {
      assert.equal(outcomes[1]!.status, 'rejected');
      assert.equal(writes.length, 1, 'a competing restoration must preserve the newly installed anchor bytes');
    }
    const final = [...values.values()][0]!;
    assert.equal(final, writes.at(-1));
    assert.equal(JSON.parse(final).serverSigningKeyset.generation, 2);
    await assert.rejects(saveDeviceEnrollmentAnchor({config, store, now}), /connection_existing_anchor_requires_recovery/);
    assert.equal([...values.values()][0], final, 'a stale ordinary writer must not roll back signing trust');
  }
});

test('legacy migration and restoration preserve both protected slots in either ordering', async () => {
  for (const first of ['migration', 'restoration'] as const) {
    const config = {schema: 'dharma.device-config/v1' as const, hqUrl: 'https://legacy-race.example',
      organizationId: 'org_legacy_race', deviceId: '44444444-4444-4444-8444-444444444444',
      deviceName: 'Synthetic', platform: 'linux' as const, publicKeyEd25519: 'A'.repeat(43),
      serverPublicKeyEd25519: 'B'.repeat(43), relayUrl: 'wss://relay.example',
      enrolledAt: '2026-10-01T00:00:00.000Z'};
    const slot = (parts: string[]) => 'device-enrollment-' + createHash('sha256').update(parts.join(':')).digest('hex').slice(0, 32);
    const current = slot([config.hqUrl, config.organizationId, config.deviceId]), legacy = slot([config.hqUrl, config.organizationId]);
    const serialized = JSON.stringify({schema: 'dharma.device-enrollment-anchor/v1', hqUrl: config.hqUrl,
      organizationId: config.organizationId, deviceId: config.deviceId, devicePublicKeyEd25519: config.publicKeyEd25519,
      serverPublicKeyEd25519: config.serverPublicKeyEd25519, enrolledAt: config.enrolledAt});
    const values = new Map([[legacy, serialized]]), writes: string[] = [];
    const store: SecureSecretStore = {backend: 'linux-secret-service',
      get: async account => values.get(account) ?? null, getFresh: async account => values.get(account) ?? null,
      put: async (account, value) => {await new Promise(resolvePromise => setTimeout(resolvePromise, 25)); writes.push(value); values.set(account, value);},
      delete: async () => {throw Error('unexpected delete');}};
    const migrate = () => loadDeviceEnrollmentAnchor({config, store});
    const restore = () => saveDeviceEnrollmentAnchor({config: {...config, publicKeyEd25519: 'C'.repeat(43)}, store, requireAbsent: true});
    const outcomes = await Promise.allSettled(first === 'migration' ? [migrate(), restore()] : [restore(), migrate()]);
    assert.equal(outcomes[first === 'migration' ? 0 : 1]!.status, 'fulfilled');
    assert.equal(outcomes[first === 'migration' ? 1 : 0]!.status, 'rejected');
    assert.equal(values.get(legacy), serialized);
    assert.equal(values.get(current), serialized);
    assert.deepEqual(writes, [serialized]);
    const snapshot = new Map(values);
    await loadDeviceEnrollmentAnchor({config, store, readOnly: true});
    assert.deepEqual(values, snapshot); assert.deepEqual(writes, [serialized]);
  }
});

test('consistency recovery and restoration preserve verified anchor bytes in either ordering', async () => {
  const now = new Date(), keys = keysetFixture(now);
  for (const first of ['recovery', 'restoration'] as const) {
    const root = await mkdtemp(resolve(tmpdir(), 'fabric-recovery-order-')), configPath = resolve(root, 'device.json');
    await saveKeysetConfig({configPath, publicKeyEd25519: keys.firstPublic, keyset: keys.initial, now});
    const config = JSON.parse(await readFile(configPath, 'utf8')), values = new Map<string, string>();
    let pause = false, entered!: () => void, resume!: () => void;
    const reached = new Promise<void>(resolvePromise => entered = resolvePromise);
    const released = new Promise<void>(resolvePromise => resume = resolvePromise);
    const writes: string[] = [];
    const store: SecureSecretStore = {backend: 'linux-secret-service',
      get: async account => values.get(account) ?? null, getFresh: async account => values.get(account) ?? null,
      put: async (account, value) => {if (pause) {pause = false; entered(); await released;} writes.push(value); values.set(account, value);},
      delete: async () => {throw Error('unexpected delete');}};
    await saveDeviceEnrollmentAnchor({config, store, now});
    await saveKeysetConfig({configPath, publicKeyEd25519: keys.firstPublic, keyset: keys.rotated, now});
    const before = [...values.values()][0]!;
    writes.length = 0;
    const restore = () => saveDeviceEnrollmentAnchor({config: {...config, publicKeyEd25519: 'C'.repeat(43)}, store, requireAbsent: true});
    if (first === 'restoration') {
      await assert.rejects(restore(), /connection_existing_anchor_requires_recovery/);
      assert.equal([...values.values()][0], before);
      await recoverDeviceEnrollmentConsistency({configPath, store, now});
    } else {
      pause = true;
      const recovery = recoverDeviceEnrollmentConsistency({configPath, store, now});
      await reached;
      const competing = assert.rejects(restore(), /connection_existing_anchor_requires_recovery/);
      resume(); await Promise.all([recovery, competing]);
    }
    assert.equal(writes.length, 1);
    const final = [...values.values()][0]!;
    assert.equal(final, writes[0]);
    assert.equal(JSON.parse(final).serverSigningKeyset.generation, 2);
  }
});

test('session open and workspace registration report the held keyset generation, expiry and relay autostart (C8)', async () => {
  const now = new Date();
  const fixture = keysetFixture(now);
  const store = memoryStore();
  const root = await mkdtemp(resolve(tmpdir(), 'fabric-c8-keyset-telemetry-'));
  const configPath = resolve(root, 'device.json');
  const identity = await loadOrCreateDeviceIdentity({ hqUrl: 'https://hq.example', organizationId: 'org_a', store });
  await saveKeysetConfig({ configPath, publicKeyEd25519: fixture.firstPublic,
    devicePublicKeyEd25519: identity.publicKeyEd25519, keyset: fixture.initial, now });
  await anchorConfig(configPath, store);
  const sent: Array<{ path: string; body: Record<string, unknown> }> = [];
  const client = await AgentFabricClient.open({ configPath, statePath: resolve(root, 'state.json'), store,
    fetcher: async (url, init) => {
      sent.push({ path: new URL(String(url)).pathname, body: JSON.parse(String(init?.body)) });
      return new Response(JSON.stringify({ ok: true }), { status: 201 });
    } });
  await client.openSession('0.2.999', { relayAutostartEnabled: true });
  await client.registerWorkspace({ workspaceId: 'workspace', name: 'Fixture' }, { relayAutostartEnabled: false });
  await client.openSession('0.2.999');
  const [session, workspace, unknownAutostart] = sent;
  assert.equal(session!.path, '/api/v1/orgs/org_a/agent-fabric/sessions');
  assert.equal(session!.body.relayVersion, '0.2.999');
  assert.equal(typeof session!.body.connectionId, 'string');
  assert.deepEqual(session!.body.deviceTelemetry, { schema: 'dharma.device-keyset-telemetry/v1',
    heldKeysetGeneration: 1, heldKeysetExpiresAt: fixture.initial.expiresAt, relayAutostartEnabled: true });
  assert.equal(workspace!.path, '/api/v1/orgs/org_a/agent-fabric/workspaces');
  assert.equal(workspace!.body.workspaceId, 'workspace');
  assert.equal(workspace!.body.name, 'Fixture');
  assert.deepEqual(workspace!.body.deviceTelemetry, { schema: 'dharma.device-keyset-telemetry/v1',
    heldKeysetGeneration: 1, heldKeysetExpiresAt: fixture.initial.expiresAt, relayAutostartEnabled: false });
  assert.deepEqual(unknownAutostart!.body.deviceTelemetry, { schema: 'dharma.device-keyset-telemetry/v1',
    heldKeysetGeneration: 1, heldKeysetExpiresAt: fixture.initial.expiresAt },
  'An unknown autostart state is omitted, never reported as false');
});

test('device keyset telemetry reports a keyset-less device as null and rejects malformed values (C8)', () => {
  const legacy = { serverSigningKeyset: undefined } as unknown as Parameters<typeof deviceKeysetTelemetry>[0];
  assert.deepEqual(deviceKeysetTelemetry(legacy), { schema: 'dharma.device-keyset-telemetry/v1',
    heldKeysetGeneration: null, heldKeysetExpiresAt: null });
  const held = (generation: unknown, expiresAt: unknown) => ({ serverSigningKeyset: { generation, expiresAt } }) as
    unknown as Parameters<typeof deviceKeysetTelemetry>[0];
  assert.deepEqual(deviceKeysetTelemetry(held(4, '2026-11-26T18:35:00.000Z'), { relayAutostartEnabled: false }),
    { schema: 'dharma.device-keyset-telemetry/v1', heldKeysetGeneration: 4,
      heldKeysetExpiresAt: '2026-11-26T18:35:00.000Z', relayAutostartEnabled: false });
  assert.equal(deviceKeysetTelemetry(held(4, '2026-11-26t18:35:00+00:00')).heldKeysetExpiresAt, '2026-11-26T18:35:00.000Z',
    'A contract-valid date-time is normalized, never a reason to fail session open');
  for (const [generation, expiresAt] of [[0, '2026-11-26T18:35:00.000Z'], [1.5, '2026-11-26T18:35:00.000Z'],
    ['4', '2026-11-26T18:35:00.000Z'], [4, 'tomorrow'], [4, null]]) {
    assert.throws(() => deviceKeysetTelemetry(held(generation, expiresAt)), /device_keyset_telemetry_invalid/);
  }
  assert.throws(() => deviceKeysetTelemetry(legacy, { relayAutostartEnabled: 'yes' as unknown as boolean }),
    /device_keyset_telemetry_invalid/);
});

// One relay process runs a durable client per workspace loop, and ad hoc commands open their own, all on the same
// protocol-state file. Each client keeps its own outbox entry in that file. Every read-modify-write of the file happens
// under device signing control and starts from the file, so one client's write never drops another client's kept
// request or recovered task completion, and no client sends, fails on or answers for another live client's request.
type SharedStateCall = { path: string; body: string; messageId: string; idempotencyKey: string | null; sessionId: string;
  sequence: number };
type SharedOutboxEntry = { sessionId: string | null; nextSequence: number; ownerPid: number; updatedAt: string;
  pending: { pathname: string; headers: Record<string, string> } | null; adoptedOutcome?: unknown };
type SharedProtocolState = { sessionId: string | null; nextSequence: number;
  pending: { headers: Record<string, string> } | null; recoveredTaskCompletions?: Array<{ taskId: string }>;
  outboxes?: Record<string, SharedOutboxEntry> };
type OpenInput = Parameters<typeof AgentFabricClient.open>[0];
/** A stable owner lane, such as the one a relay workspace loop passes, so a restarted client finds its own entry. */
const withOwner = (input: OpenInput, ownerKey: string) => ({ ...input, ownerKey }) as OpenInput;
const keptMessageIds = (state: SharedProtocolState) => Object.values(state.outboxes ?? {})
  .flatMap(entry => entry.pending ? [entry.pending.headers['x-dharma-message-id']!] : []);
/** The pid of a process that has exited, standing in for an ad hoc command that left a kept request behind. */
async function exitedPid(): Promise<number> {
  const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
  await new Promise(accept => child.once('exit', accept));
  return child.pid!;
}
const sharedOk = (body: Record<string, unknown> = {}) => new Response(JSON.stringify({ ok: true, ...body }), { status: 201 });
const sharedUnavailable = () => new Response(JSON.stringify({
  ok: false, error: { code: 'upstream_unavailable', message: 'Try again.' } }), { status: 503 });
const sharedGate = () => { let open!: () => void; const promise = new Promise<void>(accept => { open = accept; }); return { promise, open }; };
const sharedDelay = (ms: number) => new Promise(accept => setTimeout(accept, ms));

async function sharedStateFixture(prefix: string, respond: (call: SharedStateCall) => Response | Promise<Response>,
  store: SecureSecretStore = memoryStore()) {
  const root = await mkdtemp(resolve(tmpdir(), prefix));
  const identity = await loadOrCreateDeviceIdentity({ hqUrl: 'https://hq.example', organizationId: 'org_a', store });
  const configPath = resolve(root, 'device.json'), statePath = resolve(root, 'state.json');
  const config = {
    schema: 'dharma.device-config/v1' as const, hqUrl: 'https://hq.example', organizationId: 'org_a',
    deviceId: randomUUID(), deviceName: 'Test', platform: 'linux' as const,
    publicKeyEd25519: identity.publicKeyEd25519, serverPublicKeyEd25519: identity.publicKeyEd25519,
    relayUrl: 'wss://relay.example', enrolledAt: new Date().toISOString(),
  };
  await saveDeviceConfig(configPath, config);
  await anchorConfig(configPath, store);
  const calls: SharedStateCall[] = [];
  const inFlight = new Set<string>();
  let overlapping = 0;
  const fetcher = async (url: string | URL | Request, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    const call: SharedStateCall = {
      path: new URL(String(url)).pathname.replace('/api/v1/orgs/org_a', ''), body: String(init?.body ?? ''),
      messageId: headers.get('x-dharma-message-id')!, idempotencyKey: headers.get('idempotency-key'),
      sessionId: headers.get('x-dharma-session-id')!, sequence: Number(headers.get('x-dharma-sequence')),
    };
    calls.push(call);
    if (inFlight.has(call.messageId)) overlapping += 1;
    inFlight.add(call.messageId);
    try { return await respond(call); } finally { inFlight.delete(call.messageId); }
  };
  return {
    config, configPath, statePath, calls, overlapping: () => overlapping,
    open: (ownerKey?: string) => AgentFabricClient.open(ownerKey === undefined
      ? { configPath, statePath, store, fetcher } : withOwner({ configPath, statePath, store, fetcher }, ownerKey)),
    read: async () => JSON.parse(await readFile(statePath, 'utf8')) as SharedProtocolState,
  };
}

// The child holds the same device signing control from another process, through the real lock file.
function sharedChildHolder(config: { hqUrl: string; organizationId: string; deviceId: string }) {
  const module = new URL('./index.js', import.meta.url).href;
  const child = spawn(process.execPath, ['--input-type=module', '-e', `import {withDeviceSigningControl} from ${JSON.stringify(module)};
await withDeviceSigningControl({config:JSON.parse(process.argv[1])},async()=>{process.stdout.write('held;');
await new Promise(accept=>process.stdin.once('data',accept));});process.stdout.write('released;');`,
  JSON.stringify({ hqUrl: config.hqUrl, organizationId: config.organizationId, deviceId: config.deviceId })],
  { stdio: ['pipe', 'pipe', 'inherit'] });
  let output = ''; const waiters: Array<() => void> = [];
  child.stdout.on('data', chunk => { output += chunk; for (const wake of waiters.splice(0)) wake(); });
  const saw = async (text: string) => { while (!output.includes(text)) await new Promise<void>(wake => waiters.push(wake)); };
  const exited = new Promise<number | null>(accept => child.once('exit', code => accept(code)));
  return { child, saw, exited };
}

test('a task completion recorded by one client survives a later write by another client (shared protocol state)', async () => {
  const taskId = randomUUID(), trajectoryCapsuleHash = `sha256:${'a'.repeat(64)}`, receiptHash = `sha256:${'b'.repeat(64)}`;
  const f = await sharedStateFixture('fabric-shared-completion-', call =>
    sharedOk(call.path.endsWith('/events') ? { receipt: { hash: receiptHash } } : {}));
  const a = await f.open(), b = await f.open();
  await a.openSession();
  await b.openSession();
  await a.postTaskEvent(taskId, 'completed', { trajectoryCapsuleHash });
  await b.pollTask();
  assert.deepEqual((await f.read()).recoveredTaskCompletions?.map(item => item.taskId), [taskId],
    'a write by another client keeps the recorded completion');
  await b.acknowledgeRecoveredTaskCompletion(taskId, receiptHash);
  assert.deepEqual((await f.read()).recoveredTaskCompletions, [], 'any client on the device can acknowledge it');
});

test('opening a session never overwrites a request another client has in flight (shared protocol state)', async () => {
  const gate = sharedGate(), entered = sharedGate();
  let block = false;
  const f = await sharedStateFixture('fabric-shared-inflight-', async call => {
    if (block && call.path === '/agent-fabric/workspaces') { block = false; entered.open(); await gate.promise; }
    return sharedOk();
  });
  const a = await f.open(), b = await f.open();
  await a.openSession();
  block = true;
  const registering = a.registerWorkspace({ workspaceId: 'a' });
  await entered.promise;
  const inFlight = f.calls.at(-1)!.messageId;
  const opening = b.openSession();
  await sharedDelay(300);
  assert.deepEqual(keptMessageIds(await f.read()), [inFlight], 'the in-flight request stays in its owner\'s entry');
  assert.equal(f.calls.filter(call => call.path === '/agent-fabric/sessions').length, 1, 'the second session open waits');
  gate.open();
  await registering;
  await opening;
  assert.deepEqual(f.calls.map(call => call.path), ['/agent-fabric/sessions', '/agent-fabric/workspaces', '/agent-fabric/sessions']);
  assert.equal((await f.read()).pending, null);
  assert.deepEqual(keptMessageIds(await f.read()), []);
});

test('a request another client already delivered is never sent again from a stale snapshot (shared protocol state)', async () => {
  const delivered = new Set<string>(), gate = sharedGate(), entered = sharedGate();
  let mode: 'fail' | 'block' | 'ok' = 'ok';
  const f = await sharedStateFixture('fabric-shared-replay-', async call => {
    if (call.path === '/agent-fabric/workspaces' && mode === 'fail') { mode = 'ok'; return sharedUnavailable(); }
    if (call.path === '/agent-fabric/workspaces' && mode === 'block') { mode = 'ok'; entered.open(); await gate.promise; }
    if (delivered.has(call.messageId)) {
      return new Response(JSON.stringify({ ok: false, error: { code: 'message_replayed', message: 'Already accepted.' } }), { status: 409 });
    }
    delivered.add(call.messageId);
    return sharedOk();
  });
  const a = await f.open();
  await a.openSession();
  mode = 'fail';
  await assert.rejects(a.registerWorkspace({ workspaceId: 'a' }), error => error instanceof AgentFabricRequestError && error.status === 503);
  const [kept] = keptMessageIds(await f.read());
  assert.ok(kept);
  const b = await f.open();
  mode = 'block';
  const retry = a.registerWorkspace({ workspaceId: 'a' });
  await entered.promise;
  const opening = b.openSession();
  await sharedDelay(100);
  gate.open();
  await retry;
  await opening;
  assert.equal(f.calls.filter(call => call.messageId === kept).length, 2,
    'the kept request is sent by its first attempt and by its one retry, never again from a stale snapshot');
  assert.equal(f.overlapping(), 0, 'one message id is never in flight twice at once');
});

test('another live client never sends, fails on or sets aside a client\'s kept request (shared protocol state)', async () => {
  const f = await sharedStateFixture('fabric-shared-live-', call =>
    call.path === '/agent-fabric/workspaces' ? sharedUnavailable() : sharedOk({ observed: call }));
  const a = await f.open(), b = await f.open();
  await a.openSession();
  await b.openSession();
  await assert.rejects(a.registerWorkspace({ workspaceId: 'a' }), error => error instanceof AgentFabricRequestError && error.status === 503);
  const kept = f.calls.at(-1)!;
  for (let call = 0; call < 5; call++) {
    const polled = await b.pollTask();
    assert.deepEqual(polled.observed, f.calls.at(-1), 'every call of the other client gets the response to its own request');
  }
  const c = await f.open();
  await c.openSession();
  await c.pollTask();
  assert.equal(f.calls.filter(call => call.messageId === kept.messageId).length, 1, 'no other live client sends the kept request');
  assert.deepEqual(keptMessageIds(await f.read()), [kept.messageId], 'the kept request stays in its owner\'s entry');
  await assert.rejects(a.registerWorkspace({ workspaceId: 'a' }), error => error instanceof AgentFabricRequestError && error.status === 503);
  assert.deepEqual([f.calls.at(-1)!.messageId, f.calls.at(-1)!.idempotencyKey], [kept.messageId, kept.messageId],
    'its owner sends it again with the same message id and idempotency key');
});

test('a kept task completion survives any number of another client\'s calls during an outage and its owner replays it (shared protocol state)', async () => {
  const taskId = randomUUID(), trajectoryCapsuleHash = `sha256:${'a'.repeat(64)}`, receiptHash = `sha256:${'b'.repeat(64)}`;
  let outage = false;
  const f = await sharedStateFixture('fabric-shared-outage-', call => outage ? sharedUnavailable()
    : sharedOk(call.path.endsWith('/events') ? { receipt: { hash: receiptHash } } : {}));
  const a = await f.open(), b = await f.open();
  await a.openSession();
  await b.openSession();
  outage = true;
  await assert.rejects(a.postTaskEvent(taskId, 'completed', { trajectoryCapsuleHash }),
    error => error instanceof AgentFabricRequestError && error.status === 503);
  const kept = f.calls.at(-1)!;
  for (let call = 0; call < 6; call++) {
    await assert.rejects(b.pollTask(), error => error instanceof AgentFabricRequestError && error.status === 503,
      'the other client sees only the outcome of its own request');
    assert.notEqual(f.calls.at(-1)!.messageId, kept.messageId, 'the other client sends only its own request');
  }
  assert.ok(keptMessageIds(await f.read()).includes(kept.messageId), 'the completion is still kept');
  outage = false;
  await a.pollTask();
  const sent = f.calls.filter(call => call.messageId === kept.messageId);
  assert.equal(sent.length, 2, 'the completion is sent by its first attempt and by its owner\'s replay only');
  assert.deepEqual(sent.map(call => call.idempotencyKey), [kept.messageId, kept.messageId]);
  assert.deepEqual((await f.read()).recoveredTaskCompletions?.map(item => item.taskId), [taskId]);
  assert.equal(keptMessageIds(await f.read()).includes(kept.messageId), false, 'the replayed completion left the file');
});

test('a workspace loop that restarts replays its kept completion when it opens its session (shared protocol state)', async () => {
  const taskId = randomUUID(), trajectoryCapsuleHash = `sha256:${'a'.repeat(64)}`, receiptHash = `sha256:${'b'.repeat(64)}`;
  let eventsDown = false;
  const f = await sharedStateFixture('fabric-shared-restart-', call => {
    if (!call.path.endsWith('/events')) return sharedOk();
    return eventsDown ? sharedUnavailable() : sharedOk({ receipt: { hash: receiptHash } });
  });
  const a = await f.open('relay:workspace-a'), b = await f.open();
  await a.openSession();
  await b.openSession();
  eventsDown = true;
  await assert.rejects(a.postTaskEvent(taskId, 'completed', { trajectoryCapsuleHash }),
    error => error instanceof AgentFabricRequestError && error.status === 503);
  const kept = f.calls.at(-1)!;
  for (let call = 0; call < 4; call++) await b.pollTask();
  assert.equal(f.calls.filter(call => call.messageId === kept.messageId).length, 1, 'the other client never sends it');
  eventsDown = false;
  const restarted = await f.open('relay:workspace-a');
  await restarted.openSession();
  const sent = f.calls.filter(call => call.messageId === kept.messageId);
  assert.equal(sent.length, 2, 'the restarted loop sends its kept completion once more');
  assert.deepEqual([sent[1]!.idempotencyKey, sent[1]!.sessionId], [kept.messageId, kept.sessionId],
    'with the same idempotency key, in the session it was signed in');
  assert.equal(f.calls.at(-1)!.path, '/agent-fabric/sessions');
  assert.notEqual(f.calls.at(-1)!.sessionId, kept.sessionId, 'then it opens a new session');
  assert.deepEqual((await f.read()).recoveredTaskCompletions?.map(item => item.taskId), [taskId]);
  assert.deepEqual(keptMessageIds(await f.read()), []);
});

// The server accepts a session's sequences only in increasing order; gaps are allowed.
async function sharedMonotonicFixture(prefix: string) {
  const highest = new Map<string, number>();
  let unavailable = 0;
  const f = await sharedStateFixture(prefix, call => {
    if (unavailable > 0) { unavailable -= 1; return sharedUnavailable(); }
    if ((highest.get(call.sessionId) ?? 0) >= call.sequence) {
      return new Response(JSON.stringify({ ok: false, error: { code: 'sequence_out_of_order', message: 'Out of order.' } }), { status: 409 });
    }
    highest.set(call.sessionId, call.sequence);
    return sharedOk();
  });
  return { ...f, failNext: (count = 1) => { unavailable = count; } };
}

const sharedAcknowledgement = () => ({
  taskId: '11111111-1111-4111-8111-111111111111', endpointId: '22222222-2222-4222-8222-222222222222',
  actionDigest: `sha256:${'a'.repeat(64)}`, disposition: 'executed' as const,
  externalIdempotencyKeyHash: 'b'.repeat(64), resultDigest: `sha256:${'c'.repeat(64)}`,
  acknowledgedAt: new Date().toISOString(),
});

async function sharedLater<T>(minutes: number, work: () => Promise<T>): Promise<T> {
  const now = Date.now;
  Date.now = () => now() + minutes * 60_000;
  try { return await work(); } finally { Date.now = now; }
}

test('a stale action acknowledgement is re-signed only by its owner, in its own session (shared protocol state)', async () => {
  const f = await sharedMonotonicFixture('fabric-shared-resign-');
  const a = await f.open(), b = await f.open();
  await a.openSession();
  await b.openSession();
  const sessionB = f.calls[1]!.sessionId;
  f.failNext();
  await assert.rejects(b.postActionEnforcement('33333333-3333-4333-8333-333333333333', sharedAcknowledgement()),
    error => error instanceof AgentFabricRequestError && error.status === 503);
  const kept = f.calls.at(-1)!;
  await sharedLater(9, async () => { await a.pollTask(); await a.pollTask(); });
  assert.equal(f.calls.filter(call => call.sessionId === sessionB).length, 2, 'the other client never re-signs or sends it');
  await sharedLater(9, () => b.pollTask());
  const [resigned, next] = f.calls.slice(-2) as [SharedStateCall, SharedStateCall];
  assert.deepEqual([resigned.sessionId, resigned.path], [sessionB, kept.path], 'its owner re-signs it in its own session');
  assert.notEqual(resigned.messageId, kept.messageId);
  assert.ok(resigned.sequence > kept.sequence);
  assert.deepEqual([next.sessionId, next.path], [sessionB, '/agent-fabric/tasks/poll']);
  assert.ok(next.sequence > resigned.sequence, 'the owner signs its next request above the re-signed one');
});

const sharedIdleEntry = (ownerPid: number, minute = 0) => ({ sessionId: randomUUID(), nextSequence: 2, pending: null, ownerPid,
  updatedAt: new Date(Date.UTC(2026, 0, 1, 0, minute)).toISOString() });

test('a protocol-state file with an invalid outbox entry is refused and kept (shared protocol state)', async () => {
  const f = await sharedStateFixture('fabric-shared-outbox-invalid-', () => sharedOk());
  const idle = sharedIdleEntry(1);
  for (const outboxes of [[], { nobody: idle }, { 'cli:1:1': { ...idle, nextSequence: 0 } },
    { 'cli:1:1': { ...idle, ownerPid: -1 } }, { 'cli:1:1': { ...idle, updatedAt: 'later' } },
    { 'cli:1:1': { ...idle, pending: { method: 'PUT', pathname: '/x', body: '', headers: {} } } },
    { 'cli:1:1': { ...idle, adoptedAt: idle.updatedAt, adoptedOutcome: { messageId: 'm', status: 503, response: {} } } },
    Object.fromEntries(Array.from({ length: 257 }, (_, index) => [`cli:1:${index + 1}`, idle]))]) {
    const content = JSON.stringify({ schema: 'dharma.protocol-state/v1', sessionId: null, nextSequence: 1, pending: null, outboxes });
    await writeFile(f.statePath, content);
    await assert.rejects(f.open(), /protocol state is invalid/);
    assert.equal(await readFile(f.statePath, 'utf8'), content);
  }
  assert.equal(f.calls.length, 0);
});

for (const outcome of ['accepted', 'refused', 'retryable'] as const) {
  test(`an orphan left by a command that exited is adopted once and never answers the adopter: ${outcome} (shared protocol state)`, async () => {
    const taskId = randomUUID(), trajectoryCapsuleHash = `sha256:${'a'.repeat(64)}`, receiptHash = `sha256:${'b'.repeat(64)}`;
    let mode: 'down' | 'accepted' | 'refused' | 'retryable' = 'down';
    const f = await sharedStateFixture(`fabric-shared-orphan-${outcome}-`, call => {
      if (!call.path.endsWith('/events')) return sharedOk();
      if (mode === 'down' || mode === 'retryable') return sharedUnavailable();
      if (mode === 'refused') {
        return new Response(JSON.stringify({ ok: false, error: { code: 'lease_expired', message: 'Lease expired.' } }), { status: 409 });
      }
      return sharedOk({ receipt: { hash: receiptHash } });
    });
    const command = await f.open();
    await command.openSession();
    await assert.rejects(command.postTaskEvent(taskId, 'completed', { trajectoryCapsuleHash }),
      error => error instanceof AgentFabricRequestError && error.status === 503);
    const kept = f.calls.at(-1)!;
    // The command exits: its entry now names a process that is gone.
    const dead = await exitedPid();
    const state = await f.read();
    const [key, entry] = Object.entries(state.outboxes ?? {})
      .find(([, item]) => item.pending?.headers['x-dharma-message-id'] === kept.messageId) ?? [];
    assert.ok(key && entry, 'the command kept its request in its own entry');
    delete state.outboxes![key];
    state.outboxes![`cli:${dead}:1`] = { ...entry, ownerPid: dead };
    await writeFile(f.statePath, JSON.stringify(state));
    mode = outcome;
    const adopter = await f.open();
    assert.equal((await adopter.openSession()).ok, true, 'the adopter opens its session whatever the orphan\'s outcome');
    const later = await f.open();
    assert.equal((await later.openSession()).ok, true);
    let sent = f.calls.filter(call => call.messageId === kept.messageId);
    assert.equal(sent.length, 2, 'the orphan is sent once by the next session open, not again by the one after it');
    assert.deepEqual([sent[1]!.idempotencyKey, sent[1]!.sessionId], [kept.messageId, kept.sessionId]);
    if (outcome === 'retryable') {
      assert.deepEqual(keptMessageIds(await f.read()), [kept.messageId], 'an orphan without a definite answer is kept');
      mode = 'accepted';
      const next = await f.open();
      assert.equal((await sharedLater(11, () => next.openSession())).ok, true);
      sent = f.calls.filter(call => call.messageId === kept.messageId);
      assert.equal(sent.length, 3, 'a later session open sends it again');
      assert.equal(sent[2]!.idempotencyKey, kept.messageId);
    }
    assert.deepEqual(keptMessageIds(await f.read()), [], 'an answered orphan leaves the file');
    assert.deepEqual((await f.read()).recoveredTaskCompletions?.map(item => item.taskId),
      outcome === 'refused' ? [] : [taskId]);
  });
}

test('a kept request in an earlier single-slot file is sent once by the next session open and never answers it (shared protocol state)', async () => {
  const legacy = randomUUID(), legacySession = randomUUID();
  const f = await sharedStateFixture('fabric-shared-migrate-', call => call.messageId === legacy
    ? new Response(JSON.stringify({ ok: false, error: { code: 'sequence_out_of_order', message: 'Out of order.' } }), { status: 409 })
    : sharedOk());
  await writeFile(f.statePath, JSON.stringify({ schema: 'dharma.protocol-state/v1', sessionId: legacySession, nextSequence: 5,
    pending: { method: 'POST', pathname: '/api/v1/orgs/org_a/agent-fabric/tasks/poll', body: '{"leaseSeconds":120}', headers: {
      'content-type': 'application/json', 'idempotency-key': legacy, 'x-dharma-device-id': f.config.deviceId,
      'x-dharma-session-id': legacySession, 'x-dharma-message-id': legacy, 'x-dharma-timestamp': '2026-01-01T00:00:00.000Z',
      'x-dharma-nonce': 'legacy-nonce', 'x-dharma-sequence': '4', 'x-dharma-signature': 'legacy-signature' } } }));
  const a = await f.open();
  assert.equal((await a.openSession()).ok, true, 'a refusal of the migrated request never fails the session open');
  const b = await f.open();
  await b.openSession();
  const sent = f.calls.filter(call => call.messageId === legacy);
  assert.equal(sent.length, 1, 'the migrated request is sent exactly once');
  assert.deepEqual([sent[0]!.sessionId, sent[0]!.sequence, sent[0]!.idempotencyKey], [legacySession, 4, legacy]);
  const state = await f.read();
  assert.equal(state.pending, null);
  assert.deepEqual(keptMessageIds(state), []);
});

test('idle entries of exited owners are pruned and the other idle entries are capped (shared protocol state)', async () => {
  const f = await sharedStateFixture('fabric-shared-prune-', () => sharedOk());
  const dead = await exitedPid();
  const outboxes: Record<string, ReturnType<typeof sharedIdleEntry>> = {};
  for (let index = 1; index <= 3; index++) outboxes[`cli:${dead}:${index}`] = sharedIdleEntry(dead, index);
  for (let index = 1; index <= 40; index++) outboxes[`cli:${process.pid}:${1000 + index}`] = sharedIdleEntry(process.pid, 10 + index);
  await writeFile(f.statePath, JSON.stringify({ schema: 'dharma.protocol-state/v1', sessionId: null, nextSequence: 1, pending: null,
    outboxes }));
  const client = await f.open('relay:workspace-prune');
  await client.openSession();
  const keys = Object.keys((await f.read()).outboxes ?? {});
  assert.equal(keys.some(key => key.startsWith(`cli:${dead}:`)), false, 'idle entries of exited owners are pruned');
  assert.ok(keys.includes('relay:workspace-prune'), 'the client writes its own entry');
  assert.equal(keys.length, 33, 'at most 32 idle entries of other clients are kept');
  assert.ok(keys.includes(`cli:${process.pid}:1040`) && !keys.includes(`cli:${process.pid}:1001`), 'the oldest idle entries go first');
});

test('protocol state is not written while another process holds device signing control (shared protocol state)', async () => {
  const taskId = randomUUID(), receiptHash = `sha256:${'b'.repeat(64)}`;
  const f = await sharedStateFixture('fabric-shared-cross-process-', () => sharedOk());
  await writeFile(f.statePath, JSON.stringify({ schema: 'dharma.protocol-state/v1', sessionId: null, nextSequence: 1, pending: null,
    recoveredTaskCompletions: [{ taskId, trajectoryCapsuleHash: `sha256:${'a'.repeat(64)}`, receiptHash,
      recoveredAt: new Date().toISOString() }] }));
  const client = await f.open();
  const before = await readFile(f.statePath, 'utf8');
  const other = sharedChildHolder(f.config);
  try {
    await other.saw('held');
    const opening = client.openSession();
    const acknowledging = client.acknowledgeRecoveredTaskCompletion(taskId, receiptHash);
    await sharedDelay(500);
    assert.equal(await readFile(f.statePath, 'utf8'), before, 'nothing is written while the other process holds control');
    assert.equal(f.calls.length, 0);
    other.child.stdin!.end('go');
    await other.saw('released');
    await opening;
    await acknowledging;
    const after = await f.read();
    assert.deepEqual(after.recoveredTaskCompletions, []);
    assert.ok(Object.values(after.outboxes ?? {}).some(entry => entry.sessionId), 'the opened session is in the client\'s entry');
    assert.equal(await other.exited, 0);
  } finally { other.child.kill(); }
});

test('opening a session replays this client\'s own kept request inside its signing-control section (shared protocol state)', async () => {
  let unavailable = 0;
  const f = await sharedStateFixture('fabric-shared-reentrant-', () => {
    if (unavailable > 0) { unavailable -= 1; return sharedUnavailable(); }
    return sharedOk();
  });
  const client = await f.open();
  await client.openSession();
  unavailable = 1;
  await assert.rejects(client.registerWorkspace({ workspaceId: 'w' }), error => error instanceof AgentFabricRequestError && error.status === 503);
  const kept = f.calls.at(-1)!;
  await client.openSession();
  assert.deepEqual(f.calls.slice(-2).map(call => call.path), ['/agent-fabric/workspaces', '/agent-fabric/sessions']);
  assert.equal(f.calls.at(-2)!.messageId, kept.messageId);
  assert.equal((await f.read()).pending, null);
  assert.deepEqual(keptMessageIds(await f.read()), []);
});

test('a session open queued behind a holder leaves the line when its relay loop stops and writes nothing (shared protocol state)', async () => {
  const f = await sharedStateFixture('fabric-shared-stop-', () => sharedOk());
  const client = await f.open();
  const held = sharedGate(), released = sharedGate(), loop = new AbortController();
  const holder = withDeviceSigningControl({ config: f.config }, async () => { held.open(); await released.promise; });
  await held.promise;
  const stopped = withDeviceSigningLineSignal(loop.signal, () => client.openSession())
    .then(() => 'opened', (error: Error) => error.name);
  await sharedDelay(50);
  loop.abort();
  assert.equal(await stopped, 'AbortError');
  released.open();
  await holder;
  await assert.rejects(stat(f.statePath), { code: 'ENOENT' }, 'a stopped session open writes no protocol state');
  assert.equal(f.calls.length, 0);
});

test('the README says every protocol-state write takes device signing control (shared protocol state)', async () => {
  const readme = (await readFile(new URL('../README.md', import.meta.url), 'utf8')).replace(/\s+/g, ' ');
  assert.equal(/without taking signing control/.test(readme), false, 'no protocol-state write skips signing control');
  assert.equal(/protocol state [^.]*under the device signing control/i.test(readme), true,
    'the README says protocol-state writes take device signing control');
});

test('a protocol-state file corrupted after open is preserved and stops the next write (shared protocol state)', async () => {
  const f = await sharedStateFixture('fabric-shared-corrupt-', () => sharedOk());
  const client = await f.open();
  await client.openSession();
  await writeFile(f.statePath, '{"schema":"dharma.protocol-state/v1","nextSequence":0}');
  const corrupt = await readFile(f.statePath, 'utf8');
  const sent = f.calls.length;
  await assert.rejects(client.registerWorkspace({ workspaceId: 'w' }), /protocol state is invalid/);
  await assert.rejects(client.openSession(), /protocol state is invalid/);
  assert.equal(await readFile(f.statePath, 'utf8'), corrupt, 'the corrupt file is kept for recovery');
  assert.equal(f.calls.length, sent, 'nothing is signed or sent from a state the client cannot read');
});

test('an acknowledgement never waits on this client\'s queue behind a request that already holds signing control (shared protocol state)', async () => {
  const taskId = randomUUID(), receiptHash = `sha256:${'b'.repeat(64)}`;
  const f = await sharedStateFixture('fabric-shared-ack-line-', () => sharedOk());
  await writeFile(f.statePath, JSON.stringify({ schema: 'dharma.protocol-state/v1', sessionId: null, nextSequence: 1, pending: null,
    recoveredTaskCompletions: [{ taskId, trajectoryCapsuleHash: `sha256:${'a'.repeat(64)}`, receiptHash,
      recoveredAt: new Date().toISOString() }] }));
  const client = await f.open();
  await client.openSession();
  const held = sharedGate(), released = sharedGate();
  const sibling = withDeviceSigningControl({ config: f.config }, async () => { held.open(); await released.promise; });
  await held.promise;
  // An admitted request takes signing control first and then enters the client's queue, as the CLI does.
  const heartbeat = withDeviceSigningControl({ config: f.config }, () => client.pollTask()).then(() => 'heartbeat');
  await sharedDelay(50);
  const acknowledging = client.acknowledgeRecoveredTaskCompletion(taskId, receiptHash).then(() => 'acknowledged');
  await sharedDelay(50);
  released.open();
  await sibling;
  let timer: NodeJS.Timeout | undefined;
  const stalled = new Promise<string>(accept => { timer = setTimeout(() => accept('stalled'), 5_000); });
  try {
    assert.equal(await Promise.race([Promise.all([heartbeat, acknowledging]).then(done => done.join(',')), stalled]),
      'heartbeat,acknowledged', 'both settle once the sibling releases signing control');
  } finally { clearTimeout(timer); }
  assert.deepEqual((await f.read()).recoveredTaskCompletions, []);
});

test('the README limits the shared protocol-state guarantee to one client version on the device (shared protocol state)', async () => {
  const readme = (await readFile(new URL('../README.md', import.meta.url), 'utf8')).replace(/\s+/g, ' ');
  assert.equal(/clients on one device never overwrite each other's kept requests or completions\./.test(readme), false,
    'the guarantee is not stated without its version condition');
  assert.equal(/every process on the device runs this version/i.test(readme), true,
    'the README says the guarantee needs every process on the device to run this version');
  assert.equal(/upgrade stops the relay before/i.test(readme), true, 'the README says the relay upgrade stops the relay first');
});

test('the README describes one outbox entry per client and no draining of another client\'s request (shared protocol state)', async () => {
  const readme = (await readFile(new URL('../README.md', import.meta.url), 'utf8')).replace(/\s+/g, ' ');
  assert.equal(/relay_outbox_busy|one kept request for the whole device|set aside/i.test(readme), false,
    'no shared outbox slot, busy outbox or set-aside is described');
  assert.equal(/each client keeps its own outbox entry/i.test(readme), true);
  assert.equal(/owner process has exited/i.test(readme), true, 'the README says when another client sends a kept request');
});

// Orphaned kept requests: when another client sends them, how many at once, and what a full file still allows.
const sharedPending = (deviceId: string, route: string) => {
  const id = randomUUID();
  return { method: 'POST' as const, pathname: `/api/v1/orgs/org_a${route}`, body: '{"workspaceId":"orphan"}', headers: {
    'content-type': 'application/json', 'idempotency-key': id, 'x-dharma-device-id': deviceId,
    'x-dharma-session-id': randomUUID(), 'x-dharma-message-id': id, 'x-dharma-timestamp': new Date().toISOString(),
    'x-dharma-nonce': 'orphan-nonce', 'x-dharma-sequence': '1', 'x-dharma-signature': 'orphan-signature' } };
};
const sharedOrphan = (deviceId: string, ownerPid: number,
  input: { route?: string; minutesAgo?: number; adoptedMinutesAgo?: number } = {}) => ({
  sessionId: randomUUID(), nextSequence: 2, pending: sharedPending(deviceId, input.route ?? '/agent-fabric/workspaces'), ownerPid,
  updatedAt: new Date(Date.now() - (input.minutesAgo ?? 0) * 60_000).toISOString(),
  ...(input.adoptedMinutesAgo === undefined ? {} : { adoptedAt: new Date(Date.now() - input.adoptedMinutesAgo * 60_000).toISOString() }),
});
type SharedOrphan = ReturnType<typeof sharedOrphan>;
const orphanMessageId = (entry: SharedOrphan) => entry.pending.headers['x-dharma-message-id'];
const writeSharedOutboxes = (statePath: string, outboxes: Record<string, unknown>) => writeFile(statePath, JSON.stringify({
  schema: 'dharma.protocol-state/v1', sessionId: null, nextSequence: 1, pending: null, outboxes }));
const sentTimes = (calls: SharedStateCall[], messageId: string) => calls.filter(call => call.messageId === messageId).length;

test('a long-lived client sends a due orphan after its own request, without another session open (shared protocol state)', async () => {
  let down = true;
  const f = await sharedStateFixture('fabric-shared-orphan-poll-', call =>
    down && call.path === '/agent-fabric/workspaces' ? sharedUnavailable() : sharedOk());
  const orphan = sharedOrphan(f.config.deviceId, await exitedPid());
  await writeSharedOutboxes(f.statePath, { 'cli:1:orphan:1': orphan });
  const loop = await f.open('relay:workspace-loop');
  await loop.openSession();
  assert.equal(sentTimes(f.calls, orphanMessageId(orphan)), 1, 'the loop\'s session open sends it during the outage');
  down = false;
  for (let poll = 0; poll < 20; poll++) await loop.pollTask();
  assert.equal(sentTimes(f.calls, orphanMessageId(orphan)), 1, 'not again within 10 minutes');
  await sharedLater(11, () => loop.pollTask());
  assert.equal(sentTimes(f.calls, orphanMessageId(orphan)), 2, 'a later request of the same client sends it once more');
  assert.equal(f.calls.at(-2)!.path, '/agent-fabric/tasks/poll', 'after the client\'s own request');
  await sharedLater(22, () => loop.pollTask());
  assert.equal(sentTimes(f.calls, orphanMessageId(orphan)), 2);
  assert.deepEqual(keptMessageIds(await f.read()), []);
});

test('a kept request whose entry stood unchanged for 10 minutes is sent when its pid answers or its workspace loop is gone (shared protocol state)', async () => {
  const f = await sharedStateFixture('fabric-shared-orphan-stale-', () => sharedOk());
  const unrelated = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  try {
    const reused = sharedOrphan(f.config.deviceId, unrelated.pid!);
    const removed = sharedOrphan(f.config.deviceId, await exitedPid());
    await writeSharedOutboxes(f.statePath, { [`cli:${unrelated.pid}:earlier:1`]: reused, 'relay:removed-workspace': removed });
    const a = await f.open();
    await a.openSession();
    await a.pollTask();
    assert.deepEqual([sentTimes(f.calls, orphanMessageId(reused)), sentTimes(f.calls, orphanMessageId(removed))], [0, 0],
      'a fresh entry is left to its owner, and a workspace loop that restarts promptly replays its own');
    const b = await f.open();
    await sharedLater(11, () => b.openSession());
    assert.deepEqual([sentTimes(f.calls, orphanMessageId(reused)), sentTimes(f.calls, orphanMessageId(removed))], [1, 1]);
    assert.deepEqual(keptMessageIds(await f.read()), []);
  } finally { unrelated.kill(); }
});

test('a new client never takes over an entry an earlier process with the same pid left (shared protocol state)', async () => {
  const f = await sharedStateFixture('fabric-shared-pid-reuse-', call => call.path === '/agent-fabric/workspaces'
    ? new Response(JSON.stringify({ ok: false, error: { code: 'lease_expired', message: 'Refused.' } }), { status: 409 })
    : sharedOk());
  const probe = await f.open();
  await probe.openSession();
  const [probeKey] = Object.keys((await f.read()).outboxes ?? {});
  const counter = Number(probeKey!.split(':').at(-1));
  // The earlier command ran with this pid and numbered its clients from 1, as this process does.
  const earlier: Record<string, SharedOrphan> = {};
  for (let n = counter + 1; n <= counter + 20; n++) earlier[`cli:${process.pid}:${n}`] = sharedOrphan(f.config.deviceId, process.pid);
  await writeSharedOutboxes(f.statePath, earlier);
  for (let client = 0; client < 3; client++) {
    const next = await f.open();
    assert.equal((await next.openSession()).ok, true, 'another process\'s kept request never fails this session open');
  }
  assert.equal(f.calls.filter(call => call.path === '/agent-fabric/workspaces').length, 0, 'nor is it sent as this client\'s own');
  assert.equal(keptMessageIds(await f.read()).length, 20);
});

test('one session open sends at most four orphans, stops at the first without an answer and drops orphaned session opens (shared protocol state)', async () => {
  let down = true;
  const f = await sharedStateFixture('fabric-shared-orphan-batch-', call =>
    down && call.path === '/agent-fabric/workspaces' ? sharedUnavailable() : sharedOk());
  const dead = await exitedPid();
  const kept = Array.from({ length: 10 }, () => sharedOrphan(f.config.deviceId, dead));
  const sessionOpens = Array.from({ length: 3 }, () => sharedOrphan(f.config.deviceId, dead, { route: '/agent-fabric/sessions' }));
  await writeSharedOutboxes(f.statePath,
    Object.fromEntries([...sessionOpens, ...kept].map((entry, index) => [`cli:${dead}:x:${index}`, entry])));
  const orphanSends = () => f.calls.filter(call =>
    [...kept, ...sessionOpens].some(entry => orphanMessageId(entry) === call.messageId)).length;
  const a = await f.open();
  await a.openSession();
  assert.equal(orphanSends(), 1, 'the first orphan without a definite answer ends the batch');
  assert.equal(sessionOpens.some(entry => sentTimes(f.calls, orphanMessageId(entry)) > 0), false,
    'an exited command\'s session open is never sent');
  assert.deepEqual(keptMessageIds(await f.read()).sort(), kept.map(orphanMessageId).sort(),
    'the session opens left the file and the other orphans stay');
  down = false;
  const b = await f.open();
  await sharedLater(11, () => b.openSession());
  assert.equal(orphanSends(), 5, 'at most four orphans per batch');
  await sharedLater(11, () => b.pollTask());
  assert.equal(orphanSends(), 9, 'the client\'s next request sends the next batch while due orphans remain');
  await sharedLater(11, () => b.pollTask());
  await sharedLater(11, () => b.pollTask());
  assert.equal(orphanSends(), 11, 'each orphan is answered once');
  assert.deepEqual(kept.map(entry => sentTimes(f.calls, orphanMessageId(entry))).sort(), [1, 1, 1, 1, 1, 1, 1, 1, 1, 2]);
  assert.deepEqual(keptMessageIds(await f.read()), []);
});

test('a file full of kept orphans refuses only a new kept request and drains once they are due (shared protocol state)', async () => {
  let down = false;
  const orphanIds = new Set<string>();
  const f = await sharedStateFixture('fabric-shared-outbox-full-', call =>
    down && call.path === '/agent-fabric/workspaces' && !orphanIds.has(call.messageId) ? sharedUnavailable() : sharedOk());
  const dead = await exitedPid();
  const orphans = Array.from({ length: 256 }, () => sharedOrphan(f.config.deviceId, dead, { minutesAgo: 30, adoptedMinutesAgo: 1 }));
  for (const entry of orphans) orphanIds.add(orphanMessageId(entry));
  await writeSharedOutboxes(f.statePath, Object.fromEntries(orphans.map((entry, index) => [`cli:${dead}:x:${index}`, entry])));
  for (let client = 0; client < 3; client++) {
    assert.equal((await (await f.open()).openSession()).ok, true, 'a client without a kept request opens its session in a full file');
  }
  assert.equal(f.calls.filter(call => orphanIds.has(call.messageId)).length, 0, 'no orphan is due yet');
  const c = await f.open();
  await c.openSession();
  down = true;
  await assert.rejects(c.registerWorkspace({ workspaceId: 'w' }), /relay_protocol_state_outbox_full/);
  await assert.rejects(c.pollTask(), /relay_protocol_state_outbox_full/, 'while no orphan is due there is no room for any request');
  assert.equal(f.calls.filter(call => !orphanIds.has(call.messageId) && call.path !== '/agent-fabric/sessions').length, 0,
    'a refused request is not sent');
  down = false;
  await sharedLater(11, () => c.pollTask());
  assert.equal(f.calls.filter(call => orphanIds.has(call.messageId)).length, 8,
    'once orphans are due, a batch is sent to make room before the request and another after it');
  assert.equal(f.calls.filter(call => !orphanIds.has(call.messageId) && call.path === '/agent-fabric/workspaces').length, 0,
    'the refused request is not kept for a later replay');
  const d = await f.open();
  await sharedLater(11, () => d.openSession());
  for (let poll = 0; poll < 70 && keptMessageIds(await f.read()).length > 0; poll++) await sharedLater(11, () => d.pollTask());
  assert.deepEqual(keptMessageIds(await f.read()), []);
  assert.deepEqual(orphans.filter(entry => sentTimes(f.calls, orphanMessageId(entry)) !== 1), [], 'each orphan is sent once');
});

test('a live owner whose kept request another client sent after 10 minutes never sends it again (shared protocol state)', async () => {
  let down = false;
  const f = await sharedStateFixture('fabric-shared-orphan-live-owner-', call =>
    down && call.path === '/agent-fabric/workspaces' ? sharedUnavailable() : sharedOk());
  const a = await f.open(), b = await f.open();
  await a.openSession();
  await b.openSession();
  down = true;
  await assert.rejects(a.registerWorkspace({ workspaceId: 'a' }), error => error instanceof AgentFabricRequestError && error.status === 503);
  const kept = f.calls.at(-1)!;
  down = false;
  await sharedLater(11, () => b.pollTask());
  assert.equal(sentTimes(f.calls, kept.messageId), 2, 'another client sends a request whose entry stood unchanged for 10 minutes');
  await a.pollTask();
  assert.equal(sentTimes(f.calls, kept.messageId), 2, 'its owner learns the outcome from the file and does not send it again');
  const last = f.calls.at(-1)!;
  assert.deepEqual([last.path, last.sessionId], ['/agent-fabric/tasks/poll', kept.sessionId]);
  assert.ok(last.sequence > kept.sequence);
  assert.deepEqual(keptMessageIds(await f.read()), []);
});

for (const outcome of ['accepted', 'refused'] as const) {
  test(`a live owner's retry of a call another client sent gets that answer and is not sent again: ${outcome} (shared protocol state)`, async () => {
    let mode: 'ok' | 'down' | 'answer' = 'ok';
    const f = await sharedStateFixture(`fabric-shared-orphan-live-retry-${outcome}-`, call => {
      if (call.path !== '/agent-fabric/workspaces' || mode === 'ok') return sharedOk();
      if (mode === 'down') return sharedUnavailable();
      return outcome === 'accepted' ? sharedOk({ workspace: { id: 'registered' } })
        : new Response(JSON.stringify({ ok: false, error: { code: 'workspace_conflict', message: 'Refused.' } }), { status: 409 });
    });
    const a = await f.open(), b = await f.open();
    await a.openSession();
    await b.openSession();
    mode = 'down';
    await assert.rejects(a.registerWorkspace({ workspaceId: 'a' }), error => error instanceof AgentFabricRequestError && error.status === 503);
    const kept = f.calls.at(-1)!;
    mode = 'answer';
    await sharedLater(11, () => b.pollTask());
    assert.equal(sentTimes(f.calls, kept.messageId), 2, 'another client sends a request whose entry stood unchanged for 10 minutes');
    const retry = a.registerWorkspace({ workspaceId: 'a' });
    if (outcome === 'accepted') {
      assert.deepEqual(await retry, { ok: true, workspace: { id: 'registered' } }, 'the retry returns the answer the other client got');
    } else {
      await assert.rejects(retry, error => error instanceof AgentFabricRequestError && error.status === 409 && error.definitive
        && error.serverCode === 'workspace_conflict', 'the retry raises the refusal the other client got');
    }
    assert.equal(f.calls.filter(call => call.path === '/agent-fabric/workspaces').length, 2, 'the call is not signed or sent again');
    mode = 'ok';
    await a.registerWorkspace({ workspaceId: 'a' });
    const next = f.calls.at(-1)!;
    assert.notEqual(next.messageId, kept.messageId, 'a later call is a new request');
    assert.deepEqual([next.sessionId, next.sequence > kept.sequence], [kept.sessionId, true]);
  });
}

test('an owner that read its entry before another client answered it finds the answer after its process id is gone (shared protocol state)', async () => {
  let down = false;
  const f = await sharedStateFixture('fabric-shared-orphan-restart-', call =>
    down && call.path === '/agent-fabric/workspaces' ? sharedUnavailable() : sharedOk());
  const earlier = await f.open('relay:w2');
  await earlier.openSession();
  down = true;
  await assert.rejects(earlier.registerWorkspace({ workspaceId: 'w2' }), error => error instanceof AgentFabricRequestError && error.status === 503);
  const kept = f.calls.at(-1)!;
  down = false;
  const state = await f.read();
  state.outboxes!['relay:w2']!.ownerPid = await exitedPid();
  state.outboxes!['relay:w2']!.updatedAt = new Date(Date.now() - 11 * 60_000).toISOString();
  await writeFile(f.statePath, JSON.stringify(state));
  // A restarted relay opens both workspace loops' clients, then their sessions in line order.
  const w2 = await f.open('relay:w2'), w1 = await f.open('relay:w1');
  await w1.openSession();
  assert.equal(sentTimes(f.calls, kept.messageId), 2, 'the other loop sends the request that stood unchanged');
  assert.ok('relay:w2' in ((await f.read()).outboxes ?? {}), 'the answered entry stays in the file for its owner');
  await w2.openSession();
  assert.equal(sentTimes(f.calls, kept.messageId), 2, 'its owner takes the answer from the file and does not send it again');
  assert.deepEqual(keptMessageIds(await f.read()), []);
});

for (const [label, answer] of [['null', 'null'], ['an array', '[]'], ['a string', '"ok"']] as const) {
  test(`an orphan answered with ${label} instead of an object leaves a file every client still opens (shared protocol state)`, async () => {
    let mode: 'ok' | 'down' | 'bare' = 'ok';
    const f = await sharedStateFixture('fabric-shared-orphan-bare-', call => {
      if (call.path !== '/agent-fabric/workspaces' || mode === 'ok') return sharedOk();
      return mode === 'down' ? sharedUnavailable() : new Response(answer, { status: 200 });
    });
    const earlier = await f.open('relay:w2');
    await earlier.openSession();
    mode = 'down';
    await assert.rejects(earlier.registerWorkspace({ workspaceId: 'w2' }), error => error instanceof AgentFabricRequestError && error.status === 503);
    const kept = f.calls.at(-1)!;
    const state = await f.read();
    state.outboxes!['relay:w2']!.ownerPid = await exitedPid();
    state.outboxes!['relay:w2']!.updatedAt = new Date(Date.now() - 11 * 60_000).toISOString();
    await writeFile(f.statePath, JSON.stringify(state));
    mode = 'bare';
    const w2 = await f.open('relay:w2'), w1 = await f.open('relay:w1');
    assert.equal((await w1.openSession()).ok, true, 'the adopter opens its own session after it sends the orphan');
    assert.equal(sentTimes(f.calls, kept.messageId), 2);
    assert.equal((await f.read()).outboxes!['relay:w2']!.adoptedOutcome, undefined, 'an answer that is not an object is not kept');
    const later = await f.open();
    assert.equal((await later.openSession()).ok, true, 'a later client still opens the file');
    await w2.openSession();
    mode = 'ok';
    await w2.registerWorkspace({ workspaceId: 'w2' });
    const retry = f.calls.at(-1)!;
    assert.deepEqual([retry.path, retry.messageId === kept.messageId], ['/agent-fabric/workspaces', false],
      'without a kept answer its owner signs the call again');
    assert.equal(sentTimes(f.calls, kept.messageId), 2);
  });
}

function jsonFileStore(path: string): SecureSecretStore {
  const load = async () => JSON.parse(await readFile(path, 'utf8').catch(() => '{}')) as Record<string, string>;
  return {
    backend: 'linux-secret-service',
    async get(account) { return (await load())[account] ?? null; },
    async put(account, value) { const values = await load(); values[account] = value; await writeFile(path, JSON.stringify(values)); },
    async delete(account) { const values = await load(); delete values[account]; await writeFile(path, JSON.stringify(values)); },
  };
}

test('a client that stops while it sends an orphan leaves the attempt in the file, so the next client waits 10 minutes (shared protocol state)', async () => {
  const storePath = resolve(await mkdtemp(resolve(tmpdir(), 'fabric-shared-orphan-cut-store-')), 'store.json');
  const f = await sharedStateFixture('fabric-shared-orphan-cut-', () => sharedOk(), jsonFileStore(storePath));
  const orphan = sharedOrphan(f.config.deviceId, await exitedPid());
  await writeSharedOutboxes(f.statePath, { 'cli:1:orphan:1': orphan });
  // A short command, such as a prompt hook, sends the orphan from its session open and is stopped during that send.
  const module = new URL('./index.js', import.meta.url).href;
  const child = spawn(process.execPath, ['--input-type=module', '-e', `import {AgentFabricClient} from ${JSON.stringify(module)};
import {readFile,writeFile} from 'node:fs/promises';
const [configPath,statePath,storePath,orphanId]=process.argv.slice(1);
const load=async()=>JSON.parse(await readFile(storePath,'utf8').catch(()=>'{}'));
const store={backend:'linux-secret-service',get:async a=>(await load())[a]??null,
put:async(a,v)=>{const s=await load();s[a]=v;await writeFile(storePath,JSON.stringify(s));},
delete:async a=>{const s=await load();delete s[a];await writeFile(storePath,JSON.stringify(s));}};
const fetcher=async(url,init)=>{if(new Headers(init?.headers).get('x-dharma-message-id')===orphanId){
process.stdout.write('sending;');setInterval(()=>{},1000);await new Promise(()=>{});}
return new Response(JSON.stringify({ok:true}),{status:201});};
const client=await AgentFabricClient.open({configPath,statePath,store,fetcher});
await client.openSession();process.stdout.write('done;');`,
  f.configPath, f.statePath, storePath, orphanMessageId(orphan)], { stdio: ['ignore', 'pipe', 'inherit'] });
  const exited = new Promise(accept => child.once('exit', accept));
  let output = '';
  const sending = new Promise<void>(accept => child.stdout!.on('data', data => {
    output += String(data);
    if (output.includes('sending;')) accept();
  }));
  assert.equal(await Promise.race([sending.then(() => 'sending'), exited.then(() => 'exited')]), 'sending', output);
  child.kill('SIGKILL');
  await exited;
  const a = await f.open();
  await a.openSession();
  assert.equal(sentTimes(f.calls, orphanMessageId(orphan)), 0, 'the next client does not send it within 10 minutes');
  const b = await f.open();
  await sharedLater(11, () => b.openSession());
  assert.equal(sentTimes(f.calls, orphanMessageId(orphan)), 1, 'it is sent again once 10 minutes have passed');
  assert.deepEqual(keptMessageIds(await f.read()), []);
});

// Convergence review round 1: orphans are sent after the caller has its answer, answers leave the file, and an
// earlier version still finds one kept request.
const isOrphanCall = (orphans: SharedOrphan[], call: SharedStateCall) => orphans.some(entry => orphanMessageId(entry) === call.messageId);

test('a long-lived client returns its own answer before it sends a due orphan, and sends one per section (shared protocol state)', async () => {
  const gate = sharedGate(), entered = sharedGate();
  const slow = new Set<string>();
  const f = await sharedStateFixture('fabric-shared-orphan-after-', async call => {
    if (slow.delete(call.messageId)) { entered.open(); await gate.promise; }
    return sharedOk();
  });
  const dead = await exitedPid();
  const orphans = [sharedOrphan(f.config.deviceId, dead), sharedOrphan(f.config.deviceId, dead)];
  for (const entry of orphans) slow.add(orphanMessageId(entry));
  // Entries of workspace loops that are gone become due only after 10 minutes, so the session open leaves them.
  await writeSharedOutboxes(f.statePath, { 'relay:gone-a': orphans[0], 'relay:gone-b': orphans[1] });
  const loop = await f.open('relay:workspace-loop');
  await loop.openSession();
  assert.equal(f.calls.filter(call => isOrphanCall(orphans, call)).length, 0);
  const now = Date.now;
  Date.now = () => now() + 11 * 60_000;
  try {
    const first = await Promise.race([loop.pollTask().then(() => 'answered'), sharedDelay(2_000).then(() => 'held')]);
    assert.equal(first, 'answered', 'the poll returns its own answer while the orphan send is still open');
    await entered.promise;
    const next = loop.pollTask();
    await sharedDelay(100);
    assert.equal(f.calls.filter(call => call.path === '/agent-fabric/tasks/poll').length, 1, 'the next request waits for that one send');
    gate.open();
    await next;
    assert.deepEqual(f.calls.slice(0, 4).map(call => isOrphanCall(orphans, call) ? 'orphan' : call.path),
      ['/agent-fabric/sessions', '/agent-fabric/tasks/poll', 'orphan', '/agent-fabric/tasks/poll'],
      'one orphan per section, after the request has its answer');
    await loop.pollTask();
  } finally { Date.now = now; gate.open(); }
  assert.deepEqual(orphans.map(entry => sentTimes(f.calls, orphanMessageId(entry))), [1, 1]);
  assert.deepEqual(keptMessageIds(await f.read()), []);
});

test('no client of a process sends orphans after its requests while a task lease is held there (shared protocol state)', async () => {
  const taskId = randomUUID();
  let leased = true;
  const f = await sharedStateFixture('fabric-shared-orphan-lease-', call => call.path === '/agent-fabric/tasks/poll' && leased
    ? sharedOk({ task: { envelope: { taskId } } }) : sharedOk());
  const orphan = sharedOrphan(f.config.deviceId, await exitedPid());
  await writeSharedOutboxes(f.statePath, { 'relay:gone': orphan });
  const a = await f.open('relay:workspace-a'), b = await f.open('relay:workspace-b');
  await a.openSession();
  await b.openSession();
  await sharedLater(11, async () => {
    await a.pollTask();
    leased = false;
    await b.pollTask();
    await a.postTaskEvent(taskId, 'started', {});
    await a.postTaskEvent(taskId, 'lease_extended', { taskId });
    await b.pollTask();
    await b.pollTask();
    assert.equal(sentTimes(f.calls, orphanMessageId(orphan)), 0, 'no orphan is sent while the task lease is held');
    await a.postTaskEvent(taskId, 'completed', {});
    await b.pollTask();
  });
  assert.equal(sentTimes(f.calls, orphanMessageId(orphan)), 1, 'once the task ends, it is sent after the next request');
  assert.deepEqual(keptMessageIds(await f.read()), []);
});

test('an adopted answer stays in the file only for an owner that can read it, and for at most 10 minutes (shared protocol state)', async () => {
  let down = false;
  const f = await sharedStateFixture('fabric-shared-orphan-canary-', call => {
    if (down && call.path === '/agent-fabric/workspaces') return sharedUnavailable();
    return sharedOk({ private: `private-${call.path.split('/').at(-1)}-canary` });
  });
  const dead = await exitedPid();
  const poll = sharedOrphan(f.config.deviceId, dead, { route: '/agent-fabric/tasks/poll' });
  const exited = sharedOrphan(f.config.deviceId, dead);
  await writeSharedOutboxes(f.statePath, { 'cli:1:exited:1': poll, 'cli:1:exited:2': exited });
  const a = await f.open(), b = await f.open();
  await a.openSession();
  assert.equal(sentTimes(f.calls, orphanMessageId(poll)), 0, 'an orphaned poll is removed without sending, like a session open');
  assert.equal(sentTimes(f.calls, orphanMessageId(exited)), 1);
  assert.doesNotMatch(await readFile(f.statePath, 'utf8'), /canary/, 'no answer is kept for an owner that has exited');
  await b.openSession();
  down = true;
  await assert.rejects(a.registerWorkspace({ workspaceId: 'a' }), error => error instanceof AgentFabricRequestError && error.status === 503);
  const kept = f.calls.at(-1)!;
  down = false;
  await sharedLater(11, async () => { await b.pollTask(); await b.pollTask(); });
  assert.equal(sentTimes(f.calls, kept.messageId), 2);
  assert.match(await readFile(f.statePath, 'utf8'), /private-workspaces-canary/, 'the answer stays for its live owner');
  const c = await f.open();
  await sharedLater(22, () => c.openSession());
  assert.doesNotMatch(await readFile(f.statePath, 'utf8'), /canary/,
    'and leaves the file once 10 minutes have passed, while the owner still runs');
  assert.deepEqual(keptMessageIds(await f.read()), []);
});

test('a kept request stays where a session open of the earlier version replays it, and this version sends it once (shared protocol state)', async () => {
  let down = false;
  const f = await sharedStateFixture('fabric-shared-rollback-', call =>
    down && call.path === '/agent-fabric/workspaces' ? sharedUnavailable() : sharedOk());
  const a = await f.open('relay:w1');
  await a.openSession();
  down = true;
  await assert.rejects(a.registerWorkspace({ workspaceId: 'w1' }), error => error instanceof AgentFabricRequestError && error.status === 503);
  const kept = f.calls.at(-1)!;
  down = false;
  const state = await f.read();
  const entry = state.outboxes!['relay:w1']!;
  assert.deepEqual([state.sessionId, state.nextSequence, state.pending], [entry.sessionId, entry.nextSequence, entry.pending],
    'the earlier version finds the kept request at the top level, exactly as signed');
  assert.equal(state.pending?.headers['x-dharma-message-id'], kept.messageId);
  const b = await f.open();
  await b.openSession();
  assert.equal(sentTimes(f.calls, kept.messageId), 1, 'this version never takes that copy for an orphan of its own');
  const c = await f.open();
  await sharedLater(11, () => c.openSession());
  assert.equal(sentTimes(f.calls, kept.messageId), 2, 'it is sent once when its entry is due');
  const after = await f.read();
  assert.deepEqual([after.pending, keptMessageIds(after)], [null, []]);
});

test('the README says what a rollback to an earlier version keeps (shared protocol state)', async () => {
  const readme = (await readFile(new URL('../README.md', import.meta.url), 'utf8')).replace(/\s+/g, ' ');
  assert.equal(/rollback to an earlier version/i.test(readme), true, 'the README describes a rollback');
  assert.equal(/oldest kept request/i.test(readme), true, 'the README names the one kept request an earlier version replays');
});
