import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { assertTaskSkillPin, materializeInlineSkillFiles, run, taskResponsePreview, taskSkillPinFailureCode } from './index.js';
import type { SkillBundle } from '@dharma-ai/agent-fabric-skill-manager';

test('version is parser-safe structured output', async () => {
  assert.deepEqual(await run(['version']), { version: '0.1.0' });
});

test('unknown commands fail as usage errors', async () => {
  await assert.rejects(() => run(['unknown']), /Usage:/);
});

test('materializes signed inline files without repository credentials and rejects traversal', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dharma-inline-skill-'));
  const content = Buffer.from('# Private remediation\n');
  const file = {
    path: 'SKILL.md',
    contentBase64: content.toString('base64'),
    sha256: `sha256:${createHash('sha256').update(content).digest('hex')}`,
  };
  const bundle = {
    operation: 'install',
    skills: [{ path: 'skills/remediation', files: [file] }],
  } as unknown as SkillBundle;
  assert.equal(await materializeInlineSkillFiles(bundle, root), true);
  assert.equal(await readFile(join(root, 'skills/remediation/SKILL.md'), 'utf8'), '# Private remediation\n');
  await assert.rejects(
    () => materializeInlineSkillFiles({ ...bundle, skills: [{ path: 'skills/remediation', files: [{ ...file, path: '../secret' }] }] } as unknown as SkillBundle, root),
    /path is invalid/,
  );
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

test('task execution requires the signed bundle pin to match the active native bundle', () => {
  const pin = { bundleId: 'bundle-1', bundleHash: `sha256:${'a'.repeat(64)}` };
  assert.doesNotThrow(() => assertTaskSkillPin(pin, 'bundle-1'));
  assert.doesNotThrow(() => assertTaskSkillPin(null, null));
  assert.throws(
    () => assertTaskSkillPin(pin, 'bundle-2'),
    /does not match the active local bundle \(task=bundle-1, local=bundle-2\)/,
  );
  assert.throws(() => assertTaskSkillPin(undefined as never, 'bundle-1'), /missing its signed/);
  assert.throws(() => assertTaskSkillPin({ ...pin, bundleHash: 'invalid' }, 'bundle-1'), /hash is invalid/);
  assert.equal(taskSkillPinFailureCode(new Error('Task skill bundle does not match the active local bundle.')), 'skill_bundle_mismatch');
  assert.equal(taskSkillPinFailureCode(new Error('Task skill bundle hash is invalid.')), 'skill_bundle_hash_invalid');
});
