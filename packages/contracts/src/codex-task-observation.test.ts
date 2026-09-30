import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { codexTaskLogicalRequestId, signCodexTaskObservation, verifyCodexTaskObservation, verifyCodexTaskOutcome,
  verifyCodexTaskCaptureBytes, sha256, signCanonicalObject, type CodexTaskObservation, type CodexTaskScope } from './index.js';

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
  const captureBytes = () => {
    const request = { method: 'turn/start', params: { threadId: value.capture.threadId,
      input: [{ type: 'text', text: 'Fix synthetic duplicate job handling.' }], cwd: '/synthetic/repository',
      approvalPolicy: 'never', permissions: 'dharma_work' } };
    const events = [{ sequence: 0, receivedAt: value.capture.completedAt, notification: {
      method: 'turn/completed', params: { threadId: value.capture.threadId,
        turn: { id: value.capture.turnId, status: value.capture.terminalState, items: [] } } } }];
    value.capture.requestHash = sha256(JSON.stringify(request));
    value.capture.eventsHash = sha256(JSON.stringify(events));
    const bytes = Buffer.from(JSON.stringify({ schema: 'dharma.codex-local-work-capture/v2', ...scope,
      captureId: value.capture.captureId, provider: 'codex', providerThreadId: value.capture.threadId,
      providerTurnId: value.capture.turnId, startedAt: value.capture.startedAt, closedAt: value.capture.completedAt,
      workOutcome: value.capture.terminalState === 'completed' ? 'completed' : 'failed',
      providerTurnState: value.capture.terminalState, captureScope: 'turn_request_and_notifications',
      coverage: 'observed', limitations: [], droppedEvents: 0, acceptedLearningObservation: false,
      executedModel: null, request, requestHash: value.capture.requestHash, events, eventsHash: value.capture.eventsHash }));
    value.capture.captureHash = sha256(bytes.toString());
    value.outcome.captureHash = value.capture.captureHash;
    return bytes;
  };
  const retainedBytes = captureBytes();
  const input = { scope, devicePublicKey: device.publicKey, deviceActive: true, consent: value.consent,
    package: value.package, retained: { capture: structuredClone(value.capture), captureBytes: retainedBytes, sourceSnapshotHash: value.sourceSnapshotHash,
      resultSnapshotHash: value.resultSnapshotHash, provider: structuredClone(value.provider),
      publicEvidenceHash: value.outcome.publicEvidenceHash }, evaluationContractHash: value.outcome.evaluationContractHash,
    resolveGraderPublicKey: (version: string) => version === 'grader-1' ? grader.publicKey : null,
    now: new Date('2026-09-30T00:03:00Z') };
  resign();
  const refreshCapture = () => {
    input.retained.captureBytes = captureBytes();
    input.retained.capture = structuredClone(value.capture);
  };
  return { value, input, resign, refreshCapture };
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

test('matching retained descriptors alone do not prove retained native capture bytes', () => {
  const { input, resign } = fixture();
  const { captureBytes: _captureBytes, ...retained } = input.retained;
  assert.deepEqual(verifyCodexTaskObservation(resign(), { ...input, retained }),
    { ok: false, reason: 'codex_task_capture_bytes_unavailable' });
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
    const { value, input, resign, refreshCapture } = fixture();
    value.capture.terminalState = state;
    refreshCapture();
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
  const capturePackaged = JSON.parse(await readFile(new URL('./codex-local-work-capture-v2.schema.json', import.meta.url), 'utf8'));
  const capturePublished = JSON.parse(await readFile(new URL('../../../schemas/codex-local-work-capture-v2.schema.json', import.meta.url), 'utf8'));
  assert.deepEqual(capturePackaged, capturePublished);
});

test('retained native bytes must match the signed exact-byte digest', () => {
  const { input, resign } = fixture();
  const bytes = Buffer.from(input.retained.captureBytes.toString().replace('synthetic/repository', 'synthetic/different'));
  assert.deepEqual(verifyCodexTaskObservation(resign(), { ...input, retained: { ...input.retained, captureBytes: bytes } }),
    { ok: false, reason: 'codex_task_capture_hash_mismatch' });
});

