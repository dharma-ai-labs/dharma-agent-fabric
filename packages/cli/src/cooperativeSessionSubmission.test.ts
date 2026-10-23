import { test } from 'node:test';
import assert from 'node:assert/strict';
import { snapshotCooperativeSessionAnswer } from './cooperativeSessionSubmission.js';

const INVALID = 'cooperative_session_submission_invalid';
const PRIVATE_CANARY = 'PRIVATE_DIAGNOSTIC_CANARY_DO_NOT_ECHO';
const FIELDS = ['questionId', 'taskId', 'nonce', 'offerHash', 'attemptId', 'answer'] as const;

function valid(): Record<(typeof FIELDS)[number], string> {
  return {
    questionId: 'synthetic-question',
    taskId: 'synthetic-task',
    nonce: 'synthetic-nonce',
    offerHash: 'synthetic-offer',
    attemptId: 'synthetic-attempt',
    answer: 'synthetic answer',
  };
}

function captureFailure(value: unknown): unknown {
  try {
    snapshotCooperativeSessionAnswer(value);
  } catch (error) {
    return error;
  }
  return undefined;
}

function assertFixedFailure(error: unknown): void {
  assert.ok(error instanceof Error, 'invalid input must throw an Error');
  assert.equal(error.message, INVALID);
  assert.equal(String(error).includes(PRIVATE_CANARY), false);
}

function assertInvalid(value: unknown): void {
  assertFixedFailure(captureFailure(value));
}

test("accepts exactly six own enumerable string data properties", () => {
  const input = valid();
  const result = snapshotCooperativeSessionAnswer(input);
  assert.deepEqual(result, input);
  assert.notStrictEqual(result, input);
  assert.deepEqual(Reflect.ownKeys(result).sort(), [...FIELDS].sort());
  assert.equal(Object.getPrototypeOf(result), Object.prototype);
  for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(result))) {
    assert.equal(Object.hasOwn(descriptor, 'value'), true);
    assert.equal(descriptor.enumerable, true);
    assert.equal(typeof descriptor.value, 'string');
  }
});

test("accepts a frozen ordinary six-field object", () => {
  const input = Object.freeze(valid());
  assert.deepEqual(snapshotCooperativeSessionAnswer(input), valid());
  assert.equal(Object.isFrozen(input), true);
});

test("accepts sealed and readonly ordinary data descriptors", () => {
  const input = valid();
  Object.defineProperty(input, 'answer', { value: input.answer, enumerable: true, writable: false, configurable: false });
  Object.seal(input);
  assert.deepEqual(snapshotCooperativeSessionAnswer(input), valid());
});

test("returns a detached snapshot stable after mutation of every caller field", () => {
  const input = valid();
  const expected = { ...input };
  const result = snapshotCooperativeSessionAnswer(input);
  for (const field of FIELDS) input[field] = 'mutated-' + field;
  assert.deepEqual(result, expected);
  assert.notStrictEqual(result, input);
  for (const field of FIELDS) assert.notEqual(result[field], input[field]);
});

test("copies six strings verbatim without adding later semantic policy checks", () => {
  const input = {
    questionId: '', taskId: 'not-a-uuid', nonce: '', offerHash: 'not-a-hash',
    attemptId: '', answer: '  synthetic multiline\nanswer\u0000  ',
  };
  assert.deepEqual(snapshotCooperativeSessionAnswer(input), input);
});

test("does not coerce values or invoke caller conversion callbacks", () => {
  let callbacks = 0;
  const value = {
    toString() { callbacks++; throw new Error(PRIVATE_CANARY); },
    valueOf() { callbacks++; throw new Error(PRIVATE_CANARY); },
    [Symbol.toPrimitive]() { callbacks++; throw new Error(PRIVATE_CANARY); },
  };
  const error = captureFailure({ ...valid(), answer: value });
  assert.equal(callbacks, 0);
  assertFixedFailure(error);
});

test("rejects missing required own property questionId", () => {
  const input: Partial<ReturnType<typeof valid>> = valid();
  delete input.questionId;
  assertInvalid(input);
});

test("rejects missing required own property taskId", () => {
  const input: Partial<ReturnType<typeof valid>> = valid();
  delete input.taskId;
  assertInvalid(input);
});

