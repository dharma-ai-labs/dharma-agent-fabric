import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rename, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import test, { type TestContext } from 'node:test';
import {
  initializeRepositoryKnowledge, readRepositoryKnowledge, validateRepositoryKnowledgeCatalog,
  REPOSITORY_KNOWLEDGE_CATALOG_PATH, REPOSITORY_KNOWLEDGE_INIT_PATH,
} from './repositoryKnowledge.js';

const root = '.agents/skills/dharma-agent-fabric';
const now = new Date('2026-09-17T00:00:00.000Z');
async function fixture(t: TestContext) {
  const workspace = await mkdtemp(resolve(tmpdir(), 'repository-knowledge-'));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const put = async (path: string, value: string) => {
    await mkdir(dirname(resolve(workspace, path)), { recursive: true });
    await writeFile(resolve(workspace, path), value);
  };
  await put(`${root}/.dharma-agent-fabric.json`, JSON.stringify({ managedBy: 'dharma-agent-fabric', workspaceId: 'device-local' }));
  return { workspace, organizationId: 'org_fixture', repositoryAgentId: 'repository-agent-fixture', now, put };
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
  return JSON.stringify(value);
}
function rehash<T extends { catalogHash: string }>(catalog: T): T {
  const { catalogHash: _hash, ...content } = catalog;
  return { ...content, catalogHash: `sha256:${createHash('sha256').update(canonical(content)).digest('hex')}` } as T;
}

