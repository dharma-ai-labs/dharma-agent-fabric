import assert from 'node:assert/strict';
import {execFile, spawn, type ChildProcess} from 'node:child_process';
import {mkdtemp, readFile, realpath, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname, resolve} from 'node:path';
import test from 'node:test';
import {compileFunction} from 'node:vm';
import {promisify} from 'node:util';
import ts from 'typescript';
import {assertBootstrapHostSource, captureBootstrapHostChild, currentBootstrapHostScope,
  drainBootstrapHostChildren, prepareCodexBootstrapHost, runCodexBootstrapHostScope} from './bootstrapHostScope.js';
import {watchOwnedChild} from './ownedChildLifecycle.js';
import {createNamedSessionChildOwner, currentNamedSessionChildOwner} from './namedSessionChildOwner.js';
import {currentAcceptedSetupSessionScope, originalCodexSetupSessionSender} from './codexSetupSessionHandoff.js';
import {waitForNamedSessionStartup} from './namedSessionStartup.js';
import {observeNamedSessionStartupChild} from './namedSessionStartupChild.js';

const id = (n: number) => `${String(n).padStart(8, '0')}-1111-4111-8111-111111111111`;
// Actual caller declarations, with synthetic registry/OS readiness boundaries.
// The OS spawn boundary records exact argv/options, then creates C-only nodes.
async function fixture(t: {after(fn: () => Promise<void>): void}) {
  const workspace = await realpath(await mkdtemp(resolve(tmpdir(), 'dharma-process-caller-'))), now = Date.now();
  const hash = `sha256:${'a'.repeat(64)}`;
  const prepared = prepareCodexBootstrapHost({workspace, signal: new AbortController().signal, current: async () => true,
    intent: {schema: 'dharma.codex-setup-intent/v1', operationId: id(1), setupReference: id(2),
      organizationId: 'org_demo', recipientMembershipId: id(3), origin: 'https://hq.example',
      repositoryFingerprint: hash, policyRevision: 'policy-v1', scopeDigest: hash, contractDigest: hash,
      hostContextId: id(4), issuedAt: new Date(now - 1000).toISOString(), expiresAt: new Date(now + 60_000).toISOString()}});
  const entry = resolve(workspace, 'index.js'), policyPath = resolve(workspace, '.dharma', 'approved-policy.json');
  const item = {path: workspace, workspaceId: id(5), organizationId: 'org_demo', repositoryRemoteHash: hash};
  const children: ChildProcess[] = [], serviceChildren: ChildProcess[] = [], effects: string[] = [], spawnCalls: Array<{argv: string[]; options: Record<string, unknown>}> = [];
  let running = false, preexisting = false, withdrawInSpawn = false, withdrawInStatus = false;
  let container = false, withdrawInBackend = false, withdrawInContainerStart = false;
  let standingService = false, startupRegistered = true;
  let serviceUnavailable = false;
  t.after(async () => {
    await drainBootstrapHostChildren(prepared.scope);
    for (const child of children) await watchOwnedChild(child).stop({graceMs: 1000});
    for (const child of serviceChildren) await watchOwnedChild(child).stop({graceMs: 1000});
    await rm(workspace, {recursive: true, force: true});
  });
  const dependencies: Record<string, unknown> = {
    currentBootstrapHostScope, captureBootstrapHostChild, assertBootstrapHostSource, currentNamedSessionChildOwner, currentAcceptedSetupSessionScope,
    requestBootstrapNamedSession: async (scope: typeof prepared.scope) => originalCodexSetupSessionSender(scope),
    resolve, dirname, Error, Promise, Number, String, Date, VERSION: '0.2.153',
    process: {execPath: process.execPath, env: {}, platform: 'linux'},
    setTimeout: (done: () => void) => {queueMicrotask(done);}, waitForNamedSessionStartup, observeNamedSessionStartupChild,
    fileURLToPath: () => entry, dharmaHome: () => resolve(workspace, 'synthetic-home'),
    readDeviceConfig: async () => ({organizationId: 'org_demo', deviceId: id(6)}), registry: async () => [item],
    loadOrganizationPolicy: async () => ({serverAuthorization: {workspaceId: item.workspaceId}}),
    relayProcessState: async () => running || preexisting ? 'running' : 'stopped',
    relaySupervisorProcessState: async () => running || preexisting ? 'running' : 'stopped',
    relayAutostartStatus: async () => {
      if (withdrawInBackend) prepared.scope.close();
      return {backend: container ? 'container-entrypoint' : startupRegistered ? 'systemd-user' : null};
    },
    startRelayAutostart: async () => {
      if (serviceUnavailable) throw new Error('autostart_conflict: owned service unavailable');
      effects.push(container ? 'container_start' : 'user_service_start'); running = true;
      if (standingService) serviceChildren.push(spawn(process.execPath,
        ['-e', 'setInterval(() => {}, 1000)'], {cwd: workspace, stdio: 'ignore'}));
      if (withdrawInContainerStart) prepared.scope.close();
    },
    spawn: (_command: string, argv: string[], options: Record<string, unknown>) => {
      spawnCalls.push({argv, options}); effects.push('spawn');
      const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {cwd: workspace, stdio: 'ignore'});
      children.push(child); running = true;
      if (withdrawInSpawn) prepared.scope.close();
      return child;
    },
    readFile: async (path: string) => {
      if (path.endsWith('supervisor-workspace.json')) return JSON.stringify({pid: 101, version: '0.2.153',
        standardRepositories: true, organizationId: 'org_demo', deviceId: id(6)});
      if (path.endsWith('last-successful-poll.json')) return '{}';
      return '101';
    },
    repositoryRelayObservationReady: () => true,
    waitForRelayReadiness: async (input: {processState(): Promise<string>}) => ({state: await input.processState()}),
    required: (flags: Map<string, unknown>, name: string) => flags.get(name),
    namedSessionPaths: () => ({root: resolve(workspace, 'synthetic-home', 'sessions')}),
    repositoryRoleScope: () => ({endpointId: id(7), repositoryBindingId: id(8)}),
    readNamedSession: async () => null,
    verifyAgentFabricSkillInstallation: async () => ({}), repositorySharedReady: async () => true,
    verifyNamedSessionVisibleSkill: async () => {},
    saveNamedSession: async () => {effects.push('registration');},
    namedSessionRequest: async () => {
      effects.push('status');
      if (!running && !preexisting) throw new Error('not running');
      if (withdrawInStatus) prepared.scope.close();
      return {ok: true, state: 'running'};
    },
  };
  const baseline = process.env.DHARMA_RELAY_CALLER_BASELINE_SHA;
  if (baseline && !/^[a-f0-9]{40}$/.test(baseline)) throw new Error('relay_caller_baseline_invalid');
  const source = baseline ? (await promisify(execFile)('git', ['show', `${baseline}:packages/cli/src/index.ts`],
    {cwd: resolve(import.meta.dirname, '../../..'), maxBuffer: 4 * 1024 * 1024})).stdout
    : await readFile(new URL('../src/index.ts', import.meta.url), 'utf8');
  const ast = ts.createSourceFile('index.ts', source, ts.ScriptTarget.Latest, true);
  async function declaration(name: string) {
    const declarations = ast.statements.filter(node => ts.isFunctionDeclaration(node) && node.name?.text === name);
    assert.equal(declarations.length, 1);
    const compiled = ts.transpileModule(declarations[0]!.getText(ast), {compilerOptions: {
      target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.CommonJS}, reportDiagnostics: true});
    assert.equal(compiled.diagnostics?.filter(d => d.category === ts.DiagnosticCategory.Error).length, 0);
    return compileFunction(compiled.outputText.replaceAll('import.meta.url', '"file:///synthetic/index.js"')
      + `\nreturn ${name};`, ['exports', ...Object.keys(dependencies)])({}, ...Object.values(dependencies));
  }
  const relay = await declaration('startRelayDaemon'), session = await declaration('namedSessionCommand');
  const call = (kind: 'relay' | 'session') => runCodexBootstrapHostScope(prepared.scope, async () => kind === 'relay'
    ? relay(resolve(item.path, '.dharma', 'approved-policy.json'))
    : session('start', new Map<string, string | boolean>([['name', 'implementer'], ['workspace-id', item.workspaceId], ['apply', true]])));
  return {prepared, call, session, children, serviceChildren, effects, spawnCalls, item, workspace, entry, policyPath,
    useStandingService: () => {standingService = true;},
    denyStandingService: () => {serviceUnavailable = true;},
    withoutStartup: () => {startupRegistered = false;},
    legacyRelay: () => relay(policyPath),
    preexisting: () => {preexisting = true;}, cancelInSpawn: () => {withdrawInSpawn = true; withdrawInContainerStart = true;},
    cancelInStatus: () => {withdrawInStatus = true;}, useContainer: () => {container = true;},
    cancelInBackend: () => {withdrawInBackend = true;},
    cancelInContainerStart: () => {withdrawInContainerStart = true;}};
}

