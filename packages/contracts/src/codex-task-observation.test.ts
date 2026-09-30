import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { codexTaskLogicalRequestId, signCodexTaskObservation, verifyCodexTaskObservation, verifyCodexTaskOutcome,
  signCanonicalObject, type CodexTaskObservation, type CodexTaskScope } from './index.js';

const digest = (char: string) => `sha256:${char.repeat(64)}`;
const device = generateKeyPairSync('ed25519'), grader = generateKeyPairSync('ed25519');

function fixture() {
  const scope: CodexTaskScope = { organizationId: 'org_codex_test', repositoryBindingId: randomUUID(),
    workspaceId: randomUUID(), endpointId: randomUUID(), membershipId: randomUUID(), deviceId: randomUUID(),
    bindingId: randomUUID(), workId: 'logical_job_1' };
  const value: Omit<CodexTaskObservation, 'signature'> = {
    schema: 'dharma.codex-task-observation/v1', ...scope, logicalRequestId: codexTaskLogicalRequestId(scope),
    capture: { captureId: randomUUID(), captureHash: digest('a'), requestHash: digest('b'), eventsHash: digest('c'),
      threadId: 'thread_1', turnId: 'turn_1', startedAt: '2026-09-30T00:00:00Z', completedAt: '2026-09-30T00:01:00Z',
      terminalState: 'completed', coverage: 'observed', droppedEvents: 0 },
    sourceSnapshotHash: digest('d'), resultSnapshotHash: digest('e'),
    package: { releaseId: randomUUID(), manifestHash: digest('f'), catalogHash: digest('1'), skillsHash: digest('2') },
    consent: { policyId: randomUUID(), revision: 1, receiptId: randomUUID() },
    provider: { name: 'codex', runtimeVersion: '0.144.1', requestedModel: 'gpt-5.4', executedModel: null,
      retainedContextHash: digest('3'), replayMode: 'task_level' },
    outcome: { receiptId: randomUUID(), logicalRequestId: codexTaskLogicalRequestId(scope), captureHash: digest('a'),
      sourceSnapshotHash: digest('d'), resultSnapshotHash: digest('e'), evaluationContractHash: digest('4'),
      publicEvidenceHash: digest('5'), status: 'passed', completedAt: '2026-09-30T00:02:00Z',
      signerKeyVersion: 'grader-1', signature: '' },
  };
  const resign = () => {
    const { signature: _signature, ...grade } = value.outcome;
    value.outcome.signature = signCanonicalObject(grade, grader.privateKey);
    return signCodexTaskObservation(value, device.privateKey);
  };
  const input = { scope, devicePublicKey: device.publicKey, deviceActive: true, consent: value.consent,
    package: value.package, retained: { capture: structuredClone(value.capture), sourceSnapshotHash: value.sourceSnapshotHash,
      resultSnapshotHash: value.resultSnapshotHash, provider: structuredClone(value.provider),
      publicEvidenceHash: value.outcome.publicEvidenceHash }, evaluationContractHash: value.outcome.evaluationContractHash,
    resolveGraderPublicKey: (version: string) => version === 'grader-1' ? grader.publicKey : null,
    now: new Date('2026-09-30T00:03:00Z') };
  resign();
  return { value, input, resign };
}

test('real task contract requires device and independent grader signatures with retained evidence', () => {
  const { value, input, resign } = fixture();
  const verified = verifyCodexTaskObservation(resign(), input);
  assert.equal(verified.ok, true);
  if (verified.ok) {
    assert.equal(verified.logicalRequestId, value.logicalRequestId);
    assert.equal(verified.outcome, 'passed');
    assert.match(verified.observationHash, /^sha256:[a-f0-9]{64}$/);
  }
  assert.equal(value.provider.executedModel, null);
});

