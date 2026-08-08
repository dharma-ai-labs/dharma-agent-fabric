import assert from 'node:assert/strict';
import test from 'node:test';
import { AgentFabricApiError, AgentFabricClient } from './index.js';

test('SDK sends organization-scoped bearer requests and idempotency keys without exposing cloud endpoints', async () => {
  let request: { url?: string; init?: RequestInit } = {};
  const client = new AgentFabricClient({
    organizationId: 'org_northstar',
    token: 'dharma_org_secret',
    fetcher: async (url, init) => {
      request = { url: String(url), init };
      return new Response(JSON.stringify({ ok: true, onboardingId: 'onboarding-1' }), { status: 201, headers: { 'content-type': 'application/json' } });
    },
  });
  await client.startOnboarding({ companyName: 'Northstar Commerce Lab', runtimeMode: 'dharma_managed' }, { idempotencyKey: 'idem-1' });
  assert.equal(request.url, 'https://www.dharma-ai.io/api/v1/orgs/org_northstar/agent-fabric/onboarding');
  const headers = new Headers(request.init?.headers);
  assert.equal(headers.get('authorization'), 'Bearer dharma_org_secret');
  assert.equal(headers.get('idempotency-key'), 'idem-1');
  assert.equal(JSON.stringify(request).includes('run.googleapis.com'), false);
});

test('SDK accepts HTTPS and exact loopback origins but rejects credential-bearing or deceptive hosts', () => {
  assert.equal(new AgentFabricClient({ organizationId: 'org', token: 'token' }).baseUrl, 'https://www.dharma-ai.io');
  assert.equal(new AgentFabricClient({ organizationId: 'org', token: 'token', baseUrl: 'http://localhost:3000' }).baseUrl, 'http://localhost:3000');
  assert.throws(() => new AgentFabricClient({ organizationId: 'org', token: 'token', baseUrl: 'http://localhost.evil.example' }), /HTTPS or localhost/);
  assert.throws(() => new AgentFabricClient({ organizationId: 'org', token: 'token', baseUrl: 'https://user:pass@hq.dharma-ai.io' }), /credential-free origin/);
});

test('SDK returns stable typed API errors', async () => {
  const client = new AgentFabricClient({
    organizationId: 'org_northstar',
    token: 'token',
    fetcher: async () => new Response(JSON.stringify({ error: { code: 'entitlement_required', message: 'Purchase is required.', correlationId: 'corr-1' } }), { status: 403 }),
  });
  await assert.rejects(() => client.onboarding(), (error: unknown) => {
    assert.ok(error instanceof AgentFabricApiError);
    assert.equal(error.code, 'entitlement_required');
    assert.equal(error.correlationId, 'corr-1');
    return true;
  });
});

test('SDK sends the server handoff contract and keyless GCP BYOK verification', async () => {
  const requests: Request[] = [];
  const client = new AgentFabricClient({
    organizationId: 'org_northstar',
    token: 'dharma_org_test',
    fetcher: async (input, init) => {
      requests.push(new Request(input, init));
      return new Response(JSON.stringify({ ok: true }), { headers: { 'content-type': 'application/json' } });
    },
  });
  await client.dispatchHandoff({
    sourceTaskId: '11111111-1111-4111-8111-111111111111',
    targetEndpointId: '22222222-2222-4222-8222-222222222222',
    requestedResponse: 'proposal',
    stateEnvelope: {
      intent: 'Ask the coding agent for a bounded fix proposal.',
      evidence_used: ['trace:checkout-42'],
      known_state: { failingRoute: '/checkout' },
      unknown_or_missing_state: ['root cause'],
      allowed_next_actions: ['propose patch'],
      blocked_actions: ['deploy', 'read secrets'],
      decision_authority: 'proposal only',
      tool_results: [],
    },
  }, { idempotencyKey: 'handoff-1' });
  await client.verifyGcpByok({ idempotencyKey: 'byok-verify-1' });
  const handoffRequest = requests[0];
  const byokRequest = requests[1];
  assert.ok(handoffRequest);
  assert.ok(byokRequest);
  assert.deepEqual(JSON.parse(await handoffRequest.text()), {
    sourceTaskId: '11111111-1111-4111-8111-111111111111',
    targetEndpointId: '22222222-2222-4222-8222-222222222222',
    requestedResponse: 'proposal',
    stateEnvelope: {
      intent: 'Ask the coding agent for a bounded fix proposal.',
      evidence_used: ['trace:checkout-42'],
      known_state: { failingRoute: '/checkout' },
      unknown_or_missing_state: ['root cause'],
      allowed_next_actions: ['propose patch'],
      blocked_actions: ['deploy', 'read secrets'],
      decision_authority: 'proposal only',
      tool_results: [],
    },
  });
  assert.equal(byokRequest.url, 'https://www.dharma-ai.io/api/v1/orgs/org_northstar/agent-fabric/byok/gcp');
  assert.deepEqual(JSON.parse(await byokRequest.text()), { action: 'verify' });
});

test('SDK submits the bounded multimodal managed-run contract to HQ only', async () => {
  const requests: Request[] = [];
  const client = new AgentFabricClient({
    organizationId: 'org_northstar',
    token: 'dharma_org_test',
    fetcher: async (input, init) => {
      requests.push(new Request(input, init));
      return new Response(JSON.stringify({ ok: true, runId: 'run-1' }), { status: 202 });
    },
  });
  await client.submitManagedRun({
    agentId: 'garment-appraisal',
    prompt: 'Estimate price from the supplied garment evidence.',
    attachments: [{
      displayName: 'garment-front.png',
      mimeType: 'image/png',
      dataBase64: 'iVBORw0KGgo=',
      sha256: `sha256:${'a'.repeat(64)}`,
    }],
  }, { idempotencyKey: 'garment-run-1' });

  const captured = requests[0];
  assert.ok(captured);
  assert.equal(captured.url, 'https://www.dharma-ai.io/api/orgs/org_northstar/agent-runs');
  const payload = JSON.parse(await captured.text());
  assert.equal(payload.attachments[0].mimeType, 'image/png');
  assert.equal(captured.url.includes('run.app'), false);
});
