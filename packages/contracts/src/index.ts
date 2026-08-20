import { createHash, createPublicKey, sign, verify, type JsonWebKey, type KeyObject } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import type { ErrorObject } from 'ajv';
import actionDecisionAcknowledgementSchema from './action-decision-acknowledgement.schema.json' with { type: 'json' };
import actionDecisionReceiptSchema from './action-decision-receipt.schema.json' with { type: 'json' };
import actionDecisionTaskRequestSchema from './action-decision-task-request.schema.json' with { type: 'json' };
import serverSigningKeysetSchema from './server-signing-keyset.schema.json' with { type: 'json' };
import taskActionSchema from './task-action.schema.json' with { type: 'json' };
import taskEnvelopeSchema from './task-envelope.schema.json' with { type: 'json' };

const require = createRequire(import.meta.url);
const Ajv2020 = require('ajv/dist/2020').default as new (options: Record<string, unknown>) => {
  addSchema(schema: unknown): void;
  compile(schema: unknown): ((value: unknown) => boolean) & { errors?: ErrorObject[] | null };
  getSchema(id: string): ((value: unknown) => boolean) & { errors?: ErrorObject[] | null } | undefined;
};
const addFormats = require('ajv-formats').default as (ajv: unknown) => void;

export type EvidenceState =
  | 'observed'
  | 'partial'
  | 'unavailable'
  | 'excluded'
  | 'redacted'
  | 'out_of_window'
  | 'not_supported';

export type ProviderId = 'codex' | 'claude' | 'agy' | 'hermes';

export interface ProtocolEnvelope<T extends Record<string, unknown> = Record<string, unknown>> {
  schema: 'dharma.protocol-envelope/v1';
  messageId: string;
  organizationId: string;
  deviceId: string;
  sessionId: string;
  sentAt: string;
  expiresAt: string;
  sequence: number;
  nonce: string;
  type: string;
  payload: T;
  signature: string;
}

export interface RegisteredCommand {
  commandId: string;
  argv: string[];
  timeoutSeconds: number;
  workingDirectory?: string;
}

export interface ProviderCapability {
  provider: string;
  version: string | null;
  evidence: 'available' | 'partial' | 'unavailable';
  configuredAssets: 'available' | 'partial' | 'unavailable';
  taskExecution: 'available' | 'partial' | 'unavailable';
  sessionContinuation: 'available' | 'partial' | 'unavailable';
  skillInstall: 'available' | 'partial' | 'unavailable';
  activation: 'next_task' | 'next_session' | 'host_restart' | 'immediate_safe_reload' | 'unavailable';
  skillRollback?: 'available' | 'partial' | 'unavailable';
  usageEvidence: 'available' | 'partial' | 'unavailable';
  actionDecisionReceipts?: 'available' | 'unavailable';
  actionDecisionReceiver?: {
    protocol: 'action_decision_receipts_v1';
    protocolVersion: 1;
    journalSchema: 'dharma.action-execution-journal/v1';
    state: 'available' | 'unavailable';
    selfTestedAt: string;
    freshUntil: string;
    trustedKeyVersions: string[];
    reason?: string;
  };
}

export interface ActionDecisionTaskRequest {
  taskId?: string;
  targetEndpointId: string;
  workspaceId: string;
  taskType: 'external_request' | 'a2a_handoff' | 'evaluation_retest' | 'remediation_smoke';
  instructions: string;
  requiredSkills?: Array<{ skillId: string; version: string; commit: string; contentHash: string }>;
  authority: {
    commandIds: string[];
    readPaths: string[];
    writePaths: string[];
    network?: string;
    git?: 'read_only' | 'task_branch' | 'merge_allowed' | 'deploy_allowed';
    allowlistedDomains?: string[];
  };
  timeoutSeconds?: number;
  leaseSeconds?: number;
  acceptanceCommandIds?: string[];
  requiredArtifacts?: string[];
  expiresAt?: string;
}

export interface TrustedServerSigningKeyset {
  schema: 'dharma.server-signing-keyset/v1';
  organizationId: string;
  generation: number;
  keys: Array<{
    keyVersion: string;
    publicKeyEd25519: string;
    status: 'active' | 'overlap';
    notBefore: string;
    notAfter: string;
  }>;
  signedByKeyVersion: string;
  issuedAt: string;
  expiresAt: string;
  signature: string;
}

