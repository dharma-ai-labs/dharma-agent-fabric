import assert from 'node:assert/strict';
import { mock, test, type TestContext } from 'node:test';
import { createHash, generateKeyPairSync, randomUUID } from 'node:crypto';
import { appendFileSync } from 'node:fs';
import { chmod, copyFile, link, mkdtemp, mkdir, readFile, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import childProcess, { spawnSync } from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import {
  actionDecisionDigest,
  signCanonicalObject,
  validateTaskEnvelopeContract,
  validateTaskActionContract,
  type ActionDecisionEnvelope,
  type ActionDecisionReceipt,
} from '@dharma-ai-labs/agent-fabric-contracts';
import type { OrganizationPolicy } from '@dharma-ai-labs/agent-fabric-policy';
import { executeProviderTask } from '@dharma-ai-labs/agent-fabric-provider-adapters';
import {
  assertTaskWithinLocalPolicy,
  canonicalTaskActionForTask,
  executeTask,
  FileActionDecisionReplayGuard,
  FileActionExecutionJournal,
  FileTaskReceiptStore,
  providerInstructionsForTask,
  verifyTaskEnvelope,
  type ProviderTaskExecutor,
  type TaskEnvelope,
} from './index.js';
import * as taskRunner from './index.js';
import { SANDBOX_HOME, SANDBOX_POLICY_VERSION, sandboxCommandLine, type UsableSandbox } from './index.js';

// Registered commands run only inside an operating-system sandbox. On every
// operating system these unit tests replace bubblewrap with a stand-in: a Node wrapper that
// reports its child on descriptor 3, as bubblewrap's --json-status-fd does, and then runs the
// command on the host. That keeps the acceptance-loop checks (write scope, artifacts,
// environment, decision receipts) covered everywhere. registeredCommandSandbox.linux.test.ts
// runs the real bubblewrap on Linux.
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
const hostSpawn = childProcess.spawn;
function standInSpawn(command: string, argv: readonly string[], options: object) {
  if (command !== STAND_IN_SANDBOX.bwrapPath) return hostSpawn(command, argv, { ...options, windowsHide: true });
  const separator = argv.indexOf('--');
  const cwd = argv[argv.indexOf('--chdir') + 1]!;
  return hostSpawn(process.execPath, ['-e', STAND_IN_SCRIPT, cwd, ...argv.slice(separator + 1)], { ...options, windowsHide: true });
}
mock.method(childProcess, 'spawn', standInSpawn);
syncBuiltinESMExports();

async function requiredArtifactFixture(t: TestContext, requiredArtifacts: string[]) {
  const root = await mkdtemp(resolve(tmpdir(), 'dharma-required-artifact-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = resolve(root, 'workspace');
  await mkdir(workspace);
  for (const argv of [['init', '-q'], ['config', 'user.email', 'test@dharma.ai'],
    ['config', 'user.name', 'Artifact Fixture'], ['commit', '--allow-empty', '-qm', 'initial']]) {
    assert.equal(spawnSync('git', argv, { cwd: workspace, windowsHide: true }).status, 0);
  }
  const policy: OrganizationPolicy = {
    schema: 'dharma.organization-policy/v1', organizationId: 'org_test', revision: '1',
    evidence: { defaultMode: 'deep', registeredWorkspaceOnly: true, excludePaths: [], maximumCapsuleBytes: 1,
      maximumDailyUploadBytes: 1, maximumExpansionBytes: 1 },
    tasks: { defaultNetwork: 'deny', defaultGit: 'task_branch', allowedCommands: {}, writePaths: ['reports/**'],
      requireLocalConfirmationFor: [] },
    skills: { automaticInstall: true, automaticPromotionMaxRisk: 'R2', canaryPercent: 10 }, retention: {}, budgets: {},
  };
  const unsigned = {
    schema: 'dharma.task/v1' as const, taskId: randomUUID(), organizationId: 'org_test', workspaceId: 'workspace',
    taskType: 'external_request' as const, target: { deviceId: 'device', provider: 'codex' as const },
    skillBundle: null, instructions: 'Produce the signed required artifacts.', requiredSkills: [],
    authority: { readPaths: ['reports/**'], writePaths: ['reports/**'], commands: [] as { commandId: string }[],
      network: 'deny', git: 'task_branch' as const },
    execution: { isolation: 'git_worktree' as const, timeoutSeconds: 10, leaseSeconds: 20, maximumConcurrentAgents: 1 },
    acceptance: { commands: [] as { commandId: string }[], requiredArtifacts },
    budget: { mode: 'byok_local' as const, maximumDharmaCostCents: 0 },
    createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString(), nonce: randomUUID(),
  };
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const signed = (overrides: Partial<Omit<TaskEnvelope, 'signature'>> = {}) => {
    const task = { ...unsigned, ...overrides };
    return { ...task, signature: signCanonicalObject(task, privateKey) } as TaskEnvelope;
  };
  const providerResult = {
    provider: 'codex' as const, exitCode: 0, signal: null, timedOut: false, stdout: 'synthetic completion', stderr: '',
    stdoutSha256: `sha256:${'1'.repeat(64)}`, stderrSha256: `sha256:${'0'.repeat(64)}`,
  };
  return { root, workspace, policy, unsigned, signed, providerResult, publicKey,
    input: { policy, workspace, relayStateDirectory: resolve(root, 'state'), serverPublicKey: publicKey,
      receiptStore: new FileTaskReceiptStore(resolve(root, 'receipts')), registeredCommandSandbox: STAND_IN_SANDBOX } };
}

test('optional provider qualification follows the existing task executor and stored receipt', async (t) => {
  const fixture = await requiredArtifactFixture(t, []);
  const task = fixture.signed();
  const digest = `sha256:${'a'.repeat(64)}`;
  const qualification = {
    organizationId: task.organizationId, taskId: task.taskId,
    inputSha256: digest, candidateSha256: digest, oracleReceiptSha256: digest,
    fileRootsSha256: null, skillRootsSha256: null, settingsSha256: null, contextSha256: null,
  };
  let calls = 0;
  const receipt = await executeTask({ ...fixture.input, task, ...{ providerQualification: qualification },
    providerExecutor: async (input) => {
      calls++;
      assert.deepEqual(Reflect.get(input, 'qualification'), qualification);
      return executeProviderTask({ ...input, runner: async () => ({
        exitCode: 0, signal: null, timedOut: false, stdout: Buffer.from('synthetic result'), stderr: Buffer.alloc(0),
      }) });
    } });
  assert.equal(calls, 1);
  assert.equal(receipt.status, 'completed');
  const qualificationReceipt = Reflect.get(receipt.commandResults[0]!, 'qualificationReceipt');
  assert.ok(qualificationReceipt);
  assert.deepEqual(qualificationReceipt.declared, qualification);
  assert.equal(qualificationReceipt.invocation.runner, 'injected');
  const stored = await fixture.input.receiptStore.get(task.taskId);
  assert.deepEqual(Reflect.get(stored!.commandResults[0]!, 'qualificationReceipt'), qualificationReceipt);
  const duplicate = await executeTask({ ...fixture.input, task,
    providerQualification: { ...qualification, candidateSha256: `sha256:${'b'.repeat(64)}` },
    providerExecutor: async () => { throw new Error('duplicate must not execute'); } });
  assert.deepEqual(duplicate, stored);
  assert.equal(duplicate.commandResults[0]!.stdout, '');
});

test('optional provider qualification rejects a foreign task or organization before execution', async (t) => {
  for (const scope of ['task', 'organization']) {
    await t.test(scope, async (child) => {
      const fixture = await requiredArtifactFixture(child, []);
      const task = fixture.signed();
      const digest = `sha256:${'a'.repeat(64)}`;
      let calls = 0;
      await assert.rejects(executeTask({ ...fixture.input, task, ...{ providerQualification: {
        organizationId: scope === 'organization' ? 'org_other' : task.organizationId,
        taskId: scope === 'task' ? randomUUID() : task.taskId,
        inputSha256: digest, candidateSha256: digest, oracleReceiptSha256: digest,
        fileRootsSha256: null, skillRootsSha256: null, settingsSha256: null, contextSha256: null,
      } }, providerExecutor: async () => { calls++; return fixture.providerResult; } }),
      /Provider execution qualification scope does not match task/);
      assert.equal(calls, 0);
    });
  }
});

test('missing custom-executor qualification is explicit and does not add a legacy gate', async (t) => {
  const fixture = await requiredArtifactFixture(t, []);
  const task = fixture.signed();
  const digest = `sha256:${'a'.repeat(64)}`;
  const receipt = await executeTask({ ...fixture.input, task, ...{ providerQualification: {
    organizationId: task.organizationId, taskId: task.taskId,
    inputSha256: digest, candidateSha256: digest, oracleReceiptSha256: digest,
    fileRootsSha256: null, skillRootsSha256: null, settingsSha256: null, contextSha256: null,
  } }, providerExecutor: async () => fixture.providerResult });
  assert.equal(receipt.status, 'completed');
  assert.equal(Reflect.get(receipt.commandResults[0]!, 'qualificationReceipt'), null);
});

test('custom qualification reports cannot bypass receipt redaction or bind a different task', async (t) => {
  for (const variant of ['raw-top-level', 'raw-invocation', 'foreign-task', 'accessor', 'foreign-provider']) {
    await t.test(variant, async (child) => {
      const fixture = await requiredArtifactFixture(child, []);
      const decisionKeys = generateKeyPairSync('ed25519');
      const signedBase = { ...fixture.unsigned, target: { ...fixture.unsigned.target, endpointId: randomUUID() },
        requiredCapabilities: ['action_decision_receipts_v1'] as const };
      const journaled = variant === 'accessor' || variant === 'foreign-provider';
      const task = journaled ? fixture.signed({ ...signedBase,
        actionDecision: embedDecision(signedBase, 'release', decisionKeys.privateKey, new Date()) }) : fixture.signed();
      const digest = `sha256:${'a'.repeat(64)}`;
      const qualification = { organizationId: task.organizationId, taskId: task.taskId,
        inputSha256: digest, candidateSha256: digest, oracleReceiptSha256: digest,
        fileRootsSha256: null, skillRootsSha256: null, settingsSha256: null, contextSha256: null };
      let getterCalls = 0;
      const receipt = await executeTask({ ...fixture.input, task, providerQualification: qualification,
        ...(journaled ? { actionDecisions: { resolvePublicKey: () => decisionKeys.publicKey } } : {}),
        providerExecutor: async (input) => {
          const result = await executeProviderTask({ ...input,
            ...(variant === 'foreign-provider' ? { provider: 'claude' as const } : {}),
            runner: async () => ({
            exitCode: 0, signal: null, timedOut: false, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0),
          }) });
          const report = result.qualificationReceipt!;
          if (variant === 'raw-top-level') Object.assign(report, { rawSecret: 'private-receipt-canary' });
          if (variant === 'raw-invocation') Object.assign(report.invocation, { rawArgv: ['private-receipt-canary'] });
          if (variant === 'foreign-task') result.qualificationReceipt = { ...report,
            declared: { ...report.declared, taskId: randomUUID() } };
          if (variant === 'accessor') Object.defineProperty(result, 'qualificationReceipt', {
            enumerable: true, get() { getterCalls++; return report; },
          });
          return result;
        } });
      assert.equal(receipt.status, 'completed');
      assert.equal(Reflect.get(receipt.commandResults[0]!, 'qualificationReceipt'), null);
      assert.equal(getterCalls, 0);
      assert.equal(JSON.stringify(await fixture.input.receiptStore.get(task.taskId)).includes('private-receipt-canary'), false);
      if (journaled) {
        const journal = new FileActionExecutionJournal(resolve(fixture.input.relayStateDirectory, 'action-execution-journal'));
        const record = await journal.get(task.taskId);
        assert.equal(record?.state, 'receipt_recorded');
        assert.equal(record?.receipt?.commandResults[0]?.qualificationReceipt, null);
        const observed = { provider: variant === 'foreign-provider' ? 'claude' : 'codex', ...receipt.commandResults[0] };
        assert.equal(record?.providerResultDigest,
          `sha256:${createHash('sha256').update(JSON.stringify(observed)).digest('hex')}`);
      }
    });
  }
});

// Relay-internal Git calls start with `-C <folder>`, `-c name=value` configuration overrides and
// `--name=value` global options before the subcommand.
function gitSubcommand(argv: readonly string[]): string | undefined {
  let index = 0;
  while (argv[index] === '-c' || argv[index] === '-C' || argv[index]?.startsWith('--')) {
    index += argv[index] === '-c' || argv[index] === '-C' ? 2 : 1;
  }
  return argv[index];
}

// Read once: whether the host Git reads attributes from a commit (`--attr-source`, Git 2.40 or later).
const HOST_GIT_READS_ATTRIBUTE_SOURCE = (() => {
  const match = /^git version (\d+)\.(\d+)/.exec(spawnSync('git', ['version'], { windowsHide: true, encoding: 'utf8' }).stdout);
  const major = Number(match?.[1] ?? 0);
  const minor = Number(match?.[2] ?? 0);
  return major > 2 || (major === 2 && minor >= 40);
})();

// Relay Git subcommands that run after `git worktree add` and use the pinned repository paths.
const PINNED_SUBCOMMANDS = new Set(['switch', 'rev-parse', 'diff', 'ls-files']);

test('required artifact review v10: incomplete Git streams fail closed', async (t) => {
  for (const stream of ['tracked-overflow', 'untracked-overflow', 'unterminated'] as const) {
    await t.test(stream, async (child) => {
      const fixture = await requiredArtifactFixture(child, []);
      const originalSpawn = childProcess.spawn;
      const body = stream === 'unterminated' ? 'reports/partial'
        : 'reports/a\0'.repeat(99_999) + 'reports/zzextra\0';
      const outputPath = resolve(fixture.root, 'synthetic-git-output');
      await writeFile(outputPath, body);
      let intercepted = 0;
      const patch = child.mock.method(childProcess, 'spawn', (command: string, argv: readonly string[], options: object) => {
        if (command === 'git' && gitSubcommand(argv) === (stream === 'untracked-overflow' ? 'ls-files' : 'diff')) {
          intercepted++;
          return originalSpawn(process.execPath, ['-e', 'process.stdout.write(require("node:fs").readFileSync(process.argv[1]));', outputPath], { ...options, windowsHide: true });
        }
        return originalSpawn(command, argv, { ...options, windowsHide: true });
      });
      syncBuiltinESMExports();
      try {
        const receipt = await executeTask({ ...fixture.input, task: fixture.signed(),
          providerExecutor: async ({ workspace }) => {
            if (stream !== 'untracked-overflow') await writeFile(resolve(workspace, 'outside.txt'), 'fixture');
            return fixture.providerResult;
          } });
        assert.equal(intercepted, 1);
        assert.equal(receipt.status, 'failed');
        assert.match(receipt.commandResults.at(-1)?.stderr || '', /output.*limit|Git path output was incomplete/);
      } finally { patch.mock.restore(); syncBuiltinESMExports(); }
    });
  }
});

test('required artifact review v10: ignored outputs require signed write authority', async (t) => {
  const fixture = await requiredArtifactFixture(t, ['reports/result.json']);
  await writeFile(resolve(fixture.workspace, '.gitignore'), 'reports/result.json\n');
  assert.equal(spawnSync('git', ['add', '.gitignore'], { cwd: fixture.workspace, windowsHide: true }).status, 0);
  assert.equal(spawnSync('git', ['commit', '-qm', 'ignore output'], { cwd: fixture.workspace, windowsHide: true }).status, 0);
  fixture.unsigned.authority.writePaths = ['reports/allowed/**'];
  let calls = 0;
  const receipt = await executeTask({ ...fixture.input, task: fixture.signed(),
    providerExecutor: async ({ workspace }) => {
      calls++;
      await mkdir(resolve(workspace, 'reports'));
      await writeFile(resolve(workspace, 'reports/result.json'), 'forbidden ignored output');
      return fixture.providerResult;
    } });
  assert.equal(receipt.status, 'failed');
  assert.equal(calls, 0);
  assert.match(receipt.commandResults.at(-1)?.stderr || '', /required_artifact_missing/);
});

test('required artifact review v10: existing read-only artifacts remain unchanged through acceptance', async (t) => {
  for (const mutate of [false, true]) {
    await t.test(mutate ? 'changed by acceptance' : 'unchanged', async (child) => {
      const fixture = await requiredArtifactFixture(child, ['reports/result.json']);
      await mkdir(resolve(fixture.workspace, 'reports'));
      await writeFile(resolve(fixture.workspace, 'reports/result.json'), 'private-read-only-sentinel');
      assert.equal(spawnSync('git', ['add', 'reports/result.json'], { cwd: fixture.workspace, windowsHide: true }).status, 0);
      assert.equal(spawnSync('git', ['commit', '-qm', 'existing output'], { cwd: fixture.workspace, windowsHide: true }).status, 0);
      fixture.unsigned.authority.writePaths = ['reports/allowed/**'];
      if (mutate) {
        fixture.policy.tasks.allowedCommands.verify = { argv: [process.execPath, '-e',
          'require("node:fs").writeFileSync("reports/result.json","unauthorized-replacement");'], timeoutSeconds: 5 };
        fixture.unsigned.authority.commands.push({ commandId: 'verify' });
        fixture.unsigned.acceptance.commands.push({ commandId: 'verify' });
      }
      const receipt = await executeTask({ ...fixture.input, task: fixture.signed(), providerExecutor: async () => fixture.providerResult });
      assert.equal(receipt.status, mutate ? 'failed' : 'completed');
      if (mutate) assert.match(receipt.commandResults.at(-1)?.stderr || '', /required_artifact_write_unauthorized/);
      assert.equal(JSON.stringify(receipt).includes('private-read-only-sentinel'), false);
      assert.equal(JSON.stringify(receipt).includes('unauthorized-replacement'), false);
    });
  }
});

test('required artifact review v10: ignored write-authorized outputs remain supported', async (t) => {
  const fixture = await requiredArtifactFixture(t, ['reports/result.json']);
  await writeFile(resolve(fixture.workspace, '.gitignore'), 'reports/result.json\n');
  assert.equal(spawnSync('git', ['add', '.gitignore'], { cwd: fixture.workspace, windowsHide: true }).status, 0);
  assert.equal(spawnSync('git', ['commit', '-qm', 'ignore output'], { cwd: fixture.workspace, windowsHide: true }).status, 0);
  const receipt = await executeTask({ ...fixture.input, task: fixture.signed(), providerExecutor: async ({ workspace }) => {
    await mkdir(resolve(workspace, 'reports'));
    await writeFile(resolve(workspace, 'reports/result.json'), '{}');
    return fixture.providerResult;
  } });
  assert.equal(receipt.status, 'completed');
});

test('required artifacts prevent successful completion when the signed output is missing', async (t) => {
  const fixture = await requiredArtifactFixture(t, ['reports/result.json']);
  const receipt = await executeTask({ ...fixture.input, task: fixture.signed(),
    providerExecutor: async () => fixture.providerResult });
  assert.equal(receipt.commandResults[0]?.commandId, 'provider.codex');
  assert.equal(receipt.status, 'failed');
  assert.match(receipt.commandResults.at(-1)?.stderr || '', /required_artifact_missing/);
});

test('required artifacts accept regular files, including empty files, without exposing contents', async (t) => {
  const fixture = await requiredArtifactFixture(t, ['reports/result.json', 'reports/empty.txt']);
  const receipt = await executeTask({ ...fixture.input, task: fixture.signed(),
    providerExecutor: async ({ workspace }) => {
      await mkdir(resolve(workspace, 'reports'));
      await writeFile(resolve(workspace, 'reports/result.json'), 'private fixture output');
      await writeFile(resolve(workspace, 'reports/empty.txt'), '');
      return fixture.providerResult;
    } });
  assert.equal(receipt.status, 'completed');
  assert.equal(JSON.stringify(receipt).includes('private fixture output'), false);
  const durable = await readFile(resolve(fixture.root, 'receipts', `${receipt.taskId}.json`), 'utf8');
  assert.equal(durable.includes('private fixture output'), false);
});

test('required artifacts fail if any required file is missing', async (t) => {
  const fixture = await requiredArtifactFixture(t, ['reports/present.json', 'reports/missing.json']);
  const receipt = await executeTask({ ...fixture.input, task: fixture.signed(),
    providerExecutor: async ({ workspace }) => {
      await mkdir(resolve(workspace, 'reports'));
      await writeFile(resolve(workspace, 'reports/present.json'), '{}');
      return fixture.providerResult;
    } });
  assert.equal(receipt.status, 'failed');
  assert.match(receipt.commandResults.at(-1)?.stderr || '', /required_artifact_missing/);
});

test('required artifacts reject ambiguous or unauthorized references before provider execution', async (t) => {
  for (const artifact of ['', '../outside.txt', '/tmp/outside.txt', 'C:/outside.txt', 'reports\\result.json',
    'reports/../outside.txt', 'reports/./result.json', 'reports//result.json', 'reports/result:stream',
    'reports/NUL.txt', 'reports/result.', 'reports/result ', 'reports/*.json', 'outside/result.json']) {
    await t.test(JSON.stringify(artifact), async (child) => {
      const fixture = await requiredArtifactFixture(child, [artifact]);
      let calls = 0;
      await assert.rejects(executeTask({ ...fixture.input, task: fixture.signed(),
        providerExecutor: async () => { calls++; return fixture.providerResult; } }), /required_artifact_(invalid|unauthorized)|Task failed schema validation/);
      assert.equal(calls, 0);
    });
  }
});

test('required artifacts check the final state after registered acceptance commands', async (t) => {
  for (const operation of ['create', 'remove'] as const) {
    await t.test(operation, async (child) => {
      const fixture = await requiredArtifactFixture(child, ['reports/result.json']);
      const script = operation === 'create'
        ? 'const fs=require("node:fs");fs.mkdirSync("reports",{recursive:true});fs.writeFileSync("reports/result.json","{}");'
        : 'require("node:fs").unlinkSync("reports/result.json");';
      fixture.policy.tasks.allowedCommands.verify = { argv: [process.execPath, '-e', script], timeoutSeconds: 5 };
      fixture.unsigned.authority.commands.push({ commandId: 'verify' });
      fixture.unsigned.acceptance.commands.push({ commandId: 'verify' });
      const receipt = await executeTask({ ...fixture.input, task: fixture.signed(),
        providerExecutor: async ({ workspace }) => {
          if (operation === 'remove') {
            await mkdir(resolve(workspace, 'reports'));
            await writeFile(resolve(workspace, 'reports/result.json'), '{}');
          }
          return fixture.providerResult;
        } });
      assert.equal(receipt.commandResults[1]?.commandId, 'verify');
      assert.equal(receipt.commandResults[1]?.exitCode, 0);
      assert.equal(receipt.status, operation === 'create' ? 'completed' : 'failed');
      if (operation === 'remove') assert.match(receipt.commandResults.at(-1)?.stderr || '', /required_artifact_missing/);
    });
  }
});

test('required artifacts reject directories and hard-linked files', async (t) => {
  for (const kind of ['directory', 'hardlink'] as const) {
    await t.test(kind, async (child) => {
      const fixture = await requiredArtifactFixture(child, ['reports/result.json']);
      const outside = resolve(fixture.root, 'outside.txt');
      await writeFile(outside, 'outside-content-sentinel');
      const receipt = await executeTask({ ...fixture.input, task: fixture.signed(),
        providerExecutor: async ({ workspace }) => {
          await mkdir(resolve(workspace, 'reports'));
          if (kind === 'directory') await mkdir(resolve(workspace, 'reports/result.json'));
          else await link(outside, resolve(workspace, 'reports/result.json'));
          return fixture.providerResult;
        } });
      assert.equal(receipt.status, 'failed');
      assert.match(receipt.commandResults.at(-1)?.stderr || '', /required_artifact_(not_file|unsafe)/);
      assert.equal(JSON.stringify(receipt).includes('outside-content-sentinel'), false);
      assert.equal(await readFile(outside, 'utf8'), 'outside-content-sentinel');
    });
  }
});

test('required artifacts reject a linked parent directory without disclosing the target', async (t) => {
  const fixture = await requiredArtifactFixture(t, ['reports/linked/result.json']);
  const outside = resolve(fixture.root, 'outside');
  await mkdir(outside);
  await writeFile(resolve(outside, 'result.json'), 'outside-content-sentinel');
  const receipt = await executeTask({ ...fixture.input, task: fixture.signed(),
    providerExecutor: async ({ workspace }) => {
      await mkdir(resolve(workspace, 'reports'));
      await symlink(outside, resolve(workspace, 'reports/linked'), 'junction');
      return fixture.providerResult;
    } });
  assert.equal(receipt.status, 'failed');
  assert.match(receipt.commandResults.at(-1)?.stderr || '', /required_artifact_unsafe/);
  assert.equal(JSON.stringify(receipt).includes('outside-content-sentinel'), false);
  assert.equal(JSON.stringify(receipt).includes(outside), false);
});

test('required artifacts reject unreadable files', { skip: process.platform === 'win32' }, async (t) => {
  const fixture = await requiredArtifactFixture(t, ['reports/result.json']);
  const receipt = await executeTask({ ...fixture.input, task: fixture.signed(),
    providerExecutor: async ({ workspace }) => {
      await mkdir(resolve(workspace, 'reports'));
      await writeFile(resolve(workspace, 'reports/result.json'), '{}');
      await chmod(resolve(workspace, 'reports/result.json'), 0o000);
      return fixture.providerResult;
    } });
  assert.equal(receipt.status, 'failed');
  assert.match(receipt.commandResults.at(-1)?.stderr || '', /required_artifact_unreadable/);
});

test('required artifacts preserve provider failure and cancelled status', async (t) => {
  for (const kind of ['provider-failure', 'cancelled'] as const) {
    await t.test(kind, async (child) => {
      const fixture = await requiredArtifactFixture(child, ['reports/result.json']);
      const controller = new AbortController();
      const receipt = await executeTask({ ...fixture.input, task: fixture.signed(), signal: controller.signal,
        providerExecutor: async () => {
          if (kind === 'cancelled') controller.abort();
          return { ...fixture.providerResult, exitCode: kind === 'provider-failure' ? 1 : 0 };
        } });
      assert.equal(receipt.status, kind === 'cancelled' ? 'cancelled' : 'failed');
      assert.equal(receipt.commandResults[0]?.exitCode, kind === 'provider-failure' ? 1 : 0);
    });
  }
});

test('task cancellation without artifacts overrides a successful provider result and remains durable', async (t) => {
  const fixture = await requiredArtifactFixture(t, []);
  const controller = new AbortController();
  const task = fixture.signed();
  let calls = 0;
  const providerExecutor = async () => {
    calls++;
    controller.abort(new Error('private-cancellation-sentinel'));
    return fixture.providerResult;
  };
  const receipt = await executeTask({ ...fixture.input, task, signal: controller.signal, providerExecutor });
  assert.equal(calls, 1);
  assert.equal(receipt.commandResults[0]?.exitCode, 0);
  assert.equal(receipt.status, 'cancelled');
  assert.equal(receipt.commandResults.at(-1)?.stderr, 'required_artifact_interrupted');
  assert.equal(JSON.stringify(receipt).includes('private-cancellation-sentinel'), false);
  const durable = await fixture.input.receiptStore.get(task.taskId);
  assert.equal(durable?.status, 'cancelled');
  assert.equal(JSON.stringify(durable).includes('private-cancellation-sentinel'), false);
  const duplicate = await executeTask({ ...fixture.input, task, providerExecutor });
  assert.equal(duplicate.status, 'cancelled');
  assert.equal(calls, 1);
});

test('task cancellation without artifacts stops before provider execution when already aborted', async (t) => {
  const fixture = await requiredArtifactFixture(t, []);
  const controller = new AbortController();
  controller.abort(new Error('private-cancellation-sentinel'));
  let calls = 0;
  const receipt = await executeTask({ ...fixture.input, task: fixture.signed(), signal: controller.signal,
    providerExecutor: async () => { calls++; return fixture.providerResult; } });
  assert.equal(calls, 0);
  assert.equal(receipt.status, 'cancelled');
  assert.equal(receipt.commandResults.at(-1)?.stderr, 'required_artifact_interrupted');
  assert.equal(JSON.stringify(receipt).includes('private-cancellation-sentinel'), false);
});

test('task cancellation without artifacts is checked again after final Git inspection', async (t) => {
  const fixture = await requiredArtifactFixture(t, []);
  const controller = new AbortController();
  const originalSpawn = childProcess.spawn;
  let inspections = 0;
  const patch = t.mock.method(childProcess, 'spawn', (command: string, argv: readonly string[], options: object) => {
    const child = originalSpawn(command, argv, { ...options, windowsHide: true });
    if (command === 'git' && gitSubcommand(argv) === 'ls-files' && argv.includes('--exclude-standard')) {
      inspections++;
      child.once('close', () => controller.abort(new Error('private-cancellation-sentinel')));
    }
    return child;
  });
  syncBuiltinESMExports();
  try {
    const receipt = await executeTask({ ...fixture.input, task: fixture.signed(), signal: controller.signal,
      providerExecutor: async () => fixture.providerResult });
    assert.equal(inspections, 1);
    assert.equal(receipt.commandResults[0]?.exitCode, 0);
    assert.equal(receipt.status, 'cancelled');
    assert.equal(receipt.commandResults.at(-1)?.stderr, 'required_artifact_interrupted');
    assert.equal(JSON.stringify(receipt).includes('private-cancellation-sentinel'), false);
  } finally { patch.mock.restore(); syncBuiltinESMExports(); }
});

test('task cancellation without artifacts still permits an uninterrupted successful task', async (t) => {
  const fixture = await requiredArtifactFixture(t, []);
  const controller = new AbortController();
  let calls = 0;
  const receipt = await executeTask({ ...fixture.input, task: fixture.signed(), signal: controller.signal,
    providerExecutor: async () => { calls++; return fixture.providerResult; } });
  assert.equal(calls, 1);
  assert.equal(receipt.status, 'completed');
  assert.deepEqual(receipt.commandResults.map(result => result.commandId), ['provider.codex']);
});

test('required artifacts keep failed receipts durable and suppress duplicate execution', async (t) => {
  const fixture = await requiredArtifactFixture(t, ['reports/result.json']);
  const task = fixture.signed();
  let calls = 0;
  const input = { ...fixture.input, task, providerExecutor: async () => { calls++; return fixture.providerResult; } };
  const first = await executeTask(input);
  const duplicate = await executeTask(input);
  assert.equal(first.status, 'failed');
  assert.equal(duplicate.status, 'failed');
  assert.equal(calls, 1);
});

test('required artifacts cannot emit an executed acknowledgement after missing output', async (t) => {
  const fixture = await requiredArtifactFixture(t, ['reports/result.json']);
  const decisionKeys = generateKeyPairSync('ed25519');
  const base = { ...fixture.unsigned, target: { ...fixture.unsigned.target, endpointId: randomUUID() },
    requiredCapabilities: ['action_decision_receipts_v1'] as const };
  const actionDecision = embedDecision(base, 'release', decisionKeys.privateKey, new Date());
  const receipt = await executeTask({ ...fixture.input, task: fixture.signed({ ...base, actionDecision }),
    actionDecisions: { resolvePublicKey: () => decisionKeys.publicKey },
    providerExecutor: async () => fixture.providerResult });
  assert.equal(receipt.status, 'failed');
  assert.equal(receipt.actionAcknowledgement?.disposition, 'unknown');
});

test('required artifact review: signed output paths reach the provider without user instruction duplication', async (t) => {
  const fixture = await requiredArtifactFixture(t, ['reports/result.json']);
  const receipt = await executeTask({ ...fixture.input, task: fixture.signed(),
    providerExecutor: async ({ workspace, instructions }) => {
      const matched = instructions.match(/<dharma_required_artifacts>\n([\s\S]*?)\n<\/dharma_required_artifacts>/);
      assert.ok(matched, 'provider must receive the separately signed artifact list');
      const outputs = JSON.parse(matched[1]!);
      assert.deepEqual(outputs, ['reports/result.json']);
      await mkdir(resolve(workspace, 'reports'));
      await writeFile(resolve(workspace, outputs[0]!), '{}');
      return fixture.providerResult;
    } });
  assert.equal(receipt.status, 'completed');
});

test('required artifact review: superscript Windows device aliases are rejected before provider execution', async (t) => {
  for (const artifact of ['reports/COM\u00b9', 'reports/COM\u00b2.json', 'reports/COM\u00b3',
    'reports/LPT\u00b9', 'reports/LPT\u00b2.txt', 'reports/lpt\u00b3']) {
    await t.test(artifact, async (child) => {
      const fixture = await requiredArtifactFixture(child, [artifact]);
      let calls = 0;
      await assert.rejects(executeTask({ ...fixture.input, task: fixture.signed(),
        providerExecutor: async () => { calls++; return fixture.providerResult; } }), /required_artifact_invalid|Task failed schema validation/);
      assert.equal(calls, 0);
    });
  }
});

test('required artifact review: portable case and normalization collisions are rejected before execution', async (t) => {
  for (const artifacts of [['reports/A.json', 'reports/a.json'], ['reports/Result.json', 'Reports/result.json'],
    ['reports/\u00e9.json', 'reports/e\u0301.json']]) {
    await t.test(JSON.stringify(artifacts), async (child) => {
      const fixture = await requiredArtifactFixture(child, artifacts);
      fixture.unsigned.authority.readPaths = ['.'];
      let calls = 0;
      await assert.rejects(executeTask({ ...fixture.input, task: fixture.signed(),
        providerExecutor: async () => { calls++; return fixture.providerResult; } }), /required_artifact_invalid/);
      assert.equal(calls, 0);
    });
  }
});

test('required artifact review: unusable component and total path lengths are rejected before execution', async (t) => {
  for (const artifact of ['reports/' + 'x'.repeat(256), 'reports/' + '\u00e9'.repeat(128),
    'reports/' + Array(25).fill('x'.repeat(200)).join('/')]) {
    await t.test('UTF8 bytes ' + Buffer.byteLength(artifact), async (child) => {
      const fixture = await requiredArtifactFixture(child, [artifact]);
      let calls = 0;
      await assert.rejects(executeTask({ ...fixture.input, task: fixture.signed(),
        providerExecutor: async () => { calls++; return fixture.providerResult; } }), /required_artifact_invalid|Task failed schema validation/);
      assert.equal(calls, 0);
    });
  }
});

test('required artifact review v3: console aliases and lone surrogates fail before provider execution', async (t) => {
  for (const artifact of ['reports/CONIN$', 'reports/conout$', 'reports/ConIn$.txt', 'reports/CONOUT$.json',
    'reports/\ud800', 'reports/\ud801', 'reports/\udc00', 'reports/x\udfff.json']) {
    await t.test(JSON.stringify(artifact), async (child) => {
      const fixture = await requiredArtifactFixture(child, [artifact]);
      let calls = 0;
      await assert.rejects(executeTask({ ...fixture.input, task: fixture.signed(),
        providerExecutor: async () => { calls++; return fixture.providerResult; } }), /required_artifact_invalid/);
      assert.equal(calls, 0);
    });
  }
});

test('required artifact review v3: metadata does not consume the schema instruction allowance', async (t) => {
  const fixture = await requiredArtifactFixture(t, ['reports/result.json']);
  const instructions = 'x'.repeat(20_000);
  const receipt = await executeTask({ ...fixture.input, task: fixture.signed({ instructions }),
    providerExecutor: async ({ workspace, instructions: formatted }) => {
      assert.ok(formatted.startsWith(instructions + '\n'));
      assert.match(formatted, /reports\/result.json/);
      await mkdir(resolve(workspace, 'reports'));
      await writeFile(resolve(workspace, 'reports/result.json'), '{}');
      return fixture.providerResult;
    } });
  assert.equal(receipt.status, 'completed');
});

test('required artifact review v3: full artifact list and paired Unicode retain bounded instructions', async (t) => {
  const artifacts = Array.from({ length: 100 }, (_, index) => `reports/${index}-${'x'.repeat(90)}-\ud83d\ude00.json`);
  const fixture = await requiredArtifactFixture(t, artifacts);
  const formatted = providerInstructionsForTask(fixture.signed({ instructions: 'x'.repeat(20_000) }));
  const matched = formatted.match(/<dharma_required_artifacts>\n([\s\S]*?)\n<\/dharma_required_artifacts>/);
  assert.ok(matched);
  assert.deepEqual(JSON.parse(matched[1]!), artifacts);
  assert.ok(formatted.length < 276_001);
  assert.throws(() => providerInstructionsForTask(fixture.signed({ instructions: 'x'.repeat(20_001) })),
    /Provider instructions exceed the execution limit/);
});

test('required artifact review v3: raw artifact count is bounded before metadata formatting', async (t) => {
  const artifacts = Array.from({ length: 10_000 }, (_, index) => `reports/${index}-${'x'.repeat(30)}.json`);
  const fixture = await requiredArtifactFixture(t, artifacts);
  assert.throws(() => providerInstructionsForTask(fixture.signed()), /required_artifact_invalid/);
});

test('required artifact review v4: Git preserves Unicode paths in tracked and untracked results', async (t) => {
  for (const tracked of [false, true]) {
    await t.test(tracked ? 'tracked' : 'untracked', async (child) => {
      const artifact = 'reports/\ud83d\ude00 output.json';
      const fixture = await requiredArtifactFixture(child, [artifact]);
      const receipt = await executeTask({ ...fixture.input, task: fixture.signed(),
        providerExecutor: async ({ workspace }) => {
          await mkdir(resolve(workspace, 'reports'));
          await writeFile(resolve(workspace, artifact), '{}');
          if (tracked) assert.equal(spawnSync('git', ['add', '--', artifact], { cwd: workspace, windowsHide: true }).status, 0);
          return fixture.providerResult;
        } });
      assert.equal(receipt.status, 'completed');
    });
  }
});

test('required artifact review v4: delimiter-safe paths do not widen signed write scope', async (t) => {
  for (const outside of ['outside/\ud83d\ude00.json', ' reports/leak.txt']) {
    await t.test(JSON.stringify(outside), async (child) => {
      const fixture = await requiredArtifactFixture(child, []);
      const receipt = await executeTask({ ...fixture.input, task: fixture.signed(),
        providerExecutor: async ({ workspace }) => {
          await mkdir(resolve(workspace, outside.split('/')[0]!));
          await writeFile(resolve(workspace, outside), '{}');
          return fixture.providerResult;
        } });
      assert.equal(receipt.status, 'failed');
      const expected = 'Error: Provider changed a path outside the signed task authority.';
      assert.equal(receipt.commandResults.at(-1)?.stderrSha256,
        `sha256:${createHash('sha256').update(expected).digest('hex')}`);
    });
  }
});

test('required artifact review v5: Unicode caseless aliases fail before provider execution', async (t) => {
  for (const pair of [['reports/\u03c3.json', 'reports/\u03c2.json'], ['reports/\u00df.json', 'reports/\u1e9e.json']]) {
    const fixture = await requiredArtifactFixture(t, pair);
    let calls = 0;
    await assert.rejects(executeTask({ ...fixture.input, task: fixture.signed(),
      providerExecutor: async () => { calls++; return fixture.providerResult; } }), /required_artifact_invalid/);
    assert.equal(calls, 0);
  }
});

test('required artifact review v5: signed schemas bound raw artifact entries before deduplication', async (t) => {
  const fixture = await requiredArtifactFixture(t, []);
  const task = fixture.signed({ target: { ...fixture.unsigned.target, endpointId: randomUUID() } });
  for (const [artifacts, valid] of [[Array(100).fill('reports/a'), true], [Array(101).fill('reports/a'), false],
    [['x'.repeat(1000)], true], [['x'.repeat(1001)], false]] as [string[], boolean][]) {
    const value = { ...task, acceptance: { ...task.acceptance, requiredArtifacts: artifacts } };
    assert.equal(validateTaskEnvelopeContract(value).ok, valid);
    assert.equal(validateTaskActionContract(canonicalTaskActionForTask(value, randomUUID())).ok, valid);
  }
});

test('required artifact review v6: acceptance count reserves capacity for a durable failure receipt', async (t) => {
  const fixture = await requiredArtifactFixture(t, []);
  const task = fixture.signed({ target: { ...fixture.unsigned.target, endpointId: randomUUID() } });
  for (const [count, valid] of [[98, true], [99, false]] as [number, boolean][]) {
    const value = { ...task, acceptance: { ...task.acceptance,
      commands: Array.from({ length: count }, () => ({ commandId: 'verify' })) } };
    assert.equal(validateTaskEnvelopeContract(value).ok, valid);
    assert.equal(validateTaskActionContract(canonicalTaskActionForTask(value, randomUUID())).ok, valid);
  }
  const oversized = fixture.signed({ acceptance: { ...fixture.unsigned.acceptance,
    commands: Array.from({ length: 99 }, () => ({ commandId: 'verify' })) } });
  let calls = 0;
  await assert.rejects(executeTask({ ...fixture.input, task: oversized,
    providerExecutor: async () => { calls++; return fixture.providerResult; } }), /schema validation|receipt capacity/);
  assert.equal(calls, 0);
});

test('required artifact review v8: signed schemas reject empty artifact references', async (t) => {
  const fixture = await requiredArtifactFixture(t, ['']);
  const task = fixture.signed({ target: { ...fixture.unsigned.target, endpointId: randomUUID() } });
  assert.equal(validateTaskEnvelopeContract(task).ok, false);
  assert.equal(validateTaskActionContract(canonicalTaskActionForTask(task, randomUUID())).ok, false);
});

test('required artifact review v8: impossible ancestor file requirements fail before effects', async (t) => {
  for (const artifacts of [['reports/result', 'reports/result/details.json'],
    ['reports/result/details.json', 'reports/result'], ['reports/RESULT', 'reports/result/details.json'],
    ['reports/\u00e9', 'reports/e\u0301/details.json']]) {
    await t.test(JSON.stringify(artifacts), async (child) => {
      const fixture = await requiredArtifactFixture(child, artifacts);
      let calls = 0;
      await assert.rejects(executeTask({ ...fixture.input, task: fixture.signed(),
        providerExecutor: async () => { calls++; return fixture.providerResult; } }), /required_artifact_invalid/);
      assert.equal(calls, 0);
    });
  }
});

test('signed task runs only a registered command in a relay-owned worktree and deduplicates delivery', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'dharma-task-runner-'));
  const workspace = resolve(root, 'workspace');
  await mkdir(workspace);
  assert.equal(spawnSync('git', ['init', '-q'], { cwd: workspace, windowsHide: true }).status, 0);
  assert.equal(spawnSync('git', ['config', 'user.email', 'test@dharma-ai.io'], { cwd: workspace, windowsHide: true }).status, 0);
  assert.equal(spawnSync('git', ['config', 'user.name', 'Dharma Test'], { cwd: workspace, windowsHide: true }).status, 0);
  assert.equal(spawnSync('git', ['commit', '--allow-empty', '-qm', 'initial'], { cwd: workspace, windowsHide: true }).status, 0);
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
  const first = await executeTask({ registeredCommandSandbox: STAND_IN_SANDBOX, task, policy, workspace, relayStateDirectory: resolve(root, 'state'), serverPublicKey: publicKey, receiptStore: store, providerExecutor });
  const second = await executeTask({ registeredCommandSandbox: STAND_IN_SANDBOX, task, policy, workspace, relayStateDirectory: resolve(root, 'state'), serverPublicKey: publicKey, receiptStore: store, providerExecutor });
  assert.equal(first.status, 'completed');
  assert.equal(first.commandResults[0]?.commandId, 'provider.codex');
  assert.equal(first.commandResults[1]?.stdout, 'verified');
  assert.equal(providerExecutions, 1);
  assert.equal(providerAllowWrites, false);
  assert.equal('actionAcknowledgement' in first, false);
  assert.equal(second.commandResults.every((result) => result.stdout === '' && result.stderr === ''), true);
  const durableReceiptText = await readFile(resolve(root, 'receipts', `${task.taskId}.json`), 'utf8');
  assert.equal(durableReceiptText.includes('agent completed'), false);
  assert.equal(durableReceiptText.includes('verified'), false);
  const durableReceipt = JSON.parse(durableReceiptText);
  assert.equal(durableReceipt.taskId, task.taskId);
  assert.equal(durableReceipt.commandResults[0].stdoutSha256, `sha256:${'1'.repeat(64)}`);
  const failedReceipt = {
    ...first, status: 'failed' as const,
    commandResults: [{ ...first.commandResults[0]!, exitCode: 1, failureCategory: 'quota' as const,
      stderr: 'private-account@example.test' }],
  };
  await store.put(failedReceipt);
  const recovered = await store.get(task.taskId);
  assert.equal(recovered?.commandResults[0]?.failureCategory, 'quota');
  assert.equal(recovered?.commandResults[0]?.stderr, '');
});

