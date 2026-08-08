import assert from 'node:assert/strict';
import { test } from 'node:test';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { signCanonicalObject } from '@dharma-ai/agent-fabric-contracts';
import type { OrganizationPolicy } from '@dharma-ai/agent-fabric-policy';
import {
  assertTaskWithinLocalPolicy,
  executeTask,
  FileTaskReceiptStore,
  providerInstructionsForTask,
  type TaskEnvelope,
} from './index.js';

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
    schema: 'dharma.task/v1' as const, taskId: randomUUID(), organizationId: 'org_test', workspaceId: 'workspace', taskType: 'external_request' as const,
    target: { deviceId: 'device', provider: 'codex' }, skillBundle: null,
    instructions: 'Verify the repository.', requiredSkills: [],
    authority: { readPaths: ['.'], writePaths: [], commands: [{ commandId: 'verify' }], network: 'deny', git: 'task_branch' as const },
    execution: { isolation: 'git_worktree' as const, timeoutSeconds: 10, leaseSeconds: 20, maximumConcurrentAgents: 1 },
    acceptance: { commands: [{ commandId: 'verify' }], requiredArtifacts: [] },
    budget: { mode: 'byok_local' as const, maximumDharmaCostCents: 0 },
    createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString(), nonce: randomUUID(),
  };
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const task = { ...unsigned, signature: signCanonicalObject(unsigned, privateKey) } as TaskEnvelope;
  const store = new FileTaskReceiptStore(resolve(root, 'receipts'));
  let providerExecutions = 0;
  let providerAllowWrites: boolean | null = null;
  const providerExecutor = async (input: { allowWrites: boolean }) => {
    providerExecutions += 1;
    providerAllowWrites = input.allowWrites;
    return {
      provider: 'codex' as const,
      exitCode: 0,
      signal: null,
      timedOut: false,
      stdout: 'agent completed',
      stderr: '',
      stdoutSha256: `sha256:${'1'.repeat(64)}`,
      stderrSha256: `sha256:${'0'.repeat(64)}`,
    };
  };
  const first = await executeTask({ task, policy, workspace, relayStateDirectory: resolve(root, 'state'), serverPublicKey: publicKey, receiptStore: store, providerExecutor });
  const second = await executeTask({ task, policy, workspace, relayStateDirectory: resolve(root, 'state'), serverPublicKey: publicKey, receiptStore: store, providerExecutor });
  assert.equal(first.status, 'completed');
  assert.equal(first.commandResults[0]?.commandId, 'provider.codex');
  assert.equal(first.commandResults[1]?.stdout, 'verified');
  assert.equal(providerExecutions, 1);
  assert.equal(providerAllowWrites, false);
  assert.deepEqual(second, first);
  assert.equal(JSON.parse(await readFile(resolve(root, 'receipts', `${task.taskId}.json`), 'utf8')).taskId, task.taskId);
});

test('task signature tampering is rejected before worktree creation', async () => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const unsigned = {
    schema: 'dharma.task/v1' as const,
    taskId: randomUUID(),
    organizationId: 'org',
    workspaceId: 'workspace',
    taskType: 'external_request' as const,
    target: { deviceId: 'device', provider: 'codex' as const },
    skillBundle: null,
    instructions: 'original',
    requiredSkills: [],
    authority: { readPaths: ['.'], writePaths: [], commands: [], network: 'deny', git: 'task_branch' as const },
    execution: { isolation: 'git_worktree' as const, timeoutSeconds: 10, leaseSeconds: 20, maximumConcurrentAgents: 1 },
    acceptance: { commands: [], requiredArtifacts: [] },
    budget: { mode: 'byok_local' as const, maximumDharmaCostCents: 0 },
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    nonce: randomUUID(),
  };
  const task = { ...unsigned, instructions: 'tampered', signature: signCanonicalObject(unsigned, privateKey) } as unknown as TaskEnvelope;
  await assert.rejects(() => executeTask({
    task,
    policy: { organizationId: 'org' } as OrganizationPolicy,
    workspace: tmpdir(), relayStateDirectory: tmpdir(), serverPublicKey: publicKey,
    receiptStore: new FileTaskReceiptStore(resolve(tmpdir(), randomUUID())),
  }), /signature is invalid/);
});

test('task authority cannot exceed the local policy', () => {
  const policy = {
    tasks: { defaultNetwork: 'deny', writePaths: ['src/**'] },
  } as OrganizationPolicy;
  const base = {
    authority: { readPaths: ['.'], writePaths: ['src/parser.ts'], commands: [], network: 'deny', git: 'task_branch' },
  } as unknown as TaskEnvelope;
  assert.doesNotThrow(() => assertTaskWithinLocalPolicy(base, policy));
  assert.throws(
    () => assertTaskWithinLocalPolicy({ ...base, authority: { ...base.authority, writePaths: ['secrets'] } }, policy),
    /write authority exceeds/,
  );
  assert.throws(
    () => assertTaskWithinLocalPolicy({ ...base, authority: { ...base.authority, network: 'allowlisted_domains' } }, policy),
    /network authority exceeds/,
  );
});

