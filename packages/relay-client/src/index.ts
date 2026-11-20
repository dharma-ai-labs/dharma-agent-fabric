import {AsyncLocalStorage} from 'node:async_hooks';
import { createHash, createPublicKey, generateKeyPairSync, randomBytes, randomUUID, sign, type JsonWebKey } from 'node:crypto';
import { mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import {userInfo} from 'node:os';
import {acquireEnrollmentAnchorLock} from './enrollmentAnchorLock.js';
import {
  canonicalize,
  refreshActionDecisionAcknowledgement,
  validateActionDecisionAcknowledgementContract,
  verifyInitialServerSigningKeyset,
  verifyServerSigningKeysetUpdate,
  validateDeviceConfigContract,
  validateTrustedServerSigningKeysetContract,
  validateDeviceConnectionPreferenceContract,
  type DeviceConnectionPreference,
  type ActionDecisionAcknowledgement,
  type ProviderId,
  type ServerSigningKeysetVerificationResult,
  type TrustedServerSigningKeyset,
} from '@dharma-ai-labs/agent-fabric-contracts';
import { createSystemSecureStore, type SecureSecretStore } from '@dharma-ai-labs/agent-fabric-secure-store';
import {HostOperationFence, type HostOperationScope} from './hostOperationScope.js';
import {commitSigningRecoveryJournal,resumeSigningRecoveryJournal,type SigningRecoveryJournalIO} from './signingRecoveryJournal.js';
import {checkedRecoveryHostContext,retrieveSigningRecoveryDelivery,type RecoverExpiredDeviceSigningTrustInput} from './signingRecoveryClient.js';
import {planSigningRecovery} from './signingRecoveryPlan.js';
import {outsideDeviceSigningControl,withDeviceSigningControl} from './deviceSigningControl.js';
export {withDeviceSigningControl,withDeviceSigningLineSignal,type DeviceSigningControlLease} from './deviceSigningControl.js';
export {SigningRecoveryClientError,type SigningRecoveryClientPhase,type RecoverExpiredDeviceSigningTrustInput} from './signingRecoveryClient.js';
export {progressPreparedDeviceSigningRecoveryOffer,SigningRecoveryOfferClientError,
  type ProgressPreparedDeviceSigningRecoveryOfferInput,type SigningRecoveryOfferClientPhase} from './signingRecoveryOfferClient.js';
export {prepareOwnedSigningRecovery,submitOwnedSigningRecoveryPreparation,progressOwnedSigningRecoveryOffer,
  completeOwnedSigningRecovery,inspectOwnedSigningRecovery,disposeOwnedSigningRecovery,OwnedSigningRecoveryError,
  prepareOwnedSigningMaintenance,readOwnedSigningMaintenanceContext,type PrepareOwnedSigningMaintenanceInput,
  type PrepareOwnedSigningRecoveryInput,type OwnedSigningRecoveryHandle,type OwnedSigningRecoveryState} from './signingRecoveryHost.js';
export type {HostOperationScope} from './hostOperationScope.js';
export type { SecureSecretStore } from '@dharma-ai-labs/agent-fabric-secure-store';
export { claimSetupReference, setupClaimSourceRegistration, setupClaimFailureMessage, type ClaimSetupReferenceInput,
  type SetupClaimFailurePhase, type SetupClaimFailureReason, type SetupClaimFailureDiagnostic } from './setupClaim.js';
export {planDeviceSigningRecovery, type DeviceSigningRecoveryPlanInput, type DeviceSigningRecoverySourceSelection,
  type DeviceSigningRecoverySessionSelection, type DeviceSigningRecoveryHostBinding,
  planDeviceSigningMaintenance, type DeviceSigningMaintenancePlanInput, type DeviceTrustMaintenanceController} from './signingRecoveryPlan.js';

export interface DeviceConfig {
  schema: 'dharma.device-config/v1';
  hqUrl: string;
  organizationId: string;
  installationId?: string;
  deviceId: string;
  deviceName: string;
  platform: 'windows' | 'wsl' | 'macos' | 'linux';
  publicKeyEd25519: string;
  serverPublicKeyEd25519: string;
  serverSigningKeyset?: TrustedServerSigningKeyset;
  relayUrl: string;
  enrolledAt: string;
  /** Local unattended reconnection preference, never an authority grant. Absent means manual. */
  connectionMode?: 'manual' | 'resume';
  evidenceQuotaLedgerInitializedAt?: string;
  /** Public dispatch metadata only; server verifies exact signed device/source authority. */
  setupClaimReference?: string;
  setupClaimRepositoryFingerprint?: string;
}

interface PendingRequest {
  method: 'GET' | 'POST';
  pathname: string;
  body: string;
  headers: Record<string, string>;
}

/** One client's outbox in the shared protocol-state file. Only its owner signs, sends or writes it, with one
 * exception: another client sends the kept request of an orphaned entry (see orphanDue). */
interface OutboxEntry {
  sessionId: string | null;
  nextSequence: number;
  pending: PendingRequest | null;
  ownerPid: number;
  updatedAt: string;
  /** When another client last took this entry's kept request to send it, written before the send. With a kept request
   * left, it got no definite answer (or its sender stopped); without one, the owner, if it still runs, takes the outcome
   * from the file instead of sending the request again. */
  adoptedAt?: string;
  /** The definite answer that client got, so the owner returns it to a retry of the same call instead of signing the
   * call again. The owner's next write of its entry clears it. */
  adoptedOutcome?: AdoptedOutcome;
  /** Completions the server accepted whose receipts found no room in the recovered completion list when the owner
   * wrote them. Any client moves them to the list once it has room. Until then the entry stays like one with a kept
   * request, so a later write, a restart or another process never loses them. */
  keptCompletions?: RecoveredTaskCompletion[];
}

interface AdoptedOutcome {
  /** The message id the owner signed the request with. */
  messageId: string;
  /** 2xx when accepted, or a definitive 4xx refusal (see #sendPendingWithSigningControl). */
  status: number;
  response: Record<string, unknown>;
}

interface ProtocolState {
  schema: 'dharma.protocol-state/v1';
  /** In memory: this client's own session, sequence and kept request. In the file each client's own are in outboxes,
   * and these hold a copy of the oldest kept request, for a session open of an earlier version to replay (see
   * #persist). */
  sessionId: string | null;
  nextSequence: number;
  pending: PendingRequest | null;
  recoveredTaskCompletions?: RecoveredTaskCompletion[];
  /** Each client's outbox, by owner key: 'relay:<workspaceId>' for a workspace loop, 'cli:<pid>:<process>:<n>'
   * otherwise. */
  outboxes?: Record<string, OutboxEntry>;
}

/** The most kept requests in one file. Entries without one fill only the room that is left. */
const OUTBOX_ENTRIES_MAX = 256;
const IDLE_OUTBOX_ENTRIES_MAX = 32;
/** The most recovered task completions in one file. */
const RECOVERED_TASK_COMPLETIONS_MAX = 1_000;
/** An entry whose kept request stood unchanged this long is orphaned, and another client sends an orphaned request
 * that got no definite answer again only after this interval. */
const ORPHAN_RETRY_INTERVAL_MS = 10 * 60_000;
/** Orphans one hold of signing control sends, so another process that waits for the lock file waits for at most one
 * such send. While more are due, the client's next request sends the next one, in a section of its own. */
const ORPHAN_SENDS_PER_SECTION = 1;
/** Task leases held in this process, by client, until when they run unless extended. While one is held, no client of
 * this process sends an orphan after its own request, so a lease heartbeat never waits behind such a send. */
const taskLeases = new Map<object, number>();
function taskLeaseHeld(now: number): boolean {
  for (const [client, until] of taskLeases) if (until <= now) taskLeases.delete(client);
  return taskLeases.size > 0;
}
const OWNER_KEY_PATTERN = /^(?:relay|cli|migrated):[A-Za-z0-9_.:-]{1,128}$/;
/** Part of every default owner key, so a later process that gets the same pid never takes over an earlier entry. */
const PROCESS_INSTANCE = randomBytes(9).toString('base64url');
let clientInstances = 0;

// Several durable clients share one protocol-state file: one per relay workspace loop, plus ad hoc commands. Each
// read-modify-write of it runs inside one device signing-control section that starts by reloading the other clients'
// entries from the file. A section deactivates when its work settles, so a detached callback cannot write after it.
interface ProtocolStateSection { client: AgentFabricClient; active: boolean; }
const protocolStateSections = new AsyncLocalStorage<ProtocolStateSection>();

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface RecoveredTaskCompletion {
  taskId: string;
  trajectoryCapsuleHash: string;
  receiptHash: string;
  recoveredAt: string;
}

function isRecoveredTaskCompletion(value: unknown): value is RecoveredTaskCompletion {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return UUID_PATTERN.test(String(item.taskId || ''))
    && /^sha256:[a-f0-9]{64}$/.test(String(item.trajectoryCapsuleHash || ''))
    && /^sha256:[a-f0-9]{64}$/.test(String(item.receiptHash || ''))
    && Number.isFinite(Date.parse(String(item.recoveredAt || '')));
}

function isPendingRequest(value: unknown): value is PendingRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const pending = value as Record<string, unknown>;
  return (pending.method === 'POST' || pending.method === 'GET')
    && typeof pending.pathname === 'string' && pending.pathname.startsWith('/')
    && typeof pending.body === 'string'
    && pending.headers !== null && typeof pending.headers === 'object' && !Array.isArray(pending.headers)
    && Object.entries(pending.headers as Record<string, unknown>)
      .every(([name, header]) => name.length > 0 && typeof header === 'string');
}

const isInstant = (value: unknown) => typeof value === 'string' && Number.isFinite(Date.parse(value));

function isAdoptedOutcome(value: unknown): value is AdoptedOutcome {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const outcome = value as Record<string, unknown>;
  const status = Number(outcome.status);
  return typeof outcome.messageId === 'string' && outcome.messageId.length > 0 && Number.isSafeInteger(outcome.status)
    && ((status >= 200 && status < 300) || (status >= 400 && status < 500 && status !== 408 && status !== 429))
    && !!outcome.response && typeof outcome.response === 'object' && !Array.isArray(outcome.response);
}

function isOutboxEntry(value: unknown): value is OutboxEntry {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const entry = value as Record<string, unknown>;
  return (entry.sessionId === null || typeof entry.sessionId === 'string')
    && Number.isSafeInteger(entry.nextSequence) && Number(entry.nextSequence) >= 1
    && (entry.pending === null || isPendingRequest(entry.pending))
    && Number.isSafeInteger(entry.ownerPid) && Number(entry.ownerPid) >= 0
    && isInstant(entry.updatedAt) && (entry.adoptedAt === undefined || isInstant(entry.adoptedAt))
    && (entry.adoptedOutcome === undefined || (entry.adoptedAt !== undefined && isAdoptedOutcome(entry.adoptedOutcome)))
    && (entry.keptCompletions === undefined || (Array.isArray(entry.keptCompletions)
      && entry.keptCompletions.length <= RECOVERED_TASK_COMPLETIONS_MAX && entry.keptCompletions.every(isRecoveredTaskCompletion)));
}

function assertProtocolState(value: unknown): asserts value is ProtocolState {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Relay protocol state is invalid.');
  const state = value as Record<string, unknown>;
  const recovered = state.recoveredTaskCompletions;
  const outboxes = state.outboxes;
  if (state.schema !== 'dharma.protocol-state/v1'
    || !(state.sessionId === null || typeof state.sessionId === 'string')
    || !Number.isSafeInteger(state.nextSequence) || Number(state.nextSequence) < 1
    || !(state.pending === null || isPendingRequest(state.pending))
    || (outboxes !== undefined && (!outboxes || typeof outboxes !== 'object' || Array.isArray(outboxes)
      || Object.keys(outboxes).length > OUTBOX_ENTRIES_MAX
      || Object.entries(outboxes as Record<string, unknown>)
        .some(([owner, entry]) => !OWNER_KEY_PATTERN.test(owner) || !isOutboxEntry(entry))))
    || (recovered !== undefined && (!Array.isArray(recovered)
      || recovered.length > RECOVERED_TASK_COMPLETIONS_MAX
      || recovered.some((item) => !isRecoveredTaskCompletion(item))))) {
    throw new Error('Relay protocol state is invalid.');
  }
}

/** Every outbox entry of a file. The kept request of an earlier single-slot file becomes an orphan keyed by its
 * session, sent once by the next session open; a request that is always rebuilt is dropped as before. A top-level
 * request that is a copy of an entry's kept request (see #persist) is that entry's, not another orphan. So is one an
 * earlier version re-signed in place (a stale action acknowledgement gets a new message id, sequence and signature,
 * but keeps its session, path and idempotency key): it replaces the entry's request as the latest one signed. */
function outboxesOf(state: ProtocolState): Record<string, OutboxEntry> {
  const outboxes: Record<string, OutboxEntry> = {};
  for (const [owner, entry] of Object.entries(state.outboxes ?? {})) outboxes[owner] = durableOutboxEntry(entry);
  const pending = state.pending;
  const same = (kept: PendingRequest, name: string) => !!pending?.headers[name] && kept.headers[name] === pending.headers[name];
  let copied = false;
  for (const [owner, entry] of Object.entries(outboxes)) {
    if (!pending || !entry.pending) continue;
    copied = same(entry.pending, 'x-dharma-message-id');
    if (!copied && entry.pending.pathname === pending.pathname && same(entry.pending, 'idempotency-key')
      && same(entry.pending, 'x-dharma-session-id')) {
      outboxes[owner] = {...entry, pending, nextSequence: Math.max(entry.nextSequence, state.nextSequence)};
      copied = true;
    }
    if (copied) break;
  }
  if (pending && !copied && !isExplicitlyRebuiltPath(pending.pathname) && !isSessionOpen(pending)) {
    const session = pending.headers['x-dharma-session-id'] || state.sessionId || '';
    const key = `migrated:${/^[A-Za-z0-9_-]{1,128}$/.test(session) ? session : sha256(session).slice(0, 32)}`;
    outboxes[key] ??= {sessionId: session || null, nextSequence: state.nextSequence, pending, ownerPid: 0,
      updatedAt: new Date().toISOString()};
  }
  return outboxes;
}

