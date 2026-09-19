export async function prepareProvidersIndependently<T>(
  providers: readonly T[], assertRunning: () => void,
  prepare: (provider: T) => Promise<void>, onError: (provider: T, error: unknown) => void,
) {
  for (const provider of providers) {
    assertRunning();
    try { await prepare(provider); assertRunning(); }
    catch (error) { assertRunning(); onError(provider, error); }
  }
}

export function startSkillPreparationPump(input: {
  prepare: (assertRunning: () => void) => Promise<void>;
  intervalMs?: number;
  onError?: (error: unknown) => void;
}) {
  const intervalMs = input.intervalMs ?? 60_000;
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 1) throw new Error('Preparation interval is invalid.');
  let stopped = false;
  let flight: Promise<void> | null = null;
  const assertRunning = () => { if (stopped) throw new Error('Skill preparation stopped.'); };
  const tick = () => {
    if (stopped || flight) return;
    // A logical deadline must never release ownership of a still-running call.
    flight = Promise.resolve().then(() => { assertRunning(); return input.prepare(assertRunning); })
      .catch(error => { if (!stopped) input.onError?.(error); })
      .finally(() => { flight = null; });
  };
  const timer = setInterval(tick, intervalMs);
  timer.unref();
  tick();
  const requestStop = () => { stopped = true; clearInterval(timer); };
  return {
    requestStop,
    async stop() { requestStop(); await flight; },
    get running() { return flight !== null; },
  };
}
