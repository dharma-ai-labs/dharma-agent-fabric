import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import {
  canonicalize, signCanonicalObject, type ProviderId,
} from '@dharma-ai-labs/agent-fabric-contracts';
import {
  calculateBundleHash, contentHash, getActiveSkillBundleAuthorization,
  installSkillBundle, type SkillBundle,
} from '@dharma-ai-labs/agent-fabric-skill-manager';
import type { OrganizationPolicy } from '@dharma-ai-labs/agent-fabric-policy';
import {
  planRepositoryPackageTransferV2, type RepositoryTransferFile,
} from './repositoryPackageTransfer.js';
import { receiveRepositoryPackageDelivery } from './repositoryPackageDelivery.js';
import { serializeSkillPreparationRecord } from './skillPreparationRecord.js';

const keys = generateKeyPairSync('ed25519');
const ROOT = '.agents/skills/dharma-agent-fabric/';
const CATALOG = ROOT + 'knowledge/CATALOG.json';
const MANIFEST = ROOT + 'MANIFEST.json';
const PROMPT = '.dharma/onboarding-prompt.md';
const CREATED = '2026-09-18T18:00:00.000Z';
const EXPIRES = '2026-09-18T18:01:00.000Z';
const localScope = {
  organizationId: 'org_delivery_fixture',
  repositoryBindingId: '73a95988-fd64-41ba-a0b9-6c8867d03788',
  repositoryAgentId: '57f61652-a5eb-46e4-930c-9478cd4a9c31',
  deviceId: 'a24b5a90-3b7a-4a81-9503-c9f49be790c3',
  workspaceId: 'b24b5a90-3b7a-4a81-9503-c9f49be790c3',
  provider: 'codex' as ProviderId,
};
const pin = (letter: string) => 'sha256:' + letter.repeat(64);
const hash = (value: string | Uint8Array) => 'sha256:' + createHash('sha256').update(value).digest('hex');
function file(path: string, text: string): RepositoryTransferFile {
  return { path, contentBase64: Buffer.from(text).toString('base64'),
    sha256: hash(text), sizeBytes: Buffer.byteLength(text) };
}

// This is the legitimate minimal producer-shaped fixture from the metadata
// tests: a canonical catalog, complete manifest, prompt, root and source skill.
// Source provenance is hashed metadata, not an independent current grant.
function metadataFiles(): RepositoryTransferFile[] {
  const { organizationId, repositoryAgentId } = localScope;
  const knowledgeBaseId = 'repository-kb:' + hash(canonicalize({
    schema: 'dharma.repository-knowledge-identity/v1', organizationId, repositoryAgentId,
  }));
  const projection = {
    schema: 'dharma.repository-concept-projection/v1', organizationId, repositoryAgentId,
    policyHash: pin('a'), snapshotHash: pin('b'), authority: 'unsigned_projection',
    publicationAuthorized: false, concepts: [], acceptedProposalHashes: [], unresolved: [],
  };
  const catalog = {
    schema: 'dharma.repository-knowledge/v2', managedBy: 'dharma-agent-fabric',
    organizationId, repositoryAgentId, knowledgeBaseId, generation: 1,
    authority: 'requires_verified_release', policyHash: pin('a'), sourceSnapshotHash: pin('b'),
    sourceLocalCatalogHash: pin('c'), projectionHash: hash(canonicalize(projection)),
    repoAtlas: {
      associationId: '244b5a90-3b7a-4a81-9503-c9f49be790c3', knowledgeBaseId,
      organizationId, repositoryAgentId, basis: 'repository_initialization',
      sourceWindowIds: [], analysisHash: null,
    },
    concepts: [], unresolved: [],
  };
  const copies = [
    { ...file(ROOT + 'SKILL.md', '# Repository Agent Fabric\n'), role: 'skill' },
    { ...file(ROOT + 'skills/source/.claude/skills/verifier/SKILL.md', '# Verifier\n'), role: 'skill' },
    { ...file(PROMPT, 'Use the organization repository package.\n'), role: 'onboarding_prompt' },
    { ...file(CATALOG, canonicalize(catalog) + '\n'), role: 'knowledge' },
  ];
  const entryPath = '.claude/skills/verifier/SKILL.md';
  const manifest = {
    schema: 'dharma.repository-release-manifest/v1', organizationId, repositoryAgentId,
    generation: 1, authority: 'requires_verified_release', sourceManifestHash: pin('e'),
    sourceSnapshotHash: pin('b'), policyHash: pin('a'), knowledgeBaseId,
    atlasAssociationId: catalog.repoAtlas.associationId,
    sourceSkills: [{
      path: '.claude/skills/verifier', providerRoot: '.claude/skills', entryPath,
      contentHash: hash(canonicalize([{ path: entryPath, sha256: copies[1]!.sha256 }])),
      availability: 'available', filePaths: [entryPath],
      observation: { state: 'not_observed', authority: 'caller_supplied_not_runtime_verified', references: [] },
    }],
    files: copies.map(({ contentBase64: _content, ...row }) => row)
      .sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0),
  };
  return [...copies.map(({ role: _role, ...row }) => row), file(MANIFEST, canonicalize(manifest) + '\n')];
}

// Preserve the installer's existing basename-prefixed path/NUL/bytes/NUL hash,
// not the canonical source inventory hash.
function treeHash(files: RepositoryTransferFile[]): string {
  const digest = createHash('sha256');
  for (const row of files.filter(row => row.path.startsWith(ROOT))
    .sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)) {
    digest.update('dharma-agent-fabric/' + row.path.slice(ROOT.length));
    digest.update('\0');
    digest.update(Buffer.from(row.contentBase64, 'base64'));
    digest.update('\0');
  }
  return 'sha256:' + digest.digest('hex');
}