/** Whether the process that wrote an outbox entry still runs. A migrated entry has no owner process. */
function ownerProcessAlive(pid: number): boolean {
  if (pid === process.pid) return true;
  if (!Number.isSafeInteger(pid) || pid < 1 || pid > 0x7fffffff) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
}

/** A request that is always rebuilt is never kept in the file, as before. */
function durableOutboxEntry(entry: OutboxEntry): OutboxEntry {
  return entry.pending && isExplicitlyRebuiltPath(entry.pending.pathname)
    ? {...entry, nextSequence: entry.nextSequence + 1, pending: null} : entry;
}

/** A kept session open matters only to its owner, whose next session open replaces it. Another client drops an
 * orphaned one without sending it, and a full file does not keep one. */
function isSessionOpen(pending: PendingRequest): boolean {
  return pending.method === 'POST' && pending.pathname.endsWith('/agent-fabric/sessions');
}

/** A kept request only its owner can use: a session open, a poll, whose answer hands work or content to the owner (a
 * task it claimed lapses with its lease), or a read. Another client drops an orphaned one without sending it, so such
 * an answer never reaches the file, and an earlier version is never handed one to replay. */
function isOwnerOnlyRequest(pending: PendingRequest): boolean {
  return pending.method === 'GET' || isSessionOpen(pending) || pending.pathname.endsWith('/poll');
}

/** Whether another client may send an entry's kept request now. It is orphaned once its owner process has exited,
 * or once it stood unchanged for ORPHAN_RETRY_INTERVAL_MS, since a pid can be reused or belong to another account. A
 * workspace loop's entry waits that long even after its process exited, so a loop that restarts promptly replays its
 * own request first. An orphan sent without a definite answer is due again after the same interval. */
function orphanDue(owner: string, entry: OutboxEntry, now: number): boolean {
  if (!entry.pending || recentlyAdopted(entry, now)) return false;
  return now - Date.parse(entry.updatedAt) >= ORPHAN_RETRY_INTERVAL_MS
    || (!owner.startsWith('relay:') && !ownerProcessAlive(entry.ownerPid));
}

/** Whether another client took the entry's kept request less than ORPHAN_RETRY_INTERVAL_MS ago. */
function recentlyAdopted(entry: OutboxEntry, now: number): boolean {
  return entry.adoptedAt !== undefined && now - Date.parse(entry.adoptedAt) < ORPHAN_RETRY_INTERVAL_MS;
}

export interface EnrollmentResult {
  verificationUri: string;
  browserCode: string;
  deviceCode: string;
  expiresInSeconds: number;
}

export interface BootstrapEnrollmentResult {
  ok: true;
  status: 'approved';
  organizationId: string;
  deviceId: string;
  relayUrl: string;
  serverPublicKeyEd25519: string;
  serverSigningKeyset?: TrustedServerSigningKeyset;
  organizationApiToken: string;
  organizationApiTokenScopes: string[];
  correlationId?: string;
}

export interface BootstrapRecipientApproval {
  url: string;
  expiresAt: string;
  fingerprint: string;
  repositoryFingerprint: string;
}

export interface RedeemBootstrapGrantInput {
  hqUrl: string;
  organizationId: string;
  bootstrapToken: string;
  name: string;
  platform: DeviceConfig['platform'];
  publicKeyEd25519: string;
  repositoryFingerprint: string;
  fetcher?: typeof fetch;
  onRecipientApprovalRequired?: (approval: BootstrapRecipientApproval) => Promise<void> | void;
  pollIntervalMs?: number;
  maximumWaitMs?: number;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
}

function sha256(value: string | Uint8Array) {
  return createHash('sha256').update(value).digest('hex');
}

export function normalizeHqUrl(value: string) {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error('HQ URL must be a valid URL.'); }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new Error('HQ URL must use HTTPS or exact loopback HTTP.');
  }
  if (url.username || url.password || url.search || url.hash || (url.pathname !== '/' && url.pathname !== '')) {
    throw new Error('HQ URL must be a credential-free origin.');
  }
  return url.origin;
}

export function normalizeRelayUrl(value: string) {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error('Relay URL must be a valid URL.'); }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'wss:' && !(url.protocol === 'ws:' && loopback)) {
    throw new Error('Relay URL must use WSS or exact loopback WS.');
  }
  if (url.username || url.password || url.search || url.hash) throw new Error('Relay URL must not contain credentials or query state.');
  url.pathname = '';
  return url.origin;
}

function assertInstallationId(installationId: string | undefined): void {
  if (installationId !== undefined && !UUID_PATTERN.test(installationId)) {
    throw new Error('Installation identity is invalid.');
  }
}

function accountFor(hqUrl: string, organizationId: string, installationId?: string) {
  assertInstallationId(installationId);
  const scope = installationId
    ? `${normalizeHqUrl(hqUrl)}:${organizationId}:${installationId}`
    : `${normalizeHqUrl(hqUrl)}:${organizationId}`;
  return `device-key-${sha256(scope).slice(0, 32)}`;
}

function evidenceQuotaAccountFor(hqUrl: string, organizationId: string, deviceId: string) {
  return `evidence-quota-${sha256(`${normalizeHqUrl(hqUrl)}:${organizationId}:${deviceId}`).slice(0, 32)}`;
}

function legacyEnrollmentAnchorAccountFor(hqUrl: string, organizationId: string) {
  return `device-enrollment-${sha256(`${normalizeHqUrl(hqUrl)}:${organizationId}`).slice(0, 32)}`;
}

function enrollmentAnchorAccountFor(hqUrl: string, organizationId: string, deviceId: string) {
  return `device-enrollment-${sha256(`${normalizeHqUrl(hqUrl)}:${organizationId}:${deviceId}`).slice(0, 32)}`;
}

function organizationApiTokenAccountFor(hqUrl: string, organizationId: string, installationId?: string) {
  assertInstallationId(installationId);
  const scope = installationId
    ? `${normalizeHqUrl(hqUrl)}:${organizationId}:${installationId}`
    : `${normalizeHqUrl(hqUrl)}:${organizationId}`;
  return `organization-api-${sha256(scope).slice(0, 32)}`;
}

async function protectedStore(store: SecureSecretStore | undefined, scope?: HostOperationScope): Promise<SecureSecretStore> {
  if (scope === undefined) return store ?? await createSystemSecureStore();
  const fence = new HostOperationFence(scope);
  const raw = await fence.step(async () => store ?? await createSystemSecureStore());
  return fence.store(raw);
}

function parseProtectedAnchor<T>(serialized: string, scope: HostOperationScope | undefined, message: string): T {
  try {
    const parsed = JSON.parse(serialized) as T;
    if (scope && (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))) throw new Error();
    return parsed;
  } catch (error) {
    if (scope) throw new Error(message);
    throw error;
  }
}

export async function saveOrganizationApiToken(input: {
  hqUrl: string;
  organizationId: string;
  installationId?: string;
  token: string;
  store?: SecureSecretStore;
  hostScope?: HostOperationScope;
}): Promise<void> {
  const {hqUrl, organizationId, installationId, token, store: suppliedStore, hostScope} = input;
  if (!/^dharma_org_[A-Za-z0-9_-]{40,120}$/.test(token)) {
    throw new Error('Organization API token is invalid.');
  }
  const account = organizationApiTokenAccountFor(hqUrl, organizationId, installationId);
  const store = await protectedStore(suppliedStore, hostScope);
  await store.put(account, token);
  if (await store.get(account) !== token) throw new Error('Secure store did not confirm the organization API token write.');
}

export async function loadOrganizationApiToken(input: {
  hqUrl: string;
  organizationId: string;
  installationId?: string;
  store?: SecureSecretStore;
  hostScope?: HostOperationScope;
}): Promise<string | null> {
  const account = organizationApiTokenAccountFor(input.hqUrl, input.organizationId, input.installationId);
  const store = await protectedStore(input.store, input.hostScope);
  const token = await store.get(account);
  if (token && !/^dharma_org_[A-Za-z0-9_-]{40,120}$/.test(token)) {
    throw new Error('Organization API token in the secure store is corrupt.');
  }
  return token;
}

function activeSkillAnchorAccountFor(
  config: Pick<DeviceConfig, 'hqUrl' | 'organizationId' | 'deviceId'>,
  workspaceId: string,
  provider: ProviderId,
) {
  return `active-skill-${sha256([
    normalizeHqUrl(config.hqUrl), config.organizationId, config.deviceId, workspaceId, provider,
  ].join(':')).slice(0, 32)}`;
}

export interface DeviceEnrollmentAnchor {
  schema: 'dharma.device-enrollment-anchor/v1';
  hqUrl: string;
  organizationId: string;
  deviceId: string;
  devicePublicKeyEd25519: string;
  serverPublicKeyEd25519: string;
  serverSigningKeyset?: TrustedServerSigningKeyset;
  enrolledAt: string;
}

function enrollmentAnchorFromConfig(config: DeviceConfig): DeviceEnrollmentAnchor {
  return {
    schema: 'dharma.device-enrollment-anchor/v1',
    hqUrl: normalizeHqUrl(config.hqUrl),
    organizationId: config.organizationId,
    deviceId: config.deviceId,
    devicePublicKeyEd25519: config.publicKeyEd25519,
    serverPublicKeyEd25519: config.serverPublicKeyEd25519,
    ...(config.serverSigningKeyset ? { serverSigningKeyset: config.serverSigningKeyset } : {}),
    enrolledAt: config.enrolledAt,
  };
}

function enrollmentAnchorHasBaseIdentity(anchor: DeviceEnrollmentAnchor, config: DeviceConfig): boolean {
  return anchor.schema === 'dharma.device-enrollment-anchor/v1'
    && anchor.hqUrl === normalizeHqUrl(config.hqUrl)
    && anchor.organizationId === config.organizationId
    && anchor.deviceId === config.deviceId
    && anchor.devicePublicKeyEd25519 === config.publicKeyEd25519
    && anchor.serverPublicKeyEd25519 === config.serverPublicKeyEd25519
    && anchor.enrolledAt === config.enrolledAt
    && Number.isFinite(Date.parse(anchor.enrolledAt));
}

export interface ActiveSkillAuthorizationAnchor {
  schema: 'dharma.active-skill-authorization-anchor/v1';
  organizationId: string;
  deviceId: string;
  organizationAgentId: string;
  workspaceId: string;
  provider: ProviderId;
  bundleId: string;
  receiptHash: string;
  activatedAt: string;
  expiresAt: string | null;
}

// The namespace follows the OS user and protected legacy account, rather than
// DHARMA_HOME/configPath. Different configured homes share the same anchor lock.
async function withEnrollmentAnchorLock<T>(config: DeviceConfig, fence: HostOperationFence | undefined,
  operation: () => Promise<T>): Promise<T> {
  const hostScope=fence?{signal:fence.signal,current:async()=>{await fence.assert();return true;}}:undefined;
  return withDeviceSigningControl({config,hostScope},()=>withEnrollmentAnchorLockUnderControl(config,fence,operation));
}

async function withEnrollmentAnchorLockUnderControl<T>(config: DeviceConfig, fence: HostOperationFence | undefined,
  operation: () => Promise<T>): Promise<T> {
  const identity = userInfo();
  const user = createHash('sha256').update(identity.homedir + ':' + identity.username).digest('hex').slice(0, 32);
  const account = legacyEnrollmentAnchorAccountFor(config.hqUrl, config.organizationId);
  // Use a stable OS-user path even when callers override HOME, TMPDIR or DHARMA_HOME.
  const temporaryRoot = process.platform === 'win32' ? resolve(identity.homedir, 'AppData', 'Local', 'Temp') : '/tmp';
  const path = resolve(temporaryRoot, `dharma-enrollment-locks-${user}`, `${account}.lock`);
  let release: (() => Promise<void>) | undefined;
  try {
    release = await acquireEnrollmentAnchorLock(path, fence);
    return fence ? await fence.step(operation) : await operation();
  } finally {await release?.();}
}

async function freshAnchorValue(store: SecureSecretStore, account: string): Promise<string | null> {
  return (store.getFresh ?? store.get).call(store, account);
}

async function writeEnrollmentAnchor(store: SecureSecretStore, config: DeviceConfig, secret: string,
  expectedCurrent: string | null, expectedLegacy: string | null): Promise<void> {
  const account = enrollmentAnchorAccountFor(config.hqUrl, config.organizationId, config.deviceId);
  if (store.backend === 'windows-credential-manager') {
    if (!store.compareAndPutEnrollmentAnchor) throw Error('connection_anchor_store_unavailable');
    const written = await store.compareAndPutEnrollmentAnchor({account, secret, expectedCurrent, expectedLegacy,
      legacyAccount: legacyEnrollmentAnchorAccountFor(config.hqUrl, config.organizationId)});
    if (!written) throw Error('connection_existing_anchor_requires_recovery');
  } else {await store.put(account, secret);}
}

// Both callers already hold the OS-user enrollment lock. Windows additionally
// performs current+legacy comparison in the existing shared vault helper.
function signingRecoveryJournalIO(input:{configPath:string;config:DeviceConfig;store:SecureSecretStore;
  fence:HostOperationFence;clock:()=>number}):SigningRecoveryJournalIO{
  const {configPath,config,store,fence,clock}=input;
  const account=enrollmentAnchorAccountFor(config.hqUrl,config.organizationId,config.deviceId);
  const legacy=legacyEnrollmentAnchorAccountFor(config.hqUrl,config.organizationId);
  return {fence,now:clock,readConfig:()=>loadDeviceConfig(configPath),
    readAnchors:async()=>({current:await freshAnchorValue(store,account),legacy:await freshAnchorValue(store,legacy)}),
    compareAndPutAnchor:async({expectedCurrent,expectedLegacy,secret})=>{
      if(store.backend!=='windows-credential-manager'
        &&(await freshAnchorValue(store,account)!==expectedCurrent||await freshAnchorValue(store,legacy)!==expectedLegacy))return false;
      await writeEnrollmentAnchor(store,config,secret,expectedCurrent,expectedLegacy);return true;
    },writeConfig:next=>atomicJson(configPath,next,fence)};
}

/** Typed owning-host phase completion only, not a CLI/MCP command. The matching
 * approval handshake and ephemeral key stay in that host's native memory.
 * This never creates/replaces a device, grants access or retries a failed run. */