test('platform consent receipt retains its exact consent_ identity through signed intake', () => {
  const { value, input, resign } = fixture();
  value.consent.receiptId = `consent_${randomUUID()}`;
  const signed = resign();
  assert.equal(verifyCodexTaskObservation(signed, input).ok, true);
  assert.deepEqual(verifyCodexTaskObservation(signed, { ...input,
    consent: { ...input.consent, receiptId: value.consent.receiptId.slice('consent_'.length) } }),
  { ok: false, reason: 'codex_task_consent_inactive' });
});

test('provider disclosure consent cannot be replaced by source consent, a grant or an arbitrary string', () => {
  for (const receiptId of [`repo_consent_${randomUUID()}`, `consent_${randomUUID()}\n`,
    'consent_not-a-uuid', 'dhab_example', 'Bearer example', 'x'.repeat(1000)]) {
    const { value, resign } = fixture();
    value.consent.receiptId = receiptId;
    assert.throws(resign, /codex_task_observation_invalid/);
  }
});

test('logical identity is stable for provider retries and differs for distinct work and repository bindings', () => {
  const { input } = fixture();
  const initial = codexTaskLogicalRequestId(input.scope);
  assert.equal(codexTaskLogicalRequestId({ ...input.scope, turnId: 'retry_2' } as CodexTaskScope), initial);
  assert.notEqual(codexTaskLogicalRequestId({ ...input.scope, workId: 'logical_job_2' }), initial);
  assert.notEqual(codexTaskLogicalRequestId({ ...input.scope, repositoryBindingId: randomUUID() }), initial);
});

test('foreign tenants, endpoints, work identities and revoked devices cannot enter intake', () => {
  for (const key of ['organizationId', 'repositoryBindingId', 'workspaceId', 'endpointId', 'membershipId',
    'deviceId', 'bindingId', 'workId'] as const) {
    const { input, resign } = fixture();
    input.scope = { ...input.scope, [key]: key === 'organizationId' || key === 'workId' ? 'foreign' : randomUUID() };
    assert.deepEqual(verifyCodexTaskObservation(resign(), input), { ok: false, reason: 'codex_task_scope_mismatch' });
  }
  const { input, resign } = fixture();
  assert.deepEqual(verifyCodexTaskObservation(resign(), { ...input, deviceActive: false }),
    { ok: false, reason: 'codex_task_device_revoked' });
});

test('current consent, package, context, source snapshots and public grade evidence must match', () => {
  const { input, resign } = fixture();
  const signed = resign();
  for (const consent of [null, { ...input.consent, revision: 2 }]) {
    assert.deepEqual(verifyCodexTaskObservation(signed, { ...input, consent }),
      { ok: false, reason: 'codex_task_consent_inactive' });
  }
  assert.deepEqual(verifyCodexTaskObservation(signed, { ...input, package: { ...input.package, releaseId: randomUUID() } }),
    { ok: false, reason: 'codex_task_package_mismatch' });
  assert.deepEqual(verifyCodexTaskObservation(signed, { ...input, retained: null }),
    { ok: false, reason: 'codex_task_retained_evidence_mismatch' });
  for (const key of ['sourceSnapshotHash', 'resultSnapshotHash', 'publicEvidenceHash'] as const) {
    assert.deepEqual(verifyCodexTaskObservation(signed, { ...input, retained: { ...input.retained, [key]: digest('9') } }),
      { ok: false, reason: 'codex_task_retained_evidence_mismatch' });
  }
  for (const key of ['retainedContextHash', 'requestedModel', 'runtimeVersion'] as const) {
    assert.deepEqual(verifyCodexTaskObservation(signed, { ...input, retained: { ...input.retained,
      provider: { ...input.retained.provider, [key]: key === 'retainedContextHash' ? digest('9') : 'different' } } }),
      { ok: false, reason: 'codex_task_retained_evidence_mismatch' });
  }
});

