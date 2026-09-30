import { createRequire } from 'node:module';
import type { KeyObject } from 'node:crypto';
import schema from './codex-task-observation.schema.json' with { type: 'json' };
import captureSchema from './codex-local-work-capture-v2.schema.json' with { type: 'json' };
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
const validateOutcome = ajv.compile({ $defs: schema.$defs, ...schema.properties.outcome }) as (value: unknown) => boolean;
const validateCapture = ajv.compile(captureSchema) as (value: unknown) => boolean;

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

/** Exact local capture integrity only; this does not authorize disclosure or attest execution. */
export function verifyCodexTaskCaptureBytes(bytes: unknown, input: {
  scope: CodexTaskScope;
  capture: CodexTaskObservation['capture'];
  now?: Date;
}): { ok: true } | { ok: false; reason: string } {
  if (!(bytes instanceof Uint8Array)) return { ok: false, reason: 'codex_task_capture_bytes_unavailable' };
  if (bytes.byteLength > 3 * 1024 * 1024) return { ok: false, reason: 'codex_task_capture_bytes_invalid' };
  let text: string, value: Record<string, unknown>;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    const parsed: unknown = JSON.parse(text);
    if (!validateCapture(parsed) || JSON.stringify(parsed) !== text) {
      return { ok: false, reason: 'codex_task_capture_bytes_invalid' };
    }
    value = parsed as Record<string, unknown>;
  } catch { return { ok: false, reason: 'codex_task_capture_bytes_invalid' }; }
  if (sha256(bytes) !== input.capture.captureHash) return { ok: false, reason: 'codex_task_capture_hash_mismatch' };
  if (Object.keys(input.scope).some(key => value[key] !== input.scope[key as keyof CodexTaskScope])
    || value.captureId !== input.capture.captureId || value.providerThreadId !== input.capture.threadId
    || value.providerTurnId !== input.capture.turnId || value.startedAt !== input.capture.startedAt
    || value.closedAt !== input.capture.completedAt || value.providerTurnState !== input.capture.terminalState) {
    return { ok: false, reason: 'codex_task_capture_scope_mismatch' };
  }
  if (value.coverage !== 'observed' || value.droppedEvents !== 0 || (value.limitations as unknown[]).length
    || !value.providerTurnId) return { ok: false, reason: 'codex_task_capture_not_observed' };
  const request = value.request as Record<string, unknown>, params = request.params as Record<string, unknown>;
  const events = value.events as Array<{ sequence: number; receivedAt: string; notification: Record<string, unknown> }>;
  if (params.threadId !== input.capture.threadId) return { ok: false, reason: 'codex_task_capture_scope_mismatch' };
  if (value.requestHash !== input.capture.requestHash || value.eventsHash !== input.capture.eventsHash
    || sha256(JSON.stringify(request)) !== value.requestHash || sha256(JSON.stringify(events)) !== value.eventsHash) {
    return { ok: false, reason: 'codex_task_capture_hash_mismatch' };
  }
  const start = Date.parse(input.capture.startedAt), end = Date.parse(input.capture.completedAt);
  const now = (input.now ?? new Date()).getTime();
  if (!Number.isFinite(now) || start > end || end > now + 300_000) {
    return { ok: false, reason: 'codex_task_time_invalid' };
  }
  let sequence = -1, terminalObserved = false;
  for (const event of events) {
    const notification = event.notification, eventParams = record(notification.params);
    const turn = record(eventParams?.turn);
    const receivedAt = Date.parse(event.receivedAt);
    if (event.sequence <= sequence || receivedAt < start || receivedAt > end) {
      return { ok: false, reason: 'codex_task_capture_event_order_invalid' };
    }
    sequence = event.sequence;
    if (typeof notification.method !== 'string'
      || !/^(?:item\/|turn\/|thread\/tokenUsage\/updated$|error$)/.test(notification.method)
      || eventParams?.threadId !== input.capture.threadId
      || (eventParams?.turnId === undefined && turn?.id === undefined)
      || (eventParams?.turnId !== undefined && eventParams.turnId !== input.capture.turnId)
      || (turn?.id !== undefined && turn.id !== input.capture.turnId)) {
      return { ok: false, reason: 'codex_task_capture_scope_mismatch' };
    }
    if (notification.method === 'turn/completed') {
      if (turn?.status !== input.capture.terminalState) return { ok: false, reason: 'codex_task_capture_terminal_mismatch' };
      terminalObserved = true;
    }
  }
  return terminalObserved ? { ok: true } : { ok: false, reason: 'codex_task_capture_terminal_unavailable' };
}

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

