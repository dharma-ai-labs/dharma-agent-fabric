import assert from 'node:assert/strict';
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { spawn, type ChildProcess } from 'node:child_process';
import * as lifecycle from './containerRelayLifecycle.js';
import { assertRelayStartupOwnership, enableRelayAutostart, relayAutostartStatus, startRelayAutostart,
  stopRelayAutostart, disableRelayAutostart } from './relayAutostart.js';

// The filesystem and lifecycle receipts are real. Only PID1 identity and the OS
// command boundary are injected: a unit test must never signal host PID1.
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'dharma-container-lifecycle-'));
  const home = join(root, 'device');
  const workspace = join(root, 'checkout');
  await mkdir(join(home, 'relay'), { recursive: true, mode: 0o700 });
  await mkdir(join(workspace, '.dharma'), { recursive: true, mode: 0o700 });
  const uid = process.getuid?.() ?? 1000;
  const identity = { pid: 1, uid, startTicks: '12345',
    argv: ['/usr/bin/node', '/fixture/cli/dist/bin.js', 'relay', 'container-entrypoint'] };
  const marker = { schema: 'dharma.container-entrypoint/v1', home, pid: 1, uid,
    startTicks: identity.startTicks };
  await writeFile(join(home, 'relay', 'container-entrypoint.json'), JSON.stringify(marker), { mode: 0o600 });
  await writeFile(join(workspace, '.dharma', 'approved-policy.json'), '{}', { mode: 0o600 });
  const calls: string[][] = [];
  const options = { platform: 'linux' as const, uid, userHome: root, home, workspace,
    launcher: join(workspace, '.dharma', 'bin', 'dharma'),
    policy: join(workspace, '.dharma', 'approved-policy.json'), version: '0.2.134',
    containerRuntime: { identity: async () => identity, canonicalEntrypoint: identity.argv[1], runtimeVersion: '0.2.134',
      childIdentity: async (pid: number) => {
        const actual = await lifecycle.readContainerChildIdentity(pid);
        // A process fixture is parented by this test, not the container's PID1.
        assert.equal(actual.parentPid, process.pid);
        return { ...actual, parentPid: 1 };
      } },
    run: async (file: string, args: string[]) => { calls.push([file, ...args]); return { stdout: 'enabled\n' }; } };
  return { root, home, marker, identity, calls, options };
}

// Container PID1 and child identity are Linux /proc contracts. Other hosts
// qualify rejection/schema behavior through the public command tests.
const posix = { skip: process.platform !== 'linux' };

test('startup preflight uses a verified container entrypoint without touching the user systemd slot', posix, async () => {
  const f = await fixture();
  const unit = join(f.root, '.config', 'systemd', 'user', 'dharma-agent-fabric.service');
  await mkdir(join(f.root, '.config', 'systemd', 'user'), { recursive: true });
  await writeFile(unit, 'existing host service', { mode: 0o600 });
  await assertRelayStartupOwnership(f.options);
  assert.equal(await readFile(unit, 'utf8'), 'existing host service');
  assert.deepEqual(f.calls, []);
  await assert.rejects(readFile(join(f.home, 'relay', 'autostart.json')), { code: 'ENOENT' });
});

test('startup preflight rejects stale or foreign container context without systemd fallback', posix, async () => {
  const f = await fixture();
  f.identity.startTicks = '99999';
  await assert.rejects(assertRelayStartupOwnership(f.options), /container_startup_unavailable/);
  assert.deepEqual(f.calls, []);
  await writeFile(join(f.home, 'relay', 'container-entrypoint.json'), JSON.stringify({ ...f.marker, home: '/foreign' }));
  await assert.rejects(assertRelayStartupOwnership(f.options), /container_startup_unavailable/);
  assert.deepEqual(f.calls, []);
});

