import { createHash, createPublicKey, randomBytes, randomUUID, sign, verify, type JsonWebKey } from 'node:crypto';
import { chmod, lstat, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { loadOrCreateDeviceIdentity, normalizeHqUrl, type SecureSecretStore } from '@dharma-ai-labs/agent-fabric-relay-client';
import { verifyInitialServerSigningKeyset, type TrustedServerSigningKeyset } from '@dharma-ai-labs/agent-fabric-contracts';
import { acceptDemoSigningUpdate, recoverDemoSigningEnrollment, resolveDemoSigningTrust, type DemoSigningDependencies } from './demoSigningTrust.js';

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
  serverPublicKeyEd25519?: string;
  serverSigningKeyset?: TrustedServerSigningKeyset;
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
  constructor(readonly code: string, message: string, readonly status: number) {
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
  return new DemoDeviceApiError(code, message, status);
}

function transientPollFailure(error: unknown) {
  return error instanceof TypeError
    || (error instanceof DemoDeviceApiError
      && (error.status === 429 || error.status >= 500));
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

export async function loadDemoSigningTrust(input: DemoDeviceScope, deps: DemoSigningDependencies = {}) {
  const origin = normalizeHqUrl(input.hqUrl);
  const configPath = scopePath(input, origin);
  const config = JSON.parse(await readFile(configPath, 'utf8')) as DemoDeviceConfig;
  if (config.schema !== 'dharma.demo-device/v1' || !config.signedReady
    || config.hqUrl !== origin || !UUID.test(config.deviceId)
    || config.organizationId !== input.organizationId || config.repositoryId !== input.repositoryId
    || config.normalizedRepository !== input.normalizedRepository
    || config.installationId !== input.installationId
    || !/^[A-Za-z0-9_-]{43}$/.test(config.serverPublicKeyEd25519 || '')
    || !config.serverSigningKeyset) {
    throw new Error('Demo signing trust is not pinned to this approved device. Re-enroll through browser approval.');
  }
  const identity = await loadOrCreateDeviceIdentity({ hqUrl: origin,
    organizationId: `${input.organizationId}:${input.repositoryId}`,
    installationId: input.installationId, store: deps.store });
  if (config.publicKeyEd25519 !== identity.publicKeyEd25519) {
    throw new Error('Demo signing trust does not match its protected device identity.');
  }
  const trusted = await resolveDemoSigningTrust(config, deps);
  if (trusted.serverPublicKeyEd25519 !== config.serverPublicKeyEd25519
    || JSON.stringify(trusted.serverSigningKeyset) !== JSON.stringify(config.serverSigningKeyset)) {
    await writePrivateJson(configPath, trusted);
  }
  const publicKey = createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519',
    x: trusted.serverPublicKeyEd25519 }, format: 'jwk' });
  return { publicKey, keyset: trusted.serverSigningKeyset!, deviceId: config.deviceId };
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
  deviceId: string, privateJwk: JsonWebKey, sequence: number, signingGeneration?: number) {
  const url = new URL(`/api/demo/fabric/repositories/${input.repositoryId}/status`, origin);
  url.searchParams.set('orgId', input.organizationId);
  if (signingGeneration !== undefined) url.searchParams.set('signingGeneration', String(signingGeneration));
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

function authenticCompletedStatus(request: ReturnType<typeof signedStatusRequest>, publicKeyEd25519: string) {
  try {
    const fields = ['url', 'deviceId', 'sequence', 'createdAt', 'headers'];
    const headerFields = ['x-dharma-device-id', 'x-dharma-session-id', 'x-dharma-message-id',
      'x-dharma-timestamp', 'x-dharma-nonce', 'x-dharma-sequence', 'x-dharma-signature'];
    const headers = request.headers;
    if (Object.keys(request).length !== fields.length || Object.keys(request).some(key => !fields.includes(key))
      || Object.keys(headers).length !== headerFields.length || Object.keys(headers).some(key => !headerFields.includes(key))
      || headers['x-dharma-device-id'] !== request.deviceId
      || headers['x-dharma-sequence'] !== String(request.sequence)
      || headers['x-dharma-timestamp'] !== request.createdAt
      || !UUID.test(headers['x-dharma-session-id']) || !UUID.test(headers['x-dharma-message-id'])
      || !/^[A-Za-z0-9_-]{32}$/.test(headers['x-dharma-nonce'])
      || !/^[A-Za-z0-9_-]{86}$/.test(headers['x-dharma-signature'])) return false;
    const url = new URL(request.url);
    if (url.toString() !== request.url) return false;
    const payload = Buffer.from(JSON.stringify({
      bodyHash: `sha256:${createHash('sha256').update('').digest('hex')}`,
      deviceId: request.deviceId, messageId: headers['x-dharma-message-id'], method: 'GET',
      nonce: headers['x-dharma-nonce'], organizationId: url.searchParams.get('orgId'),
      pathname: `${url.pathname}${url.search}`, sequence: request.sequence,
      sessionId: headers['x-dharma-session-id'], timestamp: request.createdAt,
    }));
    return verify(null, payload, createPublicKey({
      key: { kty: 'OKP', crv: 'Ed25519', x: publicKeyEd25519 }, format: 'jwk',
    }), Buffer.from(headers['x-dharma-signature'], 'base64url'));
  } catch { return false; }
}

async function preserveCompletedStatus(configPath: string, bytes: string) {
  const directory = `${configPath}.status-history`;
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const directoryStat = await lstat(directory);
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
    throw new Error('Completed Demo status history directory is invalid.');
  }
  if (process.platform !== 'win32') await chmod(directory, 0o700);
  const hash = createHash('sha256').update(bytes).digest('hex');
  const path = resolve(directory, `${hash}.json`);
  try { await writeFile(path, bytes, { mode: 0o600, flag: 'wx' }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    const existing = await lstat(path);
    if (!existing.isFile() || existing.isSymbolicLink() || existing.size !== Buffer.byteLength(bytes)
      || await readFile(path, 'utf8') !== bytes) {
      throw new Error('Completed Demo status history conflicts with the original receipt.');
    }
  }
  if (process.platform !== 'win32') await chmod(path, 0o600);
}

export async function verifyDemoDevice(input: DemoDeviceScope,
  deps: Pick<DemoDeviceConnectDependencies, 'store' | 'fetcher' | 'expectedAcceptedSequence'> = {}) {
  const origin = normalizeHqUrl(input.hqUrl);
  const configPath = scopePath(input, origin);
  const pendingPath = `${configPath}.pending-status.json`;
  let config = JSON.parse(await readFile(configPath, 'utf8')) as DemoDeviceConfig;
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
  if (config.serverSigningKeyset) config = await resolveDemoSigningTrust(config, { store: deps.store });
  let hasPending = false;
  let existingReceiptRead = false;
  let pending = signedStatusRequest(origin, input, config.deviceId,
    identity.privateJwk, config.nextSequence, config.serverSigningKeyset?.generation);
  try {
    const existingBytes = await readFile(pendingPath, 'utf8');
    existingReceiptRead = true;
    const existing = JSON.parse(existingBytes) as typeof pending;
    const existingUrl = new URL(existing.url);
    existingUrl.searchParams.delete('signingGeneration');
    const expectedUrl = new URL(pending.url);
    expectedUrl.searchParams.delete('signingGeneration');
    if (existing.deviceId !== config.deviceId || existingUrl.toString() !== expectedUrl.toString()
      || !Number.isSafeInteger(existing.sequence) || existing.sequence < 1
      || !Number.isFinite(Date.parse(existing.createdAt))) {
      throw new Error('Pending Demo device status does not match this identity.');
    }
    if (existing.sequence < config.nextSequence) {
      // A committed status can survive a crash before cleanup; never replay it or discard its receipt.
      if (!config.signedReady || existing.sequence + 1 !== config.nextSequence
        || !authenticCompletedStatus(existing, config.publicKeyEd25519)) {
        throw new Error('Pending Demo device status does not match this identity.');
      }
      await preserveCompletedStatus(configPath, existingBytes);
    } else {
      hasPending = true;
      pending = Date.now() - Date.parse(existing.createdAt) < 4 * 60_000 && existing.url === pending.url
        ? existing
        : signedStatusRequest(origin, input, config.deviceId,
          identity.privateJwk, existing.sequence, config.serverSigningKeyset?.generation);
    }
  } catch (error) {
    if (existingReceiptRead || (error as NodeJS.ErrnoException).code !== 'ENOENT') {
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
      pending = signedStatusRequest(origin, input, config.deviceId, identity.privateJwk, sequence,
        config.serverSigningKeyset?.generation);
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
  // Sequence consumption is saved even when a delivered trust update is rejected.
  // No acknowledgement or package activation occurs until protected storage confirms it.
  if (status.signingTrustUpdate !== undefined) {
    config = await acceptDemoSigningUpdate(config, status.signingTrustUpdate, { store: deps.store });
    await writePrivateJson(configPath, config);
  }
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
  let serverPublicKeyEd25519 = '';
  let serverSigningKeyset: TrustedServerSigningKeyset | undefined;
  let signingTrustUpdate: unknown;
  let enrollmentApproval: unknown;
  let transientFailures = 0;
  while (Date.now() < deadline) {
    let polled: Record<string, unknown>;
    try {
      polled = await readJsonResponse(await fetcher(`${origin}/api/demo/fabric/enrollments/poll`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ orgId: input.organizationId, deviceCode: started.deviceCode }),
      }));
    } catch (error) {
      if (!transientPollFailure(error)) throw error;
      transientFailures += 1;
      if (transientFailures >= 3) {
        throw new Error('Demo device polling failed after 3 transient attempts. Resume with the same prompt while its grant is valid.',
          { cause: error });
      }
      await sleep(Math.min(2_000, Math.max(0, deadline - Date.now())));
      continue;
    }
    transientFailures = 0;
    if (polled.status === 'approved') {
      if (polled.repositoryId !== input.repositoryId || !UUID.test(String(polled.deviceId || ''))) {
        throw new Error('Approved Demo device does not match the requested repository.');
      }
      deviceId = String(polled.deviceId);
      serverPublicKeyEd25519 = String(polled.serverPublicKeyEd25519 || '');
      if (!/^[A-Za-z0-9_-]{43}$/.test(serverPublicKeyEd25519) || !polled.serverSigningKeyset) {
        throw new Error('Approved Demo enrollment did not include server signing trust.');
      }
      serverSigningKeyset = polled.serverSigningKeyset as TrustedServerSigningKeyset;
      const verification = verifyInitialServerSigningKeyset(serverSigningKeyset,
        createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: serverPublicKeyEd25519 }, format: 'jwk' }),
        input.organizationId);
      if (!verification.ok) throw new Error(`Demo enrollment signing trust was rejected: ${verification.reason}.`);
      signingTrustUpdate = polled.signingTrustUpdate;
      enrollmentApproval = polled.enrollmentApproval;
      break;
    }
    if (polled.status !== 'pending') throw new Error(`Demo device approval ended: ${String(polled.status || 'unknown')}.`);
    await sleep(Math.min(2_000, Math.max(0, deadline - Date.now())));
  }
  if (!deviceId) throw new Error('Demo device approval timed out. Resume from the same prompt while its grant is valid.');
  const configPath = scopePath(input, origin);
  try {
    let existing = JSON.parse(await readFile(configPath, 'utf8')) as DemoDeviceConfig;
    if (existing.schema !== 'dharma.demo-device/v1' || existing.hqUrl !== origin
      || existing.organizationId !== input.organizationId || existing.repositoryId !== input.repositoryId
      || existing.normalizedRepository !== input.normalizedRepository || existing.installationId !== input.installationId
      || existing.deviceId !== deviceId || existing.publicKeyEd25519 !== identity.publicKeyEd25519) {
      throw new Error('Existing Demo device belongs to another approved identity.');
    }
    if (existing.serverSigningKeyset) {
      try { existing = await resolveDemoSigningTrust(existing, { store: deps.store }); }
      catch (error) {
        if (!(error instanceof Error) || !error.message.startsWith('Demo signing trust rejected: expired.')) throw error;
        existing = await recoverDemoSigningEnrollment(existing, { serverPublicKeyEd25519, serverSigningKeyset },
          enrollmentApproval, { store: deps.store });
        if (signingTrustUpdate !== undefined) {
          existing = await acceptDemoSigningUpdate(existing, signingTrustUpdate, { store: deps.store });
        }
      }
      await writePrivateJson(configPath, existing);
    }
    // Repeated approval polling must not replace a newer protected generation
    // with the enrollment predecessor. Signed status reconciles from its head.
    if (!existing.serverSigningKeyset) {
      let restored = { ...existing, serverPublicKeyEd25519, serverSigningKeyset };
      if (signingTrustUpdate !== undefined) restored = await acceptDemoSigningUpdate(restored, signingTrustUpdate, { store: deps.store });
      await writePrivateJson(configPath, restored);
    }
    return verifyDemoDevice(input, deps);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  let config: DemoDeviceConfig = { schema: 'dharma.demo-device/v1',
    hqUrl: origin, organizationId: input.organizationId, repositoryId: input.repositoryId,
    normalizedRepository: input.normalizedRepository, installationId: input.installationId,
    deviceId, publicKeyEd25519: identity.publicKeyEd25519,
    enrolledAt: new Date().toISOString(), signedReady: false, nextSequence: 1,
    serverPublicKeyEd25519, serverSigningKeyset };
  const pendingEnrollmentPath = `${configPath}.pending-enrollment.json`;
  try {
    const pending = JSON.parse(await readFile(pendingEnrollmentPath, 'utf8')) as DemoDeviceConfig;
    if (Object.keys(pending).length !== Object.keys(config).length
      || Object.keys(pending).some(key => !Object.hasOwn(config, key))
      || pending.schema !== config.schema || pending.signedReady !== false || pending.nextSequence !== 1
      || !Number.isFinite(Date.parse(pending.enrolledAt)) || !pending.serverSigningKeyset
      || (['hqUrl', 'organizationId', 'repositoryId', 'normalizedRepository', 'installationId',
        'deviceId', 'publicKeyEd25519', 'serverPublicKeyEd25519'] as const).some(key => pending[key] !== config[key])) {
      throw new Error('Pending Demo enrollment does not match the approved identity. Preserve it for recovery.');
    }
    config = pending;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  // Persist the credential-free enrollment binding before the protected trust
  // write. A restart can recover its exact timestamp from this intent record.
  await writePrivateJson(pendingEnrollmentPath, config);
  const predecessorGeneration = config.serverSigningKeyset!.generation;
  config = await resolveDemoSigningTrust(config, { store: deps.store });
  if (signingTrustUpdate !== undefined && config.serverSigningKeyset!.generation === predecessorGeneration) {
    config = await acceptDemoSigningUpdate(config, signingTrustUpdate, { store: deps.store });
  }
  await writePrivateJson(configPath, config);
  await unlink(pendingEnrollmentPath);
  return verifyDemoDevice(input, deps);
}
