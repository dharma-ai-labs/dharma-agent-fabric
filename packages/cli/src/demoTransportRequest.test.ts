import assert from 'node:assert/strict';
import { generateKeyPairSync, sign, verify } from 'node:crypto';
import test from 'node:test';
import { canonicalize, sha256, signCanonicalObject } from '@dharma-ai-labs/agent-fabric-contracts';
import type { SecureSecretStore } from '@dharma-ai-labs/agent-fabric-relay-client';
import { requestDemoTransportContinuity } from './demoTransportRequest.js';
import { resolveDemoTransport } from './demoTransportState.js';

function fixture() {
  const signer = generateKeyPairSync('ed25519'), identity = generateKeyPairSync('ed25519');
  let now = new Date('2026-09-27T14:00:00.000Z');
  const unsigned = { schema: 'dharma.server-signing-keyset/v1' as const, organizationId: 'org_fixture',
    generation: 1, signedByKeyVersion: 'original', issuedAt: '2026-09-27T13:00:00.000Z',
    expiresAt: '2026-09-27T22:49:28.544Z', keys: [{ keyVersion: 'original', status: 'active' as const,
      publicKeyEd25519: signer.publicKey.export({ format: 'jwk' }).x!,
      notBefore: '2026-09-27T13:00:00.000Z', notAfter: '2026-09-27T22:49:28.544Z' }] };
  const keyset = { ...unsigned, signature: signCanonicalObject(unsigned, signer.privateKey) };
  const binding = { organizationId: 'org_fixture', repositoryId: '10000000-0000-4000-8000-000000000001',
    deviceId: '30000000-0000-4000-8000-000000000001', installationId: '40000000-0000-4000-8000-000000000001',
    publicKeyEd25519: identity.publicKey.export({ format: 'jwk' }).x!, enrollmentOrigin: 'https://original.example',
    protectedKeyset: keyset, minimumPolicyRevision: 1 };
  const target = 'https://corrected.example', values = new Map<string, string>([['protected-identity', 'do-not-touch']]);
  const store: SecureSecretStore = { backend: 'linux-secret-service',
    async get(account) { return values.get(account) ?? null; }, async getFresh(account) { return values.get(account) ?? null; },
    async put(account, value) { assert.match(account, /^demo-transport-/); values.set(account, value); },
    async delete(account) { assert.match(account, /^demo-transport-/); values.delete(account); } };
  const calls: Array<{ url: string; body: string; headers: Headers }> = [];
  let lost = false, reject: Response | ((headers: Headers) => Response) | null = null, corrupt = false;
  const issued = new Map<string, unknown>();
  const network: typeof fetch = async (resource, init) => {
    const url = new URL(String(resource)), body = String(init?.body), headers = new Headers(init?.headers);
    calls.push({ url: url.toString(), body, headers });
    assert.equal(url.origin, target); assert.equal(init?.credentials, 'omit'); assert.equal(init?.redirect, 'error');
    assert.equal(headers.get('authorization'), null); assert.equal(headers.get('cookie'), null);
    const payload = { bodyHash: sha256(body), deviceId: binding.deviceId, messageId: headers.get('x-dharma-message-id'),
      method: 'POST', nonce: headers.get('x-dharma-nonce'), organizationId: binding.organizationId,
      pathname: url.pathname + url.search, sequence: Number(headers.get('x-dharma-sequence')),
      sessionId: headers.get('x-dharma-session-id'), timestamp: headers.get('x-dharma-timestamp') };
    assert.equal(verify(null, Buffer.from(JSON.stringify(payload)), identity.publicKey,
      Buffer.from(headers.get('x-dharma-signature')!, 'base64url')), true);
    if (lost) { lost = false; throw new TypeError('fixture response lost'); }
    if (reject) return typeof reject === 'function' ? reject(headers) : reject;
    const request = JSON.parse(body);
    const certificateBody = { schema: 'dharma.demo-transport-continuity/v1', purpose: 'same-authority-repository-transport',
      organizationId: binding.organizationId, repositoryId: binding.repositoryId, deviceId: binding.deviceId,
      publicKeyEd25519: binding.publicKeyEd25519, ...request, policyRevision: 2, signingKeyVersion: 'original',
      issuedAt: now.toISOString(), expiresAt: new Date(now.getTime() + 600_000).toISOString() };
    const certificate = { ...certificateBody, signature: signCanonicalObject(certificateBody, signer.privateKey) };
    if (corrupt) certificate.signature = 'A'.repeat(86);
    if (!issued.has(request.requestNonce)) issued.set(request.requestNonce, certificate);
    return Response.json({ ok: true, certificate: issued.get(request.requestNonce), duplicate: calls.length > 1,
      correlationId: headers.get('x-dharma-correlation-id') },
      { headers: { 'x-dharma-correlation-id': headers.get('x-dharma-correlation-id')! } });
  };
  const deps = { store, now: () => new Date(now), fetcher: network,
    sign: async (payload: string) => sign(null, Buffer.from(payload), identity.privateKey).toString('base64url') };
  return { binding, target, values, calls, deps, setNow(value: Date) { now = value; },
    loseResponse() { lost = true; }, rejectWith(value: Response | ((headers: Headers) => Response) | null) { reject = value; }, corrupt() { corrupt = true; } };
}

