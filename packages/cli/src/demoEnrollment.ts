import { createHash, randomBytes, randomUUID, sign, type JsonWebKey } from 'node:crypto';
import { chmod, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { loadOrCreateDeviceIdentity, normalizeHqUrl, type SecureSecretStore } from '@dharma-ai-labs/agent-fabric-relay-client';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CODE = /^[A-Za-z0-9_-]{43}$/;
const BROWSER_CODE = /^[0-9A-F]{20}$/;

export interface DemoDeviceConnectOptions {
  hqUrl: string;
  organizationId: string;
  repositoryId: string;
  normalizedRepository: string;
  installationId: string;
  grant: string;
  deviceName: string;
  platform: 'windows' | 'wsl' | 'macos' | 'linux';
  stateRoot: string;
  maximumWaitMs?: number;
}

export type DemoDeviceScope = Pick<DemoDeviceConnectOptions,
  'hqUrl' | 'organizationId' | 'repositoryId' | 'normalizedRepository' | 'installationId' | 'stateRoot'>;

interface DemoDeviceConfig {
  schema: 'dharma.demo-device/v1';
  hqUrl: string;
  organizationId: string;
  repositoryId: string;
  normalizedRepository: string;
  installationId: string;
  deviceId: string;
  publicKeyEd25519: string;
  enrolledAt: string;
  signedReady: boolean;
  nextSequence: number;
}

export interface DemoDeviceConnectDependencies {
  store?: SecureSecretStore;
  fetcher?: typeof fetch;
  sleep?: (milliseconds: number) => Promise<void>;
  onApprovalRequired?: (url: string) => Promise<void>;
  expectedAcceptedSequence?: number;
}

function assertInput(input: DemoDeviceConnectOptions) {
  if (!/^org_[A-Za-z0-9]+$/.test(input.organizationId)
    || !UUID.test(input.repositoryId) || !UUID.test(input.installationId)
    || !CODE.test(input.grant) || input.deviceName.trim().length < 2
    || input.deviceName.length > 120 || !input.normalizedRepository
    || !['windows', 'wsl', 'macos', 'linux'].includes(input.platform)) {
    throw new Error('Demo device setup context is invalid. Copy a fresh repository-specific prompt.');
  }
}

class DemoDeviceApiError extends Error {
  constructor(readonly code: string, message: string) {
    super(`${code}: ${message}`);
  }
}

function apiError(body: unknown, status: number) {
  const item = body && typeof body === 'object' ? body as Record<string, unknown> : {};
  const nested = item.error && typeof item.error === 'object' && !Array.isArray(item.error)
    ? item.error as Record<string, unknown> : null;
  const code = typeof nested?.code === 'string' ? nested.code
    : typeof item.error === 'string' ? item.error : `http_${status}`;
  const message = typeof nested?.message === 'string' ? nested.message
    : typeof item.message === 'string' ? item.message : 'Demo device request failed.';
  return new DemoDeviceApiError(code, message);
}

async function readJsonResponse(response: Response) {
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) throw apiError(body, response.status);
  if (!body || typeof body !== 'object' || Array.isArray(body)
    || (body as Record<string, unknown>).ok !== true) {
    throw new Error('Demo device response is not a JSON object.');
  }
  return body as Record<string, unknown>;
}

export function scopePath(input: DemoDeviceScope, origin: string) {
  const scope = createHash('sha256').update(`${origin}\0${input.organizationId}\0${input.repositoryId}`)
    .digest('hex').slice(0, 32);
  return resolve(input.stateRoot, 'demo', scope, 'device.json');
}

async function writePrivateJson(path: string, value: unknown) {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600, flag: 'wx' });
  await rename(temporary, path);
  if (process.platform !== 'win32') await chmod(path, 0o600);
}

function approvalUri(value: unknown, origin: string, input: DemoDeviceConnectOptions) {
  if (typeof value !== 'string') throw new Error('Demo device verification origin is missing.');
  let url: URL;
  try { url = new URL(value); }
  catch { throw new Error('Demo device verification origin is invalid.'); }
  if (url.origin !== origin || url.pathname !== '/demo/fabric/approve'
    || url.username || url.password || url.hash || url.searchParams.size !== 3
    || url.searchParams.getAll('orgId').length !== 1
    || url.searchParams.getAll('repositoryId').length !== 1
    || url.searchParams.getAll('code').length !== 1
    || url.searchParams.get('orgId') !== input.organizationId
    || url.searchParams.get('repositoryId') !== input.repositoryId
    || !BROWSER_CODE.test(url.searchParams.get('code') || '')) {
    throw new Error('Demo device verification origin or repository scope is invalid.');
  }
  return url.toString();
}

