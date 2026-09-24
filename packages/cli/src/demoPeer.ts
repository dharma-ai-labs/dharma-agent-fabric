import { createHash, randomBytes, randomUUID, sign, type JsonWebKey } from 'node:crypto';
import { chmod, mkdir, open, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { loadOrCreateDeviceIdentity, normalizeHqUrl, type SecureSecretStore } from '@dharma-ai-labs/agent-fabric-relay-client';
import { scopePath, verifyDemoDevice, type DemoDeviceScope } from './demoEnrollment.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_PENDING_AGE_MS = 4 * 60_000;

export type DemoPeerAction =
  | { kind: 'role'; role: string; categories: string[] }
  | { kind: 'peers' }
  | { kind: 'ask'; recipientDeviceId: string; content: string }
  | { kind: 'reply'; recipientDeviceId: string; questionId: string; content: string }
  | { kind: 'inbox' }
  | { kind: 'ack'; messageId: string };

type DeviceConfig = {
  schema: string; hqUrl: string; organizationId: string; repositoryId: string;
  normalizedRepository: string; installationId: string; deviceId: string;
  publicKeyEd25519: string; signedReady: boolean; nextSequence: number;
};
type SignedOperation = { method: 'GET' | 'POST'; url: string; body: string;
  headers: Record<string, string>; sequence: number; createdAt: string };
type PendingOperation = { schema: 'dharma.demo-peer-pending/v1';
  action: DemoPeerAction; operationId: string | null; request: SignedOperation };

export interface DemoPeerDependencies { store?: SecureSecretStore; fetcher?: typeof fetch }

function assertAction(action: DemoPeerAction) {
  if (!['role', 'peers', 'ask', 'reply', 'inbox', 'ack'].includes(action.kind)) {
    throw new Error('Demo peer action is invalid.');
  }
  if (action.kind === 'role') {
    if (typeof action.role !== 'string' || !Array.isArray(action.categories)
      || action.role.length < 2 || action.role.length > 80 || action.categories.length > 12
      || action.categories.some((category) => typeof category !== 'string'
        || category.length < 2 || category.length > 80)) {
      throw new Error('Demo peer role and categories must be bounded strings.');
    }
  } else if (action.kind === 'ask' || action.kind === 'reply') {
    if (typeof action.recipientDeviceId !== 'string' || typeof action.content !== 'string'
      || !UUID.test(action.recipientDeviceId) || action.content.length < 1
      || action.content.length > 4000 || (action.kind === 'reply' && !UUID.test(action.questionId))) {
      throw new Error('Demo peer target or question content is invalid.');
    }
  } else if (action.kind === 'ack' && !UUID.test(action.messageId)) {
    throw new Error('Demo peer message ID is invalid.');
  }
}

async function privateWrite(path: string, value: unknown) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600, flag: 'wx' });
  await rename(temporary, path);
  if (process.platform !== 'win32') await chmod(path, 0o600);
}

async function device(input: DemoDeviceScope, deps: DemoPeerDependencies) {
  const origin = normalizeHqUrl(input.hqUrl);
  const configPath = scopePath(input, origin);
  let config: DeviceConfig;
  try { config = JSON.parse(await readFile(configPath, 'utf8')) as DeviceConfig; }
  catch { throw new Error('Demo device is not enrolled. Run the recipient-bound demo connect prompt first.'); }
  if (config.schema !== 'dharma.demo-device/v1' || config.hqUrl !== origin
    || config.organizationId !== input.organizationId || config.repositoryId !== input.repositoryId
    || config.normalizedRepository !== input.normalizedRepository
    || config.installationId !== input.installationId || !UUID.test(config.deviceId)
    || !Number.isSafeInteger(config.nextSequence) || config.nextSequence < 1) {
    throw new Error('Demo device state does not match this repository and installation.');
  }
  const identity = await loadOrCreateDeviceIdentity({ hqUrl: origin,
    organizationId: `${input.organizationId}:${input.repositoryId}`,
    installationId: input.installationId, store: deps.store });
  if (config.publicKeyEd25519 !== identity.publicKeyEd25519) {
    throw new Error('Demo device key does not match its protected identity.');
  }
  return { origin, configPath, config, privateJwk: identity.privateJwk };
}

