import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import test from 'node:test';
import ts from 'typescript';

type Caller = (fabric: unknown, leaseSeconds: number) => Promise<Record<string, unknown>>;

async function taskCaller(dependencies: Record<string, unknown>, removeDeviceGuard = false): Promise<Caller> {
  const text = await readFile(fileURLToPath(new URL('../src/index.ts', import.meta.url)), 'utf8');
  const source = ts.createSourceFile('index.ts', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const names = ['assertTaskWorkspacePolicy', 'assertTaskSkillPin', 'taskSkillPinFailureCode', 'executeOneTask'];
  const printer = ts.createPrinter();
  let removedGuards = 0;
  const definitions = names.map(name => {
    const matches = source.statements.filter(node => ts.isFunctionDeclaration(node) && node.name?.text === name);
    assert.equal(matches.length, 1, `${name} must resolve exactly once`);
    const declaration = matches[0] as ts.FunctionDeclaration;
    const unexported = ts.factory.updateFunctionDeclaration(declaration,
      declaration.modifiers?.filter(modifier => modifier.kind !== ts.SyntaxKind.ExportKeyword),
      declaration.asteriskToken, declaration.name, declaration.typeParameters,
      declaration.parameters, declaration.type, declaration.body);
    const transformed = ts.transform(unexported, [context => root => {
      const visit: ts.Visitor = node => {
        if (removeDeviceGuard && ts.isIfStatement(node) && ts.isBinaryExpression(node.expression)
          && node.expression.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsEqualsToken
          && node.expression.left.getText(source) === 'task.target.deviceId'
          && node.expression.right.getText(source) === 'config.deviceId') {
          removedGuards++;
          return ts.factory.createEmptyStatement();
        }
        return ts.visitEachChild(node, visit, context);
      };
      return ts.visitNode(root, visit) as ts.FunctionDeclaration;
    }]);
    try { return printer.printNode(ts.EmitHint.Unspecified, transformed.transformed[0]!, source); }
    finally { transformed.dispose(); }
  });
  assert.equal(removedGuards, removeDeviceGuard ? 1 : 0);
  const compiled = ts.transpileModule(definitions.join('\n'), {
    compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.None },
    reportDiagnostics: true,
  });
  assert.equal(compiled.diagnostics?.filter(item => item.category === ts.DiagnosticCategory.Error).length, 0);
  // Only these actual function bodies run. Every runtime effect port below is synthetic.
  return runInNewContext(`${compiled.outputText}\nexecuteOneTask`, dependencies, {
    timeout: 1000, contextCodeGeneration: { strings: false, wasm: false },
  }) as Caller;
}

function fixture() {
  const calls: string[] = [];
  const task = {
    taskId: 'task_fixture', organizationId: 'org_fixture', workspaceId: 'workspace_fixture',
    taskType: 'external_request', target: { deviceId: 'device_fixture', provider: 'claude' },
    skillBundle: null as { bundleId: string; bundleHash: string } | null,
    authority: { readPaths: ['.'], writePaths: [], commands: [], network: 'deny' },
    acceptance: { commands: [], requiredArtifacts: [] },
  };
  const workspace = { workspaceId: task.workspaceId, organizationId: task.organizationId,
    path: resolve('/fixture/task-caller/workspace'), repositoryAgentId: 'agent_fixture' };
  const policy = { organizationId: task.organizationId, serverAuthorization: { workspaceId: task.workspaceId } };
  let registered = true;
  let refreshFailure: Error | null = null;
  let activeSkill: { bundleId: string; bundleHash: string } | null = null;
  const config = { deviceId: task.target.deviceId, organizationId: task.organizationId,
    serverPublicKeyEd25519: 'synthetic_key_never_parsed' };
  const fabric = {
    pollTask: async () => { calls.push('poll'); return { task: { envelope: task } }; },
    postTaskEvent: async (_taskId: string, event: string) => { calls.push(`event:${event}`); },
  };
  const intervalIds = new Set<number>();
  let nextInterval = 0;
  const dependencies: Record<string, unknown> = {
    resolve,
    registry: async () => { calls.push('registry'); return registered ? [workspace] : []; },
    refreshVerifiedWorkspacePolicyForTransmission: async () => {
      calls.push('policy-refresh');
      if (refreshFailure) throw refreshFailure;
      return policy;
    },
    configPath: () => '/fixture/config.json',
    readFile: async (path: string) => {
      assert.equal(path, '/fixture/config.json'); calls.push('config-read'); return JSON.stringify(config);
    },
    setInterval: (_callback: () => void, _delay: number) => {
      // Virtual time never advances; no host timer or heartbeat callback runs.
      const id = ++nextInterval; intervalIds.add(id); calls.push(`interval-create:${id}`); return id;
    },
    clearInterval: (id: number) => {
      assert.ok(intervalIds.delete(id), 'clear exactly one acquired interval'); calls.push(`interval-clear:${id}`);
    },
    withWorkspaceSkillActivationLock: async (workspaceId: string, provider: string, operation: () => Promise<unknown>) => {
      assert.equal(workspaceId, workspace.workspaceId); assert.equal(provider, task.target.provider);
      calls.push('activation-lock-enter');
      try { return await operation(); }
      finally { calls.push('activation-lock-release'); }
    },
    createPublicKey: () => { calls.push('public-key'); return { synthetic: true }; },
    activeSkillAuthorization: async () => { calls.push('active-skill'); return activeSkill; },
    dharmaHome: () => '/fixture/home',
    FileTaskReceiptStore: class { constructor() { calls.push('receipt-store'); } },
    executeTask: async () => {
      calls.push('execute-task');
      return { status: 'completed', branch: null, commandResults: [],
        startedAt: '2026-10-21T00:00:00.000Z', completedAt: '2026-10-21T00:00:01.000Z' };
    },
    taskResponsePreview: () => null,
    postTaskOutcome: async () => { calls.push('outcome'); },
    createActionDecisionPublicKeyResolver: () => { throw new Error('unexpected keyset path'); },
    installedRepositoryKnowledge: async () => { throw new Error('unexpected knowledge read'); },
    prepareSignedTaskTrajectory: () => { throw new Error('unexpected trajectory preparation'); },
    stageSignedTaskTrajectoryRecovery: async () => { throw new Error('unexpected trajectory staging'); },
    finalizeRecoveredSignedTaskTrajectories: async () => { throw new Error('unexpected trajectory recovery'); },
  };
  return { task, workspace, policy, config, calls, fabric, dependencies, intervalIds,
    unregister: () => { registered = false; },
    failRefresh: () => { refreshFailure = new Error('fixture policy refresh denied'); },
    setActiveSkill: (value: typeof activeSkill) => { activeSkill = value; } };
}

