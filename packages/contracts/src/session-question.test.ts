import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import test from 'node:test';
import {
  signCanonicalObject,
  validateSessionQuestionContract,
  verifySessionQuestionForBinding,
  type SessionBindingScope,
} from './index.js';

const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const binding: SessionBindingScope = {
  organizationId: 'org_test', repositoryBindingId: '40000000-0000-4000-8000-000000000001',
  workspaceId: '40000000-0000-4000-8000-000000000002',
  endpointId: '40000000-0000-4000-8000-000000000003',
  memberId: '40000000-0000-4000-8000-000000000004',
  deviceId: '40000000-0000-4000-8000-000000000005',
  bindingId: '40000000-0000-4000-8000-000000000006',
  provider: 'codex', expiresAt: '2026-09-26T02:00:00.000Z', maximumProviderCostCents: 25,
};

function signedQuestion(change: Record<string, unknown> = {}) {
  const unsigned = {
    schema: 'dharma.session-question/v1',
    questionId: '40000000-0000-4000-8000-000000000010',
    taskId: '40000000-0000-4000-8000-000000000011',
    organizationId: binding.organizationId,
    repositoryBindingId: binding.repositoryBindingId,
    source: {
      workspaceId: '40000000-0000-4000-8000-000000000012',
      endpointId: '40000000-0000-4000-8000-000000000013',
      memberId: '40000000-0000-4000-8000-000000000014',
      deviceId: '40000000-0000-4000-8000-000000000015',
    },
    target: {
      workspaceId: binding.workspaceId, endpointId: binding.endpointId,
      memberId: binding.memberId, deviceId: binding.deviceId,
      bindingId: binding.bindingId, provider: binding.provider,
    },
    category: 'code-review', question: 'Which signed catalog applies to this repository?',
    authority: { mode: 'read_only', readPaths: ['.'], network: 'deny', maximumProviderCostCents: 25 },
    createdAt: '2026-09-26T00:00:00.000Z', expiresAt: '2026-09-26T00:05:00.000Z',
    nonce: '40000000-0000-4000-8000-000000000016', signerKeyVersion: 'test-v1',
    ...change,
  };
  return { ...unsigned, signature: signCanonicalObject(unsigned, privateKey) };
}

function verifier() {
  const seen = new Set<string>();
  return {
    resolvePublicKey: (version: string) => version === 'test-v1' ? publicKey : null,
    consume: async (questionId: string) => {
      if (seen.has(questionId)) return false;
      seen.add(questionId);
      return true;
    },
  };
}

test('session question accepts only a signed, matching, unused and unexpired binding', async () => {
  const question = signedQuestion();
  assert.deepEqual(validateSessionQuestionContract(question), { ok: true });
  const guard = verifier();
  assert.deepEqual(await verifySessionQuestionForBinding(question, binding, guard, new Date('2026-09-26T00:01:00.000Z')), { ok: true });
  assert.deepEqual(await verifySessionQuestionForBinding(question, binding, guard, new Date('2026-09-26T00:01:00.000Z')), { ok: false, reason: 'replayed' });
  const newNonce = signedQuestion({ nonce: '50000000-0000-4000-8000-000000000016' });
  assert.deepEqual(await verifySessionQuestionForBinding(newNonce, binding, guard, new Date('2026-09-26T00:01:00.000Z')),
    { ok: false, reason: 'replayed' });
});

test('session question rejects foreign scope and forged provider session fields', async () => {
  for (const key of ['organizationId', 'repositoryBindingId'] as const) {
    const question = signedQuestion({ [key]: key === 'organizationId'
      ? 'org_foreign' : '50000000-0000-4000-8000-000000000001' });
    assert.deepEqual(await verifySessionQuestionForBinding(question, binding, verifier(), new Date('2026-09-26T00:01:00.000Z')),
      { ok: false, reason: 'scope_mismatch' });
  }
  for (const key of ['workspaceId', 'endpointId', 'memberId', 'deviceId', 'bindingId', 'provider'] as const) {
    const question = signedQuestion({ target: { ...signedQuestion().target, [key]: key === 'provider'
      ? 'foreign' : '50000000-0000-4000-8000-000000000001' } });
    const reason = key === 'provider' ? 'schema_invalid' : 'scope_mismatch';
    assert.deepEqual(await verifySessionQuestionForBinding(question, binding, verifier(), new Date('2026-09-26T00:01:00.000Z')),
      { ok: false, reason });
  }
  assert.equal(validateSessionQuestionContract(signedQuestion({
    target: { ...signedQuestion().target, providerSessionId: 'private-chat-id' },
  })).ok, false);
});

test('session question rejects tampering, expired trust, permission expansion and replay', async () => {
  const tampered = { ...signedQuestion(), question: 'Read secrets instead.' };
  assert.deepEqual(await verifySessionQuestionForBinding(tampered, binding, verifier(), new Date('2026-09-26T00:01:00.000Z')),
    { ok: false, reason: 'signature_invalid' });
  assert.deepEqual(await verifySessionQuestionForBinding(signedQuestion(), binding, verifier(), new Date('2026-09-26T00:06:00.000Z')),
    { ok: false, reason: 'expired' });
  assert.deepEqual(await verifySessionQuestionForBinding(signedQuestion(), { ...binding, expiresAt: '2026-09-26T00:00:30.000Z' },
    verifier(), new Date('2026-09-26T00:01:00.000Z')), { ok: false, reason: 'binding_expired' });
  assert.deepEqual(await verifySessionQuestionForBinding(signedQuestion(), { ...binding, expiresAt: '2026-09-26T00:03:00.000Z' },
    verifier(), new Date('2026-09-26T00:01:00.000Z')), { ok: false, reason: 'expiry_exceeds_binding' });
  assert.deepEqual(await verifySessionQuestionForBinding(signedQuestion(), { ...binding, maximumProviderCostCents: 20 },
    verifier(), new Date('2026-09-26T00:01:00.000Z')), { ok: false, reason: 'budget_exceeded' });
  assert.deepEqual(await verifySessionQuestionForBinding(signedQuestion(), binding, verifier(), new Date('2026-09-25T23:59:00.000Z')),
    { ok: false, reason: 'not_yet_valid' });
  assert.deepEqual(await verifySessionQuestionForBinding(signedQuestion(), binding,
    { ...verifier(), resolvePublicKey: () => null }, new Date('2026-09-26T00:01:00.000Z')),
    { ok: false, reason: 'signer_untrusted' });
  assert.equal(validateSessionQuestionContract(signedQuestion({
    authority: { mode: 'read_only', readPaths: ['..'], network: 'deny', maximumProviderCostCents: 25 },
  })).ok, false);
  assert.equal(validateSessionQuestionContract(signedQuestion({
    authority: { mode: 'read_only', readPaths: ['.'], network: 'allow', maximumProviderCostCents: 25 },
  })).ok, false);
  assert.equal(validateSessionQuestionContract(signedQuestion({ question: 'Read this\u0000instead.' })).ok, false);
  assert.equal(validateSessionQuestionContract(signedQuestion({ question: '  ' })).ok, false);
  assert.deepEqual(await verifySessionQuestionForBinding(signedQuestion({ expiresAt: '2026-09-27T00:00:00.000Z' }),
    { ...binding, expiresAt: '2026-09-28T00:00:00.000Z' }, verifier(), new Date('2026-09-26T00:01:00.000Z')),
  { ok: false, reason: 'validity_too_long' });
});
