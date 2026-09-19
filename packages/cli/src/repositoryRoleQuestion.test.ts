import assert from 'node:assert/strict';
import test from 'node:test';
import { askRepositoryRoleQuestion, readRepositoryRoleReply } from './repositoryRoleQuestion.js';

const scope = {
  organizationId: 'org_fixture', workspaceId: '056b63dc-ebed-48ed-85d8-02c72f623ea8',
  repositoryBindingId: '73a95988-fd64-41ba-a0b9-6c8867d03788',
  repositoryAgentId: '57f61652-a5eb-46e4-930c-9478cd4a9c31',
  endpointId: '67f61652-a5eb-46e4-930c-9478cd4a9c31', sourceFingerprint: `sha256:${'a'.repeat(64)}`,
};
const target = { endpointId: '77f61652-a5eb-46e4-930c-9478cd4a9c31',
  workspaceId: '87f61652-a5eb-46e4-930c-9478cd4a9c31', provider: 'claude', roleName: 'Verifier',
  questionCategories: ['verifier-design'], description: 'Checks bounded verifiers.', revision: 1 };

test('repository question discovers a same-binding role and dispatches a signed task-bound question', async () => {
  const calls: Array<{ method: string; route: string; body?: unknown }> = [];
  const transport = {
    signedGet: async (route: string) => {
      calls.push({ method: 'GET', route });
      return { ok: true, organizationId: scope.organizationId, correlationId: 'fixture', discovery: {
        organizationId: scope.organizationId, workspaceId: scope.workspaceId,
        repositoryBindingId: scope.repositoryBindingId, repositoryAgentId: scope.repositoryAgentId,
        peers: [{ ...target, endpointId: scope.endpointId, workspaceId: scope.workspaceId }, target],
        limit: 50, possiblyTruncated: false } };
    },
    signedPost: async (route: string, body: unknown) => {
      calls.push({ method: 'POST', route, body });
      return { ok: true, organizationId: scope.organizationId, question: {
        questionId: '97f61652-a5eb-46e4-930c-9478cd4a9c31', taskId: 'a7f61652-a5eb-46e4-930c-9478cd4a9c31',
        repositoryBindingId: scope.repositoryBindingId, sourceWorkspaceId: scope.workspaceId,
        targetWorkspaceId: target.workspaceId, targetEndpointId: target.endpointId,
        category: 'verifier-design', state: 'dispatched' } };
    },
  };
  const result = await askRepositoryRoleQuestion({ transport, scope, category: 'verifier-design',
    question: 'Which invariant should this verifier enforce?' });
  assert.equal(result.state, 'dispatched');
  assert.equal(result.communicationReady, false);
  assert.deepEqual(calls.map(call => call.method), ['GET', 'POST']);
  assert.deepEqual(calls[1]?.body, { workspaceId: scope.workspaceId, repositoryBindingId: scope.repositoryBindingId,
    repositoryAgentId: scope.repositoryAgentId, targetEndpointId: target.endpointId,
    category: 'verifier-design', question: 'Which invariant should this verifier enforce?', requestedResponse: 'clarification' });
});

test('repository question refuses to route to the requesting endpoint', async () => {
  await assert.rejects(() => askRepositoryRoleQuestion({ scope, category: 'verifier-design', question: 'Review this.',
    transport: { signedPost: async () => { throw new Error('must not dispatch'); }, signedGet: async () => ({
      ok: true, organizationId: scope.organizationId, discovery: { organizationId: scope.organizationId,
        workspaceId: scope.workspaceId, repositoryBindingId: scope.repositoryBindingId,
        repositoryAgentId: scope.repositoryAgentId, peers: [{ ...target, endpointId: scope.endpointId,
          workspaceId: scope.workspaceId }], limit: 50, possiblyTruncated: false },
    }) },
  }), /same-repository contract/);
});

test('repository reply requires the original repository binding and a signed task receipt hash', async () => {
  const result = await readRepositoryRoleReply({ scope, questionId: '97f61652-a5eb-46e4-930c-9478cd4a9c31',
    transport: { signedGet: async () => ({ ok: true, organizationId: scope.organizationId, question: {
      questionId: '97f61652-a5eb-46e4-930c-9478cd4a9c31', repositoryBindingId: scope.repositoryBindingId,
      sourceWorkspaceId: scope.workspaceId, state: 'answered', reply: {
        taskId: 'a7f61652-a5eb-46e4-930c-9478cd4a9c31', targetEndpointId: target.endpointId,
        body: 'Enforce exact receipt-to-snapshot binding.', receiptHash: `sha256:${'b'.repeat(64)}` } } }) } });
  assert.deepEqual(result, { state: 'answered', body: 'Enforce exact receipt-to-snapshot binding.',
    receiptHash: `sha256:${'b'.repeat(64)}` });
});
