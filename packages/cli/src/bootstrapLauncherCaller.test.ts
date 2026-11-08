import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import {existsSync, readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, resolve} from 'node:path';
import {runInNewContext} from 'node:vm';
import test from 'node:test';
import ts from 'typescript';
import {currentBootstrapHostScope, runCodexBootstrapHost} from './bootstrapHostScope.js';
import {writeBootstrapHostText} from './bootstrapHostFiles.js';
import * as launcherModule from './repositoryLaunchers.js';
import {stableRepositoryLauncherContents} from './repositoryLaunchers.js';
import {selectDeviceWorkspace, workspaceIdForDevice} from './onboardingWorkspace.js';
const npmCliPath = process.platform === 'linux' ? '/synthetic/npm/bin/npm-cli.js' : undefined;
const providerDirectory = process.platform === 'linux' ? '/synthetic/codex/bin' : undefined;

async function fixture(t: {after(fn: () => Promise<void>): void}) {
  const root = await fs.realpath(await fs.mkdtemp(resolve(tmpdir(), 'dharma-launcher-caller-')));
  t.after(() => fs.rm(root, {recursive: true, force: true}));
  const now = Date.now(), digest = `sha256:${'a'.repeat(64)}`;
  const id = (n: number) => `${String(n).padStart(8, '0')}-1111-4111-8111-111111111111`;
  return {root, bin: resolve(root, '.dharma', 'bin'), input: {workspace: root,
    current: async () => true, signal: new AbortController().signal,
    intent: {schema: 'dharma.codex-setup-intent/v1' as const, operationId: id(1), setupReference: id(2),
      organizationId: 'org_demo', recipientMembershipId: id(3), origin: 'https://hq.example',
      repositoryFingerprint: digest, policyRevision: 'policy-v1', scopeDigest: digest, contractDigest: digest,
      hostContextId: id(4), issuedAt: new Date(now - 1000).toISOString(), expiresAt: new Date(now + 60_000).toISOString()}}};
}

// Execute the actual CLI installer declaration with real filesystem effects.
async function caller(overrides: Record<string, unknown> = {}) {
  const source = await fs.readFile(new URL('../src/index.ts', import.meta.url), 'utf8');
  const ast = ts.createSourceFile('index.ts', source, ts.ScriptTarget.Latest, true);
  const nodes = ast.statements.filter(node => ts.isFunctionDeclaration(node) && node.name?.text === 'installStableRepositoryLauncher');
  assert.equal(nodes.length, 1);
  // The bundle-holder helper and the reader of the launcher being replaced run as written; their filesystem
  // readers and protection checks stay fixtures.
  const helpers = ast.statements.filter(node => ts.isFunctionDeclaration(node)
    && ['protectedBundleHolders', 'currentLauncherProviders'].includes(node.name?.text ?? ''))
    .map(node => node.getText(ast).replace(/^export\s+/, ''));
  const output = ts.transpileModule([nodes[0]!.getText(ast), ...helpers].join('\n'), {compilerOptions: {
    target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.None}, reportDiagnostics: true});
  assert.equal(output.diagnostics?.filter(item => item.category === ts.DiagnosticCategory.Error).length, 0);
  return runInNewContext(`${output.outputText}\ninstallStableRepositoryLauncher`, {...fs, process, resolve, dirname,
    currentBootstrapHostScope, writeBootstrapHostText, stableRepositoryLauncherContents,
    readDeviceConfig: async () => null, registry: async () => [], selectDeviceWorkspace,
    providersHoldingInstalledBundle: async () => [],
    dharmaHome: () => '/synthetic/home', protectedSetUpProviderDirectories: async () => [],
    recordSetUpProviderDirectories: async () => {},
    providerDirectoriesInPathOrder: (launcherModule as Record<string, unknown>).providerDirectoriesInPathOrder,
    resolveRepositoryNpmCli: async () => npmCliPath,
    providerProcessEnvironment: () => ({PATH: '/synthetic/codex/bin:/synthetic/fallback/bin'}),
    resolveRepositoryProviderDirectory: async (input: {provider: string; searchPath?: string}) => {
      assert.equal(input.provider, 'codex');
      assert.equal(input.searchPath, '/synthetic/codex/bin:/synthetic/fallback/bin'); return providerDirectory;
    }, VERSION: '0.2.153', ...overrides},
    {timeout: 1000, contextCodeGeneration: {strings: false, wasm: false}}) as (workspace: string, providers: string[]) => Promise<{shell: string; windows: string}>;
}

