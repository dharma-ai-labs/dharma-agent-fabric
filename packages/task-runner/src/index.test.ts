import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { createHash, generateKeyPairSync, randomUUID } from 'node:crypto';
import { chmod, link, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
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
  FileActionExecutionJournal,
  FileTaskReceiptStore,
  providerInstructionsForTask,
  verifyTaskEnvelope,
  type TaskEnvelope,
} from './index.js';

async function requiredArtifactFixture(t: TestContext, requiredArtifacts: string[]) {
  const root = await mkdtemp(resolve(tmpdir(), 'dharma-required-artifact-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = resolve(root, 'workspace');
  await mkdir(workspace);
  for (const argv of [['init', '-q'], ['config', 'user.email', 'test@dharma.ai'],
    ['config', 'user.name', 'Artifact Fixture'], ['commit', '--allow-empty', '-qm', 'initial']]) {
    assert.equal(spawnSync('git', argv, { cwd: workspace }).status, 0);
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
      receiptStore: new FileTaskReceiptStore(resolve(root, 'receipts')) } };
}

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
        providerExecutor: async () => { calls++; return fixture.providerResult; } }), /required_artifact_(invalid|unauthorized)/);
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
        providerExecutor: async () => { calls++; return fixture.providerResult; } }), /required_artifact_invalid/);
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
        providerExecutor: async () => { calls++; return fixture.providerResult; } }), /required_artifact_invalid/);
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

test('required artifact review v3: generated artifact metadata has an independent hard bound', async (t) => {
  const artifacts = Array.from({ length: 10_000 }, (_, index) => `reports/${index}-${'x'.repeat(30)}.json`);
  const fixture = await requiredArtifactFixture(t, artifacts);
  assert.throws(() => providerInstructionsForTask(fixture.signed()), /Required artifact metadata exceeds the execution limit/);
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
          if (tracked) assert.equal(spawnSync('git', ['add', '--', artifact], { cwd: workspace }).status, 0);
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

test('read-only signed tasks receive only matching verified knowledge and remove it afterward', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'dharma-task-knowledge-'));
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
    execution: { isolation: 'git_worktree' as const, timeoutSeconds: 120, leaseSeconds: 20, maximumConcurrentAgents: 1 },
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
  await assert.rejects(executeTask({
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
  }), /registered external-effect receipt verifier/);
  assert.equal(networkExecutions, 0);

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
  const effectResult = await executeTask({
    task: receiptTask, policy: receiptPolicy, workspace,
    relayStateDirectory: resolve(root, 'effect-state'), serverPublicKey: taskKeys.publicKey,
    receiptStore: new FileTaskReceiptStore(resolve(root, 'effect-receipts')),
    actionDecisions: { resolvePublicKey: () => decisionKeys.publicKey },
    providerExecutor: async () => ({
      provider: 'codex', exitCode: 0, signal: null, timedOut: false,
      stdout: 'provider requested the remote change', stderr: '',
      stdoutSha256: `sha256:${'3'.repeat(64)}`, stderrSha256: `sha256:${'0'.repeat(64)}`,
    }),
  });
  assert.equal(effectResult.status, 'completed');
  assert.equal(effectResult.actionAcknowledgement?.disposition, 'executed');
  assert.equal(effectResult.externalEffectReceipt?.providerReference, 'remote-change-42');
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
