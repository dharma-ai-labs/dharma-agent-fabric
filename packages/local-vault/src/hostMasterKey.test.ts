import assert from 'node:assert/strict';
import test from 'node:test';
import {loadOrCreateVaultMasterKey} from './index.js';
import type {SecureSecretStore} from '@dharma-ai-labs/agent-fabric-secure-store';

type Scope = {signal: AbortSignal; current(): Promise<boolean>};
const load = loadOrCreateVaultMasterKey as unknown as (store: SecureSecretStore, scope: Scope) => Promise<Buffer>;
function fixture(value: string | null = Buffer.alloc(32, 1).toString('base64')) {
  const calls: string[] = []; let allowed = true, after = () => {};
  const abort = new AbortController();
  const store: SecureSecretStore = {backend: 'linux-secret-service',
    async get() {calls.push('get'); const result = value; after(); return result;},
    async put(_account, next) {calls.push('put'); value = next; after();},
    async delete() {throw new Error('unexpected delete');}};
  const scope = {signal: abort.signal, current: async () => allowed};
  return {store, scope, calls, abort, allow(next: boolean) {allowed = next;}, after(fn: () => void) {after = fn;}};
}

test('malformed supplied vault-key scopes are sanitized before store or environment fallback', async () => {
  const previousAllow = process.env.DHARMA_ALLOW_ENV_KEY, previousKey = process.env.DHARMA_VAULT_KEY;
  try {
    process.env.DHARMA_ALLOW_ENV_KEY = '1'; process.env.DHARMA_VAULT_KEY = Buffer.alloc(32, 2).toString('base64');
    const f = fixture();
    const throwingSignal = Object.defineProperty({}, 'signal', {get() {throw new Error('private-accessor-canary');}});
    const throwingCurrent = Object.defineProperty({signal: f.scope.signal}, 'current', {get() {throw new Error('private-accessor-canary');}});
    for (const scope of [null, false, 0, '', {}, throwingSignal, throwingCurrent]) {
      await assert.rejects(load(f.store, scope as unknown as Scope), {message: 'vault_key_scope_unavailable'});
      assert.deepEqual(f.calls, []);
    }
  } finally {
    if (previousAllow === undefined) delete process.env.DHARMA_ALLOW_ENV_KEY; else process.env.DHARMA_ALLOW_ENV_KEY = previousAllow;
    if (previousKey === undefined) delete process.env.DHARMA_VAULT_KEY; else process.env.DHARMA_VAULT_KEY = previousKey;
  }
});

test('vault-key fence denies accessor scopes and snapshots data fields without trusting function bind properties', async () => {
  const f = fixture(); let signals = 0, callbacks = 0;
  const current = async () => true;
  Object.defineProperty(current, 'bind', {get() {throw new Error('private-bind-canary');}});
  const scope = {get signal() {signals++; return f.scope.signal;}, get current() {callbacks++; return current;}};
  await assert.rejects(load(f.store, scope), {message: 'vault_key_scope_unavailable'});
  assert.equal(signals, 0); assert.equal(callbacks, 0); assert.deepEqual(f.calls, []);
  assert.deepEqual(await load(f.store, {signal: f.scope.signal, current}), Buffer.alloc(32, 1));
  assert.deepEqual(f.calls, ['get']);
});

test('scoped vault key refuses cancellation or revocation before touching protected storage', async () => {
  for (const cancelled of [false, true]) {
    const f = fixture(); if (cancelled) f.abort.abort(); else f.allow(false);
    await assert.rejects(load(f.store, f.scope), {message: 'vault_key_scope_unavailable'});
    assert.deepEqual(f.calls, []);
  }
});

test('scoped vault key does not return an existing key or create a missing key after withdrawal', async () => {
  for (const value of [null, Buffer.alloc(32, 1).toString('base64')]) {
    const f = fixture(value); f.after(() => f.allow(false));
    await assert.rejects(load(f.store, f.scope), {message: 'vault_key_scope_unavailable'});
    assert.deepEqual(f.calls, ['get']);
  }
});

test('scoped vault key retains a partial write without admitting readback after cancellation', async () => {
  const f = fixture(null); f.after(() => {if (f.calls.at(-1) === 'put') f.abort.abort();});
  await assert.rejects(load(f.store, f.scope), {message: 'vault_key_scope_unavailable'});
  assert.deepEqual(f.calls, ['get', 'put']);
});

test('scoped vault key never accepts the developer environment-key fallback', async () => {
  const previousAllow = process.env.DHARMA_ALLOW_ENV_KEY, previousKey = process.env.DHARMA_VAULT_KEY;
  try {
    process.env.DHARMA_ALLOW_ENV_KEY = '1'; process.env.DHARMA_VAULT_KEY = Buffer.alloc(32, 2).toString('base64');
    const f = fixture(); const key = await load(f.store, f.scope);
    assert.deepEqual(key, Buffer.alloc(32, 1)); assert.deepEqual(f.calls, ['get']);
  } finally {
    if (previousAllow === undefined) delete process.env.DHARMA_ALLOW_ENV_KEY; else process.env.DHARMA_ALLOW_ENV_KEY = previousAllow;
    if (previousKey === undefined) delete process.env.DHARMA_VAULT_KEY; else process.env.DHARMA_VAULT_KEY = previousKey;
  }
});

test('scoped vault key preserves existing-key and one-time generation behavior', async () => {
  for (const value of [null, Buffer.alloc(32, 1).toString('base64')]) {
    const f = fixture(value), first = await load(f.store, f.scope), second = await load(f.store, f.scope);
    assert.equal(first.length, 32); assert.deepEqual(second, first);
    assert.deepEqual(f.calls, value ? ['get', 'get'] : ['get', 'put', 'get', 'get']);
  }
});

test('scoped vault key withholds vendor error details and denies nonboolean authority', async () => {
  const f = fixture(); f.store.get = async () => {throw new Error('private-store-error-canary');};
  await assert.rejects(load(f.store, f.scope), {message: 'vault_key_storage_unavailable'});
  for (const current of [async () => 'true', async () => {throw new Error('private-scope-canary');}]) {
    await assert.rejects(load(f.store, {...f.scope, current} as unknown as Scope), {message: 'vault_key_scope_unavailable'});
  }
});

test('scoped vault key snapshots qualification callback before the first asynchronous effect', async () => {
  const f = fixture(); const scope = {...f.scope};
  f.after(() => {scope.current = async () => {throw new Error('changed callback');};});
  assert.deepEqual(await load(f.store, scope), Buffer.alloc(32, 1));
});
