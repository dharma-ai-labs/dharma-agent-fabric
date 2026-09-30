import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { readCodexPublicContext } from './codexPublicContext.js';
import { openCodexAppServerTransport } from './codexAppServerTransport.js';

function fixture() {
  const scope = { threadId: 'retained-synthetic-thread', workspaceRoot: '/synthetic/repository' };
  const thread = { id: scope.threadId, cwd: scope.workspaceRoot, status: { type: 'idle' }, turns: [{
    id: 'prior-turn', status: 'completed', items: [
      { type: 'userMessage', content: [{ type: 'text', text: 'Define a logical job.' }] },
      { type: 'agentMessage', text: 'One tenant-scoped operation.', encryptedContent: 'PROTECTED_CANARY' },
      { type: 'reasoning', summary: ['REASONING_CANARY'], content: ['PROTECTED_REASONING'] },
    ],
  }] };
  const resumed = { thread, model: 'gpt-5.4-mini', modelProvider: 'openai', reasoningEffort: 'low' };
  const calls: string[] = [];
  const transport = { onNotification() { return () => {}; }, async request(method: string, params: Record<string, unknown>) {
    calls.push(method);
    assert.equal(params.threadId, scope.threadId);
    assert.equal('model' in params, false);
    if (method === 'thread/resume') return resumed;
    assert.equal(method, 'thread/read');
    return { thread };
  } };
  return { scope, thread, resumed, calls, transport };
}

test('public retained history is scoped and excludes protected reasoning without claiming executed model', async () => {
  const f = fixture(), result = await readCodexPublicContext(f.transport, f.scope);
  assert.deepEqual(f.calls, ['thread/read', 'thread/resume', 'thread/read']);
  assert.equal(result.context.executedModel, null);
  assert.equal(result.context.configuredModel, 'gpt-5.4-mini');
  assert.equal(result.context.replayMode, 'task_level');
  assert.equal(result.bytes.includes('CANARY'), false);
  assert.equal(result.bytes.includes('PROTECTED_REASONING'), false);
  assert.ok(result.bytes.includes('One tenant-scoped operation.'));
  assert.equal(result.contextHash, `sha256:${createHash('sha256').update(result.bytes).digest('hex')}`);
});

test('history recovery resumes an unloaded exact thread without starting an inference turn', async () => {
  const f = fixture();
  f.transport.request = async (method, params) => {
    f.calls.push(method);
    assert.equal(params.threadId, f.scope.threadId);
    if (method === 'thread/resume') return f.resumed;
    return { thread: { ...f.thread, status: { type: params.includeTurns ? 'idle' : 'notLoaded' } } };
  };
  await readCodexPublicContext(f.transport, f.scope);
  assert.equal(f.calls.includes('turn/start'), false);
});

test('foreign or busy threads are rejected before resume', async () => {
  for (const mutate of [(f: ReturnType<typeof fixture>) => { f.thread.id = 'foreign'; },
    (f: ReturnType<typeof fixture>) => { f.thread.cwd = '/other/repository'; },
    (f: ReturnType<typeof fixture>) => { f.thread.status.type = 'active'; }]) {
    const f = fixture(); mutate(f);
    await assert.rejects(readCodexPublicContext(f.transport, f.scope), /scope_mismatch/);
    assert.deepEqual(f.calls, ['thread/read']);
  }
});

test('public history containing credentials or nonterminal turns cannot prepare learning provenance', async () => {
  const secret = fixture(); secret.thread.turns[0]!.items[1]!.text = `Bearer ${'s'.repeat(40)}`;
  await assert.rejects(readCodexPublicContext(secret.transport, secret.scope), /credentials_forbidden/);
  const active = fixture(); active.thread.turns[0]!.status = 'inProgress';
  await assert.rejects(readCodexPublicContext(active.transport, active.scope), /active_turn/);
  const large = fixture(); large.thread.turns[0]!.items[1]!.text = 'x'.repeat(2 * 1024 * 1024);
  await assert.rejects(readCodexPublicContext(large.transport, large.scope), /history_unavailable/);
});

test('unreported configuration is not inferred from generic runtime defaults', async () => {
  const f = fixture(); f.resumed.model = '';
  await assert.rejects(readCodexPublicContext(f.transport, f.scope), /configuration_unavailable/);
});

test('a changed scope after resume or during history read is rejected', async () => {
  for (const failedCall of ['thread/resume', 'history']) {
    const f = fixture(), original = f.transport.request;
    f.transport.request = async (method, params) => {
      const response = await original(method, params);
      if ((failedCall === method) || (failedCall === 'history' && params.includeTurns === true)) {
        return { ...response, thread: { ...f.thread, id: 'foreign-after-first-read' } };
      }
      return response;
    };
    await assert.rejects(readCodexPublicContext(f.transport, f.scope), /scope_mismatch/);
  }
});

test('native Codex public history API without credentials or an inference turn', {
  skip: process.platform !== 'linux' || process.env.DHARMA_TEST_NATIVE_CODEX !== '1', timeout: 60000,
}, async t => {
  const root = await mkdtemp(join(tmpdir(), 'codex-context-native-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, 'codex-home'), workspaceRoot = join(root, 'workspace');
  await mkdir(home); await mkdir(workspaceRoot);
  const transport = await openCodexAppServerTransport({ command: 'codex', cwd: workspaceRoot,
    environment: { PATH: process.env.PATH, HOME: root, CODEX_HOME: home }, experimentalApi: true,
    argv: ['-c', 'default_permissions="dharma_bridge"', '-c',
      'permissions.dharma_bridge.filesystem={":minimal"="read",":workspace_roots"={"."="read"}}',
      '-c', 'permissions.dharma_bridge.network={enabled=false}', 'app-server'] });
  t.after(() => transport.close());
  const created = await transport.request('thread/start', { cwd: workspaceRoot,
    approvalPolicy: 'never', permissions: 'dharma_bridge', ephemeral: false }) as { thread: { id: string } };
  await transport.request('thread/name/set', { threadId: created.thread.id, name: 'synthetic-context-api-check' });
  const calls: string[] = [];
  const bounded = { onNotification: transport.onNotification,
    async request(method: string, params: Record<string, unknown>) {
      calls.push(method);
      if (!['thread/read', 'thread/resume'].includes(method)) throw new Error('inference_forbidden');
      return transport.request(method, params);
    } };
  const result = await readCodexPublicContext(bounded, { threadId: created.thread.id, workspaceRoot });
  assert.equal(result.context.turns.length, 0);
  assert.equal(result.context.executedModel, null);
  assert.deepEqual(calls, ['thread/read', 'thread/resume', 'thread/read']);
  t.diagnostic(JSON.stringify({ runtimeVersion: execFileSync('codex', ['--version'], { encoding: 'utf8' }).trim(),
    inferenceTurns: 0, configuredModel: result.context.configuredModel,
    contextHash: result.contextHash, enrolledIdentity: false }));
});
