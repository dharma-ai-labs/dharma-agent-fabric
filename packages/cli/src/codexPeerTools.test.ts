import assert from 'node:assert/strict';
import test from 'node:test';
import { CODEX_PEER_TOOLS, createCodexPeerToolHandler } from './codexPeerTools.js';

const id = '40000000-0000-4000-8000-000000000001';
function fixture() {
  const calls: unknown[] = [];
  const input: Parameters<typeof createCodexPeerToolHandler>[0] = { maximumProviderCostCents: 25, authorize: async () => true,
    authorizeContent: async (_content: string) => true,
    channel: () => ({ ask: async args => { calls.push(args); return { state: 'queued', questionId: id,
      taskId: args.taskId, targetBindingId: args.targetBindingId, replay: false, correlationId: id }; },
      read: async (...args) => { calls.push(args); return { state: 'answered', answer: 'Use the logical job identity.',
        questionId: args[0], taskId: args[1], targetBindingId: args[2], failureCode: null,
        replyReceiptHash: 'sha256:' + 'a'.repeat(64), correlationId: id }; } }) };
  return { input, calls };
}
const ask = { tool: 'dharma_peer_ask', namespace: null,
  arguments: { taskId: id, targetBindingId: id, category: 'code-review', question: 'Which retry identity is canonical?' } };
const read = { tool: 'dharma_peer_reply', arguments: { taskId: id, targetBindingId: id, questionId: id } };

test('tools expose bounded schemas, not authentication or permission parameters', () => {
  assert.equal(CODEX_PEER_TOOLS.length, 2);
  for (const tool of CODEX_PEER_TOOLS) {
    assert.equal(tool.type, 'function');
    assert.equal(tool.inputSchema.additionalProperties, false);
    assert.equal(JSON.stringify(tool).includes('credentials'), false);
  }
});

test('peer tools delegate exact scopes and distinguish queued from answered', async () => {
  const f = fixture(), handler = createCodexPeerToolHandler(f.input);
  const queued = await handler(ask);
  assert.equal(JSON.parse(queued.contentItems[0]!.text).state, 'queued');
  assert.deepEqual(f.calls[0], { ...ask.arguments, maximumProviderCostCents: 25 });
  const answered = await handler(read);
  assert.equal(JSON.parse(answered.contentItems[0]!.text).state, 'answered');
  assert.deepEqual(f.calls[1], [id, id, id]);
});

test('malformed or broader arguments never reach the signed channel', async () => {
  const f = fixture(), handler = createCodexPeerToolHandler(f.input);
  for (const call of [ { ...ask, tool: 'approve_device' }, { ...ask, namespace: 'other' },
    { ...ask, arguments: { ...ask.arguments, credentials: 'never' } },
    { ...ask, arguments: { ...ask.arguments, category: 'invalid_category' } },
    { ...ask, arguments: { ...ask.arguments, question: 'x'.repeat(2001) } },
    { ...ask, arguments: { ...ask.arguments, taskId: 'foreign' } } ]) {
    assert.equal((await handler(call)).success, false);
  }
  assert.equal(f.calls.length, 0);
});

test('revocation, post-dispatch authority changes and secrets cannot become successful tool answers', async () => {
  const f = fixture();
  f.input.authorize = async () => false;
  assert.equal((await createCodexPeerToolHandler(f.input)(ask)).success, false);
  assert.equal(f.calls.length, 0);
  let checks = 0;
  f.input.authorize = async () => ++checks === 1;
  const changed = await createCodexPeerToolHandler(f.input)(ask);
  assert.equal(changed.success, false);
  assert.equal(JSON.parse(changed.contentItems[0]!.text).code, 'codex_peer_tool_authority_changed');
  f.input.authorize = async () => true;
  f.input.authorizeContent = async () => false;
  assert.equal((await createCodexPeerToolHandler(f.input)(read)).success, false);
});

test('uncertain delivery is not replayed or described as success', async () => {
  const f = fixture();
  f.input.channel = () => ({ ask: async args => { f.calls.push(args); throw new Error('private provider body'); },
    read: async () => { throw new Error('private provider body'); } });
  const result = await createCodexPeerToolHandler(f.input)(ask);
  assert.equal(result.success, false);
  assert.equal(JSON.parse(result.contentItems[0]!.text).code, 'codex_peer_tool_delivery_unconfirmed');
  assert.equal(f.calls.length, 1);
  assert.equal(JSON.stringify(result).includes('private provider body'), false);
});
