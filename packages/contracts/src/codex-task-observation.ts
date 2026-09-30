import { createRequire } from 'node:module';
import type { KeyObject } from 'node:crypto';
import schema from './codex-task-observation.schema.json' with { type: 'json' };
import { canonicalize, sha256, signCanonicalObject, verifyCanonicalObject } from './index.js';

export interface CodexTaskScope {
  organizationId: string;
  repositoryBindingId: string;
  workspaceId: string;
  endpointId: string;
  membershipId: string;
  deviceId: string;
  bindingId: string;
  workId: string;
}

export interface CodexTaskPackage {
  releaseId: string;
  manifestHash: string;
  catalogHash: string;
  skillsHash: string;
}

export interface CodexTaskConsent {
  policyId: string;
  revision: number;
  receiptId: string;
}

export interface CodexTaskOutcome {
  receiptId: string;
  logicalRequestId: string;
  captureHash: string;
  sourceSnapshotHash: string;
  resultSnapshotHash: string;
  evaluationContractHash: string;
  publicEvidenceHash: string;
  status: 'passed' | 'failed' | 'error';
  completedAt: string;
  signerKeyVersion: string;
  signature: string;
}

export interface CodexTaskObservation extends CodexTaskScope {
  schema: 'dharma.codex-task-observation/v1';
  logicalRequestId: string;
  capture: {
    captureId: string;
    captureHash: string;
    requestHash: string;
    eventsHash: string;
    threadId: string;
    turnId: string;
    startedAt: string;
    completedAt: string;
    terminalState: 'completed' | 'failed' | 'interrupted';
    coverage: 'observed';
    droppedEvents: 0;
  };
  sourceSnapshotHash: string;
  resultSnapshotHash: string;
  package: CodexTaskPackage;
  consent: CodexTaskConsent;
  provider: {
    name: 'codex';
    runtimeVersion: string;
    requestedModel: string;
    executedModel: null;
    retainedContextHash: string;
    replayMode: 'task_level';
  };
  outcome: CodexTaskOutcome;
  signature: string;
}

const require = createRequire(import.meta.url);
const Ajv = require('ajv/dist/2020').default;
const ajv = new Ajv({ allErrors: true, strict: true });
require('ajv-formats').default(ajv);
const validate = ajv.compile(schema) as (value: unknown) => boolean;

function canonicalSignature(value: string) {
  const bytes = Buffer.from(value, 'base64url');
  return bytes.length === 64 && bytes.toString('base64url') === value;
}

/** Retrying a provider turn cannot turn one logical work item into new observations. */
export function codexTaskLogicalRequestId(scope: CodexTaskScope): string {
  const keys = ['organizationId', 'repositoryBindingId', 'workspaceId', 'endpointId', 'membershipId',
    'deviceId', 'bindingId', 'workId'] as const;
  return `codex-task:${sha256(canonicalize(Object.fromEntries(keys.map(key => [key, scope[key]])))).slice(7)}`;
}

export function signCodexTaskObservation(value: Omit<CodexTaskObservation, 'signature'>,
  devicePrivateKey: KeyObject): CodexTaskObservation {
  const signed = { ...value, signature: signCanonicalObject(value, devicePrivateKey) };
  if (!validate(signed)) throw new Error('codex_task_observation_invalid');
  return signed;
}

export type CodexTaskObservationVerification =
  | { ok: true; logicalRequestId: string; observationHash: string; outcome: CodexTaskOutcome['status'] }
  | { ok: false; reason: string };

/**
 * Authoritative inputs come from current enrollment and retained server evidence.
 * A device declaration alone never proves source retention, consent, or grading.
 * This verifier does not increment a learning counter or consume an identity.
 */