test('Claude tasks read required skills from installed files because safe mode disables native skills', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'dharma-task-skill-file-'));
  const workspace = resolve(root, 'workspace');
  await mkdir(workspace);
  assert.equal(spawnSync('git', ['init', '-q'], { cwd: workspace, windowsHide: true }).status, 0);
  assert.equal(spawnSync('git', ['config', 'user.email', 'test@dharma-ai.io'], { cwd: workspace, windowsHide: true }).status, 0);
  assert.equal(spawnSync('git', ['config', 'user.name', 'Dharma Test'], { cwd: workspace, windowsHide: true }).status, 0);
  assert.equal(spawnSync('git', ['commit', '--allow-empty', '-qm', 'initial'], { cwd: workspace, windowsHide: true }).status, 0);
  const policy: OrganizationPolicy = {
    schema: 'dharma.organization-policy/v1', organizationId: 'org_test', revision: '1',
    evidence: { defaultMode: 'deep', registeredWorkspaceOnly: true, excludePaths: [], maximumCapsuleBytes: 1, maximumDailyUploadBytes: 1, maximumExpansionBytes: 1 },
    tasks: { defaultNetwork: 'deny', defaultGit: 'task_branch', allowedCommands: {}, writePaths: [], requireLocalConfirmationFor: [] },
    skills: { automaticInstall: true, automaticPromotionMaxRisk: 'R2', canaryPercent: 10 }, retention: {}, budgets: {},
  };
  const keys = generateKeyPairSync('ed25519');
  const signedTask = () => {
    const unsigned = {
      schema: 'dharma.task/v1' as const, taskId: randomUUID(), organizationId: 'org_test', workspaceId: 'workspace', taskType: 'external_request' as const,
      target: { deviceId: 'device', provider: 'claude' as const }, skillBundle: { bundleId: randomUUID(), bundleHash: `sha256:${'a'.repeat(64)}` },
      instructions: 'Use the skill.',
      requiredSkills: [{ skillId: 'dharma-agent-fabric', version: '5.0.0', commit: 'b'.repeat(40), contentHash: `sha256:${'c'.repeat(64)}` }],
      authority: { readPaths: ['.'], writePaths: [], commands: [], network: 'deny', git: 'task_branch' as const },
      execution: { isolation: 'git_worktree' as const, timeoutSeconds: 10, leaseSeconds: 20, maximumConcurrentAgents: 1 },
      acceptance: { commands: [], requiredArtifacts: [] }, budget: { mode: 'byok_local' as const, maximumDharmaCostCents: 0 },
      createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString(), nonce: randomUUID(),
    };
    return { ...unsigned, signature: signCanonicalObject(unsigned, keys.privateKey) } as TaskEnvelope;
  };
  const skillFile = resolve(root, 'skills', 'dharma-agent-fabric', 'SKILL.md');
  await mkdir(resolve(root, 'skills', 'dharma-agent-fabric'), { recursive: true });
  await writeFile(skillFile, '# Skill\n');
  const state = resolve(root, 'state');
  const receiptStore = new FileTaskReceiptStore(resolve(root, 'receipts'));
  let providerCalls = 0;
  const providerExecutor: ProviderTaskExecutor = async (input) => {
    providerCalls += 1;
    assert.ok(input.instructions.includes(JSON.stringify(skillFile)));
    assert.deepEqual(input.requiredSkillPaths, [skillFile]);
    assert.match(input.instructions, /use the Read tool/);
    return { provider: 'claude', exitCode: 0, signal: null, timedOut: false, stdout: 'answer', stderr: '',
      stdoutSha256: `sha256:${'1'.repeat(64)}`, stderrSha256: `sha256:${'0'.repeat(64)}` };
  };
  const common = { policy, workspace, relayStateDirectory: state, serverPublicKey: keys.publicKey, receiptStore, providerExecutor };
  const success = await executeTask({ ...common, task: signedTask(),
    requiredSkillFiles: [{ skillId: 'dharma-agent-fabric', path: skillFile }] });
  assert.equal(success.status, 'completed');
  assert.equal(providerCalls, 1);

  const missingFile = await executeTask({ ...common, task: signedTask(),
    requiredSkillFiles: [{ skillId: 'dharma-agent-fabric', path: resolve(root, 'absent', 'SKILL.md') }] });
  assert.equal(missingFile.status, 'failed');
  assert.match(missingFile.commandResults[0]?.stderr || '', /Required skill file is unavailable/);

  const unlisted = await executeTask({ ...common, task: signedTask() });
  assert.equal(unlisted.status, 'failed');
  assert.match(unlisted.commandResults[0]?.stderr || '', /Required skill file is unavailable/);
  assert.equal(providerCalls, 1);
});