const beforeDeviceRejection = ['poll', 'registry', 'policy-refresh', 'config-read',
  'interval-create:1', 'activation-lock-enter'];

async function assertForeignDeviceRejected(f: ReturnType<typeof fixture>, removeDeviceGuard = false) {
  f.task.target.deviceId = 'foreign_device';
  const run = await taskCaller(f.dependencies, removeDeviceGuard);
  await assert.rejects(run(f.fabric, 30), /Task target does not match this enrolled device\./);
  assert.deepEqual(f.calls, [...beforeDeviceRejection, 'activation-lock-release', 'interval-clear:1']);
  assert.equal(f.intervalIds.size, 0);
}

test('foreign-device task preserves actual earlier ports but never reaches crypto, skill or execution', async () => {
  await assertForeignDeviceRejected(fixture());
});

test('unregistered task workspace rejects before policy, config, timer or activation access', async () => {
  const f = fixture(); f.unregister();
  await assert.rejects((await taskCaller(f.dependencies))(f.fabric, 30), /Task workspace is not registered/);
  assert.deepEqual(f.calls, ['poll', 'registry']);
  assert.equal(f.intervalIds.size, 0);
});

test('real workspace-policy assertion rejects mismatched organization before config and locks', async () => {
  const f = fixture(); f.policy.organizationId = 'foreign_org';
  await assert.rejects((await taskCaller(f.dependencies))(f.fabric, 30), /Task workspace policy does not match/);
  assert.deepEqual(f.calls, ['poll', 'registry', 'policy-refresh']);
  assert.equal(f.intervalIds.size, 0);
});

test('failed policy refresh cannot create a task timer, read config or enter activation', async () => {
  const f = fixture(); f.failRefresh();
  await assert.rejects((await taskCaller(f.dependencies))(f.fabric, 30), /fixture policy refresh denied/);
  assert.deepEqual(f.calls, ['poll', 'registry', 'policy-refresh']);
  assert.equal(f.intervalIds.size, 0);
});

test('stale bundle pin posts failed preflight and releases its timer and lock without starting', async () => {
  const f = fixture();
  f.task.skillBundle = { bundleId: 'task_bundle', bundleHash: `sha256:${'a'.repeat(64)}` };
  f.setActiveSkill({ bundleId: 'other_bundle', bundleHash: f.task.skillBundle.bundleHash });
  await assert.rejects((await taskCaller(f.dependencies))(f.fabric, 30), /Task skill bundle does not match/);
  assert.deepEqual(f.calls, [...beforeDeviceRejection, 'public-key', 'active-skill', 'event:failed',
    'activation-lock-release', 'interval-clear:1']);
  assert.equal(f.intervalIds.size, 0);
});

test('matching admission reaches the injected executor and outcome with both timers cleaned', async () => {
  const f = fixture();
  const result = await (await taskCaller(f.dependencies))(f.fabric, 30);
  assert.equal(result.ok, true); assert.equal(result.taskId, f.task.taskId);
  assert.deepEqual(f.calls, [...beforeDeviceRejection, 'public-key', 'active-skill', 'event:started',
    'interval-create:2', 'receipt-store', 'execute-task', 'interval-clear:2', 'outcome',
    'activation-lock-release', 'interval-clear:1']);
  assert.equal(f.intervalIds.size, 0);
});

test('in-memory removal of the device guard is detected by the rejection assertion', async () => {
  const f = fixture();
  await assert.rejects(() => assertForeignDeviceRejected(f, true), {
    code: 'ERR_ASSERTION', message: /Missing expected rejection/,
  });
  assert.equal(f.calls.filter(call => call === 'execute-task').length, 1,
    'the negative control must reach execution, not fail because a dependency is absent');
  assert.equal(f.intervalIds.size, 0);
});