test("rejects missing required own property nonce", () => {
  const input: Partial<ReturnType<typeof valid>> = valid();
  delete input.nonce;
  assertInvalid(input);
});

test("rejects missing required own property offerHash", () => {
  const input: Partial<ReturnType<typeof valid>> = valid();
  delete input.offerHash;
  assertInvalid(input);
});

test("rejects missing required own property attemptId", () => {
  const input: Partial<ReturnType<typeof valid>> = valid();
  delete input.attemptId;
  assertInvalid(input);
});

test("rejects missing required own property answer", () => {
  const input: Partial<ReturnType<typeof valid>> = valid();
  delete input.answer;
  assertInvalid(input);
});

test("rejects enumerable getter at questionId without invocation", () => {
  let calls = 0;
  const input = valid();
  Object.defineProperty(input, 'questionId', {
    enumerable: true, configurable: true,
    get() { calls++; return 'synthetic accessor value'; },
  });
  const error = captureFailure(input);
  assert.equal(calls, 0, 'getter must not run');
  assertFixedFailure(error);
});

test("rejects throwing getter at questionId without leaking diagnostics", () => {
  let calls = 0;
  const input = valid();
  Object.defineProperty(input, 'questionId', {
    enumerable: true, configurable: true,
    get() { calls++; throw new Error(PRIVATE_CANARY); },
  });
  const error = captureFailure(input);
  assert.equal(calls, 0, 'throwing getter must not run');
  assertFixedFailure(error);
});

test("rejects setter-only accessor at questionId without invocation", () => {
  let calls = 0;
  const input = valid();
  Object.defineProperty(input, 'questionId', {
    enumerable: true, configurable: true,
    set(_value: unknown) { calls++; throw new Error(PRIVATE_CANARY); },
  });
  const error = captureFailure(input);
  assert.equal(calls, 0, 'setter must not run');
  assertFixedFailure(error);
});

test("rejects hidden required data property questionId", () => {
  const input = valid();
  Object.defineProperty(input, 'questionId', { value: input.questionId, enumerable: false, configurable: true });
  assertInvalid(input);
});

test("rejects non-string scalar or object at questionId", () => {
  const invalidValues: unknown[] = [undefined, null, 0, -1, NaN, Infinity, true, 1n, Symbol('synthetic'), {}, [], () => 'synthetic'];
  for (const value of invalidValues) assertInvalid({ ...valid(), questionId: value });
});

test("rejects enumerable getter at taskId without invocation", () => {
  let calls = 0;
  const input = valid();
  Object.defineProperty(input, 'taskId', {
    enumerable: true, configurable: true,
    get() { calls++; return 'synthetic accessor value'; },
  });
  const error = captureFailure(input);
  assert.equal(calls, 0, 'getter must not run');
  assertFixedFailure(error);
});

test("rejects throwing getter at taskId without leaking diagnostics", () => {
  let calls = 0;
  const input = valid();
  Object.defineProperty(input, 'taskId', {
    enumerable: true, configurable: true,
    get() { calls++; throw new Error(PRIVATE_CANARY); },
  });
  const error = captureFailure(input);
  assert.equal(calls, 0, 'throwing getter must not run');
  assertFixedFailure(error);
});

test("rejects setter-only accessor at taskId without invocation", () => {
  let calls = 0;
  const input = valid();
  Object.defineProperty(input, 'taskId', {
    enumerable: true, configurable: true,
    set(_value: unknown) { calls++; throw new Error(PRIVATE_CANARY); },
  });
  const error = captureFailure(input);
  assert.equal(calls, 0, 'setter must not run');
  assertFixedFailure(error);
});

test("rejects hidden required data property taskId", () => {
  const input = valid();
  Object.defineProperty(input, 'taskId', { value: input.taskId, enumerable: false, configurable: true });
  assertInvalid(input);
});

test("rejects non-string scalar or object at taskId", () => {
  const invalidValues: unknown[] = [undefined, null, 0, -1, NaN, Infinity, true, 1n, Symbol('synthetic'), {}, [], () => 'synthetic'];
  for (const value of invalidValues) assertInvalid({ ...valid(), taskId: value });
});