function endpoint(origin: string, input: DemoDeviceScope, action: DemoPeerAction) {
  const root = `/api/demo/fabric/repositories/${input.repositoryId}`;
  const pathname = action.kind === 'role' || action.kind === 'peers' ? `${root}/peers`
    : action.kind === 'ack' ? `${root}/messages/${action.messageId}/ack`
      : `${root}/messages`;
  const url = new URL(pathname, origin);
  url.searchParams.set('orgId', input.organizationId);
  const method = action.kind === 'role' || action.kind === 'ask'
    || action.kind === 'reply' || action.kind === 'ack' ? 'POST' : 'GET';
  return { url, method } as const;
}

function bodyFor(action: DemoPeerAction, operationId: string | null) {
  if (action.kind === 'role') return JSON.stringify({ role: action.role, categories: action.categories });
  if (action.kind === 'ask' || action.kind === 'reply') return JSON.stringify({
    operationId, recipientDeviceId: action.recipientDeviceId,
    kind: action.kind === 'ask' ? 'question' : 'answer',
    inReplyTo: action.kind === 'reply' ? action.questionId : null,
    content: action.content,
  });
  return '';
}

function signedOperation(origin: string, input: DemoDeviceScope, action: DemoPeerAction,
  operationId: string | null, config: DeviceConfig, privateJwk: JsonWebKey): SignedOperation {
  const { url, method } = endpoint(origin, input, action);
  const body = bodyFor(action, operationId);
  const sessionId = randomUUID();
  const messageId = randomUUID();
  const timestamp = new Date().toISOString();
  const nonce = randomBytes(24).toString('base64url');
  const sequence = config.nextSequence;
  const payload = Buffer.from(JSON.stringify({
    bodyHash: `sha256:${createHash('sha256').update(body).digest('hex')}`,
    deviceId: config.deviceId, messageId, method, nonce,
    organizationId: input.organizationId,
    pathname: `${url.pathname}${url.search}`, sequence, sessionId, timestamp,
  }));
  const signature = sign(null, payload, { key: privateJwk, format: 'jwk' }).toString('base64url');
  return { method, url: url.toString(), body, sequence, createdAt: timestamp,
    headers: {
      'x-dharma-device-id': config.deviceId, 'x-dharma-session-id': sessionId,
      'x-dharma-message-id': messageId, 'x-dharma-timestamp': timestamp,
      'x-dharma-nonce': nonce, 'x-dharma-sequence': String(sequence),
      'x-dharma-signature': signature,
    } };
}

function responseError(body: unknown, status: number) {
  const item = body && typeof body === 'object' ? body as Record<string, unknown> : {};
  const nested = item.error && typeof item.error === 'object' && !Array.isArray(item.error)
    ? item.error as Record<string, unknown> : null;
  const code = typeof nested?.code === 'string' ? nested.code
    : typeof item.error === 'string' ? item.error : `http_${status}`;
  const message = typeof nested?.message === 'string' ? nested.message
    : typeof item.message === 'string' ? item.message : 'Demo peer request failed.';
  return Object.assign(new Error(`${code}: ${message}`), { code });
}

function assertReceipt(body: Record<string, unknown>, action: DemoPeerAction) {
  const object = (value: unknown): value is Record<string, unknown> =>
    Boolean(value) && typeof value === 'object' && !Array.isArray(value);
  const items = action.kind === 'peers' ? body.peers
    : action.kind === 'inbox' ? body.messages : null;
  const valid = action.kind === 'role' ? object(body.role)
      && UUID.test(String(body.role.deviceId)) && body.role.role === action.role
    : action.kind === 'peers' ? Array.isArray(items)
      && items.every((item) => object(item) && UUID.test(String(item.deviceId))
        && typeof item.role === 'string' && Array.isArray(item.categories))
      : action.kind === 'inbox' ? Array.isArray(items)
        && items.every((item) => object(item) && UUID.test(String(item.id))
          && UUID.test(String(item.senderDeviceId)) && typeof item.content === 'string')
        : action.kind === 'ack' ? object(body.acknowledgement)
          && body.acknowledgement.id === action.messageId
          && typeof body.acknowledgement.acknowledgedAt === 'string'
          : object(body.message) && UUID.test(String(body.message.id))
            && typeof body.message.duplicate === 'boolean';
  if (!valid) throw new Error('Demo peer response does not match the expected command receipt.');
}

