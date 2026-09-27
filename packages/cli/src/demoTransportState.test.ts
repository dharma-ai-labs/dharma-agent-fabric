import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import test from 'node:test';
import { canonicalize, sha256, signCanonicalObject, type TrustedServerSigningKeyset } from '@dharma-ai-labs/agent-fabric-contracts';
import type { SecureSecretStore } from '@dharma-ai-labs/agent-fabric-relay-client';
import { acceptDemoTransport, resolveDemoTransport } from './demoTransportState.js';

function fixture() {
  const signer = generateKeyPairSync('ed25519');
  let now = new Date('2026-09-27T14:00:00.000Z');
  const unsigned = { schema: 'dharma.server-signing-keyset/v1' as const,
    organizationId: 'org_fixture', generation: 1, signedByKeyVersion: 'original',
    issuedAt: '2026-09-27T13:00:00.000Z', expiresAt: '2026-09-27T22:49:28.544Z',
    keys: [{ keyVersion: 'original', publicKeyEd25519: signer.publicKey.export({ format: 'jwk' }).x!,
      status: 'active' as const, notBefore: '2026-09-01T00:00:00.000Z', notAfter: '2026-09-27T22:49:28.544Z' }] };
  const keyset: TrustedServerSigningKeyset = { ...unsigned, signature: signCanonicalObject(unsigned, signer.privateKey) };
  const binding = { organizationId: 'org_fixture', repositoryId: '10000000-0000-4000-8000-000000000001',
    deviceId: '30000000-0000-4000-8000-000000000001', installationId: '40000000-0000-4000-8000-000000000001',
    publicKeyEd25519: generateKeyPairSync('ed25519').publicKey.export({ format: 'jwk' }).x!,
    enrollmentOrigin: 'https://original.example', protectedKeyset: keyset, minimumPolicyRevision: 1 };
  const expected = { transportOrigin: 'https://corrected.example', requestNonce: 'N'.repeat(32) };
  const values = new Map<string, string>([['existing-identity', 'private-fixture'], ['existing-trust', canonicalize(keyset)]]);
  let writes = 0;
  const store: SecureSecretStore = { backend: 'linux-secret-service',
    async get(account) { return values.get(account) ?? null; },
    async getFresh(account) { return values.get(account) ?? null; },
    async put(account, value) { assert.match(account, /^demo-transport-/); writes++; values.set(account, value); },
    async delete(account) { assert.match(account, /^demo-transport-/); writes++; values.delete(account); } };
  const deps = { store, now: () => new Date(now) };
  const certificate = (change: Record<string, unknown> = {}, authority = keyset, key = signer.privateKey) => {
    const body = { schema: 'dharma.demo-transport-continuity/v1', purpose: 'same-authority-repository-transport',
      organizationId: binding.organizationId, repositoryId: binding.repositoryId, deviceId: binding.deviceId,
      installationId: binding.installationId, publicKeyEd25519: binding.publicKeyEd25519,
      enrollmentOrigin: binding.enrollmentOrigin, ...expected, policyRevision: 2,
      trustGeneration: authority.generation, installedKeysetHash: sha256(canonicalize(authority)),
      signingKeyVersion: authority.signedByKeyVersion, issuedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + 600_000).toISOString(), ...change };
    return { ...body, signature: signCanonicalObject(body, key) };
  };
  return { binding, expected, values, store, deps, certificate, keyset,
    get writes() { return writes; }, setNow(value: Date) { now = value; } };
}

test('transport with no protected mapping stays on the original origin without writing', async () => {
  const f = fixture(), before = [...f.values];
  assert.deepEqual(await resolveDemoTransport(f.binding, f.deps), { state: 'original', transportOrigin: f.binding.enrollmentOrigin });
  assert.equal(f.writes, 0);
  assert.deepEqual([...f.values], before);
});

test('invalid local scope cannot become an original transport fallback', async () => {
  const f = fixture();
  for (const change of [{ enrollmentOrigin: 'http://original.example' },
    { enrollmentOrigin: 'https://original.example/' }, { organizationId: 'invalid' },
    { repositoryId: 'invalid' }, { deviceId: 'invalid' }, { installationId: 'invalid' },
    { publicKeyEd25519: 'invalid' }]) {
    await assert.rejects(resolveDemoTransport({ ...f.binding, ...change }, f.deps), /binding_invalid/);
    assert.equal(f.writes, 0);
  }
});

