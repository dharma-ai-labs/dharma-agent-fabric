import assert from 'node:assert/strict';
import test from 'node:test';
import { waitForRepositoryReadiness, type RepositoryReadinessObservation } from './repositoryReadinessWait.js';

const observation = (state: RepositoryReadinessObservation['state'], ready = false): RepositoryReadinessObservation => ({
  state, ready, candidateId: 'candidate-1',
});

test('waits for the installed release rather than a published candidate alone', async () => {
  const states = [observation('accepted'), observation('published'), observation('published', true)];
  let clock = 0;
  const result = await waitForRepositoryReadiness(async () => states.shift()!, {
    maximumWaitMs: 15_000, intervalMs: 5_000, now: () => clock,
    wait: async delayMs => { clock += delayMs; },
  });
  assert.deepEqual(result, { ...observation('published', true), outcome: 'ready', attempts: 3 });
  assert.equal(clock, 10_000);
});

test('stops on a blocked publication without waiting to the deadline', async () => {
  const result = await waitForRepositoryReadiness(async () => observation('blocked'), {
    wait: async () => { throw new Error('must not wait'); },
  });
  assert.equal(result.outcome, 'blocked');
  assert.equal(result.attempts, 1);
});

test('returns the last pending state at the fixed deadline', async () => {
  let clock = 0;
  const result = await waitForRepositoryReadiness(async () => observation('processing'), {
    maximumWaitMs: 11_000, intervalMs: 5_000, now: () => clock,
    wait: async delayMs => { clock += delayMs; },
  });
  assert.equal(result.outcome, 'pending');
  assert.equal(result.attempts, 4);
  assert.equal(clock, 11_000);
});

test('observes once when waiting is disabled and rejects invalid bounds', async () => {
  const result = await waitForRepositoryReadiness(async () => observation('absent'), { maximumWaitMs: 0 });
  assert.equal(result.attempts, 1);
  assert.equal(result.outcome, 'pending');
  await assert.rejects(waitForRepositoryReadiness(async () => observation('absent'), { intervalMs: 0 }), /Invalid/);
});

// G11 (2026-11-02, correlation 0e7f1918): the member saw nothing for 300 s while the
// wait polled 59 times. Each pending observation is now reported so setup can show it.
test('reports each pending observation with elapsed time before waiting again', async () => {
  let clock = 0;
  const progress: unknown[] = [];
  const result = await waitForRepositoryReadiness(async () => observation('published'), {
    maximumWaitMs: 10_000, intervalMs: 5_000, now: () => clock,
    wait: async delayMs => { clock += delayMs; },
    onProgress: update => { progress.push(update); },
  });
  assert.equal(result.outcome, 'pending');
  assert.deepEqual(progress, [
    { ...observation('published'), attempts: 1, elapsedMs: 0, maximumWaitMs: 10_000 },
    { ...observation('published'), attempts: 2, elapsedMs: 5_000, maximumWaitMs: 10_000 },
  ]);
});

// G11 F14 (2026-11-06): 58 attempts ended with a bare pending and no error code. The wait now
// asks for the relay's recorded reason once, at the deadline, and returns it with the result.
test('returns the recorded reason with a pending result at the deadline', async () => {
  let clock = 0;
  let explained = 0;
  const result = await waitForRepositoryReadiness(async () => observation('published'), {
    maximumWaitMs: 10_000, intervalMs: 5_000, now: () => clock,
    wait: async delayMs => { clock += delayMs; },
    explainPending: async () => { explained += 1; return 'repository_package_access_denied'; },
  });
  assert.deepEqual(result, { ...observation('published'), outcome: 'pending', attempts: 3,
    code: 'repository_package_access_denied' });
  assert.equal(explained, 1);
});

test('does not ask for a reason when the package becomes ready or blocked', async () => {
  for (const observed of [observation('published', true), observation('blocked')]) {
    const result = await waitForRepositoryReadiness(async () => observed, {
      explainPending: async () => { throw new Error('must not explain'); },
    });
    assert.equal(Object.hasOwn(result, 'code'), false);
  }
});

test('a failed reason lookup leaves the pending result unchanged', async () => {
  const result = await waitForRepositoryReadiness(async () => observation('absent'), {
    maximumWaitMs: 0, explainPending: async () => { throw new Error('unreadable'); },
  });
  assert.deepEqual(result, { ...observation('absent'), outcome: 'pending', attempts: 1 });
});
