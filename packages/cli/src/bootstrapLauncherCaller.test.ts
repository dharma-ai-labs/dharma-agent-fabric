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
import {stableRepositoryLauncherContents} from './repositoryLaunchers.js';

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
async function caller() {
  const source = await fs.readFile(new URL('../src/index.ts', import.meta.url), 'utf8');
  const ast = ts.createSourceFile('index.ts', source, ts.ScriptTarget.Latest, true);
  const nodes = ast.statements.filter(node => ts.isFunctionDeclaration(node) && node.name?.text === 'installStableRepositoryLauncher');
  assert.equal(nodes.length, 1);
  const output = ts.transpileModule(nodes[0]!.getText(ast), {compilerOptions: {
    target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.None}, reportDiagnostics: true});
  assert.equal(output.diagnostics?.filter(item => item.category === ts.DiagnosticCategory.Error).length, 0);
  return runInNewContext(`${output.outputText}\ninstallStableRepositoryLauncher`, {...fs, process, resolve, dirname,
    currentBootstrapHostScope, writeBootstrapHostText, stableRepositoryLauncherContents, VERSION: '0.2.153'},
    {timeout: 1000, contextCodeGeneration: {strings: false, wasm: false}}) as (workspace: string) => Promise<{shell: string; windows: string}>;
}

test('actual launcher installer denies a withdrawn owner before creating directories', async t => {
  const f = await fixture(t), install = await caller();
  await assert.rejects(runCodexBootstrapHost(f.input, async ({scope}) => {
    scope.close(); return install(f.root);
  }), {message: 'codex_setup_host_scope_unavailable'});
  assert.deepEqual(await fs.readdir(f.root), []);
});

test('actual launcher installer publishes exact pinned bytes under the original owning scope', async t => {
  const f = await fixture(t), install = await caller();
  const result = await runCodexBootstrapHost(f.input, () => install(f.root));
  assert.equal(result.shell, '.dharma/bin/dharma'); assert.equal(result.windows, '.dharma/bin/dharma.cmd');
  const expected = stableRepositoryLauncherContents('0.2.153', {platform: process.platform, nodeDirectory: dirname(process.execPath)});
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
  await assert.rejects(runCodexBootstrapHost(input, () => install(f.root)), {message: 'codex_setup_host_scope_unavailable'});
  assert.match(await fs.readFile(resolve(f.bin, 'dharma'), 'utf8'), /agent-fabric@0\.2\.153/);
  assert.equal(await fs.readFile(resolve(f.bin, 'dharma.cmd'), 'utf8'), 'prior-cmd\n');
  // A completed first publication is retained, not falsely reported as rolled back.
  assert.deepEqual((await fs.readdir(f.bin)).sort(), ['dharma', 'dharma.cmd']);
});

test('actual launcher installer rejects an aliased setup directory without writing its target', async t => {
  const f = await fixture(t), other = await fixture(t), install = await caller();
  await fs.writeFile(resolve(other.root, 'preserve'), 'sibling\n');
  await fs.symlink(other.root, resolve(f.root, '.dharma'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(runCodexBootstrapHost(f.input, () => install(f.root)), {message: 'codex_setup_host_launcher_path_invalid'});
  assert.deepEqual(await fs.readdir(other.root), ['preserve']);
  assert.equal(existsSync(resolve(other.root, 'bin')), false);
});

test('actual launcher installer cannot report success after its final publication loses acknowledgement', async t => {
  const f = await fixture(t), install = await caller();
  const cmd = resolve(f.bin, 'dharma.cmd');
  await assert.rejects(runCodexBootstrapHost({...f.input, current: async () => !existsSync(cmd)}, () => install(f.root)),
    {message: 'codex_setup_host_scope_unavailable'});
  assert.match(await fs.readFile(cmd, 'utf8'), /agent-fabric@0\.2\.153/);
  assert.match(await fs.readFile(resolve(f.bin, 'dharma'), 'utf8'), /agent-fabric@0\.2\.153/);
});

test('legacy launcher installation retains its existing supported contents without a native scope', async t => {
  const f = await fixture(t), install = await caller();
  await install(f.root);
  assert.match(await fs.readFile(resolve(f.bin, 'dharma'), 'utf8'), /agent-fabric@0\.2\.153/);
});
