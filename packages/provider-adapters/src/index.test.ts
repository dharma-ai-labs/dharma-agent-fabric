import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { codexAdapter } from './index.js';

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