test('knowledge initialization and reads permit system ancestor aliases but not workspace aliases', async t => {
  const f = await fixture(t);
  const parent = await mkdtemp(resolve(tmpdir(), 'knowledge-system-alias-'));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const alias = resolve(parent, 'system-alias');
  await symlink(dirname(f.workspace), alias, process.platform === 'win32' ? 'junction' : 'dir');
  const workspace = resolve(alias, f.workspace.slice(dirname(f.workspace).length + 1));
  const first = await initializeRepositoryKnowledge({ ...f, workspace });
  assert.equal(first.disposition, 'initialized');
  assert.deepEqual(await readRepositoryKnowledge({ ...f, workspace }), await readRepositoryKnowledge(f));
  assert.equal((await initializeRepositoryKnowledge(f)).disposition, 'reused');
  const linkedWorkspace = resolve(parent, 'workspace-alias');
  await symlink(f.workspace, linkedWorkspace, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(initializeRepositoryKnowledge({ ...f, workspace: linkedWorkspace }), /symlink/);
  await assert.rejects(readRepositoryKnowledge({ ...f, workspace: linkedWorkspace }), /symlink/);
});

test('initializes only local unsigned empty knowledge with deterministic shared repository identity', async t => {
  const a = await fixture(t);
  const b = await fixture(t);
  await a.put('.env', 'API_KEY=never-collect-this-secret');
  const first = await initializeRepositoryKnowledge(a);
  const second = await initializeRepositoryKnowledge({ ...b, now: new Date('2026-09-18T00:00:00.000Z') });
  assert.equal(first.disposition, 'initialized');
  assert.equal(first.relativePath, REPOSITORY_KNOWLEDGE_CATALOG_PATH);
  assert.equal(first.catalog.knowledgeBaseId, second.catalog.knowledgeBaseId);
  assert.deepEqual(first.catalog.concepts, []);
  assert.deepEqual(first.catalog.provenance, { origin: 'locally_initialized', authority: 'unsigned', serverReleaseId: null });
  assert.deepEqual(first.catalog.repoAtlas, { association: 'local_scope_only', findingsState: 'not_observed',
    organizationId: a.organizationId, repositoryAgentId: a.repositoryAgentId });
  const bytes = await readFile(resolve(a.workspace, first.relativePath), 'utf8');
  assert.ok(!bytes.includes(a.workspace));
  assert.ok(!bytes.includes('never-collect-this-secret'));
  assert.ok(!bytes.includes('device-local'));
  assert.equal(validateRepositoryKnowledgeCatalog(JSON.parse(bytes), a).knowledgeBaseId, first.catalog.knowledgeBaseId);
});

test('reads without creating anything and offers an explicit dry-run initialization', async t => {
  const f = await fixture(t);
  assert.equal(await readRepositoryKnowledge(f), null);
  const plan = await initializeRepositoryKnowledge({ ...f, dryRun: true });
  assert.equal(plan.disposition, 'planned');
  await assert.rejects(readFile(resolve(f.workspace, REPOSITORY_KNOWLEDGE_INIT_PATH)), { code: 'ENOENT' });
  await assert.rejects(readFile(resolve(f.workspace, REPOSITORY_KNOWLEDGE_CATALOG_PATH)), { code: 'ENOENT' });
});

test('replay preserves existing concepts and exact catalog bytes, not the new clock', async t => {
  const f = await fixture(t);
  const first = await initializeRepositoryKnowledge(f);
  const updated = rehash({ ...first.catalog, concepts: [{ conceptId: 'concept_review',
    relativePath: 'concepts/review.md', sha256: `sha256:${'a'.repeat(64)}` }] });
  const staged = resolve(f.workspace, `${root}/updated.json`);
  const bytes = `${canonical(updated)}\n`;
  await writeFile(staged, bytes);
  await rename(staged, resolve(f.workspace, first.relativePath));
  const replay = await initializeRepositoryKnowledge({ ...f, now: new Date('2026-09-19T00:00:00.000Z') });
  assert.equal(replay.disposition, 'reused');
  assert.deepEqual(replay.catalog, updated);
  assert.equal(await readFile(resolve(f.workspace, first.relativePath), 'utf8'), bytes);
});

test('concurrent first creation publishes one complete catalog and reuses it', async t => {
  const f = await fixture(t);
  const results = await Promise.all(Array.from({ length: 12 }, () => initializeRepositoryKnowledge(f)));
  assert.equal(results.filter(result => result.disposition === 'initialized').length, 1);
  assert.ok(results.every(result => canonical(result.catalog) === canonical(results[0]!.catalog)));
  assert.deepEqual(await readRepositoryKnowledge(f), results[0]!.catalog);
});

test('competing organizations cannot share or replace a first initialization', async t => {
  const f = await fixture(t);
  const inputs = [f, { ...f, organizationId: 'org_other' }];
  const results = await Promise.allSettled(inputs.map(input => initializeRepositoryKnowledge(input)));
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.filter(result => result.status === 'rejected').length, 1);
  const winner = results.findIndex(result => result.status === 'fulfilled');
  const catalog = await readRepositoryKnowledge(inputs[winner]!);
  assert.equal(catalog?.organizationId, inputs[winner]!.organizationId);
  await assert.rejects(readRepositoryKnowledge(inputs[1 - winner]!));
});

test('resumes interruption after durable intent publication with or without the empty directory', async t => {
  for (const emptyDirectory of [false, true]) {
    const f = await fixture(t);
    const first = await initializeRepositoryKnowledge(f);
    await unlink(resolve(f.workspace, first.relativePath));
    if (!emptyDirectory) await rm(resolve(f.workspace, `${root}/knowledge`), { recursive: true });
    assert.equal(await readRepositoryKnowledge(f), null);
    const recovered = await initializeRepositoryKnowledge(f);
    assert.deepEqual(recovered.catalog, first.catalog);
    assert.equal(recovered.disposition, 'initialized');
  }
});

test('ignores but never deletes an interrupted private staging file', async t => {
  const f = await fixture(t);
  const path = `${root}/.knowledge-init-00000000-0000-4000-8000-000000000000.tmp`;
  await f.put(path, 'incomplete private staging');
  await initializeRepositoryKnowledge(f);
  assert.equal(await readFile(resolve(f.workspace, path), 'utf8'), 'incomplete private staging');
});

