import assert from 'node:assert/strict';
import { chmod, copyFile, mkdir, mkdtemp, readFile, realpath, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

test('a recorded pinned directory is accepted only for the identical protected Node binary', async () => {
  const { stableRepositoryLauncherContents, verifyRecordedRepositoryLaunchers } = await import('./repositoryLaunchers.js');
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dharma-recorded-node-')));
  const current = join(root, 'current'), prior = join(root, "prior ' node");
  await mkdir(current); await mkdir(prior);
  const name = process.platform === 'win32' ? 'node.exe' : 'node';
  const nodePath = join(current, name), recorded = join(prior, name);
  await writeFile(nodePath, 'qualified synthetic binary', { mode: 0o700 });
  await copyFile(nodePath, recorded); await chmod(recorded, 0o700);
  const runtime = { platform: process.platform, nodePath };
  const launchers = stableRepositoryLauncherContents('0.2.138', { platform: process.platform, nodeDirectory: prior });
  assert.equal(await verifyRecordedRepositoryLaunchers('0.2.138', launchers, runtime), true);
  for (const changed of [
    { ...launchers, shell: launchers.shell + 'echo extra\n' },
    { ...launchers, windows: launchers.windows + 'echo extra\r\n' },
    { ...launchers, shell: launchers.shell.replace('0.2.138', '0.2.139') },
    { ...launchers, shell: launchers.shell.replace('npm exec', 'sh exec') },
  ]) assert.equal(await verifyRecordedRepositoryLaunchers('0.2.138', changed, runtime), false);
  assert.equal(await verifyRecordedRepositoryLaunchers('invalid;command', launchers, runtime), false);
  await writeFile(recorded, 'unqualified synthetic data');
  assert.equal(await verifyRecordedRepositoryLaunchers('0.2.138', launchers, runtime), false);
  assert.equal(await readFile(nodePath, 'utf8'), 'qualified synthetic binary');
});

test('recorded binary protection, canonical paths and availability remain required', async () => {
  const { stableRepositoryLauncherContents, verifyRecordedRepositoryLaunchers } = await import('./repositoryLaunchers.js');
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dharma-recorded-node-')));
  const nodePath = join(root, process.platform === 'win32' ? 'node.exe' : 'node');
  await writeFile(nodePath, 'qualified synthetic binary', { mode: 0o700 });
  const runtime = { platform: process.platform, nodePath };
  const absent = stableRepositoryLauncherContents('0.2.138', { platform: process.platform, nodeDirectory: join(root, 'absent') });
  assert.equal(await verifyRecordedRepositoryLaunchers('0.2.138', absent, runtime), false);
  const alias = join(root, 'alias');
  await symlink(root, alias, process.platform === 'win32' ? 'junction' : 'dir');
  const aliased = stableRepositoryLauncherContents('0.2.138', { platform: process.platform, nodeDirectory: alias });
  assert.equal(await verifyRecordedRepositoryLaunchers('0.2.138', aliased, runtime), false);
  if (process.platform !== 'win32') {
    const linkDirectory = join(root, 'linked');
    await mkdir(linkDirectory);
    await symlink(nodePath, join(linkDirectory, 'node'));
    const linked = stableRepositoryLauncherContents('0.2.138', { platform: process.platform, nodeDirectory: linkDirectory });
    assert.equal(await verifyRecordedRepositoryLaunchers('0.2.138', linked, runtime), false);
    await chmod(nodePath, 0o722);
    const writable = stableRepositoryLauncherContents('0.2.138', { platform: process.platform, nodeDirectory: root });
    assert.equal(await verifyRecordedRepositoryLaunchers('0.2.138', writable, runtime), false);
  }
});

test('a changed Node binary with identical size is not a trusted runtime', async () => {
  const { stableRepositoryLauncherContents, verifyRecordedRepositoryLaunchers } = await import('./repositoryLaunchers.js');
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dharma-recorded-node-')));
  const prior = join(root, 'prior'); await mkdir(prior);
  const name = process.platform === 'win32' ? 'node.exe' : 'node';
  const nodePath = join(root, name);
  await writeFile(nodePath, Buffer.alloc(128, 1), { mode: 0o700 });
  await writeFile(join(prior, name), Buffer.alloc(128, 2), { mode: 0o700 });
  const launchers = stableRepositoryLauncherContents('0.2.138', { platform: process.platform, nodeDirectory: prior });
  assert.equal(await verifyRecordedRepositoryLaunchers('0.2.138', launchers, { platform: process.platform, nodePath }), false);
});

test('an alternate Node directory cannot shadow npm or other startup executables', async () => {
  const { stableRepositoryLauncherContents, verifyRecordedRepositoryLaunchers } = await import('./repositoryLaunchers.js');
  for (const injected of ['npm', 'npm.cmd', 'sh', 'unapproved']) {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'dharma-recorded-node-')));
    const prior = join(root, 'prior'); await mkdir(prior);
    const name = process.platform === 'win32' ? 'node.exe' : 'node', nodePath = join(root, name);
    await writeFile(nodePath, 'qualified synthetic binary', { mode: 0o700 });
    await copyFile(nodePath, join(prior, name)); await chmod(join(prior, name), 0o700);
    await writeFile(join(prior, injected), 'unapproved PATH entry');
    const launchers = stableRepositoryLauncherContents('0.2.138', { platform: process.platform, nodeDirectory: prior });
    assert.equal(await verifyRecordedRepositoryLaunchers('0.2.138', launchers, { platform: process.platform, nodePath }), false);
  }
});

test('pinned runtime grammar round trips POSIX quotes and Windows percent characters', async () => {
  const { stableRepositoryLauncherContents, recordedRepositoryNodeDirectory } = await import('./repositoryLaunchers.js');
  for (const runtime of [{ platform: 'linux' as const, nodeDirectory: "/approved/a ' b/bin" },
    { platform: 'win32' as const, nodeDirectory: 'C:\\approved\\%pinned%\\bin' }]) {
    const contents = stableRepositoryLauncherContents('0.2.138', runtime);
    assert.equal(recordedRepositoryNodeDirectory('0.2.138', contents, runtime.platform), runtime.nodeDirectory);
    assert.equal(recordedRepositoryNodeDirectory('0.2.139', contents, runtime.platform), undefined);
    assert.equal(recordedRepositoryNodeDirectory('0.2.138', { ...contents, windows: contents.windows + 'extra' }, runtime.platform), undefined);
  }
});