export type CodexTaskOutcomeVerification =
  | { ok: true; receiptId: string; receiptHash: string; status: CodexTaskOutcome['status'] }
  | { ok: false; reason: string };

/** Verify a public outcome against authoritative retained work, not agent claims. */
export function verifyCodexTaskOutcome(value: unknown, input: {
  logicalRequestId: string;
  captureHash: string;
  sourceSnapshotHash: string;
  resultSnapshotHash: string;
  evaluationContractHash: string;
  publicEvidenceHash: string;
  workCompletedAt: string;
  terminalState: CodexTaskObservation['capture']['terminalState'];
  devicePublicKey: KeyObject;
  resolveGraderPublicKey(version: string): KeyObject | null;
  now?: Date;
}): CodexTaskOutcomeVerification {
  if (!validateOutcome(value)) return { ok: false, reason: 'codex_task_outcome_invalid' };
  const outcome = value as CodexTaskOutcome;
  const keys = ['logicalRequestId', 'captureHash', 'sourceSnapshotHash', 'resultSnapshotHash',
    'evaluationContractHash', 'publicEvidenceHash'] as const;
  if (keys.some(key => outcome[key] !== input[key])
    || !['completed', 'failed', 'interrupted'].includes(input.terminalState)
    || input.terminalState !== 'completed' && outcome.status === 'passed') {
    return { ok: false, reason: 'codex_task_outcome_mismatch' };
  }
  const completed = Date.parse(input.workCompletedAt), graded = Date.parse(outcome.completedAt);
  const now = (input.now ?? new Date()).getTime();
  if (!Number.isFinite(completed) || !Number.isFinite(now) || completed > graded || graded > now + 300_000) {
    return { ok: false, reason: 'codex_task_time_invalid' };
  }
  const { signature, ...payload } = outcome;
  try {
    const graderKey = input.resolveGraderPublicKey(outcome.signerKeyVersion);
    if (!canonicalSignature(signature) || !graderKey || graderKey.export({ type: 'spki', format: 'der' }).equals(
      input.devicePublicKey.export({ type: 'spki', format: 'der' }))
      || !verifyCanonicalObject(payload, signature, graderKey)) {
      return { ok: false, reason: 'codex_task_grader_signature_invalid' };
    }
  } catch { return { ok: false, reason: 'codex_task_grader_signature_invalid' }; }
  return { ok: true, receiptId: outcome.receiptId, receiptHash: sha256(canonicalize(outcome)), status: outcome.status };
}

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
    captureBytes?: Uint8Array;
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
  const nativeCapture = verifyCodexTaskCaptureBytes(retained.captureBytes, {
    scope: input.scope, capture: retained.capture, now: input.now,
  });
  if (!nativeCapture.ok) return nativeCapture;
  const outcome = observation.outcome;
  const started = Date.parse(observation.capture.startedAt), completed = Date.parse(observation.capture.completedAt);
  if (started > completed) {
    return { ok: false, reason: 'codex_task_time_invalid' };
  }
  const grade = verifyCodexTaskOutcome(outcome, {
    logicalRequestId, captureHash: observation.capture.captureHash,
    sourceSnapshotHash: observation.sourceSnapshotHash, resultSnapshotHash: observation.resultSnapshotHash,
    evaluationContractHash: input.evaluationContractHash, publicEvidenceHash: retained.publicEvidenceHash,
    workCompletedAt: observation.capture.completedAt, terminalState: observation.capture.terminalState,
    devicePublicKey: input.devicePublicKey, resolveGraderPublicKey: input.resolveGraderPublicKey, now: input.now,
  });
  if (!grade.ok) return grade;
  return { ok: true, logicalRequestId, observationHash: sha256(canonicalize(observation)), outcome: outcome.status };
}
