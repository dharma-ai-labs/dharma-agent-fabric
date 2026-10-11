import {createHash} from 'node:crypto';
import {join} from 'node:path';
import {validateContract} from '@dharma-ai-labs/agent-fabric-contracts';
import type {LocalVault, ScopedLocalVault, LocalProviderSessionBinding} from '@dharma-ai-labs/agent-fabric-local-vault';
import {codexWorkCaptureSchemaId, type CodexLocalWorkCapture} from '@dharma-ai-labs/agent-fabric-provider-adapters/experimental/codex-session';

const digest = (value: string | Uint8Array) => `sha256:${createHash('sha256').update(value).digest('hex')}`;
const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value)
  ? value as Record<string, unknown> : {};
const hash = (value: unknown) => value === undefined ? null : digest(JSON.stringify(value));
const contentHash = (value: unknown) => typeof value === 'string' ? digest(value) : hash(value);
const validHash = (value: unknown): value is string => typeof value === 'string' && /^sha256:[a-f0-9]{64}$/.test(value);
const kinds = ['commandExecution', 'mcpToolCall', 'dynamicToolCall', 'fileChange'] as const;
const captureLimitations = ['conflicting_turn_identity', 'unscoped_notification', 'invalid_notification', 'capture_limit',
  'credential_excluded', 'turn_unconfirmed', 'terminal_unconfirmed'] as const;

export interface NamedSessionNativeAuditEvent {
  kind: typeof kinds[number]; sequence: number; receivedAt: string; itemHash: string; itemIdHash: string | null;
  commandHash: string | null; cwdHash: string | null; outputHash: string | null; argumentsHash: string | null; resultHash: string | null;
  dynamicContentHash: string | null; dynamicResponseHash: string | null; errorHash: string | null;
  toolStatus: 'inProgress' | 'completed' | 'failed' | null; toolSuccess: boolean | null;
  exitCode: number | null; durationMs: number | null; pathHashes: string[]; pathsTruncated: boolean;
  commandShape: 'node_version' | 'node_test' | 'npm_test' | 'other';
  reportedNodeVersion: string | null;
  reportedTapSummary: {tests: number; pass: number; fail: number; cancelled: number; skipped: number} | null;
}

