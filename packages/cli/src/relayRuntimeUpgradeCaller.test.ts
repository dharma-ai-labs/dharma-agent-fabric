import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import test from 'node:test';
import ts from 'typescript';
import { relayRuntimeObservationReady, upgradeRelayRuntime } from './relayRuntimeUpgrade.js';
import { providerDirectoriesInPathOrder, stableRepositoryLauncherContents, verifyRecordedRepositoryLaunchers, verifyRollbackRepositoryLaunchers } from './repositoryLaunchers.js';
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
    saveWorkspaceRecord: async () => {},
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
  // The provider-recording helpers it calls run as written; their filesystem and PATH readers stay fixtures.
  const helpers = source.statements.filter(node => ts.isFunctionDeclaration(node)
    && ['recordedProviderIds', 'protectedBundleHolders', 'setUpProviderIds'].includes(node.name?.text ?? ''))
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
test('actual upgrade resolves the bin directory of --provider, else the onboarded provider, else the calling agent', async () => {
  for (const [flag, recorded, hint, expected] of [
    ['claude', undefined, 'codex', 'claude'], [undefined, ['claude'], 'codex', 'claude'],
    [undefined, undefined, 'claude', 'claude'], [undefined, undefined, null, 'codex'],
  ] as const) {
    const f = await fixture(), requested: string[] = [];
    const selected = (f.deps.selectDeviceWorkspace as () => Record<string, unknown>)();
    f.deps.selectDeviceWorkspace = () => ({...selected, ...(recorded ? {providerIds: [...recorded]} : {})});
    f.deps.providerHintFromEnvironment = () => hint;
    f.deps.resolveRepositoryProviderDirectory = async (input: {provider: string}) => {requested.push(input.provider); return undefined;};
    if (flag) f.flags.set('provider', flag);
    await f.run()(f.flags);
    assert.deepEqual(requested, [expected]);
  }
});

// PR #425 review (2): a 0.2.223 record names no provider, so upgrade took the caller's environment and never saved it.
test('actual upgrade of a record without providers prefers the provider holding a bundle and saves it on apply', async () => {
  for (const [apply, holders, hint, expected] of [
    [true, ['claude'], 'codex', 'claude'], [false, ['claude'], 'codex', 'claude'],
    [true, ['codex', 'claude'], 'claude', 'claude'], [true, [], 'claude', 'claude'],
  ] as const) {
    const f = await fixture(), saved: Record<string, unknown>[] = [];
    f.deps.providerHintFromEnvironment = () => hint;
    f.deps.providersHoldingInstalledBundle = async () => [...holders];
    f.deps.saveWorkspaceRecord = async (item: Record<string, unknown>) => { saved.push(item); };
    f.deps.resolveRepositoryProviderDirectory = async () => undefined;
    let verified: unknown;
    f.deps.verifyRollbackRepositoryLaunchers = async (_version: string, _launchers: unknown, provider?: unknown) => {
      verified = provider; return true; };
    f.deps.upgradeRelayRuntime = async (_input: unknown, hooks: {beforeStart?(phase: string): Promise<void>;
      verifyNextLaunchers?(version: string, launchers: unknown): Promise<boolean>}) => {
      await hooks.verifyNextLaunchers?.('0.2.118', {});
      if (apply) await hooks.beforeStart?.('upgrade');
      return {state: apply ? 'completed' : 'planned'};
    };
    if (apply) f.flags.set('apply', true);
    await f.run()(f.flags);
    // PR #425 fix round 2 (1): the record names the holders its relay served before, then the chosen provider.
    const recorded = [...holders.filter(item => item !== expected), expected];
    assert.deepEqual(JSON.parse(JSON.stringify(verified)), recorded, 'the written launcher is checked for the recorded providers');
    assert.deepEqual(JSON.parse(JSON.stringify(saved.map(item => item.providerIds))), apply ? [recorded] : []);
  }
});

