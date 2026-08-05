const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ROUTE = /^\/api\/v1\/orgs\/org_[A-Za-z0-9]+\/agent-fabric\/(sessions|workspaces|trajectories|evidence-requests\/poll|evidence-requests\/[0-9a-f-]{36}\/responses|tasks\/poll|tasks\/[0-9a-f-]{36}\/events|skills\/poll|skills\/[0-9a-f-]{36}\/receipts)$/i;
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
  if (typeof input.requestId !== 'string' || !UUID.test(input.requestId)) throw new Error('invalid_request_id');
  if (input.method !== 'POST' || typeof input.pathname !== 'string' || !ROUTE.test(input.pathname)) throw new Error('route_not_allowed');
  if (typeof input.body !== 'string' || Buffer.byteLength(input.body) > 1_048_576) throw new Error('body_too_large');
  const source = input.headers && typeof input.headers === 'object' && !Array.isArray(input.headers) ? input.headers as Record<string, unknown> : {};
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    const normalized = key.toLowerCase();
    if (FORWARDED_HEADERS.has(normalized) && typeof value === 'string' && !/[\r\n\0]/.test(value)) headers[normalized] = value;
  }
  for (const required of [
    'x-dharma-device-id', 'x-dharma-session-id', 'x-dharma-message-id', 'x-dharma-timestamp',
    'x-dharma-nonce', 'x-dharma-sequence', 'x-dharma-signature',
  ]) {
    if (!headers[required]) throw new Error('signed_headers_required');
  }
  const deviceId = headers['x-dharma-device-id']!;
  const sessionId = headers['x-dharma-session-id']!;
  const messageId = headers['x-dharma-message-id']!;
  const signedTimestamp = headers['x-dharma-timestamp']!;
  const nonce = headers['x-dharma-nonce']!;
  const signedSequence = headers['x-dharma-sequence']!;
  const signature = headers['x-dharma-signature']!;
  if (!UUID.test(deviceId) || !UUID.test(sessionId) || !UUID.test(messageId)) {
    throw new Error('invalid_signed_identity');
  }
  if (messageId !== input.requestId) throw new Error('request_id_mismatch');
  const timestamp = Date.parse(signedTimestamp);
  if (!Number.isFinite(timestamp) || Math.abs(Date.now() - timestamp) > 5 * 60_000) throw new Error('stale_signed_request');
  const sequence = Number(signedSequence);
  if (!Number.isSafeInteger(sequence) || sequence < 1) throw new Error('invalid_sequence');
  if (!/^[A-Za-z0-9_-]{16,}$/.test(nonce)) throw new Error('invalid_nonce');
  if (!/^[A-Za-z0-9_-]{64,}$/.test(signature)) throw new Error('invalid_signature');
  return { requestId: input.requestId, method: 'POST', pathname: input.pathname, headers, body: input.body };
}

export function relayTarget(hqInternalUrl: string, request: RelayRequest) {
  const base = new URL(hqInternalUrl);
  if (base.protocol !== 'https:' && process.env.NODE_ENV === 'production') throw new Error('https_hq_required');
  return new URL(request.pathname, `${base.origin}/`).toString();
}
