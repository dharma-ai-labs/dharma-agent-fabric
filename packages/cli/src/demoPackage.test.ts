import assert from 'node:assert/strict';
import { createHash, createPublicKey, generateKeyPairSync, verify } from 'node:crypto';
import { mkdir, mkdtemp, readFile, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { canonicalize, signCanonicalObject } from '@dharma-ai-labs/agent-fabric-contracts';
import { loadOrCreateDeviceIdentity, type SecureSecretStore } from '@dharma-ai-labs/agent-fabric-relay-client';
import { calculateBundleHash } from '@dharma-ai-labs/agent-fabric-skill-manager';
import { scopePath } from './demoEnrollment.js';
import { demoRepositoryPackage } from './demoPackage.js';
import { demoDeviceAndPackageStatus } from './demoStatus.js';
import { planRepositoryPackageTransferV2, type RepositoryTransferFile } from './repositoryPackageTransfer.js';

const organizationId = 'org_fixture';
const repositoryId = '10000000-0000-4000-8000-000000000001';
const deviceId = '30000000-0000-4000-8000-000000000001';
const workspaceId = '40000000-0000-4000-8000-000000000001';
const installationId = '50000000-0000-4000-8000-000000000001';
const normalizedRepository = 'github.com/example/private';
const hqUrl = 'https://dharma.example';
const digest = (value: string | Buffer) => `sha256:${createHash('sha256').update(value).digest('hex')}`;

function signedPackage(policyHash: string) {
  const signer = generateKeyPairSync('ed25519');
  const serverPublicKeyEd25519 = (signer.publicKey.export({ format: 'jwk' }) as { x?: string }).x!;
  const issuedAt = new Date(Date.now() - 60_000).toISOString();
  const expiresAt = new Date(Date.now() + 24 * 60 * 60_000).toISOString();
  const keyVersion = 'projects/test/locations/global/keyRings/demo/cryptoKeys/signing/cryptoKeyVersions/1';
  const keysetBase = { schema: 'dharma.server-signing-keyset/v1' as const,
    organizationId, generation: 1, keys: [{ keyVersion, publicKeyEd25519: serverPublicKeyEd25519,
      status: 'active' as const, notBefore: issuedAt, notAfter: expiresAt }],
    signedByKeyVersion: keyVersion, issuedAt, expiresAt };
  const keyset = { ...keysetBase, signature: signCanonicalObject(keysetBase, signer.privateKey) };
  const pin = (letter: string) => `sha256:${letter.repeat(64)}`;
  const root = '.agents/skills/dharma-agent-fabric/';
  const catalogPath = `${root}knowledge/CATALOG.json`;
  const manifestPath = `${root}MANIFEST.json`;
  const promptPath = '.dharma/onboarding-prompt.md';
  const knowledgeBaseId = `repository-kb:${digest(canonicalize({
    schema: 'dharma.repository-knowledge-identity/v1', organizationId, repositoryAgentId: repositoryId,
  }))}`;
  const projection = { schema: 'dharma.repository-concept-projection/v1',
    organizationId, repositoryAgentId: repositoryId, policyHash, snapshotHash: pin('b'),
    authority: 'unsigned_projection', publicationAuthorized: false, concepts: [],
    acceptedProposalHashes: [], unresolved: [] };
  const catalog = { schema: 'dharma.repository-knowledge/v2', managedBy: 'dharma-agent-fabric',
    organizationId, repositoryAgentId: repositoryId, knowledgeBaseId, generation: 1,
    authority: 'requires_verified_release', policyHash, sourceSnapshotHash: pin('b'),
    sourceLocalCatalogHash: pin('c'), projectionHash: digest(canonicalize(projection)),
    repoAtlas: { associationId: '244b5a90-3b7a-4a81-9503-c9f49be790c3',
      knowledgeBaseId, organizationId, repositoryAgentId: repositoryId,
      basis: 'repository_initialization', sourceWindowIds: [], analysisHash: null },
    concepts: [], unresolved: [] };
  const file = (path: string, text: string): RepositoryTransferFile => ({ path,
    contentBase64: Buffer.from(text).toString('base64'), sha256: digest(text),
    sizeBytes: Buffer.byteLength(text) });
  const copies = [
    { ...file(`${root}SKILL.md`, '# Repository Agent Fabric\n'), role: 'skill' },
    { ...file(`${root}skills/source/.claude/skills/verifier/SKILL.md`, '# Verifier\n'), role: 'skill' },
    { ...file(promptPath, 'Use the organization repository package.\n'), role: 'onboarding_prompt' },
    { ...file(catalogPath, `${canonicalize(catalog)}\n`), role: 'knowledge' },
  ];
  const entryPath = '.claude/skills/verifier/SKILL.md';
  const manifest = { schema: 'dharma.repository-release-manifest/v1', organizationId,
    repositoryAgentId: repositoryId, generation: 1, authority: 'requires_verified_release',
    sourceManifestHash: pin('e'), sourceSnapshotHash: pin('b'), policyHash,
    knowledgeBaseId, atlasAssociationId: catalog.repoAtlas.associationId,
    sourceSkills: [{ path: '.claude/skills/verifier', providerRoot: '.claude/skills',
      entryPath, contentHash: digest(canonicalize([{ path: entryPath, sha256: copies[1]!.sha256 }])),
      availability: 'available', filePaths: [entryPath],
      observation: { state: 'not_observed', authority: 'caller_supplied_not_runtime_verified', references: [] } }],
    files: copies.map(({ contentBase64: _content, ...row }) => row)
      .sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0) };
  const files = [...copies.map(({ role: _role, ...row }) => row),
    file(manifestPath, `${canonicalize(manifest)}\n`)];
  const commit = 'a'.repeat(40);
  const releaseId = '90000000-0000-4000-8000-000000000001';
  const bundleId = 'a0000000-0000-4000-8000-000000000001';
  const transfer = planRepositoryPackageTransferV2({ files, organizationId,
    repositoryBindingId: repositoryId, repositoryAgentId: repositoryId,
    releaseId, generation: 1, gitCommit: commit });
  const tree = createHash('sha256');
  for (const row of files.filter(row => row.path.startsWith(root))
    .sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)) {
    tree.update(`dharma-agent-fabric/${row.path.slice(root.length)}`).update('\0')
      .update(Buffer.from(row.contentBase64, 'base64')).update('\0');
  }
  const bundleBase = { schema: 'dharma.skill-bundle/v2' as const, bundleId,
    organizationId, version: '1.0.0', operation: 'install' as const,
    skills: [{ skillId: 'dharma-agent-fabric', version: '1.0.0',
      repository: 'https://github.com/example/private.git', commit,
      contentHash: `sha256:${tree.digest('hex')}`, path: root.slice(0, -1) }],
    riskClass: 'R1' as const, targetSelectors: { organizationAgentIds: [repositoryId],
      deviceIds: [], workspaceIds: [], providers: [] }, activationPolicy: 'next_session' as const,
    rollbackBundleId: null, evaluationReceiptId: 'fixture:evaluated', createdAt: issuedAt,
    expiresAt: null };
  const bundleUnsigned = { ...bundleBase, bundleHash: calculateBundleHash(bundleBase) };
  const bundle = { ...bundleUnsigned, signature: signCanonicalObject(bundleUnsigned, signer.privateKey) };
  const descriptor = { schema: 'dharma.repository-package-delivery/v1',
    delivery: 'authenticated_chunks', transferSchema: 'dharma.repository-package-transfer/v2',
    organizationId, repositoryBindingId: repositoryId, repositoryAgentId: repositoryId,
    releaseId, generation: 1, gitCommit: commit, policyHash, sourceSnapshotHash: pin('b'),
    sourceManifestHash: pin('e'), sourceLocalCatalogHash: pin('c'),
    catalogHash: files.find(row => row.path === catalogPath)!.sha256,
    manifestHash: files.find(row => row.path === manifestPath)!.sha256,
    transferIndexHash: transfer.indexHash, fileCount: files.length,
    totalBytes: transfer.index.totalBytes, maximumFileBytes: 262_144,
    createdAt: issuedAt, expiresAt };
  const envelopeUnsigned = { schema: 'dharma.repository-package-envelope/v1',
    bundleId, bundleHash: bundle.bundleHash, descriptor };
  const envelope = { ...envelopeUnsigned,
    signature: signCanonicalObject(envelopeUnsigned, signer.privateKey) };
  return { serverPublicKeyEd25519, keyset, releaseId, bundleId, bundle,
    envelope, index: transfer.index, chunks: transfer.chunks };
}