test('unrelated caller fields cannot change the protected transport account', async () => {
  const f = fixture();
  await acceptDemoTransport(f.certificate(), f.binding, f.expected, f.deps);
  const augmented = { ...f.binding, unrelated: 'not part of device identity' };
  assert.equal((await resolveDemoTransport(augmented, f.deps)).state, 'ready');
});

test('accepted transport survives restart while identity and trust accounts remain byte-identical', async () => {
  const f = fixture(), before = new Map(f.values), certificate = f.certificate();
  const result = await acceptDemoTransport(certificate, f.binding, f.expected, f.deps);
  assert.equal(result.state, 'ready');
  const restored = await resolveDemoTransport(f.binding, { ...f.deps, store: { ...f.store } });
  assert.equal(restored.state, 'ready');
  if (restored.state === 'ready') assert.equal(restored.transportOrigin, f.expected.transportOrigin);
  for (const [key, value] of before) assert.equal(f.values.get(key), value);
  const records = [...f.values].filter(([key]) => key.startsWith('demo-transport-'));
  assert.equal(records.length, 1);
  assert.doesNotMatch(records.map(([, value]) => value).join(''), /private-fixture|privateJwk|grant|authorization/);
});

test('duplicate certificate acceptance does not rewrite protected transport state', async () => {
  const f = fixture(), certificate = f.certificate();
  await acceptDemoTransport(certificate, f.binding, f.expected, f.deps);
  const before = f.writes;
  const repeated = await acceptDemoTransport(certificate, f.binding, f.expected, f.deps);
  assert.equal(repeated.duplicate, true);
  assert.equal(f.writes, before);
});

test('expiry retains monotonic history but never routes with the expired certificate', async () => {
  const f = fixture();
  await acceptDemoTransport(f.certificate(), f.binding, f.expected, f.deps);
  const before = [...f.values];
  f.setNow(new Date('2026-09-27T14:10:00.000Z'));
  const state = await resolveDemoTransport(f.binding, f.deps);
  assert.equal(state.state, 'refresh_required');
  assert.equal('transportOrigin' in state, false);
  assert.deepEqual([...f.values], before);
  f.setNow(new Date(f.keyset.expiresAt));
  await assert.rejects(resolveDemoTransport(f.binding, f.deps), /protected_authority_invalid/);
  assert.deepEqual([...f.values], before);
});

test('renewal rejects downgrade and same-revision destination conflicts after expiry', async () => {
  const f = fixture();
  await acceptDemoTransport(f.certificate(), f.binding, f.expected, f.deps);
  f.setNow(new Date('2026-09-27T14:11:00.000Z'));
  const before = [...f.values];
  for (const change of [{ policyRevision: 1 }, { transportOrigin: 'https://different.example' }]) {
    const expected = { ...f.expected, ...('transportOrigin' in change ? change : {}) };
    await assert.rejects(acceptDemoTransport(f.certificate(change), f.binding, expected, f.deps), /policy_revision_conflict/);
    assert.deepEqual([...f.values], before);
  }
  assert.equal((await acceptDemoTransport(f.certificate(), f.binding, f.expected, f.deps)).state, 'ready');
});

test('unverified, foreign and credential-bearing certificates cause no store writes', async () => {
  const f = fixture(), before = [...f.values];
  for (const value of [null, {}, { ...f.certificate(), signature: 'A'.repeat(86) },
    f.certificate({ deviceId: '30000000-0000-4000-8000-000000000099' }), f.certificate({ grant: 'do-not-store' })]) {
    await assert.rejects(acceptDemoTransport(value, f.binding, f.expected, f.deps));
    assert.equal(f.writes, 0);
    assert.deepEqual([...f.values], before);
  }
});

test('a Windows-style interrupted replacement recovers only its separate transport account', async () => {
  const f = fixture();
  await acceptDemoTransport(f.certificate(), f.binding, f.expected, f.deps);
  f.setNow(new Date('2026-09-27T14:01:00.000Z'));
  let failed = false;
  const broken: SecureSecretStore = { ...f.store, async put(account, value) {
    if (!account.endsWith('-journal') && !failed) { failed = true; f.values.delete(account); throw new Error('interrupted'); }
    await f.store.put(account, value);
  } };
  await assert.rejects(acceptDemoTransport(f.certificate({ policyRevision: 3 }), f.binding, f.expected,
    { ...f.deps, store: broken }), /secure_store_write_failed/);
  assert.ok([...f.values.keys()].some(key => key.endsWith('-journal')));
  const recovered = await resolveDemoTransport(f.binding, f.deps);
  assert.equal(recovered.state, 'ready');
  if (recovered.state === 'ready') assert.equal(recovered.certificate.policyRevision, 3);
  assert.equal(f.values.get('existing-identity'), 'private-fixture');
  assert.equal(f.values.get('existing-trust'), canonicalize(f.keyset));
  assert.ok(![...f.values.keys()].some(key => key.endsWith('-journal')));
});