test('actual relay caller refuses container start after setup withdrawal during backend discovery', async t => {
  const f = await fixture(t); f.useContainer(); f.cancelInBackend();
  await assert.rejects(f.call('relay'), /codex_setup_host_scope_unavailable/);
  assert.equal(f.effects.includes('container_start'), false);
  assert.equal(f.children.length, 0);
});

test('actual relay caller withholds readiness after withdrawal inside admitted container start', async t => {
  const f = await fixture(t); f.useContainer(); f.cancelInContainerStart();
  await assert.rejects(f.call('relay'), /codex_setup_host_scope_unavailable/);
  assert.equal(f.effects.filter(effect => effect === 'container_start').length, 1);
  assert.equal(f.children.length, 0, 'a startup request is not adoption of the standing controller');
});

test('actual relay caller preserves an already running container-owned service without a start request', async t => {
  const f = await fixture(t); f.useContainer(); f.preexisting(); await f.call('relay');
  assert.equal(f.effects.includes('container_start'), false); assert.equal(f.children.length, 0);
});

test('actual relay caller requests its verified user service instead of spawning a setup-owned supervisor', async t => {
  const f = await fixture(t); f.useStandingService(); await f.call('relay');
  assert.equal(f.effects.filter(effect => effect === 'user_service_start').length, 1);
  assert.equal(f.spawnCalls.length, 0); assert.equal(f.children.length, 0);
  assert.equal(f.serviceChildren.length, 1);
  await drainBootstrapHostChildren(f.prepared.scope);
  assert.equal(f.serviceChildren[0]!.exitCode, null);
  assert.equal(f.serviceChildren[0]!.signalCode, null);
  // The fixture's service owner, not the setup scope, drains this handle in t.after.
});