function memoryStore(): SecureSecretStore {
  const values = new Map<string, string>();
  return { backend: 'linux-secret-service',
    async get(account) { return values.get(account) || null; },
    async put(account, value) { values.set(account, value); },
    async delete(account) { values.delete(account); } };
}

async function fixture(options: { loseFirstScope?: boolean; sourcePolicy?: boolean;
  loseFirstUpload?: boolean; packagePublished?: boolean; candidatePublished?: boolean;
  activePackage?: boolean | 'valid'; loseFirstAck?: boolean; automaticPublication?: boolean;
  remoteSkill?: boolean; corruptSource?: boolean } = {}) {
  const stateRoot = await mkdtemp(resolve(tmpdir(), 'dharma-demo-package-'));
  const workspace = await mkdtemp(resolve(tmpdir(), 'dharma-demo-source-'));
  await writeFile(resolve(workspace, 'README.md'), 'Approved source evidence.\n');
  const store = memoryStore();
  const scope = { hqUrl, organizationId, repositoryId, normalizedRepository,
    installationId, stateRoot };
  const identity = await loadOrCreateDeviceIdentity({ hqUrl,
    organizationId: `${organizationId}:${repositoryId}`, installationId, store });
  const configPath = scopePath(scope, hqUrl);
  let sequence = 0;
  let lost = false;
  let uploadLost = false;
  const uploads: Array<Record<string, unknown>> = [];
  const acknowledgements: Array<Record<string, unknown>> = [];
  const generationId = '60000000-0000-4000-8000-000000000001';
  const policy = { action: 'authorize', confirmed: true,
    requestId: '70000000-0000-4000-8000-000000000001', repositoryBindingId: repositoryId,
    expectedRevision: 0, allowedContentClasses: ['approved_outputs', 'repository_content', 'repository_skills'],
    approvedRepositoryPaths: options.remoteSkill
      ? ['.claude/skills/verifier/SKILL.md', 'README.md'] : ['README.md'], approvedOutputFolders: [],
    automaticValidatedPublication: options.automaticPublication !== false,
    retentionDays: 30, maximumFileBytes: 262144, maximumSnapshotBytes: 4194304,
    maximumDailyUploadBytes: 8388608, expiresAt: null };
  const sourceAuthorization = { schema: 'dharma.repository-source-authorization/v1',
    organizationId, workspaceId, repositoryBindingId: repositoryId,
    repositoryAgentId: repositoryId, revision: 1, generationId,
    receiptId: `repo_consent_${generationId}`,
    policyRevision: `repository-source-${generationId}`,
    policyHash: `sha256:${createHash('sha256').update(canonicalize(policy)).digest('hex')}`,
    confirmedAt: new Date().toISOString(), policy };
  let currentAuthorization = sourceAuthorization;
  let releaseAuthorization: typeof sourceAuthorization | null = sourceAuthorization;
  const advancePolicy = (paths: string[]) => {
    const next = { ...policy, requestId: '70000000-0000-4000-8000-000000000002',
      expectedRevision: 1, approvedRepositoryPaths: paths };
    currentAuthorization = { ...sourceAuthorization, revision: 2,
      generationId: '60000000-0000-4000-8000-000000000002',
      receiptId: 'repo_consent_60000000-0000-4000-8000-000000000002',
      policyRevision: 'repository-source-60000000-0000-4000-8000-000000000002',
      policyHash: digest(canonicalize(next)), policy: next };
  };
  const release = options.activePackage === 'valid' ? signedPackage(sourceAuthorization.policyHash) : null;
  const sourceFiles = [{ path: 'README.md', sha256: digest('Approved source evidence.\n'),
    sizeBytes: Buffer.byteLength('Approved source evidence.\n'), role: 'repository_content' },
  ...(options.remoteSkill ? [{ path: '.claude/skills/verifier/SKILL.md',
    managedPath: 'skills/source/.claude/skills/verifier/SKILL.md',
    sha256: digest('# Verifier\n'), sizeBytes: Buffer.byteLength('# Verifier\n'), role: 'skill' }] : [])]
    .sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  const sourceSkills = options.remoteSkill ? [{ path: '.claude/skills/verifier',
    providerRoot: '.claude/skills', entryPath: '.claude/skills/verifier/SKILL.md',
    contentHash: digest(canonicalize([{ path: '.claude/skills/verifier/SKILL.md', sha256: digest('# Verifier\n') }])),
    availability: 'available', filePaths: ['.claude/skills/verifier/SKILL.md'],
    observation: { state: 'not_observed', authority: 'caller_supplied_not_runtime_verified', references: [] } }] : [];
  const publishedSourceFingerprint = digest(canonicalize({ organizationId,
    repositoryBindingId: repositoryId, repositoryAgentId: repositoryId,
    generationId, policyHash: sourceAuthorization.policyHash, files: sourceFiles, skills: sourceSkills }));
  await mkdir(dirname(configPath), { recursive: true });
  await writeFile(configPath, JSON.stringify({ schema: 'dharma.demo-device/v1',
    ...scope, deviceId, publicKeyEd25519: identity.publicKeyEd25519,
    signedReady: true, nextSequence: 1,
    ...(release ? { serverPublicKeyEd25519: release.serverPublicKeyEd25519,
      serverSigningKeyset: release.keyset } : {}) }), { mode: 0o600 });
  const fetcher: typeof fetch = async (resource, init) => {
    const url = new URL(String(resource));
    const headers = new Headers(init?.headers);
    const body = String(init?.body || '');
    const requestSequence = Number(headers.get('x-dharma-sequence'));
    const signedPayload = Buffer.from(JSON.stringify({
      bodyHash: `sha256:${createHash('sha256').update(body).digest('hex')}`,
      deviceId, messageId: headers.get('x-dharma-message-id'),
      method: init?.method || 'GET', nonce: headers.get('x-dharma-nonce'),
      organizationId, pathname: `${url.pathname}${url.search}`,
      sequence: requestSequence, sessionId: headers.get('x-dharma-session-id'),
      timestamp: headers.get('x-dharma-timestamp'),
    }));
    assert.equal(verify(null, signedPayload,
      createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: identity.publicKeyEd25519 }, format: 'jwk' }),
      Buffer.from(headers.get('x-dharma-signature')!, 'base64url')), true);
    if (requestSequence !== sequence + 1) return new Response(JSON.stringify({ ok: false,
      error: { code: 'demo_fabric_sequence_out_of_order' } }), { status: 409 });
    sequence = requestSequence;
    if (url.pathname.endsWith('/status')) return Response.json({ ok: true,
      organizationId, repositoryId, deviceId, normalizedRepository });
    if (url.pathname.endsWith('/package-scope')) {
      if (options.loseFirstScope && !lost) { lost = true; throw new Error('connection lost after scope'); }
      return Response.json({ ok: true, organizationId, repositoryId,
        repositoryAgentId: repositoryId, normalizedRepository, workspaceId,
        sourceAuthorization: options.sourcePolicy ? currentAuthorization : null,
        activeReleaseSourceAuthorization: options.packagePublished ? releaseAuthorization : null,
        repositoryPackageState: options.packagePublished ? 'published' : 'not_connected',
        activeReleaseId: options.packagePublished ? release?.releaseId
          ?? '90000000-0000-4000-8000-000000000001' : null,
        publishedSourceFingerprint: options.packagePublished ? publishedSourceFingerprint : null });
    }
    if (url.pathname.endsWith('/source-inventory')) return Response.json({ ok: true,
      organizationId, repositoryBindingId: repositoryId, repositoryAgentId: repositoryId,
      policyGenerationId: currentAuthorization.generationId, workspaceBaseline: null,
      source: { candidateId: '80000000-0000-4000-8000-000000000002', workspaceId,
        sourceSnapshotHash: digest('source snapshot'), sourceManifestHash: digest('source manifest'),
        sourceFingerprint: publishedSourceFingerprint, files: sourceFiles, skills: sourceSkills } });
    if (url.pathname.includes('/source-inventory/') && url.pathname.includes('/blobs/')) {
      const path = url.searchParams.get('path');
      const file = sourceFiles.find(row => row.path === path)!;
      return Response.json({ ok: true, organizationId, repositoryBindingId: repositoryId,
        repositoryAgentId: repositoryId, candidateId: '80000000-0000-4000-8000-000000000002',
        sourceSnapshotHash: digest('source snapshot'), sourceFingerprint: publishedSourceFingerprint,
        ...file, contentBase64: Buffer.from(options.corruptSource ? 'corrupt'
          : path === 'README.md' ? 'Approved source evidence.\n' : '# Verifier\n').toString('base64') });
    }
    if (url.pathname.endsWith('/packages/active')) return Response.json({ ok: true,
      organizationId, repositoryId, repositoryPackageState: options.activePackage ? 'published' : 'pending',
      package: release ? { releaseId: release.releaseId, envelope: release.envelope,
        bundle: release.bundle, index: release.index } : options.activePackage ? {
        releaseId: '90000000-0000-4000-8000-000000000001',
        envelope: { descriptor: { policyHash: sourceAuthorization.policyHash,
          organizationId, repositoryBindingId: repositoryId,
          releaseId: '90000000-0000-4000-8000-000000000001' } },
        bundle: {}, index: {},
      } : null });
    if (release && url.pathname.includes('/packages/') && url.pathname.includes('/chunks/')) {
      const parts = url.pathname.split('/');
      const fileIndex = Number(parts.at(-2));
      const chunkIndex = Number(parts.at(-1));
      const chunk = release.chunks.find(row => row.fileIndex === fileIndex && row.chunkIndex === chunkIndex);
      assert.ok(chunk);
      return Response.json({ ok: true, organizationId, repositoryId,
        releaseId: release.releaseId, chunk });
    }
    if (release && url.pathname.endsWith('/install-receipts')) {
      const receipt = (JSON.parse(body) as { receipt: Record<string, unknown> }).receipt;
      assert.equal(receipt.workspaceId, repositoryId);
      assert.equal(receipt.bundleId, release.bundleId);
      assert.equal(receipt.deviceId, deviceId);
      acknowledgements.push(receipt);
      if (options.loseFirstAck && acknowledgements.length === 1) {
        throw new Error('connection lost after installation acknowledgement');
      }
      return Response.json({ ok: true, organizationId, repositoryId,
        releaseId: release.releaseId, bundleId: release.bundleId,
        receiptHash: receipt.receiptHash, duplicate: acknowledgements.length > 1 });
    }
    if (url.pathname.endsWith('/package-candidates')) {
      const upload = JSON.parse(body) as Record<string, unknown>;
      assert.equal(upload.repositoryBindingId, repositoryId);
      uploads.push(upload);
      if (options.loseFirstUpload && !uploadLost) {
        uploadLost = true;
        throw new Error('connection lost after upload');
      }
      return Response.json({ ok: true, organizationId, repositoryId,
        candidate: { candidateId: '80000000-0000-4000-8000-000000000001',
          operationId: upload.operationId,
          snapshotHash: upload.sourceSnapshotHash,
          state: options.candidatePublished ? 'published' : 'accepted',
          releaseId: options.candidatePublished
            ? '90000000-0000-4000-8000-000000000001' : null } },
      { status: options.candidatePublished ? 200 : 202 });
    }
    if (url.pathname.includes('/package-candidates/')) {
      const upload = uploads.at(-1)!;
      return Response.json({ ok: true, organizationId, repositoryId,
        candidate: { candidateId: '80000000-0000-4000-8000-000000000001',
          operationId: upload.operationId, snapshotHash: upload.sourceSnapshotHash,
          state: 'accepted', releaseId: null } });
    }
    throw new Error(`Unexpected package route: ${url.pathname}`);
  };
  return { scope, workspace, store, fetcher, configPath, uploads, acknowledgements, release,
    advancePolicy, publishedSourceFingerprint, hideReleaseAuthorization: () => { releaseAuthorization = null; },
    get sequence() { return sequence; } };
}

