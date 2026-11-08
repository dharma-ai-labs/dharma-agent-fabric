import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import test from 'node:test';
import ts from 'typescript';
import { relayRuntimeObservationReady, upgradeRelayRuntime } from './relayRuntimeUpgrade.js';
import { protectedSetUpProviderDirectories, providerDirectoriesInPathOrder, recordSetUpProviderDirectories, stableRepositoryLauncherContents, verifyRecordedRepositoryLaunchers, verifyRollbackRepositoryLaunchers } from './repositoryLaunchers.js';
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
    lstat:async()=>{throw Object.assign(Error('absent fixture lock'),{code:'ENOENT'});},
    VERSION: '0.2.118', stableRepositoryLauncherContents: (version: string) => ({ version }),
    resolveRepositoryNpmCli: async () => '/fixtures/npm/bin/npm-cli.js',
    providerProcessEnvironment: (source: NodeJS.ProcessEnv) => source, providerHintFromEnvironment: () => null,
    parseSelectedProviderIds: (values: string[]) => values.length ? values : null,
    resolveRepositoryProviderDirectory: async () => '/fixtures/codex/bin', providersHoldingInstalledBundle: async () => [],
    protectedSetUpProviderDirectories: async () => [], recordSetUpProviderDirectories: async () => {},
    // The core of PR #425 records no providers on the workspace; upgrade never writes the record.
    saveWorkspaceRecord: async () => { throw new Error('unexpected workspace record write'); },
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
    providerDirectoriesInPathOrder,
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
  // The bundle-holder helper it calls runs as written; its filesystem and PATH readers stay fixtures.
  const helpers = source.statements.filter(node => ts.isFunctionDeclaration(node)
    && ['protectedBundleHolders', 'currentLauncherProviders'].includes(node.name?.text ?? ''))
    .map(node => node.getText(source).replace(/^export\s+/, ''));
  const compiled = ts.transpileModule([nodes[0]!.getText(source).replaceAll('import.meta.url', JSON.stringify(import.meta.url)),
    ...helpers].join('\n'), {
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
  const f = await fixture(), bound: unknown[] = [];
  f.deps.verifyRecordedRepositoryLaunchers = async (...input: unknown[]) => { bound.push(input); return false; };
  f.deps.upgradeRelayRuntime = async (_input: unknown, hooks: { verifyPriorLaunchers(version: string, launchers: unknown): Promise<boolean> }) => {
    assert.equal(await hooks.verifyPriorLaunchers('0.2.116', {shell: 'fixture'}), false);
    return { state: 'planned' };
  };
  await f.run()(f.flags);
  assert.deepEqual(f.calls, ['lock']);
  assert.deepEqual(JSON.parse(JSON.stringify(bound)), [['0.2.116', {shell: 'fixture'}, {platform: 'linux', nodePath: '/fixtures/node/bin/node'}]]);
});

test('actual Linux upgrade records npm while rollback does not require a replacement npm installation', async () => {
  const f = await fixture();
  let resolutions = 0;
  let codexResolutions = 0;
  f.deps.resolveRepositoryNpmCli = async () => {resolutions++; return '/fixtures/npm/bin/npm-cli.js';};
  f.deps.resolveRepositoryProviderDirectory = async () => {codexResolutions++; return '/fixtures/codex/bin';};
  f.deps.stableRepositoryLauncherContents = (_version: string, runtime?: {npmCliPath?: string; providerDirectory?: string[]}) => ({runtime});
  f.deps.upgradeRelayRuntime = async (_input: unknown, hooks: {launcherContents(version: string): {runtime?: {npmCliPath?: string; providerDirectory?: string[]}}}) => {
    assert.equal(hooks.launcherContents('0.2.118').runtime?.npmCliPath,
      f.flags.has('rollback') ? undefined : '/fixtures/npm/bin/npm-cli.js');
    assert.deepEqual(JSON.parse(JSON.stringify(hooks.launcherContents('0.2.118').runtime?.providerDirectory ?? null)),
      f.flags.has('rollback') ? null : ['/fixtures/codex/bin']);
    return {state: 'planned'};
  };
  await f.run()(f.flags);
  assert.equal(resolutions, 1);
  assert.equal(codexResolutions, 1);
  f.flags.set('rollback', true);
  await f.run()(f.flags);
  assert.equal(resolutions, 1);
  assert.equal(codexResolutions, 1);
});

