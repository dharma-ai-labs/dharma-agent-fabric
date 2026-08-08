import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import {
  activateAgyPlugin,
  assertTaskSkillPin,
  installRepositoryAgentFabricSkill,
  isDirectExecution,
  materializeWorkspacePolicy,
  materializeInlineSkillFiles,
  nativeSkillDirectory,
  run,
  taskResponsePreview,
  taskSkillPinFailureCode,
} from './index.js';
import type { SkillBundle } from '@dharma-ai/agent-fabric-skill-manager';

test('version is parser-safe structured output', async () => {
  assert.deepEqual(await run(['version']), { version: '0.1.0' });
});

test('global npm symlinks still execute the CLI entrypoint', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dharma-cli-entrypoint-'));
  const target = join(root, 'dist', 'index.js');
  const link = join(root, 'bin', 'dharma');
  await mkdir(join(root, 'dist'), { recursive: true });
  await mkdir(join(root, 'bin'), { recursive: true });
  await writeFile(target, '#!/usr/bin/env node\n');
  await symlink(target, link);
  assert.equal(isDirectExecution(link, pathToFileURL(target).href), true);
});

test('unknown commands fail as usage errors', async () => {
  await assert.rejects(() => run(['unknown']), /Usage:/);
});

test('repository onboarding skill records scoped API metadata without local paths or credentials', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'dharma-repository-skill-'));
  const result = await installRepositoryAgentFabricSkill({
    workspace,
    hqUrl: 'https://hq.dharma-ai.io',
    organizationId: 'org_northstar',
    workspaceId: 'workspace-northstar',
    policyRevision: 'policy-v1',
  });
  const skill = await readFile(join(workspace, result.skillPath), 'utf8');
  const connection = await readFile(join(workspace, result.connectionPath), 'utf8');
  assert.match(skill, /structured, task-bound handoff/);
  assert.match(connection, /workspace-northstar/);
  assert.equal(connection.includes(workspace), false);
  assert.equal(/token|secret/i.test(connection), false);
  await installRepositoryAgentFabricSkill({
    workspace,
    hqUrl: 'https://hq.dharma-ai.io',
    organizationId: 'org_northstar',
    workspaceId: 'workspace-northstar',
    policyRevision: 'policy-v2',
  });
  assert.match(await readFile(join(workspace, result.connectionPath), 'utf8'), /policy-v2/);
});

test('repository onboarding refuses to overwrite an unmanaged skill', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'dharma-repository-skill-unmanaged-'));
  const root = join(workspace, '.agents', 'skills', 'dharma-agent-fabric');
  await mkdir(root, { recursive: true });
  await writeFile(join(root, 'SKILL.md'), '# Customer-owned skill\n');
  await assert.rejects(() => installRepositoryAgentFabricSkill({
    workspace,
    hqUrl: 'https://hq.dharma-ai.io',
    organizationId: 'org_northstar',
    workspaceId: 'workspace-northstar',
    policyRevision: 'policy-v1',
  }), /Refusing to replace an unmanaged repository skill/);
});

test('blank-slate onboarding creates a conservative executable workspace policy', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'dharma-policy-'));
  await mkdir(join(workspace, 'src'));
  await writeFile(join(workspace, 'package.json'), JSON.stringify({ scripts: {
    test: 'node --test', lint: 'eslint .', deploy: 'curl https://example.com',
  } }));
  const generated = await materializeWorkspacePolicy({
    workspace, organizationId: 'org_northstar', revision: 'policy-1',
  });
  assert.equal(generated.relativePath, '.dharma/approved-policy.json');
  assert.deepEqual(Object.keys(generated.policy.tasks.allowedCommands), ['repo.test', 'repo.lint']);
  assert.deepEqual(generated.policy.tasks.writePaths, ['src/**']);
  assert.equal(generated.policy.tasks.defaultNetwork, 'deny');
  assert.equal(generated.policy.skills.automaticPromotionMaxRisk, 'R2');
  const persisted = JSON.parse(await readFile(join(workspace, generated.relativePath), 'utf8'));
  assert.equal(persisted.organizationId, 'org_northstar');
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

test('provider skill roots map to each host native discovery directory', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dharma-provider-skills-'));
  assert.equal(nativeSkillDirectory('codex', {}, home), join(home, '.codex', 'skills'));
  assert.equal(nativeSkillDirectory('claude', {}, home), join(home, '.claude', 'skills'));
  assert.equal(
    nativeSkillDirectory('agy', {}, home),
    join(home, '.gemini', 'antigravity-cli', 'plugins', 'dharma-agent-fabric', 'skills'),
  );
  assert.equal(nativeSkillDirectory('codex', { CODEX_HOME: join(home, 'custom-codex') }, home), join(home, 'custom-codex', 'skills'));
  assert.equal(nativeSkillDirectory('claude', { CLAUDE_CONFIG_DIR: join(home, 'custom-claude') }, home), join(home, 'custom-claude', 'skills'));
  assert.equal(
    nativeSkillDirectory('agy', { AGY_CONFIG_DIR: join(home, 'custom-agy') }, home),
    join(home, 'custom-agy', 'plugins', 'dharma-agent-fabric', 'skills'),
  );
});

test('Agy activation validates the generated plugin before enabling it', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dharma-agy-plugin-'));
  const calls: Array<{ executable: string; argv: string[] }> = [];
  await activateAgyPlugin({
    home,
    env: {},
    execute: async (executable, argv) => { calls.push({ executable, argv }); },
  });
  const root = join(home, '.gemini', 'antigravity-cli', 'plugins', 'dharma-agent-fabric');
  assert.deepEqual(JSON.parse(await readFile(join(root, 'plugin.json'), 'utf8')), { name: 'dharma-agent-fabric' });
  assert.deepEqual(calls, [
    { executable: 'agy', argv: ['plugin', 'validate', root] },
    { executable: 'agy', argv: ['plugin', 'enable', 'dharma-agent-fabric'] },
  ]);
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
