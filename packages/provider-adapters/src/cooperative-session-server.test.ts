import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { canonicalize, signCanonicalObject, validateSessionQuestionContract } from '@dharma-ai-labs/agent-fabric-contracts';
import { createCooperativeSessionMcpHandlers, createCooperativeSessionMcpServer, type CooperativeSessionMcpConsumer } from './cooperative-session-server.js';
import { createCooperativeSessionMcpServer as publicFactory } from './index.js';

const uuid = (n: number) => `70000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const hash = (value: string) => `sha256:${createHash('sha256').update(value).digest('hex')}`;
const schema = 'dharma.cooperative-session-tool-result/v1';
const {privateKey} = generateKeyPairSync('ed25519');
function offer() {
  const peer = {workspaceId: uuid(1), endpointId: uuid(2), membershipId: uuid(3), deviceId: uuid(4)};
  const unsigned = {schema: 'dharma.session-question/v1', questionId: uuid(10), taskId: uuid(11),
    organizationId: 'org_fixture', repositoryBindingId: uuid(5), source: peer,
    target: {...peer, bindingId: uuid(6), provider: 'codex'}, category: 'architecture', question: 'Which catalog applies?',
    authority: {mode: 'read_only', readPaths: ['.'], network: 'deny', maximumProviderCostCents: 25},
    createdAt: '2026-10-23T11:00:00.000Z', expiresAt: '2026-10-23T11:01:00.000Z', nonce: uuid(12), signerKeyVersion: 'fixture-key'};
  return {...unsigned, signature: signCanonicalObject(unsigned, privateKey)};
}
function answer() {return {questionId: uuid(10), taskId: uuid(11), nonce: uuid(12), offerHash: hash(canonicalize(offer())), attemptId: uuid(13), answer: 'Use the signed catalog.'};}
async function fixture(consumer: CooperativeSessionMcpConsumer) {
  const server = createCooperativeSessionMcpServer(consumer), client = new Client({name: 'cooperative-factory-fixture', version: '1.0.0'});
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return {server, client, close: async () => {await client.close(); await server.close();}};
}
function payload(result: {structuredContent?: unknown; content: unknown}) {
  assert.ok(result.structuredContent && typeof result.structuredContent === 'object');
  const content = result.content as Array<{type: string; text?: string}>;
  assert.equal(content.length, 1); assert.equal(content[0]?.type, 'text');
  assert.deepEqual(JSON.parse(content[0]!.text!), result.structuredContent);
  return result.structuredContent as Record<string, unknown>;
}

test('the actual package root exports the public source SDK factory', () => {assert.equal(publicFactory, createCooperativeSessionMcpServer);});

test('the SDK lists exactly two strict mutating tools without administrative or owner-selection arguments', async () => {
  const f = await fixture({checkpoint: async () => ({state: 'idle'}), submitAnswer: async () => ({state: 'reply_pending'})});
  try {
    const {tools} = await f.client.listTools();
    assert.deepEqual(tools.map(t => t.name).sort(), ['cooperative_checkpoint', 'cooperative_submit_answer']);
    for (const tool of tools) {
      assert.equal(tool.annotations?.readOnlyHint, false);
      assert.equal(tool.inputSchema.additionalProperties, false);
      assert.ok(tool.outputSchema);
      assert.doesNotMatch(JSON.stringify(tool.outputSchema), /https:\/\/schemas\.dharma-ai\.io\/session-question\/v1/);
    }
    assert.deepEqual(Object.keys(tools.find(t => t.name === 'cooperative_checkpoint')!.inputSchema.properties ?? {}), []);
    assert.deepEqual(Object.keys(tools.find(t => t.name === 'cooperative_submit_answer')!.inputSchema.properties ?? {}).sort(), Object.keys(answer()).sort());
  } finally {await f.close();}
});

test('an actual in-memory SDK checkpoint reaches the injected consumer with a live request signal', async () => {
  let calls = 0, captured: Readonly<{signal: AbortSignal}> | undefined;
  const f = await fixture({checkpoint: async context => {calls++; captured = context; return {state: 'idle'};}, submitAnswer: async () => {throw new Error('must not submit');}});
  try {
    const result = await f.client.callTool({name: 'cooperative_checkpoint', arguments: {}});
    assert.deepEqual(payload(result), {schema, state: 'idle'});
    assert.equal(result.isError, false); assert.equal(calls, 1);
    assert.ok(captured?.signal instanceof AbortSignal); assert.equal(captured.signal.aborted, false); assert.equal(Object.isFrozen(captured), true);
  } finally {await f.close();}
});

test('the actual SDK preserves an authorized handoff and a later six-field answer on one consumer', async () => {
  const signed = offer(), offerHash = hash(canonicalize(signed)), attemptId = uuid(13);
  let checkpoints = 0, submissions = 0;
  const f = await fixture({checkpoint: async () => {checkpoints++; return checkpoints === 1 ? {state: 'handed_off', offer: signed, offerHash, attemptId}
    : {state: 'checkpoint_pending', questionId: uuid(10), taskId: uuid(11), offerHash, attemptId};},
    submitAnswer: async value => {submissions++; assert.deepEqual(value, {...answer(), offerHash});
      return {state: 'answered', questionId: uuid(10), taskId: uuid(11), targetBindingId: uuid(6), replay: false, correlationId: uuid(90), completionHash: hash('completion')};}});
  try {
    assert.equal(payload(await f.client.callTool({name: 'cooperative_checkpoint', arguments: {}})).state, 'handed_off');
    const pending = payload(await f.client.callTool({name: 'cooperative_checkpoint', arguments: {}}));
    assert.equal(pending.state, 'checkpoint_pending'); assert.equal(Object.hasOwn(pending, 'offer'), false);
    const result = payload(await f.client.callTool({name: 'cooperative_submit_answer', arguments: {...answer(), offerHash}}));
    assert.equal(result.state, 'answered'); assert.equal(checkpoints, 2); assert.equal(submissions, 1);
  } finally {await f.close();}
});

test('SDK invalid-argument diagnostics are fixed and never expose a secret property name or value', async () => {
  let calls = 0;
  const f = await fixture({checkpoint: async () => {calls++; return {state: 'idle'};}, submitAnswer: async () => {calls++; return {};}});
  try {
    for (const name of ['cooperative_checkpoint', 'cooperative_submit_answer']) {
      const args = name === 'cooperative_checkpoint' ? {} : answer();
      const result = await f.client.callTool({name, arguments: {...args, SYNTHETIC_PRIVATE_FIELD_DO_NOT_ECHO: 'SYNTHETIC_PRIVATE_VALUE_DO_NOT_ECHO'}});
      assert.equal(result.isError, true); assert.doesNotMatch(JSON.stringify(result), /SYNTHETIC_PRIVATE/);
      assert.match(JSON.stringify(result), /input_invalid/);
    }
    assert.equal(calls, 0);
  } finally {await f.close();}
});

test('unknown consumer diagnostics become a fixed SDK tool error and cannot reopen the adapter', async () => {
  let calls = 0;
  const f = await fixture({checkpoint: async () => {calls++; throw new Error('SYNTHETIC_PRIVATE_CONSUMER_DIAGNOSTIC');}, submitAnswer: async () => ({})});
  try {
    const first = await f.client.callTool({name: 'cooperative_checkpoint', arguments: {}});
    assert.deepEqual(payload(first), {schema, state: 'error', code: 'operation_unconfirmed'}); assert.equal(first.isError, true);
    const second = await f.client.callTool({name: 'cooperative_checkpoint', arguments: {}});
    assert.deepEqual(payload(second), {schema, state: 'error', code: 'unavailable'}); assert.equal(calls, 1);
    assert.doesNotMatch(JSON.stringify(first), /SYNTHETIC_PRIVATE/);
  } finally {await f.close();}
});

test('valid retained recovery states remain explicit SDK results instead of answered', async () => {
  for (const raw of [
    {state: 'reply_pending', questionId: uuid(10), taskId: uuid(11), completionHash: hash('completion'), reasonCode: 'delivery_unconfirmed'},
    {state: 'reply_quarantined', questionId: uuid(10), taskId: uuid(11), completionHash: hash('completion'), dispositionHash: hash('disposition'), reasonCode: 'question_expired', delivered: false},
    {state: 'reply_reconciled', questionId: uuid(10), taskId: uuid(11), completionHash: hash('completion'), replyReceiptHash: hash('receipt'), correlationId: uuid(90)},
  ]) {
    const f = await fixture({checkpoint: async () => raw, submitAnswer: async () => ({})});
    try {assert.deepEqual(payload(await f.client.callTool({name: 'cooperative_checkpoint', arguments: {}})), {schema, ...raw});}
    finally {await f.close();}
  }
});

test('closing the SDK server does not close or retire its embedding-owned consumer', async () => {
  let closes = 0;
  const consumer = {checkpoint: async () => ({state: 'idle'}), submitAnswer: async () => ({}), close: async () => {closes++;}, retire: async () => {closes++;}};
  const f = await fixture(consumer); await f.close(); assert.equal(closes, 0);
});

test('two actual SDK servers keep their injected consumers isolated', async () => {
  let first = 0, second = 0;
  const a = await fixture({checkpoint: async () => {first++; return {state: 'idle'};}, submitAnswer: async () => ({})});
  const b = await fixture({checkpoint: async () => {second++; return {state: 'budget_denied', questionId: uuid(10), taskId: uuid(11)};}, submitAnswer: async () => ({})});
  try {
    assert.equal(payload(await a.client.callTool({name: 'cooperative_checkpoint', arguments: {}})).state, 'idle');
    assert.equal(payload(await b.client.callTool({name: 'cooperative_checkpoint', arguments: {}})).state, 'budget_denied');
    assert.equal(first, 1); assert.equal(second, 1);
  } finally {await a.close(); await b.close();}
});

test('the signed-offer schema mirror matches the canonical contract and its existing public validator', async () => {
  const runtime = JSON.parse(await readFile(new URL('./session-question.schema.json', import.meta.url), 'utf8'));
  const canonical = JSON.parse(await readFile(new URL('../../contracts/src/session-question.schema.json', import.meta.url), 'utf8'));
  assert.deepEqual(runtime, canonical);
  const signed = offer(); assert.equal(validateSessionQuestionContract(signed).ok, true);
  assert.equal(validateSessionQuestionContract({...signed, signature: 'invalid'}).ok, false);
});

test('the runtime MCP contract is byte-structure identical to the canonical schema', async () => {
  const runtime = JSON.parse(await readFile(new URL('./cooperative-session-tools-v1.schema.json', import.meta.url), 'utf8'));
  const canonical = JSON.parse(await readFile(new URL('../../../schemas/cooperative-session-tools-v1.schema.json', import.meta.url), 'utf8'));
  assert.deepEqual(runtime, canonical);
});

test('invalid or accessor-bearing signals reject without invoking callbacks or poisoning', async () => {
  let callbacks = 0, calls = 0;
  const controller = new AbortController();
  const accessor = new AbortController().signal;
  Object.defineProperty(accessor, 'aborted', {get() {callbacks++; throw new Error('must not read');}});
  const proxy = new Proxy(controller.signal, {get() {callbacks++; throw new Error('must not read');}});
  const revoked = Proxy.revocable(controller.signal, {}); revoked.revoke();
  for (const signal of [undefined, null, {}, Object.create(AbortSignal.prototype), accessor, proxy, revoked.proxy]) {
    const h = createCooperativeSessionMcpHandlers({checkpoint: async () => {calls++; return {state: 'idle'};}, submitAnswer: async () => ({})});
    assert.deepEqual(payload(await h.checkpoint({}, signal as AbortSignal)), {schema, state: 'error', code: 'input_invalid'});
    assert.equal(calls, 0); assert.equal(callbacks, 0);
  }
});

test('actual SDK submission applies the retained consumer UTF-16 answer limit before dispatch', async () => {
  let calls = 0;
  const f = await fixture({checkpoint: async () => ({state: 'idle'}), submitAnswer: async () => {calls++; return {};}});
  try {
    const result = await f.client.callTool({name: 'cooperative_submit_answer', arguments: {...answer(), answer: '\u{1f642}'.repeat(1001)}});
    assert.equal(result.isError, true); assert.match(JSON.stringify(result), /input_invalid/); assert.equal(calls, 0);
  } finally {await f.close();}
});

test('client cancellation aborts the actual SDK request signal without retiring the owner consumer', async () => {
  let entered!: () => void, release!: () => void, completed!: () => void;
  const started = new Promise<void>(resolve => {entered = resolve;});
  const gate = new Promise<void>(resolve => {release = resolve;});
  const done = new Promise<void>(resolve => {completed = resolve;});
  let observed: AbortSignal | undefined, calls = 0;
  const f = await fixture({checkpoint: async context => {calls++; observed = context.signal; entered(); await gate; completed(); return {state: 'idle'};}, submitAnswer: async () => ({})});
  const controller = new AbortController();
  const operation = f.client.callTool({name: 'cooperative_checkpoint', arguments: {}}, {signal: controller.signal});
  const rejection = assert.rejects(operation);
  try {
    await started; controller.abort(); await rejection;
    await new Promise<void>(resolve => {setImmediate(resolve);});
    assert.equal(observed?.aborted, true);
    release(); await done;
    await new Promise<void>(resolve => {setImmediate(resolve);});
    const next = await f.client.callTool({name: 'cooperative_checkpoint', arguments: {}});
    assert.deepEqual(payload(next), {schema, state: 'error', code: 'unavailable'}); assert.equal(calls, 1);
  } finally {release(); await rejection; await f.close();}
});
