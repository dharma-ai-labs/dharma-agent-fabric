import { createHash } from 'node:crypto';
import { basename } from 'node:path';
import { canonicalize, sha256, type EvidenceState } from '@dharma-ai-labs/agent-fabric-contracts';
import { assertPolicy, type OrganizationPolicy } from '@dharma-ai-labs/agent-fabric-policy';
import type { ProviderSession, SourceRecord } from '@dharma-ai-labs/agent-fabric-provider-adapters';

const SECRET_PATTERNS: Array<{ name: string; pattern: RegExp }> = [
  { name: 'private_key', pattern: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g },
  { name: 'github_token', pattern: /\b(?:gh[opusr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g },
  { name: 'openai_key', pattern: /\bsk-[A-Za-z0-9_-]{20,}\b/g },
  { name: 'aws_access_key', pattern: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g },
  { name: 'jwt', pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g },
  { name: 'connection_string', pattern: /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?):\/\/[^\s"']+/gi },
  // Keep this value grammar at least as broad as HQ's SECRET_VALUE gate. The
  // client must redact labeled secrets before signing instead of relying on a
  // server rejection after the local capsule has been committed.
  { name: 'authorization', pattern: /\b(?:authorization|api[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|client[_-]?secret|aws[_-]?secret[_-]?access[_-]?key)\s*[:=]\s*[^\s,;]{8,}/gi },
  { name: 'google_api_key', pattern: /\bAIza[0-9A-Za-z_-]{30,}\b/g },
  { name: 'slack_token', pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
  { name: 'generic_secret', pattern: /\b(?:client[_-]?secret|refresh[_-]?token|aws[_-]?secret[_-]?access[_-]?key|auth[_-]?token|x[_-]?api[_-]?key)\s*[:=]\s*["']?[A-Za-z0-9_./+=-]{8,}["']?/gi },
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
  schema: 'dharma.trajectory-capsule/v2' | 'dharma.trajectory-capsule/v3';
  trajectoryId: string;
  revision: number;
  previousRevisionHash: string | null;
  organizationId: string;
  deviceId: string;
  workspaceId: string;
  provider: string;
  sessionId: string;
  taskId: string | null;
  captureProvenance: {
    sourceClass: 'provider_discovery' | 'explicit_import' | 'signed_task_execution';
    collectedAt: string;
    taskReceiptHash: string | null;
  };
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

export function trajectoryCapsuleHash(capsule: Omit<TrajectoryCapsule, 'capsuleHash'> | TrajectoryCapsule): string {
  const { capsuleHash: ignoredHash, ...unsigned } = capsule as TrajectoryCapsule;
  void ignoredHash;
  if (unsigned.schema !== 'dharma.trajectory-capsule/v3') return sha256(canonicalize(unsigned));
  return sha256(canonicalize({
    ...unsigned,
    captureProvenance: { ...unsigned.captureProvenance, taskReceiptHash: null },
  }));
}

function deterministicUuid(value: string): string {
  const bytes = createHash('sha256').update(value).digest().subarray(0, 16);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x50;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

type RedactionOptions = { pseudonymizeIdentity?: boolean };

function globPattern(pattern: string): RegExp {
  const normalized = pattern.replaceAll('\\', '/').replace(/^\.\//, '');
  const escaped = normalized.replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replaceAll('**/', '\u0001').replaceAll('**', '\u0000').replaceAll('*', '[^/]*')
    .replaceAll('\u0001', '(?:.*/)?').replaceAll('\u0000', '.*');
  return new RegExp(`(?:^|/)${escaped}$`, 'i');
}

function normalizedFieldName(key: string) {
  return key.replace(/([a-z0-9])([A-Z])/g, '$1_$2').replace(/[-\s]+/g, '_').toLowerCase();
}

export function referencesExcludedPath(value: unknown, excludePaths: string[], key = '', depth = 0): boolean {
  if (depth > 64) return true;
  if (typeof value === 'string') {
    const normalizedKey = normalizedFieldName(key);
    const pathBearingKey = /(?:^|_)(?:path|file|filename|source|cwd)(?:$|_)/i.test(normalizedKey);
    const serializedPayloadKey = /(?:^|_)(?:arguments?|args|command|cmd|input|payload|body|data|message|content)(?:$|_)/i.test(normalizedKey);
    if (pathBearingKey || serializedPayloadKey) {
      const normalized = value.replaceAll('\\', '/');
      const candidates = [
        ...(pathBearingKey ? [normalized.trim()] : []),
        ...[...normalized.matchAll(/"([^"]+)"|'([^']+)'|`([^`]+)`|([^\s=,:;()[\]{}]+)/g)]
          .map((match) => match[1] || match[2] || match[3] || match[4])
          .filter((candidate): candidate is string => Boolean(candidate)),
      ];
      if (candidates.some((candidate) => excludePaths.some((pattern) => globPattern(pattern).test(candidate.replace(/^\.\//, ''))))) {
        return true;
      }
      if (serializedPayloadKey && /^[\[{]/.test(value.trim())) {
        try {
          if (referencesExcludedPath(JSON.parse(value), excludePaths, 'arguments', depth + 1)) return true;
        } catch {}
      }
    }
  }
  if (Array.isArray(value)) return value.some((item) => referencesExcludedPath(item, excludePaths, key, depth + 1));
  if (value && typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>)
      .some(([childKey, child]) => {
        const normalizedChildKey = childKey.replaceAll('\\', '/').replace(/^\.?\/+/, '');
        return excludePaths.some((pattern) => globPattern(pattern).test(normalizedChildKey))
          || referencesExcludedPath(child, excludePaths, childKey, depth + 1);
      });
  }
  return false;
}

const LOCAL_PATH_PATTERNS = [
  /\bfile:\/{2,3}(?:[^\s"'<>|,}\]]*[A-Za-z0-9_~@%+=/-])?/gi,
  /(?<![:/])\/(?!api(?:\/|\b)|help(?:\b|\/))[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._~@%+=:,-]*[A-Za-z0-9_~@%+=-])+/g,
  /\b[A-Za-z]:[\\/]+[^\s"'<>|,}\]]+/g,
  /\\{2,}(?:wsl(?:\.localhost)?\\{1,})?[^\s"'<>|,}\]]+/gi,
];

function redactString(value: string, stats: RedactionStats, _options: RedactionOptions): string {
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
  for (const pattern of LOCAL_PATH_PATTERNS) {
    output = output.replace(pattern, () => {
      stats.classes.add('local_path');
      stats.redactedValues += 1;
      return '[REDACTED:local_path]';
    });
  }
  stats.outputBytes += Buffer.byteLength(output);
  return output;
}

function redactValue(value: unknown, stats: RedactionStats, key = '', options: RedactionOptions = {}, depth = 0): unknown {
  if (depth > 64) {
    stats.classes.add('maximum_redaction_depth');
    stats.redactedValues += 1;
    return '[REDACTED:maximum_depth]';
  }
  const normalizedKey = normalizedFieldName(key);
  if (/^(authorization|authorization_header|proxy_authorization|proxy_authorization_header|cookie|set_cookie|password|passwd|credential|credentials|private_key|secret|token|api_key|x_api_key|client_secret|refresh_token|auth_token|access_token|aws_secret_access_key)$/i.test(normalizedKey)) {
    if (value !== null && value !== undefined) {
      stats.classes.add('sensitive_field');
      stats.redactedValues += 1;
    }
    return '[REDACTED:sensitive_field]';
  }
  if (/^(cwd|source_path|workspace_path|local_path)$/i.test(normalizedKey) && typeof value === 'string') {
    stats.inputBytes += Buffer.byteLength(value);
    stats.outputBytes += Buffer.byteLength('[REDACTED:local_path]');
    stats.classes.add('local_path');
    stats.redactedValues += 1;
    return '[REDACTED:local_path]';
  }
  if (typeof value === 'string') {
    if (/^(?:arguments?|args|input|payload|body|data|message|content)$/i.test(normalizedKey)
      && /^[\[{]/.test(value.trim())) {
      try {
        return JSON.stringify(redactValue(JSON.parse(value), stats, normalizedKey, options, depth + 1));
      } catch {}
    }
    return redactString(value, stats, options);
  }
  if (Array.isArray(value)) return value.map((item) => redactValue(item, stats, '', options, depth + 1));
  if (value && typeof value === 'object') {
    const output: Record<string, unknown> = {};
    for (const [childKey, child] of Object.entries(value as Record<string, unknown>)) {
      const redactedKey = redactString(childKey, stats, options);
      const safeKey = redactedKey === childKey
        ? childKey
        : `redacted_key_${sha256(childKey).slice(7, 23)}`;
      output[safeKey] = redactValue(child, stats, childKey, options, depth + 1);
    }
    return output;
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

const AUTOMATIC_CONTENT_CLASSES = [
  'encrypted_reasoning',
  'execution_configuration',
  'instruction_text',
  'local_path',
  'native_provider_payload',
  'prompt_text',
  'rate_limit_metadata',
  'response_text',
  'token_metadata',
  'tool_schema',
  'tool_input',
  'tool_output',
] as const;

function disclosureMode(policy: OrganizationPolicy): TrajectoryCapsule['automaticDisclosureMode'] {
  return policy.evidence.automaticDisclosure?.mode ?? 'local_analysis';
}

function isErrorRecord(record: SourceRecord): boolean {
  if (/(error|failed|failure|exception|timeout|cancelled)/i.test(record.kind)) return true;
  const nativeType = String(record.native.type ?? record.native.kind ?? '');
  const status = String(record.native.status ?? record.native.outcome ?? '');
  const subtype = String(record.native.subtype ?? record.native.stop_reason ?? '');
  return record.native.is_error === true
    || /(error|failed|failure|exception|timeout|cancelled|max_turns)/i.test(`${nativeType} ${status} ${subtype}`);
}

const REDUCED_EVENT_KINDS = new Set([
  'user_message', 'agent_message', 'tool_call', 'tool_result', 'command', 'file_read', 'file_write',
  'git', 'validation', 'permission', 'subagent', 'error', 'retry', 'session_state', 'metadata', 'collapsed_output',
]);

function normalizedReducedEventKind(value: unknown): string {
  const kind = safeKind(value);
  if (REDUCED_EVENT_KINDS.has(kind)) return kind;
  if (/(?:error|fail|exception|timeout|cancel)/i.test(kind)) return 'error';
  if (/retry/i.test(kind)) return 'retry';
  return 'metadata';
}

function buildLocalAnalysis(session: ProviderSession): NonNullable<TrajectoryCapsule['localAnalysis']> {
  const eventKinds: Record<string, number> = {};
  let totalBytes = 0;
  let maximumBytes = 0;
  let calls = 0;
  let results = 0;
  let errorRecords = 0;
  for (const record of session.records) {
    const kind = normalizedReducedEventKind(record.kind);
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

function safeKind(value: unknown): string {
  const candidate = String(value ?? 'unknown');
  if (!/^[A-Za-z0-9_.:-]{1,80}$/.test(candidate)) return 'unknown';
  const stats: RedactionStats = {
    classes: new Set(), redactedValues: 0, excludedPaths: 0, inputBytes: 0, outputBytes: 0,
  };
  return redactString(candidate, stats, { pseudonymizeIdentity: true }) === candidate ? candidate : 'unknown';
}

function safeSourceKind(record: SourceRecord): string {
  return safeKind(record.native.type ?? record.native.kind);
}

function nativeRecordBytes(record: SourceRecord): number {
  type PendingValue = { kind: 'value'; value: unknown; arrayMember: boolean } | { kind: 'exit'; value: object };
  const ancestors = new WeakSet<object>();
  const pending: PendingValue[] = [{ kind: 'value', value: record.native, arrayMember: false }];
  let bytes = 0;
  while (pending.length > 0) {
    const item = pending.pop()!;
    if (item.kind === 'exit') {
      ancestors.delete(item.value);
      continue;
    }
    const { value, arrayMember } = item;
    if (value === null) {
      bytes += 4;
      continue;
    }
    if (typeof value === 'string') {
      bytes += Buffer.byteLength(JSON.stringify(value));
      continue;
    }
    if (typeof value === 'boolean') {
      bytes += value ? 4 : 5;
      continue;
    }
    if (typeof value === 'number') {
      bytes += Buffer.byteLength(Number.isFinite(value) ? String(value) : 'null');
      continue;
    }
    if (typeof value === 'undefined' || typeof value === 'function' || typeof value === 'symbol') {
      if (arrayMember) bytes += 4;
      continue;
    }
    if (typeof value === 'bigint') throw new TypeError('Provider records must be JSON-compatible');
    if (ancestors.has(value)) throw new TypeError('Provider records must not contain circular references');
    ancestors.add(value);
    pending.push({ kind: 'exit', value });
    if (Array.isArray(value)) {
      bytes += 2 + Math.max(0, value.length - 1);
      for (let index = value.length - 1; index >= 0; index -= 1) {
        pending.push({ kind: 'value', value: value[index], arrayMember: true });
      }
      continue;
    }
    const entries = Object.entries(value).filter(([, child]) => (
      typeof child !== 'undefined' && typeof child !== 'function' && typeof child !== 'symbol'
    ));
    bytes += 2 + Math.max(0, entries.length - 1);
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const [key, child] = entries[index]!;
      bytes += Buffer.byteLength(JSON.stringify(key)) + 1;
      pending.push({ kind: 'value', value: child, arrayMember: false });
    }
  }
  return bytes;
}

function excludedContentClasses(record: SourceRecord): string[] {
  const classes = new Set<string>(['native_provider_payload']);
  if (record.kind === 'user_message') classes.add('prompt_text');
  if (record.kind === 'agent_message') classes.add('response_text');
  if (record.kind === 'tool_call') classes.add('tool_input');
  if (record.kind === 'tool_result') classes.add('tool_output');
  const pending: Array<{ value: unknown; key: string; depth: number }> = [
    { value: record.native, key: '', depth: 0 },
  ];
  while (pending.length > 0) {
    const { value, key, depth } = pending.pop()!;
    if (depth > 64) continue;
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
    if (Array.isArray(value)) value.forEach((item) => pending.push({ value: item, key: '', depth: depth + 1 }));
    else if (value && typeof value === 'object') {
      Object.entries(value as Record<string, unknown>)
        .forEach(([childKey, child]) => pending.push({ value: child, key: childKey, depth: depth + 1 }));
    }
  }
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
  activeSkillBundleId?: string | null;
  activeSkillBundleActivatedAt?: string | null;
  activeSkillBundleExpiresAt?: string | null;
  activeSkillBundleVerifiedAt?: string | null;
  taskId?: string | null;
  captureProvenance?: TrajectoryCapsule['captureProvenance'];
}): TrajectoryCapsule {
  assertPolicy(input.policy);
  const captureProvenance = input.captureProvenance ?? {
    sourceClass: 'provider_discovery' as const,
    collectedAt: input.createdAt ?? input.session.endedAt,
    taskReceiptHash: null,
  };
  if (!Number.isFinite(Date.parse(captureProvenance.collectedAt))) {
    throw new Error('Capture provenance requires a valid collection timestamp.');
  }
  const signedTaskCapture = captureProvenance.sourceClass === 'signed_task_execution';
  if (signedTaskCapture !== Boolean(input.taskId)
    || (signedTaskCapture && !/^[0-9a-f-]{36}$/i.test(input.taskId || ''))
    || (signedTaskCapture && !/^sha256:[a-f0-9]{64}$/i.test(captureProvenance.taskReceiptHash || ''))
    || (!signedTaskCapture && captureProvenance.taskReceiptHash !== null)) {
    throw new Error('Signed task provenance requires one task ID and server task receipt hash.');
  }
  if (input.activeSkillBundleId != null && !signedTaskCapture) {
    throw new Error('Skill attribution is allowed only for a signed task execution capsule.');
  }
  if (input.activeSkillBundleId != null
    && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input.activeSkillBundleId)) {
    throw new Error('Active skill bundle ID must be a UUID.');
  }
  const activatedAt = input.activeSkillBundleActivatedAt == null ? null : Date.parse(input.activeSkillBundleActivatedAt);
  const expiresAt = input.activeSkillBundleExpiresAt == null ? null : Date.parse(input.activeSkillBundleExpiresAt);
  const verifiedAt = input.activeSkillBundleVerifiedAt == null ? null : Date.parse(input.activeSkillBundleVerifiedAt);
  if (input.activeSkillBundleId != null && (!Number.isFinite(activatedAt) || (expiresAt != null && !Number.isFinite(expiresAt)))) {
    throw new Error('Active skill bundle requires a valid activation window.');
  }
  if (input.activeSkillBundleId != null && (!Number.isFinite(verifiedAt)
    || verifiedAt! < activatedAt! || (expiresAt != null && verifiedAt! >= expiresAt))) {
    throw new Error('Active skill bundle must be verified inside its authorization window before task execution.');
  }
  const stats: RedactionStats = {
    classes: new Set(), redactedValues: 0, excludedPaths: 0, inputBytes: 0, outputBytes: 0,
  };
  const trajectoryId = deterministicUuid(`${input.organizationId}:${input.deviceId}:${input.workspaceId}:${input.session.provider}:${input.session.sessionId}`);
  const pseudonymousSessionId = sha256(`${input.organizationId}:${input.workspaceId}:${input.session.provider}:${input.session.sessionId}`);
  const seen = new Set<string>();
  const events: AgentEvent[] = [];
  const excludedClasses = new Set<string>();
  const mode = disclosureMode(input.policy);
  let automaticInputBytes = 0;
  let automaticOutputBytes = 0;
  for (const [index, record] of input.session.records.entries()) {
    const recordKind = normalizedReducedEventKind(record.kind);
    const excludedPath = referencesExcludedPath(record.native, input.policy.evidence.excludePaths);
    if (excludedPath) {
      stats.classes.add('configured_excluded_path');
      stats.excludedPaths += 1;
    }
    const redactedNative = excludedPath
      ? { contentOmitted: true, omissionReason: 'configured_excluded_path' }
      : redactValue(record.native, stats, '', {
        pseudonymizeIdentity: input.policy.evidence.pseudonymizeIdentity,
      });
    const payload: Record<string, unknown> & { recordBytes: number } = {
      nativeKind: mode === 'customer_authorized_content' ? safeSourceKind(record) : recordKind,
      recordBytes: nativeRecordBytes(record),
      contentOmitted: mode !== 'customer_authorized_content',
    };
    if (mode === 'customer_authorized_content') {
      const serializedNative = canonicalize(redactedNative);
      payload.nativeProviderPayload = Buffer.byteLength(serializedNative) > Math.floor(input.policy.evidence.maximumCapsuleBytes / 2)
        ? {
          contentOmitted: true,
          omissionReason: 'record_exceeds_capsule_limit',
          redactedPayloadHash: sha256(serializedNative),
        }
        : redactedNative;
    }
    automaticInputBytes += payload.recordBytes;
    automaticOutputBytes += Buffer.byteLength(canonicalize(payload));
    excludedContentClasses(record).forEach((value) => excludedClasses.add(value));
    const fingerprint = sha256(canonicalize({ kind: record.kind, payload }));
    if (seen.has(fingerprint)) continue;
    seen.add(fingerprint);
    const occurredAt = record.timestamp ? new Date(record.timestamp).toISOString() : input.session.startedAt;
    const bundleWasActive = signedTaskCapture
      && input.activeSkillBundleId != null
      && verifiedAt != null;
    events.push({
      schema: 'dharma.agent-event/v1',
      eventId: deterministicUuid(`${trajectoryId}:${index}:${fingerprint}`),
      organizationId: input.organizationId,
      deviceId: input.deviceId,
      workspaceId: input.workspaceId,
      provider: input.session.provider,
      sessionId: pseudonymousSessionId,
      sequence: events.length,
      occurredAt,
      kind: recordKind,
      coverage: input.session.coverage,
      contentRefs: [],
      payload,
      source: {
        nativeEventId: null,
        sourceKind: mode === 'customer_authorized_content' ? safeSourceKind(record) : recordKind,
        localLocatorId: mode === 'customer_authorized_content'
          ? sha256(`${basename(record.sourcePath)}:${record.line}`)
          : null,
      },
      skillBundleId: bundleWasActive ? input.activeSkillBundleId! : null,
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
    schema: signedTaskCapture ? 'dharma.trajectory-capsule/v3' as const : 'dharma.trajectory-capsule/v2' as const,
    trajectoryId,
    revision,
    previousRevisionHash: input.previousRevisionHash ?? null,
    organizationId: input.organizationId,
    deviceId: input.deviceId,
    workspaceId: input.workspaceId,
    provider: input.session.provider,
    sessionId: pseudonymousSessionId,
    taskId: input.taskId ?? null,
    captureProvenance,
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
      uploaded: false,
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
        : [...new Set([...AUTOMATIC_CONTENT_CLASSES, ...excludedClasses])].sort(),
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
  if (Buffer.byteLength(canonicalize(base)) > input.policy.evidence.maximumCapsuleBytes && base.events.length === 1) {
    base.events[0]!.payload = {
      nativeKind: base.events[0]!.payload.nativeKind,
      recordBytes: base.events[0]!.payload.recordBytes,
      contentOmitted: true,
      omissionReason: 'capsule_size_limit',
    };
    base.coverage.state = 'partial';
    base.status = 'partial';
    base.coverage.missingFields.push('native_payload_collapsed_for_size');
  }
  if (Buffer.byteLength(canonicalize(base)) > input.policy.evidence.maximumCapsuleBytes) {
    throw new Error('Trajectory capsule metadata cannot fit the organization maximumCapsuleBytes policy.');
  }
  return { ...base, capsuleHash: trajectoryCapsuleHash(base as Omit<TrajectoryCapsule, 'capsuleHash'>) };
}

export { redactValue };