test('startup preflight rejects invalid existing container registrations and controls without mutation', posix, async () => {
  for (const kind of ['malformed-registration', 'missing-control', 'mismatched-control', 'malformed-control', 'orphan-control']) {
    const f = await fixture();
    await enableRelayAutostart(f.options);
    const registration = join(f.home, 'relay', 'autostart.json');
    const control = join(f.home, 'relay', 'container-control.json');
    if (kind === 'malformed-registration') await writeFile(registration, '{broken');
    if (kind === 'missing-control') await rm(control);
    if (kind === 'mismatched-control') {
      const value = JSON.parse(await readFile(control, 'utf8'));
      await writeFile(control, JSON.stringify({ ...value, registrationHash: '0'.repeat(64) }));
    }
    if (kind === 'malformed-control') await writeFile(control, '{broken');
    if (kind === 'orphan-control') await rm(registration);
    const snapshot = async () => Promise.all([registration, control].map(path => readFile(path, 'utf8')
      .catch(error => { if (error.code === 'ENOENT') return null; throw error; })));
    const before = await snapshot();
    await assert.rejects(assertRelayStartupOwnership(f.options), /container_startup_unavailable|autostart_conflict/, kind);
    assert.deepEqual(await snapshot(), before, kind);
    assert.deepEqual(f.calls, [], kind);
  }
});

test('startup preflight accepts an exactly owned paused container registration without resuming it', posix, async () => {
  const f = await fixture();
  await enableRelayAutostart(f.options);
  await stopRelayAutostart(f.options);
  const control = join(f.home, 'relay', 'container-control.json');
  const before = await readFile(control, 'utf8');
  await assertRelayStartupOwnership(f.options);
  assert.equal(await readFile(control, 'utf8'), before);
  assert.equal(JSON.parse(before).running, false);
  assert.deepEqual(f.calls, []);
});

for (const [name, configured] of [
  ['container-entrypoint.json', false], ['autostart.json', false], ['container-control.json', false],
  ['autostart.json', true], ['container-control.json', true],
] as const) {
  test(`startup preflight rejects JSON null in ${name} with configured=${configured}`, posix, async () => {
    const f = await fixture();
    if (configured) await enableRelayAutostart(f.options);
    const path = join(f.home, 'relay', name);
    await writeFile(path, 'null\n', { mode: 0o600 });
    await assert.rejects(assertRelayStartupOwnership(f.options), /container_startup_unavailable/);
    assert.equal(await readFile(path, 'utf8'), 'null\n');
    assert.deepEqual(f.calls, []);
  });
}

test('owned container PID1 enables startup without claiming or modifying the OS-user systemd slot', posix, async () => {
  const f = await fixture();
  const friday = join(f.root, '.config', 'systemd', 'user', 'dharma-agent-fabric.service');
  await mkdir(join(f.root, '.config', 'systemd', 'user'), { recursive: true });
  await writeFile(friday, 'foreign Friday service', { mode: 0o600 });
  const state = await enableRelayAutostart(f.options);
  assert.equal(state.backend, 'container-entrypoint');
  assert.equal(state.state, 'enabled');
  assert.equal(await readFile(friday, 'utf8'), 'foreign Friday service');
  assert.deepEqual(f.calls, []);
  assert.equal((await relayAutostartStatus(f.options)).state, 'enabled');
});

test('container lifecycle start stop and disable only change its owned control receipt', posix, async () => {
  const f = await fixture();
  await enableRelayAutostart(f.options);
  await stopRelayAutostart(f.options);
  const control = join(f.home, 'relay', 'container-control.json');
  assert.equal(JSON.parse(await readFile(control, 'utf8')).running, false);
  await startRelayAutostart(f.options);
  assert.equal(JSON.parse(await readFile(control, 'utf8')).running, true);
  assert.equal((await disableRelayAutostart(f.options)).state, 'disabled');
  assert.equal((await relayAutostartStatus(f.options)).state, 'disabled');
  assert.deepEqual(f.calls, []);
});

test('a sleep PID1 cannot assert owned container startup and cannot fall through to systemd', posix, async () => {
  const f = await fixture();
  f.identity.argv = ['sleep', 'infinity'];
  await assert.rejects(enableRelayAutostart(f.options), /container_startup_unavailable/);
  assert.deepEqual(f.calls, []);
});

test('stale marker after a different container boot is rejected until the actual entrypoint renews it', posix, async () => {
  const f = await fixture();
  await enableRelayAutostart(f.options);
  f.identity.startTicks = '99999';
  assert.equal((await relayAutostartStatus(f.options)).state, 'unavailable');
  await assert.rejects(startRelayAutostart(f.options), /owned startup|container_startup_unavailable/);
  assert.deepEqual(f.calls, []);
});

