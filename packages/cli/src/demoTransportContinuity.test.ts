import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync } from 'node:crypto';
import test from 'node:test';
import { canonicalize, signCanonicalObject, type TrustedServerSigningKeyset } from '@dharma-ai-labs/agent-fabric-contracts';
import { verifyDemoTransportContinuity } from './demoTransportContinuity.js';

const now = new Date('2026-09-27T14:00:00.000Z');
const signer = generateKeyPairSync('ed25519');
const stranger = generateKeyPairSync('ed25519');
function fixture() {
  const keysetBody = { schema: 'dharma.server-signing-keyset/v1' as const,
    organizationId: 'org_fixture', generation: 1, signedByKeyVersion: 'original',
    issuedAt: '2026-09-27T13:00:00.000Z', expiresAt: '2026-09-27T22:49:28.544Z',
    keys: [{ keyVersion: 'original', publicKeyEd25519: signer.publicKey.export({ format: 'jwk' }).x!,
      status: 'active' as const, notBefore: '2026-09-01T00:00:00.000Z', notAfter: '2026-09-27T22:49:28.544Z' }] };
  const protectedKeyset: TrustedServerSigningKeyset = { ...keysetBody,
    signature: signCanonicalObject(keysetBody, signer.privateKey) };
  const scope = { organizationId: 'org_fixture', repositoryId: '10000000-0000-4000-8000-000000000001',
    deviceId: '30000000-0000-4000-8000-000000000001', installationId: '40000000-0000-4000-8000-000000000001',
    publicKeyEd25519: stranger.publicKey.export({ format: 'jwk' }).x!,
    enrollmentOrigin: 'https://original.example', transportOrigin: 'https://corrected.example',
    requestNonce: 'N'.repeat(32) };
  const body = { schema: 'dharma.demo-transport-continuity/v1' as const,
    purpose: 'same-authority-repository-transport' as const, ...scope, policyRevision: 2,
    trustGeneration: protectedKeyset.generation,
    installedKeysetHash: `sha256:${createHash('sha256').update(canonicalize(protectedKeyset)).digest('hex')}`,
    signingKeyVersion: 'original', issuedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + 600_000).toISOString() };
  const sign = (change: Record<string, unknown> = {}) => {
    const value = { ...body, ...change };
    return { ...value, signature: signCanonicalObject(value, signer.privateKey) };
  };
  return { scope, protectedKeyset, body, sign,
    context: { ...scope, protectedKeyset, minimumPolicyRevision: 2, now } };
}

test('continuity verifies the protected authority without changing identity or extending trust', async () => {
  const f = fixture(), before = canonicalize(f.context), certificate = f.sign();
  assert.deepEqual(await verifyDemoTransportContinuity(certificate, f.context), certificate);
  assert.equal(canonicalize(f.context), before);
  assert.doesNotMatch(canonicalize(certificate), /grant|privateJwk|authorization/);
});

const invalidFields: [string, unknown][] = [
  ['organizationId', 'org_foreign'], ['repositoryId', '10000000-0000-4000-8000-000000000099'],
  ['deviceId', '30000000-0000-4000-8000-000000000099'], ['installationId', '40000000-0000-4000-8000-000000000099'],
  ['publicKeyEd25519', 'E'.repeat(43)], ['enrollmentOrigin', 'https://other.example'],
  ['transportOrigin', 'https://unrequested.example'], ['requestNonce', 'R'.repeat(32)],
  ['policyRevision', 1], ['policyRevision', 0], ['trustGeneration', 2],
  ['installedKeysetHash', `sha256:${'a'.repeat(64)}`], ['signingKeyVersion', 'untrusted'],
  ['issuedAt', new Date(now.getTime() + 1).toISOString()], ['expiresAt', now.toISOString()],
  ['expiresAt', new Date(now.getTime() + 600_001).toISOString()], ['expiresAt', 'invalid'],
  ['schema', 'legacy'], ['purpose', 'enrollment'], ['grant', 'must-not-persist'],
  ['privateJwk', { d: 'secret' }], ['authorization', 'Bearer secret'],
];
for (const [field, value] of invalidFields) {
  test(`continuity rejects signed invalid ${field}=${JSON.stringify(value)}`, async () => {
    const f = fixture();
    await assert.rejects(verifyDemoTransportContinuity(f.sign({ [field]: value }), f.context), /Demo transport continuity rejected/);
  });
}

test('continuity rejects malformed and unsigned responses, including HTML and empty objects', async () => {
  const f = fixture();
  for (const value of [null, {}, [], '', '<html>not a contract</html>', { ...f.sign(), signature: undefined }]) {
    await assert.rejects(verifyDemoTransportContinuity(value, f.context), /schema_invalid/);
  }
});

test('continuity rejects a foreign signature and tampering after issuance', async () => {
  const f = fixture();
  await assert.rejects(verifyDemoTransportContinuity({ ...f.sign(),
    signature: signCanonicalObject(f.body, stranger.privateKey) }, f.context), /signature_invalid/);
  await assert.rejects(verifyDemoTransportContinuity({ ...f.sign(), policyRevision: 3 }, f.context), /signature_invalid/);
});

