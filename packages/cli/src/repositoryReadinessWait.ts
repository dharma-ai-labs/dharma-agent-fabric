export type RepositoryReadinessObservation = {
  state: 'absent' | 'accepted' | 'processing' | 'published' | 'blocked';
  ready: boolean;
  candidateId: string | null;
};

export type RepositoryReadinessResult = RepositoryReadinessObservation & {
  outcome: 'ready' | 'blocked' | 'pending';
  attempts: number;
};

export async function waitForRepositoryReadiness(
  observe: () => Promise<RepositoryReadinessObservation>,
  options: {
    maximumWaitMs?: number;
    intervalMs?: number;
    now?: () => number;
    wait?: (delayMs: number) => Promise<void>;
  } = {},
): Promise<RepositoryReadinessResult> {
  const maximumWaitMs = options.maximumWaitMs ?? 300_000;
  const intervalMs = options.intervalMs ?? 5_000;
  if (!Number.isSafeInteger(maximumWaitMs) || maximumWaitMs < 0
    || !Number.isSafeInteger(intervalMs) || intervalMs < 1) {
    throw new Error('Invalid repository readiness wait bounds.');
  }
  const now = options.now ?? Date.now;
  const wait = options.wait ?? ((delayMs: number) => new Promise<void>(resolve => setTimeout(resolve, delayMs)));
  const deadline = now() + maximumWaitMs;
  for (let attempts = 1; ; attempts += 1) {
    const observed = await observe();
    if (observed.ready) return { ...observed, outcome: 'ready', attempts };
    if (observed.state === 'blocked') return { ...observed, outcome: 'blocked', attempts };
    const remaining = deadline - now();
    if (remaining <= 0) return { ...observed, outcome: 'pending', attempts };
    await wait(Math.min(intervalMs, remaining));
  }
}