test("rejects enumerable getter at nonce without invocation", () => {
  let calls = 0;
  const input = valid();
  Object.defineProperty(input, 'nonce', {
    enumerable: true, configurable: true,
    get() { calls++; return 'synthetic accessor value'; },
  });
  const error = captureFailure(input);
  assert.equal(calls, 0, 'getter must not run');
  assertFixedFailure(error);
});

test("rejects throwing getter at nonce without leaking diagnostics", () => {
  let calls = 0;
  const input = valid();
  Object.defineProperty(input, 'nonce', {
    enumerable: true, configurable: true,
    get() { calls++; throw new Error(PRIVATE_CANARY); },
  });
  const error = captureFailure(input);
  assert.equal(calls, 0, 'throwing getter must not run');
  assertFixedFailure(error);
});

test("rejects setter-only accessor at nonce without invocation", () => {
  let calls = 0;
  const input = valid();
  Object.defineProperty(input, 'nonce', {
    enumerable: true, configurable: true,
    set(_value: unknown) { calls++; throw new Error(PRIVATE_CANARY); },
  });
  const error = captureFailure(input);
  assert.equal(calls, 0, 'setter must not run');
  assertFixedFailure(error);
});

test("rejects hidden required data property nonce", () => {
  const input = valid();
  Object.defineProperty(input, 'nonce', { value: input.nonce, enumerable: false, configurable: true });
  assertInvalid(input);
});

test("rejects non-string scalar or object at nonce", () => {
  const invalidValues: unknown[] = [undefined, null, 0, -1, NaN, Infinity, true, 1n, Symbol('synthetic'), {}, [], () => 'synthetic'];
  for (const value of invalidValues) assertInvalid({ ...valid(), nonce: value });
});

test("rejects enumerable getter at offerHash without invocation", () => {
  let calls = 0;
  const input = valid();
  Object.defineProperty(input, 'offerHash', {
    enumerable: true, configurable: true,
    get() { calls++; return 'synthetic accessor value'; },
  });
  const error = captureFailure(input);
  assert.equal(calls, 0, 'getter must not run');
  assertFixedFailure(error);
});

test("rejects throwing getter at offerHash without leaking diagnostics", () => {
  let calls = 0;
  const input = valid();
  Object.defineProperty(input, 'offerHash', {
    enumerable: true, configurable: true,
    get() { calls++; throw new Error(PRIVATE_CANARY); },
  });
  const error = captureFailure(input);
  assert.equal(calls, 0, 'throwing getter must not run');
  assertFixedFailure(error);
});

test("rejects setter-only accessor at offerHash without invocation", () => {
  let calls = 0;
  const input = valid();
  Object.defineProperty(input, 'offerHash', {
    enumerable: true, configurable: true,
    set(_value: unknown) { calls++; throw new Error(PRIVATE_CANARY); },
  });
  const error = captureFailure(input);
  assert.equal(calls, 0, 'setter must not run');
  assertFixedFailure(error);
});

test("rejects hidden required data property offerHash", () => {
  const input = valid();
  Object.defineProperty(input, 'offerHash', { value: input.offerHash, enumerable: false, configurable: true });
  assertInvalid(input);
});

test("rejects non-string scalar or object at offerHash", () => {
  const invalidValues: unknown[] = [undefined, null, 0, -1, NaN, Infinity, true, 1n, Symbol('synthetic'), {}, [], () => 'synthetic'];
  for (const value of invalidValues) assertInvalid({ ...valid(), offerHash: value });
});

test("rejects enumerable getter at attemptId without invocation", () => {
  let calls = 0;
  const input = valid();
  Object.defineProperty(input, 'attemptId', {
    enumerable: true, configurable: true,
    get() { calls++; return 'synthetic accessor value'; },
  });
  const error = captureFailure(input);
  assert.equal(calls, 0, 'getter must not run');
  assertFixedFailure(error);
});

test("rejects throwing getter at attemptId without leaking diagnostics", () => {
  let calls = 0;
  const input = valid();
  Object.defineProperty(input, 'attemptId', {
    enumerable: true, configurable: true,
    get() { calls++; throw new Error(PRIVATE_CANARY); },
  });
  const error = captureFailure(input);
  assert.equal(calls, 0, 'throwing getter must not run');
  assertFixedFailure(error);
});

