import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { test } from 'node:test';
import { signCanonicalObject, type SessionBindingScope } from '@dharma-ai-labs/agent-fabric-contracts';
import { createProviderSessionChannel } from './providerSessionChannel.js';

type RawChannel = ReturnType<typeof createProviderSessionChannel>;
type DispatchContext = { signal?: AbortSignal; expiresAt?: string };
type ReplyInput = Parameters<RawChannel['reply']>[0];
type ExtendedChannel = Omit<RawChannel, 'inbox' | 'accept' | 'reply'> & {
  inbox(context?: DispatchContext): ReturnType<RawChannel['inbox']>;
  accept(questionId: string, taskId: string, context?: DispatchContext): ReturnType<RawChannel['accept']>;
  reply(request: ReplyInput, context?: DispatchContext): ReturnType<RawChannel['reply']>;
};
type Action = 'inbox' | 'accept' | 'reply';
const INVALID = 'provider_session_dispatch_context_invalid';
const CANCELLED = 'provider_session_channel_cancelled';
const DEADLINE = 'provider_session_channel_deadline';
const UNCERTAIN = 'provider_session_channel_uncertain';
const CANARY = 'SYNTHETIC_PRIVATE_DIAGNOSTIC_DO_NOT_ECHO';
const START = Date.parse('2026-09-26T05:00:00.000Z');
const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const uuid = (last: number) => `40000000-0000-4000-8000-${String(last).padStart(12, '0')}`;
const scope: SessionBindingScope = {
  organizationId: 'org_test', repositoryBindingId: uuid(1), workspaceId: uuid(2), endpointId: uuid(3),
  membershipId: uuid(4), deviceId: uuid(5), bindingId: uuid(6), provider: 'codex',
  expiresAt: new Date(START + 3_600_000).toISOString(), maximumProviderCostCents: 25,
};
const deadline = (offset = 10_000) => new Date(START + offset).toISOString();

