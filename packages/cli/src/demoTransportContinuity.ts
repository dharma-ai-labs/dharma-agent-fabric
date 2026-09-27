import { createPublicKey } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { Ajv2020, type ValidateFunction } from 'ajv/dist/2020.js';
import type { FormatsPlugin } from 'ajv-formats';
import { canonicalize, sha256, validateTrustedServerSigningKeysetContract,
  verifyCanonicalObject, verifyInitialServerSigningKeyset,
  type TrustedServerSigningKeyset } from '@dharma-ai-labs/agent-fabric-contracts';

export interface DemoTransportContinuity {
  schema: 'dharma.demo-transport-continuity/v1';
  purpose: 'same-authority-repository-transport';
  organizationId: string; repositoryId: string; deviceId: string; installationId: string;
  publicKeyEd25519: string; enrollmentOrigin: string; transportOrigin: string; requestNonce: string;
  policyRevision: number; trustGeneration: number; installedKeysetHash: string;
  signingKeyVersion: string; issuedAt: string; expiresAt: string; signature: string;
}
export interface DemoTransportContinuityContext {
  organizationId: string; repositoryId: string; deviceId: string; installationId: string;
  publicKeyEd25519: string; enrollmentOrigin: string; transportOrigin: string; requestNonce: string;
  protectedKeyset: TrustedServerSigningKeyset;
  minimumPolicyRevision: number;
  previous?: { policyRevision: number; transportOrigin: string };
  now?: Date;
}

let validator: Promise<ValidateFunction<DemoTransportContinuity>> | undefined;
function continuityValidator() {
  return validator ??= (async () => {
    const ajv = new Ajv2020({ allErrors: true, strict: true });
    const addFormats = createRequire(import.meta.url)('ajv-formats').default as FormatsPlugin;
    addFormats(ajv);
    return ajv.compile<DemoTransportContinuity>(JSON.parse(await readFile(
      new URL('./schemas/demo-transport-continuity.schema.json', import.meta.url), 'utf8')));
  })();
}
function reject(reason: string): never {
  throw new Error(`Demo transport continuity rejected: ${reason}. Original enrollment and trust remain unchanged.`);
}
function canonicalOrigin(value: string): boolean {
  try { return new URL(value).protocol === 'https:' && new URL(value).origin === value; }
  catch { return false; }
}
function validRevision(value: number) { return Number.isSafeInteger(value) && value > 0; }

// The caller must load protectedKeyset and previous from the existing OS trust
// store. A keyset returned by the proposed destination is never authority here.
export async function verifyDemoTransportContinuity(input: unknown,
  inputContext: DemoTransportContinuityContext): Promise<DemoTransportContinuity> {
  let value: unknown, context: DemoTransportContinuityContext;
  try { value = structuredClone(input); context = structuredClone(inputContext); }
  catch { reject('schema_invalid'); }
  const now = context.now ?? new Date();
  if (!Number.isFinite(now.getTime()) || !validRevision(context.minimumPolicyRevision)
    || (context.previous && !validRevision(context.previous.policyRevision))) reject('context_invalid');
  if (!(await continuityValidator())(value)) reject('schema_invalid');
  if (!canonicalOrigin(value.enrollmentOrigin) || !canonicalOrigin(value.transportOrigin)
    || (context.previous && !canonicalOrigin(context.previous.transportOrigin))) reject('origin_invalid');

  const keyset = context.protectedKeyset;
  if (!validateTrustedServerSigningKeysetContract(keyset).ok) reject('authority_invalid');
  const signer = keyset.keys.find(key => key.keyVersion === keyset.signedByKeyVersion);
  if (!signer || signer.status !== 'active' || keyset.keys.filter(key => key.status === 'active').length !== 1
    || !/^[A-Za-z0-9_-]{43}$/.test(signer.publicKeyEd25519)
    || Date.parse(signer.notBefore) > now.getTime()
    || Date.parse(signer.notAfter) < Date.parse(keyset.expiresAt)) reject('authority_invalid');
  const key = createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: signer.publicKeyEd25519 }, format: 'jwk' });
  if (!verifyInitialServerSigningKeyset(keyset, key, context.organizationId, now).ok) reject('authority_invalid');
  const scopeFields = ['organizationId', 'repositoryId', 'deviceId', 'installationId',
    'publicKeyEd25519', 'enrollmentOrigin', 'transportOrigin', 'requestNonce'] as const;
  if (scopeFields.some(field => value[field] !== context[field])) reject('scope_mismatch');
  if (value.trustGeneration !== keyset.generation || value.installedKeysetHash !== sha256(canonicalize(keyset))
    || value.signingKeyVersion !== keyset.signedByKeyVersion) reject('authority_mismatch');
  if (value.policyRevision < context.minimumPolicyRevision) reject('policy_revision_conflict');
  if (context.previous && (value.policyRevision < context.previous.policyRevision
    || (value.policyRevision === context.previous.policyRevision
      && value.transportOrigin !== context.previous.transportOrigin))) reject('policy_revision_conflict');
  const issued = Date.parse(value.issuedAt), expiry = Date.parse(value.expiresAt);
  if (issued > now.getTime() || expiry <= now.getTime() || expiry <= issued
    || expiry - issued > 600_000 || expiry > Date.parse(keyset.expiresAt)
    || expiry > Date.parse(signer.notAfter)) reject('lifetime_invalid');
  const { signature, ...unsigned } = value;
  if (!verifyCanonicalObject(unsigned, signature, key)) reject('signature_invalid');
  return value;
}
