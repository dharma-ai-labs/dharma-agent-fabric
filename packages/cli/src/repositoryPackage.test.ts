import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { link, mkdir, mkdtemp, readFile, readdir, rename, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { Ajv2020 } from 'ajv/dist/2020.js';
import {
  inventoryRepositoryPackage, serializeRepositoryPackageSnapshot, writeRepositoryPackageSnapshot,
} from './repositoryPackage.js';
import { installRepositoryAgentFabricSkill, run } from './index.js';
import { canonicalize } from '@dharma-ai-labs/agent-fabric-contracts';

async function fixture() {
  const workspace = await mkdtemp(resolve(tmpdir(), 'repository-package-'));
  const put = async (path: string, text: string) => {
    await mkdir(dirname(resolve(workspace, path)), { recursive: true });
    await writeFile(resolve(workspace, path), text);
  };
  return { workspace, put, organizationId: 'org_fixture', workspaceId: 'workspace_fixture' };
}

async function treeBytes(root: string, path = ''): Promise<Array<{ path: string; content: string }>> {
  const files: Array<{ path: string; content: string }> = [];
  for (const entry of (await readdir(resolve(root, path), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const child = path ? `${path}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...await treeBytes(root, child));
    else files.push({ path: child, content: (await readFile(resolve(root, child))).toString('base64') });
  }
  return files;
}

test('collecting a candidate preserves every byte and path of an installed shared release', async () => {
  const f = await fixture();
  await f.put('.codex/skills/review/SKILL.md', '# Changed source skill');
  const snapshot = await inventoryRepositoryPackage(f);
  const root = '.agents/skills/dharma-agent-fabric';
  await f.put(`${root}/SKILL.md`, '# Accepted signed skill');
  await f.put(`${root}/.dharma-agent-fabric.json`, JSON.stringify({ managedBy: 'dharma-agent-fabric' }));
  await f.put(`${root}/MANIFEST.json`, JSON.stringify({ schema: 'dharma.repository-release-manifest/v1', sourceSnapshotHash: `sha256:${'a'.repeat(64)}` }));
  await f.put(`${root}/knowledge/CATALOG.json`, '{"schema":"dharma.repository-knowledge/v2","concepts":[{"definition":"Retained knowledge"}]}');
  await f.put(`${root}/skills/source/.codex/skills/review/SKILL.md`, '# Accepted source copy');
  await f.put(`${root}/COPY-JOURNAL.json`, '{"interrupted":"must not replay against signed release"}');
  const before = await treeBytes(resolve(f.workspace, root));
  const collected = await writeRepositoryPackageSnapshot({ workspace: f.workspace, snapshot });
  assert.equal(collected.authority, 'local_inventory_not_signed');
  assert.equal(collected.managedCopiesPath, null);
  assert.ok(collected.manifestPath.startsWith('.dharma/repository-source/snapshots/'));
  assert.ok(collected.snapshotPath.startsWith('.dharma/repository-source/snapshots/'));
  assert.deepEqual(await treeBytes(resolve(f.workspace, root)), before);
  assert.equal(await readFile(resolve(f.workspace, collected.snapshotPath), 'utf8'), serializeRepositoryPackageSnapshot(snapshot));
  assert.deepEqual(JSON.parse(await readFile(resolve(f.workspace, collected.manifestPath), 'utf8')), snapshot.manifest);
  assert.deepEqual(await writeRepositoryPackageSnapshot({ workspace: f.workspace, snapshot }), collected);
  assert.deepEqual(await treeBytes(resolve(f.workspace, root)), before);
});

test('candidate-only collection never installs or replaces the bootstrap skill inventory', async () => {
  const f = await fixture();
  await f.put('skills/review/SKILL.md', '# Original');
  const initial = await inventoryRepositoryPackage(f);
  await writeRepositoryPackageSnapshot({ workspace: f.workspace, snapshot: initial });
  const root = '.agents/skills/dharma-agent-fabric';
  const before = await treeBytes(resolve(f.workspace, root));
  await f.put('skills/review/SKILL.md', '# Changed');
  const snapshot = await inventoryRepositoryPackage(f);
  const collected = await writeRepositoryPackageSnapshot({ workspace: f.workspace, snapshot, candidateOnly: true } as Parameters<typeof writeRepositoryPackageSnapshot>[0]);
  assert.equal(collected.managedCopiesPath, null);
  assert.ok(collected.snapshotPath.startsWith('.dharma/repository-source/snapshots/'));
  assert.deepEqual(await treeBytes(resolve(f.workspace, root)), before);
});

test('candidate-only collection creates no active skill tree and rejects corrupt immutable sidecars', async () => {
  const f = await fixture();
  await f.put('skills/review/SKILL.md', '# Review');
  const snapshot = await inventoryRepositoryPackage(f);
  const input = { workspace: f.workspace, snapshot, candidateOnly: true };
  const collected = await writeRepositoryPackageSnapshot(input);
  assert.equal(collected.disposition, 'candidate_only');
  await assert.rejects(readdir(resolve(f.workspace, '.agents')), /ENOENT/);
  await writeFile(resolve(f.workspace, collected.manifestPath), '{}');
  await assert.rejects(writeRepositoryPackageSnapshot(input), /CAS conflict/);
  assert.equal(await readFile(resolve(f.workspace, collected.manifestPath), 'utf8'), '{}');
  await assert.rejects(readdir(resolve(f.workspace, '.agents')), /ENOENT/);
});

test('candidate storage rejects symlinked source-state ancestors without touching their targets', async () => {
  const f = await fixture();
  const other = await fixture();
  await f.put('skills/review/SKILL.md', '# Review');
  const snapshot = await inventoryRepositoryPackage(f);
  await symlink(other.workspace, resolve(f.workspace, '.dharma'), 'dir');
  await assert.rejects(writeRepositoryPackageSnapshot({ workspace: f.workspace, snapshot, candidateOnly: true }), /symlink/);
  assert.deepEqual(await readdir(other.workspace), []);
});

test('candidate-only collection does not replay an interrupted local copy transaction', async () => {
  const f = await fixture();
  await f.put('skills/review/SKILL.md', '# Original');
  await writeRepositoryPackageSnapshot({ workspace: f.workspace, snapshot: await inventoryRepositoryPackage(f) });
  await f.put('skills/review/SKILL.md', '# Intermediate');
  const interrupted = await inventoryRepositoryPackage(f);
  await assert.rejects(writeRepositoryPackageSnapshot({ workspace: f.workspace, snapshot: interrupted,
    onCopyCheckpoint(point) { if (point === 'file_backed_up') throw new Error('interrupted'); } }), /interrupted/);
  const root = '.agents/skills/dharma-agent-fabric';
  const before = await treeBytes(resolve(f.workspace, root));
  await f.put('skills/review/SKILL.md', '# Latest');
  const latest = await inventoryRepositoryPackage(f);
  const collected = await writeRepositoryPackageSnapshot({ workspace: f.workspace, snapshot: latest, candidateOnly: true });
  assert.equal(collected.disposition, 'candidate_only');
  assert.deepEqual(await treeBytes(resolve(f.workspace, root)), before);
  await writeRepositoryPackageSnapshot({ workspace: f.workspace, snapshot: latest });
  assert.equal(await readFile(resolve(f.workspace, root, 'skills/source/skills/review/SKILL.md'), 'utf8'), '# Latest');
});

test('legacy in-skill snapshot journals remain recoverable without copying new CAS objects into the skill', async () => {
  const f = await fixture();
  await f.put('skills/review/SKILL.md', '# Original');
  const initial = await inventoryRepositoryPackage(f);
  const collected = await writeRepositoryPackageSnapshot({ workspace: f.workspace, snapshot: initial });
  const root = '.agents/skills/dharma-agent-fabric';
  await f.put(`${root}/snapshots/${initial.manifest.snapshotHash.slice(7)}.json`, serializeRepositoryPackageSnapshot(initial));
  await unlink(resolve(f.workspace, collected.snapshotPath));
  await f.put('skills/review/SKILL.md', '# Changed');
  const next = await inventoryRepositoryPackage(f);
  await writeRepositoryPackageSnapshot({ workspace: f.workspace, snapshot: next });
  assert.deepEqual(await readdir(resolve(f.workspace, root, 'snapshots')), [`${initial.manifest.snapshotHash.slice(7)}.json`]);
  assert.equal(await readFile(resolve(f.workspace, root, 'skills/source/skills/review/SKILL.md'), 'utf8'), '# Changed');
});

test('inventories all provider roots and companions without claiming runtime use', async () => {
  const f = await fixture();
  for (const root of ['.agents/skills', '.claude/skills', '.codex/skills', 'skills']) {
    await f.put(`${root}/review/SKILL.md`, '# Review\n[Procedure](references/procedure.md)');
    await f.put(`${root}/review/references/procedure.md`, 'Use visible evidence.');
  }
  const result = await inventoryRepositoryPackage(f);
  assert.equal(result.manifest.skills.length, 4);
  assert.equal(result.manifest.files.length, 8);
  assert.ok(result.manifest.skills.every(skill => skill.availability === 'available' && skill.observation.state === 'not_observed'));
  assert.ok(!serializeRepositoryPackageSnapshot(result).includes(f.workspace));
});

test('stable CAS serialization deduplicates blobs and excludes capture time and generated roots', async () => {
  const f = await fixture();
  await f.put('skills/review/SKILL.md', '# Review');
  await f.put('skills/review/references/a.md', 'Same content');
  await f.put('skills/review/references/b.md', 'Same content');
  const first = await inventoryRepositoryPackage({ ...f, now: new Date('2026-09-17T00:00:00Z') });
  await writeRepositoryPackageSnapshot({ workspace: f.workspace, snapshot: first });
  const second = await inventoryRepositoryPackage({ ...f, now: new Date('2026-09-18T00:00:00Z') });
  assert.equal(first.manifest.snapshotHash, second.manifest.snapshotHash);
  assert.equal(serializeRepositoryPackageSnapshot(first), serializeRepositoryPackageSnapshot(second));
  assert.equal(first.blobs.length, 2);
  await writeRepositoryPackageSnapshot({ workspace: f.workspace, snapshot: second });
  await f.put('skills/review/SKILL.md', '# Changed');
  assert.notEqual((await inventoryRepositoryPackage(f)).manifest.snapshotHash, first.manifest.snapshotHash);
});

test('project-scoped signed skill internals never enter repository source inventory', async () => {
  const f = await fixture();
  await f.put('.agents/skills/customer/SKILL.md', '# Customer skill');
  await f.put('.agents/skills/.dharma-managed/workspaces/local/active/dharma-agent-fabric/SKILL.md', '# Signed release');
  await f.put('.agents/skills/.dharma-activation-test/staged/dharma-agent-fabric/SKILL.md', '# Staged release');
  await f.put('.claude/skills/.dharma-managed/workspaces/local/active/dharma-agent-fabric/SKILL.md', '# Signed release');
  const snapshot = await inventoryRepositoryPackage(f);
  assert.deepEqual(snapshot.manifest.skills.map(skill => skill.path), ['.agents/skills/customer']);
  assert.equal(serializeRepositoryPackageSnapshot(snapshot).includes('Signed release'), false);
});

test('follows relative dependencies once, including cycles, and snapshots only approved outputs', async () => {
  const f = await fixture();
  await f.put('skills/review/SKILL.md', '[Guide](../../docs/a.md)\n[Missing](references/missing.md)');
  await f.put('docs/a.md', '[Loop](../skills/review/SKILL.md)');
  await f.put('output/approved.json', '{"status":"passed"}');
  await f.put('output/unapproved.md', 'Must not collect');
  const snapshot = await inventoryRepositoryPackage({ ...f, approvedOutputs: ['output/approved.json'] });
  assert.deepEqual(snapshot.manifest.files.map(file => file.path), ['docs/a.md', 'output/approved.json', 'skills/review/SKILL.md']);
  assert.equal(snapshot.manifest.skills[0]?.availability, 'partial');
  assert.ok(snapshot.manifest.exclusions.some(item => item.reason === 'missing_dependency'));
});

test('never reads symlinked roots, companions, or dependency escapes', async () => {
  const f = await fixture();
  const outside = await fixture();
  await outside.put('secret.md', 'Outside private data');
  await f.put('skills/review/SKILL.md', '[Outside](../../../secret.md)\n[Link](references/link.md)');
  await mkdir(resolve(f.workspace, 'skills/review/references'));
  await symlink(resolve(outside.workspace, 'secret.md'), resolve(f.workspace, 'skills/review/references/link.md'));
  await symlink(outside.workspace, resolve(f.workspace, '.claude'));
  const snapshot = await inventoryRepositoryPackage(f);
  assert.ok(snapshot.manifest.exclusions.some(item => item.reason === 'symlink'));
  assert.ok(!serializeRepositoryPackageSnapshot(snapshot).includes('Outside private data'));
  await assert.rejects(inventoryRepositoryPackage({ ...f, approvedOutputs: ['../secret.md'] }));
  await assert.rejects(inventoryRepositoryPackage({ ...f, approvedOutputs: ['C:\\private\\secret.md'] }));
});

test('excludes environment, credentials, binary content and secrets rather than shipping redacted source', async () => {
  const f = await fixture();
  await f.put('skills/review/SKILL.md', '# Safe');
  await f.put('skills/review/.env.production', 'PRIVATE_VALUE=must-not-appear');
  await f.put('skills/review/credential.json', '{"password":"must-not-appear"}');
  await f.put('skills/review/.envrc', 'PRIVATE_VALUE=must-not-appear');
  await f.put('skills/review/.npmrc', '//registry.npmjs.org/:_authToken=must-not-appear');
  await f.put('skills/review/references/short.yaml', "'password': 'p'\n");
  await f.put('skills/review/references/private.md', '-----BEGIN PRIVATE KEY-----\nprivate-value');
  await f.put('skills/review/references/token.json', '{"access_token":"abcdefgh123456789"}');
  await f.put('skills/review/references/binary.txt', '\u0000binary');
  await f.put('skills/review/references/path.md', 'Private file /home/customer/private/project.md');
  await f.put(`skills/review/references/ghp_${'a'.repeat(30)}.md`, 'Filename must not leak');
  const snapshot = await inventoryRepositoryPackage(f);
  const serialized = serializeRepositoryPackageSnapshot(snapshot);
  assert.equal(snapshot.manifest.files.length, 1);
  assert.ok(!serialized.includes('must-not-appear'));
  assert.ok(!snapshot.blobs.some(blob => Buffer.from(blob.contentBase64, 'base64').toString().includes('private-value')));
  assert.equal(snapshot.manifest.skills[0]?.availability, 'partial');
  assert.ok(!serialized.includes(`ghp_${'a'.repeat(30)}`));
});

test('observations require the exact skill and an approved immutable source snapshot', async () => {
  const f = await fixture();
  await f.put('skills/review/SKILL.md', '# Safe');
  await f.put('output/receipt.json', '{"used":true}');
  const approvedOutputs = ['output/receipt.json'];
  const base = await inventoryRepositoryPackage({ ...f, approvedOutputs });
  const observation = { skillPath: 'skills/review', skillHash: base.manifest.skills[0]!.contentHash,
    sourcePath: 'output/receipt.json', sourceHash: base.manifest.files.find(file => file.role === 'approved_output')!.sha256 };
  const observed = await inventoryRepositoryPackage({ ...f, approvedOutputs, observations: [observation] });
  assert.equal(observed.manifest.skills[0]?.observation.state, 'reported_observed');
  assert.equal(observed.manifest.skills[0]?.observation.authority, 'caller_supplied_not_runtime_verified');
  await assert.rejects(inventoryRepositoryPackage({ ...f, observations: [observation] }));
  await assert.rejects(inventoryRepositoryPackage({ ...f, approvedOutputs, observations: [{ ...observation, skillHash: `sha256:${'0'.repeat(64)}` }] }));
});

test('bounds entry, byte and dependency traversal without silently truncating inventory', async () => {
  const f = await fixture();
  await f.put('skills/review/SKILL.md', '[A](../../docs/a.md)');
  await f.put('docs/a.md', '[B](b.md)');
  await f.put('docs/b.md', '# B');
  await assert.rejects(inventoryRepositoryPackage({ ...f, limits: { maximumEntries: 1 } }), /limit/);
  await assert.rejects(inventoryRepositoryPackage({ ...f, limits: { maximumFileBytes: 4 } }), /limit/);
  await assert.rejects(inventoryRepositoryPackage({ ...f, limits: { maximumDependencies: 1 } }), /limit/);
});

test('schema validates the manifest and rejects unbounded fields and false observation states', async () => {
  const f = await fixture();
  await f.put('skills/review/SKILL.md', '# Safe');
  const { manifest } = await inventoryRepositoryPackage(f);
  const schema = JSON.parse(await readFile(new URL('../../../schemas/repository-package.schema.json', import.meta.url), 'utf8'));
  const ajv = new Ajv2020({ strict: true });
  const validate = ajv.compile(schema);
  assert.equal(validate(manifest), true, JSON.stringify(validate.errors));
  assert.equal(validate({ ...manifest, secret: 'no' }), false);
  assert.equal(validate({ ...manifest, skills: [{ ...manifest.skills[0], observation: { state: 'observed' } }] }), false);
});

test('installer integrates MANIFEST and local CAS without collecting its generated outputs', async () => {
  const f = await fixture();
  await f.put('.codex/skills/review/SKILL.md', '# Safe');
  const installed = await installRepositoryAgentFabricSkill({ ...f, hqUrl: 'https://example.invalid', policyRevision: '1' });
  const manifest = JSON.parse(await readFile(resolve(f.workspace, installed.repositoryPackage.manifestPath), 'utf8'));
  assert.equal(manifest.skills.length, 1);
  assert.equal(manifest.skills[0].path, '.codex/skills/review');
  const refreshed = await inventoryRepositoryPackage(f);
  assert.equal(refreshed.manifest.snapshotHash, manifest.snapshotHash);
});

for (const kind of ['symlink', 'hardlink'] as const) {
  test(`installer refuses linked generated leaves (${kind}) before changing original source bytes`, async () => {
    const f = await fixture();
    const original = '.codex/skills/customer/SKILL.md';
    const bytes = '# Original customer skill\nPreserve this exact content.\n';
    await f.put(original, bytes);
    await f.put('.agents/skills/dharma-agent-fabric/.dharma-agent-fabric.json',
      JSON.stringify({ managedBy: 'dharma-agent-fabric', workspaceId: f.workspaceId }));
    const target = resolve(f.workspace, '.agents/skills/dharma-agent-fabric/SKILL.md');
    if (kind === 'symlink') await symlink(resolve(f.workspace, original), target);
    else await link(resolve(f.workspace, original), target);
    let rejected = false;
    try { await installRepositoryAgentFabricSkill({ ...f, hqUrl: 'https://example.invalid', policyRevision: '1' }); }
    catch { rejected = true; }
    assert.equal(await readFile(resolve(f.workspace, original), 'utf8'), bytes, kind);
    assert.equal(rejected, true, kind);
  });
}

test('installer rejects a linked managed root before writing outside the work repository', async () => {
  const f = await fixture(), outside = await fixture();
  const bytes = '# Outside source\nNever overwrite.\n';
  await outside.put('.dharma-agent-fabric.json', JSON.stringify({ managedBy: 'dharma-agent-fabric', workspaceId: f.workspaceId }));
  await outside.put('SKILL.md', bytes);
  await mkdir(resolve(f.workspace, '.agents/skills'), { recursive: true });
  await symlink(outside.workspace, resolve(f.workspace, '.agents/skills/dharma-agent-fabric'), 'dir');
  let rejected = false;
  try { await installRepositoryAgentFabricSkill({ ...f, hqUrl: 'https://example.invalid', policyRevision: '1' }); }
  catch { rejected = true; }
  assert.equal(await readFile(resolve(outside.workspace, 'SKILL.md'), 'utf8'), bytes);
  await assert.rejects(readFile(resolve(outside.workspace, 'references/organization.md')));
  assert.equal(rejected, true);
});

test('installer rejects invalid ownership markers before touching generated files', async () => {
  const f = await fixture();
  await f.put('.agents/skills/dharma-agent-fabric/.dharma-agent-fabric.json', '{}');
  await f.put('.agents/skills/dharma-agent-fabric/SKILL.md', '# Preserve unmanaged bytes');
  let rejected = false;
  try { await installRepositoryAgentFabricSkill({ ...f, hqUrl: 'https://example.invalid', policyRevision: '1' }); }
  catch { rejected = true; }
  assert.equal(await readFile(resolve(f.workspace, '.agents/skills/dharma-agent-fabric/SKILL.md'), 'utf8'), '# Preserve unmanaged bytes');
  assert.equal(rejected, true);
});

test('installer preflights connection leaves before modifying the managed skill', async () => {
  const f = await fixture(), outside = await fixture();
  await f.put('.agents/skills/dharma-agent-fabric/.dharma-agent-fabric.json',
    JSON.stringify({ managedBy: 'dharma-agent-fabric', workspaceId: f.workspaceId }));
  await f.put('.agents/skills/dharma-agent-fabric/SKILL.md', '# Existing managed skill');
  await outside.put('connection.json', '{"preserve":true}');
  await mkdir(resolve(f.workspace, '.dharma'), { recursive: true });
  await symlink(resolve(outside.workspace, 'connection.json'), resolve(f.workspace, '.dharma/agent-fabric.json'));
  await assert.rejects(installRepositoryAgentFabricSkill({ ...f, hqUrl: 'https://example.invalid', policyRevision: '1' }), /symlink/);
  assert.equal(await readFile(resolve(f.workspace, '.agents/skills/dharma-agent-fabric/SKILL.md'), 'utf8'), '# Existing managed skill');
  assert.equal(await readFile(resolve(outside.workspace, 'connection.json'), 'utf8'), '{"preserve":true}');
});

test('snapshot command defaults to dry-run without enrollment, writes or network', async () => {
  const f = await fixture();
  await f.put('skills/review/SKILL.md', '# Safe');
  const result = await run(['repositories', 'snapshot', '--workspace', f.workspace, '--organization-id', f.organizationId,
    '--workspace-id', f.workspaceId, '--dry-run']) as { dryRun: boolean; serverMutation: boolean; localMutation: boolean };
  assert.equal(result.dryRun, true);
  assert.equal(result.localMutation, false);
  assert.equal(result.serverMutation, false);
  await assert.rejects(readFile(resolve(f.workspace, '.agents/skills/dharma-agent-fabric/MANIFEST.json')));
});

test('repository installer creates one unsigned catalog and includes exact catalog bytes in MANIFEST', async () => {
  const f = await fixture();
  const input = { ...f, hqUrl: 'https://example.invalid', policyRevision: '1', repositoryAgentId: 'repo_agent_fixture' };
  const installed = await installRepositoryAgentFabricSkill(input);
  assert.equal(installed.knowledge?.disposition, 'initialized');
  const snapshot = await inventoryRepositoryPackage(input);
  assert.equal(snapshot.manifest.knowledge?.authority, 'locally_initialized_unsigned');
  assert.equal(snapshot.manifest.knowledge?.atlasAssociation, 'local_scope_only');
  const file = snapshot.manifest.files.find(file => file.role === 'knowledge');
  assert.ok(file);
  const bytes = await readFile(resolve(f.workspace, file.path));
  assert.equal(file.sha256, `sha256:${createHash('sha256').update(bytes).digest('hex')}`);
  assert.equal(snapshot.blobs.find(blob => blob.sha256 === file.sha256)?.contentBase64, bytes.toString('base64'));
  assert.doesNotThrow(() => serializeRepositoryPackageSnapshot(snapshot));
  const repeated = await installRepositoryAgentFabricSkill(input);
  assert.equal(repeated.knowledge?.disposition, 'reused');
  assert.equal(repeated.knowledge?.catalog.knowledgeBaseId, installed.knowledge?.catalog.knowledgeBaseId);
  assert.equal(repeated.repositoryPackage.snapshotHash, installed.repositoryPackage.snapshotHash);
  await assert.rejects(inventoryRepositoryPackage({ ...input, repositoryAgentId: 'foreign_repo_agent' }), /scope mismatch/);
  const connectionPath = resolve(f.workspace, '.dharma/agent-fabric.json');
  const before = await readFile(connectionPath);
  await assert.rejects(installRepositoryAgentFabricSkill({ ...input, organizationId: 'org_foreign' }), /scope mismatch/);
  assert.deepEqual(await readFile(connectionPath), before);
});

test('generated knowledge path cannot be smuggled into ordinary output inventory', async () => {
  const f = await fixture();
  await installRepositoryAgentFabricSkill({ ...f, hqUrl: 'https://example.invalid', policyRevision: '1', repositoryAgentId: 'repo_agent_fixture' });
  await assert.rejects(inventoryRepositoryPackage({ ...f,
    approvedOutputs: ['.agents/skills/dharma-agent-fabric/knowledge/CATALOG.json'] }), /scope or limit/);
});

test('CAS serialization rejects a self-consistent snapshot with forged knowledge mapping', async () => {
  const f = await fixture();
  const input = { ...f, hqUrl: 'https://example.invalid', policyRevision: '1', repositoryAgentId: 'repo_agent_fixture' };
  await installRepositoryAgentFabricSkill(input);
  const snapshot = await inventoryRepositoryPackage(input);
  snapshot.manifest.knowledge!.knowledgeBaseId = `repository-kb:sha256:${'a'.repeat(64)}`;
  const { snapshotHash: _hash, snapshotId: _id, ...base } = snapshot.manifest;
  snapshot.manifest.snapshotHash = `sha256:${createHash('sha256').update(canonicalize(base)).digest('hex')}`;
  snapshot.manifest.snapshotId = `repository-package-${snapshot.manifest.snapshotHash.slice(7)}`;
  assert.throws(() => serializeRepositoryPackageSnapshot(snapshot), /knowledge mapping integrity/);
});

test('CAS persistence rejects tampered snapshots, corrupt existing objects and symlinked destinations', async () => {
  const f = await fixture();
  await f.put('skills/review/SKILL.md', '# Safe');
  const snapshot = await inventoryRepositoryPackage(f);
  await assert.rejects(writeRepositoryPackageSnapshot({ workspace: f.workspace,
    snapshot: { ...snapshot, blobs: [{ ...snapshot.blobs[0]!, contentBase64: Buffer.from('tamper').toString('base64') }] } }));
  const persisted = await writeRepositoryPackageSnapshot({ workspace: f.workspace, snapshot });
  await writeFile(resolve(f.workspace, persisted.snapshotPath), 'corrupt');
  await assert.rejects(writeRepositoryPackageSnapshot({ workspace: f.workspace, snapshot }), /conflict/);
  const other = await fixture();
  await other.put('skills/review/SKILL.md', '# Safe');
  await mkdir(resolve(other.workspace, '.agents/skills'), { recursive: true });
  await symlink(f.workspace, resolve(other.workspace, '.agents/skills/dharma-agent-fabric'));
  await assert.rejects(writeRepositoryPackageSnapshot({ workspace: other.workspace, snapshot: await inventoryRepositoryPackage(other) }), /symlink/);
});

test('concurrent persistence publishes complete CAS objects and preserves unmanaged skills', async () => {
  const f = await fixture();
  await f.put('skills/review/SKILL.md', '# Safe');
  const snapshot = await inventoryRepositoryPackage(f);
  const results = await Promise.all([writeRepositoryPackageSnapshot({ workspace: f.workspace, snapshot }),
    writeRepositoryPackageSnapshot({ workspace: f.workspace, snapshot })]);
  assert.deepEqual(results[0], results[1]);
  assert.equal(await readFile(resolve(f.workspace, results[0]!.snapshotPath), 'utf8'), serializeRepositoryPackageSnapshot(snapshot));
  const unmanaged = await fixture();
  await unmanaged.put('.agents/skills/dharma-agent-fabric/SKILL.md', '# User owned');
  await assert.rejects(writeRepositoryPackageSnapshot({ workspace: unmanaged.workspace,
    snapshot: await inventoryRepositoryPackage(unmanaged) }), /unmanaged/);
  assert.equal(await readFile(resolve(unmanaged.workspace, '.agents/skills/dharma-agent-fabric/SKILL.md'), 'utf8'), '# User owned');
});

test('filesystem case semantics are preserved and Windows traversal and protected paths are rejected', async () => {
  const f = await fixture();
  await f.put('skills/Review/SKILL.md', '# Uppercase');
  await f.put('skills/review/SKILL.md', '# Lowercase');
  await f.put('skills/review/.ENV.local', 'password=must-not-appear');
  const snapshot = await inventoryRepositoryPackage(f);
  const directories = (await readdir(resolve(f.workspace, 'skills'))).sort();
  assert.deepEqual(snapshot.manifest.skills.map(skill => skill.path), directories.map(path => `skills/${path}`));
  assert.equal(directories.length, await readFile(resolve(f.workspace, 'skills/Review/SKILL.md'), 'utf8') === '# Uppercase' ? 2 : 1);
  assert.ok(!snapshot.manifest.files.some(file => file.path.includes('.ENV')));
  for (const path of ['skills\\review\\SKILL.md', '//outside/file.md', 'skills/../outside.md', '.env', 'skills/review/.ENV.local']) {
    await assert.rejects(inventoryRepositoryPackage({ ...f, approvedOutputs: [path] }));
  }
});

test('installer permits an operating-system ancestor alias but rejects an aliased workspace', async () => {
  const f = await fixture();
  const parent = await mkdtemp(resolve(tmpdir(), 'repository-alias-'));
  const alias = resolve(parent, 'system-alias');
  await symlink(dirname(f.workspace), alias, process.platform === 'win32' ? 'junction' : 'dir');
  const workspace = resolve(alias, f.workspace.slice(dirname(f.workspace).length + 1));
  await f.put('skills/review/SKILL.md', '# Safe');
  const result = await installRepositoryAgentFabricSkill({ ...f, workspace, repositoryAgentId: 'repo_agent_fixture',
    hqUrl: 'https://example.invalid', policyRevision: '1' });
  assert.equal((JSON.parse(await readFile(resolve(workspace, result.repositoryPackage.manifestPath), 'utf8')) as {
    skills: unknown[] }).skills.length, 1);
  assert.equal(result.knowledge?.disposition, 'initialized');
  const linkedWorkspace = resolve(parent, 'workspace-alias');
  await symlink(f.workspace, linkedWorkspace, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(installRepositoryAgentFabricSkill({ ...f, workspace: linkedWorkspace,
    hqUrl: 'https://example.invalid', policyRevision: '1' }), /symlink/);
});

test('explicit snapshot apply refreshes only an installed managed root and rejects conflicting modes', async () => {
  const f = await fixture();
  await f.put('skills/review/SKILL.md', '# Safe');
  const args = ['repositories', 'snapshot', '--workspace', f.workspace, '--organization-id', f.organizationId, '--workspace-id', f.workspaceId];
  await assert.rejects(run([...args, '--apply']), /installed managed/);
  await assert.rejects(run([...args, '--apply', '--dry-run']), /Choose/);
  await installRepositoryAgentFabricSkill({ ...f, hqUrl: 'https://example.invalid', policyRevision: '1' });
  await f.put('output/report.json', '{"checks":3}');
  const result = await run([...args, '--approved-output', 'output/report.json', '--apply']) as {
    localMutation: boolean; serverMutation: boolean; snapshot: { manifest: { files: Array<{ path: string }> } } };
  assert.equal(result.localMutation, true);
  assert.equal(result.serverMutation, false);
  assert.ok(result.snapshot.manifest.files.some(file => file.path === 'output/report.json'));
});

test('opaque secret filenames still mark their owning skill partial without leaking names', async () => {
  const f = await fixture();
  await f.put('skills/review/SKILL.md', '# Safe');
  const name = `ghp_${'b'.repeat(30)}`;
  await f.put(`skills/review/${name}.md`, '# Companion');
  const snapshot = await inventoryRepositoryPackage(f);
  assert.equal(snapshot.manifest.skills[0]?.availability, 'partial');
  assert.ok(!serializeRepositoryPackageSnapshot(snapshot).includes(name));
});

test('approving an existing skill source does not suppress its dependency graph', async () => {
  const f = await fixture();
  await f.put('skills/review/SKILL.md', '[Guide](../../docs/guide.md)');
  await f.put('docs/guide.md', '# Guide');
  const snapshot = await inventoryRepositoryPackage({ ...f, approvedOutputs: ['skills/review/SKILL.md'] });
  assert.ok(snapshot.manifest.files.some(file => file.path === 'docs/guide.md'));
});

const managedRoot = '.agents/skills/dharma-agent-fabric';

test('managed copies preserve original skills, relative companions, and visible partial status', async () => {
  const f = await fixture();
  await f.put('.codex/skills/review/SKILL.md', '[Guide](references/guide.md)\n[Shared](../../docs/shared.md)\n[Missing](references/missing.md)');
  await f.put('.codex/skills/review/references/guide.md', '# Guide');
  await f.put('.codex/docs/shared.md', '# Shared');
  await f.put('output/report.md', '# Approved report');
  const snapshot = await inventoryRepositoryPackage({ ...f, approvedOutputs: ['output/report.md'] });
  await writeRepositoryPackageSnapshot({ workspace: f.workspace, snapshot });
  const skill = snapshot.manifest.skills[0]!;
  assert.equal(skill.managedPath, 'skills/source/.codex/skills/review');
  assert.equal(skill.availability, 'partial');
  const file = snapshot.manifest.files.find(file => file.path === '.codex/skills/review/references/guide.md')!;
  assert.equal(file.managedPath, 'skills/source/.codex/skills/review/references/guide.md');
  assert.equal(await readFile(resolve(f.workspace, managedRoot, file.managedPath!), 'utf8'), '# Guide');
  assert.equal(await readFile(resolve(f.workspace, '.codex/skills/review/references/guide.md'), 'utf8'), '# Guide');
  assert.equal(await readFile(resolve(f.workspace, managedRoot, 'skills/source/.codex/docs/shared.md'), 'utf8'), '# Shared');
  await assert.rejects(readFile(resolve(f.workspace, managedRoot, 'skills/source/output/report.md')));
  assert.equal((await inventoryRepositoryPackage({ ...f, approvedOutputs: ['output/report.md'] })).manifest.snapshotHash, snapshot.manifest.snapshotHash);
});

test('managed copies deterministically replace, rename and remove only owned copies', async () => {
  const f = await fixture();
  await f.put('skills/old/SKILL.md', '# Old');
  await f.put('skills/old/references/keep.md', '# Keep');
  await writeRepositoryPackageSnapshot({ workspace: f.workspace, snapshot: await inventoryRepositoryPackage(f) });
  await f.put(`${managedRoot}/skills/source/skills/old/user.txt`, 'Unmanaged addition');
  await rename(resolve(f.workspace, 'skills/old'), resolve(f.workspace, 'skills/new'));
  await f.put('skills/new/SKILL.md', '# Updated');
  const snapshot = await inventoryRepositoryPackage(f);
  const result = await writeRepositoryPackageSnapshot({ workspace: f.workspace, snapshot });
  assert.equal(await readFile(resolve(f.workspace, managedRoot, 'skills/source/skills/new/SKILL.md'), 'utf8'), '# Updated');
  await assert.rejects(readFile(resolve(f.workspace, managedRoot, 'skills/source/skills/old/SKILL.md')));
  assert.equal(await readFile(resolve(f.workspace, managedRoot, 'skills/source/skills/old/user.txt'), 'utf8'), 'Unmanaged addition');
  await unlink(resolve(f.workspace, 'skills/new/references/keep.md'));
  await writeRepositoryPackageSnapshot({ workspace: f.workspace, snapshot: await inventoryRepositoryPackage(f) });
  await assert.rejects(readFile(resolve(f.workspace, managedRoot, 'skills/source/skills/new/references/keep.md')));
  assert.equal(result.managedCopiesPath, `${managedRoot}/skills/source`);
});

test('unmanaged destination collisions and changed owned copies are preserved and fail closed', async () => {
  const f = await fixture();
  await f.put('skills/review/SKILL.md', '# Safe');
  await f.put(`${managedRoot}/skills/source/skills/review/SKILL.md`, '# User copy');
  await assert.rejects(writeRepositoryPackageSnapshot({ workspace: f.workspace, snapshot: await inventoryRepositoryPackage(f) }), /unmanaged|conflict/);
  assert.equal(await readFile(resolve(f.workspace, managedRoot, 'skills/source/skills/review/SKILL.md'), 'utf8'), '# User copy');
  const other = await fixture();
  await other.put('skills/review/SKILL.md', '# Safe');
  await writeRepositoryPackageSnapshot({ workspace: other.workspace, snapshot: await inventoryRepositoryPackage(other) });
  await other.put(`${managedRoot}/skills/source/skills/review/SKILL.md`, '# User changed it');
  await other.put('skills/review/SKILL.md', '# Updated');
  await assert.rejects(writeRepositoryPackageSnapshot({ workspace: other.workspace, snapshot: await inventoryRepositoryPackage(other) }), /conflict/);
  assert.equal(await readFile(resolve(other.workspace, managedRoot, 'skills/source/skills/review/SKILL.md'), 'utf8'), '# User changed it');
});

test('copy journal recovers interruption at every mutation and metadata boundary', async () => {
  for (const checkpoint of ['journal_prepared', 'file_backed_up', 'file_installed', 'copies_index_written', 'manifest_written', 'cleanup_file_removed'] as const) {
    const f = await fixture();
    await f.put('skills/review/SKILL.md', '# Before');
    await writeRepositoryPackageSnapshot({ workspace: f.workspace, snapshot: await inventoryRepositoryPackage(f) });
    await f.put('skills/review/SKILL.md', '# After');
    const snapshot = await inventoryRepositoryPackage(f);
    await assert.rejects(writeRepositoryPackageSnapshot({ workspace: f.workspace, snapshot,
      onCopyCheckpoint: async point => { if (point === checkpoint) throw new Error('simulated crash'); } }), /simulated crash/);
    await writeRepositoryPackageSnapshot({ workspace: f.workspace, snapshot });
    assert.equal(await readFile(resolve(f.workspace, managedRoot, 'skills/source/skills/review/SKILL.md'), 'utf8'), '# After');
    assert.equal(JSON.parse(await readFile(resolve(f.workspace, managedRoot, 'MANIFEST.json'), 'utf8')).snapshotHash, snapshot.manifest.snapshotHash);
    await assert.rejects(readFile(resolve(f.workspace, managedRoot, 'COPY-JOURNAL.json')));
  }
});

test('journal recovery refuses intervening unmanaged files instead of overwriting them', async () => {
  const f = await fixture();
  await f.put('skills/review/SKILL.md', '# Before');
  await writeRepositoryPackageSnapshot({ workspace: f.workspace, snapshot: await inventoryRepositoryPackage(f) });
  await f.put('skills/review/SKILL.md', '# After');
  const snapshot = await inventoryRepositoryPackage(f);
  await assert.rejects(writeRepositoryPackageSnapshot({ workspace: f.workspace, snapshot,
    onCopyCheckpoint: async point => { if (point === 'file_backed_up') throw new Error('simulated crash'); } }));
  await f.put(`${managedRoot}/skills/source/skills/review/SKILL.md`, '# Intervening user file');
  await assert.rejects(writeRepositoryPackageSnapshot({ workspace: f.workspace, snapshot }), /conflict/);
  assert.equal(await readFile(resolve(f.workspace, managedRoot, 'skills/source/skills/review/SKILL.md'), 'utf8'), '# Intervening user file');
  assert.ok(await readFile(resolve(f.workspace, managedRoot, 'COPY-JOURNAL.json')));
});

test('managed mapping rejects escaping or symlinked destinations without writing outside', async () => {
  const f = await fixture();
  await f.put('skills/review/SKILL.md', '# Safe');
  const snapshot = await inventoryRepositoryPackage(f);
  const outside = await fixture();
  await mkdir(resolve(f.workspace, managedRoot, 'skills'), { recursive: true });
  await symlink(outside.workspace, resolve(f.workspace, managedRoot, 'skills/source'));
  await assert.rejects(writeRepositoryPackageSnapshot({ workspace: f.workspace, snapshot }), /symlink/);
  await assert.rejects(readFile(resolve(outside.workspace, 'skills/review/SKILL.md')));
  const tampered = structuredClone(snapshot);
  tampered.manifest.files[0]!.managedPath = '../outside/SKILL.md';
  assert.throws(() => serializeRepositoryPackageSnapshot(tampered), /integrity|mapping/);
});

test('native managed-copy fixture preserves originals and removes only journal-owned stale paths', async () => {
  const f = await fixture();
  await f.put('.claude/skills/review/SKILL.md', '# Review\n[Guide](references/guide.md)');
  await f.put('.claude/skills/review/references/guide.md', '# Guide');
  const before = await inventoryRepositoryPackage(f);
  await writeRepositoryPackageSnapshot({ workspace: f.workspace, snapshot: before });
  await f.put(`${managedRoot}/skills/source/.claude/skills/review/user.txt`, '# User');
  await f.put('.claude/skills/review/SKILL.md', '# Revision');
  await unlink(resolve(f.workspace, '.claude/skills/review/references/guide.md'));
  const after = await inventoryRepositoryPackage(f);
  await writeRepositoryPackageSnapshot({ workspace: f.workspace, snapshot: after });
  assert.equal(await readFile(resolve(f.workspace, managedRoot, 'skills/source/.claude/skills/review/SKILL.md'), 'utf8'), '# Revision');
  assert.equal(await readFile(resolve(f.workspace, '.claude/skills/review/SKILL.md'), 'utf8'), '# Revision');
  assert.equal(await readFile(resolve(f.workspace, managedRoot, 'skills/source/.claude/skills/review/user.txt'), 'utf8'), '# User');
  await assert.rejects(readFile(resolve(f.workspace, managedRoot, 'skills/source/.claude/skills/review/references/guide.md')));
  assert.equal((await inventoryRepositoryPackage(f)).manifest.snapshotHash, after.manifest.snapshotHash);
});

test('actual process exit leaves a recoverable journal and dead writer lock', async () => {
  const f = await fixture();
  await f.put('skills/review/SKILL.md', '# Before');
  await writeRepositoryPackageSnapshot({ workspace: f.workspace, snapshot: await inventoryRepositoryPackage(f) });
  await f.put('skills/review/SKILL.md', '# After');
  const script = `import { inventoryRepositoryPackage, writeRepositoryPackageSnapshot } from ${JSON.stringify(new URL('./repositoryPackage.js', import.meta.url).href)};
    const input = ${JSON.stringify({ workspace: f.workspace, organizationId: f.organizationId, workspaceId: f.workspaceId })};
    await writeRepositoryPackageSnapshot({ workspace: input.workspace, snapshot: await inventoryRepositoryPackage(input),
      onCopyCheckpoint(point) { if (point === 'file_backed_up') process.exit(86); } });`;
  const exited = spawnSync(process.execPath, ['--input-type=module', '-e', script], { timeout: 10_000, encoding: 'utf8' });
  assert.equal(exited.status, 86, exited.stderr);
  assert.ok(await readFile(resolve(f.workspace, managedRoot, 'COPY-JOURNAL.json')));
  await writeRepositoryPackageSnapshot({ workspace: f.workspace, snapshot: await inventoryRepositoryPackage(f) });
  assert.equal(await readFile(resolve(f.workspace, managedRoot, 'skills/source/skills/review/SKILL.md'), 'utf8'), '# After');
  await assert.rejects(readFile(resolve(f.workspace, managedRoot, 'COPY-LOCK.json')));
  await assert.rejects(readFile(resolve(f.workspace, managedRoot, 'COPY-JOURNAL.json')));
});

test('recovery preserves same-content intervening files without treating them as staged copies', async () => {
  const f = await fixture();
  await f.put('skills/review/SKILL.md', '# Before');
  await writeRepositoryPackageSnapshot({ workspace: f.workspace, snapshot: await inventoryRepositoryPackage(f) });
  await f.put('skills/review/SKILL.md', '# After');
  const snapshot = await inventoryRepositoryPackage(f);
  await assert.rejects(writeRepositoryPackageSnapshot({ workspace: f.workspace, snapshot,
    onCopyCheckpoint(point) { if (point === 'file_backed_up') throw new Error('interrupted'); } }));
  await f.put(`${managedRoot}/skills/source/skills/review/SKILL.md`, '# After');
  await assert.rejects(writeRepositoryPackageSnapshot({ workspace: f.workspace, snapshot }), /conflict/);
  assert.equal(await readFile(resolve(f.workspace, managedRoot, 'skills/source/skills/review/SKILL.md'), 'utf8'), '# After');
});

test('malformed ownership and journal metadata cannot authorize stale deletions or escaping writes', async () => {
  const f = await fixture();
  await f.put('skills/review/SKILL.md', '# Before');
  await writeRepositoryPackageSnapshot({ workspace: f.workspace, snapshot: await inventoryRepositoryPackage(f) });
  const indexPath = resolve(f.workspace, managedRoot, 'COPY-INDEX.json');
  const original = await readFile(indexPath, 'utf8');
  const index = JSON.parse(original);
  index.files[0].path = '../outside.md';
  await writeFile(indexPath, JSON.stringify(index));
  await assert.rejects(writeRepositoryPackageSnapshot({ workspace: f.workspace, snapshot: await inventoryRepositoryPackage(f) }), /integrity/);
  await writeFile(indexPath, original);
  await f.put('skills/review/SKILL.md', '# After');
  const snapshot = await inventoryRepositoryPackage(f);
  await assert.rejects(writeRepositoryPackageSnapshot({ workspace: f.workspace, snapshot,
    onCopyCheckpoint(point) { if (point === 'journal_prepared') throw new Error('interrupted'); } }));
  const journalPath = resolve(f.workspace, managedRoot, 'COPY-JOURNAL.json');
  const journal = JSON.parse(await readFile(journalPath, 'utf8'));
  journal.transactionId = '../../outside';
  await writeFile(journalPath, JSON.stringify(journal));
  await assert.rejects(writeRepositoryPackageSnapshot({ workspace: f.workspace, snapshot }), /integrity/);
  assert.equal(await readFile(resolve(f.workspace, managedRoot, 'skills/source/skills/review/SKILL.md'), 'utf8'), '# Before');
});

test('unmanaged metadata and stale symlink replacements are never overwritten or removed', async () => {
  const f = await fixture();
  await f.put('skills/review/SKILL.md', '# Before');
  await f.put(`${managedRoot}/MANIFEST.json`, '{"note":"unmanaged"}');
  await assert.rejects(writeRepositoryPackageSnapshot({ workspace: f.workspace, snapshot: await inventoryRepositoryPackage(f) }), /integrity|conflict/);
  assert.equal(await readFile(resolve(f.workspace, managedRoot, 'MANIFEST.json'), 'utf8'), '{"note":"unmanaged"}');
  const other = await fixture();
  await other.put('skills/review/SKILL.md', '# Before');
  await other.put('skills/review/guide.md', '# Guide');
  await writeRepositoryPackageSnapshot({ workspace: other.workspace, snapshot: await inventoryRepositoryPackage(other) });
  const copied = resolve(other.workspace, managedRoot, 'skills/source/skills/review/guide.md');
  await unlink(copied);
  await symlink(resolve(other.workspace, 'skills/review/guide.md'), copied);
  await unlink(resolve(other.workspace, 'skills/review/SKILL.md'));
  await assert.rejects(writeRepositoryPackageSnapshot({ workspace: other.workspace, snapshot: await inventoryRepositoryPackage(other) }), /symlink/);
  assert.equal(await readFile(copied, 'utf8'), '# Guide');
});

test('rehashing a malicious mapping does not bypass the exact source-to-managed mapping check', async () => {
  const f = await fixture();
  await f.put('skills/review/SKILL.md', '# Before');
  const snapshot = await inventoryRepositoryPackage(f);
  snapshot.manifest.files[0]!.managedPath = 'skills/source/elsewhere/SKILL.md';
  const { snapshotHash: _hash, snapshotId: _id, ...base } = snapshot.manifest;
  const { canonicalize } = await import('@dharma-ai-labs/agent-fabric-contracts');
  snapshot.manifest.snapshotHash = `sha256:${createHash('sha256').update(canonicalize(base)).digest('hex')}`;
  snapshot.manifest.snapshotId = `repository-package-${snapshot.manifest.snapshotHash.slice(7)}`;
  assert.throws(() => serializeRepositoryPackageSnapshot(snapshot), /mapping integrity/);
});

test('recovery detects edits to unchanged companions before committing new ownership metadata', async () => {
  const f = await fixture();
  await f.put('skills/review/SKILL.md', '# Before');
  await f.put('skills/review/guide.md', '# Guide');
  const previous = await inventoryRepositoryPackage(f);
  await writeRepositoryPackageSnapshot({ workspace: f.workspace, snapshot: previous });
  await f.put('skills/review/SKILL.md', '# After');
  const snapshot = await inventoryRepositoryPackage(f);
  await assert.rejects(writeRepositoryPackageSnapshot({ workspace: f.workspace, snapshot,
    onCopyCheckpoint(point) { if (point === 'journal_prepared') throw new Error('interrupted'); } }));
  await f.put(`${managedRoot}/skills/source/skills/review/guide.md`, '# User edit');
  await assert.rejects(writeRepositoryPackageSnapshot({ workspace: f.workspace, snapshot }), /conflict/);
  assert.equal(await readFile(resolve(f.workspace, managedRoot, 'skills/source/skills/review/guide.md'), 'utf8'), '# User edit');
  assert.equal(JSON.parse(await readFile(resolve(f.workspace, managedRoot, 'MANIFEST.json'), 'utf8')).snapshotHash, previous.manifest.snapshotHash);
});

test('interrupted removals and initial additions replay deterministically and recover to a newer snapshot', async () => {
  for (const initial of [false, true]) {
    const f = await fixture();
    await f.put('skills/review/SKILL.md', '# Review');
    await f.put('skills/review/guide.md', '# Guide');
    if (!initial) {
      await writeRepositoryPackageSnapshot({ workspace: f.workspace, snapshot: await inventoryRepositoryPackage(f) });
      await unlink(resolve(f.workspace, 'skills/review/guide.md'));
    }
    const snapshot = await inventoryRepositoryPackage(f);
    await assert.rejects(writeRepositoryPackageSnapshot({ workspace: f.workspace, snapshot,
      onCopyCheckpoint(point) { if (point === (initial ? 'file_installed' : 'file_backed_up')) throw new Error('interrupted'); } }));
    await f.put('skills/review/SKILL.md', '# Latest');
    const latest = await inventoryRepositoryPackage(f);
    await writeRepositoryPackageSnapshot({ workspace: f.workspace, snapshot: latest });
    assert.equal(await readFile(resolve(f.workspace, managedRoot, 'skills/source/skills/review/SKILL.md'), 'utf8'), '# Latest');
    if (!initial) await assert.rejects(readFile(resolve(f.workspace, managedRoot, 'skills/source/skills/review/guide.md')));
    assert.equal(JSON.parse(await readFile(resolve(f.workspace, managedRoot, 'MANIFEST.json'), 'utf8')).snapshotHash, latest.manifest.snapshotHash);
  }
});

test('later manifests remain backward-compatible with inventory-only v1 snapshots', async () => {
  const f = await fixture();
  await f.put('skills/review/SKILL.md', '# Review');
  const snapshot = await inventoryRepositoryPackage(f);
  for (const file of snapshot.manifest.files) delete file.managedPath;
  for (const skill of snapshot.manifest.skills) delete skill.managedPath;
  const { snapshotHash: _hash, snapshotId: _id, ...base } = snapshot.manifest;
  const { canonicalize } = await import('@dharma-ai-labs/agent-fabric-contracts');
  snapshot.manifest.snapshotHash = `sha256:${createHash('sha256').update(canonicalize(base)).digest('hex')}`;
  snapshot.manifest.snapshotId = `repository-package-${snapshot.manifest.snapshotHash.slice(7)}`;
  await f.put(`${managedRoot}/snapshots/${snapshot.manifest.snapshotHash.slice(7)}.json`, serializeRepositoryPackageSnapshot(snapshot));
  await f.put(`${managedRoot}/MANIFEST.json`, `${canonicalize(snapshot.manifest)}\n`);
  await writeRepositoryPackageSnapshot({ workspace: f.workspace, snapshot });
  assert.equal(await readFile(resolve(f.workspace, managedRoot, 'skills/source/skills/review/SKILL.md'), 'utf8'), '# Review');
});

test('all providers share a bounded source mirror without recursive generated skills or secret copies', async () => {
  const f = await fixture();
  for (const provider of ['.agents/skills', '.claude/skills', '.codex/skills', 'skills']) {
    await f.put(`${provider}/review/SKILL.md`, '# Review\n[Loop](references/guide.md)');
    await f.put(`${provider}/review/references/guide.md`, '[Entry](../SKILL.md)');
    await f.put(`${provider}/review/.env.local`, 'PRIVATE_VALUE=never-copy');
  }
  const snapshot = await inventoryRepositoryPackage(f);
  await writeRepositoryPackageSnapshot({ workspace: f.workspace, snapshot });
  for (const skill of snapshot.manifest.skills) {
    assert.equal(skill.availability, 'partial');
    assert.equal(await readFile(resolve(f.workspace, managedRoot, skill.managedPath!, 'SKILL.md'), 'utf8'), '# Review\n[Loop](references/guide.md)');
    await assert.rejects(readFile(resolve(f.workspace, managedRoot, skill.managedPath!, '.env.local')));
  }
  assert.equal((await inventoryRepositoryPackage(f)).manifest.snapshotHash, snapshot.manifest.snapshotHash);
});
