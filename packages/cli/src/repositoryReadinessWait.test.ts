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
