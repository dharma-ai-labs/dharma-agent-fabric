import assert from 'node:assert/strict';
import { createHash, createPublicKey, generateKeyPairSync, sign, verify } from 'node:crypto';
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { canonicalize } from '@dharma-ai-labs/agent-fabric-contracts';
import { calculateBundleHash, type SkillBundle } from '@dharma-ai-labs/agent-fabric-skill-manager';
import { verifyServerAuthorizedPolicy, type OrganizationPolicy } from '@dharma-ai-labs/agent-fabric-policy';
import { AgentFabricClient, loadOrCreateDeviceIdentity, saveDeviceConfig,
  saveDeviceEnrollmentAnchor } from '@dharma-ai-labs/agent-fabric-relay-client';
import type { SecureSecretStore } from '@dharma-ai-labs/agent-fabric-secure-store';
import { readNamedSessionRepositoryContext } from './namedSessionPackageGate.js';
import { applyServerEvidencePolicy } from './index.js';

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
  await cp(join(active, 'dharma-agent-fabric'), join(workspaceRoot, '.agents/skills/dharma-agent-fabric'), { recursive: true });
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

async function refreshedAuthorizationFixture(
  change?: (policy: OrganizationPolicy, source: Record<string, unknown>, second: boolean) => void | Promise<void>,
  afterSigning?: (policy: OrganizationPolicy, second: boolean) => void,
  materialize = false,
) {
  const f = await fixture();
  const time = new Date();
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const publicKeyEd25519 = publicKey.export({ format: 'jwk' }).x!;
  f.policy.evidence.automaticDisclosure = { mode: 'customer_authorized_content',
    consentReceiptId: 'synthetic_verified_content', allowedContentClasses: ['native_provider_payload'] };
  f.policy.evidence.pseudonymizeIdentity = true;
  if (materialize) f.policy.evidence.maximumExpansionBytes = 262144;
  f.source.policy.expiresAt = new Date(time.getTime() + 3_600_000).toISOString();
  f.source.policyHash = digest(canonicalize(f.source.policy));
  f.input.now = () => time;
  let calls = 0;
  f.input.loadAuthority = async () => {
    const second = ++calls === 2;
    const policy = structuredClone(f.policy);
    const source = structuredClone(f.source);
    const evidence = policy.evidence;
    policy.serverAuthorization = {
      schema: 'dharma.workspace-policy-authorization/v1', organizationId: scope.organizationId,
      workspaceId: scope.workspaceId, keyVersion: 'synthetic_key_v1',
      issuedAt: new Date(time.getTime() - (second ? 1000 : 2000)).toISOString(),
      expiresAt: new Date(time.getTime() + (second ? 3_601_000 : 3_600_000)).toISOString(),
      policy: { revision: policy.revision, evidence: {
        automaticDisclosure: evidence.automaticDisclosure!, maximumCapsuleBytes: evidence.maximumCapsuleBytes,
        maximumDailyUploadBytes: evidence.maximumDailyUploadBytes, maximumExpansionBytes: evidence.maximumExpansionBytes,
        excludePaths: evidence.excludePaths, pseudonymizeIdentity: true } }, signature: '' };
    await change?.(policy, source, second);
    const { signature: _, ...unsigned } = policy.serverAuthorization;
    policy.serverAuthorization.signature = sign(null, Buffer.from(canonicalize(unsigned)), privateKey).toString('base64url');
    afterSigning?.(policy, second);
    return { policy: materialize
      ? applyServerEvidencePolicy(policy, policy.serverAuthorization, publicKeyEd25519,
        scope.organizationId, scope.workspaceId, time)
      : verifyServerAuthorizedPolicy({ policy, publicKeyEd25519,
        organizationId: scope.organizationId, workspaceId: scope.workspaceId, now: time }), source };
  };
  return { ...f, calls: () => calls, time, serverPublicKeyEd25519: publicKeyEd25519 };
}

