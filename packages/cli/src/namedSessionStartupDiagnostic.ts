import {types} from 'node:util';

export const namedSessionStartupErrors = Object.freeze({
  setup_child_unavailable: 'named_session_startup_setup_child_unavailable',
  named_session_registration_invalid: 'named_session_startup_registration_invalid',
  named_session_provider_authentication_required: 'named_session_startup_provider_authentication_required',
  named_session_workspace_write_not_authorized: 'named_session_startup_workspace_write_not_authorized',
  named_session_trust_scope_mismatch: 'named_session_startup_trust_scope_mismatch',
  codex_session_sandbox_unqualified: 'named_session_startup_sandbox_unqualified',
} as const);

const phases = ['vault', 'lock', 'client', 'trust', 'session', 'policy', 'registration',
  'environment', 'filesystem', 'transport', 'account', 'thread', 'binding', 'lifetime', 'service'] as const;
export type NamedSessionStartupPhase = typeof phases[number];
const reasons = ['unclassified', 'missing', 'permission', 'conflict', 'timeout', 'connection', 'aborted'] as const;
type Reason = typeof reasons[number];
export type NamedSessionStartupPhaseFailure = `named_session_startup_phase_${NamedSessionStartupPhase}_${Reason}`;
const codes = new Set<string>(phases.flatMap(phase => reasons.map(reason => `named_session_startup_phase_${phase}_${reason}`)));
const errno: Readonly<Record<string, Reason>> = Object.freeze({
  ENOENT: 'missing', EACCES: 'permission', EPERM: 'permission', EADDRINUSE: 'conflict',
  EEXIST: 'conflict', ETIMEDOUT: 'timeout', ECONNREFUSED: 'connection', ECONNRESET: 'connection',
  ABORT_ERR: 'aborted',
});

export function isNamedSessionStartupPhaseFailure(value: unknown): value is NamedSessionStartupPhaseFailure {
  return typeof value === 'string' && codes.has(value);
}

/** Never copy exception messages, response bodies or property getters into diagnostics. */
export function namedSessionStartupPhaseError(phase: NamedSessionStartupPhase, error: unknown): Error {
  let reason: Reason = 'unclassified';
  const seen = new Set<object>();
  for (let depth = 0; depth < 4; depth++) {
    if (!error || typeof error !== 'object' || types.isProxy(error) || seen.has(error)) break;
    seen.add(error);
    const message = Object.getOwnPropertyDescriptor(error, 'message');
    if (message && Object.hasOwn(message, 'value') && typeof message.value === 'string'
      && Object.hasOwn(namedSessionStartupErrors, message.value)) return new Error(message.value);
    const code = Object.getOwnPropertyDescriptor(error, 'code');
    if (code && Object.hasOwn(code, 'value') && typeof code.value === 'string' && Object.hasOwn(errno, code.value)) {
      reason = errno[code.value]!; break;
    }
    const cause = Object.getOwnPropertyDescriptor(error, 'cause');
    error = cause && Object.hasOwn(cause, 'value') ? cause.value : undefined;
  }
  const safePhase = phases.includes(phase) ? phase : 'service';
  return new Error(`named_session_startup_phase_${safePhase}_${reason}`);
}