function signedStatusRequest(origin: string, input: DemoDeviceScope,
  deviceId: string, privateJwk: JsonWebKey, sequence: number) {
  const url = new URL(`/api/demo/fabric/repositories/${input.repositoryId}/status`, origin);
  url.searchParams.set('orgId', input.organizationId);
  const sessionId = randomUUID();
  const messageId = randomUUID();
  const timestamp = new Date().toISOString();
  const nonce = randomBytes(24).toString('base64url');
  const payload = Buffer.from(JSON.stringify({
    bodyHash: `sha256:${createHash('sha256').update('').digest('hex')}`,
    deviceId, messageId, method: 'GET', nonce,
    organizationId: input.organizationId,
    pathname: `${url.pathname}${url.search}`, sequence, sessionId, timestamp,
  }));
  const signature = sign(null, payload, { key: privateJwk, format: 'jwk' }).toString('base64url');
  return { url: url.toString(), deviceId, sequence, createdAt: timestamp, headers: {
    'x-dharma-device-id': deviceId,
    'x-dharma-session-id': sessionId,
    'x-dharma-message-id': messageId,
    'x-dharma-timestamp': timestamp,
    'x-dharma-nonce': nonce,
    'x-dharma-sequence': String(sequence),
    'x-dharma-signature': signature,
  } };
}

export async function verifyDemoDevice(input: DemoDeviceScope,
  deps: Pick<DemoDeviceConnectDependencies, 'store' | 'fetcher' | 'expectedAcceptedSequence'> = {}) {
  const origin = normalizeHqUrl(input.hqUrl);
  const configPath = scopePath(input, origin);
  const pendingPath = `${configPath}.pending-status.json`;
  const config = JSON.parse(await readFile(configPath, 'utf8')) as DemoDeviceConfig;
  if (config.schema !== 'dharma.demo-device/v1' || config.hqUrl !== origin
    || config.organizationId !== input.organizationId || config.repositoryId !== input.repositoryId
    || config.normalizedRepository !== input.normalizedRepository
    || config.installationId !== input.installationId || !UUID.test(config.deviceId)
    || !Number.isSafeInteger(config.nextSequence) || config.nextSequence < 1) {
    throw new Error('Demo device config does not match the requested repository and installation.');
  }
  const identity = await loadOrCreateDeviceIdentity({ hqUrl: origin,
    organizationId: `${input.organizationId}:${input.repositoryId}`,
    installationId: input.installationId, store: deps.store });
  if (config.publicKeyEd25519 !== identity.publicKeyEd25519) {
    throw new Error('Demo device key does not match its protected local identity.');
  }
  let hasPending = false;
  let pending = signedStatusRequest(origin, input, config.deviceId,
    identity.privateJwk, config.nextSequence);
  try {
    const existing = JSON.parse(await readFile(pendingPath, 'utf8')) as typeof pending;
    if (existing.deviceId !== config.deviceId || existing.url !== pending.url
      || !Number.isSafeInteger(existing.sequence) || existing.sequence < config.nextSequence
      || !Number.isFinite(Date.parse(existing.createdAt))) {
      throw new Error('Pending Demo device status does not match this identity.');
    }
    hasPending = true;
    pending = Date.now() - Date.parse(existing.createdAt) < 4 * 60_000
      ? existing
      : signedStatusRequest(origin, input, config.deviceId,
        identity.privateJwk, existing.sequence);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw new Error('Pending Demo device status is invalid; preserve it for recovery.', { cause: error });
    }
  }
  const requestStatus = async () => {
    await writePrivateJson(pendingPath, pending);
    return readJsonResponse(await (deps.fetcher || fetch)(pending.url, {
      method: 'GET', headers: pending.headers,
    }));
  };
  let status: Record<string, unknown> | null = null;
  try {
    status = await requestStatus();
  } catch (error) {
    if ((!hasPending && deps.expectedAcceptedSequence !== pending.sequence)
      || !(error instanceof DemoDeviceApiError)
      || error.code !== 'demo_fabric_sequence_out_of_order') throw error;
    const candidates = [pending.sequence - 1, pending.sequence + 1]
      .filter((sequence) => sequence >= config.nextSequence);
    let recovered = false;
    for (const sequence of candidates) {
      pending = signedStatusRequest(origin, input, config.deviceId, identity.privateJwk, sequence);
      try {
        status = await requestStatus();
        recovered = true;
        break;
      } catch (candidateError) {
        if (!(candidateError instanceof DemoDeviceApiError)
          || candidateError.code !== 'demo_fabric_sequence_out_of_order') throw candidateError;
      }
    }
    if (!recovered) throw error;
  }
  if (!status || status.organizationId !== input.organizationId || status.repositoryId !== input.repositoryId
    || status.deviceId !== config.deviceId || status.normalizedRepository !== input.normalizedRepository) {
    throw new Error('Signed Demo status did not confirm the exact repository and device.');
  }
  config.signedReady = true;
  config.nextSequence = pending.sequence + 1;
  await writePrivateJson(configPath, config);
  await unlink(pendingPath).catch(() => {});
  return { ok: true as const, stage: 'device_signed_ready' as const,
    organizationId: input.organizationId, repositoryId: input.repositoryId,
    normalizedRepository: input.normalizedRepository, deviceId: config.deviceId,
    configPath, repositoryPackageState: 'not_connected' as const };
}