function fixture(commit = 'a'.repeat(40)) {
  const files = metadataFiles();
  const scope = { ...localScope };
  const transferScope = {
    organizationId: scope.organizationId, repositoryBindingId: scope.repositoryBindingId,
    repositoryAgentId: scope.repositoryAgentId,
    releaseId: 'c24b5a90-3b7a-4a81-9503-c9f49be790c3', generation: 1, gitCommit: commit,
  };
  const plan = planRepositoryPackageTransferV2({ ...transferScope, files });
  const descriptor = {
    schema: 'dharma.repository-package-delivery/v1', delivery: 'authenticated_chunks',
    transferSchema: 'dharma.repository-package-transfer/v2', ...transferScope,
    policyHash: pin('a'), sourceSnapshotHash: pin('b'), sourceManifestHash: pin('e'),
    sourceLocalCatalogHash: pin('c'), catalogHash: files.find(row => row.path === CATALOG)!.sha256,
    manifestHash: files.find(row => row.path === MANIFEST)!.sha256, transferIndexHash: plan.indexHash,
    fileCount: files.length, totalBytes: plan.index.totalBytes, maximumFileBytes: 262_144,
    createdAt: CREATED, expiresAt: EXPIRES,
  };
  const base: Omit<SkillBundle, 'signature' | 'bundleHash'> = {
    schema: 'dharma.skill-bundle/v2', bundleId: 'd24b5a90-3b7a-4a81-9503-c9f49be790c3',
    organizationId: scope.organizationId, version: '1.0.0', operation: 'install',
    skills: [{
      skillId: 'dharma-agent-fabric', version: '1.0.0', repository: 'https://github.com/example/repository.git',
      commit, contentHash: treeHash(files), path: ROOT.slice(0, -1),
    }],
    riskClass: 'R0', targetSelectors: {
      organizationAgentIds: [scope.repositoryAgentId], deviceIds: [scope.deviceId],
      workspaceIds: [scope.workspaceId], providers: [scope.provider],
    },
    activationPolicy: 'next_session', rollbackBundleId: null, evaluationReceiptId: 'fixture:evaluated',
    createdAt: CREATED, expiresAt: '2026-09-18T18:02:00.000Z',
  };
  const unsignedBundle = { ...base, bundleHash: calculateBundleHash(base) };
  const bundle: SkillBundle = { ...unsignedBundle, signature: signCanonicalObject(unsignedBundle, keys.privateKey) };
  const unsignedEnvelope = {
    schema: 'dharma.repository-package-envelope/v1', bundleId: bundle.bundleId,
    bundleHash: bundle.bundleHash, descriptor,
  };
  const envelope = { ...unsignedEnvelope, signature: signCanonicalObject(unsignedEnvelope, keys.privateKey) };
  return { scope, files, plan, bundle, envelope };
}
type Fixture = ReturnType<typeof fixture>;
function signEnvelope(input: Fixture) {
  const { signature: _signature, ...unsigned } = input.envelope;
  input.envelope.signature = signCanonicalObject(unsigned, keys.privateKey);
}
function signBundle(input: Fixture) {
  const { signature: _signature, bundleHash: _bundleHash, ...base } = input.bundle;
  const unsigned = { ...base, bundleHash: calculateBundleHash(base) };
  input.bundle = { ...unsigned, signature: signCanonicalObject(unsigned, keys.privateKey) };
  input.envelope.bundleId = input.bundle.bundleId;
  input.envelope.bundleHash = input.bundle.bundleHash;
  signEnvelope(input);
}
function repackage(input: Fixture) {
  const descriptor = input.envelope.descriptor;
  input.plan = planRepositoryPackageTransferV2({
    organizationId: descriptor.organizationId, repositoryBindingId: descriptor.repositoryBindingId,
    repositoryAgentId: descriptor.repositoryAgentId, releaseId: descriptor.releaseId,
    generation: descriptor.generation, gitCommit: descriptor.gitCommit, files: input.files,
  });
  descriptor.transferIndexHash = input.plan.indexHash;
  descriptor.fileCount = input.files.length;
  descriptor.totalBytes = input.plan.index.totalBytes;
  descriptor.catalogHash = input.files.find(row => row.path === CATALOG)!.sha256;
  descriptor.manifestHash = input.files.find(row => row.path === MANIFEST)!.sha256;
  input.bundle.skills[0]!.contentHash = treeHash(input.files);
  signBundle(input);
}
function readDocument(input: Fixture, path: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(input.files.find(row => row.path === path)!.contentBase64, 'base64').toString('utf8'));
}
function replaceDocument(input: Fixture, path: string, document: unknown, text = canonicalize(document) + '\n') {
  input.files[input.files.findIndex(row => row.path === path)] = file(path, text);
  if (path === CATALOG) {
    const manifest = readDocument(input, MANIFEST);
    const row = (manifest.files as Array<{ path: string; sha256: string; sizeBytes: number }>)
      .find(row => row.path === CATALOG)!;
    const replacement = input.files.find(row => row.path === CATALOG)!;
    row.sha256 = replacement.sha256;
    row.sizeBytes = replacement.sizeBytes;
    replaceDocument(input, MANIFEST, manifest);
  }
}

