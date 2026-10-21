import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { inspectOwnedContainerStartup, runOwnedContainerEntrypoint, type ContainerProcessIdentity } from './containerRelayLifecycle.js';

const posix = { skip: process.platform !== 'linux' || process.getuid?.() === 0 };
async function fixture(running: boolean | null = false) {
  const root = await mkdtemp(join(tmpdir(), 'dharma-startup-inspection-'));
  const home = join(root, 'device');
  await mkdir(join(home, 'relay'), { recursive: true, mode: 0o700 });
  const uid = process.getuid!();
  const identity: ContainerProcessIdentity = { pid: 1, uid, startTicks: '12345',
    argv: ['/usr/bin/node', '/fixture/cli/dist/bin.js', 'relay', 'container-entrypoint', '--inspect-startup'] };
  const registration = { schema: 'dharma.relay-autostart/v3', backend: 'container-entrypoint',
    launcher: '/repo/.dharma/bin/dharma', workspace: '/repo', policy: '/repo/.dharma/approved-policy.json',
    version: '0.2.211', taskName: null };
  const hash = createHash('sha256').update(JSON.stringify([home, registration.schema, registration.backend,
    registration.launcher, registration.workspace, registration.policy, registration.version, registration.taskName])).digest('hex');
  const control = { schema: 'dharma.container-relay-control/v1', home, registrationHash: hash, running };
  const paths = { registration: join(home, 'relay', 'autostart.json'), control: join(home, 'relay', 'container-control.json') };
  if (running !== null) {
    await writeFile(paths.registration, JSON.stringify(registration), { mode: 0o600 });
    await writeFile(paths.control, JSON.stringify(control), { mode: 0o600 });
  }
  const options = { home, uid, containerRuntime: { identity: async () => identity, canonicalEntrypoint: identity.argv[1] } };
  const snapshot = async () => Promise.all((await readdir(join(home, 'relay'))).sort()
    .map(async name => [name, await readFile(join(home, 'relay', name), 'utf8')]));
  return { root, home, identity, registration, control, hash, paths, options, snapshot };
}

test('inspection identity cannot take over the ordinary persistent entrypoint', posix, async t => {
  const f = await fixture(); t.after(() => rm(f.root, { recursive: true, force: true }));
  const before = await f.snapshot();
  await assert.rejects(runOwnedContainerEntrypoint({ ...f.options, signal: AbortSignal.abort() }), /container_startup_unavailable/);
  assert.deepEqual(await f.snapshot(), before);
});

for (const kind of ['missing-home', 'missing-relay', 'canary-path']) {
  test(`inspection sanitizes absent private directories: ${kind}`, posix, async t => {
    const f = await fixture(); t.after(() => rm(f.root, { recursive: true, force: true }));
    if (kind === 'missing-home') await rm(f.home, { recursive: true });
    if (kind === 'missing-relay') await rm(join(f.home, 'relay'), { recursive: true });
    if (kind === 'canary-path') f.options.home = join(f.root, 'CANARY_PRIVATE_PATH');
    await assert.rejects(inspectOwnedContainerStartup(f.options), error => {
      assert.match(String(error), /container_startup_unavailable/);
      assert.doesNotMatch(String(error), /ENOENT|EACCES|CANARY_PRIVATE_PATH/);
      assert.equal(String(error).includes(f.root), false);
      return true;
    });
  });
}

for (const running of [false, true, null]) {
  test(`inspection reads control running=${running} without creating lifecycle state`, posix, async t => {
    const f = await fixture(running); t.after(() => rm(f.root, { recursive: true, force: true }));
    const before = await f.snapshot();
    const result = await inspectOwnedContainerStartup(f.options);
    assert.equal(result.state, running === null ? 'unconfigured' : running ? 'resume_requested' : 'paused');
    assert.equal(result.registrationHash, running === null ? null : f.hash);
    assert.equal(result.version, running === null ? null : '0.2.211');
    assert.equal(result.ready, false); assert.equal(result.started, false);
    assert.equal(result.startupWrites, false); assert.equal(result.consumerStoreChecked, false);
    assert.equal(result.requiresSeparateLifecycleAdmission, true);
    assert.deepEqual(await f.snapshot(), before);
    assert.doesNotMatch(JSON.stringify(result), /launcher|workspace|privateKey|secret|\/repo/);
  });
}