export function verifyCodexTaskObservation(value: unknown, input: {
  scope: CodexTaskScope;
  devicePublicKey: KeyObject;
  deviceActive: boolean;
  consent: CodexTaskConsent | null;
  package: CodexTaskPackage | null;
  retained: {
    capture: CodexTaskObservation['capture'];
    sourceSnapshotHash: string;
    resultSnapshotHash: string;
    provider: CodexTaskObservation['provider'];
    publicEvidenceHash: string;
  } | null;
  evaluationContractHash: string;
  resolveGraderPublicKey(version: string): KeyObject | null;
  now?: Date;
}): CodexTaskObservationVerification {
  if (!validate(value)) return { ok: false, reason: 'codex_task_observation_invalid' };
  const observation = value as CodexTaskObservation;
  const { signature, ...payload } = observation;
  try {
    if (!canonicalSignature(signature) || !verifyCanonicalObject(payload, signature, input.devicePublicKey)) {
      return { ok: false, reason: 'codex_task_device_signature_invalid' };
    }
  } catch { return { ok: false, reason: 'codex_task_device_signature_invalid' }; }
  if (!input.deviceActive) return { ok: false, reason: 'codex_task_device_revoked' };
  if (Object.keys(input.scope).some(key => observation[key as keyof CodexTaskScope] !== input.scope[key as keyof CodexTaskScope])) {
    return { ok: false, reason: 'codex_task_scope_mismatch' };
  }
  const logicalRequestId = codexTaskLogicalRequestId(input.scope);
  if (observation.logicalRequestId !== logicalRequestId) {
    return { ok: false, reason: 'codex_task_logical_identity_invalid' };
  }
  if (!input.consent || canonicalize(observation.consent) !== canonicalize(input.consent)) {
    return { ok: false, reason: 'codex_task_consent_inactive' };
  }
  if (!input.package || canonicalize(observation.package) !== canonicalize(input.package)) {
    return { ok: false, reason: 'codex_task_package_mismatch' };
  }
  const retained = input.retained;
  if (!retained || canonicalize(observation.capture) !== canonicalize(retained.capture)
    || observation.sourceSnapshotHash !== retained.sourceSnapshotHash
    || observation.resultSnapshotHash !== retained.resultSnapshotHash
    || canonicalize(observation.provider) !== canonicalize(retained.provider)
    || observation.outcome.publicEvidenceHash !== retained.publicEvidenceHash) {
    return { ok: false, reason: 'codex_task_retained_evidence_mismatch' };
  }
  const outcome = observation.outcome;
  if (outcome.logicalRequestId !== logicalRequestId || outcome.captureHash !== observation.capture.captureHash
    || outcome.sourceSnapshotHash !== observation.sourceSnapshotHash
    || outcome.resultSnapshotHash !== observation.resultSnapshotHash
    || outcome.evaluationContractHash !== input.evaluationContractHash
    || observation.capture.terminalState !== 'completed' && outcome.status === 'passed') {
    return { ok: false, reason: 'codex_task_outcome_mismatch' };
  }
  const now = (input.now ?? new Date()).getTime();
  const started = Date.parse(observation.capture.startedAt), completed = Date.parse(observation.capture.completedAt);
  const graded = Date.parse(outcome.completedAt);
  if (!Number.isFinite(now) || started > completed || completed > graded || graded > now + 300_000) {
    return { ok: false, reason: 'codex_task_time_invalid' };
  }
  const { signature: gradeSignature, ...gradePayload } = outcome;
  try {
    const graderKey = input.resolveGraderPublicKey(outcome.signerKeyVersion);
    if (!canonicalSignature(gradeSignature) || !graderKey || graderKey.export({ type: 'spki', format: 'der' }).equals(
      input.devicePublicKey.export({ type: 'spki', format: 'der' }))
      || !verifyCanonicalObject(gradePayload, gradeSignature, graderKey)) {
      return { ok: false, reason: 'codex_task_grader_signature_invalid' };
    }
  } catch { return { ok: false, reason: 'codex_task_grader_signature_invalid' }; }
  return { ok: true, logicalRequestId, observationHash: sha256(canonicalize(observation)), outcome: outcome.status };
}
