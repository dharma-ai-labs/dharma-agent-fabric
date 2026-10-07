import type {ChildProcess} from 'node:child_process';
import type {Readable} from 'node:stream';

const classifications = {
  setup_child_unavailable: 'named_session_startup_setup_child_unavailable',
  named_session_registration_invalid: 'named_session_startup_registration_invalid',
  named_session_provider_authentication_required: 'named_session_startup_provider_authentication_required',
  named_session_workspace_write_not_authorized: 'named_session_startup_workspace_write_not_authorized',
  named_session_trust_scope_mismatch: 'named_session_startup_trust_scope_mismatch',
  codex_session_sandbox_unqualified: 'named_session_startup_sandbox_unqualified',
} as const;
export type NamedSessionStartupFailure = typeof classifications[keyof typeof classifications]
  | 'named_session_startup_child_spawn_failed' | 'named_session_startup_child_exited'
  | 'named_session_startup_child_failed';
const codes = new Set<string>([...Object.values(classifications), 'named_session_startup_child_spawn_failed',
  'named_session_startup_child_exited', 'named_session_startup_child_failed']);
export function isNamedSessionStartupFailure(value: unknown): value is NamedSessionStartupFailure {
  return typeof value === 'string' && codes.has(value);
}

/** Observe only the freshly spawned handle. Raw stderr stays bounded in memory,
 * never reaches logs/receipts, and is discarded when startup observation ends. */
export function observeNamedSessionStartupChild(child: ChildProcess) {
  const buffer = Buffer.alloc(4096);
  let length = 0, overflow = false, disposed = false, failure: NamedSessionStartupFailure | undefined;
  const data = (chunk: Buffer | string) => {
    if (disposed || overflow) return;
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    if (length + bytes.length > buffer.length) {overflow = true; buffer.fill(0); length = 0; return;}
    bytes.copy(buffer, length); length += bytes.length;
  };
  const error = () => {failure = 'named_session_startup_child_spawn_failed';};
  const close = (exit: number | null) => {
    if (failure) return;
    failure = exit === 0 || exit === null ? 'named_session_startup_child_exited' : 'named_session_startup_child_failed';
    if (!overflow && exit !== 0 && exit !== null) {
      const last = buffer.subarray(0, length).toString('utf8').trim().split(/\r?\n/).at(-1);
      if (last && Object.hasOwn(classifications, last)) failure = classifications[last as keyof typeof classifications];
    }
    buffer.fill(0); length = 0;
  };
  child.stderr?.on('data', data); child.on('error', error); child.on('close', close);
  return Object.freeze({readFailure: () => failure, dispose() {
    if (disposed) return;
    disposed = true; buffer.fill(0); length = 0;
    child.stderr?.removeListener('data', data); child.removeListener('error', error); child.removeListener('close', close);
    child.stderr?.resume();
    // A detached worker's diagnostic pipe must not keep its launcher alive.
    (child.stderr as (Readable & {unref?(): void}) | null)?.unref?.();
  }});
}
