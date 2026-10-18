import { createPublicKey, verify } from 'node:crypto';
import { types } from 'node:util';

export const DEVICE_SIGNING_MAINTENANCE_PROTOCOL = 'dharma.device-trust-maintenance/v1' as const;

interface DeviceSigningRecoveryContextBase {
  origin: string;
  issuer: string;
  audience: string;
  recoveryId: string;
  approvalId: string;
  organizationId: string;
  recipientMembershipId: string;
  deviceId: string;
  installationId: string;
  workspaceId: string;
  publicKeyEd25519: string;
  credentialEncryptionPublicKey: string;
  repositoryFingerprint: string;
  policyRevision: string;
  scopeDigest: string;
  contractDigest: string;
  sourceSelectionDigest: string;
  previousAnchorHash: string;
  protectedConfigDigest: string;
  previousGeneration: number;
  previousKeysetHash: string;
  previousRootFingerprint: string;
  candidateGeneration: number;
  candidateKeysetHash: string;
  candidateRootFingerprint: string;
  candidateKeyVersionFingerprint: string;
}

export type DeviceSigningRecoveryContext = DeviceSigningRecoveryContextBase & (
  {nativeSessionBindingDigest: string; controllerBindingDigest?: never}
  | {controllerBindingDigest: string; nativeSessionBindingDigest?: never});

export type DeviceSigningRecoveryChallenge = DeviceSigningRecoveryContext & {
  schema: 'dharma.device-signing-recovery-challenge/v1' | 'dharma.device-signing-maintenance-challenge/v1';
  purpose: 'expired_signing_trust_reapproval';
  method: 'POST';
  path: '/api/v1/agent-fabric/signing-recovery';
  nonce: string;
  issuedAt: string;
  expiresAt: string;
  authenticator: string;
};

const CONTEXT_KEYS = ['origin', 'issuer', 'audience', 'recoveryId', 'approvalId', 'organizationId', 'recipientMembershipId',
  'deviceId', 'installationId', 'workspaceId', 'publicKeyEd25519', 'credentialEncryptionPublicKey',
  'repositoryFingerprint', 'policyRevision', 'scopeDigest', 'contractDigest',
  'sourceSelectionDigest', 'nativeSessionBindingDigest', 'previousAnchorHash', 'protectedConfigDigest',
  'previousGeneration', 'previousKeysetHash', 'previousRootFingerprint',
  'candidateGeneration', 'candidateKeysetHash', 'candidateRootFingerprint', 'candidateKeyVersionFingerprint'] as const;
const SUFFIX_KEYS = ['purpose', 'method', 'path', 'nonce', 'issuedAt', 'expiresAt', 'authenticator'] as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const invalid = (): never => { throw new Error('device_signing_recovery_challenge_invalid'); };

function origin(value: unknown) {
  if (!value || typeof value !== 'object' || types.isProxy(value)) return invalid();
  const fields = Object.getOwnPropertyDescriptors(value);
  const maintenance = fields.audience?.value === 'dharma.agent-fabric.signing-maintenance/v1';
  const binding = maintenance ? 'controllerBindingDigest' : 'nativeSessionBindingDigest';
  const forbidden = maintenance ? 'nativeSessionBindingDigest' : 'controllerBindingDigest';
  if (!Object.hasOwn(fields, binding) || Object.hasOwn(fields, forbidden)
    || fields.audience?.value !== (maintenance ? 'dharma.agent-fabric.signing-maintenance/v1' : 'dharma.agent-fabric.signing-recovery/v1')) return invalid();
  const contextKeys = CONTEXT_KEYS.map(key => key === 'nativeSessionBindingDigest' ? binding : key);
  return {maintenance, binding, contextKeys, keys: ['schema', ...contextKeys, ...SUFFIX_KEYS]};
}

function bytes(value: unknown, size: number): boolean {
  if (typeof value !== 'string' || value.length !== Math.ceil(size * 4 / 3)
    || !/^[A-Za-z0-9_-]+$/.test(value)) return false;
  const decoded = Buffer.from(value, 'base64url');
  return decoded.length === size && decoded.toString('base64url') === value;
}

/** Public possession protocol only. The server must independently verify its
 * authenticator, current owner/recipient consent, device and policy, candidate
 * provenance and atomic replay state. This does not authorize installing trust. */