test('grant-free transport request verifies and saves only the independent certificate state', async () => {
  const f = fixture(), before = f.values.get('protected-identity');
  const result = await requestDemoTransportContinuity(f.binding, f.target, f.deps);
  assert.equal(result.stage, 'demo_transport_verified'); assert.equal(result.enrolled, false);
  assert.equal((await resolveDemoTransport(f.binding, f.deps)).state, 'ready');
  assert.equal(f.values.get('protected-identity'), before);
  const request = JSON.parse(f.calls[0]!.body);
  assert.deepEqual(Object.keys(request).sort(), ['enrollmentOrigin', 'installationId', 'installedKeysetHash', 'requestNonce', 'transportOrigin', 'trustGeneration']);
  assert.doesNotMatch([...f.values.values()].join(''), /privateJwk|grant|authorization|"d":/);
});
test('lost response keeps the same durable request nonce/body and correlation after restart, with cooldown', async () => {
  const f = fixture(); f.loseResponse();
  await assert.rejects(requestDemoTransportContinuity(f.binding, f.target, f.deps), /request_failed/);
  await assert.rejects(requestDemoTransportContinuity(f.binding, f.target, f.deps), /retry_later/);
  assert.equal(f.calls.length, 1);
  f.setNow(new Date('2026-09-27T14:01:00.000Z'));
  await requestDemoTransportContinuity(f.binding, f.target, { ...f.deps, store: { ...f.deps.store } });
  assert.equal(f.calls[0]!.body, f.calls[1]!.body);
  assert.equal(f.calls[0]!.headers.get('x-dharma-correlation-id'), f.calls[1]!.headers.get('x-dharma-correlation-id'));
});
test('a verified live mapping is reused without another issuance dispatch', async () => {
  const f = fixture(); await requestDemoTransportContinuity(f.binding, f.target, f.deps);
  await requestDemoTransportContinuity(f.binding, f.target, f.deps);
  assert.equal(f.calls.length, 1);
});
test('near-expiry refresh issues one successor request without altering trust', async () => {
  const f = fixture(); await requestDemoTransportContinuity(f.binding, f.target, f.deps);
  f.setNow(new Date('2026-09-27T14:09:10.000Z'));
  await requestDemoTransportContinuity(f.binding, f.target, f.deps);
  assert.equal(f.calls.length, 2); assert.notEqual(f.calls[0]!.body, f.calls[1]!.body);
  assert.equal(f.binding.protectedKeyset.generation, 1);
});
test('expired protected trust sends nothing and cannot manufacture re-enrollment', async () => {
  const f = fixture(); f.setNow(new Date(f.binding.protectedKeyset.expiresAt));
  await assert.rejects(requestDemoTransportContinuity(f.binding, f.target, f.deps), /protected_authority_invalid/);
  assert.equal(f.calls.length, 0); assert.equal(f.values.size, 1);
});
for (const target of ['http://corrected.example', 'https://corrected.example/', 'https://user:password@corrected.example',
  'https://corrected.example/path', 'https://corrected.example#fragment', 'https://original.example']) {
  test(`unsafe or non-transition target is rejected: ${target}`, async () => {
    const f = fixture(); await assert.rejects(requestDemoTransportContinuity(f.binding, target, f.deps), /target_invalid/);
    assert.equal(f.calls.length, 0);
  });
}
for (const response of [() => new Response('', { status: 200 }), () => Response.json({}, { status: 200 }),
  () => new Response('<html>error</html>', { status: 200, headers: { 'content-type': 'text/html' } }),
  () => Response.json({ ok: false }, { status: 404 }), () => new Response(null, { status: 302 }),
  () => Response.json({ ok: true, certificate: {}, duplicate: false, correlationId: 'foreign' }),
  () => new Response('x'.repeat(32769), { headers: { 'content-type': 'application/json' } })]) {
  test('invalid HTTP/receipt does not activate transport or discard pending request', async () => {
    const f = fixture(); f.rejectWith(response());
    await assert.rejects(requestDemoTransportContinuity(f.binding, f.target, f.deps));
    assert.equal((await resolveDemoTransport(f.binding, f.deps)).state, 'original');
    assert.ok([...f.values.keys()].some(k => k.startsWith('demo-transport-request-')));
  });
}
test('a tampered certificate is rejected before activation', async () => {
  const f = fixture(); f.corrupt();
  await assert.rejects(requestDemoTransportContinuity(f.binding, f.target, f.deps), /signature_invalid/);
  assert.equal((await resolveDemoTransport(f.binding, f.deps)).state, 'original');
});
test('three failed attempts are bounded across restarts; aged requests are retained before renewal', async () => {
  const f = fixture();
  for (let i = 0; i < 3; i++) {
    f.setNow(new Date(Date.parse('2026-09-27T14:00:00.000Z') + i * 60_000));
    f.loseResponse(); await assert.rejects(requestDemoTransportContinuity(f.binding, f.target, f.deps), /request_failed/);
  }
  f.setNow(new Date('2026-09-27T14:03:00.000Z'));
  await assert.rejects(requestDemoTransportContinuity(f.binding, f.target, f.deps), /retry_later/);
  assert.equal(f.calls.length, 3);
  f.setNow(new Date('2026-09-27T14:15:00.000Z'));
  await requestDemoTransportContinuity(f.binding, f.target, f.deps);
  assert.equal(f.calls.length, 4); assert.notEqual(f.calls[0]!.body, f.calls[3]!.body);
  assert.ok([...f.values.keys()].some(k => k.includes('-retired-')));
});
test('typed expired issuance retires its nonce, without immediate retry or unsafe activation', async () => {
  const f = fixture();
  f.rejectWith(headers => Response.json({ ok: false, error: { code: 'demo_transport_refresh_required' } },
    { status: 409, headers: { 'x-dharma-correlation-id': headers.get('x-dharma-correlation-id')! } }));
  await assert.rejects(requestDemoTransportContinuity(f.binding, f.target, f.deps), /rejected_demo_transport_refresh_required/);
  assert.equal(f.calls.length, 1); assert.equal((await resolveDemoTransport(f.binding, f.deps)).state, 'original');
  f.rejectWith(null); await requestDemoTransportContinuity(f.binding, f.target, f.deps);
  assert.notEqual(f.calls[0]!.body, f.calls[1]!.body);
});
test('fresh protected binding is rechecked after receipt and before activation', async () => {
  const f = fixture();
  await assert.rejects(requestDemoTransportContinuity(f.binding, f.target, { ...f.deps,
    loadBinding: async () => ({ ...f.binding, publicKeyEd25519: generateKeyPairSync('ed25519').publicKey.export({ format: 'jwk' }).x! }) }), /protected_binding_changed/);
  assert.equal((await resolveDemoTransport(f.binding, f.deps)).state, 'original');
});
test('corrupt or extra pending records cannot reach the network', async () => {
  const f = fixture(); f.loseResponse();
  await assert.rejects(requestDemoTransportContinuity(f.binding, f.target, f.deps));
  const account = [...f.values.keys()].find(k => k.startsWith('demo-transport-request-'))!;
  const original = f.values.get(account)!;
  f.setNow(new Date('2026-09-27T14:01:00.000Z'));
  for (const value of ['not-json', canonicalize({ ...JSON.parse(original), grant: 'never-save' })]) {
    f.values.set(account, value);
    await assert.rejects(requestDemoTransportContinuity(f.binding, f.target, f.deps), /pending_invalid/);
  }
  assert.equal(f.calls.length, 1);
});
test('a signer that no longer matches the protected device sends nothing', async () => {
  const f = fixture();
  await assert.rejects(requestDemoTransportContinuity(f.binding, f.target, { ...f.deps, sign: async () => 'A'.repeat(86) }), /device_signature_invalid/);
  assert.equal(f.calls.length, 0);
});
test('restart reconciles committed certificate after pending cleanup failure without another dispatch', async () => {
  const f = fixture(); let failed = false;
  const store = { ...f.deps.store, async delete(account: string) {
    if (account.startsWith('demo-transport-request-') && !failed) { failed = true; throw new Error('fixture store interruption'); }
    return f.deps.store.delete(account);
  } };
  await assert.rejects(requestDemoTransportContinuity(f.binding, f.target, { ...f.deps, store }), /secure_store_write_failed/);
  assert.equal((await resolveDemoTransport(f.binding, f.deps)).state, 'ready');
  const receipt = await requestDemoTransportContinuity(f.binding, f.target, { ...f.deps, store });
  assert.equal(receipt.resumed, true); assert.equal(f.calls.length, 1);
  assert.ok(![...f.values.keys()].some(k => k.startsWith('demo-transport-request-')));
});
