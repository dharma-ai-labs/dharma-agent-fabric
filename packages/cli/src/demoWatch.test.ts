import assert from 'node:assert/strict';
import test from 'node:test';
import { runDemoWatch } from './demoWatch.js';

test('one watch cycle reports the package and source states', async () => {
  const result = await runDemoWatch({ once: true,
    cycle: async () => ({ stage: 'demo_repository_package_installed',
      sourceSync: { state: 'debouncing' } }) });
  assert.deepEqual(result, { ok: true, stage: 'demo_watch_stopped',
    cycles: 1, failures: 0, lastStage: 'demo_repository_package_installed',
    lastSourceState: 'debouncing', lastFailureCode: null });
});

test('watch failure reports only a bounded code and releases the cycle', async () => {
  const failures: string[] = [];
  const result = await runDemoWatch({ once: true,
    cycle: async () => { throw new Error('private source content'); },
    onFailure: code => failures.push(code) });
  assert.equal(result.cycles, 0);
  assert.equal(result.failures, 1);
  assert.equal(result.lastFailureCode, 'demo_watch_cycle_failed');
  assert.deepEqual(failures, ['demo_watch_cycle_failed']);
  assert.equal(JSON.stringify(result).includes('private source content'), false);
});

test('abort stops a long-running watch after its first cycle', async () => {
  const controller = new AbortController();
  const result = await runDemoWatch({ signal: controller.signal,
    cycle: async () => ({ stage: 'demo_repository_package_installed' }),
    onCycle: () => controller.abort() });
  assert.equal(result.cycles, 1);
});

test('rejects an unsafe polling interval', async () => {
  await assert.rejects(runDemoWatch({ intervalMs: 1_000,
    cycle: async () => ({ stage: 'unused' }) }), /interval/);
});
