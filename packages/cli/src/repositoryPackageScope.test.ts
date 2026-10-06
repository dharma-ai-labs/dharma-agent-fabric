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
import {inventoryRepositoryPackage, serializeRepositoryPackageSnapshot, writeRepositoryPackageSnapshot} from './repositoryPackage.js';
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
async function module(overrides: Record<string, unknown> = {}, inertSchema = false) {
  const location = new URL('../src/repositoryPackage.ts', import.meta.url), require = createRequire(location);
  const source = (await fs.readFile(location, 'utf8')).replaceAll('import.meta.url', JSON.stringify(location.href));
  const result = ts.transpileModule(source, {compilerOptions: {target: ts.ScriptTarget.ES2023,
    module: ts.ModuleKind.CommonJS}, reportDiagnostics: true});
  assert.equal(result.diagnostics?.filter(item => item.category === ts.DiagnosticCategory.Error).length, 0);
  const exports: Record<string, any> = {};
  runInNewContext(result.outputText, {exports, Buffer, Date, URL, process, require: (name: string) => {
    if (name === 'node:fs') return syncFs;
    if (name === 'node:fs/promises') return {...fs, ...overrides};
    if (name === 'node:crypto') return crypto;
    if (name === 'node:path') return path;
    if (name === 'node:url') return url;
    if (name === 'node:util') return util;
    if (name === './bootstrapHostScope.js') return {currentBootstrapHostScope};
    if (name === './repositoryKnowledge.js') return knowledge;
    if (name === './repositorySourceAuthorization.js') return authorization;
    if (name === '@dharma-ai-labs/agent-fabric-contracts') return inertSchema
      ? {...contracts, validateContract: overrides.validateContract || (async () => ({ok: true}))} : contracts;
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

const generated = '.agents/skills/dharma-agent-fabric';
const snapshots = '.dharma/repository-source/snapshots';
async function writeFixture(t: {after(fn: () => Promise<void>): void}) {
  const f = await fixture(t), snapshot = await inventoryRepositoryPackage(f);
  return {workspace: f.workspace, snapshot};
}
function creating(args: Parameters<typeof fs.open>, prefix: string) {
  return !!(Number(args[1]) & syncFs.constants.O_CREAT) && path.basename(String(args[0])).startsWith(prefix);
}
test('package writer snapshots caller fields before root resolution yields', async t => {
  const f = await writeFixture(t), expected = f.snapshot.manifest.snapshotHash; let mutated = false;
  const api = await module({realpath: async (...args: Parameters<typeof fs.realpath>) => {
    const value = await fs.realpath(...args);
    if (!mutated) {mutated = true; f.snapshot.manifest.organizationId = 'org_foreign';}
    return value;
  }}, true);
  const actual: any = await runCodexBootstrapHost(host(f.workspace), () => api.writeRepositoryPackageSnapshot(f));
  assert.equal(actual.snapshotHash, expected); assert.equal(actual.disposition, 'local_bootstrap_inventory');
  assert.equal(JSON.parse(await fs.readFile(path.join(f.workspace, generated, 'MANIFEST.json'), 'utf8')).organizationId, 'org_demo');
});
test('package writer refuses caller snapshot accessors before filesystem inspection', async t => {
  const f = await writeFixture(t); let getters = 0, resolutions = 0;
  Object.defineProperty(f.snapshot, 'manifest', {get: () => {getters++; throw new Error('private writer input canary');}});
  const api = await module({realpath: async (...args: Parameters<typeof fs.realpath>) => {resolutions++; return fs.realpath(...args);}}, true);
  await assert.rejects(runCodexBootstrapHost(host(f.workspace), () => api.writeRepositoryPackageSnapshot(f)),
    {message: 'repository_package_input_invalid'});
  assert.equal(getters, 0); assert.equal(resolutions, 0);
});
test('package writer closes acquired CAS staging after withdrawal without writing or deleting it', async t => {
  const f = await writeFixture(t); let writes = 0, closes = 0, unlinks = 0;
  await assert.rejects(runCodexBootstrapHost(host(f.workspace), async ({scope}) => {
    const api = await module({open: async (...args: Parameters<typeof fs.open>) => {
      const handle = await fs.open(...args); if (!creating(args, '.snapshot-')) return handle;
      const write = handle.writeFile.bind(handle), close = handle.close.bind(handle);
      handle.writeFile = async (...values: Parameters<typeof handle.writeFile>) => {writes++; return write(...values);};
      handle.close = async () => {closes++; return close();}; scope.close(); return handle;
    }, unlink: async (...args: Parameters<typeof fs.unlink>) => {unlinks++; return fs.unlink(...args);}}, true);
    await api.writeRepositoryPackageSnapshot(f);
  }), {message: 'codex_setup_host_scope_unavailable'});
  assert.equal(writes, 0); assert.equal(closes, 1); assert.equal(unlinks, 0);
  assert.equal((await fs.readdir(path.join(f.workspace, snapshots))).filter(name => name.startsWith('.snapshot-')).length, 1);
});
test('package writer retains partial CAS staging and stops sync/publication after write withdrawal', async t => {
  const f = await writeFixture(t); let writes = 0, syncs = 0, closes = 0, links = 0, unlinks = 0;
  await assert.rejects(runCodexBootstrapHost(host(f.workspace), async ({scope}) => {
    const api = await module({open: async (...args: Parameters<typeof fs.open>) => {
      const handle = await fs.open(...args); if (!creating(args, '.snapshot-')) return handle;
      const write = handle.writeFile.bind(handle), sync = handle.sync.bind(handle), close = handle.close.bind(handle);
      handle.writeFile = async (...values: Parameters<typeof handle.writeFile>) => {writes++; const result = await write(...values); scope.close(); return result;};
      handle.sync = async () => {syncs++; return sync();}; handle.close = async () => {closes++; return close();}; return handle;
    }, link: async (...args: Parameters<typeof fs.link>) => {links++; return fs.link(...args);},
    unlink: async (...args: Parameters<typeof fs.unlink>) => {unlinks++; return fs.unlink(...args);}}, true);
    await api.writeRepositoryPackageSnapshot(f);
  }), {message: 'codex_setup_host_scope_unavailable'});
  assert.equal(writes, 1); assert.equal(syncs, 0); assert.equal(closes, 1); assert.equal(links, 0); assert.equal(unlinks, 0);
});
for (const scoped of [true, false]) test(`package writer preserves an unowned CAS staging collision (${scoped ? 'scoped' : 'legacy'})`, async t => {
  const f = await writeFixture(t); let foreign = '', unlinks = 0;
  const api = await module({open: async (...args: Parameters<typeof fs.open>) => {
    if (!creating(args, '.snapshot-')) return fs.open(...args);
    foreign = String(args[0]); await fs.writeFile(foreign, 'foreign staging');
    throw Object.assign(new Error('private exclusive-create canary'), {code: 'EEXIST'});
  }, unlink: async (...args: Parameters<typeof fs.unlink>) => {unlinks++; return fs.unlink(...args);}}, true);
  await assert.rejects(scoped ? runCodexBootstrapHost(host(f.workspace), () => api.writeRepositoryPackageSnapshot(f)) : api.writeRepositoryPackageSnapshot(f));
  assert.equal(unlinks, 0); assert.equal(await fs.readFile(foreign, 'utf8'), 'foreign staging');
});
test('package writer preserves a published CAS object and staged evidence after link withdrawal', async t => {
  const f = await writeFixture(t); let links = 0, unlinks = 0;
  await assert.rejects(runCodexBootstrapHost(host(f.workspace), async ({scope}) => {
    const api = await module({link: async (...args: Parameters<typeof fs.link>) => {
      links++; await fs.link(...args); scope.close();
    }, unlink: async (...args: Parameters<typeof fs.unlink>) => {unlinks++; return fs.unlink(...args);}}, true);
    await api.writeRepositoryPackageSnapshot(f);
  }), {message: 'codex_setup_host_scope_unavailable'});
  assert.equal(links, 1); assert.equal(unlinks, 0);
  const names = await fs.readdir(path.join(f.workspace, snapshots));
  assert.equal(names.filter(name => name.startsWith('.snapshot-')).length, 1);
  assert.equal(names.filter(name => name.endsWith('.json')).length, 1);
});
test('package writer settles its exact acquired copy lock after link admission withdraws', async t => {
  const f = await writeFixture(t);
  await assert.rejects(runCodexBootstrapHost(host(f.workspace), async ({scope}) => {
    const api = await module({link: async (...args: Parameters<typeof fs.link>) => {
      await fs.link(...args); if (path.basename(String(args[0])).startsWith('.lock-')) scope.close();
    }}, true);
    await api.writeRepositoryPackageSnapshot(f);
  }), {message: 'codex_setup_host_scope_unavailable'});
  const names = await fs.readdir(path.join(f.workspace, generated));
  assert.ok(!names.includes('COPY-LOCK.json')); assert.ok(names.every(name => !name.startsWith('.lock-')));
  assert.ok(!names.includes('COPY-JOURNAL.json'));
});
test('package writer retains interrupted journal, releases its own lock and recovers the actual managed-copy path', async t => {
  const f = await writeFixture(t), api = await module({}, true);
  await assert.rejects(runCodexBootstrapHost(host(f.workspace), async ({scope}) => api.writeRepositoryPackageSnapshot({...f,
    onCopyCheckpoint: (point: string) => {if (point === 'journal_prepared') scope.close();}})),
  {message: 'codex_setup_host_scope_unavailable'});
  const journal = path.join(f.workspace, generated, 'COPY-JOURNAL.json'), bytes = await fs.readFile(journal);
  assert.equal(JSON.parse(bytes.toString()).desired.snapshotHash, f.snapshot.manifest.snapshotHash);
  await assert.rejects(fs.stat(path.join(f.workspace, generated, 'COPY-LOCK.json')), {code: 'ENOENT'});
  await assert.rejects(fs.stat(path.join(f.workspace, generated, 'skills/source/.agents/skills/example/SKILL.md')), {code: 'ENOENT'});
  const actual: any = await api.writeRepositoryPackageSnapshot(f);
  assert.equal(actual.disposition, 'local_bootstrap_inventory');
  assert.equal(await fs.readFile(path.join(f.workspace, generated, 'skills/source/.agents/skills/example/SKILL.md'), 'utf8'),
    await fs.readFile(path.join(f.workspace, '.agents/skills/example/SKILL.md'), 'utf8'));
  await assert.rejects(fs.stat(journal), {code: 'ENOENT'});
});
test('package writer preserves foreign replacement of its lock during withdrawal', async t => {
  const f = await writeFixture(t), api = await module({}, true); let classification = '';
  const lock = path.join(f.workspace, generated, 'COPY-LOCK.json');
  await assert.rejects(runCodexBootstrapHost(host(f.workspace), async ({scope}) => {
    try {await api.writeRepositoryPackageSnapshot({...f, onCopyCheckpoint: async (point: string) => {
      if (point !== 'journal_prepared') return;
      await fs.unlink(lock); await fs.writeFile(lock, 'foreign lock'); scope.close();
    }});} catch (error) {classification = (error as Error).message; throw error;}
  }), {message: 'codex_setup_host_scope_unavailable'});
  assert.equal(classification, 'repository_package_cleanup_unconfirmed');
  assert.equal(await fs.readFile(lock, 'utf8'), 'foreign lock');
});
test('actual compiled scoped writer preserves normal managed-copy and manifest behavior', async t => {
  const f = await writeFixture(t);
  const actual = await runCodexBootstrapHost(host(f.workspace), () => writeRepositoryPackageSnapshot(f));
  assert.equal(actual.disposition, 'local_bootstrap_inventory');
  assert.equal(actual.snapshotHash, f.snapshot.manifest.snapshotHash);
  assert.equal(await fs.readFile(path.join(f.workspace, generated, 'MANIFEST.json'), 'utf8'), `${contracts.canonicalize(f.snapshot.manifest)}\n`);
  assert.equal(await fs.readFile(path.join(f.workspace, generated, 'skills/source/.agents/skills/example/SKILL.md'), 'utf8'),
    await fs.readFile(path.join(f.workspace, '.agents/skills/example/SKILL.md'), 'utf8'));
  await assert.rejects(fs.stat(path.join(f.workspace, generated, 'COPY-LOCK.json')), {code: 'ENOENT'});
});

test('package writer refuses foreign CAS staging replacement before publishing it', async t => {
  const f = await writeFixture(t); let foreign = '', links = 0;
  const api = await module({open: async (...args: Parameters<typeof fs.open>) => {
    const handle = await fs.open(...args); if (!creating(args, '.snapshot-')) return handle;
    const close = handle.close.bind(handle);
    handle.close = async () => {await close(); foreign = String(args[0]); await fs.unlink(foreign); await fs.writeFile(foreign, 'foreign staging');};
    return handle;
  }, link: async (...args: Parameters<typeof fs.link>) => {links++; return fs.link(...args);}}, true);
  await assert.rejects(runCodexBootstrapHost(host(f.workspace), () => api.writeRepositoryPackageSnapshot(f)));
  assert.equal(links, 0); assert.equal(await fs.readFile(foreign, 'utf8'), 'foreign staging');
  assert.equal((await fs.readdir(path.join(f.workspace, snapshots))).filter(name => name.endsWith('.json')).length, 0);
});
test('package writer refuses same-inode CAS staging edits before publishing them', async t => {
  const f = await writeFixture(t); let edited = '', links = 0;
  const api = await module({open: async (...args: Parameters<typeof fs.open>) => {
    const handle = await fs.open(...args); if (!creating(args, '.snapshot-')) return handle;
    const close = handle.close.bind(handle);
    handle.close = async () => {await close(); edited = String(args[0]); await fs.writeFile(edited, 'intervening edit');};
    return handle;
  }, link: async (...args: Parameters<typeof fs.link>) => {links++; return fs.link(...args);}}, true);
  await assert.rejects(runCodexBootstrapHost(host(f.workspace), () => api.writeRepositoryPackageSnapshot(f)));
  assert.equal(links, 0); assert.equal(await fs.readFile(edited, 'utf8'), 'intervening edit');
});
test('package writer preserves foreign metadata staging before journal rename', async t => {
  const f = await writeFixture(t); let foreign = '', renames = 0;
  const api = await module({open: async (...args: Parameters<typeof fs.open>) => {
    const handle = await fs.open(...args); if (!creating(args, '.metadata-')) return handle;
    const close = handle.close.bind(handle);
    handle.close = async () => {await close(); foreign = String(args[0]); await fs.unlink(foreign); await fs.writeFile(foreign, 'foreign metadata');};
    return handle;
  }, rename: async (...args: Parameters<typeof fs.rename>) => {renames++; return fs.rename(...args);}}, true);
  await assert.rejects(runCodexBootstrapHost(host(f.workspace), () => api.writeRepositoryPackageSnapshot(f)));
  assert.equal(renames, 0); assert.equal(await fs.readFile(foreign, 'utf8'), 'foreign metadata');
  await assert.rejects(fs.stat(path.join(f.workspace, generated, 'COPY-JOURNAL.json')), {code: 'ENOENT'});
});
test('package writer refuses foreign lock candidate before acquiring it or starting journal work', async t => {
  const f = await writeFixture(t); let foreign = '', lockLinks = 0;
  const api = await module({open: async (...args: Parameters<typeof fs.open>) => {
    const handle = await fs.open(...args); if (!creating(args, '.lock-')) return handle;
    const close = handle.close.bind(handle);
    handle.close = async () => {await close(); foreign = String(args[0]); await fs.unlink(foreign); await fs.writeFile(foreign, 'foreign lock candidate');};
    return handle;
  }, link: async (...args: Parameters<typeof fs.link>) => {
    if (path.basename(String(args[0])).startsWith('.lock-')) lockLinks++; return fs.link(...args);
  }}, true);
  await assert.rejects(runCodexBootstrapHost(host(f.workspace), () => api.writeRepositoryPackageSnapshot(f)));
  assert.equal(lockLinks, 0); assert.equal(await fs.readFile(foreign, 'utf8'), 'foreign lock candidate');
  await assert.rejects(fs.stat(path.join(f.workspace, generated, 'COPY-JOURNAL.json')), {code: 'ENOENT'});
});
test('package writer retains a published journal after rename withdrawal without installing a copy', async t => {
  const f = await writeFixture(t), journal = path.join(f.workspace, generated, 'COPY-JOURNAL.json');
  await assert.rejects(runCodexBootstrapHost(host(f.workspace), async ({scope}) => {
    const api = await module({rename: async (...args: Parameters<typeof fs.rename>) => {
      await fs.rename(...args); if (String(args[1]) === journal) scope.close();
    }}, true);
    await api.writeRepositoryPackageSnapshot(f);
  }), {message: 'codex_setup_host_scope_unavailable'});
  assert.equal(JSON.parse(await fs.readFile(journal, 'utf8')).desired.snapshotHash, f.snapshot.manifest.snapshotHash);
  await assert.rejects(fs.stat(path.join(f.workspace, generated, 'COPY-LOCK.json')), {code: 'ENOENT'});
  await assert.rejects(fs.stat(path.join(f.workspace, generated, 'skills/source/.agents/skills/example/SKILL.md')), {code: 'ENOENT'});
});
test('package writer preserves installed copy and journal after link withdrawal, then recovers without replacing the source', async t => {
  const f = await writeFixture(t); let api: Record<string, any> | undefined;
  await assert.rejects(runCodexBootstrapHost(host(f.workspace), async ({scope}) => {
    api = await module({link: async (...args: Parameters<typeof fs.link>) => {
      await fs.link(...args); if (String(args[0]).replaceAll('\\', '/').includes('/.copy-transactions/')) scope.close();
    }}, true);
    await api.writeRepositoryPackageSnapshot(f);
  }), {message: 'codex_setup_host_scope_unavailable'});
  const target = path.join(f.workspace, generated, 'skills/source/.agents/skills/example/SKILL.md');
  const before = await fs.stat(target, {bigint: true}), bytes = await fs.readFile(target);
  await assert.rejects(fs.stat(path.join(f.workspace, generated, 'COPY-INDEX.json')), {code: 'ENOENT'});
  await assert.rejects(fs.stat(path.join(f.workspace, generated, 'COPY-LOCK.json')), {code: 'ENOENT'});
  const actual = await api!.writeRepositoryPackageSnapshot(f);
  assert.equal(actual.disposition, 'local_bootstrap_inventory');
  assert.equal((await fs.stat(target, {bigint: true})).ino, before.ino); assert.deepEqual(await fs.readFile(target), bytes);
  await assert.rejects(fs.stat(path.join(f.workspace, generated, 'COPY-JOURNAL.json')), {code: 'ENOENT'});
});
test('queued package writer retains its closed original scope instead of falling back to legacy publication', async t => {
  const f = await writeFixture(t); let resume!: () => void, paused!: () => void, resolved!: () => void;
  const pause = new Promise<void>(resolve => {paused = resolve;}), release = new Promise<void>(resolve => {resume = resolve;});
  const resolution = new Promise<void>(resolve => {resolved = resolve;});
  let secondScope: ReturnType<typeof currentBootstrapHostScope>, validations = 0;
  const api = await module({realpath: async (...args: Parameters<typeof fs.realpath>) => {
    const value = await fs.realpath(...args); if (currentBootstrapHostScope() === secondScope && secondScope) resolved(); return value;
  }, validateContract: async () => {
    if (currentBootstrapHostScope() === secondScope && secondScope) validations++; return {ok: true};
  }}, true);
  const first = api.writeRepositoryPackageSnapshot({...f, onCopyCheckpoint: async (point: string) => {
    if (point === 'journal_prepared') {paused(); await release;}
  }});
  await pause;
  const second = runCodexBootstrapHost(host(f.workspace), async ({scope}) => {secondScope = scope; return api.writeRepositoryPackageSnapshot(f);});
  const rejected = assert.rejects(second, {message: 'codex_setup_host_scope_unavailable'});
  try {await resolution; await new Promise<void>(resolve => setImmediate(resolve)); secondScope!.close();}
  finally {resume();}
  await first; await rejected; assert.equal(validations, 0);
});
