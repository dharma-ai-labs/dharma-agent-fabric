import type { ChildProcess } from 'node:child_process';

export function relayRestartDelayMs(consecutiveShortRuns: number): number {
  return Math.min(30_000, 1_000 * 2 ** Math.min(Math.max(0, consecutiveShortRuns - 1), 5));
}

async function waitForRestart(delayMs: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  await new Promise<void>((resolveWait) => {
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', finish);
      resolveWait();
    };
    const timer = setTimeout(finish, delayMs);
    signal.addEventListener('abort', finish, { once: true });
  });
}

export async function superviseRelay(input: {
  start: () => ChildProcess;
  signal: AbortSignal;
  now?: () => number;
  wait?: (delayMs: number, signal: AbortSignal) => Promise<void>;
}): Promise<{ restarts: number }> {
  const now = input.now || Date.now;
  const wait = input.wait || waitForRestart;
  let consecutiveShortRuns = 0;
  let restarts = 0;

  while (!input.signal.aborted) {
    const startedAt = now();
    let child: ChildProcess;
    try {
      child = input.start();
    } catch {
      consecutiveShortRuns += 1;
      restarts += 1;
      await wait(relayRestartDelayMs(consecutiveShortRuns), input.signal);
      continue;
    }

    await new Promise<void>((resolveExit) => {
      const onAbort = () => { child.kill('SIGTERM'); };
      const onExit = () => {
        input.signal.removeEventListener('abort', onAbort);
        child.removeListener('error', onExit);
        child.removeListener('exit', onExit);
        resolveExit();
      };
      child.once('error', onExit);
      child.once('exit', onExit);
      input.signal.addEventListener('abort', onAbort, { once: true });
      if (input.signal.aborted) onAbort();
    });
    if (input.signal.aborted) break;

    consecutiveShortRuns = now() - startedAt >= 60_000 ? 1 : consecutiveShortRuns + 1;
    restarts += 1;
    await wait(relayRestartDelayMs(consecutiveShortRuns), input.signal);
  }

  return { restarts };
}