test('signed Demo package status reports no candidate and does not invent a release', async () => {
  const f = await fixture();
  const result = await demoRepositoryPackage({ scope: f.scope, workspace: f.scope.stateRoot,
    statusOnly: true }, { store: f.store, fetcher: f.fetcher });
  assert.equal(result.stage, 'demo_repository_package_status');
  assert.equal(result.repositoryPackageState, 'not_connected');
  assert.equal(result.candidate, null);
  assert.equal((JSON.parse(await readFile(f.configPath, 'utf8')) as { nextSequence: number }).nextSequence,
    f.sequence + 1);
});

test('signed Demo package status distinguishes a published release from local installation', async () => {
  const f = await fixture({ sourcePolicy: true, packagePublished: true, activePackage: 'valid' });
  const result = await demoRepositoryPackage({ scope: f.scope, workspace: f.workspace,
    statusOnly: true }, { store: f.store, fetcher: f.fetcher });
  assert.equal(result.repositoryPackageState, 'published');
  assert.equal(result.activationState, 'signed_delivery_pending');
  assert.equal(result.ready, false);
  assert.equal(f.acknowledgements.length, 0);
});

test('Demo status reports a published repository without claiming local installation', async () => {
  const f = await fixture({ sourcePolicy: true, packagePublished: true, activePackage: 'valid' });
  const result = await demoDeviceAndPackageStatus(f.scope, f.workspace,
    { store: f.store, fetcher: f.fetcher });
  assert.equal(result.stage, 'device_signed_ready');
  assert.equal(result.repositoryPackageState, 'published');
  assert.equal(result.repositoryPackageStateSource, 'authenticated_server_scope');
  assert.equal(result.packageInstallationCheck, 'not_run');
  assert.equal(result.deviceId, deviceId);
  assert.equal(f.acknowledgements.length, 0);
});