// PR #425 fix round 2 (1): a record without providers was narrowed to the one chosen provider, so a provider set up
// there before, and holding a bundle, got no further release while status called it up to date.
test('actual upgrade of a record without providers keeps the protected holders and resolves each for the launcher', async () => {
  for (const [codexProtected, recorded] of [[true, ['codex', 'claude']], [false, ['claude']]] as const) {
    const f = await fixture(), requested: string[] = [], saved: unknown[] = [];
    f.deps.providerHintFromEnvironment = () => 'claude';
    f.deps.providersHoldingInstalledBundle = async () => ['codex', 'claude'];
    f.deps.saveWorkspaceRecord = async (item: Record<string, unknown>) => { saved.push(item.providerIds); };
    f.deps.resolveRepositoryProviderDirectory = async (input: {provider: string}) => {
      requested.push(input.provider);
      if (input.provider === 'codex' && !codexProtected) throw new Error('relay_startup_codex_path_invalid');
      return `/fixtures/${input.provider}/bin`;
    };
    f.deps.stableRepositoryLauncherContents = (_version: string, runtime?: {providerDirectory?: unknown}) => ({runtime});
    let launcher: unknown;
    f.deps.upgradeRelayRuntime = async (_input: unknown, hooks: {beforeStart?(phase: string): Promise<void>;
      launcherContents(version: string): {runtime?: {providerDirectory?: unknown}}}) => {
      launcher = hooks.launcherContents('0.2.118').runtime?.providerDirectory;
      await hooks.beforeStart?.('upgrade');
      return {state: 'completed'};
    };
    f.flags.set('apply', true);
    await f.run()(f.flags);
    assert.deepEqual(JSON.parse(JSON.stringify(saved)), [recorded], `codex protected: ${codexProtected}`);
    assert.deepEqual(JSON.parse(JSON.stringify(launcher)), recorded.map(provider => `/fixtures/${provider}/bin`),
      'the launcher carries the bin directory of every recorded provider');
    assert.equal(requested.filter(item => item === 'codex').length, codexProtected ? 2 : 1,
      'an unprotected holder is checked once and never resolved for the launcher');
  }
});