test('actual launcher installer denies a withdrawn owner before creating directories', async t => {
  const f = await fixture(t), install = await caller();
  await assert.rejects(runCodexBootstrapHost(f.input, async ({scope}) => {
    scope.close(); return install(f.root, ['codex']);
  }), {message: 'codex_setup_host_scope_unavailable'});
  assert.deepEqual(await fs.readdir(f.root), []);
});

test('actual launcher installer publishes exact pinned bytes under the original owning scope', async t => {
  const f = await fixture(t), install = await caller();
  const result = await runCodexBootstrapHost(f.input, () => install(f.root, ['codex']));
  assert.equal(result.shell, '.dharma/bin/dharma'); assert.equal(result.windows, '.dharma/bin/dharma.cmd');
  const expected = stableRepositoryLauncherContents('0.2.153', {platform: process.platform,
    nodeDirectory: dirname(process.execPath), ...(npmCliPath === undefined ? {} : {npmCliPath}),
    ...(providerDirectory === undefined ? {} : {providerDirectory})});
  assert.equal(await fs.readFile(resolve(f.bin, 'dharma'), 'utf8'), expected.shell);
  assert.equal(await fs.readFile(resolve(f.bin, 'dharma.cmd'), 'utf8'), expected.windows);
  assert.deepEqual((await fs.readdir(f.bin)).sort(), ['dharma', 'dharma.cmd']);
  if (process.platform !== 'win32') {
    assert.equal((await fs.stat(resolve(f.bin, 'dharma'))).mode & 0o777, 0o700);
    assert.equal((await fs.stat(resolve(f.bin, 'dharma.cmd'))).mode & 0o777, 0o600);
  }
});

test('actual launcher installer cannot continue to the second file after authority is withdrawn', async t => {
  const f = await fixture(t), install = await caller();
  await fs.mkdir(f.bin, {recursive: true, mode: 0o700});
  await fs.writeFile(resolve(f.bin, 'dharma'), 'prior-shell\n');
  await fs.writeFile(resolve(f.bin, 'dharma.cmd'), 'prior-cmd\n');
  const input = {...f.input, current: async () => readFileSync(resolve(f.bin, 'dharma'), 'utf8') === 'prior-shell\n'};
  await assert.rejects(runCodexBootstrapHost(input, () => install(f.root, ['codex'])), {message: 'codex_setup_host_scope_unavailable'});
  assert.match(await fs.readFile(resolve(f.bin, 'dharma'), 'utf8'), /agent-fabric@0\.2\.153/);
  assert.equal(await fs.readFile(resolve(f.bin, 'dharma.cmd'), 'utf8'), 'prior-cmd\n');
  // A completed first publication is retained, not falsely reported as rolled back.
  assert.deepEqual((await fs.readdir(f.bin)).sort(), ['dharma', 'dharma.cmd']);
});

