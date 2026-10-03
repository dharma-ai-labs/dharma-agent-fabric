import { createPublicKey, verify } from 'node:crypto';

export interface SetupClaimContext {
  origin: string;
  setupReference: string;
  organizationId: string;
  recipientMembershipId: string;
  publicKeyEd25519: string;
  credentialEncryptionPublicKey: string;
  repositoryFingerprint: string;
  mode: 'source' | 'join';
  policyRevision: string;
  scopeDigest: string;
  contractDigest: string;
}

export interface SetupClaimChallenge extends SetupClaimContext {
  schema: 'dharma.setup-claim-challenge/v1';
  method: 'POST';
  path: '/api/v1/agent-fabric/bootstrap/setup-claim';
  nonce: string;
  issuedAt: string;
  expiresAt: string;
  authenticator: string;
}

const CONTEXT_KEYS = ['origin', 'setupReference', 'organizationId', 'recipientMembershipId',
  'publicKeyEd25519', 'credentialEncryptionPublicKey', 'repositoryFingerprint', 'mode', 'policyRevision', 'scopeDigest', 'contractDigest'] as const;
const KEYS = ['schema', ...CONTEXT_KEYS, 'method', 'path', 'nonce', 'issuedAt', 'expiresAt', 'authenticator'] as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const invalid = (): never => { throw new Error('setup_claim_challenge_invalid'); };

function bytes(value: unknown, size: number): boolean {
  if (typeof value !== 'string' || value.length !== Math.ceil(size * 4 / 3)
    || !/^[A-Za-z0-9_-]+$/.test(value)) return false;
  const decoded = Buffer.from(value, 'base64url');
  return decoded.length === size && decoded.toString('base64url') === value;
}

/** Strict public protocol validation; this is NOT server-authenticator verification
 * or enrollment authority. The server must validate its authenticator, live row,
 * recipient browser approval and atomic consumption separately. */
export function parseSetupClaimChallenge(value: unknown, expected: SetupClaimContext, now: number): SetupClaimChallenge {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
    const body = value as Record<string, unknown>;
    if (Object.keys(body).sort().join('\0') !== [...KEYS].sort().join('\0')) invalid();
    for (const key of KEYS) if (typeof body[key] !== 'string' || String(body[key]).length > 256) invalid();
    for (const key of CONTEXT_KEYS) if (body[key] !== expected[key]) invalid();
    if (body.schema !== 'dharma.setup-claim-challenge/v1' || body.method !== 'POST'
      || body.path !== '/api/v1/agent-fabric/bootstrap/setup-claim') invalid();
    const url = new URL(String(body.origin));
    if (url.protocol !== 'https:' || url.username || url.password || url.origin !== body.origin) invalid();
    if (!UUID.test(String(body.setupReference)) || !UUID.test(String(body.recipientMembershipId))
      || !/^org_[A-Za-z0-9]+$/.test(String(body.organizationId))
      || !bytes(body.publicKeyEd25519, 32) || !bytes(body.credentialEncryptionPublicKey, 32)
      || !bytes(body.nonce, 32) || !bytes(body.authenticator, 32)
      || !DIGEST.test(String(body.repositoryFingerprint)) || !DIGEST.test(String(body.scopeDigest))
      || !DIGEST.test(String(body.contractDigest)) || !['source', 'join'].includes(String(body.mode))
      || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(String(body.policyRevision))) invalid();
    const issued = Date.parse(String(body.issuedAt));
    const expiry = Date.parse(String(body.expiresAt));
    if (!Number.isFinite(now) || !Number.isFinite(issued) || !Number.isFinite(expiry)
      || new Date(issued).toISOString() !== body.issuedAt || new Date(expiry).toISOString() !== body.expiresAt
      || issued > now || expiry <= now || expiry <= issued || expiry - issued > 900_000) invalid();
    // Copy the allowlisted fields; do not retain arbitrary caller object state.
    return Object.fromEntries(KEYS.map(key => [key, body[key]])) as unknown as SetupClaimChallenge;
  } catch { return invalid(); }
}

export function setupClaimSigningPayload(value: unknown): Buffer {
  try {
    const candidate = value as SetupClaimChallenge;
    const expected = Object.fromEntries(CONTEXT_KEYS.map(key => [key, candidate[key]])) as unknown as SetupClaimContext;
    const body = parseSetupClaimChallenge(candidate, expected, Date.parse(candidate.issuedAt));
    // Fixed ordered pairs avoid cross-serializer object-order differences.
    return Buffer.from('dharma.agent-fabric.setup-claim-proof/v1\0'
      + JSON.stringify(KEYS.map(key => [key, body[key]])), 'utf8');
  } catch { return invalid(); }
}

export function verifySetupClaimProof(value: unknown, signature: unknown, expected: SetupClaimContext, now: number): boolean {
  try {
    const body = parseSetupClaimChallenge(value, expected, now);
    if (!bytes(signature, 64)) return false;
    const key = createPublicKey({ format: 'jwk', key: { kty: 'OKP', crv: 'Ed25519', x: body.publicKeyEd25519 } });
    return verify(null, setupClaimSigningPayload(body), key, Buffer.from(signature as string, 'base64url'));
  } catch { return false; }
}