function reportedCommandFacts(command: unknown, output: unknown): Pick<NamedSessionNativeAuditEvent,
  'commandShape' | 'reportedNodeVersion' | 'reportedTapSummary'> {
  const facts: Pick<NamedSessionNativeAuditEvent, 'commandShape' | 'reportedNodeVersion' | 'reportedTapSummary'> = {
    commandShape: 'other', reportedNodeVersion: null, reportedTapSummary: null};
  if (typeof command !== 'string' || typeof output !== 'string' || /[\r\n]/.test(command)) return facts;
  const node = '(?:node|/[A-Za-z0-9_./-]+/node)';
  if (new RegExp(`^${node} (?:--version|-v)$`).test(command)) {
    facts.commandShape = 'node_version';
    if (/^v[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\s*$/.test(output)) facts.reportedNodeVersion = output.trim();
  } else if (new RegExp(`^${node} --test(?: [A-Za-z0-9_./*-]+)*$`).test(command) || /^(?:npm test|npm run test)$/.test(command)) {
    facts.commandShape = command.startsWith('npm ') ? 'npm_test' : 'node_test';
    const counts: Record<string, number> = {};
    for (const key of ['tests', 'pass', 'fail', 'cancelled', 'skipped']) {
      const matches = [...output.matchAll(new RegExp(`^# ${key} ([0-9]{1,7})\\r?$`, 'gm'))];
      if (matches.length !== 1 || Number(matches[0]![1]) > 1_000_000) return facts;
      counts[key] = Number(matches[0]![1]);
    }
    if (counts.pass! + counts.fail! + counts.cancelled! + counts.skipped! <= counts.tests!) {
      facts.reportedTapSummary = counts as NonNullable<NamedSessionNativeAuditEvent['reportedTapSummary']>;
    }
  }
  return facts;
}

/** Project exact-work evidence inside its existing owner; never export native text or arbitrary vault locators. */
export async function readNamedSessionNativeAudit(input: {
  vault: Pick<LocalVault | ScopedLocalVault, 'getBlob'>;
  binding: LocalProviderSessionBinding;
  work: {workId: string; state: string; receiptHash: string} | null;
}) {
  const {vault, binding, work} = input;
  if (!work || !/^[A-Za-z0-9_-]{1,128}$(?![\s\S])/.test(work.workId)
    || !['completed', 'failed'].includes(work.state) || !validHash(work.receiptHash)) {
    throw new Error('named_session_audit_unavailable');
  }
  const read = async (id: string, maximumBytes: number) => {
    const bytes = await vault.getBlob(id);
    if (bytes.length > maximumBytes || digest(bytes) !== id) throw new Error('named_session_audit_integrity_failed');
    try {return object(JSON.parse(bytes.toString('utf8')));} catch {throw new Error('named_session_audit_integrity_failed');}
  };
  const receipt = await read(work.receiptHash, 65536), evidence = object(receipt.nativeEvidence);
  if (receipt.workId !== work.workId || !validHash(evidence.contentHash)) throw new Error('named_session_audit_scope_mismatch');
  const raw = await read(evidence.contentHash, 4 * 1024 * 1024);
  if (raw.schema !== 'dharma.codex-local-work-capture/v1' && raw.schema !== 'dharma.codex-local-work-capture/v2') {
    throw new Error('named_session_audit_integrity_failed');
  }
  const capture = raw as unknown as CodexLocalWorkCapture;
  if (!(await validateContract(join(import.meta.dirname, 'schemas'), codexWorkCaptureSchemaId(capture), capture)).ok
    || digest(JSON.stringify(capture.events)) !== capture.eventsHash || Date.parse(capture.startedAt) > Date.parse(capture.closedAt)) {
    throw new Error('named_session_audit_integrity_failed');
  }
  for (const key of ['organizationId', 'repositoryBindingId', 'workspaceId', 'endpointId', 'membershipId', 'deviceId', 'bindingId', 'provider'] as const) {
    if (capture[key] !== binding[key]) throw new Error('named_session_audit_scope_mismatch');
  }
  if (capture.workId !== work.workId || capture.captureId !== evidence.captureId || capture.providerThreadId !== binding.sessionId) {
    throw new Error('named_session_audit_scope_mismatch');
  }
  if (capture.schema === 'dharma.codex-local-work-capture/v2'
    && (capture.request.params.threadId !== binding.sessionId || capture.request.params.cwd !== binding.workspaceRoot
      || digest(JSON.stringify(capture.request)) !== capture.requestHash)) throw new Error('named_session_audit_integrity_failed');
  const events: NamedSessionNativeAuditEvent[] = [], completed = new Map<string, string>();
  let qualifyingItems = 0;
  const add = (value: unknown, sequence: number, receivedAt: string) => {
    const item = object(value), kind = kinds.find(kind => kind === item.type);
    if (!kind) return;
    const itemHash = digest(JSON.stringify(item)), id = typeof item.id === 'string' ? digest(item.id) : null;
    const key = `${kind}:${id ?? itemHash}`;
    if (completed.has(key)) {
      if (completed.get(key) !== itemHash) throw new Error('named_session_audit_integrity_failed');
      return;
    }
    completed.set(key, itemHash); qualifyingItems++;
    if (events.length >= 32) return;
    const changes = Array.isArray(item.changes) ? item.changes : [];
    const output = item.aggregatedOutput ?? item.output;
    const dynamic = kind === 'dynamicToolCall', tool = dynamic || kind === 'mcpToolCall';
    const toolStatus = tool && ['inProgress', 'completed', 'failed'].includes(String(item.status))
      ? item.status as NamedSessionNativeAuditEvent['toolStatus'] : null;
    const dynamicResponse = dynamic && toolStatus !== null
      && (item.success === null || typeof item.success === 'boolean')
      && (item.contentItems === null || Array.isArray(item.contentItems))
      ? {contentItems: item.contentItems, success: item.success, status: toolStatus} : undefined;
    events.push({kind, sequence, receivedAt, itemHash, itemIdHash: id,
      ...reportedCommandFacts(kind === 'commandExecution' ? item.command : undefined, output),
      commandHash: typeof item.command === 'string' ? digest(item.command) : null,
      cwdHash: kind === 'commandExecution' && typeof item.cwd === 'string' ? digest(item.cwd) : null,
      outputHash: dynamic ? null : contentHash(output), argumentsHash: hash(item.arguments),
      resultHash: dynamic ? null : hash(item.result),
      dynamicContentHash: dynamicResponse && Array.isArray(dynamicResponse.contentItems) ? hash(dynamicResponse.contentItems) : null,
      dynamicResponseHash: hash(dynamicResponse), errorHash: kind === 'mcpToolCall' && item.error != null ? hash(item.error) : null,
      toolStatus, toolSuccess: dynamic && typeof item.success === 'boolean' ? item.success : null,
      exitCode: Number.isSafeInteger(item.exitCode) ? Number(item.exitCode) : null,
      durationMs: Number.isSafeInteger(item.durationMs) && Number(item.durationMs) >= 0 ? Number(item.durationMs) : null,
      pathsTruncated: changes.length > 4,
      pathHashes: changes.slice(0, 4).map(object).filter(change => typeof change.path === 'string')
        .map(change => digest(change.path as string))});
  };
  for (const event of capture.events) {
    const params = object(event.notification.params), turn = object(params.turn);
    if (params.threadId !== capture.providerThreadId || params.turnId !== undefined && params.turnId !== capture.providerTurnId
      || turn.id !== undefined && turn.id !== capture.providerTurnId) throw new Error('named_session_audit_scope_mismatch');
    if (event.notification.method === 'item/completed') add(params.item, event.sequence, event.receivedAt);
    if (event.notification.method === 'turn/completed') {
      if (turn.status !== capture.providerTurnState) throw new Error('named_session_audit_integrity_failed');
      if (Array.isArray(turn.items)) for (const item of turn.items) add(item, event.sequence, event.receivedAt);
    }
  }
  return {ok: true as const, schema: 'dharma.named-session-native-audit/v1' as const,
    organizationId: binding.organizationId, repositoryBindingId: binding.repositoryBindingId, workspaceId: binding.workspaceId,
    endpointId: binding.endpointId, membershipId: binding.membershipId, deviceId: binding.deviceId, bindingId: binding.bindingId,
    provider: binding.provider, sessionId: binding.sessionId, workId: work.workId, receiptHash: work.receiptHash,
    workState: work.state, captureWorkOutcome: capture.workOutcome,
    captureId: capture.captureId, captureHash: evidence.contentHash, eventsHash: capture.eventsHash,
    startedAt: capture.startedAt, closedAt: capture.closedAt, observedAt: new Date().toISOString(),
    providerTurnId: capture.providerTurnId, providerTurnState: capture.providerTurnState,
    coverage: capture.coverage, droppedEvents: capture.droppedEvents, qualifyingItems,
    captureLimitations: captureLimitations.filter(value => capture.limitations.includes(value)),
    unrecognizedCaptureLimitationCount: capture.limitations.filter(value => !captureLimitations.some(known => value === known)).length,
    truncated: qualifyingItems > events.length || events.some(event => event.pathsTruncated),
    rawContentExported: false as const, acceptedLearningObservation: false as const,
    limitations: ['hashed_native_items_not_raw_transcripts', 'provider_reports_not_independent_grading',
      'hashed_command_and_path_match_required', 'retained_context_unavailable', 'executed_model_unreported'], events};
}
