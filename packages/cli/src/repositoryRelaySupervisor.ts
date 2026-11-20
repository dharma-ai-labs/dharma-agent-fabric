import { isAbsolute, resolve, win32 } from 'node:path';
import { withDeviceSigningLineSignal } from '@dharma-ai-labs/agent-fabric-relay-client';
import { selectDeviceWorkspace, type OnboardingWorkspaceRecord } from './onboardingWorkspace.js';
import { RELAY_OPEN_FAILURE_CODES, relayOpenFailureCode } from './relayOpenFailure.js';
import { relayRestartDelayMs } from './relaySupervisor.js';

export interface RepositoryRelayRegistration { workspaceId: string; policyPath: string }
export const REPOSITORY_RELAY_STAGES = ['policy_verification', 'session_open', 'vault_open', 'trajectory_recovery', 'evidence_sync',
  'pending_capsule_sync', 'evidence_request', 'task_poll', 'worker_run'] as const;
export type RepositoryRelayStage = typeof REPOSITORY_RELAY_STAGES[number];
export type RepositoryRelayFailureCategory = 'policy_boundary' | 'retention_not_ready' | 'policy_invalid' | 'unexpected';
// Exact codes only: any other error message can quote a path or a server value.
export const REPOSITORY_RELAY_FAILURE_CODES: ReadonlySet<string> = new Set(['connection_anchor_lock_invalid', 'connection_anchor_busy',
  'connection_anchor_recovery_required', 'connection_anchor_lock_unavailable', 'connection_anchor_lock_cleanup_unconfirmed',
  'device_signing_control_unavailable', 'connection_anchor_lock_flush_failed', ...RELAY_OPEN_FAILURE_CODES]);
const typedFailure = (value: unknown) => REPOSITORY_RELAY_FAILURE_CODES.has(value as string) ? { failureCode: value as string } : {};
// An unreadable device identity or store needs the user, so a retry every 30 s only repeats the failure.
// connection_identity_store_busy is transient and stays on the short relayRestartDelayMs schedule.
const DEVICE_CREDENTIAL_FAILURES: ReadonlySet<string> = new Set(['connection_identity_requires_recovery',
  'connection_identity_store_unavailable']);
const DEVICE_CREDENTIAL_FAILURE_LIMIT = 5;
const DEVICE_CREDENTIAL_RETRY_MS = 600_000;
// A loop that ran this long before it failed starts its restart backoff again from the first step.
export const REPOSITORY_RELAY_HEALTHY_RUN_MS = 10 * 60_000;
interface Observation { workspaceId: string | null; code: string; stage?: RepositoryRelayStage;
  category?: RepositoryRelayFailureCategory; failureCode?: string; httpStatus?: number; errorCode?: string }
/** One repository_relay line. `at` is the supervisor clock when the event happened. */
export type RepositoryRelayObservation = Observation & { at: string };

class StagedRepositoryRelayError extends Error {
  constructor(readonly stage: RepositoryRelayStage, cause: unknown) {
    super('Repository relay stage failed.', { cause });
  }
}

export async function withRepositoryRelayStage<T>(stage: RepositoryRelayStage, operation: () => Promise<T>): Promise<T> {
  try { return await operation(); }
  catch (error) { throw error instanceof StagedRepositoryRelayError ? error : new StagedRepositoryRelayError(stage, error); }
}

function failureCause(error: unknown) {
  return error instanceof StagedRepositoryRelayError ? error.cause : error;
}

function failureMessage(error: unknown) {
  const cause = failureCause(error);
  try { return cause instanceof Error ? cause.message : ''; }
  catch { return ''; }
}

// The same rule as a relay child failure code (relayChildFailure.ts), for a code a server or a local store sets.
const SAFE_LOWER_CODE = /^[a-z0-9_]{1,80}$/;
// Node errno and system codes, such as ECONNRESET or UND_ERR_CONNECT_TIMEOUT.
const SAFE_SYSTEM_CODE = /^[A-Z][A-Z0-9_]{1,79}$/;

