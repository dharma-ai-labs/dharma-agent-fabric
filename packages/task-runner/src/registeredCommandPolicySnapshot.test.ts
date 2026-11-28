import assert from 'node:assert/strict';
import { mock, test, type TestContext } from 'node:test';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import fsPromises, { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import childProcess, { spawnSync } from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { signCanonicalObject } from '@dharma-ai-labs/agent-fabric-contracts';
import type { OrganizationPolicy } from '@dharma-ai-labs/agent-fabric-policy';
import * as taskRunner from './index.js';
import {
  executeTask,
  FileTaskReceiptStore,
  RegisteredCommandsRefusedError,
  SANDBOX_POLICY_VERSION,
  type TaskEnvelope,
  type UsableSandbox,
} from './index.js';

// The registered commands a task may run are pinned when the task is admitted. The provider runs
// unsandboxed as the relay user and can rewrite the operator's approved policy file, so nothing
// after the provider may read the command policy again: the acceptance loop runs only the argv
// that was approved when the task was admitted.
//
// As in index.test.ts, bubblewrap is replaced by a stand-in on every operating system: a Node
// wrapper that reports its child on descriptor 3 and runs the command on the host.
// registeredCommandSandbox.linux.test.ts runs the real bubblewrap.

const STAND_IN_SANDBOX: UsableSandbox = {
  usable: true, host: 'linux', bwrapPath: '/usr/bin/bwrap', bwrapVersion: '0.9.0',
  bwrapSha256: `sha256:${'a'.repeat(64)}`, policy: SANDBOX_POLICY_VERSION,
  layout: { bin: 'symlink', sbin: 'symlink', lib: 'symlink', lib32: 'absent', lib64: 'symlink', libx32: 'absent' },
  nodePrefix: '/usr', bindNodePrefix: false, nodeMounts: [], disableUserns: true,
};
const STAND_IN_SCRIPT = [
  'const fs = require("node:fs"); const { spawn } = require("node:child_process");',
  'const [cwd, command, ...args] = process.argv.slice(1);',
  'fs.writeSync(3, JSON.stringify({ "child-pid": process.pid }) + "\\n");',
  'const child = spawn(command, args, { cwd, stdio: ["ignore", "inherit", "inherit"], windowsHide: true });',
  'child.on("error", () => process.exit(127));',
  'child.on("exit", (code, signal) => {',
  '  const exitCode = code ?? 128 + (require("node:os").constants.signals[signal] ?? 0);',
  '  fs.writeSync(3, JSON.stringify({ "exit-code": exitCode }) + "\\n"); process.exit(exitCode);',
  '});',
].join('\n');
// Every program the runner starts with spawn, before the stand-in replaces bubblewrap.
const spawned: string[] = [];
const hostSpawn = childProcess.spawn;
mock.method(childProcess, 'spawn', (command: string, argv: readonly string[], options: object) => {
  spawned.push(command);
  if (command !== STAND_IN_SANDBOX.bwrapPath) return hostSpawn(command, argv, { ...options, windowsHide: true });
  const separator = argv.indexOf('--');
  const cwd = argv[argv.indexOf('--chdir') + 1]!;
  return hostSpawn(process.execPath, ['-e', STAND_IN_SCRIPT, cwd, ...argv.slice(separator + 1)], { ...options, windowsHide: true });
});
syncBuiltinESMExports();

const writeReport = (name: string) => `require("node:fs").writeFileSync("reports/${name}.txt", "${name}")`;

async function exists(path: string) {
  return access(path).then(() => true, () => false);
}

async function fixture(t: TestContext) {
  const root = await mkdtemp(resolve(tmpdir(), 'dharma-command-policy-snapshot-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = resolve(root, 'workspace');
  await mkdir(resolve(workspace, 'reports'), { recursive: true });
  await writeFile(resolve(workspace, 'reports', '.keep'), '');
  for (const argv of [['init', '-q'], ['config', 'user.email', 'test@dharma.ai'], ['config', 'user.name', 'Snapshot Fixture'],
    ['add', '.'], ['commit', '-qm', 'initial']]) {
    assert.equal(spawnSync('git', argv, { cwd: workspace, windowsHide: true }).status, 0, argv.join(' '));
  }
  const policy: OrganizationPolicy = {
    schema: 'dharma.organization-policy/v1', organizationId: 'org_test', revision: '1',
    evidence: { defaultMode: 'deep', registeredWorkspaceOnly: true, excludePaths: [], maximumCapsuleBytes: 1,
      maximumDailyUploadBytes: 1, maximumExpansionBytes: 1 },
    tasks: { defaultNetwork: 'deny', defaultGit: 'task_branch', writePaths: ['reports/**'], requireLocalConfirmationFor: [],
      allowedCommands: {
        check: { argv: [process.execPath, '-e', writeReport('approved')], timeoutSeconds: 10 },
        unused: { argv: [process.execPath, '-e', writeReport('unused')], timeoutSeconds: 10 },
      } },
    skills: { automaticInstall: true, automaticPromotionMaxRisk: 'R2', canaryPercent: 10 }, retention: {}, budgets: {},
  };
  // The operator's approved policy file. The runner is handed the policy loaded from it.
  const policyFile = resolve(workspace, '.dharma', 'approved-policy.json');
  await mkdir(resolve(workspace, '.dharma'), { recursive: true });
  await writeFile(policyFile, JSON.stringify(policy));
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const signed = (taskType: TaskEnvelope['taskType'], commandIds: string[]) => {
    const unsigned = {
      schema: 'dharma.task/v1' as const, taskId: randomUUID(), organizationId: 'org_test', workspaceId: 'workspace',
      taskType, target: { deviceId: 'device', provider: 'codex' as const },
      skillBundle: null, instructions: 'Verify the repository.', requiredSkills: [],
      authority: { readPaths: ['.'], writePaths: ['reports/**'], commands: commandIds.map(commandId => ({ commandId })),
        network: 'deny', git: 'task_branch' as const },
      execution: { isolation: 'git_worktree' as const, timeoutSeconds: 30, leaseSeconds: 60, maximumConcurrentAgents: 1 },
      acceptance: { commands: commandIds.map(commandId => ({ commandId })), requiredArtifacts: [] },
      budget: { mode: 'byok_local' as const, maximumDharmaCostCents: 0 },
      createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 120_000).toISOString(), nonce: randomUUID(),
    };
    return { ...unsigned, signature: signCanonicalObject(unsigned, privateKey) } as TaskEnvelope;
  };
  const relayStateDirectory = resolve(root, 'state');
  return { root, workspace, policy, policyFile, signed, relayStateDirectory,
    worktree: (task: TaskEnvelope) => resolve(relayStateDirectory, 'worktrees', task.taskId),
    input: { policy, workspace, relayStateDirectory, serverPublicKey: publicKey,
      receiptStore: new FileTaskReceiptStore(resolve(root, 'receipts')) } };
}

const providerResult = {
  provider: 'codex' as const, exitCode: 0, signal: null, timedOut: false, stdout: 'synthetic completion', stderr: '',
  stdoutSha256: `sha256:${'1'.repeat(64)}`, stderrSha256: `sha256:${'0'.repeat(64)}`,
};

// Records every path the runner reads with fs/promises readFile or open during one task.
function recordReads(t: TestContext) {
  const reads: string[] = [];
  const originalReadFile = fsPromises.readFile;
  const originalOpen = fsPromises.open;
  const readFilePatch = t.mock.method(fsPromises, 'readFile', (path: unknown, ...rest: unknown[]) => {
    reads.push(String(path));
    return Reflect.apply(originalReadFile, fsPromises, [path, ...rest]);
  });
  const openPatch = t.mock.method(fsPromises, 'open', (path: unknown, ...rest: unknown[]) => {
    reads.push(String(path));
    return Reflect.apply(originalOpen, fsPromises, [path, ...rest]);
  });
  syncBuiltinESMExports();
  t.after(() => { readFilePatch.mock.restore(); openPatch.mock.restore(); syncBuiltinESMExports(); });
  return reads;
}

function snapshotFunction() {
  const snapshot: unknown = Reflect.get(taskRunner, 'snapshotRegisteredCommandPolicy');
  assert.equal(typeof snapshot, 'function', 'task-runner exports snapshotRegisteredCommandPolicy');
  return snapshot as typeof taskRunner.snapshotRegisteredCommandPolicy;
}

function isDeepFrozen(value: unknown): boolean {
  if (!value || typeof value !== 'object') return true;
  return Object.isFrozen(value) && Object.values(value).every(isDeepFrozen);
}

test('the provider rewriting the approved policy does not change the command this task runs', async (t) => {
  const f = await fixture(t);
  const task = f.signed('external_request', ['check']);
  const reads = recordReads(t);
  let readsBeforeProvider = -1;
  const receipt = await executeTask({ ...f.input, task, registeredCommandSandbox: STAND_IN_SANDBOX,
    providerExecutor: async () => {
      readsBeforeProvider = reads.length;
      // The unsandboxed provider rewrites the operator's policy file, and the policy object the
      // relay loaded stands in for any later read of it.
      await writeFile(f.policyFile, JSON.stringify({ ...f.policy, tasks: { ...f.policy.tasks,
        allowedCommands: { check: { argv: [process.execPath, '-e', writeReport('rewritten')], timeoutSeconds: 10 } } } }));
      f.policy.tasks.allowedCommands.check = { argv: [process.execPath, '-e', writeReport('rewritten')], timeoutSeconds: 10 };
      return providerResult;
    } });
  assert.equal(receipt.status, 'completed', JSON.stringify(receipt.commandResults.map(({ commandId, stderr }) => ({ commandId, stderr }))));
  assert.equal(await readFile(resolve(f.worktree(task), 'reports', 'approved.txt'), 'utf8'), 'approved');
  assert.equal(await exists(resolve(f.worktree(task), 'reports', 'rewritten.txt')), false,
    'the command the provider wrote into the policy did not run');
  assert.ok(readsBeforeProvider >= 0, 'the provider ran');
  assert.ok(reads.some(path => path.endsWith(`${task.taskId}.json`)), 'the read recorder sees the runner');
  assert.deepEqual(reads.filter(path => /approved-policy|\.dharma[\\/]/.test(path)), [],
    'the runner reads no policy file, before or after the provider');
});

test('the admission snapshot is frozen, holds only the commands the task names and is what the runner runs', async (t) => {
  const f = await fixture(t);
  const task = f.signed('external_request', ['check']);
  const snapshot = snapshotFunction()(task, f.policy);
  assert.deepEqual(JSON.parse(JSON.stringify(snapshot)), {
    taskId: task.taskId, organizationId: 'org_test', policyRevision: '1',
    commands: { check: { argv: [process.execPath, '-e', writeReport('approved')], timeoutSeconds: 10 } },
  });
  assert.ok(isDeepFrozen(snapshot), 'every level of the snapshot is frozen');
  // A change to the loaded policy after admission does not reach the snapshot or the command.
  f.policy.tasks.allowedCommands.check!.argv[2] = writeReport('rewritten');
  assert.deepEqual(snapshot.commands.check!.argv, [process.execPath, '-e', writeReport('approved')]);
  const receipt = await executeTask({ ...f.input, task, registeredCommandSandbox: STAND_IN_SANDBOX,
    ...{ commandPolicy: snapshot }, providerExecutor: async () => providerResult });
  assert.equal(receipt.status, 'completed', JSON.stringify(receipt.commandResults.map(({ commandId, stderr }) => ({ commandId, stderr }))));
  assert.equal(await readFile(resolve(f.worktree(task), 'reports', 'approved.txt'), 'utf8'), 'approved');
  assert.equal(await exists(resolve(f.worktree(task), 'reports', 'rewritten.txt')), false);
});

test('a snapshot taken for another task or left unfrozen is refused before any process starts', async (t) => {
  const f = await fixture(t);
  const task = f.signed('external_request', ['check']);
  const other = f.signed('external_request', ['check']);
  const snapshot = snapshotFunction();
  const unfrozen = JSON.parse(JSON.stringify(snapshot(task, f.policy))) as ReturnType<typeof snapshot>;
  for (const commandPolicy of [snapshot(other, f.policy), unfrozen]) {
    spawned.length = 0;
    let providerCalls = 0;
    await assert.rejects(executeTask({ ...f.input, task, registeredCommandSandbox: STAND_IN_SANDBOX, ...{ commandPolicy },
      providerExecutor: async () => { providerCalls++; return providerResult; } }),
    /Registered command policy snapshot does not belong to this task/);
    assert.equal(providerCalls, 0);
    assert.deepEqual(spawned, []);
    assert.equal(await exists(f.worktree(task)), false, 'no worktree was created');
  }
});

// No alternate route: a remediation_smoke task is a task like any other. It reaches the same
// admission, so it is refused without a usable sandbox, and its commands run only inside it.
test('a remediation_smoke task that names registered commands is refused without a usable sandbox, before any process', async (t) => {
  const f = await fixture(t);
  const task = f.signed('remediation_smoke', ['check']);
  spawned.length = 0;
  let providerCalls = 0;
  await assert.rejects(executeTask({ ...f.input, task,
    registeredCommandSandbox: { usable: false, reason: 'platform_unsupported', detail: 'synthetic', fix: 'synthetic' },
    providerExecutor: async () => { providerCalls++; return providerResult; } }),
  (error: unknown) => error instanceof RegisteredCommandsRefusedError && error.reason === 'platform_unsupported');
  assert.equal(providerCalls, 0);
  assert.deepEqual(spawned, []);
  assert.equal(await exists(f.worktree(task)), false);
});

test('a remediation_smoke task runs its registered commands only through the sandbox', async (t) => {
  const f = await fixture(t);
  const task = f.signed('remediation_smoke', ['check']);
  spawned.length = 0;
  const receipt = await executeTask({ ...f.input, task, registeredCommandSandbox: STAND_IN_SANDBOX,
    providerExecutor: async () => providerResult });
  assert.equal(receipt.status, 'completed', JSON.stringify(receipt.commandResults.map(({ commandId, stderr }) => ({ commandId, stderr }))));
  assert.equal(await readFile(resolve(f.worktree(task), 'reports', 'approved.txt'), 'utf8'), 'approved');
  assert.deepEqual(spawned.filter(command => command !== 'git'), [STAND_IN_SANDBOX.bwrapPath],
    'the command started through bubblewrap and never directly on the host');
});
