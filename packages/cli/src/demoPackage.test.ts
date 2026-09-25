import assert from 'node:assert/strict';
import { createHash, createPublicKey, verify } from 'node:crypto';
import { mkdir, mkdtemp, readFile, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { canonicalize } from '@dharma-ai-labs/agent-fabric-contracts';
import { loadOrCreateDeviceIdentity, type SecureSecretStore } from '@dharma-ai-labs/agent-fabric-relay-client';
import { scopePath } from './demoEnrollment.js';
import { demoRepositoryPackage } from './demoPackage.js';

const organizationId = 'org_fixture';
const repositoryId = '10000000-0000-4000-8000-000000000001';
const deviceId = '30000000-0000-4000-8000-000000000001';
const workspaceId = '40000000-0000-4000-8000-000000000001';
const installationId = '50000000-0000-4000-8000-000000000001';
const normalizedRepository = 'github.com/example/private';
const hqUrl = 'https://dharma.example';

function memoryStore(): SecureSecretStore {
  const values = new Map<string, string>();
  return { backend: 'linux-secret-service',
    async get(account) { return values.get(account) || null; },
    async put(account, value) { values.set(account, value); },
    async delete(account) { values.delete(account); } };
}

async function fixture(options: { loseFirstScope?: boolean; sourcePolicy?: boolean;
  loseFirstUpload?: boolean; packagePublished?: boolean; candidatePublished?: boolean } = {}) {
  const stateRoot = await mkdtemp(resolve(tmpdir(), 'dharma-demo-package-'));
  const workspace = await mkdtemp(resolve(tmpdir(), 'dharma-demo-source-'));
  await writeFile(resolve(workspace, 'README.md'), 'Approved source evidence.\n');
  const store = memoryStore();
  const scope = { hqUrl, organizationId, repositoryId, normalizedRepository,
    installationId, stateRoot };
  const identity = await loadOrCreateDeviceIdentity({ hqUrl,
    organizationId: `${organizationId}:${repositoryId}`, installationId, store });
  const configPath = scopePath(scope, hqUrl);
  await mkdir(dirname(configPath), { recursive: true });
  await writeFile(configPath, JSON.stringify({ schema: 'dharma.demo-device/v1',
    ...scope, deviceId, publicKeyEd25519: identity.publicKeyEd25519,
    signedReady: true, nextSequence: 1 }), { mode: 0o600 });
  let sequence = 0;
  let lost = false;
  let uploadLost = false;
  const uploads: Array<Record<string, unknown>> = [];
  const generationId = '60000000-0000-4000-8000-000000000001';
  const policy = { action: 'authorize', confirmed: true,
    requestId: '70000000-0000-4000-8000-000000000001', repositoryBindingId: repositoryId,
    expectedRevision: 0, allowedContentClasses: ['approved_outputs', 'repository_content', 'repository_skills'],
    approvedRepositoryPaths: ['.'], approvedOutputFolders: [], automaticValidatedPublication: true,
    retentionDays: 30, maximumFileBytes: 262144, maximumSnapshotBytes: 4194304,
    maximumDailyUploadBytes: 8388608, expiresAt: null };
  const sourceAuthorization = { schema: 'dharma.repository-source-authorization/v1',
    organizationId, workspaceId, repositoryBindingId: repositoryId,
    repositoryAgentId: repositoryId, revision: 1, generationId,
    receiptId: `repo_consent_${generationId}`,
    policyRevision: `repository-source-${generationId}`,
    policyHash: `sha256:${createHash('sha256').update(canonicalize(policy)).digest('hex')}`,
    confirmedAt: new Date().toISOString(), policy };
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
        sourceAuthorization: options.sourcePolicy ? sourceAuthorization : null,
        repositoryPackageState: options.packagePublished ? 'published' : 'not_connected' });
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
    throw new Error(`Unexpected package route: ${url.pathname}`);
  };
  return { scope, workspace, store, fetcher, configPath, uploads,
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

test('a published candidate is not ready until its signed release is installed', async () => {
  const f = await fixture({ sourcePolicy: true, candidatePublished: true });
  const result = await demoRepositoryPackage({ scope: f.scope, workspace: f.workspace },
    { store: f.store, fetcher: f.fetcher });
  assert.equal(result.candidate?.state, 'published');
  assert.equal(result.ready, false);
  assert.equal(result.activationState, 'signed_delivery_pending');
});
