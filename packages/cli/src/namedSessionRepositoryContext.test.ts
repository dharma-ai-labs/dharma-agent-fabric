import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { canonicalize } from '@dharma-ai-labs/agent-fabric-contracts';
import { calculateBundleHash, type SkillBundle } from '@dharma-ai-labs/agent-fabric-skill-manager';
import type { OrganizationPolicy } from '@dharma-ai-labs/agent-fabric-policy';
import { readNamedSessionRepositoryContext } from './namedSessionPackageGate.js';

const uuid = (n: number) => `40000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const digest = (value: string) => `sha256:${createHash('sha256').update(value).digest('hex')}`;
const now = new Date('2026-10-05T01:00:00Z');
const scope = { organizationId: 'org_context_fixture', workspaceId: uuid(1), repositoryBindingId: uuid(2), repositoryAgentId: uuid(3) };

async function fixture(options: { report?: string; reportPath?: string; foreignManifest?: boolean; invalidManifest?: boolean } = {}) {
  const home = await mkdtemp(join(tmpdir(), 'dharma-context-'));
  const native = join(home, 'skills', 'dharma-agent-fabric');
  const active = join(home, 'skills', '.dharma-managed', 'workspaces', scope.workspaceId, 'active');
  const workspaceRoot = join(home, 'checkout');
  const outputPath = options.reportPath ?? 'reports/repair.md';
  const sourcePolicy = { action: 'authorize', confirmed: true, requestId: uuid(4), repositoryBindingId: scope.repositoryBindingId,
    expectedRevision: 0, allowedContentClasses: ['approved_outputs', 'repository_content', 'repository_skills'],
    approvedRepositoryPaths: ['.'], approvedOutputFolders: ['reports'], automaticValidatedPublication: true,
    retentionDays: 30, maximumFileBytes: 262144, maximumSnapshotBytes: 4194304,
    maximumDailyUploadBytes: 8388608, expiresAt: '2026-10-05T02:00:00.000Z' as string | null };
  const source = { schema: 'dharma.repository-source-authorization/v1', ...scope, revision: 1, generationId: uuid(5),
    receiptId: `repo_consent_${uuid(5)}`, policyRevision: `repository-source-${uuid(5)}`,
    policyHash: digest(canonicalize(sourcePolicy)), confirmedAt: '2026-10-05T00:00:00Z', policy: sourcePolicy };
  const policy: OrganizationPolicy = { schema: 'dharma.organization-policy/v2', organizationId: scope.organizationId,
    revision: 'local-analysis-v1', evidence: { defaultMode: 'structured', registeredWorkspaceOnly: true,
      automaticDisclosure: { mode: 'local_analysis' }, excludePaths: ['.env', '.env.*', 'private/**'],
      maximumCapsuleBytes: 1048576, maximumDailyUploadBytes: 8388608, maximumExpansionBytes: 1048576 },
    tasks: { defaultNetwork: 'deny', defaultGit: 'read_only', allowedCommands: {}, writePaths: [], requireLocalConfirmationFor: [] },
    skills: { automaticInstall: true, automaticPromotionMaxRisk: 'R2', canaryPercent: 10 }, retention: {}, budgets: {} };
  const catalog = { schema: 'dharma.repository-knowledge/v2', managedBy: 'dharma-agent-fabric',
    organizationId: scope.organizationId, repositoryAgentId: scope.repositoryAgentId,
    knowledgeBaseId: `repository-kb:${digest('fixture')}`, generation: 1, authority: 'requires_verified_release',
    policyHash: source.policyHash, sourceSnapshotHash: digest('snapshot'), sourceLocalCatalogHash: digest('local'),
    projectionHash: digest('projection'), concepts: [], unresolved: [], repoAtlas: {
      associationId: uuid(6), knowledgeBaseId: `repository-kb:${digest('fixture')}`,
      organizationId: scope.organizationId, repositoryAgentId: scope.repositoryAgentId,
      basis: 'repository_initialization', sourceWindowIds: [], analysisHash: null } };
  const documents: Record<string, string> = { 'SKILL.md': '# Signed bootstrap\n',
    'skills/source/.agents/skills/job-review/SKILL.md': '# Job review\nKeep logical jobs distinct from attempts.\n',
    [`knowledge/reports/source/${outputPath}`]: options.report ?? '# Report\nRestart-memory limitation observed.\n',
    'knowledge/CATALOG.json': `${canonicalize(catalog)}\n` };
  const manifest = { schema: 'dharma.repository-release-manifest/v1', organizationId: options.foreignManifest ? 'org_foreign' : scope.organizationId,
    repositoryAgentId: scope.repositoryAgentId, generation: 1, authority: 'requires_verified_release',
    sourceManifestHash: digest('manifest'), sourceSnapshotHash: catalog.sourceSnapshotHash, policyHash: catalog.policyHash,
    knowledgeBaseId: catalog.knowledgeBaseId, atlasAssociationId: uuid(6), sourceSkills: [],
    files: Object.entries(documents).map(([path, content]) => ({ path: `.agents/skills/dharma-agent-fabric/${path}`,
      sha256: digest(content), sizeBytes: Buffer.byteLength(content), role: path.startsWith('skills/') || path === 'SKILL.md' ? 'skill' : 'knowledge' })) };
  documents['MANIFEST.json'] = `${canonicalize(options.invalidManifest ? { ...manifest, files: [] } : manifest)}\n`;
  const tree = createHash('sha256');
  for (const [path, content] of Object.entries(documents).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
    const destination = join(active, 'dharma-agent-fabric', path);
    await mkdir(dirname(destination), { recursive: true }); await writeFile(destination, content);
    tree.update(`dharma-agent-fabric/${path}`); tree.update('\0'); tree.update(content); tree.update('\0');
    const sourcePath = path.startsWith('skills/source/') ? path.slice('skills/source/'.length)
      : path.startsWith('knowledge/reports/source/') ? path.slice('knowledge/reports/source/'.length) : null;
    if (sourcePath && !sourcePath.startsWith('../')) {
      const sourceFile = join(workspaceRoot, sourcePath);
      await mkdir(dirname(sourceFile), { recursive: true }); await writeFile(sourceFile, content);
    }
  }
  await cp(join(active, 'dharma-agent-fabric'), native, { recursive: true });
  await writeFile(join(native, '.dharma-agent-fabric.json'), '{}');
  const unsigned: Omit<SkillBundle, 'signature' | 'bundleHash'> = { schema: 'dharma.skill-bundle/v2', bundleId: uuid(7),
    organizationId: scope.organizationId, version: 'fixture-v1', operation: 'install', skills: [{ skillId: 'dharma-agent-fabric',
      version: 'v1', repository: 'https://example.invalid/synthetic.git', commit: 'a'.repeat(40),
      contentHash: `sha256:${tree.digest('hex')}`, path: '.agents/skills/dharma-agent-fabric' }], riskClass: 'R1',
    targetSelectors: { organizationAgentIds: [], deviceIds: [], workspaceIds: [scope.workspaceId], providers: ['codex'] },
    activationPolicy: 'next_task', rollbackBundleId: null, evaluationReceiptId: uuid(8), createdAt: now.toISOString() };
  const bundle = { ...unsigned, bundleHash: calculateBundleHash(unsigned), signature: 'upstream-verification-fixture' };
  await writeFile(join(active, 'AUTHORIZATION.json'), JSON.stringify(bundle));
  const input = { installation: { signedLifecycleReady: true, activeBundleId: bundle.bundleId,
    signedMarkerBundleId: bundle.bundleId, activeBundleHash: bundle.bundleHash, workspaceId: scope.workspaceId,
    nativeSkillPath: join(native, 'SKILL.md') }, sharedRepositoryReady: true, scope, workspaceRoot, now: () => now,
    loadAuthority: async () => ({ policy: structuredClone(policy), source: structuredClone(source) }) };
  return { input, policy, source, native, active, workspaceRoot, dispose: () => rm(home, { recursive: true, force: true }) };
}

test('only upstream-verified signed source skills and approved reports enter task context', async () => {
  const f = await fixture();
  try {
    const context = JSON.parse(await readNamedSessionRepositoryContext(f.input));
    assert.equal(context.authority, 'untrusted_repository_data');
    assert.equal(context.sourceReceiptId, f.source.receiptId);
    assert.deepEqual(context.files.map((file: { path: string }) => file.path), ['.agents/skills/job-review/SKILL.md', 'reports/repair.md']);
    assert.equal(context.files[1].contentDisposition, 'verified_workspace_reference');
    assert.equal(context.files[1].sha256, digest('# Report\nRestart-memory limitation observed.\n'));
    assert.equal(context.files[1].content, undefined);
    assert.equal(JSON.stringify(context).includes(f.native), false);
    assert.equal(context.acceptedLearningObservation, undefined);
  } finally { await f.dispose(); }
});

for (const failure of ['unsigned', 'foreign', 'workspace', 'subtree', 'expired', 'metadata-only', 'revoked', 'changed-policy', 'changed-bytes', 'symlink', 'excluded'] as const) {
  test(`repository context rejects ${failure} without disclosing a prompt`, async () => {
    const f = await fixture();
    try {
      if (failure === 'unsigned') f.input.installation.signedLifecycleReady = false;
      if (failure === 'foreign') f.source.organizationId = 'org_foreign';
      if (failure === 'workspace') f.input.installation.workspaceId = uuid(9);
      if (failure === 'subtree') {
        f.source.policy.approvedRepositoryPaths = ['src'];
        f.source.policyHash = digest(canonicalize(f.source.policy));
      }
      if (failure === 'expired') f.input.now = () => new Date('2026-10-05T03:00:00Z');
      if (failure === 'metadata-only') f.policy.evidence.automaticDisclosure = { mode: 'metadata_only' };
      if (failure === 'revoked') f.input.loadAuthority = async () => { throw new Error('source_authority_revoked'); };
      if (failure === 'changed-policy') {
        let calls = 0;
        f.input.loadAuthority = async () => ({ source: structuredClone(f.source), policy: { ...f.policy, revision: ++calls === 1 ? 'v1' : 'v2' } });
      }
      if (failure === 'changed-bytes') await writeFile(join(f.native, 'knowledge/reports/source/reports/repair.md'), 'Changed signed file.');
      if (failure === 'symlink') {
        const { symlink } = await import('node:fs/promises');
        const path = join(f.native, 'knowledge/reports/source/reports/repair.md');
        await rm(path); await symlink(join(f.native, 'SKILL.md'), path);
      }
      if (failure === 'excluded') f.policy.evidence.excludePaths.push('reports/**');
      await assert.rejects(readNamedSessionRepositoryContext(f.input));
    } finally { await f.dispose(); }
  });
}

for (const options of [{ report: 'password: private-fixture' }, { report: 'Read /home/unrelated/private.txt' },
  { report: 'x'.repeat(262145) }, { reportPath: 'unapproved/repair.md' }, { reportPath: '../private.md' },
  { foreignManifest: true }, { invalidManifest: true }]) {
  test(`signed but unsafe repository context remains denied: ${JSON.stringify(Object.keys(options))}`, async () => {
    const f = await fixture(options);
    try { await assert.rejects(readNamedSessionRepositoryContext(f.input)); }
    finally { await f.dispose(); }
  });
}

test('large approved reports use full hash-verified workspace references without truncation or a larger prompt', async () => {
  const report = '# Complete report\n' + 'Independent later observation.\n'.repeat(330);
  assert(Buffer.byteLength(report) > 9692);
  const f = await fixture({ report });
  try {
    const raw = await readNamedSessionRepositoryContext(f.input);
    const context = JSON.parse(raw);
    assert(Buffer.byteLength(raw) < 8000);
    assert.deepEqual(context.files[1], { path: 'reports/repair.md', role: 'knowledge', sha256: digest(report),
      sizeBytes: Buffer.byteLength(report), contentDisposition: 'verified_workspace_reference' });
    assert.equal(raw.includes('Independent later observation'), false);
  } finally { await f.dispose(); }
});

for (const failure of ['missing', 'changed', 'symlink', 'directory-symlink', 'changed-during-authority'] as const) {
  test(`workspace references reject ${failure} before context admission`, async () => {
    const f = await fixture();
    try {
      const path = join(f.workspaceRoot, 'reports/repair.md');
      if (failure === 'missing') await rm(path);
      if (failure === 'changed') await writeFile(path, 'Unsigned change.');
      if (failure === 'symlink') {
        const { symlink } = await import('node:fs/promises');
        await rm(path); await symlink(join(f.native, 'knowledge/reports/source/reports/repair.md'), path);
      }
      if (failure === 'directory-symlink') {
        const { symlink } = await import('node:fs/promises');
        await rm(dirname(path), { recursive: true });
        await symlink(join(f.native, 'knowledge/reports/source/reports'), dirname(path));
      }
      if (failure === 'changed-during-authority') {
        let calls = 0;
        f.input.loadAuthority = async () => {
          if (++calls === 2) await writeFile(path, 'Changed during admission.');
          return { policy: structuredClone(f.policy), source: structuredClone(f.source) };
        };
      }
      await assert.rejects(readNamedSessionRepositoryContext(f.input));
    } finally { await f.dispose(); }
  });
}