test('Demo status rejects a package scope from another repository', async () => {
  const f = await fixture({ sourcePolicy: true });
  const fetcher: typeof fetch = async (resource, init) => {
    const response = await f.fetcher(resource, init);
    if (!new URL(String(resource)).pathname.endsWith('/package-scope')) return response;
    return Response.json({ ...await response.json() as Record<string, unknown>,
      repositoryId: '20000000-0000-4000-8000-000000000002' });
  };
  await assert.rejects(demoDeviceAndPackageStatus(f.scope, f.workspace,
    { store: f.store, fetcher }), /does not match this enrolled repository/);
});

test('Demo status rejects an unknown repository package state', async () => {
  const f = await fixture({ sourcePolicy: true });
  const fetcher: typeof fetch = async (resource, init) => {
    const response = await f.fetcher(resource, init);
    if (!new URL(String(resource)).pathname.endsWith('/package-scope')) return response;
    return Response.json({ ...await response.json() as Record<string, unknown>,
      repositoryPackageState: 'unexpected' });
  };
  await assert.rejects(demoDeviceAndPackageStatus(f.scope, f.workspace,
    { store: f.store, fetcher }), /package state is invalid/);
});

test('lost acknowledgement response retries the identical anchored installation receipt', async () => {
  const f = await fixture({ sourcePolicy: true, packagePublished: true,
    activePackage: 'valid', loseFirstAck: true });
  const input = { scope: f.scope, workspace: f.workspace, provider: 'codex' as const,
    nativeSkillDirectory: resolve(f.workspace, '.agents/skills') };
  await assert.rejects(demoRepositoryPackage(input, { store: f.store, fetcher: f.fetcher }),
    /connection lost after installation acknowledgement/);
  assert.equal(f.acknowledgements.length, 1);
  const recovered = await demoRepositoryPackage(input, { store: f.store, fetcher: f.fetcher });
  assert.equal(recovered.installed?.alreadyInstalled, true);
  assert.equal(recovered.acknowledgement?.duplicate, true);
  assert.deepEqual(f.acknowledgements[0], f.acknowledgements[1]);
});

