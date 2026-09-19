import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { canonicalize, validateContract } from '@dharma-ai-labs/agent-fabric-contracts';
import { validateRepositoryReleaseMetadata, type RepositoryReleaseMetadataFile } from './repositoryReleaseMetadata.js';

const ROOT = '.agents/skills/dharma-agent-fabric/';
const CATALOG = `${ROOT}knowledge/CATALOG.json`;
const MANIFEST = `${ROOT}MANIFEST.json`;
const PROMPT = '.dharma/onboarding-prompt.md';
const org = 'org_release_fixture';
const agent = '57f61652-a5eb-46e4-930c-9478cd4a9c31';
const hash = (value: string) => `sha256:${createHash('sha256').update(value).digest('hex')}`;
const pin = (letter: string) => `sha256:${letter.repeat(64)}`;
const kb = `repository-kb:${hash(canonicalize({ schema: 'dharma.repository-knowledge-identity/v1', organizationId: org, repositoryAgentId: agent }))}`;
function file(path: string, content: string): RepositoryReleaseMetadataFile {
  return { path, contentBase64: Buffer.from(content).toString('base64'), sha256: hash(content), sizeBytes: Buffer.byteLength(content) };
}
function fixture(withConcept = false) {
  const conceptName = 'Verifier tolerance';
  const conceptId = `concept_${hash(canonicalize({ schema: 'dharma.repository-concept-identity/v1', organizationId: org,
    repositoryAgentId: agent, name: conceptName.toLowerCase() })).slice(7)}`;
  const definition = 'Compare numerical outputs against a declared tolerance.';
  const quote = `Verifier tolerance. Tolerance policy. ${definition}`;
  const source = { sourceId: 'a24b5a90-3b7a-4a81-9503-c9f49be790c3', sourceHash: hash(quote), firstLine: 1, lastLine: 1, quote };
  const acceptedProposal = { canonicalName: conceptName, aliases: ['Tolerance policy'], definition, source };
  const concepts = withConcept ? [{ conceptId, canonicalName: conceptName, aliases: ['Tolerance policy'], definition, sources: [source] }] : [];
  const conflictId = `concept_${hash(canonicalize({ schema: 'dharma.repository-concept-identity/v1', organizationId: org,
    repositoryAgentId: agent, name: 'release policy' })).slice(7)}`;
  const conflictLines = ['Release policy. Require a review.', 'Release policy. Require two reviews.'];
  const conflicts = conflictLines.map((line, index) => ({ canonicalName: 'Release policy', aliases: [],
    definition: index === 0 ? 'Require a review.' : 'Require two reviews.',
    source: { sourceId: 'b24b5a90-3b7a-4a81-9503-c9f49be790c3', sourceHash: hash(conflictLines.join('\n')),
      firstLine: index + 1, lastLine: index + 1, quote: line } }));
  const unresolved = withConcept ? conflicts.map(proposal => ({ proposalHash: hash(canonicalize(proposal)),
    reason: 'conflicting_definition', conceptId: conflictId })).sort((a, b) => a.proposalHash.localeCompare(b.proposalHash)) : [];
  const projection = { schema: 'dharma.repository-concept-projection/v1', organizationId: org, repositoryAgentId: agent,
    policyHash: pin('a'), snapshotHash: pin('b'), authority: 'unsigned_projection', publicationAuthorized: false,
    concepts, acceptedProposalHashes: withConcept ? [hash(canonicalize(acceptedProposal))] : [], unresolved };
  const catalog = {
    schema: 'dharma.repository-knowledge/v2', managedBy: 'dharma-agent-fabric', organizationId: org,
    repositoryAgentId: agent, knowledgeBaseId: kb, generation: 1, authority: 'requires_verified_release',
    policyHash: pin('a'), sourceSnapshotHash: pin('b'), sourceLocalCatalogHash: pin('c'), projectionHash: hash(canonicalize(projection)),
    repoAtlas: { associationId: '244b5a90-3b7a-4a81-9503-c9f49be790c3', knowledgeBaseId: kb,
      organizationId: org, repositoryAgentId: agent, basis: 'repository_initialization', sourceWindowIds: [], analysisHash: null,
      selectionHash: pin('d'), priorTrajectoryCount: 0, failureFamilies: [] },
    concepts, unresolved,
  };
  const copies = [
    { ...file(`${ROOT}SKILL.md`, '# Repository Agent Fabric\n'), role: 'skill' },
    { ...file(`${ROOT}skills/source/.claude/skills/verifier/SKILL.md`, '# Verifier\n'), role: 'skill' },
    { ...file(PROMPT, 'Use the organization repository package.\n'), role: 'onboarding_prompt' },
    { ...file(CATALOG, `${canonicalize(catalog)}\n`), role: 'knowledge' },
  ];
  const sourceSkills = [{ path: '.claude/skills/verifier', providerRoot: '.claude/skills',
    entryPath: '.claude/skills/verifier/SKILL.md', contentHash: hash(canonicalize([{ path: '.claude/skills/verifier/SKILL.md',
      sha256: copies[1]!.sha256 }])), availability: 'available',
    filePaths: ['.claude/skills/verifier/SKILL.md'], observation: { state: 'not_observed',
      authority: 'caller_supplied_not_runtime_verified', references: [] } }];
  const manifest = { schema: 'dharma.repository-release-manifest/v1', organizationId: org, repositoryAgentId: agent,
    generation: 1, authority: 'requires_verified_release', sourceManifestHash: pin('e'), sourceSnapshotHash: pin('b'),
    policyHash: pin('a'), knowledgeBaseId: kb, atlasAssociationId: catalog.repoAtlas.associationId,
    sourceSkills, files: copies.map(({ contentBase64: _content, ...entry }) => entry).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0) };
  const files = [...copies.map(({ role: _role, ...entry }) => entry), file(MANIFEST, `${canonicalize(manifest)}\n`)];
  return { scope: { organizationId: org, repositoryAgentId: agent,
    repositoryBindingId: '73a95988-fd64-41ba-a0b9-6c8867d03788', generation: 1,
    policyHash: pin('a'), sourceSnapshotHash: pin('b'), sourceManifestHash: pin('e'), sourceLocalCatalogHash: pin('c'),
    catalogHash: files.find(entry => entry.path === CATALOG)!.sha256,
    manifestHash: files.find(entry => entry.path === MANIFEST)!.sha256 }, files };
}