export interface TaskAction {
  schema: 'dharma.task-action/v1';
  organizationId: string;
  actionId: string;
  taskId: string;
  targetEndpointId: string;
  workspaceId: string;
  taskType: 'external_request' | 'a2a_handoff' | 'evaluation_retest' | 'remediation_smoke';
  instructions: string;
  source?: { taskId: string; endpointId: string };
  stateEnvelope?: {
    intent: string;
    evidence_used: string[];
    known_state: Record<string, unknown>;
    unknown_or_missing_state: string[];
    allowed_next_actions: string[];
    blocked_actions: string[];
    decision_authority: string;
    tool_results: unknown[];
  };
  evidenceReferences?: Array<{ trajectoryId: string; revision: number; capsuleHash: string }>;
  skillBundle: { bundleId: string; bundleHash: string } | null;
  requiredSkills: Array<{ skillId: string; version: string; commit: string; contentHash: string }>;
  authority: {
    readPaths: string[];
    writePaths: string[];
    commands: Array<{ commandId: string }>;
    network: string;
    git: string;
    allowlistedDomains?: string[];
  };
  execution: { isolation: 'git_worktree'; timeoutSeconds: number; leaseSeconds: number; maximumConcurrentAgents: number };
  acceptance: {
    commands: Array<{ commandId: string }>;
    requiredArtifacts: string[];
    externalEffectReceiptCommandId?: string;
  };
  budget: { mode: 'byok_local' | 'byok_cloud' | 'dharma_managed'; maximumDharmaCostCents: number; maximumProviderCostCents?: number | null };
  expiresAt: string;
}

export type ActionDecisionOutcome = 'release' | 'block' | 'escalate' | 'withhold';

export interface ActionDecisionReceipt {
  schema: 'dharma.action-decision-receipt/v1';
  decisionId: string;
  organizationId: string;
  actionId: string;
  taskId: string;
  targetEndpointId: string;
  workspaceId: string;
  evaluationContractId: string;
  evaluationContractVersion: number;
  actionDigest: string;
  stateEnvelopeHash: string;
  evidenceReferences: Array<{ trajectoryId: string; revision: number; capsuleHash: string }>;
  outcome: ActionDecisionOutcome;
  reasonCodes: string[];
  confidence: number;
  evaluator: { provider: string; model: string; configDigest: string };
  nonce: string;
  issuedAt: string;
  expiresAt: string;
  keyVersion: string;
}

export interface ActionDecisionEnvelope {
  id: string;
  actionDigest: string;
  receipt: ActionDecisionReceipt;
  signature: string;
  keyVersion: string;
}

export interface ActionDecisionAcknowledgement {
  taskId: string;
  endpointId: string;
  actionDigest: string;
  disposition: 'executed' | 'contained' | 'unknown';
  externalIdempotencyKeyHash: string;
  resultDigest: string;
  acknowledgedAt: string;
}

export type ActionDecisionPublicKeyResolver = (keyVersion: string) => KeyObject | null;
export const ACTION_DECISION_RECEIPT_MAX_LIFETIME_MS = 30 * 60_000;

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalValue(item)]),
    );
  }
  return value;
}

export function canonicalize(value: unknown): string {
  return JSON.stringify(canonicalValue(value));
}

export function sha256(value: string | Uint8Array): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

export function signCanonicalObject(value: unknown, privateKey: KeyObject): string {
  return sign(null, Buffer.from(canonicalize(value), 'utf8'), privateKey).toString('base64url');
}

export function verifyCanonicalObject(value: unknown, signature: string, publicKey: KeyObject): boolean {
  return verify(
    null,
    Buffer.from(canonicalize(value), 'utf8'),
    publicKey,
    Buffer.from(signature, 'base64url'),
  );
}

const taskEnvelopeAjv = new Ajv2020({ allErrors: true, strict: true, strictRequired: false });
addFormats(taskEnvelopeAjv);
taskEnvelopeAjv.addSchema(actionDecisionReceiptSchema);
const taskEnvelopeValidator = taskEnvelopeAjv.compile(taskEnvelopeSchema);

const actionDecisionAjv = new Ajv2020({ allErrors: true, strict: true, strictRequired: false });
addFormats(actionDecisionAjv);
const taskActionValidator = actionDecisionAjv.compile(taskActionSchema);
const actionDecisionReceiptValidator = actionDecisionAjv.compile(actionDecisionReceiptSchema);
const actionDecisionAcknowledgementValidator = actionDecisionAjv.compile(actionDecisionAcknowledgementSchema);
const actionDecisionTaskRequestValidator = actionDecisionAjv.compile(actionDecisionTaskRequestSchema);
const serverSigningKeysetValidator = actionDecisionAjv.compile(serverSigningKeysetSchema);

