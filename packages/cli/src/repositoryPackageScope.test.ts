import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as syncFs from 'node:fs';
import * as crypto from 'node:crypto';
import * as path from 'node:path';
import * as url from 'node:url';
import * as util from 'node:util';
import {createRequire} from 'node:module';
import {tmpdir} from 'node:os';
import {runInNewContext} from 'node:vm';
import test from 'node:test';
import ts from 'typescript';
import * as contracts from '@dharma-ai-labs/agent-fabric-contracts';
import * as reduction from '@dharma-ai-labs/agent-fabric-evidence-reduction';
import * as knowledge from './repositoryKnowledge.js';
import * as authorization from './repositorySourceAuthorization.js';
import {inventoryRepositoryPackage, serializeRepositoryPackageSnapshot} from './repositoryPackage.js';
import {currentBootstrapHostScope, runCodexBootstrapHost} from './bootstrapHostScope.js';

function host(workspace: string) {
  const id = (n: number) => `${String(n).padStart(8, '0')}-1111-4111-8111-111111111111`;
  const now = Date.now(), digest = `sha256:${'a'.repeat(64)}`;
  return {workspace, current: async () => true, signal: new AbortController().signal,
    intent: {schema: 'dharma.codex-setup-intent/v1' as const, operationId: id(1), setupReference: id(2),
      organizationId: 'org_demo', recipientMembershipId: id(3), origin: 'https://hq.example',
      repositoryFingerprint: digest, policyRevision: 'policy-v1', scopeDigest: digest, contractDigest: digest,
      hostContextId: id(4), issuedAt: new Date(now - 1000).toISOString(), expiresAt: new Date(now + 60_000).toISOString()}};
}
async function fixture(t: {after(fn: () => Promise<void>): void}) {
  const workspace = await fs.mkdtemp(path.join(tmpdir(), 'dharma-package-scope-'));
  t.after(() => fs.rm(workspace, {recursive: true, force: true}));
  await fs.mkdir(path.join(workspace, '.agents/skills/example'), {recursive: true});
  await fs.writeFile(path.join(workspace, '.agents/skills/example/SKILL.md'), '# Example\nUse logical job identifiers.\n');
  return {workspace, organizationId: 'org_demo', workspaceId: 'synthetic', now: new Date('2026-10-01T00:00:00.000Z')};
}
async function module(overrides: Record<string, unknown> = {}) {
  const location = new URL('../src/repositoryPackage.ts', import.meta.url), require = createRequire(location);
  const source = (await fs.readFile(location, 'utf8')).replaceAll('import.meta.url', JSON.stringify(location.href));
  const result = ts.transpileModule(source, {compilerOptions: {target: ts.ScriptTarget.ES2023,
    module: ts.ModuleKind.CommonJS}, reportDiagnostics: true});
  assert.equal(result.diagnostics?.filter(item => item.category === ts.DiagnosticCategory.Error).length, 0);
  const exports: Record<string, any> = {};
  runInNewContext(result.outputText, {exports, Buffer, Date, process, require: (name: string) => {
    if (name === 'node:fs') return syncFs;
    if (name === 'node:fs/promises') return {...fs, ...overrides};
    if (name === 'node:crypto') return crypto;
    if (name === 'node:path') return path;
    if (name === 'node:url') return url;
    if (name === 'node:util') return util;
    if (name === './bootstrapHostScope.js') return {currentBootstrapHostScope};
    if (name === './repositoryKnowledge.js') return knowledge;
    if (name === './repositorySourceAuthorization.js') return authorization;
    if (name === '@dharma-ai-labs/agent-fabric-contracts') return contracts;
    if (name === '@dharma-ai-labs/agent-fabric-evidence-reduction') return reduction;
    return require(name);
  }}, {timeout: 1000, contextCodeGeneration: {strings: false, wasm: false}});
  return exports;
}

