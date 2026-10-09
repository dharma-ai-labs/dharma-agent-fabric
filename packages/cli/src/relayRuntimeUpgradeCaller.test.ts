import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import test from 'node:test';
import ts from 'typescript';
import { relayRuntimeObservationReady, upgradeRelayRuntime } from './relayRuntimeUpgrade.js';
import { stableRepositoryLauncherContents, verifyRecordedRepositoryLaunchers, verifyRollbackRepositoryLaunchers } from './repositoryLaunchers.js';
import { enableRelayAutostart } from './relayAutostart.js';

async function fixture() {
  const workspace = '/fixtures/repository', calls: string[] = [];
  const selected = { workspaceId: 'workspace', organizationId: 'org_fixture', deviceId: 'device', path: workspace };
  const startup = { workspace, version: '0.2.116', launcher: resolve(workspace, '.dharma', 'bin', 'dharma'),
    policy: resolve(workspace, '.dharma', 'approved-policy.json') };
  const deps: Record<string, unknown> = {
    readDeviceConfig: async () => ({ organizationId: selected.organizationId, deviceId: selected.deviceId }),
    registry: async () => [selected], selectDeviceWorkspace: () => selected,
    realpath: async (path: string) => path, dharmaHome: () => '/fixtures/profile', resolve, dirname,
    process: { platform: 'linux', execPath: '/fixtures/node/bin/node', env: {CODEX_HOME: '/fixtures/selected-codex'} },
    inspectOwnedRelayAutostart: async () => startup,
    relaySupervisorProcessState: async () => 'stopped', relayProcessState: async () => 'stopped',
    readdir: async () => [], pidProcessState: async () => 'stopped',
    VERSION: '0.2.118', stableRepositoryLauncherContents: (version: string) => ({ version }),
    resolveRepositoryNpmCli: async () => '/fixtures/npm/bin/npm-cli.js',
    withRelayStartupMutation: async (operation: () => Promise<unknown>) => { calls.push('lock'); return operation(); },
    upgradeRelayRuntime: async (_input: unknown, hooks: { assertStopped(): Promise<void>; inspectStartup(): Promise<unknown> }) => {
      await hooks.assertStopped(); await hooks.inspectStartup(); return { state: 'planned' };
    },
    enableRelayAutostart: async () => { calls.push('configure'); },
    startRelayAutostart: async () => { calls.push('start'); },
    stopRelayAutostart: async () => { calls.push('os_stop'); },
    relayStop: async () => { calls.push('relay_stop'); return { ok: true }; },
    validateContract: async () => ({ ok: true }),
    fileURLToPath, URL, relayRuntimeObservationReady, verifyRecordedRepositoryLaunchers, verifyRollbackRepositoryLaunchers,
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

test('actual Linux upgrade records npm while rollback does not require a replacement npm installation', async () => {
  const f = await fixture();
  let resolutions = 0;
  f.deps.resolveRepositoryNpmCli = async () => {resolutions++; return '/fixtures/npm/bin/npm-cli.js';};
  f.deps.stableRepositoryLauncherContents = (_version: string, runtime?: {npmCliPath?: string}) => ({runtime});
  f.deps.upgradeRelayRuntime = async (_input: unknown, hooks: {launcherContents(version: string): {runtime?: {npmCliPath?: string}}}) => {
    assert.equal(hooks.launcherContents('0.2.118').runtime?.npmCliPath,
      f.flags.has('rollback') ? undefined : '/fixtures/npm/bin/npm-cli.js');
    return {state: 'planned'};
  };
  await f.run()(f.flags);
  assert.equal(resolutions, 1);
  f.flags.set('rollback', true);
  await f.run()(f.flags);
  assert.equal(resolutions, 1);
});

test('actual Linux caller and real runtime journal restore exact bytes on a fresh rollback without npm resolution',
  {skip: process.platform !== 'linux'}, async t => {
    const f = await fixture(), root = await realpath(await mkdtemp(resolve(tmpdir(), 'dharma-real-upgrade-caller-')));
    t.after(() => rm(root, {recursive: true, force: true}));
    const workspace = resolve(root, 'repo'), home = resolve(root, 'profile'), bin = resolve(workspace, '.dharma', 'bin');
    const npmRoot = resolve(root, 'npm'), npmCliPath = resolve(npmRoot, 'bin', 'npm-cli.js');
    await mkdir(bin, {recursive: true}); await mkdir(dirname(npmCliPath), {recursive: true, mode: 0o700});
    await writeFile(npmCliPath, 'synthetic npm', {mode: 0o600});
    await writeFile(resolve(npmRoot, 'package.json'), JSON.stringify({name: 'npm', bin: {npm: 'bin/npm-cli.js'}}), {mode: 0o600});
    const previous = stableRepositoryLauncherContents('0.2.177', {platform: 'linux', nodeDirectory: dirname(process.execPath)});
    await writeFile(resolve(bin, 'dharma'), previous.shell); await writeFile(resolve(bin, 'dharma.cmd'), previous.windows);
    const selected = {workspaceId: '22222222-2222-4222-8222-222222222222', organizationId: 'org_fixture',
      deviceId: '11111111-1111-4111-8111-111111111111', path: workspace};
    Object.assign(f.startup, {workspace, version: '0.2.177', launcher: resolve(bin, 'dharma'),
      policy: resolve(workspace, '.dharma', 'approved-policy.json')});
    let running = false, resolutions = 0;
    Object.assign(f.deps, {
      process: {platform: 'linux', execPath: process.execPath, env: {}}, VERSION: '0.2.178',
      dharmaHome: () => home, registry: async () => [selected], selectDeviceWorkspace: () => selected,
      readDeviceConfig: async () => ({organizationId: selected.organizationId, deviceId: selected.deviceId}),
      stableRepositoryLauncherContents, upgradeRelayRuntime,
      resolveRepositoryNpmCli: async () => {resolutions++; return npmCliPath;},
      enableRelayAutostart: async (input: {version: string}) => {f.startup.version = input.version;},
      startRelayAutostart: async () => {running = true;}, stopRelayAutostart: async () => {running = false;},
      relayStop: async () => ({ok: true}),
      relayProcessState: async () => running ? 'running' : 'stopped',
      relaySupervisorProcessState: async () => running ? 'running' : 'stopped',
      readFile: async (path: string) => {
        if (basename(path) === 'supervisor.pid') return '123';
        if (basename(path) === 'relay.pid') return '456';
        if (basename(path) === 'supervisor-workspace.json') return JSON.stringify({pid: 123,
          workspaceId: selected.workspaceId, version: f.startup.version});
        if (basename(path) === 'last-successful-poll.json') return JSON.stringify({pid: 456,
          workspaceId: selected.workspaceId, version: f.startup.version, at: new Date().toISOString()});
        throw new Error('unexpected read');
      },
    });
    f.flags.set('workspace', workspace); f.flags.set('apply', true);
    assert.equal((await f.run()(f.flags) as {state: string}).state, 'completed');
    assert.equal(resolutions, 1);
    f.deps.resolveRepositoryNpmCli = async () => {throw new Error('replacement npm must not be resolved');};
    f.flags.set('rollback', true);
    assert.equal((await f.run()(f.flags) as {state: string}).state, 'rolled_back');
    assert.equal(await readFile(resolve(bin, 'dharma'), 'utf8'), previous.shell);
    assert.equal(await readFile(resolve(bin, 'dharma.cmd'), 'utf8'), previous.windows);
    assert.equal(f.startup.version, '0.2.177');
  });

test('actual upgrade caller retains the selected profile and passes only verified rollback context to startup', async () => {
  const f = await fixture();
  const contexts: Array<{codexHome?: string; restoreCodexHome?: string | null}> = [];
  f.deps.enableRelayAutostart = async (input: {codexHome?: string; restoreCodexHome?: string | null}) => {contexts.push(input);};
  f.deps.upgradeRelayRuntime = async (_input: unknown, hooks: {
    configureStartup(version: string, restore?: {codexHome: string | null}): Promise<unknown>;
  }) => {
    await hooks.configureStartup('0.2.118');
    await hooks.configureStartup('0.2.116', {codexHome: null});
    return {state: 'planned'};
  };
  await f.run()(f.flags);
  assert.equal(contexts[0]!.codexHome, '/fixtures/selected-codex');
  assert.equal(Object.hasOwn(contexts[0]!, 'restoreCodexHome'), false);
  assert.equal(contexts[1]!.restoreCodexHome, null);
  assert.equal(Object.hasOwn(contexts[1]!, 'codexHome'), false);
});

test('actual rollback caller and startup writer restore context-free legacy bytes despite ambient CODEX_HOME',
  {skip: process.platform !== 'linux'}, async () => {
    const f = await fixture();
    const root = await mkdtemp(resolve(tmpdir(), 'dharma-legacy-caller-'));
    const home = resolve(root, 'profile');
    const run = async () => ({stdout: 'enabled\n'});
    try {
      await enableRelayAutostart({platform: 'linux', home, userHome: root, ...f.startup, run});
      const unit = resolve(root, '.config', 'systemd', 'user', 'dharma-agent-fabric.service');
      const receipt = resolve(home, 'relay', 'autostart.json');
      const before = await Promise.all([readFile(unit), readFile(receipt)]);
      f.deps.dharmaHome = () => home;
      f.deps.enableRelayAutostart = async (input: Parameters<typeof enableRelayAutostart>[0]) =>
        enableRelayAutostart({...input, userHome: root, run});
      f.deps.upgradeRelayRuntime = async (_input: unknown, hooks: {
        configureStartup(version: string, restore?: {codexHome: string | null}): Promise<unknown>;
      }) => {
        await hooks.configureStartup(f.startup.version, {codexHome: null});
        return {state: 'rolled_back'};
      };
      await f.run()(f.flags);
      assert.deepEqual(await Promise.all([readFile(unit), readFile(receipt)]), before);
      assert.doesNotMatch((await readFile(unit)).toString(), /CODEX_HOME/);
    } finally { await rm(root, {recursive: true, force: true}); }
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
