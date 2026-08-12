import { createHash } from 'node:crypto';
import { basename } from 'node:path';
import { canonicalize, sha256, type EvidenceState } from '@dharma-ai-labs/agent-fabric-contracts';
import type { OrganizationPolicy } from '@dharma-ai-labs/agent-fabric-policy';
import type { ProviderSession, SourceRecord } from '@dharma-ai-labs/agent-fabric-provider-adapters';

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
  automaticDisclosureMode: 'metadata_only' | 'local_analysis' | 'customer_authorized_content';
  coverage: { state: 'observed' | 'partial'; admittedSessions: number; excludedSessions: number; missingFields: string[] };
  repoState: Record<string, unknown>;
  skillState: Record<string, unknown>;
  events: AgentEvent[];
  contentIndex: Array<{ contentId: string; kind: string; bytes: number; uploaded: boolean; availableLocally: boolean; mimeType: string | null; normalizedPath: string | null }>;
  validationResults: unknown[];
  localAnalysis: {
    schema: 'dharma.local-trajectory-analysis/v1';
    analyzer: 'deterministic';
    recordCount: number;
    recordBytes: { total: number; maximum: number };
    eventKinds: Record<string, number>;
    toolDiscipline: { calls: number; results: number; unmatchedCalls: number; orphanResults: number };
    outcomeSignals: { errorRecords: number; incomplete: boolean; coverage: EvidenceState };
    durationMs: number;
    semanticReviewRecommended: boolean;
    reasonCodes: string[];
  } | null;
  redactionReceipt: {
    policyRevision: string;
    disclosureClass: 'automatic_capsule';
    disclosureMode: 'metadata_only' | 'local_analysis' | 'customer_authorized_content';
    consentReceiptId: string | null;
    disclosedClasses: string[];
    excludedClasses: string[];
    classes: string[];
    redactedValues: number;
    excludedPaths: number;
    inputBytes: number;
    outputBytes: number;
  };
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

type RedactionOptions = { pseudonymizeIdentity?: boolean };

