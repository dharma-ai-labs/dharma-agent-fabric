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

test('SDK exposes repository agents, instructions, and scoped analysis through HQ only', async () => {
  const requests: Request[] = [];
  const client = new AgentFabricClient({
    organizationId: 'org_northstar',
    token: 'dharma_org_test',
    fetcher: async (input, init) => {
      requests.push(new Request(input, init));
      return new Response(JSON.stringify({ ok: true }), { status: init?.method === 'POST' ? 201 : 200 });
    },
  });
  await client.instructions();
  await client.listRepositoryAgents();
  await client.connectRepositoryAgent({
    sourceFingerprint: `sha256:${'b'.repeat(64)}`,
    displayName: 'Northstar checkout',
    defaultSourceRef: 'main',
  }, { idempotencyKey: 'repository-agent-1' });
  await client.requestAnalysis({
    trajectoryTarget: 100,
    scope: { mode: 'agents', organizationAgentIds: ['11111111-1111-4111-8111-111111111111'] },
  }, { idempotencyKey: 'analysis-1' });
  await client.transitionRemediationTarget('11111111-1111-4111-8111-111111111111', {
    action: 'stage_evaluation', endpointId: '44444444-4444-4444-8444-444444444444',
  }, { idempotencyKey: 'remediation-stage-1' });
  await client.transitionRemediationTarget('22222222-2222-4222-8222-222222222222', {
    action: 'approve', establishAutoUpdatePolicy: true,
  }, { idempotencyKey: 'remediation-approve-1' });
  const heldOutTrajectoryIds = Array.from({ length: 20 }, (_, index) => `trajectory-${index + 1}`);
  await client.transitionRemediationTarget('33333333-3333-4333-8333-333333333333', {
    action: 'run_backtest', trajectoryIds: heldOutTrajectoryIds,
  }, { idempotencyKey: 'remediation-backtest-1' });
  assert.deepEqual(requests.map((request) => new URL(request.url).pathname), [
    '/api/v1/orgs/org_northstar/agent-fabric/instructions',
    '/api/v1/orgs/org_northstar/agent-fabric/repository-agents',
    '/api/v1/orgs/org_northstar/agent-fabric/repository-agents',
    '/api/v1/orgs/org_northstar/agent-fabric/evals',
    '/api/v1/orgs/org_northstar/agent-fabric/remediations/11111111-1111-4111-8111-111111111111',
    '/api/v1/orgs/org_northstar/agent-fabric/remediations/22222222-2222-4222-8222-222222222222',
    '/api/v1/orgs/org_northstar/agent-fabric/remediations/33333333-3333-4333-8333-333333333333',
  ]);
  assert.equal(new Headers(requests[2]!.headers).get('idempotency-key'), 'repository-agent-1');
  assert.deepEqual(JSON.parse(await requests[3]!.text()).scope, {
    mode: 'agents',
    organizationAgentIds: ['11111111-1111-4111-8111-111111111111'],
  });
  assert.deepEqual(JSON.parse(await requests[4]!.text()), { action: 'stage_evaluation', endpointId: '44444444-4444-4444-8444-444444444444' });
  assert.deepEqual(JSON.parse(await requests[5]!.text()), { action: 'approve', establishAutoUpdatePolicy: true });
  assert.deepEqual(JSON.parse(await requests[6]!.text()), { action: 'run_backtest', trajectoryIds: heldOutTrajectoryIds });
  assert.equal(requests.every((request) => !request.url.includes('run.app')), true);
});

