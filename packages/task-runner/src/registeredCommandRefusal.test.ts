import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { access, mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import childProcess, { spawnSync } from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { signCanonicalObject } from '@dharma-ai-labs/agent-fabric-contracts';
import type { OrganizationPolicy } from '@dharma-ai-labs/agent-fabric-policy';
import * as taskRunner from './index.js';
import { executeTask, FileTaskReceiptStore, type TaskEnvelope } from './index.js';

// registered commands run as the relay's operating-system user
// without a sandbox, so the runner refuses every task that names one until
// isolation exists. Tasks that name no registered command run as before.

const REFUSAL_CODE = 'registered_commands_refused';

async function fixture(t: TestContext, provider: 'codex' | 'claude' = 'codex') {
  const root = await mkdtemp(resolve(tmpdir(), 'dharma-registered-command-refusal-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = resolve(root, 'workspace');
  await mkdir(workspace);
  for (const argv of [['init', '-q'], ['config', 'user.email', 'test@dharma.ai'],
    ['config', 'user.name', 'Refusal Fixture'], ['commit', '--allow-empty', '-qm', 'initial']]) {
    assert.equal(spawnSync('git', argv, { cwd: workspace, windowsHide: true }).status, 0);
  }
  const marker = resolve(root, 'command-ran');
  const policy: OrganizationPolicy = {
    schema: 'dharma.organization-policy/v1', organizationId: 'org_test', revision: '1',
    evidence: { defaultMode: 'deep', registeredWorkspaceOnly: true, excludePaths: [], maximumCapsuleBytes: 1,
      maximumDailyUploadBytes: 1, maximumExpansionBytes: 1 },
    tasks: {
      defaultNetwork: 'deny', defaultGit: 'task_branch', writePaths: [], requireLocalConfirmationFor: [],
      allowedCommands: {
        verify: {
          argv: [process.execPath, '-e', 'require("node:fs").writeFileSync(process.argv[1], "ran")', marker],
          timeoutSeconds: 5,
        },
      },
    },
    skills: { automaticInstall: true, automaticPromotionMaxRisk: 'R2', canaryPercent: 10 }, retention: {}, budgets: {},
  };
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const signed = (commands: { authority: string[]; acceptance: string[] }, network = 'deny') => {
    const unsigned = {
      schema: 'dharma.task/v1' as const, taskId: randomUUID(), organizationId: 'org_test', workspaceId: 'workspace',
      taskType: 'external_request' as const, target: { deviceId: 'device', provider },
      skillBundle: null, instructions: 'Verify the repository.', requiredSkills: [],
      authority: { readPaths: ['.'], writePaths: [], commands: commands.authority.map(commandId => ({ commandId })),
        network, git: 'task_branch' as const },
      execution: { isolation: 'git_worktree' as const, timeoutSeconds: 10, leaseSeconds: 20, maximumConcurrentAgents: 1 },
      acceptance: { commands: commands.acceptance.map(commandId => ({ commandId })), requiredArtifacts: [] },
      budget: { mode: 'byok_local' as const, maximumDharmaCostCents: 0 },
      createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString(), nonce: randomUUID(),
    };
    return { ...unsigned, signature: signCanonicalObject(unsigned, privateKey) } as TaskEnvelope;
  };
  const relayStateDirectory = resolve(root, 'state');
  const receiptStore = new FileTaskReceiptStore(resolve(root, 'receipts'));
  return { root, workspace, marker, policy, signed, relayStateDirectory, receiptStore,
    input: { policy, workspace, relayStateDirectory, serverPublicKey: publicKey, receiptStore } };
}

function countSpawns(t: TestContext) {
  const originalSpawn = childProcess.spawn;
  const calls: string[] = [];
  const patch = t.mock.method(childProcess, 'spawn', (command: string, argv: readonly string[], options: object) => {
    calls.push(command);
    return originalSpawn(command, argv, { ...options, windowsHide: true });
  });
  syncBuiltinESMExports();
  t.after(() => { patch.mock.restore(); syncBuiltinESMExports(); });
  return calls;
}

async function exists(path: string) {
  return access(path).then(() => true, () => false);
}

const USABLE_SANDBOX = {
  usable: true as const, host: 'linux' as const, bwrapPath: '/usr/bin/bwrap', bwrapVersion: '0.9.0',
  bwrapSha256: `sha256:${'a'.repeat(64)}`, policy: 'bwrap-policy/2',
  layout: { bin: 'symlink', sbin: 'symlink', lib: 'symlink', lib32: 'absent', lib64: 'symlink', libx32: 'absent' } as const,
  nodePrefix: '/usr', bindNodePrefix: false, nodeMounts: [], disableUserns: true,
};

const assertRefusal = (reason?: string) => (error: unknown) => {
  assert.equal(Reflect.get(error as object, 'reason'), reason ?? 'sandbox_probe_failed');
  return assertRefusalError(error);
};

function assertRefusalError(error: unknown) {
  const RefusalError = Reflect.get(taskRunner, 'RegisteredCommandsRefusedError') as (new (...args: never[]) => Error) | undefined;
  assert.equal(typeof RefusalError, 'function', 'task-runner exports RegisteredCommandsRefusedError');
  assert.ok(error instanceof RefusalError!);
  assert.equal(Reflect.get(error, 'code'), REFUSAL_CODE);
  assert.equal(Reflect.get(taskRunner, 'REGISTERED_COMMANDS_REFUSED'), REFUSAL_CODE);
  assert.match((error as Error).message, /registered commands/i);
  assert.match((error as Error).message, /isolation/i);
  return true;
}

for (const [name, commands] of [
  ['acceptance commands', { authority: ['verify'], acceptance: ['verify'] }],
  ['command ids without acceptance commands', { authority: ['verify'], acceptance: [] }],
] as const) {
  test(`a task that names ${name} is refused before the provider starts`, async (t) => {
    const f = await fixture(t);
    const task = f.signed({ authority: [...commands.authority], acceptance: [...commands.acceptance] });
    const spawns = countSpawns(t);
    let providerCalls = 0;
    await assert.rejects(executeTask({ ...f.input, task,
      providerExecutor: async () => { providerCalls++; throw new Error('provider must not start'); } }), assertRefusal());
    assert.equal(providerCalls, 0);
    assert.deepEqual(spawns, [], 'no child process is spawned on refusal');
    assert.equal(await exists(f.marker), false, 'the registered command did not run');
    assert.equal(await exists(resolve(f.relayStateDirectory, 'worktrees', task.taskId)), false, 'no worktree was created');
    assert.equal(await f.receiptStore.get(task.taskId), null, 'no receipt claims the task ran');
  });
}

test('a Claude task that names registered commands is refused before any provider process or Bash tool exists', async (t) => {
  const f = await fixture(t, 'claude');
  const task = f.signed({ authority: ['verify'], acceptance: ['verify'] });
  const spawns = countSpawns(t);
  // No injected executor: the default provider adapter would hand the commands to Claude as Bash tools.
  await assert.rejects(executeTask({ ...f.input, task }), assertRefusal());
  assert.deepEqual(spawns, [], 'neither the provider CLI nor Git was started');
  assert.equal(await exists(f.marker), false);
});

for (const [name, sandbox, network, reason] of [
  ['an unusable sandbox', { usable: false, reason: 'user_namespaces_unavailable', detail: 'd', fix: 'f' }, 'deny', 'user_namespaces_unavailable'],
  ['a macOS or Windows host', { usable: false, reason: 'platform_unsupported', detail: 'd', fix: 'f' }, 'deny', 'platform_unsupported'],
  ['a network grant, even with a usable sandbox', USABLE_SANDBOX, 'package_registry_only', 'network_not_denied'],
] as const) {
  test(`a task that names registered commands on ${name} is refused with reason ${reason}`, async (t) => {
    const f = await fixture(t);
    const task = f.signed({ authority: ['verify'], acceptance: ['verify'] }, network);
    const spawns = countSpawns(t);
    let providerCalls = 0;
    await assert.rejects(executeTask({ ...f.input, task, registeredCommandSandbox: sandbox,
      providerExecutor: async () => { providerCalls++; throw new Error('provider must not start'); } }), assertRefusal(reason));
    assert.equal(providerCalls, 0);
    assert.deepEqual(spawns, []);
    assert.equal(await exists(f.marker), false);
    assert.equal(await exists(resolve(f.relayStateDirectory, 'worktrees', task.taskId)), false, 'no worktree was created');
  });
}

test('a task that names no registered commands runs exactly as before', async (t) => {
  const f = await fixture(t);
  const task = f.signed({ authority: [], acceptance: [] });
  const seen: string[][][] = [];
  const receipt = await executeTask({ ...f.input, task, providerExecutor: async (input) => {
    seen.push(input.allowedCommandArgv);
    return {
      provider: 'codex' as const, exitCode: 0, signal: null, timedOut: false, stdout: 'agent completed', stderr: '',
      stdoutSha256: `sha256:${'1'.repeat(64)}`, stderrSha256: `sha256:${'0'.repeat(64)}`,
    };
  } });
  assert.equal(receipt.status, 'completed');
  assert.deepEqual(seen, [[]]);
  assert.deepEqual(receipt.commandResults.map(({ commandId }) => commandId), ['provider.codex']);
  assert.equal(await exists(f.marker), false);
});

test('the relay and the runner share one exported predicate for tasks that name registered commands', () => {
  const names = Reflect.get(taskRunner, 'taskNamesRegisteredCommands') as
    ((task: Pick<TaskEnvelope, 'authority' | 'acceptance'>) => boolean) | undefined;
  assert.equal(typeof names, 'function', 'task-runner exports taskNamesRegisteredCommands');
  const task = (commands: string[], acceptance: string[]) => ({
    authority: { commands }, acceptance: { commands: acceptance },
  }) as unknown as Pick<TaskEnvelope, 'authority' | 'acceptance'>;
  assert.equal(names!(task([], [])), false);
  assert.equal(names!(task(['npm.test'], [])), true);
  assert.equal(names!(task([], ['npm.test'])), true);
  assert.equal(names!(task(['npm.test'], ['npm.test'])), true);
});
