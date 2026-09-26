import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { runDemoSupervisor, type DemoWatchObservation } from './demoSupervisor.js';
import type { DemoWatchRegistration } from './demoWatchRegistry.js';

function registration(index = 0): DemoWatchRegistration {
  return { schema: 'dharma.demo-watch/v1', hqUrl: 'https://example.com',
    organizationId: 'org_test', repositoryId: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
    normalizedRepository: `github.com/example/repo${index}`, provider: 'codex', workspace: `/tmp/repo${index}` };
}

test('supervisor records bounded package observations without private payloads', async () => {
  const observations: DemoWatchObservation[] = [];
  const result = await runDemoSupervisor({ once: true, list: async () => [registration()],
    cycle: async () => ({ stage: 'installed', sourceSync: { state: 'unchanged' }, secret: 'private' }),
    onObservation: value => observations.push(value) });
  assert.equal(result.completed, 1);
  assert.equal(result.failures, 0);
  assert.equal(observations[0]!.state, 'completed');
  assert.equal(observations[0]!.sourceState, 'unchanged');
  assert.equal(JSON.stringify(observations).includes('private'), false);
});

test('concurrency is bounded and later scopes are not starved', async () => {
  const controller = new AbortController();
  const started: number[] = [];
  let active = 0;
  let maximum = 0;
  let pulses = 0;
  await runDemoSupervisor({ signal: controller.signal, concurrency: 2,
    list: async () => Array.from({ length: 5 }, (_, index) => registration(index)),
    cycle: async row => {
      started.push(Number(row.repositoryId.slice(-12)));
      active += 1; maximum = Math.max(maximum, active);
      await delay(1); active -= 1;
      return { stage: 'installed' };
    },
    wait: async () => { await delay(5); if (++pulses === 3) controller.abort(); } });
  assert.equal(maximum, 2);
  assert.deepEqual(started.slice(0, 5), [0, 1, 2, 3, 4]);
});

test('timeout aborts the cycle and late completion cannot erase its receipt or overlap', async () => {
  const controller = new AbortController();
  const observations: DemoWatchObservation[] = [];
  let finish!: (value: { stage: string }) => void;
  let cycleSignal!: AbortSignal;
  let starts = 0;
  let pulses = 0;
  const result = await runDemoSupervisor({ signal: controller.signal, cycleTimeoutMs: 5,
    list: async () => [registration()], cycle: async (_row, signal) => {
      starts += 1; cycleSignal = signal;
      return new Promise(resolve => { finish = resolve; });
    }, onObservation: value => observations.push(value),
    wait: async () => {
      await delay(15);
      if (++pulses === 2) { finish({ stage: 'late_success' }); controller.abort(); }
    } });
  await delay(0);
  assert.equal(starts, 1);
  assert.equal(cycleSignal.aborted, true);
  assert.equal(result.failures, 1);
  assert.deepEqual(observations.map(value => value.state), ['timed_out']);
  assert.equal(JSON.stringify(observations).includes('late_success'), false);
});

test('removal cancels an in-flight cycle without publishing its late result', async () => {
  const controller = new AbortController();
  const observations: DemoWatchObservation[] = [];
  let lists = 0;
  let finish!: (value: { stage: string }) => void;
  let cycleSignal!: AbortSignal;
  await runDemoSupervisor({ signal: controller.signal,
    list: async () => ++lists === 1 ? [registration()] : [],
    cycle: async (_row, signal) => { cycleSignal = signal; return new Promise(resolve => { finish = resolve; }); },
    onObservation: value => observations.push(value),
    wait: async () => {
      if (lists === 2) { finish({ stage: 'removed_success' }); controller.abort(); }
      await delay(0);
    } });
  assert.equal(cycleSignal.aborted, true);
  assert.deepEqual(observations, []);
});

test('a changed registration cancels old work and does not overlap it', async () => {
  const controller = new AbortController();
  let lists = 0;
  let starts = 0;
  let oldSignal!: AbortSignal;
  await runDemoSupervisor({ signal: controller.signal,
    list: async () => [{ ...registration(), workspace: ++lists === 1 ? '/tmp/repo0' : '/tmp/other' }],
    cycle: async (_row, signal) => { starts += 1; oldSignal = signal; return new Promise(() => {}); },
    wait: async () => { if (lists === 2) controller.abort(); await delay(0); } });
  assert.equal(oldSignal.aborted, true);
  assert.equal(starts, 1);
});

test('corrupted registry cancels work and reports no raw error', async () => {
  const controller = new AbortController();
  const observations: DemoWatchObservation[] = [];
  let lists = 0;
  let cycleSignal!: AbortSignal;
  const result = await runDemoSupervisor({ signal: controller.signal,
    list: async () => { if (++lists === 2) throw new Error('private registry contents'); return [registration()]; },
    cycle: async (_row, signal) => { cycleSignal = signal; return new Promise(() => {}); },
    onObservation: value => observations.push(value),
    wait: async () => { if (lists === 2) controller.abort(); await delay(0); } });
  assert.equal(cycleSignal.aborted, true);
  assert.equal(result.failures, 1);
  assert.equal(observations[0]!.code, 'demo_watch_registry_invalid');
  assert.equal(JSON.stringify(observations).includes('private'), false);
});

test('shutdown does not wait forever for a non-cooperative provider', async () => {
  const controller = new AbortController();
  let cycleSignal!: AbortSignal;
  await runDemoSupervisor({ signal: controller.signal, list: async () => [registration()],
    cycle: async (_row, signal) => { cycleSignal = signal; return new Promise(() => {}); },
    wait: async () => { controller.abort(); } });
  assert.equal(cycleSignal.aborted, true);
});

test('invalid options and duplicate scopes fail before dispatch', async () => {
  let starts = 0;
  const input = { once: true, list: async () => [registration(), registration()],
    cycle: async () => { starts += 1; return { stage: 'unused' }; } };
  const result = await runDemoSupervisor(input);
  assert.equal(result.failures, 1);
  assert.equal(starts, 0);
  await assert.rejects(runDemoSupervisor({ ...input, concurrency: 33 }), /concurrency/);
  await assert.rejects(runDemoSupervisor({ ...input, intervalMs: 0 }), /interval/);
  await assert.rejects(runDemoSupervisor({ ...input, cycleTimeoutMs: 0 }), /timeout/);
});

test('an invalid cycle receipt cannot count as a completed package check', async () => {
  const observations: DemoWatchObservation[] = [];
  const result = await runDemoSupervisor({ once: true, list: async () => [registration()],
    cycle: async () => ({ stage: 'private payload with credentials' }),
    onObservation: value => observations.push(value) });
  assert.equal(result.completed, 0);
  assert.equal(result.failures, 1);
  assert.equal(observations[0]!.code, 'demo_watch_receipt_invalid');
  assert.equal(JSON.stringify(observations).includes('credentials'), false);
});

test('a failed status sink cancels work and rejects without an unhandled private exception', async () => {
  await assert.rejects(runDemoSupervisor({ once: true, list: async () => [registration()],
    cycle: async () => ({ stage: 'installed' }),
    onObservation: () => { throw new Error('private logging details'); } }),
  /^Error: Demo supervisor observation sink failed\.$/);
});