test('capture parser rejects ambiguous serialization, invalid UTF-8, v1 and excessive bytes', () => {
  const { input } = fixture(), text = input.retained.captureBytes.toString();
  const captureInput = { scope: input.scope, capture: input.retained.capture, now: input.now };
  for (const bytes of [Buffer.from(text + '\n'), Buffer.from(`{"schema":"ignored",${text.slice(1)}`),
    Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text)]),
    Buffer.from([0xc3, 0x28]), Buffer.alloc(3 * 1024 * 1024 + 1),
    Buffer.from(text.replace('dharma.codex-local-work-capture/v2', 'dharma.codex-local-work-capture/v1'))]) {
    assert.deepEqual(verifyCodexTaskCaptureBytes(bytes, captureInput),
      { ok: false, reason: 'codex_task_capture_bytes_invalid' });
  }
});

test('capture verification checks time bounds and returns no private content on rejection', () => {
  const { input } = fixture(), raw = JSON.parse(input.retained.captureBytes.toString());
  const captureInput = { scope: input.scope, capture: input.retained.capture };
  for (const now of [new Date('invalid'), new Date('2026-09-29T23:00:00Z')]) {
    assert.deepEqual(verifyCodexTaskCaptureBytes(input.retained.captureBytes, { ...captureInput, now }),
      { ok: false, reason: 'codex_task_time_invalid' });
  }
  raw.request.params.input[0].text = 'PRIVATE_CONTENT_CANARY';
  const failure = verifyCodexTaskCaptureBytes(Buffer.from(JSON.stringify(raw)), { ...captureInput, now: input.now });
  assert.equal(failure.ok, false);
  assert.equal(JSON.stringify(failure).includes('PRIVATE_CONTENT_CANARY'), false);
});

test('capture verification recomputes request and event hashes rather than trusting matching descriptors', () => {
  for (const field of ['request', 'events'] as const) {
    const { input } = fixture(), raw = JSON.parse(input.retained.captureBytes.toString());
    if (field === 'request') raw.request.params.input[0].text = 'Changed task';
    else raw.events[0].notification.params.turn.items = [{ type: 'agentMessage', text: 'Changed answer' }];
    const bytes = Buffer.from(JSON.stringify(raw));
    assert.deepEqual(verifyCodexTaskCaptureBytes(bytes, { scope: input.scope, now: input.now,
      capture: { ...input.retained.capture, captureHash: sha256(bytes.toString()) } }),
    { ok: false, reason: 'codex_task_capture_hash_mismatch' });
  }
});

test('rehashing forged captures cannot hide foreign events, missing termination or contradictory coverage', () => {
  const mutations: Array<[string, (raw: any) => void]> = [
    ['codex_task_capture_scope_mismatch', raw => { raw.deviceId = randomUUID(); }],
    ['codex_task_capture_scope_mismatch', raw => { raw.request.params.threadId = 'foreign'; }],
    ['codex_task_capture_scope_mismatch', raw => { raw.events[0].notification.params.threadId = 'foreign'; }],
    ['codex_task_capture_scope_mismatch', raw => { raw.events[0].notification.params.turnId = 'foreign'; }],
    ['codex_task_capture_scope_mismatch', raw => { raw.events[0].notification.method = 'unrelated/event'; }],
    ['codex_task_capture_terminal_unavailable', raw => { raw.events = []; }],
    ['codex_task_capture_terminal_mismatch', raw => { raw.events[0].notification.params.turn.status = 'failed'; }],
    ['codex_task_capture_not_observed', raw => { raw.coverage = 'partial'; }],
    ['codex_task_capture_not_observed', raw => { raw.droppedEvents = 1; }],
    ['codex_task_capture_not_observed', raw => { raw.limitations = ['capture_limit']; }],
    ['codex_task_capture_event_order_invalid', raw => { raw.events.push(structuredClone(raw.events[0])); }],
    ['codex_task_capture_event_order_invalid', raw => { raw.events[0].receivedAt = '2026-09-29T23:59:00Z'; }],
    ['codex_task_capture_event_order_invalid', raw => { raw.events[0].receivedAt = '2026-09-30T00:04:00Z'; }],
  ];
  for (const [reason, mutate] of mutations) {
    const { input } = fixture(), raw = JSON.parse(input.retained.captureBytes.toString());
    mutate(raw);
    raw.requestHash = sha256(JSON.stringify(raw.request)); raw.eventsHash = sha256(JSON.stringify(raw.events));
    const bytes = Buffer.from(JSON.stringify(raw));
    assert.deepEqual(verifyCodexTaskCaptureBytes(bytes, { scope: input.scope, now: input.now,
      capture: { ...input.retained.capture, captureHash: sha256(bytes.toString()),
        requestHash: raw.requestHash, eventsHash: raw.eventsHash } }), { ok: false, reason }, reason);
  }
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