function field(value: unknown, name: string): unknown {
  try { return value && typeof value === 'object' ? (value as Record<string, unknown>)[name] : undefined; }
  catch { return undefined; }
}

// A safe class for a failure with no typed code: an HTTP status and one stable code, found on the error or
// on the causes it wraps (fetch keeps its errno on the cause). Error text is never read here.
function failureClass(error: unknown): { httpStatus?: number; errorCode?: string } {
  let httpStatus: number | undefined, errorCode: string | undefined;
  let current = failureCause(error);
  for (let depth = 0; depth < 3 && current && typeof current === 'object'; depth++) {
    const status = field(current, 'status'), code = field(current, 'code'), serverCode = field(current, 'serverCode');
    if (httpStatus === undefined && typeof status === 'number' && Number.isInteger(status) && status >= 100 && status <= 599) {
      httpStatus = status;
    }
    if (errorCode === undefined && typeof code === 'string' && (SAFE_SYSTEM_CODE.test(code) || SAFE_LOWER_CODE.test(code))) {
      errorCode = code;
    }
    if (errorCode === undefined && typeof serverCode === 'string' && SAFE_LOWER_CODE.test(serverCode)) errorCode = serverCode;
    current = field(current, 'cause');
  }
  return { ...(httpStatus !== undefined ? { httpStatus } : {}), ...(errorCode !== undefined ? { errorCode } : {}) };
}

function failureCategory(error: unknown): RepositoryRelayFailureCategory {
  const message = failureMessage(error);
  if (/^policy_boundary:/.test(message)) return 'policy_boundary';
  if (/^agent_fabric_retention_not_ready:/.test(message)) return 'retention_not_ready';
  if (/^agent_fabric_policy_invalid:/.test(message)) return 'policy_invalid';
  return 'unexpected';
}

// Status trusts a relay time only in the exact form the relay writes and never from the future.
export function repositoryRelayTimestampMs(value: unknown, now = Date.now()) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return null;
  const at = Date.parse(value);
  return Number.isFinite(at) && at <= now + 30_000 ? at : null;
}

export function repositoryRelayFailureReceipt(event: Observation, binding: { organizationId: string; deviceId: string;
  pid: number; relayPidMtimeMs: number; relayPidCtimeMs: number }, at: string) {
  return { schema: 'dharma.local-repository-relay-failure/v1', organizationId: binding.organizationId,
    deviceId: binding.deviceId, workspaceId: event.workspaceId, pid: binding.pid, relayPidMtimeMs: binding.relayPidMtimeMs,
    relayPidCtimeMs: binding.relayPidCtimeMs, at, stage: event.stage, category: event.category,
    ...(event.failureCode ? { failureCode: event.failureCode } : {}) };
}

export function currentRepositoryRelayFailure(input: { receipt: unknown; organizationId: string; deviceId: string;
  workspaceId: string; pid: number; relayPidMtimeMs: number | null; relayPidCtimeMs: number | null;
  lastSuccessfulPollAt: string | null; now?: number }) {
  const value = input.receipt as Record<string, unknown> | null;
  if (!value || value.schema !== 'dharma.local-repository-relay-failure/v1'
    || value.organizationId !== input.organizationId || value.deviceId !== input.deviceId
    || value.workspaceId !== input.workspaceId || value.pid !== input.pid
    || !Number.isSafeInteger(input.pid) || input.pid <= 0
    || typeof value.at !== 'string' || repositoryRelayTimestampMs(value.at, input.now) === null
    || !Number.isFinite(input.relayPidMtimeMs) || !Number.isFinite(input.relayPidCtimeMs)
    || value.relayPidMtimeMs !== input.relayPidMtimeMs || value.relayPidCtimeMs !== input.relayPidCtimeMs
    || (input.lastSuccessfulPollAt && Date.parse(value.at) <= Date.parse(input.lastSuccessfulPollAt))
    || !(REPOSITORY_RELAY_STAGES as readonly string[]).includes(String(value.stage))
    || !['policy_boundary', 'retention_not_ready', 'policy_invalid', 'unexpected'].includes(String(value.category))) {
    return null;
  }
  return { at: value.at, stage: value.stage, category: value.category,
    ...typedFailure(value.failureCode) };
}

