import assert from 'node:assert/strict';
import { createHash, createPublicKey, generateKeyPairSync, verify } from 'node:crypto';
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test from 'node:test';
import { signCanonicalObject } from '@dharma-ai-labs/agent-fabric-contracts';
import type { SecureSecretStore } from '@dharma-ai-labs/agent-fabric-relay-client';
import { connectDemoDevice, scopePath } from './demoEnrollment.js';
import { performDemoPeerAction, withDemoDeviceLock } from './demoPeer.js';

const orgId = 'org_fixture';
const repositoryId = '10000000-0000-4000-8000-000000000001';
const recipientDeviceId = '30000000-0000-4000-8000-000000000002';
const deviceId = '30000000-0000-4000-8000-000000000001';
const normalizedRepository = 'github.com/example/private';
const hqUrl = 'https://dharma.example';

function memoryStore(): SecureSecretStore {
  const values = new Map<string, string>();
  return { backend: 'linux-secret-service',
    async get(account) { return values.get(account) || null; },
    async put(account, value) { values.set(account, value); },
    async delete(account) { values.delete(account); } };
}

function scope(stateRoot: string) {
  return { hqUrl, organizationId: orgId, repositoryId, normalizedRepository,
    installationId: '40000000-0000-4000-8000-000000000001', stateRoot };
}

function server(options: { failNextSendWithCode?: string; invalidNextSend?: boolean } = {}) {
  const signer = generateKeyPairSync('ed25519');
  const serverPublicKeyEd25519 = (signer.publicKey.export({ format: 'jwk' }) as { x?: string }).x!;
  const issuedAt = new Date(Date.now() - 60_000).toISOString();
  const expiresAt = new Date(Date.now() + 24 * 60 * 60_000).toISOString();
  const keyVersion = 'projects/test/locations/global/keyRings/demo/cryptoKeys/signing/cryptoKeyVersions/1';
  const keyset = { schema: 'dharma.server-signing-keyset/v1' as const,
    organizationId: orgId, generation: 1, keys: [{ keyVersion, publicKeyEd25519: serverPublicKeyEd25519,
      status: 'active' as const, notBefore: issuedAt, notAfter: expiresAt }],
    signedByKeyVersion: keyVersion, issuedAt, expiresAt };
  let publicKey = '';
  let sequence = 0;
  let loseNextSend = !options.failNextSendWithCode && !options.invalidNextSend;
  let failNextSendWithCode = options.failNextSendWithCode;
  let invalidNextSend = options.invalidNextSend;
  const receipts = new Map<string, Record<string, unknown>>();
  const operations = new Map<string, string>();
  const sendHeaders: Headers[] = [];
  const fetcher: typeof fetch = async (resource, init) => {
    const url = new URL(String(resource));
    if (url.pathname.endsWith('/enrollments')) {
      publicKey = (JSON.parse(String(init?.body)) as { publicKeyEd25519: string }).publicKeyEd25519;
      return new Response(JSON.stringify({ ok: true, status: 'pending',
        organizationId: orgId, repositoryId, deviceCode: 'B'.repeat(43),
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        verificationUri: `${hqUrl}/demo/fabric/approve?orgId=${orgId}&repositoryId=${repositoryId}&code=ABCDEF0123456789ABCD` }),
      { status: 202 });
    }
    if (url.pathname.endsWith('/poll')) {
      return new Response(JSON.stringify({ ok: true, status: 'approved', deviceId, repositoryId,
        serverPublicKeyEd25519,
        serverSigningKeyset: { ...keyset, signature: signCanonicalObject(keyset, signer.privateKey) } }),
        { status: 200 });
    }
    const headers = new Headers(init?.headers);
    const method = init?.method || 'GET';
    const rawBody = String(init?.body || '');
    const messageId = headers.get('x-dharma-message-id')!;
    const requestSequence = Number(headers.get('x-dharma-sequence'));
    const signedPayload = Buffer.from(JSON.stringify({
      bodyHash: `sha256:${createHash('sha256').update(rawBody).digest('hex')}`,
      deviceId, messageId, method, nonce: headers.get('x-dharma-nonce'),
      organizationId: orgId, pathname: `${url.pathname}${url.search}`,
      sequence: requestSequence, sessionId: headers.get('x-dharma-session-id'),
      timestamp: headers.get('x-dharma-timestamp'),
    }));
    assert.equal(verify(null, signedPayload,
      createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: publicKey }, format: 'jwk' }),
      Buffer.from(headers.get('x-dharma-signature')!, 'base64url')), true);
    if (receipts.has(messageId)) {
      const previous = receipts.get(messageId)!;
      return new Response(JSON.stringify(previous), { status: 200 });
    }
    if (requestSequence !== sequence + 1) {
      return new Response(JSON.stringify({ ok: false, error: {
        code: 'demo_fabric_sequence_out_of_order', message: 'Device sequence is out of order.',
      } }), { status: 409 });
    }
    sequence = requestSequence;
    if (url.pathname.endsWith('/status')) {
      const result = { ok: true, organizationId: orgId, repositoryId,
        deviceId, normalizedRepository };
      receipts.set(messageId, result);
      return new Response(JSON.stringify(result), { status: 200 });
    }
    assert.equal(url.pathname, `/api/demo/fabric/repositories/${repositoryId}/messages`);
    if (failNextSendWithCode) {
      const code = failNextSendWithCode;
      failNextSendWithCode = undefined;
      return new Response(JSON.stringify({ ok: false, error: { code, message: 'Peer operation rejected.' } }),
        { status: 400 });
    }
    if (invalidNextSend) {
      invalidNextSend = false;
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    const body = JSON.parse(rawBody) as { operationId: string; kind: string };
    assert.equal(body.kind, 'question');
    sendHeaders.push(headers);
    const prior = operations.get(body.operationId);
    const id = prior || '50000000-0000-4000-8000-000000000001';
    operations.set(body.operationId, id);
    const result = { ok: true, message: { id, duplicate: Boolean(prior) } };
    receipts.set(messageId, result);
    if (loseNextSend) { loseNextSend = false; throw new Error('connection lost after send'); }
    return new Response(JSON.stringify(result), { status: 200 });
  };
  return { fetcher, operations, sendHeaders, get sequence() { return sequence; } };
}

