import assert from 'node:assert/strict';
import test from 'node:test';
import {namedSessionStartupPhaseError, isNamedSessionStartupPhaseFailure, namedSessionStartupErrors} from './namedSessionStartupDiagnostic.js';

test('unknown private errors produce only a fixed phase and no original cause', () => {
  const result = namedSessionStartupPhaseError('transport', new Error('password=secret-placeholder'));
  assert.equal(result.message, 'named_session_startup_phase_transport_unclassified');
  assert.equal(Object.hasOwn(result, 'cause'), false);
  assert.equal(JSON.stringify(result).includes('secret-placeholder'), false);
});

for (const [code, reason] of Object.entries({ENOENT: 'missing', EACCES: 'permission', EPERM: 'permission',
  EADDRINUSE: 'conflict', EEXIST: 'conflict', ETIMEDOUT: 'timeout', ECONNREFUSED: 'connection',
  ECONNRESET: 'connection', ABORT_ERR: 'aborted'})) {
  test(`only fixed errno classification is emitted (${code})`, () => {
    const error = Object.assign(new Error('secret-placeholder'), {code, path: 'private-placeholder'});
    assert.equal(namedSessionStartupPhaseError('binding', new Error('outer-secret', {cause: error})).message,
      `named_session_startup_phase_binding_${reason}`);
  });
}

test('fixed existing authorization and identity failures retain their public classification', () => {
  for (const message of Object.keys(namedSessionStartupErrors)) {
    assert.equal(namedSessionStartupPhaseError('registration', new Error(message)).message, message);
  }
});

test('getters, proxies, cycles and unrecognized errno never disclose or execute private values', () => {
  const accessor = Object.defineProperties({}, {
    message: {get() {throw new Error('getter-ran');}},
    code: {get() {throw new Error('getter-ran');}},
    cause: {get() {throw new Error('getter-ran');}},
  });
  const proxy = new Proxy({}, {getOwnPropertyDescriptor() {throw new Error('proxy-ran');}});
  const cycle: {cause?: unknown} = {}; cycle.cause = cycle;
  for (const error of [accessor, proxy, cycle, {code: 'secret-placeholder'}, 'secret-placeholder', null]) {
    assert.equal(namedSessionStartupPhaseError('account', error).message, 'named_session_startup_phase_account_unclassified');
  }
});

test('only complete allowlisted phase codes are accepted', () => {
  assert.equal(isNamedSessionStartupPhaseFailure('named_session_startup_phase_thread_timeout'), true);
  for (const value of ['named_session_startup_phase_thread_timeout\nsecret',
    'named_session_startup_phase_foreign_missing', 'named_session_startup_phase_account_secret', {}, null]) {
    assert.equal(isNamedSessionStartupPhaseFailure(value), false);
  }
});
