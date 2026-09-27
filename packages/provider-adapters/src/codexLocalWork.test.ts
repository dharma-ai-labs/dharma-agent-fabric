import assert from 'node:assert/strict';
import test from 'node:test';
import { resolve } from 'node:path';
import { runCodexLocalWork, type CodexAppServerTransport, type CodexToolHandler, type CodexToolResult } from './codexAppServerSession.js';

function fixture(expanded = false, usage: unknown = null) {
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  const listeners = new Set<(value: unknown) => void>();
  const workspaceRoot = resolve('/tmp/dharma-local-work');
  const transport: CodexAppServerTransport = {
    onNotification(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    async request(method, params) {
      calls.push({ method, params });
      if (method === 'permissionProfile/list') return { data: [{ id: 'dharma_work', allowed: true }] };
      if (method === 'config/read') return { config: { permissions: { dharma_work: {
        filesystem: { ':minimal': 'read', ':workspace_roots': { '.': 'write', ...(expanded ? { '..': 'write' } : {}) } },
        network: { enabled: false },
      } } } };
      if (method === 'thread/read') return { thread: { id: 'thread-1', cwd: workspaceRoot, status: { type: 'idle' } } };
      if (method === 'turn/start') {
        for (let index = 0; index < 100; index++) listeners.forEach(listener => listener({
          method: 'item/agentMessage/delta', params: { threadId: 'thread-1', delta: 'streaming' },
        }));
        if (usage) listeners.forEach(listener => listener({ method: 'thread/tokenUsage/updated',
          params: { threadId: 'thread-1', turnId: 'turn-1', tokenUsage: usage } }));
        queueMicrotask(() => listeners.forEach(listener => listener({ method: 'turn/completed', params: {
          threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed',
            items: [{ type: 'agentMessage', phase: 'final_answer', text: 'Tests passed.' }] },
        } })));
        return { turn: { id: 'turn-1' } };
      }
      throw new Error('unexpected');
    },
  };
  const binding = { owner: 'dharma_bridge', provider: 'codex' as const, threadId: 'thread-1', workspaceRoot,
    organizationId: 'org_test', repositoryBindingId: 'repo', workspaceId: 'workspace', endpointId: 'endpoint',
    membershipId: 'member', deviceId: 'device', bindingId: 'binding', expiresAt: new Date(Date.now() + 60_000).toISOString(),
    maximumProviderCostCents: 25 };
  return { transport, binding, calls, exclusiveLease: { assertHeld: async () => true },
    budget: { reserve: async () => true }, workId: 'work-1', prompt: 'Repair the duplicate-job defect.',
    maximumProviderCostCents: 25, writeRoots: ['.'] };
}

test('local coding work selects its bounded profile on the retained thread', { skip: process.platform !== 'linux' }, async () => {
  const f = fixture();
  const result = await runCodexLocalWork(f);
  assert.equal(result.answer, 'Tests passed.');
  const turn = f.calls.find(call => call.method === 'turn/start')!;
  assert.equal(turn.params.threadId, 'thread-1');
  assert.equal(turn.params.permissions, 'dharma_work');
  assert.equal(turn.params.approvalPolicy, 'never');
});

test('expanded local write profile fails before reservation or a turn', { skip: process.platform !== 'linux' }, async () => {
  const f = fixture(true);
  let reserved = false;
  f.budget.reserve = async () => { reserved = true; return true; };
  await assert.rejects(runCodexLocalWork(f), /profile_unavailable/);
  assert.equal(reserved, false);
  assert.equal(f.calls.some(call => call.method === 'turn/start'), false);
});

test('lost lease and expired binding cannot authorize local work', { skip: process.platform !== 'linux' }, async () => {
  const f = fixture();
  f.exclusiveLease.assertHeld = async () => false;
  await assert.rejects(runCodexLocalWork(f), /lease_unavailable/);
  f.exclusiveLease.assertHeld = async () => true;
  f.binding.expiresAt = new Date(0).toISOString();
  await assert.rejects(runCodexLocalWork(f), /binding_invalid/);
  assert.equal(f.calls.some(call => call.method === 'turn/start'), false);
});

test('budget denial prevents local execution', { skip: process.platform !== 'linux' }, async () => {
  const f = fixture();
  f.budget.reserve = async () => false;
  await assert.rejects(runCodexLocalWork(f), /budget_unavailable/);
  assert.equal(f.calls.some(call => call.method === 'turn/start'), false);
});

test('completion retains exact provider usage despite a long notification stream', { skip: process.platform !== 'linux' }, async () => {
  const breakdown = { inputTokens: 100, cachedInputTokens: 20, cacheWriteInputTokens: 0,
    outputTokens: 30, reasoningOutputTokens: 10, totalTokens: 130 };
  const usage = { total: breakdown, last: breakdown, modelContextWindow: 272000 };
  const result = await runCodexLocalWork(fixture(false, usage));
  assert.deepEqual(result.providerUsage, usage);
  assert.equal(result.providerThreadId, 'thread-1');
  assert.equal(result.providerTurnId, 'turn-1');
  assert.ok(result.elapsedMs >= 0);
});

test('missing or malformed provider usage remains unknown, not zero cost', { skip: process.platform !== 'linux' }, async () => {
  for (const usage of [null, { total: { inputTokens: -1 }, last: {}, modelContextWindow: null }]) {
    const result = await runCodexLocalWork(fixture(false, usage));
    assert.equal(result.providerUsage, null);
  }
});

test('peer tools are fenced to the active local turn and removed before another turn', { skip: process.platform !== 'linux' }, async () => {
  const f = fixture(), original = f.transport.request;
  let registered: CodexToolHandler | undefined, retained: CodexToolHandler | undefined;
  let invoked = 0, removed = 0;
  const observations: CodexToolResult[] = [];
  f.transport.onToolCall = handler => {
    registered = handler; retained = handler;
    return () => { registered = undefined; removed++; };
  };
  f.transport.request = async (method, params) => {
    if (method !== 'turn/start') return original(method, params);
    setImmediate(() => void (async () => {
      const call = { threadId: 'thread-1', turnId: 'turn-1', callId: 'call-1', tool: 'dharma_peer_ask', arguments: {} };
      observations.push(await registered!({ ...call, threadId: 'foreign' }));
      observations.push(await registered!({ ...call, turnId: 'prior-turn' }));
      observations.push(await registered!(call));
      observations.push(await registered!(call));
      f.exclusiveLease.assertHeld = async () => false;
      observations.push(await registered!({ ...call, callId: 'call-2' }));
      f.exclusiveLease.assertHeld = async () => true;
      // Complete through the original fixture only after the tool assertions.
      await original(method, params);
    })());
    return { turn: { id: 'turn-1' } };
  };
  await runCodexLocalWork({ ...f, toolHandler: async () => {
    invoked++; return { success: true, contentItems: [{ type: 'inputText', text: 'queued, not answered' }] };
  } });
  assert.deepEqual(observations.map(value => value.success), [false, false, true, false, false]);
  assert.equal(invoked, 1); assert.equal(removed, 1); assert.equal(registered, undefined);
  assert.equal((await retained!({ threadId: 'thread-1', turnId: 'turn-1', callId: 'late-call' })).success, false);
  assert.equal(invoked, 1);
});