// #514: the latest-failure receipt is hidden by the next success, so each workspace also keeps a running count
// and its last failures for the current relay process. Entries hold the time, stage and stable codes only.
export const REPOSITORY_RELAY_FAILURE_HISTORY_SCHEMA = 'dharma.local-repository-relay-failure-history/v1';
export const REPOSITORY_RELAY_FAILURE_HISTORY_LIMIT = 20;
export const REPOSITORY_RELAY_RECENT_FAILURE_MS = 24 * 60 * 60_000;
export interface RepositoryRelayFailureHistoryEntry { at: string; stage: RepositoryRelayStage; failureCode?: string;
  httpStatus?: number; errorCode?: string }
export interface RepositoryRelayFailureHistory { count: number; since: string; entries: RepositoryRelayFailureHistoryEntry[] }
interface RepositoryRelayProcessBinding { organizationId: string; deviceId: string; workspaceId: string; pid: number;
  relayPidMtimeMs: number; relayPidCtimeMs: number }
const HISTORY_ENTRY_KEYS: ReadonlySet<string> = new Set(['at', 'stage', 'failureCode', 'httpStatus', 'errorCode']);
const HISTORY_KEYS: ReadonlySet<string> = new Set(['schema', 'organizationId', 'deviceId', 'workspaceId', 'pid',
  'relayPidMtimeMs', 'relayPidCtimeMs', 'count', 'since', 'entries']);
const safeHttpStatus = (value: unknown) => typeof value === 'number' && Number.isInteger(value) && value >= 100 && value <= 599;
const safeErrorCode = (value: unknown) => typeof value === 'string' && (SAFE_SYSTEM_CODE.test(value) || SAFE_LOWER_CODE.test(value));

// Builds an entry from a failure event, dropping any field that is not a stable value.
function historyEntryFromEvent(event: Partial<RepositoryRelayObservation>): RepositoryRelayFailureHistoryEntry | null {
  if (event.code !== 'repository_relay_failed' || repositoryRelayTimestampMs(event.at) === null
    || !(REPOSITORY_RELAY_STAGES as readonly unknown[]).includes(event.stage)) return null;
  return { at: event.at!, stage: event.stage!, ...typedFailure(event.failureCode),
    ...(safeHttpStatus(event.httpStatus) ? { httpStatus: event.httpStatus } : {}),
    ...(safeErrorCode(event.errorCode) ? { errorCode: event.errorCode } : {}) };
}

// A stored entry is read only in the exact form the relay writes.
function storedHistoryEntry(value: unknown, now?: number): RepositoryRelayFailureHistoryEntry | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const entry = value as Record<string, unknown>;
  if (Object.keys(entry).some(key => !HISTORY_ENTRY_KEYS.has(key)) || repositoryRelayTimestampMs(entry.at, now) === null
    || !(REPOSITORY_RELAY_STAGES as readonly unknown[]).includes(entry.stage)
    || ('failureCode' in entry && !REPOSITORY_RELAY_FAILURE_CODES.has(entry.failureCode as string))
    || ('httpStatus' in entry && !safeHttpStatus(entry.httpStatus))
    || ('errorCode' in entry && !safeErrorCode(entry.errorCode))) return null;
  return entry as unknown as RepositoryRelayFailureHistoryEntry;
}