test('fails closed on a corrupt or foreign initialization record without publishing a catalog', async t => {
  const f = await fixture(t);
  const { catalog } = await initializeRepositoryKnowledge({ ...f, dryRun: true });
  for (const bytes of ['{', canonical(rehash({ ...catalog, organizationId: 'org_other' }))]) {
    await f.put(REPOSITORY_KNOWLEDGE_INIT_PATH, bytes);
    await assert.rejects(initializeRepositoryKnowledge(f), /invalid|identity|scope/i);
    await assert.rejects(readRepositoryKnowledge(f), /invalid|identity|scope/i);
    await assert.rejects(readFile(resolve(f.workspace, REPOSITORY_KNOWLEDGE_CATALOG_PATH)), { code: 'ENOENT' });
    assert.equal(await readFile(resolve(f.workspace, REPOSITORY_KNOWLEDGE_INIT_PATH), 'utf8'), bytes);
  }
});

test('rejects other organization and repository identities, including valid rehashed foreign scopes', async t => {
  const f = await fixture(t);
  const result = await initializeRepositoryKnowledge(f);
  for (const input of [{ ...f, organizationId: 'org_other' }, { ...f, repositoryAgentId: 'another-agent' }]) {
    await assert.rejects(initializeRepositoryKnowledge(input), /identity|scope/i);
    await assert.rejects(readRepositoryKnowledge(input), /identity|scope/i);
  }
  const foreign = rehash({ ...result.catalog, repoAtlas: { ...result.catalog.repoAtlas, repositoryAgentId: 'another-agent' } });
  assert.throws(() => validateRepositoryKnowledgeCatalog(foreign, f), /identity|scope/i);
});

test('rejects unmanaged skill roots, knowledge directories, and pre-existing catalogs without overwriting', async t => {
  for (const variant of ['marker', 'empty', 'file']) {
    const f = await fixture(t);
    if (variant === 'marker') await unlink(resolve(f.workspace, `${root}/.dharma-agent-fabric.json`));
    if (variant === 'empty') await mkdir(resolve(f.workspace, `${root}/knowledge`));
    if (variant === 'file') await f.put(REPOSITORY_KNOWLEDGE_CATALOG_PATH, '{"customerOwned":true}');
    await assert.rejects(initializeRepositoryKnowledge(f), /unmanaged|invalid/i);
    await assert.rejects(readRepositoryKnowledge(f), /unmanaged|invalid/i);
    if (variant === 'file') assert.equal(await readFile(resolve(f.workspace, REPOSITORY_KNOWLEDGE_CATALOG_PATH), 'utf8'), '{"customerOwned":true}');
  }
});

test('does not adopt unmanaged files during initialization recovery', async t => {
  const f = await fixture(t);
  await initializeRepositoryKnowledge(f);
  await unlink(resolve(f.workspace, REPOSITORY_KNOWLEDGE_CATALOG_PATH));
  await f.put(`${root}/knowledge/customer.md`, 'customer content');
  await assert.rejects(initializeRepositoryKnowledge(f), /unmanaged/i);
  assert.equal(await readFile(resolve(f.workspace, `${root}/knowledge/customer.md`), 'utf8'), 'customer content');
});