function contractResult(
  validator: ((value: unknown) => boolean) & { errors?: ErrorObject[] | null },
  value: unknown,
): { ok: true } | { ok: false; errors: ErrorObject[] } {
  return validator(value) ? { ok: true } : { ok: false, errors: [...(validator.errors ?? [])] };
}

export function validateTaskEnvelopeContract(
  value: unknown,
): { ok: true } | { ok: false; errors: ErrorObject[] } {
  return contractResult(taskEnvelopeValidator, value);
}

export function validateTaskActionContract(
  value: unknown,
): { ok: true } | { ok: false; errors: ErrorObject[] } {
  return contractResult(taskActionValidator, value);
}

export function validateActionDecisionReceiptContract(
  value: unknown,
): { ok: true } | { ok: false; errors: ErrorObject[] } {
  return contractResult(actionDecisionReceiptValidator, value);
}

export function validateActionDecisionAcknowledgementContract(
  value: unknown,
): { ok: true } | { ok: false; errors: ErrorObject[] } {
  return contractResult(actionDecisionAcknowledgementValidator, value);
}

export function validateActionDecisionTaskRequestContract(
  value: unknown,
): { ok: true } | { ok: false; errors: ErrorObject[] } {
  return contractResult(actionDecisionTaskRequestValidator, value);
}

export function validateTrustedServerSigningKeysetContract(
  value: unknown,
): { ok: true } | { ok: false; errors: ErrorObject[] } {
  return contractResult(serverSigningKeysetValidator, value);
}

export function actionDecisionDigest(action: TaskAction): string {
  const contract = validateTaskActionContract(action);
  if (!contract.ok) throw new Error(`Action failed schema validation: ${JSON.stringify(contract.errors)}`);
  return sha256(canonicalize(action));
}

export type ActionDecisionVerificationResult = { ok: true } | {
  ok: false;
  reason:
    | 'action_schema_invalid'
    | 'receipt_schema_invalid'
    | 'invalid_lifetime'
    | 'expired'
    | 'not_yet_valid'
    | 'binding_mismatch'
    | 'digest_mismatch'
    | 'unknown_key'
    | 'bad_signature';
};

export function verifyActionDecisionReceipt(
  envelope: ActionDecisionEnvelope,
  action: TaskAction,
  resolvePublicKey: ActionDecisionPublicKeyResolver,
  now = new Date(),
): ActionDecisionVerificationResult {
  if (!validateTaskActionContract(action).ok) return { ok: false, reason: 'action_schema_invalid' };
  const receipt = envelope.receipt;
  if (!validateActionDecisionReceiptContract(receipt).ok) return { ok: false, reason: 'receipt_schema_invalid' };
  const issuedAt = Date.parse(receipt.issuedAt);
  const expiresAt = Date.parse(receipt.expiresAt);
  if (expiresAt <= issuedAt
    || expiresAt - issuedAt > ACTION_DECISION_RECEIPT_MAX_LIFETIME_MS
    || expiresAt > Date.parse(action.expiresAt)) {
    return { ok: false, reason: 'invalid_lifetime' };
  }
  if (expiresAt <= now.getTime()) return { ok: false, reason: 'expired' };
  if (issuedAt > now.getTime() + 5 * 60_000) return { ok: false, reason: 'not_yet_valid' };
  if (
    envelope.id !== receipt.decisionId
    || envelope.keyVersion !== receipt.keyVersion
    || receipt.organizationId !== action.organizationId
    || receipt.taskId !== action.taskId
    || receipt.actionId !== action.actionId
    || receipt.targetEndpointId !== action.targetEndpointId
    || receipt.workspaceId !== action.workspaceId
  ) return { ok: false, reason: 'binding_mismatch' };
  const digest = actionDecisionDigest(action);
  if (receipt.actionDigest !== digest || envelope.actionDigest !== digest) return { ok: false, reason: 'digest_mismatch' };
  const publicKey = resolvePublicKey(receipt.keyVersion);
  if (!publicKey) return { ok: false, reason: 'unknown_key' };
  try {
    return verifyCanonicalObject(receipt, envelope.signature, publicKey)
      ? { ok: true }
      : { ok: false, reason: 'bad_signature' };
  } catch {
    return { ok: false, reason: 'bad_signature' };
  }
}

