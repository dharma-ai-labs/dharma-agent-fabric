import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID, type JsonWebKey } from 'node:crypto';
import test from 'node:test';
import {
  actionDecisionDigest,
  buildActionDecisionAcknowledgement,
  canonicalize,
  createActionDecisionPublicKeyResolver,
  refreshActionDecisionAcknowledgement,
  signCanonicalObject,
  signEnvelope,
  validateActionDecisionReceiptContract,
  validateActionDecisionTaskRequestContract,
  verifyInitialServerSigningKeyset,
  verifyServerSigningKeysetUpdate,
  verifyActionDecisionReceipt,
  verifyCanonicalObject,
  verifyEnvelope,
  type ActionDecisionEnvelope,
  type ActionDecisionReceipt,
  type TaskAction,
  type TrustedServerSigningKeyset,
} from './index.js';

test('canonicalize sorts nested object keys but preserves arrays', () => {
  assert.equal(canonicalize({ z: 1, a: { d: 2, b: [3, 1] } }), '{"a":{"b":[3,1],"d":2},"z":1}');
});

test('canonical object signatures do not depend on object key order', () => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const signature = signCanonicalObject({ second: 2, first: 1 }, privateKey);
  assert.equal(verifyCanonicalObject({ first: 1, second: 2 }, signature, publicKey), true);
  assert.equal(verifyCanonicalObject({ first: 1, second: 3 }, signature, publicKey), false);
});

test('signed envelopes verify and expire deterministically', () => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const now = new Date('2026-08-03T20:00:00.000Z');
  const signed = signEnvelope({
    schema: 'dharma.protocol-envelope/v1',
    messageId: randomUUID(),
    organizationId: 'org_test',
    deviceId: 'device_test',
    sessionId: 'session_test',
    sentAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + 60_000).toISOString(),
    sequence: 1,
    nonce: 'nonce',
    type: 'Heartbeat',
    payload: { status: 'online' },
  }, privateKey);

  assert.deepEqual(verifyEnvelope(signed, publicKey, now), { ok: true });
  assert.deepEqual(verifyEnvelope(signed, publicKey, new Date(now.getTime() + 60_001)), {
    ok: false,
    reason: 'expired',
  });
});

