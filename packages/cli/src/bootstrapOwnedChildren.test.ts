import assert from 'node:assert/strict';
import {spawn, type ChildProcess} from 'node:child_process';
import {EventEmitter} from 'node:events';
import {resolve} from 'node:path';
import test from 'node:test';
import {captureBootstrapHostChild, drainBootstrapHostChildren, prepareCodexBootstrapHost,
  runCodexBootstrapHost, runCodexBootstrapHostScope} from './bootstrapHostScope.js';
import {watchOwnedChild} from './ownedChildLifecycle.js';

const id = (n: number) => `${String(n).padStart(8, '0')}-1111-4111-8111-111111111111`;
function input() {
  const now = Date.now(), hash = `sha256:${'a'.repeat(64)}`;
  return {workspace: resolve('synthetic-source'), signal: new AbortController().signal, current: async () => true,
    intent: {schema: 'dharma.codex-setup-intent/v1' as const, operationId: id(1), setupReference: id(2),
      organizationId: 'org_demo', recipientMembershipId: id(3), origin: 'https://hq.example',
      repositoryFingerprint: hash, policyRevision: 'policy-v1', scopeDigest: hash, contractDigest: hash,
      hostContextId: id(4), issuedAt: new Date(now - 1000).toISOString(), expiresAt: new Date(now + 60_000).toISOString()}};
}
function childFixture() {
  const child = new EventEmitter() as ChildProcess;
  Object.assign(child, {pid: 12345, exitCode: null, signalCode: null});
  let signals = 0;
  child.kill = () => {signals++; queueMicrotask(() => child.emit('exit', null, 'SIGTERM')); return true;};
  return {child, get signals() {return signals;}};
}

test('original scope owns a captured child beyond a borrowed continuation, then drains it once', async () => {
  const prepared = prepareCodexBootstrapHost(input()), f = childFixture();
  await runCodexBootstrapHostScope(prepared.scope, async () => {
    captureBootstrapHostChild(prepared.scope, f.child);
    captureBootstrapHostChild(prepared.scope, f.child);
  });
  assert.equal(prepared.scope.signal.aborted, false); assert.equal(f.signals, 0);
  await Promise.all([drainBootstrapHostChildren(prepared.scope), drainBootstrapHostChildren(prepared.scope)]);
  assert.equal(f.signals, 1); assert.equal(prepared.scope.signal.aborted, true);
});

test('original scope cannot adopt another scope child or capture outside its borrowed frame', async () => {
  const first = prepareCodexBootstrapHost(input()), second = prepareCodexBootstrapHost(input()), f = childFixture();
  assert.throws(() => captureBootstrapHostChild(first.scope, f.child), /^Error: codex_setup_host_child_owner_invalid$/);
  await runCodexBootstrapHostScope(first.scope, async () => captureBootstrapHostChild(first.scope, f.child));
  await assert.rejects(runCodexBootstrapHostScope(second.scope, async () => captureBootstrapHostChild(second.scope, f.child)),
    /^Error: codex_setup_host_child_owner_invalid$/);
  assert.equal(f.signals, 0);
  await drainBootstrapHostChildren(second.scope); assert.equal(f.signals, 0);
  await drainBootstrapHostChildren(first.scope); assert.equal(f.signals, 1);
});

test('original scope captures an acquired child even when spawn itself triggered withdrawal', async () => {
  const prepared = prepareCodexBootstrapHost(input()), f = childFixture();
  await assert.rejects(runCodexBootstrapHostScope(prepared.scope, async () => {
    prepared.scope.close(); captureBootstrapHostChild(prepared.scope, f.child);
  }), /^Error: codex_setup_host_scope_unavailable$/);
  await drainBootstrapHostChildren(prepared.scope); assert.equal(f.signals, 1);
});

test('original scope drain waits for exit rather than an owned signal error', async () => {
  const prepared = prepareCodexBootstrapHost(input()), f = childFixture(); let settled = false;
  f.child.kill = () => {f.child.emit('error', new Error('PRIVATE_SIGNAL_CANARY')); return true;};
  await runCodexBootstrapHostScope(prepared.scope, async () => captureBootstrapHostChild(prepared.scope, f.child));
  const drain = drainBootstrapHostChildren(prepared.scope).then(() => {settled = true;});
  await new Promise<void>(done => setImmediate(done));
  assert.equal(settled, false);
  f.child.emit('exit', null, 'SIGTERM'); await drain; assert.equal(settled, true);
});

test('original scope rejects a forged drain and does not signal an uncaptured child', async () => {
  const original = prepareCodexBootstrapHost(input()), f = childFixture();
  await assert.rejects(drainBootstrapHostChildren({...original.scope}), /^Error: codex_setup_host_child_owner_invalid$/);
  await drainBootstrapHostChildren(original.scope); assert.equal(f.signals, 0);
});

test('direct original scope failure drains only its actual C-only spawned child', async () => {
  const unrelated = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {stdio: 'ignore'});
  let owned: ChildProcess | undefined;
  try {
    await assert.rejects(runCodexBootstrapHost(input(), async prepared => {
      owned = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {stdio: 'ignore'});
      captureBootstrapHostChild(prepared.scope, owned);
      throw new Error('synthetic continuation failure');
    }), /^Error: synthetic continuation failure$/);
    assert.ok(owned && (owned.exitCode !== null || owned.signalCode !== null));
    assert.equal(unrelated.exitCode, null); assert.equal(unrelated.signalCode, null);
  } finally {await watchOwnedChild(unrelated).stop({graceMs: 1000}); if (owned) await watchOwnedChild(owned).stop({graceMs: 1000});}
});
