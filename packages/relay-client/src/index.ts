import { createHash, createPublicKey, generateKeyPairSync, randomBytes, randomUUID, sign, type JsonWebKey } from 'node:crypto';
import { mkdir, open, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import {
  canonicalize,
  refreshActionDecisionAcknowledgement,
  validateActionDecisionAcknowledgementContract,
  verifyInitialServerSigningKeyset,
  verifyServerSigningKeysetUpdate,
  type ActionDecisionAcknowledgement,
  type ProviderId,
  type TrustedServerSigningKeyset,
} from '@dharma-ai-labs/agent-fabric-contracts';
import { createSystemSecureStore, type SecureSecretStore } from '@dharma-ai-labs/agent-fabric-secure-store';
export type { SecureSecretStore } from '@dharma-ai-labs/agent-fabric-secure-store';

export interface DeviceConfig {
  schema: 'dharma.device-config/v1';
  hqUrl: string;
  organizationId: string;
  deviceId: string;
  deviceName: string;
  platform: 'windows' | 'wsl' | 'macos' | 'linux';
  publicKeyEd25519: string;
  serverPublicKeyEd25519: string;
  serverSigningKeyset?: TrustedServerSigningKeyset;
  relayUrl: string;
  enrolledAt: string;
  evidenceQuotaLedgerInitializedAt?: string;
}

interface PendingRequest {
  method: 'POST';
  pathname: string;
  body: string;
  headers: Record<string, string>;
}

interface ProtocolState {
  schema: 'dharma.protocol-state/v1';
  sessionId: string | null;
  nextSequence: number;
  pending: PendingRequest | null;
  recoveredTaskCompletions?: RecoveredTaskCompletion[];
}

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

function assertProtocolState(value: unknown): asserts value is ProtocolState {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Relay protocol state is invalid.');
  const state = value as Record<string, unknown>;
  const recovered = state.recoveredTaskCompletions;
  const pending = state.pending as Record<string, unknown> | null;
  const pendingValid = pending === null || (
    typeof pending === 'object' && !Array.isArray(pending)
    && pending.method === 'POST'
    && typeof pending.pathname === 'string' && pending.pathname.startsWith('/')
    && typeof pending.body === 'string'
    && pending.headers !== null && typeof pending.headers === 'object' && !Array.isArray(pending.headers)
    && Object.entries(pending.headers as Record<string, unknown>)
      .every(([name, header]) => name.length > 0 && typeof header === 'string')
  );
  if (state.schema !== 'dharma.protocol-state/v1'
    || !(state.sessionId === null || typeof state.sessionId === 'string')
    || !Number.isSafeInteger(state.nextSequence) || Number(state.nextSequence) < 1
    || !pendingValid
    || (recovered !== undefined && (!Array.isArray(recovered)
      || recovered.length > 1_000
      || recovered.some((item) => !isRecoveredTaskCompletion(item))))) {
    throw new Error('Relay protocol state is invalid.');
  }
}

export interface EnrollmentResult {
  verificationUri: string;
  browserCode: string;
  deviceCode: string;
  expiresInSeconds: number;
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

function accountFor(hqUrl: string, organizationId: string) {
  return `device-key-${sha256(`${normalizeHqUrl(hqUrl)}:${organizationId}`).slice(0, 32)}`;
}

function evidenceQuotaAccountFor(hqUrl: string, organizationId: string, deviceId: string) {
  return `evidence-quota-${sha256(`${normalizeHqUrl(hqUrl)}:${organizationId}:${deviceId}`).slice(0, 32)}`;
}

function enrollmentAnchorAccountFor(hqUrl: string, organizationId: string) {
  return `device-enrollment-${sha256(`${normalizeHqUrl(hqUrl)}:${organizationId}`).slice(0, 32)}`;
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

export async function saveDeviceEnrollmentAnchor(input: {
  config: DeviceConfig;
  store?: SecureSecretStore;
}): Promise<DeviceEnrollmentAnchor> {
  const store = input.store ?? await createSystemSecureStore();
  const anchor = enrollmentAnchorFromConfig(input.config);
  const serialized = JSON.stringify(anchor);
  const account = enrollmentAnchorAccountFor(anchor.hqUrl, anchor.organizationId);
  await store.put(account, serialized);
  if (await store.get(account) !== serialized) throw new Error('Secure store did not confirm the enrollment anchor write.');
  return anchor;
}

export async function loadDeviceEnrollmentAnchor(input: {
  config: DeviceConfig;
  store?: SecureSecretStore;
}): Promise<DeviceEnrollmentAnchor> {
  const store = input.store ?? await createSystemSecureStore();
  const account = enrollmentAnchorAccountFor(input.config.hqUrl, input.config.organizationId);
  const serialized = await store.get(account);
  if (!serialized) throw new Error('Device enrollment is not anchored in secure storage. Run dharma login again.');
  const anchor = JSON.parse(serialized) as DeviceEnrollmentAnchor;
  if (!enrollmentAnchorHasBaseIdentity(anchor, input.config)
    || JSON.stringify(anchor.serverSigningKeyset ?? null) !== JSON.stringify(input.config.serverSigningKeyset ?? null)
  ) {
    throw new Error('Device configuration does not match the secure enrollment anchor. Run dharma login again.');
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
}): Promise<ActiveSkillAuthorizationAnchor> {
  if (!/^[0-9a-f-]{36}$/i.test(input.organizationAgentId)
    || !/^[0-9a-f-]{36}$/i.test(input.bundleId) || !/^sha256:[a-f0-9]{64}$/i.test(input.receiptHash)
    || !Number.isFinite(Date.parse(input.activatedAt))
    || (input.expiresAt !== null && !Number.isFinite(Date.parse(input.expiresAt)))) {
    throw new Error('Active skill authorization anchor is invalid.');
  }
  const store = input.store ?? await createSystemSecureStore();
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
  await store.put(account, serialized);
  if (await store.get(account) !== serialized) throw new Error('Secure store did not confirm the active skill anchor write.');
  return anchor;
}

export async function loadActiveSkillAuthorizationAnchor(input: {
  config: Pick<DeviceConfig, 'hqUrl' | 'organizationId' | 'deviceId'>;
  workspaceId: string;
  organizationAgentId: string;
  provider: ProviderId;
  store?: SecureSecretStore;
}): Promise<ActiveSkillAuthorizationAnchor | null> {
  const store = input.store ?? await createSystemSecureStore();
  const serialized = await store.get(activeSkillAnchorAccountFor(input.config, input.workspaceId, input.provider));
  if (!serialized) return null;
  const anchor = JSON.parse(serialized) as ActiveSkillAuthorizationAnchor;
  if (anchor.schema !== 'dharma.active-skill-authorization-anchor/v1'
    || anchor.organizationId !== input.config.organizationId || anchor.deviceId !== input.config.deviceId
    || anchor.organizationAgentId !== input.organizationAgentId
    || !/^[0-9a-f-]{36}$/i.test(anchor.organizationAgentId)
    || anchor.workspaceId !== input.workspaceId || anchor.provider !== input.provider
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
}): Promise<void> {
  const store = input.store ?? await createSystemSecureStore();
  const account = activeSkillAnchorAccountFor(input.config, input.workspaceId, input.provider);
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
}): Promise<EvidenceQuotaAnchor | null> {
  const store = input.store ?? await createSystemSecureStore();
  const value = await store.get(evidenceQuotaAccountFor(
    input.config.hqUrl, input.config.organizationId, input.config.deviceId,
  ));
  if (!value) return null;
  const anchor = JSON.parse(value) as EvidenceQuotaAnchor;
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
}): Promise<void> {
  const store = input.store ?? await createSystemSecureStore();
  const account = evidenceQuotaAccountFor(
    input.config.hqUrl, input.config.organizationId, input.config.deviceId,
  );
  await store.put(account, JSON.stringify(input.anchor));
  const confirmed = await store.get(account);
  if (confirmed !== JSON.stringify(input.anchor)) {
    throw new Error('Secure store did not confirm the evidence quota anchor write.');
  }
}

async function atomicJson(path: string, value: unknown) {
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

  constructor(body: unknown, status: number, definitive: boolean) {
    super(errorMessage(body, status));
    this.name = 'AgentFabricRequestError';
    this.status = status;
    this.definitive = definitive;
  }
}

export function isDefinitiveAgentFabricRejection(error: unknown): boolean {
  return error instanceof AgentFabricRequestError && error.definitive;
}

export async function loadOrCreateDeviceIdentity(input: {
  hqUrl: string;
  organizationId: string;
  store?: SecureSecretStore;
}) {
  const store = input.store ?? await createSystemSecureStore();
  const account = accountFor(input.hqUrl, input.organizationId);
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

export async function saveDeviceConfig(path: string, config: DeviceConfig) {
  await atomicJson(path, { ...config, hqUrl: normalizeHqUrl(config.hqUrl), relayUrl: normalizeRelayUrl(config.relayUrl) });
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

export async function recoverDeviceEnrollmentConsistency(input: {
  configPath: string;
  store?: SecureSecretStore;
  now?: Date;
}): Promise<DeviceConfig> {
  const config = await loadDeviceConfig(input.configPath);
  const store = input.store ?? await createSystemSecureStore();
  const serialized = await store.get(enrollmentAnchorAccountFor(config.hqUrl, config.organizationId));
  if (!serialized) return config;
  const anchor = JSON.parse(serialized) as DeviceEnrollmentAnchor;
  if (!enrollmentAnchorHasBaseIdentity(anchor, config)) {
    throw new Error('Device configuration does not match the secure enrollment anchor. Run dharma login again.');
  }
  if (canonicalize(anchor.serverSigningKeyset ?? null) === canonicalize(config.serverSigningKeyset ?? null)) {
    return config;
  }

  const now = input.now ?? new Date();
  if (anchor.serverSigningKeyset) {
    const verification = verifyKeysetTransition(config, config.serverSigningKeyset, anchor.serverSigningKeyset, now);
    if (verification.ok) {
      const recovered = { ...config, serverSigningKeyset: anchor.serverSigningKeyset };
      await saveDeviceConfig(input.configPath, recovered);
      return recovered;
    }
  }
  if (config.serverSigningKeyset) {
    const verification = verifyKeysetTransition(config, anchor.serverSigningKeyset, config.serverSigningKeyset, now);
    if (verification.ok) {
      await saveDeviceEnrollmentAnchor({ config, store });
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
}): Promise<DeviceConfig> {
  const store = input.store ?? await createSystemSecureStore();
  const config = await recoverDeviceEnrollmentConsistency({ configPath: input.configPath, store, now: input.now });
  const now = input.now ?? new Date();
  if (canonicalize(config.serverSigningKeyset ?? null) === canonicalize(input.candidate)) return config;
  const verification = verifyKeysetTransition(config, config.serverSigningKeyset, input.candidate, now);
  if (!verification.ok) throw new Error(`Server signing keyset was rejected: ${verification.reason}.`);
  const next = { ...config, serverSigningKeyset: input.candidate };
  // The protected anchor is the write-ahead record. If the process stops before
  // the disk configuration is replaced, startup verifies and completes it.
  await saveDeviceEnrollmentAnchor({ config: next, store });
  await saveDeviceConfig(input.configPath, next);
  return next;
}

export async function loadDeviceConfig(path: string): Promise<DeviceConfig> {
  const config = JSON.parse(await readFile(path, 'utf8')) as DeviceConfig;
  if (config.schema !== 'dharma.device-config/v1' || !config.deviceId || !config.organizationId || !config.hqUrl) {
    throw new Error('Device is not enrolled. Run dharma login.');
  }
  return { ...config, hqUrl: normalizeHqUrl(config.hqUrl), relayUrl: normalizeRelayUrl(config.relayUrl) };
}

export class AgentFabricClient {
  readonly config: DeviceConfig;
  readonly #privateJwk: JsonWebKey;
  readonly #statePath: string;
  readonly #configPath: string;
  readonly #store: SecureSecretStore;
  readonly #fetcher: typeof fetch;
  readonly #directTransport: boolean;
  #state: ProtocolState;
  #serial: Promise<unknown> = Promise.resolve();

  private constructor(input: {
    config: DeviceConfig; privateJwk: JsonWebKey; configPath: string; statePath: string;
    state: ProtocolState; store: SecureSecretStore; fetcher?: typeof fetch;
  }) {
    this.config = input.config;
    this.#privateJwk = input.privateJwk;
    this.#configPath = input.configPath;
    this.#store = input.store;
    this.#statePath = input.statePath;
    this.#state = input.state;
    this.#fetcher = input.fetcher || fetch;
    this.#directTransport = Boolean(input.fetcher);
  }

  static async open(input: { configPath: string; statePath: string; store?: SecureSecretStore; fetcher?: typeof fetch }) {
    const store = input.store ?? await createSystemSecureStore();
    const config = await recoverDeviceEnrollmentConsistency({ configPath: input.configPath, store });
    const identity = await loadOrCreateDeviceIdentity({ hqUrl: config.hqUrl, organizationId: config.organizationId, store });
    if (identity.publicKeyEd25519 !== config.publicKeyEd25519) throw new Error('Enrolled device identity does not match the secure store.');
    try {
      await loadDeviceEnrollmentAnchor({ config, store });
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes('not anchored in secure storage')) throw error;
      throw new Error('Legacy device enrollment must be reauthenticated with dharma login before relay access.');
    }
    let state: ProtocolState = {
      schema: 'dharma.protocol-state/v1', sessionId: null, nextSequence: 1, pending: null,
      recoveredTaskCompletions: [],
    };
    try {
      const parsed = JSON.parse(await readFile(input.statePath, 'utf8')) as unknown;
      assertProtocolState(parsed);
      state = parsed;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw new Error('Relay protocol state is invalid; preserve the file for recovery and re-enroll if necessary.', { cause: error });
      }
    }
    state.recoveredTaskCompletions ??= [];
    return new AgentFabricClient({
      config, privateJwk: identity.privateJwk, configPath: input.configPath,
      statePath: input.statePath, state, store, fetcher: input.fetcher,
    });
  }

  async openSession(relayVersion = '0.1.0') {
    if (this.#state.pending && isContentBearingPath(this.#state.pending.pathname)) {
      // Content-bearing requests are never replayed from durable state before
      // the CLI has refreshed consent. A later explicit sync rebuilds and
      // reauthorizes the request; server ingestion is capsule-hash idempotent.
      this.#state.pending = null;
      await this.#persist();
    } else if (this.#state.pending) {
      await this.#sendPending();
    }
    this.#state = {
      schema: 'dharma.protocol-state/v1', sessionId: randomUUID(), nextSequence: 1, pending: null,
      recoveredTaskCompletions: this.#state.recoveredTaskCompletions || [],
    };
    await this.#persist();
    return this.signedPost('/agent-fabric/sessions', {
      connectionId: randomBytes(24).toString('base64url'), durableCursor: null, relayVersion,
    });
  }

  async registerWorkspace(body: unknown) {
    const response = await this.signedPost('/agent-fabric/workspaces', body);
    if (response.serverSigningKeyset !== undefined) {
      const next = await installTrustedServerSigningKeyset({
        configPath: this.#configPath,
        candidate: response.serverSigningKeyset as TrustedServerSigningKeyset,
        store: this.#store,
      });
      Object.assign(this.config, next);
    }
    return response;
  }
  connectRepositoryAgent(body: unknown) { return this.signedPost('/agent-fabric/repository-agents', body); }
  syncTrajectory(body: unknown) { return this.signedPost('/agent-fabric/trajectories', body); }
  pollEvidence(body: { workspaceId: string }) { return this.signedPost('/agent-fabric/evidence-requests/poll', body); }
  postEvidenceResponse(requestId: string, body: unknown) {
    return this.signedPost(`/agent-fabric/evidence-requests/${encodeURIComponent(requestId)}/responses`, body);
  }
  pollTask(leaseSeconds = 120) { return this.signedPost('/agent-fabric/tasks/poll', { leaseSeconds }); }
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
    const operation = this.#serial.then(async () => {
      const current = this.#state.recoveredTaskCompletions || [];
      const matching = current.find((item) => item.taskId === taskId);
      if (!matching) return;
      if (matching.receiptHash !== receiptHash) throw new Error('Recovered task completion receipt does not match.');
      this.#state.recoveredTaskCompletions = current.filter((item) => item.taskId !== taskId);
      await this.#persist();
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

  signedPost(route: string, body: unknown): Promise<Record<string, unknown>> {
    const operation = this.#serial.then(() => this.#signedPostNow(route, body));
    this.#serial = operation.catch(() => undefined);
    return operation;
  }

  async #signedPostNow(route: string, body: unknown): Promise<Record<string, unknown>> {
    if (!this.#state.sessionId) throw new Error('Relay session is not open.');
    if (this.#state.pending && isContentBearingPath(this.#state.pending.pathname)) {
      // An ambiguous content delivery is never replayed implicitly. The next
      // explicit caller must rebuild the capsule after rechecking disclosure
      // policy; a skipped sequence is safe because the server enforces
      // monotonic rather than contiguous device sequences.
      this.#state.nextSequence += 1;
      this.#state.pending = null;
      await this.#persist();
    } else if (this.#state.pending) {
      return this.#sendPending();
    }
    const pathname = `/api/v1/orgs/${encodeURIComponent(this.config.organizationId)}${route}`;
    const serialized = canonicalize(body);
    const timestamp = new Date().toISOString();
    const messageId = randomUUID();
    const nonce = randomBytes(24).toString('base64url');
    const sequence = this.#state.nextSequence;
    const signingPayload = Buffer.from(JSON.stringify({
      bodyHash: `sha256:${sha256(serialized)}`, deviceId: this.config.deviceId, messageId,
      method: 'POST', nonce, organizationId: this.config.organizationId, pathname,
      sequence, sessionId: this.#state.sessionId, timestamp,
    }), 'utf8');
    const signature = sign(null, signingPayload, { key: this.#privateJwk, format: 'jwk' }).toString('base64url');
    const pending: PendingRequest = {
      method: 'POST', pathname, body: serialized,
      headers: {
        'content-type': 'application/json', 'x-dharma-device-id': this.config.deviceId,
        'x-dharma-session-id': this.#state.sessionId, 'x-dharma-message-id': messageId,
        'x-dharma-timestamp': timestamp, 'x-dharma-nonce': nonce,
        'x-dharma-sequence': String(sequence), 'x-dharma-signature': signature,
      },
    };
    this.#assertRecoveredTaskCompletionCapacity(pending);
    this.#state.pending = pending;
    await this.#persist();
    return this.#sendPending();
  }

  async #sendPending(): Promise<Record<string, unknown>> {
    const pending = this.#state.pending;
    if (!pending) throw new Error('No pending protocol request.');
    try {
      this.#assertRecoveredTaskCompletionCapacity(pending);
    } catch (error) {
      this.#state.nextSequence += 1;
      this.#state.pending = null;
      await this.#persist();
      throw error;
    }
    if (/\/agent-fabric\/decisions\/[^/]+\/enforcements$/.test(pending.pathname)) {
      let acknowledgement: ActionDecisionAcknowledgement;
      try {
        acknowledgement = JSON.parse(pending.body) as ActionDecisionAcknowledgement;
      } catch {
        acknowledgement = {} as ActionDecisionAcknowledgement;
      }
      const contract = validateActionDecisionAcknowledgementContract(acknowledgement);
      if (!contract.ok) {
        this.#state.nextSequence = Math.max(
          this.#state.nextSequence + 1,
          Number(pending.headers['x-dharma-sequence'] || 0) + 1,
        );
        this.#state.pending = null;
        await this.#persist();
        throw new Error('Stale action acknowledgement is invalid and was discarded.');
      }
      const acknowledgedAt = Date.parse(acknowledgement.acknowledgedAt);
      if (!Number.isFinite(acknowledgedAt)
        || Date.now() - acknowledgedAt > 8 * 60_000
        || acknowledgedAt > Date.now() + 5 * 60_000) {
        const refreshed = refreshActionDecisionAcknowledgement(acknowledgement);
        const sequence = Number(pending.headers['x-dharma-sequence'] || 0) + 1;
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
        this.#state.nextSequence = sequence;
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
      const response = await this.#fetcher(`${this.config.hqUrl.replace(/\/$/, '')}${pending.pathname}`, {
        method: pending.method, headers: pending.headers, body: pending.body,
      });
      status = response.status;
      body = await response.json() as Record<string, unknown>;
    } else {
      const response = await this.#sendViaRelay(pending);
      status = response.status;
      try { body = JSON.parse(response.body) as Record<string, unknown>; }
      catch { body = { ok: false, error: { code: 'invalid_relay_response', message: 'Relay returned invalid JSON.' } }; }
    }
    if (status < 200 || status >= 300) {
      // A deterministic client rejection is an acknowledgement, not an unknown
      // delivery outcome. Retaining it would permanently block the device
      // outbox. Retryable timeout and throttling responses keep the exact
      // signed request, as do upstream failures whose commit state is unknown.
      const definitive = status >= 400 && status < 500 && status !== 408 && status !== 429;
      if (definitive) {
        this.#state.nextSequence += 1;
        this.#state.pending = null;
        await this.#persist();
      }
      throw new AgentFabricRequestError(body, status, definitive);
    }
    this.#recordRecoveredTaskCompletion(pending, body);
    this.#state.nextSequence += 1;
    this.#state.pending = null;
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
    const receiptHash = String(receipt?.hash || '');
    if (!/^[0-9a-f-]{36}$/i.test(taskId)
      || !/^sha256:[a-f0-9]{64}$/.test(trajectoryCapsuleHash)) {
      throw new Error('Task completion request is missing its durable evidence identity.');
    }
    if (!/^sha256:[a-f0-9]{64}$/.test(receiptHash)) {
      throw new Error('Task completion acknowledgement is missing a valid durable receipt.');
    }
    const current = this.#state.recoveredTaskCompletions || [];
    const existing = current.find((item) => item.taskId === taskId);
    if (existing) {
      if (existing.receiptHash !== receiptHash || existing.trajectoryCapsuleHash !== trajectoryCapsuleHash) {
        throw new Error('Recovered task completion conflicts with its durable receipt.');
      }
      return;
    }
    if (current.length >= 1_000) throw new Error('Recovered task completion queue is full.');
    this.#state.recoveredTaskCompletions = [
      ...current,
      { taskId, trajectoryCapsuleHash, receiptHash, recoveredAt: new Date().toISOString() },
    ];
  }

  #assertRecoveredTaskCompletionCapacity(pending: PendingRequest): void {
    const route = pending.pathname.match(/\/agent-fabric\/tasks\/([^/]+)\/events$/);
    if (!route) return;
    let request: Record<string, unknown>;
    try { request = JSON.parse(pending.body) as Record<string, unknown>; } catch { return; }
    if (request.eventType !== 'completed') return;
    const taskId = decodeURIComponent(route[1]!);
    const current = this.#state.recoveredTaskCompletions || [];
    if (!current.some((item) => item.taskId === taskId) && current.length >= 1_000) {
      throw new Error('Recovered task completion queue is full; acknowledge stored completions before sending another completion.');
    }
  }

  #sendViaRelay(pending: PendingRequest): Promise<{ status: number; body: string }> {
    return new Promise((accept, reject) => {
      const relay = new URL(normalizeRelayUrl(this.config.relayUrl));
      relay.pathname = '/v1/connect';
      relay.search = '';
      const socket = new WebSocket(relay);
      let settled = false;
      const finish = (callback: () => void, closeSocket = true) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        callback();
        if (closeSocket && socket.readyState < WebSocket.CLOSING) socket.close(1000);
      };
      const timeout = setTimeout(
        () => finish(() => reject(new Error('Relay response timed out.'))),
        35_000,
      );
      socket.addEventListener('open', () => socket.send(JSON.stringify({
        requestId: pending.headers['x-dharma-message-id'], method: pending.method,
        pathname: pending.pathname, headers: pending.headers, body: pending.body,
      })));
      socket.addEventListener('message', (event) => {
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

  #persist() {
    // Authorized trajectory bodies may contain customer content. Keep an
    // in-flight request in memory, but never copy that body into the plaintext
    // protocol-state outbox. The encrypted local vault remains the durable
    // source from which an explicitly authorized retry is rebuilt.
    const durableState = this.#state.pending && isContentBearingPath(this.#state.pending.pathname)
      ? { ...this.#state, nextSequence: this.#state.nextSequence + 1, pending: null }
      : this.#state;
    return atomicJson(this.#statePath, durableState);
  }
}

export function isContentBearingPath(pathname: string): boolean {
  return pathname.endsWith('/agent-fabric/trajectories')
    || /\/agent-fabric\/evidence-requests\/[^/]+\/responses$/.test(pathname);
}
