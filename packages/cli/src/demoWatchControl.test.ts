import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { disableDemoWatch, enableDemoWatch, demoWatchStatus, inspectDemoWatchSupervisor,
  type DemoWatchControlDependencies, type DemoWatchSupervisor } from './demoWatchControl.js';
import { demoWatchRegistrationKey, listDemoWatchRegistrations, registerDemoWatch,
  type DemoWatchRegistration } from './demoWatchRegistry.js';
import { writeDemoWatchHealth } from './demoWatchHealth.js';

async function fixture() {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'dharma-watch-control-')));
  const workspace = join(home, 'workspace');
  await mkdir(workspace);
  const registration: DemoWatchRegistration = { schema: 'dharma.demo-watch/v1', hqUrl: 'https://example.com',
    organizationId: 'org_test', repositoryId: '00000000-0000-4000-8000-000000000001',
    normalizedRepository: 'github.com/example/repo', provider: 'codex', workspace };
  const input = { home, registration, version: '0.2.103' };
  let state: DemoWatchSupervisor = { state: 'stopped', pid: null };
  const calls: string[] = [];
  let tail: Promise<unknown> = Promise.resolve();
  const deps: DemoWatchControlDependencies = {
    verify: async () => { calls.push('verify'); },
    prepareStartup: async () => { calls.push('prepare'); },
    start: async () => { calls.push('start'); state = { state: 'running', pid: 123 }; },
    supervisor: async () => state,
    autostart: async () => 'enabled', wait: async () => {},
    exclusive: operation => {
      const result = tail.then(operation); tail = result.catch(() => {}); return result;
    },
  };
  return { input, deps, calls, setSupervisor: (value: DemoWatchSupervisor) => { state = value; },
    cleanup: () => rm(home, { recursive: true, force: true }) };
}

test('enable verifies enrollment, registers one scope and starts only one shared supervisor', async () => {
  const f = await fixture();
  try {
    const first = await enableDemoWatch(f.input, f.deps);
    assert.equal(first.registered, true);
    assert.equal(first.supervisor, 'running');
    assert.equal(first.stage, 'demo_watch_pending');
    assert.equal(first.fullWorkflowReady, false);
    await enableDemoWatch(f.input, f.deps);
    assert.equal(f.calls.filter(value => value === 'start').length, 1);
    assert.equal((await listDemoWatchRegistrations(f.input.home)).length, 1);
    assert.deepEqual(f.calls.slice(0, 3), ['verify', 'prepare', 'start']);
    assert.doesNotMatch(JSON.stringify(first), /workspace|grant|credential|email|configPath/);
  } finally { await f.cleanup(); }
});

test('dry-run and rejected authorization do not create a registry or startup entry', async () => {
  const f = await fixture();
  try {
    assert.equal((await enableDemoWatch({ ...f.input, dryRun: true }, f.deps)).stage, 'demo_watch_plan');
    assert.deepEqual(f.calls, []);
    f.deps.verify = async () => { throw Object.assign(new Error('private secret'), { code: 'demo_fabric_device_revoked' }); };
    await assert.rejects(enableDemoWatch(f.input, f.deps), /demo_fabric_device_revoked/);
    assert.deepEqual(await listDemoWatchRegistrations(f.input.home), []);
    assert.deepEqual(f.calls, []);
  } finally { await f.cleanup(); }
});

test('ten concurrent enable requests converge without ten service starts', async () => {
  const f = await fixture();
  try {
    await Promise.all(Array.from({ length: 10 }, () => enableDemoWatch(f.input, f.deps)));
    assert.equal((await listDemoWatchRegistrations(f.input.home)).length, 1);
    assert.equal(f.calls.filter(value => value === 'start').length, 1);
  } finally { await f.cleanup(); }
});

test('startup failure preserves the registered scope for a grant-free retry', async () => {
  const f = await fixture();
  try {
    const start = f.deps.start;
    f.deps.start = async () => { throw new Error('private service details'); };
    await assert.rejects(enableDemoWatch(f.input, f.deps), /^Error: demo_watch_start_failed:/);
    assert.equal((await listDemoWatchRegistrations(f.input.home)).length, 1);
    f.deps.start = start;
    assert.equal((await enableDemoWatch(f.input, f.deps)).supervisor, 'running');
  } finally { await f.cleanup(); }
});

