import type { Stats } from 'node:fs';
import { mkdir, open, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { canonicalize, sha256 } from '@dharma-ai-labs/agent-fabric-contracts';
import {
  TRAJECTORY_SEGMENT_TOO_LARGE,
  buildTrajectoryCapsule,
  type TrajectoryCapsule,
} from '@dharma-ai-labs/agent-fabric-evidence-reduction';
import type { OrganizationPolicy } from '@dharma-ai-labs/agent-fabric-policy';
import {
  providerSessionId,
  readSessionTurns,
  type SessionTurn,
  type SourceRecord,
} from '@dharma-ai-labs/agent-fabric-provider-adapters';

export interface SessionSegmentStore {
  /** Keeps the raw segment and its capsule in the local encrypted vault. */
  commit(input: {
    capsule: TrajectoryCapsule; raw: Buffer; rawContentId: string;
    localSessionId: string; sourcePath: string; observedAt: string;
  }): Promise<void>;
  /** The head HQ has accepted for this trajectory, if any. */
  head(capsule: TrajectoryCapsule): Promise<{ revision: number; capsuleHash: string } | null>;
  /** Queues, reserves and uploads one committed capsule. A failure leaves it queued. */
  sync(capsule: TrajectoryCapsule): Promise<void>;
}

export interface SessionSegmentCaptureInput {
  organizationId: string;
  deviceId: string;
  workspaceId: string;
  workspacePath: string;
  provider: 'claude' | 'codex';
  sources: string[];
  policy: OrganizationPolicy;
  ledgerRoot: string;
  sourceClass?: 'provider_discovery' | 'explicit_import';
  idleMinutes?: number;
  maximumUploadBytes?: number;
  maximumRecordBytes?: number;
  /** Epoch ms. The run stops after the first whole segment finished at or after it; the next run continues. */
  deadline?: number;
  now?: () => Date;
  /** Absent: plan only. Nothing is written, uploaded or recorded in the ledger. */
  store?: SessionSegmentStore;
  validate?: (capsule: TrajectoryCapsule) => Promise<void>;
}

export interface SessionSegmentCaptureReport {
  ok: true;
  provider: 'claude' | 'codex';
  mode: 'plan' | 'sync';
  uploadedBytes: number;
  budgetExhausted: boolean;
  stoppedReason: string | null;
  sessions: Array<{
    sessionId: string; segmentsCommitted: number; segmentsSkipped: number; segmentsPlanned: number;
    held: boolean; stoppedReason: string | null; failure: string | null;
  }>;
  segments: Array<{
    sessionId: string; trajectoryId: string; index: number; capsuleHash: string; status: string;
    coverage: string; bytes: number; recordCount: number; timeRange: { start: string; end: string };
    outcome: 'planned' | 'synced' | 'already_on_server' | 'queued';
  }>;
}

interface SegmentLedger {
  schema: 'dharma.session-segment-ledger/v1';
  workspaceId: string;
  provider: 'claude' | 'codex';
  sessionId: string;
  nextIndex: number;
  nextOffset: number;
  insideTurn: boolean;
  previousEnd: string | null;
  anchor: string | null;
  segments: Array<{ index: number; trajectoryId: string; capsuleHash: string; startOffset: number; endOffset: number }>;
}

interface Unit {
  records: SourceRecord[];
  coverage: SessionTurn['coverage'];
  startOffset: number;
  endOffset: number;
}

interface Sized extends Unit {
  overhead: number;
  eventBytes: number;
  eventCount: number;
}

class StopSession extends Error {
  constructor(readonly reason: string, readonly run = false) { super(reason); }
}

const ANCHOR_BYTES = 4_096;
const ESTIMATE_SLACK_BYTES = 4_096;
const DAILY_LIMIT_MESSAGE = 'Organization daily content upload limit would be exceeded.';

function ledgerPath(root: string, workspaceId: string, provider: string, sessionId: string) {
  return resolve(root, `${sha256(`${workspaceId}:${provider}:${sessionId}`).slice(7, 39)}.json`);
}

async function readLedger(path: string, expected: Pick<SegmentLedger, 'workspaceId' | 'provider' | 'sessionId'>): Promise<SegmentLedger> {
  let value: SegmentLedger;
  try {
    value = JSON.parse(await readFile(path, 'utf8')) as SegmentLedger;
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error('session_segment_ledger_invalid');
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return { schema: 'dharma.session-segment-ledger/v1', ...expected, nextIndex: 0, nextOffset: 0, insideTurn: false,
      previousEnd: null, anchor: null, segments: [] };
  }
  if (value?.schema !== 'dharma.session-segment-ledger/v1' || value.workspaceId !== expected.workspaceId
    || value.provider !== expected.provider || value.sessionId !== expected.sessionId
    || !Number.isSafeInteger(value.nextIndex) || value.nextIndex < 0
    || !Number.isSafeInteger(value.nextOffset) || value.nextOffset < 0 || !Array.isArray(value.segments)) {
    throw new Error('session_segment_ledger_invalid');
  }
  return value;
}

async function writeLedger(path: string, ledger: SegmentLedger) {
  await mkdir(resolve(path, '..'), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(ledger)}\n`, { mode: 0o600 });
  await rename(temporary, path);
}

async function anchorAt(path: string, offset: number): Promise<string | null> {
  if (offset === 0) return null;
  const start = Math.max(0, offset - ANCHOR_BYTES);
  const handle = await open(path, 'r');
  try {
    const buffer = Buffer.alloc(offset - start);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, start);
    return bytesRead === buffer.length ? sha256(buffer) : null;
  } finally {
    await handle.close();
  }
}

function recordTimeRange(records: SourceRecord[], previousEnd: string | null, fallback: Date) {
  let earliest = Number.POSITIVE_INFINITY;
  let latest = Number.NEGATIVE_INFINITY;
  for (const record of records) {
    const parsed = record.timestamp ? Date.parse(record.timestamp) : Number.NaN;
    if (!Number.isFinite(parsed)) continue;
    earliest = Math.min(earliest, parsed);
    latest = Math.max(latest, parsed);
  }
  const floor = previousEnd ? Date.parse(previousEnd) : Number.NEGATIVE_INFINITY;
  if (!Number.isFinite(earliest)) earliest = latest = Number.isFinite(floor) ? floor : fallback.getTime();
  // Claude writes some records a millisecond before the record they belong to,
  // so a boundary can overlap slightly. Segment ranges are kept in order.
  const start = Math.max(earliest, floor);
  return { startedAt: new Date(start).toISOString(), endedAt: new Date(Math.max(latest, start)).toISOString() };
}

// A step ends where no tool call is waiting for its result, so a split turn
// never separates a call from its result.
function pendingAfter(pending: number, record: SourceRecord): number {
  const blocks = (type: string) => {
    const message = record.native.message as { content?: unknown } | undefined;
    const content = Array.isArray(message?.content) ? message.content : [];
    const count = content.filter((block) => (block as { type?: unknown } | null)?.type === type).length;
    return count || 1;
  };
  if (record.kind === 'tool_call') return pending + blocks('tool_use');
  if (record.kind === 'tool_result') return Math.max(0, pending - blocks('tool_result'));
  return pending;
}

/** Tool calls in these records that are still waiting for their result. */
function pendingToolCalls(records: SourceRecord[]): number {
  return records.reduce(pendingAfter, 0);
}

function toolExchangeSteps(unit: Unit): Unit[] {
  const steps: Unit[] = [];
  let current: SourceRecord[] = [];
  let pending = 0;
  for (const record of unit.records) {
    current.push(record);
    pending = pendingAfter(pending, record);
    if (pending === 0) {
      steps.push({ records: current, coverage: unit.coverage, startOffset: current[0]!.line, endOffset: 0 });
      current = [];
    }
  }
  if (current.length) steps.push({ records: current, coverage: unit.coverage, startOffset: current[0]!.line, endOffset: 0 });
  steps.forEach((step, index) => { step.endOffset = steps[index + 1]?.startOffset ?? unit.endOffset; });
  if (steps.length) steps[0]!.startOffset = unit.startOffset;
  return steps;
}

function singleRecords(unit: Unit): Unit[] {
  const records = unit.records.map((record, index) => ({
    records: [record], coverage: unit.coverage, startOffset: index === 0 ? unit.startOffset : record.line, endOffset: 0,
  }));
  records.forEach((step, index) => { step.endOffset = records[index + 1]?.startOffset ?? unit.endOffset; });
  return records;
}

export async function captureSessionSegments(input: SessionSegmentCaptureInput): Promise<SessionSegmentCaptureReport> {
  const now = input.now ?? (() => new Date());
  const idleMs = Math.max(0, input.idleMinutes ?? 30) * 60_000;
  const dailyLimit = input.policy.evidence.maximumDailyUploadBytes;
  const budget = Math.min(input.maximumUploadBytes ?? dailyLimit, dailyLimit);
  const maximumBytes = input.policy.evidence.maximumCapsuleBytes;
  const report: SessionSegmentCaptureReport = {
    ok: true, provider: input.provider, mode: input.store ? 'sync' : 'plan', uploadedBytes: 0,
    budgetExhausted: false, stoppedReason: null, sessions: [], segments: [],
  };

  for (const sourcePath of input.sources) {
    if (report.stoppedReason) break;
    const localSessionId = providerSessionId(input.provider, sourcePath);
    const path = ledgerPath(input.ledgerRoot, input.workspaceId, input.provider, localSessionId);
    const summary = { sessionId: localSessionId, segmentsCommitted: 0, segmentsSkipped: 0,
      segmentsPlanned: 0, held: false, stoppedReason: null as string | null, failure: null as string | null };
    report.sessions.push(summary);
    // A failure stops this session only; later sessions are still captured.
    const fail = (error: unknown) => {
      summary.stoppedReason = 'session_capture_failed';
      summary.failure = sessionFailureCode(error);
    };
    let ledger: SegmentLedger;
    let source: Stats;
    try {
      ledger = await readLedger(path, { workspaceId: input.workspaceId, provider: input.provider, sessionId: localSessionId });
      summary.segmentsSkipped = ledger.segments.length;
      source = await stat(sourcePath);
      if (source.size < ledger.nextOffset || await anchorAt(sourcePath, ledger.nextOffset) !== ledger.anchor) {
        summary.stoppedReason = 'session_source_changed';
        continue;
      }
    } catch (error) {
      fail(error);
      continue;
    }
    const idle = now().getTime() - source.mtimeMs >= idleMs;

    const build = (units: Unit[], index: number) => {
      const records = units.flatMap((unit) => unit.records);
      const coverage = units.every((unit) => unit.coverage === 'observed') ? 'observed' as const : 'partial' as const;
      const range = recordTimeRange(records, ledger.previousEnd, source.mtime);
      const raw = Buffer.from(`${records.map((record) => JSON.stringify(record.native)).join('\n')}\n`);
      const rawContentId = sha256(raw);
      try {
        const capsule = buildTrajectoryCapsule({
          organizationId: input.organizationId, deviceId: input.deviceId, workspaceId: input.workspaceId,
          session: {
            provider: input.provider, sessionId: localSessionId, sourcePath, workspace: input.workspacePath,
            records, coverage, startedAt: range.startedAt, endedAt: range.endedAt,
          },
          policy: input.policy, rawContentId, rawBytes: raw.byteLength, rawKind: 'raw-provider-turn',
          captureProvenance: { sourceClass: input.sourceClass ?? 'provider_discovery', collectedAt: range.endedAt, taskReceiptHash: null },
          segment: { index },
        });
        return { capsule, raw, rawContentId, bytes: Buffer.byteLength(canonicalize(capsule)) };
      } catch (error) {
        if ((error as Error).message === TRAJECTORY_SEGMENT_TOO_LARGE) return null;
        throw error;
      }
    };
    const sized = (unit: Unit): Sized | null => {
      const built = build([unit], 0);
      if (!built) return null;
      const eventBytes = Buffer.byteLength(canonicalize(built.capsule.events));
      return { ...unit, overhead: built.bytes - eventBytes, eventBytes, eventCount: built.capsule.events.length };
    };
    // A conservative, deterministic size bound for several units in one capsule.
    const estimate = (units: Sized[]) => Math.max(...units.map((unit) => unit.overhead))
      + units.reduce((total, unit) => total + unit.eventBytes + 8 * unit.eventCount + 1, 0) + ESTIMATE_SLACK_BYTES;

    const emit = async (units: Unit[], insideTurnAfter: boolean): Promise<void> => {
      let built = build(units, ledger.nextIndex);
      while (!built && units.length > 1) {
        // The estimate is conservative; this only guards against a wrong bound.
        const last = units.pop()!;
        await emit(units, false);
        units = [last];
        built = build(units, ledger.nextIndex);
      }
      if (!built) throw new StopSession('record_exceeds_capsule_limit');
      const { capsule, raw, rawContentId, bytes } = built;
      const segment = {
        sessionId: capsule.sessionId, trajectoryId: capsule.trajectoryId, index: ledger.nextIndex,
        capsuleHash: capsule.capsuleHash, status: capsule.status, coverage: capsule.coverage.state, bytes,
        recordCount: units.reduce((total, unit) => total + unit.records.length, 0), timeRange: capsule.timeRange,
        outcome: 'planned' as SessionSegmentCaptureReport['segments'][number]['outcome'],
      };
      await input.validate?.(capsule);
      const head = input.store ? await input.store.head(capsule) : null;
      if (head && head.capsuleHash !== capsule.capsuleHash) throw new StopSession('segment_conflict');
      if (!head) {
        if (report.uploadedBytes + bytes > budget) {
          report.budgetExhausted = true;
          throw new StopSession('upload_budget_exhausted', true);
        }
        report.uploadedBytes += bytes;
      }
      const endOffset = units.at(-1)!.endOffset;
      if (input.store) {
        await input.store.commit({ capsule, raw, rawContentId, localSessionId: `${localSessionId}:segment:${ledger.nextIndex}`,
          sourcePath, observedAt: capsule.timeRange.end });
      }
      ledger.segments.push({ index: ledger.nextIndex, trajectoryId: capsule.trajectoryId, capsuleHash: capsule.capsuleHash,
        startOffset: units[0]!.startOffset, endOffset });
      ledger.nextIndex += 1;
      ledger.nextOffset = endOffset;
      ledger.insideTurn = insideTurnAfter;
      ledger.previousEnd = capsule.timeRange.end;
      report.segments.push(segment);
      summary.segmentsPlanned += 1;
      if (input.store) {
        ledger.anchor = await anchorAt(sourcePath, endOffset);
        await writeLedger(path, ledger);
        summary.segmentsCommitted += 1;
        if (head) segment.outcome = 'already_on_server';
        else {
          segment.outcome = 'queued';
          try {
            await input.store.sync(capsule);
          } catch (error) {
            throw new StopSession((error as Error).message === DAILY_LIMIT_MESSAGE ? 'daily_upload_limit' : 'sync_failed', true);
          }
          segment.outcome = 'synced';
        }
      }
      if (input.deadline !== undefined && now().getTime() >= input.deadline) throw new StopSession('time_budget_exhausted', true);
    };

    // Splits one turn that cannot fit a capsule. Every piece is closed; the
    // last piece of a turn still being written waits like any open tail.
    const emitPieces = async (turn: Unit, atEndOfFile: boolean): Promise<boolean> => {
      const steps: Sized[] = [];
      for (const step of toolExchangeSteps(turn)) {
        const fitted = sized(step);
        if (fitted) { steps.push(fitted); continue; }
        for (const record of singleRecords(step)) {
          const single = sized(record);
          if (!single) throw new StopSession('record_exceeds_capsule_limit');
          steps.push(single);
        }
      }
      let piece: Sized[] = [];
      for (const step of steps) {
        if (piece.length && estimate([...piece, step]) > maximumBytes) {
          await emit(piece, true);
          piece = [];
        }
        piece.push(step);
      }
      if (!piece.length) return false;
      // A call still waiting for its result keeps the piece open, even in an idle file.
      if (atEndOfFile && (!idle || pendingToolCalls(piece.flatMap((step) => step.records)) > 0)) return true;
      await emit(piece, false);
      return false;
    };

    let current: Sized[] = [];
    let first = true;
    try {
      for await (const turn of readSessionTurns({
        provider: input.provider, path: sourcePath, workspace: input.workspacePath,
        startOffset: ledger.nextOffset, maximumRecordBytes: input.maximumRecordBytes,
      })) {
        const resumedInsideTurn = first && ledger.insideTurn;
        first = false;
        if (turn.records.length === 0) {
          // Its bytes join the previous unit, and so does the fact that records were left out.
          // Without a previous unit the bytes stay unread and join the next turn.
          const previous = current.at(-1);
          if (previous) {
            previous.endOffset = turn.endOffset;
            if (turn.coverage === 'partial') previous.coverage = 'partial';
          }
          continue;
        }
        const unit = resumedInsideTurn ? null : sized(turn);
        if (!unit) {
          if (current.length) await emit(current, false);
          current = [];
          if (await emitPieces(turn, turn.atEndOfFile)) summary.held = true;
          continue;
        }
        if (current.length && estimate([...current, unit]) > maximumBytes) {
          await emit(current, false);
          current = [];
        }
        current.push(unit);
      }
      if (current.length) {
        if (!idle) summary.held = true;
        else if (pendingToolCalls(current.at(-1)!.records) > 0) {
          // A call still waiting for its result keeps its turn open, even in an idle file.
          if (current.length > 1) await emit(current.slice(0, -1), false);
          summary.held = true;
        } else await emit(current, false);
      }
    } catch (error) {
      if (!(error instanceof StopSession)) {
        fail(error);
        continue;
      }
      summary.stoppedReason = error.reason;
      if (error.run) report.stoppedReason = error.reason;
    }
  }
  return report;
}

/** A stable code for a session failure. Messages are not reported: they can carry paths or content. */
export function sessionFailureCode(error: unknown): string {
  const message = error instanceof Error ? error.message : '';
  if (message === 'session_segment_ledger_invalid' || message.startsWith('session_capture_requires_')) return message;
  if (message.includes('revision hash conflict')) return 'vault_revision_conflict';
  if (message.startsWith('Trajectory capsule failed schema validation')) return 'capsule_schema_invalid';
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return typeof code === 'string' && /^[A-Z][A-Z0-9_]{1,40}$/.test(code) ? code : 'unexpected';
}

/**
 * HQ opens an automatic organization-wide analysis window (with paid semantic
 * review) once 100 observed trajectories wait, and each segment is one
 * trajectory. Until HQ keeps segments out of that count, segments are only
 * planned locally: `capture-segments --sync` and the relay timer are refused.
 */
export const SESSION_SEGMENT_UPLOAD_AVAILABLE: boolean = false;

export function assertSessionSegmentUploadAvailable(available = SESSION_SEGMENT_UPLOAD_AVAILABLE) {
  if (!available) {
    throw new Error('session_segment_upload_unavailable: HQ does not yet keep session segments out of its automatic '
      + 'analysis window. Run capture-segments without --sync to plan segments locally.');
  }
}

/** One relay capture tick holds the task lock for at most about this long. */
export const RELAY_SESSION_CAPTURE_TICK_MS = 30_000;

export type RelaySessionCaptureSettings = { enabled: false } | {
  enabled: true; intervalMs: number; lookbackHours: number; idleMinutes: number; providers: Array<'claude' | 'codex'>;
  sessionIdsFile: string | null;
};

function boundedSetting(flags: Map<string, string | boolean>, key: string, fallback: number, minimum: number, maximum: number) {
  const raw = flags.get(key);
  if (raw === undefined) return fallback;
  const value = typeof raw === 'string' && /^\d+$/.test(raw) ? Number(raw) : Number.NaN;
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new Error('relay_session_capture_setting_invalid');
  return value;
}

/**
 * With content consent active, the unattended timer sends native payloads, so it
 * captures only the sessions a person listed in `--capture-session-ids-file`
 * after `dharma evidence preview`. The file is read again on every tick.
 */
export function relaySessionCaptureBlocked(settings: RelaySessionCaptureSettings, policy: OrganizationPolicy): string | null {
  if (!settings.enabled) return null;
  if (policy.evidence.automaticDisclosure?.mode === 'customer_authorized_content' && !settings.sessionIdsFile) {
    return 'session_capture_requires_session_allowlist';
  }
  return null;
}

/** Relay session capture is opt-in: `--capture-sessions` turns on its timer. */
export function relaySessionCaptureSettings(flags: Map<string, string | boolean>,
  options: { uploadAvailable?: boolean } = {}): RelaySessionCaptureSettings {
  const keys = ['capture-interval-minutes', 'capture-lookback-hours', 'capture-idle-minutes', 'capture-session-ids-file'];
  if (!flags.has('capture-sessions')) {
    if (keys.some((key) => flags.has(key))) throw new Error('relay_session_capture_setting_invalid');
    return { enabled: false };
  }
  if (flags.get('capture-sessions') !== true) throw new Error('relay_session_capture_setting_invalid');
  assertSessionSegmentUploadAvailable(options.uploadAvailable);
  const sessionIdsFile = flags.get('capture-session-ids-file');
  if (sessionIdsFile !== undefined && (typeof sessionIdsFile !== 'string' || !sessionIdsFile)) {
    throw new Error('relay_session_capture_setting_invalid');
  }
  return {
    enabled: true,
    intervalMs: boundedSetting(flags, 'capture-interval-minutes', 15, 5, 1_440) * 60_000,
    lookbackHours: boundedSetting(flags, 'capture-lookback-hours', 24, 1, 720),
    idleMinutes: boundedSetting(flags, 'capture-idle-minutes', 30, 5, 1_440),
    providers: ['claude', 'codex'],
    sessionIdsFile: sessionIdsFile === undefined ? null : resolve(sessionIdsFile),
  };
}