async function httpRefreshFixture(mode: 'stable' | 'changed-policy' | 'tampered' | 'foreign-workspace'
  | 'revoked' | 'malformed') {
  const f = await refreshedAuthorizationFixture((policy, _source, second) => {
    if (second && mode === 'changed-policy') {
      policy.revision = 'changed-v2';
      policy.serverAuthorization!.policy.revision = policy.revision;
    }
  }, undefined, true);
  const values = new Map<string, string>();
  const store: SecureSecretStore = { backend: 'linux-secret-service',
    async get(account) { return values.get(account) ?? null; },
    async put(account, value) { values.set(account, value); },
    async delete(account) { values.delete(account); } };
  const protocolRoot = await mkdtemp(join(tmpdir(), 'dharma-context-http-'));
  let responseBody: unknown;
  let workspaceRequests = 0, verifiedRequests = 0;
  let publicKey = '';
  const server = createServer(async (req, res) => {
    try {
      const body = await new Promise<string>((resolve, reject) => {
        let value = '';
        req.setEncoding('utf8');
        req.on('data', chunk => {
          value += chunk;
          if (Buffer.byteLength(value) > 4096) { reject(new Error('synthetic_body_limit')); req.destroy(); }
        });
        req.on('end', () => resolve(value));
        req.on('error', reject);
      });
      const header = (name: string) => String(req.headers[name] ?? '');
      const payload = { bodyHash: digest(body), deviceId: header('x-dharma-device-id'),
        messageId: header('x-dharma-message-id'), method: req.method, nonce: header('x-dharma-nonce'),
        organizationId: scope.organizationId, pathname: req.url,
        sequence: Number(header('x-dharma-sequence')), sessionId: header('x-dharma-session-id'),
        timestamp: header('x-dharma-timestamp') };
      const key = createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: publicKey }, format: 'jwk' });
      if (!verify(null, Buffer.from(JSON.stringify(payload)), key,
        Buffer.from(header('x-dharma-signature'), 'base64url'))) throw new Error('synthetic_signature_invalid');
      if (payload.deviceId !== uuid(90) || payload.sequence !== verifiedRequests + 1
        || req.method !== 'POST') throw new Error('synthetic_request_binding_invalid');
      verifiedRequests++;
      const root = `/api/v1/orgs/${scope.organizationId}/agent-fabric`;
      if (req.url === `${root}/sessions`) {
        res.writeHead(201, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      if (req.url !== `${root}/workspaces`
        || JSON.parse(body).workspaceId !== scope.workspaceId) throw new Error('synthetic_route_invalid');
      workspaceRequests++;
      const second = workspaceRequests === 2;
      if (second && mode === 'revoked') {
        res.writeHead(403, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: { code: 'synthetic_current_authority_revoked' } }));
        return;
      }
      res.writeHead(201, { 'content-type': 'application/json' });
      if (second && mode === 'malformed') { res.end('{'); return; }
      res.end(JSON.stringify(responseBody));
    } catch {
      if (!res.headersSent) res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: { code: 'synthetic_request_rejected' } }));
    }
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    const hqUrl = `http://127.0.0.1:${address.port}`;
    const identity = await loadOrCreateDeviceIdentity({ hqUrl, organizationId: scope.organizationId, store });
    publicKey = identity.publicKeyEd25519;
    const config = { schema: 'dharma.device-config/v1' as const, hqUrl,
      organizationId: scope.organizationId, deviceId: uuid(90), deviceName: 'Synthetic HTTP fixture',
      platform: 'linux' as const, publicKeyEd25519: publicKey,
      serverPublicKeyEd25519: publicKey, relayUrl: 'ws://127.0.0.1', enrolledAt: f.time.toISOString() };
    const configPath = join(protocolRoot, 'device.json');
    await saveDeviceConfig(configPath, config);
    await saveDeviceEnrollmentAnchor({ config, store });
    const client = await AgentFabricClient.open({ configPath, statePath: join(protocolRoot, 'protocol.json'), store,
      fetcher: async (url, options) => {
        if (new URL(String(url)).origin !== hqUrl) throw new Error('synthetic_non_loopback_request');
        return fetch(url, options);
      } });
    await client.openSession();
    const load = f.input.loadAuthority;
    f.input.loadAuthority = async () => {
      const loaded = await load();
      const authorization = structuredClone(loaded.policy.serverAuthorization!);
      const second = f.calls() === 2;
      if (second && mode === 'tampered') authorization.signature = 'tampered-synthetic-signature';
      if (second && mode === 'foreign-workspace') authorization.workspaceId = uuid(99);
      responseBody = { ok: true, organizationId: scope.organizationId,
        workspace: { id: scope.workspaceId, status: 'active', policyRevision: loaded.policy.revision },
        organizationPolicyAuthorization: authorization };
      const response = await client.registerWorkspace({ workspaceId: scope.workspaceId,
        policyRevision: loaded.policy.revision, providers: [] });
      return { policy: applyServerEvidencePolicy(loaded.policy, response.organizationPolicyAuthorization,
        f.serverPublicKeyEd25519,
        scope.organizationId, scope.workspaceId, f.time), source: loaded.source };
    };
    return { ...f, counts: () => ({ workspaceRequests, verifiedRequests }),
      dispose: async () => {
        server.closeAllConnections();
        await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
        values.clear();
        await rm(protocolRoot, { recursive: true, force: true });
        await f.dispose();
      } };
  } catch (error) {
    server.closeAllConnections(); server.close(); values.clear();
    await rm(protocolRoot, { recursive: true, force: true }); await f.dispose();
    throw error;
  }
}

