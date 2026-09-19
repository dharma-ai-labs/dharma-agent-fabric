import { types } from 'node:util';
import type { RepositoryRoleScope, RepositoryRoleTransport } from './repositoryRoleMetadata.js';
import { discoverRepositoryRoleMetadata } from './repositoryRoleMetadata.js';

export interface RepositoryQuestionTransport extends RepositoryRoleTransport {
  signedPost(route: string, body: unknown): Promise<Record<string, unknown>>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$(?![\s\S])/i;
const CATEGORY = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$(?![\s\S])/;
const CONTROL = /[\u0000-\u001f\u007f]/;

function requireFact(value: unknown): asserts value {
  if (!value) throw new Error('Repository question response does not match its signed same-repository contract.');
}

function record(value: unknown, keys: string[]) {
  requireFact(value !== null && typeof value === 'object' && !Array.isArray(value) && !types.isProxy(value)
    && Object.getPrototypeOf(value) === Object.prototype
    && Reflect.ownKeys(value).every(key => typeof key === 'string')
    && Reflect.ownKeys(value).sort().join(',') === [...keys].sort().join(','));
  const descriptors = Object.getOwnPropertyDescriptors(value);
  requireFact(Object.values(descriptors).every(descriptor => Object.hasOwn(descriptor, 'value') && descriptor.enumerable));
  return Object.fromEntries(Object.entries(descriptors).map(([key, descriptor]) => [key, descriptor.value]));
}

function text(value: unknown, maximum: number) {
  requireFact(typeof value === 'string' && value.length > 0 && value.length <= maximum
    && value.trim() === value && !CONTROL.test(value));
  return value;
}

export async function askRepositoryRoleQuestion(input: {
  transport: RepositoryQuestionTransport;
  scope: RepositoryRoleScope;
  category: string;
  question: string;
}) {
  requireFact(CATEGORY.test(input.category));
  const question = text(input.question, 2_000);
  const observed = await discoverRepositoryRoleMetadata(input.transport, input.scope, input.category);
  const discovery = observed.discovery as { peers: Array<{ endpointId: string; workspaceId: string; provider: string }> } | null;
  requireFact(discovery && discovery.peers.length > 0);
  const target = discovery.peers.filter(peer => peer.endpointId !== input.scope.endpointId)
    .sort((left, right) => left.endpointId.localeCompare(right.endpointId))[0];
  requireFact(target);
  const response = record(await input.transport.signedPost('/agent-fabric/repository-questions', {
    workspaceId: input.scope.workspaceId, repositoryBindingId: input.scope.repositoryBindingId,
    repositoryAgentId: input.scope.repositoryAgentId, targetEndpointId: target.endpointId,
    category: input.category, question, requestedResponse: 'clarification',
  }), ['ok', 'organizationId', 'question']);
  requireFact(response.ok === true && response.organizationId === input.scope.organizationId);
  const result = record(response.question, ['questionId', 'taskId', 'repositoryBindingId', 'sourceWorkspaceId',
    'targetWorkspaceId', 'targetEndpointId', 'category', 'state']);
  requireFact([result.questionId, result.taskId, result.sourceWorkspaceId, result.targetWorkspaceId, result.targetEndpointId]
    .every(value => typeof value === 'string' && UUID.test(value))
    && result.repositoryBindingId === input.scope.repositoryBindingId
    && result.sourceWorkspaceId === input.scope.workspaceId
    && result.targetWorkspaceId === target.workspaceId && result.targetEndpointId === target.endpointId
    && result.category === input.category && result.state === 'dispatched');
  return { schema: 'dharma.repository-question-observation/v1' as const, questionId: result.questionId as string,
    taskId: result.taskId as string, state: 'dispatched' as const, target: { ...target },
    repositoryBindingId: input.scope.repositoryBindingId, communicationReady: false as const };
}

export async function readRepositoryRoleReply(input: {
  transport: Pick<RepositoryQuestionTransport, 'signedGet'>;
  scope: RepositoryRoleScope;
  questionId: string;
}) {
  requireFact(UUID.test(input.questionId));
  const query = new URLSearchParams({ workspaceId: input.scope.workspaceId });
  const response = record(await input.transport.signedGet(
    `/agent-fabric/repository-questions/${encodeURIComponent(input.questionId)}?${query}`,
  ), ['ok', 'organizationId', 'question']);
  requireFact(response.ok === true && response.organizationId === input.scope.organizationId);
  const result = record(response.question, ['questionId', 'repositoryBindingId', 'sourceWorkspaceId', 'state', 'reply']);
  requireFact(result.questionId === input.questionId && result.repositoryBindingId === input.scope.repositoryBindingId
    && result.sourceWorkspaceId === input.scope.workspaceId && ['dispatched', 'answered', 'failed'].includes(String(result.state)));
  if (result.state === 'answered') {
    const reply = record(result.reply, ['taskId', 'targetEndpointId', 'body', 'receiptHash']);
    requireFact([reply.taskId, reply.targetEndpointId].every(value => typeof value === 'string' && UUID.test(value))
      && typeof reply.receiptHash === 'string' && /^sha256:[0-9a-f]{64}$(?![\s\S])/.test(reply.receiptHash));
    return { state: 'answered' as const, body: text(reply.body, 8_000), receiptHash: reply.receiptHash as string };
  }
  requireFact(result.reply === null);
  return { state: result.state as 'dispatched' | 'failed', body: null, receiptHash: null };
}
