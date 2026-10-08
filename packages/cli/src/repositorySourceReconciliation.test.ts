import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test, { type TestContext } from 'node:test';
import { canonicalize } from '@dharma-ai-labs/agent-fabric-contracts';
import { initializeRepositoryKnowledge } from './repositoryKnowledge.js';
import { inventoryRepositoryPackage, rebuildRepositoryPackageSnapshot,
  serializeRepositoryPackageSnapshot, type RepositoryPackageFile,
  type RepositoryPackageSnapshot } from './repositoryPackage.js';
import { planRepositorySourceResolution, reconcileRepositorySourceSnapshot } from './repositorySourceReconciliation.js';
import { fetchPublishedRepositorySource } from './repositorySourceInventoryClient.js';
import type { RepositorySourceAuthorization } from './repositorySourceAuthorization.js';

const organizationId = 'org_reconcile_fixture';
const workspaceId = '11111111-1111-4111-8111-111111111111';
const repositoryBindingId = '22222222-2222-4222-8222-222222222222';
const repositoryAgentId = '33333333-3333-4333-8333-333333333333';
const generationId = '44444444-4444-4444-8444-444444444444';
const digest = (value: string | Buffer) => `sha256:${createHash('sha256').update(value).digest('hex')}`;
const policy: RepositorySourceAuthorization['policy'] = {
  action: 'authorize', confirmed: true, requestId: '55555555-5555-4555-8555-555555555555',
  repositoryBindingId, expectedRevision: 0,
  allowedContentClasses: ['approved_outputs', 'repository_content', 'repository_skills'],
  approvedRepositoryPaths: ['README.md'], approvedOutputFolders: ['output/reports'],
  automaticValidatedPublication: true, retentionDays: 30, maximumFileBytes: 262144,
  maximumSnapshotBytes: 4194304, maximumDailyUploadBytes: 8388608, expiresAt: null,
};
const authorization: RepositorySourceAuthorization = {
  schema: 'dharma.repository-source-authorization/v1', organizationId, workspaceId,
  repositoryBindingId, repositoryAgentId, revision: 1, generationId,
  receiptId: `repo_consent_${generationId}`, policyRevision: `repository-source-${generationId}`,
  policyHash: digest(canonicalize(policy)), confirmedAt: '2026-09-24T00:00:00.000Z', policy,
};

function file(path: string, content: string): { entry: RepositoryPackageFile; blob: { sha256: string; contentBase64: string } } {
  const bytes = Buffer.from(content);
  const sha256 = digest(bytes);
  return { entry: { path, role: path === 'README.md' ? 'repository_content' : 'approved_output',
    sha256, sizeBytes: bytes.length }, blob: { sha256, contentBase64: bytes.toString('base64') } };
}

async function fixture(t: TestContext) {
  const workspace = await mkdtemp(resolve(tmpdir(), 'repository-source-reconcile-'));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const managedRoot = resolve(workspace, '.agents/skills/dharma-agent-fabric');
  await mkdir(managedRoot, { recursive: true });
  await writeFile(resolve(managedRoot, '.dharma-agent-fabric.json'),
    JSON.stringify({ managedBy: 'dharma-agent-fabric', workspaceId }));
  await initializeRepositoryKnowledge({ organizationId, repositoryAgentId, workspace });
  await writeFile(resolve(workspace, 'README.md'), '# Shared repository\n');
  const template = await inventoryRepositoryPackage({ organizationId, workspaceId, repositoryBindingId,
    repositoryAgentId, workspace, sourceAuthorization: authorization });
  const snapshot = (...entries: ReturnType<typeof file>[]): RepositoryPackageSnapshot => {
    const knowledge = template.manifest.files.filter(item => item.role === 'knowledge');
    const hashes = new Set(knowledge.map(item => item.sha256));
    const blobs = [...template.blobs.filter(blob => hashes.has(blob.sha256)), ...entries.map(item => item.blob)];
    return rebuildRepositoryPackageSnapshot(template, {
      files: [...knowledge, ...entries.map(item => item.entry)], skills: [],
      blobs: [...new Map(blobs.map(blob => [blob.sha256, blob])).values()],
    });
  };
  return { snapshot, workspace };
}

