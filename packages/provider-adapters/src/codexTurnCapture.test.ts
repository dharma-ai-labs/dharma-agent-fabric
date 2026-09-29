import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import test from 'node:test';
import { validateContract } from '@dharma-ai-labs/agent-fabric-contracts';
import { createCodexTurnCapture } from './codexTurnCapture.js';

function fixture() {
  const binding = { owner: 'dharma_bridge', provider: 'codex' as const, threadId: 'thread-1',
    workspaceRoot: resolve('repo'), organizationId: 'org_test', repositoryBindingId: randomUUID(),
    workspaceId: randomUUID(), endpointId: randomUUID(), membershipId: randomUUID(), deviceId: randomUUID(),
    bindingId: randomUUID(), expiresAt: new Date(Date.now() + 60000).toISOString(), maximumProviderCostCents: 25 };
  return createCodexTurnCapture(binding, 'work-1');
}

const event = (turnId = 'turn-1', threadId = 'thread-1', text = 'native command output') => ({
  method: 'item/completed', params: { threadId, turnId, item: { type: 'commandExecution', output: text } },
});
const terminal = (status = 'completed') => ({ method: 'turn/completed', params: {
  threadId: 'thread-1', turn: { id: 'turn-1', status, items: [] },
} });

test('early native notifications bind to only the exact thread and turn with integrity', async () => {
  const capture = fixture();
  const good = event();
  capture.observe(event('turn-1', 'foreign-thread'));
  capture.observe(event('other-turn'));
  capture.observe(good);
  capture.observe(terminal());
  capture.bind('turn-1');
  // The caller cannot later mutate retained evidence.
  good.params.item.output = 'mutated';
  capture.observe(event('other-turn'));
  const result = capture.finish('completed');
  assert.equal(result.events.length, 2);
  assert.equal(result.coverage, 'observed');
  assert.equal(result.providerTurnState, 'completed');
  assert.equal(result.acceptedLearningObservation, false);
  assert.equal(result.executedModel, null);
  assert.equal(result.eventsHash, `sha256:${createHash('sha256').update(JSON.stringify(result.events)).digest('hex')}`);
  assert.ok(JSON.stringify(result.events).includes('native command output'));
  assert.equal(JSON.stringify(result).includes('mutated'), false);
  const valid = await validateContract(resolve(import.meta.dirname, '../../../schemas'),
    'https://schemas.dharma-ai.io/codex-local-work-capture/v1', result);
  assert.equal(valid.ok, true, JSON.stringify(valid));
  for (const invalid of [{ ...result, grant: 'never-persist' }, { ...result, acceptedLearningObservation: true },
    { ...result, executedModel: 'configured-not-observed' }, { ...result, deviceId: 'foreign' }]) {
    assert.equal((await validateContract(resolve(import.meta.dirname, '../../../schemas'),
      'https://schemas.dharma-ai.io/codex-local-work-capture/v1', invalid)).ok, false);
  }
});

test('streaming duplicates are real events, not repeated logical observations', () => {
  const capture = fixture(); capture.bind('turn-1');
  capture.observe(event()); capture.observe(event()); capture.observe(terminal());
  const result = capture.finish('completed');
  assert.equal(result.events.length, 3);
  assert.deepEqual(result.events.map(item => item.sequence), [0, 1, 2]);
  assert.equal(result.acceptedLearningObservation, false);
});

test('unscoped and conflicting notifications are explicitly partial, never guessed', () => {
  const capture = fixture(); capture.bind('turn-1');
  capture.observe({ method: 'item/completed', params: { threadId: 'thread-1', item: {} } });
  capture.observe({ method: 'turn/completed', params: { threadId: 'thread-1', turnId: 'other',
    turn: { id: 'turn-1', status: 'completed' } } });
  capture.observe(terminal());
  const result = capture.finish('completed');
  assert.equal(result.coverage, 'partial');
  assert.equal(result.droppedEvents, 2);
  assert.deepEqual(result.limitations, ['conflicting_turn_identity', 'unscoped_notification']);
});

test('capture limits cannot crowd out provider completion or imply a complete trajectory', () => {
  const capture = fixture(); capture.bind('turn-1');
  for (let index = 0; index < 2100; index++) capture.observe(event());
  capture.observe(terminal());
  const result = capture.finish('completed');
  assert.equal(result.events.length, 2048);
  assert.equal(result.droppedEvents, 53);
  assert.equal(result.providerTurnState, 'completed');
  assert.equal(result.coverage, 'partial');
  assert.deepEqual(result.limitations, ['capture_limit']);
});

