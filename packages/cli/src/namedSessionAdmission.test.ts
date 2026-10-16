import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import test from 'node:test';
import {NamedSessionAdmission} from './namedSessionAdmission.js';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return {promise, resolve};
}

test('quiesce fences new local and peer work synchronously and drains admitted work without cancellation', async () => {
  const admission = new NamedSessionAdmission(), started = deferred(), finish = deferred();
  let completed = false, lateRuns = 0;
  const work = admission.enqueue(async () => {started.resolve(); await finish.promise; completed = true;});
  await started.promise;
  const fenceId = randomUUID(), generation = admission.snapshot().generation;
  let drained = false;
  const quiesce = admission.quiesce(fenceId, generation).then(receipt => {drained = true; return receipt;});
  assert.equal(admission.snapshot().state, 'draining');
  await assert.rejects(admission.enqueue(async () => {lateRuns++;}), /named_session_quiesced/);
  await assert.rejects(admission.enqueue(async () => {lateRuns++;}), /named_session_quiesced/);
  assert.equal(drained, false); assert.equal(completed, false); assert.equal(lateRuns, 0);
  assert.throws(() => admission.stopDrained(fenceId, generation), /named_session_not_drained/);
  assert.throws(() => admission.resume(fenceId, generation), /named_session_not_drained/);
  finish.resolve(); await work;
  assert.deepEqual(await quiesce, {generation, fenceId, state:'quiesced', pending:0});
  assert.equal(completed, true); assert.equal(lateRuns, 0);
  admission.stopDrained(fenceId, generation);
  await assert.rejects(admission.enqueue(async () => {lateRuns++;}), /named_session_stopped/);
  assert.equal(lateRuns, 0);
});

test('quiesce drains queued admitted work and preserves a failed operation without replay', async () => {
  const admission = new NamedSessionAdmission(), first = deferred(), started = deferred();
  const runs: string[] = [];
  const work = admission.enqueue(async () => {runs.push('first'); started.resolve(); await first.promise;});
  await started.promise;
  const failed = admission.enqueue(async () => {runs.push('failed'); throw Error('expected-failure');});
  const failure = assert.rejects(failed, /expected-failure/);
  const final = admission.enqueue(async () => {runs.push('final');});
  const fenceId = randomUUID(), generation = admission.snapshot().generation;
  const quiesce = admission.quiesce(fenceId, generation);
  first.resolve(); await Promise.all([work, failure, final, quiesce]);
  assert.deepEqual(runs, ['first', 'failed', 'final']);
  assert.equal(admission.snapshot().pending, 0);
  admission.resume(fenceId, generation);
  await admission.enqueue(async () => {runs.push('resumed');});
  assert.deepEqual(runs, ['first', 'failed', 'final', 'resumed']);
});

test('fences are generation-bound, idempotent and cannot be displaced or silently expired', async () => {
  const admission = new NamedSessionAdmission(), fenceId = randomUUID(), generation = admission.snapshot().generation;
  const first = await admission.quiesce(fenceId, generation);
  assert.deepEqual(await admission.quiesce(fenceId, generation), first);
  await assert.rejects(admission.quiesce(randomUUID(), generation), /named_session_fence_conflict/);
  await assert.rejects(admission.quiesce(fenceId, randomUUID()), /named_session_generation_changed/);
  assert.throws(() => admission.resume(randomUUID(), generation), /named_session_fence_conflict/);
  assert.throws(() => admission.stopDrained(fenceId, randomUUID()), /named_session_generation_changed/);
  assert.throws(() => admission.stop(), /named_session_fence_required/);
  assert.equal(admission.snapshot().state, 'quiesced');
  admission.resume(fenceId, generation);
  assert.equal(admission.snapshot().state, 'open');
  assert.throws(() => admission.stopDrained(fenceId, generation), /named_session_fence_conflict/);
  const replacement = new NamedSessionAdmission();
  assert.notEqual(replacement.snapshot().generation, generation);
  assert.throws(() => replacement.stopDrained(fenceId, generation), /named_session_generation_changed/);
});

test('invalid fence input and queue overflow have no admission effect', async () => {
  const admission = new NamedSessionAdmission(), hold = deferred();
  const generation = admission.snapshot().generation;
  for (const value of ['', '../foreign', 'private-fixture', randomUUID()+'\n']) {
    await assert.rejects(admission.quiesce(value, generation), /named_session_fence_invalid/);
    assert.equal(admission.snapshot().state, 'open');
  }
  const pending = Array.from({length:8}, () => admission.enqueue(() => hold.promise));
  await assert.rejects(admission.enqueue(async () => {}), /named_session_busy/);
  assert.equal(admission.snapshot().pending, 8);
  hold.resolve(); await Promise.all(pending);
  assert.equal(admission.snapshot().pending, 0);
});

test('the drained receipt waits for final evidence/health settlement, not merely provider return', async () => {
  const admission = new NamedSessionAdmission(), settlement = deferred(), settling = deferred();
  const work = admission.enqueue(async () => 'completed', async () => {settling.resolve(); await settlement.promise;});
  await settling.promise;
  const fenceId = randomUUID(), generation = admission.snapshot().generation;
  let drained = false;
  const quiesce = admission.quiesce(fenceId, generation).then(value => {drained = true; return value;});
  await Promise.resolve(); assert.equal(drained, false);
  assert.throws(() => admission.stopDrained(fenceId, generation), /named_session_not_drained/);
  settlement.resolve(); assert.equal(await work, 'completed'); await quiesce;
  admission.stopDrained(fenceId, generation);
});