function published(value: RepositoryPackageSnapshot) {
  const files = value.manifest.files.filter(item => item.role !== 'knowledge');
  const hashes = new Set(files.map(item => item.sha256));
  return { files, skills: value.manifest.skills, blobs: value.blobs.filter(blob => hashes.has(blob.sha256)),
    sourceFingerprint: value.manifest.sourceFingerprint! };
}

const readme = file('README.md', '# Shared repository\n');
const localReport = file('output/reports/local.md', '# Local report\n');
const remoteReport = file('output/reports/remote.md', '# Remote report\n');

test('reconciles independent approved reports without losing either source', async t => {
  const f = await fixture(t);
  const base = f.snapshot(readme);
  const local = f.snapshot(readme, localReport);
  const remote = f.snapshot(readme, remoteReport);
  const merged = reconcileRepositorySourceSnapshot({ local, previousLocal: base, published: published(remote) });
  assert.deepEqual(merged.manifest.files.filter(item => item.role !== 'knowledge').map(item => item.path),
    ['README.md', 'output/reports/local.md', 'output/reports/remote.md']);
  assert.notEqual(merged.manifest.sourceFingerprint, remote.manifest.sourceFingerprint);
  serializeRepositoryPackageSnapshot(merged);
});

test('does not resurrect a locally deleted file when the remote copy is unchanged', async t => {
  const f = await fixture(t);
  const base = f.snapshot(readme, localReport);
  const merged = reconcileRepositorySourceSnapshot({ local: f.snapshot(readme),
    previousLocal: base, published: published(base) });
  assert.deepEqual(merged.manifest.files.filter(item => item.role !== 'knowledge').map(item => item.path), ['README.md']);
});

test('adopts a remote deletion when this workspace has not changed the file', async t => {
  const f = await fixture(t);
  const base = f.snapshot(readme, localReport);
  const merged = reconcileRepositorySourceSnapshot({ local: base, previousLocal: base,
    published: published(f.snapshot(readme)) });
  assert.deepEqual(merged.manifest.files.filter(item => item.role !== 'knowledge').map(item => item.path), ['README.md']);
});

test('rejects concurrent conflicting modifications to the same source path', async t => {
  const f = await fixture(t);
  const base = f.snapshot(readme);
  const local = f.snapshot(file('README.md', '# Local revision\n'));
  const remote = f.snapshot(file('README.md', '# Remote revision\n'));
  assert.throws(() => reconcileRepositorySourceSnapshot({ local, previousLocal: base,
    published: published(remote) }), /changed concurrently at readme.md/);
});

test('an explicit exact-source resolution preserves independent remote changes without weakening default conflict rejection', async t => {
  const f = await fixture(t), now = new Date('2026-10-08T03:00:00.000Z');
  const base = f.snapshot(readme);
  const local = f.snapshot(file('README.md', '# Reviewed merged revision\n'), localReport);
  const remote = f.snapshot(file('README.md', '# Remote revision\n'), remoteReport);
  const input = { local, previousLocal: base, published: published(remote) };
  assert.throws(() => reconcileRepositorySourceSnapshot(input), /changed concurrently/);
  const resolution = { ...planRepositorySourceResolution({ ...input, now }), now };
  const result = reconcileRepositorySourceSnapshot({ ...input, resolution });
  assert.equal(result.manifest.files.find(f => f.path === 'README.md')?.sha256, local.manifest.files.find(f => f.path === 'README.md')?.sha256);
  assert.ok(result.manifest.files.some(f => f.path === remoteReport.entry.path));
  assert.ok(result.manifest.files.some(f => f.path === localReport.entry.path));
  assert.throws(() => reconcileRepositorySourceSnapshot(input), /changed concurrently/, 'Approval must not carry to another call.');
});

