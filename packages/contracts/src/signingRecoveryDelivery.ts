import { createCipheriv, createDecipheriv, createHash, createPublicKey, diffieHellman,
  generateKeyPairSync, hkdfSync, KeyObject, randomBytes } from 'node:crypto';
import { types } from 'node:util';
import { canonicalize, validateTrustedServerSigningKeysetContract, verifyInitialServerSigningKeyset,
  type TrustedServerSigningKeyset } from './index.js';
import { deviceSigningRecoverySigningPayload, parseDeviceSigningRecoveryChallenge,
  type DeviceSigningRecoveryChallenge, type DeviceSigningRecoveryContext } from './signingRecovery.js';

export interface DeviceSigningRecoveryCandidate {
  schema: 'dharma.device-signing-recovery-candidate/v1';
  organizationId: string; recoveryId: string; approvalId: string;
  keysetCanonical: string; rootPublicKey: string;
  publication: { schema: 'dharma.signing-recovery-publication/v1'; organizationId: string;
    recoveryId: string; generation: number; artifactHash: string; publishedAt: string };
}
export interface SealedDeviceSigningRecoveryDelivery {
  schema: 'dharma.device-signing-recovery-delivery/v1';
  organizationId: string; recoveryId: string; approvalId: string; deviceId: string;
  issuedAt: string; expiresAt: string; ephemeralPublicKey: string;
  iv: string; ciphertext: string; tag: string; contextDigest: string;
}
const DOMAIN = 'dharma.device-signing-recovery-delivery/v1';
const MAX_BYTES = 32768;
const CANDIDATE_KEYS = ['schema','organizationId','recoveryId','approvalId','keysetCanonical','rootPublicKey','publication'];
const PUBLICATION_KEYS = ['schema','organizationId','recoveryId','generation','artifactHash','publishedAt'];
const DELIVERY_KEYS = ['schema','organizationId','recoveryId','approvalId','deviceId','issuedAt','expiresAt',
  'ephemeralPublicKey','iv','ciphertext','tag','contextDigest'];