test('read-only signed tasks receive only matching verified knowledge and remove it afterward', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'dharma-task-knowledge-'));
  const workspace = resolve(root, 'workspace');
  await mkdir(workspace);
  assert.equal(spawnSync('git', ['init', '-q'], { cwd: workspace, windowsHide: true }).status, 0);
  assert.equal(spawnSync('git', ['config', 'user.email', 'test@dharma-ai.io'], { cwd: workspace, windowsHide: true }).status, 0);
  assert.equal(spawnSync('git', ['config', 'user.name', 'Dharma Test'], { cwd: workspace, windowsHide: true }).status, 0);
  assert.equal(spawnSync('git', ['commit', '--allow-empty', '-qm', 'initial'], { cwd: workspace, windowsHide: true }).status, 0);
  const policy: OrganizationPolicy = {
    schema: 'dharma.organization-policy/v1', organizationId: 'org_test', revision: '1',
    evidence: { defaultMode: 'deep', registeredWorkspaceOnly: true, excludePaths: [], maximumCapsuleBytes: 1, maximumDailyUploadBytes: 1, maximumExpansionBytes: 1 },
    tasks: { defaultNetwork: 'deny', defaultGit: 'task_branch', allowedCommands: {}, writePaths: [], requireLocalConfirmationFor: [] },
    skills: { automaticInstall: true, automaticPromotionMaxRisk: 'R2', canaryPercent: 10 }, retention: {}, budgets: {},
  };
  const keys = generateKeyPairSync('ed25519');
  const bundleId = randomUUID(), bundleHash = `sha256:${'a'.repeat(64)}`;
  const unsigned = {
    schema: 'dharma.task/v1' as const, taskId: randomUUID(), organizationId: 'org_test', workspaceId: 'workspace', taskType: 'external_request' as const,
    target: { deviceId: 'device', provider: 'codex' as const }, skillBundle: { bundleId, bundleHash },
    instructions: 'Answer from shared knowledge.', requiredSkills: [],
    authority: { readPaths: ['.'], writePaths: [], commands: [], network: 'deny', git: 'task_branch' as const },
    execution: { isolation: 'git_worktree' as const, timeoutSeconds: 10, leaseSeconds: 20, maximumConcurrentAgents: 1 },
    acceptance: { commands: [], requiredArtifacts: [] }, budget: { mode: 'byok_local' as const, maximumDharmaCostCents: 0 },
    createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString(), nonce: randomUUID(),
  };
  const task = { ...unsigned, signature: signCanonicalObject(unsigned, keys.privateKey) } as TaskEnvelope;
  const knowledge = { organizationId: 'org_test', workspaceId: 'workspace', provider: 'codex' as const,
    bundleId, bundleHash, catalogBytes: Buffer.from('{"concepts":[{"name":"canonical term"}]}'),
    manifestBytes: Buffer.from('{"snapshotHash":"sha256:example"}') };
  const state = resolve(root, 'state');
  const receiptStore = new FileTaskReceiptStore(resolve(root, 'receipts'));
  let providerCalls = 0;
  const success = await executeTask({ task, policy, workspace, relayStateDirectory: state,
    serverPublicKey: keys.publicKey, receiptStore, verifiedRepositoryKnowledge: knowledge,
    providerExecutor: async input => {
      providerCalls += 1;
      assert.equal(input.allowWrites, false);
      assert.match(input.instructions, /\.dharma-task-knowledge\/CATALOG\.json/);
      assert.match(input.instructions, /isolated temporary task worktree, not the enrolled repository workspace/);
      assert.match(input.instructions, /Do not run dharma skills verify --workspace \. here/);
      assert.match(input.instructions, /generic-bootstrap result cannot describe the enrolled package/);
      assert.match(input.instructions, /If a read is denied, report the exact denied operation/);
      assert.match(input.instructions, /use the read-only dharma_task_knowledge tools/);
      assert.ok(input.instructions.includes(bundleId));
      assert.ok(input.instructions.includes(bundleHash));
      assert.equal(input.taskKnowledge?.directory, resolve(input.workspace, '.dharma-task-knowledge'));
      assert.equal(input.taskKnowledge?.catalogSha256,
        `sha256:${createHash('sha256').update(knowledge.catalogBytes).digest('hex')}`);
      assert.equal(input.taskKnowledge?.manifestSha256,
        `sha256:${createHash('sha256').update(knowledge.manifestBytes).digest('hex')}`);
      assert.equal(await readFile(resolve(input.workspace, '.dharma-task-knowledge/CATALOG.json'), 'utf8'), knowledge.catalogBytes.toString());
      assert.equal(await readFile(resolve(input.workspace, '.dharma-task-knowledge/MANIFEST.json'), 'utf8'), knowledge.manifestBytes.toString());
      return { provider: 'codex', exitCode: 0, signal: null, timedOut: false, stdout: 'answer', stderr: '',
        stdoutSha256: `sha256:${'1'.repeat(64)}`, stderrSha256: `sha256:${'0'.repeat(64)}` };
    },
  });
  assert.equal(success.status, 'completed');
  assert.equal(providerCalls, 1);
  await assert.rejects(readFile(resolve(success.worktree, '.dharma-task-knowledge/CATALOG.json')), /ENOENT/);
  const wrongScopeUnsigned = { ...unsigned, taskId: randomUUID() };
  const wrongScopeTask = { ...wrongScopeUnsigned,
    signature: signCanonicalObject(wrongScopeUnsigned, keys.privateKey) } as TaskEnvelope;
  await assert.rejects(executeTask({ task: wrongScopeTask, policy, workspace,
    relayStateDirectory: state, serverPublicKey: keys.publicKey, receiptStore,
    verifiedRepositoryKnowledge: { ...knowledge, organizationId: 'foreign_org' },
    providerExecutor: async () => { providerCalls += 1; throw new Error('must not execute'); },
  }), /signed task scope/);
  assert.equal(providerCalls, 1);

  const mutatedUnsigned = { ...unsigned, taskId: randomUUID() };
  const mutatedTask = { ...mutatedUnsigned, signature: signCanonicalObject(mutatedUnsigned, keys.privateKey) } as TaskEnvelope;
  const failure = await executeTask({ task: mutatedTask, policy, workspace, relayStateDirectory: state,
    serverPublicKey: keys.publicKey, receiptStore, verifiedRepositoryKnowledge: knowledge,
    providerExecutor: async input => {
      const catalog = resolve(input.workspace, '.dharma-task-knowledge/CATALOG.json');
      await rm(catalog);
      await writeFile(catalog, '{"concepts":[]}');
      return { provider: 'codex', exitCode: 0, signal: null, timedOut: false, stdout: 'answer', stderr: '',
        stdoutSha256: `sha256:${'1'.repeat(64)}`, stderrSha256: `sha256:${'0'.repeat(64)}` };
    },
  });
  assert.equal(failure.status, 'failed');
  assert.match(failure.commandResults[0]?.stderr || '', /knowledge was changed/);
  await assert.rejects(readFile(resolve(failure.worktree, '.dharma-task-knowledge/CATALOG.json')), /ENOENT/);

  const extraUnsigned = { ...unsigned, taskId: randomUUID() };
  const extraTask = { ...extraUnsigned, signature: signCanonicalObject(extraUnsigned, keys.privateKey) } as TaskEnvelope;
  const extra = await executeTask({ task: extraTask, policy, workspace, relayStateDirectory: state,
    serverPublicKey: keys.publicKey, receiptStore, verifiedRepositoryKnowledge: knowledge,
    providerExecutor: async input => {
      await writeFile(resolve(input.workspace, '.dharma-task-knowledge/EXTRA.json'), '{}');
      return { provider: 'codex', exitCode: 0, signal: null, timedOut: false, stdout: 'answer', stderr: '',
        stdoutSha256: `sha256:${'1'.repeat(64)}`, stderrSha256: `sha256:${'0'.repeat(64)}` };
    },
  });
  assert.equal(extra.status, 'failed');
  assert.match(extra.commandResults[0]?.stderr || '', /knowledge was changed/);
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