export async function recoverExpiredDeviceSigningTrust(input:RecoverExpiredDeviceSigningTrustInput){
  return retrieveSigningRecoveryDelivery(input,async accepted=>{
    const fence=new HostOperationFence(input.hostScope),clock=input.now??Date.now;
    const raw=await fence.step(async()=>input.store??await createSystemSecureStore()),store=fence.store(raw);
    const config=await fence.step(()=>loadDeviceConfig(input.configPath));
    return withEnrollmentAnchorLock(config,fence,async()=>{
      // Waiting for another writer never preserves a stale source/session plan.
      const plan=await planSigningRecovery({...input,store});
      const current=checkedRecoveryHostContext({...input,challenge:accepted.challenge},plan,clock());
      if(canonicalize(current.expected)!==canonicalize(accepted.expected))throw Error('signing_recovery_local_context_changed');
      return commitSigningRecoveryJournal({io:signingRecoveryJournalIO({configPath:input.configPath,config,store,fence,clock}),
        challenge:current.challenge,expected:current.expected,candidate:accepted.candidate});
    });
  });
}

/** Missing-anchor recovery must prove both current and historical slots absent. */
export async function assertDeviceEnrollmentAnchorAbsent(input: {
  config: DeviceConfig;
  store?: SecureSecretStore;
  hostScope?: HostOperationScope;
}): Promise<void> {
  const config = input.config;
  let values: Array<string | null>;
  try {
    const store = await protectedStore(input.store, input.hostScope);
    const get = (account: string) => store.getFresh ? store.getFresh(account) : store.get(account);
    values = await Promise.all([
      get(enrollmentAnchorAccountFor(config.hqUrl, config.organizationId, config.deviceId)),
      get(legacyEnrollmentAnchorAccountFor(config.hqUrl, config.organizationId)),
    ]);
  } catch {throw new Error('connection_anchor_store_unavailable');}
  if (values.some(value => value !== null)) throw new Error('connection_existing_anchor_requires_recovery');
}

export async function saveDeviceEnrollmentAnchor(input: {
  config: DeviceConfig;
  store?: SecureSecretStore;
  hostScope?: HostOperationScope;
  requireAbsent?: boolean;
  now?: Date;
}): Promise<DeviceEnrollmentAnchor> {
  const config = structuredClone(input.config);
  const fence = input.hostScope ? new HostOperationFence(input.hostScope) : undefined;
  return withEnrollmentAnchorLock(config, fence, () => saveEnrollmentAnchorLocked({...input, config}));
}

async function saveEnrollmentAnchorLocked(input: {
  config: DeviceConfig; store?: SecureSecretStore; hostScope?: HostOperationScope; requireAbsent?: boolean; now?: Date;
}): Promise<DeviceEnrollmentAnchor> {
  const anchor = enrollmentAnchorFromConfig(input.config);
  const serialized = JSON.stringify(anchor);
  const account = enrollmentAnchorAccountFor(anchor.hqUrl, anchor.organizationId, anchor.deviceId);
  const store = await protectedStore(input.store, input.hostScope);
  let previous: string | null, legacy: string | null;
  try {
    previous = await freshAnchorValue(store, account);
    legacy = input.requireAbsent || store.backend === 'windows-credential-manager'
      ? await freshAnchorValue(store, legacyEnrollmentAnchorAccountFor(anchor.hqUrl, anchor.organizationId)) : null;
  } catch (error) {
    if (input.requireAbsent) throw Error('connection_anchor_store_unavailable');
    throw error;
  }
  if (input.requireAbsent) {
    if (previous !== null || legacy !== null) throw Error('connection_existing_anchor_requires_recovery');
  } else {
    if (previous !== null) {
      const existing = parseProtectedAnchor<DeviceEnrollmentAnchor>(previous, input.hostScope, 'Protected enrollment anchor is corrupt.');
      if (!enrollmentAnchorHasBaseIdentity(existing, input.config)) {
        throw new Error('connection_existing_anchor_requires_recovery');
      }
      if (canonicalize(existing.serverSigningKeyset ?? null) !== canonicalize(anchor.serverSigningKeyset ?? null)) {
        if (!anchor.serverSigningKeyset
          || !verifyKeysetTransition(input.config, existing.serverSigningKeyset, anchor.serverSigningKeyset, input.now ?? new Date()).ok) {
          throw new Error('connection_existing_anchor_requires_recovery');
        }
      }
    }
  }
  await writeEnrollmentAnchor(store, input.config, serialized, previous, legacy);
  if (await freshAnchorValue(store, account) !== serialized) throw new Error('Secure store did not confirm the enrollment anchor write.');
  return anchor;
}

export async function loadDeviceEnrollmentAnchor(input: {
  config: DeviceConfig;
  store?: SecureSecretStore;
  hostScope?: HostOperationScope;
  /** Validate a legacy anchor in place; do not migrate it during a read-only operation. */
  readOnly?: boolean;
}): Promise<DeviceEnrollmentAnchor> {
  if (input.readOnly) return loadEnrollmentAnchorLocked(input);
  const config = structuredClone(input.config);
  const fence = input.hostScope ? new HostOperationFence(input.hostScope) : undefined;
  return withEnrollmentAnchorLock(config, fence, () => loadEnrollmentAnchorLocked({...input, config}));
}

async function loadEnrollmentAnchorLocked(input: {
  config: DeviceConfig; store?: SecureSecretStore; hostScope?: HostOperationScope; readOnly?: boolean;
}): Promise<DeviceEnrollmentAnchor> {
  const {hostScope, store: suppliedStore} = input;
  const config = hostScope ? structuredClone(input.config) : input.config;
  const account = enrollmentAnchorAccountFor(
    config.hqUrl,
    config.organizationId,
    config.deviceId,
  );
  const store = await protectedStore(suppliedStore, hostScope);
  let serialized = await freshAnchorValue(store, account);
  let migratedLegacy = false;
  if (serialized === null) {
    serialized = await freshAnchorValue(store, legacyEnrollmentAnchorAccountFor(config.hqUrl, config.organizationId));
    migratedLegacy = serialized !== null;
  }
  if (!serialized) throw new Error('Device enrollment is not anchored in secure storage. Run dharma login again.');
  const anchor = parseProtectedAnchor<DeviceEnrollmentAnchor>(serialized, hostScope, 'Protected enrollment anchor is corrupt.');
  if (!enrollmentAnchorHasBaseIdentity(anchor, config)
    || JSON.stringify(anchor.serverSigningKeyset ?? null) !== JSON.stringify(config.serverSigningKeyset ?? null)
  ) {
    throw new Error('Device configuration does not match the secure enrollment anchor. Run dharma login again.');
  }
  if (migratedLegacy && !input.readOnly) {
    await writeEnrollmentAnchor(store, config, serialized, null, serialized);
    if (await freshAnchorValue(store, account) !== serialized) throw new Error('Secure store did not confirm the enrollment anchor migration.');
  }
  return anchor;
}

export async function saveActiveSkillAuthorizationAnchor(input: {
  config: Pick<DeviceConfig, 'hqUrl' | 'organizationId' | 'deviceId'>;
  workspaceId: string;
  organizationAgentId: string;
  provider: ProviderId;
  bundleId: string;
  receiptHash: string;
  activatedAt: string;
  expiresAt: string | null;
  store?: SecureSecretStore;
  hostScope?: HostOperationScope;
}): Promise<ActiveSkillAuthorizationAnchor> {
  if (!/^[0-9a-f-]{36}$/i.test(input.organizationAgentId)
    || !/^[0-9a-f-]{36}$/i.test(input.bundleId) || !/^sha256:[a-f0-9]{64}$/i.test(input.receiptHash)
    || !Number.isFinite(Date.parse(input.activatedAt))
    || (input.expiresAt !== null && !Number.isFinite(Date.parse(input.expiresAt)))) {
    throw new Error('Active skill authorization anchor is invalid.');
  }
  const anchor: ActiveSkillAuthorizationAnchor = {
    schema: 'dharma.active-skill-authorization-anchor/v1',
    organizationId: input.config.organizationId,
    deviceId: input.config.deviceId,
    organizationAgentId: input.organizationAgentId,
    workspaceId: input.workspaceId,
    provider: input.provider,
    bundleId: input.bundleId,
    receiptHash: input.receiptHash,
    activatedAt: input.activatedAt,
    expiresAt: input.expiresAt,
  };
  const serialized = JSON.stringify(anchor);
  const account = activeSkillAnchorAccountFor(input.config, input.workspaceId, input.provider);
  const store = await protectedStore(input.store, input.hostScope);
  await store.put(account, serialized);
  if (await store.get(account) !== serialized) throw new Error('Secure store did not confirm the active skill anchor write.');
  return anchor;
}

export async function loadActiveSkillAuthorizationAnchor(input: {
  config: Pick<DeviceConfig, 'hqUrl' | 'organizationId' | 'deviceId'>;
  workspaceId: string;
  organizationAgentId: string;
  provider: ProviderId;
  fresh?: boolean;
  store?: SecureSecretStore;
  hostScope?: HostOperationScope;
}): Promise<ActiveSkillAuthorizationAnchor | null> {
  const {workspaceId, organizationAgentId, provider, fresh, hostScope, store: suppliedStore} = input;
  const config = {...input.config};
  const account = activeSkillAnchorAccountFor(config, workspaceId, provider);
  const store = await protectedStore(suppliedStore, hostScope);
  const serialized = fresh && store.getFresh
    ? await store.getFresh(account)
    : await store.get(account);
  if (!serialized) return null;
  const anchor = parseProtectedAnchor<ActiveSkillAuthorizationAnchor>(serialized, hostScope, 'Protected active skill authorization anchor is corrupt.');
  if (anchor.schema !== 'dharma.active-skill-authorization-anchor/v1'
    || anchor.organizationId !== config.organizationId || anchor.deviceId !== config.deviceId
    || anchor.organizationAgentId !== organizationAgentId
    || !/^[0-9a-f-]{36}$/i.test(anchor.organizationAgentId)
    || anchor.workspaceId !== workspaceId || anchor.provider !== provider
    || !/^[0-9a-f-]{36}$/i.test(anchor.bundleId) || !/^sha256:[a-f0-9]{64}$/i.test(anchor.receiptHash)
    || !Number.isFinite(Date.parse(anchor.activatedAt))
    || (anchor.expiresAt !== null && !Number.isFinite(Date.parse(anchor.expiresAt)))) {
    throw new Error('Protected active skill authorization anchor is corrupt.');
  }
  return anchor;
}

export async function deleteActiveSkillAuthorizationAnchor(input: {
  config: Pick<DeviceConfig, 'hqUrl' | 'organizationId' | 'deviceId'>;
  workspaceId: string;
  provider: ProviderId;
  store?: SecureSecretStore;
  hostScope?: HostOperationScope;
}): Promise<void> {
  const account = activeSkillAnchorAccountFor(input.config, input.workspaceId, input.provider);
  const store = await protectedStore(input.store, input.hostScope);
  await store.delete(account);
  if (await store.get(account) !== null) throw new Error('Secure store did not confirm the active skill anchor deletion.');
}

export interface EvidenceQuotaAnchor {
  schema: 'dharma.evidence-quota-anchor/v1';
  day: string;
  totalBytes: number;
  ledgerHash: string;
  updatedAt: string;
}

export async function loadEvidenceQuotaAnchor(input: {
  config: Pick<DeviceConfig, 'hqUrl' | 'organizationId' | 'deviceId'>;
  store?: SecureSecretStore;
  hostScope?: HostOperationScope;
}): Promise<EvidenceQuotaAnchor | null> {
  const {hostScope, store: suppliedStore} = input;
  const account = evidenceQuotaAccountFor(
    input.config.hqUrl, input.config.organizationId, input.config.deviceId,
  );
  const store = await protectedStore(suppliedStore, hostScope);
  const value = await store.get(account);
  if (!value) return null;
  const anchor = parseProtectedAnchor<EvidenceQuotaAnchor>(value, hostScope, 'Protected evidence quota anchor is corrupt.');
  if (anchor.schema !== 'dharma.evidence-quota-anchor/v1'
    || !/^\d{4}-\d{2}-\d{2}$/.test(anchor.day)
    || !Number.isSafeInteger(anchor.totalBytes) || anchor.totalBytes < 0
    || !/^[a-f0-9]{64}$/.test(anchor.ledgerHash)
    || !Number.isFinite(Date.parse(anchor.updatedAt))) {
    throw new Error('Protected evidence quota anchor is corrupt.');
  }
  return anchor;
}

export async function saveEvidenceQuotaAnchor(input: {
  config: Pick<DeviceConfig, 'hqUrl' | 'organizationId' | 'deviceId'>;
  anchor: EvidenceQuotaAnchor;
  store?: SecureSecretStore;
  hostScope?: HostOperationScope;
}): Promise<void> {
  const account = evidenceQuotaAccountFor(
    input.config.hqUrl, input.config.organizationId, input.config.deviceId,
  );
  const serialized = JSON.stringify(input.anchor);
  const store = await protectedStore(input.store, input.hostScope);
  await store.put(account, serialized);
  const confirmed = await store.get(account);
  if (confirmed !== serialized) {
    throw new Error('Secure store did not confirm the evidence quota anchor write.');
  }
}

async function atomicJson(path: string, value: unknown, fence?: HostOperationFence) {
  if (fence) {
    await fence.step(() => mkdir(dirname(path), {recursive: true, mode: 0o700}));
    const temporary = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    let owned = false;
    try {
      await fence.assert(); handle = await open(temporary, 'wx', 0o600); owned = true; await fence.assert();
      await fence.step(() => handle!.writeFile(`${JSON.stringify(value, null, 2)}\n`));
      await fence.step(() => handle!.sync());
      await handle.close(); handle = undefined;
      await fence.step(() => rename(temporary, path));
      let directory: Awaited<ReturnType<typeof open>> | undefined;
      try {
        await fence.assert(); directory = await open(dirname(path), 'r'); await fence.assert();
        await fence.step(() => directory!.sync());
      } catch {
        // Unsupported directory fsync is not permission to swallow withdrawal.
        await fence.assert();
      } finally {await directory?.close();}
    } finally {
      await handle?.close();
      // Cleanup only this successfully created, random temporary. Never undo a
      // committed state rename or remove another actor's file after withdrawal.
      if (owned) await rm(temporary, {force: true});
    }
    return;
  }
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  const handle = await open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, path);
  try {
    const directory = await open(dirname(path), 'r');
    try { await directory.sync(); } finally { await directory.close(); }
  } catch {
    // Directory fsync is unavailable on some supported hosts.
  }
}

