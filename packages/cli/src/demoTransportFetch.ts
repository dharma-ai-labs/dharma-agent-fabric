import { createPublicKey, verify } from 'node:crypto';
import { sha256 } from '@dharma-ai-labs/agent-fabric-contracts';
import type { SecureSecretStore } from '@dharma-ai-labs/agent-fabric-relay-client';
import { resolveDemoTransport, type DemoTransportBinding } from './demoTransportState.js';

interface Dependencies {
  store: SecureSecretStore;
  loadBinding: (readOnlyStore: SecureSecretStore) => Promise<DemoTransportBinding>;
  fetcher?: typeof fetch;
  now?: () => Date;
  refresh?: (binding: DemoTransportBinding, transportOrigin: string) => Promise<unknown>;
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function fail(reason: string): never {
  throw Object.assign(new Error(`Demo transport request rejected: ${reason}. Preserve the original device and signing trust.`),
    { code: `demo_transport_${reason}` });
}
function requestScope(resource: Parameters<typeof fetch>[0], init: RequestInit, binding: DemoTransportBinding) {
  if (typeof resource !== 'string' && !(resource instanceof URL)) fail('request_scope_invalid');
  let url: URL;
  try { url = new URL(String(resource)); } catch { fail('request_scope_invalid'); }
  const prefix = `/api/demo/fabric/repositories/${binding.repositoryId}/`;
  const suffix = url.pathname.slice(prefix.length);
  if (url.origin !== binding.enrollmentOrigin || url.username || url.password || url.hash
    || !url.pathname.startsWith(prefix) || !/^[a-zA-Z0-9-]+(?:\/[a-zA-Z0-9-]+)*$/.test(suffix)
    || url.searchParams.getAll('orgId').length !== 1
    || url.searchParams.get('orgId') !== binding.organizationId
    || !['GET', 'POST'].includes(init.method || 'GET')
    || init.body !== undefined && init.body !== null && typeof init.body !== 'string'
    || (init.method || 'GET') === 'GET' && init.body) fail('request_scope_invalid');
  const headers = new Headers(init.headers);
  for (const name of headers.keys()) {
    if (!['accept', 'content-type'].includes(name) && !/^x-dharma-(?:device-id|session-id|message-id|timestamp|nonce|sequence|signature|correlation-id)$/.test(name)) {
      fail('request_scope_invalid');
    }
  }
  if (headers.get('x-dharma-device-id') !== binding.deviceId) fail('request_scope_invalid');
  return { url, headers };
}
function signedRequest(url: URL, init: RequestInit, headers: Headers, binding: DemoTransportBinding, now: Date) {
  const sessionId = headers.get('x-dharma-session-id'), messageId = headers.get('x-dharma-message-id');
  const timestamp = headers.get('x-dharma-timestamp'), nonce = headers.get('x-dharma-nonce');
  const sequenceValue = headers.get('x-dharma-sequence'), signature = headers.get('x-dharma-signature');
  const sequence = Number(sequenceValue), time = Date.parse(timestamp || '');
  if (!Number.isFinite(now.getTime()) || !UUID.test(sessionId || '') || !UUID.test(messageId || '')
    || !/^[A-Za-z0-9_-]{24,128}$/.test(nonce || '') || !/^[1-9][0-9]*$/.test(sequenceValue || '')
    || !Number.isSafeInteger(sequence) || !/^[A-Za-z0-9_-]{86}$/.test(signature || '')
    || !Number.isFinite(time) || time > now.getTime() + 5_000 || time < now.getTime() - 240_000) {
    fail('request_signature_invalid');
  }
  const payload = { bodyHash: sha256(typeof init.body === 'string' ? init.body : ''),
    deviceId: binding.deviceId, messageId, method: init.method || 'GET', nonce,
    organizationId: binding.organizationId, pathname: `${url.pathname}${url.search}`,
    sequence, sessionId, timestamp };
  let valid = false;
  try {
    const key = createPublicKey({ format: 'jwk', key: { kty: 'OKP', crv: 'Ed25519', x: binding.publicKeyEd25519 } });
    valid = verify(null, Buffer.from(JSON.stringify(payload)), key, Buffer.from(signature!, 'base64url'));
  } catch { fail('request_signature_invalid'); }
  if (!valid) fail('request_signature_invalid');
}

// The operation's existing device lock encloses this fetcher. The loader can
// read fresh OS authority, but cannot manufacture an identity or signing anchor.
export function createDemoTransportFetcher(deps: Dependencies): typeof fetch {
  const fresh = (account: string) => deps.store.getFresh ? deps.store.getFresh(account) : deps.store.get(account);
  const readOnlyStore: SecureSecretStore = { backend: deps.store.backend, get: fresh, getFresh: fresh,
    async put() { fail('existing_protected_state_required'); },
    async delete() { fail('existing_protected_state_required'); } };
  return async (resource, input = {}) => {
    const init = { ...input, headers: new Headers(input.headers) };
    const selected = typeof resource === 'string' ? resource : resource instanceof URL ? new URL(resource) : resource;
    init.signal?.throwIfAborted();
    let binding = structuredClone(await deps.loadBinding(readOnlyStore));
    let resolution = await resolveDemoTransport(binding, { store: deps.store, now: deps.now });
    let { url, headers } = requestScope(selected, init, binding);
    signedRequest(url, init, headers, binding, deps.now?.() ?? new Date());
    const needsRefresh = resolution.state === 'refresh_required' || resolution.state === 'ready'
      && Date.parse(resolution.certificate.expiresAt) <= (deps.now?.() ?? new Date()).getTime() + 60_000;
    if (needsRefresh && deps.refresh) {
      const target = resolution.state === 'refresh_required' ? resolution.lastTransportOrigin
        : resolution.state === 'ready' ? resolution.transportOrigin : binding.enrollmentOrigin;
      await deps.refresh(binding, target);
      binding = structuredClone(await deps.loadBinding(readOnlyStore));
      resolution = await resolveDemoTransport(binding, { store: deps.store, now: deps.now });
      ({ url, headers } = requestScope(selected, init, binding));
      if (resolution.state !== 'ready' || resolution.transportOrigin !== target) fail('refresh_unconfirmed');
    }
    if (resolution.state === 'refresh_required') fail('refresh_required');
    signedRequest(url, init, headers, binding, deps.now?.() ?? new Date());
    const target = new URL(`${url.pathname}${url.search}`, resolution.transportOrigin);
    const deadline = AbortSignal.timeout(15_000);
    const signal = init.signal ? AbortSignal.any([init.signal, deadline]) : deadline;
    signal.throwIfAborted();
    const options = { ...init, headers, redirect: 'error' as const, credentials: 'omit' as const, cache: 'no-store', signal };
    const response = await (deps.fetcher || fetch)(target.toString(), options);
    if (response.redirected || response.status >= 300 && response.status < 400
      || response.url && response.url !== target.toString()
      || !response.body || !/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') || '')) {
      await response.body?.cancel().catch(() => undefined);
      fail('response_contract_invalid');
    }
    return response;
  };
}