test('tampering, missing grader trust, self-grading and unrelated grade contracts are rejected', () => {
  const { value, input, resign } = fixture();
  const signed = resign();
  assert.deepEqual(verifyCodexTaskObservation({ ...signed, resultSnapshotHash: digest('9') }, input),
    { ok: false, reason: 'codex_task_device_signature_invalid' });
  assert.deepEqual(verifyCodexTaskObservation(signed, { ...input, resolveGraderPublicKey: () => null }),
    { ok: false, reason: 'codex_task_grader_signature_invalid' });
  assert.deepEqual(verifyCodexTaskObservation(signed, { ...input, resolveGraderPublicKey: () => { throw new Error('trust unavailable'); } }),
    { ok: false, reason: 'codex_task_grader_signature_invalid' });
  const { signature: _signature, ...grade } = value.outcome;
  value.outcome.signature = signCanonicalObject(grade, device.privateKey);
  const selfGraded = signCodexTaskObservation(value, device.privateKey);
  assert.deepEqual(verifyCodexTaskObservation(selfGraded, { ...input, resolveGraderPublicKey: () => device.publicKey }),
    { ok: false, reason: 'codex_task_grader_signature_invalid' });
  assert.deepEqual(verifyCodexTaskObservation(resign(), { ...input, evaluationContractHash: digest('9') }),
    { ok: false, reason: 'codex_task_outcome_mismatch' });
});

test('failed and interrupted work retain actual failures; neither can produce a passing grade', () => {
  for (const state of ['failed', 'interrupted'] as const) {
    const { value, input, resign } = fixture();
    value.capture.terminalState = state;
    input.retained.capture.terminalState = state;
    assert.deepEqual(verifyCodexTaskObservation(resign(), input), { ok: false, reason: 'codex_task_outcome_mismatch' });
    value.outcome.status = 'failed';
    const result = verifyCodexTaskObservation(resign(), input);
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.outcome, 'failed');
  }
});

test('a forged grade cannot be made valid by the enrolled device signing it', () => {
  const { value, input } = fixture();
  value.outcome.publicEvidenceHash = digest('9');
  input.retained.publicEvidenceHash = digest('9');
  assert.deepEqual(verifyCodexTaskObservation(signCodexTaskObservation(value, device.privateKey), input),
    { ok: false, reason: 'codex_task_grader_signature_invalid' });
});

test('trusted KMS grader versions and canonical signatures are supported', () => {
  const { value, input, resign } = fixture();
  const version = 'projects/demo/locations/global/keyRings/learning/cryptoKeys/grader/cryptoKeyVersions/1';
  value.outcome.signerKeyVersion = version;
  input.resolveGraderPublicKey = name => name === version ? grader.publicKey : null;
  const signed = resign();
  assert.equal(verifyCodexTaskObservation(signed, input).ok, true);
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  const alternate = signed.signature.slice(0, -1) + alphabet[alphabet.indexOf(signed.signature.at(-1)!) + 1];
  assert.deepEqual(Buffer.from(alternate, 'base64url'), Buffer.from(signed.signature, 'base64url'));
  assert.deepEqual(verifyCodexTaskObservation({ ...signed, signature: alternate }, input),
    { ok: false, reason: 'codex_task_device_signature_invalid' });
});

test('partial, secret-bearing and fabricated executed-model records fail strict parsing', () => {
  const { value } = fixture();
  const mutations = [
    { ...value, grant: 'forbidden' },
    { ...value, capture: { ...value.capture, coverage: 'partial' } },
    { ...value, capture: { ...value.capture, droppedEvents: 1 } },
    { ...value, provider: { ...value.provider, executedModel: value.provider.requestedModel } },
    { ...value, outcome: { ...value.outcome, privateGraderPath: '/private/grader' } },
  ];
  for (const mutation of mutations) assert.throws(() => signCodexTaskObservation(
    mutation as Omit<CodexTaskObservation, 'signature'>, device.privateKey), /codex_task_observation_invalid/);
});

test('grading cannot precede work completion or arrive with a future timestamp', () => {
  for (const completedAt of ['2026-09-29T23:59:00Z', '2026-09-30T01:00:00Z']) {
    const { value, input, resign } = fixture();
    value.outcome.completedAt = completedAt;
    assert.deepEqual(verifyCodexTaskObservation(resign(), input), { ok: false, reason: 'codex_task_time_invalid' });
  }
});