test('lost scope response reconciles the consumed sequence on retry', async () => {
  const f = await fixture({ loseFirstScope: true });
  const input = { scope: f.scope, workspace: f.scope.stateRoot, statusOnly: true };
  await assert.rejects(demoRepositoryPackage(input, { store: f.store, fetcher: f.fetcher }),
    /connection lost after scope/);
  const result = await demoRepositoryPackage(input,
    { store: f.store, fetcher: f.fetcher });
  assert.equal(result.repositoryPackageState, 'not_connected');
  assert.equal((JSON.parse(await readFile(f.configPath, 'utf8')) as { nextSequence: number }).nextSequence,
    f.sequence + 1);
});

test('approved repository inventory uploads once logically after a lost response', async () => {
  const f = await fixture({ sourcePolicy: true, loseFirstUpload: true });
  const input = { scope: f.scope, workspace: f.workspace };
  await assert.rejects(demoRepositoryPackage(input,
    { store: f.store, fetcher: f.fetcher }), /connection lost after upload/);
  const skillPath = resolve(f.workspace, '.agents/skills/dharma-agent-fabric/SKILL.md');
  await unlink(skillPath);
  const result = await demoRepositoryPackage(input,
    { store: f.store, fetcher: f.fetcher });
  assert.equal(result.stage, 'demo_repository_package_candidate');
  assert.equal(result.candidate?.state, 'accepted');
  assert.equal(result.ready, false);
  assert.equal(f.uploads.length, 2);
  assert.equal(f.uploads[0]!.operationId, f.uploads[1]!.operationId);
  assert.match(await readFile(skillPath, 'utf8'), /Agent Fabric: repository onboarding/);
  const snapshotHash = String(f.uploads[0]!.sourceSnapshotHash);
  const snapshotPath = resolve(f.workspace, '.dharma/repository-source/snapshots',
    `${snapshotHash.slice(7)}.json`);
  const snapshot = await readFile(snapshotPath, 'utf8');
  const stored = JSON.parse(snapshot) as { manifest: { snapshotHash: string;
    files: Array<{ path: string; sha256: string }> };
    blobs: Array<{ sha256: string; contentBase64: string }> };
  assert.equal(stored.manifest.snapshotHash, snapshotHash);
  const source = stored.manifest.files.find(file => file.path === 'README.md');
  assert.ok(source);
  const blob = stored.blobs.find(row => row.sha256 === source.sha256);
  assert.ok(blob);
  assert.equal(Buffer.from(blob.contentBase64, 'base64').toString('utf8'), 'Approved source evidence.\n');
  assert.equal(snapshot.includes('grant'), false);
  const outbox = resolve(f.scope.stateRoot, 'demo-repository-candidates',
    organizationId, repositoryId, `${workspaceId}.json`);
  const bytes = await readFile(outbox, 'utf8');
  assert.equal(bytes.includes('Approved source evidence.'), false);
  assert.equal(bytes.includes('grant'), false);
});