function harness(input: Fixture) {
  const calls = { index: 0, chunks: [] as Array<[number, number]> };
  const clock = { milliseconds: Date.parse('2026-09-18T18:00:01.000Z') };
  const request = {
    envelope: input.envelope as unknown, bundle: input.bundle, serverPublicKey: keys.publicKey,
    scope: input.scope, now: () => new Date(clock.milliseconds),
    fetchIndex: async (): Promise<unknown> => { calls.index++; return structuredClone(input.plan.index); },
    fetchChunk: async (fileIndex: number, chunkIndex: number): Promise<unknown> => {
      calls.chunks.push([fileIndex, chunkIndex]);
      const chunk = input.plan.chunks.find(row => row.fileIndex === fileIndex && row.chunkIndex === chunkIndex);
      assert.ok(chunk, 'Fixture must supply a requested indexed chunk.');
      return structuredClone(chunk);
    },
  };
  return { request, calls, clock };
}
async function rejectBeforeFetch(change: (input: Fixture) => void) {
  const input = fixture();
  change(input);
  const { request, calls } = harness(input);
  await assert.rejects(receiveRepositoryPackageDelivery(request));
  assert.deepEqual(calls, { index: 0, chunks: [] });
}

test('signed package delivery returns the complete five-file metadata package and a live currentness guard', async () => {
  const input = fixture();
  const { request, calls } = harness(input);
  const result = await receiveRepositoryPackageDelivery(request);
  assert.deepEqual(result.files, input.files);
  assert.deepEqual(result.bundle, input.bundle);
  assert.equal(result.files.length, 5);
  assert.equal(calls.index, 1);
  assert.equal(calls.chunks.length, input.plan.chunks.length);
  assert.deepEqual([...calls.chunks].sort(), input.plan.chunks.map(row => [row.fileIndex, row.chunkIndex]).sort());
  assert.equal(typeof result.assertCurrent, 'function');
  assert.doesNotThrow(() => result.assertCurrent());
  assert.deepEqual(Object.keys(result).sort(), ['assertCurrent', 'bundle', 'envelope', 'files', 'index']);
});

test('signed package preparation retains verified provenance independently of mutable transport objects', async () => {
  const input = fixture();
  const { request } = harness(input);
  const transportIndex = structuredClone(input.plan.index);
  request.fetchIndex = async () => transportIndex;
  const expectedEnvelope = structuredClone(input.envelope);
  const expectedIndex = structuredClone(transportIndex);
  const result = await receiveRepositoryPackageDelivery(request) as unknown as {
    envelope: unknown; index: unknown; assertCurrent: () => void;
  };
  input.envelope.descriptor.gitCommit = 'f'.repeat(40);
  transportIndex.files[0]!.sha256 = pin('f');
  assert.deepEqual(result.envelope, expectedEnvelope);
  assert.deepEqual(result.index, expectedIndex);
  assert.doesNotThrow(result.assertCurrent);
});

test('pending package record checks outer scope and immutable index provenance', async () => {
  const input = fixture();
  const { request } = harness(input);
  const prepared = await receiveRepositoryPackageDelivery(request);
  const { repositoryBindingId, repositoryAgentId, organizationId, workspaceId, deviceId, provider } = input.scope;
  const record = { schema: 'dharma.skill-preparation/v1', repositoryBindingId, repositoryAgentId,
    organizationId, workspaceId, deviceId, provider, policyHash: pin('a'), rolloutId: 'fixture-rollout',
    bundle: prepared.bundle, repositoryPackage: { envelope: prepared.envelope, index: prepared.index },
    preparedAt: CREATED, activationAuthorized: false };
  assert.deepEqual(JSON.parse(await serializeSkillPreparationRecord(record)), record);
  await assert.rejects(serializeSkillPreparationRecord({ ...record,
    repositoryBindingId: 'f24b5a90-3b7a-4a81-9503-c9f49be790c3' }), /repository scope mismatch/);
  const tampered = structuredClone(record);
  tampered.repositoryPackage.index.files[0]!.sha256 = pin('f');
  await assert.rejects(serializeSkillPreparationRecord(tampered), /provenance mismatch/);
});

test('signed package delivery accepts an immutable 64-character commit without narrowing the descriptor', async () => {
  const input = fixture('b'.repeat(64));
  const { request } = harness(input);
  const result = await receiveRepositoryPackageDelivery(request);
  assert.deepEqual(result.files, input.files);
  result.assertCurrent();
});

const rejectedParents: Array<[string, (input: Fixture) => void]> = [
  ['bad signature', input => { input.bundle.signature = 'invalid'; }],
  ['unsigned hash mutation', input => { input.bundle.bundleHash = pin('f'); }],
  ['cross-schema bundle', input => { input.bundle.schema = 'dharma.skill-bundle/v3' as SkillBundle['schema']; signBundle(input); }],
  ['foreign organization', input => { input.bundle.organizationId = 'org_foreign'; signBundle(input); }],
  ['clear operation', input => { input.bundle.operation = 'clear'; input.bundle.skills = []; signBundle(input); }],
  ['zero skills', input => { input.bundle.skills = []; signBundle(input); }],
  ['multiple skills', input => { input.bundle.skills.push({ ...input.bundle.skills[0]! }); signBundle(input); }],
  ['wrong skill path', input => { input.bundle.skills[0]!.path = 'skills/other'; signBundle(input); }],
  ['inline files', input => { input.bundle.skills[0]!.files = [{ path: 'SKILL.md', contentBase64: 'YQ==', sha256: hash('a') }]; signBundle(input); }],
  ['empty inline files', input => { input.bundle.skills[0]!.files = []; signBundle(input); }],
  ['foreign pinned commit', input => { input.bundle.skills[0]!.commit = 'c'.repeat(40); signBundle(input); }],
  ['mutable pinned ref', input => { input.bundle.skills[0]!.commit = 'main'; signBundle(input); }],
  ['wildcard repository agent', input => { input.bundle.targetSelectors.organizationAgentIds = []; signBundle(input); }],
  ['foreign repository selector', input => { input.bundle.targetSelectors.organizationAgentIds = ['67f61652-a5eb-46e4-930c-9478cd4a9c31']; signBundle(input); }],
  ['foreign device selector', input => { input.bundle.targetSelectors.deviceIds = ['e24b5a90-3b7a-4a81-9503-c9f49be790c3']; signBundle(input); }],
  ['foreign workspace selector', input => { input.bundle.targetSelectors.workspaceIds = ['e24b5a90-3b7a-4a81-9503-c9f49be790c3']; signBundle(input); }],
  ['foreign provider selector', input => { input.bundle.targetSelectors.providers = ['claude']; signBundle(input); }],
  ['invalid creation', input => { input.bundle.createdAt = 'not-a-date'; signBundle(input); }],
  ['invalid creation calendar', input => { input.bundle.createdAt = '2026-02-30T18:00:00.000Z'; signBundle(input); }],
  ['future creation', input => { input.bundle.createdAt = '2026-09-18T18:00:02.000Z'; signBundle(input); }],
  ['expired parent', input => { input.bundle.expiresAt = '2026-09-18T18:00:01.000Z'; signBundle(input); }],
  ['invalid parent expiry', input => { input.bundle.expiresAt = 'not-a-date'; signBundle(input); }],
  ['descriptor outlives parent', input => { input.bundle.expiresAt = '2026-09-18T18:00:30.000Z'; signBundle(input); }],
];
for (const [name, change] of rejectedParents) test('package delivery makes no fetch for parent ' + name,
  async () => rejectBeforeFetch(change));

