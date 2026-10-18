import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { resolve } from 'node:path';
import test from 'node:test';
import * as contracts from './index.js';

const now = Date.parse('2026-10-17T09:31:49.040Z');
const device = generateKeyPairSync('ed25519');
const encryption = generateKeyPairSync('x25519');
const expected = {
  origin: 'https://www.dharma-ai.io', recoveryId: '11111111-1111-4111-8111-111111111111',
  issuer: 'https://www.dharma-ai.io', audience: 'dharma.agent-fabric.signing-recovery/v1',
  approvalId: '55555555-5555-4555-8555-555555555555', workspaceId: '66666666-6666-4666-8666-666666666666',
  organizationId: 'org_synthetic', recipientMembershipId: '22222222-2222-4222-8222-222222222222',
  deviceId: '33333333-3333-4333-8333-333333333333', installationId: '44444444-4444-4444-8444-444444444444',
  publicKeyEd25519: device.publicKey.export({format: 'jwk'}).x!,
  credentialEncryptionPublicKey: encryption.publicKey.export({format: 'jwk'}).x!,
  repositoryFingerprint: `sha256:${'a'.repeat(64)}`, policyRevision: 'agent-fabric-policy-v1',
  scopeDigest: `sha256:${'b'.repeat(64)}`, contractDigest: `sha256:${'c'.repeat(64)}`,
  sourceSelectionDigest: `sha256:${'2'.repeat(64)}`, nativeSessionBindingDigest: `sha256:${'3'.repeat(64)}`,
  previousAnchorHash: `sha256:${'4'.repeat(64)}`, protectedConfigDigest: `sha256:${'5'.repeat(64)}`,
  previousGeneration: 2, previousKeysetHash: `sha256:${'d'.repeat(64)}`,
  previousRootFingerprint: `sha256:${'e'.repeat(64)}`,
  candidateGeneration: 3, candidateKeysetHash: `sha256:${'f'.repeat(64)}`,
  candidateRootFingerprint: `sha256:${'0'.repeat(64)}`, candidateKeyVersionFingerprint: `sha256:${'1'.repeat(64)}`,
};
const challenge = {
  schema: 'dharma.device-signing-recovery-challenge/v1', ...expected,
  purpose: 'expired_signing_trust_reapproval', method: 'POST',
  path: '/api/v1/agent-fabric/signing-recovery', nonce: Buffer.alloc(32, 12).toString('base64url'),
  issuedAt: new Date(now - 1000).toISOString(), expiresAt: new Date(now + 60_000).toISOString(),
  authenticator: Buffer.alloc(32, 13).toString('base64url'),
};
type Context = typeof expected;
type PublicChallenge = typeof challenge;
function protocol() {
  const api = contracts as unknown as Record<string, unknown>;
  for (const key of ['parseDeviceSigningRecoveryChallenge', 'deviceSigningRecoverySigningPayload', 'verifyDeviceSigningRecoveryProof']) {
    assert.equal(typeof api[key], 'function', `Public recovery protocol is missing: ${key}`);
  }
  return api as unknown as {
    parseDeviceSigningRecoveryChallenge(value: unknown, context: Context, at: number): PublicChallenge;
    deviceSigningRecoverySigningPayload(value: unknown): Buffer;
    verifyDeviceSigningRecoveryProof(value: unknown, signature: unknown, context: Context, at: number): boolean;
  };
}
function proof(value: unknown = challenge) {
  return sign(null, protocol().deviceSigningRecoverySigningPayload(value), device.privateKey).toString('base64url');
}

test('maintenance challenge is a disjoint device purpose, never a native-session attestation',()=>{
  const {nativeSessionBindingDigest,...base}=expected;
  const scope={...base,audience:'dharma.agent-fabric.signing-maintenance/v1',controllerBindingDigest:`sha256:${'7'.repeat(64)}`};
  const body={...challenge,...scope,schema:'dharma.device-signing-maintenance-challenge/v1'} as Record<string,unknown>;
  delete body.nativeSessionBindingDigest;
  const parse=protocol().parseDeviceSigningRecoveryChallenge as (v:unknown,c:unknown,at:number)=>unknown;
  const verify=protocol().verifyDeviceSigningRecoveryProof as (v:unknown,s:unknown,c:unknown,at:number)=>boolean;
  assert.deepEqual(parse(body,scope,now),body);
  const payload=protocol().deviceSigningRecoverySigningPayload(body);
  assert.ok(payload.toString().startsWith('dharma.agent-fabric.device-signing-maintenance-proof/v1\0'));
  const signature=sign(null,payload,device.privateKey).toString('base64url');
  assert.equal(verify(body,signature,scope,now),true);
  assert.equal(verify(challenge,signature,expected,now),false);
  for(const changed of [{...body,nativeSessionBindingDigest},{...body,audience:expected.audience},
    {...body,schema:challenge.schema},{...body,controllerBindingDigest:`sha256:${'8'.repeat(64)}`}])
    assert.equal(verify(changed,signature,scope,now),false);
});

