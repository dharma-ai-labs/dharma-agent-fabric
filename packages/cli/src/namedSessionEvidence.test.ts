import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { LocalVault } from '@dharma-ai-labs/agent-fabric-local-vault';
import { signCanonicalObject, validateContract } from '@dharma-ai-labs/agent-fabric-contracts';
import type { CodexLocalWorkCapture } from '@dharma-ai-labs/agent-fabric-provider-adapters/experimental/codex-session';
import type { OrganizationPolicy } from '@dharma-ai-labs/agent-fabric-policy';
import { verifyServerAuthorizedPolicy } from '@dharma-ai-labs/agent-fabric-policy';
import { queueNamedSessionEvidence } from './namedSessionEvidence.js';
import { syncPendingRetentionCapsules } from './index.js';

function fixture() {
  const identity = { organizationId: 'org_test', repositoryBindingId: randomUUID(), workspaceId: randomUUID(),
    endpointId: randomUUID(), membershipId: randomUUID(), deviceId: randomUUID(), provider: 'codex' as const };
  const bindingId = randomUUID(), sessionId = randomUUID(), turnId = randomUUID();
  const startedAt = new Date(Date.now() - 1000).toISOString(), closedAt = new Date().toISOString();
  const events = [
    { method: 'item/completed', params: { threadId: sessionId, turnId,
      item: { id: 'user-1', type: 'userMessage', content: [{ type: 'text', text: 'Run public tests.' }] } } },
    { method: 'item/started', params: { threadId: sessionId, turnId,
      item: { id: 'command-1', type: 'commandExecution', command: 'npm test', status: 'inProgress' } } },
    { method: 'item/completed', params: { threadId: sessionId, turnId,
      item: { id: 'command-1', type: 'commandExecution', command: 'npm test', exitCode: 0, aggregatedOutput: 'SYNTHETIC_TEST_OUTPUT' } } },
    { method: 'item/completed', params: { threadId: sessionId, turnId,
      item: { id: 'answer-1', type: 'agentMessage', phase: 'final_answer', text: 'Public tests passed.' } } },
    { method: 'turn/completed', params: { threadId: sessionId, turn: { id: turnId, status: 'completed', items: [] } } },
  ].map((notification, sequence) => ({ sequence, receivedAt: closedAt, notification }));
  const capture: CodexLocalWorkCapture = { schema: 'dharma.codex-local-work-capture/v1', captureId: randomUUID(),
    ...identity, bindingId, workId: randomUUID(), providerThreadId: sessionId, providerTurnId: turnId,
    startedAt, closedAt, workOutcome: 'completed', providerTurnState: 'completed', captureScope: 'turn_notifications',
    coverage: 'observed', limitations: [], droppedEvents: 0, acceptedLearningObservation: false, executedModel: null,
    events, eventsHash: `sha256:${createHash('sha256').update(JSON.stringify(events)).digest('hex')}` };
  const policy: OrganizationPolicy = { schema: 'dharma.organization-policy/v2', organizationId: identity.organizationId,
    revision: 'rev_test', evidence: { defaultMode: 'deep', registeredWorkspaceOnly: true,
      automaticDisclosure: { mode: 'local_analysis' }, excludePaths: ['**/.env', '**/private-graders/**'],
      maximumCapsuleBytes: 1_000_000, maximumDailyUploadBytes: 5_000_000, maximumExpansionBytes: 1_000_000 },
    tasks: { defaultNetwork: 'deny', defaultGit: 'task_branch', writePaths: ['src/**'],
      requireLocalConfirmationFor: [], allowedCommands: { test: { argv: ['npm', 'test'], timeoutSeconds: 60 } } },
    skills: { automaticInstall: true, automaticPromotionMaxRisk: 'R2', canaryPercent: 10 }, retention: {}, budgets: {} };
  return { capture, policy, binding: { ...identity, bindingId, sessionId, workspaceRoot: '/synthetic/repository' } };
}

