import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { canonicalize } from '@dharma-ai-labs/agent-fabric-contracts';
import { pollRepositoryCandidate, synchronizeRepositoryCandidate } from './repositoryCandidateSync.js';
import { inventoryRepositoryPackage } from './repositoryPackage.js';
import { initializeRepositoryKnowledge } from './repositoryKnowledge.js';

const ids = {
  workspaceId: '056b63dc-ebed-48ed-85d8-02c72f623ea8',
  repositoryBindingId: '73a95988-fd64-41ba-a0b9-6c8867d03788',
  repositoryAgentId: '57f61652-a5eb-46e4-930c-9478cd4a9c31',
};
async function snapshot(root: string) {
  const workspace = join(root, 'repository');
  await mkdir(join(workspace, '.agents/skills/dharma-agent-fabric'), { recursive: true });
  await writeFile(join(workspace, '.agents/skills/dharma-agent-fabric/.dharma-agent-fabric.json'),
    JSON.stringify({ managedBy: 'dharma-agent-fabric', workspaceId: ids.workspaceId }));
  await writeFile(join(workspace, 'README.md'), '# Governed repository\n');
  const operation = { action: 'authorize', confirmed: true,
    requestId: '5ff2ee1b-6cb3-459e-a977-ea99c757bf30', repositoryBindingId: ids.repositoryBindingId,
    expectedRevision: 0, allowedContentClasses: ['approved_outputs', 'repository_content', 'repository_skills'],
    approvedRepositoryPaths: ['README.md'], approvedOutputFolders: [], automaticValidatedPublication: true,
    retentionDays: 30, maximumFileBytes: 262144, maximumSnapshotBytes: 4194304,
    maximumDailyUploadBytes: 1073741824, expiresAt: '2031-01-01T00:00:00.000Z' };
  const generationId = '67f61652-a5eb-46e4-930c-9478cd4a9c31';
  const sourceAuthorization = { schema: 'dharma.repository-source-authorization/v1', organizationId: 'org_fixture',
    workspaceId: ids.workspaceId, repositoryBindingId: ids.repositoryBindingId, repositoryAgentId: ids.repositoryAgentId,
    revision: 1, generationId, receiptId: `repo_consent_${generationId}`,
    policyRevision: `repository-source-${generationId}`,
    policyHash: `sha256:${createHash('sha256').update(canonicalize(operation)).digest('hex')}`,
    confirmedAt: '2030-01-01T00:00:00.000Z', policy: operation };
  const input = { workspace, organizationId: 'org_fixture', ...ids, sourceAuthorization,
    now: new Date('2030-01-02T00:00:00.000Z') };
  await initializeRepositoryKnowledge(input);
  return inventoryRepositoryPackage(input);
}

