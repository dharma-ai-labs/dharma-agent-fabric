import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {tmpdir} from 'node:os';
import {dirname, resolve} from 'node:path';
import {runInNewContext} from 'node:vm';
import test from 'node:test';
import ts from 'typescript';
import {currentBootstrapHostScope, runCodexBootstrapHost} from './bootstrapHostScope.js';
import {writeBootstrapHostJson} from './bootstrapHostFiles.js';
import {readWorkspaceRegistry} from './workspaceRegistry.js';

async function fixture(t: {after(fn: () => Promise<void>): void}) {
  const root = await fs.mkdtemp(resolve(tmpdir(), 'dharma-registry-caller-'));
  t.after(() => fs.rm(root, {recursive: true, force: true}));
  const path = resolve(root, 'registry', 'workspaces.json'), now = Date.now(), digest = `sha256:${'a'.repeat(64)}`;
  const id = (n: number) => `${String(n).padStart(8, '0')}-1111-4111-8111-111111111111`;
  return {root, path, entry: {workspaceId: id(5), organizationId: 'org_demo', path: root},
    input: {workspace: root, current: async () => true, signal: new AbortController().signal,
      intent: {schema: 'dharma.codex-setup-intent/v1' as const, operationId: id(1), setupReference: id(2),
        organizationId: 'org_demo', recipientMembershipId: id(3), origin: 'https://hq.example',
        repositoryFingerprint: digest, policyRevision: 'policy-v1', scopeDigest: digest, contractDigest: digest,
        hostContextId: id(4), issuedAt: new Date(now - 1000).toISOString(), expiresAt: new Date(now + 60_000).toISOString()}}};
}

// Parse actual production declarations; inject only their C-only I/O dependencies.
async function callers(root: string, path: string, overrides: Record<string, unknown> = {}) {
  const text = await fs.readFile(new URL('../src/index.ts', import.meta.url), 'utf8');
  const ast = ts.createSourceFile('index.ts', text, ts.ScriptTarget.Latest, true);
  const names = ['acquirePidLock', 'registry', 'saveRegistry', 'saveWorkspaceRecord', 'writeJsonAtomic',
    'withFileLock', 'withRelayStartupMutation', 'withEvidenceLedgerLock'];
  const declarations = names.map(name => {
    const nodes = ast.statements.filter(node => ts.isFunctionDeclaration(node) && node.name?.text === name);
    assert.equal(nodes.length, 1); return nodes[0]!.getText(ast);
  });
  const output = ts.transpileModule(declarations.join('\n'), {compilerOptions: {
    target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.None}, reportDiagnostics: true});
  assert.equal(output.diagnostics?.filter(item => item.category === ts.DiagnosticCategory.Error).length, 0);
  return runInNewContext(`${output.outputText}\nif (typeof wrapAcquisition === 'function') acquirePidLock = wrapAcquisition(acquirePidLock);\n({${names.join(',')}})`, {...fs, dirname, resolve, randomUUID,
    process, Date, setTimeout, structuredClone, exports: {}, currentBootstrapHostScope, readWorkspaceRegistry, writeBootstrapHostJson,
    dharmaHome: () => root, workspaceRegistryPath: () => path, evidenceUploadLedgerPath: () => resolve(root, 'ledger.json'),
    ...overrides}, {timeout: 1000, contextCodeGeneration: {strings: false, wasm: false}}) as Record<string, (...args: any[]) => Promise<any>>;
}

test('registry mutation callers refuse a closed owner before directory or lock effects', async t => {
  const f = await fixture(t), c = await callers(f.root, f.path);
  for (const name of ['saveRegistry', 'saveWorkspaceRecord']) {
    let outcome: PromiseSettledResult<unknown>[] = [];
    await assert.rejects(runCodexBootstrapHost(f.input, async ({scope}) => {
      scope.close(); outcome = await Promise.allSettled([c[name]!(name === 'saveRegistry' ? [f.entry] : f.entry)]);
    }), {message: 'codex_setup_host_scope_unavailable'});
    assert.equal(outcome[0]?.status, 'rejected'); assert.deepEqual(await fs.readdir(f.root), []);
  }
});