const LOCAL_PATH_PATTERNS = [
  /\/(?:home|Users)\/[A-Za-z0-9._-]+(?:\/[^\s"'<>|,}\]]+)*/g,
  /\b[A-Za-z]:\\{1,}[^\s"'<>|,}\]]+/g,
  /\\{2,}(?:wsl(?:\.localhost)?\\{1,})?[^\s"'<>|,}\]]+/gi,
];

function redactString(value: string, stats: RedactionStats, options: RedactionOptions): string {
  stats.inputBytes += Buffer.byteLength(value);
  let output = value.replaceAll('\u0000', () => {
    stats.classes.add('invalid_unicode_nul');
    stats.redactedValues += 1;
    return '[REMOVED:nul]';
  });
  for (const rule of SECRET_PATTERNS) {
    output = output.replace(rule.pattern, () => {
      stats.classes.add(rule.name);
      stats.redactedValues += 1;
      return `[REDACTED:${rule.name}]`;
    });
  }
  if (options.pseudonymizeIdentity) {
    for (const pattern of LOCAL_PATH_PATTERNS) {
      output = output.replace(pattern, () => {
        stats.classes.add('local_path');
        stats.redactedValues += 1;
        return '[REDACTED:local_path]';
      });
    }
  }
  stats.outputBytes += Buffer.byteLength(output);
  return output;
}

function redactValue(value: unknown, stats: RedactionStats, key = '', options: RedactionOptions = {}): unknown {
  if (/^(authorization|cookie|set-cookie|password|secret|token|api[_-]?key)$/i.test(key)) {
    if (value !== null && value !== undefined) {
      stats.classes.add('sensitive_field');
      stats.redactedValues += 1;
    }
    return '[REDACTED:sensitive_field]';
  }
  if (options.pseudonymizeIdentity && /^(cwd|source[_-]?path|workspace[_-]?path|local[_-]?path)$/i.test(key) && typeof value === 'string') {
    stats.inputBytes += Buffer.byteLength(value);
    stats.outputBytes += Buffer.byteLength('[REDACTED:local_path]');
    stats.classes.add('local_path');
    stats.redactedValues += 1;
    return '[REDACTED:local_path]';
  }
  if (typeof value === 'string') return redactString(value, stats, options);
  if (Array.isArray(value)) return value.map((item) => redactValue(item, stats, '', options));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([childKey, child]) => [
      childKey,
      redactValue(child, stats, childKey, options),
    ]));
  }
  return value;
}

const AUTOMATIC_DISCLOSED_CLASSES = [
  'tenant_identifier',
  'device_identifier',
  'workspace_identifier',
  'pseudonymous_session_identifier',
  'provider_name',
  'event_kind',
  'event_timestamp',
  'event_coverage',
  'source_kind',
  'record_size',
  'local_evidence_descriptor',
] as const;

function disclosureMode(policy: OrganizationPolicy): TrajectoryCapsule['automaticDisclosureMode'] {
  return policy.evidence.automaticDisclosure?.mode ?? 'local_analysis';
}

function isErrorRecord(record: SourceRecord): boolean {
  if (/(error|failed|failure|exception|timeout|cancelled)/i.test(record.kind)) return true;
  const nativeType = String(record.native.type ?? record.native.kind ?? '');
  const status = String(record.native.status ?? record.native.outcome ?? '');
  return /(error|failed|failure|exception|timeout|cancelled)/i.test(`${nativeType} ${status}`);
}

function buildLocalAnalysis(session: ProviderSession): NonNullable<TrajectoryCapsule['localAnalysis']> {
  const eventKinds: Record<string, number> = {};
  let totalBytes = 0;
  let maximumBytes = 0;
  let calls = 0;
  let results = 0;
  let errorRecords = 0;
  for (const record of session.records) {
    const kind = safeSourceKind(record);
    eventKinds[kind] = (eventKinds[kind] ?? 0) + 1;
    const bytes = nativeRecordBytes(record);
    totalBytes += bytes;
    maximumBytes = Math.max(maximumBytes, bytes);
    if (record.kind === 'tool_call' || /tool.*call/i.test(kind)) calls += 1;
    if (record.kind === 'tool_result' || /tool.*(result|output)/i.test(kind)) results += 1;
    if (isErrorRecord(record)) errorRecords += 1;
  }
  const unmatchedCalls = Math.max(0, calls - results);
  const orphanResults = Math.max(0, results - calls);
  const incomplete = session.coverage !== 'observed';
  const reasonCodes = [
    ...(errorRecords > 0 ? ['runtime_failure_signal'] : []),
    ...(unmatchedCalls > 0 ? ['tool_call_without_result'] : []),
    ...(orphanResults > 0 ? ['tool_result_without_call'] : []),
    ...(incomplete ? ['partial_evidence'] : []),
  ];
  return {
    schema: 'dharma.local-trajectory-analysis/v1',
    analyzer: 'deterministic',
    recordCount: session.records.length,
    recordBytes: { total: totalBytes, maximum: maximumBytes },
    eventKinds,
    toolDiscipline: { calls, results, unmatchedCalls, orphanResults },
    outcomeSignals: { errorRecords, incomplete, coverage: session.coverage },
    durationMs: Math.max(0, Date.parse(session.endedAt) - Date.parse(session.startedAt)),
    semanticReviewRecommended: reasonCodes.length > 0,
    reasonCodes,
  };
}

function safeSourceKind(record: SourceRecord): string {
  const value = String(record.native.type ?? record.native.kind ?? 'unknown');
  return /^[A-Za-z0-9_.:-]{1,80}$/.test(value) ? value : 'unknown';
}

function nativeRecordBytes(record: SourceRecord): number {
  return Buffer.byteLength(JSON.stringify(record.native));
}

function excludedContentClasses(record: SourceRecord): string[] {
  const classes = new Set<string>(['native_provider_payload']);
  if (record.kind === 'user_message') classes.add('prompt_text');
  if (record.kind === 'agent_message') classes.add('response_text');
  if (record.kind === 'tool_call') classes.add('tool_input');
  if (record.kind === 'tool_result') classes.add('tool_output');
  const visit = (value: unknown, key = ''): void => {
    const normalized = key.toLowerCase().replaceAll('-', '_');
    if (/(instruction|system_prompt|developer_message)/.test(normalized)) classes.add('instruction_text');
    if (/(tool.*schema|input_schema)/.test(normalized)) classes.add('tool_schema');
    if (/(tool.*input|arguments|params)/.test(normalized)) classes.add('tool_input');
    if (/(tool.*result|tool.*output)/.test(normalized)) classes.add('tool_output');
    if (/(token_usage|tokens|usage_metadata)/.test(normalized)) classes.add('token_metadata');
    if (/(rate_limit|ratelimit)/.test(normalized)) classes.add('rate_limit_metadata');
    if (/(encrypted_content|reasoning)/.test(normalized)) classes.add('encrypted_reasoning');
    if (/(cwd|path|workspace_root)/.test(normalized)) classes.add('local_path');
    if (/(model|approval_policy|sandbox|collaboration|configuration|config)/.test(normalized)) {
      classes.add('execution_configuration');
    }
    if (Array.isArray(value)) value.forEach((item) => visit(item));
    else if (value && typeof value === 'object') {
      Object.entries(value as Record<string, unknown>).forEach(([childKey, child]) => visit(child, childKey));
    }
  };
  visit(record.native);
  return [...classes];
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
  revision?: number;
  previousRevisionHash?: string | null;
}): TrajectoryCapsule {
  const stats: RedactionStats = {
    classes: new Set(), redactedValues: 0, excludedPaths: 0, inputBytes: 0, outputBytes: 0,
  };
  const trajectoryId = deterministicUuid(`${input.organizationId}:${input.deviceId}:${input.session.provider}:${input.session.sessionId}`);
  const seen = new Set<string>();
  const events: AgentEvent[] = [];
  const excludedClasses = new Set<string>();
  const mode = disclosureMode(input.policy);
  let automaticInputBytes = 0;
  let automaticOutputBytes = 0;
  for (const [index, record] of input.session.records.entries()) {
    const redactedNative = redactValue(record.native, stats, '', {
      pseudonymizeIdentity: input.policy.evidence.pseudonymizeIdentity,
    });
    const payload: Record<string, unknown> & { recordBytes: number } = {
      nativeKind: safeSourceKind(record),
      recordBytes: nativeRecordBytes(record),
      contentOmitted: mode !== 'customer_authorized_content',
    };
    if (mode === 'customer_authorized_content') payload.nativeProviderPayload = redactedNative;
    automaticInputBytes += payload.recordBytes;
    automaticOutputBytes += Buffer.byteLength(canonicalize(payload));
    excludedContentClasses(record).forEach((value) => excludedClasses.add(value));
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
        nativeEventId: null,
        sourceKind: safeSourceKind(record),
        localLocatorId: sha256(`${basename(record.sourcePath)}:${record.line}`),
      },
      skillBundleId: null,
      providerModel: null,
    });
  }

  const createdAt = input.createdAt ?? input.session.endedAt;
  const revision = input.revision ?? 1;
  if (!Number.isSafeInteger(revision) || revision < 1) throw new Error('Trajectory capsule revision must be a positive integer.');
  if (revision === 1 && input.previousRevisionHash) throw new Error('The first trajectory capsule revision cannot reference a previous revision.');
  if (revision > 1 && !/^sha256:[a-f0-9]{64}$/.test(input.previousRevisionHash || '')) {
    throw new Error('A later trajectory capsule revision requires the previous capsule hash.');
  }
  const base = {
    schema: 'dharma.trajectory-capsule/v1' as const,
    trajectoryId,
    revision,
    previousRevisionHash: input.previousRevisionHash ?? null,
    organizationId: input.organizationId,
    deviceId: input.deviceId,
    workspaceId: input.workspaceId,
    provider: input.session.provider,
    sessionId: input.session.sessionId,
    taskId: null,
    timeRange: { start: input.session.startedAt, end: input.session.endedAt },
    status: input.session.coverage === 'observed' ? 'completed' as const : 'partial' as const,
    evidenceMode: input.policy.evidence.defaultMode,
    automaticDisclosureMode: mode,
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
      uploaded: mode === 'customer_authorized_content',
      availableLocally: true,
      mimeType: 'application/x-ndjson',
      normalizedPath: null,
    }],
    validationResults: [],
    localAnalysis: mode === 'metadata_only' ? null : buildLocalAnalysis(input.session),
    redactionReceipt: {
      policyRevision: input.policy.revision,
      disclosureClass: 'automatic_capsule' as const,
      disclosureMode: mode,
      consentReceiptId: input.policy.evidence.automaticDisclosure?.consentReceiptId ?? null,
      disclosedClasses: [
        ...AUTOMATIC_DISCLOSED_CLASSES,
        ...(mode === 'metadata_only' ? [] : ['local_deterministic_analysis'] as const),
        ...(mode === 'customer_authorized_content' ? ['native_provider_payload'] as const : []),
      ].sort(),
      excludedClasses: mode === 'customer_authorized_content'
        ? ['detected_secret_values', 'configured_excluded_paths']
        : [...excludedClasses].sort(),
      classes: [...new Set([
        ...stats.classes,
        ...(mode === 'customer_authorized_content' ? ['customer_authorized_content'] : ['automatic_content_omission']),
      ])].sort(),
      redactedValues: stats.redactedValues,
      excludedPaths: stats.excludedPaths,
      inputBytes: automaticInputBytes,
      outputBytes: automaticOutputBytes,
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