test('resolution approval rejects expired, future-dated and tampered plans', async t => {
  const f = await fixture(t), now = new Date('2026-10-08T03:00:00.000Z');
  const input = { local: f.snapshot(file('README.md', '# Local\n')), previousLocal: f.snapshot(readme),
    published: published(f.snapshot(file('README.md', '# Remote\n'))) };
  const proposed = planRepositorySourceResolution({ ...input, now });
  for (const at of [new Date(now.getTime() - 1), new Date(now.getTime() + 900000)]) {
    assert.throws(() => reconcileRepositorySourceSnapshot({ ...input, resolution: { ...proposed, now: at } }), /expired_or_invalid/);
  }
  for (const field of ['organizationId', 'workspaceId', 'repositoryBindingId', 'repositoryAgentId', 'policyGenerationId',
    'policyHash', 'baselineSnapshotHash', 'localSnapshotHash', 'publishedFingerprint', 'publishedInventoryHash', 'expiresAt'] as const) {
    const plan = { ...proposed.plan, [field]: 'tampered' };
    assert.throws(() => reconcileRepositorySourceSnapshot({ ...input, resolution: { ...proposed, plan, now } }), /context_changed/);
  }
  assert.throws(() => reconcileRepositorySourceSnapshot({ ...input,
    resolution: { ...proposed, plan: { ...proposed.plan, conflicts: [] }, now } }), /context_changed/);
});

test('an approved plan refuses local, remote or baseline changes after review', async t => {
  const f = await fixture(t), now = new Date('2026-10-08T03:00:00.000Z');
  const input = { local: f.snapshot(file('README.md', '# Local\n')), previousLocal: f.snapshot(readme),
    published: published(f.snapshot(file('README.md', '# Remote\n'))) };
  const resolution = { ...planRepositorySourceResolution({ ...input, now }), now };
  const changed = f.snapshot(file('README.md', '# Changed after review\n'));
  for (const value of [{ ...input, local: changed }, { ...input, previousLocal: changed },
    { ...input, published: published(changed) }, { ...input, published: { ...input.published,
      sourceFingerprint: `sha256:${'a'.repeat(64)}` } }]) {
    assert.throws(() => reconcileRepositorySourceSnapshot({ ...value, resolution }), /context_changed/);
  }
});

test('resolution plans require a retained baseline, published source and actual conflict', async t => {
  const f = await fixture(t), base = f.snapshot(readme);
  const local = f.snapshot(file('README.md', '# Local\n'));
  const remote = published(f.snapshot(file('README.md', '# Remote\n')));
  assert.throws(() => planRepositorySourceResolution({ local, previousLocal: null, published: remote }), /prerequisite_missing/);
  assert.throws(() => planRepositorySourceResolution({ local, previousLocal: base, published: null }), /prerequisite_missing/);
  assert.throws(() => planRepositorySourceResolution({ local: base, previousLocal: base, published: remote }), /not_required/);
});

test('explicit local deletion is pinned and resolution metadata contains no source content', async t => {
  const f = await fixture(t), marker = 'SYNTHETIC_PRIVATE_CONTENT_NOT_A_REAL_SECRET';
  const input = { local: f.snapshot(localReport), previousLocal: f.snapshot(readme, localReport),
    published: published(f.snapshot(file('README.md', marker), localReport)) };
  const now = new Date('2026-10-08T03:00:00.000Z');
  const proposed = planRepositorySourceResolution({ ...input, now });
  assert.equal(JSON.stringify(proposed).includes(marker), false);
  assert.equal(JSON.stringify(proposed).includes(Buffer.from(marker).toString('base64')), false);
  const result = reconcileRepositorySourceSnapshot({ ...input, resolution: { ...proposed, now } });
  assert.equal(result.manifest.files.some(f => f.path === 'README.md'), false);
});

test('skill conflicts require exact approval of both the skill descriptor and its source file', async t => {
  const f = await fixture(t), path = '.codex/skills/review/SKILL.md';
  await mkdir(resolve(f.workspace, '.codex/skills/review'), { recursive: true });
  const collect = async (content: string) => {
    await writeFile(resolve(f.workspace, path), content);
    return inventoryRepositoryPackage({ organizationId, workspaceId, repositoryBindingId,
      repositoryAgentId, workspace: f.workspace, sourceAuthorization: authorization });
  };
  const base = await collect('# Original review\n'), local = await collect('# Reviewed merged review\n');
  const remote = await collect('# Remote review\n');
  const input = { local, previousLocal: base, published: published(remote) }, now = new Date();
  const proposed = planRepositorySourceResolution({ ...input, now });
  assert.deepEqual(proposed.plan.conflicts.map(entry => entry.kind), ['file', 'skill']);
  const result = reconcileRepositorySourceSnapshot({ ...input, resolution: { ...proposed, now } });
  assert.equal(result.manifest.skills[0]!.contentHash, local.manifest.skills[0]!.contentHash);
  const incomplete = { ...proposed.plan, conflicts: proposed.plan.conflicts.filter(entry => entry.kind === 'file') };
  assert.throws(() => reconcileRepositorySourceSnapshot({ ...input,
    resolution: { plan: incomplete, planHash: digest(canonicalize(incomplete)), now } }), /context_changed/);
});