test('task signatures resolve an explicit rotating server key version', () => {
  const legacy = generateKeyPairSync('ed25519');
  const rotated = generateKeyPairSync('ed25519');
  const signerKeyVersion = 'projects/test/locations/global/keyRings/test/cryptoKeys/tasks/cryptoKeyVersions/2';
  const unsigned = {
    schema: 'dharma.task/v1' as const,
    taskId: randomUUID(), organizationId: 'org', workspaceId: 'workspace', taskType: 'external_request' as const,
    target: { deviceId: 'device', provider: 'codex' as const }, skillBundle: null,
    instructions: 'Inspect the repository.', requiredSkills: [],
    authority: { readPaths: ['.'], writePaths: [], commands: [], network: 'deny', git: 'task_branch' as const },
    execution: { isolation: 'git_worktree' as const, timeoutSeconds: 10, leaseSeconds: 20, maximumConcurrentAgents: 1 },
    acceptance: { commands: [], requiredArtifacts: [] },
    budget: { mode: 'byok_local' as const, maximumDharmaCostCents: 0 },
    createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString(),
    nonce: randomUUID(), signerKeyVersion,
  };
  const task = { ...unsigned, signature: signCanonicalObject(unsigned, rotated.privateKey) } as TaskEnvelope;
  assert.doesNotThrow(() => verifyTaskEnvelope(
    task,
    legacy.publicKey,
    new Date(),
    (version) => version === signerKeyVersion ? rotated.publicKey : null,
  ));
  assert.throws(() => verifyTaskEnvelope(task, legacy.publicKey, new Date(), () => null), /key version is unavailable/);
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
  assert.equal(spawnSync('git', ['init', '-q'], { cwd: workspace, windowsHide: true }).status, 0);
  assert.equal(spawnSync('git', ['config', 'user.email', 'test@dharma-ai.io'], { cwd: workspace, windowsHide: true }).status, 0);
  assert.equal(spawnSync('git', ['config', 'user.name', 'Dharma Test'], { cwd: workspace, windowsHide: true }).status, 0);
  assert.equal(spawnSync('git', ['add', '.'], { cwd: workspace, windowsHide: true }).status, 0);
  assert.equal(spawnSync('git', ['commit', '-qm', 'initial'], { cwd: workspace, windowsHide: true }).status, 0);
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
      assert.equal(spawnSync('git', ['add', 'outside.txt'], { cwd: worktree, windowsHide: true }).status, 0);
      assert.equal(spawnSync('git', ['commit', '-qm', 'unauthorized change'], { cwd: worktree, windowsHide: true }).status, 0);
      return providerResult;
    },
  });
  assert.equal(committed.status, 'failed');
  assert.match(committed.commandResults.at(-1)?.stderr || '', /outside the signed task authority/);
});

test('acceptance commands cannot expand signed write scope or run a later command after a violation', async (t) => {
  for (const variant of ['untracked', 'tracked', 'committed', 'receipt-required'] as const) {
    await t.test(variant, async (child) => {
      const fixture = await requiredArtifactFixture(child, []);
      const forbiddenPath = 'private-scope-canary.txt';
      await writeFile(resolve(fixture.workspace, forbiddenPath), 'original');
      assert.equal(spawnSync('git', ['add', forbiddenPath], { cwd: fixture.workspace, windowsHide: true }).status, 0);
      assert.equal(spawnSync('git', ['commit', '-qm', 'protected fixture'], { cwd: fixture.workspace, windowsHide: true }).status, 0);
      const target = variant === 'untracked' || variant === 'receipt-required' ? 'untracked-scope-canary.txt' : forbiddenPath;
      const script = `require('node:fs').writeFileSync(${JSON.stringify(target)}, 'private-content-canary');`
        + (variant === 'committed'
          ? `const cp=require('node:child_process');for(const args of [['add',${JSON.stringify(target)}],['commit','-qm','validation change']]){if(cp.spawnSync('git',args).status!==0)process.exit(2);}`
          : '');
      fixture.policy.tasks.allowedCommands.verify = { argv: [process.execPath, '-e', script], timeoutSeconds: 5 };
      fixture.policy.tasks.allowedCommands.next = { argv: [process.execPath, '-e',
        'const fs=require("node:fs");fs.mkdirSync("reports",{recursive:true});fs.writeFileSync("reports/next.txt","must not run");'], timeoutSeconds: 5 };
      fixture.unsigned.authority.commands.push({ commandId: 'verify' }, { commandId: 'next' });
      fixture.unsigned.acceptance.commands.push({ commandId: 'verify' }, { commandId: 'next' });
      const decisionKeys = generateKeyPairSync('ed25519');
      const base = { ...fixture.unsigned, target: { ...fixture.unsigned.target, endpointId: randomUUID() },
        requiredCapabilities: ['action_decision_receipts_v1'] as const };
      const task = variant === 'receipt-required' ? fixture.signed({ ...base,
        actionDecision: embedDecision(base, 'release', decisionKeys.privateKey, new Date()) }) : fixture.signed();
      const receipt = await executeTask({ ...fixture.input, task,
        ...(variant === 'receipt-required' ? { actionDecisions: { resolvePublicKey: () => decisionKeys.publicKey } } : {}),
        providerExecutor: async () => fixture.providerResult });
      assert.equal(receipt.status, 'failed');
      assert.equal(receipt.commandResults[1]?.commandId, 'verify');
      assert.equal(receipt.commandResults[1]?.exitCode, 0);
      assert.equal(receipt.commandResults.some(result => result.commandId === 'next'), false);
      assert.match(receipt.commandResults.at(-1)?.stderr || '', /Acceptance command changed a path outside the signed task authority/);
      await assert.rejects(readFile(resolve(receipt.worktree, 'reports/next.txt')), { code: 'ENOENT' });
      const stored = await fixture.input.receiptStore.get(task.taskId);
      assert.equal(stored?.status, 'failed');
      assert.equal(JSON.stringify(stored).includes('scope-canary'), false);
      assert.equal(JSON.stringify(stored).includes('private-content-canary'), false);
      if (variant === 'receipt-required') assert.equal(receipt.actionAcknowledgement?.disposition, 'unknown');
      const replay = await executeTask({ ...fixture.input, task,
        providerExecutor: async () => { throw new Error('A failed receipt must not re-execute.'); } });
      assert.deepEqual(replay, stored);
    });
  }
});

test('acceptance commands preserve authorized outputs and read-only tasks', async (t) => {
  for (const variant of ['authorized', 'read-only'] as const) {
    await t.test(variant, async (child) => {
      const fixture = await requiredArtifactFixture(child, variant === 'authorized' ? ['reports/result.json'] : []);
      if (variant === 'read-only') fixture.unsigned.authority.writePaths = [];
      const script = variant === 'authorized'
        ? 'const fs=require("node:fs");fs.mkdirSync("reports",{recursive:true});fs.writeFileSync("reports/result.json","{}");'
        : 'process.stdout.write("read-only validation");';
      fixture.policy.tasks.allowedCommands.verify = { argv: [process.execPath, '-e', script], timeoutSeconds: 5 };
      fixture.unsigned.authority.commands.push({ commandId: 'verify' });
      fixture.unsigned.acceptance.commands.push({ commandId: 'verify' });
      const receipt = await executeTask({ ...fixture.input, task: fixture.signed(), providerExecutor: async () => fixture.providerResult });
      assert.equal(receipt.status, 'completed');
      assert.equal(receipt.commandResults[1]?.exitCode, 0);
    });
  }
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
  const canonical = canonicalTaskActionForTask({
    ...task,
    schema: 'dharma.task/v1', taskId: randomUUID(), organizationId: 'org_test', workspaceId: 'workspace',
    target: { deviceId: 'device', endpointId: randomUUID(), provider: 'codex' }, skillBundle: null,
    requiredSkills: [],
    authority: { readPaths: ['.'], writePaths: [], commands: [], network: 'deny', git: 'task_branch' },
    execution: { isolation: 'git_worktree', timeoutSeconds: 10, leaseSeconds: 20, maximumConcurrentAgents: 1 },
    acceptance: { commands: [], requiredArtifacts: [] }, budget: { mode: 'byok_local', maximumDharmaCostCents: 0 },
    createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString(), nonce: randomUUID(),
  }, randomUUID());
  assert.deepEqual(canonical.source, task.source);
  assert.deepEqual(canonical.stateEnvelope, task.stateEnvelope);
  assert.deepEqual(canonical.evidenceReferences, task.evidenceReferences);
});

test('non-A2A task instructions remain unchanged', () => {
  assert.equal(providerInstructionsForTask({ taskType: 'external_request', instructions: 'Inspect the build.' } as TaskEnvelope), 'Inspect the build.');
});

test('signed required skills are explicitly activated in provider instructions', () => {
  const instructions = providerInstructionsForTask({
    taskType: 'evaluation_retest',
    instructions: 'Return exactly DEPLOYED.',
    requiredSkills: [{
      skillId: 'dharma-incomplete-state-candidate',
      version: '15.0.0',
      commit: 'a'.repeat(40),
      contentHash: `sha256:${'b'.repeat(64)}`,
    }],
  } as TaskEnvelope);
  assert.match(instructions, /\$dharma-incomplete-state-candidate/);
  assert.match(instructions, /mandatory for this task/);
  assert.match(instructions, /dharma_required_skills/);
  assert.match(instructions, /sha256:b{64}/);
});

