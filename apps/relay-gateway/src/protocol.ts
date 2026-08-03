const ROUTE = /^\/api\/v1\/orgs\/org_[A-Za-z0-9]+\/agent-fabric\/(sessions|workspaces|trajectories|tasks\/poll|tasks\/[0-9a-f-]{36}\/events|skills\/poll|skills\/receipts)$/i;
const FORWARDED_HEADERS = new Set([
  'content-type', 'x-dharma-correlation-id', 'x-dharma-device-id', 'x-dharma-session-id',
  'x-dharma-message-id', 'x-dharma-timestamp', 'x-dharma-nonce', 'x-dharma-sequence', 'x-dharma-signature',
]);

export interface RelayRequest {
  requestId: string;
  method: 'POST';
  pathname: string;
  headers: Record<string, string>;
  body: string;
}

export function parseRelayRequest(value: unknown): RelayRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid_relay_request');
  const input = value as Record<string, unknown>;
  if (typeof input.requestId !== 'string' || !/^[0-9a-f-]{36}$/i.test(input.requestId)) throw new Error('invalid_request_id');
  if (input.method !== 'POST' || typeof input.pathname !== 'string' || !ROUTE.test(input.pathname)) throw new Error('route_not_allowed');
  if (typeof input.body !== 'string' || Buffer.byteLength(input.body) > 1_048_576) throw new Error('body_too_large');
  const source = input.headers && typeof input.headers === 'object' && !Array.isArray(input.headers) ? input.headers as Record<string, unknown> : {};
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    const normalized = key.toLowerCase();
    if (FORWARDED_HEADERS.has(normalized) && typeof value === 'string' && !/[\r\n\0]/.test(value)) headers[normalized] = value;
  }
  for (const required of ['x-dharma-device-id', 'x-dharma-session-id', 'x-dharma-message-id', 'x-dharma-signature']) {
    if (!headers[required]) throw new Error('signed_headers_required');
  }
  return { requestId: input.requestId, method: 'POST', pathname: input.pathname, headers, body: input.body };
}

export function relayTarget(hqInternalUrl: string, request: RelayRequest) {
  const base = new URL(hqInternalUrl);
  if (base.protocol !== 'https:' && process.env.NODE_ENV === 'production') throw new Error('https_hq_required');
  return new URL(request.pathname, `${base.origin}/`).toString();
}
