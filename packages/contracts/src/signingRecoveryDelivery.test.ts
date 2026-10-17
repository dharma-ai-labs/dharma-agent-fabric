import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createHash, generateKeyPairSync } from 'node:crypto';
import test from 'node:test';
import { canonicalize, signCanonicalObject } from './index.js';
import { openSetupClaimCredential, sealSetupClaimCredential } from './setupClaimCredential.js';
import type { SetupClaimChallenge } from './setupClaim.js';
import type { DeviceSigningRecoveryChallenge } from './signingRecovery.js';
import { openDeviceSigningRecoveryDelivery, sealDeviceSigningRecoveryDelivery } from './signingRecoveryDelivery.js';

const now = Date.parse('2030-01-01T00:00:00.000Z');
const id = (n: number) => `a0000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const hash = (v: string | Buffer) => 'sha256:' + createHash('sha256').update(v).digest('hex');
const fixed = (c: string) => 'sha256:' + c.repeat(64);
function fixture() {
  const encryption = generateKeyPairSync('x25519'), root = generateKeyPairSync('ed25519');
  const rootPublicKey = root.publicKey.export({format: 'jwk'}).x!;
  const keyVersion = 'projects/synthetic/locations/global/keyRings/fabric/cryptoKeys/server/cryptoKeyVersions/3';
  const unsigned = {schema: 'dharma.server-signing-keyset/v1' as const, organizationId: 'org_fixture', generation: 3,
    keys: [{keyVersion, publicKeyEd25519: rootPublicKey, status: 'active' as const,
      notBefore: new Date(now).toISOString(), notAfter: new Date(now + 7 * 86400000).toISOString()}],
    signedByKeyVersion: keyVersion, issuedAt: new Date(now).toISOString(), expiresAt: new Date(now + 7 * 86400000).toISOString()};
  const keyset = {...unsigned, signature: signCanonicalObject(unsigned, root.privateKey)};
  const challenge: DeviceSigningRecoveryChallenge = {
    schema: 'dharma.device-signing-recovery-challenge/v1', purpose: 'expired_signing_trust_reapproval',
    origin: 'https://www.dharma-ai.io', issuer: 'https://www.dharma-ai.io', audience: 'dharma.agent-fabric.signing-recovery/v1',
    recoveryId: id(1), approvalId: id(2), organizationId: 'org_fixture', recipientMembershipId: id(3), deviceId: id(4),
    installationId: id(5), workspaceId: id(6), publicKeyEd25519: generateKeyPairSync('ed25519').publicKey.export({format: 'jwk'}).x!,
    credentialEncryptionPublicKey: encryption.publicKey.export({format: 'jwk'}).x!, repositoryFingerprint: fixed('a'),
    policyRevision: 'agent-fabric-policy-v1', scopeDigest: fixed('b'), contractDigest: fixed('c'),
    sourceSelectionDigest: fixed('d'), nativeSessionBindingDigest: fixed('e'), previousAnchorHash: fixed('1'),
    protectedConfigDigest: fixed('2'), previousGeneration: 2, previousKeysetHash: fixed('3'), previousRootFingerprint: fixed('4'),
    candidateGeneration: 3, candidateKeysetHash: hash(canonicalize(keyset)), candidateRootFingerprint: hash(Buffer.from(rootPublicKey, 'base64url')),
    candidateKeyVersionFingerprint: hash(keyVersion), method: 'POST', path: '/api/v1/agent-fabric/signing-recovery',
    nonce: Buffer.alloc(32, 7).toString('base64url'), authenticator: Buffer.alloc(32, 8).toString('base64url'),
    issuedAt: new Date(now).toISOString(), expiresAt: new Date(now + 600000).toISOString(),
  };
  const candidate = {schema: 'dharma.device-signing-recovery-candidate/v1' as const,
    organizationId: challenge.organizationId, recoveryId: id(1), approvalId: id(2),
    keysetCanonical: canonicalize(keyset), rootPublicKey,
    publication: {schema: 'dharma.signing-recovery-publication/v1' as const, organizationId: challenge.organizationId,
      recoveryId: id(1), generation: 3, artifactHash: fixed('f'), publishedAt: new Date(now).toISOString()}};
  return {encryption, root, challenge, candidate, keyset};
}
const unavailable = /^Error: device_signing_recovery_delivery_unavailable$/;

test('versioned wire schemas agree with runtime objects and reject secret/credential fields', async () => {
  const require=createRequire(import.meta.url),Ajv=require('ajv/dist/2020').default,addFormats=require('ajv-formats').default;
  const ajv=new Ajv({strict:true,allErrors:true});addFormats(ajv);
  const delivery=ajv.compile(JSON.parse(await readFile(new URL('../../../schemas/device-signing-recovery-delivery.schema.json',import.meta.url),'utf8')));
  const candidateSchema=ajv.compile(JSON.parse(await readFile(new URL('../../../schemas/device-signing-recovery-candidate.schema.json',import.meta.url),'utf8')));
  const f=fixture(),sealed=sealDeviceSigningRecoveryDelivery(f.challenge,f.candidate,now);
  assert.equal(delivery(sealed),true);assert.equal(candidateSchema(f.candidate),true);
  for(const extra of [{token:'SYNTHETIC_PRIVATE_SENTINEL'},{grant:'SYNTHETIC_GRANT_SENTINEL'},{privateKey:'SYNTHETIC_PRIVATE_KEY_SENTINEL'}]){
    assert.equal(delivery({...sealed,...extra}),false);assert.equal(candidateSchema({...f.candidate,...extra}),false);
  }
  for(const field of ['organizationId','rootPublicKey'] as const)assert.equal(candidateSchema({...f.candidate,[field]:f.candidate[field]+'\n'}),false);
  assert.equal(candidateSchema({...f.candidate,publication:{...f.candidate.publication,artifactHash:fixed('f')+'\n'}}),false);
  for(const field of ['organizationId','ephemeralPublicKey','iv','ciphertext','tag','contextDigest'] as const)
    assert.equal(delivery({...sealed,[field]:sealed[field]+'\n'}),false);
  for(const field of ['recoveryId','approvalId','deviceId'] as const)assert.equal(delivery({...sealed,[field]:sealed[field]+'\n'}),false);
});

test('only the exact native recipient decrypts the purpose-bound candidate; it is not install authority', () => {
  const f = fixture(), sealed = sealDeviceSigningRecoveryDelivery(f.challenge, f.candidate, now);
  const serialized = JSON.stringify(sealed);
  assert.equal(serialized.includes(f.candidate.keysetCanonical), false);
  assert.equal(serialized.includes(f.candidate.rootPublicKey), false);
  assert.deepEqual(openDeviceSigningRecoveryDelivery(f.challenge, sealed, f.encryption.privateKey, f.challenge, now), f.candidate);
  assert.throws(() => openDeviceSigningRecoveryDelivery(f.challenge, sealed, generateKeyPairSync('x25519').privateKey, f.challenge, now), unavailable);
  assert.throws(() => openDeviceSigningRecoveryDelivery(f.challenge, sealed, f.root.privateKey, f.challenge, now), unavailable);
});

test('fresh sealing is randomized and old setup-credential responses cannot cross purpose', () => {
  const f = fixture(), first = sealDeviceSigningRecoveryDelivery(f.challenge, f.candidate, now), second = sealDeviceSigningRecoveryDelivery(f.challenge, f.candidate, now);
  assert.notEqual(first.ephemeralPublicKey, second.ephemeralPublicKey); assert.notEqual(first.ciphertext, second.ciphertext);
  const setup: SetupClaimChallenge = {schema:'dharma.setup-claim-challenge/v1', origin:f.challenge.origin,
    setupReference:f.challenge.recoveryId, organizationId:f.challenge.organizationId, recipientMembershipId:f.challenge.recipientMembershipId,
    publicKeyEd25519:f.challenge.publicKeyEd25519, credentialEncryptionPublicKey:f.challenge.credentialEncryptionPublicKey,
    repositoryFingerprint:f.challenge.repositoryFingerprint, mode:'source', policyRevision:f.challenge.policyRevision,
    scopeDigest:f.challenge.scopeDigest, contractDigest:f.challenge.contractDigest, method:'POST', path:'/api/v1/agent-fabric/bootstrap/setup-claim',
    nonce:f.challenge.nonce, authenticator:f.challenge.authenticator, issuedAt:f.challenge.issuedAt, expiresAt:f.challenge.expiresAt};
  const old = sealSetupClaimCredential(setup, 'SYNTHETIC_OLD_CREDENTIAL_CANARY');
  assert.throws(() => openDeviceSigningRecoveryDelivery(f.challenge, old, f.encryption.privateKey, f.challenge, now), unavailable);
  assert.throws(() => openSetupClaimCredential(setup, first, f.encryption.privateKey), /^Error: setup_claim_credential_unavailable$/);
});

test('encryption authenticates context, ciphertext and metadata without echoing input', () => {
  const f = fixture(), sealed = sealDeviceSigningRecoveryDelivery(f.challenge, f.candidate, now);
  for (const [field, value] of Object.entries({organizationId:'org_foreign', recoveryId:id(20), approvalId:id(21), deviceId:id(22),
    schema:'dharma.setup-claim-credential/v1', issuedAt:new Date(now-1).toISOString(), expiresAt:new Date(now+1).toISOString(),
    contextDigest:fixed('0'), iv:Buffer.alloc(12).toString('base64url'), tag:Buffer.alloc(16).toString('base64url'),
    ciphertext:Buffer.alloc(64).toString('base64url'), ephemeralPublicKey:generateKeyPairSync('x25519').publicKey.export({format:'jwk'}).x!})) {
    assert.throws(() => openDeviceSigningRecoveryDelivery(f.challenge,{...sealed,[field]:value},f.encryption.privateKey,f.challenge,now),unavailable,field);
  }
  for (const [field,value] of Object.entries({workspaceId:id(23),installationId:id(24),recipientMembershipId:id(25),
    repositoryFingerprint:fixed('0'),policyRevision:'other-policy',protectedConfigDigest:fixed('0'),
    previousAnchorHash:fixed('0'),nativeSessionBindingDigest:fixed('0'),sourceSelectionDigest:fixed('0')})) {
    const changed={...f.challenge,[field]:value};
    assert.throws(() => openDeviceSigningRecoveryDelivery(changed,sealed,f.encryption.privateKey,changed,now),unavailable,field);
    assert.throws(() => openDeviceSigningRecoveryDelivery(changed,sealed,f.encryption.privateKey,f.challenge,now),unavailable,field+' expected context');
  }
});

test('only the approved candidate and exact publication metadata may be sealed', () => {
  const f=fixture();
  for (const bad of [{...f.candidate,organizationId:'org_foreign'},{...f.candidate,recoveryId:id(30)},
    {...f.candidate,approvalId:id(31)},{...f.candidate,rootPublicKey:generateKeyPairSync('ed25519').publicKey.export({format:'jwk'}).x!},
    {...f.candidate,keysetCanonical:JSON.stringify({...f.keyset,signature:'SYNTHETIC_BAD_SIGNATURE'})},
    {...f.candidate,publication:{...f.candidate.publication,recoveryId:id(32)}},
    {...f.candidate,publication:{...f.candidate.publication,generation:4}},
    {...f.candidate,publication:{...f.candidate.publication,publishedAt:new Date(now+1).toISOString()}},
    {...f.candidate,publication:{...f.candidate.publication,artifactHash:'latest'}},
    {...f.candidate,publication:{...f.candidate.publication,artifactHash:fixed('f')+'\n'}},
    {...f.candidate,credential:'SYNTHETIC_CREDENTIAL_CANARY'}]) {
    assert.throws(()=>sealDeviceSigningRecoveryDelivery(f.challenge,bad,now),unavailable);
  }
});

test('expiry, malformed envelopes, getters and proxies fail closed before unsafe access', () => {
  const f=fixture(),sealed=sealDeviceSigningRecoveryDelivery(f.challenge,f.candidate,now);
  assert.throws(()=>sealDeviceSigningRecoveryDelivery(f.challenge,f.candidate,now+600000),unavailable);
  assert.throws(()=>openDeviceSigningRecoveryDelivery(f.challenge,sealed,f.encryption.privateKey,f.challenge,now+600000),unavailable);
  for(const bad of [null,[],{...sealed,extra:'SYNTHETIC_PRIVATE_SENTINEL'},{...sealed,ciphertext:'A'.repeat(50000)},
    {...sealed,ephemeralPublicKey:Buffer.alloc(32).toString('base64url')}]) {
    assert.throws(()=>openDeviceSigningRecoveryDelivery(f.challenge,bad,f.encryption.privateKey,f.challenge,now),unavailable);
  }
  let reads=0;const accessor={...sealed};Object.defineProperty(accessor,'ciphertext',{enumerable:true,get(){reads++;throw Error('SYNTHETIC_PRIVATE_SENTINEL');}});
  assert.throws(()=>openDeviceSigningRecoveryDelivery(f.challenge,accessor,f.encryption.privateKey,f.challenge,now),unavailable);
  const proxy=new Proxy(sealed,{ownKeys(){reads++;throw Error('SYNTHETIC_PRIVATE_SENTINEL');}});
  assert.throws(()=>openDeviceSigningRecoveryDelivery(f.challenge,proxy,f.encryption.privateKey,f.challenge,now),unavailable);
  assert.equal(reads,0);
});

test('control characters in any supplied recovery context are rejected before sealing',()=>{
  const f=fixture();
  for(const field of ['organizationId','recoveryId','approvalId','deviceId','installationId','workspaceId',
    'policyRevision','repositoryFingerprint','nativeSessionBindingDigest','sourceSelectionDigest','previousAnchorHash'] as const){
    const challenge={...f.challenge,[field]:f.challenge[field]+'\n'};
    assert.throws(()=>sealDeviceSigningRecoveryDelivery(challenge,f.candidate,now),unavailable,field);
  }
});