const HASH = /^sha256:[a-f0-9]{64}$(?![\s\S])/;
const unavailable = (): never => { throw Error('device_signing_recovery_delivery_unavailable'); };
const digest = (bytes: string | Buffer) => 'sha256:' + createHash('sha256').update(bytes).digest('hex');
function record(value: unknown, expectedKeys?: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || types.isProxy(value)
    || ![null,Object.prototype].includes(Object.getPrototypeOf(value)) || Object.getOwnPropertySymbols(value).length) return unavailable();
  const names = Object.getOwnPropertyNames(value);
  if (names.length > 64 || expectedKeys && names.sort().join('\0') !== [...expectedKeys].sort().join('\0')) return unavailable();
  const fields = Object.getOwnPropertyDescriptors(value), result: Record<string, unknown> = {};
  for (const name of names) {
    const field = fields[name];
    if (!field?.enumerable || !Object.hasOwn(field,'value')) return unavailable();
    Object.defineProperty(result,name,{enumerable:true,value:field.value});
  }
  return result;
}
function decode(value: unknown, size: number): Buffer {
  if (typeof value !== 'string' || value.length !== Math.ceil(size * 4 / 3) || !/^[A-Za-z0-9_-]+$/.test(value)) return unavailable();
  const bytes = Buffer.from(value,'base64url');
  if (bytes.length !== size || bytes.toString('base64url') !== value) return unavailable();
  return bytes;
}
function timestamp(value: unknown): number {
  if (typeof value !== 'string' || value.length > 40) return unavailable();
  const result = Date.parse(value);
  if (!Number.isFinite(result) || new Date(result).toISOString() !== value) return unavailable();
  return result;
}
function checkedChallenge(value: unknown, expected: DeviceSigningRecoveryContext, now: number) {
  const safe = record(value), scope = record(expected);
  for (const field of [...Object.values(safe),...Object.values(scope)]) {
    if (typeof field === 'string' && /[\x00-\x1f\x7f]/.test(field)) return unavailable();
  }
  return parseDeviceSigningRecoveryChallenge(safe,scope as unknown as DeviceSigningRecoveryContext,now);
}
function context(challenge: DeviceSigningRecoveryChallenge): Buffer {
  return Buffer.concat([Buffer.from(DOMAIN+'\0'),deviceSigningRecoverySigningPayload(challenge)]);
}
function peer(value: unknown): KeyObject {
  decode(value,32);
  return createPublicKey({format:'jwk',key:{kty:'OKP',crv:'X25519',x:value as string}});
}
function derive(privateKey: KeyObject, publicKey: KeyObject, aad: Buffer): Buffer {
  if (types.isProxy(privateKey) || !(privateKey instanceof KeyObject) || privateKey.type !== 'private' || privateKey.asymmetricKeyType !== 'x25519') return unavailable();
  const shared = diffieHellman({privateKey,publicKey});
  try { return Buffer.from(hkdfSync('sha256',shared,createHash('sha256').update(aad).digest(),Buffer.from(DOMAIN),32)); }
  finally { shared.fill(0); }
}
function candidate(value: unknown, challenge: DeviceSigningRecoveryChallenge, now: number): DeviceSigningRecoveryCandidate {
  const body = record(value,CANDIDATE_KEYS), publication = record(body.publication,PUBLICATION_KEYS);
  if (body.schema !== 'dharma.device-signing-recovery-candidate/v1' || body.organizationId !== challenge.organizationId
    || body.recoveryId !== challenge.recoveryId || body.approvalId !== challenge.approvalId
    || typeof body.keysetCanonical !== 'string' || Buffer.byteLength(body.keysetCanonical,'utf8') > 16384
    || typeof body.rootPublicKey !== 'string' || digest(decode(body.rootPublicKey,32)) !== challenge.candidateRootFingerprint
    || challenge.candidateRootFingerprint === challenge.previousRootFingerprint
    || challenge.candidateGeneration !== challenge.previousGeneration+1
    || digest(body.keysetCanonical) !== challenge.candidateKeysetHash) return unavailable();
  const parsed: unknown = JSON.parse(body.keysetCanonical);
  if (!validateTrustedServerSigningKeysetContract(parsed).ok || canonicalize(parsed) !== body.keysetCanonical) return unavailable();
  const keyset = parsed as TrustedServerSigningKeyset, key = keyset.keys[0];
  const issued = timestamp(keyset.issuedAt), expiry = timestamp(keyset.expiresAt);
  if (keyset.organizationId !== challenge.organizationId || keyset.generation !== challenge.candidateGeneration
    || keyset.keys.length !== 1 || !key || key.status !== 'active' || key.publicKeyEd25519 !== body.rootPublicKey
    || key.keyVersion !== keyset.signedByKeyVersion || digest(key.keyVersion) !== challenge.candidateKeyVersionFingerprint
    || issued > now || expiry <= now || expiry <= issued || expiry-issued > 29*86400000
    || timestamp(key.notBefore) > issued || timestamp(key.notAfter) < expiry) return unavailable();
  const root = createPublicKey({format:'jwk',key:{kty:'OKP',crv:'Ed25519',x:body.rootPublicKey}});
  if (!verifyInitialServerSigningKeyset(keyset,root,challenge.organizationId,new Date(now)).ok) return unavailable();
  if (publication.schema !== 'dharma.signing-recovery-publication/v1' || publication.organizationId !== challenge.organizationId
    || publication.recoveryId !== challenge.recoveryId || publication.generation !== challenge.candidateGeneration
    || typeof publication.artifactHash !== 'string' || !HASH.test(publication.artifactHash)) return unavailable();
  const published = timestamp(publication.publishedAt);
  if (published < timestamp(challenge.issuedAt) || published >= timestamp(challenge.expiresAt) || published > now) return unavailable();
  return Object.freeze({...body,publication:Object.freeze({...publication})}) as unknown as DeviceSigningRecoveryCandidate;
}

/** Structural/signature verification only, never consent or install authority. */
export function parseDeviceSigningRecoveryCandidate(value: unknown, challenge: DeviceSigningRecoveryChallenge,
  expected: DeviceSigningRecoveryContext, now: number): DeviceSigningRecoveryCandidate {
  try {return candidate(value,checkedChallenge(challenge,expected,now),now);}
  catch {return unavailable();}
}

