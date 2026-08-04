import assert from 'node:assert/strict';
import { createHash, createPublicKey, generateKeyPairSync, verify } from 'node:crypto';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { AgentFabricClient, beginEnrollment, loadOrCreateDeviceIdentity, saveDeviceConfig } from './index.js';
import type { SecureSecretStore } from '@dharma-ai/agent-fabric-secure-store';

function memoryStore(): SecureSecretStore {
  const values = new Map<string, string>();
  return {
    backend: 'linux-secret-service',
    async get(account) { return values.get(account) || null; },
    async put(account, value) { values.set(account, value); },
    async delete(account) { values.delete(account); },
  };
}

test('device identity remains stable in the OS secret store', async () => {
  const store = memoryStore();
  const first = await loadOrCreateDeviceIdentity({ hqUrl: 'https://hq.example', organizationId: 'org_a', store });
  const second = await loadOrCreateDeviceIdentity({ hqUrl: 'https://hq.example', organizationId: 'org_a', store });
  assert.equal(first.publicKeyEd25519, second.publicKeyEd25519);
  assert.ok(first.privateJwk.d);
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
