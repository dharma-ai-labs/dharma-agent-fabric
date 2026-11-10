/**
 * Scheduled capture of the member's own provider sessions by the local relay.
 *
 * Setup captures the workspace's earlier sessions once. Before this module the relay only uploaded
 * capsules that were already queued, so every later session waited for a manual
 * `dharma evidence capture-batch --sync`. Each cycle discovers workspace-qualified sessions per
 * provider and queues new or changed capsule revisions; the relay's ordinary pending-capsule sync
 * uploads them under the current policy, in the same cycle.
 */
export const RELAY_SESSION_CAPTURE_INTERVAL_MS = 300_000;
/** The same bound setup and the documented capture-batch command use. */
export const RELAY_SESSION_CAPTURE_MAXIMUM_SESSIONS = 20;

export interface RelaySessionCaptureCycle { queued: number; failures: number }

/** One provider's unreadable history or one session's invalid capsule never stops the others. */
export async function runRelaySessionCapture<Session, Provider extends string = string>(input: {
  providers: readonly Provider[];
  discover: (provider: Provider) => Promise<readonly Session[]>;
  /** True when a new capsule revision was queued; false when the vault already holds this evidence. */
  queue: (session: Session) => Promise<boolean>;
  stopping: () => boolean;
}): Promise<RelaySessionCaptureCycle> {
  let queued = 0;
  let failures = 0;
  for (const provider of input.providers) {
    if (input.stopping()) break;
    let sessions: readonly Session[];
    try { sessions = await input.discover(provider); } catch { failures += 1; continue; }
    for (const session of sessions) {
      if (input.stopping()) break;
      try { if (await input.queue(session)) queued += 1; } catch { failures += 1; }
    }
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