async function dispatch(request: SignedOperation, action: DemoPeerAction, fetcher: typeof fetch) {
  const response = await fetcher(request.url, {
    method: request.method, headers: request.headers,
    body: request.method === 'POST' && request.body ? request.body : undefined,
  });
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) throw responseError(body, response.status);
  if (!body || typeof body !== 'object' || Array.isArray(body)
    || (body as Record<string, unknown>).ok !== true) {
    throw new Error('Demo peer response is not a verified JSON receipt.');
  }
  const receipt = body as Record<string, unknown>;
  assertReceipt(receipt, action);
  return receipt;
}

async function complete(path: string, configPath: string,
  config: DeviceConfig, pending: PendingOperation, result: Record<string, unknown>) {
  config.nextSequence = pending.request.sequence + 1;
  await privateWrite(configPath, config);
  await unlink(path).catch(() => {});
  return { ...result, stage: 'demo_peer_operation', action: pending.action.kind,
    deviceId: config.deviceId, repositoryId: config.repositoryId };
}

export async function performDemoPeerAction(input: DemoDeviceScope,
  requested: DemoPeerAction | null, deps: DemoPeerDependencies = {}) {
  if (requested) assertAction(requested);
  const initial = await device(input, deps);
  if (!initial.config.signedReady) throw new Error('Demo device has not completed signed readiness. Run demo status.');
  const pendingPath = `${initial.configPath}.pending-peer.json`;
  let pending: PendingOperation | null = null;
  try { pending = JSON.parse(await readFile(pendingPath, 'utf8')) as PendingOperation; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw new Error('Pending Demo peer request is invalid; preserve it for recovery.', { cause: error });
    }
  }
  if (pending) {
    if (pending.schema !== 'dharma.demo-peer-pending/v1' || !pending.action
      || (pending.operationId !== null && !UUID.test(pending.operationId))
      || (['ask', 'reply'].includes(pending.action.kind) && pending.operationId === null)
      || !Number.isSafeInteger(pending.request?.sequence)
      || pending.request.sequence < 1 || !Number.isFinite(Date.parse(pending.request.createdAt))
      || !pending.request.headers || typeof pending.request.headers !== 'object'
      || Object.keys(pending.request.headers).sort().join(',') !== [
        'x-dharma-device-id', 'x-dharma-message-id', 'x-dharma-nonce',
        'x-dharma-sequence', 'x-dharma-session-id', 'x-dharma-signature',
        'x-dharma-timestamp',
      ].sort().join(',')
      || pending.request.headers['x-dharma-device-id'] !== initial.config.deviceId
      || pending.request.headers['x-dharma-sequence'] !== String(pending.request.sequence)
      || pending.request.url !== endpoint(initial.origin, input, pending.action).url.toString()
      || pending.request.body !== bodyFor(pending.action, pending.operationId)
      || pending.request.method !== endpoint(initial.origin, input, pending.action).method) {
      throw new Error('Pending Demo peer request does not match this signed repository.');
    }
    assertAction(pending.action);
    const sameAction = requested !== null
      && JSON.stringify(requested) === JSON.stringify(pending.action);
    if (initial.config.nextSequence === pending.request.sequence
      && Date.now() - Date.parse(pending.request.createdAt) < MAX_PENDING_AGE_MS) {
      const pendingSequence = pending.request.sequence;
      try {
        const result = await dispatch(pending.request, pending.action, deps.fetcher || fetch);
        const receipt = await complete(pendingPath, initial.configPath,
          initial.config, pending, result);
        if (sameAction || !requested) return { ...receipt, resumed: true };
        pending = null;
      } catch (error) {
        const code = (error as { code?: string }).code;
        if (code && code !== 'demo_fabric_sequence_out_of_order') {
          await verifyDemoDevice(input, { ...deps,
            expectedAcceptedSequence: pendingSequence });
          await unlink(pendingPath).catch(() => {});
        }
        if (code !== 'demo_fabric_sequence_out_of_order') throw error;
      }
    }
    if (pending) {
      await verifyDemoDevice(input, { ...deps,
        expectedAcceptedSequence: pending.request.sequence });
      const resumed = await device(input, deps);
      pending.request = signedOperation(resumed.origin, input, pending.action,
        pending.operationId, resumed.config, resumed.privateJwk);
      await privateWrite(pendingPath, pending);
      try {
        const result = await dispatch(pending.request, pending.action, deps.fetcher || fetch);
        const receipt = await complete(pendingPath, resumed.configPath,
          resumed.config, pending, result);
        if (sameAction || !requested) return { ...receipt, resumed: true };
      } catch (error) {
        if ((error as { code?: string }).code) {
          await verifyDemoDevice(input, { ...deps,
            expectedAcceptedSequence: pending.request.sequence });
          await unlink(pendingPath).catch(() => {});
        }
        throw error;
      }
    }
  }
  if (!requested) return { ok: true, stage: 'demo_peer_no_pending' };
  await verifyDemoDevice(input, deps);
  const ready = await device(input, deps);
  const operationId = requested.kind === 'ask' || requested.kind === 'reply' ? randomUUID() : null;
  const fresh: PendingOperation = { schema: 'dharma.demo-peer-pending/v1',
    action: requested, operationId,
    request: signedOperation(ready.origin, input, requested, operationId,
      ready.config, ready.privateJwk) };
  await privateWrite(pendingPath, fresh);
  try {
    const result = await dispatch(fresh.request, requested, deps.fetcher || fetch);
    return complete(pendingPath, ready.configPath, ready.config, fresh, result);
  } catch (error) {
    if ((error as { code?: string }).code === 'demo_fabric_sequence_out_of_order') {
      await verifyDemoDevice(input, { ...deps,
        expectedAcceptedSequence: fresh.request.sequence });
      const retry = await device(input, deps);
      fresh.request = signedOperation(retry.origin, input, requested, operationId,
        retry.config, retry.privateJwk);
      await privateWrite(pendingPath, fresh);
      const result = await dispatch(fresh.request, requested, deps.fetcher || fetch);
      return complete(pendingPath, retry.configPath, retry.config, fresh, result);
    }
    if ((error as { code?: string }).code) {
      await verifyDemoDevice(input, { ...deps,
        expectedAcceptedSequence: fresh.request.sequence });
      await unlink(pendingPath).catch(() => {});
    }
    throw error;
  }
}

