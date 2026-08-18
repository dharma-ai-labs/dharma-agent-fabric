import assert from 'node:assert/strict';
import { test } from 'node:test';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  actionDecisionDigest,
  signCanonicalObject,
  type ActionDecisionEnvelope,
  type ActionDecisionReceipt,
} from '@dharma-ai-labs/agent-fabric-contracts';
import type { OrganizationPolicy } from '@dharma-ai-labs/agent-fabric-policy';
import {
  assertTaskWithinLocalPolicy,
  canonicalTaskActionForTask,
  executeTask,
  FileActionDecisionReplayGuard,
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
  assert.equal('actionAcknowledgement' in first, false);
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

function embedDecision(
  baseTask: Omit<TaskEnvelope, 'actionDecision' | 'signature'>,
  outcome: ActionDecisionReceipt['outcome'],
  decisionPrivateKey: ReturnType<typeof generateKeyPairSync>['privateKey'],
  now: Date,
): ActionDecisionEnvelope {
  const actionId = randomUUID();
  const action = canonicalTaskActionForTask(baseTask as TaskEnvelope, actionId);
  const receipt = {
    schema: 'dharma.action-decision-receipt/v1' as const,
    decisionId: randomUUID(), organizationId: baseTask.organizationId, actionId, taskId: baseTask.taskId,
    targetEndpointId: baseTask.target.endpointId!, workspaceId: baseTask.workspaceId,
    evaluationContractId: randomUUID(), evaluationContractVersion: 1,
    actionDigest: actionDecisionDigest(action), stateEnvelopeHash: `sha256:${'a'.repeat(64)}`,
    evidenceReferences: [], outcome, reasonCodes: [`policy_${outcome}`], confidence: outcome === 'release' ? 0.98 : 1,
    evaluator: { provider: 'dharma_deterministic_preflight', model: 'deterministic-v1', configDigest: `sha256:${'b'.repeat(64)}` },
    nonce: randomUUID(), issuedAt: now.toISOString(), expiresAt: baseTask.expiresAt,
    keyVersion: 'projects/test/locations/global/keyRings/test/cryptoKeys/action-decisions/cryptoKeyVersions/1',
  } satisfies ActionDecisionReceipt;
  return {
    id: receipt.decisionId,
    actionDigest: receipt.actionDigest,
    receipt,
    signature: signCanonicalObject(receipt, decisionPrivateKey),
    keyVersion: receipt.keyVersion,
  };
}

test('receipt-required task fails closed before provider execution without an embedded decision', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'dharma-action-decision-'));
  const workspace = resolve(root, 'workspace');
  await mkdir(workspace);
  assert.equal(spawnSync('git', ['init', '-q'], { cwd: workspace }).status, 0);
  assert.equal(spawnSync('git', ['config', 'user.email', 'test@dharma-ai.io'], { cwd: workspace }).status, 0);
  assert.equal(spawnSync('git', ['config', 'user.name', 'Dharma Test'], { cwd: workspace }).status, 0);
  assert.equal(spawnSync('git', ['commit', '--allow-empty', '-qm', 'initial'], { cwd: workspace }).status, 0);
  const policy: OrganizationPolicy = {
    schema: 'dharma.organization-policy/v1', organizationId: 'org_test', revision: '1',
    evidence: { defaultMode: 'deep', registeredWorkspaceOnly: true, excludePaths: [], maximumCapsuleBytes: 1, maximumDailyUploadBytes: 1, maximumExpansionBytes: 1 },
    tasks: { defaultNetwork: 'deny', defaultGit: 'task_branch', allowedCommands: {}, writePaths: [], requireLocalConfirmationFor: [] },
    skills: { automaticInstall: true, automaticPromotionMaxRisk: 'R2', canaryPercent: 10 }, retention: {}, budgets: {},
  };
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const unsigned = {
    schema: 'dharma.task/v1' as const, taskId: randomUUID(), organizationId: 'org_test', workspaceId: 'workspace', taskType: 'external_request' as const,
    target: { deviceId: 'device', endpointId: randomUUID(), provider: 'codex' as const },
    requiredCapabilities: ['action_decision_receipts_v1'] as const,
    skillBundle: null, instructions: 'Inspect the repository.', requiredSkills: [],
    authority: { readPaths: ['.'], writePaths: [], commands: [], network: 'deny', git: 'task_branch' as const },
    execution: { isolation: 'git_worktree' as const, timeoutSeconds: 10, leaseSeconds: 20, maximumConcurrentAgents: 1 },
    acceptance: { commands: [], requiredArtifacts: [] }, budget: { mode: 'byok_local' as const, maximumDharmaCostCents: 0 },
    createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString(), nonce: randomUUID(),
  };
  const task = { ...unsigned, signature: signCanonicalObject(unsigned, privateKey) } as TaskEnvelope;
  let executions = 0;
  await assert.rejects(executeTask({
    task, policy, workspace, relayStateDirectory: resolve(root, 'state'), serverPublicKey: publicKey,
    receiptStore: new FileTaskReceiptStore(resolve(root, 'receipts')),
    providerExecutor: async () => {
      executions += 1;
      throw new Error('must not execute');
    },
  }), /schema validation/);
  assert.equal(executions, 0);
});