test('actual Linux caller and real runtime journal restore exact bytes on a fresh rollback without npm resolution',
  {skip: process.platform !== 'linux'}, async t => {
    for (const fixedPrevious of [false, true]) {
    const f = await fixture(), root = await realpath(await mkdtemp(resolve(tmpdir(), 'dharma-real-upgrade-caller-')));
    t.after(() => rm(root, {recursive: true, force: true}));
    const workspace = resolve(root, 'repo'), home = resolve(root, 'profile'), bin = resolve(workspace, '.dharma', 'bin');
    const npmRoot = resolve(root, 'npm'), npmCliPath = resolve(npmRoot, 'bin', 'npm-cli.js');
    await mkdir(bin, {recursive: true}); await mkdir(dirname(npmCliPath), {recursive: true, mode: 0o700});
    await writeFile(npmCliPath, 'synthetic npm', {mode: 0o600});
    await writeFile(resolve(npmRoot, 'package.json'), JSON.stringify({name: 'npm', bin: {npm: 'bin/npm-cli.js'}}), {mode: 0o600});
    const initialVersion = fixedPrevious ? '0.2.178' : '0.2.177', targetVersion = fixedPrevious ? '0.2.179' : '0.2.178';
    const previousNpm = resolve(root, 'previous-npm', 'bin', 'npm-cli.js');
    if (fixedPrevious) {
      await mkdir(dirname(previousNpm), {recursive: true, mode: 0o700});
      await writeFile(previousNpm, 'synthetic old npm', {mode: 0o600});
      await writeFile(resolve(dirname(dirname(previousNpm)), 'package.json'),
        JSON.stringify({name: 'npm', bin: {npm: 'bin/npm-cli.js'}}), {mode: 0o600});
    }
    const previous = stableRepositoryLauncherContents(initialVersion, {platform: 'linux', nodeDirectory: dirname(process.execPath),
      ...(fixedPrevious ? {npmCliPath: previousNpm} : {})});
    await writeFile(resolve(bin, 'dharma'), previous.shell); await writeFile(resolve(bin, 'dharma.cmd'), previous.windows);
    const selected = {workspaceId: '22222222-2222-4222-8222-222222222222', organizationId: 'org_fixture',
      deviceId: '11111111-1111-4111-8111-111111111111', path: workspace};
    Object.assign(f.startup, {workspace, version: initialVersion, launcher: resolve(bin, 'dharma'),
      policy: resolve(workspace, '.dharma', 'approved-policy.json')});
    let running = false, resolutions = 0;
    Object.assign(f.deps, {
      process: {platform: 'linux', execPath: process.execPath, env: {}}, VERSION: targetVersion,
      dharmaHome: () => home, registry: async () => [selected], selectDeviceWorkspace: () => selected,
      readDeviceConfig: async () => ({organizationId: selected.organizationId, deviceId: selected.deviceId}),
      stableRepositoryLauncherContents, upgradeRelayRuntime,
      resolveRepositoryNpmCli: async () => {resolutions++; return npmCliPath;},
      resolveRepositoryProviderDirectory: async () => undefined,
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
    assert.equal(f.startup.version, initialVersion);
    }
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

test('actual caller dispatches only the explicit maintenance mode and validates its distinct receipt',async()=>{
  const f=await fixture();f.flags.set('stage-signing-maintenance',true);let schema='';
  f.deps.readdir=async()=>[{name:'original',isDirectory:()=>true}];
  f.deps.readNamedSession=async()=>({enabled:false,identity:{organizationId:'org_fixture',deviceId:'device',workspaceId:'workspace'}});
  f.deps.upgradeRelayForSigningMaintenance=async(input:{finish:boolean;dryRun:boolean},hooks:{assertNamedDisabled():Promise<void>})=>{
    assert.equal(input.finish,false);assert.equal(input.dryRun,true);await hooks.assertNamedDisabled();return{state:'planned'};};
  f.deps.upgradeRelayRuntime=async()=>{throw Error('ordinary upgrade must not run');};
  f.deps.validateContract=async(_root:string,id:string)=>{schema=id;return{ok:true};};
  assert.deepEqual(JSON.parse(JSON.stringify(await f.run()(f.flags))),{state:'planned'});
  assert.equal(schema,'https://schemas.dharma-ai.io/local-signing-maintenance-upgrade/v1');assert.deepEqual(f.calls,['lock']);
});

test('actual maintenance caller refuses conflicting options before enrollment reads',async()=>{
  for(const entries of[
    [['stage-signing-maintenance',true],['finish-signing-maintenance',true]],
    [['stage-signing-maintenance',true],['rollback',true]],
    [['stage-signing-maintenance','false']],
    [['stage-signing-maintenance',true],['apply','false']],
    [['stage-signing-maintenance',true],['dry-run','false']],
    [['previous-upgrade-sha256','sha256:public']]
  ]as Array<Array<[string,string|boolean]>>){
    const f=await fixture();for(const[key,value]of entries)f.flags.set(key,value);
    f.deps.readDeviceConfig=()=>{throw Error('enrollment read must not occur');};
    await assert.rejects(f.run()(f.flags),/maintenance_options_invalid/);assert.deepEqual(f.calls,[]);
  }
});

test('actual maintenance caller refuses enabled, foreign or stale-lock named registration before staging',async()=>{
  for(const mode of['enabled','foreign','absent','dead-lock']){
    const f=await fixture();f.flags.set('stage-signing-maintenance',true);
    f.deps.readdir=async()=>mode==='absent'?[]:[{name:'original',isDirectory:()=>true}];
    f.deps.readNamedSession=async()=>({enabled:mode==='enabled',identity:{organizationId:'org_fixture',deviceId:mode==='foreign'?'other':'device',workspaceId:'workspace'}});
    if(mode==='dead-lock')f.deps.lstat=async()=>({isFile:()=>true});
    f.deps.upgradeRelayForSigningMaintenance=async(_input:unknown,hooks:{assertNamedDisabled():Promise<void>})=>hooks.assertNamedDisabled();
    await assert.rejects(f.run()(f.flags),/session_scope_unavailable|session_lock_requires_reconciliation/);assert.deepEqual(f.calls,['lock']);
  }
});

test('actual maintenance finish checks newer verified trust and the same protected enrollment anchor',async()=>{
  for(const failure of['none','generation','device','signature','anchor']){
    const f=await fixture();f.flags.set('finish-signing-maintenance',true);f.flags.set('apply',true);let reads=0;
    f.deps.readDeviceConfig=async()=>({organizationId:'org_fixture',deviceId:failure==='device'&&reads++>0?'other':'device',
      serverSigningKeyset:{generation:failure==='generation'?2:3},serverPublicKeyEd25519:'SYNTHETIC_PUBLIC'});
    f.deps.validateTrustedServerSigningKeysetContract=()=>({ok:true});f.deps.createPublicKey=()=>({});
    f.deps.verifyInitialServerSigningKeyset=()=>({ok:failure!=='signature'});
    f.deps.loadDeviceEnrollmentAnchor=async(input:{readOnly:boolean})=>{f.calls.push('anchor');assert.equal(input.readOnly,true);if(failure==='anchor')throw Error('anchor mismatch');};
    f.deps.upgradeRelayForSigningMaintenance=async(_input:unknown,hooks:{assertRecoveredTrust(previous:number):Promise<void>})=>{
      await hooks.assertRecoveredTrust(2);return{state:'completed'};};
    if(failure==='none'){await f.run()(f.flags);assert.deepEqual(f.calls,['lock','anchor']);}
    else{await assert.rejects(f.run()(f.flags),/trust_not_recovered|anchor mismatch/);
      assert.deepEqual(f.calls,failure==='anchor'?['lock','anchor']:['lock']);}
  }
});

// F13 C1 (2026-11-06): an existing install gets the provider bin directory through relay upgrade.
test('actual upgrade resolves the bin directory of --provider, else the calling agent, else codex', async () => {
  for (const [flag, hint, expected] of [
    ['claude', 'codex', 'claude'], [undefined, 'claude', 'claude'], [undefined, null, 'codex'],
  ] as const) {
    const f = await fixture(), requested: string[] = [];
    f.deps.providerHintFromEnvironment = () => hint;
    f.deps.resolveRepositoryProviderDirectory = async (input: {provider: string}) => {requested.push(input.provider); return undefined;};
    if (flag) f.flags.set('provider', flag);
    await f.run()(f.flags);
    assert.deepEqual(requested, [expected], `${flag} ${hint}`);
  }
});

// PR #425 review round 5 (1): with codex holding the 0.2.223 bundle and Claude Code calling, the holder was chosen
// over the calling agent, so the launcher carried only codex and the relay still could not reach claude. The relay
// serves every adapter, so the launcher carries the protected holders and the provider this upgrade is for.
test('actual upgrade keeps the protected bundle holders on the launcher PATH beside the provider it is for', async () => {
  for (const [flag, holders, hint, codexProtected, expected] of [
    [undefined, ['codex'], 'claude', true, ['codex', 'claude']],
    [undefined, ['claude'], 'codex', true, ['claude', 'codex']],
    ['claude', ['codex'], 'codex', true, ['codex', 'claude']],
    [undefined, ['codex'], 'claude', false, ['claude']],
    [undefined, ['claude'], null, true, ['claude', 'codex']],
  ] as const) {
    const f = await fixture(), resolved: string[] = [], label = `${flag} ${holders} ${hint} ${codexProtected}`;
    f.deps.providerHintFromEnvironment = () => hint;
    f.deps.providersHoldingInstalledBundle = async () => [...holders];
    f.deps.resolveRepositoryProviderDirectory = async (input: {provider: string}) => {
      resolved.push(input.provider);
      if (input.provider === 'codex' && !codexProtected) throw new Error('relay_startup_codex_path_invalid');
      return `/fixtures/${input.provider}/bin`;
    };
    f.deps.stableRepositoryLauncherContents = (_version: string, runtime?: {providerDirectory?: unknown}) => ({runtime});
    let launcher: unknown, verified: unknown;
    f.deps.verifyRollbackRepositoryLaunchers = async (_version: string, _launchers: unknown, provider?: unknown) => {
      verified = provider; return true; };
    f.deps.upgradeRelayRuntime = async (_input: unknown, hooks: {launcherContents(version: string): {runtime?: {providerDirectory?: unknown}};
      verifyNextLaunchers?(version: string, launchers: unknown): Promise<boolean>}) => {
      launcher = hooks.launcherContents('0.2.118').runtime?.providerDirectory;
      await hooks.verifyNextLaunchers?.('0.2.118', {});
      return {state: 'completed'};
    };
    f.flags.set('apply', true);
    if (flag) f.flags.set('provider', flag);
    await f.run()(f.flags);
    assert.deepEqual(JSON.parse(JSON.stringify(launcher)), expected.map(provider => `/fixtures/${provider}/bin`), label);
    assert.deepEqual(JSON.parse(JSON.stringify(verified)), expected, `${label}: the written launcher is checked for them`);
    if (!codexProtected) assert.equal(resolved.filter(item => item === 'codex').length, 1,
      'an unprotected holder is checked once and never resolved for the launcher');
  }
});

// PR #425 review (4), narrowed in round 2: the launcher this run writes is checked for the set-up provider. The
// launchers already recorded (prior bytes, journal next) were written for whichever provider was known then.
test('actual upgrade binds the set-up provider only into verification of the launcher it writes', async () => {
  const f = await fixture(), verified: unknown[] = [];
  f.deps.providerHintFromEnvironment = () => 'claude';
  f.deps.verifyRecordedRepositoryLaunchers = async (_version: string, _launchers: unknown, runtime: {provider?: string}) => {
    verified.push(['prior', runtime.provider ?? null]); return true; };
  f.deps.verifyRollbackRepositoryLaunchers = async (_version: string, _launchers: unknown, provider?: unknown) => {
    verified.push(['recorded', provider ?? null]); return true; };
  f.deps.upgradeRelayRuntime = async (_input: unknown, hooks: {verifyPriorLaunchers(version: string, launchers: unknown): Promise<boolean>;
    verifyRecoveryLaunchers(version: string, launchers: unknown): Promise<boolean>;
    verifyNextLaunchers?(version: string, launchers: unknown): Promise<boolean>}) => {
    await hooks.verifyPriorLaunchers('0.2.118', {}); await hooks.verifyRecoveryLaunchers('0.2.118', {});
    await hooks.verifyNextLaunchers?.('0.2.118', {});
    return {state: 'planned'};
  };
  await f.run()(f.flags);
  assert.deepEqual(JSON.parse(JSON.stringify(verified)), [['prior', null], ['recorded', null], ['recorded', ['claude']]]);
});

test('relay upgrade usage and the unsafe PATH error name --provider', async () => {
  const {CLI_USAGE} = await import('./usage.js');
  assert.match(CLI_USAGE, /relay upgrade --workspace <owned-checkout> \[--provider <codex\|claude\|agy\|hermes>\]/);
  const source = await readFile(fileURLToPath(new URL('../src/repositoryLaunchers.ts', import.meta.url)), 'utf8');
  assert.match(source, /const unsafeProviderOnPath = [^;]*--provider/);
});

// CLI 0.2.224 review R1: codex set up with its shared package still pending holds no bundle, so a Claude Code relay
// upgrade wrote a launcher without codex, which then never came back. 0.2.223 always carried codex. The upgrade keeps
// each protected provider directory this device recorded for the current launcher, never one read from the working
// tree (K1), checks the launcher it writes for that provider, and records the new directories once it completes.
test('actual upgrade keeps the protected provider directories this device recorded for the current launcher', async () => {
  for (const [apply, state, rollback] of [[true, 'completed', false], [false, 'planned', false], [true, 'rolled_back', false],
    [true, 'rolled_back', true]] as const) {
    const f = await fixture(), resolved: string[] = [], seen: unknown[] = [], recorded: unknown[] = [];
    const label = `${state}${rollback ? ' --rollback' : ''}`;
    f.deps.protectedSetUpProviderDirectories = async (input: unknown) => {
      seen.push(input); return [{provider: 'codex', directory: '/fixtures/codex/bin'}];
    };
    f.deps.recordSetUpProviderDirectories = async (input: unknown) => {recorded.push(input);};
    f.deps.providerHintFromEnvironment = () => 'claude';
    f.deps.resolveRepositoryProviderDirectory = async (input: {provider: string}) => {
      resolved.push(input.provider); return `/fixtures/${input.provider}/bin`; };
    f.deps.stableRepositoryLauncherContents = (_version: string, runtime?: {providerDirectory?: unknown}) => ({runtime});
    let launcher: unknown, verified: unknown;
    f.deps.verifyRollbackRepositoryLaunchers = async (_version: string, _launchers: unknown, provider?: unknown) => {
      verified = provider; return true; };
    f.deps.upgradeRelayRuntime = async (_input: unknown, hooks: {launcherContents(version: string): {runtime?: {providerDirectory?: unknown}};
      verifyNextLaunchers?(version: string, launchers: unknown): Promise<boolean>}) => {
      launcher = hooks.launcherContents('0.2.118').runtime?.providerDirectory;
      await hooks.verifyNextLaunchers?.('0.2.118', {});
      return {state};
    };
    if (apply) f.flags.set('apply', true);
    if (rollback) f.flags.set('rollback', true);
    await f.run()(f.flags);
    if (rollback) {
      assert.deepEqual(seen, [], `${label}: a rollback keeps nothing`);
      assert.deepEqual(recorded, [], `${label}: a rollback records nothing`);
      continue;
    }
    assert.deepEqual(JSON.parse(JSON.stringify(seen)), [{home: '/fixtures/profile', workspace: f.startup.workspace}], label);
    assert.deepEqual(resolved, ['claude'], `${label}: a kept directory is not resolved again`);
    assert.deepEqual(JSON.parse(JSON.stringify(launcher)), ['/fixtures/claude/bin', '/fixtures/codex/bin'], label);
    assert.deepEqual(JSON.parse(JSON.stringify(verified)), ['claude', 'codex'], label);
    assert.deepEqual(JSON.parse(JSON.stringify(recorded)), state === 'completed'
      ? [{home: '/fixtures/profile', workspace: f.startup.workspace, providerDirectory: ['/fixtures/claude/bin', '/fixtures/codex/bin']}] : [],
      `${label}: only a completed upgrade records its directories`);
  }
});

// CLI 0.2.224 review K1 regression (2x3=6): on a 0.2.223 device there is no record, and codex with its shared package
// still pending holds no bundle, so a relay upgrade from inside Claude Code dropped codex from the launcher; 0.2.223
// always carried the codex on the upgrade PATH. With no record, the upgrade keeps the protected codex first on its PATH,
// leaves off an unsafe one without failing, and records what it wrote.
test('actual upgrade keeps codex from the upgrade PATH on a 0.2.223 device with no record', {skip: process.platform !== 'linux'}, async () => {
  for (const unsafe of [false, true]) {
    const f = await fixture(), resolved: string[] = [];
    const root = await realpath(await mkdtemp(resolve(tmpdir(), 'dharma-upgrade-unrecorded-')));
    try {
      const home = resolve(root, 'home'), codex = resolve(root, 'codex', 'bin');
      for (const directory of [home, codex]) await mkdir(directory, {recursive: true, mode: 0o700});
      await writeFile(resolve(codex, 'codex'), '#!/bin/sh\necho codex\n', {mode: 0o700});
      if (unsafe) await chmod(resolve(codex, 'codex'), 0o722);
      f.deps.dharmaHome = () => home;
      f.deps.process = {...(f.deps.process as object), env: {CODEX_HOME: '/fixtures/selected-codex', PATH: `${codex}:/fixtures/claude/bin`}};
      f.deps.protectedSetUpProviderDirectories = protectedSetUpProviderDirectories;
      f.deps.recordSetUpProviderDirectories = recordSetUpProviderDirectories;
      f.deps.providerHintFromEnvironment = () => 'claude';
      f.deps.resolveRepositoryProviderDirectory = async (input: {provider: string}) => {
        resolved.push(input.provider); return '/fixtures/claude/bin'; };
      f.deps.stableRepositoryLauncherContents = (_version: string, runtime?: {providerDirectory?: unknown}) => ({runtime});
      let launcher: unknown, verified: unknown;
      f.deps.verifyRollbackRepositoryLaunchers = async (_version: string, _launchers: unknown, provider?: unknown) => {
        verified = provider; return true; };
      f.deps.upgradeRelayRuntime = async (_input: unknown, hooks: {launcherContents(version: string): {runtime?: {providerDirectory?: unknown}};
        verifyNextLaunchers?(version: string, launchers: unknown): Promise<boolean>}) => {
        launcher = hooks.launcherContents('0.2.118').runtime?.providerDirectory;
        await hooks.verifyNextLaunchers?.('0.2.118', {});
        return {state: 'completed'};
      };
      f.flags.set('apply', true);
      await f.run()(f.flags);
      const label = unsafe ? 'unsafe codex' : 'codex';
      assert.deepEqual(resolved, ['claude'], `${label}: codex holds no bundle`);
      assert.deepEqual(JSON.parse(JSON.stringify(launcher)), unsafe ? ['/fixtures/claude/bin'] : [codex, '/fixtures/claude/bin'], label);
      assert.deepEqual(JSON.parse(JSON.stringify(verified)), unsafe ? ['claude'] : ['claude', 'codex'], label);
      assert.deepEqual(await protectedSetUpProviderDirectories({home, workspace: f.startup.workspace, searchPath: ''}),
        unsafe ? [] : [{provider: 'codex', directory: codex}], `${label}: the record names what the launcher carries`);
    } finally {await rm(root, {recursive: true, force: true});}
  }
});

// CLI 0.2.224 review R2: a provider merely guessed from the environment (the calling agent, else codex) that fails the
// launcher check hard-failed the upgrade. It is left off the launcher instead; a --provider the user named still fails.
test('actual upgrade leaves off a guessed provider that fails the check, and refuses a named one', async () => {
  for (const [flag, hint] of [[undefined, 'claude'], [undefined, null], ['claude', 'codex']] as const) {
    const f = await fixture(), label = `${flag} ${hint}`;
    f.deps.providerHintFromEnvironment = () => hint;
    f.deps.providersHoldingInstalledBundle = async () => ['agy'];
    f.deps.resolveRepositoryProviderDirectory = async (input: {provider: string}) => {
      if (input.provider !== 'agy') throw new Error(`relay_startup_${input.provider}_path_invalid`);
      return '/fixtures/agy/bin';
    };
    f.deps.stableRepositoryLauncherContents = (_version: string, runtime?: {providerDirectory?: unknown}) => ({runtime});
    let launcher: unknown, verified: unknown;
    f.deps.verifyRollbackRepositoryLaunchers = async (_version: string, _launchers: unknown, provider?: unknown) => {
      verified = provider; return true; };
    f.deps.upgradeRelayRuntime = async (_input: unknown, hooks: {launcherContents(version: string): {runtime?: {providerDirectory?: unknown}};
      verifyNextLaunchers?(version: string, launchers: unknown): Promise<boolean>}) => {
      launcher = hooks.launcherContents('0.2.118').runtime?.providerDirectory;
      await hooks.verifyNextLaunchers?.('0.2.118', {});
      return {state: 'completed'};
    };
    f.flags.set('apply', true);
    if (flag) {
      f.flags.set('provider', flag);
      await assert.rejects(f.run()(f.flags), /relay_startup_claude_path_invalid/, label);
      continue;
    }
    await f.run()(f.flags);
    assert.deepEqual(JSON.parse(JSON.stringify(launcher)), ['/fixtures/agy/bin'], label);
    assert.deepEqual(JSON.parse(JSON.stringify(verified)), ['agy'], label);
  }
});