test('a published shared repository waits for signed delivery without submitting a second candidate', async () => {
  const f = await fixture({ sourcePolicy: true, packagePublished: true });
  const result = await demoRepositoryPackage({ scope: f.scope, workspace: f.workspace },
    { store: f.store, fetcher: f.fetcher });
  assert.equal(result.stage, 'demo_repository_package_delivery_pending');
  assert.equal(result.ready, false);
  assert.equal(result.activationState, 'signed_delivery_pending');
  assert.equal(f.uploads.length, 0);
  await assert.rejects(readFile(resolve(f.workspace, '.agents/skills/dharma-agent-fabric/SKILL.md')));
});

test('a published package cannot install without the browser-pinned signing anchor', async () => {
  const f = await fixture({ sourcePolicy: true, packagePublished: true, activePackage: true });
  await assert.rejects(demoRepositoryPackage({ scope: f.scope, workspace: f.workspace },
    { store: f.store, fetcher: f.fetcher }), /signing trust is not pinned/i);
  assert.equal(f.uploads.length, 0);
  await assert.rejects(readFile(resolve(f.workspace, '.agents/skills/dharma-agent-fabric/SKILL.md')));
});

test('a published signed package installs once under the scoped provider and reuses its protected receipt', async () => {
  const f = await fixture({ sourcePolicy: true, packagePublished: true, activePackage: 'valid' });
  const nativeSkillDirectory = resolve(f.workspace, '.agents/skills');
  const input = { scope: f.scope, workspace: f.workspace, provider: 'codex' as const,
    nativeSkillDirectory };
  const first = await demoRepositoryPackage(input, { store: f.store, fetcher: f.fetcher });
  assert.equal(first.stage, 'demo_repository_package_installed');
  assert.equal(first.ready, false);
  assert.equal(first.activationState, 'signed_package_active');
  assert.equal(first.sourceSync?.state, 'seeded');
  assert.equal(first.installed?.alreadyInstalled, false);
  assert.equal(first.installed?.releaseId, f.release?.releaseId);
  assert.equal(first.installed?.bundleId, f.release?.bundleId);
  assert.equal(await readFile(resolve(nativeSkillDirectory, 'dharma-agent-fabric/SKILL.md'), 'utf8'),
    '# Repository Agent Fabric\n');
  assert.equal(f.uploads.length, 0);
  assert.equal(f.acknowledgements.length, 1);
  const second = await demoRepositoryPackage(input, { store: f.store, fetcher: f.fetcher });
  assert.equal(second.stage, 'demo_repository_package_installed');
  assert.equal(second.installed?.alreadyInstalled, true);
  assert.equal(second.installed?.receiptHash, first.installed?.receiptHash);
  assert.equal(second.acknowledgement?.duplicate, true);
  assert.equal(second.sourceSync?.state, 'unchanged');
  assert.equal(f.acknowledgements.length, 2);
});