async function scopedResponseJson(response: Response, fence: HostOperationFence): Promise<Record<string, unknown>> {
  const invalid = () => new Error('relay_host_transport_response_invalid');
  if (!response.body || Number(response.headers.get('content-length')) > 5_000_000) throw invalid();
  await fence.assert();
  const reader = response.body.getReader();
  const cancel = () => {void reader.cancel().catch(() => undefined);};
  fence.signal.addEventListener('abort', cancel, {once: true});
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    await fence.assert();
    while (true) {
      const next = await fence.step(() => reader.read());
      if (next.done) break;
      size += next.value.byteLength;
      if (size > 5_000_000) throw invalid();
      chunks.push(next.value);
    }
    await fence.assert();
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw invalid();
    return parsed as Record<string, unknown>;
  } catch {
    await fence.assert(); throw invalid();
  } finally {
    fence.signal.removeEventListener('abort', cancel);
    await reader.cancel().catch(() => undefined); reader.releaseLock();
  }
}

function errorMessage(body: unknown, status: number) {
  if (body && typeof body === 'object') {
    const record = body as { error?: { code?: string; message?: string } };
    if (record.error?.message) return `${record.error.code || 'request_failed'}: ${record.error.message}`;
  }
  return `Dharma HQ request failed with HTTP ${status}.`;
}

export class AgentFabricRequestError extends Error {
  readonly status: number;
  readonly definitive: boolean;
  /** The server's error code, kept only in the stable form diagnostics may record. The message stays free text. */
  readonly serverCode?: string;

  constructor(body: unknown, status: number, definitive: boolean) {
    super(errorMessage(body, status));
    this.name = 'AgentFabricRequestError';
    this.status = status;
    this.definitive = definitive;
    const code = body && typeof body === 'object' ? (body as { error?: { code?: unknown } }).error?.code : undefined;
    if (typeof code === 'string' && /^[a-z0-9_]{1,80}$/.test(code)) this.serverCode = code;
  }
}

export function isDefinitiveAgentFabricRejection(error: unknown): boolean {
  return error instanceof AgentFabricRequestError && error.definitive;
}

export async function loadOrCreateDeviceIdentity(input: {
  hqUrl: string;
  organizationId: string;
  installationId?: string;
  store?: SecureSecretStore;
}) {
  const store = input.store ?? await createSystemSecureStore();
  const account = accountFor(input.hqUrl, input.organizationId, input.installationId);
  const current = await store.get(account);
  let privateJwk: JsonWebKey;
  if (current) {
    privateJwk = JSON.parse(current) as JsonWebKey;
  } else {
    const pair = generateKeyPairSync('ed25519');
    privateJwk = pair.privateKey.export({ format: 'jwk' });
    await store.put(account, JSON.stringify(privateJwk));
    if (!await store.get(account)) throw new Error('Secure store did not confirm the device identity write.');
  }
  if (privateJwk.kty !== 'OKP' || privateJwk.crv !== 'Ed25519' || !privateJwk.x || !privateJwk.d) {
    throw new Error('Stored device identity is corrupt.');
  }
  return { account, privateJwk, publicKeyEd25519: privateJwk.x };
}

async function existingHostDeviceIdentity(config: DeviceConfig, store: SecureSecretStore) {
  const account = accountFor(config.hqUrl, config.organizationId, config.installationId);
  const current = await store.get(account);
  const unavailable = () => new Error('relay_host_device_identity_unavailable');
  if (!current) throw unavailable();
  try {
    const privateJwk = JSON.parse(current) as JsonWebKey;
    if (privateJwk.kty !== 'OKP' || privateJwk.crv !== 'Ed25519'
      || !/^[A-Za-z0-9_-]{43}$/.test(privateJwk.x ?? '') || !/^[A-Za-z0-9_-]{43}$/.test(privateJwk.d ?? '')) throw unavailable();
    return {account, privateJwk, publicKeyEd25519: privateJwk.x!};
  } catch {throw unavailable();}
}

/** Read the accepted identity; never repair a missing key by generating one. */
export async function loadDeviceIdentity(input: {config: DeviceConfig; store?: SecureSecretStore;
  hostScope?: HostOperationScope}) {
  const config = {...input.config};
  const store = await protectedStore(input.store, input.hostScope);
  const identity = await existingHostDeviceIdentity(config, store);
  if (identity.publicKeyEd25519 !== config.publicKeyEd25519) throw new Error('relay_host_device_identity_unavailable');
  return identity;
}

export async function beginEnrollment(input: {
  hqUrl: string;
  organizationId: string;
  name: string;
  platform: DeviceConfig['platform'];
  publicKeyEd25519: string;
  idempotencyKey?: string;
  fetcher?: typeof fetch;
}): Promise<EnrollmentResult> {
  const response = await (input.fetcher || fetch)(`${normalizeHqUrl(input.hqUrl)}/api/v1/agent-fabric/enrollments`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': input.idempotencyKey || randomUUID() },
    body: JSON.stringify({ organizationId: input.organizationId, name: input.name, platform: input.platform, publicKeyEd25519: input.publicKeyEd25519 }),
  });
  const body = await response.json() as EnrollmentResult & { error?: unknown };
  if (!response.ok) throw new Error(errorMessage(body, response.status));
  return body;
}

function parseBootstrapRecipientApproval(
  body: unknown,
  input: Pick<RedeemBootstrapGrantInput, 'hqUrl' | 'organizationId' | 'bootstrapToken' | 'publicKeyEd25519' | 'repositoryFingerprint'>,
): BootstrapRecipientApproval | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const record = body as Record<string, unknown>;
  const error = record.error && typeof record.error === 'object' && !Array.isArray(record.error)
    ? record.error as Record<string, unknown>
    : null;
  const approval = record.approval && typeof record.approval === 'object' && !Array.isArray(record.approval)
    ? record.approval as Record<string, unknown>
    : null;
  if (record.ok !== false || record.status !== 'recipient_approval_required'
    || record.organizationId !== input.organizationId
    || error?.code !== 'bootstrap_recipient_approval_required' || error.retryable !== true
    || typeof approval?.url !== 'string' || typeof approval.expiresAt !== 'string'
    || !/^sha256:[a-f0-9]{64}$/.test(String(approval.fingerprint || ''))) return null;

  let approvalUrl: URL;
  let destination: URL;
  try {
    const hqOrigin = normalizeHqUrl(input.hqUrl);
    approvalUrl = new URL(approval.url);
    if (approvalUrl.origin !== hqOrigin || approvalUrl.pathname !== '/login'
      || approvalUrl.username || approvalUrl.password
      || [...approvalUrl.searchParams.keys()].some(key => key !== 'redirect_url')
      || approvalUrl.searchParams.getAll('redirect_url').length !== 1 || approvalUrl.hash) return null;
    destination = new URL(approvalUrl.searchParams.get('redirect_url')!, hqOrigin);
    if (destination.origin !== hqOrigin
      || destination.pathname !== '/portal/agent-fabric/bootstrap-approval'
      || destination.username || destination.password || destination.search) return null;
  } catch {
    return null;
  }
  const fragment = new URLSearchParams(destination.hash.slice(1));
  const hasRepositoryFingerprint = Boolean(input.repositoryFingerprint);
  if (fragment.get('organizationId') !== input.organizationId
    || fragment.get('publicKeyEd25519') !== input.publicKeyEd25519
    || (hasRepositoryFingerprint && fragment.get('repositoryFingerprint') !== input.repositoryFingerprint)
    || (!hasRepositoryFingerprint && fragment.has('repositoryFingerprint'))
    || !/^[a-f0-9]{64}$/.test(fragment.get('bootstrapTokenHash') || '')
    || (hasRepositoryFingerprint && !/^sha256:[a-f0-9]{64}$/.test(fragment.get('repositoryFingerprint') || ''))
    || ['organizationId', 'publicKeyEd25519', 'bootstrapTokenHash', ...(hasRepositoryFingerprint ? ['repositoryFingerprint'] : [])]
      .some(key => fragment.getAll(key).length !== 1)
    || [...fragment.keys()].some(key => !['organizationId', 'publicKeyEd25519', 'bootstrapTokenHash', 'repositoryFingerprint'].includes(key))) {
    return null;
  }
  let decodedUrl = approvalUrl.toString();
  try { decodedUrl = decodeURIComponent(decodedUrl); } catch {}
  if (approvalUrl.toString().includes(input.bootstrapToken) || decodedUrl.includes(input.bootstrapToken)) return null;
  return {
    url: approvalUrl.toString(),
    expiresAt: approval.expiresAt,
    fingerprint: String(approval.fingerprint),
    repositoryFingerprint: input.repositoryFingerprint,
  };
}

export async function redeemBootstrapGrant(input: RedeemBootstrapGrantInput): Promise<BootstrapEnrollmentResult> {
  const hqUrl = normalizeHqUrl(input.hqUrl);
  const endpoint = `${hqUrl}/api/v1/agent-fabric/bootstrap`;
  const requestBody = JSON.stringify({
    organizationId: input.organizationId,
    bootstrapToken: input.bootstrapToken,
    name: input.name,
    platform: input.platform,
    publicKeyEd25519: input.publicKeyEd25519,
    repositoryFingerprint: input.repositoryFingerprint,
  });
  const fetcher = input.fetcher || fetch;
  const now = input.now || Date.now;
  const sleep = input.sleep || ((milliseconds: number) => new Promise<void>(accept => setTimeout(accept, milliseconds)));
  const pollIntervalMs = Math.min(Math.max(input.pollIntervalMs ?? 2_000, 250), 10_000);
  const maximumWaitMs = Math.min(Math.max(input.maximumWaitMs ?? 15 * 60_000, 1_000), 15 * 60_000);
  const startedAt = now();
  let pending: BootstrapRecipientApproval | null = null;
  let deadline = startedAt + maximumWaitMs;

  while (true) {
    const response = await fetcher(endpoint, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: requestBody,
    });
    let body: unknown;
    try { body = await response.json(); }
    catch { throw new Error(`Bootstrap response was not valid JSON (HTTP ${response.status}).`); }
    if (response.ok) {
      const approved = body as BootstrapEnrollmentResult;
      if (approved.status !== 'approved' || approved.organizationId !== input.organizationId
        || !approved.deviceId || !approved.relayUrl || !approved.serverPublicKeyEd25519
        || !approved.organizationApiToken) {
        throw new Error('Bootstrap response did not contain a complete enrollment.');
      }
      return approved;
    }

    const approval = response.status === 409 ? parseBootstrapRecipientApproval(body, input) : null;
    if (!approval || !input.onRecipientApprovalRequired) {
      throw new Error(errorMessage(body, response.status));
    }
    const serverDeadline = Date.parse(approval.expiresAt);
    if (!Number.isFinite(serverDeadline) || serverDeadline <= now()) {
      throw new Error('Bootstrap recipient approval deadline is invalid or expired.');
    }
    if (!pending) {
      pending = approval;
      deadline = Math.min(serverDeadline, startedAt + maximumWaitMs);
      await input.onRecipientApprovalRequired(approval);
    } else if (approval.url !== pending.url || approval.expiresAt !== pending.expiresAt
      || approval.fingerprint !== pending.fingerprint) {
      throw new Error('Bootstrap recipient approval context changed while polling.');
    }
    const remaining = deadline - now();
    if (remaining <= 0) throw new Error('Bootstrap recipient approval timed out.');
    await sleep(Math.min(pollIntervalMs, remaining));
  }
}

export async function pollEnrollment(input: {
  hqUrl: string;
  deviceCode: string;
  fetcher?: typeof fetch;
}): Promise<Record<string, unknown>> {
  const response = await (input.fetcher || fetch)(`${normalizeHqUrl(input.hqUrl)}/api/v1/agent-fabric/enrollments/${encodeURIComponent(input.deviceCode)}`);
  const body = await response.json() as Record<string, unknown>;
  if (!response.ok) throw new Error(errorMessage(body, response.status));
  return body;
}

export async function saveDeviceConfig(path: string, config: DeviceConfig, hostScope?: HostOperationScope) {
  const fence = hostScope === undefined ? undefined : new HostOperationFence(hostScope);
  await atomicJson(path, { ...config, hqUrl: normalizeHqUrl(config.hqUrl), relayUrl: normalizeRelayUrl(config.relayUrl) }, fence);
}

function verifyKeysetTransition(
  config: DeviceConfig,
  current: TrustedServerSigningKeyset | undefined,
  candidate: TrustedServerSigningKeyset,
  now: Date,
) {
  return current
    ? verifyServerSigningKeysetUpdate(current, candidate, now)
    : verifyInitialServerSigningKeyset(
      candidate,
      createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: config.serverPublicKeyEd25519 }, format: 'jwk' }),
      config.organizationId,
      now,
    );
}

/** A verified successor of a stored keyset (runbook C9). It either chains from
 * the stored keyset, or this device's pinned root signed it at a strictly higher
 * generation. The root path still applies after the stored keyset expired. A
 * different root, a lower or equal generation or a bad signature never passes. */
export function verifyServerSigningKeysetSuccessor(
  config: Pick<DeviceConfig, 'organizationId' | 'serverPublicKeyEd25519'>,
  stored: TrustedServerSigningKeyset,
  candidate: TrustedServerSigningKeyset,
  now = new Date(),
): ServerSigningKeysetVerificationResult {
  const chained = verifyServerSigningKeysetUpdate(stored, candidate, now);
  if (chained.ok) return chained;
  if (!validateTrustedServerSigningKeysetContract(stored).ok || !validateTrustedServerSigningKeysetContract(candidate).ok
    || stored.organizationId !== config.organizationId) return chained;
  if (candidate.generation <= stored.generation) return { ok: false, reason: 'generation_not_advanced' };
  let root: ReturnType<typeof createPublicKey>;
  try {root = createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: config.serverPublicKeyEd25519 }, format: 'jwk' });}
  catch {return { ok: false, reason: 'untrusted_initial_signer' };}
  return verifyInitialServerSigningKeyset(candidate, root, config.organizationId, now);
}

