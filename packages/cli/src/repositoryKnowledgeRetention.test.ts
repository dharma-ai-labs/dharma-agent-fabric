import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rename, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import test, { type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { canonicalize, signCanonicalObject, validateContract } from '@dharma-ai-labs/agent-fabric-contracts';
import { calculateBundleHash, contentHash, installSkillBundle, readVerifiedRepositoryKnowledge } from '@dharma-ai-labs/agent-fabric-skill-manager';
import type { OrganizationPolicy } from '@dharma-ai-labs/agent-fabric-policy';
import * as knowledge from './repositoryKnowledge.js';
import { inventoryRepositoryPackage, serializeRepositoryPackageSnapshot, writeRepositoryPackageSnapshot } from './repositoryPackage.js';
import { RepositorySourceWatcher, scanRepositorySourceChanges } from './repositorySourceSync.js';
import { selectInstalledRepositoryKnowledge } from './repositoryInstalledKnowledge.js';

const ROOT = '.agents/skills/dharma-agent-fabric';
const CATALOG = `${ROOT}/knowledge/CATALOG.json`, MANIFEST = `${ROOT}/MANIFEST.json`;
const digest = (value: string | Buffer) => `sha256:${createHash('sha256').update(value).digest('hex')}`;
const H = digest('synthetic source fixture');
const scope = { organizationId: 'org_retention_fixture', workspaceId: '056b63dc-ebed-48ed-85d8-02c72f623ea8',
  repositoryBindingId: '73a95988-fd64-41ba-a0b9-6c8867d03788', repositoryAgentId: '57f61652-a5eb-46e4-930c-9478cd4a9c31' };
function authorization() {
  const generationId = '1a731db0-d1bb-469c-8ffd-e1f10bece914';
  const policy = { action: 'authorize', confirmed: true, requestId: '5ff2ee1b-6cb3-459e-a977-ea99c757bf30',
    repositoryBindingId: scope.repositoryBindingId, expectedRevision: 0,
    allowedContentClasses: ['approved_outputs', 'repository_content', 'repository_skills'],
    approvedRepositoryPaths: ['README.md', 'docs'], approvedOutputFolders: ['output/approved'], automaticValidatedPublication: true,
    retentionDays: 30, maximumFileBytes: 262144, maximumSnapshotBytes: 4194304, maximumDailyUploadBytes: 8388608, expiresAt: null };
  return { schema: 'dharma.repository-source-authorization/v1', ...scope, revision: 1, generationId,
    receiptId: `repo_consent_${generationId}`, policyRevision: `repository-source-${generationId}`,
    policyHash: digest(canonicalize(policy)), confirmedAt: '2020-01-01T00:00:00+00:00', policy };
}
type SourceObservation = { kind: string; catalog: { concepts: unknown[]; unresolved?: unknown[] }; catalogBytes: Buffer;
  manifestBytes?: Buffer; reference?: Record<string, unknown> };
function readSource(input: typeof scope & { workspace: string }): Promise<SourceObservation | null> {
  return (knowledge as unknown as { readRepositoryKnowledgeSource: (value: typeof scope & { workspace: string }) => Promise<SourceObservation | null> })
    .readRepositoryKnowledgeSource(input);
}
function rehash(snapshot: Awaited<ReturnType<typeof inventoryRepositoryPackage>>) {
  const { snapshotHash: _hash, snapshotId: _id, ...base } = snapshot.manifest;
  const snapshotHash = digest(canonicalize(base));
  return { ...snapshot, manifest: { ...base, snapshotHash, snapshotId: `repository-package-${snapshotHash.slice(7)}` } };
}
async function fixture(t: TestContext) {
  const workspace = await mkdtemp(resolve(tmpdir(), 'repository-knowledge-retention-'));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const put = async (path: string, content: string | Buffer) => {
    await mkdir(dirname(resolve(workspace, path)), { recursive: true });
    if (path === CATALOG) {
      await writeFile(resolve(workspace, `${CATALOG}.pending`), content);
      await rename(resolve(workspace, `${CATALOG}.pending`), resolve(workspace, CATALOG));
    } else await writeFile(resolve(workspace, path), content);
  };
  await put(`${ROOT}/.dharma-agent-fabric.json`, JSON.stringify({ managedBy: 'dharma-agent-fabric', workspaceId: scope.workspaceId }));
  const initial = await knowledge.initializeRepositoryKnowledge({ ...scope, workspace, now: new Date('2026-09-17T00:00:00Z') });
  const initialCatalogBytes = await readFile(resolve(workspace, CATALOG));
  const conceptId = `concept_${digest(canonicalize({ schema: 'dharma.repository-concept-identity/v1',
    organizationId: scope.organizationId, repositoryAgentId: scope.repositoryAgentId, name: 'tenant boundary' })).slice(7)}`;
  const catalog = { schema: 'dharma.repository-knowledge/v2', managedBy: 'dharma-agent-fabric',
    organizationId: scope.organizationId, repositoryAgentId: scope.repositoryAgentId, knowledgeBaseId: initial.catalog.knowledgeBaseId,
    generation: 2, authority: 'requires_verified_release', policyHash: H, sourceSnapshotHash: H,
    sourceLocalCatalogHash: initial.catalog.catalogHash, projectionHash: H,
    repoAtlas: { associationId: 'decb788c-f9f5-45e6-934c-0d3f0d796ec6', knowledgeBaseId: initial.catalog.knowledgeBaseId,
      organizationId: scope.organizationId, repositoryAgentId: scope.repositoryAgentId, basis: 'semantic_analysis',
      sourceWindowIds: ['acbe76d4-e2cd-4b4d-ae0f-d8dd3a92de21'], analysisHash: H },
    concepts: [{ conceptId, canonicalName: 'Tenant boundary', aliases: ['Organization scope'],
      definition: 'Customer identity is organization-scoped.',
      sources: [{ sourceId: '7abe76d4-e2cd-4b4d-ae0f-d8dd3a92de21', sourceHash: H, firstLine: 1, lastLine: 1,
        quote: 'Customer identity is organization-scoped.' }] }],
    unresolved: [{ proposalHash: H, reason: 'conflicting_definition', conceptId }] };
  const catalogBytes = Buffer.from(`${canonicalize(catalog)}\n`);
  const manifest = { schema: 'dharma.repository-release-manifest/v1', organizationId: scope.organizationId,
    repositoryAgentId: scope.repositoryAgentId, generation: 2, authority: 'requires_verified_release', sourceManifestHash: H,
    sourceSnapshotHash: H, policyHash: H, knowledgeBaseId: initial.catalog.knowledgeBaseId,
    atlasAssociationId: catalog.repoAtlas.associationId, sourceSkills: [],
    files: [{ path: `${ROOT}/SKILL.md`, sha256: digest('# Shared skill\n'), sizeBytes: Buffer.byteLength('# Shared skill\n'), role: 'skill' },
      { path: CATALOG, sha256: digest(catalogBytes), sizeBytes: catalogBytes.length, role: 'knowledge' },
      { path: '.dharma/onboarding-prompt.md', sha256: digest('Prompt\n'), sizeBytes: 7, role: 'onboarding_prompt' }] };
  const manifestBytes = Buffer.from(`${canonicalize(manifest)}\n`);
  await put('README.md', '# Shared repository');
  await put('skills/review/SKILL.md', '# Review');
  await put(`${ROOT}/SKILL.md`, '# Shared skill\n');
  await put(CATALOG, catalogBytes); await put(MANIFEST, manifestBytes);
  return { workspace, put, catalog, catalogBytes, initialCatalogBytes, manifest, manifestBytes, input: { ...scope, workspace, sourceAuthorization: authorization() } };
}

test('governed inventory retains populated delivered v2 knowledge without relabeling it as unsigned v1', async t => {
  const f = await fixture(t);
  const snapshot = await inventoryRepositoryPackage(f.input);
  assert.equal(snapshot.manifest.schema, 'dharma.repository-package/v3');
  const mapping = snapshot.manifest.knowledge as unknown as Record<string, unknown>;
  assert.equal(mapping.authority, 'unverified_prior_release_reference');
  assert.equal(mapping.atlasAssociation, 'requires_verified_release');
  assert.equal(mapping.catalogHash, digest(f.catalogBytes));
  const blobs = new Map(snapshot.blobs.map(blob => [blob.sha256, Buffer.from(blob.contentBase64, 'base64')]));
  for (const [path, bytes] of [[CATALOG, f.catalogBytes], [MANIFEST, f.manifestBytes]] as const) {
    const file = snapshot.manifest.files.find(file => file.path === path);
    assert.ok(file); assert.equal(file.role, 'knowledge');
    assert.deepEqual(blobs.get(file.sha256), bytes);
  }
  const serialized = serializeRepositoryPackageSnapshot(snapshot);
  const schema = await validateContract(fileURLToPath(new URL('./schemas/', import.meta.url)),
    'https://schemas.dharma-ai.io/repository-package/v3', snapshot.manifest);
  assert.equal(schema.ok, true, schema.ok ? '' : JSON.stringify(schema.errors));
  assert.ok(!serialized.includes('serverReleaseId'));
  const persisted = await writeRepositoryPackageSnapshot({ workspace: f.workspace, snapshot, candidateOnly: true });
  assert.equal(persisted.disposition, 'candidate_only');
  assert.deepEqual(await readFile(resolve(f.workspace, CATALOG)), f.catalogBytes);
  assert.deepEqual(await readFile(resolve(f.workspace, MANIFEST)), f.manifestBytes);
});

test('source reader returns delivered knowledge as an observation with exact bytes and no invented release identity', async t => {
  const f = await fixture(t);
  const observed = await readSource(f.input);
  assert.ok(observed); assert.equal(observed.kind, 'delivered_v2_requires_verified_release');
  assert.deepEqual(observed.catalog, f.catalog);
  assert.deepEqual(observed.catalogBytes, f.catalogBytes);
  assert.deepEqual(observed.manifestBytes, f.manifestBytes);
  assert.equal(observed.reference?.generation, 2);
  assert.equal(observed.reference?.catalogHash, digest(f.catalogBytes));
  assert.equal(observed.reference?.manifestHash, digest(f.manifestBytes));
  assert.equal(observed.reference?.repositoryBindingId, scope.repositoryBindingId);
  assert.equal(observed.reference?.authority, 'unverified_prior_release_reference');
  assert.equal(Object.hasOwn(observed.reference!, 'releaseId'), false);
  assert.equal(Object.hasOwn(observed.reference!, 'bundleId'), false);
});

test('v1 reader and local initialization remain unsigned and fail closed instead of clearing delivered knowledge', async t => {
  const f = await fixture(t);
  await assert.rejects(knowledge.initializeRepositoryKnowledge(f.input), /knowledge/);
  assert.deepEqual(await readFile(resolve(f.workspace, CATALOG)), f.catalogBytes);
  await assert.rejects(knowledge.readRepositoryKnowledge(f.input), /knowledge/);
  const other = await fixture(t);
  await unlink(resolve(other.workspace, CATALOG)); await unlink(resolve(other.workspace, MANIFEST));
  await knowledge.initializeRepositoryKnowledge(other.input);
  const observed = await readSource(other.input);
  assert.equal(observed?.kind, 'local_v1_unsigned');
  assert.equal(observed?.reference, undefined);
});

for (const mode of ['foreign_catalog', 'foreign_manifest', 'generation', 'policy', 'snapshot', 'atlas', 'catalog_hash', 'catalog_size', 'missing_manifest'] as const) {
  test(`delivered knowledge retention rejects ${mode} without modifying the existing catalog`, async t => {
    const f = await fixture(t);
    if (mode === 'foreign_catalog') f.catalog.organizationId = 'org_other';
    else if (mode === 'foreign_manifest') f.manifest.repositoryAgentId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    else if (mode === 'generation') f.manifest.generation = 3;
    else if (mode === 'policy') f.manifest.policyHash = digest('other policy');
    else if (mode === 'snapshot') f.manifest.sourceSnapshotHash = digest('other snapshot');
    else if (mode === 'atlas') f.manifest.atlasAssociationId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    else if (mode === 'catalog_hash') f.manifest.files.find(file => file.path === CATALOG)!.sha256 = digest('other catalog');
    else if (mode === 'catalog_size') f.manifest.files.find(file => file.path === CATALOG)!.sizeBytes++;
    const before = Buffer.from(`${canonicalize(f.catalog)}\n`);
    await f.put(CATALOG, before);
    if (mode === 'missing_manifest') await unlink(resolve(f.workspace, MANIFEST));
    else await f.put(MANIFEST, `${canonicalize(f.manifest)}\n`);
    await assert.rejects(inventoryRepositoryPackage(f.input), /knowledge|retention|release|scope/i);
    assert.deepEqual(await readFile(resolve(f.workspace, CATALOG)), before);
  });
}

test('autonomous source scan retains delivered concepts and conflicts while collecting an approved report edit', async t => {
  const f = await fixture(t);
  await f.put('output/approved/report.md', 'An authorized new observation.');
  const a = authorization();
  const transport = { signedGet: async () => ({ ok: true, organizationId: scope.organizationId,
    policy: { organizationId: scope.organizationId, repositoryBindingId: scope.repositoryBindingId, repositoryAgentId: scope.repositoryAgentId,
      current: { active: true, reason: 'authorized', ...a } } }) };
  const watcher = new RepositorySourceWatcher(1000);
  let now = 0;
  const input = { ...f.input, transport, watcher, monotonicNow: () => now };
  assert.equal((await scanRepositorySourceChanges(input)).state, 'debouncing');
  now = 1000;
  const result = await scanRepositorySourceChanges(input);
  assert.equal(result.state, 'local_candidate_collected');
  assert.equal(result.sharedAuthority, 'pending');
  assert.deepEqual(await readFile(resolve(f.workspace, CATALOG)), f.catalogBytes);
  assert.deepEqual(await readFile(resolve(f.workspace, MANIFEST)), f.manifestBytes);
  now = 2000;
  assert.equal((await scanRepositorySourceChanges(input)).state, 'unchanged');
});

test('retained knowledge cannot be collected through a symlinked catalog or without governed repository identity', async t => {
  const f = await fixture(t), other = await fixture(t);
  await unlink(resolve(f.workspace, CATALOG));
  await symlink(resolve(other.workspace, CATALOG), resolve(f.workspace, CATALOG));
  await assert.rejects(inventoryRepositoryPackage(f.input), /symlink/);
  await assert.rejects(inventoryRepositoryPackage({ ...other.input, sourceAuthorization: undefined }), /governed|authorization|retention|knowledge/i);
  assert.deepEqual(await readFile(resolve(other.workspace, CATALOG)), other.catalogBytes);
});

for (const mode of ['binding', 'generation', 'catalog_hash', 'manifest_hash', 'catalog_size', 'authority', 'downgrade', 'missing_knowledge', 'missing_reference'] as const) {
  test(`serializer rejects self-rehashed retained reference ${mode} without implying signed authority`, async t => {
    const f = await fixture(t);
    const snapshot = await inventoryRepositoryPackage(f.input);
    assert.equal(snapshot.manifest.schema, 'dharma.repository-package/v3');
    const mutated = structuredClone(snapshot);
    const mapping = mutated.manifest.knowledge as unknown as Record<string, unknown>;
    const reference = mapping.priorRelease as Record<string, unknown>;
    if (mode === 'binding') reference.repositoryBindingId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    else if (mode === 'generation') reference.generation = 3;
    else if (mode === 'catalog_hash') reference.catalogHash = digest('foreign catalog');
    else if (mode === 'manifest_hash') reference.manifestHash = digest('foreign manifest');
    else if (mode === 'catalog_size') reference.catalogSizeBytes = Number(reference.catalogSizeBytes) + 1;
    else if (mode === 'authority') mapping.authority = 'requires_verified_release';
    else if (mode === 'downgrade') mutated.manifest.schema = 'dharma.repository-package/v2';
    else if (mode === 'missing_reference') delete mapping.priorRelease;
    else delete mutated.manifest.knowledge;
    assert.throws(() => serializeRepositoryPackageSnapshot(rehash(mutated)), /knowledge|retention|integrity|scope/i);
    assert.deepEqual(await readFile(resolve(f.workspace, CATALOG)), f.catalogBytes);
  });
}

test('retention schema and opaque catalog parsing reject injected release IDs, unknown fields and oversized bytes', async t => {
  const f = await fixture(t);
  const observed = await readSource(f.input); assert.ok(observed?.reference);
  const validate = (knowledge as unknown as { validateRepositoryKnowledgeRetention: (value: unknown) => unknown }).validateRepositoryKnowledgeRetention;
  assert.throws(() => validate({ identity: scope, catalogBytes: f.catalogBytes, manifestBytes: f.manifestBytes,
    reference: { ...observed.reference, releaseId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' } }), /retention/);
  await f.put(CATALOG, `${canonicalize({ ...f.catalog, arbitraryAuthority: 'trusted' })}\n`);
  await assert.rejects(readSource(f.input), /schema/);
  await f.put(CATALOG, Buffer.alloc(262145, 'x'));
  await assert.rejects(readSource(f.input), /limit/);
});

test('serializer counts every file instance toward total budgets even when content blobs are deduplicated', async t => {
  const f = await fixture(t);
  const snapshot = await inventoryRepositoryPackage(f.input);
  const content = Buffer.alloc(65536, 'x'), sha256 = digest(content);
  snapshot.blobs.push({ sha256, contentBase64: content.toString('base64') });
  for (let n = 0; n < 65; n++) snapshot.manifest.files.push({ path: `docs/copy-${n}.md`, role: 'repository_content', sha256, sizeBytes: content.length });
  const a = snapshot.manifest.sourceAuthorization!;
  snapshot.manifest.sourceFingerprint = digest(canonicalize({ organizationId: snapshot.manifest.organizationId,
    repositoryBindingId: a.repositoryBindingId, repositoryAgentId: a.repositoryAgentId,
    generationId: a.generationId, policyHash: a.policyHash,
    files: snapshot.manifest.files.filter(file => file.role !== 'knowledge'), skills: snapshot.manifest.skills }));
  assert.throws(() => serializeRepositoryPackageSnapshot(rehash(snapshot)), /byte limit/);
});

test('locally edited canonical knowledge remains an unverified retention claim rather than an approved update', async t => {
  const f = await fixture(t);
  f.catalog.concepts[0]!.definition = 'A changed local definition that requires trusted server resolution.';
  const edited = Buffer.from(`${canonicalize(f.catalog)}\n`);
  const entry = f.manifest.files.find(file => file.path === CATALOG)!;
  entry.sha256 = digest(edited); entry.sizeBytes = edited.length;
  await f.put(CATALOG, edited); await f.put(MANIFEST, `${canonicalize(f.manifest)}\n`);
  const snapshot = await inventoryRepositoryPackage(f.input);
  assert.equal(snapshot.manifest.authority, 'local_inventory_not_signed');
  assert.equal(snapshot.manifest.knowledge?.authority, 'unverified_prior_release_reference');
  const collected = await writeRepositoryPackageSnapshot({ workspace: f.workspace, snapshot });
  assert.equal(collected.disposition, 'candidate_only');
  assert.equal(collected.managedCopiesPath, null);
  assert.deepEqual(await readFile(resolve(f.workspace, CATALOG)), edited);
});

test('installed-provider ownership marker is scoped without inventing a release ID from its bundle', async t => {
  const f = await fixture(t);
  await f.put(`${ROOT}/.dharma-agent-fabric.json`, JSON.stringify({ bundleId: 'fe8cf113-3c95-4baf-a7b9-941a2d1f5bb2',
    skillId: 'repository-agent-fabric-package', workspaceId: scope.workspaceId }));
  const observed = await readSource(f.input);
  assert.ok(observed?.reference);
  assert.equal(Object.hasOwn(observed.reference, 'bundleId'), false);
  await f.put(`${ROOT}/.dharma-agent-fabric.json`, JSON.stringify({ bundleId: 'fe8cf113-3c95-4baf-a7b9-941a2d1f5bb2',
    skillId: 'repository-agent-fabric-package', workspaceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }));
  await assert.rejects(readSource(f.input), /Unmanaged/);
});

test('actual public native installation supplies populated knowledge to governed work-repository inventory', async t => {
  const f = await fixture(t), native = await mkdtemp(resolve(tmpdir(), 'repository-knowledge-native-'));
  t.after(() => rm(native, { recursive: true, force: true }));
  const server = generateKeyPairSync('ed25519'), device = generateKeyPairSync('ed25519'), deviceId = randomUUID();
  const unsigned = { schema: 'dharma.skill-bundle/v2' as const, bundleId: randomUUID(), organizationId: scope.organizationId,
    version: '2', operation: 'install' as const, skills: [{ skillId: 'dharma-agent-fabric', version: '2',
      repository: 'https://github.com/synthetic/control.git', commit: 'b'.repeat(40), path: ROOT,
      contentHash: await contentHash(resolve(f.workspace, ROOT)) }], riskClass: 'R2' as const,
    targetSelectors: { organizationAgentIds: [scope.repositoryAgentId], deviceIds: [deviceId], workspaceIds: [scope.workspaceId], providers: ['codex' as const] },
    activationPolicy: 'next_session' as const, rollbackBundleId: null, evaluationReceiptId: 'synthetic-not-live-evaluation',
    createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 3600000).toISOString() };
  const bundleHash = calculateBundleHash(unsigned), bundle = { ...unsigned, bundleHash, signature: signCanonicalObject({ ...unsigned, bundleHash }, server.privateKey) };
  const receipt = await installSkillBundle({ bundle, sourceDirectory: f.workspace, nativeSkillDirectory: native,
    policy: { organizationId: scope.organizationId, skills: { automaticInstall: true } } as OrganizationPolicy,
    serverPublicKey: server.publicKey, devicePrivateKey: device.privateKey, deviceId, organizationAgentId: scope.repositoryAgentId,
    workspaceId: scope.workspaceId, provider: 'codex' });
  await f.put(CATALOG, f.initialCatalogBytes);
  const observed = await readVerifiedRepositoryKnowledge({ nativeSkillDirectory: native, organizationId: scope.organizationId,
    organizationAgentId: scope.repositoryAgentId, workspaceId: scope.workspaceId, deviceId, provider: 'codex',
    serverPublicKey: server.publicKey, devicePublicKey: device.publicKey, expectedReceiptHash: receipt.receiptHash });
  assert.ok(observed);
  const inventoryInput = { ...f.input, retainedKnowledge: observed };
  const snapshot = await inventoryRepositoryPackage(inventoryInput);
  assert.equal(snapshot.manifest.schema, 'dharma.repository-package/v3');
  const catalogFile = snapshot.manifest.files.find(file => file.path === CATALOG)!;
  assert.deepEqual(Buffer.from(snapshot.blobs.find(blob => blob.sha256 === catalogFile.sha256)!.contentBase64, 'base64'), f.catalogBytes);
  assert.deepEqual(await readFile(resolve(f.workspace, CATALOG)), f.initialCatalogBytes);
});

test('autonomous scan resolves receipt-pinned knowledge and rechecks it before candidate persistence', async t => {
  const f = await fixture(t);
  await f.put(CATALOG, f.initialCatalogBytes);
  const a = authorization(), watcher = new RepositorySourceWatcher(1000);
  const transport = { signedGet: async () => ({ ok: true, organizationId: scope.organizationId,
    policy: { organizationId: scope.organizationId, repositoryBindingId: scope.repositoryBindingId, repositoryAgentId: scope.repositoryAgentId,
      current: { active: true, reason: 'authorized', ...a } } }) };
  let now = 0, calls = 0;
  const input = { ...f.input, transport, watcher, monotonicNow: () => now,
    loadRetainedKnowledge: async () => { calls++; return { catalogBytes: f.catalogBytes, manifestBytes: f.manifestBytes }; } };
  assert.equal((await scanRepositorySourceChanges(input)).state, 'debouncing'); now = 1000;
  const result = await scanRepositorySourceChanges(input);
  assert.equal(result.state, 'local_candidate_collected'); assert.equal(calls, 3);
  assert.deepEqual(await readFile(resolve(f.workspace, CATALOG)), f.initialCatalogBytes);
});

test('autonomous scan blocks when the verified retained release changes during collection', async t => {
  const f = await fixture(t), a = authorization(), watcher = new RepositorySourceWatcher(1000);
  const transport = { signedGet: async () => ({ ok: true, organizationId: scope.organizationId,
    policy: { organizationId: scope.organizationId, repositoryBindingId: scope.repositoryBindingId, repositoryAgentId: scope.repositoryAgentId,
      current: { active: true, reason: 'authorized', ...a } } }) };
  let now = 0, calls = 0;
  const input = { ...f.input, transport, watcher, monotonicNow: () => now,
    loadRetainedKnowledge: async () => ++calls > 2 ? null : { catalogBytes: f.catalogBytes, manifestBytes: f.manifestBytes } };
  assert.equal((await scanRepositorySourceChanges(input)).state, 'debouncing'); now = 1000;
  await assert.rejects(scanRepositorySourceChanges(input), /release|knowledge.*changed/i);
  assert.deepEqual(await readFile(resolve(f.workspace, CATALOG)), f.catalogBytes);
});

test('installed provider selection keeps the highest observed valid generation without manufacturing activation', async t => {
  const f = await fixture(t), newerCatalog = structuredClone(f.catalog), newerManifest = structuredClone(f.manifest);
  newerCatalog.generation = 3; newerManifest.generation = 3;
  const catalogBytes = Buffer.from(`${canonicalize(newerCatalog)}\n`);
  const entry = newerManifest.files.find(file => file.path === CATALOG)!; entry.sha256 = digest(catalogBytes); entry.sizeBytes = catalogBytes.length;
  const manifestBytes = Buffer.from(`${canonicalize(newerManifest)}\n`), calls: string[] = [];
  const observed = await selectInstalledRepositoryKnowledge({ ...scope, loadProvider: async provider => {
    calls.push(provider); return provider === 'codex' ? { catalogBytes: f.catalogBytes, manifestBytes: f.manifestBytes }
      : provider === 'claude' ? { catalogBytes, manifestBytes } : null;
  } });
  assert.deepEqual(calls, ['codex', 'claude', 'agy', 'hermes']);
  assert.ok(observed); assert.deepEqual(observed.catalogBytes, catalogBytes);
  const snapshot = await inventoryRepositoryPackage({ ...f.input, retainedKnowledge: observed });
  assert.equal(snapshot.manifest.knowledge?.authority, 'unverified_prior_release_reference');
  assert.deepEqual(await readFile(resolve(f.workspace, CATALOG)), f.catalogBytes);
});

test('installed provider selection rejects conflicting bytes for one generation', async t => {
  const f = await fixture(t), catalog = structuredClone(f.catalog), manifest = structuredClone(f.manifest);
  catalog.concepts[0]!.definition = 'A conflicting same-generation definition.';
  const catalogBytes = Buffer.from(`${canonicalize(catalog)}\n`), entry = manifest.files.find(file => file.path === CATALOG)!;
  entry.sha256 = digest(catalogBytes); entry.sizeBytes = catalogBytes.length;
  const manifestBytes = Buffer.from(`${canonicalize(manifest)}\n`);
  await assert.rejects(selectInstalledRepositoryKnowledge({ ...scope, loadProvider: async provider => provider === 'codex'
    ? { catalogBytes: f.catalogBytes, manifestBytes: f.manifestBytes } : { catalogBytes, manifestBytes } }), /generation conflict/);
});

test('installed provider selection never falls back to empty knowledge after a loader failure', async t => {
  const f = await fixture(t);
  await assert.rejects(selectInstalledRepositoryKnowledge({ ...scope, loadProvider: async provider => {
    if (provider === 'claude') throw new Error('Expired enrolled provider authorization');
    return { catalogBytes: f.catalogBytes, manifestBytes: f.manifestBytes };
  } }), /Expired enrolled/);
  assert.equal(await selectInstalledRepositoryKnowledge({ ...scope, loadProvider: async () => null }), null);
});

test('source collection validates retained scope and bounded bytes before use', async t => {
  const f = await fixture(t), catalog = structuredClone(f.catalog);
  catalog.organizationId = 'org_foreign';
  await assert.rejects(inventoryRepositoryPackage({ ...f.input,
    retainedKnowledge: { catalogBytes: Buffer.from(`${canonicalize(catalog)}\n`), manifestBytes: f.manifestBytes } }), /scope/);
  await assert.rejects(selectInstalledRepositoryKnowledge({ ...scope, loadProvider: async () => ({ catalogBytes: Buffer.alloc(262145), manifestBytes: f.manifestBytes }) }), /limit/);
  await assert.rejects(inventoryRepositoryPackage({ ...f.input, sourceAuthorization: undefined,
    retainedKnowledge: { catalogBytes: f.catalogBytes, manifestBytes: f.manifestBytes } }), /governed scope/);
});