test('package capture refuses workspace resolution after original scope closes', async t => {
  const f = await fixture(t); let resolutions = 0;
  const api = await module({realpath: async (...args: Parameters<typeof fs.realpath>) => {resolutions++; return fs.realpath(...args);}});
  await assert.rejects(runCodexBootstrapHost(host(f.workspace), async ({scope}) => {
    scope.close(); await api.inventoryRepositoryPackage(f);
  }), {message: 'codex_setup_host_scope_unavailable'});
  assert.equal(resolutions, 0);
});
test('package capture stops before metadata after workspace resolution withdraws authority', async t => {
  const f = await fixture(t); let stats = 0;
  await assert.rejects(runCodexBootstrapHost(host(f.workspace), async ({scope}) => {
    const api = await module({realpath: async (...args: Parameters<typeof fs.realpath>) => {
      const value = await fs.realpath(...args); scope.close(); return value;
    }, lstat: async (...args: Parameters<typeof fs.lstat>) => {stats++; return fs.lstat(...args);}});
    await api.inventoryRepositoryPackage(f);
  }), {message: 'codex_setup_host_scope_unavailable'});
  assert.equal(stats, 0);
});
test('package capture closes its directory after withdrawal without reading another entry', async t => {
  const f = await fixture(t); let reads = 0, closes = 0, opens = 0;
  await assert.rejects(runCodexBootstrapHost(host(f.workspace), async ({scope}) => {
    const api = await module({opendir: async (...args: Parameters<typeof fs.opendir>) => {
      const directory = await fs.opendir(...args), read = directory.read.bind(directory), close = directory.close.bind(directory);
      const controlled = {read: async () => {reads++; const value = await read(); scope.close(); return value;},
        close: async () => {closes++; return close();},
        async *[Symbol.asyncIterator]() {try {for (;;) {const entry = await controlled.read(); if (!entry) break; yield entry;}}
          finally {await controlled.close();}}};
      return controlled;
    }, open: async (...args: Parameters<typeof fs.open>) => {opens++; return fs.open(...args);}});
    await api.inventoryRepositoryPackage(f);
  }), {message: 'codex_setup_host_scope_unavailable'});
  assert.equal(reads, 1); assert.equal(closes, 1); assert.equal(opens, 0);
});
test('package capture closes an acquired file after withdrawal without reading it', async t => {
  const f = await fixture(t); let reads = 0, closes = 0;
  await assert.rejects(runCodexBootstrapHost(host(f.workspace), async ({scope}) => {
    const api = await module({open: async (...args: Parameters<typeof fs.open>) => {
      const handle = await fs.open(...args), read = handle.read.bind(handle), close = handle.close.bind(handle);
      handle.read = ((...values: any[]) => {reads++; return Reflect.apply(read, handle, values);}) as typeof handle.read;
      handle.close = async () => {closes++; return close();}; scope.close(); return handle;
    }});
    await api.inventoryRepositoryPackage(f);
  }), {message: 'codex_setup_host_scope_unavailable'});
  assert.equal(reads, 0); assert.equal(closes, 1);
});
test('package capture does not convert withdrawal during file read into an unavailable exclusion', async t => {
  const f = await fixture(t); let reads = 0, closes = 0;
  await assert.rejects(runCodexBootstrapHost(host(f.workspace), async ({scope}) => {
    const api = await module({open: async (...args: Parameters<typeof fs.open>) => {
      const handle = await fs.open(...args), read = handle.read.bind(handle), close = handle.close.bind(handle);
      handle.read = (async (...values: any[]) => {reads++; const value = await Reflect.apply(read, handle, values); scope.close(); return value;}) as typeof handle.read;
      handle.close = async () => {closes++; return close();}; return handle;
    }});
    await api.inventoryRepositoryPackage(f);
  }), {message: 'codex_setup_host_scope_unavailable'});
  assert.equal(reads, 1); assert.equal(closes, 1);
});
test('package capture freezes caller scope and clock before filesystem inspection yields', async t => {
  const f = await fixture(t), expected = f.now.toISOString();
  const api = await module({realpath: async (...args: Parameters<typeof fs.realpath>) => {
    const value = await fs.realpath(...args); f.organizationId = 'org_foreign'; f.now.setTime(0); return value;
  }});
  const actual: any = await runCodexBootstrapHost(host(f.workspace), () => api.inventoryRepositoryPackage(f));
  assert.equal(actual.manifest.organizationId, 'org_demo'); assert.equal(actual.capturedAt, expected);
  assert.equal(actual.manifest.skills.length, 1); assert.equal(actual.manifest.skills[0].availability, 'available');
});
test('package capture refuses caller getters before filesystem work', async t => {
  const f = await fixture(t), workspace = f.workspace; let getters = 0, resolutions = 0;
  Object.defineProperty(f, 'workspace', {get: () => {getters++; throw new Error('private input canary');}});
  const api = await module({realpath: async (...args: Parameters<typeof fs.realpath>) => {resolutions++; return fs.realpath(...args);}});
  await assert.rejects(runCodexBootstrapHost(host(workspace), () => api.inventoryRepositoryPackage(f)),
    {message: 'repository_package_input_invalid'});
  assert.equal(getters, 0); assert.equal(resolutions, 0);
});
test('package capture refuses native error accessors without disclosing diagnostics', async t => {
  const f = await fixture(t); let getters = 0;
  const api = await module({realpath: async () => {throw Object.defineProperty(new Error('private native canary'), 'code', {
    get: () => {getters++; throw new Error('private getter canary');}});}});
  await assert.rejects(runCodexBootstrapHost(host(f.workspace), () => api.inventoryRepositoryPackage(f)),
    {message: 'repository_package_storage_unavailable'});
  assert.equal(getters, 0);
});

