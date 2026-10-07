import assert from 'node:assert/strict';
import {execFile, spawn, type ChildProcess} from 'node:child_process';
import {EventEmitter, once} from 'node:events';
import {PassThrough} from 'node:stream';
import test from 'node:test';
import {promisify} from 'node:util';
import {isNamedSessionStartupFailure, observeNamedSessionStartupChild} from './namedSessionStartupChild.js';

function fixture() {
  const child = Object.assign(new EventEmitter(), {stderr: new PassThrough()});
  return {child, observed: observeNamedSessionStartupChild(child as unknown as ChildProcess)};
}

test('real owned subprocess classifies an exact fixed startup error without exposing raw stderr', async () => {
  const child = spawn(process.execPath, ['-e', 'process.stderr.write("setup_child_unavailable\\n");process.exitCode=2'],
    {stdio: ['ignore', 'ignore', 'pipe']});
  const observed = observeNamedSessionStartupChild(child);
  try {
    await once(child, 'close');
    assert.equal(observed.readFailure(), 'named_session_startup_setup_child_unavailable');
    assert.deepEqual(Object.keys(observed).sort(), ['dispose', 'readFailure']);
  } finally {observed.dispose();}
});

for (const content of ['password=secret-placeholder', 'setup_child_unavailable secret-placeholder',
  'x'.repeat(4097) + '\nsetup_child_unavailable', '\u0000setup_child_unavailable']) {
  test(`private or oversized stderr is withheld (${content.length} bytes)`, () => {
    const f = fixture();
    f.child.stderr.write(content); f.child.emit('close', 2);
    assert.equal(f.observed.readFailure(), 'named_session_startup_child_failed');
    assert.equal(JSON.stringify(f.observed).includes('secret-placeholder'), false);f.observed.dispose();
  });
}

test('a live child is never declared stopped from stderr alone', () => {
  const f = fixture();f.child.stderr.write('setup_child_unavailable\n');
  assert.equal(f.observed.readFailure(), undefined);f.observed.dispose();
});

test('clean exit before readiness and spawn error have distinct fixed categories', () => {
  const a = fixture();a.child.emit('close', 0);assert.equal(a.observed.readFailure(), 'named_session_startup_child_exited');a.observed.dispose();
  const b = fixture();b.child.emit('error', new Error('secret-placeholder'));b.child.emit('close', -1);
  assert.equal(b.observed.readFailure(), 'named_session_startup_child_spawn_failed');b.observed.dispose();
});

test('disposal removes only these listeners and drains without collecting subsequent output', () => {
  const f = fixture();const sibling = () => {};f.child.on('close', sibling);
  f.observed.dispose();f.observed.dispose();f.child.stderr.write('setup_child_unavailable\n');f.child.emit('close', 2);
  assert.equal(f.observed.readFailure(), undefined);assert.deepEqual(f.child.listeners('close'), [sibling]);
  assert.equal(f.child.stderr.listenerCount('data'), 0);
});

test('only exact fixed diagnostic codes qualify; private strings are rejected', () => {
  assert.equal(isNamedSessionStartupFailure('named_session_startup_child_failed'), true);
  for (const value of ['secret-placeholder', 'named_session_startup_child_failed\nsecret', {}, null]) assert.equal(isNamedSessionStartupFailure(value), false);
});

test('disposing a live detached worker pipe lets the original launcher exit normally', async () => {
  const moduleUrl = new URL('./namedSessionStartupChild.js', import.meta.url).href;
  const source = `import {spawn} from 'node:child_process';
    import {observeNamedSessionStartupChild} from ${JSON.stringify(moduleUrl)};
    const child=spawn(process.execPath,['-e','setTimeout(()=>{},5000)'],{detached:true,stdio:['ignore','ignore','pipe']});
    process.once('SIGTERM',()=>{child.kill('SIGTERM');process.exitCode=1;});
    const observed=observeNamedSessionStartupChild(child);observed.dispose();child.unref();
    console.log('startup_observation_disposed');`;
  const result = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', source], {timeout: 2000});
  assert.equal(result.stdout.trim(), 'startup_observation_disposed');
});