test('canonical release metadata validates the complete catalog and manifest without promoting unsigned authority', async () => {
  const result = await validateRepositoryReleaseMetadata(fixture());
  assert.equal(result.stage, 'repository_release_metadata_observed');
  assert.equal(result.sharedRepositoryReady, false);
  assert.equal(result.signatureVerified, false);
  assert.equal(result.activationVerified, false);
});

test('canonical release metadata preserves sourced concepts and unresolved definitions rather than resetting local knowledge', async () => {
  const input = fixture(true);
  const expected = JSON.parse(Buffer.from(input.files.find(entry => entry.path === CATALOG)!.contentBase64, 'base64').toString('utf8'));
  const result = await validateRepositoryReleaseMetadata(input);
  assert.equal(result.stage, 'repository_release_metadata_observed');
  assert.deepEqual(result.catalog?.concepts, expected.concepts);
  assert.deepEqual(result.catalog?.unresolved, expected.unresolved);
  assert.equal(result.sharedRepositoryReady, false);
});

test('canonical release metadata retains legacy initialization releases without manufacturing first-learning evidence', async () => {
  const input = fixture();
  editCatalog(input, value => {
    delete value.repoAtlas.selectionHash;
    delete value.repoAtlas.priorTrajectoryCount;
    delete value.repoAtlas.failureFamilies;
  });
  const result = await validateRepositoryReleaseMetadata(input);
  assert.equal(result.stage, 'repository_release_metadata_observed');
  assert.equal(Object.hasOwn(result.catalog.repoAtlas as Record<string, unknown>, 'selectionHash'), false);
  assert.equal(result.projectionVerified, false);
});