for (const kind of ['orphan-control', 'missing-control', 'null-control', 'extra-secret', 'wrong-home', 'wrong-hash', 'oversized']) {
  test(`inspection rejects ${kind} without mutation or reflecting private input`, posix, async t => {
    const f = await fixture(); t.after(() => rm(f.root, { recursive: true, force: true }));
    if (kind === 'orphan-control') await rm(f.paths.registration);
    if (kind === 'missing-control') await rm(f.paths.control);
    if (kind === 'null-control') await writeFile(f.paths.control, 'null');
    if (kind === 'extra-secret') await writeFile(f.paths.control, JSON.stringify({ ...f.control, secret: 'CANARY_PRIVATE_INPUT' }));
    if (kind === 'wrong-home') await writeFile(f.paths.control, JSON.stringify({ ...f.control, home: '/foreign' }));
    if (kind === 'wrong-hash') await writeFile(f.paths.control, JSON.stringify({ ...f.control, registrationHash: '0'.repeat(64) }));
    if (kind === 'oversized') await writeFile(f.paths.control, 'CANARY_PRIVATE_INPUT'.repeat(2000));
    const before = await f.snapshot();
    await assert.rejects(inspectOwnedContainerStartup(f.options), error => {
      assert.match(String(error), /container_startup_unavailable/);
      assert.doesNotMatch(String(error), /CANARY_PRIVATE_INPUT/); return true;
    });
    assert.deepEqual(await f.snapshot(), before);
  });
}

for (const kind of ['home-mode', 'relay-mode', 'file-mode', 'file-symlink', 'relay-symlink']) {
  test(`inspection preserves private filesystem rejection for ${kind}`, posix, async t => {
    const f = await fixture(); t.after(() => rm(f.root, { recursive: true, force: true }));
    if (kind === 'home-mode') await chmod(f.home, 0o755);
    if (kind === 'relay-mode') await chmod(join(f.home, 'relay'), 0o755);
    if (kind === 'file-mode') await chmod(f.paths.control, 0o644);
    if (kind === 'file-symlink') {
      await rm(f.paths.control); await symlink(f.paths.registration, f.paths.control);
    }
    if (kind === 'relay-symlink') {
      const foreign = join(f.root, 'foreign'); await mkdir(foreign, { mode: 0o700 });
      await rm(join(f.home, 'relay'), { recursive: true }); await symlink(foreign, join(f.home, 'relay'));
    }
    await assert.rejects(inspectOwnedContainerStartup(f.options), /container_startup_unavailable/);
  });
}

for (const kind of ['normal-argv', 'extra-argv', 'root', 'foreign-uid', 'foreground']) {
  test(`inspection rejects noninspection process identity ${kind}`, posix, async t => {
    const f = await fixture(); t.after(() => rm(f.root, { recursive: true, force: true }));
    if (kind === 'normal-argv') f.identity.argv.pop();
    if (kind === 'extra-argv') f.identity.argv.push('--unexpected');
    if (kind === 'root') f.identity.uid = 0;
    if (kind === 'foreign-uid') f.identity.uid++;
    if (kind === 'foreground') f.identity.pid = 42;
    const before = await f.snapshot();
    await assert.rejects(inspectOwnedContainerStartup(f.options), /container_startup_unavailable/);
    assert.deepEqual(await f.snapshot(), before);
  });
}

test('inspection rejects a changed process identity after the bounded read', posix, async t => {
  const f = await fixture(); t.after(() => rm(f.root, { recursive: true, force: true }));
  let calls = 0;
  f.options.containerRuntime.identity = async () => ({ ...f.identity, startTicks: ++calls === 1 ? '12345' : '99999' });
  const before = await f.snapshot();
  await assert.rejects(inspectOwnedContainerStartup(f.options), /container_startup_unavailable/);
  assert.deepEqual(await f.snapshot(), before);
});

for (const kind of ['valid', 'unverified-init', 'adopted-child', 'wrong-session', 'normal-controller']) {
  test(`inspection authenticates Docker-init main child: ${kind}`, posix, async t => {
    const f = await fixture(); t.after(() => rm(f.root, { recursive: true, force: true }));
    const init: ContainerProcessIdentity = { pid: 1, uid: f.options.uid, parentPid: 0, startTicks: '111',
      processGroupId: 1, sessionId: 1, argv: ['/sbin/docker-init', '--', 'docker-entrypoint.sh', 'sleep', 'infinity'] };
    const controller: ContainerProcessIdentity = { ...f.identity, pid: 42, parentPid: 1, startTicks: '222',
      processGroupId: 42, sessionId: kind === 'wrong-session' ? 99 : 1,
      argv: kind === 'normal-controller' ? f.identity.argv.slice(0, 4) : f.identity.argv };
    const options = { ...f.options, containerRuntime: { ...f.options.containerRuntime,
      identity: async () => init, controllerIdentity: async () => controller, currentControllerPid: 42,
      dockerInitVerified: async () => kind !== 'unverified-init',
      dockerInitMainChild: async () => kind === 'adopted-child' ? 43 : 42,
      controllerExecutableVerified: async () => true } };
    const before = await f.snapshot();
    if (kind === 'valid') assert.equal((await inspectOwnedContainerStartup(options)).state, 'paused');
    else await assert.rejects(inspectOwnedContainerStartup(options), /container_startup_unavailable/);
    assert.deepEqual(await f.snapshot(), before);
  });
}
