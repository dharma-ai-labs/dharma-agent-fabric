import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import test from 'node:test';
import ts from 'typescript';
import * as taskRunner from '@dharma-ai-labs/agent-fabric-task-runner';

type Caller = (fabric: unknown, leaseSeconds: number) => Promise<Record<string, unknown>>;

async function taskCaller(dependencies: Record<string, unknown>, options: {
  removeDeviceGuard?: boolean; isolateErrorRealm?: boolean;
} = {}): Promise<Caller> {
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
        if (options.removeDeviceGuard && ts.isIfStatement(node) && ts.isBinaryExpression(node.expression)
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
  assert.equal(removedGuards, options.removeDeviceGuard ? 1 : 0);
  const compiled = ts.transpileModule(definitions.join('\n'), {
    compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.None },
    reportDiagnostics: true,
  });
  assert.equal(compiled.diagnostics?.filter(item => item.category === ts.DiagnosticCategory.Error).length, 0);
  // Only these actual function bodies run. Every runtime effect port below is synthetic.
  return runInNewContext(`${compiled.outputText}\nexecuteOneTask`, {
    ...dependencies,
    // Injected ports and the caller share Error in production; VM isolation is a control only.
    ...(options.isolateErrorRealm ? {} : { Error }),
  }, {
    timeout: 1000, contextCodeGeneration: { strings: false, wasm: false },
  }) as Caller;
}