type Fixture = ReturnType<typeof fixture>;
function readDocument(input: Fixture, path: string): Record<string, any> {
  return JSON.parse(Buffer.from(input.files.find(entry => entry.path === path)!.contentBase64, 'base64').toString('utf8'));
}
function replaceDocument(input: Fixture, path: string, value: unknown, text = `${canonicalize(value)}\n`) {
  const replacement = file(path, text);
  input.files[input.files.findIndex(entry => entry.path === path)] = replacement;
  if (path === CATALOG) {
    input.scope.catalogHash = replacement.sha256;
    const manifest = readDocument(input, MANIFEST);
    const entry = manifest.files.find((entry: any) => entry.path === CATALOG);
    entry.sha256 = replacement.sha256;
    entry.sizeBytes = replacement.sizeBytes;
    replaceDocument(input, MANIFEST, manifest);
  } else if (path === MANIFEST) input.scope.manifestHash = replacement.sha256;
}
function editCatalog(input: Fixture, change: (value: Record<string, any>) => void) {
  const value = readDocument(input, CATALOG);
  change(value);
  replaceDocument(input, CATALOG, value);
}
function editManifest(input: Fixture, change: (value: Record<string, any>) => void) {
  const value = readDocument(input, MANIFEST);
  change(value);
  replaceDocument(input, MANIFEST, value);
}
function inventory(input: Fixture) {
  editManifest(input, value => {
    value.files = input.files.filter(entry => entry.path !== MANIFEST).map(({ contentBase64: _content, ...entry }) => ({
      ...entry, role: entry.path === CATALOG ? 'knowledge' : entry.path === PROMPT ? 'onboarding_prompt' : 'skill',
    })).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  });
}

