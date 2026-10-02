import { createCipheriv, createDecipheriv, createHash, createPublicKey, diffieHellman,
  generateKeyPairSync, hkdfSync, randomBytes, type KeyObject } from 'node:crypto';
import { setupClaimSigningPayload, type SetupClaimChallenge } from './setupClaim.js';

export interface SealedSetupClaimCredential {
  schema: 'dharma.setup-claim-credential/v1';
  organizationId: string;
  setupReference: string;
  issuedAt: string;
  expiresAt: string;
  ephemeralPublicKey: string;
  iv: string;
  ciphertext: string;
  tag: string;
  contextDigest: string;
}
const KEYS = ['schema', 'organizationId', 'setupReference', 'issuedAt', 'expiresAt', 'ephemeralPublicKey', 'iv', 'ciphertext', 'tag', 'contextDigest'];
const fail = (): never => { throw new Error('setup_claim_credential_unavailable'); };
function decode(value: unknown, size: number): Buffer {
  if (typeof value !== 'string' || value.length !== Math.ceil(size * 4 / 3)
    || !/^[A-Za-z0-9_-]+$/.test(value)) return fail();
  const decoded = Buffer.from(value, 'base64url');
  if (decoded.length !== size || decoded.toString('base64url') !== value) return fail();
  return decoded;
}
function peer(value: string): KeyObject {
  decode(value, 32);
  return createPublicKey({ format: 'jwk', key: { kty: 'OKP', crv: 'X25519', x: value } });
}
function derive(privateKey: KeyObject, publicKey: KeyObject, context: Buffer): Buffer {
  if (privateKey.type !== 'private' || privateKey.asymmetricKeyType !== 'x25519') return fail();
  const shared = diffieHellman({ privateKey, publicKey });
  try {
    return Buffer.from(hkdfSync('sha256', shared, createHash('sha256').update(context).digest(),
      Buffer.from('dharma.setup-claim-credential/v1'), 32));
  } finally { shared.fill(0); }
}

/** Confidential response layer, NOT authorization. The caller must first verify
 * live setup scope, device proof, recipient approval and atomic consumption.
 * Neither a public reference nor a replayed signed request can decrypt this. */
export function sealSetupClaimCredential(challenge: SetupClaimChallenge, credential: string): SealedSetupClaimCredential {
  let plaintext: Buffer | null = null;
  let key: Buffer | null = null;
  try {
    if (typeof credential !== 'string' || !credential || Buffer.byteLength(credential, 'utf8') > 8192) return fail();
    const context = setupClaimSigningPayload(challenge);
    const pair = generateKeyPairSync('x25519');
    key = derive(pair.privateKey, peer(challenge.credentialEncryptionPublicKey), context);
    plaintext = Buffer.from(credential, 'utf8');
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(context);
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return {
      schema: 'dharma.setup-claim-credential/v1', organizationId: challenge.organizationId,
      setupReference: challenge.setupReference, issuedAt: challenge.issuedAt, expiresAt: challenge.expiresAt,
      ephemeralPublicKey: pair.publicKey.export({ format: 'jwk' }).x!,
      iv: iv.toString('base64url'), ciphertext: ciphertext.toString('base64url'),
      tag: cipher.getAuthTag().toString('base64url'),
      contextDigest: 'sha256:' + createHash('sha256').update(context).digest('hex'),
    };
  } catch { return fail(); }
  finally { plaintext?.fill(0); key?.fill(0); }
}

/** Native memory only. Caller validates the decrypted credential and writes it
 * directly to the existing protected store; never return it as command output. */
export function openSetupClaimCredential(challenge: SetupClaimChallenge, value: unknown, privateKey: KeyObject): string {
  let key: Buffer | null = null;
  let plaintext: Buffer | null = null;
  try {
    const context = setupClaimSigningPayload(challenge);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return fail();
    const body = value as Record<string, unknown>;
    if (Object.keys(body).sort().join('\0') !== [...KEYS].sort().join('\0')
      || body.schema !== 'dharma.setup-claim-credential/v1'
      || body.organizationId !== challenge.organizationId || body.setupReference !== challenge.setupReference
      || body.issuedAt !== challenge.issuedAt || body.expiresAt !== challenge.expiresAt
      || body.contextDigest !== 'sha256:' + createHash('sha256').update(context).digest('hex')
      || typeof body.ciphertext !== 'string' || !body.ciphertext || body.ciphertext.length > Math.ceil(8192 * 4 / 3)
      || !/^[A-Za-z0-9_-]+$/.test(body.ciphertext)) return fail();
    if (privateKey.type !== 'private' || privateKey.asymmetricKeyType !== 'x25519'
      || createPublicKey(privateKey).export({ format: 'jwk' }).x !== challenge.credentialEncryptionPublicKey) return fail();
    const ciphertext = Buffer.from(body.ciphertext, 'base64url');
    if (ciphertext.length > 8192 || ciphertext.toString('base64url') !== body.ciphertext) return fail();
    key = derive(privateKey, peer(String(body.ephemeralPublicKey)), context);
    const decipher = createDecipheriv('aes-256-gcm', key, decode(body.iv, 12));
    decipher.setAAD(context);
    decipher.setAuthTag(decode(body.tag, 16));
    plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return plaintext.toString('utf8');
  } catch { return fail(); }
  finally { plaintext?.fill(0); key?.fill(0); }
}