test("rejects setter-only accessor at attemptId without invocation", () => {
  let calls = 0;
  const input = valid();
  Object.defineProperty(input, 'attemptId', {
    enumerable: true, configurable: true,
    set(_value: unknown) { calls++; throw new Error(PRIVATE_CANARY); },
  });
  const error = captureFailure(input);
  assert.equal(calls, 0, 'setter must not run');
  assertFixedFailure(error);
});

test("rejects hidden required data property attemptId", () => {
  const input = valid();
  Object.defineProperty(input, 'attemptId', { value: input.attemptId, enumerable: false, configurable: true });
  assertInvalid(input);
});

test("rejects non-string scalar or object at attemptId", () => {
  const invalidValues: unknown[] = [undefined, null, 0, -1, NaN, Infinity, true, 1n, Symbol('synthetic'), {}, [], () => 'synthetic'];
  for (const value of invalidValues) assertInvalid({ ...valid(), attemptId: value });
});

test("rejects enumerable getter at answer without invocation", () => {
  let calls = 0;
  const input = valid();
  Object.defineProperty(input, 'answer', {
    enumerable: true, configurable: true,
    get() { calls++; return 'synthetic accessor value'; },
  });
  const error = captureFailure(input);
  assert.equal(calls, 0, 'getter must not run');
  assertFixedFailure(error);
});

test("rejects throwing getter at answer without leaking diagnostics", () => {
  let calls = 0;
  const input = valid();
  Object.defineProperty(input, 'answer', {
    enumerable: true, configurable: true,
    get() { calls++; throw new Error(PRIVATE_CANARY); },
  });
  const error = captureFailure(input);
  assert.equal(calls, 0, 'throwing getter must not run');
  assertFixedFailure(error);
});

test("rejects setter-only accessor at answer without invocation", () => {
  let calls = 0;
  const input = valid();
  Object.defineProperty(input, 'answer', {
    enumerable: true, configurable: true,
    set(_value: unknown) { calls++; throw new Error(PRIVATE_CANARY); },
  });
  const error = captureFailure(input);
  assert.equal(calls, 0, 'setter must not run');
  assertFixedFailure(error);
});

test("rejects hidden required data property answer", () => {
  const input = valid();
  Object.defineProperty(input, 'answer', { value: input.answer, enumerable: false, configurable: true });
  assertInvalid(input);
});

test("rejects non-string scalar or object at answer", () => {
  const invalidValues: unknown[] = [undefined, null, 0, -1, NaN, Infinity, true, 1n, Symbol('synthetic'), {}, [], () => 'synthetic'];
  for (const value of invalidValues) assertInvalid({ ...valid(), answer: value });
});

test("rejects an extra enumerable string key", () => {
  assertInvalid({ ...valid(), extra: 'synthetic' });
});

test("rejects an extra non-enumerable data key", () => {
  const input = valid();
  Object.defineProperty(input, 'extra', { value: 'synthetic', enumerable: false });
  assertInvalid(input);
});

test("rejects hidden accessor extra without invoking it", () => {
  let calls = 0;
  const input = valid();
  Object.defineProperty(input, 'extra', {
    enumerable: false,
    get() { calls++; throw new Error(PRIVATE_CANARY); },
  });
  const error = captureFailure(input);
  assert.equal(calls, 0);
  assertFixedFailure(error);
});

test("rejects enumerable symbol key even when its value is a string", () => {
  const input = valid();
  Object.defineProperty(input, Symbol('synthetic extra'), { value: 'synthetic', enumerable: true });
  assertInvalid(input);
});

test("rejects non-enumerable symbol accessor without invoking it", () => {
  let calls = 0;
  const input = valid();
  Object.defineProperty(input, Symbol('synthetic hidden extra'), {
    enumerable: false,
    get() { calls++; throw new Error(PRIVATE_CANARY); },
  });
  const error = captureFailure(input);
  assert.equal(calls, 0);
  assertFixedFailure(error);
});

test("rejects an own constructor key rather than treating it as metadata", () => {
  assertInvalid({ ...valid(), constructor: 'synthetic' });
});

test("rejects own __proto__ data without changing or accepting the prototype", () => {
  const input = valid();
  Object.defineProperty(input, '__proto__', { value: 'synthetic', enumerable: false });
  assert.equal(Object.getPrototypeOf(input), Object.prototype);
  assertInvalid(input);
});

