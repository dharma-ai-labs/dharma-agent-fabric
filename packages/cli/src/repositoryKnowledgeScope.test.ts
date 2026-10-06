import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as syncFs from 'node:fs';
import * as crypto from 'node:crypto';
import * as path from 'node:path';
import * as url from 'node:url';
import {createRequire} from 'node:module';
import {tmpdir} from 'node:os';
import {runInNewContext} from 'node:vm';
import test from 'node:test';
import ts from 'typescript';
import {currentBootstrapHostScope, runCodexBootstrapHost} from './bootstrapHostScope.js';

const skill = '.agents/skills/dharma-agent-fabric';
function input(workspace: string) {
  const id = (n: number) => `${String(n).padStart(8, '0')}-1111-4111-8111-111111111111`;
  const now = Date.now(), digest = `sha256:${'a'.repeat(64)}`;
  return {workspace, current: async () => true, signal: new AbortController().signal,
    intent: {schema: 'dharma.codex-setup-intent/v1' as const, operationId: id(1), setupReference: id(2),
      organizationId: 'org_demo', recipientMembershipId: id(3), origin: 'https://hq.example',
      repositoryFingerprint: digest, policyRevision: 'policy-v1', scopeDigest: digest, contractDigest: digest,
      hostContextId: id(4), issuedAt: new Date(now - 1000).toISOString(), expiresAt: new Date(now + 60_000).toISOString()}};
}
async function fixture(t: {after(fn: () => Promise<void>): void}) {
  const workspace = await fs.mkdtemp(path.join(tmpdir(), 'dharma-knowledge-scope-'));
  t.after(() => fs.rm(workspace, {recursive: true, force: true}));
  await fs.mkdir(path.join(workspace, skill), {recursive: true});
  await fs.writeFile(path.join(workspace, skill, '.dharma-agent-fabric.json'),
    JSON.stringify({managedBy: 'dharma-agent-fabric', workspaceId: 'synthetic'}));
  return {workspace, organizationId: 'org_demo', repositoryAgentId: 'synthetic', now: new Date('2026-10-01T00:00:00.000Z')};
}
async function module(overrides: Record<string, unknown> = {}) {
  const location = new URL('../src/repositoryKnowledge.ts', import.meta.url), require = createRequire(location);
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
    if (name === 'node:module') return {createRequire: () => require};
    if (name === './bootstrapHostScope.js') return {currentBootstrapHostScope};
    return require(name);
  }}, {timeout: 1000, contextCodeGeneration: {strings: false, wasm: false}});
  return exports;
}

for (const scoped of [true, false]) for (const cleanup of [true, false]) {
  test(`knowledge preserves replaced staging despite reused dev/ino (${scoped ? 'scoped' : 'legacy'}, ${cleanup ? 'cleanup' : 'publication'})`, async t => {
    const f = await fixture(t); let staging = '', foreign = '', acquired: syncFs.BigIntStats | undefined, unlinks = 0, links = 0;
    const api = await module({open: async (...args: Parameters<typeof fs.open>) => {
      const handle = await fs.open(...args);
      if (!(Number(args[1]) & syncFs.constants.O_CREAT)) return handle;
      staging = String(args[0]); const close = handle.close.bind(handle);
      handle.close = async () => {
        acquired = await handle.stat({bigint: true}); await close();
        const original = await fs.readFile(staging); foreign = 'x'.repeat(original.length);
        await fs.unlink(staging); await fs.writeFile(staging, foreign);
      };
      return handle;
    }, lstat: async (name: Parameters<typeof fs.lstat>[0], options?: any) => {
      const actual = await fs.lstat(name, options);
      if (String(name) !== staging || !acquired || !options?.bigint) return actual;
      return Object.assign(Object.create(Object.getPrototypeOf(actual)), actual, {dev: acquired.dev, ino: acquired.ino});
    }, unlink: async (...args: Parameters<typeof fs.unlink>) => {unlinks++; return fs.unlink(...args);},
    link: async (...args: Parameters<typeof fs.link>) => {
      links++; if (cleanup) throw new Error('fixture link failure'); return fs.link(...args);
    }});
    const operation = () => api.initializeRepositoryKnowledge(f);
    const error = await (scoped ? runCodexBootstrapHost(input(f.workspace), operation) : operation()).then(() => null, (failure: Error) => failure);
    assert.equal(await fs.readFile(staging, 'utf8'), foreign);
    assert.equal(unlinks, 0); assert.equal(links, 0);
    await assert.rejects(fs.stat(path.join(f.workspace, skill, '.repository-knowledge-init.json')), {code: 'ENOENT'});
    assert.equal(error?.message, 'repository_knowledge_cleanup_unconfirmed');
  });
}