export function currentRepositoryRelayFailureHistory(input: { record: unknown; organizationId: string; deviceId: string;
  workspaceId: string; pid: number; relayPidMtimeMs: number | null; relayPidCtimeMs: number | null; now?: number;
}): RepositoryRelayFailureHistory | null {
  const value = input.record as Record<string, unknown> | null;
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !HISTORY_KEYS.has(key))
    || value.schema !== REPOSITORY_RELAY_FAILURE_HISTORY_SCHEMA
    || value.organizationId !== input.organizationId || value.deviceId !== input.deviceId
    || value.workspaceId !== input.workspaceId || !Number.isSafeInteger(input.pid) || input.pid <= 0 || value.pid !== input.pid
    || !Number.isFinite(input.relayPidMtimeMs) || !Number.isFinite(input.relayPidCtimeMs)
    || value.relayPidMtimeMs !== input.relayPidMtimeMs || value.relayPidCtimeMs !== input.relayPidCtimeMs
    || repositoryRelayTimestampMs(value.since, input.now) === null || !Array.isArray(value.entries)
    || value.entries.length < 1 || value.entries.length > REPOSITORY_RELAY_FAILURE_HISTORY_LIMIT
    || !Number.isSafeInteger(value.count) || (value.count as number) < value.entries.length) return null;
  const entries = value.entries.map(entry => storedHistoryEntry(entry, input.now));
  if (entries.some(entry => entry === null)) return null;
  return { count: value.count as number, since: value.since as string, entries: entries as RepositoryRelayFailureHistoryEntry[] };
}

/** The history after one more failure. A history from another relay process, or in any other form, starts again. */
export function appendRepositoryRelayFailureHistory(previous: unknown, event: Partial<RepositoryRelayObservation>,
  binding: RepositoryRelayProcessBinding) {
  const entry = historyEntryFromEvent(event);
  if (!entry) return null;
  const prior = currentRepositoryRelayFailureHistory({ record: previous, ...binding });
  return { schema: REPOSITORY_RELAY_FAILURE_HISTORY_SCHEMA, organizationId: binding.organizationId,
    deviceId: binding.deviceId, workspaceId: binding.workspaceId, pid: binding.pid,
    relayPidMtimeMs: binding.relayPidMtimeMs, relayPidCtimeMs: binding.relayPidCtimeMs,
    count: Math.min((prior?.count ?? 0) + 1, Number.MAX_SAFE_INTEGER), since: prior?.since ?? entry.at,
    entries: [...(prior?.entries ?? []), entry].slice(-REPOSITORY_RELAY_FAILURE_HISTORY_LIMIT) };
}

/** The one-line default status summary, only when the latest failure is from the last 24 hours. */
export function recentRepositoryRelayFailure(history: RepositoryRelayFailureHistory | null, now = Date.now()) {
  const latest = history?.entries.at(-1);
  if (!history || !latest || now - Date.parse(latest.at) > REPOSITORY_RELAY_RECENT_FAILURE_MS) return null;
  return { count: history.count, since: history.since, latest };
}

export async function selectRepositoryRelayRegistrations<T extends OnboardingWorkspaceRecord & { routeHash: string }>(
  records: readonly T[], enrollment: { organizationId: string; deviceId: string },
  readPolicy: (path: string) => Promise<{ organizationId: string; serverAuthorization?: { workspaceId: string } }>,
): Promise<RepositoryRelayRegistration[]> {
  const result: RepositoryRelayRegistration[] = [];
  for (const path of new Set(records.filter(row => row.organizationId === enrollment.organizationId).map(row => row.path))) {
    const local = selectDeviceWorkspace(records, { ...enrollment, path });
    if (!local) continue;
    const policyPath = resolve(path, '.dharma', 'approved-policy.json');
    let policy;
    try { policy = await readPolicy(policyPath); } catch { continue; }
    const canonical = records.filter(row => row.workspaceId === policy.serverAuthorization?.workspaceId
      && row.organizationId === enrollment.organizationId && row.path === path
      && row.routeHash === local.routeHash && row.repositoryRemoteHash === local.repositoryRemoteHash);
    if (policy.organizationId === enrollment.organizationId && canonical.length === 1) {
      result.push({ workspaceId: canonical[0]!.workspaceId, policyPath });
    }
  }
  return registrations(result);
}