async function withVault(operation: (vault: LocalVault, root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'named-evidence-'));
  const vault = await LocalVault.open({ root, masterKey: randomBytes(32) });
  try { await operation(vault, root); } finally { vault.close(); }
}

function withRequest(input = fixture()) {
  const request = { method: 'turn/start' as const, params: { threadId: input.binding.sessionId,
    input: [{ type: 'text' as const, text: 'EXACT_PUBLIC_WORK_REQUEST' }] as [{ type: 'text'; text: string }],
    cwd: input.binding.workspaceRoot, approvalPolicy: 'never' as const, permissions: 'dharma_work' as const } };
  return { ...input, capture: { ...input.capture, schema: 'dharma.codex-local-work-capture/v2' as const,
    captureScope: 'turn_request_and_notifications' as const, request,
    requestHash: `sha256:${createHash('sha256').update(JSON.stringify(request)).digest('hex')}` } };
}

test('the exact native request reaches the encrypted outbox under the existing disclosure boundary', async () => {
  await withVault(async vault => {
    const input = withRequest();
    const result = await queueNamedSessionEvidence({ ...input, vault });
    const capsule = (await vault.listPendingCapsuleSyncs())[0]!.capsule;
    assert.equal(JSON.stringify(capsule).includes('EXACT_PUBLIC_WORK_REQUEST'), false);
    assert.ok((await vault.getBlob(result.captureHash)).includes(Buffer.from('EXACT_PUBLIC_WORK_REQUEST')));
    const missing = (capsule.coverage as Record<string, unknown>).missingFields as string[];
    assert.ok(missing.includes('retained_context_unavailable'));
    assert.ok(missing.includes('executed_model_unreported'));
    assert.equal(missing.includes('turn_notifications_only'), false);
    assert.equal(result.acceptedLearningObservation, false);
    assert.deepEqual(await queueNamedSessionEvidence({ ...input, vault }), result);
    assert.equal((await vault.listPendingCapsuleSyncs()).length, 1);
  });
});

test('native request hashes, authority, scope and credentials are checked before vault admission', async () => {
  await withVault(async vault => {
    for (const key of ['threadId', 'cwd']) {
      const input = withRequest();
      Object.assign(input.capture.request.params, { [key]: 'foreign' });
      input.capture.requestHash = `sha256:${createHash('sha256').update(JSON.stringify(input.capture.request)).digest('hex')}`;
      await assert.rejects(queueNamedSessionEvidence({ ...input, vault }), /scope_mismatch/);
    }
    const tampered = withRequest(); tampered.capture.request.params.input[0].text = 'Changed task.';
    await assert.rejects(queueNamedSessionEvidence({ ...tampered, vault }), /integrity_failed/);
    const secret = withRequest(); secret.capture.request.params.input[0].text = 'Use dhab_PRIVATE_TEST_GRANT';
    secret.capture.requestHash = `sha256:${createHash('sha256').update(JSON.stringify(secret.capture.request)).digest('hex')}`;
    await assert.rejects(queueNamedSessionEvidence({ ...secret, vault }), /credentials_forbidden/);
    const expanded = withRequest(); Object.assign(expanded.capture.request.params, { permissions: 'unrestricted' });
    await assert.rejects(queueNamedSessionEvidence({ ...expanded, vault }), /evidence_invalid/);
    assert.equal((await vault.listPendingCapsuleSyncs()).length, 0);
  });
});