export async function recoverDeviceEnrollmentConsistency(input: {
  configPath: string;
  store?: SecureSecretStore;
  now?: Date;
  hostScope?: HostOperationScope;
}): Promise<DeviceConfig> {
  return recoverEnrollmentWithFence({...input,
    hostFence: input.hostScope === undefined ? undefined : new HostOperationFence(input.hostScope)});
}

async function recoverEnrollmentWithFence(input: {
  configPath: string; store?: SecureSecretStore; now?: Date; hostFence?: HostOperationFence;
}): Promise<DeviceConfig> {
  const config = input.hostFence ? await input.hostFence.step(() => loadDeviceConfig(input.configPath))
    : await loadDeviceConfig(input.configPath);
  return withEnrollmentAnchorLock(config, input.hostFence, () => recoverEnrollmentLocked({...input, lockedConfig: config}));
}

async function recoverEnrollmentLocked(input: {
  configPath: string; store?: SecureSecretStore; now?: Date; hostFence?: HostOperationFence; lockedConfig: DeviceConfig;
}): Promise<DeviceConfig> {
  const config = input.hostFence ? await input.hostFence.step(() => loadDeviceConfig(input.configPath))
    : await loadDeviceConfig(input.configPath);
  if (!enrollmentAnchorHasBaseIdentity(enrollmentAnchorFromConfig(input.lockedConfig), config)) {
    throw new Error('connection_enrollment_changed');
  }
  const rawStore = input.hostFence ? await input.hostFence.step(async () => input.store ?? await createSystemSecureStore())
    : input.store ?? await createSystemSecureStore();
  const store = input.hostFence ? input.hostFence.store(rawStore) : rawStore;
  const account = enrollmentAnchorAccountFor(config.hqUrl, config.organizationId, config.deviceId);
  let serialized = await freshAnchorValue(store, account);
  let migratedLegacy = false;
  if (serialized === null) {
    serialized = await freshAnchorValue(store, legacyEnrollmentAnchorAccountFor(config.hqUrl, config.organizationId));
    migratedLegacy = serialized !== null;
  }
  if (!serialized) return config;
  if ((JSON.parse(serialized) as {schema?:unknown})?.schema === 'dharma.device-enrollment-recovery-journal/v1') {
    const fence = input.hostFence;
    if (!fence) throw Error('signing_recovery_host_scope_required');
    return resumeSigningRecoveryJournal(signingRecoveryJournalIO({configPath:input.configPath,config,store,fence,
      clock:()=>(input.now??new Date()).getTime()}));
  }
  const anchor = JSON.parse(serialized) as DeviceEnrollmentAnchor;
  if (!enrollmentAnchorHasBaseIdentity(anchor, config)) {
    throw new Error('Device configuration does not match the secure enrollment anchor. Run dharma login again.');
  }
  if (migratedLegacy) {
    await writeEnrollmentAnchor(store, config, serialized, null, serialized);
    if (await freshAnchorValue(store, account) !== serialized) throw new Error('Secure store did not confirm the enrollment anchor migration.');
  }
  if (canonicalize(anchor.serverSigningKeyset ?? null) === canonicalize(config.serverSigningKeyset ?? null)) {
    return config;
  }

  const now = input.now ?? new Date();
  if (anchor.serverSigningKeyset) {
    // The anchor is written ahead of device.json. Its keyset may follow a stored
    // keyset that expired while the device was offline (C9).
    const verification = config.serverSigningKeyset
      ? verifyServerSigningKeysetSuccessor(config, config.serverSigningKeyset, anchor.serverSigningKeyset, now)
      : verifyKeysetTransition(config, undefined, anchor.serverSigningKeyset, now);
    if (verification.ok) {
      const recovered = { ...config, serverSigningKeyset: anchor.serverSigningKeyset };
      await atomicJson(input.configPath, recovered, input.hostFence);
      return recovered;
    }
  }
  if (config.serverSigningKeyset) {
    const verification = verifyKeysetTransition(config, anchor.serverSigningKeyset, config.serverSigningKeyset, now);
    if (verification.ok) {
      await saveEnrollmentAnchorLocked({config, store, now});
      return config;
    }
  }
  throw new Error('Interrupted server signing keyset installation could not be verified. Run dharma login again.');
}

export async function installTrustedServerSigningKeyset(input: {
  configPath: string;
  candidate: TrustedServerSigningKeyset;
  store?: SecureSecretStore;
  now?: Date;
  hostScope?: HostOperationScope;
}): Promise<DeviceConfig> {
  return installKeysetWithFence({...input,
    hostFence: input.hostScope === undefined ? undefined : new HostOperationFence(input.hostScope)});
}

async function installKeysetWithFence(input: {
  configPath: string; candidate: TrustedServerSigningKeyset; store?: SecureSecretStore; now?: Date;
  hostFence?: HostOperationFence;
}): Promise<DeviceConfig> {
  const config = input.hostFence ? await input.hostFence.step(() => loadDeviceConfig(input.configPath))
    : await loadDeviceConfig(input.configPath);
  return withEnrollmentAnchorLock(config, input.hostFence, () => installKeysetLocked({...input, lockedConfig: config}));
}

async function installKeysetLocked(input: {
  configPath: string; candidate: TrustedServerSigningKeyset; store?: SecureSecretStore; now?: Date;
  hostFence?: HostOperationFence; lockedConfig: DeviceConfig;
}): Promise<DeviceConfig> {
  const rawStore = input.hostFence ? await input.hostFence.step(async () => input.store ?? await createSystemSecureStore())
    : input.store ?? await createSystemSecureStore();
  const store = input.hostFence ? input.hostFence.store(rawStore) : rawStore;
  const config = await recoverEnrollmentLocked({configPath: input.configPath, store, now: input.now,
    hostFence: input.hostFence, lockedConfig: input.lockedConfig});
  const now = input.now ?? new Date();
  if (canonicalize(config.serverSigningKeyset ?? null) === canonicalize(input.candidate)) return config;
  const verification = verifyKeysetTransition(config, config.serverSigningKeyset, input.candidate, now);
  if (!verification.ok) throw new Error(`Server signing keyset was rejected: ${verification.reason}.`);
  const next = { ...config, serverSigningKeyset: input.candidate };
  // The protected anchor is the write-ahead record. If the process stops before
  // the disk configuration is replaced, startup verifies and completes it.
  await saveEnrollmentAnchorLocked({config: next, store, now});
  await atomicJson(input.configPath, next, input.hostFence);
  return next;
}

export function parseDeviceConfig(bytes: string): DeviceConfig {
  let value: unknown;
  try {value = JSON.parse(bytes);} catch {throw new Error('connection_config_corrupt');}
  if (!validateDeviceConfigContract(value)) throw new Error('connection_config_invalid');
  const config = value as DeviceConfig;
  try {
    assertInstallationId(config.installationId);
    return {...config, hqUrl: normalizeHqUrl(config.hqUrl), relayUrl: normalizeRelayUrl(config.relayUrl)};
  } catch {throw new Error('connection_config_invalid');}
}

export async function loadDeviceConfig(path: string): Promise<DeviceConfig> {
  let bytes: string;
  try {bytes = await readFile(path, 'utf8');}
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw error;
    throw new Error('connection_config_unreadable');
  }
  return readDeviceConnectionPreference(path, parseDeviceConfig(bytes));
}

function connectionPreferenceBinding(config: DeviceConfig) {
  const {schema, hqUrl, organizationId, installationId, deviceId, publicKeyEd25519,
    serverPublicKeyEd25519, relayUrl, enrolledAt} = config;
  return sha256(canonicalize({schema, hqUrl, organizationId, installationId: installationId ?? null,
    deviceId, publicKeyEd25519, serverPublicKeyEd25519, relayUrl, enrolledAt}));
}

/** Separate local preference from trust snapshots so a delayed keyset write cannot overwrite opt-out. */
export async function readDeviceConnectionPreference(path: string, config: DeviceConfig): Promise<DeviceConfig> {
  const binding = connectionPreferenceBinding(config);
  let bytes: string;
  try {bytes = await readFile(`${path}.connection.json`, 'utf8');}
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return config;
    throw new Error('connection_preference_unreadable');
  }
  let value: DeviceConnectionPreference;
  try {value = JSON.parse(bytes) as DeviceConnectionPreference;} catch {throw new Error('connection_preference_corrupt');}
  if (!validateDeviceConnectionPreferenceContract(value)) throw new Error('connection_preference_invalid');
  // A changed scope cannot inherit consent or resurrect an older inline opt-in.
  if (value.binding !== binding) return {...config, connectionMode: 'manual'};
  return {...config, connectionMode: value.connectionMode};
}

export async function saveDeviceConnectionPreference(input: {
  configPath: string; config: DeviceConfig; connectionMode: 'manual' | 'resume'; hostScope?: HostOperationScope;
}): Promise<void> {
  if (input.connectionMode !== 'manual' && input.connectionMode !== 'resume') throw new Error('connection_preference_invalid');
  const fence = input.hostScope === undefined ? undefined : new HostOperationFence(input.hostScope);
  const binding = connectionPreferenceBinding(input.config);
  const current = fence ? await fence.step(() => loadDeviceConfig(input.configPath)) : await loadDeviceConfig(input.configPath);
  if (connectionPreferenceBinding(current) !== binding) throw new Error('connection_state_changed');
  const preference: DeviceConnectionPreference = {schema: 'dharma.device-connection-preference/v1',
    binding, connectionMode: input.connectionMode};
  await atomicJson(`${input.configPath}.connection.json`, preference, fence);
}

export class AgentFabricClient {
  readonly config: DeviceConfig;
  readonly #privateJwk: JsonWebKey;
  readonly #statePath: string;
  readonly #configPath: string;
  readonly #store: SecureSecretStore;
  readonly #fetcher: typeof fetch;
  readonly #directTransport: boolean;
  readonly #hostFence?: HostOperationFence;
  readonly #hostBinding: string;
  readonly #readOnly: boolean;
  readonly #isolatedSession: boolean;
  #readSessionAdmissionUsed = false;
  #state: ProtocolState;
  readonly #ownerKey: string;
  /** The other clients' entries as of this client's last read of the file. */
  #otherOutboxes: Record<string, OutboxEntry>;
  /** The definite answer another client got for this client's kept request, with the request as this client signed
   * it. Only the next call can take it, and only when it is the same call. */
  #adoptedOutcome: (Pick<PendingRequest, 'method' | 'pathname' | 'body'> & Pick<AdoptedOutcome, 'status' | 'response'>) | null = null;
  /** Completions this client recorded that no state write has stored yet, such as when the write after the server's
   * answer failed. A reload of the file keeps them until a write succeeds. */
  #unwrittenCompletions = new Map<string, RecoveredTaskCompletion>();
  /** The completions in this client's own entry that wait for room in the queue, as of the last read or write. */
  #keptCompletions: RecoveredTaskCompletion[] = [];
  /** Whether this client's kept request is in its own entry in the file, as of the last read or write. */
  #keptOnDisk: boolean;
  /** Opened with an owner key, as a workspace loop is: it also sends due orphans after its own requests. */
  readonly #longLived: boolean;
  #serial: Promise<unknown> = Promise.resolve();

  private constructor(input: {
    config: DeviceConfig; privateJwk: JsonWebKey; configPath: string; statePath: string;
    state: ProtocolState; store: SecureSecretStore; fetcher?: typeof fetch; hostFence?: HostOperationFence; readOnly?: boolean; isolatedSession?: boolean;
    ownerKey: string; longLived: boolean; otherOutboxes: Record<string, OutboxEntry>; keptOnDisk: boolean;
  }) {
    this.config = input.config;
    this.#privateJwk = input.privateJwk;
    this.#configPath = input.configPath;
    this.#store = input.store;
    this.#statePath = input.statePath;
    this.#state = input.state;
    this.#fetcher = input.fetcher || fetch;
    this.#directTransport = Boolean(input.fetcher);
    this.#hostFence = input.hostFence;
    this.#hostBinding = this.#binding();
    this.#readOnly = input.readOnly === true;
    this.#isolatedSession = input.isolatedSession === true;
    this.#ownerKey = input.ownerKey;
    this.#longLived = input.longLived;
    this.#otherOutboxes = input.otherOutboxes;
    this.#keptOnDisk = input.keptOnDisk;
  }