const rejectedEnvelopes: Array<[string, (input: Fixture) => void]> = [
  ['bad signature', input => { input.envelope.signature = 'invalid'; }],
  ['wrong envelope schema', input => { input.envelope.schema = 'dharma.repository-package-envelope/v2'; signEnvelope(input); }],
  ['foreign bundle id', input => { input.envelope.bundleId = 'e24b5a90-3b7a-4a81-9503-c9f49be790c3'; signEnvelope(input); }],
  ['foreign bundle hash', input => { input.envelope.bundleHash = pin('f'); signEnvelope(input); }],
  ['wrong descriptor schema', input => { input.envelope.descriptor.schema = 'dharma.repository-package-delivery/v2'; signEnvelope(input); }],
  ['inline delivery', input => { input.envelope.descriptor.delivery = 'inline'; signEnvelope(input); }],
  ['v1 transfer downgrade', input => { input.envelope.descriptor.transferSchema = 'dharma.repository-package-transfer/v1'; signEnvelope(input); }],
  ['foreign binding', input => { input.envelope.descriptor.repositoryBindingId = 'e24b5a90-3b7a-4a81-9503-c9f49be790c3'; signEnvelope(input); }],
  ['foreign repository', input => { input.envelope.descriptor.repositoryAgentId = '67f61652-a5eb-46e4-930c-9478cd4a9c31'; signEnvelope(input); }],
  ['foreign org', input => { input.envelope.descriptor.organizationId = 'org_foreign'; signEnvelope(input); }],
  ['future descriptor', input => { input.envelope.descriptor.createdAt = '2026-09-18T18:00:02.000Z'; signEnvelope(input); }],
  ['expired descriptor', input => { input.envelope.descriptor.expiresAt = '2026-09-18T18:00:01.000Z'; signEnvelope(input); }],
  ['equal lifetime', input => { input.envelope.descriptor.expiresAt = input.envelope.descriptor.createdAt; signEnvelope(input); }],
  ['reversed lifetime', input => { input.envelope.descriptor.expiresAt = '2026-09-18T17:59:59.999Z'; signEnvelope(input); }],
  ['invalid calendar day', input => { input.envelope.descriptor.createdAt = '2026-02-30T18:00:00.000Z'; signEnvelope(input); }],
  ['noncanonical timestamp', input => { input.envelope.descriptor.createdAt = '2026-09-18T18:00:00Z'; signEnvelope(input); }],
  ['offset timestamp', input => { input.envelope.descriptor.expiresAt = '2026-09-18T18:01:00.000+00:00'; signEnvelope(input); }],
];
for (const [name, change] of rejectedEnvelopes) test('package delivery makes no fetch for envelope ' + name,
  async () => rejectBeforeFetch(change));

test('package delivery enforces strict public envelope and parent shapes even if signed', async () => {
  for (const key of ['url', 'token', 'authority', 'keyVersion']) {
    const input = fixture();
    const extra = { ...input.envelope, [key]: 'extra' };
    const { signature: _signature, ...unsigned } = extra;
    extra.signature = signCanonicalObject(unsigned, keys.privateKey);
    const { request, calls } = harness(input);
    request.envelope = extra;
    await assert.rejects(receiveRepositoryPackageDelivery(request));
    assert.equal(calls.index, 0);
  }
  const input = fixture();
  const extraBundle = { ...input.bundle, repositoryPackage: input.envelope.descriptor };
  const { signature: _signature, bundleHash: _bundleHash, ...base } = extraBundle;
  const unsigned = { ...base, bundleHash: hash(canonicalize(base)) };
  input.envelope.bundleHash = unsigned.bundleHash;
  signEnvelope(input);
  const { request, calls } = harness(input);
  request.bundle = { ...unsigned, signature: signCanonicalObject(unsigned, keys.privateKey) };
  await assert.rejects(receiveRepositoryPackageDelivery(request));
  assert.deepEqual(calls, { index: 0, chunks: [] });
});

test('package delivery rejects envelope required-field omissions and extra descriptor fields before fetch', async () => {
  for (const key of ['schema', 'bundleId', 'bundleHash', 'descriptor', 'signature']) {
    const input = fixture();
    const envelope: Record<string, unknown> = { ...input.envelope };
    delete envelope[key];
    const { request, calls } = harness(input);
    request.envelope = envelope;
    await assert.rejects(receiveRepositoryPackageDelivery(request));
    assert.deepEqual(calls, { index: 0, chunks: [] });
  }
  const input = fixture();
  Object.assign(input.envelope.descriptor, { url: 'https://example.invalid/package' });
  signEnvelope(input);
  const { request, calls } = harness(input);
  await assert.rejects(receiveRepositoryPackageDelivery(request));
  assert.deepEqual(calls, { index: 0, chunks: [] });
});