export function buildActionDecisionAcknowledgement(
  input: {
    taskId: string;
    endpointId: string;
    actionDigest: string;
    disposition: ActionDecisionAcknowledgement['disposition'];
    externalIdempotencyKey: string;
    result: unknown;
  },
  now = new Date(),
): ActionDecisionAcknowledgement {
  const acknowledgement: ActionDecisionAcknowledgement = {
    taskId: input.taskId,
    endpointId: input.endpointId,
    actionDigest: input.actionDigest,
    disposition: input.disposition,
    externalIdempotencyKeyHash: createHash('sha256').update(input.externalIdempotencyKey).digest('hex'),
    resultDigest: sha256(canonicalize(input.result)),
    acknowledgedAt: now.toISOString(),
  };
  const contract = validateActionDecisionAcknowledgementContract(acknowledgement);
  if (!contract.ok) throw new Error(`Action acknowledgement failed schema validation: ${JSON.stringify(contract.errors)}`);
  return acknowledgement;
}

export function refreshActionDecisionAcknowledgement(
  acknowledgement: ActionDecisionAcknowledgement,
  now = new Date(),
): ActionDecisionAcknowledgement {
  const current = validateActionDecisionAcknowledgementContract(acknowledgement);
  if (!current.ok) throw new Error(`Action acknowledgement failed schema validation: ${JSON.stringify(current.errors)}`);
  const refreshed = { ...acknowledgement, acknowledgedAt: now.toISOString() };
  const contract = validateActionDecisionAcknowledgementContract(refreshed);
  if (!contract.ok) throw new Error(`Refreshed action acknowledgement failed schema validation: ${JSON.stringify(contract.errors)}`);
  return refreshed;
}

const SERVER_SIGNING_KEYSET_MAX_LIFETIME_MS = 30 * 24 * 60 * 60_000;
const SERVER_SIGNING_KEY_OVERLAP_MS = 10 * 60_000;

function unsignedServerSigningKeyset(keyset: TrustedServerSigningKeyset) {
  const { signature, ...unsigned } = keyset;
  return unsigned;
}

function keysetTimeFailure(keyset: TrustedServerSigningKeyset, now: Date): string | null {
  const issuedAt = Date.parse(keyset.issuedAt);
  const expiresAt = Date.parse(keyset.expiresAt);
  if (!Number.isFinite(issuedAt) || !Number.isFinite(expiresAt)
    || expiresAt <= issuedAt || expiresAt - issuedAt > SERVER_SIGNING_KEYSET_MAX_LIFETIME_MS) {
    return 'invalid_lifetime';
  }
  if (issuedAt > now.getTime() + 5 * 60_000) return 'not_yet_valid';
  if (expiresAt <= now.getTime()) return 'expired';
  const versions = new Set<string>();
  for (const key of keyset.keys) {
    if (versions.has(key.keyVersion)) return 'duplicate_key_version';
    versions.add(key.keyVersion);
    const notBefore = Date.parse(key.notBefore);
    const notAfter = Date.parse(key.notAfter);
    if (!Number.isFinite(notBefore) || !Number.isFinite(notAfter) || notAfter <= notBefore) return 'invalid_key_lifetime';
  }
  if (!keyset.keys.some((key) => key.status === 'active'
    && Date.parse(key.notBefore) <= now.getTime() && Date.parse(key.notAfter) > now.getTime())) {
    return 'no_active_key';
  }
  return null;
}

export type ServerSigningKeysetVerificationResult = { ok: true } | { ok: false; reason: string };

export function verifyInitialServerSigningKeyset(
  keyset: TrustedServerSigningKeyset,
  pinnedRootPublicKey: KeyObject,
  organizationId: string,
  now = new Date(),
): ServerSigningKeysetVerificationResult {
  if (!validateTrustedServerSigningKeysetContract(keyset).ok) return { ok: false, reason: 'schema_invalid' };
  if (keyset.organizationId !== organizationId) return { ok: false, reason: 'organization_mismatch' };
  const timeFailure = keysetTimeFailure(keyset, now);
  if (timeFailure) return { ok: false, reason: timeFailure };
  const pinned = pinnedRootPublicKey.export({ format: 'jwk' }) as JsonWebKey;
  const signer = keyset.keys.find((key) => key.keyVersion === keyset.signedByKeyVersion);
  if (!signer || signer.publicKeyEd25519 !== pinned.x) return { ok: false, reason: 'untrusted_initial_signer' };
  return verifyCanonicalObject(unsignedServerSigningKeyset(keyset), keyset.signature, pinnedRootPublicKey)
    ? { ok: true }
    : { ok: false, reason: 'bad_signature' };
}