test('receipt-required task executes only a KMS-signed release and acknowledges its effect', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'dharma-action-release-'));
  const workspace = resolve(root, 'workspace');
  await mkdir(workspace);
  assert.equal(spawnSync('git', ['init', '-q'], { cwd: workspace }).status, 0);
  assert.equal(spawnSync('git', ['config', 'user.email', 'test@dharma-ai.io'], { cwd: workspace }).status, 0);
  assert.equal(spawnSync('git', ['config', 'user.name', 'Dharma Test'], { cwd: workspace }).status, 0);
  assert.equal(spawnSync('git', ['commit', '--allow-empty', '-qm', 'initial'], { cwd: workspace }).status, 0);
  const policy: OrganizationPolicy = {
    schema: 'dharma.organization-policy/v1', organizationId: 'org_test', revision: '1',
    evidence: { defaultMode: 'deep', registeredWorkspaceOnly: true, excludePaths: [], maximumCapsuleBytes: 1, maximumDailyUploadBytes: 1, maximumExpansionBytes: 1 },
    tasks: { defaultNetwork: 'deny', defaultGit: 'task_branch', allowedCommands: { verify: { argv: [process.execPath, '-e', 'process.stdout.write("released")'], timeoutSeconds: 5 } }, writePaths: [], requireLocalConfirmationFor: [] },
    skills: { automaticInstall: true, automaticPromotionMaxRisk: 'R2', canaryPercent: 10 }, retention: {}, budgets: {},
  };
  const taskKeys = generateKeyPairSync('ed25519');
  const decisionKeys = generateKeyPairSync('ed25519');
  const now = new Date();
  const baseTask = {
    schema: 'dharma.task/v1' as const, taskId: randomUUID(), organizationId: 'org_test', workspaceId: 'workspace', taskType: 'external_request' as const,
    target: { deviceId: 'device', endpointId: randomUUID(), provider: 'codex' as const },
    requiredCapabilities: ['action_decision_receipts_v1'] as const,
    skillBundle: null, instructions: 'Inspect the repository.', requiredSkills: [],
    authority: { readPaths: ['.'], writePaths: [], commands: [{ commandId: 'verify' }], network: 'deny', git: 'task_branch' as const },
    execution: { isolation: 'git_worktree' as const, timeoutSeconds: 10, leaseSeconds: 20, maximumConcurrentAgents: 1 },
    acceptance: { commands: [{ commandId: 'verify' }], requiredArtifacts: [] }, budget: { mode: 'byok_local' as const, maximumDharmaCostCents: 0 },
    createdAt: now.toISOString(), expiresAt: new Date(now.getTime() + 60_000).toISOString(), nonce: randomUUID(),
  } satisfies Omit<TaskEnvelope, 'actionDecision' | 'signature'>;
  const actionDecision = embedDecision(baseTask, 'release', decisionKeys.privateKey, now);
  const unsigned = { ...baseTask, actionDecision };
  const task = { ...unsigned, signature: signCanonicalObject(unsigned, taskKeys.privateKey) } as TaskEnvelope;
  let executions = 0;
  let decisionConsumptions = 0;
  const result = await executeTask({
    task, policy, workspace, relayStateDirectory: resolve(root, 'state'), serverPublicKey: taskKeys.publicKey,
    receiptStore: new FileTaskReceiptStore(resolve(root, 'receipts')),
    actionDecisions: {
      resolvePublicKey: () => decisionKeys.publicKey,
      replayGuard: {
        consume: async (decisionId, digest) => {
          decisionConsumptions += 1;
          assert.equal(decisionId, actionDecision.id);
          assert.equal(digest, actionDecision.actionDigest);
          return true;
        },
      },
    },
    providerExecutor: async () => {
      executions += 1;
      return { provider: 'codex', exitCode: 0, signal: null, timedOut: false, stdout: 'done', stderr: '', stdoutSha256: `sha256:${'1'.repeat(64)}`, stderrSha256: `sha256:${'0'.repeat(64)}` };
    },
  });
  assert.equal(result.status, 'completed');
  assert.equal(executions, 1);
  assert.equal(decisionConsumptions, 1);
  assert.equal(result.commandResults[1]?.stdout, 'released');
  assert.equal(result.actionAcknowledgement?.disposition, 'executed');
  assert.equal(result.actionAcknowledgement?.taskId, task.taskId);
  assert.equal(result.actionAcknowledgement?.endpointId, task.target.endpointId);
  assert.equal(result.actionAcknowledgement?.actionDigest, task.actionDecision?.actionDigest);
  assert.match(result.actionAcknowledgement?.externalIdempotencyKeyHash || '', /^[a-f0-9]{64}$/);
  assert.match(result.actionAcknowledgement?.resultDigest || '', /^sha256:[a-f0-9]{64}$/);
});

