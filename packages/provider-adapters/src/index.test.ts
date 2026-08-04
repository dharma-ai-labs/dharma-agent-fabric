import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { codexAdapter, executeProviderTask } from './index.js';

test('Codex discovery admits only sessions bound to the requested workspace', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dharma-provider-'));
  const workspace = join(root, 'repo');
  const sessions = join(root, 'sessions');
  await mkdir(workspace);
  await mkdir(sessions);
  await writeFile(join(sessions, 'good.jsonl'), [
    JSON.stringify({ type: 'session_meta', payload: { cwd: workspace }, timestamp: '2026-08-03T01:00:00Z' }),
    JSON.stringify({ type: 'user_message', payload: { cwd: workspace, text: 'fix the test' }, timestamp: '2026-08-03T01:00:01Z' }),
  ].join('\n'));
  await writeFile(join(sessions, 'foreign.jsonl'), JSON.stringify({ type: 'user_message', cwd: join(root, 'other') }));

  const result = await codexAdapter.discover({ workspace, roots: [sessions] });
  assert.equal(result.length, 1);
  assert.equal(result[0]?.records.length, 2);
});

test('cwd-less sessions are not inferred into a workspace', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dharma-provider-'));
  const workspace = join(root, 'repo');
  const sessions = join(root, 'sessions');
  await mkdir(workspace);
  await mkdir(sessions);
  await writeFile(join(sessions, 'unknown.jsonl'), JSON.stringify({ type: 'user_message', text: 'unbound' }));
  assert.deepEqual(await codexAdapter.discover({ workspace, roots: [sessions] }), []);
});

test('discovery bounds oversized sessions and marks sampled evidence partial', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dharma-provider-'));
  const workspace = join(root, 'repo');
  const sessions = join(root, 'sessions');
  await mkdir(workspace);
  await mkdir(sessions);
  await writeFile(join(sessions, 'large.jsonl'), [
    JSON.stringify({ type: 'session_meta', payload: { cwd: workspace }, timestamp: '2026-08-03T01:00:00Z' }),
    JSON.stringify({ type: 'tool_result', payload: { cwd: workspace, output: 'x'.repeat(300_000) } }),
    JSON.stringify({ type: 'assistant_message', payload: { cwd: workspace, text: 'bounded result' }, timestamp: '2026-08-03T01:00:02Z' }),
  ].join('\n'));
  const result = await codexAdapter.discover({
    workspace,
    roots: [sessions],
    maximumSessions: 1,
    maximumBytesPerSession: 131_072,
    maximumRecordBytes: 65_536,
  });
  assert.equal(result.length, 1);
  assert.equal(result[0]?.coverage, 'partial');
  assert.ok((result[0]?.records.length ?? 0) <= 2);
});

test('Codex task execution uses stdin, workspace sandboxing, and disabled network without a shell', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dharma-provider-'));
  let observed: Record<string, unknown> = {};
  const result = await executeProviderTask({
    provider: 'codex', workspace: root, instructions: 'Fix the parser test.', timeoutSeconds: 30, allowedCommandArgv: [['npm', 'test']],
    runner: async (input) => {
      observed = input;
      return { exitCode: 0, signal: null, timedOut: false, stdout: Buffer.from('{"type":"result"}\n'), stderr: Buffer.alloc(0) };
    },
  });
  assert.equal(observed.command, 'codex');
  assert.equal(observed.stdin, 'Fix the parser test.');
  assert.deepEqual((observed.argv as string[]).slice(0, 2), ['exec', '--json']);
  assert.ok((observed.argv as string[]).includes('sandbox_workspace_write.network_access=false'));
  assert.equal(result.exitCode, 0);
});

test('Claude task execution exposes only bounded edit tools and registered commands', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dharma-provider-'));
  let argv: string[] = [];
  await executeProviderTask({
    provider: 'claude', workspace: root, instructions: 'Repair the test.', timeoutSeconds: 30, allowedCommandArgv: [['npm', 'test']],
    runner: async (input) => {
      argv = input.argv;
      return { exitCode: 0, signal: null, timedOut: false, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
    },
  });
  assert.ok(argv.includes('Read,Edit,Write,Bash(npm test)'));
  assert.ok(argv.includes('WebFetch,WebSearch'));
  assert.equal(argv.includes('--dangerously-skip-permissions'), false);
});
