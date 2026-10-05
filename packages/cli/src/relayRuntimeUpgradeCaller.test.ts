import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import test from 'node:test';
import ts from 'typescript';
import { relayRuntimeObservationReady } from './relayRuntimeUpgrade.js';
import { verifyRecordedRepositoryLaunchers } from './repositoryLaunchers.js';

async function fixture() {
  const workspace = '/fixtures/repository', calls: string[] = [];
  const selected = { workspaceId: 'workspace', organizationId: 'org_fixture', deviceId: 'device', path: workspace };
  const startup = { workspace, version: '0.2.116', launcher: resolve(workspace, '.dharma', 'bin', 'dharma'),
    policy: resolve(workspace, '.dharma', 'approved-policy.json') };
  const deps: Record<string, unknown> = {
    readDeviceConfig: async () => ({ organizationId: selected.organizationId, deviceId: selected.deviceId }),
    registry: async () => [selected], selectDeviceWorkspace: () => selected,
    realpath: async (path: string) => path, dharmaHome: () => '/fixtures/profile', resolve, dirname,
    process: { platform: 'linux', execPath: '/fixtures/node/bin/node' },
    inspectOwnedRelayAutostart: async () => startup,
    relaySupervisorProcessState: async () => 'stopped', relayProcessState: async () => 'stopped',
    readdir: async () => [], pidProcessState: async () => 'stopped',
    VERSION: '0.2.118', stableRepositoryLauncherContents: (version: string) => ({ version }),
    withRelayStartupMutation: async (operation: () => Promise<unknown>) => { calls.push('lock'); return operation(); },
    upgradeRelayRuntime: async (_input: unknown, hooks: { assertStopped(): Promise<void>; inspectStartup(): Promise<unknown> }) => {
      await hooks.assertStopped(); await hooks.inspectStartup(); return { state: 'planned' };
    },
    enableRelayAutostart: async () => { calls.push('configure'); },
    startRelayAutostart: async () => { calls.push('start'); },
    stopRelayAutostart: async () => { calls.push('os_stop'); },
    relayStop: async () => { calls.push('relay_stop'); return { ok: true }; },
    validateContract: async () => ({ ok: true }),
    fileURLToPath, URL, relayRuntimeObservationReady, verifyRecordedRepositoryLaunchers,
    setTimeout: (callback: () => void) => { callback(); return 0; },
    readFile: async (path: string) => {
      const name = basename(path);
      if (name === 'supervisor.pid') return '123';
      if (name === 'relay.pid') return '456';
      if (name === 'supervisor-workspace.json') return JSON.stringify({ pid: 123, workspaceId: 'workspace', version: '0.2.118' });
      if (name === 'last-successful-poll.json') return JSON.stringify({ pid: 456, workspaceId: 'workspace', version: '0.2.118',
        at: new Date().toISOString() });
      throw new Error('unexpected fixture read');
    },
  };
  const sourceText = await readFile(fileURLToPath(new URL('../src/index.ts', import.meta.url)), 'utf8');
  const source = ts.createSourceFile('index.ts', sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const nodes = source.statements.filter(node => ts.isFunctionDeclaration(node) && node.name?.text === 'relayUpgrade');
  assert.equal(nodes.length, 1);
  const compiled = ts.transpileModule(nodes[0]!.getText(source).replaceAll('import.meta.url', JSON.stringify(import.meta.url)), {
    compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.None }, reportDiagnostics: true });
  assert.equal(compiled.diagnostics?.filter(item => item.category === ts.DiagnosticCategory.Error).length, 0);
  const run = () => runInNewContext(`${compiled.outputText}\nrelayUpgrade`, deps,
    { timeout: 1000, contextCodeGeneration: { strings: false, wasm: false } }) as
      (flags: Map<string, string | boolean>) => Promise<unknown>;
  return { run, deps, calls, startup, flags: new Map<string, string | boolean>([['workspace', workspace]]) };
}

