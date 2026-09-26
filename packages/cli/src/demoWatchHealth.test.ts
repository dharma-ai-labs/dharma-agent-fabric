import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createDemoWatchHealthRecorder, readDemoWatchHealth, writeDemoWatchHealth, type DemoWatchHealth } from './demoWatchHealth.js';

const key = 'a'.repeat(64);
const now = Date.parse('2026-09-26T03:00:00.000Z');
const receipt: DemoWatchHealth = { schema: 'dharma.demo-watch-health/v1', key, pid: 123,
  version: '0.2.103', observedAt: new Date(now).toISOString(), state: 'completed',
  stage: 'demo_repository_package_installed', sourceState: 'unchanged', code: null };

test('health recorder serializes writes, coalesces pending scopes and drains before lease release', async () => {
  const rows: DemoWatchHealth[] = [];
  let finish!: () => void;
  let concurrent = 0;
  let maximum = 0;
  const recorder = createDemoWatchHealthRecorder({ home: '/unused', pid: 123, version: '0.2.103',
    now: () => now, write: async (_home, row) => {
      maximum = Math.max(maximum, ++concurrent);
      if (!rows.length) await new Promise<void>(resolve => { finish = resolve; });
      rows.push(row); concurrent -= 1;
    } });
  recorder.record(receipt);
  await new Promise(resolve => setImmediate(resolve));
  recorder.record({ ...receipt, key: 'b'.repeat(64), sourceState: 'pending' });
  recorder.record({ ...receipt, key: 'b'.repeat(64), sourceState: 'unchanged' });
  let drained = false;
  const drain = recorder.drain().then(() => { drained = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(drained, false);
  finish(); await drain;
  assert.equal(maximum, 1);
  assert.equal(rows.length, 2);
  assert.equal(rows[1]?.sourceState, 'unchanged');
  assert.equal(recorder.available(), true);
});

test('a receipt arriving while the writer closes is drained rather than stranded', async () => {
  const rows: DemoWatchHealth[] = [];
  const recorder = createDemoWatchHealthRecorder({ home: '/unused', pid: 123, version: '0.2.103',
    now: () => now, write: async (_home, row) => {
      rows.push(row);
      if (rows.length === 1) queueMicrotask(() => queueMicrotask(() => {
        recorder.record({ ...receipt, key: 'b'.repeat(64) });
      }));
    } });
  recorder.record(receipt);
  await recorder.drain();
  assert.equal(rows.length, 2);
  assert.equal(rows[1]?.key, 'b'.repeat(64));
});

test('health write failure gates cycles and a later recorded observation restores the gate', async () => {
  let fail = true;
  const recorder = createDemoWatchHealthRecorder({ home: '/unused', pid: 123, version: '0.2.103',
    now: () => now, write: async () => { if (fail) throw new Error('private filesystem error'); } });
  recorder.record(receipt);
  await recorder.drain();
  assert.equal(recorder.available(), false);
  fail = false;
  recorder.record({ ...receipt, state: 'failed', stage: null, sourceState: null, code: 'demo_watch_health_unavailable' });
  await recorder.drain();
  assert.equal(recorder.available(), true);
});

test('success on another repository cannot clear a failed scope receipt', async () => {
  let fail = true;
  const otherKey = 'b'.repeat(64);
  const recorder = createDemoWatchHealthRecorder({ home: '/unused', pid: 123, version: '0.2.103',
    now: () => now, write: async (_home, row) => {
      if (row.key === key && fail) throw new Error('Single-scope write failed');
    } });
  recorder.record(receipt); await recorder.drain();
  recorder.record({ ...receipt, key: otherKey }); await recorder.drain();
  assert.equal(recorder.available(), false);
  assert.equal(recorder.available(key), false);
  assert.equal(recorder.available(otherKey), true);
  fail = false;
  recorder.record(receipt); await recorder.drain();
  assert.equal(recorder.available(key), true);
  assert.equal(recorder.available(), true);
});

test('health recorder rejects malformed observations and ignores unscoped registry failures', async () => {
  let writes = 0;
  const recorder = createDemoWatchHealthRecorder({ home: '/unused', pid: 123, version: '0.2.103',
    now: () => now, write: async () => { writes += 1; } });
  recorder.record({ ...receipt, key: null });
  recorder.record({ ...receipt, key: 'bad-key' });
  await recorder.drain();
  assert.equal(writes, 0);
  assert.equal(recorder.available(), false);
});

async function fixture() {
  const home = await mkdtemp(join(tmpdir(), 'dharma-demo-watch-health-'));
  await mkdir(join(home, 'relay'));
  await writeFile(join(home, 'relay', 'supervisor.pid'), '123\n');
  return home;
}

test('health is credential-free and fresh only for its current supervisor/version', async () => {
  const home = await fixture();
  try {
    await writeDemoWatchHealth(home, receipt);
    assert.deepEqual(await readDemoWatchHealth(home, key, { pid: 123, version: '0.2.103', now }), receipt);
    assert.equal(await readDemoWatchHealth(home, key, { pid: 124, version: '0.2.103', now }), null);
    assert.equal(await readDemoWatchHealth(home, key, { pid: 123, version: '0.2.104', now }), null);
    assert.equal(await readDemoWatchHealth(home, key, { pid: 123, version: '0.2.103', now: now + 180_001 }), null);
    assert.equal(await readDemoWatchHealth(home, key, { pid: 123, version: '0.2.103', now: now - 10_000 }), null);
    const raw = await readFile(join(home, 'relay', 'demo-watch-health', `${key}.json`), 'utf8');
    assert.doesNotMatch(raw, /token|grant|password|workspace|email|Authorization/);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test('a departed supervisor cannot overwrite its successor receipt', async () => {
  const home = await fixture();
  try {
    await writeDemoWatchHealth(home, receipt);
    await writeFile(join(home, 'relay', 'supervisor.pid'), '124\n');
    const newer = { ...receipt, pid: 124, state: 'timed_out' as const,
      stage: null, sourceState: null, code: 'demo_watch_cycle_timeout' };
    await writeDemoWatchHealth(home, newer);
    await assert.rejects(writeDemoWatchHealth(home, receipt), /supervisor changed/);
    assert.deepEqual(await readDemoWatchHealth(home, key, { pid: 124, version: '0.2.103', now }), newer);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test('missing, malformed and foreign-key health cannot establish readiness', async () => {
  const home = await fixture();
  try {
    const expected = { pid: 123, version: '0.2.103', now };
    assert.equal(await readDemoWatchHealth(home, key, expected), null);
    await writeDemoWatchHealth(home, receipt);
    const path = join(home, 'relay', 'demo-watch-health', `${key}.json`);
    await writeFile(path, JSON.stringify({ ...receipt, key: 'b'.repeat(64) }));
    await assert.rejects(readDemoWatchHealth(home, key, expected), /invalid/);
    await writeFile(path, 'private malformed payload');
    await assert.rejects(readDemoWatchHealth(home, key, expected), /^Error: Demo watch health receipt is invalid\.$/);
    await assert.rejects(writeDemoWatchHealth(home, { ...receipt, grant: 'never-persist' } as DemoWatchHealth), /invalid/);
    await assert.rejects(writeDemoWatchHealth(home, { ...receipt, stage: 'private content' }), /invalid/);
    await assert.rejects(writeDemoWatchHealth(home, { ...receipt, code: 'failure_on_completed' }), /invalid/);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test('health never follows directory or leaf symlinks', { skip: process.platform === 'win32' }, async () => {
  const home = await fixture();
  const outside = await mkdtemp(join(tmpdir(), 'dharma-demo-watch-health-outside-'));
  try {
    await symlink(outside, join(home, 'relay', 'demo-watch-health'));
    await assert.rejects(writeDemoWatchHealth(home, receipt), /symlink/);
    await rm(join(home, 'relay', 'demo-watch-health'));
    await mkdir(join(home, 'relay', 'demo-watch-health'));
    const target = join(outside, 'preserve.json');
    await writeFile(target, JSON.stringify(receipt));
    await symlink(target, join(home, 'relay', 'demo-watch-health', `${key}.json`));
    await assert.rejects(readDemoWatchHealth(home, key, { pid: 123, version: '0.2.103', now }), /symlink/);
    await assert.rejects(writeDemoWatchHealth(home, receipt), /symlink/);
    assert.equal(await readFile(target, 'utf8'), JSON.stringify(receipt));
  } finally { await rm(home, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }); }
});
