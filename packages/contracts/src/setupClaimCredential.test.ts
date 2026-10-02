import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import test from 'node:test';
import { openSetupClaimCredential, sealSetupClaimCredential } from './setupClaimCredential.js';
import type { SetupClaimChallenge } from './setupClaim.js';

const device = generateKeyPairSync('x25519');
const now = Date.parse('2026-10-02T21:15:00Z');
const challenge: SetupClaimChallenge = {
  schema: 'dharma.setup-claim-challenge/v1', origin: 'https://www.dharma-ai.io',
  setupReference: '36f56631-a74e-4f35-a337-8cb8c1553762', organizationId: 'org_synthetic',
  recipientMembershipId: '514d7500-540a-46e6-8cbf-513be79c6661',
  publicKeyEd25519: generateKeyPairSync('ed25519').publicKey.export({ format: 'jwk' }).x!,
  credentialEncryptionPublicKey: device.publicKey.export({ format: 'jwk' }).x!,
  repositoryFingerprint: 'sha256:' + 'a'.repeat(64), mode: 'source', policyRevision: 'agent-fabric-policy-v1',
  scopeDigest: 'sha256:' + 'b'.repeat(64), contractDigest: 'sha256:' + 'c'.repeat(64),
  method: 'POST', path: '/api/v1/agent-fabric/bootstrap/setup-claim',
  nonce: Buffer.alloc(32, 42).toString('base64url'), authenticator: Buffer.alloc(32, 43).toString('base64url'),
  issuedAt: new Date(now).toISOString(), expiresAt: new Date(now + 60_000).toISOString(),
};
const synthetic = 'SYNTHETIC_CREDENTIAL_CANARY';

test('native recipient alone decrypts a sealed response; public fields contain no credential', () => {
  const response = sealSetupClaimCredential(challenge, synthetic);
  assert.equal(JSON.stringify(response).includes(synthetic), false);
  assert.equal(openSetupClaimCredential(challenge, response, device.privateKey), synthetic);
  const attacker = generateKeyPairSync('x25519');
  assert.throws(() => openSetupClaimCredential(challenge, response, attacker.privateKey), /^Error: setup_claim_credential_unavailable$/);
});

test('replayed proof response remains sealed and each server encryption is fresh', () => {
  const first = sealSetupClaimCredential(challenge, synthetic);
  const second = sealSetupClaimCredential(challenge, synthetic);
  assert.notEqual(first.ephemeralPublicKey, second.ephemeralPublicKey);
  assert.notEqual(first.ciphertext, second.ciphertext);
  assert.equal(openSetupClaimCredential(challenge, second, device.privateKey), synthetic);
});

test('ciphertext, tag, context and encryption-key substitutions fail with sanitized errors', () => {
  const response = sealSetupClaimCredential(challenge, synthetic);
  for (const [field, replacement] of Object.entries({
    ciphertext: Buffer.alloc(32).toString('base64url'), tag: Buffer.alloc(16).toString('base64url'),
    iv: Buffer.alloc(12).toString('base64url'), contextDigest: 'sha256:' + 'f'.repeat(64),
    organizationId: 'org_other', setupReference: '36f56631-a74e-4f35-a337-8cb8c1553763',
    issuedAt: '2026-10-02T21:14:00.000Z', expiresAt: '2026-10-02T21:17:00.000Z',
    ephemeralPublicKey: generateKeyPairSync('x25519').publicKey.export({ format: 'jwk' }).x!,
  })) assert.throws(() => openSetupClaimCredential(challenge, { ...response, [field]: replacement }, device.privateKey), /^Error: setup_claim_credential_unavailable$/);
  assert.throws(() => openSetupClaimCredential({ ...challenge, repositoryFingerprint: 'sha256:' + 'd'.repeat(64) }, response, device.privateKey), /^Error: setup_claim_credential_unavailable$/);
});

test('malformed and oversized responses or extra secret fields never echo input', () => {
  const response = sealSetupClaimCredential(challenge, synthetic);
  for (const bad of [null, [], { ...response, privateKey: synthetic }, { ...response, ciphertext: 'A'.repeat(100_000) }]) {
    assert.throws(() => openSetupClaimCredential(challenge, bad, device.privateKey), /^Error: setup_claim_credential_unavailable$/);
  }
  assert.throws(() => sealSetupClaimCredential(challenge, synthetic.repeat(1000)), /^Error: setup_claim_credential_unavailable$/);
});