test('native named turns enter the encrypted relay outbox, not the accepted learning counter', async () => {
  await withVault(async (vault, root) => {
    const input = fixture();
    const result = await queueNamedSessionEvidence({ ...input, vault });
    assert.equal(result.state, 'queued');
    assert.equal(result.acceptedLearningObservation, false);
    assert.equal((await validateContract(join(import.meta.dirname, 'schemas'),
      'https://schemas.dharma-ai.io/named-session-evidence/v1', result)).ok, true);
    const pending = await vault.listPendingCapsuleSyncs();
    assert.equal(pending.length, 1);
    const capsule = pending[0]!.capsule;
    assert.equal(capsule.deviceId, input.binding.deviceId);
    assert.equal(capsule.workspaceId, input.binding.workspaceId);
    assert.equal((await validateContract(join(import.meta.dirname, 'schemas'),
      'https://schemas.dharma-ai.io/trajectory-capsule/v2', capsule)).ok, true);
    assert.equal(JSON.stringify(capsule).includes('SYNTHETIC_TEST_OUTPUT'), false);
    assert.equal(capsule.coverage && (capsule.coverage as Record<string, unknown>).state, 'partial');
    assert.ok(((capsule.coverage as Record<string, unknown>).missingFields as string[]).includes('turn_notifications_only'));
    assert.deepEqual((capsule.localAnalysis as Record<string, unknown>).toolDiscipline,
      { calls: 1, results: 1, unmatchedCalls: 0, orphanResults: 0 });
    const digest = result.captureHash.slice(7);
    assert.equal((await readFile(join(root, 'blobs', digest.slice(0, 2), `${digest}.blob`)))
      .includes(Buffer.from('SYNTHETIC_TEST_OUTPUT')), false);
    assert.ok((await vault.getBlob(result.captureHash)).includes(Buffer.from('SYNTHETIC_TEST_OUTPUT')));
  });
});

test('queue replay is idempotent, but another real turn has a distinct trajectory', async () => {
  await withVault(async vault => {
    const input = fixture();
    const first = await queueNamedSessionEvidence({ ...input, vault });
    assert.deepEqual(await queueNamedSessionEvidence({ ...input, vault }), first);
    assert.equal((await vault.listPendingCapsuleSyncs()).length, 1);
    const other = fixture();
    other.binding = input.binding;
    for (const key of ['organizationId', 'repositoryBindingId', 'workspaceId', 'deviceId', 'endpointId', 'membershipId', 'bindingId'] as const) {
      other.capture[key] = input.binding[key];
    }
    other.capture.providerThreadId = input.binding.sessionId;
    for (const event of other.capture.events) event.notification.params = {
      ...(event.notification.params as Record<string, unknown>), threadId: input.binding.sessionId };
    other.capture.eventsHash = `sha256:${createHash('sha256').update(JSON.stringify(other.capture.events)).digest('hex')}`;
    const second = await queueNamedSessionEvidence({ ...other, vault });
    assert.notEqual(second.trajectoryId, first.trajectoryId);
    assert.equal((await vault.listPendingCapsuleSyncs()).length, 2);
  });
});

test('foreign scope, changed hashes, and forged policy do not enter the queue', async () => {
  await withVault(async vault => {
    for (const key of ['organizationId', 'repositoryBindingId', 'workspaceId', 'deviceId', 'endpointId', 'membershipId', 'bindingId']) {
      const input = fixture();
      Object.assign(input.capture, { [key]: key === 'organizationId' ? 'org_foreign' : randomUUID() });
      await assert.rejects(queueNamedSessionEvidence({ ...input, vault }), /scope_mismatch/);
    }
    const input = fixture();
    input.capture.eventsHash = `sha256:${'0'.repeat(64)}`;
    await assert.rejects(queueNamedSessionEvidence({ ...input, vault }), /integrity_failed/);
    const foreign = fixture(); foreign.policy.organizationId = 'org_foreign';
    await assert.rejects(queueNamedSessionEvidence({ ...foreign, vault }), /scope_mismatch/);
    const forged = fixture();
    forged.policy.evidence.automaticDisclosure = { mode: 'customer_authorized_content',
      consentReceiptId: 'unverified', allowedContentClasses: ['native_provider_payload'] };
    await assert.rejects(queueNamedSessionEvidence({ ...forged, vault }));
    assert.equal((await vault.listPendingCapsuleSyncs()).length, 0);
  });
});

