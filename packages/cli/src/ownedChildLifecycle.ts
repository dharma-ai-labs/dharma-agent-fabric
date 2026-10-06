import type { ChildProcess } from 'node:child_process';

export interface OwnedChildLifecycle {
  readonly exited: Promise<void>;
  readonly failed: boolean;
  readonly stopped: boolean;
  stop(options?: { verify?: () => Promise<boolean>; graceMs?: number }): Promise<void>;
}

/** Capture immediately after this caller's spawn. Never adopt a raw PID. */
export function watchOwnedChild(child: ChildProcess): OwnedChildLifecycle {
  let confirmed = false;
  let failed = false;
  let finish!: () => void;
  let stopFlight: Promise<void> | undefined;
  const exited = new Promise<void>(resolveExit => { finish = resolveExit; });
  const terminal = () => typeof child.exitCode === 'number'
    || typeof child.signalCode === 'string';
  const onExit = () => {
    if (confirmed) return;
    confirmed = true;
    child.removeListener('exit', onExit);
    finish();
  };
  const onError = () => {
    failed = true;
    // Failed spawn has no process. A signal/send error on a live process does.
    if (!child.pid || terminal()) onExit();
  };
  child.on('error', onError);
  child.once('exit', onExit);
  child.once('close', () => { child.removeListener('error', onError); });
  if (terminal()) onExit();

  const stopped = () => {
    if (!confirmed && terminal()) onExit();
    return confirmed;
  };
  const wait = async (milliseconds: number) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([exited, new Promise<void>(done => { timer = setTimeout(done, milliseconds); })]);
    } finally { if (timer) clearTimeout(timer); }
  };
  const unavailable = () => new Error('owned_child_stop_unconfirmed');

  return Object.freeze({
    exited,
    get failed() { return failed; },
    get stopped() { return stopped(); },
    stop(options: { verify?: () => Promise<boolean>; graceMs?: number } = {}) {
      if (stopFlight) return stopFlight;
      const graceMs = options.graceMs ?? 10_000;
      if (!Number.isInteger(graceMs) || graceMs < 1 || graceMs > 10_000) return Promise.reject(unavailable());
      stopFlight = (async () => {
        try {
          for (const signal of ['SIGTERM', 'SIGKILL'] as const) {
            if (stopped()) return;
            if (options.verify && !await options.verify().catch(() => false)) {
              if (stopped()) return;
              throw unavailable();
            }
            if (stopped()) return;
            // Use only the retained spawn handle, and recheck creation identity
            // before each signal when the owning controller supplies one.
            if (child.pid) { try { child.kill(signal); } catch { /* Exit remains unconfirmed. */ } }
            await wait(graceMs);
          }
          if (!stopped()) throw unavailable();
        } finally { stopFlight = undefined; }
      })();
      return stopFlight;
    },
  });
}
