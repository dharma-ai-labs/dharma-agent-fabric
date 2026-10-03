import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import test from 'node:test';
import { parseSetupClaimChallenge, setupClaimSigningPayload, verifySetupClaimProof } from './setupClaim.js';

const now = Date.parse('2026-10-02T21:15:00Z');
const pair = generateKeyPairSync('ed25519');
const publicKey = pair.publicKey.export({ format: 'jwk' }).x!;
const expected = {
  origin: 'https://www.dharma-ai.io', setupReference: '36f56631-a74e-4f35-a337-8cb8c1553762',
  organizationId: 'org_synthetic', recipientMembershipId: '514d7500-540a-46e6-8cbf-513be79c6661',
  publicKeyEd25519: publicKey, repositoryFingerprint: 'sha256:' + 'a'.repeat(64),
  credentialEncryptionPublicKey: generateKeyPairSync('x25519').publicKey.export({ format: 'jwk' }).x!,
  mode: 'source' as const, policyRevision: 'agent-fabric-policy-v1',
  scopeDigest: 'sha256:' + 'b'.repeat(64), contractDigest: 'sha256:' + 'c'.repeat(64),
};
const challenge = {
  schema: 'dharma.setup-claim-challenge/v1', ...expected, method: 'POST',
  path: '/api/v1/agent-fabric/bootstrap/setup-claim', nonce: Buffer.alloc(32, 42).toString('base64url'),
  issuedAt: new Date(now - 1000).toISOString(), expiresAt: new Date(now + 60_000).toISOString(),
  authenticator: Buffer.alloc(32, 43).toString('base64url'),
};
const proof = (body: unknown) => sign(null, setupClaimSigningPayload(body), pair.privateKey).toString('base64url');

test('real Ed25519 possession verifies only the exact bounded setup context', () => {
  assert.deepEqual(parseSetupClaimChallenge(challenge, expected, now), challenge);
  assert.equal(verifySetupClaimProof(challenge, proof(challenge), expected, now), true);
  const wrongKey = generateKeyPairSync('ed25519');
  const wrongProof = sign(null, setupClaimSigningPayload(challenge), wrongKey.privateKey).toString('base64url');
  assert.equal(verifySetupClaimProof(challenge, wrongProof, expected, now), false);
});

test('proof cannot cross tenant, recipient, key, repository, mode, policy, contract or scope', () => {
  const signature = proof(challenge);
  for (const [field, replacement] of Object.entries({
    origin: 'https://other.example', setupReference: '36f56631-a74e-4f35-a337-8cb8c1553763',
    organizationId: 'org_other', recipientMembershipId: '514d7500-540a-46e6-8cbf-513be79c6662',
    publicKeyEd25519: generateKeyPairSync('ed25519').publicKey.export({ format: 'jwk' }).x!,
    credentialEncryptionPublicKey: generateKeyPairSync('x25519').publicKey.export({ format: 'jwk' }).x!,
    repositoryFingerprint: 'sha256:' + 'd'.repeat(64), mode: 'join', policyRevision: 'other-v1',
    scopeDigest: 'sha256:' + 'e'.repeat(64), contractDigest: 'sha256:' + 'f'.repeat(64),
  })) {
    assert.equal(verifySetupClaimProof({ ...challenge, [field]: replacement }, signature, expected, now), false, field);
  }
});

test('signature domain binds method, path, nonce, server authenticator and time fields', () => {
  const signature = proof(challenge);
  for (const [field, replacement] of Object.entries({
    method: 'GET', path: '/api/v1/agent-fabric/enrollments', nonce: 'm'.repeat(43),
    authenticator: 'g'.repeat(43), issuedAt: new Date(now - 2000).toISOString(),
    expiresAt: new Date(now + 30_000).toISOString(),
  })) assert.equal(verifySetupClaimProof({ ...challenge, [field]: replacement }, signature, expected, now), false, field);
  const payload = setupClaimSigningPayload(challenge).toString('utf8');
  assert.ok(payload.startsWith('dharma.agent-fabric.setup-claim-proof/v1\0'));
});

test('expired, future, overlong or invalid challenge deadlines fail closed', () => {
  for (const fields of [
    { expiresAt: new Date(now).toISOString() }, { issuedAt: new Date(now + 1).toISOString() },
    { issuedAt: challenge.issuedAt, expiresAt: new Date(now + 900_000).toISOString() },
    { expiresAt: 'not-a-date' }, { issuedAt: '2026-10-02' },
  ]) assert.throws(() => parseSetupClaimChallenge({ ...challenge, ...fields }, expected, now), /setup_claim_challenge_invalid/);
});

test('unknown fields, malformed public identities and untrusted origins are rejected', () => {
  for (const body of [
    { ...challenge, bootstrapToken: 'SYNTHETIC_SECRET_NEVER_PRINT' },
    { ...challenge, nonce: '' }, { ...challenge, nonce: 'n'.repeat(100_000) },
    { ...challenge, publicKeyEd25519: 'A'.repeat(42) }, { ...challenge, setupReference: 'guessable' },
    { ...challenge, origin: 'http://www.dharma-ai.io' },
    { ...challenge, origin: 'https://user:password@www.dharma-ai.io' },
    { ...challenge, origin: 'https://www.dharma-ai.io/path' },
    { ...challenge, policyRevision: 'v1\nunsafe' }, null, [],
  ]) assert.throws(() => parseSetupClaimChallenge(body, expected, now), /^Error: setup_claim_challenge_invalid$/);
});

test('invalid proof never throws secret-bearing data or accepts noncanonical base64url', () => {
  for (const signature of ['', 'A'.repeat(85), 'A'.repeat(87), 'A'.repeat(86) + '=', 'private-input-canary']) {
    assert.equal(verifySetupClaimProof(challenge, signature, expected, now), false);
  }
});