test('provider changes outside signed write paths fail even when untracked or committed', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'dharma-task-containment-'));
  const workspace = resolve(root, 'workspace');
  await mkdir(resolve(workspace, 'src'), { recursive: true });
  await writeFile(resolve(workspace, 'src', 'allowed.ts'), 'export const allowed = true;\n');
  await writeFile(resolve(workspace, 'outside.txt'), 'protected\n');
  assert.equal(spawnSync('git', ['init', '-q'], { cwd: workspace }).status, 0);
  assert.equal(spawnSync('git', ['config', 'user.email', 'test@dharma-ai.io'], { cwd: workspace }).status, 0);
  assert.equal(spawnSync('git', ['config', 'user.name', 'Dharma Test'], { cwd: workspace }).status, 0);
  assert.equal(spawnSync('git', ['add', '.'], { cwd: workspace }).status, 0);
  assert.equal(spawnSync('git', ['commit', '-qm', 'initial'], { cwd: workspace }).status, 0);
  const policy: OrganizationPolicy = {
    schema: 'dharma.organization-policy/v1', organizationId: 'org_test', revision: '1',
    evidence: { defaultMode: 'deep', registeredWorkspaceOnly: true, excludePaths: [], maximumCapsuleBytes: 1, maximumDailyUploadBytes: 1, maximumExpansionBytes: 1 },
    tasks: { defaultNetwork: 'deny', defaultGit: 'task_branch', allowedCommands: {}, writePaths: ['src/**'], requireLocalConfirmationFor: [] },
    skills: { automaticInstall: true, automaticPromotionMaxRisk: 'R2', canaryPercent: 10 }, retention: {}, budgets: {},
  };
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const makeTask = () => {
    const unsigned = {
      schema: 'dharma.task/v1' as const, taskId: randomUUID(), organizationId: 'org_test', workspaceId: 'workspace', taskType: 'external_request' as const,
      target: { deviceId: 'device', provider: 'codex' as const }, skillBundle: null,
      instructions: 'Make the requested repository change.', requiredSkills: [],
      authority: { readPaths: ['.'], writePaths: ['src/**'], commands: [], network: 'deny', git: 'task_branch' as const },
      execution: { isolation: 'git_worktree' as const, timeoutSeconds: 10, leaseSeconds: 20, maximumConcurrentAgents: 1 },
      acceptance: { commands: [], requiredArtifacts: [] },
      budget: { mode: 'byok_local' as const, maximumDharmaCostCents: 0 },
      createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString(), nonce: randomUUID(),
    };
    return { ...unsigned, signature: signCanonicalObject(unsigned, privateKey) } as TaskEnvelope;
  };
  const providerResult = {
    provider: 'codex' as const, exitCode: 0, signal: null, timedOut: false,
    stdout: 'done', stderr: '', stdoutSha256: `sha256:${'1'.repeat(64)}`, stderrSha256: `sha256:${'0'.repeat(64)}`,
  };

  const untracked = await executeTask({
    task: makeTask(), policy, workspace, relayStateDirectory: resolve(root, 'untracked-state'),
    serverPublicKey: publicKey, receiptStore: new FileTaskReceiptStore(resolve(root, 'untracked-receipts')),
    providerExecutor: async ({ workspace: worktree }) => {
      await writeFile(resolve(worktree, 'untracked-outside.txt'), 'not authorized\n');
      return providerResult;
    },
  });
  assert.equal(untracked.status, 'failed');
  assert.match(untracked.commandResults.at(-1)?.stderr || '', /outside the signed task authority/);

  const committed = await executeTask({
    task: makeTask(), policy, workspace, relayStateDirectory: resolve(root, 'committed-state'),
    serverPublicKey: publicKey, receiptStore: new FileTaskReceiptStore(resolve(root, 'committed-receipts')),
    providerExecutor: async ({ workspace: worktree }) => {
      await writeFile(resolve(worktree, 'outside.txt'), 'changed outside scope\n');
      assert.equal(spawnSync('git', ['add', 'outside.txt'], { cwd: worktree }).status, 0);
      assert.equal(spawnSync('git', ['commit', '-qm', 'unauthorized change'], { cwd: worktree }).status, 0);
      return providerResult;
    },
  });
  assert.equal(committed.status, 'failed');
  assert.match(committed.commandResults.at(-1)?.stderr || '', /outside the signed task authority/);
});

test('A2A task instructions carry bounded signed state and evidence context', () => {
  const task = {
    taskType: 'a2a_handoff',
    instructions: 'Return a code-fix proposal.',
    source: { taskId: randomUUID(), endpointId: randomUUID() },
    stateEnvelope: {
      intent: 'Help the support agent resolve a checkout parser defect.',
      evidence_used: ['trace:checkout-42'],
      known_state: { failingTest: 'checkout-parser.test.ts' },
      unknown_or_missing_state: ['root cause'],
      allowed_next_actions: ['inspect repository', 'propose patch'],
      blocked_actions: ['deploy', 'read secrets'],
      decision_authority: 'read-only proposal',
      tool_results: [{ tool: 'trace_lookup', status: 'failed_test_observed' }],
    },
    evidenceReferences: [{ trajectoryId: randomUUID(), revision: 1, capsuleHash: `sha256:${'a'.repeat(64)}` }],
  } as unknown as TaskEnvelope;
  const instructions = providerInstructionsForTask(task);
  assert.match(instructions, /checkout parser defect/);
  assert.match(instructions, /checkout-parser\.test\.ts/);
  assert.match(instructions, /read-only proposal/);
  assert.match(instructions, /dharma_a2a_context/);
  assert.ok(instructions.length < 20_000);
});

test('non-A2A task instructions remain unchanged', () => {
  assert.equal(providerInstructionsForTask({ taskType: 'external_request', instructions: 'Inspect the build.' } as TaskEnvelope), 'Inspect the build.');
});
