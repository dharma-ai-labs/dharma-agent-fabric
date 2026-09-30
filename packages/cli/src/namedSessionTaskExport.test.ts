import assert from 'node:assert/strict';
import { generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { canonicalize, sha256, signCanonicalObject } from '@dharma-ai-labs/agent-fabric-contracts';
import { verifyServerAuthorizedPolicy, type OrganizationPolicy } from '@dharma-ai-labs/agent-fabric-policy';
import { LocalVault, type LocalProviderSessionBinding } from '@dharma-ai-labs/agent-fabric-local-vault';
import type { CodexLocalWorkCapture } from '@dharma-ai-labs/agent-fabric-provider-adapters/experimental/codex-session';
import { prepareNamedSessionTaskExport } from './namedSessionTaskExport.js';
import { stageNamedSessionTaskExport, syncNamedSessionTaskExports } from './namedSessionTaskExportSync.js';
import { retainNamedSessionRepositoryState } from './namedSessionRepositoryState.js';
import { inventoryRepositoryPackage } from './repositoryPackage.js';
import { initializeRepositoryKnowledge } from './repositoryKnowledge.js';
import type { RepositorySourceAuthorization } from './repositorySourceAuthorization.js';

function fixture() {
  const binding: LocalProviderSessionBinding = { schema: 'dharma.local-provider-session-binding/v1',
    organizationId: 'org_synthetic', repositoryBindingId: randomUUID(), workspaceId: randomUUID(),
    endpointId: randomUUID(), membershipId: randomUUID(), deviceId: randomUUID(), bindingId: randomUUID(),
    provider: 'codex', owner: 'dharma_bridge', sessionId: 'synthetic_thread', workspaceRoot: '/home/synthetic/repository',
    createdAt: new Date(Date.now() - 60000).toISOString(), expiresAt: new Date(Date.now() + 60000).toISOString(),
    maximumProviderCostCents: 10 };
  const startedAt = new Date(Date.now() - 1000).toISOString(), closedAt = new Date().toISOString();
  const request = { method: 'turn/start' as const, params: { threadId: binding.sessionId,
    input: [{ type: 'text' as const, text: 'Define a logical job.' }] as [{ type: 'text'; text: string }],
    cwd: binding.workspaceRoot, approvalPolicy: 'never' as const, permissions: 'dharma_work' as const } };
  const events = [{ sequence: 0, receivedAt: closedAt, notification: { method: 'turn/completed',
    params: { threadId: binding.sessionId, turn: { id: 'synthetic_turn', status: 'completed', items: [
      { type: 'agentMessage', text: 'One tenant-scoped job; inspected /home/synthetic/repository/src/jobs.ts.' },
      { type: 'reasoning', summary: ['PROTECTED_REASONING_CANARY'], encryptedContent: 'PROTECTED_CIPHER_CANARY' },
    ] } } } }];
  const capture: CodexLocalWorkCapture = { schema: 'dharma.codex-local-work-capture/v2',
    captureId: randomUUID(), organizationId: binding.organizationId, repositoryBindingId: binding.repositoryBindingId,
    workspaceId: binding.workspaceId, endpointId: binding.endpointId, membershipId: binding.membershipId,
    deviceId: binding.deviceId, bindingId: binding.bindingId, workId: 'synthetic_job', provider: 'codex',
    providerThreadId: binding.sessionId, providerTurnId: 'synthetic_turn', startedAt, closedAt,
    workOutcome: 'completed', providerTurnState: 'completed', captureScope: 'turn_request_and_notifications',
    coverage: 'observed', limitations: [], droppedEvents: 0, acceptedLearningObservation: false, executedModel: null,
    request, requestHash: sha256(JSON.stringify(request)), events, eventsHash: sha256(JSON.stringify(events)) };
  const context = { schema: 'dharma.codex-public-context/v1', threadId: binding.sessionId,
    capturedAt: new Date(Date.now() - 2000).toISOString(), configuredModel: 'synthetic-model',
    configuredModelProvider: 'synthetic-provider', configuredReasoningEffort: 'low', executedModel: null,
    replayMode: 'task_level', limitations: ['public_history_only', 'executed_model_unreported'],
    turns: [{ id: 'prior_turn', status: 'completed', items: [{ type: 'agentMessage',
      text: 'Prior task inspected /home/synthetic/repository/README.md.', encryptedContent: 'PROTECTED_HISTORY_CANARY' }] }] };
  const contextBytes = Buffer.from(canonicalize(context));
  const policy: OrganizationPolicy = { schema: 'dharma.organization-policy/v2', organizationId: binding.organizationId,
    revision: 'synthetic-policy', evidence: { defaultMode: 'deep', registeredWorkspaceOnly: true,
      automaticDisclosure: { mode: 'customer_authorized_content', consentReceiptId: `consent_${randomUUID()}`,
        allowedContentClasses: ['native_provider_payload'] }, excludePaths: ['private-graders/**', '**/.env'],
      maximumCapsuleBytes: 1048576, maximumDailyUploadBytes: 8388608, maximumExpansionBytes: 1048576,
      pseudonymizeIdentity: true }, tasks: { defaultNetwork: 'deny', defaultGit: 'read_only', allowedCommands: {},
      writePaths: [], requireLocalConfirmationFor: [] }, skills: { automaticInstall: true,
      automaticPromotionMaxRisk: 'R1', canaryPercent: 10 }, retention: {}, budgets: {} };
  const keys = generateKeyPairSync('ed25519');
  const authorize = () => {
    const authorization = { schema: 'dharma.workspace-policy-authorization/v1' as const,
      organizationId: binding.organizationId, workspaceId: binding.workspaceId,
      policy: { revision: policy.revision, evidence: { automaticDisclosure: policy.evidence.automaticDisclosure!,
        maximumCapsuleBytes: policy.evidence.maximumCapsuleBytes, maximumDailyUploadBytes: policy.evidence.maximumDailyUploadBytes,
        maximumExpansionBytes: policy.evidence.maximumExpansionBytes, excludePaths: policy.evidence.excludePaths,
        pseudonymizeIdentity: true as const } }, issuedAt: new Date(Date.now() - 1000).toISOString(),
      expiresAt: new Date(Date.now() + 60000).toISOString(), keyVersion: 'synthetic-policy-key' };
    policy.serverAuthorization = { ...authorization, signature: signCanonicalObject(authorization, keys.privateKey) };
    verifyServerAuthorizedPolicy({ policy, publicKeyEd25519: keys.publicKey.export({ format: 'jwk' }).x!,
      organizationId: binding.organizationId, workspaceId: binding.workspaceId });
  };
  authorize();
  return { input: { binding, capture, contextBytes, contextHash: sha256(contextBytes), policy }, context, authorize };
}

test('portable export redacts native paths and protected reasoning with distinct byte lineage', async () => {
  const { input } = fixture(), before = JSON.stringify(input.capture);
  const result = await prepareNamedSessionTaskExport(input);
  assert.equal(result.state, 'ready');
  if (result.state !== 'ready') throw new Error('Export was not ready');
  const bytes = String(result.bytes);
  assert.ok(bytes.includes('One tenant-scoped job'));
  for (const excluded of ['PROTECTED_', '/home/synthetic']) assert.equal(bytes.includes(excluded), false);
  assert.equal(result.exportHash, sha256(bytes));
  assert.notEqual(result.exportHash, sha256(before));
  assert.equal(JSON.stringify(input.capture), before);
  const value = JSON.parse(bytes);
  assert.equal(value.original.captureHash, sha256(before));
  assert.equal(value.original.contextHash, input.contextHash);
  assert.equal(value.coverage, 'redacted_task_level');
  assert.equal(value.acceptedLearningObservation, false);
});

test('unverified, expired, mutated and foreign policy scopes cannot authorize export', async () => {
  const f = fixture();
  const mutations = [
    () => ({ ...f.input, policy: structuredClone(f.input.policy) }),
    () => ({ ...f.input, binding: { ...f.input.binding, workspaceId: randomUUID() } }),
    () => ({ ...f.input, binding: { ...f.input.binding, organizationId: 'org_other' } }),
  ];
  for (const input of mutations.map(mutate => mutate())) assert.deepEqual(await prepareNamedSessionTaskExport(input),
    { state: 'not_authorized', code: 'task_export_not_authorized', acceptedLearningObservation: false });
  f.input.policy.serverAuthorization!.expiresAt = new Date(Date.now() - 1).toISOString();
  assert.equal((await prepareNamedSessionTaskExport(f.input)).state, 'not_authorized');
  const changed = fixture(); changed.input.policy.evidence.excludePaths = [];
  assert.equal((await prepareNamedSessionTaskExport(changed.input)).state, 'not_authorized');
});

test('foreign, tampered and incomplete native captures are never exported as qualified work', async () => {
  for (const mutate of [
    (f: ReturnType<typeof fixture>) => { f.input.binding.deviceId = randomUUID(); },
    (f: ReturnType<typeof fixture>) => { f.input.capture.providerThreadId = 'other_thread'; },
    (f: ReturnType<typeof fixture>) => { f.input.capture.coverage = 'partial'; },
    (f: ReturnType<typeof fixture>) => { f.input.capture.eventsHash = `sha256:${'a'.repeat(64)}`; },
    (f: ReturnType<typeof fixture>) => { if (f.input.capture.schema === 'dharma.codex-local-work-capture/v2') f.input.capture.request.params.cwd = '/other/workspace'; },
  ]) {
    const f = fixture(); mutate(f);
    assert.deepEqual(await prepareNamedSessionTaskExport(f.input),
      { state: 'blocked', code: 'task_export_capture_invalid', acceptedLearningObservation: false });
  }
});

test('retained context hash, thread, time, terminality and executed-model limits are checked', async () => {
  for (const mutate of [
    (context: Record<string, unknown>) => { context.threadId = 'other_thread'; },
    (context: Record<string, unknown>) => { context.capturedAt = new Date(Date.now() + 10000).toISOString(); },
    (context: Record<string, unknown>) => { context.executedModel = 'unverified-model'; },
    (context: Record<string, unknown>) => { context.unknownField = 'UNAUTHORIZED_FIELD'; },
    (context: Record<string, unknown>) => { (context.turns as Array<Record<string, unknown>>)[0]!.status = 'inProgress'; },
  ]) {
    const f = fixture(); mutate(f.context);
    f.input.contextBytes = Buffer.from(canonicalize(f.context)); f.input.contextHash = sha256(f.input.contextBytes);
    assert.equal((await prepareNamedSessionTaskExport(f.input)).state, 'blocked');
  }
  const tampered = fixture(); tampered.input.contextHash = `sha256:${'a'.repeat(64)}`;
  assert.deepEqual(await prepareNamedSessionTaskExport(tampered.input),
    { state: 'blocked', code: 'task_export_context_invalid', acceptedLearningObservation: false });
});

test('configured excluded history is reported without exporting its content', async () => {
  const f = fixture(); f.context.turns[0]!.items[0]!.text = 'Inspected private-graders/hidden.json: PRIVATE_GRADER_CANARY';
  f.input.contextBytes = Buffer.from(canonicalize(f.context)); f.input.contextHash = sha256(f.input.contextBytes);
  const result = await prepareNamedSessionTaskExport(f.input);
  assert.deepEqual(result, { state: 'excluded', code: 'task_export_configured_excluded_path', acceptedLearningObservation: false });
  assert.equal(JSON.stringify(result).includes('PRIVATE_GRADER_CANARY'), false);
});

test('nested sensitive fields and serialized protected reasoning never reach the export', async () => {
  const f = fixture();
  const item = f.context.turns[0]!.items[0]! as Record<string, unknown>;
  item.result = { apiKey: 'SECRET_CANARY', credentials: 'CREDENTIAL_CANARY', response: 'Public response' };
  item.arguments = JSON.stringify({ type: 'reasoning', encryptedContent: 'PROTECTED_JSON_CANARY' });
  f.input.contextBytes = Buffer.from(canonicalize(f.context)); f.input.contextHash = sha256(f.input.contextBytes);
  const result = await prepareNamedSessionTaskExport(f.input);
  assert.equal(result.state, 'ready');
  if (result.state !== 'ready') throw new Error('Export was not ready');
  for (const forbidden of ['SECRET_CANARY', 'CREDENTIAL_CANARY', 'PROTECTED_JSON_CANARY']) {
    assert.equal(result.bytes.includes(forbidden), false);
  }
  assert.ok(result.bytes.includes('Public response'));
});

test('Windows and UNC paths are redacted using the existing shared disclosure reducer', async () => {
  for (const workspaceRoot of ['C:\\Users\\synthetic\\repository', '\\\\host\\share\\repository']) {
    const f = fixture(); f.input.binding.workspaceRoot = workspaceRoot;
    if (f.input.capture.schema !== 'dharma.codex-local-work-capture/v2') throw new Error('Missing request');
    f.input.capture.request.params.cwd = workspaceRoot;
    f.input.capture.requestHash = sha256(JSON.stringify(f.input.capture.request));
    f.context.turns[0]!.items[0]!.text = `Read ${workspaceRoot}\\README.md.`;
    f.input.contextBytes = Buffer.from(canonicalize(f.context)); f.input.contextHash = sha256(f.input.contextBytes);
    const result = await prepareNamedSessionTaskExport(f.input);
    assert.equal(result.state, 'ready');
    if (result.state !== 'ready') throw new Error('Export was not ready');
    assert.equal(result.bytes.includes('Users'), false); assert.equal(result.bytes.includes('host'), false);
  }
});

test('policy size limits are enforced and repeats preserve one deterministic export hash', async () => {
  const f = fixture();
  assert.deepEqual(await prepareNamedSessionTaskExport(f.input), await prepareNamedSessionTaskExport(f.input));
  f.input.policy.evidence.maximumCapsuleBytes = 1; f.authorize();
  assert.deepEqual(await prepareNamedSessionTaskExport(f.input),
    { state: 'blocked', code: 'task_export_size_or_schema_invalid', acceptedLearningObservation: false });
});

async function queuedExportFixture() {
  const root = await mkdtemp(join(tmpdir(), 'task-export-sync-'));
  const key = randomBytes(32), f = fixture();
  const scope = { organizationId: f.input.binding.organizationId, repositoryBindingId: f.input.binding.repositoryBindingId,
    workspaceId: f.input.binding.workspaceId, endpointId: f.input.binding.endpointId,
    membershipId: f.input.binding.membershipId, deviceId: f.input.binding.deviceId, provider: f.input.binding.provider };
  const vault = await LocalVault.open({ root, masterKey: key });
  vault.saveProviderSessionBinding(f.input.binding);
  const staged = await stageNamedSessionTaskExport(vault, f.input);
  if (staged.exported.state !== 'ready' || !staged.outbox) throw new Error('Outbox not ready');
  return { root, key, f, scope, vault, staged, request: { schema: 'dharma.codex-task-export-upload/v1' as const,
    exportBytes: staged.exported.bytes, exportHash: staged.exported.exportHash },
    response: { ok: true, organizationId: scope.organizationId, correlationId: randomUUID(),
      receipt: { id: randomUUID(), status: 'retained', exportHash: staged.exported.exportHash,
        contentExpiresAt: new Date(Date.now() + 86400000).toISOString(), acceptedLearningObservation: false } } };
}

test('lost export response reopens encrypted outbox and sends identical bytes without rerunning work', async () => {
  const q = await queuedExportFixture();
  let vault = q.vault, sends = 0;
  const run = () => syncNamedSessionTaskExports({ vault, bindingId: q.f.input.binding.bindingId, identity: q.scope,
    loadPolicy: async () => q.f.input.policy, send: async body => {
      assert.deepEqual(body, q.request);
      if (++sends === 1) throw new Error('PRIVATE_LOST_RESPONSE_CANARY');
      return { ...q.response, receipt: { ...q.response.receipt, status: 'duplicate' } };
    } });
  try {
    const repeat = await stageNamedSessionTaskExport(vault, q.f.input);
    assert.deepEqual(repeat.outbox, q.staged.outbox);
    assert.equal((await run()).state, 'pending');
    vault.close(); vault = await LocalVault.open({ root: q.root, masterKey: q.key });
    const recovered = await run();
    assert.equal(recovered.state, 'delivered');
    assert.equal(recovered.pending, 0); assert.equal(recovered.delivered, 1);
    assert.equal(recovered.acceptedLearningObservation, false);
    assert.equal(recovered.lastReceipt?.receipt.acceptedLearningObservation, false);
    const receiptHash = sha256(canonicalize(recovered.lastReceipt));
    assert.equal(JSON.parse((await vault.getBlob(receiptHash)).toString()).receipt.id, q.response.receipt.id);
    vault.close(); vault = await LocalVault.open({ root: q.root, masterKey: q.key });
    const idle = await run();
    assert.equal(idle.state, 'idle'); assert.equal(sends, 2);
    assert.deepEqual(idle.lastReceipt, recovered.lastReceipt);
    assert.deepEqual(vault.listProviderSessionTaskExports(q.f.input.binding.bindingId, q.scope), []);
  } finally { vault.close(); await rm(q.root, { recursive: true, force: true }); }
});

test('export acknowledgement rejects foreign, altered, expired and learning-admission receipts', async () => {
  for (const change of [
    (value: Awaited<ReturnType<typeof queuedExportFixture>>['response']) => { value.organizationId = 'org_foreign'; },
    (value: Awaited<ReturnType<typeof queuedExportFixture>>['response']) => { value.receipt.exportHash = `sha256:${'0'.repeat(64)}`; },
    (value: Awaited<ReturnType<typeof queuedExportFixture>>['response']) => { value.receipt.acceptedLearningObservation = true; },
    (value: Awaited<ReturnType<typeof queuedExportFixture>>['response']) => { value.receipt.contentExpiresAt = new Date(Date.now() - 1000).toISOString(); },
    (value: Awaited<ReturnType<typeof queuedExportFixture>>['response'] & { grant?: string }) => { value.grant = 'PRIVATE_RESPONSE_CANARY'; },
  ]) {
    const q = await queuedExportFixture();
    try {
      const response = structuredClone(q.response); change(response);
      const result = await syncNamedSessionTaskExports({ vault: q.vault, bindingId: q.f.input.binding.bindingId,
        identity: q.scope, loadPolicy: async () => q.f.input.policy, send: async () => response });
      assert.equal(result.code, 'task_export_receipt_invalid');
      assert.equal(result.state, 'blocked'); assert.equal(result.delivered, 0);
      assert.equal(result.lastReceipt, undefined);
      assert.equal(JSON.stringify(result).includes('PRIVATE_'), false);
      assert.equal(q.vault.listProviderSessionTaskExports(q.f.input.binding.bindingId, q.scope).length, 1);
    } finally { q.vault.close(); await rm(q.root, { recursive: true, force: true }); }
  }
});

test('export retries require original consent and current exclusion limits immediately before sending', async () => {
  for (const change of ['revision', 'consent', 'exclusion', 'binding'] as const) {
    const q = await queuedExportFixture();
    let refreshes = 0, sends = 0;
    try {
      const result = await syncNamedSessionTaskExports({ vault: q.vault, bindingId: q.f.input.binding.bindingId,
        identity: q.scope, loadPolicy: async () => {
          if (++refreshes === 2) {
            if (change === 'revision') q.f.input.policy.revision = 'new-revision';
            if (change === 'consent') q.f.input.policy.evidence.automaticDisclosure!.consentReceiptId = `consent_${randomUUID()}`;
            if (change === 'exclusion') q.f.input.policy.evidence.excludePaths = ['**/src/**'];
            if (change === 'binding') q.vault.revokeProviderSessionBinding(q.f.input.binding.bindingId, q.scope);
            q.f.authorize();
          }
          return q.f.input.policy;
        }, send: async () => { sends++; return q.response; } });
      assert.equal(result.state, 'blocked', change);
      assert.equal(result.delivered, 0); assert.equal(sends, 0);
    } finally { q.vault.close(); await rm(q.root, { recursive: true, force: true }); }
  }
});

test('empty outbox does not refresh authority or send network requests', async () => {
  const root = await mkdtemp(join(tmpdir(), 'task-export-idle-')), f = fixture();
  const vault = await LocalVault.open({ root, masterKey: randomBytes(32) });
  try {
    vault.saveProviderSessionBinding(f.input.binding);
    const result = await syncNamedSessionTaskExports({ vault, bindingId: f.input.binding.bindingId, identity: f.input.binding,
      loadPolicy: async () => { throw new Error('must not refresh'); }, send: async () => { throw new Error('must not send'); } });
    assert.equal(result.state, 'idle'); assert.equal(result.pending, 0);
  } finally { vault.close(); await rm(root, { recursive: true, force: true }); }
});

test('expired raw evidence blocks export without recreating content or executing a provider', async () => {
  const q = await queuedExportFixture();
  try {
    const expired = await q.vault.enforceRawEvidenceRetention({ retentionDays: 30, now: new Date(Date.now() + 31 * 86400000) });
    assert.equal(expired.deleted, 1);
    const result = await syncNamedSessionTaskExports({ vault: q.vault, bindingId: q.f.input.binding.bindingId,
      identity: q.scope, loadPolicy: async () => { throw new Error('must not request authority'); },
      send: async () => { throw new Error('must not send'); } });
    assert.equal(result.state, 'blocked'); assert.equal(result.code, 'task_export_retained_content_unavailable');
    assert.equal(result.delivered, 0); assert.equal(result.acceptedLearningObservation, false);
  } finally { q.vault.close(); await rm(q.root, { recursive: true, force: true }); }
});

test('repository-state retention keeps raw and portable evidence in separate encrypted blobs', async t => {
  const root = await mkdtemp(join(tmpdir(), 'task-portable-retention-'));
  let vault: LocalVault | undefined;
  t.after(async () => { vault?.close(); await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });
  vault = await LocalVault.open({ root: join(root, 'vault'), masterKey: randomBytes(32) });
  const f = fixture(); f.input.binding.workspaceRoot = root;
  if (f.input.capture.schema !== 'dharma.codex-local-work-capture/v2') throw new Error('Missing request');
  f.input.capture.request.params.cwd = root; f.input.capture.requestHash = sha256(JSON.stringify(f.input.capture.request));
  const { binding } = f.input;
  vault.saveProviderSessionBinding(binding);
  const policy: RepositorySourceAuthorization['policy'] = { action: 'authorize', confirmed: true,
    requestId: randomUUID(), repositoryBindingId: binding.repositoryBindingId, expectedRevision: 0,
    allowedContentClasses: ['approved_outputs', 'repository_content', 'repository_skills'], approvedRepositoryPaths: ['README.md'], approvedOutputFolders: [],
    automaticValidatedPublication: true, retentionDays: 30, maximumFileBytes: 262144, maximumSnapshotBytes: 4194304,
    maximumDailyUploadBytes: 8388608, expiresAt: null };
  const generationId = randomUUID();
  const sourceAuthorization: RepositorySourceAuthorization = { schema: 'dharma.repository-source-authorization/v1',
    organizationId: binding.organizationId, workspaceId: binding.workspaceId, repositoryBindingId: binding.repositoryBindingId,
    repositoryAgentId: randomUUID(), revision: 1, generationId, receiptId: `repo_consent_${generationId}`,
    policyRevision: `repository-source-${generationId}`, confirmedAt: new Date().toISOString(),
    policyHash: sha256(canonicalize(policy)), policy };
  const snapshotInput = { workspace: root, organizationId: binding.organizationId, workspaceId: binding.workspaceId,
    repositoryAgentId: sourceAuthorization.repositoryAgentId, repositoryBindingId: binding.repositoryBindingId, sourceAuthorization };
  const skillRoot = join(root, '.agents/skills/dharma-agent-fabric');
  await mkdir(skillRoot, { recursive: true });
  await writeFile(join(skillRoot, '.dharma-agent-fabric.json'), JSON.stringify({ managedBy: 'dharma-agent-fabric', workspaceId: binding.workspaceId }));
  await initializeRepositoryKnowledge(snapshotInput);
  await writeFile(join(root, 'README.md'), 'SYNTHETIC_BEFORE'); const before = await inventoryRepositoryPackage(snapshotInput);
  await writeFile(join(root, 'README.md'), 'SYNTHETIC_AFTER'); const after = await inventoryRepositoryPackage(snapshotInput);
  const receipt = await retainNamedSessionRepositoryState({ vault, binding, workId: f.input.capture.workId,
    capture: f.input.capture, before, after, activeBundleId: randomUUID(), activeBundleHash: `sha256:${'a'.repeat(64)}`,
    taskExport: { policy: f.input.policy, contextBytes: f.input.contextBytes, contextHash: f.input.contextHash } });
  assert.equal(receipt.portableExport?.state, 'ready');
  if (receipt.portableExport?.state !== 'ready') throw new Error('Portable retention not ready');
  const raw = await vault.getBlob(receipt.captureHash), portable = await vault.getBlob(receipt.portableExport.exportHash);
  assert.ok(raw.toString().includes('PROTECTED_CIPHER_CANARY'));
  assert.equal(portable.toString().includes('PROTECTED_'), false);
  assert.equal(receipt.captureHash, sha256(raw)); assert.equal(receipt.portableExport.exportHash, sha256(portable));
  assert.notEqual(receipt.captureHash, receipt.portableExport.exportHash);
  assert.equal(receipt.acceptedLearningObservation, false);
  assert.equal(JSON.stringify(receipt).includes('CANARY'), false);
  for (const hash of [receipt.captureHash, receipt.portableExport.exportHash]) {
    const digest = hash.slice(7), encrypted = await readFile(join(root, 'vault/blobs', digest.slice(0, 2), `${digest}.blob`));
    assert.equal(encrypted.includes(Buffer.from('PROTECTED_CIPHER_CANARY')), false);
    assert.equal(encrypted.includes(Buffer.from('One tenant-scoped job')), false);
  }
});
