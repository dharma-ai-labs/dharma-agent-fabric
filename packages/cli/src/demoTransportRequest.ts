import { createPublicKey, randomBytes, randomUUID, verify } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { Ajv2020, type ValidateFunction } from 'ajv/dist/2020.js';
import type { FormatsPlugin } from 'ajv-formats';
import { canonicalize, sha256 } from '@dharma-ai-labs/agent-fabric-contracts';
import type { SecureSecretStore } from '@dharma-ai-labs/agent-fabric-relay-client';
import { acceptDemoTransport, resolveDemoTransport, type DemoTransportBinding } from './demoTransportState.js';

interface Pending {
  schema: 'dharma.demo-transport-request/v1'; bindingHash: string; correlationId: string;
  request: { installationId: string; enrollmentOrigin: string; transportOrigin: string;
    requestNonce: string; trustGeneration: number; installedKeysetHash: string };
  createdAt: string; lastAttemptAt: string | null; attempts: number;
}
interface Dependencies {
  store: SecureSecretStore; fetcher?: typeof fetch; now?: () => Date; signal?: AbortSignal;
  sign: (payload: string) => Promise<string>;
  loadBinding?: () => Promise<DemoTransportBinding>;
}
let validator: Promise<ValidateFunction<Pending>> | undefined;
function pendingValidator() {
  return validator ??= (async () => {
    const ajv = new Ajv2020({ allErrors: true, strict: true });
    (createRequire(import.meta.url)('ajv-formats').default as FormatsPlugin)(ajv);
    return ajv.compile<Pending>(JSON.parse(await readFile(new URL('./schemas/demo-transport-request.schema.json', import.meta.url), 'utf8')));
  })();
}
function fail(code: string, correlationId?: string, status?: number): never {
  throw Object.assign(new Error(`Demo transport recovery ${code}. Preserve original enrollment and pending recovery.${correlationId ? ` Correlation: ${correlationId}.` : ''}`),
    { code: `demo_transport_${code}`, stage: 'demo_transport_request', correlationId, status });
}
function clock(deps: Dependencies) {
  const now = deps.now?.() ?? new Date();
  if (!Number.isFinite(now.getTime())) fail('clock_invalid');
  return now;
}
const fresh = (store: SecureSecretStore, account: string) => store.getFresh ? store.getFresh(account) : store.get(account);
async function confirmed(store: SecureSecretStore, account: string, value: string | null) {
  try { if (value === null) await store.delete(account); else await store.put(account, value); }
  catch { fail('secure_store_write_failed'); }
  if (await fresh(store, account) !== value) fail('secure_store_write_unconfirmed');
}
async function receipt(response: Response, url: string) {
  if (response.redirected || response.status >= 300 && response.status < 400 || response.url && response.url !== url
    || !response.body || !/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') || '')
    || Number(response.headers.get('content-length') || 0) > 32768) fail('receipt_invalid');
  const reader = response.body.getReader(), chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const part = await reader.read(); if (part.done) break;
      size += part.value.byteLength;
      if (size > 32768) { void reader.cancel().catch(() => undefined); fail('receipt_invalid'); }
      chunks.push(part.value);
    }
    const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail('receipt_invalid');
    return value as Record<string, unknown>;
  } catch { fail('receipt_invalid'); }
  finally { reader.releaseLock(); }
}

