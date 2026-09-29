import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import test from 'node:test';
import { canonicalize, sha256, signCanonicalObject, type TrustedServerSigningKeyset } from '@dharma-ai-labs/agent-fabric-contracts';
import type { SecureSecretStore } from '@dharma-ai-labs/agent-fabric-relay-client';
import { acceptDemoTransport } from './demoTransportState.js';
import { createDemoTransportFetcher } from './demoTransportFetch.js';

async function fixture(mapped = true) {
  const signer = generateKeyPairSync('ed25519'), identity = generateKeyPairSync('ed25519');
  let now = new Date('2026-09-27T14:00:00.000Z');
  const unsigned = { schema: 'dharma.server-signing-keyset/v1' as const,
    organizationId: 'org_fixture', generation: 1, signedByKeyVersion: 'original',
    issuedAt: '2026-09-27T13:00:00.000Z', expiresAt: '2026-09-27T22:49:28.544Z',
    keys: [{ keyVersion: 'original', publicKeyEd25519: signer.publicKey.export({ format: 'jwk' }).x!,
      status: 'active' as const, notBefore: '2026-09-01T00:00:00.000Z', notAfter: '2026-09-27T22:49:28.544Z' }] };
  const keyset: TrustedServerSigningKeyset = { ...unsigned, signature: signCanonicalObject(unsigned, signer.privateKey) };
  const binding = { organizationId: 'org_fixture', repositoryId: '10000000-0000-4000-8000-000000000001',
    deviceId: '30000000-0000-4000-8000-000000000001', installationId: '40000000-0000-4000-8000-000000000001',
    publicKeyEd25519: identity.publicKey.export({ format: 'jwk' }).x!,
    enrollmentOrigin: 'https://original.example', protectedKeyset: keyset, minimumPolicyRevision: 1 };
  const values = new Map<string, string>([['existing-identity', 'private-fixture'], ['existing-trust', canonicalize(keyset)]]);
  const store: SecureSecretStore = { backend: 'linux-secret-service',
    async get(account) { return values.get(account) ?? null; },
    async getFresh(account) { return values.get(account) ?? null; },
    async put(account, value) { assert.match(account, /^demo-transport-/); values.set(account, value); },
    async delete(account) { assert.match(account, /^demo-transport-/); values.delete(account); } };
  const clock = () => new Date(now), target = 'https://corrected.example';
  if (mapped) {
    const body = { schema: 'dharma.demo-transport-continuity/v1', purpose: 'same-authority-repository-transport',
      organizationId: binding.organizationId, repositoryId: binding.repositoryId, deviceId: binding.deviceId,
      installationId: binding.installationId, publicKeyEd25519: binding.publicKeyEd25519,
      enrollmentOrigin: binding.enrollmentOrigin, transportOrigin: target, requestNonce: 'N'.repeat(32),
      policyRevision: 2, trustGeneration: 1, installedKeysetHash: sha256(canonicalize(keyset)),
      signingKeyVersion: 'original', issuedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + 600_000).toISOString() };
    await acceptDemoTransport({ ...body, signature: signCanonicalObject(body, signer.privateKey) }, binding,
      { transportOrigin: target, requestNonce: body.requestNonce }, { store, now: clock });
  }
  const root = `/api/demo/fabric/repositories/${binding.repositoryId}`;
  const request = (path = `${root}/status?orgId=${binding.organizationId}`, method = 'GET', body = '') => {
    const url = new URL(path, binding.enrollmentOrigin), sessionId = randomUUID(), messageId = randomUUID();
    const timestamp = now.toISOString(), nonce = 'N'.repeat(32), sequence = 7;
    const payload = { bodyHash: sha256(body), deviceId: binding.deviceId, messageId, method, nonce,
      organizationId: binding.organizationId, pathname: `${url.pathname}${url.search}`, sequence, sessionId, timestamp };
    const headers = { 'x-dharma-device-id': binding.deviceId, 'x-dharma-session-id': sessionId,
      'x-dharma-message-id': messageId, 'x-dharma-timestamp': timestamp, 'x-dharma-nonce': nonce,
      'x-dharma-sequence': String(sequence), 'x-dharma-signature': sign(null, Buffer.from(JSON.stringify(payload)), identity.privateKey).toString('base64url') };
    return { url: url.toString(), init: { method, headers, ...(body ? { body } : {}) } };
  };
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  let response = Response.json({ ok: true });
  const network: typeof fetch = async (resource, init) => { calls.push({ url: String(resource), init }); return response; };
  const deps = { store, now: clock, loadBinding: async (_store: SecureSecretStore) => binding, fetcher: network };
  const fetcher = createDemoTransportFetcher(deps);
  return { binding, values, calls, deps, fetcher, request, root, target,
    setNow(value: Date) { now = value; }, setResponse(value: Response) { response = value; } };
}

