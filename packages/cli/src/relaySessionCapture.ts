/**
 * Scheduled capture of the member's own provider sessions by the local relay.
 *
 * Setup captures the workspace's earlier sessions once. Before this module the relay only uploaded
 * capsules that were already queued, so every later session waited for a manual
 * `dharma evidence capture-batch --sync`. Each cycle discovers workspace-qualified sessions per
 * provider and queues new or changed capsule revisions; the relay's ordinary pending-capsule sync
 * uploads them under the current policy, in the same cycle.
 *
 * A session is queued only after it has been quiet for one interval, so a session in progress is
 * uploaded once when it pauses, not as a full new revision every cycle. After a provider's cycle
 * completes, its next discovery asks only for sessions changed since one interval before that cycle.
 */
export const RELAY_SESSION_CAPTURE_INTERVAL_MS = 300_000;
/** The same bound setup and the documented capture-batch command use. */
export const RELAY_SESSION_CAPTURE_MAXIMUM_SESSIONS = 20;

export interface RelaySessionCaptureCycle { queued: number; failures: number }
/** `pending`: the session's latest revision still waits for its upload, so no revision is built on it yet. */
export type RelaySessionQueueResult = 'queued' | 'unchanged' | 'pending';

/** One provider's unreadable history or one session's invalid capsule never stops the others. */
export async function runRelaySessionCapture<Session extends { endedAt: string }, Provider extends string = string>(input: {
  providers: readonly Provider[];
  /** Per-provider discovery window kept by the relay across cycles; absent means the newest sessions. */
  since: Map<Provider, Date>;
  now: number;
  /** Null when the provider cannot be read this cycle; its window is kept. */
  discover: (provider: Provider, since: Date | undefined) => Promise<readonly Session[] | null>;
  queue: (session: Session) => Promise<RelaySessionQueueResult>;
  stopping: () => boolean;
}): Promise<RelaySessionCaptureCycle> {
  let queued = 0;
  let failures = 0;
  const quietBefore = input.now - RELAY_SESSION_CAPTURE_INTERVAL_MS;
  for (const provider of input.providers) {
    if (input.stopping()) break;
    let sessions: readonly Session[] | null;
    try { sessions = await input.discover(provider, input.since.get(provider)); } catch { failures += 1; continue; }
    if (!sessions) continue;
    // A failed, still-pending or interrupted session keeps the provider's window, so it is seen again.
    let complete = true;
    for (const session of sessions) {
      if (input.stopping()) { complete = false; break; }
      // Still being written: the next window (one interval before this cycle) still includes it.
      if (Date.parse(session.endedAt) > quietBefore) continue;
      try {
        const result = await input.queue(session);
        if (result === 'queued') queued += 1;
        if (result === 'pending') complete = false;
      } catch { failures += 1; complete = false; }
    }
    if (complete) input.since.set(provider, new Date(quietBefore));
  }
  return { queued, failures };
}

const DAILY_UPLOAD_LIMIT = 'Organization daily content upload limit would be exceeded.';

/** Scheduled capture makes the daily content limit reachable in normal use. Reaching it pauses
 * uploads until the next policy refresh; it is not a relay failure to restart on. */
export async function deferDailyUploadLimit<T>(operation: () => Promise<T>): Promise<
  { state: 'completed'; value: T } | { state: 'deferred'; reason: 'daily_upload_limit' }> {
  try {
    return { state: 'completed', value: await operation() };
  } catch (error) {
    if (error instanceof Error && error.message === DAILY_UPLOAD_LIMIT) return { state: 'deferred', reason: 'daily_upload_limit' };
    throw error;
  }
}