test('actual relay caller refuses user service start after setup withdrawal during backend discovery', async t => {
  const f = await fixture(t); f.cancelInBackend();
  await assert.rejects(f.call('relay'), /codex_setup_host_scope_unavailable/);
  assert.equal(f.effects.includes('user_service_start'), false); assert.equal(f.spawnCalls.length, 0);
});

test('actual relay caller withholds readiness after withdrawal inside admitted user service start', async t => {
  const f = await fixture(t); f.cancelInContainerStart();
  await assert.rejects(f.call('relay'), /codex_setup_host_scope_unavailable/);
  assert.equal(f.effects.filter(effect => effect === 'user_service_start').length, 1);
  assert.equal(f.children.length, 0); assert.equal(f.spawnCalls.length, 0);
});

test('actual relay caller refuses an unavailable owned user service without detached fallback', async t => {
  const f = await fixture(t); f.denyStandingService();
  await assert.rejects(f.call('relay'), /autostart_conflict/);
  assert.equal(f.children.length, 0); assert.equal(f.spawnCalls.length, 0);
  assert.equal(f.effects.includes('user_service_start'), false);
});

test('actual legacy relay caller retains its unscoped detached supervisor startup', async t => {
  const f = await fixture(t); f.withoutStartup(); await f.legacyRelay();
  assert.equal(f.spawnCalls.length, 1); assert.equal(f.spawnCalls[0]!.options.detached, true);
  assert.equal(f.effects.includes('user_service_start'), false);
});