test('registry mutation caller denies continuation after its actual read withdraws the owner', async t => {
  const f = await fixture(t); await fs.mkdir(dirname(f.path)); await fs.writeFile(f.path, '[]\n');
  let writesAfterRead = 0, withdrawn = false;
  await assert.rejects(runCodexBootstrapHost(f.input, async ({scope}) => {
    const c = await callers(f.root, f.path, {
      readFile: async (path: string, encoding: BufferEncoding) => {
        const value = await fs.readFile(path, encoding);
        if (path === f.path) {withdrawn = true; scope.close();} return value;
      }, mkdir: async (path: string, options: Parameters<typeof fs.mkdir>[1]) => {
        if (withdrawn) writesAfterRead++; return fs.mkdir(path, options);
      }});
    return c.saveWorkspaceRecord!(f.entry);
  }), {message: 'codex_setup_host_scope_unavailable'});
  assert.equal(writesAfterRead, 0); assert.equal(await fs.readFile(f.path, 'utf8'), '[]\n');
  assert.deepEqual(await fs.readdir(dirname(f.path)), ['workspaces.json']);
});

test('registry mutation snapshots the original row before its first asynchronous effect', async t => {
  const f = await fixture(t), originalId = f.entry.workspaceId;
  await fs.mkdir(dirname(f.path)); await fs.writeFile(f.path, '[]\n');
  const c = await callers(f.root, f.path, {readFile: async (path: string, encoding: BufferEncoding) => {
    const value = await fs.readFile(path, encoding); if (path === f.path) f.entry.workspaceId = 'mutated-foreign-row'; return value;
  }});
  await runCodexBootstrapHost(f.input, () => c.saveWorkspaceRecord!(f.entry));
  assert.equal(JSON.parse(await fs.readFile(f.path, 'utf8'))[0].workspaceId, originalId);
});

test('registry mutation withholds diagnostics and rejects unsafe input before lock creation', async t => {
  const f = await fixture(t), c = await callers(f.root, f.path);
  const entry = Object.defineProperty({...f.entry}, 'workspaceId', {get() {throw new Error('private-row-canary');}});
  await assert.rejects(runCodexBootstrapHost(f.input, () => c.saveWorkspaceRecord!(entry)),
    {message: 'workspace_registry_write_failed'});
  assert.deepEqual(await fs.readdir(f.root), []);
});

test('current registry mutation preserves sibling rows and commits the intended row', async t => {
  const f = await fixture(t), sibling = {...f.entry, workspaceId: 'sibling-preserve'};
  await fs.mkdir(dirname(f.path)); await fs.writeFile(f.path, `${JSON.stringify([sibling])}\n`);
  const c = await callers(f.root, f.path);
  await runCodexBootstrapHost(f.input, () => c.saveWorkspaceRecord!(f.entry));
  assert.deepEqual(JSON.parse(await fs.readFile(f.path, 'utf8')), [sibling, f.entry]);
  assert.deepEqual(await fs.readdir(dirname(f.path)), ['workspaces.json']);
});

for (const name of ['withFileLock', 'withRelayStartupMutation', 'withEvidenceLedgerLock']) {
  test(`${name} refuses a callback after scope loss at lock handoff and releases its lease`, async t => {
    const f = await fixture(t); let entered = false;
    await assert.rejects(runCodexBootstrapHost(f.input, async ({scope}) => {
      const guarded = await callers(f.root, f.path, {wrapAcquisition:
        (actual: (...args: unknown[]) => Promise<() => Promise<void>>) => async (...args: unknown[]) => {
          const release = await actual(...args); scope.close(); return release;
        }});
      const work = async () => {entered = true;};
      return name === 'withFileLock' ? guarded[name]!(resolve(f.root, 'lock'), work)
        : name === 'withRelayStartupMutation' ? guarded[name]!(work, f.root) : guarded[name]!(work);
    }), {message: 'codex_setup_host_scope_unavailable'});
    assert.equal(entered, false); assert.deepEqual(await fs.readdir(f.root), []);
  });
}
