import assert from 'node:assert/strict';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter, once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { relayRestartDelayMs, superviseRelay } from './relaySupervisor.js';

const execFileAsync = promisify(execFile);

test('relay restart backoff is bounded', () => {
  assert.equal(relayRestartDelayMs(1), 1_000);
  assert.equal(relayRestartDelayMs(2), 2_000);
  assert.equal(relayRestartDelayMs(6), 30_000);
  assert.equal(relayRestartDelayMs(100), 30_000);
});

test('supervisor restarts unexpected exits and stops its child on shutdown', async () => {
  const controller = new AbortController();
  const waits: number[] = [];
  let starts = 0;
  const result = await superviseRelay({
    signal: controller.signal,
    wait: async delayMs => { waits.push(delayMs); },
    start: () => {
      starts += 1;
      const child = new EventEmitter() as ChildProcess;
      child.kill = () => {
        queueMicrotask(() => child.emit('exit', 0, null));
        return true;
      };
      queueMicrotask(() => {
        if (starts === 3) controller.abort();
        else child.emit('exit', 1, null);
      });
      return child;
    },
  });
  assert.equal(starts, 3);
  assert.deepEqual(waits, [1_000, 2_000]);
  assert.equal(result.restarts, 2);
});

test('supervisor does not start a relay after shutdown', async () => {
  const controller = new AbortController();
  controller.abort();
  let starts = 0;
  const result = await superviseRelay({
    signal: controller.signal,
    start: () => { starts += 1; throw new Error('must not start'); },
  });
  assert.equal(starts, 0);
  assert.equal(result.restarts, 0);
});

test('a detached supervisor records its workspace and relay stop shuts it down', {
  skip: process.platform === 'win32',
}, async () => {
  const root = await mkdtemp(join(tmpdir(), 'dharma-relay-supervisor-process-'));
  const home = join(root, 'home');
  const workspace = join(root, 'repo');
  const policyPath = join(workspace, '.dharma', 'approved-policy.json');
  await mkdir(join(workspace, '.dharma'), { recursive: true });
  await mkdir(join(home, 'registry'), { recursive: true });
  await writeFile(policyPath, '{}\n');
  await writeFile(join(home, 'device.json'), JSON.stringify({ organizationId: 'org_test', deviceId: 'device_test' }));
  await writeFile(join(home, 'registry', 'workspaces.json'), JSON.stringify([{ path: workspace, workspaceId: 'workspace_test' }]));
  const env = { ...process.env, DHARMA_HOME: home };
  const bin = fileURLToPath(new URL('./bin.js', import.meta.url));
  const child = spawn(process.execPath, [bin, 'relay', 'supervise', '--policy', policyPath], {
    env, stdio: 'ignore', detached: true,
  });
  try {
    let binding: { workspaceId: string; policyPath: string } | null = null;
    for (let attempt = 0; attempt < 50; attempt += 1) {
      binding = await readFile(join(home, 'relay', 'supervisor-workspace.json'), 'utf8')
        .then(value => JSON.parse(value) as { workspaceId: string; policyPath: string }).catch(() => null);
      if (binding) break;
      await new Promise(resolveWait => setTimeout(resolveWait, 100));
    }
    assert.deepEqual(binding && { workspaceId: binding.workspaceId, policyPath: binding.policyPath }, {
      workspaceId: 'workspace_test', policyPath,
    });
    const { stdout } = await execFileAsync(process.execPath, [bin, 'relay', 'stop'], { env, timeout: 10_000 });
    assert.deepEqual(JSON.parse(stdout), { ok: true, stopped: true, vaultPreserved: true });
    const status = await execFileAsync(process.execPath, [bin, 'status'], { env, timeout: 10_000 });
    assert.equal(JSON.parse(status.stdout).supervisor, 'stopped');
  } finally {
    if (child.exitCode === null) child.kill('SIGTERM');
    await rm(root, { recursive: true, force: true });
  }
});

test('relay stop terminates an orphaned receiver after the supervisor exits', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dharma-relay-orphan-stop-'));
  const home = join(root, 'home');
  const relayDir = join(home, 'relay');
  await mkdir(relayDir, { recursive: true });
  const supervisor = spawn(process.execPath, ['-e', 'console.log("ready"); setInterval(() => {}, 1000)'], {
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  const receiver = spawn(process.execPath, ['-e', 'console.log("ready"); setInterval(() => {}, 1000)'], {
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  try {
    assert.ok(supervisor.pid);
    assert.ok(receiver.pid);
    await Promise.all([once(supervisor.stdout!, 'data'), once(receiver.stdout!, 'data')]);
    await writeFile(join(relayDir, 'supervisor.pid'), `${supervisor.pid}\n`);
    await writeFile(join(relayDir, 'relay.pid'), `${receiver.pid}\n`);
    const bin = fileURLToPath(new URL('./bin.js', import.meta.url));
    const { stdout } = await execFileAsync(process.execPath, [bin, 'relay', 'stop'], {
      env: { ...process.env, DHARMA_HOME: home }, timeout: 10_000,
    });
    assert.deepEqual(JSON.parse(stdout), { ok: true, stopped: true, vaultPreserved: true });
    assert.equal(supervisor.exitCode !== null || supervisor.signalCode !== null, true);
    assert.equal(receiver.exitCode !== null || receiver.signalCode !== null, true);
  } finally {
    supervisor.kill('SIGTERM');
    receiver.kill('SIGTERM');
    await rm(root, { recursive: true, force: true });
  }
});
