import { createHash, randomUUID } from 'node:crypto';
import type { CodexBridgeBinding } from './codexAppServerSession.js';

interface CodexWorkCaptureFields {
  captureId: string;
  organizationId: string;
  repositoryBindingId: string;
  workspaceId: string;
  endpointId: string;
  membershipId: string;
  deviceId: string;
  bindingId: string;
  workId: string;
  provider: 'codex';
  providerThreadId: string;
  providerTurnId: string | null;
  startedAt: string;
  closedAt: string;
  workOutcome: 'completed' | 'failed';
  providerTurnState: 'completed' | 'failed' | 'interrupted' | 'unconfirmed';
  coverage: 'observed' | 'partial' | 'unavailable';
  limitations: string[];
  droppedEvents: number;
  acceptedLearningObservation: false;
  executedModel: null;
  eventsHash: string;
  events: Array<{ sequence: number; receivedAt: string; notification: Record<string, unknown> }>;
}

export interface CodexWorkRequest {
  method: 'turn/start';
  params: { threadId: string; input: [{ type: 'text'; text: string }]; cwd: string;
    approvalPolicy: 'never'; permissions: 'dharma_work' };
}

export type CodexLocalWorkCapture = CodexWorkCaptureFields & (
  { schema: 'dharma.codex-local-work-capture/v1'; captureScope: 'turn_notifications' }
  | { schema: 'dharma.codex-local-work-capture/v2'; captureScope: 'turn_request_and_notifications';
    request: CodexWorkRequest; requestHash: string }
);

export function codexWorkCaptureSchemaId(capture: CodexLocalWorkCapture) {
  return capture.schema === 'dharma.codex-local-work-capture/v2'
    ? 'https://schemas.dharma-ai.io/codex-local-work-capture/v2'
    : 'https://schemas.dharma-ai.io/codex-local-work-capture/v1';
}

export type CodexTurnEvidenceSink = (capture: CodexLocalWorkCapture) => Promise<void>;