test('a valid repository request changes only the transport host, not device identity, signature or body', async () => {
  const f = await fixture(), before = [...f.values];
  for (const request of [f.request(), f.request(`${f.root}/messages?orgId=org_fixture`, 'POST', '{"content":"bounded question"}')]) {
    assert.equal((await f.fetcher(request.url, request.init)).status, 200);
    const sent = f.calls.at(-1)!;
    assert.equal(new URL(sent.url).origin, f.target);
    assert.equal(new URL(sent.url).pathname + new URL(sent.url).search,
      new URL(request.url).pathname + new URL(request.url).search);
    assert.equal(sent.init?.body, request.init.body);
    assert.equal(new Headers(sent.init?.headers).get('x-dharma-signature'), request.init.headers['x-dharma-signature']);
    assert.equal(sent.init?.redirect, 'error');
    assert.equal(sent.init?.credentials, 'omit');
  }
  assert.deepEqual([...f.values], before);
});

test('unmapped transport uses the original origin without creating keys or a transport record', async () => {
  const f = await fixture(false), before = [...f.values], request = f.request();
  await f.fetcher(request.url, request.init);
  assert.equal(new URL(f.calls[0]!.url).origin, f.binding.enrollmentOrigin);
  assert.deepEqual([...f.values], before);
});

for (const mapped of [false, true]) {
  test(`canonical source blob GET preserves signed scope on ${mapped ? 'mapped' : 'original'} transport`, async () => {
    const f = await fixture(mapped), before = [...f.values];
    const candidate = '50000000-0000-4000-8000-000000000001';
    const hash = `sha256:${'a'.repeat(64)}`;
    const path = `${f.root}/source-inventory/${candidate}/blobs/${encodeURIComponent(hash)}`
      + '?workspaceId=60000000-0000-4000-8000-000000000001&path=reports%2Freview.md&orgId=org_fixture';
    for (const implicitMethod of [false, true]) {
      const request = f.request(path);
      const init: RequestInit = { ...request.init };
      if (implicitMethod) delete init.method;
      assert.equal((await f.fetcher(request.url, init)).status, 200);
      const sent = f.calls.at(-1)!;
      assert.equal(sent.url, request.url.replace(f.binding.enrollmentOrigin, mapped ? f.target : f.binding.enrollmentOrigin));
      assert.equal(new Headers(sent.init?.headers).get('x-dharma-signature'), request.init.headers['x-dharma-signature']);
      assert.equal(sent.init?.credentials, 'omit');
      assert.equal(sent.init?.redirect, 'error');
    }
    assert.equal(f.calls.length, 2);
    assert.deepEqual([...f.values], before);
  });
}

test('source blob exception rejects malformed and noncanonical paths and non-GET methods', async () => {
  const f = await fixture(), candidate = '50000000-0000-4000-8000-000000000001';
  const hash = `sha256%3A${'a'.repeat(64)}`;
  const suffix = `source-inventory/${candidate}/blobs/${hash}`;
  const invalid = [suffix.replace(candidate, 'not-a-uuid'), suffix.replace('-4000-', '-0000-'),
    suffix.replace('-8000-', '-7000-'), suffix.replace(candidate, '50000000-0000-4000-8000-00000000000A'),
    suffix.replace('%3A', ':'), suffix.replace('%3A', '%3a'), suffix.replace('%3A', '%253A'),
    suffix.replace('sha256', 'sha512'), suffix.slice(0, -1), `${suffix}a`, suffix.replace(/a$/, 'A'),
    suffix.replace(/a$/, 'g'), suffix.replace('source-inventory', '%73ource-inventory'),
    suffix.replace('/blobs/', '%2Fblobs/'), suffix.replace(candidate, `%35${candidate.slice(1)}`),
    `${suffix}/extra`, `${suffix}/`, suffix.replace('blobs', 'blob'), suffix.replace('%3A', '%3A%2F')];
  for (const path of invalid) {
    const request = f.request(`${f.root}/${path}?orgId=org_fixture`);
    await assert.rejects(f.fetcher(request.url, request.init), /request_scope_invalid/, path);
  }
  for (const method of ['POST', 'PUT', 'DELETE', 'HEAD', 'get']) {
    const request = f.request(`${f.root}/${suffix}?orgId=org_fixture`, method);
    await assert.rejects(f.fetcher(request.url, request.init), /request_scope_invalid/, method);
  }
  assert.equal(f.calls.length, 0);
});

test('canonical source blob GET cannot bypass tenant, identity, signature or origin checks', async () => {
  const f = await fixture();
  const path = `${f.root}/source-inventory/50000000-0000-4000-8000-000000000001/blobs/sha256%3A${'a'.repeat(64)}?orgId=org_fixture`;
  for (const target of [path.replace(f.binding.repositoryId, '10000000-0000-4000-8000-000000000099'),
    path.replace('org_fixture', 'org_foreign'), `${path}&orgId=org_fixture`,
    `https://foreign.example${path}`]) {
    const request = f.request(target);
    await assert.rejects(f.fetcher(request.url, request.init), /request_scope_invalid/);
  }
  const request = f.request(path);
  for (const headers of [{ ...request.init.headers, 'x-dharma-device-id': randomUUID() },
    { ...request.init.headers, 'x-dharma-signature': 'A'.repeat(86) },
    { ...request.init.headers, authorization: 'Bearer do-not-forward' }]) {
    await assert.rejects(f.fetcher(request.url, { ...request.init, headers }), /request_(scope|signature)_invalid/);
  }
  await assert.rejects(f.fetcher(request.url, { ...request.init, body: 'unexpected' }), /request_scope_invalid/);
  assert.equal(f.calls.length, 0);
});