test('actual upgrade caller blocks running relay and named service before mutations', async () => {
  for (const kind of ['relay', 'session']) {
    const f = await fixture();
    if (kind === 'relay') f.deps.relayProcessState = async () => 'running';
    else {
      f.deps.readdir = async () => [{ name: 'reviewer', isDirectory: () => true }];
      f.deps.pidProcessState = async () => 'running';
    }
    await assert.rejects(f.run()(f.flags), new RegExp(`relay_upgrade_${kind === 'relay' ? 'runtime' : 'session'}_busy`));
    assert.deepEqual(f.calls, ['lock']);
  }
});

test('actual upgrade caller binds the reviewed recorded-runtime verifier without bypassing identity checks', async () => {
  const f = await fixture();
  f.deps.upgradeRelayRuntime = async (_input: unknown, hooks: { verifyPriorLaunchers: unknown }) => {
    assert.equal(hooks.verifyPriorLaunchers, verifyRecordedRepositoryLaunchers);
    return { state: 'planned' };
  };
  await f.run()(f.flags);
  assert.deepEqual(f.calls, ['lock']);
});

test('actual upgrade caller requires matching enrollment workspace and owned startup', async () => {
  const f = await fixture();
  f.startup.workspace = '/fixtures/other';
  await assert.rejects(f.run()(f.flags), /workspace_conflict/);
  assert.deepEqual(f.calls, []);
});

test('actual upgrade caller rechecks startup authority after obtaining the mutation lock', async () => {
  const f = await fixture();
  let read = 0;
  f.deps.inspectOwnedRelayAutostart = async () => ++read === 1 ? f.startup
    : { ...f.startup, policy: '/fixtures/unauthorized.json' };
  await assert.rejects(f.run()(f.flags), /workspace_conflict/);
  assert.deepEqual(f.calls, ['lock']);
});

test('actual rollback caller never stops a receiver while work holds an activation lease', async () => {
  const f = await fixture();
  f.flags.set('rollback', true);
  f.deps.readdir = async (path: string) => path.endsWith('skill-activation-locks') ? ['lease.lock'] : [];
  f.deps.pidProcessState = async () => 'running';
  f.deps.upgradeRelayRuntime = async (_input: unknown, hooks: { stop(): Promise<void> }) => hooks.stop();
  await assert.rejects(f.run()(f.flags), /work_in_progress/);
  assert.deepEqual(f.calls, ['lock']);
});

test('actual rollback caller rejects a running named session before either owned stop control', async () => {
  const f = await fixture();
  f.flags.set('rollback', true);
  f.deps.readdir = async (path: string) => path.endsWith('sessions')
    ? [{ name: 'reviewer', isDirectory: () => true }] : [];
  f.deps.pidProcessState = async () => 'running';
  f.deps.upgradeRelayRuntime = async (_input: unknown, hooks: { stop(): Promise<void> }) => hooks.stop();
  await assert.rejects(f.run()(f.flags), /session_busy/);
  assert.deepEqual(f.calls, ['lock']);
});

test('actual upgrade caller observes current receiver identity instead of invoking a probe', async () => {
  const f = await fixture();
  f.deps.relayProcessState = f.deps.relaySupervisorProcessState = async () => 'running';
  f.deps.upgradeRelayRuntime = async (_input: unknown, hooks: { verify(version: string, since: string): Promise<void> }) => {
    await hooks.verify('0.2.118', new Date(Date.now() - 1000).toISOString()); return { state: 'completed' };
  };
  f.deps.probeRelayConnection = () => { throw new Error('probe must not count as runtime upgrade'); };
  assert.deepEqual(JSON.parse(JSON.stringify(await f.run()(f.flags))), { state: 'completed' });
});

test('actual upgrade caller rejects an old receiver even when the invoked CLI is newer', async () => {
  const f = await fixture();
  f.deps.relayProcessState = f.deps.relaySupervisorProcessState = async () => 'running';
  const read = f.deps.readFile as (path: string) => Promise<string>;
  f.deps.readFile = async (path: string) => (await read(path)).replaceAll('0.2.118', '0.2.116');
  f.deps.upgradeRelayRuntime = async (_input: unknown, hooks: { verify(version: string, since: string): Promise<void> }) => {
    await hooks.verify('0.2.118', new Date(Date.now() - 1000).toISOString());
  };
  await assert.rejects(f.run()(f.flags), /receiver_unconfirmed/);
});