for (const key of ['organizationId', 'repositoryBindingId', 'repositoryAgentId', 'deviceId', 'workspaceId', 'provider'] as const) {
  test('package delivery snapshots and validates the local scope field ' + key, async () => {
    const input = fixture();
    const { request, calls } = harness(input);
    const scope: Record<string, unknown> = { ...input.scope };
    scope[key] = key === 'provider' ? 'foreign' : String(scope[key]) + '\n';
    request.scope = scope as typeof request.scope;
    await assert.rejects(receiveRepositoryPackageDelivery(request));
    assert.deepEqual(calls, { index: 0, chunks: [] });
  });
}

for (const key of ['policyHash', 'sourceSnapshotHash', 'sourceManifestHash', 'sourceLocalCatalogHash',
  'catalogHash', 'manifestHash', 'transferIndexHash'] as const) {
  test('package delivery rejects newline-suffixed signed descriptor pin ' + key + ' before fetch', async () => {
    await rejectBeforeFetch(input => { input.envelope.descriptor[key] += '\n'; signEnvelope(input); });
  });
}

test('package delivery verifies both signatures using the same trusted server key', async () => {
  const other = generateKeyPairSync('ed25519');
  for (const which of ['parent', 'envelope', 'trusted-key']) {
    const input = fixture();
    if (which === 'parent') {
      const { signature: _signature, ...unsigned } = input.bundle;
      input.bundle.signature = signCanonicalObject(unsigned, other.privateKey);
    } else if (which === 'envelope') {
      const { signature: _signature, ...unsigned } = input.envelope;
      input.envelope.signature = signCanonicalObject(unsigned, other.privateKey);
    }
    const { request, calls } = harness(input);
    if (which === 'trusted-key') request.serverPublicKey = other.publicKey;
    await assert.rejects(receiveRepositoryPackageDelivery(request));
    assert.deepEqual(calls, { index: 0, chunks: [] });
  }
});

test('package delivery rejects an invalid injected clock before fetching', async () => {
  const { request, calls, clock } = harness(fixture());
  clock.milliseconds = NaN;
  await assert.rejects(receiveRepositoryPackageDelivery(request));
  assert.deepEqual(calls, { index: 0, chunks: [] });
});

test('package delivery permits a parent without expiry and wildcard non-repository selectors', async () => {
  const input = fixture();
  input.bundle.expiresAt = null;
  input.bundle.targetSelectors.deviceIds = [];
  input.bundle.targetSelectors.workspaceIds = [];
  input.bundle.targetSelectors.providers = [];
  signBundle(input);
  const { request } = harness(input);
  assert.deepEqual((await receiveRepositoryPackageDelivery(request)).files, input.files);
});

test('package delivery snapshots envelope, parent and local scope before the first await', async () => {
  const input = fixture();
  const originalFiles = structuredClone(input.files);
  const originalBundle = structuredClone(input.bundle);
  const { request } = harness(input);
  const pending = receiveRepositoryPackageDelivery(request);
  input.envelope.descriptor.organizationId = 'org_mutated';
  input.envelope.descriptor.expiresAt = CREATED;
  input.envelope.signature = 'invalid';
  input.bundle.targetSelectors.organizationAgentIds.length = 0;
  input.bundle.createdAt = 'invalid';
  input.bundle.expiresAt = CREATED;
  input.bundle.signature = 'invalid';
  input.scope.repositoryBindingId = 'invalid';
  const result = await pending;
  assert.deepEqual(result.files, originalFiles);
  assert.deepEqual(result.bundle, originalBundle);
  assert.doesNotThrow(() => result.assertCurrent());
});

test('package delivery currentness guard stays bound to snapshots but observes the live clock', async () => {
  const input = fixture();
  const { request, calls, clock } = harness(input);
  const result = await receiveRepositoryPackageDelivery(request);
  input.envelope.descriptor.expiresAt = '2099-01-01T00:00:00.000Z';
  input.bundle.expiresAt = '2099-01-01T00:00:00.000Z';
  clock.milliseconds = Date.parse(EXPIRES) - 1;
  assert.doesNotThrow(() => result.assertCurrent());
  clock.milliseconds++;
  assert.throws(() => result.assertCurrent());
  clock.milliseconds = Date.parse(CREATED) - 1;
  assert.throws(() => result.assertCurrent());
  clock.milliseconds = NaN;
  assert.throws(() => result.assertCurrent());
  assert.equal(calls.index, 1);
});

test('package delivery checks expiry after index await before requesting any chunks', async () => {
  const input = fixture();
  const { request, calls, clock } = harness(input);
  request.fetchIndex = async () => { calls.index++; clock.milliseconds = Date.parse(EXPIRES); return input.plan.index; };
  await assert.rejects(receiveRepositoryPackageDelivery(request));
  assert.deepEqual(calls, { index: 1, chunks: [] });
});

test('package delivery checks expiry before each subsequent chunk read', async () => {
  const input = fixture();
  const { request, calls, clock } = harness(input);
  const original = request.fetchChunk;
  request.fetchChunk = async (fileIndex, chunkIndex) => {
    const chunk = await original(fileIndex, chunkIndex);
    clock.milliseconds = Date.parse(EXPIRES);
    return chunk;
  };
  await assert.rejects(receiveRepositoryPackageDelivery(request));
  assert.equal(calls.chunks.length, 1);
});