async function enrolled(options: { failNextSendWithCode?: string; invalidNextSend?: boolean } = {}) {
  const stateRoot = await mkdtemp(resolve(tmpdir(), 'dharma-demo-peer-'));
  const store = memoryStore();
  const fixture = server(options);
  const input = scope(stateRoot);
  const connected = await connectDemoDevice({ ...input, grant: 'A'.repeat(43),
    deviceName: 'Fixture device', platform: 'linux' },
  { store, fetcher: fixture.fetcher, sleep: async () => {} });
  assert.equal(connected.stage, 'device_signed_ready');
  return { fixture, input, store, configPath: connected.configPath };
}

test('a lost peer response replays the exact signed request without creating another question', async () => {
  const { fixture, input, store, configPath } = await enrolled();
  const action = { kind: 'ask' as const, recipientDeviceId, content: 'Which approved mapping?' };
  await assert.rejects(performDemoPeerAction(input, action,
    { store, fetcher: fixture.fetcher }), /connection lost after send/);
  const recovered = await performDemoPeerAction(input, action,
    { store, fetcher: fixture.fetcher }) as Record<string, unknown>;
  assert.equal(recovered.stage, 'demo_peer_operation');
  assert.equal(recovered.resumed, true);
  assert.equal(fixture.operations.size, 1);
  assert.equal(fixture.sendHeaders.length, 1);
  assert.equal(fixture.sequence, 3);
  assert.equal((JSON.parse(await readFile(configPath, 'utf8')) as { nextSequence: number }).nextSequence, 4);
});