test('one-use receipt replay guard rejects a second consumption atomically', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'dharma-action-replay-'));
  const guard = new FileActionDecisionReplayGuard(root);
  const decisionId = '44444444-4444-4444-8444-444444444444';
  const actionDigest = `sha256:${'a'.repeat(64)}`;
  const consumed = await Promise.all([guard.consume(decisionId, actionDigest), guard.consume(decisionId, actionDigest)]);
  assert.deepEqual(consumed.sort(), [false, true]);
});

test('one embedded block receipt is consumed, contains the task, and never reaches the provider', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'dharma-action-block-'));
  const workspace = resolve(root, 'workspace');
  await mkdir(workspace);
  assert.equal(spawnSync('git', ['init', '-q'], { cwd: workspace }).status, 0);
  assert.equal(spawnSync('git', ['config', 'user.email', 'test@dharma-ai.io'], { cwd: workspace }).status, 0);
  assert.equal(spawnSync('git', ['config', 'user.name', 'Dharma Test'], { cwd: workspace }).status, 0);
  assert.equal(spawnSync('git', ['commit', '--allow-empty', '-qm', 'initial'], { cwd: workspace }).status, 0);
  const policy: OrganizationPolicy = {
    schema: 'dharma.organization-policy/v1', organizationId: 'org_test', revision: '1',
    evidence: { defaultMode: 'deep', registeredWorkspaceOnly: true, excludePaths: [], maximumCapsuleBytes: 1, maximumDailyUploadBytes: 1, maximumExpansionBytes: 1 },
    tasks: { defaultNetwork: 'deny', defaultGit: 'task_branch', allowedCommands: {}, writePaths: [], requireLocalConfirmationFor: [] },
    skills: { automaticInstall: true, automaticPromotionMaxRisk: 'R2', canaryPercent: 10 }, retention: {}, budgets: {},
  };
  const taskKeys = generateKeyPairSync('ed25519');
  const decisionKeys = generateKeyPairSync('ed25519');
  const now = new Date();
  const baseTask = {
    schema: 'dharma.task/v1' as const, taskId: randomUUID(), organizationId: 'org_test', workspaceId: 'workspace', taskType: 'external_request' as const,
    target: { deviceId: 'device', endpointId: randomUUID(), provider: 'codex' as const }, requiredCapabilities: ['action_decision_receipts_v1'] as const,
    skillBundle: null, instructions: 'Do not execute.', requiredSkills: [],
    authority: { readPaths: ['.'], writePaths: [], commands: [], network: 'deny', git: 'task_branch' as const },
    execution: { isolation: 'git_worktree' as const, timeoutSeconds: 10, leaseSeconds: 20, maximumConcurrentAgents: 1 },
    acceptance: { commands: [], requiredArtifacts: [] }, budget: { mode: 'byok_local' as const, maximumDharmaCostCents: 0 },
    createdAt: now.toISOString(), expiresAt: new Date(now.getTime() + 60_000).toISOString(), nonce: randomUUID(),
  } satisfies Omit<TaskEnvelope, 'actionDecision' | 'signature'>;
  const actionDecision = embedDecision(baseTask, 'block', decisionKeys.privateKey, now);
  const unsigned = { ...baseTask, actionDecision };
  const task = { ...unsigned, signature: signCanonicalObject(unsigned, taskKeys.privateKey) } as TaskEnvelope;
  let executions = 0;
  const result = await executeTask({
    task, policy, workspace, relayStateDirectory: resolve(root, 'state'), serverPublicKey: taskKeys.publicKey,
    receiptStore: new FileTaskReceiptStore(resolve(root, 'receipts')),
    actionDecisions: { resolvePublicKey: () => decisionKeys.publicKey, now: () => now },
    providerExecutor: async () => { executions += 1; throw new Error('must not execute'); },
  });
  assert.equal(result.status, 'failed');
  assert.equal(executions, 0);
  assert.equal(result.actionAcknowledgement?.disposition, 'contained');
});
