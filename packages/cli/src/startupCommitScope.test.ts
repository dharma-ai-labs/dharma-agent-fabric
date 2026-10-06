import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {createHash, randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import test from 'node:test';
import {promisify} from 'node:util';
import {compileFunction} from 'node:vm';
import ts from 'typescript';
import {currentBootstrapHostScope, prepareCodexBootstrapHost, runCodexBootstrapHostScope} from './bootstrapHostScope.js';

const id = (n: number) => `${String(n).padStart(8, '0')}-1111-4111-8111-111111111111`;
type Phase = 'controller' | 'directory' | 'existing' | 'temporary' | 'commit' | 'registration' | 'status' | 'os';

// Whole production declarations, real lifetime fencing, synthetic OS/filesystem.
// No Docker, private store, native client, disk probe or real file mutation.
async function fixture(phase?: Phase, failure: 'withdraw' | 'identity' | 'expire' | 'error' = 'withdraw') {
  const workspace = resolve(tmpdir(), 'dharma-startup-commit-synthetic'), signal = new AbortController();
  const now = Date.now(), lifetime = failure === 'expire' ? 1500 : 60_000;
  let valid = true;
  const hash = `sha256:${'a'.repeat(64)}`;
  const prepared = prepareCodexBootstrapHost({workspace, signal: signal.signal, current: async () => valid,
    intent: {schema: 'dharma.codex-setup-intent/v1', operationId: id(1), setupReference: id(2),
      organizationId: 'org_demo', recipientMembershipId: id(3), origin: 'https://hq.example',
      repositoryFingerprint: hash, policyRevision: 'policy-v1', scopeDigest: hash, contractDigest: hash,
      hostContextId: id(4), issuedAt: new Date(now - 1000).toISOString(), expiresAt: new Date(now + lifetime).toISOString()}});
  const writes: string[] = [], commits: string[] = [], removals: string[] = [], commands: Array<[string, string[]]> = [];
  const stored = new Map<string, string>(), phases: Phase[] = [];
  const boundary = async (at: Phase) => {
    phases.push(at); await Promise.resolve();
    if (at !== phase) return;
    if (failure === 'withdraw') signal.abort();
    else if (failure === 'identity') valid = false;
    else if (failure === 'error') throw new Error('synthetic_commit_uncertain');
    else await new Promise(done => setTimeout(done, Math.max(1, now + lifetime - Date.now()) + 40));
  };
  const registration = {schema: 'dharma.relay-autostart/v3', backend: 'container-entrypoint',
    launcher: resolve(workspace, '.dharma', 'bin', 'dharma'), workspace,
    policy: resolve(workspace, '.dharma', 'approved-policy.json'), version: '0.2.153', taskName: null};
  const options = {home: resolve(workspace, 'private-home')};
  const dependencies: Record<string, unknown> = {
    currentBootstrapHostScope, createHash, randomUUID, join,
    privatePath: (home: string, name: string) => join(home, 'relay', name),
    privateDirectory: async () => boundary('directory'),
    privateJson: async () => boundary('existing'),
    containerEntrypointAvailable: async () => {await boundary('controller'); return true;},
    writeFile: async (path: string, bytes: string) => {writes.push(path); stored.set(path, bytes); await boundary('temporary');},
    rename: async (path: string, destination: string) => {
      commits.push(destination); stored.set(destination, stored.get(path)!); stored.delete(path); await boundary('commit');
    },
    rm: async (path: string) => {removals.push(path); stored.delete(path);},
    readRegistration: async () => {await boundary('registration'); return {...registration, backend: 'systemd-user'};},
    relayAutostartStatus: async () => {await boundary('status'); return {state: 'enabled'};},
    defaultRunner: async (file: string, args: string[]) => {commands.push([file, args]); await boundary('os'); return {stdout: ''};},
    unavailable: () => new Error('container_startup_unavailable'), UNIT_NAME: 'dharma-agent-fabric.service',
  };
  const baseline = process.env.DHARMA_STARTUP_COMMIT_BASELINE_SHA;
  if (baseline && !/^[a-f0-9]{40}$/.test(baseline)) throw new Error('startup_commit_baseline_invalid');
  const declaration = async (file: string, name: string) => {
    const source = baseline ? (await promisify(execFile)('git', ['show', `${baseline}:packages/cli/src/${file}`],
      {cwd: resolve(import.meta.dirname, '../../..'), maxBuffer: 1024 * 1024})).stdout
      : await readFile(new URL(`../src/${file}`, import.meta.url), 'utf8');
    const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
    const nodes = ast.statements.filter(node => ts.isFunctionDeclaration(node) && node.name?.text === name);
    assert.equal(nodes.length, 1);
    const compiled = ts.transpileModule(nodes[0]!.getText(ast), {compilerOptions: {
      target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.CommonJS}, reportDiagnostics: true});
    assert.equal(compiled.diagnostics?.filter(d => d.category === ts.DiagnosticCategory.Error).length, 0);
    return compileFunction(compiled.outputText + `\nreturn ${name};`, ['exports', ...Object.keys(dependencies)])({}, ...Object.values(dependencies));
  };
  dependencies.registrationHash = await declaration('containerRelayLifecycle.ts', 'registrationHash');
  dependencies.writePrivateJson = await declaration('containerRelayLifecycle.ts', 'writePrivateJson');
  const control = await declaration('containerRelayLifecycle.ts', 'containerStartupControl');
  dependencies.containerStartupControl = control;
  const start = await declaration('relayAutostart.ts', 'startRelayAutostart');
  return {prepared, phases, writes, commits, removals, commands, stored, options,
    cancel: () => signal.abort(),
    call: () => runCodexBootstrapHostScope(prepared.scope, () => control(options, registration, true)),
    legacy: () => control(options, registration, true),
    start: () => runCodexBootstrapHostScope(prepared.scope, () => start(options))};
}

test('startup commit retains one active scoped control with private temporary cleanup', async () => {
  const f = await fixture(); await f.call();
  assert.equal(f.writes.length, 1); assert.equal(f.commits.length, 1); assert.equal(f.removals.length, 1);
  assert.equal(f.stored.size, 1); assert.equal(JSON.parse(f.stored.get(f.commits[0]!)!).running, true);
});

for (const phase of ['controller', 'directory', 'existing'] as const) {
  test(`startup commit refuses withdrawal during ${phase} verification before any write`, async () => {
    const f = await fixture(phase);
    await assert.rejects(f.call(), /codex_setup_host_scope_unavailable/);
    assert.equal(f.writes.length, 0); assert.equal(f.commits.length, 0);
  });
}

test('startup commit refuses expired original authority after controller verification', async () => {
  const f = await fixture('controller', 'expire');
  await assert.rejects(f.call(), /codex_setup_host_scope_unavailable/);
  assert.equal(f.writes.length, 0); assert.equal(f.commits.length, 0);
});

test('startup commit refuses changed owner identity after controller verification', async () => {
  const f = await fixture('controller', 'identity');
  await assert.rejects(f.call(), /codex_setup_host_scope_unavailable/);
  assert.equal(f.writes.length, 0); assert.equal(f.commits.length, 0);
});

for (const failure of ['withdraw', 'identity'] as const) {
  test(`startup commit refuses ${failure} between temporary write and control rename`, async () => {
    const f = await fixture('temporary', failure);
    await assert.rejects(f.call(), /codex_setup_host_scope_unavailable/);
    assert.equal(f.writes.length, 1); assert.equal(f.commits.length, 0);
    assert.equal(f.removals.length, 1); assert.equal(f.stored.size, 0);
  });
}

test('startup commit does not turn an admitted rename with lost authority into rollback or success', async () => {
  const f = await fixture('commit');
  await assert.rejects(f.call(), /codex_setup_host_scope_unavailable/);
  assert.equal(f.commits.length, 1); assert.equal(f.stored.size, 1);
  assert.equal(JSON.parse(f.stored.get(f.commits[0]!)!).running, true);
});

test('startup commit preserves an uncertain commit error without replay or success', async () => {
  const f = await fixture('commit', 'error');
  await assert.rejects(f.call(), /synthetic_commit_uncertain/);
  assert.equal(f.commits.length, 1); assert.equal(f.stored.size, 1);
});

test('startup commit retains legacy unscoped control behavior', async () => {
  const f = await fixture(); await f.legacy(); assert.equal(f.commits.length, 1);
});

test('startup commit never dispatches verification after prior withdrawal', async () => {
  const f = await fixture(); f.cancel();
  await assert.rejects(f.call(), /codex_setup_host_scope_unavailable/);
  assert.equal(f.phases.length, 0); assert.equal(f.writes.length, 0);
});

for (const phase of ['registration', 'status'] as const) {
  test(`user startup refuses withdrawal during ${phase} readback before OS command`, async () => {
    const f = await fixture(phase);
    await assert.rejects(f.start(), /codex_setup_host_scope_unavailable/); assert.equal(f.commands.length, 0);
  });
}

test('user startup dispatches only the owned fixed service while original authority is current', async () => {
  const f = await fixture(); const result = await f.start() as {state: string};
  assert.deepEqual(f.commands, [['systemctl', ['--user', 'start', 'dharma-agent-fabric.service']]]);
  assert.equal(result.state, 'start_requested');
});

test('user startup withholds a late OS acknowledgement without claiming reversal', async () => {
  const f = await fixture('os'); await assert.rejects(f.start(), /codex_setup_host_scope_unavailable/);
  assert.equal(f.commands.length, 1);
});