test('package delivery checks invalid time after network awaits', async () => {
  for (const stage of ['index', 'chunk']) {
    const input = fixture();
    const { request, clock } = harness(input);
    const originalIndex = request.fetchIndex;
    const originalChunk = request.fetchChunk;
    if (stage === 'index') request.fetchIndex = async () => {
      const value = await originalIndex(); clock.milliseconds = NaN; return value;
    };
    else request.fetchChunk = async (fileIndex, chunkIndex) => {
      const value = await originalChunk(fileIndex, chunkIndex); clock.milliseconds = NaN; return value;
    };
    await assert.rejects(receiveRepositoryPackageDelivery(request));
  }
});

test('package delivery checks expiry after the final chunk await rather than returning stale files', async () => {
  const input = fixture();
  const { request, calls, clock } = harness(input);
  const original = request.fetchChunk;
  request.fetchChunk = async (fileIndex, chunkIndex) => {
    const chunk = await original(fileIndex, chunkIndex);
    if (calls.chunks.length === input.plan.chunks.length) clock.milliseconds = Date.parse(EXPIRES);
    return chunk;
  };
  await assert.rejects(receiveRepositoryPackageDelivery(request));
  assert.equal(calls.chunks.length, input.plan.chunks.length);
});

test('package delivery propagates current authorization read failures without returning partial files', async () => {
  for (const stage of ['index', 'chunk']) {
    const input = fixture();
    const { request, calls } = harness(input);
    const revoked = new Error('Endpoint authorization revoked.');
    if (stage === 'index') request.fetchIndex = async () => { calls.index++; throw revoked; };
    else request.fetchChunk = async (fileIndex, chunkIndex) => {
      calls.chunks.push([fileIndex, chunkIndex]); throw revoked;
    };
    await assert.rejects(receiveRepositoryPackageDelivery(request), error => error === revoked);
    assert.equal(calls.index, 1);
    assert.equal(calls.chunks.length, stage === 'index' ? 0 : 1);
  }
});

for (const key of ['organizationId', 'repositoryBindingId', 'repositoryAgentId', 'releaseId', 'generation', 'gitCommit'] as const) {
  test('package delivery enforces signed transfer scope against a repinned foreign index: ' + key, async () => {
    const input = fixture();
    const foreign = { ...input.plan.index, [key]: key === 'generation' ? 2
      : key === 'gitCommit' ? 'f'.repeat(40) : key === 'organizationId' ? 'org_foreign'
        : 'e24b5a90-3b7a-4a81-9503-c9f49be790c3' };
    input.envelope.descriptor.transferIndexHash = hash(canonicalize(foreign));
    signEnvelope(input);
    const { request, calls } = harness(input);
    request.fetchIndex = async () => { calls.index++; return foreign; };
    await assert.rejects(receiveRepositoryPackageDelivery(request));
    assert.equal(calls.chunks.length, 0);
  });
}

test('package delivery does not trust an index hash supplied by the network', async () => {
  const input = fixture();
  const { request, calls } = harness(input);
  const changed = structuredClone(input.plan.index);
  changed.files[0]!.path = ROOT + 'renamed.md';
  request.fetchIndex = async () => { calls.index++; return changed; };
  await assert.rejects(receiveRepositoryPackageDelivery(request));
  assert.equal(calls.chunks.length, 0);
});

test('package delivery rejects transfer schema downgrade and signed inventory count mismatches', async () => {
  for (const key of ['fileCount', 'totalBytes', 'schema']) {
    const input = fixture();
    const { request, calls } = harness(input);
    if (key === 'schema') {
      const index = { ...input.plan.index, schema: 'dharma.repository-package-transfer/v1' };
      input.envelope.descriptor.transferIndexHash = hash(canonicalize(index));
      signEnvelope(input);
      request.fetchIndex = async () => { calls.index++; return index; };
    } else {
      const countKey = key as keyof Pick<typeof input.envelope.descriptor, 'fileCount' | 'totalBytes'>;
      input.envelope.descriptor[countKey]++;
      signEnvelope(input);
    }
    await assert.rejects(receiveRepositoryPackageDelivery(request));
    assert.equal(calls.chunks.length, 0);
  }
});

test('package delivery rejects chunk corruption, foreign pins and cross-schema chunks', async () => {
  for (const change of [
    { contentBase64: Buffer.from('corrupt').toString('base64') },
    { indexHash: pin('f') }, { schema: 'dharma.repository-package-chunk/v1' },
  ]) {
    const input = fixture();
    const { request } = harness(input);
    const original = request.fetchChunk;
    request.fetchChunk = async (fileIndex, chunkIndex) => {
      const chunk = await original(fileIndex, chunkIndex);
      return { ...(chunk as object), ...change };
    };
    await assert.rejects(receiveRepositoryPackageDelivery(request));
  }
});

for (const key of ['policyHash', 'sourceSnapshotHash', 'sourceManifestHash', 'sourceLocalCatalogHash',
  'catalogHash', 'manifestHash'] as const) {
  test('package delivery enforces whole metadata lineage from the trusted descriptor: ' + key, async () => {
    const input = fixture();
    input.envelope.descriptor[key] = pin('f');
    signEnvelope(input);
    const { request } = harness(input);
    await assert.rejects(receiveRepositoryPackageDelivery(request));
  });
}

test('package delivery validates complete metadata even when transfer hashes and signatures are consistent', async () => {
  const input = fixture();
  const manifest = readDocument(input, MANIFEST);
  manifest.sourceSkills = [];
  replaceDocument(input, MANIFEST, manifest);
  repackage(input);
  const { request } = harness(input);
  await assert.rejects(receiveRepositoryPackageDelivery(request));
});