test('published schema and packaged validator schema stay identical', async () => {
  const packaged = JSON.parse(await readFile(new URL('./codex-task-observation.schema.json', import.meta.url), 'utf8'));
  const published = JSON.parse(await readFile(new URL('../../../schemas/codex-task-observation.schema.json', import.meta.url), 'utf8'));
  assert.deepEqual(packaged, published);
});

function outcomeFixture() {
  const { value, input } = fixture();
  return { outcome: value.outcome, input: {
    logicalRequestId: value.logicalRequestId, captureHash: value.capture.captureHash,
    sourceSnapshotHash: value.sourceSnapshotHash, resultSnapshotHash: value.resultSnapshotHash,
    evaluationContractHash: input.evaluationContractHash, publicEvidenceHash: input.retained.publicEvidenceHash,
    workCompletedAt: value.capture.completedAt, terminalState: value.capture.terminalState,
    devicePublicKey: input.devicePublicKey, resolveGraderPublicKey: input.resolveGraderPublicKey, now: input.now,
  } };
}

test('standalone outcome read path returns a stable verified receipt reference', () => {
  const { outcome, input } = outcomeFixture();
  const result = verifyCodexTaskOutcome(outcome, input);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.receiptId, outcome.receiptId);
    assert.equal(result.status, 'passed');
    assert.match(result.receiptHash, /^sha256:[a-f0-9]{64}$/);
    assert.deepEqual(verifyCodexTaskOutcome(structuredClone(outcome), input), result);
  }
});

test('standalone outcomes require every retained evidence and evaluation binding', () => {
  const { outcome, input } = outcomeFixture();
  for (const key of ['logicalRequestId', 'captureHash', 'sourceSnapshotHash', 'resultSnapshotHash',
    'evaluationContractHash', 'publicEvidenceHash'] as const) {
    assert.deepEqual(verifyCodexTaskOutcome(outcome, { ...input, [key]: 'unrelated' }),
      { ok: false, reason: 'codex_task_outcome_mismatch' });
  }
  assert.deepEqual(verifyCodexTaskOutcome({ ...outcome, privateGraderPath: '/hidden' }, input),
    { ok: false, reason: 'codex_task_outcome_invalid' });
});

test('standalone outcomes reject forged or self-signed receipts and unavailable trust', () => {
  const { outcome, input } = outcomeFixture();
  assert.deepEqual(verifyCodexTaskOutcome({ ...outcome, receiptId: randomUUID() }, input),
    { ok: false, reason: 'codex_task_grader_signature_invalid' });
  const { signature: _signature, ...payload } = outcome;
  const selfSigned = { ...payload, signature: signCanonicalObject(payload, device.privateKey) };
  assert.deepEqual(verifyCodexTaskOutcome(selfSigned, { ...input, resolveGraderPublicKey: () => device.publicKey }),
    { ok: false, reason: 'codex_task_grader_signature_invalid' });
  assert.deepEqual(verifyCodexTaskOutcome(outcome, { ...input, resolveGraderPublicKey: () => null }),
    { ok: false, reason: 'codex_task_grader_signature_invalid' });
});

test('standalone outcomes reject invalid work time and passing interrupted work', () => {
  const { outcome, input } = outcomeFixture();
  for (const workCompletedAt of ['invalid', '2026-09-30T00:03:00Z']) {
    assert.deepEqual(verifyCodexTaskOutcome(outcome, { ...input, workCompletedAt }),
      { ok: false, reason: 'codex_task_time_invalid' });
  }
  assert.deepEqual(verifyCodexTaskOutcome(outcome, { ...input, terminalState: 'interrupted' }),
    { ok: false, reason: 'codex_task_outcome_mismatch' });
  assert.deepEqual(verifyCodexTaskOutcome(outcome, { ...input, now: new Date('invalid') }),
    { ok: false, reason: 'codex_task_time_invalid' });
});