const rejected: Array<[string, (input: Fixture) => void]> = [
  ['foreign organization', input => { input.scope.organizationId = 'org_foreign'; }],
  ['foreign repository agent', input => { input.scope.repositoryAgentId = '67f61652-a5eb-46e4-930c-9478cd4a9c31'; }],
  ['invalid binding identity', input => { input.scope.repositoryBindingId = 'not-a-binding'; }],
  ['generation mismatch', input => { input.scope.generation += 1; }],
  ['policy mismatch', input => { input.scope.policyHash = pin('f'); }],
  ['source snapshot mismatch', input => { input.scope.sourceSnapshotHash = pin('f'); }],
  ['source manifest mismatch', input => { input.scope.sourceManifestHash = pin('f'); }],
  ['local catalog lineage mismatch', input => { input.scope.sourceLocalCatalogHash = pin('f'); }],
  ['unpinned canonical catalog', input => { input.scope.catalogHash = pin('f'); }],
  ['unpinned release manifest', input => { input.scope.manifestHash = pin('f'); }],
  ['missing package file', input => { input.files.splice(1, 1); }],
  ['extra uninventoried file', input => { input.files.push(file(`${ROOT}skills/source/extra.md`, '# Extra\n')); }],
  ['duplicate file', input => { input.files.push(input.files[0]!); }],
  ['case-folded file collision', input => { input.files.push(file(`${ROOT}skill.md`, '# Collision\n')); }],
  ['file-directory collision', input => { input.files.push(file(`${ROOT}skills`, '# Collision\n')); inventory(input); }],
  ['path traversal', input => { input.files[1]!.path = `${ROOT}skills/source/../escape.md`; inventory(input); }],
  ['protected secret path', input => { input.files[1]!.path = `${ROOT}skills/source/.env.production`; inventory(input); }],
  ['noncanonical base64', input => { input.files[1]!.contentBase64 += '\n'; }],
  ['incorrect size', input => { input.files[1]!.sizeBytes += 1; }],
  ['corrupted file bytes', input => { input.files[1]!.contentBase64 = Buffer.from('# Corrupt\n').toString('base64'); }],
  ['non-UTF8 content', input => {
    const bytes = Buffer.from([0xff]);
    input.files[1] = { path: input.files[1]!.path, contentBase64: bytes.toString('base64'), sha256: hash(bytes.toString('latin1')), sizeBytes: 1 };
    input.files[1]!.sha256 = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
    inventory(input);
  }],
  ['private key content', input => {
    input.files[1] = file(input.files[1]!.path, '-----BEGIN OPENSSH PRIVATE KEY-----\nsynthetic\n'); inventory(input);
  }],
  ['manifest self-inventory', input => { editManifest(input, value => value.files.push({ path: MANIFEST, sha256: pin('a'), sizeBytes: 1, role: 'skill' })); }],
  ['manifest file hash mismatch', input => { editManifest(input, value => { value.files[0].sha256 = pin('f'); }); }],
  ['incorrect catalog role', input => { editManifest(input, value => { value.files.find((entry: any) => entry.path === CATALOG).role = 'skill'; }); }],
  ['source skill hash mismatch', input => { editManifest(input, value => { value.sourceSkills[0].contentHash = pin('f'); }); }],
  ['missing skill metadata', input => { editManifest(input, value => { value.sourceSkills = []; }); }],
  ['orphan copied dependency', input => {
    const extra = file(`${ROOT}skills/source/scripts/orphan.py`, 'print("synthetic")\n');
    input.files.push(extra); inventory(input);
    editManifest(input, value => { value.files.find((entry: any) => entry.path === extra.path).role = 'dependency'; });
  }],
  ['missing skill companion', input => { editManifest(input, value => { value.sourceSkills[0].filePaths.push('.claude/skills/verifier/missing.md'); }); }],
  ['invented native-use authority', input => { editManifest(input, value => { value.sourceSkills[0].observation.authority = 'runtime_verified'; }); }],
  ['reported use without evidence', input => { editManifest(input, value => { value.sourceSkills[0].observation.state = 'reported_observed'; }); }],
  ['knowledge identity mismatch', input => { editCatalog(input, value => { value.knowledgeBaseId = `repository-kb:${pin('f')}`; }); }],
  ['foreign Atlas association', input => { editCatalog(input, value => { value.repoAtlas.organizationId = 'org_foreign'; }); }],
  ['Atlas manifest mismatch', input => { editManifest(input, value => { value.atlasAssociationId = '344b5a90-3b7a-4a81-9503-c9f49be790c3'; }); }],
  ['fabricated initialized Atlas analysis', input => { editCatalog(input, value => { value.repoAtlas.analysisHash = pin('f'); }); }],
  ['partial Atlas learning lineage', input => { editCatalog(input, value => { delete value.repoAtlas.failureFamilies; }); }],
  ['initialized Atlas trajectory count', input => { editCatalog(input, value => { value.repoAtlas.priorTrajectoryCount = 1; }); }],
  ['initialized Atlas failure family', input => { editCatalog(input, value => { value.repoAtlas.failureFamilies = [{ familyKey: 'invented',
    title: 'Invented', causeClass: 'other', severity: 'medium', trajectoryIds: [] }]; }); }],
  ['semantic Atlas without windows', input => { editCatalog(input, value => { value.repoAtlas.basis = 'semantic_analysis'; value.repoAtlas.analysisHash = pin('f'); }); }],
  ['semantic Atlas without selection lineage', input => { editCatalog(input, value => { value.repoAtlas.basis = 'semantic_analysis';
    value.repoAtlas.sourceWindowIds = ['444b5a90-3b7a-4a81-9503-c9f49be790c3']; value.repoAtlas.analysisHash = pin('f');
    value.repoAtlas.selectionHash = null; value.repoAtlas.priorTrajectoryCount = 1; }); }],
  ['semantic Atlas without prior trajectories', input => { editCatalog(input, value => { value.repoAtlas.basis = 'semantic_analysis';
    value.repoAtlas.sourceWindowIds = ['444b5a90-3b7a-4a81-9503-c9f49be790c3']; value.repoAtlas.analysisHash = pin('f');
    value.repoAtlas.priorTrajectoryCount = 0; }); }],
  ['duplicate Atlas family key', input => { editCatalog(input, value => { value.repoAtlas.basis = 'semantic_analysis';
    value.repoAtlas.sourceWindowIds = ['444b5a90-3b7a-4a81-9503-c9f49be790c3']; value.repoAtlas.analysisHash = pin('f');
    value.repoAtlas.priorTrajectoryCount = 1; value.repoAtlas.failureFamilies = [
      { familyKey: 'Tool Discipline', title: 'One', causeClass: 'tool', severity: 'high', trajectoryIds: [] },
      { familyKey: ' tool discipline ', title: 'Two', causeClass: 'tool', severity: 'medium', trajectoryIds: [] }]; }); }],
  ['duplicate Atlas trajectory', input => { editCatalog(input, value => { value.repoAtlas.basis = 'semantic_analysis';
    value.repoAtlas.sourceWindowIds = ['444b5a90-3b7a-4a81-9503-c9f49be790c3']; value.repoAtlas.analysisHash = pin('f');
    value.repoAtlas.priorTrajectoryCount = 1; value.repoAtlas.failureFamilies = [{ familyKey: 'tool', title: 'Tool',
      causeClass: 'tool', severity: 'high', trajectoryIds: ['544b5a90-3b7a-4a81-9503-c9f49be790c3',
        '544b5a90-3b7a-4a81-9503-c9f49be790c3'] }]; }); }],
  ['invented accepted catalog authority', input => { editCatalog(input, value => { value.authority = 'accepted'; }); }],
  ['unknown catalog field', input => { editCatalog(input, value => { value.accepted = true; }); }],
  ['local-v1 catalog coercion', input => { editCatalog(input, value => { value.schema = 'dharma.repository-knowledge/v1'; }); }],
  ['concept identity mismatch', input => { editCatalog(input, value => { value.concepts[0].conceptId = `concept_${'f'.repeat(64)}`; }); }],
  ['normalized alias collision', input => { editCatalog(input, value => { value.concepts[0].aliases = ['VERIFIER TOLERANCE']; }); }],
  ['reversed source line span', input => { editCatalog(input, value => { value.concepts[0].sources[0].firstLine = 2; }); }],
  ['oversized source line span', input => { editCatalog(input, value => { value.concepts[0].sources[0].lastLine = 129; }); }],
  ['unpaired surrogate in concept', input => { editCatalog(input, value => { value.concepts[0].definition = '\ud800'; }); }],
  ['unknown unresolved reason', input => { editCatalog(input, value => { value.unresolved[0].reason = 'approved'; }); }],
  ['newline-suffixed unresolved hash', input => { editCatalog(input, value => { value.unresolved[0].proposalHash += '\n'; }); }],
  ['duplicate JSON key', input => {
    const value = readDocument(input, CATALOG);
    replaceDocument(input, CATALOG, value, `${canonicalize(value).replace('{', '{"generation":1,')}\n`);
  }],
  ['noncanonical JSON whitespace', input => {
    const value = readDocument(input, CATALOG); replaceDocument(input, CATALOG, value, JSON.stringify(value, null, 2));
  }],
];
for (const [name, change] of rejected) test(`canonical release metadata rejects ${name}`, async () => {
  const input = fixture(true);
  change(input);
  await assert.rejects(validateRepositoryReleaseMetadata(input));
});