test('knowledge verifies content even when an in-place edit reports unchanged metadata', async t => {
  const f = await fixture(t); let staging = '', foreign = '', acquired: syncFs.BigIntStats | undefined, unlinks = 0, links = 0;
  const api = await module({open: async (...args: Parameters<typeof fs.open>) => {
    const handle = await fs.open(...args);
    if (Number(args[1]) & syncFs.constants.O_CREAT) {
      staging = String(args[0]); const close = handle.close.bind(handle);
      handle.close = async () => {
        acquired = await handle.stat({bigint: true}); await close();
        foreign = 'x'.repeat(Number(acquired.size)); await fs.writeFile(staging, foreign);
      };
    } else if (String(args[0]) === staging) handle.stat = (async () => acquired!) as typeof handle.stat;
    return handle;
  }, lstat: async (name: Parameters<typeof fs.lstat>[0], options?: any) =>
    String(name) === staging && acquired && options?.bigint ? acquired : fs.lstat(name, options),
  unlink: async (...args: Parameters<typeof fs.unlink>) => {unlinks++; return fs.unlink(...args);},
  link: async (...args: Parameters<typeof fs.link>) => {links++; return fs.link(...args);}});
  await assert.rejects(runCodexBootstrapHost(input(f.workspace), () => api.initializeRepositoryKnowledge(f)),
    {message: 'repository_knowledge_cleanup_unconfirmed'});
  assert.equal(await fs.readFile(staging, 'utf8'), foreign); assert.equal(unlinks, 0); assert.equal(links, 0);
});

test('knowledge closes its staging reader after read withdrawal without publication or cleanup', async t => {
  const f = await fixture(t); let staging = '', readersClosed = 0, unlinks = 0, links = 0;
  await assert.rejects(runCodexBootstrapHost(input(f.workspace), async ({scope}) => {
    const api = await module({open: async (...args: Parameters<typeof fs.open>) => {
      const handle = await fs.open(...args);
      if (Number(args[1]) & syncFs.constants.O_CREAT) staging = String(args[0]);
      else if (String(args[0]) === staging) {
        const read = handle.read.bind(handle), close = handle.close.bind(handle);
        handle.read = (async (...values: any[]) => {const result = await Reflect.apply(read, handle, values); scope.close(); return result;}) as typeof handle.read;
        handle.close = async () => {readersClosed++; return close();};
      }
      return handle;
    }, unlink: async (...args: Parameters<typeof fs.unlink>) => {unlinks++; return fs.unlink(...args);},
    link: async (...args: Parameters<typeof fs.link>) => {links++; return fs.link(...args);}});
    await api.initializeRepositoryKnowledge(f);
  }), {message: 'codex_setup_host_scope_unavailable'});
  assert.equal(readersClosed, 1); assert.equal(unlinks, 0); assert.equal(links, 0);
  assert.equal(JSON.parse(await fs.readFile(staging, 'utf8')).organizationId, 'org_demo');
});