test('package delivery rejects noncanonical duplicate-key metadata despite trusted byte pins', async () => {
  const input = fixture();
  const catalog = readDocument(input, CATALOG);
  const duplicate = canonicalize(catalog).replace('{', '{"generation":1,') + '\n';
  replaceDocument(input, CATALOG, catalog, duplicate);
  repackage(input);
  const { request } = harness(input);
  await assert.rejects(receiveRepositoryPackageDelivery(request));
});

test('package delivery rejects missing canonical package files rather than returning a partial package', async () => {
  const input = fixture();
  input.files = input.files.filter(row => row.path !== PROMPT);
  const manifest = readDocument(input, MANIFEST);
  manifest.files = (manifest.files as Array<{ path: string }>).filter(row => row.path !== PROMPT);
  replaceDocument(input, MANIFEST, manifest);
  repackage(input);
  const { request } = harness(input);
  await assert.rejects(receiveRepositoryPackageDelivery(request));
});

test('package delivery does not replace the existing installer treehash check with metadata integrity', async () => {
  const input = fixture();
  input.bundle.skills[0]!.contentHash = pin('f');
  signBundle(input);
  const { request } = harness(input);
  // This byte receiver leaves the independently signed skill treehash to the
  // unchanged installer. Metadata success is not installation success.
  const result = await receiveRepositoryPackageDelivery(request);
  assert.deepEqual(result.files, input.files);
  assert.notEqual(treeHash(result.files), input.bundle.skills[0]!.contentHash);
});

test('package delivery rejects scope accessors and proxies without invoking hooks', async () => {
  let calls = 0;
  const input = fixture();
  const accessor = { ...input.scope };
  Object.defineProperty(accessor, 'repositoryBindingId', {
    enumerable: true, get() { calls++; return input.scope.repositoryBindingId; },
  });
  const proxy = new Proxy(input.scope, {
    ownKeys() { calls++; return Reflect.ownKeys(input.scope); },
    get() { calls++; throw new Error('Proxy hook executed.'); },
  });
  for (const scope of [accessor, proxy]) {
    const { request, calls: network } = harness(input);
    request.scope = scope;
    await assert.rejects(receiveRepositoryPackageDelivery(request));
    assert.deepEqual(network, { index: 0, chunks: [] });
  }
  assert.equal(calls, 0);
});

test('package delivery rejects envelope and parent accessors or proxies before asynchronous validation', async () => {
  let calls = 0;
  const input = fixture();
  const envelope = { ...input.envelope };
  Object.defineProperty(envelope, 'descriptor', { enumerable: true,
    get() { calls++; return input.envelope.descriptor; } });
  const bundle = { ...input.bundle };
  Object.defineProperty(bundle, 'skills', { enumerable: true, get() { calls++; return input.bundle.skills; } });
  const proxy = new Proxy(input.envelope, {
    ownKeys() { calls++; return Reflect.ownKeys(input.envelope); },
  });
  for (const which of ['envelope', 'bundle', 'proxy']) {
    const { request, calls: network } = harness(input);
    if (which === 'bundle') request.bundle = bundle;
    else request.envelope = which === 'proxy' ? proxy : envelope;
    await assert.rejects(receiveRepositoryPackageDelivery(request));
    assert.deepEqual(network, { index: 0, chunks: [] });
  }
  assert.equal(calls, 0);
});

test('package delivery bounds local scope and descriptor JSON snapshots before network reads', async () => {
  const input = fixture();
  for (const which of ['scope', 'descriptor']) {
    const { request, calls } = harness(input);
    const padding = Array.from({ length: 64 }, () => 'x'.repeat(349_529));
    if (which === 'scope') request.scope = { ...input.scope, padding } as typeof request.scope;
    else request.envelope = { ...input.envelope, descriptor: { ...input.envelope.descriptor, padding } };
    await assert.rejects(receiveRepositoryPackageDelivery(request));
    assert.deepEqual(calls, { index: 0, chunks: [] });
  }
});

function currentFilesystemFixture() {
  const input = fixture();
  const milliseconds = Date.now();
  const createdAt = new Date(milliseconds - 1000).toISOString();
  const expiresAt = new Date(milliseconds + 120_000).toISOString();
  input.bundle.createdAt = createdAt;
  input.bundle.expiresAt = expiresAt;
  input.envelope.descriptor.createdAt = createdAt;
  input.envelope.descriptor.expiresAt = expiresAt;
  signBundle(input);
  return input;
}

const filesystemPolicy: OrganizationPolicy = {
  schema: 'dharma.organization-policy/v1', organizationId: localScope.organizationId, revision: '1',
  evidence: {
    defaultMode: 'structured', registeredWorkspaceOnly: true, excludePaths: [],
    maximumCapsuleBytes: 1, maximumDailyUploadBytes: 1, maximumExpansionBytes: 1,
  },
  tasks: {
    defaultNetwork: 'deny', defaultGit: 'read_only', allowedCommands: {},
    writePaths: [], requireLocalConfirmationFor: [],
  },
  skills: { automaticInstall: true, automaticPromotionMaxRisk: 'R0', canaryPercent: 100 },
  retention: {}, budgets: {},
};

async function materializeReceived(
  delivery: Awaited<ReturnType<typeof receiveRepositoryPackageDelivery>>, source: string,
) {
  for (const row of delivery.files) {
    const target = resolve(source, row.path);
    const route = relative(source, target);
    assert.ok(route && !isAbsolute(route) && route.split(sep)[0] !== '..');
    delivery.assertCurrent();
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    delivery.assertCurrent();
    await writeFile(target, Buffer.from(row.contentBase64, 'base64'), { flag: 'wx', mode: 0o600 });
  }
}