test('failure after main write retains a recoverable journal without issuing another certificate', async () => {
  const f = fixture();
  const broken: SecureSecretStore = { ...f.store, async delete() { throw new Error('interrupted clear'); } };
  await assert.rejects(acceptDemoTransport(f.certificate(), f.binding, f.expected,
    { ...f.deps, store: broken }), /secure_store_write_failed/);
  const before = [...f.values];
  assert.ok(before.some(([key]) => key.endsWith('-journal')));
  assert.equal((await resolveDemoTransport(f.binding, f.deps)).state, 'ready');
  assert.equal([...f.values].filter(([key]) => key.startsWith('demo-transport-')).length, 1);
});

test('malformed journal and unrelated intervening state are preserved and rejected', async () => {
  const f = fixture();
  const broken: SecureSecretStore = { ...f.store, async delete() { throw new Error('interrupted clear'); } };
  await assert.rejects(acceptDemoTransport(f.certificate(), f.binding, f.expected, { ...f.deps, store: broken }));
  const journalKey = [...f.values.keys()].find(key => key.endsWith('-journal'))!;
  const original = f.values.get(journalKey)!;
  f.values.set(journalKey, canonicalize({ ...JSON.parse(original), grant: 'invalid' }));
  const malformed = [...f.values];
  await assert.rejects(resolveDemoTransport(f.binding, f.deps), /journal_invalid/);
  assert.deepEqual([...f.values], malformed);
  f.values.set(journalKey, original);
  f.values.set(journalKey.slice(0, -8), 'foreign intervening state');
  const conflicting = [...f.values];
  await assert.rejects(resolveDemoTransport(f.binding, f.deps), /journal_conflict/);
  assert.deepEqual([...f.values], conflicting);
});

test('generation changes require fresh issuance; split or rolled-back protected heads cannot route', async () => {
  const f = fixture();
  await acceptDemoTransport(f.certificate(), f.binding, f.expected, f.deps);
  const next = generateKeyPairSync('ed25519');
  const { signature: _signature, ...unsigned } = f.keyset;
  const body = { ...unsigned, generation: 2, signedByKeyVersion: 'successor', keys: [{ ...unsigned.keys[0]!,
    keyVersion: 'successor', publicKeyEd25519: next.publicKey.export({ format: 'jwk' }).x! }] };
  const successor = { ...body, signature: signCanonicalObject(body, next.privateKey) };
  const binding = { ...f.binding, protectedKeyset: successor };
  assert.equal((await resolveDemoTransport(binding, f.deps)).state, 'refresh_required');
  await acceptDemoTransport(f.certificate({}, successor, next.privateKey), binding, f.expected, f.deps);
  await assert.rejects(resolveDemoTransport(f.binding, f.deps), /protected_generation_rollback/);
  const splitBody = { ...body, issuedAt: '2026-09-27T13:01:00.000Z' };
  await assert.rejects(resolveDemoTransport({ ...binding, protectedKeyset: { ...splitBody,
    signature: signCanonicalObject(splitBody, next.privateKey) } }, f.deps), /protected_generation_conflict/);
});

test('fresh reads bypass cached values and unconfirmed writes never activate transport', async () => {
  const f = fixture();
  const stale: SecureSecretStore = { ...f.store, async get() { return 'stale-cache'; } };
  assert.equal((await acceptDemoTransport(f.certificate(), f.binding, f.expected, { ...f.deps, store: stale })).state, 'ready');
  const fresh = fixture();
  const dropped: SecureSecretStore = { ...fresh.store, async put() {} };
  await assert.rejects(acceptDemoTransport(fresh.certificate(), fresh.binding, fresh.expected,
    { ...fresh.deps, store: dropped }), /secure_store_write_unconfirmed/);
  assert.equal((await resolveDemoTransport(fresh.binding, fresh.deps)).state, 'original');
});