for (const mode of ['stable', 'changed-policy', 'tampered', 'foreign-workspace', 'revoked', 'malformed'] as const) {
  test(`signed loopback workspace refresh ${mode} keeps repository admission bounded`, { timeout: 15_000 }, async () => {
    const f = await httpRefreshFixture(mode);
    try {
      if (mode === 'stable') {
        const context = JSON.parse(await readNamedSessionRepositoryContext(f.input));
        assert.equal(context.files.length, 2);
        assert.equal(JSON.stringify(context).includes('serverAuthorization'), false);
      } else await assert.rejects(readNamedSessionRepositoryContext(f.input));
      assert.deepEqual(f.counts(), { workspaceRequests: 2, verifiedRequests: 3 });
    } finally { await f.dispose(); }
  });
}

test('fresh verified envelopes with unchanged effective authority admit repository context', async () => {
  const f = await refreshedAuthorizationFixture();
  try {
    const context = JSON.parse(await readNamedSessionRepositoryContext(f.input));
    assert.equal(f.calls(), 2);
    assert.equal(context.sourceReceiptId, f.source.receiptId);
    assert.deepEqual(context.files.map((file: { path: string }) => file.path),
      ['.agents/skills/dharma-agent-fabric/skills/source/.agents/skills/job-review/SKILL.md', '.agents/skills/dharma-agent-fabric/knowledge/reports/source/reports/repair.md']);
    assert.equal(JSON.stringify(context).includes('serverAuthorization'), false);
    assert.equal(JSON.stringify(context).includes('synthetic_verified_content'), false);
  } finally { await f.dispose(); }
});

test('production policy materialization admits both fresh verified envelopes with unchanged authority', async () => {
  const f = await refreshedAuthorizationFixture(undefined, undefined, true);
  try {
    const context = JSON.parse(await readNamedSessionRepositoryContext(f.input));
    assert.equal(f.calls(), 2);
    assert.equal(context.sourceReceiptId, f.source.receiptId);
    assert.equal(context.files.length, 2);
    assert.equal(JSON.stringify(context).includes('serverAuthorization'), false);
  } finally { await f.dispose(); }
});

for (const failure of ['revision', 'exclusions', 'content-limit', 'commands', 'writes', 'network', 'budget',
  'source-receipt', 'source-policy', 'foreign-org', 'foreign-workspace', 'schema', 'key-version', 'older-issued',
  'shorter-expiry', 'same-issued-different-signature', 'equivalent-issued-different-signature',
  'expired', 'future-issued', 'tampered', 'missing-envelope', 'revoked'] as const) {
  test(`fresh verified authority keeps ${failure} denied during context admission`, async () => {
    const f = await refreshedAuthorizationFixture((policy, source, second) => {
      if (!second) return;
      const auth = policy.serverAuthorization!;
      if (failure === 'revision') { policy.revision = 'changed-v2'; auth.policy.revision = policy.revision; }
      if (failure === 'exclusions') policy.evidence.excludePaths.push('new-private/**');
      if (failure === 'content-limit') {
        policy.evidence.maximumDailyUploadBytes--;
        auth.policy.evidence.maximumDailyUploadBytes = policy.evidence.maximumDailyUploadBytes;
      }
      if (failure === 'commands') policy.tasks.allowedCommands['new-command'] = { argv: ['new-command'], timeoutSeconds: 1 };
      if (failure === 'writes') policy.tasks.writePaths.push('new-path');
      if (failure === 'network') policy.tasks.defaultNetwork = 'allowlisted_domains';
      if (failure === 'budget') policy.budgets = { maximumCents: 1 };
      if (failure === 'source-receipt') source.confirmedAt = '2026-10-05T00:00:01Z';
      if (failure === 'source-policy') {
        source.policy = { ...(source.policy as Record<string, unknown>), approvedRepositoryPaths: ['src'] };
        source.policyHash = digest(canonicalize(source.policy));
      }
      if (failure === 'foreign-org') auth.organizationId = 'org_foreign';
      if (failure === 'foreign-workspace') auth.workspaceId = uuid(99);
      if (failure === 'schema') Object.assign(auth, { schema: 'dharma.workspace-policy-authorization/v2' });
      if (failure === 'key-version') auth.keyVersion = 'synthetic_key_v2';
      if (failure === 'older-issued') auth.issuedAt = new Date(Date.parse(auth.issuedAt) - 2000).toISOString();
      if (failure === 'shorter-expiry') auth.expiresAt = new Date(Date.parse(auth.expiresAt) - 2000).toISOString();
      if (failure === 'same-issued-different-signature') auth.issuedAt = new Date(Date.parse(auth.issuedAt) - 1000).toISOString();
      if (failure === 'equivalent-issued-different-signature') {
        auth.issuedAt = new Date(Date.parse(auth.issuedAt) - 1000).toISOString().replace('Z', '+00:00');
      }
      if (failure === 'expired') auth.expiresAt = new Date(0).toISOString();
      if (failure === 'future-issued') auth.issuedAt = new Date(Date.now() + 600_000).toISOString();
      if (failure === 'revoked') throw new Error('synthetic_current_authority_revoked');
    }, (policy, second) => {
      if (second && failure === 'tampered') policy.serverAuthorization!.signature = 'tampered-synthetic-signature';
      if (second && failure === 'missing-envelope') delete policy.serverAuthorization;
    });
    try {
      await assert.rejects(readNamedSessionRepositoryContext(f.input));
      assert.equal(f.calls(), 2);
    } finally { await f.dispose(); }
  });
}

