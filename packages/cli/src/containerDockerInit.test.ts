import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import * as lifecycle from './containerRelayLifecycle.js';
import { enableRelayAutostart, relayAutostartStatus } from './relayAutostart.js';

const linux = { skip: process.platform !== 'linux' };
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'dharma-docker-init-'));
  const home = join(root, 'device'); const workspace = join(root, 'checkout');
  await mkdir(join(home, 'relay'), { recursive: true, mode: 0o700 });
  await mkdir(join(workspace, '.dharma'), { recursive: true, mode: 0o700 });
  const uid = process.getuid!();
  const init = { pid: 1, parentPid: 0, processGroupId: 1, sessionId: 1, uid, startTicks: '123', argv: ['/sbin/docker-init', '--', 'docker-entrypoint.sh', 'sleep', 'infinity'] };
  const controller = { pid: 42, parentPid: 1, processGroupId: 42, sessionId: 1, uid, startTicks: '124',
    argv: ['/usr/local/bin/node', '/fixture/cli/dist/bin.js', 'relay', 'container-entrypoint'] };
  const marker = { schema: 'dharma.container-entrypoint/v2', home, pid: controller.pid, uid,
    startTicks: controller.startTicks, initStartTicks: init.startTicks };
  await writeFile(join(home, 'relay', 'container-entrypoint.json'), JSON.stringify(marker), { mode: 0o600 });
  let verifiedInit = true; let verifiedNode = true; let mainChild = controller.pid;
  const runtime = { identity: async () => init, canonicalEntrypoint: controller.argv[1], runtimeVersion: '0.2.135',
    controllerIdentity: async (pid: number) => { assert.equal(pid, controller.pid); return controller; },
    dockerInitVerified: async () => verifiedInit,
    dockerInitMainChild: async () => mainChild,
    controllerExecutableVerified: async () => verifiedNode,
    childIdentity: async (pid: number) => ({ ...await lifecycle.readContainerChildIdentity(pid), parentPid: controller.pid }) };
  const options = { platform: 'linux' as const, home, uid, userHome: root, workspace,
    launcher: join(workspace, '.dharma', 'bin', 'dharma'), policy: join(workspace, '.dharma', 'approved-policy.json'),
    version: '0.2.135', containerRuntime: runtime,
    run: async () => { throw new Error('must never use systemd for the owned init child'); } };
  return { root, home, init, controller, marker, runtime, options,
    untrustInit: () => { verifiedInit = false; }, untrustNode: () => { verifiedNode = false; },
    setMainChild: (pid: number) => { mainChild = pid; } };
}
async function until(check: () => boolean) {
  const deadline = Date.now() + 3000;
  while (!check()) { if (Date.now() > deadline) throw new Error('fixture did not progress'); await new Promise(r => setTimeout(r, 10)); }
}

test('canonical direct child of verified Docker init can own persistent container startup', linux, async () => {
  const f = await fixture();
  assert.equal((await enableRelayAutostart(f.options)).backend, 'container-entrypoint');
  assert.equal((await relayAutostartStatus(f.options)).state, 'enabled');
});

test('adopted canonical exec child cannot replace the Docker init main startup child', linux, async () => {
  for (const kind of ['different-main-child', 'foreign-session', 'foreign-process-group', 'missing-main-child']) {
    const f = await fixture();
    if (kind === 'different-main-child') f.setMainChild(7);
    if (kind === 'missing-main-child') f.setMainChild(0);
    if (kind === 'foreign-session') f.controller.sessionId = 99;
    if (kind === 'foreign-process-group') f.controller.processGroupId = 99;
    await assert.rejects(enableRelayAutostart(f.options), /container_startup_unavailable/, kind);
  }
});

test('Docker init main-child identity is checked again before control is admitted', linux, async () => {
  const f = await fixture(); let reads = 0;
  f.runtime.dockerInitMainChild = async () => ++reads === 1 ? f.controller.pid : 7;
  await assert.rejects(enableRelayAutostart(f.options), /container_startup_unavailable/);
});

test('Docker init session and controller process group cannot change during attribution', linux, async () => {
  for (const kind of ['init-session', 'init-group', 'controller-session', 'controller-group']) {
    const f = await fixture(); let reads = 0;
    if (kind.startsWith('init-')) f.runtime.identity = async () => {
      reads++;
      return { ...f.init, ...(reads > 1 ? kind === 'init-session' ? { sessionId: 99 } : { processGroupId: 99 } : {}) };
    };
    else f.runtime.controllerIdentity = async () => {
      reads++;
      return { ...f.controller, ...(reads > 1 ? kind === 'controller-session' ? { sessionId: 99 } : { processGroupId: 99 } : {}) };
    };
    await assert.rejects(enableRelayAutostart(f.options), /container_startup_unavailable/, kind);
  }
});