export function repositoryRelayObservationReady(input: {
  observation: unknown; workspaceId: string; version: string; pid: number; now?: number;
}) {
  const value = input.observation as { at?: string; workspaceId?: string; version?: string; pid?: number } | null;
  const age = value && typeof value.at === 'string' ? (input.now ?? Date.now()) - Date.parse(value.at) : NaN;
  return Number.isSafeInteger(input.pid) && input.pid > 0 && value?.workspaceId === input.workspaceId
    && value.version === input.version && value.pid === input.pid
    && Number.isFinite(age) && age >= 0 && age <= 300_000;
}

// #511: sibling loops in this process wait in the signing-control line, but a holder in another process (a CLI
// command or a native turn) can still outlast the 10 s lock wait. A stage retries that busy answer a few times
// instead of ending the loop, which would reopen a device session and wait out the restart backoff.
const SIGNING_CONTROL_BUSY_RETRIES = 3;
const SIGNING_CONTROL_BUSY_RETRY_MS = 1_000;

export async function retrySigningControlBusy<T>(operation: () => Promise<T>, input: { signal: AbortSignal;
  wait?: (ms: number, signal: AbortSignal) => Promise<void> }): Promise<T> {
  const wait = input.wait ?? waitForRelayRefresh;
  for (let retries = 0; ; retries++) {
    try { return await operation(); }
    catch (error) {
      if (retries >= SIGNING_CONTROL_BUSY_RETRIES || input.signal.aborted
        || failureMessage(error) !== 'connection_anchor_busy') throw error;
      await wait(SIGNING_CONTROL_BUSY_RETRY_MS, input.signal);
      if (input.signal.aborted) throw error;
    }
  }
}

export function serializeRelayWork() {
  let tail = Promise.resolve();
  return <T>(operation: () => Promise<T>): Promise<T> => {
    const result = tail.then(operation);
    tail = result.then(() => undefined, () => undefined);
    return result;
  };
}

function registrations(rows: readonly RepositoryRelayRegistration[]) {
  if (rows.length > 50) throw new Error('Too many registered repositories.');
  const ids = new Set<string>();
  for (const row of rows) {
    if (!row || typeof row.workspaceId !== 'string' || !row.workspaceId || row.workspaceId.length > 128
      || /[\r\n\0]/.test(row.workspaceId) || typeof row.policyPath !== 'string'
      || row.policyPath.length > 4096 || /[\r\n\0]/.test(row.policyPath)
      || !(isAbsolute(row.policyPath) || win32.isAbsolute(row.policyPath)) || ids.has(row.workspaceId)) {
      throw new Error('Invalid repository registration.');
    }
    ids.add(row.workspaceId);
  }
  return [...rows].sort((a, b) => a.workspaceId.localeCompare(b.workspaceId));
}

export async function waitForRelayRefresh(ms: number, signal: AbortSignal) {
  if (signal.aborted) return;
  await new Promise<void>(accept => {
    const finish = () => { clearTimeout(timer); signal.removeEventListener('abort', finish); accept(); };
    const timer = setTimeout(finish, ms);
    signal.addEventListener('abort', finish, { once: true });
    if (signal.aborted) finish();
  });
}