test('knowledge scope refuses workspace metadata before IO when original host is closed', async t => {
  const f = await fixture(t); let stats = 0;
  const api = await module({lstat: async (...args: Parameters<typeof fs.lstat>) => {stats++; return fs.lstat(...args);}});
  await assert.rejects(runCodexBootstrapHost(input(f.workspace), async ({scope}) => {
    scope.close(); await api.initializeRepositoryKnowledge(f);
  }), {message: 'codex_setup_host_scope_unavailable'});
  assert.equal(stats, 0);
});
test('knowledge scope stops after withdrawn workspace metadata without resolving another path', async t => {
  const f = await fixture(t); let stats = 0, resolutions = 0;
  await assert.rejects(runCodexBootstrapHost(input(f.workspace), async ({scope}) => {
    const api = await module({lstat: async (...args: Parameters<typeof fs.lstat>) => {
      stats++; const value = await fs.lstat(...args); scope.close(); return value;
    }, realpath: async (...args: Parameters<typeof fs.realpath>) => {resolutions++; return fs.realpath(...args);}});
    await api.readRepositoryKnowledge(f);
  }), {message: 'codex_setup_host_scope_unavailable'});
  assert.equal(stats, 1); assert.equal(resolutions, 0);
});
test('knowledge scope closes acquired marker handle after withdrawal without reading', async t => {
  const f = await fixture(t); let reads = 0, closes = 0;
  await assert.rejects(runCodexBootstrapHost(input(f.workspace), async ({scope}) => {
    const api = await module({open: async (...args: Parameters<typeof fs.open>) => {
      const handle = await fs.open(...args), close = handle.close.bind(handle), read = handle.read.bind(handle);
      handle.close = async () => {closes++; return close();};
      handle.read = ((...values: any[]) => {reads++; return Reflect.apply(read, handle, values);}) as typeof handle.read;
      scope.close(); return handle;
    }});
    await api.readRepositoryKnowledge(f);
  }), {message: 'codex_setup_host_scope_unavailable'});
  assert.equal(reads, 0); assert.equal(closes, 1);
});
test('knowledge scope snapshots identity and timestamp before workspace inspection yields', async t => {
  const f = await fixture(t), intended = {...f, now: new Date(f.now)};
  const api = await module({lstat: async (...args: Parameters<typeof fs.lstat>) => {
    const value = await fs.lstat(...args); f.organizationId = 'org_foreign'; f.now.setTime(0); return value;
  }});
  const actual: any = await runCodexBootstrapHost(input(f.workspace), () => api.initializeRepositoryKnowledge(f));
  assert.equal(actual.catalog.organizationId, intended.organizationId);
  assert.equal(actual.catalog.initializedAt, intended.now.toISOString());
});
test('knowledge scope retains interrupted generated staging after write and closes only its handle', async t => {
  const f = await fixture(t); let links = 0, syncs = 0, closes = 0;
  await assert.rejects(runCodexBootstrapHost(input(f.workspace), async ({scope}) => {
    const api = await module({open: async (...args: Parameters<typeof fs.open>) => {
      const handle = await fs.open(...args);
      if (!(Number(args[1]) & syncFs.constants.O_CREAT)) return handle;
      const write = handle.writeFile.bind(handle), sync = handle.sync.bind(handle), close = handle.close.bind(handle);
      handle.writeFile = async (...values: Parameters<typeof handle.writeFile>) => {const value = await write(...values); scope.close(); return value;};
      handle.sync = async () => {syncs++; return sync();}; handle.close = async () => {closes++; return close();};
      return handle;
    }, link: async (...args: Parameters<typeof fs.link>) => {links++; return fs.link(...args);}});
    await api.initializeRepositoryKnowledge(f);
  }), {message: 'codex_setup_host_scope_unavailable'});
  assert.equal(links, 0); assert.equal(syncs, 0); assert.equal(closes, 1);
  assert.equal((await fs.readdir(path.join(f.workspace, skill))).filter(name => name.startsWith('.knowledge-init-')).length, 1);
  await assert.rejects(fs.stat(path.join(f.workspace, skill, 'knowledge')), {code: 'ENOENT'});
});
test('knowledge scope preserves published intent when link result withdraws host authority', async t => {
  const f = await fixture(t); let links = 0, unlinks = 0, directories = 0;
  await assert.rejects(runCodexBootstrapHost(input(f.workspace), async ({scope}) => {
    const api = await module({link: async (...args: Parameters<typeof fs.link>) => {
      links++; await fs.link(...args); scope.close();
    }, unlink: async (...args: Parameters<typeof fs.unlink>) => {unlinks++; return fs.unlink(...args);},
    mkdir: async (...args: Parameters<typeof fs.mkdir>) => {directories++; return fs.mkdir(...args);}});
    await api.initializeRepositoryKnowledge(f);
  }), {message: 'codex_setup_host_scope_unavailable'});
  assert.equal(links, 1); assert.equal(unlinks, 0); assert.equal(directories, 0);
  assert.equal(JSON.parse(await fs.readFile(path.join(f.workspace, skill, '.repository-knowledge-init.json'), 'utf8')).organizationId, f.organizationId);
});
test('knowledge scope never invokes a native error code accessor or discloses native diagnostics', async t => {
  const f = await fixture(t); let getters = 0;
  const api = await module({lstat: async () => {throw Object.defineProperty(new Error('private native canary'), 'code', {
    get: () => {getters++; throw new Error('private getter canary');}});}});
  await assert.rejects(runCodexBootstrapHost(input(f.workspace), () => api.readRepositoryKnowledge(f)),
    {message: 'repository_knowledge_storage_unavailable'});
  assert.equal(getters, 0);
});