test("rejects null-prototype six-field records", () => {
  assertInvalid(Object.assign(Object.create(null) as object, valid()));
});

test("rejects custom prototype with six valid own fields", () => {
  const prototype = { inherited: 'synthetic' };
  assertInvalid(Object.assign(Object.create(prototype) as object, valid()));
});

test("rejects inherited required fields instead of reading them", () => {
  assertInvalid(Object.create(valid()));
});

test("rejects inherited accessor without executing it", () => {
  let calls = 0;
  const prototype = Object.create(null) as object;
  Object.defineProperty(prototype, 'questionId', {
    enumerable: true,
    get() { calls++; throw new Error(PRIVATE_CANARY); },
  });
  const own: Partial<ReturnType<typeof valid>> = valid();
  delete own.questionId;
  const input = Object.assign(Object.create(prototype) as object, own);
  const error = captureFailure(input);
  assert.equal(calls, 0);
  assertFixedFailure(error);
});

test("rejects class instances with otherwise valid own fields", () => {
  class Submission {
    questionId = 'synthetic-question';
    taskId = 'synthetic-task';
    nonce = 'synthetic-nonce';
    offerHash = 'synthetic-offer';
    attemptId = 'synthetic-attempt';
    answer = 'synthetic answer';
  }
  assertInvalid(new Submission());
});

test("rejects boxed primitives decorated with six valid fields", () => {
  for (const input of [new String(''), new Number(0), new Boolean(false)]) {
    assertInvalid(Object.assign(input, valid()));
  }
});

test("rejects arrays even when their enumerable own fields match the contract", () => {
  assertInvalid(Object.assign([], valid()));
  assertInvalid(Object.assign(['synthetic element'], valid()));
});

test("rejects callable input without invoking its body", () => {
  let callbacks = 0;
  const input = Object.assign(() => { callbacks++; throw new Error(PRIVATE_CANARY); }, valid());
  const error = captureFailure(input);
  assert.equal(callbacks, 0);
  assertFixedFailure(error);
});

test("rejects null and ordinary primitives with the fixed error", () => {
  const inputs: unknown[] = [null, undefined, false, true, 0, 1, NaN, Infinity, '', 'abcdef', 1n, Symbol('synthetic')];
  for (const input of inputs) assertInvalid(input);
});

test("rejects Proxy before any reflection or value trap runs", () => {
  let traps = 0;
  const fail = (): never => { traps++; throw new Error(PRIVATE_CANARY); };
  const input = new Proxy(valid(), {
    ownKeys: fail,
    getOwnPropertyDescriptor: fail,
    getPrototypeOf: fail,
    get: fail,
    has: fail,
    isExtensible: fail,
  });
  const error = captureFailure(input);
  assert.equal(traps, 0, 'Proxy must be rejected without entering traps');
  assertFixedFailure(error);
});

test("rejects transparent Proxy without enumerating or reading its target", () => {
  let traps = 0;
  const target = valid();
  const input = new Proxy(target, {
    ownKeys(object) { traps++; return Reflect.ownKeys(object); },
    getOwnPropertyDescriptor(object, key) { traps++; return Reflect.getOwnPropertyDescriptor(object, key); },
    getPrototypeOf(object) { traps++; return Reflect.getPrototypeOf(object); },
    get(object, key, receiver) { traps++; return Reflect.get(object, key, receiver); },
  });
  const error = captureFailure(input);
  assert.equal(traps, 0);
  assertFixedFailure(error);
  assert.deepEqual(target, valid());
});

test("rejects revoked Proxy with sanitized fixed error", () => {
  const { proxy, revoke } = Proxy.revocable(valid(), {});
  revoke();
  assertInvalid(proxy);
});

test("rejects callable Proxy without apply or reflection traps", () => {
  let traps = 0;
  let callbacks = 0;
  const target = Object.assign(() => { callbacks++; return 'synthetic'; }, valid());
  const fail = (): never => { traps++; throw new Error(PRIVATE_CANARY); };
  const input = new Proxy(target, {
    apply: fail, ownKeys: fail, getOwnPropertyDescriptor: fail, getPrototypeOf: fail, get: fail,
  });
  const error = captureFailure(input);
  assert.equal(traps, 0);
  assert.equal(callbacks, 0);
  assertFixedFailure(error);
});
