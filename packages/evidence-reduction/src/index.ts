import { createHash } from 'node:crypto';
import { basename } from 'node:path';
import { canonicalize, sha256, type EvidenceState } from '@dharma-ai/agent-fabric-contracts';
import type { OrganizationPolicy } from '@dharma-ai/agent-fabric-policy';
import type { ProviderSession, SourceRecord } from '@dharma-ai/agent-fabric-provider-adapters';

const SECRET_PATTERNS: Array<{ name: string; pattern: RegExp }> = [
  { name: 'private_key', pattern: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g },
  { name: 'github_token', pattern: /\b(?:gh[opusr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g },
  { name: 'openai_key', pattern: /\bsk-[A-Za-z0-9_-]{20,}\b/g },
  { name: 'aws_access_key', pattern: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g },
  { name: 'jwt', pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g },
  { name: 'connection_string', pattern: /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?):\/\/[^\s"']+/gi },
  { name: 'authorization', pattern: /\b(?:authorization|api[_-]?key|access[_-]?token|secret)\s*[:=]\s*["']?[A-Za-z0-9_./+=-]{12,}["']?/gi },
];

export interface RedactionStats {
  classes: Set<string>;
  redactedValues: number;
  excludedPaths: number;
  inputBytes: number;
  outputBytes: number;
}

export interface AgentEvent {
  schema: 'dharma.agent-event/v1';
  eventId: string;
  organizationId: string;
  deviceId: string;
  workspaceId: string;
  provider: ProviderSession['provider'];
  sessionId: string;
  sequence: number;
  occurredAt: string;
  kind: string;
  coverage: EvidenceState;
  contentRefs: string[];
  payload: Record<string, unknown>;
  source: { nativeEventId: string | null; sourceKind: string; localLocatorId: string | null };
  skillBundleId: string | null;
  providerModel: string | null;
}

export interface TrajectoryCapsule {
  schema: 'dharma.trajectory-capsule/v1';
  trajectoryId: string;
  revision: number;
  previousRevisionHash: string | null;
  organizationId: string;
  deviceId: string;
  workspaceId: string;
  provider: string;
  sessionId: string;
  taskId: string | null;
  timeRange: { start: string; end: string };
  status: 'completed' | 'partial';
  evidenceMode: OrganizationPolicy['evidence']['defaultMode'];
  coverage: { state: 'observed' | 'partial'; admittedSessions: number; excludedSessions: number; missingFields: string[] };
  repoState: Record<string, unknown>;
  skillState: Record<string, unknown>;
  events: AgentEvent[];
  contentIndex: Array<{ contentId: string; kind: string; bytes: number; uploaded: boolean; availableLocally: boolean; mimeType: string | null; normalizedPath: string | null }>;
  validationResults: unknown[];
  redactionReceipt: { policyRevision: string; classes: string[]; redactedValues: number; excludedPaths: number; inputBytes: number; outputBytes: number };
  localEvidenceAvailable: Array<{ contentId: string; kind: string; bytes: number }>;
  capsuleHash: string;
  createdAt: string;
}

function deterministicUuid(value: string): string {
  const bytes = createHash('sha256').update(value).digest().subarray(0, 16);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x50;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function redactString(value: string, stats: RedactionStats): string {
  stats.inputBytes += Buffer.byteLength(value);
  let output = value;
  for (const rule of SECRET_PATTERNS) {
    output = output.replace(rule.pattern, () => {
      stats.classes.add(rule.name);
      stats.redactedValues += 1;
      return `[REDACTED:${rule.name}]`;
    });
  }
  stats.outputBytes += Buffer.byteLength(output);
  return output;
}

function redactValue(value: unknown, stats: RedactionStats, key = ''): unknown {
  if (/^(authorization|cookie|set-cookie|password|secret|token|api[_-]?key)$/i.test(key)) {
    if (value !== null && value !== undefined) {
      stats.classes.add('sensitive_field');
      stats.redactedValues += 1;
    }
    return '[REDACTED:sensitive_field]';
  }
  if (typeof value === 'string') return redactString(value, stats);
  if (Array.isArray(value)) return value.map((item) => redactValue(item, stats));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([childKey, child]) => [
      childKey,
      redactValue(child, stats, childKey),
    ]));
  }
  return value;
}

function nativeEventId(record: SourceRecord): string | null {
  for (const key of ['id', 'event_id', 'eventId', 'call_id', 'callId']) {
    const value = record.native[key];
    if (typeof value === 'string') return value;
  }
  return null;
}

function providerModel(record: SourceRecord): string | null {
  for (const key of ['model', 'model_name', 'modelName']) {
    const value = record.native[key];
    if (typeof value === 'string') return value;
  }
  return null;
}

export function buildTrajectoryCapsule(input: {
  organizationId: string;
  deviceId: string;
  workspaceId: string;
  session: ProviderSession;
  policy: OrganizationPolicy;
  rawContentId: string;
  rawBytes: number;
  rawKind?: 'raw-provider-session' | 'raw-provider-turn';
  createdAt?: string;
}): TrajectoryCapsule {
  const stats: RedactionStats = {
    classes: new Set(), redactedValues: 0, excludedPaths: 0, inputBytes: 0, outputBytes: 0,
  };
  const trajectoryId = deterministicUuid(`${input.organizationId}:${input.deviceId}:${input.session.provider}:${input.session.sessionId}`);
  const seen = new Set<string>();
  const events: AgentEvent[] = [];
  for (const [index, record] of input.session.records.entries()) {
    const payload = redactValue(record.native, stats) as Record<string, unknown>;
    const fingerprint = sha256(canonicalize({ kind: record.kind, payload }));
    if (seen.has(fingerprint)) continue;
    seen.add(fingerprint);
    events.push({
      schema: 'dharma.agent-event/v1',
      eventId: deterministicUuid(`${trajectoryId}:${index}:${fingerprint}`),
      organizationId: input.organizationId,
      deviceId: input.deviceId,
      workspaceId: input.workspaceId,
      provider: input.session.provider,
      sessionId: input.session.sessionId,
      sequence: events.length,
      occurredAt: record.timestamp ? new Date(record.timestamp).toISOString() : input.session.startedAt,
      kind: record.kind,
      coverage: input.session.coverage,
      contentRefs: [],
      payload,
      source: {
        nativeEventId: nativeEventId(record),
        sourceKind: String(record.native.type ?? record.native.kind ?? 'unknown'),
        localLocatorId: sha256(`${basename(record.sourcePath)}:${record.line}`),
      },
      skillBundleId: null,
      providerModel: providerModel(record),
    });
  }

  const createdAt = input.createdAt ?? new Date().toISOString();
  const base = {
    schema: 'dharma.trajectory-capsule/v1' as const,
    trajectoryId,
    revision: 1,
    previousRevisionHash: null,
    organizationId: input.organizationId,
    deviceId: input.deviceId,
    workspaceId: input.workspaceId,
    provider: input.session.provider,
    sessionId: input.session.sessionId,
    taskId: null,
    timeRange: { start: input.session.startedAt, end: input.session.endedAt },
    status: input.session.coverage === 'observed' ? 'completed' as const : 'partial' as const,
    evidenceMode: input.policy.evidence.defaultMode,
    coverage: {
      state: input.session.coverage === 'observed' ? 'observed' as const : 'partial' as const,
      admittedSessions: 1,
      excludedSessions: 0,
      missingFields: input.session.coverage === 'observed' ? [] : ['workspace_on_some_events'],
    },
    repoState: {},
    skillState: {},
    events,
    contentIndex: [{
      contentId: input.rawContentId,
      kind: input.rawKind || 'raw-provider-session',
      bytes: input.rawBytes,
      uploaded: false,
      availableLocally: true,
      mimeType: 'application/x-ndjson',
      normalizedPath: null,
    }],
    validationResults: [],
    redactionReceipt: {
      policyRevision: input.policy.revision,
      classes: [...stats.classes].sort(),
      redactedValues: stats.redactedValues,
      excludedPaths: stats.excludedPaths,
      inputBytes: stats.inputBytes,
      outputBytes: stats.outputBytes,
    },
    localEvidenceAvailable: [{ contentId: input.rawContentId, kind: input.rawKind || 'raw-provider-session', bytes: input.rawBytes }],
    createdAt,
  };

  while (Buffer.byteLength(canonicalize(base)) > input.policy.evidence.maximumCapsuleBytes && base.events.length > 1) {
    base.events.shift();
    base.events.forEach((event, index) => { event.sequence = index; });
    base.coverage.state = 'partial';
    base.status = 'partial';
    if (!base.coverage.missingFields.includes('events_collapsed_for_size')) {
      base.coverage.missingFields.push('events_collapsed_for_size');
    }
  }
  if (Buffer.byteLength(canonicalize(base)) > input.policy.evidence.maximumCapsuleBytes) {
    throw new Error('Trajectory capsule cannot fit the organization maximumCapsuleBytes policy.');
  }
  return { ...base, capsuleHash: sha256(canonicalize(base)) };
}

export { redactValue };