export async function withDemoDeviceLock<T>(input: DemoDeviceScope, work: () => Promise<T>): Promise<T> {
  const path = `${scopePath(input, normalizeHqUrl(input.hqUrl))}.lock`;
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const token = randomUUID();
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let handle;
    try {
      handle = await open(path, 'wx', 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const age = Date.now() - (await stat(path)).mtimeMs;
      let owner = 0;
      try { owner = (JSON.parse(await readFile(path, 'utf8')) as { pid?: number }).pid || 0; }
      catch { /* An incomplete new lock is treated as busy. */ }
      let alive = owner > 0;
      if (alive) {
        try { process.kill(owner, 0); }
        catch (processError) { alive = (processError as NodeJS.ErrnoException).code !== 'ESRCH'; }
      }
      if (age < 2_000 || alive) {
        throw new Error('Demo device is busy on this machine. Retry after its current operation ends.');
      }
      await unlink(path);
      continue;
    }
    try { await handle.writeFile(JSON.stringify({ pid: process.pid, token })); }
    catch (error) { await unlink(path).catch(() => {}); throw error; }
    finally { await handle.close(); }
    try { return await work(); }
    finally {
      const current = JSON.parse(await readFile(path, 'utf8')) as { token?: string };
      if (current.token === token) await unlink(path);
    }
  }
  throw new Error('Demo device lock could not be recovered.');
}
