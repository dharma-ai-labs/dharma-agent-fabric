import { types } from 'node:util';
import { inspectSessionQuestionForBinding, type SessionBindingScope, type SessionQuestion,
  type SessionQuestionVerifier } from '@dharma-ai-labs/agent-fabric-contracts';

type Mode = 'bridge_owned' | 'cooperative';
type FailureCode = 'provider_unavailable' | 'budget_denied' | 'validation_failed' | 'execution_failed';
type Registration = { bindingId: string; workspaceId: string; endpointId: string; repositoryBindingId: string;
  membershipId: string; deviceId: string; provider: 'codex'; mode: Mode; revision: number;
  state: 'attached' | 'detached'; leaseUntil: string; replay: boolean };
type Acknowledgement = { questionId: string; taskId: string; targetBindingId: string;
  state: 'queued' | 'accepted' | 'answered' | 'failed'; replay: boolean; correlationId: string };
type Reply = { questionId: string; taskId: string; outcome: 'answered' | 'failed'; answer: string; failureCode: FailureCode | null };
type Observation = { questionId: string; taskId: string; targetBindingId: string;
  state: 'preparing' | 'queued' | 'accepted' | 'answered' | 'failed' | 'expired' | 'unavailable';
  answer: string | null; failureCode: FailureCode | null; replyReceiptHash: string | null; correlationId: string };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$(?![\s\S])/i;
const CATEGORY = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$(?![\s\S])/;
const CONTROL = /[\u0000-\u001f\u007f]/;
const REPLY_CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const SECRET = /-----BEGIN[^\r\n]*PRIVATE KEY-----|\b(?:gh[pousr]_|github_pat_|sk_live_|sk_test_)[A-Za-z0-9_]{12,}|\bBearer\s+[A-Za-z0-9_.+-]{8,}|\b(?:password|api[_-]?key|access[_-]?token|client[_-]?secret)\s*[:=]\s*\S{8,}/i;
const FAILURE = ['provider_unavailable', 'budget_denied', 'validation_failed', 'execution_failed'];
function identifier(value: unknown): value is string { return typeof value === 'string' && UUID.test(value); }
function fact(condition: unknown, kind: 'input' | 'response'): asserts condition {
  if (!condition) throw new Error(`provider_session_channel_${kind}`);
}
function record(value: unknown, fields: string[], kind: 'input' | 'response') {
  fact(value && typeof value === 'object' && !Array.isArray(value) && !types.isProxy(value)
    && Object.getPrototypeOf(value) === Object.prototype, kind);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  fact(Reflect.ownKeys(value).every(key => typeof key === 'string')
    && Object.keys(descriptors).sort().join(',') === [...fields].sort().join(',')
    && Object.values(descriptors).every(item => Object.hasOwn(item, 'value') && item.enumerable), kind);
  return Object.fromEntries(Object.entries(descriptors).map(([key, descriptor]) => [key, descriptor.value]));
}
function safeWire(value: unknown, depth = 0, seen = new Set<object>(), budget = { nodes: 0 }): void {
  fact(depth <= 8 && ++budget.nodes <= 1000, 'response');
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return;
  if (typeof value === 'string') { fact(value.length <= 4096, 'response'); return; }
  fact(value && typeof value === 'object' && !types.isProxy(value) && !seen.has(value), 'response');
  const array = Array.isArray(value), descriptors = Object.getOwnPropertyDescriptors(value);
  fact(Object.getPrototypeOf(value) === (array ? Array.prototype : Object.prototype)
    && Reflect.ownKeys(value).length <= 100 && Reflect.ownKeys(value).every(key => typeof key === 'string')
    && Object.values(descriptors).every(item => Object.hasOwn(item, 'value')), 'response');
  seen.add(value);
  try { for (const descriptor of Object.values(descriptors)) safeWire(descriptor.value, depth + 1, seen, budget); }
  finally { seen.delete(value); }
}
function text(value: unknown, kind: 'input' | 'response', multiline = false) {
  fact(typeof value === 'string' && value.length <= 2000 && value.trim().length > 0
    && !(multiline ? REPLY_CONTROL : CONTROL).test(value) && !SECRET.test(value)
    && (multiline || value.trim() === value), kind);
  return value;
}