// Caller holds the enrolled device lock. This separate lane never increments or
// repairs the work queue's cursor, nor writes original credentials/config/trust.
export async function requestDemoTransportContinuity(input: DemoTransportBinding, target: string, deps: Dependencies) {
  const binding = structuredClone(input), now = clock(deps);
  try {
    const url = new URL(target);
    if (target.length > 2048 || url.protocol !== 'https:' || url.origin !== target || target === binding.enrollmentOrigin) fail('target_invalid');
  } catch { fail('target_invalid'); }
  const resolution = await resolveDemoTransport(binding, deps);
  const bindingHash = sha256(canonicalize(binding));
  const identityHash = sha256(canonicalize({ organizationId: binding.organizationId, repositoryId: binding.repositoryId,
    deviceId: binding.deviceId, installationId: binding.installationId, publicKeyEd25519: binding.publicKeyEd25519,
    enrollmentOrigin: binding.enrollmentOrigin, target })).slice(7);
  const account = `demo-transport-request-${identityHash}`, store = deps.store;
  let pending: Pending | null = null, raw = await fresh(store, account), resumed = raw !== null;
  if (raw !== null) {
    if (Buffer.byteLength(raw) > 8192) fail('pending_invalid');
    let parsed: unknown;
    try { parsed = JSON.parse(raw); } catch { fail('pending_invalid'); }
    if (!(await pendingValidator())(parsed) || canonicalize(parsed) !== raw
      || Date.parse(parsed.createdAt) > now.getTime() || parsed.lastAttemptAt !== null
        && (Date.parse(parsed.lastAttemptAt) < Date.parse(parsed.createdAt) || Date.parse(parsed.lastAttemptAt) > now.getTime())) fail('pending_invalid');
    pending = parsed;
    if (pending.request.installationId !== binding.installationId || pending.request.enrollmentOrigin !== binding.enrollmentOrigin
      || pending.request.transportOrigin !== target) fail('pending_scope_conflict');
    if (resolution.state === 'ready' && pending.bindingHash === bindingHash
      && pending.request.requestNonce === resolution.certificate.requestNonce) {
      await confirmed(store, account, null); raw = null; pending = null;
    }
    if (pending && (pending.bindingHash !== bindingHash || now.getTime() - Date.parse(pending.createdAt) >= 15 * 60_000)) {
      // Keep the previous logical request, but never replay it under changed trust
      // or after every possible certificate it could have produced has expired.
      await confirmed(store, `${account}-retired-${pending.request.requestNonce}`, raw);
      await confirmed(store, account, null); raw = null; pending = null; resumed = false;
    } else if (pending && (pending.attempts >= 3 || pending.lastAttemptAt !== null
      && now.getTime() - Date.parse(pending.lastAttemptAt) < 60_000)) fail('retry_later', pending.correlationId);
  }
  if (!pending && resolution.state === 'ready' && resolution.transportOrigin === target
    && Date.parse(resolution.certificate.expiresAt) > now.getTime() + 60_000) {
    return { ok: true, stage: 'demo_transport_verified' as const, enrolled: false, duplicate: true,
      deviceId: binding.deviceId, repositoryId: binding.repositoryId, transportOrigin: target,
      expiresAt: resolution.certificate.expiresAt, resumed };
  }
  if (!pending) pending = { schema: 'dharma.demo-transport-request/v1', bindingHash, correlationId: randomUUID(),
    request: { installationId: binding.installationId, enrollmentOrigin: binding.enrollmentOrigin, transportOrigin: target,
      requestNonce: randomBytes(24).toString('base64url'), trustGeneration: binding.protectedKeyset.generation,
      installedKeysetHash: sha256(canonicalize(binding.protectedKeyset)) },
    createdAt: now.toISOString(), lastAttemptAt: null, attempts: 0 };
  pending.attempts++; pending.lastAttemptAt = now.toISOString();
  if (await fresh(store, account) !== raw) fail('pending_conflict');
  await confirmed(store, account, canonicalize(pending));
  const body = canonicalize(pending.request), url = new URL(`/api/demo/fabric/repositories/${binding.repositoryId}/transport-continuity`, target);
  url.searchParams.set('orgId', binding.organizationId);
  const sessionId = randomUUID(), messageId = randomUUID(), nonce = randomBytes(24).toString('base64url'), timestamp = clock(deps).toISOString();
  const payload = { bodyHash: sha256(body), deviceId: binding.deviceId, messageId, method: 'POST', nonce,
    organizationId: binding.organizationId, pathname: url.pathname + url.search, sequence: 1, sessionId, timestamp };
  const signature = await deps.sign(JSON.stringify(payload));
  const key = createPublicKey({ format: 'jwk', key: { kty: 'OKP', crv: 'Ed25519', x: binding.publicKeyEd25519 } });
  if (!/^[A-Za-z0-9_-]{86}$/.test(signature)
    || !verify(null, Buffer.from(JSON.stringify(payload)), key, Buffer.from(signature, 'base64url'))) fail('device_signature_invalid');
  const deadline = AbortSignal.timeout(15_000), signal = deps.signal ? AbortSignal.any([deps.signal, deadline]) : deadline;
  signal.throwIfAborted();
  let response: Response;
  try {
    const options = { method: 'POST', body, redirect: 'error' as const, credentials: 'omit' as const, cache: 'no-store', signal,
      headers: { 'content-type': 'application/json', 'x-dharma-device-id': binding.deviceId, 'x-dharma-session-id': sessionId,
        'x-dharma-message-id': messageId, 'x-dharma-timestamp': timestamp, 'x-dharma-nonce': nonce,
        'x-dharma-sequence': '1', 'x-dharma-signature': signature, 'x-dharma-correlation-id': pending.correlationId } };
    response = await (deps.fetcher || fetch)(url.toString(), options);
  } catch { fail('request_failed', pending.correlationId); }
  const result = await receipt(response, url.toString());
  if (response.status !== 200) {
    const error = result.error && typeof result.error === 'object' && !Array.isArray(result.error) ? result.error as Record<string, unknown> : {};
    const matched = response.headers.get('x-dharma-correlation-id') === pending.correlationId
      && typeof error.code === 'string' && /^[a-z][a-z0-9_]{0,119}$/.test(error.code);
    if (matched && response.status === 409 && error.code === 'demo_transport_refresh_required') {
      await confirmed(store, `${account}-retired-${pending.request.requestNonce}`, canonicalize(pending));
      await confirmed(store, account, null);
    }
    fail(matched ? `rejected_${error.code}` : 'receipt_invalid', pending.correlationId, response.status);
  }
  if (result.ok !== true || typeof result.duplicate !== 'boolean' || result.correlationId !== pending.correlationId
    || response.headers.get('x-dharma-correlation-id') !== pending.correlationId
    || Object.keys(result).sort().join(',') !== 'certificate,correlationId,duplicate,ok') fail('receipt_invalid', pending.correlationId);
  if (deps.loadBinding && sha256(canonicalize(await deps.loadBinding())) !== bindingHash) fail('protected_binding_changed', pending.correlationId);
  await acceptDemoTransport(result.certificate, binding, { transportOrigin: target, requestNonce: pending.request.requestNonce }, deps);
  if (await fresh(store, account) !== canonicalize(pending)) fail('pending_conflict');
  await confirmed(store, account, null);
  const verified = await resolveDemoTransport(binding, deps);
  if (verified.state !== 'ready') fail('activation_unconfirmed', pending.correlationId);
  return { ok: true, stage: 'demo_transport_verified' as const, enrolled: false, duplicate: result.duplicate,
    deviceId: binding.deviceId, repositoryId: binding.repositoryId, transportOrigin: target,
    expiresAt: verified.certificate.expiresAt, correlationId: pending.correlationId, resumed };
}