test('canonical release metadata preserves external skill dependencies and caller-reported observations without native-use proof', async () => {
  const input = fixture(true);
  const dependency = file(`${ROOT}skills/source/scripts/check.py`, 'print("synthetic")\n');
  input.files.push(dependency);
  inventory(input);
  editManifest(input, value => {
    value.files.find((entry: any) => entry.path === dependency.path).role = 'dependency';
    const skill = value.sourceSkills[0];
    skill.filePaths.push('scripts/check.py');
    skill.filePaths.sort();
    skill.contentHash = hash(canonicalize(skill.filePaths.map((path: string) => ({ path,
      sha256: input.files.find(entry => entry.path === `${ROOT}skills/source/${path}`)!.sha256 }))));
    skill.observation = { state: 'reported_observed', authority: 'caller_supplied_not_runtime_verified',
      references: [{ skillPath: skill.path, skillHash: skill.contentHash, sourcePath: 'output/report.md', sourceHash: pin('f') }] };
  });
  const result = await validateRepositoryReleaseMetadata(input);
  assert.equal(result.stage, 'repository_release_metadata_observed');
  assert.equal(result.nativeUseVerified, false);
  assert.equal(result.currentAuthorizationVerified, false);
  assert.deepEqual(result.manifest.sourceSkills, readDocument(input, MANIFEST).sourceSkills);
});

test('canonical release metadata preserves semantic Atlas provenance without claiming analysis truth', async () => {
  const input = fixture(true);
  editCatalog(input, value => {
    value.repoAtlas.basis = 'semantic_analysis';
    value.repoAtlas.sourceWindowIds = ['444b5a90-3b7a-4a81-9503-c9f49be790c3'];
    value.repoAtlas.analysisHash = pin('f');
    value.repoAtlas.selectionHash = pin('e');
    value.repoAtlas.priorTrajectoryCount = 1;
    value.repoAtlas.failureFamilies = [{ familyKey: 'tool-discipline', title: 'Tool discipline', causeClass: 'tool_discipline',
      severity: 'high', trajectoryIds: ['544b5a90-3b7a-4a81-9503-c9f49be790c3'] }];
  });
  const result = await validateRepositoryReleaseMetadata(input);
  assert.equal(result.stage, 'repository_release_metadata_observed');
  assert.equal(result.projectionVerified, false);
  assert.equal(result.signatureVerified, false);
  assert.equal(result.repositoryBindingVerified, false);
  assert.deepEqual((result.catalog.repoAtlas as Record<string, unknown>).failureFamilies, [{ familyKey: 'tool-discipline', title: 'Tool discipline',
    causeClass: 'tool_discipline', severity: 'high', trajectoryIds: ['544b5a90-3b7a-4a81-9503-c9f49be790c3'] }]);
});