export async function connectDemoDevice(input: DemoDeviceConnectOptions,
  deps: DemoDeviceConnectDependencies = {}) {
  assertInput(input);
  const origin = normalizeHqUrl(input.hqUrl);
  const fetcher = deps.fetcher || fetch;
  const sleep = deps.sleep || ((milliseconds: number) => new Promise<void>((accept) => setTimeout(accept, milliseconds)));
  const identity = await loadOrCreateDeviceIdentity({ hqUrl: origin,
    organizationId: `${input.organizationId}:${input.repositoryId}`,
    installationId: input.installationId, store: deps.store });
  const started = await readJsonResponse(await fetcher(`${origin}/api/demo/fabric/enrollments`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ orgId: input.organizationId, repositoryId: input.repositoryId,
      grant: input.grant, name: input.deviceName.trim(), platform: input.platform,
      publicKeyEd25519: identity.publicKeyEd25519 }),
  }));
  if (started.organizationId !== input.organizationId || started.repositoryId !== input.repositoryId
    || !CODE.test(String(started.deviceCode || '')) || !Number.isFinite(Date.parse(String(started.expiresAt || '')))) {
    throw new Error('Demo enrollment response does not match the requested repository.');
  }
  const verificationUri = approvalUri(started.verificationUri, origin, input);
  if (started.status === 'pending') await deps.onApprovalRequired?.(verificationUri);
  const deadline = Math.min(Date.parse(String(started.expiresAt)),
    Date.now() + Math.min(Math.max(input.maximumWaitMs ?? 10 * 60_000, 1_000), 15 * 60_000));
  let deviceId = '';
  while (Date.now() < deadline) {
    const polled = await readJsonResponse(await fetcher(`${origin}/api/demo/fabric/enrollments/poll`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ orgId: input.organizationId, deviceCode: started.deviceCode }),
    }));
    if (polled.status === 'approved') {
      if (polled.repositoryId !== input.repositoryId || !UUID.test(String(polled.deviceId || ''))) {
        throw new Error('Approved Demo device does not match the requested repository.');
      }
      deviceId = String(polled.deviceId);
      break;
    }
    if (polled.status !== 'pending') throw new Error(`Demo device approval ended: ${String(polled.status || 'unknown')}.`);
    await sleep(Math.min(2_000, Math.max(0, deadline - Date.now())));
  }
  if (!deviceId) throw new Error('Demo device approval timed out. Resume from the same prompt while its grant is valid.');
  const configPath = scopePath(input, origin);
  try {
    const existing = JSON.parse(await readFile(configPath, 'utf8')) as DemoDeviceConfig;
    if (existing.deviceId !== deviceId || existing.publicKeyEd25519 !== identity.publicKeyEd25519) {
      throw new Error('Existing Demo device belongs to another approved identity.');
    }
    return verifyDemoDevice(input, deps);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  await writePrivateJson(configPath, { schema: 'dharma.demo-device/v1',
    hqUrl: origin, organizationId: input.organizationId, repositoryId: input.repositoryId,
    normalizedRepository: input.normalizedRepository, installationId: input.installationId,
    deviceId, publicKeyEd25519: identity.publicKeyEd25519,
    enrolledAt: new Date().toISOString(), signedReady: false, nextSequence: 1 });
  return verifyDemoDevice(input, deps);
}