test('embedded action-decision receipts verify the exact HQ task action and KMS key version', () => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const now = new Date('2026-08-17T20:00:00.000Z');
  const action: TaskAction = {
    schema: 'dharma.task-action/v1',
    actionId: '11111111-1111-4111-8111-111111111111',
    organizationId: 'org_test',
    taskId: '22222222-2222-4222-8222-222222222222',
    targetEndpointId: '33333333-3333-4333-8333-333333333333',
    workspaceId: 'workspace_test',
    taskType: 'external_request',
    instructions: 'Apply the bounded repair.',
    requiredSkills: [],
    authority: { readPaths: ['src/**'], writePaths: ['src/parser.ts'], commands: [{ commandId: 'verify' }], network: 'deny', git: 'task_branch', allowlistedDomains: [] },
    execution: { isolation: 'git_worktree', timeoutSeconds: 60, leaseSeconds: 60, maximumConcurrentAgents: 1 },
    acceptance: { commands: [{ commandId: 'verify' }], requiredArtifacts: [] },
    budget: { mode: 'byok_local', maximumDharmaCostCents: 0, maximumProviderCostCents: null },
    expiresAt: '2026-08-17T20:10:00.000Z',
  };
  const receipt = {
    schema: 'dharma.action-decision-receipt/v1' as const,
    decisionId: '44444444-4444-4444-8444-444444444444',
    organizationId: action.organizationId,
    actionId: action.actionId,
    taskId: action.taskId,
    targetEndpointId: action.targetEndpointId,
    workspaceId: action.workspaceId,
    evaluationContractId: '55555555-5555-4555-8555-555555555555',
    evaluationContractVersion: 3,
    actionDigest: actionDecisionDigest(action),
    stateEnvelopeHash: `sha256:${'a'.repeat(64)}`,
    evidenceReferences: [{ trajectoryId: '66666666-6666-4666-8666-666666666666', revision: 2, capsuleHash: `sha256:${'b'.repeat(64)}` }],
    outcome: 'release' as const,
    reasonCodes: ['policy_release'],
    confidence: 0.98,
    evaluator: { provider: 'google_vertex_ai', model: 'gemini-test', configDigest: `sha256:${'c'.repeat(64)}` },
    nonce: 'receipt-nonce',
    issuedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + 10 * 60_000).toISOString(),
    keyVersion: 'projects/test/locations/global/keyRings/test/cryptoKeys/action-decisions/cryptoKeyVersions/1',
  } satisfies ActionDecisionReceipt;
  const embedded = {
    id: receipt.decisionId,
    actionDigest: receipt.actionDigest,
    receipt,
    signature: signCanonicalObject(receipt, privateKey),
    keyVersion: receipt.keyVersion,
  } satisfies ActionDecisionEnvelope;

  assert.deepEqual(verifyActionDecisionReceipt(embedded, action, (version) => version === receipt.keyVersion ? publicKey : null, now), { ok: true });
  assert.deepEqual(
    verifyActionDecisionReceipt(embedded, { ...action, instructions: 'Different effect.' }, () => publicKey, now),
    { ok: false, reason: 'digest_mismatch' },
  );
  for (const field of ['organizationId', 'taskId', 'actionId', 'targetEndpointId', 'workspaceId'] as const) {
    assert.deepEqual(
      verifyActionDecisionReceipt({ ...embedded, receipt: { ...receipt, [field]: field === 'organizationId' || field === 'workspaceId' ? 'other' : randomUUID() } }, action, () => publicKey, now),
      { ok: false, reason: 'binding_mismatch' },
    );
  }
  assert.deepEqual(verifyActionDecisionReceipt(embedded, action, () => null, now), { ok: false, reason: 'unknown_key' });
  assert.deepEqual(verifyActionDecisionReceipt({ ...embedded, id: randomUUID() }, action, () => publicKey, now), { ok: false, reason: 'binding_mismatch' });
  assert.deepEqual(verifyActionDecisionReceipt({ ...embedded, signature: signCanonicalObject({ ...receipt, confidence: 0.1 }, privateKey) }, action, () => publicKey, now), { ok: false, reason: 'bad_signature' });
  assert.deepEqual(
    verifyActionDecisionReceipt(embedded, action, () => publicKey, new Date(now.getTime() + 10 * 60_000 + 1)),
    { ok: false, reason: 'expired' },
  );
  assert.deepEqual(
    verifyActionDecisionReceipt({ ...embedded, receipt: { ...receipt, expiresAt: new Date(now.getTime() + 30 * 60_000 + 1).toISOString() } }, action, () => publicKey, now),
    { ok: false, reason: 'invalid_lifetime' },
  );
});

test('action-decision receipt schema allows exactly one bounded outcome', () => {
  const base = {
    schema: 'dharma.action-decision-receipt/v1',
    decisionId: '44444444-4444-4444-8444-444444444444',
    organizationId: 'org_test',
    taskId: '22222222-2222-4222-8222-222222222222',
    actionId: '11111111-1111-4111-8111-111111111111',
    targetEndpointId: '33333333-3333-4333-8333-333333333333',
    workspaceId: 'workspace_test',
    evaluationContractId: '55555555-5555-4555-8555-555555555555',
    evaluationContractVersion: 1,
    actionDigest: `sha256:${'a'.repeat(64)}`,
    stateEnvelopeHash: `sha256:${'b'.repeat(64)}`,
    evidenceReferences: [],
    outcome: 'release',
    reasonCodes: ['policy_release'],
    confidence: 1,
    evaluator: { provider: 'dharma_deterministic_preflight', model: 'deterministic-v1', configDigest: `sha256:${'c'.repeat(64)}` },
    nonce: 'receipt-nonce',
    issuedAt: '2026-08-17T20:00:00.000Z',
    expiresAt: '2026-08-17T20:01:00.000Z',
    keyVersion: 'projects/test/locations/global/keyRings/test/cryptoKeys/action-decisions/cryptoKeyVersions/1',
  };
  for (const outcome of ['release', 'block', 'escalate', 'withhold']) {
    assert.equal(validateActionDecisionReceiptContract({ ...base, outcome }).ok, true);
  }
  assert.equal(validateActionDecisionReceiptContract({ ...base, outcome: 'allow' }).ok, false);
  assert.equal(validateActionDecisionReceiptContract({ ...base, outcomes: ['release', 'block'] }).ok, false);
});