export function parseDeviceSigningRecoveryChallenge(
  value: unknown, expected: DeviceSigningRecoveryContext, now: number,
): DeviceSigningRecoveryChallenge {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value) || types.isProxy(value)) invalid();
    if (Object.getOwnPropertySymbols(value).length !== 0) invalid();
    const kind = origin(expected), {keys, contextKeys} = kind;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (Object.keys(descriptors).sort().join('\0') !== [...keys].sort().join('\0')) invalid();
    const body: Record<string, string | number> = {};
    for (const key of keys) {
      const field = descriptors[key] ?? invalid();
      if (!field.enumerable || !('value' in field)) invalid();
      if (key === 'previousGeneration' || key === 'candidateGeneration') {
        if (!Number.isSafeInteger(field.value) || field.value < 1) invalid();
      } else if (typeof field.value !== 'string' || field.value.length > 256) invalid();
      body[key] = field.value as string | number;
    }
    const expectedFields = Object.getOwnPropertyDescriptors(expected);
    for (const key of contextKeys) {
      const field = expectedFields[key];
      if (!field?.enumerable || !Object.hasOwn(field, 'value') || body[key] !== field.value) invalid();
    }
    if (body.schema !== (kind.maintenance ? 'dharma.device-signing-maintenance-challenge/v1' : 'dharma.device-signing-recovery-challenge/v1')
      || body.purpose !== 'expired_signing_trust_reapproval' || body.method !== 'POST'
      || body.path !== '/api/v1/agent-fabric/signing-recovery') invalid();
    const url = new URL(String(body.origin));
    if (url.protocol !== 'https:' || url.username || url.password || url.origin !== body.origin
      || body.issuer !== body.origin) invalid();
    for (const key of ['recoveryId', 'approvalId', 'recipientMembershipId', 'deviceId', 'installationId', 'workspaceId']) {
      if (!UUID.test(String(body[key]))) invalid();
    }
    for (const key of ['repositoryFingerprint', 'scopeDigest', 'contractDigest', 'sourceSelectionDigest',
      kind.binding, 'previousAnchorHash', 'protectedConfigDigest', 'previousKeysetHash',
      'previousRootFingerprint', 'candidateKeysetHash', 'candidateRootFingerprint', 'candidateKeyVersionFingerprint']) {
      if (!DIGEST.test(String(body[key]))) invalid();
    }
    if (!/^org_[A-Za-z0-9]+$/.test(String(body.organizationId))
      || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(String(body.policyRevision))
      || !bytes(body.publicKeyEd25519, 32) || !bytes(body.credentialEncryptionPublicKey, 32)
      || !bytes(body.nonce, 32) || !bytes(body.authenticator, 32)
      || Number(body.candidateGeneration) <= Number(body.previousGeneration)
      || body.candidateKeysetHash === body.previousKeysetHash) invalid();
    const issued = Date.parse(String(body.issuedAt));
    const expiry = Date.parse(String(body.expiresAt));
    if (!Number.isFinite(now) || !Number.isFinite(issued) || !Number.isFinite(expiry)
      || new Date(issued).toISOString() !== body.issuedAt || new Date(expiry).toISOString() !== body.expiresAt
      || issued > now || expiry <= now || expiry <= issued || expiry - issued > 900_000) invalid();
    return body as unknown as DeviceSigningRecoveryChallenge;
  } catch { return invalid(); }
}

export function deviceSigningRecoverySigningPayload(value: unknown): Buffer {
  try {
    // Snapshot descriptors before parsing so caller accessors are never evaluated.
    if (!value || typeof value !== 'object' || Array.isArray(value) || types.isProxy(value)) invalid();
    const kind = origin(value);
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const expected = Object.fromEntries(kind.contextKeys.map(key => [key, descriptors[key]?.value])) as unknown as DeviceSigningRecoveryContext;
    const issuedAt = descriptors.issuedAt?.value;
    const body = parseDeviceSigningRecoveryChallenge(value, expected, typeof issuedAt === 'string' ? Date.parse(issuedAt) : NaN);
    const domain = kind.maintenance ? 'dharma.agent-fabric.device-signing-maintenance-proof/v1' : 'dharma.agent-fabric.device-signing-expiry-recovery-proof/v1';
    const fields = body as unknown as Record<string, string | number>;
    return Buffer.from(domain + '\0' + JSON.stringify(kind.keys.map(key => [key, fields[key]])), 'utf8');
  } catch { return invalid(); }
}

export function verifyDeviceSigningRecoveryProof(
  value: unknown, signature: unknown, expected: DeviceSigningRecoveryContext, now: number,
): boolean {
  try {
    const body = parseDeviceSigningRecoveryChallenge(value, expected, now);
    if (!bytes(signature, 64)) return false;
    const key = createPublicKey({format: 'jwk', key: {kty: 'OKP', crv: 'Ed25519', x: body.publicKeyEd25519}});
    return verify(null, deviceSigningRecoverySigningPayload(body), key, Buffer.from(signature as string, 'base64url'));
  } catch { return false; }
}
