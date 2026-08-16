import assert from 'node:assert/strict';
import { createHash, createPublicKey, generateKeyPairSync, verify } from 'node:crypto';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { test } from 'node:test';
import {
  AgentFabricClient,
  beginEnrollment,
  loadOrCreateDeviceIdentity,
  normalizeHqUrl,
  normalizeRelayUrl,
  saveDeviceConfig,
  saveDeviceEnrollmentAnchor,
} from './index.js';
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
  const timestamps: string[] = [];
  let failAfterAccept = false;
  const fetcher = async (url: string | URL | Request, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    const pathname = new URL(String(url)).pathname;
    const body = String(init?.body || '');
    const messageId = headers.get('x-dharma-message-id')!;
    messageIds.push(messageId);
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
  await assert.rejects(client.registerWorkspace({ workspaceId: 'oversized' }), /trajectory_capsule_too_large/);
  const state = JSON.parse(await readFile(statePath, 'utf8'));
  assert.equal(state.pending, null);
  assert.equal(state.nextSequence, 3);
  await client.registerWorkspace({ workspaceId: 'bounded' });
  assert.deepEqual(sequences, [1, 2, 3]);
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