export function verifyServerSigningKeysetUpdate(
  current: TrustedServerSigningKeyset,
  candidate: TrustedServerSigningKeyset,
  now = new Date(),
): ServerSigningKeysetVerificationResult {
  if (!validateTrustedServerSigningKeysetContract(current).ok
    || !validateTrustedServerSigningKeysetContract(candidate).ok) return { ok: false, reason: 'schema_invalid' };
  if (candidate.organizationId !== current.organizationId) return { ok: false, reason: 'organization_mismatch' };
  if (candidate.generation <= current.generation) return { ok: false, reason: 'generation_not_advanced' };
  const currentTimeFailure = keysetTimeFailure(current, now);
  if (currentTimeFailure) return { ok: false, reason: `current_${currentTimeFailure}` };
  const timeFailure = keysetTimeFailure(candidate, now);
  if (timeFailure) return { ok: false, reason: timeFailure };
  const signer = current.keys.find((key) => key.keyVersion === candidate.signedByKeyVersion
    && Date.parse(key.notBefore) <= now.getTime() && Date.parse(key.notAfter) > now.getTime());
  if (!signer) return { ok: false, reason: 'untrusted_update_signer' };
  const retained = candidate.keys.find((key) => key.keyVersion === signer.keyVersion
    && key.publicKeyEd25519 === signer.publicKeyEd25519
    && key.notBefore === signer.notBefore
    && Date.parse(key.notAfter) <= Date.parse(signer.notAfter)
    && Date.parse(key.notAfter) >= now.getTime() + SERVER_SIGNING_KEY_OVERLAP_MS);
  if (!retained) return { ok: false, reason: 'rotation_overlap_missing' };
  const publicKey = createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: signer.publicKeyEd25519 }, format: 'jwk' });
  return verifyCanonicalObject(unsignedServerSigningKeyset(candidate), candidate.signature, publicKey)
    ? { ok: true }
    : { ok: false, reason: 'bad_signature' };
}

export function createActionDecisionPublicKeyResolver(
  keyset: TrustedServerSigningKeyset,
  now = new Date(),
): ActionDecisionPublicKeyResolver {
  if (!validateTrustedServerSigningKeysetContract(keyset).ok || keysetTimeFailure(keyset, now)) return () => null;
  const keys = new Map(keyset.keys
    .filter((key) => Date.parse(key.notBefore) <= now.getTime() && Date.parse(key.notAfter) > now.getTime())
    .map((key) => [key.keyVersion, key.publicKeyEd25519]));
  return (keyVersion) => {
    const value = keys.get(keyVersion);
    if (!value) return null;
    try { return createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: value }, format: 'jwk' }); }
    catch { return null; }
  };
}

export function envelopeSigningPayload(envelope: Omit<ProtocolEnvelope, 'signature'>): Buffer {
  return Buffer.from(canonicalize(envelope), 'utf8');
}

export function signEnvelope(
  envelope: Omit<ProtocolEnvelope, 'signature'>,
  privateKey: KeyObject,
): ProtocolEnvelope {
  return {
    ...envelope,
    signature: sign(null, envelopeSigningPayload(envelope), privateKey).toString('base64url'),
  };
}

export function verifyEnvelope(
  envelope: ProtocolEnvelope,
  publicKey: KeyObject,
  now = new Date(),
): { ok: true } | { ok: false; reason: 'expired' | 'not_yet_valid' | 'bad_signature' } {
  const sentAt = Date.parse(envelope.sentAt);
  const expiresAt = Date.parse(envelope.expiresAt);
  if (expiresAt <= now.getTime()) return { ok: false, reason: 'expired' };
  if (sentAt > now.getTime() + 5 * 60_000) return { ok: false, reason: 'not_yet_valid' };
  const { signature, ...unsigned } = envelope;
  const valid = verify(
    null,
    envelopeSigningPayload(unsigned),
    publicKey,
    Buffer.from(signature, 'base64url'),
  );
  return valid ? { ok: true } : { ok: false, reason: 'bad_signature' };
}

export async function validateContract(
  schemaDirectory: string,
  schemaId: string,
  value: unknown,
): Promise<{ ok: true } | { ok: false; errors: ErrorObject[] }> {
  const ajv = new Ajv2020({ allErrors: true, strict: true, strictRequired: false });
  addFormats(ajv);
  for (const name of (await readdir(schemaDirectory)).filter((item) => item.endsWith('.schema.json'))) {
    ajv.addSchema(JSON.parse(await readFile(resolve(schemaDirectory, name), 'utf8')));
  }
  const validator = ajv.getSchema(schemaId);
  if (!validator) throw new Error(`Unknown contract schema: ${schemaId}`);
  return validator(value) ? { ok: true } : { ok: false, errors: [...(validator.errors ?? [])] };
}