for (const origin of ['http://corrected.example', 'https://corrected.example/', 'https://corrected.example/path',
  'https://corrected.example?query=x', 'https://corrected.example#fragment', 'https://user:password@corrected.example',
  'https://CORRECTED.example', 'https://corrected.example:443']) {
  test(`continuity rejects noncanonical or insecure destination ${origin}`, async () => {
    const f = fixture();
    await assert.rejects(verifyDemoTransportContinuity(f.sign({ transportOrigin: origin }),
      { ...f.context, transportOrigin: origin }), /origin_invalid/);
  });
}

test('continuity rejects invalid protected authority, even if the certificate looks valid', async () => {
  const f = fixture();
  for (const protectedKeyset of [{ ...f.protectedKeyset, signature: 'invalid' },
    { ...f.protectedKeyset, organizationId: 'org_foreign' },
    { ...f.protectedKeyset, keys: [] }]) {
    await assert.rejects(verifyDemoTransportContinuity(f.sign(), { ...f.context, protectedKeyset }), /authority_invalid/);
  }
});

test('continuity rejects ambiguous signer roles and duplicate versions in protected authority', async () => {
  const f = fixture();
  const original = f.protectedKeyset.keys[0]!;
  const cases: TrustedServerSigningKeyset['keys'][] = [
    [{ ...original, status: 'overlap' }], [original, { ...original, keyVersion: 'second' }],
    [original, { ...original, status: 'overlap' }],
    [{ ...original, notBefore: '2026-09-27T14:01:00.000Z' }],
    [{ ...original, notAfter: '2026-09-27T22:00:00.000Z' }],
  ];
  for (const keys of cases) {
    const { signature: _signature, ...unsigned } = f.protectedKeyset;
    const body = { ...unsigned, keys };
    const protectedKeyset = { ...body, signature: signCanonicalObject(body, signer.privateKey) };
    await assert.rejects(verifyDemoTransportContinuity(f.sign({
      installedKeysetHash: `sha256:${createHash('sha256').update(canonicalize(protectedKeyset)).digest('hex')}` }),
    { ...f.context, protectedKeyset }), /authority_invalid/);
  }
});

test('continuity rejects certificates missing required scope and unsafe revisions', async () => {
  const f = fixture();
  for (const field of Object.keys(f.body)) {
    const unsigned: Record<string, unknown> = { ...f.body };
    delete unsigned[field];
    await assert.rejects(verifyDemoTransportContinuity({ ...unsigned,
      signature: signCanonicalObject(unsigned, signer.privateKey) }, f.context), /schema_invalid/);
  }
  for (const value of [1.5, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity]) {
    await assert.rejects(verifyDemoTransportContinuity(f.sign({ policyRevision: value }), f.context), /schema_invalid/);
    await assert.rejects(verifyDemoTransportContinuity(f.sign({ trustGeneration: value }), f.context), /schema_invalid/);
  }
});

test('continuity never recovers expired trust and expires no later than the original anchor', async () => {
  const f = fixture();
  const late = new Date(f.protectedKeyset.expiresAt);
  await assert.rejects(verifyDemoTransportContinuity(f.sign(), { ...f.context, now: late }), /authority_invalid/);
  const nearExpiry = new Date(late.getTime() - 60_000);
  await assert.rejects(verifyDemoTransportContinuity(f.sign({ issuedAt: nearExpiry.toISOString(),
    expiresAt: new Date(late.getTime() + 1).toISOString() }), { ...f.context, now: nearExpiry }), /lifetime_invalid/);
});

test('continuity rejects downgrade and split destinations at the same protected revision', async () => {
  const f = fixture();
  const previous = { policyRevision: 3, transportOrigin: f.scope.transportOrigin };
  await assert.rejects(verifyDemoTransportContinuity(f.sign(), { ...f.context, previous }), /policy_revision_conflict/);
  await assert.rejects(verifyDemoTransportContinuity(f.sign({ policyRevision: 3 }),
    { ...f.context, previous: { ...previous, transportOrigin: 'https://different.example' } }), /policy_revision_conflict/);
  assert.equal((await verifyDemoTransportContinuity(f.sign({ policyRevision: 3 }),
    { ...f.context, previous })).policyRevision, 3);
});

test('continuity snapshots inputs before asynchronous schema loading and rejects invalid local context', async () => {
  const f = fixture(), certificate = f.sign(), before = structuredClone(certificate);
  const pending = verifyDemoTransportContinuity(certificate, f.context);
  certificate.transportOrigin = 'https://changed.example';
  f.context.transportOrigin = 'https://changed.example';
  assert.deepEqual(await pending, before);
  const fresh = fixture();
  for (const context of [{ ...fresh.context, now: new Date(NaN) },
    { ...fresh.context, minimumPolicyRevision: 0 }, { ...fresh.context, minimumPolicyRevision: NaN }]) {
    await assert.rejects(verifyDemoTransportContinuity(fresh.sign(), context), /context_invalid/);
  }
});