// This channel carries messages only. A caller must retain its real session owner;
// neither registration nor acceptance authorizes spawning a replacement worker.
export function createProviderSessionChannel(input: {
  transport: { signedPost(route: string, body: unknown): Promise<Record<string, unknown>> };
  scope: SessionBindingScope; mode: Mode; expectedRevision: number;
  assertOwner(): Promise<boolean>;
  verifier: Pick<SessionQuestionVerifier, 'resolvePublicKey'>;
  authorizeContent(content: string, kind: 'question' | 'answer'): Promise<boolean>;
  now?: () => Date;
}) {
  const raw = record(input.scope, ['organizationId', 'repositoryBindingId', 'workspaceId', 'endpointId',
    'membershipId', 'deviceId', 'bindingId', 'provider', 'expiresAt', 'maximumProviderCostCents'], 'input');
  fact(typeof raw.organizationId === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$(?![\s\S])/.test(raw.organizationId)
    && ['repositoryBindingId', 'workspaceId', 'endpointId', 'membershipId', 'deviceId', 'bindingId']
      .every(key => identifier(raw[key]))
    && raw.provider === 'codex' && typeof raw.expiresAt === 'string' && Number.isFinite(Date.parse(raw.expiresAt))
    && Number.isInteger(raw.maximumProviderCostCents) && raw.maximumProviderCostCents >= 0 && raw.maximumProviderCostCents <= 10000
    && ['bridge_owned', 'cooperative'].includes(input.mode) && Number.isInteger(input.expectedRevision)
    && input.expectedRevision >= 0 && input.expectedRevision <= 2147483646, 'input');
  const scope = raw as SessionBindingScope, mode = input.mode, now = input.now || (() => new Date());
  const base = { schema: 'dharma.provider-session-question-request/v1', bindingId: scope.bindingId,
    workspaceId: scope.workspaceId, endpointId: scope.endpointId, repositoryBindingId: scope.repositoryBindingId };
  let revision = input.expectedRevision, registration: Registration | null = null, closed = false;
  let correlationId: string | null = null;
  let serial = Promise.resolve();
  function operation<T>(run: () => Promise<T>): Promise<T> {
    const result = serial.then(run).catch(error => {
      if (error instanceof Error && error.message === 'provider_session_channel_response') closed = true;
      throw error;
    });
    serial = result.then(() => undefined, () => undefined); return result;
  }
  async function owner(live = false) {
    if (closed) throw new Error('provider_session_channel_closed');
    let held = false;
    try { held = await input.assertOwner(); } catch { /* Unconfirmed ownership cannot authorize another send. */ }
    if (!held || !Number.isFinite(now().getTime()) || now().getTime() >= Date.parse(scope.expiresAt)) {
      closed = true; throw new Error('provider_session_channel_owner_lost');
    }
    if (live && (!registration || registration.state !== 'attached' || now().getTime() >= Date.parse(registration.leaseUntil))) {
      throw new Error('provider_session_channel_unavailable');
    }
  }
  async function post(route: string, body: Record<string, unknown>, field: 'registration' | 'result') {
    fact(Buffer.byteLength(JSON.stringify(body), 'utf8') <= 3500, 'input');
    await owner();
    let response: unknown;
    try { response = await input.transport.signedPost(route, body); }
    catch { closed = true; throw new Error('provider_session_channel_uncertain'); }
    await owner();
    try {
      safeWire(response);
      const envelope = record(response, ['ok', 'organizationId', field, 'correlationId'], 'response');
      fact(envelope.ok === true && envelope.organizationId === scope.organizationId
        && identifier(envelope.correlationId), 'response');
      correlationId = envelope.correlationId;
      return envelope[field];
    } catch (error) { closed = true; throw error; }
  }
  async function register(action: 'attach' | 'heartbeat' | 'detach') {
    await owner(action === 'heartbeat');
    fact(action === 'attach' || revision > 0, 'input');
    const value = record(await post('/agent-fabric/provider-sessions', { ...base,
      schema: 'dharma.provider-session-registration/v1', action, provider: 'codex', mode,
      expectedRevision: revision, leaseSeconds: 60 }, 'registration'), ['bindingId', 'workspaceId', 'endpointId',
      'repositoryBindingId', 'membershipId', 'deviceId', 'provider', 'mode', 'revision', 'state', 'leaseUntil', 'replay'], 'response');
    fact(['bindingId', 'workspaceId', 'endpointId', 'repositoryBindingId', 'membershipId', 'deviceId', 'provider']
      .every(key => value[key] === scope[key as keyof SessionBindingScope]) && value.mode === mode
      && value.revision === revision + 1 && value.state === (action === 'detach' ? 'detached' : 'attached')
      && typeof value.leaseUntil === 'string' && Number.isFinite(Date.parse(value.leaseUntil))
      && Date.parse(value.leaseUntil) <= now().getTime() + 120000 && typeof value.replay === 'boolean', 'response');
    registration = value as Registration; revision = registration.revision;
    if (action === 'detach') closed = true;
    return { ...registration, correlationId };
  }
  function acknowledgement(value: unknown, expected: { questionId?: string; taskId: string; targetBindingId: string; state: string }) {
    const result = record(value, ['questionId', 'taskId', 'targetBindingId', 'state', 'replay'], 'response');
    fact(identifier(result.questionId)
      && (!expected.questionId || result.questionId === expected.questionId) && result.taskId === expected.taskId
      && result.targetBindingId === expected.targetBindingId && result.state === expected.state
      && typeof result.replay === 'boolean', 'response');
    return { ...result, correlationId } as Acknowledgement;
  }
  async function question(action: string, additional: Record<string, unknown> = {}) {
    await owner(true);
    const result = await post('/agent-fabric/provider-session-questions', { ...base, action, ...additional }, 'result');
    await owner(true); return result;
  }
  async function content(value: string, kind: 'question' | 'answer') {
    fact(await input.authorizeContent(value, kind), 'input'); await owner(true);
  }
  return {
    attach: () => operation(() => register('attach')),
    heartbeat: () => operation(() => register('heartbeat')),
    detach: () => operation(() => register('detach')),
    inbox: () => operation(async () => {
      const result = record(await question('inbox'), ['offers'], 'response');
      fact(Array.isArray(result.offers) && result.offers.length <= 5, 'response');
      const offers: SessionQuestion[] = [], seen = new Set<string>();
      for (const candidate of result.offers) {
        const inspected = inspectSessionQuestionForBinding(candidate, scope, input.verifier, now());
        fact(inspected.ok, 'response'); const offer = candidate as SessionQuestion;
        text(offer.question, 'response');
        fact(!seen.has(offer.questionId), 'response'); seen.add(offer.questionId); offers.push(offer);
      }
      return offers;
    }),
    ask: (request: { targetBindingId: string; taskId: string; category: string; question: string; maximumProviderCostCents: number }) => operation(async () => {
      const value = record(request, ['targetBindingId', 'taskId', 'category', 'question', 'maximumProviderCostCents'], 'input');
      fact(identifier(value.targetBindingId) && identifier(value.taskId) && value.targetBindingId !== scope.bindingId
        && typeof value.category === 'string' && value.category.length <= 64 && CATEGORY.test(value.category)
        && Number.isInteger(value.maximumProviderCostCents) && value.maximumProviderCostCents >= 0
        && value.maximumProviderCostCents <= scope.maximumProviderCostCents, 'input');
      await content(text(value.question, 'input'), 'question');
      return acknowledgement(await question('ask', value), { taskId: request.taskId, targetBindingId: request.targetBindingId, state: 'queued' });
    }),
    accept: (questionId: string, taskId: string) => operation(async () => {
      fact(identifier(questionId) && identifier(taskId), 'input');
      return acknowledgement(await question('accept', { questionId }), { questionId, taskId, targetBindingId: scope.bindingId, state: 'accepted' });
    }),
    reply: (request: Reply) => operation(async () => {
      const value = record(request, ['questionId', 'taskId', 'outcome', 'answer', 'failureCode'], 'input');
      fact(identifier(value.questionId) && identifier(value.taskId), 'input');
      if (value.outcome === 'answered') {
        fact(value.failureCode === null, 'input'); await content(text(value.answer, 'input', true), 'answer');
      } else fact(value.outcome === 'failed' && value.answer === '' && FAILURE.includes(value.failureCode), 'input');
      const { taskId, ...payload } = value;
      return acknowledgement(await question('reply', payload), { questionId: request.questionId, taskId: String(taskId),
        targetBindingId: scope.bindingId, state: request.outcome });
    }),
    read: (questionId: string, taskId: string, targetBindingId: string) => operation(async () => {
      fact([questionId, taskId, targetBindingId].every(identifier), 'input');
      const value = record(await question('read', { questionId }), ['questionId', 'taskId', 'targetBindingId',
        'state', 'answer', 'failureCode', 'replyReceiptHash'], 'response');
      fact(value.questionId === questionId && value.taskId === taskId && value.targetBindingId === targetBindingId
        && ['preparing', 'queued', 'accepted', 'answered', 'failed', 'expired', 'unavailable'].includes(value.state), 'response');
      if (value.state === 'answered') { text(value.answer, 'response', true); fact(value.failureCode === null, 'response'); }
      else fact(value.answer === null && (value.state === 'failed' ? FAILURE.includes(value.failureCode) : value.failureCode === null), 'response');
      fact(['answered', 'failed'].includes(value.state)
        ? typeof value.replyReceiptHash === 'string' && /^sha256:[0-9a-f]{64}$(?![\s\S])/.test(value.replyReceiptHash)
        : value.replyReceiptHash === null, 'response');
      return { ...value, correlationId } as Observation;
    }),
  };
}