test('large notifications obey event and total byte limits', () => {
  const capture = fixture(); capture.bind('turn-1');
  capture.observe(event('turn-1', 'thread-1', 'x'.repeat(256 * 1024)));
  for (let index = 0; index < 12; index++) capture.observe(event('turn-1', 'thread-1', 'x'.repeat(200 * 1024)));
  capture.observe(terminal());
  const result = capture.finish('completed');
  assert.ok(result.events.length < 12);
  assert.ok(Buffer.byteLength(JSON.stringify(result)) < 2 * 1024 * 1024 + 8192);
  assert.equal(result.coverage, 'partial');
  assert.ok(result.droppedEvents >= 3);
});

test('recognizable grants and credentials are excluded even from the private capture', () => {
  const capture = fixture(); capture.bind('turn-1');
  for (const text of ['dhab_PRIVATE_TEST_GRANT', 'Bearer private-fixture', '-----BEGIN PRIVATE KEY-----',
    '{"access_token":"private-fixture"}', '{"authorization":"private-fixture"}',
    '{"grant":"private-fixture"}', '{"private_key":"private-fixture"}']) capture.observe(event('turn-1', 'thread-1', text));
  capture.observe({ ...event(), params: { ...event().params, credential: 'direct-field-fixture' } });
  capture.observe({ ...event(), params: { ...event().params, nested: { apiKey: 'camel-case-fixture' } } });
  capture.observe({ ...event(), params: { ...event().params, nested: { API_KEY: 'uppercase-field-fixture' } } });
  capture.observe(terminal());
  const result = capture.finish('completed');
  assert.equal(result.events.length, 1);
  assert.equal(result.coverage, 'partial');
  assert.equal(result.droppedEvents, 10);
  assert.equal(JSON.stringify(result).includes('PRIVATE_TEST_GRANT'), false);
  assert.equal(JSON.stringify(result).includes('private-fixture'), false);
  assert.equal(JSON.stringify(result).includes('direct-field-fixture'), false);
  assert.equal(JSON.stringify(result).includes('camel-case-fixture'), false);
  assert.equal(JSON.stringify(result).includes('uppercase-field-fixture'), false);
});

test('unidentified and unterminated turns remain unavailable or partial', () => {
  const capture = fixture(); capture.observe(event());
  const unknown = capture.finish('failed');
  assert.equal(unknown.providerTurnId, null);
  assert.equal(unknown.events.length, 0);
  assert.equal(unknown.coverage, 'unavailable');
  assert.deepEqual(unknown.limitations, ['terminal_unconfirmed', 'turn_unconfirmed']);
  const interrupted = fixture(); interrupted.bind('turn-1'); interrupted.observe(event());
  const result = interrupted.finish('failed');
  assert.equal(result.providerTurnState, 'unconfirmed');
  assert.equal(result.coverage, 'partial');
});

test('the request snapshot is immutable, versioned and bound to this workspace and thread', async () => {
  const capture = fixture();
  const params = { threadId: 'thread-1', input: [{ type: 'text' as const, text: 'Run public tests.' }] as [{ type: 'text'; text: string }],
    cwd: resolve('repo'), approvalPolicy: 'never' as const, permissions: 'dharma_work' as const };
  capture.retainRequest(params);
  params.input[0].text = 'mutated';
  capture.bind('turn-1'); capture.observe(terminal());
  const result = capture.finish('completed');
  assert.equal(result.schema, 'dharma.codex-local-work-capture/v2');
  if (result.schema !== 'dharma.codex-local-work-capture/v2') return;
  assert.equal(result.request.params.input[0].text, 'Run public tests.');
  assert.equal(result.requestHash, `sha256:${createHash('sha256').update(JSON.stringify(result.request)).digest('hex')}`);
  assert.equal((await validateContract(resolve(import.meta.dirname, '../../../schemas'),
    'https://schemas.dharma-ai.io/codex-local-work-capture/v2', result)).ok, true);
  for (const invalid of [{ ...result, requestHash: undefined }, { ...result, executedModel: 'configured' },
    { ...result, request: { ...result.request, params: { ...result.request.params, permissions: 'unrestricted' } } }]) {
    assert.equal((await validateContract(resolve(import.meta.dirname, '../../../schemas'),
      'https://schemas.dharma-ai.io/codex-local-work-capture/v2', invalid)).ok, false);
  }
  result.request.params.input[0].text = 'second mutation';
  const again = capture.finish('completed');
  assert.equal(again.schema === 'dharma.codex-local-work-capture/v2' && again.request.params.input[0].text, 'Run public tests.');
  assert.throws(() => capture.retainRequest(params), /request_invalid/);
  for (const change of [{ threadId: 'foreign' }, { cwd: resolve('foreign') }]) {
    assert.throws(() => fixture().retainRequest({ ...params, ...change }), /request_invalid/);
  }
});