test('repository candidate upload persists an exact outbox and polls the same operation after a lost caller response', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dharma-candidate-'));
  const calls: Array<{ method: string; route: string; body?: unknown }> = [];
  const candidateId = '77f61652-a5eb-46e4-930c-9478cd4a9c31';
  try {
    const transport = {
      signedPost: async (route: string, body: unknown) => {
        calls.push({ method: 'POST', route, body });
        const request = body as Record<string, unknown>;
        return { ok: true, organizationId: 'org_fixture', candidate: { candidateId,
          operationId: request.operationId, snapshotHash: request.sourceSnapshotHash, state: 'processing', releaseId: null } };
      },
      signedGet: async (route: string) => {
        calls.push({ method: 'GET', route });
        const stored = JSON.parse(await readFile(join(root, 'outbox', `${ids.workspaceId}.json`), 'utf8'));
        return { ok: true, organizationId: 'org_fixture', candidate: { candidateId,
          operationId: stored.operationId, snapshotHash: stored.snapshotHash,
          state: 'published', releaseId: '87f61652-a5eb-46e4-930c-9478cd4a9c31' } };
      },
    };
    const input = { transport, outboxRoot: join(root, 'outbox'), scope: { organizationId: 'org_fixture', ...ids },
      snapshot: await snapshot(root), initialRepository: true };
    const first = await synchronizeRepositoryCandidate(input);
    assert.equal(first.state, 'processing');
    const second = await synchronizeRepositoryCandidate(input);
    assert.equal(second.state, 'published');
    assert.deepEqual(calls.map(call => call.method), ['POST', 'GET']);
    const request = calls[0]?.body as Record<string, unknown>;
    assert.deepEqual(request.consolidation, { mode: 'initial_repository', includeApprovedOutputs: true,
      requireAtlasAssociation: true });
    const uploadedSnapshot = request.snapshot as Record<string, unknown>;
    assert.deepEqual(Object.keys(uploadedSnapshot).sort(), ['blobs', 'capturedAt', 'manifest', 'schema']);
    assert.equal(uploadedSnapshot.schema, 'dharma.repository-package-snapshot/v1');
    assert.equal(uploadedSnapshot.capturedAt, '2030-01-02T00:00:00.000Z');
    const stored = await readFile(join(root, 'outbox', `${ids.workspaceId}.json`), 'utf8');
    assert.doesNotMatch(stored, /contentBase64|Governed repository/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('repository candidate rejects non-canonical upload timestamps before transport', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dharma-candidate-'));
  let calls = 0;
  try {
    const candidateSnapshot = await snapshot(root);
    candidateSnapshot.capturedAt = '2030-01-02T00:00:00Z';
    await assert.rejects(() => synchronizeRepositoryCandidate({
      outboxRoot: join(root, 'outbox'), scope: { organizationId: 'org_fixture', ...ids },
      snapshot: candidateSnapshot, initialRepository: true,
      transport: { signedGet: async () => ({}), signedPost: async () => { calls += 1; return {}; } },
    }), /envelope metadata/);
    assert.equal(calls, 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('repository candidate status polling is independent of repository source observation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dharma-candidate-'));
  const candidateId = '77f61652-a5eb-46e4-930c-9478cd4a9c31';
  try {
    const candidateSnapshot = await snapshot(root);
    const scope = { organizationId: 'org_fixture', ...ids };
    const first = await synchronizeRepositoryCandidate({ outboxRoot: join(root, 'outbox'), scope,
      snapshot: candidateSnapshot, initialRepository: false, transport: { signedGet: async () => ({}),
        signedPost: async (_route, body) => ({ ok: true, organizationId: scope.organizationId, candidate: {
          candidateId, operationId: (body as Record<string, unknown>).operationId,
          snapshotHash: (body as Record<string, unknown>).sourceSnapshotHash, state: 'accepted', releaseId: null } }) } });
    const current = await pollRepositoryCandidate({ outboxRoot: join(root, 'outbox'), scope,
      transport: { signedGet: async route => {
        assert.match(route, new RegExp(candidateId));
        return { ok: true, organizationId: scope.organizationId, candidate: { ...first, state: 'published',
          releaseId: '87f61652-a5eb-46e4-930c-9478cd4a9c31' } };
      } } });
    assert.equal(current?.state, 'published');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('repository candidate rejects tampered durable metadata before transport', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dharma-candidate-'));
  let calls = 0;
  try {
    const candidateSnapshot = await snapshot(root);
    const input = { outboxRoot: join(root, 'outbox'), scope: { organizationId: 'org_fixture', ...ids },
      snapshot: candidateSnapshot, initialRepository: true, transport: { signedGet: async () => { calls += 1; return {}; },
        signedPost: async (_route: string, body: unknown) => ({ ok: true, organizationId: 'org_fixture', candidate: {
          candidateId: '77f61652-a5eb-46e4-930c-9478cd4a9c31', operationId: (body as Record<string, unknown>).operationId,
          snapshotHash: (body as Record<string, unknown>).sourceSnapshotHash, state: 'processing', releaseId: null } }) } };
    await synchronizeRepositoryCandidate(input);
    const path = join(root, 'outbox', `${ids.workspaceId}.json`);
    const stored = JSON.parse(await readFile(path, 'utf8'));
    stored.consolidation.includeApprovedOutputs = false;
    await writeFile(path, JSON.stringify(stored));
    await assert.rejects(() => pollRepositoryCandidate({ outboxRoot: join(root, 'outbox'), scope: input.scope,
      transport: input.transport }), /outbox|consolidation|current upload/i);
    assert.equal(calls, 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('repository candidate upload rejects foreign or inconsistent receipts without advancing the outbox', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dharma-candidate-'));
  try {
    const candidateSnapshot = await snapshot(root);
    await assert.rejects(() => synchronizeRepositoryCandidate({
      outboxRoot: join(root, 'outbox'), scope: { organizationId: 'org_fixture', ...ids },
      snapshot: candidateSnapshot, initialRepository: false,
      transport: { signedGet: async () => ({}), signedPost: async (_route, body) => ({ ok: true,
        organizationId: 'org_foreign', candidate: { candidateId: ids.workspaceId,
          operationId: (body as Record<string, unknown>).operationId,
          snapshotHash: (body as Record<string, unknown>).sourceSnapshotHash, state: 'published', releaseId: null } }) },
    }), /scope|receipt|response/i);
  } finally { await rm(root, { recursive: true, force: true }); }
});