test('unconfirmed and empty turns remain local and explicit; failed executions are partial evidence', async () => {
  await withVault(async vault => {
    for (const change of [{ providerTurnId: null, coverage: 'unavailable' as const },
      { providerTurnState: 'unconfirmed' as const }, { events: [] }]) {
      const input = fixture(); Object.assign(input.capture, change);
      input.capture.eventsHash = `sha256:${createHash('sha256').update(JSON.stringify(input.capture.events)).digest('hex')}`;
      const result = await queueNamedSessionEvidence({ ...input, vault });
      assert.equal(result.state, 'unavailable');
      assert.equal(result.acceptedLearningObservation, false);
    }
    assert.equal((await vault.listPendingCapsuleSyncs()).length, 0);
    const failed = fixture(); failed.capture.workOutcome = 'failed'; failed.capture.providerTurnState = 'failed';
    const terminal = failed.capture.events.at(-1)!;
    (terminal.notification.params as { turn: { status: string } }).turn.status = 'failed';
    failed.capture.eventsHash = `sha256:${createHash('sha256').update(JSON.stringify(failed.capture.events)).digest('hex')}`;
    assert.equal((await queueNamedSessionEvidence({ ...failed, vault })).state, 'queued');
    const capsule = (await vault.listPendingCapsuleSyncs())[0]!.capsule;
    assert.equal(capsule.status, 'partial');
    assert.ok((capsule.localAnalysis as Record<string, unknown>).semanticReviewRecommended);
  });
});

test('signed content disclosure filters protected provider fields, secrets and private paths', async () => {
  await withVault(async vault => {
    const input = withRequest(), keys = generateKeyPairSync('ed25519');
    input.policy.evidence.pseudonymizeIdentity = true;
    const disclosure = { mode: 'customer_authorized_content' as const, consentReceiptId: 'approved-test-consent',
      allowedContentClasses: ['native_provider_payload' as const] };
    input.policy.evidence.automaticDisclosure = disclosure;
    const unsigned = { schema: 'dharma.workspace-policy-authorization/v1' as const,
      organizationId: input.binding.organizationId, workspaceId: input.binding.workspaceId,
      policy: { revision: input.policy.revision, evidence: { ...input.policy.evidence,
        automaticDisclosure: disclosure, pseudonymizeIdentity: true as const } },
      issuedAt: new Date(Date.now() - 1000).toISOString(), expiresAt: new Date(Date.now() + 60000).toISOString(), keyVersion: 'test' };
    input.policy.serverAuthorization = { ...unsigned, signature: signCanonicalObject(unsigned, keys.privateKey) };
    const command = (input.capture.events[2]!.notification.params as { item: Record<string, unknown> }).item;
    command.encryptedContent = 'PROTECTED_NATIVE_CANARY';
    command.aggregatedOutput = 'SYNTHETIC_TEST_OUTPUT';
    command.result = { apiKey: 'SECRET_FIELD_CANARY' };
    const answer = (input.capture.events[3]!.notification.params as { item: Record<string, unknown> }).item;
    answer.path = 'private-graders/hidden.json'; answer.text = 'PRIVATE_GRADER_CANARY';
    input.capture.eventsHash = `sha256:${createHash('sha256').update(JSON.stringify(input.capture.events)).digest('hex')}`;
    verifyServerAuthorizedPolicy({ policy: input.policy, publicKeyEd25519: keys.publicKey.export({ format: 'jwk' }).x!,
      organizationId: input.binding.organizationId, workspaceId: input.binding.workspaceId });
    await queueNamedSessionEvidence({ ...input, vault });
    const wire = JSON.stringify((await vault.listPendingCapsuleSyncs())[0]!.capsule);
    assert.ok(wire.includes('EXACT_PUBLIC_WORK_REQUEST'));
    assert.ok(wire.includes('SYNTHETIC_TEST_OUTPUT'));
    for (const excluded of ['PROTECTED_NATIVE_CANARY', 'SECRET_FIELD_CANARY', 'PRIVATE_GRADER_CANARY']) {
      assert.equal(wire.includes(excluded), false);
    }
    input.policy.serverAuthorization.expiresAt = new Date(Date.now() - 1).toISOString();
    await assert.rejects(queueNamedSessionEvidence({ ...input, vault }));
    assert.equal((await vault.listPendingCapsuleSyncs()).length, 1);
  });
});

