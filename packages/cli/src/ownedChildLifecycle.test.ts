import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { watchOwnedChild } from './ownedChildLifecycle.js';

function fixture() {
  const child = new EventEmitter() as ChildProcess;
  Object.assign(child, {pid: 12345, exitCode: null, signalCode: null});
  const signals: string[] = [];
  child.kill = signal => { signals.push(String(signal)); return true; };
  return {child, signals};
}
const tick = () => new Promise<void>(done => setImmediate(done));

test('owned child signal error does not confirm process termination', async () => {
  const f = fixture(); const owned = watchOwnedChild(f.child);
  let exited = false; void owned.exited.then(() => { exited = true; });
  f.child.emit('error', new Error('PRIVATE_CANARY'));
  await tick();
  assert.equal(owned.failed, true); assert.equal(owned.stopped, false); assert.equal(exited, false);
  f.child.emit('exit', null, 'SIGTERM'); await owned.exited;
  assert.equal(owned.stopped, true);
});

test('owned child failed spawn without a PID is not treated as a live process', async () => {
  const f = fixture(); Object.assign(f.child, {pid: undefined});
  const owned = watchOwnedChild(f.child);
  f.child.emit('error', new Error('synthetic spawn failure'));
  await owned.exited; await owned.stop();
  assert.equal(owned.failed, true); assert.equal(owned.stopped, true); assert.deepEqual(f.signals, []);
});

test('owned child concurrent cancellation waits for actual exit and signals once', async () => {
  const f = fixture(); const owned = watchOwnedChild(f.child);
  let settled = false;
  const first = owned.stop({graceMs: 500}).then(() => { settled = true; });
  const second = owned.stop({graceMs: 500});
  await tick();
  assert.equal(settled, false); assert.deepEqual(f.signals, ['SIGTERM']);
  f.child.emit('error', new Error('synthetic kill error')); await tick();
  assert.equal(settled, false);
  f.child.emit('exit', null, 'SIGTERM'); await Promise.all([first, second]);
  assert.equal(owned.stopped, true); assert.deepEqual(f.signals, ['SIGTERM']);
});

test('owned child escalation rechecks attribution before signalling the retained handle', async () => {
  const f = fixture(); const owned = watchOwnedChild(f.child);
  let checks = 0;
  f.child.kill = signal => {
    f.signals.push(String(signal));
    if (signal === 'SIGKILL') queueMicrotask(() => f.child.emit('exit', null, 'SIGKILL'));
    return true;
  };
  await owned.stop({graceMs: 5, verify: async () => { checks++; return true; }});
  assert.equal(checks, 2); assert.deepEqual(f.signals, ['SIGTERM', 'SIGKILL']); assert.equal(owned.stopped, true);
});

test('owned child lost attribution neither kills another process nor claims stop', async () => {
  const f = fixture(); const owned = watchOwnedChild(f.child); let checks = 0;
  await assert.rejects(owned.stop({graceMs: 5, verify: async () => ++checks === 1}),
    /^Error: owned_child_stop_unconfirmed$/);
  assert.deepEqual(f.signals, ['SIGTERM']); assert.equal(owned.stopped, false);
  assert.equal(f.child.listenerCount('exit'), 1);
  f.child.emit('exit', null, 'SIGTERM'); await owned.exited;
});

test('owned child attribution error stays sanitized and preserves live-child observation', async () => {
  const f = fixture(); const owned = watchOwnedChild(f.child);
  await assert.rejects(owned.stop({verify: async () => { throw new Error('PRIVATE_CANARY'); }}),
    /^Error: owned_child_stop_unconfirmed$/);
  assert.deepEqual(f.signals, []); assert.equal(owned.stopped, false);
  f.child.emit('exit', 0, null); await owned.exited;
});

test('owned child timeout retains uncertainty instead of deleting the exit listener', async () => {
  const f = fixture(); const owned = watchOwnedChild(f.child);
  f.child.kill = signal => {
    f.signals.push(String(signal)); f.child.emit('error', new Error('PRIVATE_CANARY')); return false;
  };
  await assert.rejects(owned.stop({graceMs: 5}), /^Error: owned_child_stop_unconfirmed$/);
  assert.equal(owned.stopped, false); assert.deepEqual(f.signals, ['SIGTERM', 'SIGKILL']);
  assert.equal(f.child.listenerCount('exit'), 1);
  f.child.emit('exit', 0, null); await owned.exited; assert.equal(owned.stopped, true);
});

test('owned child already terminal requires no signal or attribution lookup', async () => {
  const f = fixture(); Object.assign(f.child, {exitCode: 0});
  const owned = watchOwnedChild(f.child);
  await owned.stop({verify: async () => { throw new Error('must not inspect'); }});
  assert.equal(owned.stopped, true); assert.deepEqual(f.signals, []);
});

test('owned child cancellation drains a real C-only spawned process', async () => {
  const child = spawn(process.execPath, ['-e', 'console.log("ready"); setInterval(() => {}, 1000)'],
    {stdio: ['ignore', 'pipe', 'ignore']});
  const owned = watchOwnedChild(child);
  try {
    await new Promise<void>((resolveReady, reject) => {
      const timer = setTimeout(() => reject(new Error('fixture readiness timeout')), 5000);
      child.stdout!.once('data', () => { clearTimeout(timer); resolveReady(); });
      child.once('error', error => { clearTimeout(timer); reject(error); });
    });
    assert.equal(owned.stopped, false);
    await owned.stop({graceMs: 1000});
    assert.equal(owned.stopped, true);
    assert.ok(child.exitCode !== null || child.signalCode !== null);
  } finally { await owned.stop({graceMs: 1000}); }
});