test('recovery public protocol validates and verifies exact real Ed25519 possession, not consent or server trust', () => {
  const api = protocol();
  assert.deepEqual(api.parseDeviceSigningRecoveryChallenge(challenge, expected, now), challenge);
  assert.equal(api.verifyDeviceSigningRecoveryProof(challenge, proof(), expected, now), true);
  const wrong = generateKeyPairSync('ed25519');
  const bad = sign(null, api.deviceSigningRecoverySigningPayload(challenge), wrong.privateKey).toString('base64url');
  assert.equal(api.verifyDeviceSigningRecoveryProof(challenge, bad, expected, now), false);
});

for (const [field, value] of Object.entries({
  origin: 'https://foreign.example', recoveryId: '11111111-1111-4111-8111-111111111112',
  issuer: 'https://foreign.example', audience: 'dharma.agent-fabric.setup/v1',
  approvalId: '55555555-5555-4555-8555-555555555556', workspaceId: '66666666-6666-4666-8666-666666666667',
  organizationId: 'org_other', recipientMembershipId: '22222222-2222-4222-8222-222222222223',
  deviceId: '33333333-3333-4333-8333-333333333334', installationId: '44444444-4444-4444-8444-444444444445',
  publicKeyEd25519: generateKeyPairSync('ed25519').publicKey.export({format: 'jwk'}).x!,
  credentialEncryptionPublicKey: generateKeyPairSync('x25519').publicKey.export({format: 'jwk'}).x!,
  repositoryFingerprint: `sha256:${'2'.repeat(64)}`, policyRevision: 'foreign-v1',
  scopeDigest: `sha256:${'3'.repeat(64)}`, contractDigest: `sha256:${'4'.repeat(64)}`,
  sourceSelectionDigest: `sha256:${'6'.repeat(64)}`, nativeSessionBindingDigest: `sha256:${'7'.repeat(64)}`,
  previousAnchorHash: `sha256:${'8'.repeat(64)}`, protectedConfigDigest: `sha256:${'9'.repeat(64)}`,
  previousGeneration: 1, previousKeysetHash: `sha256:${'5'.repeat(64)}`, previousRootFingerprint: `sha256:${'6'.repeat(64)}`,
  candidateGeneration: 4, candidateKeysetHash: `sha256:${'7'.repeat(64)}`,
  candidateRootFingerprint: `sha256:${'8'.repeat(64)}`, candidateKeyVersionFingerprint: `sha256:${'9'.repeat(64)}`,
})) test(`recovery proof rejects changed ${field} against the original expected context`, () => {
  assert.equal(protocol().verifyDeviceSigningRecoveryProof({...challenge, [field]: value}, proof(), expected, now), false);
});

test('recovery signing domain binds purpose, method, path, nonce, authenticator and time', () => {
  const api = protocol(); const signature = proof();
  for (const changed of [
    {purpose: 'source_setup'}, {schema: 'dharma.setup-claim-challenge/v1'}, {method: 'GET'},
    {path: '/api/v1/agent-fabric/bootstrap/setup-claim'}, {nonce: Buffer.alloc(32, 15).toString('base64url')},
    {authenticator: Buffer.alloc(32, 16).toString('base64url')},
    {issuedAt: new Date(now - 2000).toISOString()}, {expiresAt: new Date(now + 30_000).toISOString()},
  ]) assert.equal(api.verifyDeviceSigningRecoveryProof({...challenge, ...changed}, signature, expected, now), false);
  assert.ok(api.deviceSigningRecoverySigningPayload(challenge).toString().startsWith(
    'dharma.agent-fabric.device-signing-expiry-recovery-proof/v1\0'));
  const ordinary = {schema: 'dharma.setup-claim-challenge/v1', origin: expected.origin,
    setupReference: expected.recoveryId, organizationId: expected.organizationId,
    recipientMembershipId: expected.recipientMembershipId, publicKeyEd25519: expected.publicKeyEd25519,
    credentialEncryptionPublicKey: expected.credentialEncryptionPublicKey,
    repositoryFingerprint: expected.repositoryFingerprint, mode: 'source' as const, policyRevision: expected.policyRevision,
    scopeDigest: expected.scopeDigest, contractDigest: expected.contractDigest, method: 'POST',
    path: '/api/v1/agent-fabric/bootstrap/setup-claim', nonce: challenge.nonce, authenticator: challenge.authenticator,
    issuedAt: challenge.issuedAt, expiresAt: challenge.expiresAt};
  const ordinaryProof = sign(null, contracts.setupClaimSigningPayload(ordinary), device.privateKey).toString('base64url');
  assert.equal(api.verifyDeviceSigningRecoveryProof(challenge, ordinaryProof, expected, now), false);
  assert.equal(contracts.verifySetupClaimProof(ordinary, signature, ordinary, now), false);
});

