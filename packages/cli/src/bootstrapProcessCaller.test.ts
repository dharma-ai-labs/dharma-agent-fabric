import assert from 'node:assert/strict';
import {spawn, type ChildProcess} from 'node:child_process';
import {mkdtemp, readFile, realpath, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname, resolve} from 'node:path';
import test from 'node:test';
import {compileFunction} from 'node:vm';
import ts from 'typescript';
import {assertBootstrapHostSource, captureBootstrapHostChild, currentBootstrapHostScope,
  drainBootstrapHostChildren, prepareCodexBootstrapHost, runCodexBootstrapHostScope} from './bootstrapHostScope.js';
import {watchOwnedChild} from './ownedChildLifecycle.js';

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
  const children: ChildProcess[] = [], effects: string[] = [], spawnCalls: Array<{argv: string[]; options: Record<string, unknown>}> = [];
  let running = false, preexisting = false, withdrawInSpawn = false, withdrawInStatus = false;
  t.after(async () => {
    await drainBootstrapHostChildren(prepared.scope);
    for (const child of children) await watchOwnedChild(child).stop({graceMs: 1000});
    await rm(workspace, {recursive: true, force: true});
  });
  const dependencies: Record<string, unknown> = {
    currentBootstrapHostScope, captureBootstrapHostChild, assertBootstrapHostSource,
    resolve, dirname, Error, Promise, Number, String, Date, VERSION: '0.2.153',
    process: {execPath: process.execPath, env: {}, platform: 'linux'},
    setTimeout: (done: () => void) => {queueMicrotask(done);},
    fileURLToPath: () => entry, dharmaHome: () => resolve(workspace, 'synthetic-home'),
    readDeviceConfig: async () => ({organizationId: 'org_demo', deviceId: id(6)}), registry: async () => [item],
    loadOrganizationPolicy: async () => ({serverAuthorization: {workspaceId: item.workspaceId}}),
    relayProcessState: async () => running || preexisting ? 'running' : 'stopped',
    relaySupervisorProcessState: async () => running || preexisting ? 'running' : 'stopped',
    relayAutostartStatus: async () => ({backend: 'systemd-user'}),
    startRelayAutostart: async () => {throw new Error('not this scoped spawn route');},
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
  const source = await readFile(new URL('../src/index.ts', import.meta.url), 'utf8');
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
  return {prepared, call, children, effects, spawnCalls, item, workspace, entry, policyPath,
    preexisting: () => {preexisting = true;}, cancelInSpawn: () => {withdrawInSpawn = true;},
    cancelInStatus: () => {withdrawInStatus = true;}};
}

for (const kind of ['relay', 'session'] as const) {
  test(`actual ${kind} caller captures only its scoped attached child and drains it on owner withdrawal`, async t => {
    const f = await fixture(t); await f.call(kind);
    assert.equal(f.children.length, 1); assert.equal(f.spawnCalls[0]!.options.detached, false);
    assert.equal(f.spawnCalls[0]!.options.cwd, f.workspace);
    assert.deepEqual(f.spawnCalls[0]!.argv, kind === 'relay'
      ? [f.entry, 'relay', 'supervise', '--policy', f.policyPath]
      : [f.entry, 'sessions', 'serve', '--name', 'implementer', '--workspace-id', f.item.workspaceId, '--apply']);
    assert.equal(f.children[0]!.exitCode, null); assert.equal(f.children[0]!.signalCode, null);
    await drainBootstrapHostChildren(f.prepared.scope);
    assert.ok(f.children[0]!.exitCode !== null || f.children[0]!.signalCode !== null);
  });

  test(`actual ${kind} caller preserves a preexisting service without acquiring its process`, async t => {
    const f = await fixture(t); f.preexisting(); await f.call(kind);
    await drainBootstrapHostChildren(f.prepared.scope);
    assert.equal(f.children.length, 0); assert.equal(f.spawnCalls.length, 0);
  });

  test(`actual ${kind} caller drains its child when cancellation occurs inside spawn`, async t => {
    const f = await fixture(t); f.cancelInSpawn();
    await assert.rejects(f.call(kind), /^Error: codex_setup_host_scope_unavailable$/);
    await drainBootstrapHostChildren(f.prepared.scope);
    assert.equal(f.children.length, 1);
    assert.ok(f.children[0]!.exitCode !== null || f.children[0]!.signalCode !== null);
  });

  test(`actual ${kind} caller refuses a foreign checkout before starting a process`, async t => {
    const f = await fixture(t); f.item.path = resolve(f.workspace, 'foreign');
    await assert.rejects(f.call(kind), /^Error: codex_setup_host_scope_unavailable$/);
    assert.equal(f.prepared.scope.signal.aborted, true);
    assert.equal(f.children.length, 0); assert.equal(f.spawnCalls.length, 0);
  });
}

test('actual session caller withholds status returned after setup withdrawal and drains its acquired child', async t => {
  const f = await fixture(t); f.cancelInStatus();
  await assert.rejects(f.call('session'), /^Error: codex_setup_host_scope_unavailable$/);
  await drainBootstrapHostChildren(f.prepared.scope);
  assert.equal(f.children.length, 1);
  assert.ok(f.children[0]!.exitCode !== null || f.children[0]!.signalCode !== null);
});