test('foreign home marker cannot claim ownership', posix, async () => {
  const f = await fixture();
  await writeFile(join(f.home, 'relay', 'container-entrypoint.json'), JSON.stringify({ ...f.marker, home: '/foreign' }));
  await assert.rejects(enableRelayAutostart(f.options), /container_startup_unavailable/);
  assert.deepEqual(f.calls, []);
});

type Entrypoint = (options: { home: string; uid: number; signal: AbortSignal;
  containerRuntime: lifecycle.ContainerRuntime;
  spawnRelay: (registration: lifecycle.ContainerRelayRegistration) => ChildProcess;
  consumerStoreReady?: () => Promise<boolean>;
  pollMs: number; restartDelayMs: number }) => Promise<{ stopped: boolean; restarts: number }>;
function entrypoint(): Entrypoint {
  const run = (lifecycle as typeof lifecycle & { runOwnedContainerEntrypoint?: Entrypoint }).runOwnedContainerEntrypoint;
  assert.equal(typeof run, 'function', 'released container lifecycle has no owned entrypoint loop');
  return run!;
}
async function until(condition: () => boolean | Promise<boolean>, milliseconds = 3000) {
  const deadline = Date.now() + milliseconds;
  while (!await condition()) {
    if (Date.now() >= deadline) throw new Error('owned child fixture did not reach its expected state');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}
const exited = (child: ChildProcess) => child.exitCode !== null || child.signalCode !== null;

test('entrypoint starts only its owned supervisor, stops it, and reconnects after an explicit start', posix, async () => {
  const run = entrypoint();
  const f = await fixture();
  const controller = new AbortController();
  const children: ChildProcess[] = [];
  const result = run({ home: f.home, uid: f.options.uid, signal: controller.signal,
    containerRuntime: f.options.containerRuntime, consumerStoreReady: async () => true, pollMs: 10, restartDelayMs: 10,
    spawnRelay: registration => {
      assert.equal(registration.policy, f.options.policy);
      const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
      children.push(child); return child;
    } });
  const watchdog = setTimeout(() => controller.abort(), 5000);
  try {
    await enableRelayAutostart(f.options);
    await until(() => children.length === 1);
    await stopRelayAutostart(f.options);
    await until(() => exited(children[0]!));
    // Child exit precedes the controller's next receipt. Do not interpret the
    // prior running heartbeat as current authority to restart an exited PID.
    await until(async () => {
      const status = await relayAutostartStatus(f.options);
      return status.state === 'enabled' && status.lifecycle === 'paused';
    });
    assert.equal(children.length, 1, 'paused controller must not relaunch on its own');
    await startRelayAutostart(f.options);
    await until(() => children.length === 2);
  } finally { clearTimeout(watchdog); controller.abort(); }
  assert.equal((await result).stopped, true);
  assert.equal(children.every(exited), true);
  assert.deepEqual(f.calls, []);
});

test('entrypoint relaunches a failed owned child and renews boot identity while retaining startup configuration', posix, async () => {
  const run = entrypoint();
  const f = await fixture();
  await enableRelayAutostart(f.options);
  const children: ChildProcess[] = [];
  const admittedChild = (child: ChildProcess) => until(async () => {
    const heartbeat = await readFile(join(f.home, 'relay', 'container-heartbeat.json'), 'utf8')
      .then(value => JSON.parse(value)).catch(error => {
        if (error.code === 'ENOENT') return null;
        throw error;
      });
    return heartbeat?.lifecycle === 'running' && heartbeat.childPid === child.pid
      && heartbeat.startTicks === f.identity.startTicks && typeof heartbeat.childStartTicks === 'string';
  });
  async function boot() {
    const controller = new AbortController();
    const result = run({ home: f.home, uid: f.options.uid, signal: controller.signal,
      containerRuntime: f.options.containerRuntime, consumerStoreReady: async () => true, pollMs: 10, restartDelayMs: 10,
      spawnRelay: () => {
        const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
        children.push(child); return child;
      } });
    return { controller, result };
  }
  const first = await boot();
  try {
    await until(() => children.length === 1);
    await admittedChild(children[0]!);
    children[0]!.kill('SIGTERM');
    await until(() => children.length === 2);
    await admittedChild(children[1]!);
  } finally { first.controller.abort(); }
  assert.equal((await first.result).restarts, 1);
  f.identity.startTicks = '54321';
  const second = await boot();
  try {
    await until(() => children.length === 3);
    await admittedChild(children[2]!);
    assert.equal((await relayAutostartStatus(f.options)).state, 'enabled');
    const marker = JSON.parse(await readFile(join(f.home, 'relay', 'container-entrypoint.json'), 'utf8'));
    assert.equal(marker.startTicks, '54321');
  } finally { second.controller.abort(); }
  await second.result;
  assert.equal(children.every(exited), true);
});

test('unconfigured entrypoint waits without enrolling, calling a provider, or launching a relay', posix, async () => {
  const run = entrypoint();
  const f = await fixture();
  const controller = new AbortController();
  let launches = 0;
  const result = run({ home: f.home, uid: f.options.uid, signal: controller.signal,
    containerRuntime: f.options.containerRuntime, consumerStoreReady: async () => true, pollMs: 10, restartDelayMs: 10,
    spawnRelay: () => { launches++; throw new Error('must not launch'); } });
  await new Promise(resolve => setTimeout(resolve, 40));
  controller.abort();
  await result;
  assert.equal(launches, 0);
});

test('corrupt startup authority fails closed and reaps the owned child without leaking raw input', posix, async () => {
  const run = entrypoint();
  const f = await fixture();
  await enableRelayAutostart(f.options);
  const controller = new AbortController();
  let child: ChildProcess | undefined;
  const result = run({ home: f.home, uid: f.options.uid, signal: controller.signal,
    containerRuntime: f.options.containerRuntime, consumerStoreReady: async () => true, pollMs: 10, restartDelayMs: 10,
    spawnRelay: () => child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' }) });
  const failure = assert.rejects(result, error => {
    assert.match(String(error), /container_startup_unavailable/);
    assert.doesNotMatch(String(error), /CANARY_PRIVATE_INPUT/);
    return true;
  });
  await until(() => Boolean(child));
  await writeFile(join(f.home, 'relay', 'autostart.json'), 'CANARY_PRIVATE_INPUT');
  await failure;
  assert.equal(exited(child!), true);
});

test('locked protected consumer blocks startup without launching a relay until explicitly unlocked', posix, async () => {
  const run = entrypoint();
  const f = await fixture();
  await enableRelayAutostart(f.options);
  const controller = new AbortController();
  let ready = false;
  const children: ChildProcess[] = [];
  const result = run({ home: f.home, uid: f.options.uid, signal: controller.signal,
    containerRuntime: f.options.containerRuntime, pollMs: 10, restartDelayMs: 10,
    consumerStoreReady: async () => ready,
    spawnRelay: () => {
      const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
      children.push(child); return child;
    } });
  try {
    await until(() => false, 50).catch(() => {});
    assert.equal(children.length, 0);
    const heartbeat = JSON.parse(await readFile(join(f.home, 'relay', 'container-heartbeat.json'), 'utf8'));
    assert.equal(heartbeat.lifecycle, 'blocked');
    assert.equal(heartbeat.reason, 'consumer_store_locked_or_unavailable');
    ready = true;
    await until(() => children.length === 1);
  } finally { controller.abort(); }
  await result;
  assert.equal(children.every(exited), true);
});

test('duplicate owned entrypoint cannot take over a live lifecycle lease', posix, async () => {
  const run = entrypoint();
  const f = await fixture();
  const controller = new AbortController();
  const options = { home: f.home, uid: f.options.uid, signal: controller.signal,
    containerRuntime: f.options.containerRuntime, pollMs: 10, restartDelayMs: 10,
    spawnRelay: () => { throw new Error('unconfigured'); } };
  const first = run(options);
  try {
    await until(() => false, 40).catch(() => {});
    await assert.rejects(run(options), /container_entrypoint_busy/);
  } finally { controller.abort(); }
  await first;
});

test('configured entrypoint cannot claim running startup from a nonexistent child heartbeat', posix, async () => {
  const f = await fixture();
  await enableRelayAutostart(f.options);
  const control = JSON.parse(await readFile(join(f.home, 'relay', 'container-control.json'), 'utf8'));
  await writeFile(join(f.home, 'relay', 'container-heartbeat.json'), JSON.stringify({
    schema: 'dharma.container-relay-heartbeat/v1', home: f.home, startTicks: f.identity.startTicks,
    polledAt: Date.now(), lifecycle: 'running', reason: null, registrationHash: control.registrationHash,
    childPid: 999999999, childStartTicks: '12345',
  }), { mode: 0o600 });
  assert.notEqual((await relayAutostartStatus(f.options)).lifecycle, 'running');
});

test('PID1 must use the exact canonical CLI entrypoint and non-root owner', posix, async () => {
  for (const change of ['script', 'uid', 'extra-argument', 'ticks']) {
    const f = await fixture();
    if (change === 'script') f.identity.argv[1] = '/foreign/cli/dist/bin.js';
    if (change === 'uid') f.identity.uid++;
    if (change === 'extra-argument') f.identity.argv.push('--grant');
    if (change === 'ticks') f.identity.startTicks = 'invalid';
    await assert.rejects(enableRelayAutostart(f.options), /container_startup_unavailable/);
    assert.deepEqual(f.calls, []);
  }
});

test('private lifecycle marker and control reject unsafe files and malformed contents without reflecting input', posix, async () => {
  for (const name of ['container-entrypoint.json', 'container-control.json']) {
    for (const kind of ['symlink', 'world-writable', 'oversize', 'malformed', 'foreign-uid']) {
      const f = await fixture();
      await enableRelayAutostart(f.options);
      const path = join(f.home, 'relay', name);
      if (kind === 'symlink') {
        const target = join(f.root, 'foreign-canary.json');
        await writeFile(target, 'CANARY_PRIVATE_INPUT', { mode: 0o600 });
        await rm(path); await symlink(target, path);
      } else if (kind === 'world-writable') await chmod(path, 0o666);
      else if (kind === 'oversize') await writeFile(path, 'CANARY_PRIVATE_INPUT'.repeat(4096));
      else if (kind === 'malformed') await writeFile(path, 'CANARY_PRIVATE_INPUT');
      else f.options.uid++;
      const status = await relayAutostartStatus(f.options);
      assert.equal(status.state, 'unavailable', `${name}/${kind}`);
      assert.doesNotMatch(JSON.stringify(status), /CANARY_PRIVATE_INPUT/);
      await assert.rejects(startRelayAutostart(f.options), /owned startup|container_startup_unavailable/);
      assert.deepEqual(f.calls, []);
    }
  }
});


test('entrypoint does not launch a registration from a different installed runtime version', posix, async () => {
  const run = entrypoint(); const f = await fixture();
  await enableRelayAutostart({ ...f.options, version: '0.0.1' });
  const controller = new AbortController(); let launches = 0;
  const result = run({ home: f.home, uid: f.options.uid, signal: controller.signal,
    containerRuntime: f.options.containerRuntime, consumerStoreReady: async () => true, pollMs: 10, restartDelayMs: 10,
    spawnRelay: () => { launches++; return spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' }); } });
  await new Promise(resolve => setTimeout(resolve, 50)); controller.abort(); await result;
  assert.equal(launches, 0);
});


test('stale heartbeat and reused or foreign child identity cannot assert live startup', posix, async () => {
  for (const kind of ['stale', 'reused', 'foreign-parent', 'foreign-owner']) {
    const f = await fixture(); await enableRelayAutostart(f.options);
    const control = JSON.parse(await readFile(join(f.home, 'relay', 'container-control.json'), 'utf8'));
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    try {
      const identity = await lifecycle.readContainerChildIdentity(child.pid!);
      if (kind === 'foreign-parent' || kind === 'foreign-owner') {
        f.options.containerRuntime.childIdentity = async () => ({ ...identity,
          uid: kind === 'foreign-owner' ? identity.uid + 1 : identity.uid,
          parentPid: kind === 'foreign-parent' ? process.pid : 1 });
      }
      await writeFile(join(f.home, 'relay', 'container-heartbeat.json'), JSON.stringify({
        schema: 'dharma.container-relay-heartbeat/v1', home: f.home, startTicks: f.identity.startTicks,
        polledAt: Date.now() - (kind === 'stale' ? 20_000 : 0), lifecycle: 'running', reason: null,
        registrationHash: control.registrationHash, childPid: child.pid,
        childStartTicks: kind === 'reused' ? String(BigInt(identity.startTicks) + 1n) : identity.startTicks,
      }), { mode: 0o600 });
      const status = await relayAutostartStatus(f.options);
      assert.equal(status.state, 'unavailable', kind);
      assert.equal(status.reason, 'container_startup_unavailable', kind);
    } finally { child.kill('SIGTERM'); await until(() => exited(child)); }
  }
});

test('concurrent owned controls are atomic and disabling reaps interrupted owned work', posix, async () => {
  const f = await fixture(); await enableRelayAutostart(f.options);
  const controller = new AbortController(); const children: ChildProcess[] = [];
  const result = entrypoint()({ home: f.home, uid: f.options.uid, signal: controller.signal,
    containerRuntime: f.options.containerRuntime, consumerStoreReady: async () => true, pollMs: 10, restartDelayMs: 10,
    spawnRelay: () => { const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
      children.push(child); return child; } });
  try {
    await until(() => children.length === 1);
    const registration = await lifecycle.readContainerRegistration(f.options);
    assert.ok(registration);
    await Promise.all(Array.from({ length: 12 }, (_, index) => lifecycle.containerStartupControl(f.options, registration, index % 2 === 0)));
    assert.equal(typeof JSON.parse(await readFile(join(f.home, 'relay', 'container-control.json'), 'utf8')).running, 'boolean');
    // No subsequent writer; disable is terminal for this registration.
    await disableRelayAutostart(f.options);
    await until(() => children.every(exited));
    assert.equal((await relayAutostartStatus(f.options)).state, 'disabled');
  } finally { controller.abort(); }
  await result;
});

test('SIGTERM to an owned process fixture shuts down and reaps its child normally', posix, async () => {
  const f = await fixture(); await enableRelayAutostart(f.options);
  const program = `
    import { spawn } from 'node:child_process';
    import { runOwnedContainerEntrypoint, readContainerChildIdentity } from ${JSON.stringify(new URL('./containerRelayLifecycle.js', import.meta.url).href)};
    const controller = new AbortController();
    process.once('SIGTERM', () => controller.abort());
    await runOwnedContainerEntrypoint({ home: ${JSON.stringify(f.home)}, uid: process.getuid(), signal: controller.signal,
      containerRuntime: { identity: async () => (${JSON.stringify(f.identity)}), canonicalEntrypoint: ${JSON.stringify(f.identity.argv[1])}, runtimeVersion: '0.2.134',
        childIdentity: async pid => { const actual = await readContainerChildIdentity(pid);
          if (actual.parentPid !== process.pid) throw new Error('foreign fixture child'); return { ...actual, parentPid: 1 }; } },
      consumerStoreReady: async () => true, pollMs: 10, restartDelayMs: 10,
      spawnRelay: () => { const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
        process.stdout.write(JSON.stringify({ childPid: child.pid }) + '\\n'); return child; } });
  `;
  const runner = spawn(process.execPath, ['--input-type=module', '-e', program], { stdio: ['ignore', 'pipe', 'pipe'] });
  let output = ''; let errorOutput = ''; let childPid = 0;
  runner.stdout!.on('data', data => { output += String(data); if (output.includes('\n')) childPid = JSON.parse(output.trim()).childPid; });
  runner.stderr!.on('data', data => { errorOutput += String(data); });
  try {
    await until(() => childPid > 1 || exited(runner));
    assert.ok(childPid > 1, errorOutput || output || 'fixture exited without a child');
    runner.kill('SIGTERM'); await until(() => exited(runner));
    assert.equal(runner.exitCode, 0, errorOutput);
    assert.throws(() => process.kill(childPid, 0), /ESRCH/);
    assert.equal((await relayAutostartStatus(f.options)).state, 'unavailable');
    assert.ok(await readFile(join(f.home, 'relay', 'autostart.json'), 'utf8'));
  } finally { if (!exited(runner)) { runner.kill('SIGTERM'); await until(() => exited(runner)); } }
});


test('the normal npm client recognizes a separate identical qualified CLI image but rejects changed executable bytes', posix, async () => {
  const f = await fixture();
  const runtime = join(f.root, 'qualified-cli'); await mkdir(join(runtime, 'dist'), { recursive: true, mode: 0o700 });
  for (const name of ['bin.js', 'index.js', 'containerRelayLifecycle.js']) {
    await copyFile(new URL(`./${name}`, import.meta.url), join(runtime, 'dist', name));
    await chmod(join(runtime, 'dist', name), 0o644);
  }
  await copyFile(new URL('../package.json', import.meta.url), join(runtime, 'package.json'));
  await chmod(join(runtime, 'package.json'), 0o644);
  f.identity.argv[1] = join(runtime, 'dist', 'bin.js');
  const runtimeOptions: lifecycle.ContainerLifecycleOptions = { home: f.home, uid: f.options.uid,
    containerRuntime: { identity: async () => f.identity } };
  assert.equal(await lifecycle.containerEntrypointAvailable(runtimeOptions), true);
  await writeFile(join(runtime, 'dist', 'index.js'), 'CANARY_CHANGED_RUNTIME');
  await assert.rejects(lifecycle.containerEntrypointAvailable(runtimeOptions), error => {
    assert.match(String(error), /container_startup_unavailable/);
    assert.doesNotMatch(String(error), /CANARY_CHANGED_RUNTIME/); return true;
  });
});


test('malformed entrypoint leases cannot be silently discarded as an earlier boot', posix, async () => {
  for (const startTicks of [null, 'CANARY_PRIVATE_INPUT']) {
    const f = await fixture();
    await writeFile(join(f.home, 'relay', 'container-entrypoint.lock'), JSON.stringify({ ...f.marker, startTicks }), { mode: 0o600 });
    const controller = new AbortController(); const timeout = setTimeout(() => controller.abort(), 100);
    try {
      await assert.rejects(entrypoint()({ home: f.home, uid: f.options.uid, signal: controller.signal,
        containerRuntime: f.options.containerRuntime, consumerStoreReady: async () => true, pollMs: 10, restartDelayMs: 10,
        spawnRelay: () => { throw new Error('must not launch'); } }), error => {
        assert.match(String(error), /container_startup_unavailable/); assert.doesNotMatch(String(error), /CANARY_PRIVATE_INPUT/); return true;
      });
      assert.equal(JSON.parse(await readFile(join(f.home, 'relay', 'container-entrypoint.lock'), 'utf8')).startTicks, startTicks);
    } finally { clearTimeout(timeout); controller.abort(); }
  }
});


test('entrypoint never starts an owned child after shutdown arrives during consumer preflight', posix, async () => {
  const f = await fixture(); await enableRelayAutostart(f.options);
  const controller = new AbortController(); let checking = false; let launches = 0;
  let release: (() => void) | undefined;
  const consumer = new Promise<boolean>(resolveReady => { release = () => resolveReady(true); });
  const result = entrypoint()({ home: f.home, uid: f.options.uid, signal: controller.signal,
    containerRuntime: f.options.containerRuntime, consumerStoreReady: async () => { checking = true; return consumer; },
    pollMs: 10, restartDelayMs: 10, spawnRelay: () => { launches++;
      return spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' }); } });
  await until(() => checking); controller.abort(); release!(); await result;
  assert.equal(launches, 0);
});


test('unverifiable freshly spawned child fails closed and is reaped through its owned process handle', posix, async () => {
  const f = await fixture(); await enableRelayAutostart(f.options);
  const controller = new AbortController(); let child: ChildProcess | undefined;
  const result = entrypoint()({ home: f.home, uid: f.options.uid, signal: controller.signal,
    containerRuntime: { ...f.options.containerRuntime, childIdentity: async () => { throw new Error('CANARY_PROC_FAILURE'); } },
    consumerStoreReady: async () => true, pollMs: 10, restartDelayMs: 10,
    spawnRelay: () => child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' }) });
  try {
    await assert.rejects(result, error => { assert.match(String(error), /container_startup_unavailable/);
      assert.doesNotMatch(String(error), /CANARY_PROC_FAILURE/); return true; });
    assert.ok(child); await until(() => exited(child!), 100);
  } finally { controller.abort(); if (child && !exited(child)) { child.kill('SIGTERM'); await until(() => exited(child!)); } }
});