// Limits apply to both early notifications and the selected turn. No raw payload is returned publicly.
const MAX_EVENTS = 2048, MAX_BYTES = 2 * 1024 * 1024, MAX_EVENT_BYTES = 256 * 1024;

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function containsCredential(value: unknown, depth = 0): boolean {
  if (depth > 32) return true;
  if (typeof value === 'string') {
    if (/dhab_[A-Za-z0-9_-]+|Bearer\s+[A-Za-z0-9._-]+|-----BEGIN [A-Z ]*PRIVATE KEY-----/i.test(value)) return true;
    if (/^[\[{]/.test(value.trim())) {
      try { return containsCredential(JSON.parse(value), depth + 1); } catch { /* Inspect non-JSON text below. */ }
    }
    return /["']?(?:authorization|cookie|access[_-]?token|refresh[_-]?token|api[_-]?key|private[_-]?key|client[_-]?secret|credentials?|grant|password|secret)["']?\s*[:=]/i.test(value);
  }
  if (Array.isArray(value)) return value.some(item => containsCredential(item, depth + 1));
  if (record(value)) return Object.entries(value as Record<string, unknown>).some(([key, item]) => {
    const normalized = key.replace(/([a-z0-9])([A-Z])/g, '$1_$2').replace(/([A-Z])([A-Z][a-z])/g, '$1_$2')
      .replace(/[-\s]+/g, '_').toLowerCase();
    return /^(?:authorization|proxy_authorization|cookie|set_cookie|access_token|refresh_token|api_key|private_key|credential|credentials|grant|password|secret|token)$/.test(normalized)
      || containsCredential(item, depth + 1);
  });
  return false;
}

export function assertCodexWorkPrompt(prompt: unknown, nativeRequest = false): asserts prompt is string {
  if (typeof prompt !== 'string' || prompt.length < 1 || prompt.length > (nativeRequest ? 12000 : 10000)) {
    throw new Error('codex_session_work_invalid');
  }
  if (containsCredential(prompt)) throw new Error('codex_session_work_credentials_forbidden');
}

export function createCodexTurnCapture(binding: CodexBridgeBinding, workId: string) {
  const startedAt = new Date().toISOString();
  type Entry = CodexLocalWorkCapture['events'][number] & { turnId: string; bytes: number };
  let turnId: string | null = null, bytes = 0, sequence = 0, droppedEvents = 0;
  let events: Entry[] = [];
  let request: CodexWorkRequest | undefined;
  const limitations = new Set<string>();
  let providerTurnState: CodexLocalWorkCapture['providerTurnState'] = 'unconfirmed';

  function observe(value: unknown) {
    const event = record(value), params = record(event?.params);
    if (!event || !params || params.threadId !== binding.threadId || typeof event.method !== 'string'
      || !/^(?:item\/|turn\/|thread\/tokenUsage\/updated$|error$)/.test(event.method)) return;
    const turn = record(params.turn);
    if (typeof params.turnId === 'string' && typeof turn?.id === 'string' && params.turnId !== turn.id) {
      limitations.add('conflicting_turn_identity'); droppedEvents++; return;
    }
    const eventTurnId = typeof params.turnId === 'string' ? params.turnId : turn?.id;
    if (typeof eventTurnId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(eventTurnId)) {
      limitations.add('unscoped_notification'); droppedEvents++; return;
    }
    if (turnId && eventTurnId !== turnId) return;
    if (event.method === 'turn/completed' && eventTurnId === turnId) {
      if (turn?.status === 'completed' || turn?.status === 'failed' || turn?.status === 'interrupted') {
        providerTurnState = turn.status;
      }
    }
    let serialized: string;
    try { serialized = JSON.stringify(event); } catch { limitations.add('invalid_notification'); droppedEvents++; return; }
    const size = Buffer.byteLength(serialized);
    if (size > MAX_EVENT_BYTES || events.length >= MAX_EVENTS || bytes + size > MAX_BYTES) {
      limitations.add('capture_limit'); droppedEvents++; return;
    }
    // Grants and recognizable credential envelopes must not enter even the encrypted evidence store.
    if (containsCredential(event)) {
      limitations.add('credential_excluded'); droppedEvents++; return;
    }
    events.push({ sequence: sequence++, receivedAt: new Date().toISOString(), turnId: eventTurnId,
      bytes: size, notification: JSON.parse(serialized) });
    bytes += size;
  }

  return {
    observe,
    retainRequest(params: CodexWorkRequest['params']) {
      assertCodexWorkPrompt(params.input[0].text, true);
      if (request || params.threadId !== binding.threadId || params.cwd !== binding.workspaceRoot
        || params.permissions !== 'dharma_work' || params.approvalPolicy !== 'never') {
        throw new Error('codex_session_evidence_request_invalid');
      }
      request = structuredClone({ method: 'turn/start', params });
    },
    bind(id: string) {
      turnId = id;
      events = events.filter(event => event.turnId === id);
      bytes = events.reduce((sum, event) => sum + event.bytes, 0);
      for (const event of events) {
        const notification = event.notification, turn = record(record(notification.params)?.turn);
        if (notification.method === 'turn/completed'
          && (turn?.status === 'completed' || turn?.status === 'failed' || turn?.status === 'interrupted')) {
          providerTurnState = turn.status;
        }
      }
    },
    finish(workOutcome: CodexLocalWorkCapture['workOutcome']): CodexLocalWorkCapture {
      // If turn/start did not identify a turn, no buffered event can safely be attributed to this work.
      if (!turnId) { events = []; limitations.add('turn_unconfirmed'); }
      if (providerTurnState === 'unconfirmed') limitations.add('terminal_unconfirmed');
      const captured = events.map(({ turnId: _turnId, bytes: _bytes, ...event }) => event);
      return {
        ...(request ? { schema: 'dharma.codex-local-work-capture/v2' as const,
          captureScope: 'turn_request_and_notifications' as const, request: structuredClone(request),
          requestHash: `sha256:${createHash('sha256').update(JSON.stringify(request)).digest('hex')}` }
          : { schema: 'dharma.codex-local-work-capture/v1' as const, captureScope: 'turn_notifications' as const }),
        captureId: randomUUID(),
        organizationId: binding.organizationId, repositoryBindingId: binding.repositoryBindingId,
        workspaceId: binding.workspaceId, endpointId: binding.endpointId, membershipId: binding.membershipId,
        deviceId: binding.deviceId, bindingId: binding.bindingId, workId, provider: 'codex',
        providerThreadId: binding.threadId, providerTurnId: turnId, startedAt, closedAt: new Date().toISOString(),
        workOutcome, providerTurnState,
        coverage: !captured.length ? 'unavailable' : limitations.size ? 'partial' : 'observed',
        limitations: [...limitations].sort(), droppedEvents, acceptedLearningObservation: false, executedModel: null,
        eventsHash: `sha256:${createHash('sha256').update(JSON.stringify(captured)).digest('hex')}`, events: captured,
      };
    },
  };
}
