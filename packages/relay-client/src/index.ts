import { createHash, generateKeyPairSync, randomBytes, randomUUID, sign, type JsonWebKey } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { canonicalize, type ProviderId } from '@dharma-ai-labs/agent-fabric-contracts';
import { createSystemSecureStore, type SecureSecretStore } from '@dharma-ai-labs/agent-fabric-secure-store';

export interface DeviceConfig {
  schema: 'dharma.device-config/v1';
  hqUrl: string;
  organizationId: string;
  deviceId: string;
  deviceName: string;
  platform: 'windows' | 'wsl' | 'macos' | 'linux';
  publicKeyEd25519: string;
  serverPublicKeyEd25519: string;
  relayUrl: string;
  enrolledAt: string;
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

async function atomicJson(path: string, value: unknown) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, path);
}

function errorMessage(body: unknown, status: number) {
  if (body && typeof body === 'object') {
    const record = body as { error?: { code?: string; message?: string } };
    if (record.error?.message) return `${record.error.code || 'request_failed'}: ${record.error.message}`;
  }
  return `Dharma HQ request failed with HTTP ${status}.`;
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
  readonly #fetcher: typeof fetch;
  readonly #directTransport: boolean;
  #state: ProtocolState;
  #serial: Promise<unknown> = Promise.resolve();

  private constructor(input: { config: DeviceConfig; privateJwk: JsonWebKey; statePath: string; state: ProtocolState; fetcher?: typeof fetch }) {
    this.config = input.config;
    this.#privateJwk = input.privateJwk;
    this.#statePath = input.statePath;
    this.#state = input.state;
    this.#fetcher = input.fetcher || fetch;
    this.#directTransport = Boolean(input.fetcher);
  }

  static async open(input: { configPath: string; statePath: string; store?: SecureSecretStore; fetcher?: typeof fetch }) {
    const config = await loadDeviceConfig(input.configPath);
    const identity = await loadOrCreateDeviceIdentity({ hqUrl: config.hqUrl, organizationId: config.organizationId, store: input.store });
    if (identity.publicKeyEd25519 !== config.publicKeyEd25519) throw new Error('Enrolled device identity does not match the secure store.');
    let state: ProtocolState = { schema: 'dharma.protocol-state/v1', sessionId: null, nextSequence: 1, pending: null };
    try { state = JSON.parse(await readFile(input.statePath, 'utf8')) as ProtocolState; } catch {}
    return new AgentFabricClient({ config, privateJwk: identity.privateJwk, statePath: input.statePath, state, fetcher: input.fetcher });
  }

  async openSession(relayVersion = '0.1.0') {
    if (this.#state.pending) await this.#sendPending();
    this.#state = { schema: 'dharma.protocol-state/v1', sessionId: randomUUID(), nextSequence: 1, pending: null };
    await this.#persist();
    return this.signedPost('/agent-fabric/sessions', {
      connectionId: randomBytes(24).toString('base64url'), durableCursor: null, relayVersion,
    });
  }

  registerWorkspace(body: unknown) { return this.signedPost('/agent-fabric/workspaces', body); }
  syncTrajectory(body: unknown) { return this.signedPost('/agent-fabric/trajectories', body); }
  pollEvidence(body: { workspaceId: string }) { return this.signedPost('/agent-fabric/evidence-requests/poll', body); }
  postEvidenceResponse(requestId: string, body: unknown) {
    return this.signedPost(`/agent-fabric/evidence-requests/${encodeURIComponent(requestId)}/responses`, body);
  }
  pollTask(leaseSeconds = 120) { return this.signedPost('/agent-fabric/tasks/poll', { leaseSeconds }); }
  postTaskEvent(taskId: string, eventType: string, payload: unknown) {
    return this.signedPost(`/agent-fabric/tasks/${encodeURIComponent(taskId)}/events`, { eventType, payload });
  }
  pollSkill(body: { workspaceId: string; provider: ProviderId; installedBundleId: string | null }) {
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
    if (this.#state.pending) return this.#sendPending();
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
    this.#state.pending = {
      method: 'POST', pathname, body: serialized,
      headers: {
        'content-type': 'application/json', 'x-dharma-device-id': this.config.deviceId,
        'x-dharma-session-id': this.#state.sessionId, 'x-dharma-message-id': messageId,
        'x-dharma-timestamp': timestamp, 'x-dharma-nonce': nonce,
        'x-dharma-sequence': String(sequence), 'x-dharma-signature': signature,
      },
    };
    await this.#persist();
    return this.#sendPending();
  }

  async #sendPending(): Promise<Record<string, unknown>> {
    const pending = this.#state.pending;
    if (!pending) throw new Error('No pending protocol request.');
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
      if (status >= 400 && status < 500 && status !== 408 && status !== 429) {
        this.#state.nextSequence += 1;
        this.#state.pending = null;
        await this.#persist();
      }
      throw new Error(errorMessage(body, status));
    }
    this.#state.nextSequence += 1;
    this.#state.pending = null;
    await this.#persist();
    return body;
  }

  #sendViaRelay(pending: PendingRequest): Promise<{ status: number; body: string }> {
    return new Promise((accept, reject) => {
      const relay = new URL(normalizeRelayUrl(this.config.relayUrl));
      relay.pathname = '/v1/connect';
      relay.search = '';
      const socket = new WebSocket(relay);
      const timeout = setTimeout(() => { socket.close(); reject(new Error('Relay response timed out.')); }, 35_000);
      const finish = (callback: () => void) => { clearTimeout(timeout); socket.close(); callback(); };
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
        if (event.code !== 1000) { clearTimeout(timeout); reject(new Error(`Relay closed before acknowledgement (${event.code}).`)); }
      });
    });
  }

  #persist() { return atomicJson(this.#statePath, this.#state); }
}