function offer() {
  const unsigned = {
    schema: 'dharma.session-question/v1', questionId: uuid(10), taskId: uuid(11),
    organizationId: scope.organizationId, repositoryBindingId: scope.repositoryBindingId,
    source: { workspaceId: uuid(12), endpointId: uuid(13), membershipId: uuid(14), deviceId: uuid(15) },
    target: { workspaceId: scope.workspaceId, endpointId: scope.endpointId, membershipId: scope.membershipId,
      deviceId: scope.deviceId, bindingId: scope.bindingId, provider: scope.provider },
    category: 'architecture', question: 'Which signed catalog applies?',
    authority: { mode: 'read_only', readPaths: ['.'], network: 'deny', maximumProviderCostCents: 25 },
    createdAt: new Date(START).toISOString(), expiresAt: new Date(START + 900_000).toISOString(), nonce: uuid(16),
    signerKeyVersion: 'projects/test/locations/global/keyRings/af/cryptoKeys/questions/cryptoKeyVersions/1',
  };
  return { ...unsigned, signature: signCanonicalObject(unsigned, privateKey) };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

function fixture() {
  let time = START;
  let held = true;
  const calls: Array<{ route: string; body: Record<string, unknown> }> = [];
  const hooks: {
    owner?: () => void | Promise<void>;
    content?: (kind: 'question' | 'answer') => void | Promise<void>;
    send?: (action: string, body: Record<string, unknown>) => void | Promise<void>;
  } = {};
  let ackPatch: Record<string, unknown> | undefined;
  const raw = createProviderSessionChannel({
    scope, mode: 'cooperative', expectedRevision: 0, now: () => new Date(time),
    assertOwner: async () => { await hooks.owner?.(); return held; },
    verifier: { resolvePublicKey: () => publicKey },
    authorizeContent: async (_content, kind) => { await hooks.content?.(kind); return true; },
    transport: {
      async signedPost(route: string, input: unknown): Promise<Record<string, unknown>> {
        const body = input as Record<string, unknown>;
        calls.push({ route, body });
        await hooks.send?.(String(body.action), body);
        const envelope = { ok: true, organizationId: scope.organizationId, correlationId: uuid(90) };
        if (route.endsWith('/provider-sessions')) {
          return { ...envelope, registration: {
            bindingId: scope.bindingId, workspaceId: scope.workspaceId, endpointId: scope.endpointId,
            repositoryBindingId: scope.repositoryBindingId, membershipId: scope.membershipId, deviceId: scope.deviceId,
            provider: 'codex', mode: 'cooperative', revision: Number(body.expectedRevision) + 1,
            state: body.action === 'detach' ? 'detached' : 'attached',
            leaseUntil: new Date(time + 60_000).toISOString(), replay: false,
          } };
        }
        if (body.action === 'inbox') return { ...envelope, result: { offers: [offer()] } };
        if (body.action === 'read') return { ...envelope, result: {
          questionId: body.questionId, taskId: uuid(11), targetBindingId: scope.bindingId,
          state: 'answered', answer: 'Use the signed catalog.', failureCode: null,
          replyReceiptHash: 'sha256:' + 'a'.repeat(64),
        } };
        if (!['accept', 'reply', 'ask'].includes(String(body.action))) throw new Error('Unexpected synthetic action');
        return { ...envelope, result: {
          questionId: body.questionId ?? uuid(10), taskId: uuid(11),
          targetBindingId: body.targetBindingId ?? scope.bindingId,
          state: body.action === 'accept' ? 'accepted' : body.action === 'reply' ? body.outcome : 'queued',
          replay: false, ...ackPatch,
        } };
      },
    },
  });
  const channel = raw as unknown as ExtendedChannel;
  return {
    channel, calls, hooks, raw,
    setTime(value: number) { time = value; },
    setHeld(value: boolean) { held = value; },
    patchAck(value: Record<string, unknown>) { ackPatch = value; },
    protectedCalls() { return calls.filter(call => call.route.endsWith('/provider-session-questions')); },
  };
}
type Fixture = ReturnType<typeof fixture>;

function replyInput(): ReplyInput {
  return { questionId: uuid(10), taskId: uuid(11), outcome: 'answered',
    answer: 'Use the signed catalog.', failureCode: null };
}
function invoke(f: Fixture, action: Action, context?: unknown): Promise<unknown> {
  const data = context as DispatchContext | undefined;
  if (action === 'inbox') return f.channel.inbox(data);
  if (action === 'accept') return f.channel.accept(uuid(10), uuid(11), data);
  return f.channel.reply(replyInput(), data);
}
async function captureFailure(promise: Promise<unknown>): Promise<unknown> {
  try { await promise; } catch (error) { return error; }
  return undefined;
}
function fixedFailure(error: unknown, code: string) {
  assert.ok(error instanceof Error, 'operation must reject with an Error');
  assert.equal(error.message, code);
  assert.equal(String(error).includes(CANARY), false);
}
async function blockedHeartbeat() {
  const f = fixture();
  await f.channel.attach();
  const entered = deferred(), gate = deferred();
  f.hooks.send = async action => {
    if (action === 'heartbeat') { entered.resolve(); await gate.promise; }
  };
  const heartbeat = f.channel.heartbeat();
  void heartbeat.catch(() => undefined);
  await entered.promise;
  return { ...f, async unblock() { gate.resolve(); await heartbeat; } };
}

test("inbox: missing, undefined, empty and frozen ordinary contexts remain valid", { timeout: 5_000 }, async () => {
  const omitted = fixture(); await omitted.channel.attach();
  assert.notEqual(await omitted.channel.inbox(), undefined);
  assert.equal(omitted.protectedCalls().length, 1);
  const contexts = [undefined, {}, Object.freeze({}), Object.freeze({ signal: new AbortController().signal, expiresAt: deadline() })];
  for (const context of contexts) {
    const f = fixture(); await f.channel.attach();
    const result = await invoke(f, 'inbox', context);
    assert.notEqual(result, undefined);
    assert.equal(f.protectedCalls().length, 1);
  }
});

test("inbox: already-aborted signal prevents protected dispatch", { timeout: 5_000 }, async () => {
  const f = fixture(); await f.channel.attach();
  const controller = new AbortController(); controller.abort();
  fixedFailure(await captureFailure(invoke(f, 'inbox', { signal: controller.signal })), CANCELLED);
  assert.equal(f.protectedCalls().length, 0);
});

test("inbox: valid expired deadline prevents protected dispatch", { timeout: 5_000 }, async () => {
  const f = fixture(); await f.channel.attach();
  fixedFailure(await captureFailure(invoke(f, 'inbox', { expiresAt: deadline(-1) })), DEADLINE);
  assert.equal(f.protectedCalls().length, 0);
});

test("inbox: malformed context shape rejects asynchronously before owner or transport", { timeout: 5_000 }, async () => {
  const contexts: unknown[] = [null, [], 'synthetic', 1, true, () => undefined,
    Object.create(null), Object.create({ inherited: true }), { extra: true }];
  for (const context of contexts) {
    const f = fixture(); let ownerCalls = 0;
    f.hooks.owner = () => { ownerCalls++; };
    let promise!: Promise<unknown>;
    assert.doesNotThrow(() => { promise = invoke(f, 'inbox', context); });
    fixedFailure(await captureFailure(promise), INVALID);
    assert.equal(ownerCalls, 0);
    assert.equal(f.calls.length, 0);
  }
});

test("inbox: hidden and symbol fields are invalid without accessor invocation", { timeout: 5_000 }, async () => {
  for (const variant of ['hidden-signal', 'hidden-deadline', 'hidden-extra', 'symbol-data', 'symbol-getter'] as const) {
    const f = fixture(); let callbacks = 0;
    const context: object = {};
    if (variant === 'hidden-signal') Object.defineProperty(context, 'signal', { value: new AbortController().signal, enumerable: false });
    if (variant === 'hidden-deadline') Object.defineProperty(context, 'expiresAt', { value: deadline(), enumerable: false });
    if (variant === 'hidden-extra') Object.defineProperty(context, 'extra', { value: true, enumerable: false });
    if (variant === 'symbol-data') Object.defineProperty(context, Symbol('synthetic'), { value: true, enumerable: true });
    if (variant === 'symbol-getter') Object.defineProperty(context, Symbol('synthetic'), {
      enumerable: false, get() { callbacks++; throw new Error(CANARY); },
    });
    const error = await captureFailure(invoke(f, 'inbox', context));
    assert.equal(callbacks, 0);
    fixedFailure(error, INVALID);
    assert.equal(f.calls.length, 0);
  }
});

test("inbox: signal getter is rejected without running or leaking it", { timeout: 5_000 }, async () => {
  const f = fixture(); let getters = 0;
  const context = {};
  Object.defineProperty(context, 'signal', {
    enumerable: true, get() { getters++; throw new Error(CANARY); },
  });
  const error = await captureFailure(invoke(f, 'inbox', context));
  assert.equal(getters, 0);
  fixedFailure(error, INVALID);
  assert.equal(f.calls.length, 0);
});

test("inbox: signal setter-only field is rejected without invocation", { timeout: 5_000 }, async () => {
  const f = fixture(); let setters = 0;
  const context = {};
  Object.defineProperty(context, 'signal', {
    enumerable: true, set(_value: unknown) { setters++; throw new Error(CANARY); },
  });
  const error = await captureFailure(invoke(f, 'inbox', context));
  assert.equal(setters, 0);
  fixedFailure(error, INVALID);
  assert.equal(f.calls.length, 0);
});

test("inbox: expiresAt getter is rejected without running or leaking it", { timeout: 5_000 }, async () => {
  const f = fixture(); let getters = 0;
  const context = {};
  Object.defineProperty(context, 'expiresAt', {
    enumerable: true, get() { getters++; throw new Error(CANARY); },
  });
  const error = await captureFailure(invoke(f, 'inbox', context));
  assert.equal(getters, 0);
  fixedFailure(error, INVALID);
  assert.equal(f.calls.length, 0);
});

test("inbox: expiresAt setter-only field is rejected without invocation", { timeout: 5_000 }, async () => {
  const f = fixture(); let setters = 0;
  const context = {};
  Object.defineProperty(context, 'expiresAt', {
    enumerable: true, set(_value: unknown) { setters++; throw new Error(CANARY); },
  });
  const error = await captureFailure(invoke(f, 'inbox', context));
  assert.equal(setters, 0);
  fixedFailure(error, INVALID);
  assert.equal(f.calls.length, 0);
});

test("inbox: invalid signal values and spoofed signal brands are rejected", { timeout: 5_000 }, async () => {
  const values: unknown[] = [null, false, 1, 'signal', {}, new Date(START), Object.create(AbortSignal.prototype)];
  for (const signal of values) {
    const f = fixture();
    fixedFailure(await captureFailure(invoke(f, 'inbox', { signal })), INVALID);
    assert.equal(f.calls.length, 0);
  }
});

test("inbox: duck-typed signal getters are never invoked", { timeout: 5_000 }, async () => {
  const f = fixture(); let callbacks = 0;
  const signal = {
    get aborted() { callbacks++; throw new Error(CANARY); },
    addEventListener() { callbacks++; throw new Error(CANARY); },
  };
  const error = await captureFailure(invoke(f, 'inbox', { signal }));
  assert.equal(callbacks, 0);
  fixedFailure(error, INVALID);
  assert.equal(f.calls.length, 0);
});

test("inbox: invalid deadline values do not invoke coercion", { timeout: 5_000 }, async () => {
  const values: unknown[] = [null, 0, NaN, Infinity, true, '', 'not-a-date', [], new Date(START)];
  for (const expiresAt of values) {
    const f = fixture();
    fixedFailure(await captureFailure(invoke(f, 'inbox', { expiresAt })), INVALID);
    assert.equal(f.calls.length, 0);
  }
  const f = fixture(); let calls = 0;
  const expiresAt = { toString() { calls++; throw new Error(CANARY); } };
  const error = await captureFailure(invoke(f, 'inbox', { expiresAt }));
  assert.equal(calls, 0); fixedFailure(error, INVALID); assert.equal(f.calls.length, 0);
});

test("inbox: context Proxy and revoked Proxy are trap-free invalid inputs", { timeout: 5_000 }, async () => {
  let traps = 0;
  const fail = (): never => { traps++; throw new Error(CANARY); };
  const proxy = new Proxy({}, { get: fail, ownKeys: fail, getOwnPropertyDescriptor: fail, getPrototypeOf: fail });
  const revoked = Proxy.revocable({}, {}); revoked.revoke();
  for (const context of [proxy, revoked.proxy]) {
    const f = fixture();
    const error = await captureFailure(invoke(f, 'inbox', context));
    assert.equal(traps, 0); fixedFailure(error, INVALID); assert.equal(f.calls.length, 0);
  }
});

test("inbox: proxied genuine AbortSignal is rejected before traps", { timeout: 5_000 }, async () => {
  const f = fixture(); let traps = 0;
  const fail = (): never => { traps++; throw new Error(CANARY); };
  const signal = new Proxy(new AbortController().signal, { get: fail, getPrototypeOf: fail });
  const error = await captureFailure(invoke(f, 'inbox', { signal }));
  assert.equal(traps, 0); fixedFailure(error, INVALID); assert.equal(f.calls.length, 0);
});

test("inbox: queued call retains the original cancelled signal after context replacement", { timeout: 5_000 }, async () => {
  const f = await blockedHeartbeat();
  const original = new AbortController();
  const context = { signal: original.signal, expiresAt: deadline() };
  const outcome = captureFailure(invoke(f, 'inbox', context));
  original.abort(); context.signal = new AbortController().signal;
  try {
    await f.unblock();
    fixedFailure(await outcome, CANCELLED);
    assert.equal(f.protectedCalls().length, 0);
  } finally { await f.unblock(); }
});

test("inbox: aborting only a replacement signal does not cancel queued original context", { timeout: 5_000 }, async () => {
  const f = await blockedHeartbeat();
  const original = new AbortController(), replacement = new AbortController();
  const context = { signal: original.signal };
  const pending = invoke(f, 'inbox', context);
  void pending.catch(() => undefined);
  context.signal = replacement.signal; replacement.abort();
  try {
    await f.unblock();
    assert.notEqual(await pending, undefined);
    assert.equal(f.protectedCalls().length, 1);
  } finally { await f.unblock(); }
});

test("inbox: queued deadline cannot be extended by caller mutation", { timeout: 5_000 }, async () => {
  const f = await blockedHeartbeat();
  const context = { expiresAt: deadline() };
  const outcome = captureFailure(invoke(f, 'inbox', context));
  context.expiresAt = scope.expiresAt; f.setTime(START + 11_000);
  try {
    await f.unblock();
    fixedFailure(await outcome, DEADLINE);
    assert.equal(f.protectedCalls().length, 0);
  } finally { await f.unblock(); }
});

test("inbox: queued live deadline cannot be shortened by caller mutation", { timeout: 5_000 }, async () => {
  const f = await blockedHeartbeat();
  const context = { expiresAt: deadline(20_000) };
  const pending = invoke(f, 'inbox', context);
  void pending.catch(() => undefined);
  context.expiresAt = deadline(-1);
  try {
    await f.unblock();
    assert.notEqual(await pending, undefined);
    assert.equal(f.protectedCalls().length, 1);
  } finally { await f.unblock(); }
});

test("inbox: fields added after queuing an empty context cannot change admission", { timeout: 5_000 }, async () => {
  const f = await blockedHeartbeat();
  const context: DispatchContext = {};
  const pending = invoke(f, 'inbox', context);
  void pending.catch(() => undefined);
  const added = new AbortController(); added.abort();
  context.signal = added.signal; context.expiresAt = deadline(-1);
  try {
    await f.unblock();
    assert.notEqual(await pending, undefined);
    assert.equal(f.protectedCalls().length, 1);
  } finally { await f.unblock(); }
});

test("inbox: cancellation during asynchronous owner admission prevents send", { timeout: 5_000 }, async () => {
  const f = fixture(); await f.channel.attach();
  const original = new AbortController(), entered = deferred(), gate = deferred();
  let first = true;
  f.hooks.owner = async () => { if (first) { first = false; entered.resolve(); await gate.promise; } };
  const context = { signal: original.signal };
  const outcome = captureFailure(invoke(f, 'inbox', context));
  try {
    await entered.promise;
    original.abort(); context.signal = new AbortController().signal;
    gate.resolve();
    fixedFailure(await outcome, CANCELLED);
    assert.equal(f.protectedCalls().length, 0);
  } finally { gate.resolve(); }
});

test("inbox: deadline expiring during owner admission prevents send", { timeout: 5_000 }, async () => {
  const f = fixture(); await f.channel.attach();
  const entered = deferred(), gate = deferred(); let first = true;
  f.hooks.owner = async () => { if (first) { first = false; entered.resolve(); await gate.promise; } };
  const outcome = captureFailure(invoke(f, 'inbox', { expiresAt: deadline() }));
  try {
    await entered.promise; f.setTime(START + 11_000); gate.resolve();
    fixedFailure(await outcome, DEADLINE);
    assert.equal(f.protectedCalls().length, 0);
  } finally { gate.resolve(); }
});

test("inbox: cancellation after possible signedPost effect is uncertain and closes without replay", { timeout: 5_000 }, async () => {
  const f = fixture(); await f.channel.attach();
  const original = new AbortController();
  f.hooks.send = action => { if (action === 'inbox') original.abort(); };
  fixedFailure(await captureFailure(invoke(f, 'inbox', { signal: original.signal })), UNCERTAIN);
  assert.equal(f.protectedCalls().length, 1);
  fixedFailure(await captureFailure(f.channel.inbox()), 'provider_session_channel_closed');
  assert.equal(f.protectedCalls().length, 1);
});

test("inbox: original signal stays live through post-send owner wait", { timeout: 5_000 }, async () => {
  const f = fixture(); await f.channel.attach();
  const entered = deferred(), gate = deferred(), original = new AbortController(); let paused = false;
  f.hooks.owner = async () => {
    if (!paused && f.protectedCalls().length === 1) { paused = true; entered.resolve(); await gate.promise; }
  };
  const context = { signal: original.signal };
  const outcome = captureFailure(invoke(f, 'inbox', context));
  try {
    await entered.promise;
    original.abort(); context.signal = new AbortController().signal; gate.resolve();
    fixedFailure(await outcome, UNCERTAIN);
    assert.equal(f.protectedCalls().length, 1);
    fixedFailure(await captureFailure(f.channel.inbox()), 'provider_session_channel_closed');
    assert.equal(f.protectedCalls().length, 1);
  } finally { gate.resolve(); }
});

test("inbox: expiry after a completed read withholds local offers without claiming remote cancellation", { timeout: 5_000 }, async () => {
  const f = fixture(); await f.channel.attach();
  f.hooks.send = action => { if (action === 'inbox') f.setTime(START + 11_000); };
  fixedFailure(await captureFailure(invoke(f, 'inbox', { expiresAt: deadline() })), DEADLINE);
  assert.equal(f.protectedCalls().length, 1);
});

test("inbox: live context stays off wire and preserves request fields", { timeout: 5_000 }, async () => {
  const f = fixture(); await f.channel.attach();
  await invoke(f, 'inbox', { signal: new AbortController().signal, expiresAt: deadline() });
  const call = f.protectedCalls().at(-1);
  assert.ok(call);
  const baseFields = ['schema', 'bindingId', 'workspaceId', 'endpointId', 'repositoryBindingId', 'action'];
  const extra: string[] = [];
  assert.deepEqual(Object.keys(call.body).sort(), [...baseFields, ...extra].sort());
  assert.equal(call.body.schema, 'dharma.provider-session-question-request/v1');
  assert.equal(call.body.bindingId, scope.bindingId);
  assert.equal(call.body.action, 'inbox');
  assert.equal(Object.hasOwn(call.body, 'signal'), false);
  assert.equal(Object.hasOwn(call.body, 'expiresAt'), false);
});

test("accept: missing, undefined, empty and frozen ordinary contexts remain valid", { timeout: 5_000 }, async () => {
  const omitted = fixture(); await omitted.channel.attach();
  assert.notEqual(await omitted.channel.accept(uuid(10), uuid(11)), undefined);
  assert.equal(omitted.protectedCalls().length, 1);
  const contexts = [undefined, {}, Object.freeze({}), Object.freeze({ signal: new AbortController().signal, expiresAt: deadline() })];
  for (const context of contexts) {
    const f = fixture(); await f.channel.attach();
    const result = await invoke(f, 'accept', context);
    assert.notEqual(result, undefined);
    assert.equal(f.protectedCalls().length, 1);
  }
});

test("accept: already-aborted signal prevents protected dispatch", { timeout: 5_000 }, async () => {
  const f = fixture(); await f.channel.attach();
  const controller = new AbortController(); controller.abort();
  fixedFailure(await captureFailure(invoke(f, 'accept', { signal: controller.signal })), CANCELLED);
  assert.equal(f.protectedCalls().length, 0);
});

test("accept: valid expired deadline prevents protected dispatch", { timeout: 5_000 }, async () => {
  const f = fixture(); await f.channel.attach();
  fixedFailure(await captureFailure(invoke(f, 'accept', { expiresAt: deadline(-1) })), DEADLINE);
  assert.equal(f.protectedCalls().length, 0);
});

test("accept: malformed context shape rejects asynchronously before owner or transport", { timeout: 5_000 }, async () => {
  const contexts: unknown[] = [null, [], 'synthetic', 1, true, () => undefined,
    Object.create(null), Object.create({ inherited: true }), { extra: true }];
  for (const context of contexts) {
    const f = fixture(); let ownerCalls = 0;
    f.hooks.owner = () => { ownerCalls++; };
    let promise!: Promise<unknown>;
    assert.doesNotThrow(() => { promise = invoke(f, 'accept', context); });
    fixedFailure(await captureFailure(promise), INVALID);
    assert.equal(ownerCalls, 0);
    assert.equal(f.calls.length, 0);
  }
});

test("accept: hidden and symbol fields are invalid without accessor invocation", { timeout: 5_000 }, async () => {
  for (const variant of ['hidden-signal', 'hidden-deadline', 'hidden-extra', 'symbol-data', 'symbol-getter'] as const) {
    const f = fixture(); let callbacks = 0;
    const context: object = {};
    if (variant === 'hidden-signal') Object.defineProperty(context, 'signal', { value: new AbortController().signal, enumerable: false });
    if (variant === 'hidden-deadline') Object.defineProperty(context, 'expiresAt', { value: deadline(), enumerable: false });
    if (variant === 'hidden-extra') Object.defineProperty(context, 'extra', { value: true, enumerable: false });
    if (variant === 'symbol-data') Object.defineProperty(context, Symbol('synthetic'), { value: true, enumerable: true });
    if (variant === 'symbol-getter') Object.defineProperty(context, Symbol('synthetic'), {
      enumerable: false, get() { callbacks++; throw new Error(CANARY); },
    });
    const error = await captureFailure(invoke(f, 'accept', context));
    assert.equal(callbacks, 0);
    fixedFailure(error, INVALID);
    assert.equal(f.calls.length, 0);
  }
});

test("accept: signal getter is rejected without running or leaking it", { timeout: 5_000 }, async () => {
  const f = fixture(); let getters = 0;
  const context = {};
  Object.defineProperty(context, 'signal', {
    enumerable: true, get() { getters++; throw new Error(CANARY); },
  });
  const error = await captureFailure(invoke(f, 'accept', context));
  assert.equal(getters, 0);
  fixedFailure(error, INVALID);
  assert.equal(f.calls.length, 0);
});

test("accept: signal setter-only field is rejected without invocation", { timeout: 5_000 }, async () => {
  const f = fixture(); let setters = 0;
  const context = {};
  Object.defineProperty(context, 'signal', {
    enumerable: true, set(_value: unknown) { setters++; throw new Error(CANARY); },
  });
  const error = await captureFailure(invoke(f, 'accept', context));
  assert.equal(setters, 0);
  fixedFailure(error, INVALID);
  assert.equal(f.calls.length, 0);
});

test("accept: expiresAt getter is rejected without running or leaking it", { timeout: 5_000 }, async () => {
  const f = fixture(); let getters = 0;
  const context = {};
  Object.defineProperty(context, 'expiresAt', {
    enumerable: true, get() { getters++; throw new Error(CANARY); },
  });
  const error = await captureFailure(invoke(f, 'accept', context));
  assert.equal(getters, 0);
  fixedFailure(error, INVALID);
  assert.equal(f.calls.length, 0);
});

test("accept: expiresAt setter-only field is rejected without invocation", { timeout: 5_000 }, async () => {
  const f = fixture(); let setters = 0;
  const context = {};
  Object.defineProperty(context, 'expiresAt', {
    enumerable: true, set(_value: unknown) { setters++; throw new Error(CANARY); },
  });
  const error = await captureFailure(invoke(f, 'accept', context));
  assert.equal(setters, 0);
  fixedFailure(error, INVALID);
  assert.equal(f.calls.length, 0);
});

test("accept: invalid signal values and spoofed signal brands are rejected", { timeout: 5_000 }, async () => {
  const values: unknown[] = [null, false, 1, 'signal', {}, new Date(START), Object.create(AbortSignal.prototype)];
  for (const signal of values) {
    const f = fixture();
    fixedFailure(await captureFailure(invoke(f, 'accept', { signal })), INVALID);
    assert.equal(f.calls.length, 0);
  }
});

test("accept: duck-typed signal getters are never invoked", { timeout: 5_000 }, async () => {
  const f = fixture(); let callbacks = 0;
  const signal = {
    get aborted() { callbacks++; throw new Error(CANARY); },
    addEventListener() { callbacks++; throw new Error(CANARY); },
  };
  const error = await captureFailure(invoke(f, 'accept', { signal }));
  assert.equal(callbacks, 0);
  fixedFailure(error, INVALID);
  assert.equal(f.calls.length, 0);
});

test("accept: invalid deadline values do not invoke coercion", { timeout: 5_000 }, async () => {
  const values: unknown[] = [null, 0, NaN, Infinity, true, '', 'not-a-date', [], new Date(START)];
  for (const expiresAt of values) {
    const f = fixture();
    fixedFailure(await captureFailure(invoke(f, 'accept', { expiresAt })), INVALID);
    assert.equal(f.calls.length, 0);
  }
  const f = fixture(); let calls = 0;
  const expiresAt = { toString() { calls++; throw new Error(CANARY); } };
  const error = await captureFailure(invoke(f, 'accept', { expiresAt }));
  assert.equal(calls, 0); fixedFailure(error, INVALID); assert.equal(f.calls.length, 0);
});

test("accept: context Proxy and revoked Proxy are trap-free invalid inputs", { timeout: 5_000 }, async () => {
  let traps = 0;
  const fail = (): never => { traps++; throw new Error(CANARY); };
  const proxy = new Proxy({}, { get: fail, ownKeys: fail, getOwnPropertyDescriptor: fail, getPrototypeOf: fail });
  const revoked = Proxy.revocable({}, {}); revoked.revoke();
  for (const context of [proxy, revoked.proxy]) {
    const f = fixture();
    const error = await captureFailure(invoke(f, 'accept', context));
    assert.equal(traps, 0); fixedFailure(error, INVALID); assert.equal(f.calls.length, 0);
  }
});

test("accept: proxied genuine AbortSignal is rejected before traps", { timeout: 5_000 }, async () => {
  const f = fixture(); let traps = 0;
  const fail = (): never => { traps++; throw new Error(CANARY); };
  const signal = new Proxy(new AbortController().signal, { get: fail, getPrototypeOf: fail });
  const error = await captureFailure(invoke(f, 'accept', { signal }));
  assert.equal(traps, 0); fixedFailure(error, INVALID); assert.equal(f.calls.length, 0);
});

test("accept: queued call retains the original cancelled signal after context replacement", { timeout: 5_000 }, async () => {
  const f = await blockedHeartbeat();
  const original = new AbortController();
  const context = { signal: original.signal, expiresAt: deadline() };
  const outcome = captureFailure(invoke(f, 'accept', context));
  original.abort(); context.signal = new AbortController().signal;
  try {
    await f.unblock();
    fixedFailure(await outcome, CANCELLED);
    assert.equal(f.protectedCalls().length, 0);
  } finally { await f.unblock(); }
});

test("accept: aborting only a replacement signal does not cancel queued original context", { timeout: 5_000 }, async () => {
  const f = await blockedHeartbeat();
  const original = new AbortController(), replacement = new AbortController();
  const context = { signal: original.signal };
  const pending = invoke(f, 'accept', context);
  void pending.catch(() => undefined);
  context.signal = replacement.signal; replacement.abort();
  try {
    await f.unblock();
    assert.notEqual(await pending, undefined);
    assert.equal(f.protectedCalls().length, 1);
  } finally { await f.unblock(); }
});

test("accept: queued deadline cannot be extended by caller mutation", { timeout: 5_000 }, async () => {
  const f = await blockedHeartbeat();
  const context = { expiresAt: deadline() };
  const outcome = captureFailure(invoke(f, 'accept', context));
  context.expiresAt = scope.expiresAt; f.setTime(START + 11_000);
  try {
    await f.unblock();
    fixedFailure(await outcome, DEADLINE);
    assert.equal(f.protectedCalls().length, 0);
  } finally { await f.unblock(); }
});

test("accept: queued live deadline cannot be shortened by caller mutation", { timeout: 5_000 }, async () => {
  const f = await blockedHeartbeat();
  const context = { expiresAt: deadline(20_000) };
  const pending = invoke(f, 'accept', context);
  void pending.catch(() => undefined);
  context.expiresAt = deadline(-1);
  try {
    await f.unblock();
    assert.notEqual(await pending, undefined);
    assert.equal(f.protectedCalls().length, 1);
  } finally { await f.unblock(); }
});

test("accept: fields added after queuing an empty context cannot change admission", { timeout: 5_000 }, async () => {
  const f = await blockedHeartbeat();
  const context: DispatchContext = {};
  const pending = invoke(f, 'accept', context);
  void pending.catch(() => undefined);
  const added = new AbortController(); added.abort();
  context.signal = added.signal; context.expiresAt = deadline(-1);
  try {
    await f.unblock();
    assert.notEqual(await pending, undefined);
    assert.equal(f.protectedCalls().length, 1);
  } finally { await f.unblock(); }
});

test("accept: cancellation during asynchronous owner admission prevents send", { timeout: 5_000 }, async () => {
  const f = fixture(); await f.channel.attach();
  const original = new AbortController(), entered = deferred(), gate = deferred();
  let first = true;
  f.hooks.owner = async () => { if (first) { first = false; entered.resolve(); await gate.promise; } };
  const context = { signal: original.signal };
  const outcome = captureFailure(invoke(f, 'accept', context));
  try {
    await entered.promise;
    original.abort(); context.signal = new AbortController().signal;
    gate.resolve();
    fixedFailure(await outcome, CANCELLED);
    assert.equal(f.protectedCalls().length, 0);
  } finally { gate.resolve(); }
});

test("accept: deadline expiring during owner admission prevents send", { timeout: 5_000 }, async () => {
  const f = fixture(); await f.channel.attach();
  const entered = deferred(), gate = deferred(); let first = true;
  f.hooks.owner = async () => { if (first) { first = false; entered.resolve(); await gate.promise; } };
  const outcome = captureFailure(invoke(f, 'accept', { expiresAt: deadline() }));
  try {
    await entered.promise; f.setTime(START + 11_000); gate.resolve();
    fixedFailure(await outcome, DEADLINE);
    assert.equal(f.protectedCalls().length, 0);
  } finally { gate.resolve(); }
});

test("accept: cancellation after possible signedPost effect is uncertain and closes without replay", { timeout: 5_000 }, async () => {
  const f = fixture(); await f.channel.attach();
  const original = new AbortController();
  f.hooks.send = action => { if (action === 'accept') original.abort(); };
  fixedFailure(await captureFailure(invoke(f, 'accept', { signal: original.signal })), UNCERTAIN);
  assert.equal(f.protectedCalls().length, 1);
  fixedFailure(await captureFailure(f.channel.inbox()), 'provider_session_channel_closed');
  assert.equal(f.protectedCalls().length, 1);
});

test("accept: original signal stays live through post-send owner wait", { timeout: 5_000 }, async () => {
  const f = fixture(); await f.channel.attach();
  const entered = deferred(), gate = deferred(), original = new AbortController(); let paused = false;
  f.hooks.owner = async () => {
    if (!paused && f.protectedCalls().length === 1) { paused = true; entered.resolve(); await gate.promise; }
  };
  const context = { signal: original.signal };
  const outcome = captureFailure(invoke(f, 'accept', context));
  try {
    await entered.promise;
    original.abort(); context.signal = new AbortController().signal; gate.resolve();
    fixedFailure(await outcome, UNCERTAIN);
    assert.equal(f.protectedCalls().length, 1);
    fixedFailure(await captureFailure(f.channel.inbox()), 'provider_session_channel_closed');
    assert.equal(f.protectedCalls().length, 1);
  } finally { gate.resolve(); }
});

test("accept: crossing a request deadline after send is not a new remote cancellation contract", { timeout: 5_000 }, async () => {
  const f = fixture(); await f.channel.attach();
  f.hooks.send = action => { if (action === 'accept') f.setTime(START + 11_000); };
  assert.notEqual(await invoke(f, 'accept', { expiresAt: deadline() }), undefined);
  assert.equal(f.protectedCalls().length, 1);
});

test("accept: live context stays off wire and preserves request fields", { timeout: 5_000 }, async () => {
  const f = fixture(); await f.channel.attach();
  await invoke(f, 'accept', { signal: new AbortController().signal, expiresAt: deadline() });
  const call = f.protectedCalls().at(-1);
  assert.ok(call);
  const baseFields = ['schema', 'bindingId', 'workspaceId', 'endpointId', 'repositoryBindingId', 'action'];
  const extra: string[] = ["questionId"];
  assert.deepEqual(Object.keys(call.body).sort(), [...baseFields, ...extra].sort());
  assert.equal(call.body.schema, 'dharma.provider-session-question-request/v1');
  assert.equal(call.body.bindingId, scope.bindingId);
  assert.equal(call.body.action, 'accept');
  assert.equal(Object.hasOwn(call.body, 'signal'), false);
  assert.equal(Object.hasOwn(call.body, 'expiresAt'), false);
});

test("reply: missing, undefined, empty and frozen ordinary contexts remain valid", { timeout: 5_000 }, async () => {
  const omitted = fixture(); await omitted.channel.attach();
  assert.notEqual(await omitted.channel.reply(replyInput()), undefined);
  assert.equal(omitted.protectedCalls().length, 1);
  const contexts = [undefined, {}, Object.freeze({}), Object.freeze({ signal: new AbortController().signal, expiresAt: deadline() })];
  for (const context of contexts) {
    const f = fixture(); await f.channel.attach();
    const result = await invoke(f, 'reply', context);
    assert.notEqual(result, undefined);
    assert.equal(f.protectedCalls().length, 1);
  }
});

test("reply: already-aborted signal prevents protected dispatch", { timeout: 5_000 }, async () => {
  const f = fixture(); await f.channel.attach();
  const controller = new AbortController(); controller.abort();
  fixedFailure(await captureFailure(invoke(f, 'reply', { signal: controller.signal })), CANCELLED);
  assert.equal(f.protectedCalls().length, 0);
});

test("reply: valid expired deadline prevents protected dispatch", { timeout: 5_000 }, async () => {
  const f = fixture(); await f.channel.attach();
  fixedFailure(await captureFailure(invoke(f, 'reply', { expiresAt: deadline(-1) })), DEADLINE);
  assert.equal(f.protectedCalls().length, 0);
});

test("reply: malformed context shape rejects asynchronously before owner or transport", { timeout: 5_000 }, async () => {
  const contexts: unknown[] = [null, [], 'synthetic', 1, true, () => undefined,
    Object.create(null), Object.create({ inherited: true }), { extra: true }];
  for (const context of contexts) {
    const f = fixture(); let ownerCalls = 0;
    f.hooks.owner = () => { ownerCalls++; };
    let promise!: Promise<unknown>;
    assert.doesNotThrow(() => { promise = invoke(f, 'reply', context); });
    fixedFailure(await captureFailure(promise), INVALID);
    assert.equal(ownerCalls, 0);
    assert.equal(f.calls.length, 0);
  }
});

test("reply: hidden and symbol fields are invalid without accessor invocation", { timeout: 5_000 }, async () => {
  for (const variant of ['hidden-signal', 'hidden-deadline', 'hidden-extra', 'symbol-data', 'symbol-getter'] as const) {
    const f = fixture(); let callbacks = 0;
    const context: object = {};
    if (variant === 'hidden-signal') Object.defineProperty(context, 'signal', { value: new AbortController().signal, enumerable: false });
    if (variant === 'hidden-deadline') Object.defineProperty(context, 'expiresAt', { value: deadline(), enumerable: false });
    if (variant === 'hidden-extra') Object.defineProperty(context, 'extra', { value: true, enumerable: false });
    if (variant === 'symbol-data') Object.defineProperty(context, Symbol('synthetic'), { value: true, enumerable: true });
    if (variant === 'symbol-getter') Object.defineProperty(context, Symbol('synthetic'), {
      enumerable: false, get() { callbacks++; throw new Error(CANARY); },
    });
    const error = await captureFailure(invoke(f, 'reply', context));
    assert.equal(callbacks, 0);
    fixedFailure(error, INVALID);
    assert.equal(f.calls.length, 0);
  }
});

test("reply: signal getter is rejected without running or leaking it", { timeout: 5_000 }, async () => {
  const f = fixture(); let getters = 0;
  const context = {};
  Object.defineProperty(context, 'signal', {
    enumerable: true, get() { getters++; throw new Error(CANARY); },
  });
  const error = await captureFailure(invoke(f, 'reply', context));
  assert.equal(getters, 0);
  fixedFailure(error, INVALID);
  assert.equal(f.calls.length, 0);
});

test("reply: signal setter-only field is rejected without invocation", { timeout: 5_000 }, async () => {
  const f = fixture(); let setters = 0;
  const context = {};
  Object.defineProperty(context, 'signal', {
    enumerable: true, set(_value: unknown) { setters++; throw new Error(CANARY); },
  });
  const error = await captureFailure(invoke(f, 'reply', context));
  assert.equal(setters, 0);
  fixedFailure(error, INVALID);
  assert.equal(f.calls.length, 0);
});

test("reply: expiresAt getter is rejected without running or leaking it", { timeout: 5_000 }, async () => {
  const f = fixture(); let getters = 0;
  const context = {};
  Object.defineProperty(context, 'expiresAt', {
    enumerable: true, get() { getters++; throw new Error(CANARY); },
  });
  const error = await captureFailure(invoke(f, 'reply', context));
  assert.equal(getters, 0);
  fixedFailure(error, INVALID);
  assert.equal(f.calls.length, 0);
});

test("reply: expiresAt setter-only field is rejected without invocation", { timeout: 5_000 }, async () => {
  const f = fixture(); let setters = 0;
  const context = {};
  Object.defineProperty(context, 'expiresAt', {
    enumerable: true, set(_value: unknown) { setters++; throw new Error(CANARY); },
  });
  const error = await captureFailure(invoke(f, 'reply', context));
  assert.equal(setters, 0);
  fixedFailure(error, INVALID);
  assert.equal(f.calls.length, 0);
});

test("reply: invalid signal values and spoofed signal brands are rejected", { timeout: 5_000 }, async () => {
  const values: unknown[] = [null, false, 1, 'signal', {}, new Date(START), Object.create(AbortSignal.prototype)];
  for (const signal of values) {
    const f = fixture();
    fixedFailure(await captureFailure(invoke(f, 'reply', { signal })), INVALID);
    assert.equal(f.calls.length, 0);
  }
});

test("reply: duck-typed signal getters are never invoked", { timeout: 5_000 }, async () => {
  const f = fixture(); let callbacks = 0;
  const signal = {
    get aborted() { callbacks++; throw new Error(CANARY); },
    addEventListener() { callbacks++; throw new Error(CANARY); },
  };
  const error = await captureFailure(invoke(f, 'reply', { signal }));
  assert.equal(callbacks, 0);
  fixedFailure(error, INVALID);
  assert.equal(f.calls.length, 0);
});

test("reply: invalid deadline values do not invoke coercion", { timeout: 5_000 }, async () => {
  const values: unknown[] = [null, 0, NaN, Infinity, true, '', 'not-a-date', [], new Date(START)];
  for (const expiresAt of values) {
    const f = fixture();
    fixedFailure(await captureFailure(invoke(f, 'reply', { expiresAt })), INVALID);
    assert.equal(f.calls.length, 0);
  }
  const f = fixture(); let calls = 0;
  const expiresAt = { toString() { calls++; throw new Error(CANARY); } };
  const error = await captureFailure(invoke(f, 'reply', { expiresAt }));
  assert.equal(calls, 0); fixedFailure(error, INVALID); assert.equal(f.calls.length, 0);
});

test("reply: context Proxy and revoked Proxy are trap-free invalid inputs", { timeout: 5_000 }, async () => {
  let traps = 0;
  const fail = (): never => { traps++; throw new Error(CANARY); };
  const proxy = new Proxy({}, { get: fail, ownKeys: fail, getOwnPropertyDescriptor: fail, getPrototypeOf: fail });
  const revoked = Proxy.revocable({}, {}); revoked.revoke();
  for (const context of [proxy, revoked.proxy]) {
    const f = fixture();
    const error = await captureFailure(invoke(f, 'reply', context));
    assert.equal(traps, 0); fixedFailure(error, INVALID); assert.equal(f.calls.length, 0);
  }
});

test("reply: proxied genuine AbortSignal is rejected before traps", { timeout: 5_000 }, async () => {
  const f = fixture(); let traps = 0;
  const fail = (): never => { traps++; throw new Error(CANARY); };
  const signal = new Proxy(new AbortController().signal, { get: fail, getPrototypeOf: fail });
  const error = await captureFailure(invoke(f, 'reply', { signal }));
  assert.equal(traps, 0); fixedFailure(error, INVALID); assert.equal(f.calls.length, 0);
});

test("reply: queued call retains the original cancelled signal after context replacement", { timeout: 5_000 }, async () => {
  const f = await blockedHeartbeat();
  const original = new AbortController();
  const context = { signal: original.signal, expiresAt: deadline() };
  const outcome = captureFailure(invoke(f, 'reply', context));
  original.abort(); context.signal = new AbortController().signal;
  try {
    await f.unblock();
    fixedFailure(await outcome, CANCELLED);
    assert.equal(f.protectedCalls().length, 0);
  } finally { await f.unblock(); }
});

test("reply: aborting only a replacement signal does not cancel queued original context", { timeout: 5_000 }, async () => {
  const f = await blockedHeartbeat();
  const original = new AbortController(), replacement = new AbortController();
  const context = { signal: original.signal };
  const pending = invoke(f, 'reply', context);
  void pending.catch(() => undefined);
  context.signal = replacement.signal; replacement.abort();
  try {
    await f.unblock();
    assert.notEqual(await pending, undefined);
    assert.equal(f.protectedCalls().length, 1);
  } finally { await f.unblock(); }
});

test("reply: queued deadline cannot be extended by caller mutation", { timeout: 5_000 }, async () => {
  const f = await blockedHeartbeat();
  const context = { expiresAt: deadline() };
  const outcome = captureFailure(invoke(f, 'reply', context));
  context.expiresAt = scope.expiresAt; f.setTime(START + 11_000);
  try {
    await f.unblock();
    fixedFailure(await outcome, DEADLINE);
    assert.equal(f.protectedCalls().length, 0);
  } finally { await f.unblock(); }
});

test("reply: queued live deadline cannot be shortened by caller mutation", { timeout: 5_000 }, async () => {
  const f = await blockedHeartbeat();
  const context = { expiresAt: deadline(20_000) };
  const pending = invoke(f, 'reply', context);
  void pending.catch(() => undefined);
  context.expiresAt = deadline(-1);
  try {
    await f.unblock();
    assert.notEqual(await pending, undefined);
    assert.equal(f.protectedCalls().length, 1);
  } finally { await f.unblock(); }
});

test("reply: fields added after queuing an empty context cannot change admission", { timeout: 5_000 }, async () => {
  const f = await blockedHeartbeat();
  const context: DispatchContext = {};
  const pending = invoke(f, 'reply', context);
  void pending.catch(() => undefined);
  const added = new AbortController(); added.abort();
  context.signal = added.signal; context.expiresAt = deadline(-1);
  try {
    await f.unblock();
    assert.notEqual(await pending, undefined);
    assert.equal(f.protectedCalls().length, 1);
  } finally { await f.unblock(); }
});

test("reply: cancellation during asynchronous owner admission prevents send", { timeout: 5_000 }, async () => {
  const f = fixture(); await f.channel.attach();
  const original = new AbortController(), entered = deferred(), gate = deferred();
  let first = true;
  f.hooks.owner = async () => { if (first) { first = false; entered.resolve(); await gate.promise; } };
  const context = { signal: original.signal };
  const outcome = captureFailure(invoke(f, 'reply', context));
  try {
    await entered.promise;
    original.abort(); context.signal = new AbortController().signal;
    gate.resolve();
    fixedFailure(await outcome, CANCELLED);
    assert.equal(f.protectedCalls().length, 0);
  } finally { gate.resolve(); }
});

test("reply: deadline expiring during owner admission prevents send", { timeout: 5_000 }, async () => {
  const f = fixture(); await f.channel.attach();
  const entered = deferred(), gate = deferred(); let first = true;
  f.hooks.owner = async () => { if (first) { first = false; entered.resolve(); await gate.promise; } };
  const outcome = captureFailure(invoke(f, 'reply', { expiresAt: deadline() }));
  try {
    await entered.promise; f.setTime(START + 11_000); gate.resolve();
    fixedFailure(await outcome, DEADLINE);
    assert.equal(f.protectedCalls().length, 0);
  } finally { gate.resolve(); }
});

test("reply: cancellation after possible signedPost effect is uncertain and closes without replay", { timeout: 5_000 }, async () => {
  const f = fixture(); await f.channel.attach();
  const original = new AbortController();
  f.hooks.send = action => { if (action === 'reply') original.abort(); };
  fixedFailure(await captureFailure(invoke(f, 'reply', { signal: original.signal })), UNCERTAIN);
  assert.equal(f.protectedCalls().length, 1);
  fixedFailure(await captureFailure(f.channel.inbox()), 'provider_session_channel_closed');
  assert.equal(f.protectedCalls().length, 1);
});

test("reply: original signal stays live through post-send owner wait", { timeout: 5_000 }, async () => {
  const f = fixture(); await f.channel.attach();
  const entered = deferred(), gate = deferred(), original = new AbortController(); let paused = false;
  f.hooks.owner = async () => {
    if (!paused && f.protectedCalls().length === 1) { paused = true; entered.resolve(); await gate.promise; }
  };
  const context = { signal: original.signal };
  const outcome = captureFailure(invoke(f, 'reply', context));
  try {
    await entered.promise;
    original.abort(); context.signal = new AbortController().signal; gate.resolve();
    fixedFailure(await outcome, UNCERTAIN);
    assert.equal(f.protectedCalls().length, 1);
    fixedFailure(await captureFailure(f.channel.inbox()), 'provider_session_channel_closed');
    assert.equal(f.protectedCalls().length, 1);
  } finally { gate.resolve(); }
});

test("reply: crossing a request deadline after send is not a new remote cancellation contract", { timeout: 5_000 }, async () => {
  const f = fixture(); await f.channel.attach();
  f.hooks.send = action => { if (action === 'reply') f.setTime(START + 11_000); };
  assert.notEqual(await invoke(f, 'reply', { expiresAt: deadline() }), undefined);
  assert.equal(f.protectedCalls().length, 1);
});

test("reply: live context stays off wire and preserves request fields", { timeout: 5_000 }, async () => {
  const f = fixture(); await f.channel.attach();
  await invoke(f, 'reply', { signal: new AbortController().signal, expiresAt: deadline() });
  const call = f.protectedCalls().at(-1);
  assert.ok(call);
  const baseFields = ['schema', 'bindingId', 'workspaceId', 'endpointId', 'repositoryBindingId', 'action'];
  const extra: string[] = ["questionId","outcome","answer","failureCode"];
  assert.deepEqual(Object.keys(call.body).sort(), [...baseFields, ...extra].sort());
  assert.equal(call.body.schema, 'dharma.provider-session-question-request/v1');
  assert.equal(call.body.bindingId, scope.bindingId);
  assert.equal(call.body.action, 'reply');
  assert.equal(Object.hasOwn(call.body, 'signal'), false);
  assert.equal(Object.hasOwn(call.body, 'expiresAt'), false);
});

test("reply: cancellation during content authorization prevents signed reply", { timeout: 5_000 }, async () => {
  const f = fixture(); await f.channel.attach();
  const original = new AbortController(), entered = deferred(), gate = deferred();
  f.hooks.content = async kind => { if (kind === 'answer') { entered.resolve(); await gate.promise; } };
  const context = { signal: original.signal };
  const outcome = captureFailure(f.channel.reply(replyInput(), context));
  try {
    await entered.promise; original.abort(); context.signal = new AbortController().signal; gate.resolve();
    fixedFailure(await outcome, CANCELLED);
    assert.equal(f.protectedCalls().length, 0);
  } finally { gate.resolve(); }
});

test("reply: expiry during content authorization prevents signed reply", { timeout: 5_000 }, async () => {
  const f = fixture(); await f.channel.attach();
  const entered = deferred(), gate = deferred();
  f.hooks.content = async kind => { if (kind === 'answer') { entered.resolve(); await gate.promise; } };
  const outcome = captureFailure(f.channel.reply(replyInput(), { expiresAt: deadline() }));
  try {
    await entered.promise; f.setTime(START + 11_000); gate.resolve();
    fixedFailure(await outcome, DEADLINE);
    assert.equal(f.protectedCalls().length, 0);
  } finally { gate.resolve(); }
});

test("inbox: cancellation during offer authorization never returns signed offers", { timeout: 5_000 }, async () => {
  const f = fixture(); await f.channel.attach();
  const entered = deferred(), gate = deferred(), original = new AbortController();
  f.hooks.content = async kind => { if (kind === 'question') { entered.resolve(); await gate.promise; } };
  const context = { signal: original.signal };
  const pending = captureFailure(f.channel.inbox(context));
  try {
    await entered.promise; original.abort(); context.signal = new AbortController().signal; gate.resolve();
    const error = await pending;
    assert.ok(error instanceof Error, 'cancelled authorization must not disclose offers');
    assert.ok([CANCELLED, UNCERTAIN].includes(error.message), 'fixed cancellation or retained uncertainty only');
    assert.equal(String(error).includes(CANARY), false);
    assert.equal(f.protectedCalls().length, 1);
  } finally { gate.resolve(); }
});

test("accept: context does not weaken acknowledgement correlation validation", { timeout: 5_000 }, async () => {
  for (const patch of [
    { questionId: uuid(30) }, { taskId: uuid(31) }, { targetBindingId: uuid(32) }, { state: 'queued' },
  ]) {
    const f = fixture(); await f.channel.attach(); f.patchAck(patch);
    fixedFailure(await captureFailure(invoke(f, 'accept', {
      signal: new AbortController().signal, expiresAt: deadline(),
    })), 'provider_session_channel_response');
    assert.equal(f.protectedCalls().length, 1);
  }
});

test("reply: context does not weaken acknowledgement correlation validation", { timeout: 5_000 }, async () => {
  for (const patch of [
    { questionId: uuid(30) }, { taskId: uuid(31) }, { targetBindingId: uuid(32) }, { state: 'queued' },
  ]) {
    const f = fixture(); await f.channel.attach(); f.patchAck(patch);
    fixedFailure(await captureFailure(invoke(f, 'reply', {
      signal: new AbortController().signal, expiresAt: deadline(),
    })), 'provider_session_channel_response');
    assert.equal(f.protectedCalls().length, 1);
  }
});

test("reply: queued payload and acknowledgement use the same call-time snapshot", { timeout: 5_000 }, async () => {
  const f = await blockedHeartbeat();
  const request = replyInput(), context = { signal: new AbortController().signal, expiresAt: deadline() };
  const pending = f.channel.reply(request, context);
  void pending.catch(() => undefined);
  request.questionId = uuid(30); request.taskId = uuid(31); request.answer = 'Mutated answer.';
  try {
    await f.unblock();
    const receipt = await pending;
    assert.equal(receipt.questionId, uuid(10)); assert.equal(receipt.taskId, uuid(11));
    assert.equal(f.protectedCalls().at(-1)?.body.questionId, uuid(10));
    assert.equal(f.protectedCalls().at(-1)?.body.answer, 'Use the signed catalog.');
  } finally { await f.unblock(); }
});

test("ask and read retain their existing signal-only optional interfaces", { timeout: 5_000 }, async () => {
  const f = fixture(); await f.channel.attach();
  const controller = new AbortController();
  const queued = await f.raw.ask({
    targetBindingId: uuid(20), taskId: uuid(11), category: 'architecture',
    question: 'Which signed catalog applies?', maximumProviderCostCents: 25,
  }, { signal: controller.signal });
  assert.equal(queued.state, 'queued'); assert.equal(queued.targetBindingId, uuid(20));
  const result = await f.raw.read(uuid(10), uuid(11), scope.bindingId, { signal: controller.signal });
  assert.equal(result.state, 'answered'); assert.equal(result.answer, 'Use the signed catalog.');
  assert.equal(f.protectedCalls().length, 2);
});