test('filesystem integration: delivered five-file package installs through the public v2 installer and active authorization', async () => {
  const input = currentFilesystemFixture();
  const { request } = harness(input);
  request.now = () => new Date();
  const delivery = await receiveRepositoryPackageDelivery(request);
  assert.equal(delivery.files.length, 5);
  const owned = await mkdtemp(resolve(tmpdir(), 'fabric-package-delivery-integration-'));
  try {
    const source = resolve(owned, 'source');
    const native = resolve(owned, 'native');
    const device = generateKeyPairSync('ed25519');
    await materializeReceived(delivery, source);
    assert.equal(await contentHash(resolve(source, ROOT)), delivery.bundle.skills[0]!.contentHash);
    delivery.assertCurrent();
    const receipt = await installSkillBundle({
      bundle: delivery.bundle, sourceDirectory: source, nativeSkillDirectory: native,
      policy: filesystemPolicy, serverPublicKey: keys.publicKey, devicePrivateKey: device.privateKey,
      deviceId: input.scope.deviceId, organizationAgentId: input.scope.repositoryAgentId,
      workspaceId: input.scope.workspaceId, provider: input.scope.provider,
    });
    assert.equal(receipt.status, 'active');
    assert.ok(receipt.checks.some(check => check.name === 'content:dharma-agent-fabric' && check.status === 'pass'));
    for (const row of delivery.files.filter(row => row.path.startsWith(ROOT))) {
      const copied = resolve(native, 'dharma-agent-fabric', row.path.slice(ROOT.length));
      assert.equal(hash(await readFile(copied)), row.sha256, row.path);
    }
    assert.equal(hash(await readFile(resolve(source, PROMPT))),
      delivery.files.find(row => row.path === PROMPT)!.sha256);
    assert.equal(await contentHash(resolve(native, '.dharma-managed', 'workspaces',
      input.scope.workspaceId, 'releases', delivery.bundle.bundleId, 'dharma-agent-fabric')),
      delivery.bundle.skills[0]!.contentHash);
    const ownership = JSON.parse(await readFile(resolve(native, 'dharma-agent-fabric', '.dharma-agent-fabric.json'), 'utf8'));
    assert.equal(ownership.bundleId, delivery.bundle.bundleId);
    assert.equal(ownership.workspaceId, input.scope.workspaceId);
    const authorization = await getActiveSkillBundleAuthorization({
      nativeSkillDirectory: native, workspaceId: input.scope.workspaceId, provider: input.scope.provider,
      organizationId: input.scope.organizationId, organizationAgentId: input.scope.repositoryAgentId,
      deviceId: input.scope.deviceId, serverPublicKey: keys.publicKey, devicePublicKey: device.publicKey,
      expectedReceiptHash: receipt.receiptHash,
    });
    assert.equal(authorization?.bundleId, delivery.bundle.bundleId);
    assert.equal(authorization?.bundleHash, delivery.bundle.bundleHash);
  } finally {
    await rm(owned, { recursive: true, force: true });
  }
});

test('filesystem integration: tampering after delivery fails the installer treehash before replacing the prior accepted package', async () => {
  const input = currentFilesystemFixture();
  const { request } = harness(input);
  request.now = () => new Date();
  const prior = await receiveRepositoryPackageDelivery(request);
  const owned = await mkdtemp(resolve(tmpdir(), 'fabric-package-delivery-tamper-'));
  try {
    const source = resolve(owned, 'prior-source');
    const native = resolve(owned, 'native');
    const device = generateKeyPairSync('ed25519');
    const endpoint = {
      deviceId: input.scope.deviceId, organizationAgentId: input.scope.repositoryAgentId,
      workspaceId: input.scope.workspaceId, provider: input.scope.provider,
    };
    await materializeReceived(prior, source);
    prior.assertCurrent();
    const receipt = await installSkillBundle({
      bundle: prior.bundle, sourceDirectory: source, nativeSkillDirectory: native,
      policy: filesystemPolicy, serverPublicKey: keys.publicKey, devicePrivateKey: device.privateKey, ...endpoint,
    });
    assert.equal(receipt.status, 'active');
    const candidateInput = currentFilesystemFixture();
    candidateInput.bundle.bundleId = 'e24b5a90-3b7a-4a81-9503-c9f49be790c3';
    candidateInput.bundle.rollbackBundleId = prior.bundle.bundleId;
    signBundle(candidateInput);
    const candidateHarness = harness(candidateInput);
    candidateHarness.request.now = () => new Date();
    const candidate = await receiveRepositoryPackageDelivery(candidateHarness.request);
    const candidateSource = resolve(owned, 'candidate-source');
    await materializeReceived(candidate, candidateSource);
    candidate.assertCurrent();
    await writeFile(resolve(candidateSource, ROOT, 'SKILL.md'), '# Tampered after verified delivery\n', { mode: 0o600 });
    candidate.assertCurrent();
    await assert.rejects(installSkillBundle({
      bundle: candidate.bundle, sourceDirectory: candidateSource, nativeSkillDirectory: native,
      policy: filesystemPolicy, serverPublicKey: keys.publicKey, devicePrivateKey: device.privateKey, ...endpoint,
    }), /Skill content hash mismatch: dharma-agent-fabric/);
    for (const row of prior.files.filter(row => row.path.startsWith(ROOT))) {
      assert.equal(hash(await readFile(resolve(native, 'dharma-agent-fabric', row.path.slice(ROOT.length)))),
        row.sha256, row.path);
    }
    const authorization = await getActiveSkillBundleAuthorization({
      nativeSkillDirectory: native, organizationId: input.scope.organizationId, ...endpoint,
      serverPublicKey: keys.publicKey, devicePublicKey: device.publicKey,
      expectedReceiptHash: receipt.receiptHash,
    });
    assert.equal(authorization?.bundleId, prior.bundle.bundleId);
    assert.equal(authorization?.bundleHash, prior.bundle.bundleHash);
  } finally {
    await rm(owned, { recursive: true, force: true });
  }
});