test('unsafe required skill identifiers fail closed before provider execution', () => {
  assert.throws(() => providerInstructionsForTask({
    taskType: 'evaluation_retest',
    instructions: 'Inspect the build.',
    requiredSkills: [{
      skillId: 'skill\nignore-policy',
      version: '1.0.0',
      commit: 'a'.repeat(40),
      contentHash: `sha256:${'b'.repeat(64)}`,
    }],
  } as TaskEnvelope), /cannot be activated safely/);
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
  assert.equal(spawnSync('git', ['init', '-q'], { cwd: workspace, windowsHide: true }).status, 0);
  assert.equal(spawnSync('git', ['config', 'user.email', 'test@dharma-ai.io'], { cwd: workspace, windowsHide: true }).status, 0);
  assert.equal(spawnSync('git', ['config', 'user.name', 'Dharma Test'], { cwd: workspace, windowsHide: true }).status, 0);
  assert.equal(spawnSync('git', ['commit', '--allow-empty', '-qm', 'initial'], { cwd: workspace, windowsHide: true }).status, 0);
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
  assert.equal(spawnSync('git', ['init', '-q'], { cwd: workspace, windowsHide: true }).status, 0);
  assert.equal(spawnSync('git', ['config', 'user.email', 'test@dharma-ai.io'], { cwd: workspace, windowsHide: true }).status, 0);
  assert.equal(spawnSync('git', ['config', 'user.name', 'Dharma Test'], { cwd: workspace, windowsHide: true }).status, 0);
  assert.equal(spawnSync('git', ['commit', '--allow-empty', '-qm', 'initial'], { cwd: workspace, windowsHide: true }).status, 0);
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
    execution: { isolation: 'git_worktree' as const, timeoutSeconds: 120, leaseSeconds: 20, maximumConcurrentAgents: 1 },
    acceptance: { commands: [{ commandId: 'verify' }], requiredArtifacts: [] }, budget: { mode: 'byok_local' as const, maximumDharmaCostCents: 0 },
    createdAt: now.toISOString(), expiresAt: new Date(now.getTime() + 60_000).toISOString(), nonce: randomUUID(),
  } satisfies Omit<TaskEnvelope, 'actionDecision' | 'signature'>;
  const actionDecision = embedDecision(baseTask, 'release', decisionKeys.privateKey, now);
  const unsigned = { ...baseTask, actionDecision };
  const task = { ...unsigned, signature: signCanonicalObject(unsigned, taskKeys.privateKey) } as TaskEnvelope;
  let executions = 0;
  let decisionConsumptions = 0;
  const result = await executeTask({ registeredCommandSandbox: STAND_IN_SANDBOX,
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
    providerExecutor: async (providerInput) => {
      executions += 1;
      assert.equal(providerInput.externalIdempotencyKey, actionDecision.id);
      assert.equal(providerInput.actionDigest, actionDecision.actionDigest);
      assert.ok(providerInput.timeoutSeconds <= 60, 'provider timeout must not outlive the signed task');
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
  const durableJournal = await readFile(
    resolve(root, 'state', 'action-execution-journal', `${task.taskId}.json`),
    'utf8',
  );
  assert.equal(durableJournal.includes('done'), false);
  assert.equal(durableJournal.includes('released'), false);

  const networkPolicy = {
    ...policy,
    tasks: { ...policy.tasks, defaultNetwork: 'allowlisted_domains' as const },
  };
  const networkBase = {
    ...baseTask,
    taskId: randomUUID(),
    target: { ...baseTask.target, endpointId: randomUUID() },
    authority: {
      ...baseTask.authority,
      network: 'allowlisted_domains' as const,
      allowlistedDomains: ['api.example.test'],
    },
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    nonce: randomUUID(),
  };
  const networkDecision = embedDecision(networkBase, 'release', decisionKeys.privateKey, new Date());
  const networkUnsigned = { ...networkBase, actionDecision: networkDecision };
  const networkTask = {
    ...networkUnsigned,
    signature: signCanonicalObject(networkUnsigned, taskKeys.privateKey),
  } as TaskEnvelope;
  let networkExecutions = 0;
  await assert.rejects(executeTask({ registeredCommandSandbox: STAND_IN_SANDBOX,
    task: networkTask,
    policy: networkPolicy,
    workspace,
    relayStateDirectory: resolve(root, 'network-state'),
    serverPublicKey: taskKeys.publicKey,
    receiptStore: new FileTaskReceiptStore(resolve(root, 'network-receipts')),
    actionDecisions: { resolvePublicKey: () => decisionKeys.publicKey },
    providerExecutor: async () => {
      networkExecutions += 1;
      return {
        provider: 'codex', exitCode: 0, signal: null, timedOut: false,
        stdout: 'provider said it sent the request', stderr: '',
        stdoutSha256: `sha256:${'2'.repeat(64)}`, stderrSha256: `sha256:${'0'.repeat(64)}`,
      };
    },
  }), (error: unknown) => error instanceof taskRunner.RegisteredCommandsRefusedError && error.reason === 'network_not_denied');
  assert.equal(networkExecutions, 0);
  // Tasks with registered commands and a network grant are refused before anything runs: their
  // commands would need the host network. The external-effect receipt path below is refused the
  // same way until a command-level network deny exists for network-granted tasks.

  const effectScript = [
    'const receipt = {',
    'schema: "dharma.external-effect-receipt/v1",',
    'actionDigest: process.env.DHARMA_ACTION_DIGEST,',
    'externalIdempotencyKey: process.env.DHARMA_EXTERNAL_IDEMPOTENCY_KEY,',
    'status: "committed", providerReference: "remote-change-42",',
    `proofDigest: "sha256:${'d'.repeat(64)}", observedAt: new Date().toISOString() };`,
    'process.stdout.write(JSON.stringify(receipt));',
  ].join('');
  const receiptPolicy = {
    ...networkPolicy,
    tasks: {
      ...networkPolicy.tasks,
      allowedCommands: {
        ...networkPolicy.tasks.allowedCommands,
        effect_receipt: { argv: [process.execPath, '-e', effectScript], timeoutSeconds: 5 },
      },
    },
  };
  const receiptBase = {
    ...networkBase,
    taskId: randomUUID(), target: { ...networkBase.target, endpointId: randomUUID() },
    authority: { ...networkBase.authority, commands: [...networkBase.authority.commands, { commandId: 'effect_receipt' }] },
    acceptance: {
      commands: [...networkBase.acceptance.commands, { commandId: 'effect_receipt' }],
      requiredArtifacts: [], externalEffectReceiptCommandId: 'effect_receipt',
    },
    createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString(), nonce: randomUUID(),
  };
  const receiptDecision = embedDecision(receiptBase, 'release', decisionKeys.privateKey, new Date());
  const receiptUnsigned = { ...receiptBase, actionDecision: receiptDecision };
  const receiptTask = { ...receiptUnsigned, signature: signCanonicalObject(receiptUnsigned, taskKeys.privateKey) } as TaskEnvelope;
  let effectExecutions = 0;
  await assert.rejects(executeTask({ registeredCommandSandbox: STAND_IN_SANDBOX,
    task: receiptTask, policy: receiptPolicy, workspace,
    relayStateDirectory: resolve(root, 'effect-state'), serverPublicKey: taskKeys.publicKey,
    receiptStore: new FileTaskReceiptStore(resolve(root, 'effect-receipts')),
    actionDecisions: { resolvePublicKey: () => decisionKeys.publicKey },
    providerExecutor: async () => {
      effectExecutions += 1;
      return {
        provider: 'codex', exitCode: 0, signal: null, timedOut: false,
        stdout: 'provider requested the remote change', stderr: '',
        stdoutSha256: `sha256:${'3'.repeat(64)}`, stderrSha256: `sha256:${'0'.repeat(64)}`,
      };
    },
  }), (error: unknown) => error instanceof taskRunner.RegisteredCommandsRefusedError && error.reason === 'network_not_denied');
  assert.equal(effectExecutions, 0);
});

test('one-use receipt replay guard rejects a second consumption atomically', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'dharma-action-replay-'));
  const guard = new FileActionDecisionReplayGuard(root);
  const decisionId = '44444444-4444-4444-8444-444444444444';
  const actionDigest = `sha256:${'a'.repeat(64)}`;
  const consumed = await Promise.all([guard.consume(decisionId, actionDigest), guard.consume(decisionId, actionDigest)]);
  assert.deepEqual(consumed.sort(), [false, true]);
});

test('a crashed external-effect claim remains durable and cannot be claimed again', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'dharma-action-journal-crash-'));
  const journal = new FileActionExecutionJournal(root, 2_147_483_647);
  const taskId = randomUUID();
  const prepared = await journal.prepare({
    taskId,
    decisionId: randomUUID(),
    endpointId: randomUUID(),
    actionDigest: `sha256:${'a'.repeat(64)}`,
    externalIdempotencyKey: randomUUID(),
    worktree: '/tmp/dharma-worktree',
    branch: `dharma/task/${taskId}`,
  });
  const authorized = await journal.transition(taskId, ['prepared'], 'replay_authorized');
  await journal.claim(authorized, 60_000);

  const recovered = new FileActionExecutionJournal(root);
  const record = await recovered.get(taskId);
  const claim = await recovered.getClaim(taskId);
  assert.equal(record?.state, 'executing');
  assert.ok(claim);
  assert.equal(recovered.isClaimOwnerAlive(claim!), false);
  await assert.rejects(recovered.claim(record!, 60_000), /not authorized for claiming/);
});

test('external-effect claims expire despite PID reuse', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'dharma-action-journal-pid-reuse-'));
  let now = new Date('2026-08-17T20:00:00.000Z');
  const journal = new FileActionExecutionJournal(root, process.pid, () => now);
  const taskId = randomUUID();
  const prepared = await journal.prepare({
    taskId, decisionId: randomUUID(), endpointId: randomUUID(),
    actionDigest: `sha256:${'a'.repeat(64)}`, externalIdempotencyKey: randomUUID(),
    worktree: '/tmp/dharma-worktree', branch: `dharma/task/${taskId}`,
  });
  const authorized = await journal.transition(taskId, ['prepared'], 'replay_authorized');
  const claim = await journal.claim(authorized, 60_000);
  assert.equal(journal.isClaimOwnerAlive(claim), true);
  now = new Date(now.getTime() + 60_001);
  assert.equal(journal.isClaimOwnerAlive(claim), false);
});

test('durable stores reject malformed or decision-conflicting receipts', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'dharma-action-journal-validation-'));
  const receiptStore = new FileTaskReceiptStore(resolve(root, 'receipts'));
  const taskId = randomUUID();
  await mkdir(resolve(root, 'receipts'), { recursive: true });
  await writeFile(resolve(root, 'receipts', `${taskId}.json`), JSON.stringify({ taskId, status: 'completed' }));
  await assert.rejects(receiptStore.get(taskId), /Task receipt is invalid/);

  await writeFile(resolve(root, 'receipts', `${taskId}.json`), JSON.stringify({
    taskId, status: 'completed', worktree: '/tmp/dharma-worktree', branch: `dharma/task/${taskId}`,
    commandResults: [], startedAt: new Date(Date.now() - 1_000).toISOString(), completedAt: new Date().toISOString(),
    externalEffectReceipt: { schema: 'dharma.external-effect-receipt/v1', status: 'committed' },
  }));
  await assert.rejects(receiptStore.get(taskId), /External-effect receipt is invalid/);

  const journalRoot = resolve(root, 'journal');
  await mkdir(journalRoot, { recursive: true });
  await writeFile(resolve(journalRoot, `${taskId}.json`), JSON.stringify({
    schema: 'dharma.action-execution-journal/v1', taskId,
    decisionId: randomUUID(), endpointId: randomUUID(), actionDigest: `sha256:${'a'.repeat(64)}`,
    externalIdempotencyKey: randomUUID(), worktree: '/tmp/dharma-worktree',
    branch: `dharma/task/${taskId}`, state: 'receipt_recorded',
    preparedAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    receipt: { taskId, status: 'completed' },
  }));
  await assert.rejects(new FileActionExecutionJournal(journalRoot).get(taskId), /Task receipt is invalid/);
});

for (const outcome of ['block', 'escalate', 'withhold'] as const) {
test(`one embedded ${outcome} receipt contains the task without a protected effect`, async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'dharma-action-block-'));
  const workspace = resolve(root, 'workspace');
  await mkdir(workspace);
  const protectedPath = resolve(workspace, 'protected.txt');
  await writeFile(protectedPath, 'original protected content\n');
  assert.equal(spawnSync('git', ['init', '-q'], { cwd: workspace, windowsHide: true }).status, 0);
  assert.equal(spawnSync('git', ['config', 'user.email', 'test@dharma-ai.io'], { cwd: workspace, windowsHide: true }).status, 0);
  assert.equal(spawnSync('git', ['config', 'user.name', 'Dharma Test'], { cwd: workspace, windowsHide: true }).status, 0);
  assert.equal(spawnSync('git', ['commit', '--allow-empty', '-qm', 'initial'], { cwd: workspace, windowsHide: true }).status, 0);
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
  const actionDecision = embedDecision(baseTask, outcome, decisionKeys.privateKey, now);
  const unsigned = { ...baseTask, actionDecision };
  const task = { ...unsigned, signature: signCanonicalObject(unsigned, taskKeys.privateKey) } as TaskEnvelope;
  let executions = 0;
  const result = await executeTask({
    task, policy, workspace, relayStateDirectory: resolve(root, 'state'), serverPublicKey: taskKeys.publicKey,
    receiptStore: new FileTaskReceiptStore(resolve(root, 'receipts')),
    actionDecisions: { resolvePublicKey: () => decisionKeys.publicKey, now: () => now },
    providerExecutor: async () => {
      executions += 1;
      await writeFile(protectedPath, 'unauthorized effect\n');
      throw new Error('must not execute');
    },
  });
  assert.equal(result.status, 'failed');
  assert.equal(executions, 0);
  assert.equal(result.actionAcknowledgement?.disposition, 'contained');
  assert.equal(await readFile(protectedPath, 'utf8'), 'original protected content\n');
});
}

type AcceptanceEnvironmentInput = {
  source: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  cwd: string;
  command: { argv: string[]; timeoutSeconds: number; environment?: unknown };
  actionDecision?: { externalIdempotencyKey: string; actionDigest: string };
};

function acceptanceEnvironment(input: AcceptanceEnvironmentInput): Record<string, string> {
  const builder = Reflect.get(taskRunner, 'acceptanceCommandEnvironment') as
    ((value: AcceptanceEnvironmentInput) => Record<string, string>) | undefined;
  assert.equal(typeof builder, 'function', 'acceptance commands need an explicit environment builder');
  return builder!(input);
}

const ENVIRONMENT_PROBE = 'process.stdout.write(JSON.stringify(process.env))';
const RUNNER_OWNED_NAMES = ['DHARMA_TASK_WORKTREE', 'DHARMA_EXTERNAL_IDEMPOTENCY_KEY', 'DHARMA_ACTION_DIGEST'];
const SYNTHETIC_DIGEST = `sha256:${'c'.repeat(64)}`;