test('recovery rejects expired, future, noncanonical and overlong deadlines', () => {
  for (const changed of [
    {expiresAt: new Date(now).toISOString()}, {issuedAt: new Date(now + 1).toISOString()},
    {expiresAt: new Date(now + 900_000).toISOString()}, {issuedAt: '2026-10-17'},
    {expiresAt: 'secret-input-canary'}, {expiresAt: new Date(now - 2000).toISOString()},
  ]) assert.throws(() => protocol().parseDeviceSigningRecoveryChallenge({...challenge, ...changed}, expected, now),
    /^Error: device_signing_recovery_challenge_invalid$/);
  assert.throws(() => protocol().parseDeviceSigningRecoveryChallenge(challenge, expected, NaN),
    /^Error: device_signing_recovery_challenge_invalid$/);
});

for (const [name, changed] of Object.entries({
  zero_previous: {previousGeneration: 0}, fractional_generation: {candidateGeneration: 3.5},
  same_generation: {candidateGeneration: 2}, backwards_generation: {candidateGeneration: 1},
  unsafe_generation: {candidateGeneration: Number.MAX_SAFE_INTEGER + 1},
  unchanged_artifact: {candidateKeysetHash: expected.previousKeysetHash},
  foreign_issuer: {issuer: 'https://foreign.example'}, foreign_audience: {audience: 'other'},
  invalid_approval: {approvalId: 'guessable'}, invalid_workspace: {workspaceId: 'guessable'},
  invalid_source_selection: {sourceSelectionDigest: 'guessable'}, invalid_session_binding: {nativeSessionBindingDigest: 'guessable'},
  invalid_anchor: {previousAnchorHash: 'guessable'}, invalid_protected_config: {protectedConfigDigest: 'guessable'},
  invalid_installation: {installationId: 'guessable'}, invalid_device: {deviceId: 'guessable'},
  invalid_hash: {previousKeysetHash: 'a'.repeat(64)}, invalid_policy: {policyRevision: 'v1\nunsafe'},
  invalid_key: {publicKeyEd25519: 'a'.repeat(42)}, padded_key: {publicKeyEd25519: expected.publicKeyEd25519 + '='},
  http_origin: {origin: 'http://www.dharma-ai.io'}, credential_origin: {origin: 'https://user:secret@www.dharma-ai.io'},
  path_origin: {origin: 'https://www.dharma-ai.io/path'}, private_field: {grant: 'secret-input-canary'},
  oversized_nonce: {nonce: 'a'.repeat(100_000)},
})) test(`recovery rejects ${name} even when supplied as its expected context`, () => {
  const value = {...challenge, ...changed};
  assert.throws(() => protocol().parseDeviceSigningRecoveryChallenge(value, {...expected, ...changed}, now),
    /^Error: device_signing_recovery_challenge_invalid$/);
});

test('public recovery schema agrees with strict parser on structure and never accepts authority/credential fields', async () => {
  protocol();
  const schema = 'https://schemas.dharma-ai.io/device-signing-recovery-challenge/v1';
  const directory = resolve(import.meta.dirname, '../../../schemas');
  assert.equal((await contracts.validateContract(directory, schema, challenge)).ok, true);
  for (const extra of [{approved: true}, {token: 'secret-input-canary'}, {schema: 'foreign'}, {candidateGeneration: 0}]) {
    assert.equal((await contracts.validateContract(directory, schema, {...challenge, ...extra})).ok, false);
  }
});

test('recovery proof rejects malformed signatures and does not reflect caller secrets', () => {
  const api = protocol();
  for (const signature of ['', null, 'a'.repeat(85), proof() + '=', 'secret-input-canary', {}]) {
    assert.equal(api.verifyDeviceSigningRecoveryProof(challenge, signature, expected, now), false);
  }
  for (const value of [null, [], 'secret-input-canary']) {
    assert.throws(() => api.parseDeviceSigningRecoveryChallenge(value, expected, now),
      /^Error: device_signing_recovery_challenge_invalid$/);
  }
});

