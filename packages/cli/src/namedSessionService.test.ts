import assert from 'node:assert/strict';
import { generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { LocalVault, type LocalProviderSessionBinding } from '@dharma-ai-labs/agent-fabric-local-vault';
import { signCanonicalObject, validateContract } from '@dharma-ai-labs/agent-fabric-contracts';
import { namedSessionPaths, namedSessionRequest, readNamedSession, runNamedSessionService, saveNamedSession,
  type NamedSessionRegistration } from './namedSessionService.js';
import { queueNamedSessionEvidence } from './namedSessionEvidence.js';

test('durable named registration excludes credentials, grants and foreign shape', async () => {
  const home = await mkdtemp(join(process.platform === 'darwin' ? '/tmp' : tmpdir(), 'dhr-'));
  const identity = { organizationId: 'org_test', repositoryBindingId: randomUUID(), workspaceId: randomUUID(),
    endpointId: randomUUID(), membershipId: randomUUID(), deviceId: randomUUID(), provider: 'codex' as const };
  const good: NamedSessionRegistration = { schema: 'dharma.named-session/v1', name: 'reviewer', bindingId: randomUUID(),
    identity, maximumCostCents: 100, maximumTurnCostCents: 25, enabled: true };
  await saveNamedSession(home, good);
  for (const invalid of [{ ...good, grant: 'private-fixture' }, { ...good, maximumTurnCostCents: 101 },
    { ...good, identity: { ...identity, credential: 'private-fixture' } },
    { ...good, identity: { ...identity, membershipId: 'unbound-email' } }]) {
    await assert.rejects(saveNamedSession(home, invalid as NamedSessionRegistration), /registration_invalid/);
    assert.deepEqual(await readNamedSession(home, 'reviewer'), good);
  }
  await writeFile(namedSessionPaths(home, 'reviewer').registration, JSON.stringify({ ...good, grant: 'private-fixture' }));
  await assert.rejects(readNamedSession(home, 'reviewer'), /registration_invalid/);
});

test('named session socket paths remain bounded without relaxing identity validation', () => {
  assert.throws(() => namedSessionPaths('/tmp/' + 'x'.repeat(100), 'reviewer'), /socket_path_too_long/);
  assert.throws(() => namedSessionPaths('/tmp/dhr', '../foreign'), /name_invalid/);
  assert.ok(Buffer.byteLength(namedSessionPaths('/tmp/dhr', 'reviewer').socket) <= 103);
});

for (const queueFailure of [false, true]) for (const failWork of [false, true]) test((failWork
  ? 'named session retains failed native work evidence and its reservation without replay'
  : 'named session serializes local work and signed peer questions with per-turn permissions')
    + (queueFailure ? ' with blocked evidence synchronization' : ' with encrypted outbox synchronization'),
  { skip: process.platform !== 'linux' }, async () => {
    const home = await mkdtemp(join(tmpdir(), 'dharma-named-'));
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const identity = { organizationId: 'org_test', repositoryBindingId: randomUUID(), workspaceId: randomUUID(),
      endpointId: randomUUID(), membershipId: randomUUID(), deviceId: randomUUID(), provider: 'codex' as const };
    const binding: LocalProviderSessionBinding = { schema: 'dharma.local-provider-session-binding/v1', ...identity,
      bindingId: randomUUID(), owner: 'dharma_bridge', sessionId: randomUUID(), workspaceRoot: join(home, 'repo'),
      createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 3600000).toISOString(), maximumProviderCostCents: 25 };
    const registration: NamedSessionRegistration = { schema: 'dharma.named-session/v1', name: 'implementer',
      bindingId: binding.bindingId, identity, maximumCostCents: 100, maximumTurnCostCents: 25, enabled: true };
    await mkdir(binding.workspaceRoot); await saveNamedSession(home, registration);
    assert.deepEqual(await readNamedSession(home, registration.name), registration);
    const vault = await LocalVault.open({ root: join(home, 'vault'), masterKey: randomBytes(32) });
    vault.saveProviderSessionBinding(binding);
    const controller = new AbortController(), turns: string[] = [], replies: string[] = [];
    const listeners = new Set<(value: unknown) => void>();
    let offered = false, accepted = false, active = 0, maximumActive = 0, closed = false, revision = 0;
    const questionId = randomUUID(), taskId = randomUUID(), now = new Date();
    const unsigned = { schema: 'dharma.session-question/v1', questionId, taskId,
      organizationId: identity.organizationId, repositoryBindingId: identity.repositoryBindingId,
      source: { workspaceId: randomUUID(), endpointId: randomUUID(), membershipId: randomUUID(), deviceId: randomUUID() },
      target: { workspaceId: identity.workspaceId, endpointId: identity.endpointId, membershipId: identity.membershipId,
        deviceId: identity.deviceId, bindingId: binding.bindingId, provider: 'codex' },
      category: 'code-review', question: 'What is a logical job?',
      authority: { mode: 'read_only', readPaths: ['.'], network: 'deny', maximumProviderCostCents: 25 },
      createdAt: now.toISOString(), expiresAt: new Date(now.getTime() + 300000).toISOString(),
      nonce: randomUUID(), signerKeyVersion: 'test-v1' };
    const question = { ...unsigned, signature: signCanonicalObject(unsigned, privateKey) };
    const transport = {
      onToolCall() { return () => {}; },
      onNotification(listener: (value: unknown) => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
      async close() { closed = true; },
      async request(method: string, params: Record<string, unknown>): Promise<unknown> {
        if (method === 'permissionProfile/list') return { data: ['dharma_bridge', 'dharma_work'].map(id => ({ id, allowed: true })) };
        if (method === 'config/read') return { config: { permissions: {
          dharma_bridge: { filesystem: { ':minimal': 'read', ':workspace_roots': { '.': 'read' } }, network: { enabled: false } },
          dharma_work: { filesystem: { ':minimal': 'read', ':workspace_roots': { '.': 'write' } }, network: { enabled: false } },
        } } };
        if (method === 'thread/read') return { thread: { id: binding.sessionId, cwd: binding.workspaceRoot, status: { type: 'idle' } } };
        if (method === 'turn/start') {
          assert.equal(params.threadId, binding.sessionId);
          assert.equal(params.approvalPolicy, 'never');
          turns.push(String(params.permissions)); active++; maximumActive = Math.max(maximumActive, active);
          const turnId = randomUUID();
          const fail = failWork && turns.length === 2;
          setTimeout(() => {
            active--;
            if (params.permissions === 'dharma_work') for (const listener of listeners) listener({
              method: 'item/completed', params: { threadId: binding.sessionId, turnId,
                item: { type: 'commandExecution', output: 'RAW_CAPTURE_ONLY_TEST_CANARY' } },
            });
            for (const listener of listeners) listener({ method: 'turn/completed', params: { threadId: binding.sessionId,
              turn: { id: turnId, status: fail ? 'failed' : 'completed',
                items: fail ? [] : [{ type: 'agentMessage', phase: 'final_answer', text: 'One tenant-scoped operation.' }] } } });
          }, 25);
          return { turn: { id: turnId } };
        }
        throw new Error('unexpected');
      },
    };
    const channelTransport = { async signedPost(route: string, body: unknown) {
      const value = body as Record<string, unknown>;
      const base = { ok: true, organizationId: identity.organizationId, correlationId: randomUUID() };
      if (route.endsWith('provider-sessions')) {
        if (value.action === 'inspect') return { ...base, registration: null };
        return { ...base, registration: { bindingId: binding.bindingId, ...identity,
          organizationId: undefined, mode: 'bridge_owned', revision: ++revision, state: 'attached',
          leaseUntil: new Date(Date.now() + 60000).toISOString(), replay: false } };
      }
      if (value.action === 'inbox') return { ...base, result: { offers: offered && !accepted ? [question] : [] } };
      if (value.action === 'accept') accepted = true;
      if (value.action === 'reply') replies.push(String(value.answer));
      return { ...base, result: { questionId, taskId, targetBindingId: binding.bindingId,
        state: value.action === 'reply' ? 'answered' : 'accepted', replay: false } };
    } };
    // The wire registration deliberately has no organizationId inside the scoped result.
    const rawPost = channelTransport.signedPost;
    channelTransport.signedPost = async (route, body) => {
      const result = await rawPost(route, body) as Record<string, unknown>;
      if (result.registration) delete (result.registration as Record<string, unknown>).organizationId;
      return result as Awaited<ReturnType<typeof rawPost>>;
    };
    let boundaryWorkId: string | null = null;
    const retainedWorkIds: string[] = [];
    const service = runNamedSessionService({ home, registration, vault, signal: controller.signal,
      openTransport: async () => transport, channelTransport, verifier: { resolvePublicKey: () => publicKey, consume: async () => true },
      authorizeContent: async () => true, localWriteRoots: ['.'], authorizeLocalWork: async () => true,
      retainRepositoryState: async capture => {
        assert.equal(capture.workId, boundaryWorkId);
        retainedWorkIds.push(capture.workId);
        if (queueFailure) throw new Error('RAW_STATE_FAILURE_MUST_NOT_LEAK');
        return { state: 'not_authorized', acceptedLearningObservation: false };
      },
      queueEvidence: async capture => {
        if (queueFailure) throw new Error('RAW_QUEUE_FAILURE_DIAGNOSTIC_MUST_NOT_LEAK');
        return queueNamedSessionEvidence({ vault, capture, binding, policy: {
          schema: 'dharma.organization-policy/v1', organizationId: identity.organizationId, revision: 'test_rev',
          evidence: { defaultMode: 'deep', registeredWorkspaceOnly: true, excludePaths: ['.env'],
            maximumCapsuleBytes: 1_000_000, maximumDailyUploadBytes: 5_000_000, maximumExpansionBytes: 1_000_000 },
          tasks: { defaultNetwork: 'deny', defaultGit: 'task_branch', writePaths: ['src/**'],
            requireLocalConfirmationFor: [], allowedCommands: {} },
          skills: { automaticInstall: true, automaticPromotionMaxRisk: 'R2', canaryPercent: 10 }, retention: {}, budgets: {},
        } });
      },
      withActivationBoundary: async (operation, work) => {
        assert.equal(boundaryWorkId, null);
        boundaryWorkId = work?.workId ?? null;
        try { return await operation(); }
        finally { boundaryWorkId = null; }
      } });
    try {
      for (let n = 0; n < 40; n++) {
        try { await namedSessionRequest(home, 'implementer', { action: 'status' }); break; }
        catch { await new Promise(resolveWait => setTimeout(resolveWait, 10)); }
      }
      let idleHealth: Record<string, unknown> | undefined;
      for (let n = 0; n < 100; n++) {
        const candidate = JSON.parse(await readFile(namedSessionPaths(home, 'implementer').health, 'utf8'));
        if (candidate.lastObservation?.state === 'idle' && candidate.state === 'running' && candidate.queued === 0) {
          idleHealth = candidate;
          break;
        }
        await new Promise(resolveWait => setTimeout(resolveWait, 10));
      }
      assert.ok(idleHealth, 'an idle inbox poll must persist a running, empty-queue health snapshot');
      const workId = randomUUID();
      const putBlob = vault.putBlob.bind(vault);
      let secretPersisted = false;
      vault.putBlob = async (plaintext, kind) => {
        if (Buffer.from(plaintext).includes(Buffer.from('dhab_PRIVATE_TEST_GRANT'))) secretPersisted = true;
        return putBlob(plaintext, kind);
      };
      await assert.rejects(namedSessionRequest(home, 'implementer', { action: 'work', workId: randomUUID(),
        prompt: 'Use dhab_PRIVATE_TEST_GRANT for this task.' }), /codex_session_work_credentials_forbidden/);
      assert.equal(secretPersisted, false);
      assert.equal(turns.length, 0);
      vault.putBlob = putBlob;
      if (failWork) {
        await namedSessionRequest(home, 'implementer', { action: 'work', workId, prompt: 'Run the public tests.' });
        const failedId = randomUUID();
        await assert.rejects(namedSessionRequest(home, 'implementer', { action: 'work', workId: failedId,
          prompt: 'A failing native task.' }), /turn_failed/);
        controller.abort();
        await service;
        const health = JSON.parse(await readFile(namedSessionPaths(home, 'implementer').health, 'utf8'));
        assert.equal(health.lastWork.state, 'failed');
        assert.equal(health.lastWork.workId, failedId);
        assert.equal(health.budget.reservedCents, 50);
        const failure = JSON.parse((await vault.getBlob(health.lastWork.receiptHash)).toString('utf8'));
        const failedIntent = JSON.parse((await vault.getBlob(failure.intentHash)).toString('utf8'));
        assert.equal(failedIntent.workId, failedId);
        assert.equal(failedIntent.prompt, 'A failing native task.');
        assert.equal(failure.nativeEvidence.acceptedLearningObservation, false);
        assert.deepEqual(retainedWorkIds, [workId, failedId]);
        assert.equal(failure.nativeEvidence.repositoryState.state, queueFailure ? 'blocked' : 'not_authorized');
        assert.equal(failure.nativeEvidence.providerTurnState, 'failed');
        assert.equal(failure.nativeEvidence.synchronization.state, queueFailure ? 'blocked' : 'queued');
        assert.equal((await vault.listPendingCapsuleSyncs()).length, queueFailure ? 0 : 2);
        const capture = JSON.parse((await vault.getBlob(failure.nativeEvidence.contentHash)).toString('utf8'));
        assert.equal(capture.workOutcome, 'failed');
        assert.equal(capture.workId, failedId);
        assert.equal((await validateContract(join(import.meta.dirname, 'schemas'),
          'https://schemas.dharma-ai.io/codex-local-work-capture/v2', capture)).ok, true);
        assert.deepEqual(turns, ['dharma_work', 'dharma_work']);
        return;
      }
      const first = namedSessionRequest(home, 'implementer', { action: 'work', workId, prompt: 'Run the public tests.' });
      const second = namedSessionRequest(home, 'implementer', { action: 'work', workId: randomUUID(), prompt: 'Check the correction.' });
      const workReceipts = await Promise.all([first, second]);
      for (const receipt of workReceipts) {
        const intent = JSON.parse((await vault.getBlob(String(receipt.intentHash))).toString('utf8'));
        assert.equal(intent.workId, receipt.workId);
        assert.equal(intent.bindingId, binding.bindingId);
        assert.equal('prompt' in receipt, false);
        const evidence = receipt.nativeEvidence as Record<string, unknown>;
        assert.equal(evidence.acceptedLearningObservation, false);
        assert.equal((evidence.repositoryState as Record<string, unknown>).state, queueFailure ? 'blocked' : 'not_authorized');
        const synchronization = evidence.synchronization as Record<string, unknown>;
        assert.equal(synchronization.state, queueFailure ? 'blocked' : 'queued');
        assert.equal(synchronization.acceptedLearningObservation, false);
        assert.equal((await validateContract(join(import.meta.dirname, 'schemas'),
          'https://schemas.dharma-ai.io/named-session-evidence/v1', synchronization)).ok, true);
        assert.equal(evidence.coverage, 'observed');
        assert.equal(JSON.stringify(receipt).includes('RAW_CAPTURE_ONLY_TEST_CANARY'), false);
        const capture = JSON.parse((await vault.getBlob(String(evidence.contentHash))).toString('utf8'));
        assert.equal(capture.workId, receipt.workId);
        assert.equal(capture.providerTurnId, receipt.providerTurnId);
        assert.equal(capture.deviceId, identity.deviceId);
        assert.equal(capture.repositoryBindingId, identity.repositoryBindingId);
        assert.equal((await validateContract(join(import.meta.dirname, 'schemas'),
          'https://schemas.dharma-ai.io/codex-local-work-capture/v2', capture)).ok, true);
        assert.ok(JSON.stringify(capture).includes('RAW_CAPTURE_ONLY_TEST_CANARY'));
        const digest = String(evidence.contentHash).slice(7);
        const stored = await readFile(join(home, 'vault', 'blobs', digest.slice(0, 2), `${digest}.blob`));
        assert.equal(stored.includes(Buffer.from('RAW_CAPTURE_ONLY_TEST_CANARY')), false);
      }
      for (const entry of await readdir(join(home, 'vault'), { withFileTypes: true })) {
        if (entry.isFile()) assert.equal((await readFile(join(home, 'vault', entry.name))).includes(Buffer.from('RAW_CAPTURE_ONLY_TEST_CANARY')), false);
      }
      offered = true;
      for (let n = 0; n < 150 && !replies.length; n++) await new Promise(resolveWait => setTimeout(resolveWait, 10));
      assert.equal(replies.length, 1);
      assert.equal(maximumActive, 1);
      assert.deepEqual(retainedWorkIds, workReceipts.map(receipt => receipt.workId));
      assert.equal(JSON.stringify(workReceipts).includes('RAW_STATE_FAILURE_MUST_NOT_LEAK'), false);
      assert.deepEqual(turns, ['dharma_work', 'dharma_work', 'dharma_bridge']);
      await assert.rejects(namedSessionRequest(home, 'implementer', { action: 'work', workId, prompt: 'Replay' }), /work_already_recorded/);
      assert.equal(turns.length, 3);
      assert.equal((await vault.listPendingCapsuleSyncs()).length, queueFailure ? 0 : 2);
      const health = JSON.parse(await readFile(namedSessionPaths(home, 'implementer').health, 'utf8'));
      assert.equal(health.budget.reservedCents, 75);
      assert.equal(JSON.stringify(health).includes('RAW_CAPTURE_ONLY_TEST_CANARY'), false);
      assert.equal(JSON.stringify(health).includes('RAW_QUEUE_FAILURE_DIAGNOSTIC_MUST_NOT_LEAK'), false);
      const completion = JSON.parse((await vault.getBlob(health.lastObservation.completionHash)).toString('utf8'));
      assert.equal((await validateContract(join(import.meta.dirname, 'schemas'),
        'https://schemas.dharma-ai.io/provider-session-completion/v1', completion)).ok, true);
      assert.equal((await namedSessionRequest(home, 'implementer', { action: 'status' })).sessionId, binding.sessionId);
      const retention = await vault.enforceRawEvidenceRetention({ retentionDays: 30,
        now: new Date(Date.now() + 31 * 86400000) });
      assert.equal(retention.deleted, 2);
      for (const receipt of workReceipts) {
        await assert.rejects(vault.getBlob(String((receipt.nativeEvidence as Record<string, unknown>).contentHash)));
        assert.ok(await vault.getBlob(String(receipt.completionHash)));
      }
    } finally { controller.abort(); await service; vault.close(); }
    assert.equal(closed, true);
  });