test('an incompatible or unknown active supervisor is not killed or replaced', async () => {
  const f = await fixture();
  try {
    for (const state of ['version_mismatch', 'legacy', 'unknown'] as const) {
      f.setSupervisor({ state, pid: 123 });
      await assert.rejects(enableDemoWatch(f.input, f.deps), /demo_watch_supervisor_conflict/);
      assert.equal((await listDemoWatchRegistrations(f.input.home)).length, 0);
      assert.equal(f.calls.includes('prepare'), false);
      assert.equal(f.calls.includes('start'), false);
    }
  } finally { await f.cleanup(); }
});

test('status uses only a current scoped observation and never equates a cycle with full readiness', async () => {
  const f = await fixture();
  try {
    await enableDemoWatch(f.input, f.deps);
    await writeFile(join(f.input.home, 'relay', 'supervisor.pid'), '123\n');
    await writeDemoWatchHealth(f.input.home, { schema: 'dharma.demo-watch-health/v1',
      key: demoWatchRegistrationKey(f.input.registration), pid: 123, version: f.input.version,
      observedAt: new Date().toISOString(), state: 'completed', stage: 'demo_repository_package_installed',
      sourceState: 'unchanged', code: null });
    const observed = await demoWatchStatus(f.input, f.deps);
    assert.equal(observed.stage, 'demo_watch_cycle_observed');
    assert.equal(observed.fullWorkflowReady, false);
    f.setSupervisor({ state: 'stopped', pid: null });
    assert.equal((await demoWatchStatus(f.input, f.deps)).observation, null);
    f.setSupervisor({ state: 'running', pid: 124 });
    assert.equal((await demoWatchStatus(f.input, f.deps)).stage, 'demo_watch_pending');
  } finally { await f.cleanup(); }
});

test('disable works after authorization revocation and preserves another scope and shared startup', async () => {
  const f = await fixture();
  try {
    await enableDemoWatch(f.input, f.deps);
    const other = { ...f.input.registration, repositoryId: '00000000-0000-4000-8000-000000000002' };
    await registerDemoWatch(f.input.home, other);
    f.deps.verify = async () => { throw new Error('revoked'); };
    const calls = [...f.calls];
    const result = await disableDemoWatch(f.input, f.deps);
    assert.equal(result.stage, 'demo_watch_disabled');
    assert.equal(result.registered, false);
    assert.equal(result.autostart, 'enabled');
    assert.deepEqual(await listDemoWatchRegistrations(f.input.home), [other]);
    assert.deepEqual(f.calls, calls);
    assert.equal((await readFile(join(f.input.home, 'relay', 'demo-watches', `${demoWatchRegistrationKey(other)}.json`), 'utf8')).includes('grant'), false);
  } finally { await f.cleanup(); }
});

test('a foreign checkout cannot inspect or remove an existing scope', async () => {
  const f = await fixture();
  try {
    await enableDemoWatch(f.input, f.deps);
    const other = { ...f.input, registration: { ...f.input.registration, workspace: join(f.input.home, 'elsewhere') } };
    await assert.rejects(demoWatchStatus(other, f.deps), /demo_watch_registration_conflict/);
    await assert.rejects(disableDemoWatch(other, f.deps), /demo_watch_registration_conflict/);
    assert.equal((await listDemoWatchRegistrations(f.input.home)).length, 1);
  } finally { await f.cleanup(); }
});

test('supervisor inspection rejects stale bindings, invalid PID and legacy/version mismatch', async () => {
  const f = await fixture();
  try {
    await mkdir(join(f.input.home, 'relay'));
    const pidPath = join(f.input.home, 'relay', 'supervisor.pid');
    const bindingPath = join(f.input.home, 'relay', 'supervisor-workspace.json');
    await writeFile(pidPath, '123\n');
    await writeFile(bindingPath, JSON.stringify({ pid: 124, version: '0.2.103', demoWatches: true }));
    const inspect = () => inspectDemoWatchSupervisor(f.input.home, f.input.version, async () => 'running');
    assert.equal((await inspect()).state, 'unknown');
    await writeFile(bindingPath, JSON.stringify({ pid: 123, version: '0.2.102', demoWatches: true }));
    assert.equal((await inspect()).state, 'version_mismatch');
    await writeFile(bindingPath, JSON.stringify({ pid: 123, version: '0.2.103' }));
    assert.equal((await inspect()).state, 'legacy');
    await writeFile(bindingPath, JSON.stringify({ pid: 123, version: '0.2.103', demoWatches: true }));
    assert.deepEqual(await inspect(), { state: 'running', pid: 123 });
    await writeFile(pidPath, 'invalid');
    assert.equal((await inspect()).state, 'unknown');
  } finally { await f.cleanup(); }
});