test('recovery parser copies primitives and deterministic payload ignores object insertion order', () => {
  const api = protocol(); const mutable = {...challenge};
  const parsed = api.parseDeviceSigningRecoveryChallenge(mutable, expected, now);
  mutable.nonce = Buffer.alloc(32, 99).toString('base64url');
  assert.equal(parsed.nonce, challenge.nonce);
  const reversed = Object.fromEntries(Object.entries(challenge).reverse());
  assert.deepEqual(api.deviceSigningRecoverySigningPayload(reversed), api.deviceSigningRecoverySigningPayload(challenge));
});

test('recovery rejects missing or accessor-backed fields without evaluating caller accessors', () => {
  const api = protocol(); let reads = 0;
  const withGetter = {...challenge};
  Object.defineProperty(withGetter, 'nonce', {enumerable: true, get() {reads++; throw Error('secret-input-canary');}});
  for (const value of [withGetter, {...challenge, [Symbol('extra')]: true}]) {
    assert.throws(() => api.parseDeviceSigningRecoveryChallenge(value, expected, now),
      /^Error: device_signing_recovery_challenge_invalid$/);
    assert.throws(() => api.deviceSigningRecoverySigningPayload(value),
      /^Error: device_signing_recovery_challenge_invalid$/);
  }
  assert.equal(reads, 0);
  for (const field of Object.keys(challenge)) {
    const value: Record<string, unknown> = {...challenge}; delete value[field];
    assert.throws(() => api.parseDeviceSigningRecoveryChallenge(value, expected, now),
      /^Error: device_signing_recovery_challenge_invalid$/);
  }
});

test('recovery accepts the exact bounded lifetime and monotonic jumps, but cannot replay past expiry', () => {
  const api = protocol();
  const context = {...expected, candidateGeneration: 9};
  const value = {...challenge, ...context, issuedAt: new Date(now).toISOString(), expiresAt: new Date(now + 900_000).toISOString()};
  const signature = proof(value);
  assert.equal(api.verifyDeviceSigningRecoveryProof(value, signature, context, now), true);
  assert.equal(api.verifyDeviceSigningRecoveryProof(value, signature, context, now + 899_999), true);
  assert.equal(api.verifyDeviceSigningRecoveryProof(value, signature, context, now + 900_000), false);
  assert.equal(api.verifyDeviceSigningRecoveryProof(value, signature, context, now - 1), false);
});

test('recovery structural schema rejects invalid origins, noncanonical bytes and unsafe generations', async () => {
  const directory = resolve(import.meta.dirname, '../../../schemas');
  const schema = 'https://schemas.dharma-ai.io/device-signing-recovery-challenge/v1';
  for (const change of [
    {origin: 'https://user:secret@www.dharma-ai.io'}, {origin: 'https://www.dharma-ai.io/path'},
    {origin: 'http://www.dharma-ai.io'}, {origin: 'https://www.dharma-ai.io?x=1'},
    {nonce: 'A'.repeat(42) + 'B'}, {authenticator: challenge.authenticator + '='},
    {deviceId: '33333333-3333-4333-0333-333333333333'},
    {candidateGeneration: Number.MAX_SAFE_INTEGER + 1}, {previousGeneration: 0},
  ]) assert.equal((await contracts.validateContract(directory, schema, {...challenge, ...change})).ok, false);
});

test('recovery rejects trailing-newline identifiers and digests in both runtime and structural schema', async () => {
  const directory = resolve(import.meta.dirname, '../../../schemas');
  const schema = 'https://schemas.dharma-ai.io/device-signing-recovery-challenge/v1';
  const fields = ['recoveryId', 'organizationId', 'recipientMembershipId', 'deviceId', 'installationId', 'workspaceId',
    'approvalId', 'repositoryFingerprint', 'policyRevision', 'scopeDigest', 'contractDigest', 'sourceSelectionDigest',
    'nativeSessionBindingDigest', 'previousAnchorHash', 'protectedConfigDigest', 'previousKeysetHash',
    'previousRootFingerprint', 'candidateKeysetHash', 'candidateRootFingerprint', 'candidateKeyVersionFingerprint'] as const;
  for (const field of fields) for (const suffix of ['\n', '\r\n']) {
    const change = {[field]: expected[field] + suffix};
    assert.throws(() => protocol().parseDeviceSigningRecoveryChallenge({...challenge, ...change}, {...expected, ...change}, now),
      /^Error: device_signing_recovery_challenge_invalid$/, field);
    assert.equal((await contracts.validateContract(directory, schema, {...challenge, ...change})).ok, false, field);
  }
});