// PR #425 review (4), narrowed in round 2: the launcher this run writes is checked for the set-up provider. The
// launchers already recorded (prior bytes, journal next) were written for whichever provider was known then.
test('actual upgrade binds the set-up provider only into verification of the launcher it writes', async () => {
  const f = await fixture(), verified: unknown[] = [];
  const selected = (f.deps.selectDeviceWorkspace as () => Record<string, unknown>)();
  f.deps.selectDeviceWorkspace = () => ({...selected, providerIds: ['claude']});
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

// PR #425 review round 2 (2): with the hint naming a bundle holder, upgrade saved that provider before the
// upgrade ran, then checked the old launcher for it, so it failed and every retry failed the same way.
// Round 3 (1): it then saved a pre-upgrade snapshot after the new relay had started and loaded its record, so
// that relay still served every provider, its own saves were rolled back, and its guarded saves failed.
function memoryRegistry(f: Awaited<ReturnType<typeof fixture>>, initial: Record<string, unknown>) {
  let rows = [JSON.parse(JSON.stringify(initial)) as Record<string, unknown>];
  const row = () => rows.find(item => item.workspaceId === initial.workspaceId)!;
  f.deps.registry = async () => JSON.parse(JSON.stringify(rows));
  f.deps.selectDeviceWorkspace = (items: Record<string, unknown>[]) => items.find(item => item.workspaceId === initial.workspaceId);
  f.deps.saveWorkspaceRecord = async (entry: Record<string, unknown>, guard?: {expected: unknown}) => {
    if (guard && JSON.stringify(row()) !== JSON.stringify(guard.expected)) throw new Error('workspace_registry_compare_and_swap_failed');
    rows = [...rows.filter(item => item.workspaceId !== entry.workspaceId), JSON.parse(JSON.stringify(entry))];
  };
  return row;
}

test('actual upgrade records the provider before the new relay starts, into the current record, and restores it on rollback', async () => {
  for (const outcome of ['completed', 'rolled_back', 'rollback_failed'] as const) {
    const f = await fixture();
    const row = memoryRegistry(f, {workspaceId: 'workspace', organizationId: 'org_fixture', deviceId: 'device',
      path: '/fixtures/repository'});
    f.deps.providerHintFromEnvironment = () => 'claude';
    f.deps.providersHoldingInstalledBundle = async () => ['codex', 'claude'];
    let loaded: unknown = 'not started';
    f.deps.upgradeRelayRuntime = async (_input: unknown, hooks: {
      configureStartup(version: string, restore?: {codexHome: string | null}): Promise<unknown>;
      beforeStart?(phase: string): Promise<void>;
    }) => {
      await hooks.configureStartup('0.2.118');
      await hooks.beforeStart?.('upgrade');
      // The new relay loads its record at start, then saves its recovered baseline guarded by what it loaded.
      const record = row();
      loaded = record.providerIds;
      await (f.deps.saveWorkspaceRecord as (entry: unknown, guard: unknown) => Promise<void>)(
        {...record, repositoryPackage: {state: 'absent'}}, {expected: record});
      if (outcome === 'rolled_back') {
        await hooks.configureStartup('0.2.116', {codexHome: null});
        await hooks.beforeStart?.('rollback');
      }
      return {state: outcome};
    };
    f.flags.set('apply', true);
    await f.run()(f.flags);
    assert.deepEqual(loaded, ['codex', 'claude'], `${outcome}: the new relay loads the recorded providers`);
    assert.deepEqual(row().repositoryPackage, {state: 'absent'}, `${outcome}: the relay's own save is kept`);
    assert.deepEqual(row().providerIds, outcome === 'completed' ? ['codex', 'claude'] : undefined, outcome);
    assert.equal(Object.hasOwn(row(), 'providerIds'), outcome === 'completed', outcome);
  }
});

test('actual upgrade without --apply or with --rollback never records a provider', async () => {
  for (const flag of ['dry-run', 'rollback']) {
    const f = await fixture(), saved: unknown[] = [];
    f.deps.providerHintFromEnvironment = () => 'claude';
    f.deps.saveWorkspaceRecord = async (item: Record<string, unknown>) => { saved.push(item.providerIds); };
    f.deps.upgradeRelayRuntime = async (_input: unknown, hooks: {beforeStart?(phase: string): Promise<void>}) => {
      await hooks.beforeStart?.('upgrade'); await hooks.beforeStart?.('rollback'); return {state: 'planned'};
    };
    f.flags.set(flag, true);
    await f.run()(f.flags);
    assert.deepEqual(saved, [], flag);
  }
});

// PR #425 review round 3 (2): --provider replaced the provider a record names, so that provider became
// clear-only, against the usage text. --provider chooses only for a record that names no provider.
test('actual upgrade refuses a --provider the record does not name and never rewrites a record that names providers', async () => {
  for (const [flag, refused] of [['codex', true], ['claude', false], [undefined, false]] as const) {
    const f = await fixture(), saved: unknown[] = [], upgraded: string[] = [];
    const selected = (f.deps.selectDeviceWorkspace as () => Record<string, unknown>)();
    f.deps.selectDeviceWorkspace = () => ({...selected, providerIds: ['claude']});
    f.deps.saveWorkspaceRecord = async (item: Record<string, unknown>) => { saved.push(item.providerIds); };
    f.deps.upgradeRelayRuntime = async (_input: unknown, hooks: {beforeStart?(phase: string): Promise<void>}) => {
      upgraded.push('upgrade'); await hooks.beforeStart?.('upgrade'); return {state: 'completed'};
    };
    f.flags.set('apply', true);
    if (flag) f.flags.set('provider', flag);
    if (refused) await assert.rejects(f.run()(f.flags), /relay_upgrade_provider_conflict/);
    else await f.run()(f.flags);
    assert.deepEqual(upgraded, refused ? [] : ['upgrade'], String(flag));
    assert.deepEqual(saved, [], String(flag));
  }
});

test('relay upgrade usage and the unsafe PATH error name --provider', async () => {
  const {CLI_USAGE} = await import('./usage.js');
  assert.match(CLI_USAGE, /relay upgrade --workspace <owned-checkout> \[--provider <codex\|claude\|agy\|hermes>\]/);
  const source = await readFile(fileURLToPath(new URL('../src/repositoryLaunchers.ts', import.meta.url)), 'utf8');
  assert.match(source, /const unsafeProviderOnPath = [^;]*--provider/);
});
