import assert from 'node:assert/strict';
import { mock, test, type TestContext } from 'node:test';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import childProcess, { spawnSync } from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import {
  actionDecisionDigest,
  signCanonicalObject,
  validateContract,
  type ActionDecisionEnvelope,
  type ActionDecisionReceipt,
} from '@dharma-ai-labs/agent-fabric-contracts';
import type { OrganizationPolicy } from '@dharma-ai-labs/agent-fabric-policy';
import {
  canonicalTaskActionForTask,
  executeTask,
  FileTaskReceiptStore,
  PROBE_CHECKS,
  SANDBOX_POLICY_VERSION,
  type TaskEnvelope,
  type TaskReceipt,
  type UsableSandbox,
} from './index.js';

// Every task receipt says which command sandbox the task was admitted with (receipt revision
// dharma.task-receipt/v2). A task that names registered commands records the probed sandbox:
// bubblewrap's absolute path, version and sha256, the sandbox policy, the host kind and the probe
// result. A task without registered commands records that no sandbox was used.
//
// As in index.test.ts, bubblewrap is replaced by a stand-in on every operating system: a Node
// wrapper that reports its child on descriptor 3 and runs the command on the host.
// registeredCommandSandbox.linux.test.ts checks the tuple against the real bubblewrap.

const RECEIPT_SCHEMA = 'https://schemas.dharma-ai.io/task-receipt/v2';
const SCHEMA_DIRECTORY = fileURLToPath(new URL('../../../schemas/', import.meta.url));
const PROBE = {
  checks: [...PROBE_CHECKS.base, ...PROBE_CHECKS.disableUserns],
  probedAt: '2026-11-28T00:00:00.000Z',
};
const STAND_IN_SANDBOX = {
  usable: true, host: 'linux', bwrapPath: '/usr/bin/bwrap', bwrapVersion: '0.9.0',
  bwrapSha256: `sha256:${'a'.repeat(64)}`, policy: SANDBOX_POLICY_VERSION,
  layout: { bin: 'symlink', sbin: 'symlink', lib: 'symlink', lib32: 'absent', lib64: 'symlink', libx32: 'absent' },
  nodePrefix: '/usr', bindNodePrefix: false, nodeMounts: [], disableUserns: true, probe: PROBE,
} as UsableSandbox;
const SANDBOXED = {
  state: 'sandboxed', host: 'linux', bwrapPath: '/usr/bin/bwrap', bwrapVersion: '0.9.0',
  bwrapSha256: `sha256:${'a'.repeat(64)}`, policy: SANDBOX_POLICY_VERSION,
  probe: { result: 'passed', checks: PROBE.checks, probedAt: PROBE.probedAt },
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
mock.method(childProcess, 'spawn', (command: string, argv: readonly string[], options: object) => {
  if (command !== STAND_IN_SANDBOX.bwrapPath) return hostSpawn(command, argv, { ...options, windowsHide: true });
  const separator = argv.indexOf('--');
  const cwd = argv[argv.indexOf('--chdir') + 1]!;
  return hostSpawn(process.execPath, ['-e', STAND_IN_SCRIPT, cwd, ...argv.slice(separator + 1)], { ...options, windowsHide: true });
});
syncBuiltinESMExports();

const providerResult = {
  provider: 'codex' as const, exitCode: 0, signal: null, timedOut: false, stdout: 'synthetic completion', stderr: '',
  stdoutSha256: `sha256:${'1'.repeat(64)}`, stderrSha256: `sha256:${'0'.repeat(64)}`,
};

async function schemaErrors(value: unknown) {
  const result = await validateContract(SCHEMA_DIRECTORY, RECEIPT_SCHEMA, JSON.parse(JSON.stringify(value)));
  return result.ok ? [] : result.errors.map(error => `${error.instancePath} ${error.message}`);
}

function loose(receipt: TaskReceipt) {
  return JSON.parse(JSON.stringify(receipt)) as Record<string, unknown>;
}

async function fixture(t: TestContext) {
  const root = await mkdtemp(resolve(tmpdir(), 'dharma-receipt-sandbox-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = resolve(root, 'workspace');
  await mkdir(resolve(workspace, 'reports'), { recursive: true });
  await writeFile(resolve(workspace, 'reports', '.keep'), '');
  for (const argv of [['init', '-q'], ['config', 'user.email', 'test@dharma.ai'], ['config', 'user.name', 'Receipt Fixture'],
    ['add', '.'], ['commit', '-qm', 'initial']]) {
    assert.equal(spawnSync('git', argv, { cwd: workspace, windowsHide: true }).status, 0, argv.join(' '));
  }
  const policy: OrganizationPolicy = {
    schema: 'dharma.organization-policy/v1', organizationId: 'org_test', revision: '1',
    evidence: { defaultMode: 'deep', registeredWorkspaceOnly: true, excludePaths: [], maximumCapsuleBytes: 1,
      maximumDailyUploadBytes: 1, maximumExpansionBytes: 1 },
    tasks: { defaultNetwork: 'deny', defaultGit: 'task_branch', writePaths: ['reports/**'], requireLocalConfirmationFor: [],
      allowedCommands: {
        check: { argv: [process.execPath, '-e', 'process.stdout.write("checked")'], timeoutSeconds: 10 },
      } },
    skills: { automaticInstall: true, automaticPromotionMaxRisk: 'R2', canaryPercent: 10 }, retention: {}, budgets: {},
  };
  const taskKeys = generateKeyPairSync('ed25519');
  const decisionKeys = generateKeyPairSync('ed25519');
  const base = (commandIds: string[]) => ({
    schema: 'dharma.task/v1' as const, taskId: randomUUID(), organizationId: 'org_test', workspaceId: 'workspace',
    taskType: 'external_request' as const, target: { deviceId: 'device', provider: 'codex' as const },
    skillBundle: null, instructions: 'Verify the repository.', requiredSkills: [],
    authority: { readPaths: ['.'], writePaths: ['reports/**'], commands: commandIds.map(commandId => ({ commandId })),
      network: 'deny', git: 'task_branch' as const },
    execution: { isolation: 'git_worktree' as const, timeoutSeconds: 30, leaseSeconds: 60, maximumConcurrentAgents: 1 },
    acceptance: { commands: commandIds.map(commandId => ({ commandId })), requiredArtifacts: [] },
    budget: { mode: 'byok_local' as const, maximumDharmaCostCents: 0 },
    createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 120_000).toISOString(), nonce: randomUUID(),
  });
  const sign = (unsigned: object) => ({ ...unsigned, signature: signCanonicalObject(unsigned, taskKeys.privateKey) }) as TaskEnvelope;
  // A receipt-required task with a KMS-style release decision, as index.test.ts builds it.
  const decided = (commandIds: string[], now: Date) => {
    const baseTask = { ...base(commandIds), target: { deviceId: 'device', endpointId: randomUUID(), provider: 'codex' as const },
      requiredCapabilities: ['action_decision_receipts_v1'] as const };
    const actionId = randomUUID();
    const action = canonicalTaskActionForTask(baseTask as unknown as TaskEnvelope, actionId);
    const receipt = {
      schema: 'dharma.action-decision-receipt/v1' as const,
      decisionId: randomUUID(), organizationId: baseTask.organizationId, actionId, taskId: baseTask.taskId,
      targetEndpointId: baseTask.target.endpointId, workspaceId: baseTask.workspaceId,
      evaluationContractId: randomUUID(), evaluationContractVersion: 1,
      actionDigest: actionDecisionDigest(action), stateEnvelopeHash: `sha256:${'a'.repeat(64)}`,
      evidenceReferences: [], outcome: 'release' as const, reasonCodes: ['policy_release'], confidence: 0.98,
      evaluator: { provider: 'dharma_deterministic_preflight', model: 'deterministic-v1', configDigest: `sha256:${'b'.repeat(64)}` },
      nonce: randomUUID(), issuedAt: now.toISOString(), expiresAt: baseTask.expiresAt,
      keyVersion: 'projects/test/locations/global/keyRings/test/cryptoKeys/action-decisions/cryptoKeyVersions/1',
    } satisfies ActionDecisionReceipt;
    const actionDecision: ActionDecisionEnvelope = { id: receipt.decisionId, actionDigest: receipt.actionDigest, receipt,
      signature: signCanonicalObject(receipt, decisionKeys.privateKey), keyVersion: receipt.keyVersion };
    return { task: sign({ ...baseTask, actionDecision }), actionDecision };
  };
  const relayStateDirectory = resolve(root, 'state');
  const receipts = resolve(root, 'receipts');
  return { root, workspace, policy, relayStateDirectory, receipts, decisionKeys,
    task: (commandIds: string[]) => sign(base(commandIds)), decided,
    input: { policy, workspace, relayStateDirectory, serverPublicKey: taskKeys.publicKey,
      receiptStore: new FileTaskReceiptStore(receipts) } };
}

test('a task that names registered commands records the probed sandbox in its receipt and stored receipt', async (t) => {
  const f = await fixture(t);
  const task = f.task(['check']);
  const receipt = await executeTask({ ...f.input, task, registeredCommandSandbox: STAND_IN_SANDBOX,
    providerExecutor: async () => providerResult });
  assert.equal(receipt.status, 'completed', JSON.stringify(receipt.commandResults.map(({ commandId, stderr }) => ({ commandId, stderr }))));
  const record = loose(receipt);
  assert.equal(record.schema, 'dharma.task-receipt/v2');
  assert.deepEqual(record.commandSandbox, SANDBOXED);
  const stored = JSON.parse(await readFile(resolve(f.receipts, `${task.taskId}.json`), 'utf8')) as Record<string, unknown>;
  assert.equal(stored.schema, 'dharma.task-receipt/v2');
  assert.deepEqual(stored.commandSandbox, SANDBOXED, 'the durable receipt keeps the tuple');
  assert.deepEqual(await schemaErrors(receipt), []);
  assert.deepEqual(await schemaErrors(stored), []);
  const reread = await f.input.receiptStore.get(task.taskId);
  assert.deepEqual(loose(reread!).commandSandbox, SANDBOXED, 'a delivery retry returns the same tuple');
});

test('a task without registered commands records that no sandbox was used', async (t) => {
  const f = await fixture(t);
  for (const registeredCommandSandbox of [undefined, STAND_IN_SANDBOX]) {
    const task = f.task([]);
    const receipt = await executeTask({ ...f.input, task, ...(registeredCommandSandbox ? { registeredCommandSandbox } : {}),
      providerExecutor: async () => providerResult });
    assert.equal(receipt.status, 'completed', JSON.stringify(receipt.commandResults.map(({ commandId, stderr }) => ({ commandId, stderr }))));
    const record = loose(receipt);
    assert.equal(record.schema, 'dharma.task-receipt/v2');
    assert.deepEqual(record.commandSandbox, { state: 'not_used' },
      'a sandbox the relay passed is not recorded for a task that runs no registered command');
    assert.deepEqual(await schemaErrors(receipt), []);
  }
});

test('a failed command-bearing task still records the sandbox it was admitted with', async (t) => {
  const f = await fixture(t);
  const task = f.task(['check']);
  const receipt = await executeTask({ ...f.input, task, registeredCommandSandbox: STAND_IN_SANDBOX,
    providerExecutor: async () => ({ ...providerResult, exitCode: 1 }) });
  assert.equal(receipt.status, 'failed');
  assert.deepEqual(receipt.commandResults.map(({ commandId }) => commandId), ['provider.codex'], 'no registered command ran');
  assert.deepEqual(loose(receipt).commandSandbox, SANDBOXED);
  assert.deepEqual(await schemaErrors(receipt), []);
});

function storedReceipt(taskId: string, extra: Record<string, unknown>) {
  return {
    taskId, status: 'completed', worktree: resolve(tmpdir(), 'dharma-worktree'), branch: `dharma/task/${taskId}`,
    commandResults: [{ commandId: 'check', exitCode: 0, signal: null, timedOut: false,
      stdoutSha256: `sha256:${'1'.repeat(64)}`, stderrSha256: `sha256:${'0'.repeat(64)}`, stdout: '', stderr: '' }],
    startedAt: '2026-11-28T00:00:00.000Z', completedAt: '2026-11-28T00:00:01.000Z', ...extra,
  };
}

test('receipt readers accept revision 1 receipts, and the runner and the schema reject the same broken tuples', async (t) => {
  const root = await mkdtemp(resolve(tmpdir(), 'dharma-receipt-revisions-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new FileTaskReceiptStore(root);
  const read = async (value: Record<string, unknown>) => {
    await writeFile(resolve(root, `${value.taskId}.json`), JSON.stringify(value));
    return store.get(String(value.taskId));
  };
  const v2 = 'dharma.task-receipt/v2';

  // Revision 1: receipts written before the sandbox tuple carry neither `schema` nor `commandSandbox`.
  const legacy = storedReceipt(randomUUID(), {});
  const legacyRead = await read(legacy);
  assert.equal(legacyRead?.taskId, legacy.taskId, 'a stored revision 1 receipt is still returned on a delivery retry');
  assert.equal('commandSandbox' in loose(legacyRead!), false);

  for (const commandSandbox of [SANDBOXED, { state: 'not_used' }, { state: 'unavailable' },
    { ...SANDBOXED, host: 'wsl2', bwrapPath: '/bin/bwrap' }]) {
    const valid = storedReceipt(randomUUID(), { schema: v2, commandSandbox });
    assert.equal((await read(valid))?.taskId, valid.taskId, JSON.stringify(commandSandbox));
    assert.deepEqual(await schemaErrors(valid), [], JSON.stringify(commandSandbox));
  }

  const broken: Array<[string, Record<string, unknown>]> = [
    ['no tuple', { schema: v2 }],
    ['PATH lookup', { schema: v2, commandSandbox: { ...SANDBOXED, bwrapPath: 'bwrap' } }],
    ['other path', { schema: v2, commandSandbox: { ...SANDBOXED, bwrapPath: '/usr/local/bin/bwrap' } }],
    ['short digest', { schema: v2, commandSandbox: { ...SANDBOXED, bwrapSha256: 'sha256:abc' } }],
    ['bare digest', { schema: v2, commandSandbox: { ...SANDBOXED, bwrapSha256: 'a'.repeat(64) } }],
    ['unparsed version', { schema: v2, commandSandbox: { ...SANDBOXED, bwrapVersion: 'bubblewrap 0.9.0' } }],
    ['other host', { schema: v2, commandSandbox: { ...SANDBOXED, host: 'darwin' } }],
    ['other policy', { schema: v2, commandSandbox: { ...SANDBOXED, policy: 'custom' } }],
    ['failed probe', { schema: v2, commandSandbox: { ...SANDBOXED, probe: { ...SANDBOXED.probe, result: 'failed' } } }],
    ['no checks', { schema: v2, commandSandbox: { ...SANDBOXED, probe: { ...SANDBOXED.probe, checks: [] } } }],
    ['repeated check', { schema: v2, commandSandbox: { ...SANDBOXED, probe: { ...SANDBOXED.probe, checks: ['network_denied', 'network_denied'] } } }],
    ['no probe time', { schema: v2, commandSandbox: { ...SANDBOXED, probe: { result: 'passed', checks: PROBE.checks } } }],
    ['no probe', { schema: v2, commandSandbox: { ...SANDBOXED, probe: undefined } }],
    ['extra field', { schema: v2, commandSandbox: { ...SANDBOXED, layout: { bin: 'symlink' } } }],
    ['not used with a path', { schema: v2, commandSandbox: { state: 'not_used', bwrapPath: '/usr/bin/bwrap' } }],
    ['unknown state', { schema: v2, commandSandbox: { state: 'skipped' } }],
    ['unknown revision', { schema: 'dharma.task-receipt/v3', commandSandbox: SANDBOXED }],
    ['revision 1 with a tuple', { commandSandbox: SANDBOXED }],
  ];
  for (const [name, extra] of broken) {
    const value = JSON.parse(JSON.stringify(storedReceipt(randomUUID(), extra))) as Record<string, unknown>;
    await assert.rejects(read(value), /Task receipt/, `the runner rejects: ${name}`);
    assert.notDeepEqual(await schemaErrors(value), [], `the schema rejects: ${name}`);
  }
});

test('a receipt-required task journals its sandbox, and a receipt after a receiver restart reports that sandbox', async (t) => {
  const f = await fixture(t);
  const now = new Date();
  const { task } = f.decided(['check'], now);
  const journalPath = resolve(f.relayStateDirectory, 'action-execution-journal', `${task.taskId}.json`);
  let journaled: unknown;
  const receipt = await executeTask({ ...f.input, task, registeredCommandSandbox: STAND_IN_SANDBOX,
    actionDecisions: { resolvePublicKey: () => f.decisionKeys.publicKey, now: () => now },
    providerExecutor: async () => {
      journaled = (JSON.parse(await readFile(journalPath, 'utf8')) as Record<string, unknown>).commandSandbox;
      return providerResult;
    } });
  assert.equal(receipt.status, 'completed', JSON.stringify(receipt.commandResults.map(({ commandId, stderr }) => ({ commandId, stderr }))));
  assert.deepEqual(journaled, SANDBOXED, 'the journal holds the tuple before any effect');
  assert.deepEqual(loose(receipt).commandSandbox, SANDBOXED);
  assert.deepEqual(await schemaErrors(receipt), []);

  // A receiver restart finds an execution that was in progress. Its receipt reports the sandbox the
  // interrupted run was admitted with, not the one this relay probed now; a journal written before
  // receipts carried the tuple reports it as unavailable.
  const recorded = { ...SANDBOXED, bwrapVersion: '0.8.0', bwrapSha256: `sha256:${'b'.repeat(64)}` };
  for (const [journalSandbox, expected] of [[recorded, recorded], [undefined, { state: 'unavailable' }]] as const) {
    const { task: interrupted, actionDecision } = f.decided(['check'], now);
    const path = resolve(f.relayStateDirectory, 'action-execution-journal', `${interrupted.taskId}.json`);
    await mkdir(resolve(path, '..'), { recursive: true });
    await writeFile(path, JSON.stringify({
      schema: 'dharma.action-execution-journal/v1', taskId: interrupted.taskId,
      decisionId: actionDecision.receipt.decisionId, endpointId: interrupted.target.endpointId,
      actionDigest: actionDecision.receipt.actionDigest, externalIdempotencyKey: actionDecision.receipt.decisionId,
      worktree: resolve(f.relayStateDirectory, 'worktrees', interrupted.taskId), branch: `dharma/task/${interrupted.taskId}`,
      state: 'executing', preparedAt: now.toISOString(), updatedAt: now.toISOString(),
      ...(journalSandbox ? { commandSandbox: journalSandbox } : {}),
    }));
    let providerCalls = 0;
    const recovered = await executeTask({ ...f.input, task: interrupted, registeredCommandSandbox: STAND_IN_SANDBOX,
      actionDecisions: { resolvePublicKey: () => f.decisionKeys.publicKey, now: () => now },
      providerExecutor: async () => { providerCalls++; return providerResult; } });
    assert.equal(providerCalls, 0, 'execution is not repeated');
    assert.equal(recovered.status, 'failed');
    assert.equal(loose(recovered).schema, 'dharma.task-receipt/v2');
    assert.deepEqual(loose(recovered).commandSandbox, expected);
    assert.deepEqual(await schemaErrors(recovered), []);
  }
});