// One device relay owns multiple independently authorized repository loops.
// The caller authenticates every registration and serializes task execution.
export async function runRegisteredRepositoryRelays(input: {
  signal: AbortSignal;
  list: () => Promise<readonly RepositoryRelayRegistration[]>;
  run: (registration: RepositoryRelayRegistration, signal: AbortSignal) => Promise<unknown>;
  observe?: (observation: RepositoryRelayObservation) => void | Promise<void>;
  wait?: (ms: number, signal: AbortSignal) => Promise<void>;
  now?: () => number;
}) {
  const now = input.now ?? Date.now;
  const wait = input.wait ?? waitForRelayRefresh;
  type Worker = { row: RepositoryRelayRegistration; controller: AbortController;
    flight: Promise<void>; done: boolean; failed: boolean; failureCode?: string; startedAt: number; endedAt: number };
  const workers = new Map<string, Worker>();
  const failures = new Map<string, { count: number; credentialCount: number; retryAt: number }>();
  // Diagnostics must never turn a caught worker failure into an unhandled rejection.
  const observe = (event: Observation) => {
    try { void Promise.resolve(input.observe?.({ ...event, at: new Date(now()).toISOString() })).catch(() => {}); }
    catch { /* Preserve worker lifecycle. */ }
  };
  const abort = () => { for (const worker of workers.values()) worker.controller.abort(); };
  input.signal.addEventListener('abort', abort, { once: true });
  try {
    while (!input.signal.aborted) {
      let rows: RepositoryRelayRegistration[];
      try { rows = registrations(await input.list()); }
      catch {
        abort();
        observe({ workspaceId: null, code: 'repository_registry_unavailable' });
        await wait(1000, input.signal);
        continue;
      }
      if (input.signal.aborted) break;
      for (const [id, worker] of workers) {
        const current = rows.find(row => row.workspaceId === id);
        if (!current || current.policyPath !== worker.row.policyPath) worker.controller.abort();
        if (!worker.done) continue;
        workers.delete(id);
        if (worker.failed && !worker.controller.signal.aborted) {
          const previous = worker.endedAt - worker.startedAt >= REPOSITORY_RELAY_HEALTHY_RUN_MS ? undefined : failures.get(id);
          const count = (previous?.count ?? 0) + 1;
          const credentialCount = DEVICE_CREDENTIAL_FAILURES.has(worker.failureCode ?? '') ? (previous?.credentialCount ?? 0) + 1 : 0;
          failures.set(id, { count, credentialCount, retryAt: now() + (credentialCount >= DEVICE_CREDENTIAL_FAILURE_LIMIT
            ? DEVICE_CREDENTIAL_RETRY_MS : relayRestartDelayMs(count)) });
        } else failures.delete(id);
      }
      for (const row of rows) {
        if (workers.has(row.workspaceId) || (failures.get(row.workspaceId)?.retryAt ?? 0) > now()) continue;
        const controller = new AbortController();
        const startedAt = now();
        const worker: Worker = { row, controller, done: false, failed: false, flight: Promise.resolve(), startedAt, endedAt: startedAt };
        workers.set(row.workspaceId, worker);
        worker.flight = Promise.resolve().then(async () => {
          if (controller.signal.aborted || input.signal.aborted) return;
          try {
            // A stopped or revoked loop leaves the in-process signing line at once instead of waiting its turn.
            await withDeviceSigningLineSignal(controller.signal, () => input.run(row, controller.signal));
            if (!controller.signal.aborted) {
              worker.failed = true;
              observe({ workspaceId: row.workspaceId, code: 'repository_relay_failed',
                stage: 'worker_run', category: 'unexpected' });
            }
          } catch (error) {
            if (!controller.signal.aborted) {
              worker.failed = true;
              const stage = error instanceof StagedRepositoryRelayError ? error.stage : 'worker_run';
              worker.failureCode = typedFailure(failureMessage(error)).failureCode
                ?? (stage === 'session_open' ? relayOpenFailureCode(failureCause(error)) : undefined);
              // A typed failure code already names the failure; the safe class explains the rest.
              observe({ workspaceId: row.workspaceId, code: 'repository_relay_failed', stage,
                category: failureCategory(error), ...(worker.failureCode ? { failureCode: worker.failureCode } : failureClass(error)) });
            }
          } finally {
            worker.endedAt = now();
            worker.done = true;
          }
        });
      }
      await wait(1000, input.signal);
    }
  } finally {
    abort();
    await Promise.allSettled([...workers.values()].map(worker => worker.flight));
    input.signal.removeEventListener('abort', abort);
  }
}