test('action acknowledgement helper emits the exact HQ enforcement payload', () => {
  const common = {
    taskId: randomUUID(), endpointId: randomUUID(), actionDigest: `sha256:${'a'.repeat(64)}`,
    externalIdempotencyKey: 'decision-id', result: { status: 'completed', commands: 2 },
  };
  const executed = buildActionDecisionAcknowledgement({ ...common, disposition: 'executed' }, new Date('2026-08-17T20:00:00.000Z'));
  assert.equal(executed.disposition, 'executed');
  assert.match(executed.externalIdempotencyKeyHash, /^[a-f0-9]{64}$/);
  assert.match(executed.resultDigest, /^sha256:[a-f0-9]{64}$/);
  const contained = buildActionDecisionAcknowledgement({ ...common, disposition: 'contained' }, new Date('2026-08-17T20:00:00.000Z'));
  assert.equal(contained.disposition, 'contained');
  const refreshed = refreshActionDecisionAcknowledgement(executed, new Date('2026-08-17T20:08:00.000Z'));
  assert.equal(refreshed.acknowledgedAt, '2026-08-17T20:08:00.000Z');
  assert.equal(refreshed.actionDigest, executed.actionDigest);
  assert.equal(refreshed.externalIdempotencyKeyHash, executed.externalIdempotencyKeyHash);
  assert.equal(refreshed.resultDigest, executed.resultDigest);
});

test('action decision task request matches the flat HQ parser contract', () => {
  const request = {
    taskId: randomUUID(), targetEndpointId: randomUUID(), workspaceId: 'workspace-test',
    taskType: 'external_request', instructions: 'Apply the bounded repair.',
    requiredSkills: [{ skillId: 'dharma-boundary', version: '1.2.0', commit: 'abc123', contentHash: `sha256:${'d'.repeat(64)}` }],
    authority: {
      commandIds: ['verify'], readPaths: ['src/**'], writePaths: ['src/parser.ts'],
      network: 'deny', git: 'task_branch', allowlistedDomains: [],
    },
    timeoutSeconds: 120, leaseSeconds: 180, acceptanceCommandIds: ['verify'],
    requiredArtifacts: ['test-report.json'], expiresAt: '2026-08-17T20:10:00.000Z',
  };
  assert.equal(validateActionDecisionTaskRequestContract(request).ok, true);
  assert.equal(validateActionDecisionTaskRequestContract({ ...request, requiredSkills: ['dharma-boundary'] }).ok, false);
  assert.equal(validateActionDecisionTaskRequestContract({ ...request, authority: { ...request.authority, commands: [{ commandId: 'verify' }] } }).ok, false);
  assert.equal(validateActionDecisionTaskRequestContract({ ...request, execution: { timeoutSeconds: 120 } }).ok, false);
});

function signedKeyset(input: {
  organizationId?: string;
  generation: number;
  signerVersion: string;
  signerPrivateKey: ReturnType<typeof generateKeyPairSync>['privateKey'];
  keys: TrustedServerSigningKeyset['keys'];
  now: Date;
}): TrustedServerSigningKeyset {
  const unsigned = {
    schema: 'dharma.server-signing-keyset/v1' as const,
    organizationId: input.organizationId ?? 'org_test', generation: input.generation,
    keys: input.keys, signedByKeyVersion: input.signerVersion,
    issuedAt: input.now.toISOString(), expiresAt: new Date(input.now.getTime() + 24 * 60 * 60_000).toISOString(),
  };
  return { ...unsigned, signature: signCanonicalObject(unsigned, input.signerPrivateKey) };
}

