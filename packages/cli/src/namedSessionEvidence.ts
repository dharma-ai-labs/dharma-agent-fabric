import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { validateContract } from '@dharma-ai-labs/agent-fabric-contracts';
import { buildTrajectoryCapsule, trajectoryCapsuleHash } from '@dharma-ai-labs/agent-fabric-evidence-reduction';
import type { LocalVault, ScopedLocalVault, LocalProviderSessionBinding } from '@dharma-ai-labs/agent-fabric-local-vault';
import type { OrganizationPolicy } from '@dharma-ai-labs/agent-fabric-policy';
import { assertPolicy } from '@dharma-ai-labs/agent-fabric-policy';
import type { ProviderSession, SourceRecord } from '@dharma-ai-labs/agent-fabric-provider-adapters';
import { stripProtectedNativeContent } from '@dharma-ai-labs/agent-fabric-provider-adapters';
import type { CodexLocalWorkCapture } from '@dharma-ai-labs/agent-fabric-provider-adapters/experimental/codex-session';
import { assertCodexWorkPrompt, codexWorkCaptureSchemaId } from '@dharma-ai-labs/agent-fabric-provider-adapters/experimental/codex-session';

export interface NamedSessionEvidenceReceipt {
  schema: 'dharma.named-session-evidence/v1';
  organizationId: string;
  deviceId: string;
  workspaceId: string;
  bindingId: string;
  workId: string;
  captureId: string;
  captureHash: string;
  createdAt: string;
  state: 'queued' | 'unavailable' | 'blocked';
  trajectoryId: string | null;
  capsuleHash: string | null;
  code: 'relay_outbox_queued' | 'native_turn_unavailable' | 'evidence_queue_failed';
  acceptedLearningObservation: false;
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function sourceRecords(capture: CodexLocalWorkCapture, workspace: string): SourceRecord[] {
  const records: SourceRecord[] = [], completed = new Set<string>();
  if (capture.schema === 'dharma.codex-local-work-capture/v2') {
    records.push({ native: { type: 'user_message', content: capture.request.params.input,
      providerRequestHash: capture.requestHash }, sourcePath: 'dharma-codex-turn', line: 1,
      workspace, timestamp: capture.startedAt, kind: 'user_message', coverage: 'partial' });
  }
  function addItem(item: Record<string, unknown>, receivedAt: string, started: boolean) {
    const type = String(item.type || '');
    const tools = ['commandExecution', 'mcpToolCall', 'dynamicToolCall'];
    if (started && !tools.includes(type)) return;
    const key = typeof item.id === 'string' ? item.id : JSON.stringify(item);
    if (!started) { if (completed.has(key)) return; completed.add(key); }
    const kind = tools.includes(type) ? started ? 'tool_call' : 'tool_result'
      : type === 'userMessage' ? 'user_message' : type === 'agentMessage' ? 'agent_message'
        : type === 'fileChange' ? 'file_write' : 'metadata';
    records.push({ native: stripProtectedNativeContent({ ...item, type: kind, providerItemType: type }) as Record<string, unknown>, sourcePath: 'dharma-codex-turn',
      line: records.length + 1, workspace, timestamp: receivedAt, kind, coverage: 'partial' });
  }
  for (const event of capture.events) {
    const { method } = event.notification, params = object(event.notification.params);
    const turn = object(params.turn);
    if (params.threadId !== capture.providerThreadId
      || (params.turnId !== undefined && params.turnId !== capture.providerTurnId)
      || (turn.id !== undefined && turn.id !== capture.providerTurnId)) throw new Error('named_session_evidence_scope_mismatch');
    if (method === 'item/started' || method === 'item/completed') {
      addItem(object(params.item), event.receivedAt, method === 'item/started');
    } else if (method === 'turn/completed') {
      if (turn.status !== capture.providerTurnState) throw new Error('named_session_evidence_integrity_failed');
      if (Array.isArray(turn.items)) for (const item of turn.items) addItem(object(item), event.receivedAt, false);
      records.push({ native: { type: 'session_state', status: turn.status, error: turn.error ?? null },
        sourcePath: 'dharma-codex-turn', line: records.length + 1, workspace, timestamp: event.receivedAt,
        kind: 'session_state', coverage: 'partial' });
    } else if (method === 'error') {
      records.push({ native: { type: 'error', error: params.error ?? null }, sourcePath: 'dharma-codex-turn',
        line: records.length + 1, workspace, timestamp: event.receivedAt, kind: 'error', coverage: 'partial' });
    }
  }
  return records;
}

export async function queueNamedSessionEvidence(input: {
  vault: LocalVault | ScopedLocalVault;
  capture: CodexLocalWorkCapture;
  binding: Pick<LocalProviderSessionBinding, 'organizationId' | 'repositoryBindingId' | 'workspaceId' | 'deviceId'
    | 'endpointId' | 'membershipId' | 'provider' | 'bindingId' | 'sessionId' | 'workspaceRoot'>;
  policy: OrganizationPolicy;
}): Promise<NamedSessionEvidenceReceipt> {
  const { capture, binding, vault, policy } = input;
  const valid = await validateContract(join(import.meta.dirname, 'schemas'),
    codexWorkCaptureSchemaId(capture), capture);
  if (!valid.ok) throw new Error('named_session_evidence_invalid');
  for (const key of ['organizationId', 'repositoryBindingId', 'workspaceId', 'deviceId', 'endpointId',
    'membershipId', 'provider', 'bindingId'] as const) {
    if (capture[key] !== binding[key]) throw new Error('named_session_evidence_scope_mismatch');
  }
  if (capture.providerThreadId !== binding.sessionId || policy.organizationId !== binding.organizationId
    || (policy.serverAuthorization && policy.serverAuthorization.workspaceId !== binding.workspaceId)) {
    throw new Error('named_session_evidence_scope_mismatch');
  }
  const eventsHash = `sha256:${createHash('sha256').update(JSON.stringify(capture.events)).digest('hex')}`;
  if (eventsHash !== capture.eventsHash || Date.parse(capture.startedAt) > Date.parse(capture.closedAt)) {
    throw new Error('named_session_evidence_integrity_failed');
  }
  if (capture.schema === 'dharma.codex-local-work-capture/v2') {
    const request = capture.request;
    if (request.params.threadId !== binding.sessionId || request.params.cwd !== binding.workspaceRoot) {
      throw new Error('named_session_evidence_scope_mismatch');
    }
    if (`sha256:${createHash('sha256').update(JSON.stringify(request)).digest('hex')}` !== capture.requestHash) {
      throw new Error('named_session_evidence_integrity_failed');
    }
    assertCodexWorkPrompt(request.params.input[0].text, true);
  }
  assertPolicy(policy);
  const raw = Buffer.from(JSON.stringify(capture));
  const captureHash = `sha256:${createHash('sha256').update(raw).digest('hex')}`;
  const base = { schema: 'dharma.named-session-evidence/v1' as const, organizationId: binding.organizationId,
    deviceId: binding.deviceId, workspaceId: binding.workspaceId, bindingId: binding.bindingId, workId: capture.workId,
    captureId: capture.captureId, captureHash, createdAt: capture.closedAt, acceptedLearningObservation: false as const };
  if (!capture.providerTurnId || !capture.events.length || capture.providerTurnState === 'unconfirmed') {
    return { ...base, state: 'unavailable', trajectoryId: null, capsuleHash: null, code: 'native_turn_unavailable' };
  }
  // Turn notifications do not prove full context, executed model, or applied skill. Preserve that limit in the capsule.
  const session: ProviderSession = { provider: 'codex', sessionId: `codex-turn:${binding.sessionId}:${capture.providerTurnId}`,
    sourcePath: 'dharma-codex-turn', workspace: binding.workspaceRoot, records: sourceRecords(capture, binding.workspaceRoot),
    coverage: 'partial', startedAt: capture.startedAt, endedAt: capture.closedAt };
  if (!session.records.length) return { ...base, state: 'unavailable', trajectoryId: null, capsuleHash: null,
    code: 'native_turn_unavailable' };
  const capsule = buildTrajectoryCapsule({ organizationId: binding.organizationId, deviceId: binding.deviceId,
    workspaceId: binding.workspaceId, session, policy, rawContentId: captureHash, rawBytes: raw.length,
    rawKind: 'raw-provider-turn' });
  capsule.coverage.missingFields = [...new Set([...capsule.coverage.missingFields.filter(field => field !== 'workspace_on_some_events'),
    capture.schema === 'dharma.codex-local-work-capture/v2' ? 'retained_context_unavailable' : 'turn_notifications_only',
    'executed_model_unreported', 'applied_skill_unverified', ...capture.limitations])];
  capsule.capsuleHash = trajectoryCapsuleHash(capsule);
  const checked = await validateContract(join(import.meta.dirname, 'schemas'),
    'https://schemas.dharma-ai.io/trajectory-capsule/v2', capsule);
  if (!checked.ok || Buffer.byteLength(JSON.stringify(capsule)) > policy.evidence.maximumCapsuleBytes) {
    throw new Error('named_session_evidence_capsule_invalid');
  }
  const existing = await vault.getCapsuleMetadata(capsule.trajectoryId, capsule.revision);
  if (existing && existing.capsuleHash !== capsule.capsuleHash) throw new Error('named_session_evidence_revision_conflict');
  if (!existing) await vault.commitCapture({ raw: { plaintext: raw, kind: 'raw-provider-turn', expectedContentId: captureHash },
    capsule: { plaintext: Buffer.from(JSON.stringify(capsule)), trajectoryId: capsule.trajectoryId,
      revision: capsule.revision, capsuleHash: capsule.capsuleHash },
    session: { sessionId: session.sessionId, provider: session.provider, workspaceId: binding.workspaceId,
      sourceLocator: session.sourcePath, status: session.coverage, observedAt: session.endedAt } });
  await vault.queueCapsuleSync(capsule.trajectoryId, capsule.revision);
  return { ...base, state: 'queued', trajectoryId: capsule.trajectoryId, capsuleHash: capsule.capsuleHash, code: 'relay_outbox_queued' };
}
