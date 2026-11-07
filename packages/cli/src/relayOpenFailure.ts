import { createSystemSecureStore, type SecureSecretStore } from '@dharma-ai-labs/agent-fabric-secure-store';

// Stable codes for an AgentFabricClient.open failure at the relay session_open stage.
// Only exact error forms map to a code. The error text itself is never recorded:
// it can quote a path, a store's stderr or a server value.
export const RELAY_OPEN_FAILURE_CODES = ['connection_identity_requires_recovery', 'connection_trust_requires_recovery',
  'connection_identity_store_unavailable', 'connection_identity_store_busy'] as const;
export type RelayOpenFailureCode = typeof RELAY_OPEN_FAILURE_CODES[number] | 'connection_anchor_lock_unavailable';

const IDENTITY_MESSAGES = new Set(['relay_host_device_identity_unavailable',
  'Enrolled device identity does not match the secure store.']);
const TRUST_MESSAGES = new Set([
  'Legacy device enrollment must be reauthenticated with dharma login before relay access.',
  'Device configuration does not match the secure enrollment anchor. Run dharma login again.',
  'Device enrollment is not anchored in secure storage. Run dharma login again.',
  'Protected enrollment anchor is corrupt.']);
// Codes the secure-store package sets on a failed credential read. An unreadable answer needs the user;
// a helper that timed out or went away is transient and keeps the normal short retry.
const STORE_UNREADABLE_CODES = new Set(['read_response_invalid', 'read_response_too_large']);
// Without the fresh reader (WSL) the Windows helper reports any non-not-found vault exception with this fixed text.
const STORE_UNREADABLE_MESSAGES = new Set(['Windows Credential Manager failed: Credential read unavailable.']);
const STORE_BUSY_CODES = new Set(['read_timeout', 'read_helper_unavailable', 'read_helper_exited', 'read_helper_closed']);
const STORE_FAILURE_PREFIXES = ['Windows Credential Manager failed: ', 'Linux Secret Service failed: ', 'macOS Keychain failed: '];
// The OS-user enrollment and signing-control lock directories (relay-client enrollmentAnchorLock callers).
const LOCK_PATH = /[\\/]dharma-(?:enrollment-locks|signing-controls)-[a-f0-9]{32}[\\/]/;

function field(error: unknown, name: string): unknown {
  try { return error && typeof error === 'object' ? (error as Record<string, unknown>)[name] : undefined; }
  catch { return undefined; }
}

export function relayOpenFailureCode(error: unknown): RelayOpenFailureCode | undefined {
  const message = field(error, 'message'), code = field(error, 'code');
  if (typeof code === 'string' && STORE_UNREADABLE_CODES.has(code)) return 'connection_identity_store_unavailable';
  if (typeof code === 'string' && STORE_BUSY_CODES.has(code)) return 'connection_identity_store_busy';
  // A raw errno escapes acquireEnrollmentAnchorLock when it runs without a host scope.
  if (typeof code === 'string' && /^E[A-Z]+$/.test(code) && code !== 'ENOENT'
    && (field(error, 'syscall') === 'kill' || [field(error, 'path'), field(error, 'dest')]
      .some(path => typeof path === 'string' && LOCK_PATH.test(path)))) return 'connection_anchor_lock_unavailable';
  if (typeof message !== 'string') return undefined;
  if (IDENTITY_MESSAGES.has(message)) return 'connection_identity_requires_recovery';
  if (TRUST_MESSAGES.has(message)) return 'connection_trust_requires_recovery';
  if (STORE_UNREADABLE_MESSAGES.has(message)) return 'connection_identity_store_unavailable';
  // Any other store command that exited non-zero gives no sign that the credential is gone.
  if (STORE_FAILURE_PREFIXES.some(prefix => message.startsWith(prefix))) return 'connection_identity_store_busy';
  return undefined;
}

const WINDOWS_CREDENTIALS_REMEDY = 'Device credentials cannot be read. If the Windows password was reset by an administrator, '
  + 'restore the previous password or re-enroll this device.';

/** One line for `dharma status`; undefined for any code without a known next step. */
export function relayOpenFailureRemedy(code: unknown, platform: NodeJS.Platform = process.platform): string | undefined {
  switch (code) {
    case 'connection_identity_requires_recovery': return platform === 'win32' ? WINDOWS_CREDENTIALS_REMEDY
      : 'Device credentials cannot be read from the OS keychain. Unlock it for this user or re-enroll this device.';
    case 'connection_identity_store_unavailable': return platform === 'win32' ? WINDOWS_CREDENTIALS_REMEDY
      : 'The OS credential store cannot be read. Unlock it for this user; the relay retries on its own.';
    case 'connection_identity_store_busy':
      return 'The credential store did not answer in time; the relay keeps retrying.';
    case 'connection_trust_requires_recovery':
      return 'Device enrollment trust cannot be verified. Run dharma login to re-authenticate this device.';
    case 'connection_anchor_lock_unavailable':
      return 'The device enrollment lock cannot be checked. Close other Dharma relays for this user; the relay retries on its own.';
    default: return undefined;
  }
}

const BACKEND_PLATFORM: Record<SecureSecretStore['backend'], NodeJS.Platform> = {
  'windows-credential-manager': 'win32', 'macos-keychain': 'darwin', 'linux-secret-service': 'linux' };

/** The remedy for this host's credential store: WSL uses the Windows vault, so it gets the Windows text. */
export async function relayOpenFailureRemedyForHost(code: unknown,
  openStore: () => Promise<Pick<SecureSecretStore, 'backend'>> = createSystemSecureStore): Promise<string | undefined> {
  if (relayOpenFailureRemedy(code) === undefined) return undefined;
  const platform = await openStore().then(store => BACKEND_PLATFORM[store.backend] ?? process.platform, () => process.platform);
  return relayOpenFailureRemedy(code, platform);
}