test('trusted signing keyset supports overlap rotation and rollback without trusting receipt metadata', () => {
  const now = new Date('2026-08-17T20:00:00.000Z');
  const root = generateKeyPairSync('ed25519');
  const rotated = generateKeyPairSync('ed25519');
  const rootX = (root.publicKey.export({ format: 'jwk' }) as JsonWebKey).x!;
  const rotatedX = (rotated.publicKey.export({ format: 'jwk' }) as JsonWebKey).x!;
  const key = (keyVersion: string, publicKeyEd25519: string, status: 'active' | 'overlap', minutes: number) => ({
    keyVersion, publicKeyEd25519, status,
    notBefore: new Date(now.getTime() - 60_000).toISOString(),
    notAfter: new Date(now.getTime() + minutes * 60_000).toISOString(),
  });
  const initial = signedKeyset({ generation: 1, signerVersion: 'kms/1', signerPrivateKey: root.privateKey, keys: [key('kms/1', rootX, 'active', 120)], now });
  assert.deepEqual(verifyInitialServerSigningKeyset(initial, root.publicKey, 'org_test', now), { ok: true });
  const rotation = signedKeyset({
    generation: 2, signerVersion: 'kms/1', signerPrivateKey: root.privateKey,
    keys: [key('kms/1', rootX, 'overlap', 30), key('kms/2', rotatedX, 'active', 120)], now,
  });
  assert.deepEqual(verifyServerSigningKeysetUpdate(initial, rotation, now), { ok: true });
  assert.ok(createActionDecisionPublicKeyResolver(rotation, now)('kms/2'));
  assert.equal(createActionDecisionPublicKeyResolver(rotation, now)('kms/untrusted'), null);

  const rollback = signedKeyset({
    generation: 3, signerVersion: 'kms/2', signerPrivateKey: rotated.privateKey,
    keys: [key('kms/1', rootX, 'active', 120), key('kms/2', rotatedX, 'overlap', 30)], now,
  });
  assert.deepEqual(verifyServerSigningKeysetUpdate(rotation, rollback, now), { ok: true });
  assert.ok(createActionDecisionPublicKeyResolver(rollback, now)('kms/1'));

  const noOverlap = signedKeyset({
    generation: 3, signerVersion: 'kms/2', signerPrivateKey: rotated.privateKey,
    keys: [key('kms/1', rootX, 'active', 120), key('kms/2', rotatedX, 'overlap', 5)], now,
  });
  assert.deepEqual(verifyServerSigningKeysetUpdate(rotation, noOverlap, now), { ok: false, reason: 'rotation_overlap_missing' });
  assert.deepEqual(verifyInitialServerSigningKeyset({ ...initial, organizationId: 'other' }, root.publicKey, 'org_test', now), { ok: false, reason: 'organization_mismatch' });

  const expiredCurrent = signedKeyset({
    generation: 4, signerVersion: 'kms/1', signerPrivateKey: root.privateKey,
    keys: [key('kms/1', rootX, 'active', 120)],
    now: new Date(now.getTime() - 31 * 24 * 60 * 60_000),
  });
  const attemptedRevival = signedKeyset({
    generation: 5, signerVersion: 'kms/1', signerPrivateKey: root.privateKey,
    keys: [key('kms/1', rootX, 'active', 120)], now,
  });
  assert.deepEqual(
    verifyServerSigningKeysetUpdate(expiredCurrent, attemptedRevival, now),
    { ok: false, reason: 'current_expired' },
  );

  const expiringKey = key('kms/1', rootX, 'active', 30);
  const boundedCurrent = signedKeyset({
    generation: 6, signerVersion: 'kms/1', signerPrivateKey: root.privateKey,
    keys: [expiringKey], now,
  });
  const extendedKey = { ...expiringKey, notAfter: new Date(now.getTime() + 120 * 60_000).toISOString() };
  const attemptedExtension = signedKeyset({
    generation: 7, signerVersion: 'kms/1', signerPrivateKey: root.privateKey,
    keys: [extendedKey], now,
  });
  assert.deepEqual(
    verifyServerSigningKeysetUpdate(boundedCurrent, attemptedExtension, now),
    { ok: false, reason: 'rotation_overlap_missing' },
  );
});
