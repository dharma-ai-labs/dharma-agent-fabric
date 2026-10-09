import assert from 'node:assert/strict';
import { chmod, copyFile, mkdir, mkdtemp, readFile, realpath, symlink, writeFile } from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';

test('Linux startup records npm explicitly instead of relying on the service PATH', async () => {
  const { stableRepositoryLauncherContents, recordedRepositoryNodeDirectory } = await import('./repositoryLaunchers.js');
  const runtime = { platform: 'linux' as const, nodeDirectory: '/approved/node/bin',
    npmCliPath: "/approved/npm ' tools/bin/npm-cli.js" };
  const launchers = stableRepositoryLauncherContents('0.2.177', runtime);
  assert.ok(launchers.shell.includes("exec '/approved/node/bin/node' '/approved/npm '\\'' tools/bin/npm-cli.js' exec --yes -- @dharma-ai-labs/agent-fabric@0.2.177"));
  assert.equal(recordedRepositoryNodeDirectory('0.2.177', launchers, 'linux'), runtime.nodeDirectory);
  assert.equal(recordedRepositoryNodeDirectory('0.2.177', { ...launchers,
    shell: launchers.shell.replace('npm-cli.js', 'unapproved.js') }, 'linux'), undefined);
  for (const npmCliPath of ['relative/npm-cli.js', '/approved/npm\n-cli.js', '/approved/npm\0-cli.js']) {
    assert.throws(() => stableRepositoryLauncherContents('0.2.177', { ...runtime, npmCliPath }));
  }
});

test('npm resolution validates the selected protected package without falling back from invalid state', async () => {
  const { resolveRepositoryNpmCli } = await import('./repositoryLaunchers.js');
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dharma-startup-npm-')));
  const bin = join(root, 'bin'); await mkdir(bin);
  const npmCliPath = join(bin, 'npm-cli.js');
  await writeFile(npmCliPath, 'synthetic npm entry', {mode: 0o600});
  await writeFile(join(root, 'package.json'), JSON.stringify({name: 'npm', bin: {npm: 'bin/npm-cli.js'}}), {mode: 0o600});
  assert.equal(await resolveRepositoryNpmCli({npmExecPath: npmCliPath, searchPath: ''}), npmCliPath);
  await assert.rejects(() => resolveRepositoryNpmCli({npmExecPath: join(bin, 'absent'), searchPath: ''}), /relay_startup_npm_unavailable/);
  await writeFile(join(root, 'package.json'), '{"name":"not-npm"}', {mode: 0o600});
  await assert.rejects(() => resolveRepositoryNpmCli({npmExecPath: npmCliPath, searchPath: ''}), /relay_startup_npm_unavailable/);
});

test('actual Linux launcher starts with no npm on PATH and preserves argument boundaries', {skip: process.platform !== 'linux'}, async () => {
  const {stableRepositoryLauncherContents, verifyRecordedRepositoryLaunchers, verifyRollbackRepositoryLaunchers} = await import('./repositoryLaunchers.js');
  const root = await realpath(await mkdtemp(join(tmpdir(), "dharma-npm ' startup-")));
  const bin = join(root, 'bin'); await mkdir(bin, {mode: 0o700});
  const npmCliPath = join(bin, 'npm-cli.js');
  await writeFile(npmCliPath, 'process.stdout.write(JSON.stringify(process.argv.slice(2)))', {mode: 0o600});
  await writeFile(join(root, 'package.json'), JSON.stringify({name: 'npm', bin: {npm: 'bin/npm-cli.js'}}), {mode: 0o600});
  const nodeDirectory = join(root, 'node-only'); await mkdir(nodeDirectory, {mode: 0o700});
  await copyFile(process.execPath, join(nodeDirectory, 'node')); await chmod(join(nodeDirectory, 'node'), 0o700);
  const runtime = {platform: 'linux' as const, nodeDirectory, npmCliPath};
  const old = join(root, 'old.sh'), fixed = join(root, 'fixed.sh');
  await writeFile(old, stableRepositoryLauncherContents('0.2.177', {platform: 'linux', nodeDirectory: runtime.nodeDirectory}).shell);
  const launchers = stableRepositoryLauncherContents('0.2.177', runtime);
  await writeFile(fixed, launchers.shell);
  const run = promisify(execFile), env = {PATH: join(root, 'absent'), HOME: root};
  await assert.rejects(run('/bin/sh', [old, 'status'], {env}), (error: unknown) => (error as {code: number}).code === 127);
  const result = await run('/bin/sh', [fixed, 'status', 'space and ; $argument'], {env});
  assert.deepEqual(JSON.parse(result.stdout), ['exec', '--yes', '--', '@dharma-ai-labs/agent-fabric@0.2.177', 'status', 'space and ; $argument']);
  assert.equal(await verifyRecordedRepositoryLaunchers('0.2.177', launchers,
    {platform: 'linux', nodePath: process.execPath, npmCliPath}), true);
  assert.equal(await verifyRecordedRepositoryLaunchers('0.2.177', launchers,
    {platform: 'linux', nodePath: process.execPath, npmCliPath: join(root, 'absent')}), false);
  assert.equal(await verifyRollbackRepositoryLaunchers('0.2.177', launchers), true);
  assert.equal(await verifyRollbackRepositoryLaunchers('0.2.177', {...launchers, shell: `${launchers.shell}# foreign\n`}), false);
  await chmod(npmCliPath, 0o666);
  assert.equal(await verifyRecordedRepositoryLaunchers('0.2.177', launchers,
    {platform: 'linux', nodePath: process.execPath, npmCliPath}), false);
  assert.equal(await verifyRollbackRepositoryLaunchers('0.2.177', launchers), false);
});

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
