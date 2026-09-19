import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { prepareProvidersIndependently, startSkillPreparationPump } from './skillPreparationPump.js';

test('independent preparation continues while a separate task is pending', async () => {
  let count = 0;
  let completeTask!: () => void;
  const task = new Promise<void>(resolve => { completeTask = resolve; });
  const pump = startSkillPreparationPump({ intervalMs: 5, prepare: async check => { check(); count++; } });
  try {
    await sleep(40);
    assert.ok(count >= 2);
    completeTask();
    await task;
  } finally { await pump.stop(); }
});

test('single-flight ownership is retained until a blocked preparation settles', async () => {
  let count = 0;
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const pump = startSkillPreparationPump({ intervalMs: 2, prepare: async () => { count++; await blocked; } });
  await sleep(25);
  assert.equal(count, 1);
  assert.equal(pump.running, true);
  let closed = false;
  const closing = pump.stop().then(() => { closed = true; });
  await sleep(15);
  assert.equal(closed, false);
  assert.equal(count, 1);
  release();
  await closing;
  assert.equal(pump.running, false);
});

test('signal-shaped stop prevents post-await publication and future cycles', async () => {
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  let started = 0, published = 0, errors = 0;
  const pump = startSkillPreparationPump({ intervalMs: 2, onError: () => { errors++; },
    prepare: async check => { started++; await blocked; check(); published++; } });
  await sleep(10);
  pump.requestStop();
  release();
  await pump.stop();
  await sleep(15);
  assert.equal(started, 1);
  assert.equal(published, 0);
  assert.equal(errors, 0);
});

test('a failed preparation releases ownership for a later retry', async () => {
  let count = 0, errors = 0;
  const pump = startSkillPreparationPump({ intervalMs: 5, onError: () => { errors++; },
    prepare: async () => { count++; if (count === 1) throw new Error('fixture'); } });
  try { await sleep(30); assert.ok(count >= 2); assert.equal(errors, 1); }
  finally { await pump.stop(); }
});

test('first provider failure cannot starve a later authorized provider', async () => {
  const calls: string[] = [], failures: string[] = [];
  await prepareProvidersIndependently(['codex', 'claude'], () => {}, async provider => {
    calls.push(provider); if (provider === 'codex') throw new Error('denied fixture');
  }, provider => { failures.push(provider); });
  assert.deepEqual(calls, ['codex', 'claude']);
  assert.deepEqual(failures, ['codex']);
});

test('stop during a provider failure prevents subsequent provider work', async () => {
  const calls: string[] = [];
  let stopped = false;
  await assert.rejects(() => prepareProvidersIndependently(['codex', 'claude'],
    () => { if (stopped) throw new Error('stopped'); }, async provider => {
      calls.push(provider); stopped = true; throw new Error('fixture');
    }, () => { throw new Error('Should not report a stopped cycle.'); }), /stopped/);
  assert.deepEqual(calls, ['codex']);
});