test('fresh verified envelopes cannot hide workspace bytes changed during refresh', async () => {
  let workspaceRoot: string;
  const f = await refreshedAuthorizationFixture(async (_policy, _source, second) => {
    if (second) await writeFile(join(workspaceRoot, '.agents/skills/dharma-agent-fabric/knowledge/reports/source/reports/repair.md'), 'Unsigned later change.');
  });
  workspaceRoot = f.workspaceRoot;
  try { await assert.rejects(readNamedSessionRepositoryContext(f.input)); }
  finally { await f.dispose(); }
});

test('fresh verified envelopes cannot hide signed skill bytes changed during refresh', async () => {
  let native: string;
  const f = await refreshedAuthorizationFixture(async (_policy, _source, second) => {
    if (second) await writeFile(join(native, 'skills/source/.agents/skills/job-review/SKILL.md'), 'Tampered signed skill.');
  });
  native = f.native;
  try { await assert.rejects(readNamedSessionRepositoryContext(f.input)); }
  finally { await f.dispose(); }
});

for (const failure of ['expired', 'tampered'] as const) {
  test(`initial ${failure} signed authority is denied before repository context reads`, async () => {
    const f = await refreshedAuthorizationFixture((policy, _source, second) => {
      if (!second && failure === 'expired') policy.serverAuthorization!.expiresAt = new Date(0).toISOString();
    }, (policy, second) => {
      if (!second && failure === 'tampered') policy.serverAuthorization!.signature = 'tampered-synthetic-signature';
    });
    try {
      await assert.rejects(readNamedSessionRepositoryContext(f.input));
      assert.equal(f.calls(), 1);
    } finally { await f.dispose(); }
  });
}

test('distributed signed report does not require the publishers original output file', async () => {
  const f = await fixture();
  try {
    await rm(join(f.workspaceRoot, 'reports/repair.md'));
    const context = JSON.parse(await readNamedSessionRepositoryContext(f.input));
    assert.equal(context.files[1].path, '.agents/skills/dharma-agent-fabric/knowledge/reports/source/reports/repair.md');
    assert.equal(context.files[1].sha256, digest('# Report\nRestart-memory limitation observed.\n'));
  } finally { await f.dispose(); }
});

test('only upstream-verified signed source skills and approved reports enter task context', async () => {
  const f = await fixture();
  try {
    const context = JSON.parse(await readNamedSessionRepositoryContext(f.input));
    assert.equal(context.authority, 'untrusted_repository_data');
    assert.equal(context.sourceReceiptId, f.source.receiptId);
    assert.deepEqual(context.files.map((file: { path: string }) => file.path), ['.agents/skills/dharma-agent-fabric/skills/source/.agents/skills/job-review/SKILL.md', '.agents/skills/dharma-agent-fabric/knowledge/reports/source/reports/repair.md']);
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
    assert.deepEqual(context.files[1], { path: '.agents/skills/dharma-agent-fabric/knowledge/reports/source/reports/repair.md', role: 'knowledge', sha256: digest(report),
      sizeBytes: Buffer.byteLength(report), contentDisposition: 'verified_workspace_reference' });
    assert.equal(raw.includes('Independent later observation'), false);
  } finally { await f.dispose(); }
});

for (const failure of ['missing', 'changed', 'symlink', 'directory-symlink', 'changed-during-authority'] as const) {
  test(`workspace references reject ${failure} before context admission`, async () => {
    const f = await fixture();
    try {
      const path = join(f.workspaceRoot, '.agents/skills/dharma-agent-fabric/knowledge/reports/source/reports/repair.md');
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
