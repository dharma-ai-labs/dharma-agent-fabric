import { setTimeout as delay } from 'node:timers/promises';

export async function runDemoWatch<T extends { stage: string; sourceSync?: { state: string } }>(input: {
  cycle: () => Promise<T>;
  intervalMs?: number;
  once?: boolean;
  signal?: AbortSignal;
  onCycle?: (result: T) => void;
  onFailure?: (code: string) => void;
}) {
  const intervalMs = input.intervalMs ?? 60_000;
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 15_000 || intervalMs > 300_000) {
    throw new Error('Demo watch interval must be between 15 and 300 seconds.');
  }
  let cycles = 0;
  let failures = 0;
  let lastStage: string | null = null;
  let lastSourceState: string | null = null;
  let lastFailureCode: string | null = null;
  while (!input.signal?.aborted) {
    try {
      const result = await input.cycle();
      cycles += 1;
      lastStage = result.stage;
      lastSourceState = result.sourceSync?.state ?? null;
      lastFailureCode = null;
      input.onCycle?.(result);
    } catch (error) {
      failures += 1;
      const code = (error as { code?: unknown }).code;
      lastFailureCode = typeof code === 'string' && /^[a-z0-9_]{1,80}$/.test(code)
        ? code : 'demo_watch_cycle_failed';
      input.onFailure?.(lastFailureCode);
    }
    if (input.once) break;
    try { await delay(intervalMs, undefined, { signal: input.signal }); }
    catch (error) {
      if (!input.signal?.aborted) throw error;
    }
  }
  return { ok: failures === 0, stage: 'demo_watch_stopped', cycles, failures,
    lastStage, lastSourceState, lastFailureCode };
}