test('actual unscoped relay recovery uses its registered Linux owner instead of a detached supervisor', async t => {
  const f = await fixture(t); f.useStandingService(); await f.legacyRelay();
  assert.equal(f.effects.filter(effect => effect === 'user_service_start').length, 1);
  assert.equal(f.spawnCalls.length, 0); assert.equal(f.children.length, 0);
  assert.equal(f.serviceChildren.length, 1);
});

test('actual unscoped relay recovery cannot bypass a failed registered Linux owner', async t => {
  const f = await fixture(t); f.denyStandingService();
  await assert.rejects(f.legacyRelay(), /autostart_conflict/);
  assert.equal(f.spawnCalls.length, 0); assert.equal(f.children.length, 0);
});

for (const kind of ['relay'] as const) {
  test(`actual ${kind} caller uses its selected lifecycle owner on setup withdrawal`, async t => {
    const f = await fixture(t); await f.call(kind);
    assert.equal(f.effects.filter(effect => effect === 'user_service_start').length, 1);
    assert.equal(f.children.length, 0); assert.equal(f.spawnCalls.length, 0);
    await drainBootstrapHostChildren(f.prepared.scope);
  });

  test(`actual ${kind} caller preserves a preexisting service without acquiring its process`, async t => {
    const f = await fixture(t); f.preexisting(); await f.call(kind);
    await drainBootstrapHostChildren(f.prepared.scope);
    assert.equal(f.children.length, 0); assert.equal(f.spawnCalls.length, 0);
  });

  test(`actual ${kind} caller refuses completion after cancellation inside its admitted startup`, async t => {
    const f = await fixture(t); f.cancelInSpawn();
    await assert.rejects(f.call(kind), /^Error: codex_setup_host_scope_unavailable$/);
    await drainBootstrapHostChildren(f.prepared.scope);
    assert.equal(f.children.length, 0);
    assert.equal(f.effects.filter(effect => effect === 'user_service_start').length, 1);
  });

  test(`actual ${kind} caller refuses a foreign checkout before starting a process`, async t => {
    const f = await fixture(t); f.item.path = resolve(f.workspace, 'foreign');
    await assert.rejects(f.call(kind), /^Error: codex_setup_host_scope_unavailable$/);
    assert.equal(f.prepared.scope.signal.aborted, true);
    assert.equal(f.children.length, 0); assert.equal(f.spawnCalls.length, 0);
  });
}

test('actual session caller refuses a setup scope without its original private sender and acquires no child', async t => {
  const f = await fixture(t);
  await assert.rejects(f.call('session'), /^Error: setup_session_sender_unavailable$/);
  await drainBootstrapHostChildren(f.prepared.scope);
  assert.equal(f.children.length, 0); assert.equal(f.spawnCalls.length, 0);
  assert.deepEqual(f.effects, []);
});

test('actual session caller binds a fresh attached child to its standing supervisor and drains it at shutdown', async t => {
  const f = await fixture(t), signal = new AbortController(), owner = createNamedSessionChildOwner(signal.signal);
  await owner.run(async () => {
    await f.session('start', new Map<string, string | boolean>([['name', 'reviewer'], ['workspace-id', f.item.workspaceId], ['apply', true]]));
    assert.equal(f.children.length, 1); assert.equal(f.spawnCalls[0]!.options.detached, false);
    assert.equal(f.children[0]!.exitCode, null);
  });
  assert.ok(f.children[0]!.exitCode !== null || f.children[0]!.signalCode !== null);
});

test('actual session caller does not adopt a preexisting service into standing supervisor ownership', async t => {
  const f = await fixture(t); f.preexisting();
  await createNamedSessionChildOwner(new AbortController().signal).run(() => f.session('start',
    new Map<string, string | boolean>([['name', 'reviewer'], ['workspace-id', f.item.workspaceId], ['apply', true]])));
  assert.equal(f.children.length, 0); assert.equal(f.spawnCalls.length, 0);
});

test('actual session caller refuses overlapping setup and standing-supervisor authority before spawning', async t => {
  const f = await fixture(t);
  await assert.rejects(createNamedSessionChildOwner(new AbortController().signal).run(() => f.call('session')),
    /named_session_child_owner_conflict/);
  assert.equal(f.children.length, 0);
});