test('every request resolves fresh protected state; expired transport or signing trust sends nothing', async () => {
  const f = await fixture();
  f.setNow(new Date('2026-09-27T14:10:00.000Z'));
  const request = f.request();
  await assert.rejects(f.fetcher(request.url, request.init), /refresh_required/);
  assert.equal(f.calls.length, 0);
  f.setNow(new Date(f.binding.protectedKeyset.expiresAt));
  await assert.rejects(f.fetcher(request.url, f.request().init), /protected_authority_invalid/);
  assert.equal(f.calls.length, 0);
});

test('foreign origins, repositories, duplicate tenants and encoded routes never receive signed requests', async () => {
  const f = await fixture();
  const valid = f.request();
  for (const url of [valid.url.replace('original.example', 'foreign.example'),
    valid.url.replace(f.binding.repositoryId, '10000000-0000-4000-8000-000000000099'),
    `${valid.url}&orgId=org_fixture`, valid.url.replace('org_fixture', 'org_foreign'),
    valid.url.replace('/status', '/%73tatus'), `${valid.url}#fragment`,
    valid.url.replace('https://', 'https://user:password@')]) {
    await assert.rejects(f.fetcher(url, valid.init), /request_scope_invalid/);
  }
  assert.equal(f.calls.length, 0);
});

test('invalid or altered signatures, credentials and unsupported bodies are never forwarded', async () => {
  const f = await fixture(), request = f.request(`${f.root}/messages?orgId=org_fixture`, 'POST', '{"content":"original"}');
  for (const change of [{ body: '{"content":"altered"}' }, { method: 'DELETE' },
    { body: new URLSearchParams('secret=do-not-forward') },
    { headers: { ...request.init.headers, authorization: 'Bearer do-not-forward' } },
    { headers: { ...request.init.headers, cookie: 'do-not-forward' } },
    { headers: { ...request.init.headers, 'x-dharma-device-id': randomUUID() } },
    { headers: { ...request.init.headers, 'x-dharma-signature': 'A'.repeat(86) } }]) {
    await assert.rejects(f.fetcher(request.url, { ...request.init, ...change }), /request_(scope|signature)_invalid/);
  }
  assert.equal(f.calls.length, 0);
});

test('the protected binding loader cannot create or replace enrollment accounts', async () => {
  const f = await fixture(), request = f.request(), before = [...f.values];
  for (const operation of ['put', 'delete'] as const) {
    const fetcher = createDemoTransportFetcher({ ...f.deps, loadBinding: async store => {
      if (operation === 'put') await store.put('existing-identity', 'replacement');
      else await store.delete('existing-trust');
      return f.binding;
    } });
    await assert.rejects(fetcher(request.url, request.init), /existing_protected_state_required/);
  }
  assert.deepEqual([...f.values], before);
  assert.equal(f.calls.length, 0);
});

test('redirects, HTML, and empty transport responses cannot become verified JSON', async () => {
  const f = await fixture(), request = f.request();
  for (const response of [new Response(null, { status: 302, headers: { location: 'https://foreign.example' } }),
    new Response('<html>login</html>', { headers: { 'content-type': 'text/html' } }),
    new Response(null, { status: 204 })]) {
    f.setResponse(response);
    await assert.rejects(f.fetcher(request.url, request.init), /response_contract_invalid/);
  }
});

test('HTTP rejection is retained for the caller and never relabeled healthy', async () => {
  const f = await fixture(), request = f.request();
  f.setResponse(Response.json({ ok: false, error: { code: 'demo_fabric_device_revoked' } }, { status: 403 }));
  const result = await f.fetcher(request.url, request.init);
  assert.equal(result.status, 403);
  assert.deepEqual(await result.json(), { ok: false, error: { code: 'demo_fabric_device_revoked' } });
});

test('an aborted request and a changed protected binding cannot dispatch', async () => {
  const f = await fixture(), request = f.request(), controller = new AbortController();
  controller.abort();
  await assert.rejects(f.fetcher(request.url, { ...request.init, signal: controller.signal }));
  const foreign = createDemoTransportFetcher({ ...f.deps,
    loadBinding: async () => ({ ...f.binding, deviceId: randomUUID() }) });
  await assert.rejects(foreign(request.url, request.init), /request_scope_invalid/);
  assert.equal(f.calls.length, 0);
});