test('actual launcher installer rejects an aliased setup directory without writing its target', async t => {
  const f = await fixture(t), other = await fixture(t), install = await caller();
  await fs.writeFile(resolve(other.root, 'preserve'), 'sibling\n');
  await fs.symlink(other.root, resolve(f.root, '.dharma'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(runCodexBootstrapHost(f.input, () => install(f.root, ['codex'])), {message: 'codex_setup_host_launcher_path_invalid'});
  assert.deepEqual(await fs.readdir(other.root), ['preserve']);
  assert.equal(existsSync(resolve(other.root, 'bin')), false);
});

test('actual launcher installer cannot report success after its final publication loses acknowledgement', async t => {
  const f = await fixture(t), install = await caller();
  const cmd = resolve(f.bin, 'dharma.cmd');
  await assert.rejects(runCodexBootstrapHost({...f.input, current: async () => !existsSync(cmd)}, () => install(f.root, ['codex'])),
    {message: 'codex_setup_host_scope_unavailable'});
  assert.match(await fs.readFile(cmd, 'utf8'), /agent-fabric@0\.2\.153/);
  assert.match(await fs.readFile(resolve(f.bin, 'dharma'), 'utf8'), /agent-fabric@0\.2\.153/);
});

test('legacy launcher installation retains its existing supported contents without a native scope', async t => {
  const f = await fixture(t), install = await caller();
  await install(f.root, ['codex']);
  assert.match(await fs.readFile(resolve(f.bin, 'dharma'), 'utf8'), /agent-fabric@0\.2\.153/);
});

test('actual launcher installer stops before publishing an unsafe provider path', async t => {
  const f = await fixture(t), install = await caller({resolveRepositoryProviderDirectory: async () => {
    throw new Error('relay_startup_codex_path_invalid');
  }});
  await assert.rejects(runCodexBootstrapHost(f.input, () => install(f.root, ['codex'])), {message: 'relay_startup_codex_path_invalid'});
  assert.equal(existsSync(f.bin), false);
});

test('actual launcher installer cannot publish after provider resolution loses its owning scope', async t => {
  const f = await fixture(t);
  let close = () => {};
  const install = await caller({resolveRepositoryProviderDirectory: async () => {close(); return providerDirectory;}});
  await assert.rejects(runCodexBootstrapHost(f.input, async ({scope}) => {close = () => scope.close(); return install(f.root, ['codex']);}),
    {message: 'codex_setup_host_scope_unavailable'});
  assert.equal(existsSync(f.bin), false);
});

test('actual launcher installer resolves the bin directory of the provider that setup selected', async t => {
  const f = await fixture(t), requested: string[] = [];
  const install = await caller({
    resolveRepositoryProviderDirectory: async (input: {provider: string; searchPath?: string}) => {
      assert.equal(input.searchPath, '/synthetic/codex/bin:/synthetic/fallback/bin');
      requested.push(input.provider); return undefined;
    },
  });
  await runCodexBootstrapHost(f.input, () => install(f.root, ['claude']));
  assert.deepEqual(requested, ['claude']);
});

// PR #425 fix round 2 (2): setting up a second provider rewrote the launcher with only that provider's bin directory.
test('actual launcher installer carries the bin directory of every provider set up in the checkout', async t => {
  const f = await fixture(t), requested: string[] = [];
  const directory = (provider: string) => process.platform === 'linux' ? `/synthetic/${provider}/bin` : undefined;
  const install = await caller({
    providerProcessEnvironment: () => ({PATH: '/synthetic/claude/bin:/synthetic/codex/bin'}),
    resolveRepositoryProviderDirectory: async (input: {provider: string; searchPath?: string}) => {
      assert.equal(input.searchPath, '/synthetic/claude/bin:/synthetic/codex/bin');
      requested.push(input.provider); return directory(input.provider);
    },
  });
  await runCodexBootstrapHost(f.input, () => install(f.root, ['codex', 'claude']));
  assert.deepEqual(requested, ['codex', 'claude']);
  const expected = stableRepositoryLauncherContents('0.2.153', {platform: process.platform,
    nodeDirectory: dirname(process.execPath), ...(npmCliPath === undefined ? {} : {npmCliPath}),
    ...(process.platform === 'linux' ? {providerDirectory: ['/synthetic/claude/bin', '/synthetic/codex/bin']} : {})});
  assert.equal(await fs.readFile(resolve(f.bin, 'dharma'), 'utf8'), expected.shell);
});

// PR #424 review (F1): re-running setup from a second agent rewrote the launcher with only that agent's bin directory,
// so the relay lost the protected codex directory that holds the installed bundle. Relay upgrade already keeps holders.
async function holderFixture(t: {after(fn: () => Promise<void>): void}, holderDirectory: (provider: string) => Promise<string | undefined>) {
  const f = await fixture(t), requested: string[] = [];
  const config = {organizationId: 'org_demo', deviceId: 'device_demo'};
  const record = {workspaceId: workspaceIdForDevice({...config, path: f.root}), organizationId: config.organizationId,
    deviceId: config.deviceId, path: f.root, repositoryRemoteHash: null};
  const install = await caller({
    readDeviceConfig: async () => config, registry: async () => [record],
    providersHoldingInstalledBundle: async (workspace: unknown) => {assert.equal(workspace, record); return ['codex'];},
    providerProcessEnvironment: () => ({PATH: '/synthetic/codex/bin:/synthetic/claude/bin'}),
    resolveRepositoryProviderDirectory: async (input: {provider: string; searchPath?: string}) => {
      assert.equal(input.searchPath, '/synthetic/codex/bin:/synthetic/claude/bin');
      requested.push(input.provider); return holderDirectory(input.provider);
    },
  });
  return {f, requested, install};
}

test('actual launcher installer keeps each protected bundle holder of the registered workspace', async t => {
  const linux = process.platform === 'linux';
  const {f, requested, install} = await holderFixture(t, async provider => linux ? `/synthetic/${provider}/bin` : undefined);
  await runCodexBootstrapHost(f.input, () => install(f.root, ['claude']));
  // The holder's protection check, then the launcher resolution of the holder and of the set-up provider.
  assert.deepEqual(requested, ['codex', 'codex', 'claude']);
  const expected = stableRepositoryLauncherContents('0.2.153', {platform: process.platform,
    nodeDirectory: dirname(process.execPath), ...(npmCliPath === undefined ? {} : {npmCliPath}),
    ...(linux ? {providerDirectory: ['/synthetic/codex/bin', '/synthetic/claude/bin']} : {})});
  assert.equal(await fs.readFile(resolve(f.bin, 'dharma'), 'utf8'), expected.shell);
});

test('actual launcher installer leaves out a bundle holder whose executable fails the protection check', async t => {
  const linux = process.platform === 'linux';
  const {f, requested, install} = await holderFixture(t, async provider => {
    if (provider === 'codex') throw new Error('relay_startup_codex_path_invalid');
    return linux ? `/synthetic/${provider}/bin` : undefined;
  });
  await runCodexBootstrapHost(f.input, () => install(f.root, ['claude']));
  assert.deepEqual(requested, ['codex', 'claude']);
  const expected = stableRepositoryLauncherContents('0.2.153', {platform: process.platform,
    nodeDirectory: dirname(process.execPath), ...(npmCliPath === undefined ? {} : {npmCliPath}),
    ...(linux ? {providerDirectory: '/synthetic/claude/bin'} : {})});
  assert.equal(await fs.readFile(resolve(f.bin, 'dharma'), 'utf8'), expected.shell);
});

// CLI 0.2.224 review R1: codex set up first, with its shared package still pending (no ACTIVE_BUNDLE, so it holds no
// bundle), then Claude Code set up in the same checkout. The launcher dropped codex's bin directory and the relay never
// reached codex again. The installer records the directories it writes in this device's state and keeps each protected
// one recorded for the launcher being replaced (K1: never read from the working tree).
test('actual launcher installer keeps the provider directories it recorded for the launcher it replaces', async t => {
  const linux = process.platform === 'linux', f = await fixture(t), seen: unknown[] = [], recorded: unknown[] = [];
  const recordSetUpProviderDirectories = async (input: unknown) => {recorded.push(input);};
  const first = await caller({recordSetUpProviderDirectories});
  await runCodexBootstrapHost(f.input, () => first(f.root, ['codex']));
  const second = await caller({recordSetUpProviderDirectories,
    providerProcessEnvironment: () => ({PATH: '/synthetic/codex/bin:/synthetic/claude/bin'}),
    resolveRepositoryProviderDirectory: async (input: {provider: string}) => {
      assert.equal(input.provider, 'claude', 'a kept directory is not resolved again'); return linux ? '/synthetic/claude/bin' : undefined;
    },
    protectedSetUpProviderDirectories: async (input: unknown) => {
      seen.push(input); return linux ? [{provider: 'codex', directory: '/synthetic/codex/bin'}] : [];
    },
  });
  await runCodexBootstrapHost(f.input, () => second(f.root, ['claude']));
  assert.deepEqual(JSON.parse(JSON.stringify(seen)), [{home: '/synthetic/home', workspace: f.root,
    searchPath: '/synthetic/codex/bin:/synthetic/claude/bin'}], "the installer reads this device's record for the workspace");
  assert.deepEqual(JSON.parse(JSON.stringify(recorded)), [
    {home: '/synthetic/home', workspace: f.root, providerDirectory: linux ? ['/synthetic/codex/bin'] : []},
    {home: '/synthetic/home', workspace: f.root, providerDirectory: linux ? ['/synthetic/codex/bin', '/synthetic/claude/bin'] : []}]);
  const expected = stableRepositoryLauncherContents('0.2.153', {platform: process.platform,
    nodeDirectory: dirname(process.execPath), ...(npmCliPath === undefined ? {} : {npmCliPath}),
    ...(linux ? {providerDirectory: ['/synthetic/codex/bin', '/synthetic/claude/bin']} : {})});
  assert.equal(await fs.readFile(resolve(f.bin, 'dharma'), 'utf8'), expected.shell);
});

// CLI 0.2.224 review K1 (3x8=24): setup read the provider directories to keep from <workspace>/.dharma/bin/dharma,
// which anyone who writes to the repository can commit, and put each one that passed the check ahead of the user's
// PATH. A planted launcher naming <workspace>/tools, with a git-tracked tools/claude, put repository code first on the
// relay PATH. Setup keeps only directories this device recorded in its own state, never one inside the workspace.
test('actual launcher installer never keeps a provider directory a committed launcher names', {skip: process.platform !== 'linux'}, async t => {
  const linux = process.platform === 'linux', f = await fixture(t);
  const home = await fs.realpath(await fs.mkdtemp(resolve(tmpdir(), 'dharma-launcher-home-')));
  t.after(() => fs.rm(home, {recursive: true, force: true}));
  const tools = resolve(f.root, 'tools');
  await fs.mkdir(tools, {mode: 0o755}); await fs.chmod(tools, 0o755);
  for (const name of ['claude', 'git']) {
    await fs.writeFile(resolve(tools, name), '#!/bin/sh\necho PLANTED\n'); await fs.chmod(resolve(tools, name), 0o755);
  }
  // As a repository author writes them: a 0.2.223-format launcher naming guessed checkout paths and the real one.
  const planted = stableRepositoryLauncherContents('0.2.223', {platform: 'linux', nodeDirectory: '/usr/bin',
    providerDirectory: ['/workspaces/repo/tools', '/home/ubuntu/repo/tools', tools]});
  await fs.mkdir(f.bin, {recursive: true, mode: 0o755});
  for (const directory of [resolve(f.root, '.dharma'), f.bin]) await fs.chmod(directory, 0o755);
  await fs.writeFile(resolve(f.bin, 'dharma'), planted.shell, {mode: 0o755});
  await fs.writeFile(resolve(f.bin, 'dharma.cmd'), planted.windows, {mode: 0o644});
  const install = await caller({...launcherModule, dharmaHome: () => home,
    resolveRepositoryNpmCli: async () => npmCliPath,
    resolveRepositoryProviderDirectory: async (input: {provider: string}) => {
      assert.equal(input.provider, 'codex'); return providerDirectory;
    }});
  await runCodexBootstrapHost(f.input, () => install(f.root, ['codex']));
  const shell = await fs.readFile(resolve(f.bin, 'dharma'), 'utf8');
  assert.ok(!shell.includes(tools), `no workspace directory on the relay PATH: ${shell}`);
  const expected = stableRepositoryLauncherContents('0.2.153', {platform: process.platform,
    nodeDirectory: dirname(process.execPath), ...(npmCliPath === undefined ? {} : {npmCliPath}),
    ...(linux ? {providerDirectory: '/synthetic/codex/bin'} : {})});
  assert.equal(shell, expected.shell);
});

// CLI 0.2.224 review K1 regression (2x3=6): a 0.2.223 device has a launcher naming codex's directory and no record of
// its own. With codex's shared package still pending (no installed bundle, so codex is not a holder), the first 0.2.224
// `setup --provider claude` dropped codex from the launcher, which 0.2.223 always carried from the setup PATH. With no
// record, setup keeps the protected codex first on its PATH, leaves off an unsafe one without failing, and records.
test('actual launcher installer keeps codex from the setup PATH on a 0.2.223 device with no record', {skip: process.platform !== 'linux'}, async t => {
  for (const unsafe of [false, true]) {
    const f = await fixture(t);
    const home = await fs.realpath(await fs.mkdtemp(resolve(tmpdir(), 'dharma-launcher-home-')));
    const tools = await fs.realpath(await fs.mkdtemp(resolve(tmpdir(), 'dharma-launcher-codex-')));
    t.after(() => fs.rm(home, {recursive: true, force: true})); t.after(() => fs.rm(tools, {recursive: true, force: true}));
    const codex = resolve(tools, 'bin'); await fs.mkdir(codex, {mode: 0o700});
    await fs.writeFile(resolve(codex, 'codex'), '#!/bin/sh\necho codex\n', {mode: 0o700});
    if (unsafe) await fs.chmod(resolve(codex, 'codex'), 0o722);
    const prior = stableRepositoryLauncherContents('0.2.223', {platform: 'linux', nodeDirectory: dirname(process.execPath),
      providerDirectory: codex});
    await fs.mkdir(f.bin, {recursive: true, mode: 0o700});
    await fs.writeFile(resolve(f.bin, 'dharma'), prior.shell, {mode: 0o700});
    await fs.writeFile(resolve(f.bin, 'dharma.cmd'), prior.windows, {mode: 0o600});
    const install = await caller({...launcherModule, dharmaHome: () => home,
      resolveRepositoryNpmCli: async () => npmCliPath,
      providerProcessEnvironment: () => ({PATH: `${codex}:/synthetic/claude/bin`}),
      resolveRepositoryProviderDirectory: async (input: {provider: string}) => {
        assert.equal(input.provider, 'claude', 'codex holds no bundle'); return '/synthetic/claude/bin';
      }});
    await runCodexBootstrapHost(f.input, () => install(f.root, ['claude']));
    const expected = stableRepositoryLauncherContents('0.2.153', {platform: process.platform,
      nodeDirectory: dirname(process.execPath), ...(npmCliPath === undefined ? {} : {npmCliPath}),
      providerDirectory: unsafe ? ['/synthetic/claude/bin'] : [codex, '/synthetic/claude/bin']});
    assert.equal(await fs.readFile(resolve(f.bin, 'dharma'), 'utf8'), expected.shell, unsafe ? 'unsafe codex left off' : 'codex kept');
    assert.deepEqual(await launcherModule.protectedSetUpProviderDirectories({home, workspace: f.root, searchPath: ''}),
      unsafe ? [] : [{provider: 'codex', directory: codex}], 'the record now names what the launcher carries');
  }
});