test('fresh workspaces preserve remote-only source and reject conflicting same-path content', async t => {
  const f = await fixture(t);
  const local = f.snapshot(readme, localReport);
  const remote = f.snapshot(readme, remoteReport);
  const merged = reconcileRepositorySourceSnapshot({ local, previousLocal: null, published: published(remote) });
  assert.equal(merged.manifest.files.filter(item => item.role !== 'knowledge').length, 3);
  assert.throws(() => reconcileRepositorySourceSnapshot({ local, previousLocal: null,
    published: published(f.snapshot(file('README.md', '# Different repository\n'))) }),
  /changed concurrently at readme.md/);
});

test('rejects missing or corrupted remote blobs through the normal snapshot serializer', async t => {
  const f = await fixture(t);
  const local = f.snapshot(readme);
  const remote = f.snapshot(readme, remoteReport);
  assert.throws(() => reconcileRepositorySourceSnapshot({ local, previousLocal: local,
    published: { ...published(remote), blobs: [] } }), /missing a content-addressed blob/);
  assert.throws(() => reconcileRepositorySourceSnapshot({ local, previousLocal: local,
    published: { ...published(remote), blobs: [{ ...remoteReport.blob, contentBase64: 'YmFk' }] } }),
  /blob integrity failed/);
});

test('reads scoped published inventory and verifies a missing remote blob', async t => {
  const f = await fixture(t);
  const local = f.snapshot(readme);
  const remote = f.snapshot(readme, remoteReport);
  const candidateId = '66666666-6666-4666-8666-666666666666';
  const remoteFile = remote.manifest.files.find(item => item.path === remoteReport.entry.path)!;
  const view = { ok: true, organizationId, repositoryBindingId, repositoryAgentId,
    policyGenerationId: generationId, workspaceBaseline: null,
    source: { candidateId, workspaceId: '77777777-7777-4777-8777-777777777777',
      sourceSnapshotHash: remote.manifest.snapshotHash,
      sourceManifestHash: digest(canonicalize(remote.manifest)),
      sourceFingerprint: remote.manifest.sourceFingerprint,
      files: published(remote).files, skills: remote.manifest.skills } };
  const requests: string[] = [];
  const transport = { signedGet: async (route: string): Promise<Record<string, unknown>> => {
    requests.push(route);
    if (!route.includes('/blobs/')) return view;
    return { ok: true, organizationId, repositoryBindingId, repositoryAgentId,
      candidateId, sourceSnapshotHash: remote.manifest.snapshotHash,
      sourceFingerprint: remote.manifest.sourceFingerprint, path: remoteFile.path,
      role: remoteFile.role, sha256: remoteFile.sha256, sizeBytes: remoteFile.sizeBytes,
      contentBase64: remoteReport.blob.contentBase64 };
  } };
  const scope = { organizationId, workspaceId, repositoryBindingId, repositoryAgentId };
  const fetched = await fetchPublishedRepositorySource({ transport, scope, authorization, local });
  assert.equal(fetched?.blobs.length, 1);
  assert.equal(fetched?.blobs[0]?.sha256, remoteReport.blob.sha256);
  assert.equal(requests.length, 2);
  const merged = reconcileRepositorySourceSnapshot({ local, previousLocal: local, published: fetched });
  assert.deepEqual(merged.manifest.files.filter(item => item.role !== 'knowledge').map(item => item.path),
    ['README.md', 'output/reports/remote.md']);
  await assert.rejects(fetchPublishedRepositorySource({ transport: { signedGet: async () =>
    ({ ...view, organizationId: 'org_foreign' }) }, scope, authorization, local }), /authority/);
  await assert.rejects(fetchPublishedRepositorySource({ transport: { signedGet: async route =>
    route.includes('/blobs/') ? { ...(await transport.signedGet(route)), contentBase64: 'YmFk' }
      : view }, scope, authorization, local }), /blob integrity/);
});
