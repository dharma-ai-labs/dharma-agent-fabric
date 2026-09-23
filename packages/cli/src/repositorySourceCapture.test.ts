import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import test, { type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { canonicalize, validateContract } from '@dharma-ai-labs/agent-fabric-contracts';
import { inventoryRepositoryPackage, serializeRepositoryPackageSnapshot, writeRepositoryPackageSnapshot } from './repositoryPackage.js';
import { parseRepositorySourcePolicyResponse, repositorySourcePathSafe, validateRepositorySourceAuthorization } from './repositorySourceAuthorization.js';
import { initializeRepositoryKnowledge } from './repositoryKnowledge.js';

const NOW = new Date('2026-09-18T09:00:00.000Z');
const GENERATION = '1a731db0-d1bb-469c-8ffd-e1f10bece914';
const BINDING = '73a95988-fd64-41ba-a0b9-6c8867d03788';

async function fixture(t: TestContext) {
  const workspace = await mkdtemp(resolve(tmpdir(), 'repository-source-capture-'));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const put = async (path: string, text: string) => {
    await mkdir(dirname(resolve(workspace, path)), { recursive: true });
    await writeFile(resolve(workspace, path), text);
  };
  const operation = {
    action: 'authorize', confirmed: true, requestId: '5ff2ee1b-6cb3-459e-a977-ea99c757bf30',
    repositoryBindingId: BINDING, expectedRevision: 0,
    allowedContentClasses: ['approved_outputs', 'repository_content', 'repository_skills'],
    approvedRepositoryPaths: ['README.md', 'docs'], approvedOutputFolders: ['output/approved'],
    automaticValidatedPublication: true, retentionDays: 30, maximumFileBytes: 262144,
    maximumSnapshotBytes: 4194304, maximumDailyUploadBytes: 8388608,
    expiresAt: '2026-10-01T00:00:00.000Z' as string | null,
  };
  const sourceAuthorization = {
    schema: 'dharma.repository-source-authorization/v1', organizationId: 'org_source_fixture',
    workspaceId: '056b63dc-ebed-48ed-85d8-02c72f623ea8', repositoryBindingId: BINDING,
    repositoryAgentId: '57f61652-a5eb-46e4-930c-9478cd4a9c31', revision: 1,
    generationId: GENERATION, receiptId: `repo_consent_${GENERATION}`,
    policyRevision: `repository-source-${GENERATION}`, confirmedAt: '2026-09-18T08:00:00+00:00',
    policyHash: `sha256:${createHash('sha256').update(canonicalize(operation)).digest('hex')}`,
    policy: operation,
  };
  const input = { workspace, organizationId: sourceAuthorization.organizationId,
    workspaceId: sourceAuthorization.workspaceId, repositoryAgentId: sourceAuthorization.repositoryAgentId,
    repositoryBindingId: BINDING,
    sourceAuthorization, now: NOW };
  await put('.agents/skills/dharma-agent-fabric/.dharma-agent-fabric.json',
    JSON.stringify({ managedBy: 'dharma-agent-fabric', workspaceId: input.workspaceId }));
  await initializeRepositoryKnowledge(input);
  return { input, put };
}

test('governed v2 capture includes authorized documents and uncommitted report folders, not siblings', async t => {
  const f = await fixture(t);
  await f.put('README.md', '# Work repository\nCanonical glossary.');
  await f.put('docs/nested/terms.md', 'Widget ledger means the authoritative record.');
  await f.put('output/approved/report.md', 'Observation: the lookup omitted a required evidence reference.');
  await f.put('output/unapproved/report.md', 'Must remain local.');
  await f.put('private/unapproved.md', 'Must remain local too.');
  const snapshot = await inventoryRepositoryPackage(f.input);
  assert.equal(String(snapshot.manifest.schema), 'dharma.repository-package/v2');
  assert.deepEqual(snapshot.manifest.files.filter(file => file.role !== 'knowledge').map(file => [file.path, file.role]), [
    ['README.md', 'repository_content'], ['docs/nested/terms.md', 'repository_content'],
    ['output/approved/report.md', 'approved_output'],
  ]);
});

test('root-scoped capture excludes project-native release metadata before traversal', async t => {
  const f = await fixture(t);
  assert.equal(repositorySourcePathSafe('.agents/skills/.dharma-managed'), false);
  assert.equal(repositorySourcePathSafe('.claude/skills/.dharma-activation-test'), false);
  f.input.sourceAuthorization.policy.approvedRepositoryPaths = ['.'];
  f.input.sourceAuthorization.policyHash = `sha256:${createHash('sha256')
    .update(canonicalize(f.input.sourceAuthorization.policy)).digest('hex')}`;
  await f.put('README.md', '# Approved root document');
  for (let index = 0; index < 50; index += 1) {
    await f.put(`.agents/skills/.dharma-managed/workspaces/local/releases/release-${index}/SKILL.md`, '# Internal signed copy');
  }
  const snapshot = await inventoryRepositoryPackage({ ...f.input, limits: { maximumEntries: 40 } });
  assert.ok(snapshot.manifest.files.some(file => file.path === 'README.md'));
  assert.ok(snapshot.manifest.files.every(file => !file.path.includes('.dharma-managed')));
});

test('root-scoped capture prunes generated worktrees and unapproved outputs before entry limits', async t => {
  const f = await fixture(t);
  assert.equal(repositorySourcePathSafe('.worktrees/peer/README.md'), false);
  f.input.sourceAuthorization.policy.approvedRepositoryPaths = ['.'];
  resign(f.input);
  await f.put('README.md', '# Repository knowledge');
  await f.put('.codex/skills/review/SKILL.md', '# Review');
  await f.put('output/approved/report.md', 'Uncommitted approved finding.');
  for (let index = 0; index < 50; index += 1) {
    await f.put(`output/unapproved/report-${index}.md`, 'Not authorized.');
    await f.put(`.codex-pr-worktrees/run-${index}/README.md`, 'Separate checkout.');
    await f.put(`.worktrees/run-${index}/README.md`, 'Another Git worktree.');
  }
  const snapshot = await inventoryRepositoryPackage({ ...f.input, limits: { maximumEntries: 40 } });
  assert.deepEqual(snapshot.manifest.files.filter(file => file.role !== 'knowledge').map(file => file.path), [
    '.codex/skills/review/SKILL.md', 'README.md', 'output/approved/report.md',
  ]);
  assert.equal(serializeRepositoryPackageSnapshot(snapshot).includes('Not authorized.'), false);
  assert.equal(serializeRepositoryPackageSnapshot(snapshot).includes('Separate checkout.'), false);
  assert.equal(serializeRepositoryPackageSnapshot(snapshot).includes('Another Git worktree.'), false);
  await f.put('output/unapproved/report-0.md', 'Still not authorized.');
  await f.put('.codex-pr-worktrees/run-0/README.md', 'A changed separate checkout.');
  await f.put('.worktrees/run-0/README.md', 'A changed Git worktree.');
  const unchanged = await inventoryRepositoryPackage({ ...f.input, limits: { maximumEntries: 40 } });
  assert.equal(unchanged.manifest.snapshotHash, snapshot.manifest.snapshotHash);
});

test('root-scoped capture prunes generated indexes and context caches before source limits', async t => {
  const f = await fixture(t);
  assert.equal(repositorySourcePathSafe('.gitnexus/parse-cache/result.json'), false);
  assert.equal(repositorySourcePathSafe('.context/cache/result.json'), false);
  f.input.sourceAuthorization.policy.approvedRepositoryPaths = ['.'];
  resign(f.input);
  await f.put('README.md', '# Repository knowledge');
  for (let index = 0; index < 50; index += 1) {
    await f.put(`.gitnexus/parse-cache/result-${index}.json`, 'x'.repeat(300_000));
    await f.put(`.context/cache/result-${index}.json`, 'x'.repeat(300_000));
  }
  const snapshot = await inventoryRepositoryPackage({ ...f.input, limits: { maximumEntries: 40 } });
  assert.deepEqual(snapshot.manifest.files.filter(file => file.role !== 'knowledge').map(file => file.path), ['README.md']);
  await f.put('.gitnexus/parse-cache/result-0.json', 'changed');
  await f.put('.context/cache/result-0.json', 'changed');
  const unchanged = await inventoryRepositoryPackage({ ...f.input, limits: { maximumEntries: 40 } });
  assert.equal(unchanged.manifest.snapshotHash, snapshot.manifest.snapshotHash);
});

test('approved output root ignores generated non-document trees before the document budget', async t => {
  const f = await fixture(t);
  f.input.sourceAuthorization.policy.approvedRepositoryPaths = ['.'];
  f.input.sourceAuthorization.policy.approvedOutputFolders = ['output'];
  resign(f.input);
  await f.put('README.md', '# Repository knowledge');
  await f.put('output/reports/lexicon.md', 'Canonical definition with a source.');
  for (let index = 0; index < 50; index += 1) {
    await f.put(`output/runs/run-${index}/screenshot.png`, 'generated image');
  }
  const snapshot = await inventoryRepositoryPackage({ ...f.input, limits: { maximumEntries: 40 } });
  assert.deepEqual(snapshot.manifest.files.filter(file => file.role !== 'knowledge').map(file => file.path), [
    'README.md', 'output/reports/lexicon.md',
  ]);
  await f.put('output/runs/run-0/screenshot.png', 'updated generated image');
  const unchanged = await inventoryRepositoryPackage({ ...f.input, limits: { maximumEntries: 40 } });
  assert.equal(unchanged.manifest.snapshotHash, snapshot.manifest.snapshotHash);
  for (let index = 0; index < 50; index += 1) {
    await f.put(`output/reports/report-${index}.md`, `Eligible report ${index}.`);
  }
  await assert.rejects(inventoryRepositoryPackage({ ...f.input, limits: { maximumEntries: 40 } }), /document limit/);
});

test('approved output traversal keeps a separate hard scan bound', async t => {
  const f = await fixture(t);
  f.input.sourceAuthorization.policy.approvedOutputFolders = ['output'];
  resign(f.input);
  for (let index = 0; index < 50; index += 1) {
    await f.put(`output/generated-${index}.png`, 'generated image');
  }
  await assert.rejects(inventoryRepositoryPackage({ ...f.input,
    limits: { maximumScannedSourceEntries: 40 } }), /scan limit/);
});

test('governed capture preserves native skills and companions alongside repository documents', async t => {
  const f = await fixture(t);
  await f.put('.codex/skills/review/SKILL.md', '# Review\n[Guide](references/procedure.md)');
  await f.put('.codex/skills/review/references/procedure.md', 'Check cited evidence.');
  await f.put('README.md', '# Repository knowledge');
  const snapshot = await inventoryRepositoryPackage(f.input);
  assert.equal(snapshot.manifest.files.filter(file => file.role !== 'knowledge').length, 3);
  assert.equal(snapshot.manifest.skills[0]?.availability, 'available');
  assert.equal(snapshot.manifest.skills[0]?.observation.state, 'not_observed');
});

test('an uncommitted approved report edit changes the captured source hash', async t => {
  const f = await fixture(t);
  await f.put('output/approved/report.md', 'The canonical concept is widget ledger.');
  const before = await inventoryRepositoryPackage(f.input);
  assert.ok(before.manifest.files.some(file => file.path === 'output/approved/report.md'));
  await f.put('output/approved/report.md', 'The canonical concept is widget ledger, including revisions.');
  assert.notEqual((await inventoryRepositoryPackage(f.input)).manifest.snapshotHash, before.manifest.snapshotHash);
});

test('governed capture rejects an expired authorization without downgrading to v1', async t => {
  const f = await fixture(t);
  f.input.sourceAuthorization.policy.expiresAt = '2026-09-17T00:00:00.000Z';
  f.input.sourceAuthorization.policyHash = `sha256:${createHash('sha256').update(canonicalize(f.input.sourceAuthorization.policy)).digest('hex')}`;
  await assert.rejects(inventoryRepositoryPackage(f.input), /source.*(?:authorization|policy|expired)/i);
});

test('governed capture rejects a foreign organization rather than using its source policy', async t => {
  const f = await fixture(t);
  f.input.sourceAuthorization.organizationId = 'org_foreign_fixture';
  await assert.rejects(inventoryRepositoryPackage(f.input), /source.*(?:authorization|policy|scope)/i);
});

test('governed capture rejects a mismatched consent operation hash', async t => {
  const f = await fixture(t);
  f.input.sourceAuthorization.policyHash = `sha256:${'0'.repeat(64)}`;
  await assert.rejects(inventoryRepositoryPackage(f.input), /source.*(?:authorization|policy|hash)/i);
});

function resign(input: Awaited<ReturnType<typeof fixture>>['input']) {
  input.sourceAuthorization.policyHash = `sha256:${createHash('sha256').update(canonicalize(input.sourceAuthorization.policy)).digest('hex')}`;
}

test('no-history onboarding still has a mandatory empty knowledge catalog, not an invented Atlas', async t => {
  const f = await fixture(t);
  const snapshot = await inventoryRepositoryPackage(f.input);
  assert.ok(snapshot.manifest.knowledge?.knowledgeBaseId);
  assert.equal(snapshot.manifest.knowledge?.atlasAssociation, 'local_scope_only');
  assert.ok(snapshot.manifest.files.some(file => file.role === 'knowledge'));
  assert.equal(snapshot.manifest.skills.length, 0);
});

test('governed schema and historical CAS support v2 while live expired capture fails closed', async t => {
  const f = await fixture(t);
  await f.put('README.md', '# Shared concepts');
  const snapshot = await inventoryRepositoryPackage(f.input);
  const validated = await validateContract(fileURLToPath(new URL('./schemas/', import.meta.url)),
    'https://schemas.dharma-ai.io/repository-package/v2', snapshot.manifest);
  assert.equal(validated.ok, true, validated.ok ? '' : JSON.stringify(validated.errors));
  const serialized = serializeRepositoryPackageSnapshot(snapshot);
  const persisted = await writeRepositoryPackageSnapshot({ workspace: f.input.workspace, snapshot });
  await writeRepositoryPackageSnapshot({ workspace: f.input.workspace, snapshot });
  assert.equal(await readFile(resolve(f.input.workspace, persisted.snapshotPath), 'utf8'), serialized);
  assert.notEqual(serializeRepositoryPackageSnapshot(snapshot).length, 0);
  await assert.rejects(inventoryRepositoryPackage({ ...f.input, now: new Date('2026-10-02T00:00:00Z') }), /expired/);
});

test('managed copies do not cause an autonomous source fingerprint update loop', async t => {
  const f = await fixture(t);
  await f.put('skills/review/SKILL.md', '# Review');
  const before = await inventoryRepositoryPackage(f.input);
  await writeRepositoryPackageSnapshot({ workspace: f.input.workspace, snapshot: before });
  await f.put('.agents/skills/dharma-agent-fabric/references/derived.md', '# Generated instructions');
  const after = await inventoryRepositoryPackage(f.input);
  assert.equal(after.manifest.sourceFingerprint, before.manifest.sourceFingerprint);
  assert.equal(after.manifest.snapshotHash, before.manifest.snapshotHash);
});

test('documents and approved reports cannot expand capture through relative links', async t => {
  const f = await fixture(t);
  await f.put('docs/terms.md', '[Hidden](../private/source.md)');
  await f.put('output/approved/report.md', '[Hidden](../../unapproved/source.md)');
  await f.put('private/source.md', 'Unauthorized source');
  await f.put('output/unapproved/source.md', 'Unauthorized source');
  const snapshot = await inventoryRepositoryPackage(f.input);
  assert.equal(snapshot.manifest.files.filter(file => file.role !== 'knowledge').length, 2);
  assert.ok(!snapshot.blobs.some(blob => Buffer.from(blob.contentBase64, 'base64').toString().includes('Unauthorized source')));
});

test('native skill dependencies outside the consent scope remain unavailable and local', async t => {
  const f = await fixture(t);
  await f.put('skills/review/SKILL.md', '[Hidden](../../private/source.md)');
  await f.put('private/source.md', 'Unauthorized source');
  const snapshot = await inventoryRepositoryPackage(f.input);
  assert.equal(snapshot.manifest.skills[0]?.availability, 'partial');
  assert.ok(snapshot.manifest.exclusions.some(entry => entry.path === 'private/source.md' && entry.reason === 'unauthorized_dependency'));
  assert.ok(!snapshot.manifest.files.some(file => file.path === 'private/source.md'));
});

test('manual approved output flags cannot override the organization source grant', async t => {
  const f = await fixture(t);
  await f.put('output/unapproved/report.md', 'Local only');
  await assert.rejects(inventoryRepositoryPackage({ ...f.input, approvedOutputs: ['output/unapproved/report.md'] }), /authorization scope/);
});

test('secrets, excluded files, unsupported media and symlinked reports never enter shared blobs', async t => {
  const f = await fixture(t);
  await f.put('docs/safe.md', 'Canonical glossary');
  await f.put('docs/.env.local', 'PRIVATE_VALUE=must-not-share');
  await f.put('docs/access.md', 'access_token=must-not-share');
  await f.put('docs/image.png', 'Unsupported image');
  await symlink(resolve(f.input.workspace, 'docs/safe.md'), resolve(f.input.workspace, 'docs/linked.md'));
  const snapshot = await inventoryRepositoryPackage(f.input);
  assert.deepEqual(snapshot.manifest.files.filter(file => file.role !== 'knowledge').map(file => file.path), ['docs/safe.md']);
  assert.ok(snapshot.manifest.exclusions.some(entry => entry.reason === 'symlink'));
  assert.ok(snapshot.manifest.exclusions.some(entry => entry.reason === 'unsupported_content_type'));
  assert.ok(!serializeRepositoryPackageSnapshot(snapshot).includes('must-not-share'));
});

test('policy file and total byte caps fail the whole capture instead of truncating documents', async t => {
  const f = await fixture(t);
  await f.put('docs/large.md', 'x'.repeat(512));
  f.input.sourceAuthorization.policy.maximumFileBytes = 128;
  resign(f.input);
  await assert.rejects(inventoryRepositoryPackage(f.input), /file byte limit/);
  f.input.sourceAuthorization.policy.maximumFileBytes = 512;
  f.input.sourceAuthorization.policy.maximumSnapshotBytes = 512;
  resign(f.input);
  await assert.rejects(inventoryRepositoryPackage(f.input), /limit/);
});

test('overlapping document/output scopes deduplicate each file and keep output classification', async t => {
  const f = await fixture(t);
  f.input.sourceAuthorization.policy.approvedRepositoryPaths.push('output');
  resign(f.input);
  await f.put('output/approved/report.md', 'One immutable source');
  const snapshot = await inventoryRepositoryPackage(f.input);
  const reports = snapshot.manifest.files.filter(file => file.path === 'output/approved/report.md');
  assert.equal(reports.length, 1);
  assert.equal(reports[0]?.role, 'approved_output');
});

for (const field of ['workspaceId', 'repositoryAgentId', 'repositoryBindingId'] as const) {
  test(`source consent rejects foreign ${field}`, async t => {
    const f = await fixture(t);
    f.input.sourceAuthorization[field] = '70a5f314-6933-41d3-8946-c30423fa129f';
    await assert.rejects(inventoryRepositoryPackage(f.input), /scope mismatch/);
  });
}

test('null, prototype, accessor and sparse-array consent inputs fail without reading accessors', async t => {
  const f = await fixture(t);
  await assert.rejects(inventoryRepositoryPackage({ ...f.input, sourceAuthorization: null }), /authorization/);
  const prototype = Object.create(f.input.sourceAuthorization);
  assert.throws(() => validateRepositorySourceAuthorization(prototype, f.input, NOW), /prototype/);
  let invoked = false;
  const accessor = { ...f.input.sourceAuthorization };
  Object.defineProperty(accessor, 'policy', { enumerable: true, get() { invoked = true; throw new Error('never invoke'); } });
  assert.throws(() => validateRepositorySourceAuthorization(accessor, f.input, NOW), /accessors/);
  assert.equal(invoked, false);
  const sparse = structuredClone(f.input.sourceAuthorization);
  delete sparse.policy.approvedRepositoryPaths[0];
  assert.throws(() => validateRepositorySourceAuthorization(sparse, f.input, NOW), /array/);
});

test('signed-policy response matches actual SQL receipt IDs and offset confirmation timestamps', async t => {
  const f = await fixture(t);
  const a = f.input.sourceAuthorization;
  const current = { ...a, active: true, reason: 'authorized' };
  const response = { ok: true, organizationId: a.organizationId,
    policy: { organizationId: a.organizationId, repositoryBindingId: a.repositoryBindingId,
      repositoryAgentId: a.repositoryAgentId, current } };
  assert.deepEqual(parseRepositorySourcePolicyResponse(response, f.input, NOW), a);
  current.active = false;
  assert.throws(() => parseRepositorySourcePolicyResponse(response, f.input, NOW), /inactive/);
});

test('absence of governed authorization preserves the exact legacy v1 CAS object', async t => {
  const f = await fixture(t);
  await f.put('skills/review/SKILL.md', '# Review');
  const snapshot = await inventoryRepositoryPackage({ ...f.input, sourceAuthorization: undefined });
  assert.equal(snapshot.manifest.schema, 'dharma.repository-package/v1');
  assert.equal(snapshot.manifest.sourceAuthorization, undefined);
  assert.equal(snapshot.manifest.sourceFingerprint, undefined);
  assert.equal(serializeRepositoryPackageSnapshot(snapshot), `${canonicalize({ manifest: snapshot.manifest, blobs: snapshot.blobs })}\n`);
  await writeRepositoryPackageSnapshot({ workspace: f.input.workspace, snapshot });
});

test('external native dependencies cannot bypass document content-type filtering', async t => {
  const f = await fixture(t);
  await f.put('skills/review/SKILL.md', '[Payload](../../docs/payload.exe)');
  await f.put('docs/payload.exe', '[More](downstream.md)');
  await f.put('docs/downstream.md', 'Would be outside selected scope');
  f.input.sourceAuthorization.policy.approvedRepositoryPaths = ['docs/payload.exe'];
  resign(f.input);
  const snapshot = await inventoryRepositoryPackage(f.input);
  assert.equal(snapshot.manifest.skills[0]?.availability, 'partial');
  assert.ok(!snapshot.manifest.files.some(file => file.path.startsWith('docs/')));
});

test('newline paths and identity suffixes are rejected by full-input checks', async t => {
  const f = await fixture(t);
  f.input.sourceAuthorization.policy.approvedRepositoryPaths = ['docs\n'];
  resign(f.input);
  await assert.rejects(inventoryRepositoryPackage(f.input), /path scope/);
  f.input.sourceAuthorization.policy.approvedRepositoryPaths = ['docs'];
  f.input.sourceAuthorization.generationId += '\n';
  resign(f.input);
  await assert.rejects(inventoryRepositoryPackage(f.input), /identity/);
  f.input.sourceAuthorization.generationId = GENERATION;
  if (process.platform !== 'win32') await f.put('docs/example.md\n', 'Not a portable source');
  const snapshot = await inventoryRepositoryPackage(f.input);
  assert.ok(!snapshot.manifest.files.some(file => file.role !== 'knowledge'));
});

test('proxy consent is rejected before reflection traps run', async t => {
  const f = await fixture(t);
  let invoked = false;
  const sourceAuthorization = new Proxy(f.input.sourceAuthorization, {
    getPrototypeOf() { invoked = true; throw new Error('never invoke'); },
    ownKeys() { invoked = true; throw new Error('never invoke'); },
  });
  assert.throws(() => validateRepositorySourceAuthorization(sourceAuthorization, f.input, NOW), /proxy/);
  assert.equal(invoked, false);
});

test('inherited serialization hooks never run for unknown consent input', async t => {
  const f = await fixture(t);
  const before = Object.getOwnPropertyDescriptor(Object.prototype, 'toJSON');
  let invoked = false;
  try {
    Object.defineProperty(Object.prototype, 'toJSON', { configurable: true, value() { invoked = true; return {}; } });
    assert.throws(() => validateRepositorySourceAuthorization(f.input.sourceAuthorization, f.input, NOW), /serialization hooks/);
    assert.equal(invoked, false);
  } finally {
    if (before) Object.defineProperty(Object.prototype, 'toJSON', before);
    else Reflect.deleteProperty(Object.prototype, 'toJSON');
  }
});

test('reconstructed approved outputs cannot bypass content types beneath native skill roots', async t => {
  const f = await fixture(t);
  f.input.sourceAuthorization.policy.approvedOutputFolders = ['skills/review'];
  resign(f.input);
  await f.put('skills/review/SKILL.md', '# Review');
  await f.put('skills/review/payload.exe', 'Unsupported external artifact');
  const snapshot = await inventoryRepositoryPackage(f.input);
  const file = snapshot.manifest.files.find(file => file.path === 'skills/review/payload.exe');
  assert.ok(file);
  file.role = 'approved_output';
  const a = snapshot.manifest.sourceAuthorization!;
  snapshot.manifest.sourceFingerprint = `sha256:${createHash('sha256').update(canonicalize({
    organizationId: snapshot.manifest.organizationId, repositoryBindingId: a.repositoryBindingId,
    repositoryAgentId: a.repositoryAgentId, generationId: a.generationId, policyHash: a.policyHash,
    files: snapshot.manifest.files.filter(file => file.role !== 'knowledge'), skills: snapshot.manifest.skills,
  })).digest('hex')}`;
  const { snapshotHash: _hash, snapshotId: _id, ...base } = snapshot.manifest;
  snapshot.manifest.snapshotHash = `sha256:${createHash('sha256').update(canonicalize(base)).digest('hex')}`;
  snapshot.manifest.snapshotId = `repository-package-${snapshot.manifest.snapshotHash.slice(7)}`;
  assert.throws(() => serializeRepositoryPackageSnapshot(snapshot), /content type integrity/);
});