test('package capture freezes input before asynchronous owner revalidation', async t => {
  const f = await fixture(t), expected = f.now.toISOString(), api = await module(); let armed = false;
  const actual: any = await runCodexBootstrapHost({...host(f.workspace), current: async () => {
    if (armed) {f.organizationId = 'org_foreign'; f.now.setTime(0);} return true;
  }}, async () => {armed = true; return api.inventoryRepositoryPackage(f);});
  assert.equal(actual.manifest.organizationId, 'org_demo'); assert.equal(actual.capturedAt, expected);
});
test('package capture closes a directory acquired during withdrawal without its first read', async t => {
  const f = await fixture(t); let reads = 0, closes = 0;
  await assert.rejects(runCodexBootstrapHost(host(f.workspace), async ({scope}) => {
    const api = await module({opendir: async (...args: Parameters<typeof fs.opendir>) => {
      const directory = await fs.opendir(...args), read = directory.read.bind(directory), close = directory.close.bind(directory);
      scope.close(); return {read: async () => {reads++; return read();}, close: async () => {closes++; return close();}};
    }});
    await api.inventoryRepositoryPackage(f);
  }), {message: 'codex_setup_host_scope_unavailable'});
  assert.equal(reads, 0); assert.equal(closes, 1);
});
test('package capture rejects a nested observation getter without executing it', async t => {
  const f = await fixture(t); let getters = 0;
  const api = await module(), observation = Object.defineProperty({}, 'sourcePath', {
    get: () => {getters++; throw new Error('private nested canary');}});
  await assert.rejects(runCodexBootstrapHost(host(f.workspace), () => api.inventoryRepositoryPackage({...f, observations: [observation]})),
    {message: 'repository_package_input_invalid'});
  assert.equal(getters, 0);
});
test('package capture reports uncertain owned-handle close without native diagnostics', async t => {
  const f = await fixture(t); let closes = 0;
  await assert.rejects(runCodexBootstrapHost(host(f.workspace), async ({scope}) => {
    const api = await module({open: async (...args: Parameters<typeof fs.open>) => {
      const handle = await fs.open(...args), close = handle.close.bind(handle);
      handle.close = async () => {closes++; await close(); throw new Error('private close canary');};
      return handle;
    }});
    await api.inventoryRepositoryPackage(f);
  }), {message: 'repository_package_cleanup_unconfirmed'});
  assert.equal(closes, 1);
});
test('actual compiled package capture retains governed documents, knowledge and authorized uncommitted reports', async t => {
  const f = await fixture(t), id = (n: number) => `${String(n).padStart(8, '0')}-1111-4111-8111-111111111111`;
  const policy = {action: 'authorize', confirmed: true, requestId: id(5), repositoryBindingId: id(6), expectedRevision: 0,
    allowedContentClasses: ['approved_outputs', 'repository_content', 'repository_skills'],
    approvedRepositoryPaths: ['README.md'], approvedOutputFolders: ['output/approved'], automaticValidatedPublication: true,
    retentionDays: 30, maximumFileBytes: 262144, maximumSnapshotBytes: 4194304, maximumDailyUploadBytes: 8388608, expiresAt: null};
  const sourceAuthorization = {schema: 'dharma.repository-source-authorization/v1', organizationId: f.organizationId,
    workspaceId: id(7), repositoryBindingId: id(6), repositoryAgentId: id(8), revision: 1, generationId: id(9),
    receiptId: `repo_consent_${id(9)}`, policyRevision: `repository-source-${id(9)}`,
    confirmedAt: '2026-09-18T08:00:00.000Z',
    policyHash: `sha256:${crypto.createHash('sha256').update(contracts.canonicalize(policy)).digest('hex')}`, policy};
  const input = {...f, workspaceId: id(7), repositoryBindingId: id(6), repositoryAgentId: id(8), sourceAuthorization};
  const skill = path.join(f.workspace, '.agents/skills/dharma-agent-fabric');
  await fs.mkdir(skill, {recursive: true});
  await fs.writeFile(path.join(skill, '.dharma-agent-fabric.json'), JSON.stringify({managedBy: 'dharma-agent-fabric', workspaceId: input.workspaceId}));
  await knowledge.initializeRepositoryKnowledge(input);
  await fs.writeFile(path.join(f.workspace, 'README.md'), '# Logical job\nOne accepted operation.');
  await fs.mkdir(path.join(f.workspace, 'output/approved'), {recursive: true});
  await fs.writeFile(path.join(f.workspace, 'output/approved/report.md'), 'The retry preserved its logical job identifier.');
  await fs.writeFile(path.join(f.workspace, 'unapproved.md'), 'Excluded private fixture.');
  const baseline = await inventoryRepositoryPackage(input);
  const actual = await runCodexBootstrapHost(host(f.workspace), () => inventoryRepositoryPackage(input));
  assert.equal(serializeRepositoryPackageSnapshot(actual), serializeRepositoryPackageSnapshot(baseline));
  assert.equal(actual.manifest.schema, 'dharma.repository-package/v2');
  assert.ok(actual.manifest.files.some(file => file.role === 'knowledge'));
  assert.ok(actual.manifest.files.some(file => file.path === 'output/approved/report.md'));
  assert.ok(actual.manifest.files.every(file => file.path !== 'unapproved.md'));
});
