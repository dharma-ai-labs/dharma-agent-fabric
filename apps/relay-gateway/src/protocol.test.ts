import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseRelayRequest } from './protocol.js';

const request = {
  requestId: '8eca231c-e9d2-40e5-bf9c-445ddfeee094', method: 'POST',
  pathname: '/api/v1/orgs/org_customer/agent-fabric/trajectories', body: '{}',
  headers: {
    'content-type': 'application/json', 'x-dharma-device-id': 'device', 'x-dharma-session-id': 'session',
    'x-dharma-message-id': 'message', 'x-dharma-signature': 'signature', authorization: 'Bearer secret', cookie: 'secret',
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