test('encrypted evidence outbox survives reopening without dispatching another provider turn', async () => {
  const root = await mkdtemp(join(tmpdir(), 'named-evidence-restart-')), masterKey = randomBytes(32);
  let vault = await LocalVault.open({ root, masterKey });
  const input = fixture();
  const first = await queueNamedSessionEvidence({ ...input, vault });
  vault.close();
  vault = await LocalVault.open({ root, masterKey });
  try {
    assert.equal((await vault.listPendingCapsuleSyncs()).length, 1);
    assert.deepEqual(await queueNamedSessionEvidence({ ...input, vault }), first);
    assert.equal((await vault.listPendingCapsuleSyncs()).length, 1);
  } finally { vault.close(); }
});

test('scoped capture cannot smuggle another thread or turn through a recomputed hash', async () => {
  await withVault(async vault => {
    for (const key of ['threadId', 'turnId']) {
      const input = fixture();
      (input.capture.events[0]!.notification.params as Record<string, unknown>)[key] = randomUUID();
      input.capture.eventsHash = `sha256:${createHash('sha256').update(JSON.stringify(input.capture.events)).digest('hex')}`;
      await assert.rejects(queueNamedSessionEvidence({ ...input, vault }), /scope_mismatch/);
    }
    assert.equal((await vault.listPendingCapsuleSyncs()).length, 0);
  });
});

test('normal relay drain admits scoped partial turns, resumes offline delivery, and preserves revoked raw evidence', async () => {
  await withVault(async (vault, root) => {
    const previous = process.env.DHARMA_HOME; process.env.DHARMA_HOME = join(root, 'home');
    try {
      const input = fixture(), receipt = await queueNamedSessionEvidence({ ...input, vault });
      let offline = true, sends = 0;
      const fabric = { config: { organizationId: input.binding.organizationId, deviceId: input.binding.deviceId },
        async syncTrajectory(capsule: Record<string, unknown>) {
          assert.equal(capsule.trajectoryId, receipt.trajectoryId); sends++;
          if (offline) throw new Error('offline');
          return { ok: true };
        } };
      await assert.rejects(syncPendingRetentionCapsules(vault, fabric as never, input.policy, input.binding.workspaceId), /offline/);
      assert.equal((await vault.listPendingCapsuleSyncs()).length, 1);
      offline = false;
      assert.equal(await syncPendingRetentionCapsules(vault, fabric as never, input.policy, input.binding.workspaceId), 1);
      assert.equal(await syncPendingRetentionCapsules(vault, fabric as never, input.policy, input.binding.workspaceId), 0);
      assert.equal(sends, 2);
      const revoked = fixture();
      const denied = await queueNamedSessionEvidence({ ...revoked, vault });
      revoked.policy.evidence.automaticDisclosure = { mode: 'metadata_only' };
      const noSend = { config: { organizationId: revoked.binding.organizationId, deviceId: revoked.binding.deviceId },
        syncTrajectory: async () => { throw new Error('revoked content must never be sent'); } };
      assert.equal(await syncPendingRetentionCapsules(vault, noSend as never, revoked.policy, revoked.binding.workspaceId), 0);
      assert.equal((await vault.listPendingCapsuleSyncs()).length, 0);
      assert.ok(await vault.getBlob(denied.captureHash));
    } finally { if (previous === undefined) delete process.env.DHARMA_HOME; else process.env.DHARMA_HOME = previous; }
  });
});
