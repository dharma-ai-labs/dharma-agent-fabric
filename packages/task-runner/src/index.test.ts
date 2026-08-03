import assert from 'node:assert/strict';
import { test } from 'node:test';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { signCanonicalObject } from '@dharma-ai/agent-fabric-contracts';
import type { OrganizationPolicy } from '@dharma-ai/agent-fabric-policy';
import { executeTask, FileTaskReceiptStore, type TaskEnvelope } from './index.js';

test('signed task runs only a registered command in a relay-owned worktree and deduplicates delivery', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'dharma-task-runner-'));
  const workspace = resolve(root, 'workspace');
  await mkdir(workspace);
  assert.equal(spawnSync('git', ['init', '-q'], { cwd: workspace }).status, 0);
  assert.equal(spawnSync('git', ['config', 'user.email', 'test@dharma-ai.io'], { cwd: workspace }).status, 0);
  assert.equal(spawnSync('git', ['config', 'user.name', 'Dharma Test'], { cwd: workspace }).status, 0);
  assert.equal(spawnSync('git', ['commit', '--allow-empty', '-qm', 'initial'], { cwd: workspace }).status, 0);
  const policy: OrganizationPolicy = {
    schema: 'dharma.organization-policy/v1', organizationId: 'org_test', revision: '1',
    evidence: { defaultMode: 'deep', registeredWorkspaceOnly: true, excludePaths: [], maximumCapsuleBytes: 1, maximumDailyUploadBytes: 1, maximumExpansionBytes: 1 },
    tasks: { defaultNetwork: 'deny', defaultGit: 'task_branch', allowedCommands: { verify: { argv: [process.execPath, '-e', 'process.stdout.write("verified")'], timeoutSeconds: 5 } }, writePaths: [], requireLocalConfirmationFor: [] },
    skills: { automaticInstall: true, automaticPromotionMaxRisk: 'R2', canaryPercent: 10 }, retention: {}, budgets: {},
  };
  const unsigned = {
    schema: 'dharma.task/v1' as const, taskId: randomUUID(), organizationId: 'org_test', workspaceId: 'workspace',
    target: { deviceId: 'device', provider: 'codex' }, instructions: 'Verify the repository.', requiredSkills: [],
    authority: { readPaths: ['.'], writePaths: [], commands: [{ commandId: 'verify' }], network: 'deny', git: 'task_branch' as const },
    execution: { isolation: 'git_worktree' as const, timeoutSeconds: 10, leaseSeconds: 20, maximumConcurrentAgents: 1 },
    acceptance: { commands: [{ commandId: 'verify' }], requiredArtifacts: [] },
    budget: { mode: 'byok_local' as const, maximumDharmaCostCents: 0 },
    createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString(), nonce: randomUUID(),
  };
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const task = { ...unsigned, signature: signCanonicalObject(unsigned, privateKey) } as TaskEnvelope;
  const store = new FileTaskReceiptStore(resolve(root, 'receipts'));
  const first = await executeTask({ task, policy, workspace, relayStateDirectory: resolve(root, 'state'), serverPublicKey: publicKey, receiptStore: store });
  const second = await executeTask({ task, policy, workspace, relayStateDirectory: resolve(root, 'state'), serverPublicKey: publicKey, receiptStore: store });
  assert.equal(first.status, 'completed');
  assert.equal(first.commandResults[0]?.stdout, 'verified');
  assert.deepEqual(second, first);
  assert.equal(JSON.parse(await readFile(resolve(root, 'receipts', `${task.taskId}.json`), 'utf8')).taskId, task.taskId);
});

test('task signature tampering is rejected before worktree creation', async () => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const unsigned = { schema: 'dharma.task/v1', taskId: randomUUID(), expiresAt: new Date(Date.now() + 60_000).toISOString() };
  const task = { ...unsigned, instructions: 'tampered', signature: signCanonicalObject(unsigned, privateKey) } as unknown as TaskEnvelope;
  await assert.rejects(() => executeTask({
    task,
    policy: { organizationId: 'org' } as OrganizationPolicy,
    workspace: tmpdir(), relayStateDirectory: tmpdir(), serverPublicKey: publicKey,
    receiptStore: new FileTaskReceiptStore(resolve(tmpdir(), randomUUID())),
  }), /signature is invalid/);
});