test('a stable approved source edit submits one scoped repository update candidate', async () => {
  const f = await fixture({ sourcePolicy: true, packagePublished: true, activePackage: 'valid' });
  const input = { scope: f.scope, workspace: f.workspace, provider: 'codex' as const,
    nativeSkillDirectory: resolve(f.workspace, '.agents/skills') };
  let now = 1_000;
  const deps = { store: f.store, fetcher: f.fetcher, now: () => now };
  assert.equal((await demoRepositoryPackage(input, deps)).sourceSync?.state, 'seeded');
  await writeFile(resolve(f.workspace, 'README.md'), 'Approved source revision.\n');
  now = 2_000;
  assert.equal((await demoRepositoryPackage(input, deps)).sourceSync?.state, 'debouncing');
  assert.equal(f.uploads.length, 0);
  now = 17_000;
  const updated = await demoRepositoryPackage(input, deps);
  assert.equal(updated.sourceSync?.state, 'submitted');
  assert.equal(updated.sourceSync?.candidate?.state, 'accepted');
  assert.equal(f.uploads.length, 1);
  assert.deepEqual(f.uploads[0]!.consolidation, { mode: 'repository_update',
    includeApprovedOutputs: true, requireAtlasAssociation: true,
    expectedLatestSourceFingerprint: f.publishedSourceFingerprint });
  assert.equal(f.uploads[0]!.repositoryBindingId, repositoryId);
});

test('an unrelated Demo edit retains the teammate source skill, without writing customer source files', async () => {
  const f = await fixture({ sourcePolicy: true, packagePublished: true, activePackage: 'valid', remoteSkill: true });
  const input = { scope: f.scope, workspace: f.workspace };
  let now = 1000;
  const deps = { store: f.store, fetcher: f.fetcher, now: () => now };
  await demoRepositoryPackage(input, deps);
  await writeFile(resolve(f.workspace, 'README.md'), 'Approved source revision.\n');
  now = 2000;
  await demoRepositoryPackage(input, deps);
  now = 17000;
  await demoRepositoryPackage(input, deps);
  assert.equal(f.uploads.length, 1);
  const upload = f.uploads[0] as { snapshot: { manifest: { files: Array<{ path: string }> } } };
  assert.ok(upload.snapshot.manifest.files.some(file => file.path === '.claude/skills/verifier/SKILL.md'),
    'candidate omitted a verified remote-only skill');
  now = 32000;
  assert.equal((await demoRepositoryPackage(input, deps)).sourceSync?.state, 'submitted');
  assert.equal(f.uploads.length, 1, 'pending delivery must not dispatch a second candidate');
  await assert.rejects(readFile(resolve(f.workspace, '.claude/skills/verifier/SKILL.md')), { code: 'ENOENT' });
});

test('corrupted remote Demo source cannot authorize an update', async () => {
  const f = await fixture({ sourcePolicy: true, packagePublished: true, activePackage: 'valid',
    remoteSkill: true, corruptSource: true });
  const input = { scope: f.scope, workspace: f.workspace };
  let now = 1000;
  const deps = { store: f.store, fetcher: f.fetcher, now: () => now };
  await demoRepositoryPackage(input, deps);
  await writeFile(resolve(f.workspace, 'README.md'), 'Approved source revision.\n');
  now = 2000;
  await demoRepositoryPackage(input, deps);
  now = 17000;
  await assert.rejects(demoRepositoryPackage(input, deps), /blob integrity/);
  assert.equal(f.uploads.length, 0);
});

test('lost reconciled Demo upload retries the same snapshot and operation after restart', async () => {
  const f = await fixture({ sourcePolicy: true, packagePublished: true, activePackage: 'valid',
    remoteSkill: true, loseFirstUpload: true });
  const input = { scope: f.scope, workspace: f.workspace };
  let now = 1000;
  const deps = { store: f.store, fetcher: f.fetcher, now: () => now };
  await demoRepositoryPackage(input, deps);
  await writeFile(resolve(f.workspace, 'README.md'), 'Approved source revision.\n');
  now = 2000;
  await demoRepositoryPackage(input, deps);
  now = 17000;
  await assert.rejects(demoRepositoryPackage(input, deps), /connection lost after upload/);
  await writeFile(resolve(f.workspace, 'README.md'), 'Another revision while delivery is pending.\n');
  now = 32000;
  assert.equal((await demoRepositoryPackage(input, deps)).sourceSync?.state, 'submitted');
  assert.equal(f.uploads.length, 2);
  assert.equal(f.uploads[0]?.operationId, f.uploads[1]?.operationId);
  assert.deepEqual(f.uploads[0]?.snapshot, f.uploads[1]?.snapshot);
});