test('rejects static symlinks at every managed boundary and the workspace itself', async t => {
  for (const path of ['.agents', `${root}/knowledge`, REPOSITORY_KNOWLEDGE_CATALOG_PATH,
    REPOSITORY_KNOWLEDGE_INIT_PATH, `${root}/.dharma-agent-fabric.json`]) {
    const f = await fixture(t);
    const outside = await fixture(t);
    const target = resolve(f.workspace, path);
    await mkdir(dirname(target), { recursive: true });
    await rm(target, { recursive: true, force: true });
    const isFile = path.endsWith('.json');
    await symlink(isFile ? resolve(outside.workspace, `${root}/.dharma-agent-fabric.json`) : outside.workspace,
      target, isFile ? 'file' : process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(initializeRepositoryKnowledge(f), /symlink/i);
    await assert.rejects(readRepositoryKnowledge(f), /symlink/i);
  }
  const f = await fixture(t);
  const alias = `${f.workspace}-alias`;
  t.after(() => rm(alias, { force: true }));
  await symlink(f.workspace, alias, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(initializeRepositoryKnowledge({ ...f, workspace: alias }), /symlink/i);
});

test('fails closed on corrupt, oversized, forged provenance and invalid integrity catalogs', async t => {
  const f = await fixture(t);
  const result = await initializeRepositoryKnowledge(f);
  for (const bytes of ['{', 'x'.repeat(1_048_577), canonical({ ...result.catalog, catalogHash: `sha256:${'0'.repeat(64)}` }),
    canonical(rehash({ ...result.catalog, provenance: { ...result.catalog.provenance, authority: 'signed' } }))]) {
    await writeFile(resolve(f.workspace, REPOSITORY_KNOWLEDGE_CATALOG_PATH), bytes);
    await assert.rejects(readRepositoryKnowledge(f), /invalid|limit|integrity/i);
    await assert.rejects(initializeRepositoryKnowledge(f), /invalid|limit|integrity/i);
    assert.equal(await readFile(resolve(f.workspace, REPOSITORY_KNOWLEDGE_CATALOG_PATH), 'utf8'), bytes);
  }
});

test('rejects unsafe POSIX/Windows concept paths, environment/secret references and invalid shared identities', async t => {
  const f = await fixture(t);
  const { catalog } = await initializeRepositoryKnowledge(f);
  for (const relativePath of ['../secret.md', '/etc/passwd', 'C:\\private\\file.md', '\\\\host\\share\\file.md',
    'concepts/../escape.md', 'concepts/.env', 'concepts/secrets.md', 'concepts/credentials.json',
    'concepts/CON.md', 'concepts/readme.md:stream', 'concepts/guide./file.md']) {
    const value = rehash({ ...catalog, concepts: [{ conceptId: 'concept_safe', relativePath, sha256: `sha256:${'a'.repeat(64)}` }] });
    assert.throws(() => validateRepositoryKnowledgeCatalog(value, f), /invalid|unsafe/i);
  }
  for (const repositoryAgentId of ['../repo', 'C:\\repo', 'repo/child', 'repo:stream', ' repo', '', undefined, null]) {
    await assert.rejects(initializeRepositoryKnowledge({ ...f, repositoryAgentId: repositoryAgentId as string }), /identity/i);
  }
  const injected = rehash({ ...catalog, password: 'never-retain-this-secret' });
  assert.throws(() => validateRepositoryKnowledgeCatalog(injected, f), /invalid/i);
});

test('JSON schema and runtime validator agree on catalog structure and unsigned provenance', async t => {
  const f = await fixture(t);
  const { catalog } = await initializeRepositoryKnowledge(f);
  const require = createRequire(import.meta.url);
  const Ajv2020 = require('ajv/dist/2020.js').default;
  const addFormats = require('ajv-formats').default;
  const schema = JSON.parse(await readFile(new URL('../../../schemas/repository-knowledge.schema.json', import.meta.url), 'utf8'));
  const ajv = new Ajv2020({ strict: true });
  addFormats(ajv);
  const validate = ajv.compile(schema);
  assert.equal(validate(catalog), true, JSON.stringify(validate.errors));
  for (const invalid of [{ ...catalog, workspaceId: 'not-shared' },
    { ...catalog, initializedAt: '2026-02-31T00:00:00.000Z' },
    { ...catalog, provenance: { ...catalog.provenance, serverReleaseId: 'invented-server-release' } },
    { ...catalog, concepts: [{ conceptId: 'concept_bad', relativePath: '../secret.md', sha256: 'invalid' }] }]) {
    assert.equal(validate(invalid), false);
    assert.throws(() => validateRepositoryKnowledgeCatalog(invalid, f));
  }
});

test('rejects duplicate concept identities and Windows case-colliding paths without rewriting', async t => {
  const f = await fixture(t);
  const { catalog } = await initializeRepositoryKnowledge(f);
  const concept = { conceptId: 'concept_review', relativePath: 'concepts/Review.md', sha256: `sha256:${'a'.repeat(64)}` };
  for (const second of [{ ...concept, relativePath: 'concepts/Other.md' },
    { ...concept, conceptId: 'concept_other', relativePath: 'concepts/review.md' }]) {
    assert.throws(() => validateRepositoryKnowledgeCatalog(rehash({ ...catalog, concepts: [concept, second] }), f), /invalid|unsafe/i);
  }
});
