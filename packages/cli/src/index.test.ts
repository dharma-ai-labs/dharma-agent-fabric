import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { run, taskResponsePreview } from './index.js';

test('version is parser-safe structured output', async () => {
  assert.deepEqual(await run(['version']), { version: '0.1.0' });
});

test('unknown commands fail as usage errors', async () => {
  await assert.rejects(() => run(['unknown']), /Usage:/);
});

test('evidence preview counts native turns without disclosing paths or prompt bodies', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dharma-cli-preview-'));
  const workspace = join(root, 'repo');
  const sessions = join(root, 'sessions');
  await mkdir(workspace);
  await mkdir(sessions);
  const canonicalWorkspace = await realpath(workspace);
  await writeFile(join(sessions, 'desktop.jsonl'), [
    { type: 'session_meta', payload: { cwd: canonicalWorkspace }, timestamp: '2026-08-03T01:00:00Z' },
    { type: 'turn_context', payload: { turn_id: '019fcaab-6c8e-7432-bfb7-fc63efa3d728', cwd: canonicalWorkspace }, timestamp: '2026-08-03T01:00:01Z' },
    { type: 'event_msg', payload: { type: 'user_message', message: 'private prompt body' }, timestamp: '2026-08-03T01:00:02Z' },
  ].map((value) => JSON.stringify(value)).join('\n'));
  const result = await run([
    'evidence', 'preview', '--workspace', workspace, '--provider', 'codex', '--source-root', sessions,
  ]) as Record<string, unknown>;
  const encoded = JSON.stringify(result);
  assert.equal(result.trajectoryCount, 1);
  assert.equal(encoded.includes(root), false);
  assert.equal(encoded.includes('private prompt body'), false);
});

test('task response preview extracts the final agent message and removes secrets', () => {
  const receipt = {
    taskId: 'task', status: 'completed' as const, worktree: '/private/worktree', branch: 'dharma/task/task',
    startedAt: '2026-08-04T00:00:00Z', completedAt: '2026-08-04T00:00:01Z',
    commandResults: [{
      commandId: 'provider.codex', exitCode: 0, signal: null, timedOut: false,
      stdout: [
        JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'First draft' } }),
        JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'Architecture summary. api_key=secret-secret-secret' } }),
      ].join('\n'),
      stderr: '', stdoutSha256: `sha256:${'1'.repeat(64)}`, stderrSha256: `sha256:${'0'.repeat(64)}`,
    }],
  };
  const preview = taskResponsePreview(receipt);
  assert.match(preview?.text || '', /Architecture summary/);
  assert.equal(preview?.text.includes('secret-secret-secret'), false);
  assert.ok((preview?.redactedValues || 0) >= 1);
});