test('an expanded policy publishes a replacement without installing the stale signed release', async () => {
  const f = await fixture({ sourcePolicy: true, packagePublished: true, activePackage: 'valid' });
  const input = { scope: f.scope, workspace: f.workspace, provider: 'codex' as const,
    nativeSkillDirectory: resolve(f.workspace, '.agents/skills') };
  let now = 1_000;
  const deps = { store: f.store, fetcher: f.fetcher, now: () => now };
  await demoRepositoryPackage(input, deps);
  assert.equal(f.acknowledgements.length, 1);
  f.advancePolicy(['.agents/skills/utility-bill-review/SKILL.md', 'README.md']);
  await mkdir(resolve(f.workspace, '.agents/skills/utility-bill-review'), { recursive: true });
  await writeFile(resolve(f.workspace, '.agents/skills/utility-bill-review/SKILL.md'),
    '---\nname: utility-bill-review\ndescription: Review utility bills.\n---\n');
  now = 2_000;
  const first = await demoRepositoryPackage(input, deps);
  assert.equal(first.stage, 'demo_repository_package_policy_transition');
  assert.equal(first.sourceSync?.state, 'debouncing');
  assert.equal(first.ready, false);
  assert.equal(f.acknowledgements.length, 1);
  now = 17_000;
  const updated = await demoRepositoryPackage(input, deps);
  assert.equal(updated.sourceSync?.state, 'submitted');
  assert.equal(f.uploads.length, 1);
  assert.deepEqual(f.uploads[0]!.consolidation, { mode: 'repository_update',
    includeApprovedOutputs: true, requireAtlasAssociation: true,
    expectedLatestSourceFingerprint: f.publishedSourceFingerprint });
  assert.equal(f.acknowledgements.length, 1);
});

test('a narrowed or unverifiable policy transition cannot publish a replacement', async () => {
  const f = await fixture({ sourcePolicy: true, packagePublished: true, activePackage: 'valid' });
  const input = { scope: f.scope, workspace: f.workspace, provider: 'codex' as const,
    nativeSkillDirectory: resolve(f.workspace, '.agents/skills') };
  await demoRepositoryPackage(input, { store: f.store, fetcher: f.fetcher });
  f.advancePolicy(['experiment_score.py']);
  await assert.rejects(demoRepositoryPackage(input, { store: f.store, fetcher: f.fetcher }),
    /narrows the active release policy/i);
  assert.equal(f.uploads.length, 0);
  f.advancePolicy(['.agents/skills/utility-bill-review/SKILL.md', 'README.md']);
  f.hideReleaseAuthorization();
  await assert.rejects(demoRepositoryPackage(input, { store: f.store, fetcher: f.fetcher }),
    /active release policy.*unavailable/i);
  assert.equal(f.uploads.length, 0);
});

test('repository authorization rejects disabled automatic publication before package installation', async () => {
  const f = await fixture({ sourcePolicy: true, packagePublished: true,
    activePackage: 'valid', automaticPublication: false });
  await assert.rejects(demoRepositoryPackage({ scope: f.scope, workspace: f.workspace,
    provider: 'codex', nativeSkillDirectory: resolve(f.workspace, '.agents/skills') },
  { store: f.store, fetcher: f.fetcher }), /repository source authorization policy is invalid/i);
  assert.equal(f.acknowledgements.length, 0);
  await assert.rejects(readFile(resolve(f.workspace, '.agents/skills/dharma-agent-fabric/SKILL.md')));
});

test('a legacy installer-only marker migrates to repository ownership before signed activation', async () => {
  const f = await fixture({ sourcePolicy: true, packagePublished: true, activePackage: 'valid' });
  const skillRoot = resolve(f.workspace, '.agents/skills/dharma-agent-fabric');
  await mkdir(skillRoot, { recursive: true });
  await writeFile(resolve(skillRoot, '.dharma-agent-fabric.json'), JSON.stringify({
    managedBy: 'dharma-agent-fabric', workspaceId,
  }));
  const result = await demoRepositoryPackage({ scope: f.scope, workspace: f.workspace,
    provider: 'codex', nativeSkillDirectory: resolve(f.workspace, '.agents/skills') },
  { store: f.store, fetcher: f.fetcher });
  assert.equal(result.stage, 'demo_repository_package_installed');
  assert.deepEqual(JSON.parse(await readFile(resolve(skillRoot, '.dharma-agent-fabric.json'), 'utf8')),
    { bundleId: f.release!.bundleId, skillId: 'dharma-agent-fabric', workspaceId: repositoryId });
});

test('a published candidate is not ready until its signed release is installed', async () => {
  const f = await fixture({ sourcePolicy: true, candidatePublished: true });
  const result = await demoRepositoryPackage({ scope: f.scope, workspace: f.workspace },
    { store: f.store, fetcher: f.fetcher });
  assert.equal(result.candidate?.state, 'published');
  assert.equal(result.ready, false);
  assert.equal(result.activationState, 'signed_delivery_pending');
});
