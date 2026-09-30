import { isAbsolute, resolve, win32 } from 'node:path';
import { selectDeviceWorkspace, type OnboardingWorkspaceRecord } from './onboardingWorkspace.js';
import { relayRestartDelayMs } from './relaySupervisor.js';

export interface RepositoryRelayRegistration { workspaceId: string; policyPath: string }
export type RepositoryRelayStage = 'policy_verification' | 'trajectory_recovery' | 'evidence_sync' | 'task_poll' | 'worker_run';
export type RepositoryRelayFailureCategory = 'policy_boundary' | 'retention_not_ready' | 'policy_invalid' | 'unexpected';
interface Observation { workspaceId: string | null; code: string; stage?: RepositoryRelayStage;
  category?: RepositoryRelayFailureCategory }

class StagedRepositoryRelayError extends Error {
  constructor(readonly stage: RepositoryRelayStage, cause: unknown) {
    super('Repository relay stage failed.', { cause });
  }
}

export async function withRepositoryRelayStage<T>(stage: RepositoryRelayStage, operation: () => Promise<T>): Promise<T> {
  try { return await operation(); }
  catch (error) { throw new StagedRepositoryRelayError(stage, error); }
}

function failureCategory(error: unknown): RepositoryRelayFailureCategory {
  const cause = error instanceof StagedRepositoryRelayError ? error.cause : error;
  let message = '';
  try { if (cause instanceof Error) message = cause.message; }
  catch { return 'unexpected'; }
  if (/^policy_boundary:/.test(message)) return 'policy_boundary';
  if (/^agent_fabric_retention_not_ready:/.test(message)) return 'retention_not_ready';
  if (/^agent_fabric_policy_invalid:/.test(message)) return 'policy_invalid';
  return 'unexpected';
}

export function currentRepositoryRelayFailure(input: { receipt: unknown; organizationId: string; deviceId: string;
  workspaceId: string; pid: number; relayPidWrittenAt: number | null;
  lastSuccessfulPollAt: string | null; now?: number }) {
  const value = input.receipt as Record<string, unknown> | null;
  if (!value || value.schema !== 'dharma.local-repository-relay-failure/v1'
    || value.organizationId !== input.organizationId || value.deviceId !== input.deviceId
    || value.workspaceId !== input.workspaceId || value.pid !== input.pid
    || !Number.isSafeInteger(input.pid) || input.pid <= 0
    || typeof value.at !== 'string' || !Number.isFinite(Date.parse(value.at))
    || !Number.isFinite(input.relayPidWrittenAt) || input.relayPidWrittenAt === null
    || Date.parse(value.at) <= input.relayPidWrittenAt
    || Date.parse(value.at) > (input.now ?? Date.now()) + 30_000
    || (input.lastSuccessfulPollAt && Date.parse(value.at) <= Date.parse(input.lastSuccessfulPollAt))
    || !['policy_verification', 'trajectory_recovery', 'evidence_sync', 'task_poll', 'worker_run'].includes(String(value.stage))
    || !['policy_boundary', 'retention_not_ready', 'policy_invalid', 'unexpected'].includes(String(value.category))) {
    return null;
  }
  return { at: value.at, stage: value.stage, category: value.category };
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
  observe?: (observation: Observation) => void | Promise<void>;
  wait?: (ms: number, signal: AbortSignal) => Promise<void>;
  now?: () => number;
}) {
  const now = input.now ?? Date.now;
  const wait = input.wait ?? waitForRelayRefresh;
  const workers = new Map<string, { row: RepositoryRelayRegistration; controller: AbortController;
    flight: Promise<void>; done: boolean; failed: boolean }>();
  const failures = new Map<string, { count: number; retryAt: number }>();
  // Diagnostics must never turn a caught worker failure into an unhandled rejection.
  const observe = (event: Observation) => {
    try { void Promise.resolve(input.observe?.(event)).catch(() => {}); }
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
          const count = (failures.get(id)?.count ?? 0) + 1;
          failures.set(id, { count, retryAt: now() + relayRestartDelayMs(count) });
        } else failures.delete(id);
      }
      for (const row of rows) {
        if (workers.has(row.workspaceId) || (failures.get(row.workspaceId)?.retryAt ?? 0) > now()) continue;
        const controller = new AbortController();
        const worker = { row, controller, done: false, failed: false, flight: Promise.resolve() };
        workers.set(row.workspaceId, worker);
        worker.flight = Promise.resolve().then(async () => {
          if (controller.signal.aborted || input.signal.aborted) return;
          try {
            await input.run(row, controller.signal);
            if (!controller.signal.aborted) {
              worker.failed = true;
              observe({ workspaceId: row.workspaceId, code: 'repository_relay_failed',
                stage: 'worker_run', category: 'unexpected' });
            }
          } catch (error) {
            if (!controller.signal.aborted) {
              worker.failed = true;
              observe({ workspaceId: row.workspaceId, code: 'repository_relay_failed',
                stage: error instanceof StagedRepositoryRelayError ? error.stage : 'worker_run',
                category: failureCategory(error) });
            }
          } finally {
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