async function withParentEnvironment<T>(values: Record<string, string>, run: () => Promise<T>): Promise<T> {
  const previous = new Map(Object.keys(values).map((name) => [name, process.env[name]]));
  Object.assign(process.env, values);
  try {
    return await run();
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

function environmentValue(environment: NodeJS.ProcessEnv, name: string): string | undefined {
  if (process.platform !== 'win32') return environment[name];
  const key = Object.keys(environment).find((candidate) => candidate.toUpperCase() === name.toUpperCase());
  return key === undefined ? undefined : environment[key];
}

function probeCommand(inherit?: string[]) {
  return {
    argv: [process.execPath, '-e', ENVIRONMENT_PROBE], timeoutSeconds: 10,
    ...(inherit ? { ...{ environment: { inherit } } } : {}),
  };
}

test('acceptance commands run with an explicit environment instead of the relay process environment', async (t) => {
  const fixture = await requiredArtifactFixture(t, []);
  fixture.policy.tasks.allowedCommands.permitted = probeCommand(['ACCEPTANCE_PERMITTED_INPUT']);
  fixture.policy.tasks.allowedCommands.plain = probeCommand();
  for (const commandId of ['permitted', 'plain']) {
    fixture.unsigned.authority.commands.push({ commandId });
    fixture.unsigned.acceptance.commands.push({ commandId });
  }
  let worktree = '';
  const receipt = await withParentEnvironment({
    ACCEPTANCE_PARENT_SENTINEL: 'synthetic-parent-sentinel',
    SYNTHETIC_SERVICE_TOKEN: 'synthetic-token-value',
    ACCEPTANCE_PERMITTED_INPUT: 'synthetic-permitted-value',
    DHARMA_TASK_WORKTREE: 'synthetic-forged-worktree',
    DHARMA_EXTERNAL_IDEMPOTENCY_KEY: 'synthetic-forged-key',
    DHARMA_ACTION_DIGEST: 'synthetic-forged-digest',
  }, () => executeTask({ ...fixture.input, task: fixture.signed(),
    providerExecutor: async ({ workspace }) => { worktree = workspace; return fixture.providerResult; } }));
  assert.equal(receipt.status, 'completed', receipt.commandResults.at(-1)?.stderr);
  const permitted = JSON.parse(receipt.commandResults[1]!.stdout) as Record<string, string>;
  const plain = JSON.parse(receipt.commandResults[2]!.stdout) as Record<string, string>;
  for (const environment of [permitted, plain]) {
    assert.equal(environmentValue(environment, 'ACCEPTANCE_PARENT_SENTINEL'), undefined);
    assert.equal(environmentValue(environment, 'SYNTHETIC_SERVICE_TOKEN'), undefined);
    assert.deepEqual(Object.keys(environment).filter((name) => /^npm_/i.test(name)), []);
    assert.equal(environmentValue(environment, 'DHARMA_TASK_WORKTREE'), worktree);
    assert.equal(environmentValue(environment, 'DHARMA_EXTERNAL_IDEMPOTENCY_KEY'), undefined);
    assert.equal(environmentValue(environment, 'DHARMA_ACTION_DIGEST'), undefined);
    const essentials = process.platform === 'win32'
      ? ['PATH', 'PATHEXT', 'SystemRoot', 'ComSpec', 'TEMP', 'USERPROFILE']
      : ['PATH', 'LANG'];
    for (const name of essentials) {
      assert.equal(environmentValue(environment, name), environmentValue(process.env, name), name);
    }
    // Inside the sandbox the home and temporary folders are the sandbox's own, empty ones.
    assert.equal(environmentValue(environment, 'HOME'), SANDBOX_HOME);
    assert.equal(environmentValue(environment, 'TMPDIR'), '/tmp');
  }
  assert.equal(environmentValue(permitted, 'ACCEPTANCE_PERMITTED_INPUT'), 'synthetic-permitted-value');
  assert.equal(environmentValue(plain, 'ACCEPTANCE_PERMITTED_INPUT'), undefined);
});

test('relay Git checks after an acceptance command do not run a Git monitor hook the command configured', async (t) => {
  const fixture = await requiredArtifactFixture(t, []);
  const marker = resolve(fixture.root, 'monitor-hook-ran.json');
  const hook = resolve(fixture.root, 'monitor-hook.cjs');
  await writeFile(hook, [
    'require("node:fs").writeFileSync(',
    `  ${JSON.stringify(marker)},`,
    '  JSON.stringify({ sentinel: process.env.ACCEPTANCE_PARENT_SENTINEL ?? null }));',
    'process.exit(1);',
  ].join('\n'));
  const shellPath = (path: string) => `'${path.replace(/\\/g, '/')}'`;
  fixture.policy.tasks.allowedCommands.configure = {
    argv: ['git', 'config', 'core.fsmonitor', `${shellPath(process.execPath)} ${shellPath(hook)}`],
    timeoutSeconds: 10,
  };
  fixture.unsigned.authority.commands.push({ commandId: 'configure' });
  fixture.unsigned.acceptance.commands.push({ commandId: 'configure' });
  const receipt = await withParentEnvironment({ ACCEPTANCE_PARENT_SENTINEL: 'synthetic-parent-sentinel' },
    () => executeTask({ ...fixture.input, task: fixture.signed(), providerExecutor: async () => fixture.providerResult }));
  assert.equal(receipt.commandResults[1]?.exitCode, 0, receipt.commandResults[1]?.stderr);
  const hookOutput = await readFile(marker, 'utf8').catch(() => undefined);
  assert.equal(hookOutput, undefined, 'relay Git ran the monitor hook');
  // The stand-in runs the command on the host, so it can change the repository configuration;
  // relay Git then fails the task closed instead of reading it.
  assert.equal(receipt.status, 'failed');
  assert.match(receipt.commandResults.at(-1)?.stderr || '', /relay_git_isolation_failed/);
});

test('acceptance command policy cannot inherit runner-owned environment names', async (t) => {
  for (const name of [...RUNNER_OWNED_NAMES, 'dharma_action_digest']) {
    await t.test(name, async (child) => {
      const fixture = await requiredArtifactFixture(child, []);
      fixture.policy.tasks.allowedCommands.probe = probeCommand([name]);
      fixture.unsigned.authority.commands.push({ commandId: 'probe' });
      fixture.unsigned.acceptance.commands.push({ commandId: 'probe' });
      let providerCalls = 0;
      const receipt = await withParentEnvironment({ [name]: 'synthetic-forged-value' }, () => executeTask({
        ...fixture.input, task: fixture.signed(),
        providerExecutor: async () => { providerCalls += 1; return fixture.providerResult; } }));
      assert.equal(receipt.status, 'failed');
      assert.equal(providerCalls, 0);
      assert.equal(receipt.commandResults.some(({ commandId }) => commandId === 'probe'), false);
      assert.match(receipt.commandResults.at(-1)?.stderr || '', /environment/);
    });
  }
});

test('signed tasks cannot carry their own acceptance-command environment', async (t) => {
  const fixture = await requiredArtifactFixture(t, []);
  fixture.policy.tasks.allowedCommands.probe = probeCommand();
  fixture.unsigned.authority.commands.push({ commandId: 'probe' });
  for (const acceptance of [
    { commands: [{ commandId: 'probe', environment: { DHARMA_TASK_WORKTREE: 'forged' } }], requiredArtifacts: [] },
    { commands: [{ commandId: 'probe' }], requiredArtifacts: [], environment: { DHARMA_ACTION_DIGEST: 'forged' } },
  ]) {
    const task = fixture.signed({ acceptance } as unknown as Partial<TaskEnvelope>);
    assert.throws(() => verifyTaskEnvelope(task, fixture.publicKey), /schema validation/);
    let providerCalls = 0;
    await assert.rejects(executeTask({ ...fixture.input, task,
      providerExecutor: async () => { providerCalls += 1; return fixture.providerResult; } }));
    assert.equal(providerCalls, 0);
  }
});

test('decision-bound acceptance variables come only from the verified decision receipt', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'dharma-acceptance-decision-'));
  try {
    const workspace = resolve(root, 'workspace');
    await mkdir(workspace);
    for (const argv of [['init', '-q'], ['config', 'user.email', 'test@dharma-ai.io'],
      ['config', 'user.name', 'Dharma Test'], ['commit', '--allow-empty', '-qm', 'initial']]) {
      assert.equal(spawnSync('git', argv, { cwd: workspace, windowsHide: true }).status, 0);
    }
    const policy: OrganizationPolicy = {
      schema: 'dharma.organization-policy/v1', organizationId: 'org_test', revision: '1',
      evidence: { defaultMode: 'deep', registeredWorkspaceOnly: true, excludePaths: [], maximumCapsuleBytes: 1,
        maximumDailyUploadBytes: 1, maximumExpansionBytes: 1 },
      tasks: { defaultNetwork: 'deny', defaultGit: 'task_branch', allowedCommands: { probe: probeCommand() },
        writePaths: [], requireLocalConfirmationFor: [] },
      skills: { automaticInstall: true, automaticPromotionMaxRisk: 'R2', canaryPercent: 10 }, retention: {}, budgets: {},
    };
    const taskKeys = generateKeyPairSync('ed25519');
    const decisionKeys = generateKeyPairSync('ed25519');
    const now = new Date();
    const baseTask = {
      schema: 'dharma.task/v1' as const, taskId: randomUUID(), organizationId: 'org_test', workspaceId: 'workspace',
      taskType: 'external_request' as const,
      target: { deviceId: 'device', endpointId: randomUUID(), provider: 'codex' as const },
      requiredCapabilities: ['action_decision_receipts_v1'] as const,
      skillBundle: null, instructions: 'Inspect the repository.', requiredSkills: [],
      authority: { readPaths: ['.'], writePaths: [], commands: [{ commandId: 'probe' }], network: 'deny', git: 'task_branch' as const },
      execution: { isolation: 'git_worktree' as const, timeoutSeconds: 120, leaseSeconds: 20, maximumConcurrentAgents: 1 },
      acceptance: { commands: [{ commandId: 'probe' }], requiredArtifacts: [] },
      budget: { mode: 'byok_local' as const, maximumDharmaCostCents: 0 },
      createdAt: now.toISOString(), expiresAt: new Date(now.getTime() + 60_000).toISOString(), nonce: randomUUID(),
    } satisfies Omit<TaskEnvelope, 'actionDecision' | 'signature'>;
    const actionDecision = embedDecision(baseTask, 'release', decisionKeys.privateKey, now);
    const unsigned = { ...baseTask, actionDecision };
    const task = { ...unsigned, signature: signCanonicalObject(unsigned, taskKeys.privateKey) } as TaskEnvelope;
    let providerInput: Parameters<ProviderTaskExecutor>[0] | undefined;
    const receipt = await withParentEnvironment({
      DHARMA_EXTERNAL_IDEMPOTENCY_KEY: 'synthetic-forged-key',
      DHARMA_ACTION_DIGEST: 'synthetic-forged-digest',
      DHARMA_TASK_WORKTREE: 'synthetic-forged-worktree',
    }, () => executeTask({ registeredCommandSandbox: STAND_IN_SANDBOX,
      task, policy, workspace, relayStateDirectory: resolve(root, 'state'), serverPublicKey: taskKeys.publicKey,
      receiptStore: new FileTaskReceiptStore(resolve(root, 'receipts')),
      actionDecisions: { resolvePublicKey: () => decisionKeys.publicKey },
      providerExecutor: async (input) => {
        providerInput = input;
        return { provider: 'codex', exitCode: 0, signal: null, timedOut: false, stdout: 'done', stderr: '',
          stdoutSha256: `sha256:${'1'.repeat(64)}`, stderrSha256: `sha256:${'0'.repeat(64)}` };
      },
    }));
    assert.equal(receipt.status, 'completed', receipt.commandResults.at(-1)?.stderr);
    assert.equal(providerInput?.externalIdempotencyKey, actionDecision.id);
    assert.equal(providerInput?.actionDigest, actionDecision.actionDigest);
    const environment = JSON.parse(receipt.commandResults[1]!.stdout) as Record<string, string>;
    assert.equal(environmentValue(environment, 'DHARMA_EXTERNAL_IDEMPOTENCY_KEY'), actionDecision.id);
    assert.equal(environmentValue(environment, 'DHARMA_ACTION_DIGEST'), actionDecision.actionDigest);
    assert.equal(environmentValue(environment, 'DHARMA_TASK_WORKTREE'), providerInput?.workspace);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('acceptance environment builder copies only POSIX essentials, permitted names and runner-owned values', () => {
  const source = {
    PATH: '/usr/local/bin:/usr/bin', HOME: '/home/customer', TMPDIR: '/tmp/customer', LANG: 'C.UTF-8',
    LANGUAGE: 'en', LC_ALL: 'C.UTF-8', LC_CTYPE: 'C.UTF-8', LC_MESSAGES: 'C', LC_COLLATE: 'C', LC_NUMERIC: 'C',
    LC_TIME: 'C', LC_MONETARY: 'C', TZ: 'UTC', USER: 'customer', LOGNAME: 'customer',
    XDG_CONFIG_HOME: '/home/customer/.config', XDG_CACHE_HOME: '/home/customer/.cache',
    HTTPS_PROXY: 'http://proxy.example.test:3128',
    XDG_RUNTIME_DIR: '/run/user/1000', DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus',
    SSH_AUTH_SOCK: '/tmp/agent.sock', GPG_AGENT_INFO: '/tmp/gpg', WSL_INTEROP: '/run/WSL/1_interop', WSLENV: 'X',
    DISPLAY: ':0', WAYLAND_DISPLAY: 'wayland-0', CODEX_HOME: '/home/customer/.codex',
    CLAUDE_CONFIG_DIR: '/home/customer/.claude', SHELL: '/bin/bash', TERM: 'xterm', INVOCATION_ID: 'synthetic',
    JOURNAL_STREAM: '8:1', MANAGERPID: '1', npm_config_userconfig: '/home/customer/.npmrc', npm_lifecycle_event: 'test',
    XPC_SERVICE_NAME: 'synthetic', XPC_FLAGS: '0x0', __CF_USER_TEXT_ENCODING: '0x1F5:0x0:0x0',
    DHARMA_HOME: '/home/customer/.dharma', DHARMA_ORG_API_TOKEN: 'synthetic-token', DHARMA_VAULT_KEY: 'synthetic-key',
    DHARMA_TASK_WORKTREE: '/forged', DHARMA_EXTERNAL_IDEMPOTENCY_KEY: 'forged-key', DHARMA_ACTION_DIGEST: 'forged-digest',
    ACCEPTANCE_PARENT_SENTINEL: 'synthetic-parent-sentinel', path: '/lowercase-is-a-different-name',
  };
  const essentials = {
    PATH: source.PATH, HOME: source.HOME, TMPDIR: source.TMPDIR, LANG: source.LANG, LANGUAGE: source.LANGUAGE,
    LC_ALL: source.LC_ALL, LC_CTYPE: source.LC_CTYPE, LC_MESSAGES: source.LC_MESSAGES, LC_COLLATE: source.LC_COLLATE,
    LC_NUMERIC: source.LC_NUMERIC, LC_TIME: source.LC_TIME, LC_MONETARY: source.LC_MONETARY, TZ: source.TZ,
    USER: source.USER, LOGNAME: source.LOGNAME, XDG_CONFIG_HOME: source.XDG_CONFIG_HOME,
    XDG_CACHE_HOME: source.XDG_CACHE_HOME,
  };
  for (const platform of ['linux', 'darwin'] as const) {
    assert.deepEqual(acceptanceEnvironment({ source, platform, cwd: '/work/tree', command: probeCommand() }),
      { ...essentials, DHARMA_TASK_WORKTREE: '/work/tree' }, platform);
    assert.deepEqual(acceptanceEnvironment({ source, platform, cwd: '/work/tree',
      command: probeCommand(['HTTPS_PROXY', 'NOT_PRESENT']),
      actionDecision: { externalIdempotencyKey: 'decision-id', actionDigest: SYNTHETIC_DIGEST } }), {
      ...essentials, HTTPS_PROXY: source.HTTPS_PROXY, DHARMA_TASK_WORKTREE: '/work/tree',
      DHARMA_EXTERNAL_IDEMPOTENCY_KEY: 'decision-id', DHARMA_ACTION_DIGEST: SYNTHETIC_DIGEST,
    }, platform);
  }
});

test('acceptance command environment policy is bounded and cannot name runner-owned variables', () => {
  const source = { HTTPS_PROXY: 'http://proxy.example.test:3128', NODE_EXTRA_CA_CERTS: '/etc/ssl/synthetic.pem' };
  const command = (environment: unknown) => ({ argv: [process.execPath], timeoutSeconds: 10, environment });
  assert.deepEqual(acceptanceEnvironment({ source, platform: 'linux', cwd: '/work',
    command: command({ inherit: ['HTTPS_PROXY', 'NODE_EXTRA_CA_CERTS'] }) }),
  { ...source, DHARMA_TASK_WORKTREE: '/work' });
  assert.deepEqual(acceptanceEnvironment({ source, platform: 'linux', cwd: '/work', command: command({ inherit: [] }) }),
    { DHARMA_TASK_WORKTREE: '/work' });
  const invalid: unknown[] = [
    { inherit: ['DHARMA_TASK_WORKTREE'] },
    { inherit: ['DHARMA_EXTERNAL_IDEMPOTENCY_KEY'] },
    { inherit: ['DHARMA_ACTION_DIGEST'] },
    { inherit: ['dharma_action_digest'] },
    { inherit: ['Dharma_Task_Worktree'] },
    { inherit: ['DHARMA_HOME'] },
    { inherit: ['1INVALID'] },
    { inherit: ['NAME=VALUE'] },
    { inherit: [''] },
    { inherit: ['A'.repeat(129)] },
    { inherit: ['HTTPS_PROXY', 'https_proxy'] },
    { inherit: Array.from({ length: 33 }, (_, index) => `NAME_${index}`) },
    { inherit: 'HTTPS_PROXY' },
    { inherit: [42] },
    { inherit: ['HTTPS_PROXY'], values: { HTTPS_PROXY: 'http://proxy.example.test' } },
    {},
    null,
    ['HTTPS_PROXY'],
  ];
  for (const environment of invalid) {
    for (const platform of ['linux', 'win32'] as const) {
      assert.throws(() => acceptanceEnvironment({ source, platform, cwd: '/work', command: command(environment) }),
        /environment/, `${platform} ${JSON.stringify(environment)}`);
    }
  }
});

test('acceptance environment builder handles Windows essentials and case-insensitive names', () => {
  const source = {
    Path: 'C:\\Windows\\system32;C:\\Program Files\\nodejs', PATHEXT: '.COM;.EXE;.BAT;.CMD',
    SystemRoot: 'C:\\Windows', windir: 'C:\\Windows', ComSpec: 'C:\\Windows\\system32\\cmd.exe', SystemDrive: 'C:',
    TEMP: 'C:\\Users\\customer\\AppData\\Local\\Temp', TMP: 'C:\\Users\\customer\\AppData\\Local\\Temp',
    USERPROFILE: 'C:\\Users\\customer', APPDATA: 'C:\\Users\\customer\\AppData\\Roaming',
    LOCALAPPDATA: 'C:\\Users\\customer\\AppData\\Local', ProgramFiles: 'C:\\Program Files',
    'ProgramFiles(x86)': 'C:\\Program Files (x86)', ProgramW6432: 'C:\\Program Files', ProgramData: 'C:\\ProgramData',
    CommonProgramFiles: 'C:\\Program Files\\Common Files', NUMBER_OF_PROCESSORS: '8', PROCESSOR_ARCHITECTURE: 'AMD64',
    OS: 'Windows_NT', https_proxy: 'http://proxy.example.test:3128',
    HOMEDRIVE: 'C:', HOMEPATH: '\\Users\\customer', USERNAME: 'customer', USERDOMAIN: 'DOMAIN',
    COMPUTERNAME: 'HOST', PSModulePath: 'C:\\modules', npm_config_cache: 'C:\\npm-cache',
    Dharma_Task_Worktree: 'C:\\forged', dharma_action_digest: 'forged-digest', DHARMA_ORG_API_TOKEN: 'synthetic-token',
    ACCEPTANCE_PARENT_SENTINEL: 'synthetic-parent-sentinel',
  };
  const { https_proxy: _proxy, HOMEDRIVE: _drive, HOMEPATH: _homePath, USERNAME: _user, USERDOMAIN: _domain,
    COMPUTERNAME: _computer, PSModulePath: _modules, npm_config_cache: _npm, Dharma_Task_Worktree: _worktree,
    dharma_action_digest: _digest, DHARMA_ORG_API_TOKEN: _token, ACCEPTANCE_PARENT_SENTINEL: _sentinel,
    ...essentials } = source;
  const environment = acceptanceEnvironment({ source, platform: 'win32', cwd: 'C:\\work\\tree',
    command: probeCommand(['HTTPS_PROXY']) });
  assert.deepEqual(environment, { ...essentials, https_proxy: source.https_proxy, DHARMA_TASK_WORKTREE: 'C:\\work\\tree' });
  assert.equal(Object.keys(environment).filter((name) => name.toUpperCase() === 'PATH').length, 1);
  assert.equal(Object.keys(environment).filter((name) => name.toUpperCase().startsWith('DHARMA_')).length, 1);
  assert.deepEqual(acceptanceEnvironment({ source: { PATH: 'C:\\Windows', SYSTEMROOT: 'C:\\Windows' }, platform: 'win32',
    cwd: 'C:\\work', command: probeCommand(),
    actionDecision: { externalIdempotencyKey: 'decision-id', actionDigest: SYNTHETIC_DIGEST } }), {
    PATH: 'C:\\Windows', SYSTEMROOT: 'C:\\Windows', DHARMA_TASK_WORKTREE: 'C:\\work',
    DHARMA_EXTERNAL_IDEMPOTENCY_KEY: 'decision-id', DHARMA_ACTION_DIGEST: SYNTHETIC_DIGEST,
  });
  for (const name of [...RUNNER_OWNED_NAMES, 'dharma_task_worktree', 'DHARMA_HOME']) {
    for (const platform of ['win32', 'linux'] as const) {
      assert.throws(() => acceptanceEnvironment({ source, platform, cwd: 'C:\\work', command: probeCommand([name]) }),
        /environment/, `${platform} ${name}`);
    }
  }
});

// Acceptance commands start only through the sandbox, and the relay Git checks that
// follow a sandboxed command use pinned repository paths.
type SpawnRecord = { command: string; argv: string[]; options: { cwd?: string; env?: Record<string, string>; stdio?: unknown; shell?: boolean; detached?: boolean }; pid?: number };
function recordSpawns(t: TestContext, replace?: (record: SpawnRecord) => ReturnType<typeof childProcess.spawn> | undefined) {
  const records: SpawnRecord[] = [];
  const current = childProcess.spawn;
  const patch = t.mock.method(childProcess, 'spawn', (command: string, argv: readonly string[], options: object) => {
    const record: SpawnRecord = { command, argv: [...argv], options: options as SpawnRecord['options'] };
    records.push(record);
    const child = replace?.(record) ?? current(command, argv, { ...options, windowsHide: true });
    if (child.pid !== undefined) record.pid = child.pid;
    return child;
  });
  syncBuiltinESMExports();
  t.after(() => { patch.mock.restore(); syncBuiltinESMExports(); });
  return records;
}

async function commandFixture(t: TestContext, script: string, options: { timeoutSeconds?: number } = {}) {
  const fixture = await requiredArtifactFixture(t, []);
  fixture.policy.tasks.allowedCommands.verify = { argv: [process.execPath, '-e', script], timeoutSeconds: options.timeoutSeconds ?? 10 };
  fixture.unsigned.authority.commands.push({ commandId: 'verify' });
  fixture.unsigned.acceptance.commands.push({ commandId: 'verify' });
  return fixture;
}

test('acceptance commands start bubblewrap with the built argument list, the sandbox environment and a status descriptor', async (t) => {
  const fixture = await commandFixture(t, 'process.stdout.write("inside")');
  const spawns = recordSpawns(t);
  let worktree = '';
  const receipt = await withParentEnvironment({ ACCEPTANCE_PARENT_SENTINEL: 'synthetic-parent-sentinel' },
    () => executeTask({ ...fixture.input, task: fixture.signed(),
      providerExecutor: async ({ workspace }) => { worktree = workspace; return fixture.providerResult; } }));
  assert.equal(receipt.status, 'completed', receipt.commandResults.at(-1)?.stderr);
  assert.equal(receipt.commandResults[1]?.stdout, 'inside');
  const sandboxed = spawns.filter(({ command }) => command === STAND_IN_SANDBOX.bwrapPath);
  assert.equal(sandboxed.length, 1);
  const [record] = sandboxed;
  assert.deepEqual(record!.argv, sandboxCommandLine(STAND_IN_SANDBOX, { worktree, cwd: worktree,
    argv: [process.execPath, '-e', 'process.stdout.write("inside")'] }));
  assert.deepEqual(record!.options.stdio, ['ignore', 'pipe', 'pipe', 'pipe']);
  assert.equal(record!.options.shell, false);
  assert.equal(record!.options.cwd, worktree);
  assert.equal(record!.options.env?.HOME, SANDBOX_HOME);
  assert.equal(record!.options.env?.TMPDIR, '/tmp');
  assert.equal(record!.options.env?.DHARMA_TASK_WORKTREE, worktree);
  assert.equal(Object.hasOwn(record!.options.env ?? {}, 'ACCEPTANCE_PARENT_SENTINEL'), false);
  assert.equal(spawns.filter(({ command, argv }) => command === process.execPath
    && argv[1] === 'process.stdout.write("inside")').length, 0, 'the command never starts directly');
});

test('the provider gets no command tools when the task names registered commands', async (t) => {
  const fixture = await commandFixture(t, 'process.exit(0)');
  const seen: string[][][] = [];
  const receipt = await executeTask({ ...fixture.input, task: fixture.signed(),
    providerExecutor: async (input) => { seen.push(input.allowedCommandArgv); return fixture.providerResult; } });
  assert.equal(receipt.status, 'completed', receipt.commandResults.at(-1)?.stderr);
  assert.deepEqual(seen, [[]]);
});

test('a sandbox that never reports its child fails the task once and never runs the command on the host', async (t) => {
  const fixture = await commandFixture(t, 'process.exit(0)');
  const marker = resolve(fixture.root, 'host-run');
  fixture.policy.tasks.allowedCommands.verify = { argv: [process.execPath, '-e',
    `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "ran")`], timeoutSeconds: 10 };
  const spawns = recordSpawns(t, ({ command, options }) => command === STAND_IN_SANDBOX.bwrapPath
    ? hostSpawn(process.execPath, ['-e', 'process.stderr.write("bwrap: setting up uid map: Permission denied\\n"); process.exit(1)'], { ...(options as childProcess.SpawnOptions), windowsHide: true })
    : undefined);
  const receipt = await executeTask({ ...fixture.input, task: fixture.signed(), providerExecutor: async () => fixture.providerResult });
  assert.equal(receipt.status, 'failed');
  const last = receipt.commandResults.at(-1)!;
  assert.equal(last.commandId, 'runner');
  assert.match(last.stderr, /registered_command_sandbox_failed/);
  assert.equal(spawns.filter(({ command }) => command === STAND_IN_SANDBOX.bwrapPath).length, 1);
  assert.equal(await readFile(marker, 'utf8').catch(() => undefined), undefined);
});

test('a timed-out sandboxed command kills the bubblewrap process group', { skip: process.platform === 'win32' }, async (t) => {
  const fixture = await commandFixture(t, 'setInterval(() => {}, 1000)', { timeoutSeconds: 1 });
  const spawns = recordSpawns(t);
  const kills: Array<[number, string | number | undefined]> = [];
  const originalKill = process.kill.bind(process);
  t.mock.method(process, 'kill', (pid: number, signal?: string | number) => { kills.push([pid, signal]); return originalKill(pid, signal); });
  const receipt = await executeTask({ ...fixture.input, task: fixture.signed(), providerExecutor: async () => fixture.providerResult });
  const result = receipt.commandResults.find(({ commandId }) => commandId === 'verify');
  assert.equal(result?.timedOut, true);
  assert.equal(receipt.status, 'failed');
  const sandboxPid = spawns.find(({ command }) => command === STAND_IN_SANDBOX.bwrapPath)?.pid;
  assert.ok(sandboxPid);
  assert.ok(kills.some(([pid, signal]) => pid === -sandboxPid! && signal === 'SIGKILL'), 'the bubblewrap process group is killed');
});

test('relay Git after a sandboxed command uses the pinned repository paths and no diff drivers', async (t) => {
  const fixture = await commandFixture(t, 'process.exit(0)');
  const spawns = recordSpawns(t);
  let worktree = '';
  const receipt = await executeTask({ ...fixture.input, task: fixture.signed(),
    providerExecutor: async ({ workspace }) => { worktree = workspace; return fixture.providerResult; } });
  assert.equal(receipt.status, 'completed', receipt.commandResults.at(-1)?.stderr);
  const sandboxIndex = spawns.findIndex(({ command }) => command === STAND_IN_SANDBOX.bwrapPath);
  const before = spawns.slice(0, sandboxIndex).filter(({ command }) => command === 'git');
  const after = spawns.slice(sandboxIndex + 1).filter(({ command }) => command === 'git');
  assert.ok(before.length > 0 && after.length >= 2);
  const pointer = await readFile(resolve(worktree, '.git'), 'utf8');
  const gitDir = resolve(worktree, pointer.replace(/^gitdir:\s*/, '').trim());
  // Every call after `git worktree add` uses the pinned paths, including the provider-phase checks.
  for (const { argv } of [...before, ...after].filter(({ argv }) => PINNED_SUBCOMMANDS.has(gitSubcommand(argv)!))) {
    assert.ok(argv.includes(`--git-dir=${gitDir}`), argv.join(' '));
    assert.ok(argv.includes(`--work-tree=${worktree}`), argv.join(' '));
    if (argv.includes('diff')) assert.ok(argv.includes('--no-ext-diff') && argv.includes('--no-textconv'), argv.join(' '));
  }
});

test('a changed worktree Git pointer after a sandboxed command fails the task', async (t) => {
  // The stand-in runs the command on the host, so it can change the pointer; the real sandbox
  // mounts the pointer read-only (registeredCommandSandbox.linux.test.ts).
  const fixture = await commandFixture(t, 'require("node:fs").appendFileSync(".git", "\\n")');
  const receipt = await executeTask({ ...fixture.input, task: fixture.signed(), providerExecutor: async () => fixture.providerResult });
  assert.equal(receipt.status, 'failed');
  assert.match(receipt.commandResults.at(-1)?.stderr || '', /Git pointer changed/);
});

test('tasks without registered commands never start bubblewrap, and relay Git after the provider still uses the pinned paths', async (t) => {
  const fixture = await requiredArtifactFixture(t, []);
  const spawns = recordSpawns(t);
  let worktree = '';
  const receipt = await executeTask({ ...fixture.input, task: fixture.signed(),
    providerExecutor: async ({ workspace }) => { worktree = workspace; return fixture.providerResult; } });
  assert.equal(receipt.status, 'completed', receipt.commandResults.at(-1)?.stderr);
  assert.equal(spawns.some(({ command }) => command === STAND_IN_SANDBOX.bwrapPath), false);
  const checks = spawns.filter(({ command, argv }) => command === 'git' && ['diff', 'ls-files'].includes(gitSubcommand(argv)!));
  assert.ok(checks.length >= 2);
  for (const { argv } of checks) {
    assert.ok(argv.some(value => value.startsWith('--git-dir=')), argv.join(' '));
    assert.ok(argv.includes(`--work-tree=${worktree}`), argv.join(' '));
  }
});

// Slice 3: relay Git after the provider or a sandboxed command runs nothing the task could have
// influenced. It ignores system and global configuration, uses a relay-owned empty hooks folder,
// reads attributes from the starting commit, and checks the pinned repository files around each call.
// The value Git uses for `name`: the last `-c name=value` wins.
function configOverride(argv: readonly string[], name: string): string | undefined {
  let value: string | undefined;
  for (let index = 0; index < argv.length - 1; index++) {
    if (argv[index] === '-c' && argv[index + 1]!.startsWith(`${name}=`)) value = argv[index + 1]!.slice(name.length + 1);
  }
  return value;
}

function within(parent: string, candidate: string | undefined) {
  return candidate !== undefined && resolve(candidate).toLowerCase().startsWith(resolve(parent).toLowerCase());
}

async function commitFixtureFiles(workspace: string, files: Record<string, string>) {
  for (const [path, content] of Object.entries(files)) {
    await mkdir(resolve(workspace, path, '..'), { recursive: true });
    await writeFile(resolve(workspace, path), content);
  }
  assert.equal(spawnSync('git', ['add', '.'], { cwd: workspace, windowsHide: true }).status, 0);
  assert.equal(spawnSync('git', ['commit', '-qm', 'fixture files'], { cwd: workspace, windowsHide: true }).status, 0);
}

// A clean filter that the operator's repository configuration defines (as Git LFS does). It writes
// a canary outside the worktree when Git runs it.
async function configureCanaryFilter(fixture: { root: string; workspace: string }, name: string) {
  const canary = resolve(fixture.root, `filter-${name}-ran`);
  const script = resolve(fixture.root, `filter-${name}.cjs`);
  await writeFile(script, `require("node:fs").writeFileSync(${JSON.stringify(canary)}, "ran"); process.stdin.pipe(process.stdout);\n`);
  const shellPath = (path: string) => `'${path.replace(/\\/g, '/')}'`;
  assert.equal(spawnSync('git', ['config', `filter.${name}.clean`, `${shellPath(process.execPath)} ${shellPath(script)}`],
    { cwd: fixture.workspace, windowsHide: true }).status, 0);
  return canary;
}

test('relay Git ignores system and global configuration and uses relay-owned hooks, attributes and ignore paths', async (t) => {
  const fixture = await requiredArtifactFixture(t, []);
  const version = spawnSync('git', ['version'], { windowsHide: true, encoding: 'utf8' }).stdout.trim();
  process.stdout.write(`# relay git on ${process.platform}: ${version}\n`);
  const startingCommit = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: fixture.workspace, windowsHide: true, encoding: 'utf8' }).stdout.trim();
  const spawns = recordSpawns(t);
  let worktree = '';
  const receipt = await executeTask({ ...fixture.input, task: fixture.signed(),
    providerExecutor: async ({ workspace }) => { worktree = workspace; return fixture.providerResult; } });
  assert.equal(receipt.status, 'completed', receipt.commandResults.at(-1)?.stderr);
  const state = fixture.input.relayStateDirectory;
  const calls = spawns.filter(({ command }) => command === 'git');
  // The checkout before the task and the reads of the operator's checkout settings use the
  // operator's Git configuration, so the task worktree matches the operator's checkout. No task
  // code has run yet; they still use the relay-owned hooks folder and no file-system monitor.
  const operatorCalls = calls.filter(({ argv }) => ['worktree', 'config'].includes(gitSubcommand(argv)!));
  assert.ok(operatorCalls.some(({ argv }) => gitSubcommand(argv) === 'worktree'));
  for (const { argv, options } of operatorCalls) {
    const label = argv.join(' ');
    const env = options.env ?? {};
    assert.equal(env.GIT_CONFIG_NOSYSTEM, undefined, label);
    assert.equal(env.GIT_CONFIG_GLOBAL, undefined, label);
    const hooks = configOverride(argv, 'core.hooksPath');
    assert.ok(within(state, hooks) && !within(worktree, hooks), `hooks path is relay-owned: ${label}`);
    assert.equal(configOverride(argv, 'core.fsmonitor'), 'false', label);
  }
  const isolated = calls.filter(call => !operatorCalls.includes(call));
  assert.ok(isolated.length >= 4);
  for (const { argv, options } of isolated) {
    const label = argv.join(' ');
    const env = options.env ?? {};
    assert.equal(env.GIT_CONFIG_NOSYSTEM, '1', label);
    assert.ok(within(state, env.GIT_CONFIG_GLOBAL), `global configuration is relay-owned: ${label}`);
    assert.equal(await readFile(env.GIT_CONFIG_GLOBAL!, 'utf8'), '', 'the relay-owned global configuration is empty');
    for (const name of ['HOME', 'XDG_CONFIG_HOME']) {
      assert.ok(within(state, env[name]), `${name} is relay-owned: ${label}`);
      assert.notEqual(env[name], process.env[name], name);
    }
    const hooks = configOverride(argv, 'core.hooksPath');
    assert.ok(within(state, hooks) && !within(worktree, hooks), `hooks path is relay-owned: ${label}`);
    assert.equal(configOverride(argv, 'core.fsmonitor'), 'false', label);
    assert.equal(configOverride(argv, 'core.untrackedCache'), 'false', label);
    assert.equal(configOverride(argv, 'core.attributesFile'), env.GIT_CONFIG_GLOBAL, label);
    // The operator's global exclude file, resolved before the task; never a worktree path.
    const excludes = configOverride(argv, 'core.excludesFile');
    assert.ok(excludes !== undefined && !within(worktree, excludes), `exclude file is not in the worktree: ${label}`);
  }
  const checks = isolated.filter(({ argv }) => ['diff', 'ls-files'].includes(gitSubcommand(argv)!));
  assert.ok(checks.length >= 2);
  for (const { argv } of checks) {
    assert.equal(argv.includes(`--attr-source=${startingCommit}`), HOST_GIT_READS_ATTRIBUTE_SOURCE, argv.join(' '));
  }
});