/** Confidentiality only, NOT installation authority. The server must first
 * validate live scope, device proof, both consents, signer and atomic publication.
 * No grant, token or private key is a field of this recovery payload. */
export function sealDeviceSigningRecoveryDelivery(value: DeviceSigningRecoveryChallenge,
  payload: unknown, now = Date.now()): SealedDeviceSigningRecoveryDelivery {
  let key: Buffer | null = null, plaintext: Buffer | null = null;
  try {
    const challenge = checkedChallenge(value,value,now), checked = candidate(payload,challenge,now), aad = context(challenge);
    plaintext = Buffer.from(canonicalize(checked),'utf8'); if (plaintext.length > MAX_BYTES) return unavailable();
    const ephemeral = generateKeyPairSync('x25519'); key = derive(ephemeral.privateKey,peer(challenge.credentialEncryptionPublicKey),aad);
    const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm',key,iv); cipher.setAAD(aad);
    const ciphertext = Buffer.concat([cipher.update(plaintext),cipher.final()]);
    return Object.freeze({schema:DOMAIN,organizationId:challenge.organizationId,recoveryId:challenge.recoveryId,
      approvalId:challenge.approvalId,deviceId:challenge.deviceId,issuedAt:challenge.issuedAt,expiresAt:challenge.expiresAt,
      ephemeralPublicKey:ephemeral.publicKey.export({format:'jwk'}).x!,iv:iv.toString('base64url'),
      ciphertext:ciphertext.toString('base64url'),tag:cipher.getAuthTag().toString('base64url'),contextDigest:digest(aad)});
  } catch { return unavailable(); }
  finally { key?.fill(0); plaintext?.fill(0); }
}

/** Native memory only. Decryption/signature validity is NOT consent, a current
 * server-publication lookup, a protected-state CAS or permission to install.
 * The owning host supplies expected context, never task/model fields. */
export function openDeviceSigningRecoveryDelivery(value: DeviceSigningRecoveryChallenge, envelope: unknown,
  privateKey: KeyObject, expected: DeviceSigningRecoveryContext, now = Date.now()): DeviceSigningRecoveryCandidate {
  let key: Buffer | null = null, plaintext: Buffer | null = null;
  try {
    const challenge = checkedChallenge(value,expected,now), aad = context(challenge), body = record(envelope,DELIVERY_KEYS);
    if (body.schema !== DOMAIN || body.organizationId !== challenge.organizationId || body.recoveryId !== challenge.recoveryId
      || body.approvalId !== challenge.approvalId || body.deviceId !== challenge.deviceId
      || body.issuedAt !== challenge.issuedAt || body.expiresAt !== challenge.expiresAt || body.contextDigest !== digest(aad)
      || typeof body.ciphertext !== 'string' || !body.ciphertext || body.ciphertext.length > Math.ceil(MAX_BYTES*4/3)
      || !/^[A-Za-z0-9_-]+$/.test(body.ciphertext) || types.isProxy(privateKey) || !(privateKey instanceof KeyObject)
      || privateKey.type !== 'private' || privateKey.asymmetricKeyType !== 'x25519'
      || createPublicKey(privateKey).export({format:'jwk'}).x !== challenge.credentialEncryptionPublicKey) return unavailable();
    const ciphertext = Buffer.from(body.ciphertext,'base64url');
    if (ciphertext.length > MAX_BYTES || ciphertext.toString('base64url') !== body.ciphertext) return unavailable();
    key = derive(privateKey,peer(body.ephemeralPublicKey),aad);
    const decipher = createDecipheriv('aes-256-gcm',key,decode(body.iv,12)); decipher.setAAD(aad); decipher.setAuthTag(decode(body.tag,16));
    plaintext = Buffer.concat([decipher.update(ciphertext),decipher.final()]);
    if (plaintext.length > MAX_BYTES) return unavailable();
    const decoded = new TextDecoder('utf-8',{fatal:true}).decode(plaintext), parsed: unknown = JSON.parse(decoded);
    if (canonicalize(parsed) !== decoded) return unavailable();
    return candidate(parsed,challenge,now);
  } catch { return unavailable(); }
  finally { key?.fill(0); plaintext?.fill(0); }
}