test('an expired signed peer request recovers sequence and reissues one logical operation', async () => {
  const { fixture, input, store, configPath } = await enrolled();
  const action = { kind: 'ask' as const, recipientDeviceId, content: 'Which approved mapping?' };
  await assert.rejects(performDemoPeerAction(input, action,
    { store, fetcher: fixture.fetcher }), /connection lost after send/);
  const pendingPath = `${configPath}.pending-peer.json`;
  const pending = JSON.parse(await readFile(pendingPath, 'utf8')) as {
    operationId: string; request: { createdAt: string } };
  pending.request.createdAt = new Date(Date.now() - 5 * 60_000).toISOString();
  await writeFile(pendingPath, JSON.stringify(pending));
  const recovered = await performDemoPeerAction(input, action,
    { store, fetcher: fixture.fetcher }) as Record<string, unknown>;
  assert.equal(recovered.stage, 'demo_peer_operation');
  assert.equal(recovered.resumed, true);
  assert.equal((recovered.message as { duplicate: boolean }).duplicate, true);
  assert.equal(fixture.operations.size, 1);
  assert.equal(fixture.sendHeaders.length, 2);
  assert.notEqual(fixture.sendHeaders[0]!.get('x-dharma-message-id'),
    fixture.sendHeaders[1]!.get('x-dharma-message-id'));
  assert.equal(fixture.sequence, 5);
  assert.equal((JSON.parse(await readFile(configPath, 'utf8')) as { nextSequence: number }).nextSequence, 6);
});

test('a typed post-acceptance rejection reconciles sequence and clears the failed operation', async () => {
  const { fixture, input, store, configPath } = await enrolled({
    failNextSendWithCode: 'demo_fabric_peer_invalid',
  });
  await assert.rejects(performDemoPeerAction(input, { kind: 'ask',
    recipientDeviceId, content: 'Invalid on server' },
  { store, fetcher: fixture.fetcher }), /demo_fabric_peer_invalid/);
  assert.equal(fixture.sequence, 4);
  assert.equal((JSON.parse(await readFile(configPath, 'utf8')) as { nextSequence: number }).nextSequence, 5);
  await assert.rejects(stat(`${configPath}.pending-peer.json`), { code: 'ENOENT' });
});

test('an incomplete 200 response cannot be reported as a completed peer operation', async () => {
  const { fixture, input, store, configPath } = await enrolled({ invalidNextSend: true });
  await assert.rejects(performDemoPeerAction(input, { kind: 'ask',
    recipientDeviceId, content: 'Which approved mapping?' },
  { store, fetcher: fixture.fetcher }), /expected command receipt/);
  assert.equal(fixture.operations.size, 0);
  assert.equal(fixture.sequence, 3);
  await stat(`${configPath}.pending-peer.json`);
});

test('a tampered pending URL cannot receive signed device headers', async () => {
  const { fixture, input, store, configPath } = await enrolled();
  const action = { kind: 'ask' as const, recipientDeviceId, content: 'Which mapping?' };
  await assert.rejects(performDemoPeerAction(input, action,
    { store, fetcher: fixture.fetcher }), /connection lost after send/);
  const pendingPath = `${configPath}.pending-peer.json`;
  const pending = JSON.parse(await readFile(pendingPath, 'utf8')) as {
    request: { url: string } };
  pending.request.url = 'https://attacker.example/collect';
  await writeFile(pendingPath, JSON.stringify(pending));
  await assert.rejects(performDemoPeerAction(input, action,
    { store, fetcher: fixture.fetcher }), /does not match this signed repository/);
  assert.equal(fixture.sequence, 3);
});

test('the CLI lock rejects overlapping Demo operations on one local device', async () => {
  const stateRoot = await mkdtemp(resolve(tmpdir(), 'dharma-demo-peer-lock-'));
  const input = scope(stateRoot);
  let release: (() => void) | undefined;
  const first = withDemoDeviceLock(input, () => new Promise<void>((done) => { release = done; }));
  const lockPath = `${scopePath(input, hqUrl)}.lock`;
  for (let attempts = 0; attempts < 20; attempts += 1) {
    try { await stat(lockPath); break; }
    catch { await new Promise((done) => setTimeout(done, 10)); }
  }
  await assert.rejects(withDemoDeviceLock(input, async () => 'overlap'), /busy/);
  release?.();
  await first;
  assert.equal(await withDemoDeviceLock(input, async () => 'available'), 'available');
});