  #binding() {
    const {schema, organizationId, deviceId, installationId, hqUrl, relayUrl, publicKeyEd25519,
      serverPublicKeyEd25519, enrolledAt, platform, setupClaimReference, setupClaimRepositoryFingerprint} = this.config;
    return canonicalize({organizationId, deviceId, installationId: installationId ?? null, hqUrl, relayUrl,
      publicKeyEd25519, serverPublicKeyEd25519, enrolledAt, platform, schema,
      setupClaimReference: setupClaimReference ?? null, setupClaimRepositoryFingerprint: setupClaimRepositoryFingerprint ?? null});
  }
  async #assertHostScope() {
    if (!this.#hostFence) return;
    try {if (this.#binding() !== this.#hostBinding) this.#hostFence.withdraw();}
    catch {this.#hostFence.withdraw();}
    await this.#hostFence.assert();
  }

  static async open(input: { configPath: string; statePath: string; store?: SecureSecretStore; fetcher?: typeof fetch;
    hostScope?: HostOperationScope;
    /** Isolated in-memory protocol session; no enrollment repair, durable outbox replay or application POSTs. */
    readOnly?: boolean;
    /** Fresh in-memory protocol state for an explicit workflow; application requests retain their normal authorization. */
    isolatedSession?: boolean;
    /** The owner of this client's outbox entry: 'relay:<workspaceId>' for a workspace loop, so a restarted loop finds
     * its own kept request and replays it. Such a client also sends due orphans after its own requests. Omitted, the
     * client gets an entry of its own, unique to this process, and sends due orphans only when it opens its session,
     * so a one-shot command exits once its last call returns. */
    ownerKey?: string }) {
    const {configPath, statePath, store: suppliedStore, fetcher, hostScope, readOnly, isolatedSession} = input;
    if (readOnly !== undefined && typeof readOnly !== 'boolean') throw new Error('relay_read_only_option_invalid');
    if (isolatedSession !== undefined && typeof isolatedSession !== 'boolean') throw new Error('relay_isolated_session_option_invalid');
    if (input.ownerKey !== undefined && (typeof input.ownerKey !== 'string'
      || !/^(?:relay|cli):/.test(input.ownerKey) || !OWNER_KEY_PATTERN.test(input.ownerKey))) {
      throw new Error('relay_owner_key_invalid');
    }
    const ownerKey = input.ownerKey ?? `cli:${process.pid}:${PROCESS_INSTANCE}:${++clientInstances}`;
    const fence = hostScope === undefined ? undefined : new HostOperationFence(hostScope);
    const rawStore = fence ? await fence.step(async () => suppliedStore ?? await createSystemSecureStore())
      : suppliedStore ?? await createSystemSecureStore();
    const safeStore: SecureSecretStore = readOnly ? { backend: rawStore.backend,
      get: account => rawStore.get(account),
      put: async () => { throw new Error('relay_read_only_secure_store_write_denied'); },
      delete: async () => { throw new Error('relay_read_only_secure_store_write_denied'); } } : rawStore;
    const store = fence ? fence.store(safeStore) : safeStore;
    const config = readOnly || isolatedSession ? (fence ? await fence.step(() => loadDeviceConfig(configPath)) : await loadDeviceConfig(configPath))
      : await recoverEnrollmentWithFence({configPath, store, hostFence: fence});
    const identity = await existingHostDeviceIdentity(config, store);
    if (identity.publicKeyEd25519 !== config.publicKeyEd25519) throw new Error('Enrolled device identity does not match the secure store.');
    try {
      await loadDeviceEnrollmentAnchor({ config, store, readOnly: readOnly || isolatedSession });
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes('not anchored in secure storage')) throw error;
      throw new Error('Legacy device enrollment must be reauthenticated with dharma login before relay access.');
    }
    let state: ProtocolState = {
      schema: 'dharma.protocol-state/v1', sessionId: null, nextSequence: 1, pending: null,
      recoveredTaskCompletions: [],
    };
    let otherOutboxes: Record<string, OutboxEntry> = {};
    let keptOnDisk = false;
    if (!readOnly && !isolatedSession) try {
      const bytes = fence ? await fence.step(() => readFile(statePath, 'utf8')) : await readFile(statePath, 'utf8');
      const parsed = JSON.parse(bytes) as unknown;
      assertProtocolState(parsed);
      const {[ownerKey]: own, ...others} = outboxesOf(parsed);
      otherOutboxes = others;
      keptOnDisk = !!own?.pending;
      state = {
        schema: 'dharma.protocol-state/v1', sessionId: own?.sessionId ?? null, nextSequence: own?.nextSequence ?? 1,
        pending: own?.pending ?? null, recoveredTaskCompletions: parsed.recoveredTaskCompletions ?? [],
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        if (fence) await fence.assert();
        throw new Error('Relay protocol state is invalid; preserve the file for recovery and re-enroll if necessary.', { cause: error });
      }
    }
    state.recoveredTaskCompletions ??= [];
    await fence?.assert();
    return new AgentFabricClient({
      config, privateJwk: identity.privateJwk, configPath,
      statePath, state, store, fetcher, hostFence: fence, readOnly, isolatedSession, ownerKey,
      longLived: input.ownerKey !== undefined, otherOutboxes, keptOnDisk,
    });
  }

  async openSession(relayVersion = '0.1.0', telemetry: DeviceTelemetryOptions = {}) {
    const deviceTelemetry = deviceKeysetTelemetry(this.config, telemetry);
    await this.#assertHostScope();
    if (this.#readOnly && (this.#state.sessionId || this.#readSessionAdmissionUsed)) {
      throw new Error('relay_read_only_session_already_started');
    }
    // A durable client sends one due orphan or replays its own kept request, and writes its new session from the
    // latest file, all in one signing-control section. It calls the sends directly: waiting on #serial while holding
    // control could deadlock. The section ends before the session POST, which takes control again through #serial.
    const replace = async () => {
      // Not while a task lease is held in this process, so the lease heartbeat of a sibling loop never waits on them,
      // and not when this section replays this client's own kept request, so it holds signing control for one send.
      const replays = !!this.#state.pending && !isExplicitlyRebuiltPath(this.#state.pending.pathname);
      if (this.#durable && !replays && !taskLeaseHeld(Date.now())) await this.#adoptOrphans();
      if (this.#state.pending && isExplicitlyRebuiltPath(this.#state.pending.pathname)) {
        // Content-bearing requests require refreshed consent. Repository connect
        // requests depend on current workspace registration. Both are rebuilt by
        // their explicit workflows instead of replayed from stale prerequisites.
        this.#state.pending = null;
        await this.#persist();
      } else if (this.#state.pending) {
        await this.#sendPendingWithSigningControl(this.#state);
      }
      this.#state.sessionId = randomUUID();
      this.#state.nextSequence = 1;
      this.#state.pending = null;
      await this.#persist();
    };
    if (this.#durable || this.#state.pending) await this.#withProtocolState(replace);
    else await replace();
    return this.signedPost('/agent-fabric/sessions', {
      connectionId: randomBytes(24).toString('base64url'), durableCursor: null, relayVersion, deviceTelemetry,
    });
  }

  async registerWorkspace(body: Record<string, unknown>, telemetry: DeviceTelemetryOptions = {}) {
    const response = await this.signedPost('/agent-fabric/workspaces',
      { ...body, deviceTelemetry: deviceKeysetTelemetry(this.config, telemetry) });
    if (response.serverSigningKeyset !== undefined) {
      const next = await installKeysetWithFence({
        configPath: this.#configPath,
        candidate: response.serverSigningKeyset as TrustedServerSigningKeyset,
        store: this.#store,
        hostFence: this.#hostFence,
      });
      Object.assign(this.config, next);
    }
    return response;
  }
  connectRepositoryAgent(body: unknown) { return this.signedPost('/agent-fabric/repository-agents', body); }
  getTrajectoryHead(body: { trajectoryId: string; workspaceId: string }) {
    return this.signedPost('/agent-fabric/trajectories/head', body);
  }
  syncTrajectory(body: unknown) { return this.signedPost('/agent-fabric/trajectories', body); }
  pollEvidence(body: { workspaceId: string }) { return this.signedPost('/agent-fabric/evidence-requests/poll', body); }
  postEvidenceResponse(requestId: string, body: unknown) {
    return this.signedPost(`/agent-fabric/evidence-requests/${encodeURIComponent(requestId)}/responses`, body);
  }
  pollTask(leaseSeconds = 120, studyExpectedTaskId?: string) {
    return this.signedPost('/agent-fabric/tasks/poll', {
      leaseSeconds, ...(studyExpectedTaskId === undefined ? {} : { studyExpectedTaskId }),
    });
  }
  postTaskEvent(taskId: string, eventType: string, payload: unknown) {
    return this.signedPost(`/agent-fabric/tasks/${encodeURIComponent(taskId)}/events`, { eventType, payload });
  }
  postActionEnforcement(decisionId: string, body: ActionDecisionAcknowledgement) {
    const contract = validateActionDecisionAcknowledgementContract(body);
    if (!contract.ok) throw new Error(`Action acknowledgement failed schema validation: ${JSON.stringify(contract.errors)}`);
    return this.signedPost(`/agent-fabric/decisions/${encodeURIComponent(decisionId)}/enforcements`, body);
  }
  listRecoveredTaskCompletions(): RecoveredTaskCompletion[] {
    return (this.#state.recoveredTaskCompletions || []).map((item) => ({ ...item }));
  }
  acknowledgeRecoveredTaskCompletion(taskId: string, receiptHash: string): Promise<void> {
    const acknowledge = async () => {
      const current = this.#state.recoveredTaskCompletions || [];
      const matching = current.find((item) => item.taskId === taskId);
      if (!matching) return;
      if (matching.receiptHash !== receiptHash) throw new Error('Recovered task completion receipt does not match.');
      this.#state.recoveredTaskCompletions = current.filter((item) => item.taskId !== taskId);
      this.#unwrittenCompletions.delete(taskId);
      await this.#persist();
    };
    if (this.#durable) {
      // The completion queue belongs to the whole device: acknowledge against the latest file, under signing control.
      // Never on this client's request queue: a request that already holds signing control can wait there, and this
      // acknowledgement would then wait in the signing-control line for that request while it waits for us.
      return (async () => { await this.#assertHostScope(); return this.#withProtocolState(acknowledge); })();
    }
    const operation = this.#serial.then(async () => {
      await this.#assertHostScope();
      if (this.#readOnly) throw new Error('relay_read_only_mutation_denied');
      return acknowledge();
    });
    this.#serial = operation.catch(() => undefined);
    return operation;
  }
  pollSkill(body: {
    workspaceId: string;
    provider: ProviderId;
    installedBundleId: string | null;
    legacyBaselineMigrationRequested?: boolean;
  }) {
    return this.signedPost('/agent-fabric/skills/poll', body);
  }
  postInstallReceipt(bundleId: string, rolloutId: string, receipt: unknown) {
    return this.signedPost(`/agent-fabric/skills/${encodeURIComponent(bundleId)}/receipts`, { rolloutId, receipt });
  }

  listControlAgentSessions(sessionId?: string) {
    const query = sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : '';
    return this.signedGet(`/control-agent/sessions${query}`);
  }
  createControlAgentSession(title = 'New conversation') {
    return this.signedPost('/control-agent/sessions', { title });
  }
  submitControlAgentMessage(sessionId: string, body: unknown) {
    return this.signedPost(`/control-agent/sessions/${encodeURIComponent(sessionId)}/messages`, body);
  }
  listControlAgentEvents(sessionId: string, afterSequence = 0) {
    return this.signedGet(`/control-agent/sessions/${encodeURIComponent(sessionId)}/events?afterSequence=${afterSequence}`);
  }

  signedGet(route: string): Promise<Record<string, unknown>> {
    const operation = this.#serial.then(() => this.#signedRequestNow('GET', route, undefined));
    this.#serial = operation.catch(() => undefined);
    return operation;
  }

  signedPost(route: string, body: unknown): Promise<Record<string, unknown>> {
    const operation = this.#serial.then(() => this.#signedRequestNow('POST', route, body));
    this.#serial = operation.catch(() => undefined);
    return operation;
  }

  async #signedRequestNow(method: PendingRequest['method'], route: string, body: unknown): Promise<Record<string, unknown>> {
    const event = method === 'POST' && /^\/agent-fabric\/tasks\/[^/]+\/events$/.test(route)
      ? (body as { eventType?: unknown } | null)?.eventType : undefined;
    if (event === 'completed' || event === 'failed' || event === 'cancelled') taskLeases.delete(this);
    const result = await this.#withProtocolState(() => this.#signedRequestWithSigningControl(method, route, body));
    if (!this.#durable) return result;
    if (route === '/agent-fabric/tasks/poll' && result.task && typeof result.task === 'object') {
      const seconds = Number((body as { leaseSeconds?: unknown } | null)?.leaseSeconds);
      this.#leaseMs = (Number.isFinite(seconds) && seconds > 0 ? seconds : 120) * 1000;
      taskLeases.set(this, Date.now() + this.#leaseMs);
    } else if (event === 'started' || event === 'lease_extended') {
      taskLeases.set(this, Date.now() + this.#leaseMs);
    }
    // A long-lived client, such as a workspace loop, also sends due orphans after its own requests, so they do not wait
    // for another session open (which has just sent them before its own POST). A one-shot command does not: a send
    // after its last call would keep its process running after it has its answer.
    if (this.#longLived && !(method === 'POST' && route === '/agent-fabric/sessions')) this.#sendDueOrphansLater();
    return result;
  }

  /** The lease length of the task this client last polled. */
  #leaseMs = 120_000;
  /** Whether a section that sends due orphans is waiting or running. */
  #orphanSection = false;

  /** Sends at most one due orphan in a signing-control section of its own, after the caller already has its answer. It
   * waits in the signing-control line like any root, so this client's next request may wait for that one send, but
   * never while a task lease is held in this process. It never runs inside the caller's hold of signing control. */
  #sendDueOrphansLater(): void {
    if (this.#orphanSection || Date.now() < this.#orphansDueAt || taskLeaseHeld(Date.now())) return;
    this.#orphanSection = true;
    const send = () => this.#withProtocolState(async () => {
      if (!taskLeaseHeld(Date.now())) await this.#adoptOrphans();
    });
    void outsideDeviceSigningControl(() => protocolStateSections.exit(send))
      .catch(() => undefined) // A later request tries again; the caller already has its answer.
      .finally(() => { this.#orphanSection = false; });
  }

  get #durable(): boolean { return !this.#readOnly && !this.#isolatedSession; }

  #controlScope(): HostOperationScope | undefined {
    return this.#hostFence?{signal:this.#hostFence.signal,current:async()=>{await this.#assertHostScope();return true;}}:undefined;
  }

  /** Runs work under device signing control. A root section of a durable client first reloads the device-wide
   * protocol state from the file; a nested call inside this client's live section reuses it without a reload. */
  async #withProtocolState<T>(work: () => Promise<T>): Promise<T> {
    const input = {config: this.config, hostScope: this.#controlScope()};
    const current = protocolStateSections.getStore();
    if (current?.client === this && current.active) return withDeviceSigningControl(input, work);
    return withDeviceSigningControl(input, () => {
      const section: ProtocolStateSection = {client: this, active: true};
      return protocolStateSections.run(section, async () => {
        try {
          if (this.#durable) await this.#reloadSharedState();
          return await work();
        } finally { section.active = false; }
      });
    });
  }

  /** The file wins for every other client's entry and for the recovered completion queue, except for a completion this
   * client recorded and no write has stored yet, which it keeps. A completion waiting in any entry, or one this client
   * has not written yet, joins the queue only while the queue stays within what a reader accepts; otherwise it waits
   * for room, in its entry or, until the next write puts it in this client's entry, in memory. This client's own
   * session, sequence and kept request are written only by this client, so they are never reloaded. */
  async #reloadSharedState(): Promise<void> {
    let disk: ProtocolState | null = null;
    try {
      const bytes = this.#hostFence ? await this.#hostFence.step(() => readFile(this.#statePath, 'utf8'))
        : await readFile(this.#statePath, 'utf8');
      const parsed = JSON.parse(bytes) as unknown;
      assertProtocolState(parsed);
      disk = parsed;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        await this.#hostFence?.assert();
        throw new Error('Relay protocol state is invalid; preserve the file for recovery and re-enroll if necessary.', { cause: error });
      }
    }
    const others = disk ? outboxesOf(disk) : {};
    const own = others[this.#ownerKey];
    delete others[this.#ownerKey];
    this.#otherOutboxes = others;
    const merged = [...disk?.recoveredTaskCompletions ?? []];
    /** Whether the completion is in the queue, adding it while there is room. */
    const listed = (item: RecoveredTaskCompletion) => {
      if (merged.some(other => other.taskId === item.taskId)) return true;
      if (merged.length >= RECOVERED_TASK_COMPLETIONS_MAX) return false;
      merged.push(item);
      return true;
    };
    this.#keptCompletions = (own?.keptCompletions ?? []).filter(item => !listed(item));
    for (const item of this.#unwrittenCompletions.values()) listed(item);
    for (const entry of Object.values(others)) {
      const waiting = entry.keptCompletions?.filter(item => !listed(item));
      if (waiting?.length) entry.keptCompletions = waiting; else delete entry.keptCompletions;
    }
    this.#state.recoveredTaskCompletions = merged;
    // This client's kept request left the file, although no write drops one: another client sent it and got a definite
    // answer, and the entry was removed before this client read it again (by the idle cap, or the file was replaced).
    // The sequences that client signed in this session are then unknown, so this session signs nothing more: the
    // request is settled, and the next call needs a new session.
    if (this.#state.pending && this.#keptOnDisk && !own) {
      this.#state.pending = null;
      this.#state.sessionId = null;
      this.#adoptedOutcome = null;
    }
    // Another client sent this client's kept request after it stood unchanged (see orphanDue). The file then holds
    // its outcome: no kept request once it was answered, with the answer, or the request as last sent. When the
    // answer is not there (never kept, or removed after ORPHAN_RETRY_INTERVAL_MS), this client keeps its signed
    // request, so a retry sends it again with the same message id and idempotency key instead of signing the call again.
    // The file's next sequence counts any sequence the other client signed in this session, so none is signed again.
    if (own?.adoptedAt && this.#state.pending) {
      const signed = this.#state.pending;
      const outcome = own.adoptedOutcome;
      const answered = !own.pending && !!outcome && outcome.messageId === signed.headers['x-dharma-message-id'];
      this.#state.nextSequence = Math.max(this.#state.nextSequence, own.nextSequence);
      if (own.pending || answered) this.#state.pending = own.pending;
      this.#adoptedOutcome = answered
        ? {method: signed.method, pathname: signed.pathname, body: signed.body, status: outcome!.status,
          response: outcome!.response}
        : null;
    }
  }

  /** When this client next looks for due orphans after its own request. */
  #orphansDueAt = 0;

  /** Sends the kept requests of orphaned entries (see orphanDue): at most ORPHAN_SENDS_PER_SECTION, and none after one
   * without a definite answer. Their outcome is never this caller's and is never thrown. Each entry is marked in the
   * file before its send, so when this client stops during the send, the next one waits ORPHAN_RETRY_INTERVAL_MS too.
   * An answered entry keeps no request; it holds the answer only when its owner may still read it (a workspace loop, or a process
   * that still runs), so a live owner takes the outcome from the file, and #persist drops that answer after
   * ORPHAN_RETRY_INTERVAL_MS. A request without a definite answer stays and is due again after
   * ORPHAN_RETRY_INTERVAL_MS. A re-signed request keeps its owner's session. While more are due, this client's next
   * request sends the next one. An orphaned request only its owner can use is dropped without sending. */
  async #adoptOrphans(): Promise<void> {
    const now = Date.now();
    this.#orphansDueAt = now + ORPHAN_RETRY_INTERVAL_MS;
    const due = Object.entries(this.#otherOutboxes).filter(([owner, entry]) => orphanDue(owner, entry, now));
    let unwritten = false;
    for (const [, entry] of due) {
      if (!isOwnerOnlyRequest(entry.pending!)) continue;
      entry.nextSequence += 1;
      entry.pending = null;
      entry.adoptedAt = entry.updatedAt = new Date().toISOString();
      delete entry.adoptedOutcome;
      unwritten = true;
    }
    let sent = 0;
    for (const [owner, entry] of due) {
      if (!entry.pending) continue;
      if (sent === ORPHAN_SENDS_PER_SECTION) { this.#orphansDueAt = now; break; }
      sent += 1;
      const messageId = entry.pending.headers['x-dharma-message-id'] ?? '';
      const ownerReads = owner.startsWith('relay:') || ownerProcessAlive(entry.ownerPid);
      entry.adoptedAt = new Date().toISOString();
      delete entry.adoptedOutcome;
      await this.#persist();
      unwritten = false;
      try {
        await this.#sendPendingWithSigningControl(entry, (status, response) => {
          // Only an answer every reader accepts is kept; without one, the owner signs its retry again.
          const outcome = {messageId, status, response};
          if (ownerReads && isAdoptedOutcome(outcome)) entry.adoptedOutcome = outcome;
        });
      } catch { await this.#assertHostScope(); }
      entry.adoptedAt = new Date().toISOString();
      if (!entry.pending) entry.updatedAt = entry.adoptedAt;
      await this.#persist();
      if (entry.pending) break;
    }
    if (unwritten) await this.#persist();
  }

  async #signedRequestWithSigningControl(method: PendingRequest['method'], route: string, body: unknown): Promise<Record<string, unknown>> {
    await this.#assertHostScope();
    if (!this.#state.sessionId) throw new Error('Relay session is not open.');
    if (this.#readOnly) {
      if (this.#state.pending) throw new Error('relay_read_only_pending_request');
      if (method !== 'GET') {
        if (route !== '/agent-fabric/sessions' || this.#readSessionAdmissionUsed || this.#state.nextSequence !== 1) {
          throw new Error('relay_read_only_mutation_denied');
        }
        this.#readSessionAdmissionUsed = true;
      }
    }
    const pathname = `/api/v1/orgs/${encodeURIComponent(this.config.organizationId)}${route}`;
    const serialized = method === 'GET' ? '' : canonicalize(body);
    const adopted = this.#adoptedOutcome;
    this.#adoptedOutcome = null;
    if (adopted && !this.#state.pending && adopted.method === method && adopted.pathname === pathname
      && adopted.body === serialized) {
      // Another client delivered this call's kept request: the retry gets that answer, as a recovery of its own would.
      if (adopted.status >= 200 && adopted.status < 300) return adopted.response;
      throw new AgentFabricRequestError(adopted.response, adopted.status, true);
    }
    if (this.#state.pending && isContentBearingPath(this.#state.pending.pathname)) {
      // An ambiguous content delivery is never replayed implicitly. The next
      // explicit caller must rebuild the capsule after rechecking disclosure
      // policy; a skipped sequence is safe because the server enforces
      // monotonic rather than contiguous device sequences.
      this.#state.nextSequence += 1;
      this.#state.pending = null;
      await this.#persist();
    } else if (this.#state.pending) {
      const sameRequest = this.#state.pending.method === method
        && this.#state.pending.pathname === pathname
        && this.#state.pending.body === serialized;
      const recovered = await this.#sendPendingWithSigningControl(this.#state);
      // Recovery acknowledges only its original caller's request identity.
      if (sameRequest) return recovered;
    }
    const timestamp = new Date().toISOString();
    await this.#assertHostScope();
    const messageId = randomUUID();
    const nonce = randomBytes(24).toString('base64url');
    const sequence = this.#state.nextSequence;
    const signingPayload = Buffer.from(JSON.stringify({
      bodyHash: `sha256:${sha256(serialized)}`, deviceId: this.config.deviceId, messageId,
      method, nonce, organizationId: this.config.organizationId, pathname,
      sequence, sessionId: this.#state.sessionId, timestamp,
    }), 'utf8');
    const signature = sign(null, signingPayload, { key: this.#privateJwk, format: 'jwk' }).toString('base64url');
    const pending: PendingRequest = {
      method, pathname, body: serialized,
      headers: {
        ...(method === 'POST' ? {
          'content-type': 'application/json',
          'idempotency-key': messageId,
        } : {}),
        'x-dharma-device-id': this.config.deviceId,
        'x-dharma-session-id': this.#state.sessionId, 'x-dharma-message-id': messageId,
        'x-dharma-timestamp': timestamp, 'x-dharma-nonce': nonce,
        'x-dharma-sequence': String(sequence), 'x-dharma-signature': signature,
      },
    };
    this.#assertRecoveredTaskCompletionCapacity(pending);
    // In a file full of other clients' kept requests, due orphans are sent first to make room for this one.
    if (this.#durable && !isExplicitlyRebuiltPath(pending.pathname) && !isSessionOpen(pending)
      && Object.values(this.#otherOutboxes).filter(entry => entry.pending).length >= OUTBOX_ENTRIES_MAX) {
      await this.#adoptOrphans();
    }
    this.#state.pending = pending;
    try { await this.#persist(); } catch (error) {
      // A request the full file refused is never sent, so it is not kept for a later replay either.
      if ((error as Error).message === 'relay_protocol_state_outbox_full') this.#state.pending = null;
      throw error;
    }
    return this.#sendPendingWithSigningControl(this.#state);
  }

  /** Sends the kept request of one outbox entry: this client's own, or an orphan in #adoptOrphans. answered sees a
   * definite answer before the entry is written without its request. */
  async #sendPendingWithSigningControl(slot: Pick<OutboxEntry, 'nextSequence' | 'pending'>,
    answered?: (status: number, response: Record<string, unknown>) => void): Promise<Record<string, unknown>> {
    await this.#assertHostScope();
    const pending = slot.pending;
    if (!pending) throw new Error('No pending protocol request.');
    // A kept completion is sent again even when the queue is full: the server may already have accepted it, and its
    // receipt then waits in this client's entry for room (see #recordRecoveredTaskCompletion).
    if (/\/agent-fabric\/decisions\/[^/]+\/enforcements$/.test(pending.pathname)) {
      let acknowledgement: ActionDecisionAcknowledgement;
      try {
        acknowledgement = JSON.parse(pending.body) as ActionDecisionAcknowledgement;
      } catch {
        acknowledgement = {} as ActionDecisionAcknowledgement;
      }
      const contract = validateActionDecisionAcknowledgementContract(acknowledgement);
      if (!contract.ok) {
        slot.nextSequence = Math.max(
          slot.nextSequence + 1,
          Number(pending.headers['x-dharma-sequence'] || 0) + 1,
        );
        slot.pending = null;
        await this.#persist();
        throw new Error('Stale action acknowledgement is invalid and was discarded.');
      }
      const acknowledgedAt = Date.parse(acknowledgement.acknowledgedAt);
      if (!Number.isFinite(acknowledgedAt)
        || Date.now() - acknowledgedAt > 8 * 60_000
        || acknowledgedAt > Date.now() + 5 * 60_000) {
        const refreshed = refreshActionDecisionAcknowledgement(acknowledgement);
        // Above every sequence used in this session, including one another client signed when it sent this entry.
        const sequence = Math.max(Number(pending.headers['x-dharma-sequence'] || 0) + 1, slot.nextSequence);
        const timestamp = new Date().toISOString();
        const messageId = randomUUID();
        const nonce = randomBytes(24).toString('base64url');
        pending.body = canonicalize(refreshed);
        const signingPayload = Buffer.from(JSON.stringify({
          bodyHash: `sha256:${sha256(pending.body)}`,
          deviceId: this.config.deviceId, messageId, method: pending.method, nonce,
          organizationId: this.config.organizationId, pathname: pending.pathname,
          sequence, sessionId: pending.headers['x-dharma-session-id'], timestamp,
        }), 'utf8');
        pending.headers['x-dharma-message-id'] = messageId;
        pending.headers['x-dharma-timestamp'] = timestamp;
        pending.headers['x-dharma-nonce'] = nonce;
        pending.headers['x-dharma-sequence'] = String(sequence);
        pending.headers['x-dharma-signature'] = sign(
          null, signingPayload, { key: this.#privateJwk, format: 'jwk' },
        ).toString('base64url');
        slot.nextSequence = sequence;
        await this.#persist();
      }
    }
    const signedAt = Date.parse(pending.headers['x-dharma-timestamp'] || '');
    if (!Number.isFinite(signedAt) || Date.now() - signedAt > 4 * 60_000) {
      const timestamp = new Date().toISOString();
      const nonce = randomBytes(24).toString('base64url');
      const messageId = pending.headers['x-dharma-message-id']!;
      const signingPayload = Buffer.from(JSON.stringify({
        bodyHash: `sha256:${sha256(pending.body)}`,
        deviceId: this.config.deviceId,
        messageId,
        method: pending.method,
        nonce,
        organizationId: this.config.organizationId,
        pathname: pending.pathname,
        sequence: Number(pending.headers['x-dharma-sequence']),
        sessionId: pending.headers['x-dharma-session-id'],
        timestamp,
      }), 'utf8');
      pending.headers['x-dharma-timestamp'] = timestamp;
      pending.headers['x-dharma-nonce'] = nonce;
      pending.headers['x-dharma-signature'] = sign(
        null,
        signingPayload,
        { key: this.#privateJwk, format: 'jwk' },
      ).toString('base64url');
      await this.#persist();
    }
    let status: number;
    let body: Record<string, unknown>;
    if (this.#directTransport) {
      await this.#assertHostScope();
      const url = `${this.config.hqUrl.replace(/\/$/, '')}${pending.pathname}`;
      let response: Response | undefined;
      try {
        response = await this.#fetcher(url, {
          method: pending.method, headers: pending.headers,
          body: pending.method === 'GET' ? undefined : pending.body,
          ...(this.#hostFence ? {signal: this.#hostFence.signal, redirect: 'error' as const} : {}),
        });
        await this.#assertHostScope();
        if (this.#hostFence && (response.redirected || response.url && response.url !== url)) {
          throw new Error('relay_host_transport_response_invalid');
        }
        status = response.status;
        body = this.#hostFence ? await scopedResponseJson(response, this.#hostFence)
          : await response.json() as Record<string, unknown>;
      } catch (error) {
        if (this.#hostFence) {
          await response?.body?.cancel().catch(() => undefined);
          await this.#assertHostScope();
        }
        throw error;
      }
    } else {
      const response = await this.#sendViaRelay(pending);
      await this.#assertHostScope();
      status = response.status;
      try { body = JSON.parse(response.body) as Record<string, unknown>; }
      catch { body = { ok: false, error: { code: 'invalid_relay_response', message: 'Relay returned invalid JSON.' } }; }
    }
    await this.#assertHostScope();
    if (status < 200 || status >= 300) {
      // A deterministic client rejection is an acknowledgement, not an unknown
      // delivery outcome. Retaining it would permanently block the device
      // outbox. Retryable timeout and throttling responses keep the exact
      // signed request, as do upstream failures whose commit state is unknown.
      const definitive = status >= 400 && status < 500 && status !== 408 && status !== 429;
      if (definitive) {
        answered?.(status, body);
        slot.nextSequence += 1;
        slot.pending = null;
        await this.#persist();
      }
      throw new AgentFabricRequestError(body, status, definitive);
    }
    this.#recordRecoveredTaskCompletion(pending, body);
    answered?.(status, body);
    slot.nextSequence += 1;
    slot.pending = null;
    await this.#persist();
    return body;
  }

  #recordRecoveredTaskCompletion(pending: PendingRequest, response: Record<string, unknown>): void {
    const route = pending.pathname.match(/\/agent-fabric\/tasks\/([^/]+)\/events$/);
    if (!route) return;
    let request: Record<string, unknown>;
    try { request = JSON.parse(pending.body) as Record<string, unknown>; } catch { return; }
    const payload = request.payload && typeof request.payload === 'object' && !Array.isArray(request.payload)
      ? request.payload as Record<string, unknown>
      : null;
    const receipt = response.receipt && typeof response.receipt === 'object' && !Array.isArray(response.receipt)
      ? response.receipt as Record<string, unknown>
      : null;
    const taskId = decodeURIComponent(route[1]!);
    const trajectoryCapsuleHash = String(payload?.trajectoryCapsuleHash || '');
    if (request.eventType !== 'completed') return;
    // First-run tasks without an active skill are valid completions, but they
    // do not stage a signed trajectory for recovery.
    if (!trajectoryCapsuleHash) return;
    const receiptHash = String(receipt?.hash || '');
    if (!/^[0-9a-f-]{36}$/i.test(taskId)
      || !/^sha256:[a-f0-9]{64}$/.test(trajectoryCapsuleHash)) {
      throw new Error('Task completion request is missing its durable evidence identity.');
    }
    if (!/^sha256:[a-f0-9]{64}$/.test(receiptHash)) {
      throw new Error('Task completion acknowledgement is missing a valid durable receipt.');
    }
    const current = this.#state.recoveredTaskCompletions || [];
    const existing = [...current, ...this.#keptCompletions, ...this.#unwrittenCompletions.values()]
      .find((item) => item.taskId === taskId);
    if (existing) {
      if (existing.receiptHash !== receiptHash || existing.trajectoryCapsuleHash !== trajectoryCapsuleHash) {
        throw new Error('Recovered task completion conflicts with its durable receipt.');
      }
      return;
    }
    const completion = { taskId, trajectoryCapsuleHash, receiptHash, recoveredAt: new Date().toISOString() };
    // An accepted completion is never dropped: without room in the queue it waits in this client's entry (see #persist).
    if (current.length < RECOVERED_TASK_COMPLETIONS_MAX) this.#state.recoveredTaskCompletions = [...current, completion];
    this.#unwrittenCompletions.set(taskId, completion);
  }

  #assertRecoveredTaskCompletionCapacity(pending: PendingRequest): void {
    const route = pending.pathname.match(/\/agent-fabric\/tasks\/([^/]+)\/events$/);
    if (!route) return;
    let request: Record<string, unknown>;
    try { request = JSON.parse(pending.body) as Record<string, unknown>; } catch { return; }
    if (request.eventType !== 'completed') return;
    const taskId = decodeURIComponent(route[1]!);
    const current = this.#state.recoveredTaskCompletions || [];
    if (!current.some((item) => item.taskId === taskId) && current.length >= RECOVERED_TASK_COMPLETIONS_MAX) {
      throw new Error('Recovered task completion queue is full; acknowledge stored completions before sending another completion.');
    }
  }

  async #sendViaRelay(pending: PendingRequest): Promise<{ status: number; body: string }> {
    await this.#assertHostScope();
    return new Promise((accept, reject) => {
      const relay = new URL(normalizeRelayUrl(this.config.relayUrl));
      relay.pathname = '/v1/connect';
      relay.search = '';
      const socket = new WebSocket(relay);
      let settled = false;
      const finish = (callback: () => void, closeSocket = true) => {
        if (settled) return;
        settled = true;
        clearTimeout(connectTimeout);
        clearTimeout(timeout);
        this.#hostFence?.signal.removeEventListener('abort', abort);
        callback();
        if (closeSocket && socket.readyState < WebSocket.CLOSING) socket.close(1000);
      };
      const timeout = setTimeout(
        () => finish(() => reject(Object.assign(new Error('Relay response timed out.'), {code: 'relay_response_timeout'}))),
        RELAY_ACKNOWLEDGEMENT_TIMEOUT_MS,
      );
      // #512: before the socket opens this attempt has sent nothing, so this limit fails it cleanly. The kept signed
      // request is sent on the next attempt, exactly as after any other failure that keeps it (an earlier attempt
      // may already have sent it). It never shortens the window after send.
      const connectTimeout = setTimeout(
        () => finish(() => reject(Object.assign(
          new Error('Relay connection timed out before the request was sent.'), {code: 'relay_connect_timeout'}))),
        RELAY_CONNECT_TIMEOUT_MS,
      );
      const abort = () => finish(() => reject(new Error('relay_host_scope_unavailable')));
      this.#hostFence?.signal.addEventListener('abort', abort, {once: true});
      if (this.#hostFence?.signal.aborted) abort();
      socket.addEventListener('open', () => {
        clearTimeout(connectTimeout);
        const send = () => {if (!settled) socket.send(JSON.stringify({
          requestId: pending.headers['x-dharma-message-id'], method: pending.method,
          pathname: pending.pathname, headers: pending.headers, body: pending.body,
        }));};
        if (!this.#hostFence) send();
        else void this.#assertHostScope().then(send).catch(error => finish(() => reject(error)));
      });
      socket.addEventListener('message', (event) => {
        if (settled) return;
        try {
          const response = JSON.parse(String(event.data)) as { requestId: string; status: number; body: string };
          if (response.requestId !== pending.headers['x-dharma-message-id']) return;
          finish(() => accept({ status: response.status, body: response.body }));
        } catch (error) { finish(() => reject(error)); }
      });
      socket.addEventListener('error', () => finish(() => reject(new Error('Relay connection failed.'))));
      socket.addEventListener('close', (event) => {
        finish(
          () => reject(new Error(`Relay closed before acknowledgement (${event.code}).`)),
          false,
        );
      });
    });
  }

  async #persist() {
    if (this.#readOnly || this.#isolatedSession) { await this.#assertHostScope();return; }
    const section = protocolStateSections.getStore();
    if (section?.client !== this || !section.active) throw new Error('relay_protocol_state_unserialized');
    await this.#assertHostScope();
    // Authorized content and state-dependent repository connects are rebuilt
    // from their governed source. Do not retain them as an automatic replay
    // that can outlive consent or the workspace registration they depend on.
    // Each other client's entry is written back as read; an idle entry of an
    // owner process that has exited is dropped once no other client took its
    // request in the last ORPHAN_RETRY_INTERVAL_MS (an owner that read the
    // entry earlier still finds the answer), and the newest idle entries are
    // kept up to IDLE_OUTBOX_ENTRIES_MAX. A kept request is never dropped.
    // The entry limit counts kept requests only: a write is refused only when
    // it would add one to a full file, and idle entries, this client's own
    // included, take only the room that is left.
    const outboxes: Record<string, OutboxEntry> = {};
    const idle: Array<[string, OutboxEntry]> = [];
    const now = Date.now();
    for (const [owner, read] of Object.entries(this.#otherOutboxes)) {
      let entry = durableOutboxEntry(read);
      if (entry.adoptedOutcome && !recentlyAdopted(entry, now)) {
        // An adopted answer stays only while its owner may still retry the call (see recentlyAdopted).
        const {adoptedOutcome: _answer, ...rest} = entry;
        entry = rest;
      }
      if (entry.pending || entry.keptCompletions) outboxes[owner] = entry;
      else if (ownerProcessAlive(entry.ownerPid) || recentlyAdopted(entry, now)) idle.push([owner, entry]);
    }
    // A file never holds more entries than a reader accepts. Only a new kept request an earlier version left at the
    // top level of a full file can exceed them (see outboxesOf); it stays at the top level until it is sent.
    let leftover: OutboxEntry | undefined;
    const migrated = Object.keys(outboxes).filter(owner => owner.startsWith('migrated:')).at(-1); // outboxesOf adds it last
    if (Object.keys(outboxes).length > OUTBOX_ENTRIES_MAX && migrated) {
      leftover = outboxes[migrated];
      delete outboxes[migrated];
    }
    const {sessionId, nextSequence, pending} = this.#state;
    // A completion this client recorded that the queue has no room for waits in its own entry, which is then kept.
    const listed = this.#state.recoveredTaskCompletions ?? [];
    const waiting = [...this.#keptCompletions, ...[...this.#unwrittenCompletions.values()].filter(item =>
      !listed.some(other => other.taskId === item.taskId) && !this.#keptCompletions.some(other => other.taskId === item.taskId))];
    const own = durableOutboxEntry({sessionId, nextSequence, pending, ownerPid: process.pid,
      updatedAt: new Date().toISOString(), ...(waiting.length ? {keptCompletions: waiting} : {})});
    let room = OUTBOX_ENTRIES_MAX - Object.keys(outboxes).length;
    if (room < 1 && (waiting.length || (own.pending && !isSessionOpen(own.pending)))) {
      throw new Error('relay_protocol_state_outbox_full');
    }
    if (room > 0) { outboxes[this.#ownerKey] = own; room -= 1; }
    idle.sort(([, a], [, b]) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
    for (const [owner, entry] of idle.slice(0, Math.min(IDLE_OUTBOX_ENTRIES_MAX, room))) outboxes[owner] = entry;
    // An earlier version reads only the top-level session, sequence and kept request, and its session open replays
    // that request and then writes a file without outboxes. So the oldest kept request, exactly as signed, also goes
    // there: after a rollback the earlier version still sends that one, with the same message id. outboxesOf never
    // takes this copy for another orphan.
    const [copy] = leftover ? [leftover] : Object.values(outboxes)
      .filter(entry => entry.pending && !isOwnerOnlyRequest(entry.pending))
      .sort((a, b) => Date.parse(a.updatedAt) - Date.parse(b.updatedAt));
    await atomicJson(this.#statePath, {
      schema: 'dharma.protocol-state/v1', sessionId: copy?.sessionId ?? null, nextSequence: copy?.nextSequence ?? 1,
      pending: copy?.pending ?? null, recoveredTaskCompletions: this.#state.recoveredTaskCompletions ?? [], outboxes,
    } satisfies ProtocolState, this.#hostFence);
    // Every completion this client recorded is now in the queue or in its own entry.
    this.#unwrittenCompletions.clear();
    this.#keptCompletions = waiting;
    this.#keptOnDisk = !!outboxes[this.#ownerKey]?.pending;
  }
}

export const RELAY_ACKNOWLEDGEMENT_TIMEOUT_MS = 90_000;
/** Limit for the relay connection to open. Nothing is sent before it opens; the acknowledgement window is unchanged. */
export const RELAY_CONNECT_TIMEOUT_MS = 30_000;

/** schemas/device-keyset-telemetry.schema.json. Reported for lag alerts only; the server never authorizes on it. */
export type DeviceKeysetTelemetry = {
  schema: 'dharma.device-keyset-telemetry/v1';
  heldKeysetGeneration: number | null;
  heldKeysetExpiresAt: string | null;
  relayAutostartEnabled?: boolean;
};
/** Omit relayAutostartEnabled when the state cannot be read; it is never guessed as false. */
export type DeviceTelemetryOptions = { relayAutostartEnabled?: boolean };

// A date-time the keyset contract accepts (including a lowercase or space separator); sent normalized to ISO.
const TELEMETRY_INSTANT = /^\d{4}-\d{2}-\d{2}[Tt ]\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:[Zz]|[+-]\d{2}:\d{2})$/;

export function deviceKeysetTelemetry(config: Pick<DeviceConfig, 'serverSigningKeyset'>,
  options: DeviceTelemetryOptions = {}): DeviceKeysetTelemetry {
  const keyset = config.serverSigningKeyset;
  const generation: unknown = keyset ? keyset.generation : null;
  const expiresAt: unknown = keyset ? keyset.expiresAt : null;
  const autostart: unknown = options.relayAutostartEnabled;
  if ((keyset && (typeof generation !== 'number' || !Number.isSafeInteger(generation) || generation < 1
    || typeof expiresAt !== 'string' || !TELEMETRY_INSTANT.test(expiresAt) || Number.isNaN(Date.parse(expiresAt))))
    || (autostart !== undefined && typeof autostart !== 'boolean')) {
    throw new Error('device_keyset_telemetry_invalid');
  }
  return {
    schema: 'dharma.device-keyset-telemetry/v1',
    heldKeysetGeneration: generation as number | null,
    heldKeysetExpiresAt: expiresAt === null ? null : new Date(Date.parse(expiresAt as string)).toISOString(),
    ...(autostart === undefined ? {} : { relayAutostartEnabled: autostart as boolean }),
  };
}

export function isContentBearingPath(pathname: string): boolean {
  return pathname.endsWith('/agent-fabric/trajectories')
    || pathname.endsWith('/agent-fabric/codex-task-exports')
    || pathname.endsWith('/agent-fabric/provider-session-questions')
    || /\/agent-fabric\/evidence-requests\/[^/]+\/responses$/.test(pathname)
    || /\/agent-fabric\/repository-agents\/[^/]+\/package-candidates$/.test(pathname);
}

export function isExplicitlyRebuiltPath(pathname: string): boolean {
  return isContentBearingPath(pathname)
    || pathname.endsWith('/agent-fabric/repository-agents');
}
