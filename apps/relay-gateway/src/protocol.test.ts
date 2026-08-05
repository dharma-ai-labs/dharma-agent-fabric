import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MAX_RELAY_BODY_BYTES, parseRelayRequest } from './protocol.js';

const request = {
  requestId: '8eca231c-e9d2-40e5-bf9c-445ddfeee094', method: 'POST',
  pathname: '/api/v1/orgs/org_customer/agent-fabric/trajectories', body: '{}',
  headers: {
    'content-type': 'application/json',
    'x-dharma-device-id': 'd327bcce-2314-4c92-a6b7-13ec5570c1ee',
    'x-dharma-session-id': '93d01b40-a824-4cb1-a8ff-aa8ec9819bb1',
    'x-dharma-message-id': '8eca231c-e9d2-40e5-bf9c-445ddfeee094',
    'x-dharma-timestamp': new Date().toISOString(), 'x-dharma-nonce': 'N0nc3_With-Enough_Entropy',
    'x-dharma-sequence': '1', 'x-dharma-signature': 'A'.repeat(86),
    authorization: 'Bearer secret', cookie: 'secret',
  },
};

test('relay permits only Agent Fabric routes and strips ambient credentials', () => {
  const parsed = parseRelayRequest(request);
  assert.equal(parsed.headers.authorization, undefined);
  assert.equal(parsed.headers.cookie, undefined);
  assert.equal(parsed.pathname, request.pathname);
});

test('relay rejects arbitrary HQ, worker, and admin paths', () => {
  for (const pathname of ['/api/admin', '/api/workers/agent-executor', '/api/v1/orgs/org_customer/managed-agents']) {
    assert.throws(() => parseRelayRequest({ ...request, pathname }), /route_not_allowed/);
  }
});

test('relay accepts bundle-qualified skill receipts', () => {
  const parsed = parseRelayRequest({
    ...request,
    pathname: '/api/v1/orgs/org_customer/agent-fabric/skills/d327bcce-2314-4c92-a6b7-13ec5570c1ee/receipts',
  });
  assert.match(parsed.pathname, /skills\/d327bcce.*\/receipts$/);
});

test('relay accepts only bounded evidence poll and response routes', () => {
  assert.doesNotThrow(() => parseRelayRequest({
    ...request,
    pathname: '/api/v1/orgs/org_customer/agent-fabric/evidence-requests/poll',
  }));
  assert.doesNotThrow(() => parseRelayRequest({
    ...request,
    pathname: '/api/v1/orgs/org_customer/agent-fabric/evidence-requests/d327bcce-2314-4c92-a6b7-13ec5570c1ee/responses',
  }));
  assert.throws(() => parseRelayRequest({
    ...request,
    pathname: '/api/v1/orgs/org_customer/agent-fabric/evidence-requests/all/raw',
  }), /route_not_allowed/);
});

test('relay accepts the organization capsule ceiling and rejects larger bodies', () => {
  assert.doesNotThrow(() => parseRelayRequest({
    ...request,
    body: 'x'.repeat(2_000_000),
  }));
  assert.throws(() => parseRelayRequest({
    ...request,
    body: 'x'.repeat(MAX_RELAY_BODY_BYTES + 1),
  }), /body_too_large/);
});

test('relay rejects incomplete, stale, and mismatched signed envelopes', () => {
  const missingTimestamp = { ...request, headers: { ...request.headers, 'x-dharma-timestamp': '' } };
  assert.throws(() => parseRelayRequest(missingTimestamp), /signed_headers_required/);
  assert.throws(() => parseRelayRequest({
    ...request, headers: { ...request.headers, 'x-dharma-timestamp': '2020-01-01T00:00:00.000Z' },
  }), /stale_signed_request/);
  assert.throws(() => parseRelayRequest({
    ...request, requestId: '7d315d8e-52b0-49b8-8627-37eb97a1040d',
  }), /request_id_mismatch/);
});