test('SDK binds local, managed ADK, and Vertex BYOK endpoints to one repository agent through HQ', async () => {
  const requests: Request[] = [];
  const client = new AgentFabricClient({
    organizationId: 'org_northstar',
    token: 'dharma_org_test',
    fetcher: async (input, init) => {
      requests.push(new Request(input, init));
      return new Response(JSON.stringify({ ok: true, endpoint: { id: 'endpoint-1' } }), { status: 201 });
    },
  });
  const agentId = '11111111-1111-4111-8111-111111111111';
  await client.bindLocalEndpoint(agentId, {
    workspaceId: '22222222-2222-4222-8222-222222222222', provider: 'codex', priority: 25,
  }, { idempotencyKey: 'bind-local-1' });
  await client.bindRuntimeEndpoint(agentId, {
    endpointKind: 'managed_runtime',
    managedAgentId: '33333333-3333-4333-8333-333333333333',
    runtimeBindingId: '44444444-4444-4444-8444-444444444444',
  }, { idempotencyKey: 'bind-managed-1' });
  await client.bindRuntimeEndpoint(agentId, {
    endpointKind: 'cloud_byok',
    managedAgentId: '55555555-5555-4555-8555-555555555555',
    runtimeBindingId: '66666666-6666-4666-8666-666666666666',
  }, { idempotencyKey: 'bind-byok-1' });
  assert.equal(requests.length, 3);
  assert.equal(requests.every((request) => new URL(request.url).pathname.endsWith(`/agents/${agentId}/endpoints`)), true);
  assert.deepEqual(JSON.parse(await requests[1]!.text()), {
    endpointKind: 'managed_runtime',
    managedAgentId: '33333333-3333-4333-8333-333333333333',
    runtimeBindingId: '44444444-4444-4444-8444-444444444444',
  });
  assert.equal(requests.every((request) => !request.url.includes('run.app')), true);
});

test('SDK requests action decisions through HQ and keeps effect acknowledgement device-only', async () => {
  const requests: Request[] = [];
  const client = new AgentFabricClient({
    organizationId: 'org_northstar',
    token: 'dharma_org_test',
    fetcher: async (input, init) => {
      requests.push(new Request(input, init));
      return new Response(JSON.stringify({ ok: true, decision: { outcome: 'release' } }), { status: 201 });
    },
  });
  await client.requestActionDecision({
    evaluationContractId: '11111111-1111-4111-8111-111111111111',
    task: {
      taskId: '22222222-2222-4222-8222-222222222222',
      workspaceId: '33333333-3333-4333-8333-333333333333',
      targetEndpointId: '44444444-4444-4444-8444-444444444444',
      taskType: 'external_request',
      instructions: 'Apply the bounded approved patch.',
      authority: { writePaths: ['src/**'], commands: ['test'], network: 'deny' },
      execution: { commandId: 'test', argv: [] },
      acceptance: { requiredChecks: ['test'] },
      budget: { maxRuntimeSeconds: 120 },
    },
    stateEnvelope: {
      intent: 'Apply one reviewed patch.',
      evidence_used: ['trajectory:checkout'],
      known_state: { failingCheck: 'test' },
      unknown_or_missing_state: [],
      allowed_next_actions: ['apply_patch'],
      blocked_actions: ['deploy'],
      decision_authority: 'source patch only',
      tool_results: [{ tool: 'test', status: 'failed' }],
      proposed_action: 'apply_patch',
    },
    evidenceReferences: [{
      trajectoryId: '55555555-5555-4555-8555-555555555555',
      revision: 1,
      capsuleHash: `sha256:${'a'.repeat(64)}`,
    }],
  }, { idempotencyKey: 'decision-1' });
  await client.listActionDecisions('?limit=10');
  await client.transitionEvaluationContract({
    contractId: '11111111-1111-4111-8111-111111111111',
    action: 'activate',
    confirmation: 'ACTIVATE EVALUATION CONTRACT 11111111-1111-4111-8111-111111111111',
  }, { idempotencyKey: 'contract-activate-1' });

  assert.equal(requests[0]?.url, 'https://www.dharma-ai.io/api/v1/orgs/org_northstar/agent-fabric/decisions');
  assert.equal(requests[0]?.headers.get('idempotency-key'), 'decision-1');
  assert.equal(requests[1]?.url, 'https://www.dharma-ai.io/api/v1/orgs/org_northstar/agent-fabric/decisions?limit=10');
  assert.equal(requests[2]?.url, 'https://www.dharma-ai.io/api/v1/orgs/org_northstar/agent-fabric/evaluation-contracts');
  assert.equal(requests[2]?.headers.get('idempotency-key'), 'contract-activate-1');
  assert.equal('acknowledgeActionDecisionEnforcement' in client, false);
});
