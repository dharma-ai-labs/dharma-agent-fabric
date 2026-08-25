import assert from 'node:assert/strict';
import { createHash, createPublicKey, generateKeyPairSync, verify, type JsonWebKey } from 'node:crypto';
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
  isDefinitiveAgentFabricRejection,
  installTrustedServerSigningKeyset,
  loadDeviceEnrollmentAnchor,
  recoverDeviceEnrollmentConsistency,
  normalizeHqUrl,
  normalizeRelayUrl,
  redeemBootstrapGrant,
  saveDeviceConfig,
  saveActiveSkillAuthorizationAnchor,
  saveDeviceEnrollmentAnchor,
  loadOrganizationApiToken,
  saveOrganizationApiToken,
} from './index.js';
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

async function anchorConfig(configPath: string, store: SecureSecretStore) {
  const config = JSON.parse(await readFile(configPath, 'utf8'));
  await saveDeviceEnrollmentAnchor({ config, store });
}

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

test('bootstrap redemption is credential-free on the URL and returns device plus organization authority', async () => {
  const requests: Request[] = [];
  const result = await redeemBootstrapGrant({
    hqUrl: 'https://www.dharma-ai.io',
    organizationId: 'org_a',
    bootstrapToken: `dhab_${'a'.repeat(43)}`,
    name: 'Test device',
    platform: 'wsl',
    publicKeyEd25519: 'device-public-key',
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
  await saveDeviceEnrollmentAnchor({ config: { ...anchorAheadConfig, serverSigningKeyset: fixture.rotated }, store: anchorAheadStore });
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
  const client = await AgentFabricClient.open({ configPath, statePath, store, fetcher });
  await client.openSession();
  failAfterAccept = true;
  await assert.rejects(client.registerWorkspace({ workspaceId: 'workspace' }), /socket closed/);
  const state = JSON.parse(await readFile(statePath, 'utf8'));
  state.pending.headers['x-dharma-timestamp'] = '2026-01-01T00:00:00.000Z';
  await writeFile(statePath, JSON.stringify(state));
  const resumed = await AgentFabricClient.open({ configPath, statePath, store, fetcher });
  await resumed.registerWorkspace({ workspaceId: 'ignored-until-pending-is-acked' });
  assert.equal(messageIds.at(-2), messageIds.at(-1));
  assert.equal(idempotencyKeys.at(-2), messageIds.at(-2));
  assert.equal(idempotencyKeys.at(-1), messageIds.at(-1));
  assert.notEqual(timestamps.at(-2), timestamps.at(-1));
});

test('content-bearing trajectory outbox is discarded before a new session can replay it', async () => {
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
    if (failTrajectory && pathname.endsWith('/agent-fabric/trajectories')) {
      failTrajectory = false;
      throw new Error('unknown trajectory delivery outcome');
    }
    return new Response(JSON.stringify({ ok: true }), { status: 201 });
  };
  const client = await AgentFabricClient.open({ configPath, statePath, store, fetcher });
  await client.openSession();
  await assert.rejects(client.syncTrajectory({ secret: 'authorized-at-the-time' }), /unknown trajectory delivery/);
  const durableState = JSON.parse(await readFile(statePath, 'utf8'));
  assert.equal(durableState.pending, null);
  assert.doesNotMatch(await readFile(statePath, 'utf8'), /authorized-at-the-time/);
  const resumed = await AgentFabricClient.open({ configPath, statePath, store, fetcher });
  await resumed.openSession();
  assert.equal(paths.filter((path) => path.endsWith('/agent-fabric/trajectories')).length, 1);
  assert.equal(JSON.parse(await readFile(statePath, 'utf8')).pending, null);
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
  const client = await AgentFabricClient.open({ configPath, statePath, store, fetcher });
  await client.openSession();
  await assert.rejects(client.postTaskEvent(taskId, 'completed', { trajectoryCapsuleHash }), /connection lost/);
  assert.deepEqual(client.listRecoveredTaskCompletions(), []);

  const resumed = await AgentFabricClient.open({ configPath, statePath, store, fetcher });
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
  const client = await AgentFabricClient.open({ configPath, statePath, store, fetcher });
  await client.openSession();
  await assert.rejects(
    client.postTaskEvent(taskId, 'completed', { trajectoryCapsuleHash }),
    /missing a valid durable receipt/,
  );
  const pending = JSON.parse(await readFile(statePath, 'utf8'));
  assert.match(pending.pending.pathname, new RegExp(`${taskId}/events$`));
  validReceipt = true;
  const resumed = await AgentFabricClient.open({ configPath, statePath, store, fetcher });
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
  const client = await AgentFabricClient.open({ configPath, statePath, store, fetcher });
  await client.openSession();
  await assert.rejects(
    client.postEvidenceResponse('request-1', { contentBase64: 'customer-content' }),
    /unknown evidence-response delivery/,
  );
  const persisted = await readFile(statePath, 'utf8');
  assert.doesNotMatch(persisted, /customer-content/);
  assert.equal(JSON.parse(persisted).nextSequence, 3);
  const resumed = await AgentFabricClient.open({ configPath, statePath, store, fetcher });
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
  const client = await AgentFabricClient.open({ configPath, statePath, store, fetcher });
  await client.openSession();
  rejectNext = true;
  await assert.rejects(client.registerWorkspace({ workspaceId: 'oversized' }), (error) => {
    assert.ok(error instanceof AgentFabricRequestError);
    assert.equal(error.status, 413);
    assert.equal(isDefinitiveAgentFabricRejection(error), true);
    return true;
  });
  const state = JSON.parse(await readFile(statePath, 'utf8'));
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
  const client = await AgentFabricClient.open({ configPath, statePath, store, fetcher });
  await client.openSession();
  retryable = true;
  await assert.rejects(client.registerWorkspace({ workspaceId: 'retryable' }), (error) => {
    assert.ok(error instanceof AgentFabricRequestError);
    assert.equal(error.status, 503);
    assert.equal(isDefinitiveAgentFabricRejection(error), false);
    return true;
  });
  assert.notEqual(JSON.parse(await readFile(statePath, 'utf8')).pending, null);
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