test('Docker init route rejects foreign parent owner argv executable boot and controller ticks', linux, async () => {
  for (const kind of ['parent', 'uid', 'argv', 'executable', 'node-executable', 'init-parent', 'init-argv', 'init-boot', 'controller-boot', 'extra-argument']) {
    const f = await fixture();
    if (kind === 'parent') f.controller.parentPid = 9;
    if (kind === 'uid') f.controller.uid++;
    if (kind === 'argv') f.controller.argv[1] = '/foreign/cli/dist/bin.js';
    if (kind === 'executable') f.untrustInit();
    if (kind === 'node-executable') f.untrustNode();
    if (kind === 'init-parent') f.init.parentPid = 3;
    if (kind === 'init-argv') f.init.argv[3] = 'foreign-command';
    if (kind === 'init-boot') f.init.startTicks = '999';
    if (kind === 'controller-boot') f.controller.startTicks = '999';
    if (kind === 'extra-argument') f.controller.argv.push('--grant');
    await assert.rejects(enableRelayAutostart(f.options), /container_startup_unavailable/, kind);
  }
});

test('init marker cannot omit the Docker boot identity or promote an ordinary exec child to the entrypoint', linux, async () => {
  const f = await fixture();
  await writeFile(join(f.home, 'relay', 'container-entrypoint.json'), JSON.stringify({ ...f.marker, initStartTicks: undefined }));
  await assert.rejects(enableRelayAutostart(f.options), /container_startup_unavailable/);
});

test('controller identity changes during executable verification are rejected before startup control', linux, async () => {
  const f = await fixture(); let reads = 0;
  f.runtime.controllerIdentity = async pid => {
    assert.equal(pid, f.controller.pid); reads++;
    return { ...f.controller, startTicks: reads > 1 ? 'CANARY_REUSED_PROCESS' : f.controller.startTicks };
  };
  await assert.rejects(enableRelayAutostart(f.options), error => {
    assert.match(String(error), /container_startup_unavailable/);
    assert.doesNotMatch(String(error), /CANARY_REUSED_PROCESS/); return true;
  });
});

test('same Docker-init boot cannot take over another controller lease', linux, async () => {
  const f = await fixture();
  await writeFile(join(f.home, 'relay', 'container-entrypoint.lock'), JSON.stringify({ ...f.marker, pid: 77, startTicks: '99' }), { mode: 0o600 });
  const abort = new AbortController();
  await assert.rejects(lifecycle.runOwnedContainerEntrypoint({ home: f.home, uid: f.options.uid, signal: abort.signal,
    containerRuntime: { ...f.runtime, currentControllerPid: f.controller.pid } }), /container_entrypoint_busy/);
});

test('different verified Docker-init boot renews only its own previous lifecycle metadata', linux, async () => {
  const f = await fixture();
  await writeFile(join(f.home, 'relay', 'container-entrypoint.lock'), JSON.stringify(f.marker), { mode: 0o600 });
  f.init.startTicks = '223'; f.controller.startTicks = '224';
  const abort = new AbortController();
  const result = lifecycle.runOwnedContainerEntrypoint({ home: f.home, uid: f.options.uid, signal: abort.signal,
    containerRuntime: { ...f.runtime, currentControllerPid: f.controller.pid }, pollMs: 10,
    spawnRelay: () => { throw new Error('unconfigured controller cannot launch'); } });
  try {
    await new Promise(resolve => setTimeout(resolve, 50));
    const marker = JSON.parse(await readFile(join(f.home, 'relay', 'container-entrypoint.json'), 'utf8'));
    assert.equal(marker.initStartTicks, '223'); assert.equal(marker.startTicks, '224');
  } finally { abort.abort(); }
  await result;
});

test('Docker init controller fences its own supervisor and remains blocked while the consumer is locked', linux, async () => {
  const f = await fixture(); await enableRelayAutostart(f.options);
  const abort = new AbortController(); let ready = false; const children: ReturnType<typeof spawn>[] = [];
  const result = lifecycle.runOwnedContainerEntrypoint({ home: f.home, uid: f.options.uid, signal: abort.signal,
    containerRuntime: { ...f.runtime, currentControllerPid: f.controller.pid }, pollMs: 10,
    consumerStoreReady: async () => ready,
    spawnRelay: () => { const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' }); children.push(child); return child; } } as Parameters<typeof lifecycle.runOwnedContainerEntrypoint>[0]);
  try {
    await new Promise(resolve => setTimeout(resolve, 50));
    const heartbeat = JSON.parse(await readFile(join(f.home, 'relay', 'container-heartbeat.json'), 'utf8'));
    assert.equal(heartbeat.lifecycle, 'blocked'); assert.equal(children.length, 0);
    ready = true; await until(() => children.length === 1);
    assert.equal((await relayAutostartStatus(f.options)).lifecycle, 'running');
  } finally { abort.abort(); }
  await result;
  assert.equal(children.every(child => child.exitCode !== null || child.signalCode !== null), true);
});
