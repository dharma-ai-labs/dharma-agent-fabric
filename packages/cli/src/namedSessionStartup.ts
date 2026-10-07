import {isNamedSessionStartupFailure, type NamedSessionStartupFailure} from './namedSessionStartupChild.js';

export async function waitForNamedSessionStartup<T>(input: {
  step<R>(operation: () => Promise<R>): Promise<R>;
  assertActive(): Promise<void>;
  observe(): Promise<T>;
  maximumWaitMs?: number;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
  readFailure?: () => NamedSessionStartupFailure | undefined;
}): Promise<T> {
  const maximumWaitMs = input.maximumWaitMs ?? 120_000;
  if (!Number.isSafeInteger(maximumWaitMs) || maximumWaitMs < 1 || maximumWaitMs > 120_000) {
    throw new Error('named_session_startup_failed');
  }
  const now = input.now ?? (() => performance.now());
  const sleep = input.sleep ?? (milliseconds => new Promise<void>(done => setTimeout(done, milliseconds)));
  const deadline = now() + maximumWaitMs;
  while (now() < deadline) {
    await input.step(() => sleep(Math.min(250, deadline - now())));
    if (now() >= deadline) break;
    await input.assertActive();
    if (now() >= deadline) break;
    // Only transport observation failures are retryable; never swallow a scope refusal.
    const result = await input.step(async () => {
      if (now() >= deadline) return {available: false as const};
      const refuseFailedChild = () => {
        const failure = input.readFailure?.();
        if (failure !== undefined) throw new Error(isNamedSessionStartupFailure(failure) ? failure : 'named_session_startup_failed');
      };
      refuseFailedChild();
      let observation: {available: true; value: T} | {available: false};
      try {observation = {available: true, value: await input.observe()};}
      catch {observation = {available: false};}
      refuseFailedChild();
      return observation;
    });
    if (now() >= deadline) break;
    if (result.available) return result.value;
  }
  throw new Error('named_session_startup_failed');
}