test('knowledge scope initializes and reuses byte-identical unsigned catalog under its original identity', async t => {
  const f = await fixture(t), api = await module();
  const first: any = await runCodexBootstrapHost(input(f.workspace), () => api.initializeRepositoryKnowledge(f));
  const catalog = path.join(f.workspace, skill, 'knowledge', 'CATALOG.json'), bytes = await fs.readFile(catalog);
  const second: any = await runCodexBootstrapHost(input(f.workspace), () =>
    api.initializeRepositoryKnowledge({...f, now: new Date('2026-10-02T00:00:00.000Z')}));
  assert.equal(first.disposition, 'initialized'); assert.equal(second.disposition, 'reused');
  assert.deepEqual(second.catalog, first.catalog); assert.deepEqual(await fs.readFile(catalog), bytes);
  assert.equal(second.catalog.provenance.authority, 'unsigned');
});

test('knowledge scope snapshots input without invoking identity accessors', async t => {
  const f = await fixture(t); let getters = 0, stats = 0;
  Object.defineProperty(f, 'organizationId', {get: () => {getters++; throw new Error('private input canary');}});
  const api = await module({lstat: async (...args: Parameters<typeof fs.lstat>) => {stats++; return fs.lstat(...args);}});
  await assert.rejects(runCodexBootstrapHost(input(f.workspace), () => api.initializeRepositoryKnowledge(f)),
    {message: 'repository_knowledge_input_invalid'});
  assert.equal(getters, 0); assert.equal(stats, 0);
});

test('knowledge scope retains an unowned staging collision without cleanup or publication', async t => {
  const f = await fixture(t); let foreignPath = '', unlinks = 0;
  const api = await module({open: async (...args: Parameters<typeof fs.open>) => {
    if (!(Number(args[1]) & syncFs.constants.O_CREAT)) return fs.open(...args);
    foreignPath = String(args[0]); await fs.writeFile(foreignPath, 'foreign');
    throw Object.assign(new Error('private collision canary'), {code: 'EEXIST'});
  }, unlink: async (...args: Parameters<typeof fs.unlink>) => {unlinks++; return fs.unlink(...args);}});
  await assert.rejects(runCodexBootstrapHost(input(f.workspace), () => api.initializeRepositoryKnowledge(f)),
    {message: 'repository_knowledge_storage_unavailable'});
  assert.equal(unlinks, 0); assert.equal(await fs.readFile(foreignPath, 'utf8'), 'foreign');
});

test('knowledge scope preserves foreign staging replacement after its acquired handle closes', async t => {
  const f = await fixture(t); let foreignPath = '', unlinks = 0;
  const api = await module({open: async (...args: Parameters<typeof fs.open>) => {
    const handle = await fs.open(...args);
    if (!(Number(args[1]) & syncFs.constants.O_CREAT)) return handle;
    foreignPath = String(args[0]); const close = handle.close.bind(handle);
    handle.close = async () => {await close(); await fs.unlink(foreignPath); await fs.writeFile(foreignPath, 'foreign');};
    return handle;
  }, link: async () => {throw new Error('private link canary');},
  unlink: async (...args: Parameters<typeof fs.unlink>) => {unlinks++; return fs.unlink(...args);}});
  await assert.rejects(runCodexBootstrapHost(input(f.workspace), () => api.initializeRepositoryKnowledge(f)),
    {message: 'repository_knowledge_cleanup_unconfirmed'});
  assert.equal(unlinks, 0); assert.equal(await fs.readFile(foreignPath, 'utf8'), 'foreign');
});

test('knowledge scope does not unlink generated evidence after uncertain staging close', async t => {
  const f = await fixture(t); let closes = 0, unlinks = 0;
  const api = await module({open: async (...args: Parameters<typeof fs.open>) => {
    const handle = await fs.open(...args);
    if (!(Number(args[1]) & syncFs.constants.O_CREAT)) return handle;
    const close = handle.close.bind(handle);
    handle.close = async () => {closes++; await close(); throw new Error('private close canary');}; return handle;
  }, unlink: async (...args: Parameters<typeof fs.unlink>) => {unlinks++; return fs.unlink(...args);}});
  await assert.rejects(runCodexBootstrapHost(input(f.workspace), () => api.initializeRepositoryKnowledge(f)),
    {message: 'repository_knowledge_cleanup_unconfirmed'});
  assert.equal(closes, 1); assert.equal(unlinks, 0);
  assert.equal((await fs.readdir(path.join(f.workspace, skill))).filter(name => name.startsWith('.knowledge-init-')).length, 1);
});
