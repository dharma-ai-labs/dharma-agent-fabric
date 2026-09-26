import { setTimeout as delay } from 'node:timers/promises';
import { demoWatchRegistrationKey, type DemoWatchRegistration } from './demoWatchRegistry.js';

export type DemoWatchObservation = {
  key: string | null;
  state: 'completed' | 'failed' | 'timed_out';
  stage: string | null;
  sourceState: string | null;
  code: string | null;
};

type CycleResult = { stage: string; sourceSync?: { state: string } };
type Flight = { registration: DemoWatchRegistration; controller: AbortController; decision: Promise<void> };

function bounded(value: unknown): string | null {
  return typeof value === 'string' && /^[a-z0-9_]{1,80}$/.test(value) ? value : null;
}

function sameRegistration(a: DemoWatchRegistration, b: DemoWatchRegistration) {
  return (Object.keys(a) as (keyof DemoWatchRegistration)[]).every(key => a[key] === b[key]);
}

export async function runDemoSupervisor(input: {
  list: () => Promise<DemoWatchRegistration[]>;
  cycle: (registration: DemoWatchRegistration, signal: AbortSignal) => Promise<CycleResult>;
  intervalMs?: number;
  cycleTimeoutMs?: number;
  concurrency?: number;
  once?: boolean;
  signal?: AbortSignal;
  now?: () => number;
  wait?: (durationMs: number, signal?: AbortSignal) => Promise<void>;
  onObservation?: (observation: DemoWatchObservation) => void;
}) {
  const intervalMs = input.intervalMs ?? 60_000;
  const timeoutMs = input.cycleTimeoutMs ?? 30_000;
  const concurrency = input.concurrency ?? 4;
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 15_000 || intervalMs > 300_000) {
    throw new Error('Demo supervisor interval must be between 15 and 300 seconds.');
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300_000) {
    throw new Error('Demo supervisor timeout must be positive and at most 300 seconds.');
  }
  if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 32) {
    throw new Error('Demo supervisor concurrency must be between 1 and 32.');
  }
  const wait = input.wait ?? ((durationMs, signal) => delay(durationMs, undefined, { signal }));
  const now = input.now ?? (() => performance.now());
  const pollIntervalMs = Math.min(intervalMs, 2_000);
  const flights = new Map<string, Flight>();
  const nextEligible = new Map<string, number>();
  let lastTime = 0;
  let cursor = 0;
  let completed = 0;
  let failures = 0;
  let polls = 0;
  let observationFailed = false;
  const cancel = () => { for (const flight of flights.values()) flight.controller.abort(); };
  input.signal?.addEventListener('abort', cancel, { once: true });
  const observe = (observation: DemoWatchObservation) => {
    try { input.onObservation?.(observation); }
    catch { observationFailed = true; cancel(); }
  };

  const start = (key: string, registration: DemoWatchRegistration) => {
    const controller = new AbortController();
    let decide!: () => void;
    const flight: Flight = { registration, controller,
      decision: new Promise<void>(resolve => { decide = resolve; }) };
    flights.set(key, flight);
    let decided = false;
    const finish = (observation?: DemoWatchObservation) => {
      if (decided) return;
      decided = true;
      clearTimeout(timer);
      controller.signal.removeEventListener('abort', abort);
      decide();
      if (observation) observe(observation);
    };
    const abort = () => finish();
    const timer = setTimeout(() => {
      failures += 1;
      finish({ key, state: 'timed_out', stage: null, sourceState: null, code: 'demo_watch_cycle_timeout' });
      controller.abort();
    }, timeoutMs);
    controller.signal.addEventListener('abort', abort, { once: true });
    // Keep the slot until the operation actually settles, even after its deadline or revocation.
    const operation = (async () => input.cycle(registration, controller.signal))();
    void operation.then(result => {
      if (decided || controller.signal.aborted || input.signal?.aborted) return;
      const stage = bounded(result?.stage);
      const sourceState = bounded(result?.sourceSync?.state);
      if (!stage || (result?.sourceSync && !sourceState)) {
        failures += 1;
        finish({ key, state: 'failed', stage: null, sourceState: null, code: 'demo_watch_receipt_invalid' });
        return;
      }
      completed += 1;
      finish({ key, state: 'completed', stage, sourceState, code: null });
    }, error => {
      if (decided || controller.signal.aborted || input.signal?.aborted) return;
      failures += 1;
      finish({ key, state: 'failed', stage: null, sourceState: null,
        code: bounded((error as { code?: unknown } | null)?.code) ?? 'demo_watch_cycle_failed' });
    }).finally(() => { if (flights.get(key) === flight) flights.delete(key); });
    return flight;
  };

  try {
    while (!input.signal?.aborted && !observationFailed) {
      polls += 1;
      let registrations = new Map<string, DemoWatchRegistration>();
      try {
        const rows = await input.list();
        if (rows.length > 32) throw new Error('Demo watch registration limit exceeded.');
        for (const row of rows) {
          const key = demoWatchRegistrationKey(row);
          if (registrations.has(key)) throw new Error('Duplicate Demo watch scope.');
          registrations.set(key, row);
        }
      } catch {
        registrations = new Map();
        failures += 1;
        observe({ key: null, state: 'failed', stage: null,
          sourceState: null, code: 'demo_watch_registry_invalid' });
      }
      if (input.signal?.aborted || observationFailed) break;
      const currentTime = now();
      if (!Number.isFinite(currentTime) || currentTime < lastTime
        || currentTime > Number.MAX_SAFE_INTEGER - intervalMs) {
        throw new Error('Demo supervisor clock must be finite and monotonic.');
      }
      lastTime = currentTime;
      for (const key of nextEligible.keys()) {
        if (!registrations.has(key)) nextEligible.delete(key);
      }
      for (const [key, flight] of flights) {
        const row = registrations.get(key);
        if (!row || !sameRegistration(row, flight.registration)) flight.controller.abort();
      }
      const rows = [...registrations.entries()];
      const launched: Flight[] = [];
      const startAt = rows.length ? cursor % rows.length : 0;
      for (let offset = 0; offset < rows.length && flights.size < concurrency; offset += 1) {
        const index = (startAt + offset) % rows.length;
        const [key, row] = rows[index]!;
        if (!flights.has(key) && currentTime >= (nextEligible.get(key) ?? 0)) {
          nextEligible.set(key, currentTime + intervalMs);
          launched.push(start(key, row));
          cursor = index + 1;
        }
      }
      if (input.once) { await Promise.all(launched.map(flight => flight.decision)); break; }
      try { await wait(pollIntervalMs, input.signal); }
      catch (error) { if (!input.signal?.aborted) throw error; }
    }
    if (observationFailed) throw new Error('Demo supervisor observation sink failed.');
    return { ok: failures === 0, stage: 'demo_supervisor_stopped', polls, completed, failures };
  } finally {
    input.signal?.removeEventListener('abort', cancel);
    cancel();
  }
}
