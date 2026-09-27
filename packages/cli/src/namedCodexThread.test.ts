import assert from 'node:assert/strict';
import test from 'node:test';
import { resolve } from 'node:path';
import type { CodexAppServerTransport } from '@dharma-ai-labs/agent-fabric-provider-adapters/experimental/codex-session';
import { CODEX_PEER_TOOLS } from './codexPeerTools.js';
import { startNamedCodexThread } from './namedCodexThread.js';

const workspace = resolve('synthetic-workspace');
function fixture() {
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  const thread = { id: 'thread-1', cwd: workspace, status: { type: 'idle' }, name: 'implementer' };
  const transport: CodexAppServerTransport = {
    async request(method, params) { calls.push({ method, params }); return method === 'thread/name/set' ? {} : { thread }; },
    onNotification: () => () => {},
  };
  return { calls, thread, transport };
}

test('new named threads persist their native name before returning an identity for registration', async () => {
  const f = fixture();
  assert.equal(await startNamedCodexThread(f.transport, workspace, 'implementer'), 'thread-1');
  assert.deepEqual(f.calls, [
    { method: 'thread/start', params: { cwd: workspace, approvalPolicy: 'never', permissions: 'dharma_bridge',
      ephemeral: false, dynamicTools: CODEX_PEER_TOOLS } },
    { method: 'thread/name/set', params: { threadId: 'thread-1', name: 'implementer' } },
    { method: 'thread/read', params: { threadId: 'thread-1', includeTurns: false } },
  ]);
});

test('invalid names and workspace roots never start a thread', async () => {
  const f = fixture();
  for (const [root, name] of [[workspace, '../foreign'], ['relative', 'implementer'], [workspace, 'x'.repeat(49)]]) {
    await assert.rejects(startNamedCodexThread(f.transport, root!, name!), /named_session_thread_invalid/);
  }
  assert.equal(f.calls.length, 0);
});

test('invalid native start identity is never named or returned', async () => {
  for (const patch of [{ id: '' }, { id: 'bad/id' }, { cwd: resolve('foreign') }, { status: { type: 'notLoaded' } }]) {
    const f = fixture(); Object.assign(f.thread, patch);
    await assert.rejects(startNamedCodexThread(f.transport, workspace, 'implementer'), /named_session_thread_invalid/);
    assert.equal(f.calls.length, 1);
  }
});

test('a failed name operation does not produce a ready session identity', async () => {
  const f = fixture();
  f.transport.request = async (method, params) => {
    f.calls.push({ method, params });
    if (method === 'thread/name/set') throw new Error('codex_app_server_request_failed');
    return { thread: f.thread };
  };
  await assert.rejects(startNamedCodexThread(f.transport, workspace, 'implementer'), /codex_app_server_request_failed/);
  assert.equal(f.calls.length, 2);
});

test('post-name scope, state and name mismatches never return an identity', async () => {
  for (const patch of [{ id: 'other' }, { cwd: resolve('foreign') }, { name: 'reviewer' }, { status: { type: 'notLoaded' } }]) {
    const f = fixture();
    f.transport.request = async (method, params) => {
      f.calls.push({ method, params });
      return { thread: method === 'thread/read' ? { ...f.thread, ...patch } : f.thread };
    };
    await assert.rejects(startNamedCodexThread(f.transport, workspace, 'implementer'), /named_session_thread_invalid/);
    assert.equal(f.calls.length, 3);
  }
});