test('canonical release metadata retains more than 32 companion files without truncating the canonical inventory', async () => {
  const input = fixture(true);
  for (let index = 0; index < 32; index += 1) input.files.push(file(
    `${ROOT}skills/source/.claude/skills/verifier/references/example-${String(index).padStart(2, '0')}.md`,
    `# Synthetic companion ${index}\n`));
  inventory(input);
  editManifest(input, value => {
    const skill = value.sourceSkills[0];
    skill.filePaths = input.files.filter(entry => entry.path.startsWith(`${ROOT}skills/source/`))
      .map(entry => entry.path.slice(`${ROOT}skills/source/`.length)).sort();
    skill.contentHash = hash(canonicalize(skill.filePaths.map((path: string) => ({ path,
      sha256: input.files.find(entry => entry.path === `${ROOT}skills/source/${path}`)!.sha256 }))));
  });
  const result = await validateRepositoryReleaseMetadata(input);
  assert.equal((result.manifest.files as unknown[]).length, 36);
  assert.equal((result.manifest.sourceSkills as any[])[0].filePaths.length, 33);
  assert.equal(result.sharedRepositoryReady, false);
  assert.equal(result.activationVerified, false);
});

test('canonical release metadata snapshots caller data before asynchronous validation', async () => {
  const input = fixture(true);
  const pending = validateRepositoryReleaseMetadata(input);
  input.scope.organizationId = 'org_changed';
  input.files.length = 0;
  const result = await pending;
  assert.equal(result.catalog.organizationId, org);
  assert.equal(result.manifest.organizationId, org);
});

test('canonical release metadata accepts a provider-root SKILL.md and preserves its complete inventory', async () => {
  const input = fixture(true);
  input.files[1] = file(`${ROOT}skills/source/.claude/skills/SKILL.md`, '# Provider root skill\n');
  inventory(input);
  editManifest(input, value => {
    const skill = value.sourceSkills[0];
    skill.path = '.claude/skills';
    skill.entryPath = '.claude/skills/SKILL.md';
    skill.filePaths = [skill.entryPath];
    skill.contentHash = hash(canonicalize([{ path: skill.entryPath, sha256: input.files[1]!.sha256 }]));
  });
  const result = await validateRepositoryReleaseMetadata(input);
  assert.equal(result.stage, 'repository_release_metadata_observed');
  assert.deepEqual(result.manifest.sourceSkills, readDocument(input, MANIFEST).sourceSkills);
  assert.equal(result.nativeUseVerified, false);
});

test('canonical release metadata rejects repeated oversized input during bounded traversal', async () => {
  const input = Object.assign(fixture(), { padding: Array.from({ length: 60 }, () => 'x'.repeat(300000)) });
  await assert.rejects(validateRepositoryReleaseMetadata(input), /complete scoped contract/);
  const wide = Object.assign(fixture(), Object.fromEntries(Array.from({ length: 70 }, (_, index) => [`extra${index}`, 0])));
  await assert.rejects(validateRepositoryReleaseMetadata(wide), /complete scoped contract/);
});

test('canonical release metadata rejects hostile caller objects without invoking hooks', async () => {
  for (const value of [new Proxy(fixture(), { get() { throw new Error('hook invoked'); } }),
    Object.defineProperty(fixture(), 'files', { get() { throw new Error('hook invoked'); } })]) {
    await assert.rejects(validateRepositoryReleaseMetadata(value), /complete scoped contract/);
  }
  const cyclic = fixture() as Fixture & { cycle?: unknown };
  cyclic.cycle = cyclic;
  await assert.rejects(validateRepositoryReleaseMetadata(cyclic), /complete scoped contract/);
});

test('canonical release public schemas accept emitted shapes and reject additional authority fields', async () => {
  const input = fixture(true), directory = fileURLToPath(new URL('./schemas/', import.meta.url));
  for (const [path, id] of [[CATALOG, 'https://schemas.dharma-ai.io/repository-knowledge/v2'],
    [MANIFEST, 'https://schemas.dharma-ai.io/repository-release-manifest/v1']]) {
    const value = readDocument(input, path!);
    assert.equal((await validateContract(directory, id!, value)).ok, true);
    value.signatureVerified = true;
    assert.equal((await validateContract(directory, id!, value)).ok, false);
  }
});