test('relay Git checks the worktree Git pointer again after each call', async (t) => {
  const fixture = await requiredArtifactFixture(t, []);
  let worktree = '';
  let swapped = false;
  recordSpawns(t, ({ command, argv }) => {
    // Stands in for a race: the pointer changes while a relay Git call runs.
    if (command === 'git' && gitSubcommand(argv) === 'diff' && worktree && !swapped) {
      swapped = true;
      // Git marks the pointer hidden on Windows, where only an append can open it for writing.
      appendFileSync(resolve(worktree, '.git'), '\n');
    }
    return undefined;
  });
  const receipt = await executeTask({ ...fixture.input, task: fixture.signed(),
    providerExecutor: async ({ workspace }) => { worktree = workspace; return fixture.providerResult; } });
  assert.equal(swapped, true);
  assert.equal(receipt.status, 'failed');
  assert.match(receipt.commandResults.at(-1)?.stderr || '', /relay_git_isolation_failed.*Git pointer changed/);
});

test('a provider that changes repository configuration or Git-directory attributes fails the task closed', async (t) => {
  const changes: Record<string, (workspace: string, worktree: string) => Promise<void>> = {
    configuration: async (_workspace, worktree) => {
      assert.equal(spawnSync('git', ['config', 'core.pager', 'cat'], { cwd: worktree, windowsHide: true }).status, 0);
    },
    'info/attributes': async (workspace) => {
      await mkdir(resolve(workspace, '.git', 'info'), { recursive: true });
      await writeFile(resolve(workspace, '.git', 'info', 'attributes'), '* filter=x\n');
    },
    'info/exclude': async (workspace) => {
      await mkdir(resolve(workspace, '.git', 'info'), { recursive: true });
      await writeFile(resolve(workspace, '.git', 'info', 'exclude'), '*\n');
    },
  };
  for (const [name, change] of Object.entries(changes)) {
    await t.test(name, async (child) => {
      const fixture = await requiredArtifactFixture(child, []);
      const receipt = await executeTask({ ...fixture.input, task: fixture.signed(),
        providerExecutor: async ({ workspace }) => { await change(fixture.workspace, workspace); return fixture.providerResult; } });
      assert.equal(receipt.status, 'failed');
      assert.match(receipt.commandResults.at(-1)?.stderr || '', /relay_git_isolation_failed/);
    });
  }
});

