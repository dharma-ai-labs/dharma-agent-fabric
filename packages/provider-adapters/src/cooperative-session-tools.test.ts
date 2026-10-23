import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { test } from 'node:test';
import { canonicalize, sha256, signCanonicalObject, type SessionQuestion } from '@dharma-ai-labs/agent-fabric-contracts';
import { createCooperativeSessionMcpHandlers } from './cooperative-session-server.js';

type Consumer = NonNullable<Parameters<typeof createCooperativeSessionMcpHandlers>[0]>;
type Handlers = ReturnType<typeof createCooperativeSessionMcpHandlers>;
type Result = Awaited<ReturnType<Handlers['checkpoint']>>;
type Answer = { questionId: string; taskId: string; nonce: string; offerHash: string; attemptId: string; answer: string };
type Context = Readonly<{ signal: AbortSignal }>;
const SCHEMA = 'dharma.cooperative-session-tool-result/v1';
const CANARY = 'SYNTHETIC_PRIVATE_DIAGNOSTIC_DO_NOT_ECHO';
const uuid = (last: number) => `40000000-0000-4000-8000-${String(last).padStart(12, '0')}`;
const digest = (label: string) => sha256(label);
const { privateKey } = generateKeyPairSync('ed25519');

function offer(question = 'Which signed catalog applies?'): SessionQuestion {
  const unsigned: Omit<SessionQuestion, 'signature'> = {
    schema: 'dharma.session-question/v1', questionId: uuid(10), taskId: uuid(11),
    organizationId: 'org_test', repositoryBindingId: uuid(1),
    source: { workspaceId: uuid(12), endpointId: uuid(13), membershipId: uuid(14), deviceId: uuid(15) },
    target: { workspaceId: uuid(2), endpointId: uuid(3), membershipId: uuid(4),
      deviceId: uuid(5), bindingId: uuid(6), provider: 'codex' },
    category: 'architecture', question,
    authority: { mode: 'read_only', readPaths: ['.'], network: 'deny', maximumProviderCostCents: 25 },
    createdAt: '2026-09-26T05:00:00.000Z', expiresAt: '2026-09-26T05:15:00.000Z',
    nonce: uuid(16), signerKeyVersion: 'projects/test/locations/global/keyRings/af/cryptoKeys/questions/cryptoKeyVersions/1',
  };
  return { ...unsigned, signature: signCanonicalObject(unsigned, privateKey) };
}
function answer(): Answer {
  return { questionId: uuid(10), taskId: uuid(11), nonce: uuid(16),
    offerHash: digest('offer'), attemptId: uuid(17), answer: 'Use the signed catalog.' };
}
function pending() {
  return { state: 'reply_pending', questionId: uuid(10), taskId: uuid(11), completionHash: digest('completion') };
}
function answered(value: Answer) {
  return { state: 'answered', questionId: value.questionId, taskId: value.taskId,
    targetBindingId: uuid(6), replay: false, correlationId: uuid(90), completionHash: digest('completion') };
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
function fixture() {
  const calls = { checkpoint: 0, submit: 0, close: 0, retire: 0 };
  const seen: { contexts: Context[]; answers: Answer[] } = { contexts: [], answers: [] };
  const behavior: {
    checkpoint(): Promise<unknown>;
    submit(value: Answer): Promise<unknown>;
  } = { checkpoint: async () => ({ state: 'idle' }), submit: async value => answered(value) };
  const consumer = {
    async checkpoint(context: Context): Promise<unknown> {
      calls.checkpoint++; seen.contexts.push(context); return behavior.checkpoint();
    },
    async submitAnswer(value: Answer, context: Context): Promise<unknown> {
      calls.submit++; seen.contexts.push(context); seen.answers.push(value); return behavior.submit(value);
    },
    close() { calls.close++; },
    retire() { calls.retire++; },
  };
  return { consumer, behavior, calls, seen };
}
function payload(result: Result): Record<string, unknown> {
  assert.ok(result && typeof result === 'object');
  assert.ok(Array.isArray(result.content));
  const texts = result.content.filter(part => part.type === 'text');
  assert.ok(texts.length >= 1, 'a matching JSON text result is required');
  assert.ok(result.structuredContent && typeof result.structuredContent === 'object');
  for (const part of texts) {
    assert.equal(part.type, 'text');
    if (part.type === 'text') assert.deepEqual(JSON.parse(part.text), result.structuredContent);
  }
  const value = result.structuredContent as Record<string, unknown>;
  assert.equal(value.schema, SCHEMA);
  return value;
}
function ok(result: Result, expected: Record<string, unknown>) {
  assert.notEqual(result.isError, true);
  assert.deepEqual(payload(result), { schema: SCHEMA, ...expected });
}
function failure(result: Result, code: string) {
  assert.equal(result.isError, true);
  assert.deepEqual(payload(result), { schema: SCHEMA, state: 'error', code });
  for (const part of result.content) {
    if (part.type === 'text') assert.equal(part.text.includes(CANARY), false);
  }
}
function signal() { return new AbortController().signal; }
function calls(f: ReturnType<typeof fixture>) { return f.calls.checkpoint + f.calls.submit; }
async function poisoned(h: Handlers, f: ReturnType<typeof fixture>, count: number) {
  failure(await h.checkpoint({}, signal()), 'unavailable');
  failure(await h.submitAnswer(answer(), signal()), 'unavailable');
  assert.equal(calls(f), count);
}
function constructorInvalid(value: unknown) {
  assert.throws(() => createCooperativeSessionMcpHandlers(value as Consumer | null),
    { message: 'cooperative_mcp_consumer_unavailable' });
}
test("constructor rejects absent or incomplete consumers without dispatch", { timeout: 5_000 }, async () => {
  for (const value of [null, undefined, {}, true, { active: true }, { checkpoint: async () => ({ state: 'idle' }) },
    { checkpoint: async () => ({ state: 'idle' }), submitAnswer: false }]) constructorInvalid(value);
});

test("constructor rejects consumer Proxy and revoked Proxy before traps", { timeout: 5_000 }, async () => {
  let callbacks = 0;
  const fail = (): never => { callbacks++; throw new Error(CANARY); };
  const f = fixture();
  const proxy = new Proxy(f.consumer, { get: fail, getPrototypeOf: fail, ownKeys: fail, getOwnPropertyDescriptor: fail });
  const revoked = Proxy.revocable(f.consumer, {}); revoked.revoke();
  for (const value of [proxy, revoked.proxy]) constructorInvalid(value);
  assert.equal(callbacks, 0); assert.equal(calls(f), 0);
});

test("constructor rejects required method accessors without invoking them", { timeout: 5_000 }, async () => {
  for (const field of ['checkpoint', 'submitAnswer'] as const) {
    const f = fixture(); let callbacks = 0;
    Object.defineProperty(f.consumer, field, { enumerable: true, get() { callbacks++; throw new Error(CANARY); } });
    constructorInvalid(f.consumer);
    assert.equal(callbacks, 0); assert.equal(calls(f), 0);
  }
});

test("handlers capture both original consumer methods once at construction", { timeout: 5_000 }, async () => {
  const f = fixture(), h = createCooperativeSessionMcpHandlers(f.consumer);
  let callbacks = 0;
  for (const field of ['checkpoint', 'submitAnswer'] as const) {
    Object.defineProperty(f.consumer, field, { enumerable: true, get() { callbacks++; throw new Error(CANARY); } });
  }
  ok(await h.checkpoint({}, signal()), { state: 'idle' });
  ok(await h.submitAnswer(answer(), signal()), answered(answer()));
  assert.equal(callbacks, 0); assert.equal(f.calls.checkpoint, 1); assert.equal(f.calls.submit, 1);
});

test("empty and frozen checkpoint arguments produce matching schema-tagged JSON", { timeout: 5_000 }, async () => {
  const f = fixture(), h = createCooperativeSessionMcpHandlers(f.consumer);
  ok(await h.checkpoint({}, signal()), { state: 'idle' });
  ok(await h.checkpoint(Object.freeze({}), signal()), { state: 'idle' });
  assert.equal(f.calls.checkpoint, 2);
});

test("checkpoint rejects nonplain extra hidden symbol and metadata arguments before dispatch", { timeout: 5_000 }, async () => {
  const hidden = {}; Object.defineProperty(hidden, 'extra', { value: CANARY, enumerable: false });
  const symbol = { [Symbol('synthetic')]: true };
  for (const args of [null, undefined, [], '', Object.create(null), Object.create({ inherited: true }),
    { extra: true }, { sessionId: uuid(20) }, { requestState: CANARY }, hidden, symbol]) {
    const f = fixture(), h = createCooperativeSessionMcpHandlers(f.consumer);
    failure(await h.checkpoint(args, signal()), 'input_invalid'); assert.equal(calls(f), 0);
    ok(await h.checkpoint({}, signal()), { state: 'idle' }); assert.equal(calls(f), 1);
  }
});

test("valid submit arguments are detached before the first consumer await", { timeout: 5_000 }, async () => {
  const f = fixture(), gate = deferred(), entered = deferred();
  f.behavior.submit = async value => { entered.resolve(); await gate.promise; return answered(value); };
  const h = createCooperativeSessionMcpHandlers(f.consumer), input = answer(), expected = { ...input };
  const operation = h.submitAnswer(input, signal());
  try {
    await entered.promise;
    for (const field of Object.keys(input) as Array<keyof Answer>) input[field] = CANARY;
    assert.notStrictEqual(f.seen.answers[0], input);
    assert.deepEqual(f.seen.answers[0], expected);
    gate.resolve(); ok(await operation, answered(expected));
  } finally { gate.resolve(); }
});

test("submit accepts frozen scalar data and preserves permitted multiline answer content", { timeout: 5_000 }, async () => {
  const f = fixture(), h = createCooperativeSessionMcpHandlers(f.consumer);
  const input = Object.freeze({ ...answer(), answer: '  Synthetic\nanswer\tcontent\r  ' });
  ok(await h.submitAnswer(input, signal()), answered(input));
  assert.equal(f.seen.answers[0]?.answer, input.answer);
});

test("submit rejects native identity scope metadata and extra hidden controls before dispatch", { timeout: 5_000 }, async () => {
  const extras = ['nativeSessionId', 'workspaceRoot', 'provider', 'bindingId', 'authority', 'sessionId', 'requestState', '_meta'];
  for (const field of extras) {
    const f = fixture(), h = createCooperativeSessionMcpHandlers(f.consumer);
    failure(await h.submitAnswer({ ...answer(), [field]: CANARY }, signal()), 'input_invalid');
    assert.equal(calls(f), 0);
  }
  for (const args of [Object.assign(Object.create(null) as object, answer()),
    Object.assign(Object.create({ inherited: true }) as object, answer()),
    { ...answer(), [Symbol('synthetic')]: true }]) {
    const f = fixture(), h = createCooperativeSessionMcpHandlers(f.consumer);
    failure(await h.submitAnswer(args, signal()), 'input_invalid'); assert.equal(calls(f), 0);
  }
  const hidden = answer(); Object.defineProperty(hidden, 'extra', { value: CANARY, enumerable: false });
  const f = fixture(), h = createCooperativeSessionMcpHandlers(f.consumer);
  failure(await h.submitAnswer(hidden, signal()), 'input_invalid'); assert.equal(calls(f), 0);
});

test("submit rejects each missing hidden nonstring or accessor field without callbacks", { timeout: 5_000 }, async () => {
  for (const field of Object.keys(answer()) as Array<keyof Answer>) {
    for (const variant of ['missing', 'hidden', 'number', 'getter', 'setter'] as const) {
      const f = fixture(), h = createCooperativeSessionMcpHandlers(f.consumer); let callbacks = 0;
      const input: Partial<Answer> = answer();
      if (variant === 'missing') delete input[field];
      if (variant === 'hidden') Object.defineProperty(input, field, { value: input[field], enumerable: false });
      if (variant === 'number') Object.defineProperty(input, field, { value: 42, enumerable: true });
      if (variant === 'getter') Object.defineProperty(input, field, { enumerable: true, get() { callbacks++; throw new Error(CANARY); } });
      if (variant === 'setter') Object.defineProperty(input, field, { enumerable: true, set(_value: unknown) { callbacks++; throw new Error(CANARY); } });
      const result = await h.submitAnswer(input, signal());
      assert.equal(callbacks, 0); failure(result, 'input_invalid'); assert.equal(calls(f), 0);
    }
  }
});

test("both handlers reject Proxy and revoked argument objects without traps", { timeout: 5_000 }, async () => {
  for (const operation of ['checkpoint', 'submit'] as const) {
    const f = fixture(), h = createCooperativeSessionMcpHandlers(f.consumer); let callbacks = 0;
    const target = operation === 'checkpoint' ? {} : answer();
    const fail = (): never => { callbacks++; throw new Error(CANARY); };
    const proxy = new Proxy(target, { get: fail, getPrototypeOf: fail, ownKeys: fail, getOwnPropertyDescriptor: fail });
    const revoked = Proxy.revocable(target, {}); revoked.revoke();
    for (const args of [proxy, revoked.proxy]) {
      const result = operation === 'checkpoint' ? await h.checkpoint(args, signal()) : await h.submitAnswer(args, signal());
      assert.equal(callbacks, 0); failure(result, 'input_invalid'); assert.equal(calls(f), 0);
    }
  }
});

test("submit enforces existing UUID and lowercase sha256 wire shapes", { timeout: 5_000 }, async () => {
  for (const field of ['questionId', 'taskId', 'nonce', 'attemptId', 'offerHash'] as const) {
    const values = field === 'offerHash'
      ? ['sha256:' + 'A'.repeat(64), 'sha256:' + 'a'.repeat(63), 'a'.repeat(64), digest('valid') + '\n']
      : ['not-a-uuid', uuid(10) + '\n', '', uuid(10).slice(1)];
    for (const value of values) {
      const f = fixture(), h = createCooperativeSessionMcpHandlers(f.consumer);
      failure(await h.submitAnswer({ ...answer(), [field]: value }, signal()), 'input_invalid'); assert.equal(calls(f), 0);
    }
  }
});

test("submit bounds nonblank answer length and existing forbidden controls", { timeout: 5_000 }, async () => {
  for (const value of ['', ' \n\t ', 'x'.repeat(2001), 'bad\u0000control', 'bad\u000bcontrol', 'bad\u007fcontrol']) {
    const f = fixture(), h = createCooperativeSessionMcpHandlers(f.consumer);
    failure(await h.submitAnswer({ ...answer(), answer: value }, signal()), 'input_invalid'); assert.equal(calls(f), 0);
  }
  const f = fixture(), h = createCooperativeSessionMcpHandlers(f.consumer);
  const input = { ...answer(), answer: 'x'.repeat(2000) };
  ok(await h.submitAnswer(input, signal()), answered(input));
});

test("checkpoint preserves all eight allowed states and their exact fields", { timeout: 5_000 }, async () => {
  const signed = offer();
  const results: Array<Record<string, unknown>> = [
    { state: 'idle' },
    { state: 'budget_denied', questionId: uuid(10), taskId: uuid(11) },
    { state: 'handed_off', offer: signed, offerHash: sha256(canonicalize(signed)), attemptId: uuid(17) },
    { state: 'checkpoint_pending', questionId: uuid(10), taskId: uuid(11), offerHash: digest('offer'), attemptId: uuid(17) },
    { state: 'offer_recovery_required', questionId: uuid(10), offerHash: digest('offer') },
    pending(),
    { state: 'reply_reconciled', questionId: uuid(10), taskId: uuid(11), completionHash: digest('completion'),
      replyReceiptHash: digest('receipt'), correlationId: uuid(90) },
    { state: 'reply_quarantined', questionId: uuid(10), taskId: uuid(11), completionHash: digest('completion'),
      dispositionHash: digest('disposition'), reasonCode: 'question_expired', delivered: false },
  ];
  for (const expected of results) {
    const f = fixture(); f.behavior.checkpoint = async () => expected;
    const h = createCooperativeSessionMcpHandlers(f.consumer);
    ok(await h.checkpoint({}, signal()), expected); assert.equal(calls(f), 1);
  }
});

test("submit preserves only answered and correlated reply_pending states", { timeout: 5_000 }, async () => {
  for (const expected of [answered(answer()), pending()]) {
    const f = fixture(); f.behavior.submit = async () => expected;
    const h = createCooperativeSessionMcpHandlers(f.consumer);
    ok(await h.submitAnswer(answer(), signal()), expected);
  }
});

test("reply_pending preserves every fixed reason and blocker code without raw diagnostics", { timeout: 5_000 }, async () => {
  const reasons = ['content_or_contract_blocked', 'receipt_invalid', 'delivery_unconfirmed', 'signed_deadline_expired',
    'dispatch_cancelled', 'answer_conflict', 'remote_not_answered'];
  const blockers = ['text_contract_invalid', 'foreign_policy', 'private_local_path', 'excluded_path', 'redaction_required',
    'metadata_only', 'source_authority_unavailable', 'source_subtree_not_authorized', 'authority_unavailable'];
  for (const reasonCode of reasons) {
    const f = fixture(); const expected = { ...pending(), reasonCode };
    f.behavior.checkpoint = async () => expected;
    ok(await createCooperativeSessionMcpHandlers(f.consumer).checkpoint({}, signal()), expected);
  }
  for (const blocker of blockers) {
    const f = fixture(); const expected = { ...pending(), blocker };
    f.behavior.submit = async () => expected;
    ok(await createCooperativeSessionMcpHandlers(f.consumer).submitAnswer(answer(), signal()), expected);
  }
});

test("handed-off projection preserves valid signed unicode offer and exact canonical hash", { timeout: 5_000 }, async () => {
  const signed = offer('🙂'.repeat(2000));
  const raw = { state: 'handed_off', offer: signed, offerHash: sha256(canonicalize(signed)), attemptId: uuid(17) };
  const f = fixture(); f.behavior.checkpoint = async () => raw;
  const result = await createCooperativeSessionMcpHandlers(f.consumer).checkpoint({}, signal());
  ok(result, raw);
  const value = payload(result);
  assert.equal(sha256(canonicalize(value.offer)), raw.offerHash);
  assert.equal((value.offer as SessionQuestion).question, signed.question);
  assert.ok(Buffer.byteLength(JSON.stringify(value), 'utf8') <= 16384);
});

test("invalid offered schema hash or attempt becomes uncertain and poisons without disclosure", { timeout: 5_000 }, async () => {
  const signed = offer();
  const valid = { state: 'handed_off', offer: signed, offerHash: sha256(canonicalize(signed)), attemptId: uuid(17) };
  const rows = [
    { ...valid, offerHash: digest('different') }, { ...valid, attemptId: 'invalid' },
    { ...valid, offer: { ...signed, privateExtra: CANARY } },
    { ...valid, offer: { ...signed, authority: { ...signed.authority, network: 'allow' } } },
  ];
  for (const raw of rows) {
    const f = fixture(); f.behavior.checkpoint = async () => raw;
    const h = createCooperativeSessionMcpHandlers(f.consumer);
    failure(await h.checkpoint({}, signal()), 'delivery_unconfirmed'); await poisoned(h, f, 1);
  }
});

test("metadata-only pending and recovery states never allow an extra offer or answer", { timeout: 5_000 }, async () => {
  for (const raw of [
    { state: 'checkpoint_pending', questionId: uuid(10), taskId: uuid(11), offerHash: digest('offer'), attemptId: uuid(17), offer: offer() },
    { state: 'offer_recovery_required', questionId: uuid(10), offerHash: digest('offer'), answer: CANARY },
  ]) {
    const f = fixture(); f.behavior.checkpoint = async () => raw;
    const h = createCooperativeSessionMcpHandlers(f.consumer);
    failure(await h.checkpoint({}, signal()), 'delivery_unconfirmed'); await poisoned(h, f, 1);
  }
});

test("submit result question and task must match captured input exactly", { timeout: 5_000 }, async () => {
  for (const state of ['answered', 'reply_pending'] as const) {
    for (const field of ['questionId', 'taskId'] as const) {
      const f = fixture();
      f.behavior.submit = async value => ({ ...(state === 'answered' ? answered(value) : pending()), [field]: uuid(99) });
      const h = createCooperativeSessionMcpHandlers(f.consumer);
      failure(await h.submitAnswer(answer(), signal()), 'delivery_unconfirmed'); await poisoned(h, f, 1);
    }
  }
});

test("already-aborted calls do not dispatch or poison either handler", { timeout: 5_000 }, async () => {
  for (const operation of ['checkpoint', 'submit'] as const) {
    const f = fixture(), h = createCooperativeSessionMcpHandlers(f.consumer), controller = new AbortController();
    controller.abort();
    failure(operation === 'checkpoint' ? await h.checkpoint({}, controller.signal)
      : await h.submitAnswer(answer(), controller.signal), 'cancelled');
    assert.equal(calls(f), 0);
    ok(await h.checkpoint({}, signal()), { state: 'idle' }); assert.equal(calls(f), 1);
  }
});

test("consumer receives the original live signal in a frozen signal-only context", { timeout: 5_000 }, async () => {
  for (const operation of ['checkpoint', 'submit'] as const) {
    const f = fixture(), entered = deferred(), gate = deferred(), controller = new AbortController();
    const wait = async () => { entered.resolve(); await gate.promise; return operation === 'checkpoint' ? { state: 'idle' } : answered(answer()); };
    f.behavior.checkpoint = wait; f.behavior.submit = wait;
    const h = createCooperativeSessionMcpHandlers(f.consumer);
    const pending = operation === 'checkpoint' ? h.checkpoint({}, controller.signal) : h.submitAnswer(answer(), controller.signal);
    try {
      await entered.promise;
      const context = f.seen.contexts[0]; assert.ok(context);
      assert.strictEqual(context.signal, controller.signal);
      assert.equal(Object.isFrozen(context), true);
      assert.deepEqual(Reflect.ownKeys(context), ['signal']);
      gate.resolve(); ok(await pending, operation === 'checkpoint' ? { state: 'idle' } : answered(answer()));
    } finally { gate.resolve(); }
  }
});

test("post-invocation abort waits for owned work then returns uncertainty and poisons", { timeout: 5_000 }, async () => {
  for (const operation of ['checkpoint', 'submit'] as const) {
    const f = fixture(), entered = deferred(), gate = deferred(), controller = new AbortController();
    let completed = false;
    const wait = async () => { entered.resolve(); await gate.promise; completed = true; return operation === 'checkpoint' ? { state: 'idle' } : answered(answer()); };
    f.behavior.checkpoint = wait; f.behavior.submit = wait;
    const h = createCooperativeSessionMcpHandlers(f.consumer);
    const pending = operation === 'checkpoint' ? h.checkpoint({}, controller.signal) : h.submitAnswer(answer(), controller.signal);
    let settled = false;
    void pending.then(() => { settled = true; }, () => { settled = true; });
    try {
      await entered.promise; controller.abort();
      assert.strictEqual(f.seen.contexts[0]?.signal, controller.signal);
      assert.equal(f.seen.contexts[0]?.signal.aborted, true);
      await new Promise<void>(done => { setImmediate(done); });
      assert.equal(completed, false); assert.equal(settled, false, 'no Promise.race may pretend owned work ended');
      gate.resolve(); failure(await pending, 'delivery_unconfirmed');
      assert.equal(completed, true); await poisoned(h, f, 1);
    } finally { gate.resolve(); }
  }
});

test("concurrent valid request is busy without dispatch and normal work continues afterward", { timeout: 5_000 }, async () => {
  const f = fixture(), entered = deferred(), gate = deferred();
  f.behavior.checkpoint = async () => { entered.resolve(); await gate.promise; return { state: 'idle' }; };
  const h = createCooperativeSessionMcpHandlers(f.consumer);
  const active = h.checkpoint({}, signal());
  try {
    await entered.promise;
    failure(await h.submitAnswer(answer(), signal()), 'busy');
    assert.equal(f.calls.checkpoint, 1); assert.equal(f.calls.submit, 0);
    gate.resolve(); ok(await active, { state: 'idle' });
    ok(await h.submitAnswer(answer(), signal()), answered(answer())); assert.equal(calls(f), 2);
  } finally { gate.resolve(); }
});

test("consumer busy and handoff_pending refusals do not poison the adapter", { timeout: 5_000 }, async () => {
  for (const code of ['cooperative_session_busy', 'cooperative_session_handoff_pending']) {
    const f = fixture(); f.behavior.checkpoint = async () => { throw new Error(code); };
    const h = createCooperativeSessionMcpHandlers(f.consumer);
    failure(await h.checkpoint({}, signal()), 'busy');
    f.behavior.checkpoint = async () => ({ state: 'idle' });
    ok(await h.checkpoint({}, signal()), { state: 'idle' }); assert.equal(calls(f), 2);
  }
});

test("known consumer errors map to fixed codes and poison except the explicit busy cases", { timeout: 5_000 }, async () => {
  const mappings: Array<[string, string]> = [
    ['cooperative_session_submission_invalid', 'submission_invalid'],
    ['cooperative_session_submission_mismatch', 'submission_mismatch'],
    ['cooperative_session_answer_invalid', 'answer_invalid'],
    ['cooperative_session_signer_untrusted', 'signer_untrusted'],
    ['cooperative_session_content_denied', 'content_blocked'],
    ['provider_session_channel_input', 'content_blocked'],
    ['cooperative_session_owner_lost', 'owner_lost'],
    ['provider_session_channel_owner_lost', 'owner_lost'],
    ['provider_session_channel_response', 'receipt_invalid'],
    ['provider_session_channel_cancelled', 'cancelled'],
    ['provider_session_channel_deadline', 'deadline'],
    ['provider_session_channel_uncertain', 'delivery_unconfirmed'],
    ['cooperative_session_failure_delivery_unconfirmed', 'delivery_unconfirmed'],
    ['cooperative_session_unavailable', 'unavailable'],
    ['cooperative_session_binding_unavailable', 'unavailable'],
    ['cooperative_session_lease_unavailable', 'unavailable'],
    ['provider_session_channel_unavailable', 'unavailable'],
    ['provider_session_channel_closed', 'unavailable'],
    ['provider_session_channel_revoked', 'unavailable'],
  ];
  for (const [source, code] of mappings) {
    const f = fixture(); f.behavior.checkpoint = async () => { throw new Error(source); };
    const h = createCooperativeSessionMcpHandlers(f.consumer);
    failure(await h.checkpoint({}, signal()), code); await poisoned(h, f, 1);
  }
});

test("unknown thrown strings objects and Errors never expose diagnostic data", { timeout: 5_000 }, async () => {
  for (const value of [CANARY, new Error(CANARY), { message: CANARY }, null, 42, Symbol(CANARY)]) {
    const f = fixture(); f.behavior.checkpoint = async () => { throw value; };
    const h = createCooperativeSessionMcpHandlers(f.consumer);
    failure(await h.checkpoint({}, signal()), 'operation_unconfirmed'); await poisoned(h, f, 1);
  }
});

test("hostile thrown errors do not invoke message getters conversion callbacks or Proxy traps", { timeout: 5_000 }, async () => {
  for (const variant of ['message-getter', 'conversion', 'proxy', 'revoked'] as const) {
    let callbacks = 0;
    const fail = (): never => { callbacks++; throw new Error(CANARY); };
    let value: unknown;
    if (variant === 'message-getter') {
      value = new Error('synthetic'); Object.defineProperty(value, 'message', { get: fail });
    } else if (variant === 'conversion') {
      value = { toString: fail, toJSON: fail, [Symbol.toPrimitive]: fail };
    } else if (variant === 'proxy') {
      value = new Proxy(new Error(CANARY), { get: fail, getPrototypeOf: fail, getOwnPropertyDescriptor: fail, ownKeys: fail });
    } else {
      const revoked = Proxy.revocable(new Error(CANARY), {}); revoked.revoke(); value = revoked.proxy;
    }
    const f = fixture(); f.behavior.checkpoint = async () => { throw value; };
    const h = createCooperativeSessionMcpHandlers(f.consumer);
    const result = await h.checkpoint({}, signal());
    assert.equal(callbacks, 0); failure(result, 'operation_unconfirmed'); await poisoned(h, f, 1);
  }
});

test("output accessors proxies cycles and toJSON are rejected without callback execution", { timeout: 5_000 }, async () => {
  for (const variant of ['getter', 'nested-getter', 'proxy', 'revoked', 'toJSON', 'cycle'] as const) {
    let callbacks = 0; const fail = (): never => { callbacks++; throw new Error(CANARY); };
    let raw: unknown = { state: 'idle' };
    if (variant === 'getter') Object.defineProperty(raw, 'state', { enumerable: true, get: fail });
    if (variant === 'nested-getter') {
      const signed = offer(); const hash = sha256(canonicalize(signed));
      Object.defineProperty(signed, 'question', { enumerable: true, get: fail });
      raw = { state: 'handed_off', offer: signed, offerHash: hash, attemptId: uuid(17) };
    }
  if (variant === 'proxy' || variant === 'revoked') {
    const signed = offer(), hash = sha256(canonicalize(signed));
    const revoked = Proxy.revocable(signed, {}); revoked.revoke();
    const nested = variant === 'proxy'
      ? new Proxy(signed, { get: fail, getPrototypeOf: fail, ownKeys: fail, getOwnPropertyDescriptor: fail })
      : revoked.proxy;
    raw = { state: 'handed_off', offer: nested, offerHash: hash, attemptId: uuid(17) };
  }
    if (variant === 'toJSON') raw = { state: 'idle', toJSON: fail };
    if (variant === 'cycle') { const cycle: Record<string, unknown> = { state: 'idle' }; cycle.self = cycle; raw = cycle; }
    const f = fixture(); f.behavior.checkpoint = async () => raw;
    const h = createCooperativeSessionMcpHandlers(f.consumer);
    const result = await h.checkpoint({}, signal());
    assert.equal(callbacks, 0); failure(result, 'delivery_unconfirmed'); await poisoned(h, f, 1);
  }
});

test("nonplain hidden symbol extra and primitive outputs are uncertain rather than serialized fallback", { timeout: 5_000 }, async () => {
  const hidden = { state: 'idle' }; Object.defineProperty(hidden, 'extra', { value: CANARY, enumerable: false });
  const rows: unknown[] = [
    null, undefined, false, [], 'idle', Object.assign(Object.create(null) as object, { state: 'idle' }),
    Object.assign(Object.create({ inherited: CANARY }) as object, { state: 'idle' }),
    hidden, { state: 'idle', [Symbol(CANARY)]: true }, { state: 'idle', extra: CANARY },
  ];
  for (const raw of rows) {
    const f = fixture(); f.behavior.checkpoint = async () => raw;
    const h = createCooperativeSessionMcpHandlers(f.consumer);
    failure(await h.checkpoint({}, signal()), 'delivery_unconfirmed'); await poisoned(h, f, 1);
  }
});

test("bounded oversized deep wide and node-heavy outputs fail closed without truncation", { timeout: 5_000 }, async () => {
  let deep: unknown = 'leaf'; for (let i = 0; i < 10; i++) deep = { child: deep };
  const wide: Record<string, unknown> = { state: 'idle' };
  for (let i = 0; i < 101; i++) wide['extra' + i] = i;
  const nodes = Array.from({ length: 12 }, () => Array.from({ length: 90 }, () => 'leaf'));
  const utf8Heavy = { state: 'idle', extraA: '€'.repeat(3000), extraB: '€'.repeat(3000) };
  assert.ok(Buffer.byteLength(JSON.stringify(utf8Heavy), 'utf8') > 16384);
  for (const raw of [{ state: 'x'.repeat(4097) }, { state: 'idle', deep }, wide, { state: 'idle', nodes }, utf8Heavy]) {
    const f = fixture(); f.behavior.checkpoint = async () => raw;
    const h = createCooperativeSessionMcpHandlers(f.consumer);
    failure(await h.checkpoint({}, signal()), 'delivery_unconfirmed'); await poisoned(h, f, 1);
  }
});

test("operation-specific union never fabricates delivered failed settlement or accepted learning", { timeout: 5_000 }, async () => {
  for (const raw of [{ state: 'failed' }, { state: 'delivered' }, { state: 'learning_accepted' }, answered(answer()),
    { schema: SCHEMA, state: 'idle' }]) {
    const f = fixture(); f.behavior.checkpoint = async () => raw;
    const h = createCooperativeSessionMcpHandlers(f.consumer);
    failure(await h.checkpoint({}, signal()), 'delivery_unconfirmed'); await poisoned(h, f, 1);
  }
  for (const raw of [{ state: 'idle' }, { state: 'budget_denied', questionId: uuid(10), taskId: uuid(11) }]) {
    const f = fixture(); f.behavior.submit = async () => raw;
    const h = createCooperativeSessionMcpHandlers(f.consumer);
    failure(await h.submitAnswer(answer(), signal()), 'delivery_unconfirmed'); await poisoned(h, f, 1);
  }
});

test("output snapshot is detached and never adds schema to the consumer object", { timeout: 5_000 }, async () => {
  const signed = offer();
  const raw = { state: 'handed_off', offer: signed, offerHash: sha256(canonicalize(signed)), attemptId: uuid(17) };
  const expected = JSON.parse(canonicalize(raw)) as Record<string, unknown>;
  const f = fixture(); f.behavior.checkpoint = async () => raw;
  const result = await createCooperativeSessionMcpHandlers(f.consumer).checkpoint({}, signal());
  assert.equal(Object.hasOwn(raw, 'schema'), false);
  raw.offer.question = CANARY; raw.offer.target.workspaceId = uuid(99);
  (raw.offer.authority.readPaths as string[])[0] = 'mutated'; raw.offerHash = digest('mutated');
  ok(result, expected);
  assert.notStrictEqual(payload(result).offer, raw.offer);
});

test("handoff and later submission retain one consumer without taking over its lifecycle", { timeout: 5_000 }, async () => {
  const signed = offer(), raw = { state: 'handed_off', offer: signed, offerHash: sha256(canonicalize(signed)), attemptId: uuid(17) };
  const f = fixture(); f.behavior.checkpoint = async () => raw;
  const h = createCooperativeSessionMcpHandlers(f.consumer);
  ok(await h.checkpoint({}, signal()), raw);
  const input = { ...answer(), offerHash: raw.offerHash };
  ok(await h.submitAnswer(input, signal()), answered(input));
  assert.equal(f.calls.checkpoint, 1); assert.equal(f.calls.submit, 1);
  assert.equal(f.calls.close, 0); assert.equal(f.calls.retire, 0);
  f.behavior.checkpoint = async () => { throw new Error(CANARY); };
  failure(await h.checkpoint({}, signal()), 'operation_unconfirmed');
  assert.equal(f.calls.close, 0); assert.equal(f.calls.retire, 0);
});

test("quarantine stays explicitly undelivered and optional reason codes remain allowlisted", { timeout: 5_000 }, async () => {
  const quarantined = { state: 'reply_quarantined', questionId: uuid(10), taskId: uuid(11),
    completionHash: digest('completion'), dispositionHash: digest('disposition'), reasonCode: 'question_expired', delivered: false };
  for (const raw of [
    { ...quarantined, delivered: true }, { ...quarantined, reasonCode: CANARY },
    { ...pending(), reasonCode: CANARY }, { ...pending(), blocker: CANARY },
    { ...pending(), completionHash: 'sha256:' + 'A'.repeat(64) },
  ]) {
    const f = fixture(); f.behavior.checkpoint = async () => raw;
    const h = createCooperativeSessionMcpHandlers(f.consumer);
    failure(await h.checkpoint({}, signal()), 'delivery_unconfirmed'); await poisoned(h, f, 1);
  }
});

test("raw diagnostics and raw offers cannot leak through fixed error envelopes", { timeout: 5_000 }, async () => {
  const signed = offer();
  const f = fixture(); f.behavior.submit = async () => { throw { privatePath: CANARY, offer: signed, answer: CANARY }; };
  const result = await createCooperativeSessionMcpHandlers(f.consumer).submitAnswer(answer(), signal());
  failure(result, 'operation_unconfirmed');
  const value = payload(result);
  assert.deepEqual(Object.keys(value).sort(), ['schema', 'state', 'code'].sort());
});

test("submit rejects primitive array and callable roots without dispatch or poisoning", { timeout: 5_000 }, async () => {
  for (const input of [null, undefined, false, 42, 'synthetic', [], Object.assign([], answer()),
    Object.assign(() => undefined, answer())]) {
    const f = fixture(), h = createCooperativeSessionMcpHandlers(f.consumer);
    failure(await h.submitAnswer(input, signal()), 'input_invalid'); assert.equal(calls(f), 0);
    ok(await h.submitAnswer(answer(), signal()), answered(answer())); assert.equal(calls(f), 1);
  }
});

test("input getters and toJSON metadata never run in either direct decoder", { timeout: 5_000 }, async () => {
  for (const operation of ['checkpoint', 'submit'] as const) {
    for (const field of ['extra', '_meta', 'toJSON']) {
      const f = fixture(), h = createCooperativeSessionMcpHandlers(f.consumer); let callbacks = 0;
      const input = operation === 'checkpoint' ? {} : answer();
      Object.defineProperty(input, field, { enumerable: true, get() { callbacks++; throw new Error(CANARY); } });
      const result = operation === 'checkpoint' ? await h.checkpoint(input, signal()) : await h.submitAnswer(input, signal());
      assert.equal(callbacks, 0); failure(result, 'input_invalid'); assert.equal(calls(f), 0);
    }
    const f = fixture(), h = createCooperativeSessionMcpHandlers(f.consumer); let callbacks = 0;
    const input = { ...(operation === 'checkpoint' ? {} : answer()), toJSON() { callbacks++; throw new Error(CANARY); } };
    const result = operation === 'checkpoint' ? await h.checkpoint(input, signal()) : await h.submitAnswer(input, signal());
    assert.equal(callbacks, 0); failure(result, 'input_invalid'); assert.equal(calls(f), 0);
  }
});

test("receipt UUID digest and replay types stay strict after successful consumer invocation", { timeout: 5_000 }, async () => {
  for (const patch of [
    { targetBindingId: CANARY }, { correlationId: CANARY }, { replay: 'false' },
    { completionHash: 'sha256:' + 'A'.repeat(64) }, { completionHash: digest('ok') + '\n' },
  ]) {
    const f = fixture(); f.behavior.submit = async value => ({ ...answered(value), ...patch });
    const h = createCooperativeSessionMcpHandlers(f.consumer);
    failure(await h.submitAnswer(answer(), signal()), 'delivery_unconfirmed'); await poisoned(h, f, 1);
  }
  const f = fixture(); f.behavior.checkpoint = async () => ({
    state: 'reply_reconciled', questionId: uuid(10), taskId: uuid(11), completionHash: digest('completion'),
    replyReceiptHash: CANARY, correlationId: uuid(90),
  });
  const h = createCooperativeSessionMcpHandlers(f.consumer);
  failure(await h.checkpoint({}, signal()), 'delivery_unconfirmed'); await poisoned(h, f, 1);
});
