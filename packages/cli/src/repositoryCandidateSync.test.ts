import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import ts from 'typescript';
import { canonicalize, sha256, validateContract } from '@dharma-ai-labs/agent-fabric-contracts';
import { adoptRepositoryCandidate, checkpointRepositoryRestorationCandidate, checkpointRepositoryRestorationFence, checkpointRepositoryRestorationRegistry, fenceRepositoryRestorationUpload,
  readRepositoryRestorationAttempt, pollRepositoryCandidate, recoverRepositoryRestorationCandidate, synchronizeRepositoryCandidate } from './repositoryCandidateSync.js';
import { inventoryRepositoryPackage } from './repositoryPackage.js';
import { initializeRepositoryKnowledge } from './repositoryKnowledge.js';

const ids = {
  workspaceId: '056b63dc-ebed-48ed-85d8-02c72f623ea8',
  repositoryBindingId: '73a95988-fd64-41ba-a0b9-6c8867d03788',
  repositoryAgentId: '57f61652-a5eb-46e4-930c-9478cd4a9c31',
};

test('unadmitted restoration is fenced before checkpoint retirement and a distinct retry preserves its archive', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dharma-restoration-fence-'));
  try {
    const scope = { organizationId: 'org_fixture', ...ids }, calls: string[] = [];
    const restoration = { planHash: `sha256:${'b'.repeat(64)}`, localSnapshotHash: `sha256:${'c'.repeat(64)}`,
      baselineSnapshotHash: null, previousOperationId: null, priorReleaseId: '87f61652-a5eb-46e4-930c-9478cd4a9c31' };
    const outboxRoot = join(root, 'outbox'), path = join(outboxRoot, `${ids.workspaceId}.json`);
    const generation = '67f61652-a5eb-46e4-930c-9478cd4a9c31', fenceId = 'a7f61652-a5eb-46e4-930c-9478cd4a9c31';
    const inventory = await snapshot(root);let admitted = false;
    const transport = {
      signedGet: async () => ({ ok: true, organizationId: scope.organizationId, candidate: null }),
      signedPost: async (route: string, raw: unknown) => {
        const body = raw as Record<string, unknown>;calls.push(route.endsWith('/fence') ? 'FENCE' : 'UPLOAD');
        if (route.endsWith('/fence')) return { ok: true, organizationId: scope.organizationId, candidate: null,
          fence: { fenceId, operationId: body.operationId, workspaceId: scope.workspaceId,
            repositoryBindingId: scope.repositoryBindingId, repositoryAgentId: scope.repositoryAgentId,
            sourceSnapshotHash: body.sourceSnapshotHash, sourceManifestHash: body.sourceManifestHash,
            policyGenerationId: generation, state: 'fenced', createdAt: '2030-01-02T00:00:00.000Z' } };
        if (!admitted) throw new Error('lost_upload');
        assert.equal(body.restorationAttempt, fenceId);
        return { ok: true, organizationId: scope.organizationId, candidate: {
          candidateId: '77f61652-a5eb-46e4-930c-9478cd4a9c31', operationId: body.operationId,
          snapshotHash: body.sourceSnapshotHash, state: 'accepted', releaseId: null } };
      },
    };
    const input = { transport, outboxRoot, scope, snapshot: inventory, initialRepository: false,
      expectedLatestSourceFingerprint: `sha256:${'a'.repeat(64)}`, restoration };
    await assert.rejects(synchronizeRepositoryCandidate(input), /lost_upload/);
    const before = await readFile(path, 'utf8'), old = JSON.parse(before);
    await assert.rejects(fenceRepositoryRestorationUpload({ ...input, planHash: restoration.planHash,
      policyGenerationId: generation, expectedPreviousOperationId: `sha256:${'d'.repeat(64)}` }), /checkpoint is invalid/);
    assert.deepEqual(calls, ['UPLOAD']);assert.equal(await readFile(path, 'utf8'), before);
    const fenced = await fenceRepositoryRestorationUpload({ ...input, planHash: restoration.planHash,
      policyGenerationId: generation, expectedPreviousOperationId: null });
    const requested = canonicalize({ ...old, fenceRequestGenerationId: generation }) + '\n';
    assert.equal(await readFile(path, 'utf8'), requested);assert.equal(fenced.fence?.fenceId, fenceId);
    await checkpointRepositoryRestorationFence({ outboxRoot, scope, fenced });
    assert.equal(await readRepositoryRestorationAttempt({ outboxRoot, scope }), fenceId);
    assert.equal(await pollRepositoryCandidate(input), null);
    // A crash after durable archival but before the outbox rename must recover the same fence.
    await writeFile(path, requested);
    const recoveredFence = await fenceRepositoryRestorationUpload({ ...input, planHash: restoration.planHash,
      policyGenerationId: generation, expectedPreviousOperationId: null });
    await checkpointRepositoryRestorationFence({ outboxRoot, scope, fenced: recoveredFence });
    const terminalBytes = await readFile(path, 'utf8');
    const archivePath = join(outboxRoot, 'fenced', `${ids.workspaceId}.${fenceId}.json`);
    const archivedBytes = await readFile(archivePath, 'utf8');
    // Ordinary registry adoption must not consume the retry identity.
    for (const state of ['published', 'blocked'] as const) {
      const ordinary = { candidateId: '77f61652-a5eb-46e4-930c-9478cd4a9c31',
        operationId: `sha256:${'e'.repeat(64)}`, snapshotHash: `sha256:${'f'.repeat(64)}`, state,
        releaseId: state === 'published' ? '97f61652-a5eb-46e4-930c-9478cd4a9c31' : null };
      assert.deepEqual(await adoptRepositoryCandidate({ scope, outboxRoot, candidate: ordinary,
        sourceManifestHash: `sha256:${'d'.repeat(64)}`, consolidationMode: 'repository_update' }), ordinary);
      assert.equal(await readFile(path, 'utf8'), terminalBytes);
      assert.equal(await readFile(archivePath, 'utf8'), archivedBytes);
      assert.equal(await readRepositoryRestorationAttempt({ outboxRoot, scope }), fenceId);
    }
    admitted = true;
    await assert.rejects(synchronizeRepositoryCandidate(input), /fenced operation requires/);
    const retry = await synchronizeRepositoryCandidate({ ...input, restoration: { ...restoration, attemptId: fenceId } });
    assert.notEqual(retry.operationId, old.operationId);assert.deepEqual(calls, ['UPLOAD', 'FENCE', 'FENCE', 'UPLOAD']);
    const archive = JSON.parse(await readFile(join(outboxRoot, 'fenced', `${ids.workspaceId}.${fenceId}.json`), 'utf8'));
    assert.deepEqual(archive.checkpoint, JSON.parse(requested));assert.equal(archive.fence.fenceId, fenceId);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('partial archive writes never publish a poisoned terminal receipt and retry recovers', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dharma-archive-interruption-')), originalOpen = fs.open;
  let injected = false;
  try {
    const scope = { organizationId: 'org_fixture', ...ids }, outboxRoot = join(root, 'outbox');
    const path = join(outboxRoot, `${ids.workspaceId}.json`), generation = '67f61652-a5eb-46e4-930c-9478cd4a9c31';
    const fenceId = 'a7f61652-a5eb-46e4-930c-9478cd4a9c31';
    const restoration = { planHash: `sha256:${'b'.repeat(64)}`, localSnapshotHash: `sha256:${'c'.repeat(64)}`,
      baselineSnapshotHash: null, previousOperationId: null, priorReleaseId: '87f61652-a5eb-46e4-930c-9478cd4a9c31' };
    const transport = { signedGet: async () => ({}), signedPost: async (route: string, raw: unknown) => {
      if (!route.endsWith('/fence')) throw new Error('lost_upload');
      const body = raw as Record<string, unknown>;
      return { ok: true, organizationId: scope.organizationId, candidate: null, fence: { fenceId,
        operationId: body.operationId, ...ids, sourceSnapshotHash: body.sourceSnapshotHash,
        sourceManifestHash: body.sourceManifestHash, policyGenerationId: generation, state: 'fenced', createdAt: '2030-01-02T00:00:00.000Z' } };
    } };
    await assert.rejects(synchronizeRepositoryCandidate({ scope, outboxRoot, transport, snapshot: await snapshot(root),
      initialRepository: false, expectedLatestSourceFingerprint: `sha256:${'a'.repeat(64)}`, restoration }), /lost_upload/);
    const fenced = await fenceRepositoryRestorationUpload({ scope, outboxRoot, transport, planHash: restoration.planHash,
      policyGenerationId: generation, expectedPreviousOperationId: null });
    const before = await readFile(path, 'utf8');
    fs.open = async (...args: Parameters<typeof fs.open>) => {
      const handle = await originalOpen(...args);
      if (String(args[0]).replaceAll('\\', '/').includes('/fenced/') && !injected) {
        const write = handle.writeFile.bind(handle);
        handle.writeFile = async () => { injected = true; await write('partial'); throw new Error('partial_archive_write'); };
      }
      return handle;
    };syncBuiltinESMExports();
    await assert.rejects(checkpointRepositoryRestorationFence({ scope, outboxRoot, fenced }), /partial_archive_write/);
    fs.open = originalOpen;syncBuiltinESMExports();
    assert.equal(injected, true);assert.equal(await readFile(path, 'utf8'), before);
    assert.deepEqual(await fs.readdir(join(outboxRoot, 'fenced')), []);
    await checkpointRepositoryRestorationFence({ scope, outboxRoot, fenced });
    assert.equal(JSON.parse(await readFile(path, 'utf8')).state, 'fenced');
    assert.deepEqual(await fs.readdir(join(outboxRoot, 'fenced')), [`${ids.workspaceId}.${fenceId}.json`]);
  } finally { fs.open = originalOpen;syncBuiltinESMExports();await rm(root, { recursive: true, force: true }); }
});

test('uncertain, malformed or foreign fence responses preserve the pending checkpoint byte for byte', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dharma-fence-rejection-'));
  try {
    const scope = { organizationId: 'org_fixture', ...ids }, outboxRoot = join(root, 'outbox');
    const path = join(outboxRoot, `${ids.workspaceId}.json`), generation = '67f61652-a5eb-46e4-930c-9478cd4a9c31';
    const restoration = { planHash: `sha256:${'b'.repeat(64)}`, localSnapshotHash: `sha256:${'c'.repeat(64)}`,
      baselineSnapshotHash: null, previousOperationId: null, priorReleaseId: '87f61652-a5eb-46e4-930c-9478cd4a9c31' };
    const transport = { signedGet: async () => ({}), signedPost: async () => { throw new Error('lost_upload'); } };
    const input = { transport, outboxRoot, scope, snapshot: await snapshot(root), initialRepository: false,
      expectedLatestSourceFingerprint: `sha256:${'a'.repeat(64)}`, restoration };
    await assert.rejects(synchronizeRepositoryCandidate(input), /lost_upload/);
    const original = await readFile(path, 'utf8'), pending = { ...JSON.parse(original), fenceRequestGenerationId: generation };
    const before = canonicalize(pending) + '\n';
    const fence = { fenceId: 'a7f61652-a5eb-46e4-930c-9478cd4a9c31', operationId: pending.operationId,
      workspaceId: scope.workspaceId, repositoryBindingId: scope.repositoryBindingId, repositoryAgentId: scope.repositoryAgentId,
      sourceSnapshotHash: pending.snapshotHash, sourceManifestHash: pending.sourceManifestHash, policyGenerationId: generation,
      state: 'fenced', createdAt: '2030-01-02T00:00:00.000Z' };
    for (const value of [null, { candidate: null, fence: null }, { candidate: {}, fence },
      { candidate: null, fence: { ...fence, policyGenerationId: scope.workspaceId } },
      { candidate: null, fence: { ...fence, sourceManifestHash: `sha256:${'f'.repeat(64)}` } },
      { candidate: null, fence: { ...fence, privateKey: 'synthetic-must-not-be-retained' } }]) {
      const transport = { signedGet: async () => ({}), signedPost: async () => {
        if (!value) throw new Error('lost_fence_reply');
        return { ok: true, organizationId: scope.organizationId, ...value };
      } };
      await assert.rejects(fenceRepositoryRestorationUpload({ transport, outboxRoot, scope, planHash: restoration.planHash,
        policyGenerationId: generation, expectedPreviousOperationId: null }));
      assert.equal(await readFile(path, 'utf8'), before);
    }
    const transportWon = { signedGet: async () => ({}), signedPost: async () => ({ ok: true,
      organizationId: scope.organizationId, fence: null, candidate: { candidateId: scope.repositoryAgentId,
        operationId: pending.operationId, snapshotHash: pending.snapshotHash, state: 'accepted', releaseId: null } }) };
    const won = await fenceRepositoryRestorationUpload({ transport: transportWon, outboxRoot, scope,
      planHash: restoration.planHash, policyGenerationId: generation, expectedPreviousOperationId: null });
    assert.equal(won.fence, null);assert.equal(won.candidate?.state, 'accepted');
    await assert.rejects(checkpointRepositoryRestorationFence({ outboxRoot, scope, fenced: won }), /checkpoint changed/);
    assert.equal(await readFile(path, 'utf8'), before);
    const transportFenced = { signedGet: async () => ({}), signedPost: async () => ({ ok: true,
      organizationId: scope.organizationId, candidate: null, fence }) };
    const terminal = await fenceRepositoryRestorationUpload({ transport: transportFenced, outboxRoot, scope,
      planHash: restoration.planHash, policyGenerationId: generation, expectedPreviousOperationId: null });
    const changed = JSON.stringify({ ...pending, restoration: { ...restoration, planHash: `sha256:${'e'.repeat(64)}` } });
    await writeFile(path, changed);
    await assert.rejects(checkpointRepositoryRestorationFence({ outboxRoot, scope, fenced: terminal }), /checkpoint changed/);
    assert.equal(await readFile(path, 'utf8'), changed);
    await writeFile(path, before);await mkdir(join(outboxRoot, 'fenced'));
    await writeFile(join(outboxRoot, 'fenced', `${ids.workspaceId}.${fence.fenceId}.json`), 'conflicting archive');
    await assert.rejects(checkpointRepositoryRestorationFence({ outboxRoot, scope, fenced: terminal }), /archive changed/);
    assert.equal(await readFile(path, 'utf8'), before);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('durable restoration checkpoint recovers a terminal receipt by exact scoped GET without reposting', async () => {
  for (const state of ['published', 'blocked'] as const) {
    const root = await mkdtemp(join(tmpdir(), 'dharma-restoration-replay-'));
    try {
      const scope = { organizationId: 'org_fixture', ...ids }, calls: string[] = [];
      const restoration = { planHash: `sha256:${'b'.repeat(64)}`, localSnapshotHash: `sha256:${'c'.repeat(64)}`,
        baselineSnapshotHash: null, previousOperationId: null, priorReleaseId: '87f61652-a5eb-46e4-930c-9478cd4a9c31' };
      let accepted: Record<string, unknown> = {};
      const transport = {
        signedPost: async (_route: string, body: unknown) => {
          calls.push('POST');const request = body as Record<string, unknown>;
          assert.equal(Object.hasOwn(request, 'restoration'), false);
          const journal = JSON.parse(await readFile(join(root, 'outbox', `${ids.workspaceId}.json`), 'utf8'));
          assert.deepEqual(journal.restoration, restoration);assert.equal(journal.state, 'pending_upload');
          accepted = { candidateId: '77f61652-a5eb-46e4-930c-9478cd4a9c31', operationId: request.operationId,
            snapshotHash: request.sourceSnapshotHash, state, releaseId: state === 'published' ? '97f61652-a5eb-46e4-930c-9478cd4a9c31' : null };
          return { ok: true, organizationId: scope.organizationId, candidate: accepted };
        },
        signedGet: async (route: string) => {
          calls.push('GET');assert.ok(route.includes(`/package-candidates/${accepted.candidateId}?workspaceId=${ids.workspaceId}&operationId=`));
          return { ok: true, organizationId: scope.organizationId, candidate: accepted };
        },
      };
      const input = { transport, outboxRoot: join(root, 'outbox'), scope,
        snapshot: await snapshot(root), initialRepository: false, expectedLatestSourceFingerprint: `sha256:${'a'.repeat(64)}`, restoration };
      await synchronizeRepositoryCandidate(input);
      for (let replay = 0; replay < 2; replay++) {
        const recovered = await recoverRepositoryRestorationCandidate({ ...input, planHash: restoration.planHash });
        assert.deepEqual(recovered?.candidate, accepted);assert.equal(recovered?.localSnapshotHash, restoration.localSnapshotHash);
      }
      assert.equal(await recoverRepositoryRestorationCandidate({ ...input, planHash: `sha256:${'d'.repeat(64)}` }), null);
      assert.deepEqual(calls, ['POST', 'GET', 'GET']);
      const path = join(root, 'outbox', `${ids.workspaceId}.json`), journal = JSON.parse(await readFile(path, 'utf8'));
      journal.operationId = `sha256:${'e'.repeat(64)}`;await writeFile(path, JSON.stringify(journal));
      await assert.rejects(recoverRepositoryRestorationCandidate({ ...input, planHash: restoration.planHash }), /checkpoint operation/);
      assert.deepEqual(calls, ['POST', 'GET', 'GET']);
      journal.scope.repositoryAgentId = '97f61652-a5eb-46e4-930c-9478cd4a9c31';await writeFile(path, JSON.stringify(journal));
      await assert.rejects(recoverRepositoryRestorationCandidate({ ...input, planHash: restoration.planHash }), /outbox scope/);
    } finally { await rm(root, { recursive: true, force: true }); }
  }
});
test('review regression: encoded candidate respects the relay body limit before checkpoint or transport', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dharma-candidate-body-limit-'));
  try {
    const outboxRoot = join(root, 'outbox');let posts = 0;
    const inventory = await snapshot(root, 13);
    const serializedBytes = Buffer.byteLength(canonicalize(inventory));
    assert.ok(serializedBytes > 4_194_304 && serializedBytes < 8_388_608);
    const transport = { signedGet: async () => ({}), signedPost: async () => {
      posts++;throw new Error('oversized upload reached transport');
    } };
    await assert.rejects(synchronizeRepositoryCandidate({ transport, outboxRoot,
      scope: { organizationId: 'org_fixture', ...ids }, snapshot: inventory, initialRepository: true }), /upload byte limit/);
    const bytesPerFile = 262_000 - Math.ceil((serializedBytes - 4_194_304 + 100) * 3 / 4 / 13);
    const nearLimit = await snapshot(root, 13, bytesPerFile);
    const remaining = 4_194_304 - Buffer.byteLength(canonicalize(nearLimit));
    assert.ok(remaining > 0 && remaining < 200, `Snapshot boundary margin: ${remaining}`);
    await assert.rejects(synchronizeRepositoryCandidate({ transport, outboxRoot,
      scope: { organizationId: 'org_fixture', ...ids }, snapshot: nearLimit, initialRepository: true }), /upload byte limit/);
    assert.equal(posts, 0);
    await assert.rejects(readFile(join(outboxRoot, `${ids.workspaceId}.json`)), { code: 'ENOENT' });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('lost fence response recovers durable request provenance across repeated policy rollover', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dharma-fence-lost-response-'));
  try {
    const scope = { organizationId: 'org_fixture', ...ids }, outboxRoot = join(root, 'outbox');
    const path = join(outboxRoot, `${ids.workspaceId}.json`);
    const firstGeneration = '67f61652-a5eb-46e4-930c-9478cd4a9c31';
    const laterGeneration = '97f61652-a5eb-46e4-930c-9478cd4a9c31';
    const fenceId = 'a7f61652-a5eb-46e4-930c-9478cd4a9c31';
    const restoration = { planHash: `sha256:${'b'.repeat(64)}`, localSnapshotHash: `sha256:${'c'.repeat(64)}`,
      baselineSnapshotHash: null, previousOperationId: null, priorReleaseId: '87f61652-a5eb-46e4-930c-9478cd4a9c31' };
    let posts = 0;
    const transport = { signedGet: async () => ({}), signedPost: async (route: string, raw: unknown) => {
      if (!route.endsWith('/fence')) throw new Error('lost_upload');
      const body = raw as Record<string, unknown>;
      const saved = JSON.parse(await readFile(path, 'utf8'));
      assert.equal(saved.fenceRequestGenerationId, firstGeneration, 'request provenance must be durable before POST');
      assert.equal(body.requestPolicyGenerationId, firstGeneration);
      if (++posts === 1) throw new Error('lost_successful_fence_response');
      return { ok: true, organizationId: scope.organizationId, candidate: null, fence: { fenceId,
        operationId: body.operationId, ...ids, sourceSnapshotHash: body.sourceSnapshotHash,
        sourceManifestHash: body.sourceManifestHash, policyGenerationId: firstGeneration,
        requestPolicyGenerationId: firstGeneration, state: 'fenced', createdAt: '2030-01-02T00:00:00.000Z' } };
    } };
    const upload = { scope, outboxRoot, transport, snapshot: await snapshot(root),
      initialRepository: false, expectedLatestSourceFingerprint: `sha256:${'a'.repeat(64)}`, restoration };
    await assert.rejects(synchronizeRepositoryCandidate(upload), /lost_upload/);
    const input = { scope, outboxRoot, transport, planHash: restoration.planHash,
      policyGenerationId: firstGeneration, expectedPreviousOperationId: null };
    await assert.rejects(fenceRepositoryRestorationUpload(input), /lost_successful_fence_response/);
    const pending = await readFile(path, 'utf8');
    await assert.rejects(synchronizeRepositoryCandidate(upload), /fence outcome must be reconciled/);
    const recovered = await fenceRepositoryRestorationUpload({ ...input, policyGenerationId: laterGeneration });
    assert.equal(await readFile(path, 'utf8'), pending);
    assert.equal(recovered.fence?.policyGenerationId, firstGeneration);
    await checkpointRepositoryRestorationFence({ scope, outboxRoot, fenced: recovered });
    const archivePath = join(outboxRoot, 'fenced', `${ids.workspaceId}.${fenceId}.json`);
    const archive = await readFile(archivePath, 'utf8');
    const replay = await fenceRepositoryRestorationUpload({ ...input, policyGenerationId: scope.workspaceId });
    await checkpointRepositoryRestorationFence({ scope, outboxRoot, fenced: replay });
    assert.equal(posts, 2);assert.equal(await readFile(archivePath, 'utf8'), archive);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('review regression: checkpointed fence replay retains its admitted generation after policy rollover', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dharma-fence-policy-rollover-'));
  try {
    const scope = { organizationId: 'org_fixture', ...ids }, outboxRoot = join(root, 'outbox');
    const generation = '67f61652-a5eb-46e4-930c-9478cd4a9c31';
    const currentGeneration = '97f61652-a5eb-46e4-930c-9478cd4a9c31';
    const fenceId = 'a7f61652-a5eb-46e4-930c-9478cd4a9c31';let rolledOver = false, fencePosts = 0;
    const restoration = { planHash: `sha256:${'b'.repeat(64)}`, localSnapshotHash: `sha256:${'c'.repeat(64)}`,
      baselineSnapshotHash: null, previousOperationId: null, priorReleaseId: '87f61652-a5eb-46e4-930c-9478cd4a9c31' };
    const transport = { signedGet: async () => ({}), signedPost: async (route: string, raw: unknown) => {
      if (!route.endsWith('/fence')) throw new Error('lost_upload');
      fencePosts++;
      if (rolledOver) throw new Error('HTTP 403: fabric_repository_candidate_fence_binding_denied');
      const body = raw as Record<string, unknown>;
      return { ok: true, organizationId: scope.organizationId, candidate: null, fence: { fenceId,
        operationId: body.operationId, ...ids, sourceSnapshotHash: body.sourceSnapshotHash,
        sourceManifestHash: body.sourceManifestHash, policyGenerationId: generation,
        state: 'fenced', createdAt: '2030-01-02T00:00:00.000Z' } };
    } };
    await assert.rejects(synchronizeRepositoryCandidate({ scope, outboxRoot, transport, snapshot: await snapshot(root),
      initialRepository: false, expectedLatestSourceFingerprint: `sha256:${'a'.repeat(64)}`, restoration }), /lost_upload/);
    const input = { scope, outboxRoot, transport, planHash: restoration.planHash,
      policyGenerationId: generation, expectedPreviousOperationId: null };
    const fenced = await fenceRepositoryRestorationUpload(input);
    await checkpointRepositoryRestorationFence({ scope, outboxRoot, fenced });
    const path = join(outboxRoot, `${ids.workspaceId}.json`);
    const archivePath = join(outboxRoot, 'fenced', `${ids.workspaceId}.${fenceId}.json`);
    const before = await readFile(path, 'utf8'), archiveBefore = await readFile(archivePath, 'utf8');
    rolledOver = true;
    const replay = await fenceRepositoryRestorationUpload({ ...input, policyGenerationId: currentGeneration });
    assert.deepEqual(replay.fence, fenced.fence);
    await checkpointRepositoryRestorationFence({ scope, outboxRoot, fenced: replay });
    assert.equal(fencePosts, 1);
    assert.equal(await readFile(path, 'utf8'), before);
    assert.equal(await readFile(archivePath, 'utf8'), archiveBefore);
    const tampered = JSON.parse(before);tampered.fence.policyGenerationId = currentGeneration;
    tampered.fenceRequestGenerationId = currentGeneration;
    await writeFile(path, canonicalize(tampered) + '\n');
    const tamperedBytes = await readFile(path, 'utf8');
    const changed = await fenceRepositoryRestorationUpload({ ...input, policyGenerationId: currentGeneration });
    await assert.rejects(checkpointRepositoryRestorationFence({ scope, outboxRoot, fenced: changed }), /archive changed/);
    assert.equal(await readFile(path, 'utf8'), tamperedBytes);
    assert.equal(await readFile(archivePath, 'utf8'), archiveBefore);assert.equal(fencePosts, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});

async function snapshot(root: string, largeFiles = 0, largeFileBytes = 262_000) {
  const workspace = join(root, 'repository');
  await mkdir(join(workspace, '.agents/skills/dharma-agent-fabric'), { recursive: true });
  await writeFile(join(workspace, '.agents/skills/dharma-agent-fabric/.dharma-agent-fabric.json'),
    JSON.stringify({ managedBy: 'dharma-agent-fabric', workspaceId: ids.workspaceId }));
  await writeFile(join(workspace, 'README.md'), '# Governed repository\n');
  const largePaths = Array.from({ length: largeFiles }, (_, index) => `source-${index}.txt`);
  for (const [index, path] of largePaths.entries()) {
    await writeFile(join(workspace, path), `${index}:` + 'x'.repeat(largeFileBytes));
  }
  const operation = { action: 'authorize', confirmed: true,
    requestId: '5ff2ee1b-6cb3-459e-a977-ea99c757bf30', repositoryBindingId: ids.repositoryBindingId,
    expectedRevision: 0, allowedContentClasses: ['approved_outputs', 'repository_content', 'repository_skills'],
    approvedRepositoryPaths: ['README.md', ...largePaths].sort(), approvedOutputFolders: [], automaticValidatedPublication: true,
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

test('review regression: terminal restoration cannot be replaced before registry reconciliation', async () => {
  for (const state of ['published', 'blocked'] as const) {
    const root = await mkdtemp(join(tmpdir(), 'dharma-terminal-restoration-'));
    try {
      const scope = { organizationId: 'org_fixture', ...ids }, outboxRoot = join(root, 'outbox');
      const restoration = { planHash: `sha256:${'b'.repeat(64)}`, localSnapshotHash: `sha256:${'c'.repeat(64)}`,
        baselineSnapshotHash: null, previousOperationId: null, priorReleaseId: '87f61652-a5eb-46e4-930c-9478cd4a9c31' };
      let posts = 0;
      const transport = { signedGet: async () => ({}), signedPost: async (_route: string, raw: unknown) => {
        posts++;const body = raw as Record<string, unknown>;
        return { ok: true, organizationId: scope.organizationId, candidate: {
          candidateId: '77f61652-a5eb-46e4-930c-9478cd4a9c31', operationId: body.operationId,
          snapshotHash: body.sourceSnapshotHash, state, releaseId: state === 'published' ? '97f61652-a5eb-46e4-930c-9478cd4a9c31' : null } };
      } };
      const input = { scope, outboxRoot, transport, snapshot: await snapshot(root), initialRepository: false,
        expectedLatestSourceFingerprint: `sha256:${'a'.repeat(64)}` };
      await synchronizeRepositoryCandidate({ ...input, restoration });
      const path = join(outboxRoot, `${ids.workspaceId}.json`), before = await readFile(path, 'utf8');
      await assert.rejects(synchronizeRepositoryCandidate({ ...input, expectedLatestSourceFingerprint: `sha256:${'e'.repeat(64)}` }),
        /registry reconciliation/);
      assert.equal(posts, 1);assert.equal(await readFile(path, 'utf8'), before);
      const candidate = (await pollRepositoryCandidate(input))!;
      await assert.rejects(adoptRepositoryCandidate({ ...input, candidate: { ...candidate, operationId: `sha256:${'e'.repeat(64)}` },
        sourceManifestHash: JSON.parse(before).sourceManifestHash, consolidationMode: 'repository_update' }), /registry reconciliation/);
      await adoptRepositoryCandidate({ ...input, candidate, sourceManifestHash: JSON.parse(before).sourceManifestHash,
        consolidationMode: 'repository_update' });
      assert.equal(await readFile(path, 'utf8'), before);
    } finally { await rm(root, { recursive: true, force: true }); }
  }
});

test('real guarded registry and durable outbox retain a terminal response across failed save and resumed scan', async () => {
  const indexText = await readFile(new URL('../src/index.ts', import.meta.url), 'utf8');
  const indexSource = ts.createSourceFile('index.ts', indexText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const helpers = ['saveWorkspaceRecord', 'saveRegistry', 'writeJsonAtomic', 'acquirePidLock'];
  const helperCode = ts.transpileModule(indexSource.statements.filter(node => ts.isFunctionDeclaration(node)
    && node.name && helpers.includes(node.name.text)).map(node => node.getText(indexSource)).join('\n'),
  { compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.CommonJS } }).outputText;
  for (const state of ['published', 'blocked'] as const) {
    const root = await mkdtemp(join(tmpdir(), 'dharma-real-registry-outbox-'));
    try {
      const scope = { organizationId: 'org_fixture', ...ids }, outboxRoot = join(root, 'outbox');
      const registryPath = join(root, 'registry', 'workspaces.json'), inventory = await snapshot(root);
      const original = { ...scope, repositoryPackage: { operationId: null, state: 'published', generation: 18 } };
      const sibling = { workspaceId: 'sibling', marker: 'preserve' };
      await mkdir(dirname(registryPath), { recursive: true });
      await writeFile(registryPath, JSON.stringify([original, sibling]));
      const restoration = { planHash: `sha256:${'b'.repeat(64)}`, localSnapshotHash: inventory.manifest.snapshotHash,
        baselineSnapshotHash: null, previousOperationId: null, priorReleaseId: '87f61652-a5eb-46e4-930c-9478cd4a9c31' };
      let posts = 0, candidate: Awaited<ReturnType<typeof synchronizeRepositoryCandidate>> | undefined;
      const transport = { signedGet: async () => ({ ok: true, organizationId: scope.organizationId, candidate }),
        signedPost: async (_route: string, raw: unknown) => {
          posts++;const body = raw as Record<string, string>;
          return { ok: true, organizationId: scope.organizationId, candidate: {
            candidateId: '77f61652-a5eb-46e4-930c-9478cd4a9c31', operationId: body.operationId,
            snapshotHash: body.sourceSnapshotHash, state, releaseId: state === 'published' ? '97f61652-a5eb-46e4-930c-9478cd4a9c31' : null } };
        } };
      const input = { scope, outboxRoot, transport, snapshot: inventory, initialRepository: false,
        expectedLatestSourceFingerprint: `sha256:${'a'.repeat(64)}` };
      const resumedScan = () => synchronizeRepositoryCandidate({ ...input, expectedLatestSourceFingerprint: `sha256:${'e'.repeat(64)}` });
      let failRegistry = true, interleavingObserved = false;
      const save = runInNewContext(helperCode + '\nsaveWorkspaceRecord', { exports: {}, ...fs, structuredClone, canonicalize,
        dirname, resolve, process, randomUUID, setTimeout, currentBootstrapHostScope: () => undefined,
        dharmaHome: () => root, workspaceRegistryPath: () => registryPath,
        rename: async (from: string, to: string) => {
          if (to === registryPath && failRegistry) {
            await assert.rejects(resumedScan(), /registry reconciliation/);interleavingObserved = true;
            throw new Error('injected_registry_rename_failure');
          }
          return fs.rename(from, to);
        },
      }, { timeout: 1000, contextCodeGeneration: { strings: false, wasm: false } }) as
        (record: unknown, guard: { expected: unknown; beforeSave?: () => Promise<void>;
          preparePackage?: () => Promise<unknown>; afterSave?: (record: any) => Promise<void> }) => Promise<void>;
      let admissionEntered = false;
      await assert.rejects(save(original, { expected: { ...original, repositoryPackage: { operationId: 'stale' } },
        preparePackage: async () => { admissionEntered = true;await synchronizeRepositoryCandidate({ ...input, restoration }); } }), /compare_and_swap/);
      assert.equal(admissionEntered, false);assert.equal(posts, 0);
      const packageFor = (receipt: NonNullable<typeof candidate>) => ({ ...receipt,
        sourceManifestHash: sha256(canonicalize(inventory.manifest)), consolidationMode: 'repository_update', generation: 18,
        localBaselineSnapshotHash: state === 'blocked' ? null : restoration.localSnapshotHash,
        publishedLocalSnapshotHash: state === 'published' ? restoration.localSnapshotHash : null,
        pendingLocalSnapshotHash: null, pendingLocalOperationId: null });
      await assert.rejects(save(original, { expected: original, preparePackage: async () => {
        candidate = await synchronizeRepositoryCandidate({ ...input, restoration });return packageFor(candidate);
      }, afterSave: saved => checkpointRepositoryRestorationRegistry({ ...input, repositoryPackage: saved.repositoryPackage }) }), /injected_registry_rename_failure/);
      assert.equal(interleavingObserved, true);assert.equal(posts, 1);
      assert.deepEqual(JSON.parse(await readFile(registryPath, 'utf8')), [original, sibling]);
      const path = join(outboxRoot, `${ids.workspaceId}.json`), before = await readFile(path, 'utf8');
      assert.equal(JSON.parse(before).registryReceiptHash, undefined);
      await assert.rejects(resumedScan(), /registry reconciliation/);assert.equal(await readFile(path, 'utf8'), before);
      const recovered = (await recoverRepositoryRestorationCandidate({ ...input, planHash: restoration.planHash }))!;
      failRegistry = false;
      await save({ ...original, repositoryPackage: packageFor(recovered.candidate) }, { expected: original,
        beforeSave: async () => { await checkpointRepositoryRestorationCandidate({ ...input, recovered }); },
        afterSave: saved => checkpointRepositoryRestorationRegistry({ ...input, repositoryPackage: saved.repositoryPackage }) });
      assert.equal(posts, 1);assert.match(JSON.parse(await readFile(path, 'utf8')).registryReceiptHash, /^sha256:/);
      const rows = JSON.parse(await readFile(registryPath, 'utf8'));
      assert.deepEqual(rows.find((row: { workspaceId: string }) => row.workspaceId === 'sibling'), sibling);
      assert.equal(rows.find((row: { workspaceId: string }) => row.workspaceId === scope.workspaceId).repositoryPackage.operationId, candidate!.operationId);
      await resumedScan();assert.equal(posts, 2);
      await assert.rejects(fs.lstat(`${registryPath}.mutation.lock`), { code: 'ENOENT' });
    } finally { await rm(root, { recursive: true, force: true }); }
  }
});

test('candidate upload schema validates actual legacy and restoration wire bodies and rejects malformed provenance', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dharma-candidate-upload-contract-'));
  try {
    const scope = { organizationId: 'org_fixture', ...ids }, inventory = await snapshot(root);
    const attemptId = 'a7f61652-a5eb-46e4-930c-9478cd4a9c31', headCandidateId = 'b7f61652-a5eb-46e4-930c-9478cd4a9c31';
    const restoration = { planHash: `sha256:${'b'.repeat(64)}`, localSnapshotHash: inventory.manifest.snapshotHash,
      baselineSnapshotHash: null, previousOperationId: null, priorReleaseId: '87f61652-a5eb-46e4-930c-9478cd4a9c31', attemptId, headCandidateId };
    const schemaDirectory = new URL('./schemas/', import.meta.url);
    for (const mode of ['legacy-initial', 'legacy-update', 'restoration'] as const) {
      let body: Record<string, any> = {};
      await synchronizeRepositoryCandidate({ scope, snapshot: inventory, outboxRoot: join(root, mode),
        initialRepository: mode === 'legacy-initial',
        ...(mode !== 'legacy-initial' ? { expectedLatestSourceFingerprint: `sha256:${'a'.repeat(64)}` } : {}),
        ...(mode === 'restoration' ? { restoration } : {}),
        transport: { signedGet: async () => ({}), signedPost: async (_route, raw) => {
          body = raw as typeof body;return { ok: true, organizationId: scope.organizationId, candidate: {
            candidateId: '77f61652-a5eb-46e4-930c-9478cd4a9c31', operationId: body.operationId,
            snapshotHash: body.sourceSnapshotHash, state: 'accepted', releaseId: null } };
        } } });
      const validate = (value: unknown) => validateContract(fileURLToPath(schemaDirectory),
        'https://schemas.dharma-ai.io/repository-candidate-upload/v1', value);
      assert.equal((await validate(body)).ok, true);
      if (mode === 'restoration') {
        assert.equal(body.restorationAttempt, attemptId);assert.equal(body.restorationContext.headCandidateId, headCandidateId);
        for (const changed of [
          { ...body, restorationAttempt: `${attemptId}\n` }, { ...body, restorationContext: { ...body.restorationContext, token: 'forbidden' } },
          { ...body, restorationContext: { priorReleaseId: restoration.priorReleaseId } },
          { ...body, consolidation: { ...body.consolidation, mode: 'initial_repository' } },
          { ...body, consolidation: { mode: 'repository_update', includeApprovedOutputs: true, requireAtlasAssociation: true } },
          { ...body, snapshot: { ...body.snapshot, privateKey: 'forbidden' } },
        ]) assert.equal((await validate(changed)).ok, false);
      } else assert.equal(body.restorationContext, undefined);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('a terminal poll invalidates the previous registry marker and preserves provenance until its exact reconciliation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dharma-restoration-marker-'));
  try {
    const scope = { organizationId: 'org_fixture', ...ids }, outboxRoot = join(root, 'outbox'), inventory = await snapshot(root);
    const restoration = { planHash: `sha256:${'b'.repeat(64)}`, localSnapshotHash: inventory.manifest.snapshotHash,
      baselineSnapshotHash: null, previousOperationId: null, priorReleaseId: '87f61652-a5eb-46e4-930c-9478cd4a9c31' };
    let terminal = false;
    let candidate: Awaited<ReturnType<typeof synchronizeRepositoryCandidate>>;
    const input = { scope, outboxRoot, snapshot: inventory, initialRepository: false, expectedLatestSourceFingerprint: `sha256:${'a'.repeat(64)}`,
      transport: { signedPost: async (_route: string, raw: unknown) => {
        const body = raw as Record<string, string>;return { ok: true, organizationId: scope.organizationId, candidate: {
          candidateId: '77f61652-a5eb-46e4-930c-9478cd4a9c31', operationId: body.operationId,
          snapshotHash: body.sourceSnapshotHash, state: 'accepted', releaseId: null } };
      }, signedGet: async () => ({ ok: true, organizationId: scope.organizationId,
        candidate: terminal ? { ...candidate, state: 'published', releaseId: '97f61652-a5eb-46e4-930c-9478cd4a9c31' } : candidate }) } };
    candidate = await synchronizeRepositoryCandidate({ ...input, restoration });
    const saved = { ...candidate, sourceManifestHash: sha256(canonicalize(inventory.manifest)), consolidationMode: 'repository_update',
      localBaselineSnapshotHash: restoration.localSnapshotHash, publishedLocalSnapshotHash: null,
      pendingLocalSnapshotHash: restoration.localSnapshotHash, pendingLocalOperationId: candidate.operationId };
    await checkpointRepositoryRestorationRegistry({ ...input, repositoryPackage: saved });
    terminal = true;candidate = (await pollRepositoryCandidate(input))!;
    const path = join(outboxRoot, `${ids.workspaceId}.json`), before = await readFile(path, 'utf8');
    await assert.rejects(synchronizeRepositoryCandidate({ ...input, expectedLatestSourceFingerprint: `sha256:${'e'.repeat(64)}` }), /registry reconciliation/);
    await assert.rejects(checkpointRepositoryRestorationRegistry({ ...input, repositoryPackage: saved }), /registry receipt/);
    assert.equal(await readFile(path, 'utf8'), before);
    const terminalSaved = { ...saved, ...candidate, publishedLocalSnapshotHash: restoration.localSnapshotHash,
      pendingLocalSnapshotHash: null, pendingLocalOperationId: null };
    await assert.rejects(checkpointRepositoryRestorationRegistry({ ...input,
      repositoryPackage: { ...terminalSaved, localBaselineSnapshotHash: `sha256:${'e'.repeat(64)}` } }), /registry receipt/);
    assert.equal(await readFile(path, 'utf8'), before);
    await checkpointRepositoryRestorationRegistry({ ...input, repositoryPackage: terminalSaved });
    await synchronizeRepositoryCandidate({ ...input, expectedLatestSourceFingerprint: `sha256:${'e'.repeat(64)}` });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('lost terminal POST response recovers by operation lookup without a second upload', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dharma-restoration-lost-response-'));
  try {
    const scope = { organizationId: 'org_fixture', ...ids }, calls: string[] = [];
    const restoration = { planHash: `sha256:${'b'.repeat(64)}`, localSnapshotHash: `sha256:${'c'.repeat(64)}`,
      baselineSnapshotHash: null, previousOperationId: null, priorReleaseId: '87f61652-a5eb-46e4-930c-9478cd4a9c31' };
    let candidate: Record<string, unknown> | null = null;
    const transport = {
      signedPost: async (_route: string, value: unknown) => {
        calls.push('POST');const body = value as Record<string, unknown>;
        candidate = { candidateId: '77f61652-a5eb-46e4-930c-9478cd4a9c31', operationId: body.operationId,
          snapshotHash: body.sourceSnapshotHash, state: 'published', releaseId: '97f61652-a5eb-46e4-930c-9478cd4a9c31' };
        throw new Error('simulated_lost_POST_response');
      },
      signedGet: async (route: string) => {
        calls.push('GET');assert.ok(route.includes(`/package-candidates?workspaceId=${ids.workspaceId}&operationId=`));
        return { ok: true, organizationId: scope.organizationId, candidate };
      },
    };
    const input = { transport, outboxRoot: join(root, 'outbox'), scope, snapshot: await snapshot(root),
      initialRepository: false, expectedLatestSourceFingerprint: `sha256:${'a'.repeat(64)}`, restoration };
    await assert.rejects(synchronizeRepositoryCandidate(input), /simulated_lost_POST_response/);
    const journal = JSON.parse(await readFile(join(root, 'outbox', `${ids.workspaceId}.json`), 'utf8'));
    assert.equal(journal.state, 'pending_upload');assert.equal(journal.candidateId, null);
    for (let replay = 0; replay < 2; replay++) {
      assert.deepEqual((await recoverRepositoryRestorationCandidate({ ...input, planHash: restoration.planHash }))?.candidate, candidate);
    }
    assert.deepEqual(calls, ['POST', 'GET', 'GET']);
    candidate = null;
    const before = await readFile(join(root, 'outbox', `${ids.workspaceId}.json`), 'utf8');
    await assert.rejects(recoverRepositoryRestorationCandidate({ ...input, planHash: restoration.planHash }), /upload_unresolved/);
    assert.equal(await readFile(join(root, 'outbox', `${ids.workspaceId}.json`), 'utf8'), before);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('lost pending response checkpoints recovery durably and normal polling reaches publication', async () => {
  for (const initialState of ['accepted', 'processing'] as const) {
    const root = await mkdtemp(join(tmpdir(), 'dharma-restoration-pending-recovery-'));
    try {
      const scope = { organizationId: 'org_fixture', ...ids }, calls: string[] = [];
      const restoration = { planHash: `sha256:${'b'.repeat(64)}`, localSnapshotHash: `sha256:${'c'.repeat(64)}`,
        baselineSnapshotHash: null, previousOperationId: null, priorReleaseId: '87f61652-a5eb-46e4-930c-9478cd4a9c31' };
      let candidate: Record<string, unknown> = {};
      const transport = {
        signedPost: async (_route: string, value: unknown) => {
          calls.push('POST');const body = value as Record<string, unknown>;
          candidate = { candidateId: '77f61652-a5eb-46e4-930c-9478cd4a9c31', operationId: body.operationId,
            snapshotHash: body.sourceSnapshotHash, state: initialState, releaseId: null };
          throw new Error('simulated_lost_POST_response');
        },
        signedGet: async (route: string) => {
          calls.push(route);return { ok: true, organizationId: scope.organizationId, candidate };
        },
      };
      const input = { transport, outboxRoot: join(root, 'outbox'), scope, snapshot: await snapshot(root),
        initialRepository: false, expectedLatestSourceFingerprint: `sha256:${'a'.repeat(64)}`, restoration };
      await assert.rejects(synchronizeRepositoryCandidate(input), /simulated_lost_POST_response/);
      assert.equal(await pollRepositoryCandidate(input), null);
      const recovered = await recoverRepositoryRestorationCandidate({ ...input, planHash: restoration.planHash });
      assert.ok(recovered);
      await checkpointRepositoryRestorationCandidate({ ...input, recovered });
      // Simulate a registry-write crash after the durable checkpoint: retry
      // must recover by candidate ID with all restoration provenance intact.
      const retried = await recoverRepositoryRestorationCandidate({ ...input, planHash: restoration.planHash });
      assert.deepEqual(retried, recovered);
      await checkpointRepositoryRestorationCandidate({ ...input, recovered: retried! });
      candidate = { ...candidate, state: 'processing' };
      assert.equal((await pollRepositoryCandidate(input))?.state, 'processing');
      candidate = { ...candidate, state: 'published', releaseId: '97f61652-a5eb-46e4-930c-9478cd4a9c31' };
      assert.equal((await pollRepositoryCandidate(input))?.state, 'published');
      const path = join(input.outboxRoot, `${scope.workspaceId}.json`), bytes = await readFile(path, 'utf8');
      const stored = JSON.parse(bytes);
      assert.equal(stored.candidateId, candidate.candidateId);assert.equal(stored.state, 'published');
      assert.deepEqual(stored.restoration, restoration);
      assert.equal(calls.filter(call => call === 'POST').length, 1);
      assert.ok(calls[1]!.includes('/package-candidates?workspaceId='));
      assert.ok(calls.slice(2).every(call => call.includes(`/package-candidates/${candidate.candidateId}?`)));
      await assert.rejects(checkpointRepositoryRestorationCandidate({ ...input, recovered }), /terminal state changed/);
      assert.equal(await readFile(path, 'utf8'), bytes);
      for (const changed of [
        { ...retried!, planHash: `sha256:${'e'.repeat(64)}` },
        { ...retried!, localSnapshotHash: `sha256:${'e'.repeat(64)}` },
        { ...retried!, sourceManifestHash: `sha256:${'e'.repeat(64)}` },
        { ...retried!, candidate: { ...retried!.candidate, operationId: `sha256:${'e'.repeat(64)}` } },
        { ...retried!, candidate: { ...retried!.candidate, snapshotHash: `sha256:${'e'.repeat(64)}` } },
        { ...retried!, candidate: { ...retried!.candidate, candidateId: '97f61652-a5eb-46e4-930c-9478cd4a9c31' } },
      ]) {
        await assert.rejects(checkpointRepositoryRestorationCandidate({ ...input, recovered: changed }));
        assert.equal(await readFile(path, 'utf8'), bytes);
      }
      await assert.rejects(checkpointRepositoryRestorationCandidate({ ...input, recovered: retried!,
        scope: { ...scope, repositoryAgentId: '97f61652-a5eb-46e4-930c-9478cd4a9c31' } }), /outbox scope/);
      assert.equal(await readFile(path, 'utf8'), bytes);
    } finally { await rm(root, { recursive: true, force: true }); }
  }
});

test('empty lookup does not retire an unknown upload that can be accepted later', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dharma-restoration-late-admission-'));
  try {
    const scope = { organizationId: 'org_fixture', ...ids };
    const restoration = { planHash: `sha256:${'b'.repeat(64)}`, localSnapshotHash: `sha256:${'c'.repeat(64)}`,
      baselineSnapshotHash: null, previousOperationId: null, priorReleaseId: '87f61652-a5eb-46e4-930c-9478cd4a9c31' };
    let serverCandidate: Record<string, unknown> | null = null, admitLate = () => {}, posts = 0;
    const transport = { signedPost: async (_route: string, body: unknown) => {
      posts++;const request = body as Record<string, unknown>;
      admitLate = () => { serverCandidate = { candidateId: '77f61652-a5eb-46e4-930c-9478cd4a9c31', operationId: request.operationId,
        snapshotHash: request.sourceSnapshotHash, state: 'processing', releaseId: null }; };
      throw new Error('transport_outcome_unknown');
    }, signedGet: async () => ({ ok: true, organizationId: scope.organizationId, candidate: serverCandidate }) };
    const input = { transport, scope, outboxRoot: join(root, 'outbox'), snapshot: await snapshot(root),
      initialRepository: false, expectedLatestSourceFingerprint: `sha256:${'a'.repeat(64)}`, restoration };
    await assert.rejects(synchronizeRepositoryCandidate(input), /outcome_unknown/);
    const path = join(input.outboxRoot, `${scope.workspaceId}.json`), before = await readFile(path, 'utf8');
    await assert.rejects(recoverRepositoryRestorationCandidate({ ...input, planHash: restoration.planHash }), /upload_unresolved/);
    assert.equal(await readFile(path, 'utf8'), before);
    admitLate();
    const recovered = await recoverRepositoryRestorationCandidate({ ...input, planHash: restoration.planHash });
    assert.ok(recovered);await checkpointRepositoryRestorationCandidate({ ...input, recovered });
    assert.equal((await pollRepositoryCandidate(input))?.state, 'processing');assert.equal(posts, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('archived release identity is rejected at upload, recovery, checkpoint and normal polling', async () => {
  for (const phase of ['upload', 'recovery', 'checkpoint', 'poll', 'terminal-poll']) {
    const root = await mkdtemp(join(tmpdir(), 'dharma-restoration-archived-release-'));
    try {
      const scope = { organizationId: 'org_fixture', ...ids };
      const restoration = { planHash: `sha256:${'b'.repeat(64)}`, localSnapshotHash: `sha256:${'c'.repeat(64)}`,
        baselineSnapshotHash: null, previousOperationId: null, priorReleaseId: '87f61652-a5eb-46e4-930c-9478cd4a9c31' };
      let candidate: Record<string, unknown> = {};
      const transport = { signedPost: async (_route: string, body: unknown) => {
        const request = body as Record<string, unknown>;
        candidate = { candidateId: '77f61652-a5eb-46e4-930c-9478cd4a9c31', operationId: request.operationId,
          snapshotHash: request.sourceSnapshotHash, state: 'published', releaseId: restoration.priorReleaseId };
        return { ok: true, organizationId: scope.organizationId,
          candidate: phase === 'upload' ? candidate : { ...candidate, state: 'accepted', releaseId: null } };
      }, signedGet: async () => ({ ok: true, organizationId: scope.organizationId, candidate }) };
      const input = { transport, scope, outboxRoot: join(root, 'outbox'), snapshot: await snapshot(root),
        initialRepository: false, expectedLatestSourceFingerprint: `sha256:${'a'.repeat(64)}`, restoration };
      const path = join(input.outboxRoot, `${scope.workspaceId}.json`);
      if (phase === 'upload') {
        await assert.rejects(synchronizeRepositoryCandidate(input), /archived release/);
        assert.equal(JSON.parse(await readFile(path, 'utf8')).state, 'pending_upload');continue;
      }
      await synchronizeRepositoryCandidate(input);
      if (phase === 'terminal-poll') {
        const stored = JSON.parse(await readFile(path, 'utf8'));
        await writeFile(path, JSON.stringify({ ...stored, ...candidate }));
      }
      const before = await readFile(path, 'utf8');
      const operation = phase === 'recovery'
        ? recoverRepositoryRestorationCandidate({ ...input, planHash: restoration.planHash })
        : phase === 'checkpoint' ? checkpointRepositoryRestorationCandidate({ ...input, recovered: {
          ...restoration, sourceManifestHash: JSON.parse(before).sourceManifestHash,
          candidate: candidate as unknown as Awaited<ReturnType<typeof synchronizeRepositoryCandidate>> } })
          : pollRepositoryCandidate(input);
      await assert.rejects(operation, /archived release/);
      assert.equal(await readFile(path, 'utf8'), before);
    } finally { await rm(root, { recursive: true, force: true }); }
  }
});

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

test('one blocked initial candidate can be retried without another grant or unbounded resubmission', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dharma-candidate-recovery-'));
  const calls: string[] = [];
  const idsByAttempt = [
    '77f61652-a5eb-46e4-930c-9478cd4a9c31',
    '87f61652-a5eb-46e4-930c-9478cd4a9c31',
  ];
  try {
    const transport = {
      signedPost: async (_route: string, value: unknown) => {
        const body = value as Record<string, unknown>;
        calls.push('POST');
        return { ok: true, organizationId: 'org_fixture', candidate: {
          candidateId: idsByAttempt[calls.length - 1], operationId: body.operationId,
          snapshotHash: body.sourceSnapshotHash, state: 'accepted', releaseId: null,
        } };
      },
      signedGet: async () => {
        calls.push('GET');
        const stored = JSON.parse(await readFile(join(root, 'outbox', `${ids.workspaceId}.json`), 'utf8'));
        return { ok: true, organizationId: 'org_fixture', candidate: {
          candidateId: stored.candidateId, operationId: stored.operationId,
          snapshotHash: stored.snapshotHash, state: 'blocked', releaseId: null,
        } };
      },
    };
    const input = { transport, outboxRoot: join(root, 'outbox'), scope: { organizationId: 'org_fixture', ...ids },
      snapshot: await snapshot(root), initialRepository: true };
    const initial = await synchronizeRepositoryCandidate(input);
    const recovery = { ...input, blockedCandidate: { ...initial, state: 'blocked' as const } };
    const retried = await synchronizeRepositoryCandidate(recovery);
    assert.notEqual(retried.operationId, initial.operationId);
    assert.notEqual(retried.candidateId, initial.candidateId);
    const replay = await synchronizeRepositoryCandidate(recovery);
    assert.equal(replay.operationId, retried.operationId);
    assert.equal(replay.candidateId, retried.candidateId);
    assert.deepEqual(calls, ['POST', 'POST', 'GET']);
    await assert.rejects(() => synchronizeRepositoryCandidate({ ...input, blockedCandidate: initial }),
      /blocked initial publication/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('reconciled updates pin the latest source in the signed upload and durable outbox', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dharma-candidate-parent-'));
  const parent = `sha256:${'a'.repeat(64)}`;
  const candidateId = '77f61652-a5eb-46e4-930c-9478cd4a9c31';
  const requests: Record<string, unknown>[] = [];
  try {
    const candidateSnapshot = await snapshot(root);
    const transport = { signedGet: async () => ({}), signedPost: async (_route: string, value: unknown) => {
      const body = value as Record<string, unknown>;
      requests.push(body);
      return { ok: true, organizationId: 'org_fixture', candidate: { candidateId,
        operationId: body.operationId, snapshotHash: body.sourceSnapshotHash,
        state: 'accepted', releaseId: null } };
    } };
    const input = { transport, outboxRoot: join(root, 'outbox'), scope: { organizationId: 'org_fixture', ...ids },
      snapshot: candidateSnapshot, initialRepository: false, expectedLatestSourceFingerprint: parent };
    await synchronizeRepositoryCandidate(input);
    assert.deepEqual(requests[0]?.consolidation, { mode: 'repository_update', includeApprovedOutputs: true,
      requireAtlasAssociation: true, expectedLatestSourceFingerprint: parent });
    const stored = JSON.parse(await readFile(join(root, 'outbox', `${ids.workspaceId}.json`), 'utf8'));
    assert.equal(stored.consolidation.expectedLatestSourceFingerprint, parent);
    await assert.rejects(synchronizeRepositoryCandidate({ ...input, initialRepository: true }), /expected source parent/);
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
