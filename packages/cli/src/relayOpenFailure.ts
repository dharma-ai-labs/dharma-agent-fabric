// Stable codes for an AgentFabricClient.open failure at the relay session_open stage.
// Only exact error forms map to a code. The error text itself is never recorded:
// it can quote a path, a store's stderr or a server value.
export const RELAY_OPEN_FAILURE_CODES = ['connection_identity_requires_recovery', 'connection_trust_requires_recovery',
  'connection_identity_store_unavailable'] as const;
export type RelayOpenFailureCode = typeof RELAY_OPEN_FAILURE_CODES[number] | 'connection_anchor_lock_unavailable';

const IDENTITY_MESSAGES = new Set(['relay_host_device_identity_unavailable',
  'Enrolled device identity does not match the secure store.']);
const TRUST_MESSAGES = new Set([
  'Legacy device enrollment must be reauthenticated with dharma login before relay access.',
  'Device configuration does not match the secure enrollment anchor. Run dharma login again.',
  'Device enrollment is not anchored in secure storage. Run dharma login again.',
  'Protected enrollment anchor is corrupt.']);
// Codes the secure-store package sets on a failed credential read.
const STORE_READ_CODES = new Set(['read_response_invalid', 'read_response_too_large', 'read_timeout',
  'read_helper_unavailable', 'read_helper_exited', 'read_helper_closed', 'secure_store_unreadable']);
const STORE_FAILURE_PREFIXES = ['Windows Credential Manager failed: ', 'Linux Secret Service failed: ', 'macOS Keychain failed: '];
// The OS-user enrollment and signing-control lock directories (relay-client enrollmentAnchorLock callers).
const LOCK_PATH = /[\\/]dharma-(?:enrollment-locks|signing-controls)-[a-f0-9]{32}[\\/]/;

function field(error: unknown, name: string): unknown {
  try { return error && typeof error === 'object' ? (error as Record<string, unknown>)[name] : undefined; }
  catch { return undefined; }
}

export function relayOpenFailureCode(error: unknown): RelayOpenFailureCode | undefined {
  const message = field(error, 'message'), code = field(error, 'code');
  if (typeof code === 'string' && STORE_READ_CODES.has(code)) return 'connection_identity_store_unavailable';
  // A raw errno escapes acquireEnrollmentAnchorLock when it runs without a host scope.
  if (typeof code === 'string' && /^E[A-Z]+$/.test(code) && code !== 'ENOENT'
    && (field(error, 'syscall') === 'kill' || [field(error, 'path'), field(error, 'dest')]
      .some(path => typeof path === 'string' && LOCK_PATH.test(path)))) return 'connection_anchor_lock_unavailable';
  if (typeof message !== 'string') return undefined;
  if (IDENTITY_MESSAGES.has(message)) return 'connection_identity_requires_recovery';
  if (TRUST_MESSAGES.has(message)) return 'connection_trust_requires_recovery';
  if (STORE_FAILURE_PREFIXES.some(prefix => message.startsWith(prefix))) return 'connection_identity_store_unavailable';
  return undefined;
}
