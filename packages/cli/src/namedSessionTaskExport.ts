import type { LocalProviderSessionBinding } from '@dharma-ai-labs/agent-fabric-local-vault';
import type { OrganizationPolicy } from '@dharma-ai-labs/agent-fabric-policy';
import type { CodexLocalWorkCapture } from '@dharma-ai-labs/agent-fabric-provider-adapters/experimental/codex-session';
import { containsCredential } from '@dharma-ai-labs/agent-fabric-provider-adapters/experimental/codex-session';
import { join } from 'node:path';
import { canonicalize, sha256, validateContract, verifyCodexTaskCaptureBytes } from '@dharma-ai-labs/agent-fabric-contracts';
import { assertPolicy } from '@dharma-ai-labs/agent-fabric-policy';
import { redactValue, referencesExcludedPath, containsDisallowedLocalPath, type RedactionStats } from '@dharma-ai-labs/agent-fabric-evidence-reduction';

export interface NamedSessionTaskExportInput {
  capture: CodexLocalWorkCapture;
  binding: LocalProviderSessionBinding;
  contextBytes: Uint8Array;
  contextHash: string;
  policy: OrganizationPolicy;
}

export type NamedSessionTaskExportResult =
  | { state: 'ready'; bytes: string; exportHash: string; acceptedLearningObservation: false }
  | { state: 'not_authorized' | 'blocked' | 'excluded'; code: string; acceptedLearningObservation: false };

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function publicOnly(value: unknown, stats: RedactionStats, depth = 0): unknown {
  if (depth > 64) throw new Error('task_export_depth_exceeded');
  if (Array.isArray(value)) return value.map(child => publicOnly(child, stats, depth + 1)).filter(child => child !== undefined);
  if (typeof value === 'string' && /^[\[{]/.test(value.trim())) {
    let parsed: unknown;
    try { parsed = JSON.parse(value); } catch { return value; }
    return JSON.stringify(publicOnly(parsed, stats, depth + 1));
  }
  const record = object(value);
  if (!record) return value;
  if (record.type === 'reasoning') {
    stats.classes.add('protected_reasoning'); stats.redactedValues++;
    return undefined;
  }
  const result: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(record)) {
    const normalized = key.replace(/([a-z0-9])([A-Z])/g, '$1_$2').replace(/[-\s]+/g, '_').toLowerCase();
    if (/^(encrypted_content|encrypted_reasoning|reasoning|reasoning_content|chain_of_thought)$/.test(normalized)
      || /(?:^|_)(?:authorization|proxy_authorization|cookie|set_cookie|password|passwd|secret|client_secret|api_key|access_token|refresh_token|auth_token|private_key|credential|credentials|grant|token|aws_secret_access_key)(?:$|_)/.test(normalized)) {
      stats.classes.add('protected_or_sensitive_field'); stats.redactedValues++;
      continue;
    }
    const safe = publicOnly(child, stats, depth + 1);
    if (safe !== undefined) result[key] = safe;
  }
  return result;
}

function excluded(value: unknown, paths: string[], depth = 0): boolean {
  if (depth > 64) return true;
  if (typeof value === 'string') return referencesExcludedPath(value, paths, 'content');
  if (Array.isArray(value)) return value.some(child => excluded(child, paths, depth + 1));
  if (object(value)) return Object.entries(value as Record<string, unknown>)
    .some(([key, child]) => referencesExcludedPath(key, paths, 'content') || excluded(child, paths, depth + 1));
  return false;
}

// This is a portable task-level projection, not native-wire evidence or an admission receipt.
export async function prepareNamedSessionTaskExport(input: NamedSessionTaskExportInput): Promise<NamedSessionTaskExportResult> {
  const fail = (state: 'not_authorized' | 'blocked' | 'excluded', code: string): NamedSessionTaskExportResult =>
    ({ state, code, acceptedLearningObservation: false });
  const { policy, binding, capture } = input;
  try { assertPolicy(policy); } catch { return fail('not_authorized', 'task_export_not_authorized'); }
  const disclosure = policy.evidence.automaticDisclosure;
  if (disclosure?.mode !== 'customer_authorized_content' || policy.organizationId !== binding.organizationId
    || policy.serverAuthorization?.workspaceId !== binding.workspaceId
    || policy.serverAuthorization.organizationId !== binding.organizationId) {
    return fail('not_authorized', 'task_export_not_authorized');
  }
  if (capture.schema !== 'dharma.codex-local-work-capture/v2') return fail('blocked', 'task_export_request_unavailable');
  const scope = { organizationId: binding.organizationId, repositoryBindingId: binding.repositoryBindingId,
    workspaceId: binding.workspaceId, endpointId: binding.endpointId, membershipId: binding.membershipId,
    deviceId: binding.deviceId, bindingId: binding.bindingId, workId: capture.workId };
  const rawBytes = Buffer.from(JSON.stringify(capture)), captureHash = sha256(rawBytes);
  if (capture.providerThreadId !== binding.sessionId || capture.request.params.cwd !== binding.workspaceRoot
    || !['completed', 'failed', 'interrupted'].includes(capture.providerTurnState)) {
    return fail('blocked', 'task_export_capture_invalid');
  }
  const checked = verifyCodexTaskCaptureBytes(rawBytes, { scope, capture: {
    captureId: capture.captureId, captureHash, requestHash: capture.requestHash, eventsHash: capture.eventsHash,
    threadId: binding.sessionId, turnId: capture.providerTurnId!, startedAt: capture.startedAt, completedAt: capture.closedAt,
    terminalState: capture.providerTurnState as 'completed' | 'failed' | 'interrupted', coverage: 'observed', droppedEvents: 0 } });
  if (!checked.ok) return fail('blocked', 'task_export_capture_invalid');
  let context: Record<string, unknown>;
  try {
    if (input.contextBytes.byteLength > 2 * 1024 * 1024 || sha256(input.contextBytes) !== input.contextHash) throw new Error();
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(input.contextBytes);
    const parsed = object(JSON.parse(text));
    const allowed = new Set(['schema', 'threadId', 'capturedAt', 'configuredModel', 'configuredModelProvider',
      'configuredReasoningEffort', 'executedModel', 'replayMode', 'limitations', 'turns']);
    if (!parsed || canonicalize(parsed) !== text || parsed.schema !== 'dharma.codex-public-context/v1'
      || Object.keys(parsed).some(key => !allowed.has(key))
      || parsed.threadId !== binding.sessionId || parsed.executedModel !== null || parsed.replayMode !== 'task_level'
      || !Number.isFinite(Date.parse(String(parsed.capturedAt))) || Date.parse(String(parsed.capturedAt)) > Date.parse(capture.startedAt)
      || !Array.isArray(parsed.turns) || parsed.turns.length > 2048
      || parsed.turns.some(value => { const turn = object(value); return !turn || typeof turn.id !== 'string'
        || !['completed', 'failed', 'interrupted'].includes(String(turn.status)) || !Array.isArray(turn.items); })) throw new Error();
    context = parsed;
  } catch { return fail('blocked', 'task_export_context_invalid'); }
  const stats: RedactionStats = { classes: new Set(), redactedValues: 0, excludedPaths: 0, inputBytes: 0, outputBytes: 0 };
  let projected: Record<string, unknown>;
  try {
    const publicData = publicOnly({ request: capture.request, events: capture.events, context }, stats);
    if (excluded(publicData, policy.evidence.excludePaths)) return fail('excluded', 'task_export_configured_excluded_path');
    projected = redactValue(publicData, stats) as Record<string, unknown>;
    if (containsCredential(projected) || containsDisallowedLocalPath(projected)) throw new Error();
    const portableContext = object(projected.context);
    if (!portableContext) throw new Error();
    portableContext.schema = 'dharma.codex-task-portable-context/v1';
  } catch { return fail('blocked', 'task_export_disclosure_invalid'); }
  const value = { schema: 'dharma.codex-task-replay-export/v1', ...scope,
    captureId: capture.captureId, providerThreadId: binding.sessionId, providerTurnId: capture.providerTurnId,
    timeRange: { startedAt: capture.startedAt, completedAt: capture.closedAt }, terminalState: capture.providerTurnState,
    policy: { revision: policy.revision, consentReceiptId: disclosure.consentReceiptId,
      contentClass: 'native_provider_payload', purpose: 'continuous_evaluation' },
    original: { captureHash, requestHash: capture.requestHash, eventsHash: capture.eventsHash, contextHash: input.contextHash },
    exported: { requestHash: sha256(canonicalize(projected.request)), eventsHash: sha256(canonicalize(projected.events)),
      contextHash: sha256(canonicalize(projected.context)) }, ...projected,
    redaction: { classes: [...stats.classes].sort(), redactedValues: stats.redactedValues },
    coverage: 'redacted_task_level', limitations: ['not_full_native_capture', 'protected_reasoning_excluded',
      'local_paths_redacted', 'executed_model_unreported'], acceptedLearningObservation: false };
  const bytes = canonicalize(value);
  const valid = await validateContract(join(import.meta.dirname, 'schemas'),
    'https://schemas.dharma-ai.io/codex-task-replay-export/v1', value);
  if (!valid.ok || Buffer.byteLength(bytes) > Math.min(524288, policy.evidence.maximumCapsuleBytes)) {
    return fail('blocked', 'task_export_size_or_schema_invalid');
  }
  // Recheck the same verified policy after asynchronous schema loading.
  try { assertPolicy(policy); } catch { return fail('not_authorized', 'task_export_not_authorized'); }
  return { state: 'ready', bytes, exportHash: sha256(bytes), acceptedLearningObservation: false };
}
