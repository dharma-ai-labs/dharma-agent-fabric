import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { canonicalize } from '@dharma-ai-labs/agent-fabric-contracts';
import { checkpointRepositoryRestorationCandidate, pollRepositoryCandidate, recoverRepositoryRestorationCandidate, synchronizeRepositoryCandidate } from './repositoryCandidateSync.js';
import { inventoryRepositoryPackage } from './repositoryPackage.js';
import { initializeRepositoryKnowledge } from './repositoryKnowledge.js';

const ids = {
  workspaceId: '056b63dc-ebed-48ed-85d8-02c72f623ea8',
  repositoryBindingId: '73a95988-fd64-41ba-a0b9-6c8867d03788',
  repositoryAgentId: '57f61652-a5eb-46e4-930c-9478cd4a9c31',
};

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