function fixture() {
  const calls: string[] = [];
  const events: Array<{ taskId: string; event: string; payload: unknown }> = [];
  const task = {
    taskId: 'task_fixture', organizationId: 'org_fixture', workspaceId: 'workspace_fixture',
    taskType: 'external_request', target: { deviceId: 'device_fixture', provider: 'claude' },
    skillBundle: null as { bundleId: string; bundleHash: string } | null,
    authority: { readPaths: ['.'], writePaths: [], commands: [], network: 'deny' },
    acceptance: { commands: [], requiredArtifacts: [] },
  };
  const workspace = { workspaceId: task.workspaceId, organizationId: task.organizationId,
    path: resolve('/fixture/task-caller/workspace'), repositoryAgentId: 'agent_fixture' };
  const policy = { organizationId: task.organizationId, revision: '7', serverAuthorization: { workspaceId: task.workspaceId },
    tasks: { allowedCommands: {} as Record<string, { argv: string[]; timeoutSeconds: number }> } };
  let registered = true;
  let refreshFailure: Error | null = null;
  let activeSkill: { bundleId: string; bundleHash: string } | null = null;
  let unsafeProviders: string[] = [];
  let sandbox: unknown = { usable: false, reason: 'platform_unsupported', detail: 'platform=win32', fix: 'synthetic fix' };
  const config = { deviceId: task.target.deviceId, organizationId: task.organizationId,
    serverPublicKeyEd25519: 'synthetic_key_never_parsed' };
  const fabric = {
    pollTask: async () => { calls.push('poll'); return { task: { envelope: task } }; },
    postTaskEvent: async (taskId: string, event: string, payload: unknown) => {
      calls.push(`event:${event}`); events.push({ taskId, event, payload });
    },
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
    // The real task-runner predicate and admission, so the relay and runner checks cannot drift.
    REGISTERED_COMMANDS_REFUSED: taskRunner.REGISTERED_COMMANDS_REFUSED,
    taskNamesRegisteredCommands: taskRunner.taskNamesRegisteredCommands,
    registeredCommandAdmission: taskRunner.registeredCommandAdmission,
    // The real snapshot of the commands a task may run, taken once at admission.
    snapshotRegisteredCommandPolicy: Reflect.get(taskRunner, 'snapshotRegisteredCommandPolicy'),
    // The live probe is a port here; task-runner tests cover its real behaviour.
    detectRegisteredCommandSandbox: async (options: { relayStateDirectory: string }) => {
      assert.equal(options.relayStateDirectory, resolve('/fixture/home', 'relay'));
      calls.push('sandbox-probe'); return sandbox;
    },
    PROVIDER_UNSAFE_PATH: 'provider_unsafe_path',
    relayProviderUnsafePath: async (provider: string) => {
      if (!unsafeProviders.includes(provider)) return false;
      calls.push(`unsafe-provider:${provider}`); return true;
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
    requiredSkillFilesForTask: async () => [],
    prepareSignedTaskTrajectory: () => { throw new Error('unexpected trajectory preparation'); },
    stageSignedTaskTrajectoryRecovery: async () => { throw new Error('unexpected trajectory staging'); },
    finalizeRecoveredSignedTaskTrajectories: async () => { throw new Error('unexpected trajectory recovery'); },
  };
  return { task, workspace, policy, config, calls, events, fabric, dependencies, intervalIds,
    unregister: () => { registered = false; },
    failRefresh: () => { refreshFailure = new Error('fixture policy refresh denied'); },
    setActiveSkill: (value: typeof activeSkill) => { activeSkill = value; },
    setUnsafeProviders: (value: string[]) => { unsafeProviders = value; },
    setSandbox: (value: unknown) => { sandbox = value; } };
}

const beforeDeviceRejection = ['poll', 'registry', 'policy-refresh', 'config-read',
  'interval-create:1', 'activation-lock-enter'];

async function assertForeignDeviceRejected(f: ReturnType<typeof fixture>, removeDeviceGuard = false) {
  f.task.target.deviceId = 'foreign_device';
  const run = await taskCaller(f.dependencies, { removeDeviceGuard });
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

// PR #427 review (3x8=24): the first executable of the task's provider on PATH can belong to another user.
test('task for a provider whose first executable on PATH is unsafe is refused before config, lock or execution', async () => {
  const f = fixture(); f.setUnsafeProviders(['claude']);
  const result = await (await taskCaller(f.dependencies))(f.fabric, 30);
  assert.deepEqual({ ...result }, { ok: false, taskId: f.task.taskId, code: 'provider_unsafe_path' });
  assert.deepEqual(f.calls, ['poll', 'registry', 'policy-refresh', 'unsafe-provider:claude', 'event:failed']);
  assert.deepEqual(JSON.parse(JSON.stringify(f.events)), [{ taskId: f.task.taskId, event: 'failed',
    payload: { phase: 'preflight', code: 'provider_unsafe_path' } }]);
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

test('executor rejection after started releases both timers and the activation lock without a false outcome', async () => {
  const f = fixture(), failure = new Error('fixture executor rejected before a receipt');
  f.dependencies.executeTask = async () => { f.calls.push('execute-task'); throw failure; };
  await assert.rejects((await taskCaller(f.dependencies))(f.fabric, 30), error => error === failure);
  assert.equal(f.intervalIds.size, 0);
  assert.deepEqual(f.calls, [...beforeDeviceRejection, 'public-key', 'active-skill', 'event:started',
    'interval-create:2', 'receipt-store', 'execute-task', 'interval-clear:2',
    'activation-lock-release', 'interval-clear:1']);
  assert.deepEqual(f.events.map(event => event.event), ['started']);
});

async function assertCoordinationTimeout(f: ReturnType<typeof fixture>, isolateErrorRealm = false) {
  const failure = new Error('Timed out waiting for the workspace skill activation lock.');
  f.dependencies.withWorkspaceSkillActivationLock = async () => {
    f.calls.push('activation-lock-timeout'); throw failure;
  };
  await assert.rejects((await taskCaller(f.dependencies, { isolateErrorRealm }))(f.fabric, 30),
    error => error === failure);
  assert.equal(f.intervalIds.size, 0);
  assert.equal(f.events.length, 1, 'coordination timeout must post one bounded failure');
  assert.deepEqual(JSON.parse(JSON.stringify(f.events)), [{ taskId: f.task.taskId, event: 'failed',
    payload: { phase: 'coordination', code: 'skill_activation_lock_timeout' } }]);
  assert.deepEqual(f.calls, ['poll', 'registry', 'policy-refresh', 'config-read',
    'interval-create:1', 'activation-lock-timeout', 'event:failed', 'interval-clear:1']);
}

test('coordination timeout posts its actual failure classification and clears only the waiting timer', async () => {
  await assertCoordinationTimeout(fixture());
});

test('an isolated VM Error realm is detected by the timeout-event assertion, not a missing dependency', async () => {
  const f = fixture();
  await assert.rejects(() => assertCoordinationTimeout(f, true), {
    code: 'ERR_ASSERTION', message: /coordination timeout must post one bounded failure/,
  });
  assert.equal(f.intervalIds.size, 0);
  assert.equal(f.calls.filter(call => call === 'activation-lock-timeout').length, 1);
  assert.equal(f.calls.includes('execute-task'), false);
  assert.deepEqual(f.events, []);
});

// Tasks that name registered commands run only inside an operating-system sandbox.
// The relay refuses such a task right after the poll, before policy sync, locks, `started` or
// skill hashing, unless the task's network is `deny` and the live sandbox probe is usable. The
// refusal is one terminal `failed` event that carries the reason.
const USABLE_SANDBOX = {
  usable: true, host: 'linux', bwrapPath: '/usr/bin/bwrap', bwrapVersion: '0.9.0', bwrapSha256: `sha256:${'a'.repeat(64)}`,
  policy: 'bwrap-policy/2', layout: { bin: 'symlink', sbin: 'symlink', lib: 'symlink', lib32: 'absent', lib64: 'symlink', libx32: 'absent' },
  nodePrefix: '/usr', bindNodePrefix: false, nodeMounts: [], disableUserns: true,
};

function registeredCommandPorts(f: ReturnType<typeof fixture>) {
  const RefusedError = taskRunner.RegisteredCommandsRefusedError;
  const executed: unknown[] = [];
  f.dependencies.requiredSkillFilesForTask = async () => { f.calls.push('skill-hash'); return []; };
  // The runner's own admission stays as the backstop behind the relay check.
  f.dependencies.executeTask = async (input: { task: typeof f.task; registeredCommandSandbox?: unknown }) => {
    f.calls.push('execute-task');
    executed.push(input.registeredCommandSandbox);
    const admission = taskRunner.registeredCommandAdmission(input.task as never, input.registeredCommandSandbox as never);
    if (!admission.admitted) throw new RefusedError(admission.reason);
    f.calls.push('child-process');
    return { status: 'completed', branch: null, commandResults: [],
      startedAt: '2026-10-21T00:00:00.000Z', completedAt: '2026-10-21T00:00:01.000Z' };
  };
  return { code: taskRunner.REGISTERED_COMMANDS_REFUSED, executed };
}

const nameCommands = {
  'acceptance commands': (task: ReturnType<typeof fixture>['task']) => {
    (task.authority.commands as string[]).push('npm.test');
    (task.acceptance.commands as string[]).push('npm.test');
  },
  'command ids only': (task: ReturnType<typeof fixture>['task']) => {
    (task.authority.commands as string[]).push('npm.test');
  },
};

for (const [name, names] of Object.entries(nameCommands)) {
  for (const reason of ['platform_unsupported', 'bubblewrap_missing', 'bubblewrap_too_old', 'bubblewrap_untrusted',
    'user_namespaces_unavailable', 'sandbox_probe_failed'] as const) {
    test(`a polled task with ${name} on a host whose sandbox is ${reason} gets one terminal failed preflight event`, async () => {
      const f = fixture(); names(f.task);
      f.setSandbox({ usable: false, reason, detail: 'synthetic detail', fix: 'synthetic fix' });
      const { code, executed } = registeredCommandPorts(f);
      assert.equal(code, 'registered_commands_refused');
      const result = await (await taskCaller(f.dependencies))(f.fabric, 30);
      assert.deepEqual({ ...result }, { ok: false, taskId: f.task.taskId, code, reason });
      assert.deepEqual(JSON.parse(JSON.stringify(f.events)), [{ taskId: f.task.taskId, event: 'failed',
        payload: { phase: 'preflight', code, reason } }]);
      assert.deepEqual(f.calls, ['poll', 'registry', 'sandbox-probe', 'event:failed'],
        'no policy sync, config read, timer, activation lock, started event, skill hashing or execution');
      assert.deepEqual(executed, []);
      assert.equal(f.intervalIds.size, 0);
    });
  }
}

test('a polled task with registered commands and a network grant is refused without a probe', async () => {
  const f = fixture(); nameCommands['acceptance commands'](f.task);
  f.task.authority.network = 'package_registry_only';
  f.setSandbox(USABLE_SANDBOX);
  const { code } = registeredCommandPorts(f);
  const result = await (await taskCaller(f.dependencies))(f.fabric, 30);
  assert.deepEqual({ ...result }, { ok: false, taskId: f.task.taskId, code, reason: 'network_not_denied' });
  assert.deepEqual(JSON.parse(JSON.stringify(f.events)), [{ taskId: f.task.taskId, event: 'failed',
    payload: { phase: 'preflight', code, reason: 'network_not_denied' } }]);
  assert.deepEqual(f.calls, ['poll', 'registry', 'event:failed']);
});

test('an admitted task with registered commands reaches the runner with the probed sandbox', async () => {
  const f = fixture(); nameCommands['acceptance commands'](f.task);
  f.setSandbox(USABLE_SANDBOX);
  const { executed } = registeredCommandPorts(f);
  const result = await (await taskCaller(f.dependencies))(f.fabric, 30);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(f.calls, ['poll', 'registry', 'sandbox-probe', ...beforeDeviceRejection.slice(2), 'public-key', 'active-skill',
    'event:started', 'interval-create:2', 'skill-hash', 'receipt-store', 'execute-task', 'child-process', 'interval-clear:2',
    'outcome', 'activation-lock-release', 'interval-clear:1']);
  assert.deepEqual(executed, [USABLE_SANDBOX]);
  assert.deepEqual(f.events.map(event => event.event), ['started']);
});

// The task receipt names the command sandbox (receipt revision dharma.task-receipt/v2). The relay
// passes that tuple on unchanged in the outcome it posts and in its own output, and adds nothing
// for a revision 1 receipt that has none.
const RECEIPT_SANDBOX = {
  state: 'sandboxed', host: 'linux', bwrapPath: '/usr/bin/bwrap', bwrapVersion: '0.9.0', bwrapSha256: `sha256:${'a'.repeat(64)}`,
  policy: 'bwrap-policy/2', probe: { result: 'passed', checks: ['network_denied'], probedAt: '2026-10-20T23:59:59.000Z' },
};

for (const [name, commandSandbox] of [['the probed sandbox', RECEIPT_SANDBOX], ['no sandbox', { state: 'not_used' }],
  ['a revision 1 receipt', undefined]] as const) {
  test(`the task outcome carries the command sandbox from the receipt: ${name}`, async () => {
    const f = fixture();
    if (commandSandbox === RECEIPT_SANDBOX) { nameCommands['acceptance commands'](f.task); f.setSandbox(USABLE_SANDBOX); }
    registeredCommandPorts(f);
    const payloads: unknown[] = [];
    f.dependencies.executeTask = async () => ({
      ...(commandSandbox ? { schema: 'dharma.task-receipt/v2', commandSandbox } : {}),
      status: 'completed', branch: null, commandResults: [],
      startedAt: '2026-10-21T00:00:00.000Z', completedAt: '2026-10-21T00:00:01.000Z',
    });
    f.dependencies.postTaskOutcome = async (input: { payload: unknown }) => { payloads.push(input.payload); };
    const result = await (await taskCaller(f.dependencies))(f.fabric, 30);
    assert.equal(result.ok, true, JSON.stringify(result));
    const summary = { status: 'completed', branch: null, response: null, commandResults: [],
      startedAt: '2026-10-21T00:00:00.000Z', completedAt: '2026-10-21T00:00:01.000Z',
      ...(commandSandbox ? { commandSandbox } : {}) };
    assert.deepEqual(JSON.parse(JSON.stringify(payloads)), [summary]);
    assert.deepEqual(JSON.parse(JSON.stringify(result.receipt)), summary);
  });
}

test('a task without registered commands never probes and runs as before', async () => {
  const f = fixture();
  const { executed } = registeredCommandPorts(f);
  const result = await (await taskCaller(f.dependencies))(f.fabric, 30);
  assert.equal(result.ok, true); assert.equal(result.taskId, f.task.taskId);
  assert.deepEqual(f.calls, [...beforeDeviceRejection, 'public-key', 'active-skill', 'event:started',
    'interval-create:2', 'skill-hash', 'receipt-store', 'execute-task', 'child-process', 'interval-clear:2',
    'outcome', 'activation-lock-release', 'interval-clear:1']);
  assert.deepEqual(executed, [undefined]);
  assert.deepEqual(f.events.map(event => event.event), ['started']);
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

function isDeepFrozen(value: unknown): boolean {
  if (!value || typeof value !== 'object') return true;
  return Object.isFrozen(value) && Object.values(value).every(isDeepFrozen);
}

// The commands a task may run are read once, at admission, before locks, `started` and the
// provider. The runner gets that frozen snapshot. The provider runs unsandboxed and can rewrite
// the approved policy file; that changes nothing for this task, and the relay does not read the
// policy again after the runner returns.
test('the relay reads the command policy once at admission and hands the runner a frozen snapshot', async () => {
  const f = fixture();
  (f.task.authority.commands as { commandId: string }[]).push({ commandId: 'npm.test' });
  (f.task.acceptance.commands as { commandId: string }[]).push({ commandId: 'npm.test' });
  f.policy.tasks.allowedCommands['npm.test'] = { argv: ['npm', 'test'], timeoutSeconds: 60 };
  f.policy.tasks.allowedCommands['npm.publish'] = { argv: ['npm', 'publish'], timeoutSeconds: 60 };
  f.setSandbox(USABLE_SANDBOX);
  registeredCommandPorts(f);
  const handed: Array<{ commandPolicy?: { commands: Record<string, { argv: string[] }> }; policy: unknown }> = [];
  f.dependencies.executeTask = async (input: { commandPolicy?: { commands: Record<string, { argv: string[] }> }; policy: unknown }) => {
    f.calls.push('execute-task');
    handed.push(input);
    // The unsandboxed provider rewrites the approved policy while the task runs.
    f.policy.tasks.allowedCommands['npm.test'] = { argv: ['sh', '-c', 'rewritten'], timeoutSeconds: 60 };
    return { status: 'completed', branch: null, commandResults: [],
      startedAt: '2026-10-21T00:00:00.000Z', completedAt: '2026-10-21T00:00:01.000Z' };
  };
  const result = await (await taskCaller(f.dependencies))(f.fabric, 30);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(handed.length, 1);
  const snapshot = handed[0]!.commandPolicy;
  assert.ok(snapshot, 'the runner receives the admission snapshot');
  assert.deepEqual(JSON.parse(JSON.stringify(snapshot)), {
    taskId: f.task.taskId, organizationId: f.task.organizationId, policyRevision: '7',
    commands: { 'npm.test': { argv: ['npm', 'test'], timeoutSeconds: 60 } },
  }, 'only the commands the task names, as approved at admission');
  assert.ok(isDeepFrozen(snapshot), 'every level of the snapshot is frozen');
  assert.deepEqual(snapshot.commands['npm.test']!.argv, ['npm', 'test'], 'the rewrite during the task does not reach it');
  assert.equal(handed[0]!.policy, f.policy, 'the runner checks the same policy read at admission');
  assert.equal(f.calls.filter(call => call === 'policy-refresh').length, 1, 'the policy is read once');
  assert.ok(f.calls.indexOf('policy-refresh') < f.calls.indexOf('event:started'));
  assert.deepEqual(f.calls.slice(f.calls.indexOf('execute-task')),
    ['execute-task', 'interval-clear:2', 'outcome', 'activation-lock-release', 'interval-clear:1'],
    'without a skill bundle, nothing reads the policy after the runner returns');
});

// No alternate route: a skill smoke check runs a registered command on the host, outside the
// sandbox. Only the operator's `dharma skills sync --smoke-command` starts one. The relay
// activates skills without a smoke command, and the task path installs no skill.
test('no task reaches a skill smoke check', async () => {
  const callers: Array<{ file: string; callee: string; caller: string; call: string }> = [];
  for (const file of ['index.ts', 'demoPackage.ts']) {
    const text = await readFile(fileURLToPath(new URL(`../src/${file}`, import.meta.url)), 'utf8');
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const visit = (node: ts.Node, enclosing: string) => {
      const name = ts.isFunctionDeclaration(node) && node.name ? node.name.text : enclosing;
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)
        && ['activatePreparedSkillUpdate', 'installSkillBundle', 'executeOneTask'].includes(node.expression.text)) {
        callers.push({ file, callee: node.expression.text, caller: name, call: node.getText(source) });
      }
      if (ts.isFunctionDeclaration(node) && node.name?.text === 'executeOneTask') {
        assert.doesNotMatch(node.getText(source), /installSkillBundle|activatePreparedSkillUpdate|smoke/i,
          'the task path installs no skill and starts no smoke check');
      }
      if (ts.isFunctionDeclaration(node) && node.name?.text === 'activatePreparedSkillUpdate') {
        assert.match(node.getText(source),
          /const smokeCommandId = typeof flags\.get\('smoke-command'\) === 'string' \? String\(flags\.get\('smoke-command'\)\) : undefined;/,
          'a smoke command comes only from the --smoke-command flag');
      }
      ts.forEachChild(node, child => visit(child, name));
    };
    visit(source, '');
  }
  const skillCalls = callers.filter(({ callee }) => callee !== 'executeOneTask');
  assert.deepEqual(skillCalls.map(({ file, callee, caller }) => `${file}:${caller}->${callee}`).sort(), [
    'demoPackage.ts:installActiveDemoPackage->installSkillBundle',
    'index.ts:activatePreparedSkillUpdate->installSkillBundle',
    'index.ts:relayWorkspaceLoop->activatePreparedSkillUpdate',
    'index.ts:skillSync->activatePreparedSkillUpdate',
  ].sort());
  assert.match(skillCalls.find(({ caller }) => caller === 'relayWorkspaceLoop')!.call, /flags: new Map\(\)/,
    'the relay activates skills with no flags, so with no smoke command');
  assert.doesNotMatch(skillCalls.find(({ file }) => file === 'demoPackage.ts')!.call, /smoke/i);
  assert.ok(callers.some(({ callee, caller }) => callee === 'executeOneTask' && caller === 'relayWorkspaceLoop'),
    'the relay runs tasks through executeOneTask');
});