test('relay Git reads attributes from the starting commit, so a task-written .gitattributes starts no filter', async (t) => {
  const fixture = await requiredArtifactFixture(t, []);
  await commitFixtureFiles(fixture.workspace, { 'reports/tracked.txt': 'original\n' });
  const canary = await configureCanaryFilter(fixture, 'x');
  const receipt = await executeTask({ ...fixture.input, task: fixture.signed(),
    providerExecutor: async ({ workspace }) => {
      await writeFile(resolve(workspace, 'reports', '.gitattributes'), '* filter=x\n');
      await writeFile(resolve(workspace, 'reports', 'tracked.txt'), 'changed by the task\n');
      return fixture.providerResult;
    } });
  assert.equal(await readFile(canary, 'utf8').catch(() => undefined), undefined, 'relay Git ran the filter');
  if (HOST_GIT_READS_ATTRIBUTE_SOURCE) {
    assert.equal(receipt.status, 'completed', receipt.commandResults.at(-1)?.stderr);
  } else {
    // An older host Git cannot read attributes from the starting commit, so the relay refuses the task.
    assert.equal(receipt.status, 'failed');
    assert.match(receipt.commandResults.at(-1)?.stderr || '', /relay_git_isolation_failed.*\.gitattributes/);
  }
});

test('a Git without attribute-source support refuses a task-written .gitattributes and keeps other tasks working', async (t) => {
  // The starting commit has a tracked root .gitattributes, which the relay records and compares.
  const cases = { 'attributes written': 'new', 'attributes unchanged': 'none', 'tracked attributes changed': 'tracked' } as const;
  for (const [name, change] of Object.entries(cases)) {
    const writesAttributes = change !== 'none';
    await t.test(name, async (child) => {
      const fixture = await requiredArtifactFixture(child, []);
      await commitFixtureFiles(fixture.workspace, { 'reports/tracked.txt': 'original\n', '.gitattributes': '*.txt text\n' });
      const canary = await configureCanaryFilter(fixture, 'x');
      let versionChecks = 0;
      const spawns = recordSpawns(child, ({ command, argv, options }) => {
        if (command !== 'git' || gitSubcommand(argv) !== 'version') return undefined;
        versionChecks++;
        return hostSpawn(process.execPath, ['-e', 'process.stdout.write("git version 2.39.5\\n")'],
          { ...(options as childProcess.SpawnOptions), windowsHide: true });
      });
      const receipt = await executeTask({ ...fixture.input, task: fixture.signed(),
        providerExecutor: async ({ workspace }) => {
          if (change === 'new') await writeFile(resolve(workspace, 'reports', '.gitattributes'), '* filter=x\n');
          if (change === 'tracked') appendFileSync(resolve(workspace, '.gitattributes'), '* filter=x\n');
          await writeFile(resolve(workspace, 'reports', 'tracked.txt'), 'changed by the task\n');
          return fixture.providerResult;
        } });
      assert.ok(versionChecks >= 1, 'the relay checks the Git version');
      assert.equal(spawns.some(({ argv }) => argv.some(value => value.startsWith('--attr-source='))), false);
      assert.equal(await readFile(canary, 'utf8').catch(() => undefined), undefined, 'relay Git ran the filter');
      if (writesAttributes) {
        assert.equal(receipt.status, 'failed');
        assert.match(receipt.commandResults.at(-1)?.stderr || '', /relay_git_isolation_failed.*\.gitattributes/);
      } else {
        assert.equal(receipt.status, 'completed', receipt.commandResults.at(-1)?.stderr);
      }
    });
  }
});

// The operator's own Git configuration, found through HOME (USERPROFILE on Windows) and
// XDG_CONFIG_HOME, which the relay passes to the checkout before the task.
async function operatorGitHome(root: string, gitconfig: string, files: Record<string, string> = {}) {
  const home = resolve(root, 'operator-home');
  await mkdir(resolve(home, '.config', 'git'), { recursive: true });
  await writeFile(resolve(home, '.gitconfig'), gitconfig);
  for (const [path, content] of Object.entries(files)) await writeFile(resolve(home, path), content);
  return { HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: resolve(home, '.config') };
}

const portablePath = (path: string) => path.replace(/\\/g, '/');

test('relay Git runs from a relay-owned folder, so a git program the task wrote into the worktree never runs', async (t) => {
  const fixture = await requiredArtifactFixture(t, []);
  const spawns = recordSpawns(t);
  const receipt = await executeTask({ ...fixture.input, task: fixture.signed(),
    providerExecutor: async ({ workspace }) => {
      // Windows looks up a bare program name in the working folder before PATH.
      if (process.platform === 'win32') await copyFile(process.execPath, resolve(workspace, 'git.exe'));
      return fixture.providerResult;
    } });
  const calls = spawns.filter(({ command }) => command === 'git');
  assert.ok(calls.length >= 5);
  const relayGitFolder = resolve(fixture.input.relayStateDirectory, 'relay-git');
  for (const { argv, options } of calls) assert.ok(within(relayGitFolder, options.cwd), `${options.cwd}: ${argv.join(' ')}`);
  if (process.platform === 'win32') {
    // Real Git ran and reported the planted program as a write outside the signed write paths.
    assert.equal(receipt.status, 'failed');
    assert.match(receipt.commandResults.at(-1)?.stderr || '', /outside the signed task authority/);
  } else {
    assert.equal(receipt.status, 'completed', receipt.commandResults.at(-1)?.stderr);
  }
});

test('relay Git does not look inside a submodule folder that the task turned into a repository', async (t) => {
  const fixture = await requiredArtifactFixture(t, []);
  const run = (cwd: string, argv: string[]) =>
    assert.equal(spawnSync('git', argv, { cwd, windowsHide: true }).status, 0, argv.join(' '));
  const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: fixture.workspace, windowsHide: true, encoding: 'utf8' }).stdout.trim();
  // The starting commit has a submodule; `git worktree add` leaves its folder empty.
  run(fixture.workspace, ['update-index', '--add', '--cacheinfo', `160000,${head},sub`]);
  run(fixture.workspace, ['commit', '-qm', 'submodule']);
  const spawns = recordSpawns(t);
  let canary = '';
  const receipt = await executeTask({ ...fixture.input, task: fixture.signed(),
    providerExecutor: async ({ workspace }) => {
      // The task makes the folder a repository with an unborn HEAD, a filter driver assigned to
      // every path, and an index entry whose content Git has to read again.
      const sub = resolve(workspace, 'sub');
      await mkdir(sub, { recursive: true });
      run(sub, ['init', '-q']);
      await writeFile(resolve(sub, 'a'), 'payload\n');
      run(sub, ['add', 'a']);
      canary = await configureCanaryFilter({ root: fixture.root, workspace: sub }, 'sub');
      await mkdir(resolve(sub, '.git', 'info'), { recursive: true });
      await writeFile(resolve(sub, '.git', 'info', 'attributes'), '* filter=sub\n');
      // Lets the starting commit that --attr-source names resolve inside the task-written repository.
      await mkdir(resolve(sub, '.git', 'objects', 'info'), { recursive: true });
      await writeFile(resolve(sub, '.git', 'objects', 'info', 'alternates'), `${portablePath(resolve(fixture.workspace, '.git', 'objects'))}\n`);
      const old = new Date('2001-01-01T00:00:00Z');
      await utimes(resolve(sub, 'a'), old, old);
      return fixture.providerResult;
    } });
  assert.equal(await readFile(canary, 'utf8').catch(() => undefined), undefined, 'relay Git ran a filter inside the submodule folder');
  assert.equal(receipt.status, 'completed', receipt.commandResults.at(-1)?.stderr);
  const diffs = spawns.filter(({ command, argv }) => command === 'git' && gitSubcommand(argv) === 'diff');
  assert.ok(diffs.length >= 1);
  for (const { argv } of diffs) {
    assert.ok(argv.includes('--ignore-submodules=dirty'), argv.join(' '));
    assert.equal(configOverride(argv, 'submodule.recurse'), 'false', argv.join(' '));
  }
});

test('the checkout before the task uses the operator Git configuration, and later relay Git uses the same checkout settings', async (t) => {
  const fixture = await requiredArtifactFixture(t, []);
  await commitFixtureFiles(fixture.workspace, { '.gitattributes': '*.txt text\n', 'reports/notes.txt': 'line\n' });
  const operator = await operatorGitHome(fixture.root, '[core]\n\tautocrlf = false\n\teol = crlf\n');
  const spawns = recordSpawns(t);
  let checkedOut = '';
  const receipt = await withParentEnvironment(operator, () => executeTask({ ...fixture.input, task: fixture.signed(),
    providerExecutor: async ({ workspace }) => {
      checkedOut = await readFile(resolve(workspace, 'reports', 'notes.txt'), 'utf8');
      return fixture.providerResult;
    } }));
  assert.equal(checkedOut, 'line\r\n', 'the task worktree uses the operator line endings');
  assert.equal(receipt.status, 'completed', receipt.commandResults.at(-1)?.stderr);
  const diffs = spawns.filter(({ command, argv }) => command === 'git' && gitSubcommand(argv) === 'diff');
  assert.ok(diffs.length >= 1);
  for (const { argv } of diffs) {
    assert.equal(configOverride(argv, 'core.eol'), 'crlf', argv.join(' '));
    assert.equal(configOverride(argv, 'core.autocrlf'), 'false', argv.join(' '));
  }
});

test('the checkout before the task honours the operator safe.directory setting', async (t) => {
  const fixture = await requiredArtifactFixture(t, []);
  const operator = await operatorGitHome(fixture.root, '[safe]\n\tdirectory = *\n');
  // Stands in for a repository that another account owns (for example on a network drive). Calls
  // with an explicit --git-dir skip the ownership check.
  recordSpawns(t, ({ command, argv, options }) => {
    if (command !== 'git' || argv.some(value => value.startsWith('--git-dir='))) return undefined;
    return hostSpawn(command, argv, { ...(options as childProcess.SpawnOptions),
      env: { ...options.env, GIT_TEST_ASSUME_DIFFERENT_OWNER: '1' }, windowsHide: true });
  });
  const receipt = await withParentEnvironment(operator, () => executeTask({ ...fixture.input, task: fixture.signed(),
    providerExecutor: async () => fixture.providerResult }));
  assert.equal(receipt.status, 'completed', receipt.commandResults.at(-1)?.stderr);
});

test('the write-scope check honours the operator global exclude file', async (t) => {
  for (const location of ['core.excludesFile', 'default location'] as const) {
    await t.test(location, async (child) => {
      const fixture = await requiredArtifactFixture(child, []);
      const ignoreFile = resolve(fixture.root, 'operator-ignore');
      await writeFile(ignoreFile, 'generated/\n');
      const operator = location === 'core.excludesFile'
        ? await operatorGitHome(fixture.root, `[core]\n\texcludesFile = ${portablePath(ignoreFile)}\n`)
        : await operatorGitHome(fixture.root, '', { '.config/git/ignore': 'generated/\n' });
      const receipt = await withParentEnvironment(operator, () => executeTask({ ...fixture.input, task: fixture.signed(),
        providerExecutor: async ({ workspace }) => {
          await mkdir(resolve(workspace, 'generated'), { recursive: true });
          await writeFile(resolve(workspace, 'generated', 'cache.bin'), 'build output');
          return fixture.providerResult;
        } }));
      assert.equal(receipt.status, 'completed', receipt.commandResults.at(-1)?.stderr);
    });
  }
});

test('ordinary writes to the enrolled repository configuration during a task do not fail it', async (t) => {
  const fixture = await requiredArtifactFixture(t, []);
  const receipt = await executeTask({ ...fixture.input, task: fixture.signed(),
    providerExecutor: async () => {
      // What `git push -u`, `git checkout -b x origin/x`, `git remote add` and Git LFS write in the main checkout.
      for (const argv of [['config', 'branch.feature.remote', 'origin'], ['config', 'branch.feature.merge', 'refs/heads/feature'],
        ['remote', 'add', 'upstream', 'https://example.invalid/fabric.git'],
        ['config', 'lfs.https://example.invalid/fabric.git/info/lfs.access', 'basic']]) {
        assert.equal(spawnSync('git', argv, { cwd: fixture.workspace, windowsHide: true }).status, 0, argv.join(' '));
      }
      return fixture.providerResult;
    } });
  assert.equal(receipt.status, 'completed', receipt.commandResults.at(-1)?.stderr);
});

test('a .gitignore the task writes cannot hide files outside the write paths from the write-scope check', async (t) => {
  const cases: Record<string, { tracked?: Record<string, string>; files: Record<string, string>; status: 'completed' | 'failed' }> = {
    'self-ignoring folder': { files: { 'docs/.gitignore': '*\n', 'docs/secret.txt': 'hidden' }, status: 'failed' },
    'root ignore file': { files: { '.gitignore': '*\n', 'notes.txt': 'hidden' }, status: 'failed' },
    'tool cache in a folder the starting rules ignore': { tracked: { '.gitignore': '.pytest_cache/\n' },
      files: { '.pytest_cache/.gitignore': '*\n', '.pytest_cache/v/lastfailed': '{}' }, status: 'completed' },
    'inside the write paths': { files: { 'reports/.gitignore': '*\n', 'reports/out.txt': 'result' }, status: 'completed' },
  };
  for (const [name, { tracked, files, status }] of Object.entries(cases)) {
    await t.test(name, async (child) => {
      const fixture = await requiredArtifactFixture(child, []);
      if (tracked) await commitFixtureFiles(fixture.workspace, tracked);
      const receipt = await executeTask({ ...fixture.input, task: fixture.signed(),
        providerExecutor: async ({ workspace }) => {
          for (const [path, content] of Object.entries(files)) {
            await mkdir(resolve(workspace, path, '..'), { recursive: true });
            await writeFile(resolve(workspace, path), content);
          }
          return fixture.providerResult;
        } });
      assert.equal(receipt.status, status, receipt.commandResults.at(-1)?.stderr);
      if (status === 'failed') assert.match(receipt.commandResults.at(-1)?.stderr || '', /relay_git_isolation_failed.*\.gitignore/);
    });
  }
});

test('commands run from the policy loaded before the provider; the workspace policy file is not read again', async (t) => {
  const fixture = await commandFixture(t, 'process.stdout.write("from loaded policy")');
  await mkdir(resolve(fixture.workspace, '.dharma'));
  await writeFile(resolve(fixture.workspace, '.dharma', 'approved-policy.json'), JSON.stringify({ tasks: { allowedCommands: {
    verify: { argv: [process.execPath, '-e', 'process.stdout.write("from workspace file")'], timeoutSeconds: 10 } } } }));
  const fsPromises = (await import('node:fs/promises')).default;
  const reads: string[] = [];
  const original = fsPromises.readFile;
  const patch = t.mock.method(fsPromises, 'readFile', (...args: Parameters<typeof original>) => {
    reads.push(String(args[0])); return original(...args);
  });
  syncBuiltinESMExports();
  t.after(() => { patch.mock.restore(); syncBuiltinESMExports(); });
  const receipt = await executeTask({ ...fixture.input, task: fixture.signed(), providerExecutor: async () => fixture.providerResult });
  assert.equal(receipt.commandResults[1]?.stdout, 'from loaded policy');
  assert.equal(reads.some(path => path.endsWith('approved-policy.json')), false);
});
