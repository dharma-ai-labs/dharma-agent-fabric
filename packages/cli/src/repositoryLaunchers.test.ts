import assert from 'node:assert/strict';
import { chmod, chown, copyFile, lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import { tmpdir, userInfo } from 'node:os';
import { dirname, join, relative } from 'node:path';
import test from 'node:test';

test('new Linux launchers privately create package files without changing historical rollback bytes', async () => {
  const {stableRepositoryLauncherContents, recordedRepositoryNodeDirectory} = await import('./repositoryLaunchers.js');
  const runtime = {platform: 'linux' as const, nodeDirectory: '/approved/node/bin',
    npmCliPath: '/approved/npm/bin/npm-cli.js', providerDirectory: '/approved/codex/bin'};
  for (const version of ['0.2.206', '0.2.206-canary.1', '0.3.0', '1.0.0']) {
    const contents = stableRepositoryLauncherContents(version, runtime);
    assert.ok(contents.shell.includes('\numask 077\nexec '));
    assert.ok(contents.shell.includes(` exec --yes --umask=077 -- @dharma-ai-labs/agent-fabric@${version} `));
    assert.equal(recordedRepositoryNodeDirectory(version, contents, 'linux'), runtime.nodeDirectory);
    for (const shell of [contents.shell.replace('umask 077\n', ''),
      contents.shell.replace('umask 077\n', 'umask 002\n'), contents.shell.replace('--umask=077 ', ''),
      contents.shell.replace('--umask=077 ', '--umask=002 '), contents.shell + 'echo foreign\n']) {
      assert.equal(recordedRepositoryNodeDirectory(version, {...contents, shell}, 'linux'), undefined);
    }
  }
  for (const version of ['0.2.138', '0.2.180', '0.2.204', '0.2.205']) {
    const contents = stableRepositoryLauncherContents(version, runtime);
    assert.deepEqual(contents, {
      shell: `#!/bin/sh\nexport PATH='/approved/node/bin':"$PATH"\nexport PATH='/approved/codex/bin':"$PATH"\nexec '/approved/node/bin/node' '/approved/npm/bin/npm-cli.js' exec --yes -- @dharma-ai-labs/agent-fabric@${version} "$@"\n`,
      windows: `@echo off\r\nnpm exec --yes -- @dharma-ai-labs/agent-fabric@${version} %*\r\n`,
    });
    assert.equal(recordedRepositoryNodeDirectory(version, contents, 'linux'), runtime.nodeDirectory);
  }
  const unpinned = stableRepositoryLauncherContents('0.2.206');
  assert.ok(unpinned.shell.includes('\numask 077\nexec npm exec --yes --umask=077 -- '));
  const windows = stableRepositoryLauncherContents('0.2.206', {platform: 'win32', nodeDirectory: 'C:\\approved\\node'});
  assert.ok(!windows.windows.includes('umask'));
  assert.ok(windows.windows.endsWith('npm exec --yes -- @dharma-ai-labs/agent-fabric@0.2.206 %*\r\n'));
});

test('new Linux launcher overrides a permissive parent umask before invoking npm', {skip: process.platform !== 'linux'}, async () => {
  const {stableRepositoryLauncherContents, verifyRollbackRepositoryLaunchers} = await import('./repositoryLaunchers.js');
  const root = await realpath(await mkdtemp(join(tmpdir(), "fabric-private-launcher ' ")));
  const nodeDirectory = join(root, 'node'), npmDirectory = join(root, 'npm');
  await mkdir(nodeDirectory, {mode: 0o700});
  await mkdir(join(npmDirectory, 'bin'), {recursive: true, mode: 0o700});
  await copyFile(process.execPath, join(nodeDirectory, 'node')); await chmod(join(nodeDirectory, 'node'), 0o700);
  const npmCliPath = join(npmDirectory, 'bin', 'npm-cli.js');
  await writeFile(join(npmDirectory, 'package.json'), JSON.stringify({name: 'npm', bin: {npm: 'bin/npm-cli.js'}}), {mode: 0o600});
  await writeFile(npmCliPath, "const fs=require('node:fs');fs.mkdirSync('fresh-package',{mode:0o777});fs.writeFileSync('fresh-package/index.js','public fixture',{mode:0o666});process.stdout.write(JSON.stringify({umask:process.umask(),argv:process.argv.slice(2),mode:fs.statSync('fresh-package/index.js').mode&0o777,directoryMode:fs.statSync('fresh-package').mode&0o777}));", {mode: 0o600});
  const contents = stableRepositoryLauncherContents('0.2.206', {platform: 'linux', nodeDirectory, npmCliPath});
  const launcher = join(root, 'launcher.sh'); await writeFile(launcher, contents.shell, {mode: 0o700});
  try {
    const run = promisify(execFile);
    const output = JSON.parse((await run('/bin/sh', ['-c', 'umask 002; exec /bin/sh "$1" status "$2"',
      'fixture', launcher, 'space and ; $argument'], {cwd: root, env: {PATH: '/usr/bin:/bin', HOME: root, npm_config_umask: '002'}})).stdout);
    assert.equal(output.umask, 0o077);
    assert.equal(output.mode, 0o600);
    assert.equal(output.directoryMode, 0o700);
    assert.deepEqual(output.argv, ['exec', '--yes', '--umask=077', '--', '@dharma-ai-labs/agent-fabric@0.2.206', 'status', 'space and ; $argument']);
    assert.equal(await verifyRollbackRepositoryLaunchers('0.2.206', contents), true);
  } finally {await rm(root, {recursive: true, force: true});}
});

test('Linux launcher retains the selected Codex directory without copying the ambient environment', async () => {
  const {stableRepositoryLauncherContents, recordedRepositoryNodeDirectory} = await import('./repositoryLaunchers.js');
  const runtime = {platform: 'linux' as const, nodeDirectory: '/approved/node/bin',
    npmCliPath: '/approved/npm/bin/npm-cli.js', providerDirectory: "/approved/codex ' tools/bin"};
  const launchers = stableRepositoryLauncherContents('0.2.180', runtime);
  assert.ok(launchers.shell.includes("export PATH='/approved/codex '\\'' tools/bin':\"$PATH\"\n"));
  assert.ok(launchers.shell.indexOf("export PATH='/approved/node/bin'") < launchers.shell.indexOf('codex'));
  assert.equal(recordedRepositoryNodeDirectory('0.2.180', launchers, 'linux'), runtime.nodeDirectory);
  assert.equal(recordedRepositoryNodeDirectory('0.2.180', {...launchers,
    shell: launchers.shell.replace('codex', 'codex\nunsafe')}, 'linux'), undefined);
  for (const providerDirectory of ['relative/bin', '/approved/bin:foreign', '/approved/bin\nunsafe', '/']) {
    assert.throws(() => stableRepositoryLauncherContents('0.2.180', {...runtime, providerDirectory}));
  }
});

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

test('Codex startup resolution is protected and does not skip an unsafe first executable', {skip: process.platform !== 'linux'}, async () => {
  const {resolveRepositoryProviderDirectory} = await import('./repositoryLaunchers.js');
  const root = await realpath(await mkdtemp(join(tmpdir(), 'fabric-codex-startup-')));
  const good = join(root, 'good'), unsafe = join(root, 'unsafe');
  await mkdir(good, {mode: 0o700}); await mkdir(unsafe, {mode: 0o700});
  const binary = join(good, 'codex');
  await writeFile(binary, '#!/bin/sh\nprintf "fixture-codex\\n"\n', {mode: 0o700});
  await symlink(binary, join(unsafe, 'codex'));
  assert.equal(await resolveRepositoryProviderDirectory({searchPath: join(root, 'absent') + ':' + good}), good);
  assert.equal(await resolveRepositoryProviderDirectory({searchPath: ''}), undefined);
  await assert.rejects(resolveRepositoryProviderDirectory({searchPath: relative(process.cwd(), good) + ':' + good}),
    /relay_startup_codex_path_invalid/);
  await chmod(unsafe, 0o777);
  await assert.rejects(resolveRepositoryProviderDirectory({searchPath: unsafe + ':' + good}),
    /^Error: relay_startup_codex_path_invalid: .*Put your own codex first on PATH, or remove the other one from PATH\. If you set up another provider, pass --provider <codex\|claude\|agy\|hermes>\.$/);
  await chmod(binary, 0o722);
  await assert.rejects(resolveRepositoryProviderDirectory({searchPath: good}), /relay_startup_codex_path_invalid/);
  await chmod(binary, 0o700);
  await chmod(root, 0o777);
  await assert.rejects(resolveRepositoryProviderDirectory({searchPath: good}), /relay_startup_codex_path_invalid/);
  await chmod(root, 0o700);
});

test('actual Linux service-style startup retains Codex with a minimal inherited PATH', {skip: process.platform !== 'linux'}, async () => {
  const {stableRepositoryLauncherContents, verifyRecordedRepositoryLaunchers, verifyRollbackRepositoryLaunchers,
    resolveRepositoryProviderDirectory} = await import('./repositoryLaunchers.js');
  const root = await realpath(await mkdtemp(join(tmpdir(), "fabric-codex ' startup-")));
  const nodeDirectory = join(root, 'node'), npmDirectory = join(root, 'npm'), providerDirectory = join(root, 'provider');
  for (const directory of [nodeDirectory, npmDirectory, providerDirectory]) await mkdir(directory, {mode: 0o700});
  await copyFile(process.execPath, join(nodeDirectory, 'node')); await chmod(join(nodeDirectory, 'node'), 0o700);
  const npmCliPath = join(npmDirectory, 'bin', 'npm-cli.js'); await mkdir(dirname(npmCliPath), {mode: 0o700});
  await writeFile(join(npmDirectory, 'package.json'), JSON.stringify({name: 'npm', bin: {npm: 'bin/npm-cli.js'}}), {mode: 0o600});
  await writeFile(npmCliPath, "const r=require('node:child_process').spawnSync('codex',['--version'],{encoding:'utf8'});process.stdout.write(JSON.stringify({status:r.status,stdout:r.stdout}));", {mode: 0o600});
  await writeFile(join(providerDirectory, 'codex'), '#!/bin/sh\nprintf "fixture-codex\\n"\n', {mode: 0o700});
  const runtime = {platform: 'linux' as const, nodeDirectory, npmCliPath, providerDirectory};
  const old = join(root, 'old.sh'), fixed = join(root, 'fixed.sh');
  await writeFile(old, stableRepositoryLauncherContents('0.2.180', {...runtime, providerDirectory: undefined}).shell);
  const launchers = stableRepositoryLauncherContents('0.2.180', runtime); await writeFile(fixed, launchers.shell);
  const run = promisify(execFile), env = {PATH: join(root, 'absent'), HOME: root, UNRELATED_SECRET: 'not-in-launcher'};
  const before = JSON.parse((await run('/bin/sh', [old], {env})).stdout);
  assert.equal(before.status, null);
  await writeFile(join(nodeDirectory, 'codex'), '#!/bin/sh\nprintf "wrong-node-directory-codex\\n"\n', {mode: 0o700});
  assert.deepEqual(JSON.parse((await run('/bin/sh', [fixed], {env})).stdout), {status: 0, stdout: 'fixture-codex\n'});
  await rm(join(nodeDirectory, 'codex'));
  assert.ok(!launchers.shell.includes('UNRELATED_SECRET') && !launchers.shell.includes('not-in-launcher'));
  assert.equal(await verifyRecordedRepositoryLaunchers('0.2.180', launchers, {platform: 'linux', nodePath: process.execPath, npmCliPath}), true);
  assert.equal(await verifyRollbackRepositoryLaunchers('0.2.180', launchers), true);
  const shadow = join(providerDirectory, 'node');
  await writeFile(shadow, '#!/bin/sh\nprintf "unapproved-node\\n"\n', {mode: 0o700});
  const envNode = '/usr/bin/env node\n';
  const shebang = join(root, 'child');
  await writeFile(shebang, '#!' + envNode + 'console.log(process.version);\n', {mode: 0o700});
  await writeFile(npmCliPath, `const r=require('node:child_process').spawnSync(${JSON.stringify(shebang)},[],{encoding:'utf8'});process.stdout.write(JSON.stringify({status:r.status,stdout:r.stdout}));`, {mode: 0o600});
  assert.deepEqual(JSON.parse((await run('/bin/sh', [fixed], {env})).stdout), {status: 0, stdout: 'unapproved-node\n'});
  await assert.rejects(resolveRepositoryProviderDirectory({searchPath: providerDirectory}), /relay_startup_codex_path_invalid/);
  assert.equal(await verifyRecordedRepositoryLaunchers('0.2.180', launchers, {platform: 'linux', nodePath: process.execPath, npmCliPath}), false);
  assert.equal(await verifyRollbackRepositoryLaunchers('0.2.180', launchers), false);
  await copyFile(process.execPath, shadow); await chmod(shadow, 0o700);
  assert.equal(await resolveRepositoryProviderDirectory({searchPath: providerDirectory}), providerDirectory);
  assert.deepEqual(JSON.parse((await run('/bin/sh', [fixed], {env})).stdout), {status: 0, stdout: process.version + '\n'});
  assert.equal(await verifyRecordedRepositoryLaunchers('0.2.180', launchers, {platform: 'linux', nodePath: process.execPath, npmCliPath}), true);
  assert.equal(await verifyRollbackRepositoryLaunchers('0.2.180', launchers), true);
  await rm(shadow);
  await chmod(join(providerDirectory, 'codex'), 0o722);
  assert.equal(await verifyRecordedRepositoryLaunchers('0.2.180', launchers, {platform: 'linux', nodePath: process.execPath, npmCliPath}), false);
  assert.equal(await verifyRollbackRepositoryLaunchers('0.2.180', launchers), false);
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

// F13 C1 (2026-11-06): setup under Claude Code resolved claude from ~/.npm-global/bin, but the
// service started with the user manager PATH, found another user's codex and no claude at all.
test('startup resolution selects the set-up provider and ignores an unsafe Codex earlier on PATH', {skip: process.platform !== 'linux'}, async () => {
  const launchers: Record<string, any> = await import('./repositoryLaunchers.js');
  const root = await realpath(await mkdtemp(join(tmpdir(), 'fabric-provider-startup-')));
  try {
    const foreign = join(root, 'foreign'), own = join(root, 'own');
    await mkdir(foreign, {mode: 0o700}); await mkdir(own, {mode: 0o700});
    await writeFile(join(foreign, 'codex'), '#!/bin/sh\nprintf "foreign-codex\n"\n', {mode: 0o700});
    await chmod(foreign, 0o777);
    await writeFile(join(own, 'claude'), '#!/bin/sh\nprintf "own-claude\n"\n', {mode: 0o700});
    assert.equal(typeof launchers.resolveRepositoryProviderDirectory, 'function');
    const resolveProvider = launchers.resolveRepositoryProviderDirectory as
      (options: {provider: string; searchPath: string}) => Promise<string | undefined>;
    assert.equal(await resolveProvider({provider: 'claude', searchPath: `${foreign}:${own}`}), own);
    await assert.rejects(resolveProvider({provider: 'codex', searchPath: `${foreign}:${own}`}),
      /^Error: relay_startup_codex_path_invalid: .*Put your own codex first on PATH/);
    await chmod(join(own, 'claude'), 0o722);
    await assert.rejects(resolveProvider({provider: 'claude', searchPath: own}),
      /^Error: relay_startup_claude_path_invalid: .*Put your own claude first on PATH, or remove the other one from PATH\. If you set up another provider, pass --provider <codex\|claude\|agy\|hermes>\.$/);
  } finally {await chmod(join(root, 'foreign'), 0o700).catch(() => {}); await rm(root, {recursive: true, force: true});}
});

test('actual Linux service-style startup finds the set-up Claude provider with a minimal inherited PATH', {skip: process.platform !== 'linux'}, async () => {
  const launchers: Record<string, any> = await import('./repositoryLaunchers.js');
  const root = await realpath(await mkdtemp(join(tmpdir(), 'fabric-claude-startup-')));
  try {
    const nodeDirectory = join(root, 'node'), npmDirectory = join(root, 'npm'), providerDirectory = join(root, 'npm-global', 'bin');
    for (const directory of [nodeDirectory, npmDirectory, providerDirectory]) await mkdir(directory, {recursive: true, mode: 0o700});
    await copyFile(process.execPath, join(nodeDirectory, 'node')); await chmod(join(nodeDirectory, 'node'), 0o700);
    const npmCliPath = join(npmDirectory, 'bin', 'npm-cli.js'); await mkdir(dirname(npmCliPath), {mode: 0o700});
    await writeFile(join(npmDirectory, 'package.json'), JSON.stringify({name: 'npm', bin: {npm: 'bin/npm-cli.js'}}), {mode: 0o600});
    await writeFile(npmCliPath, "const r=require('node:child_process').spawnSync('claude',['--version'],{encoding:'utf8'});process.stdout.write(JSON.stringify({status:r.status,stdout:r.stdout}));", {mode: 0o600});
    await writeFile(join(providerDirectory, 'claude'), '#!/bin/sh\nprintf "fixture-claude\n"\n', {mode: 0o700});
    const resolved = await launchers.resolveRepositoryProviderDirectory?.({provider: 'claude', searchPath: providerDirectory});
    assert.equal(resolved, providerDirectory);
    const runtime = {platform: 'linux' as const, nodeDirectory, npmCliPath, providerDirectory: resolved};
    const before = stableLauncher(launchers, {...runtime, providerDirectory: undefined});
    const after = stableLauncher(launchers, runtime);
    const run = promisify(execFile), env = {PATH: join(root, 'absent'), HOME: root};
    await writeFile(join(root, 'before.sh'), before.shell); await writeFile(join(root, 'after.sh'), after.shell);
    assert.equal(JSON.parse((await run('/bin/sh', [join(root, 'before.sh')], {env})).stdout).status, null);
    assert.deepEqual(JSON.parse((await run('/bin/sh', [join(root, 'after.sh')], {env})).stdout), {status: 0, stdout: 'fixture-claude\n'});
    assert.equal(await launchers.verifyRecordedRepositoryLaunchers('0.2.224', after, {platform: 'linux', nodePath: process.execPath, npmCliPath}), true);
    assert.equal(await launchers.verifyRollbackRepositoryLaunchers('0.2.224', after), true);
    await chmod(join(providerDirectory, 'claude'), 0o722);
    assert.equal(await launchers.verifyRollbackRepositoryLaunchers('0.2.224', after), false);
  } finally {await rm(root, {recursive: true, force: true});}
});

// PR #425 review (4): a directory holding both codex and claude was verified for codex, the first command in it.
test('recorded-launcher verification checks the set-up provider, else accepts any protected provider command', {skip: process.platform !== 'linux'}, async () => {
  const launchers: Record<string, any> = await import('./repositoryLaunchers.js');
  const root = await realpath(await mkdtemp(join(tmpdir(), 'fabric-shared-bin-')));
  try {
    const nodeDirectory = join(root, 'node'), npmDirectory = join(root, 'npm'), providerDirectory = join(root, 'bin');
    for (const directory of [nodeDirectory, npmDirectory, providerDirectory]) await mkdir(directory, {recursive: true, mode: 0o700});
    await copyFile(process.execPath, join(nodeDirectory, 'node')); await chmod(join(nodeDirectory, 'node'), 0o700);
    const npmCliPath = join(npmDirectory, 'bin', 'npm-cli.js'); await mkdir(dirname(npmCliPath), {mode: 0o700});
    await writeFile(join(npmDirectory, 'package.json'), JSON.stringify({name: 'npm', bin: {npm: 'bin/npm-cli.js'}}), {mode: 0o600});
    await writeFile(npmCliPath, 'synthetic npm entry', {mode: 0o600});
    await writeFile(join(providerDirectory, 'codex'), '#!/bin/sh\nprintf "group-writable-codex\\n"\n', {mode: 0o700});
    await chmod(join(providerDirectory, 'codex'), 0o722);
    await writeFile(join(providerDirectory, 'claude'), '#!/bin/sh\nprintf "own-claude\\n"\n', {mode: 0o700});
    const after = stableLauncher(launchers, {platform: 'linux', nodeDirectory, npmCliPath, providerDirectory});
    const verify = (provider?: string) => launchers.verifyRecordedRepositoryLaunchers('0.2.224', after,
      {platform: 'linux', nodePath: process.execPath, npmCliPath, ...(provider ? {provider} : {})});
    assert.equal(await verify('claude'), true);
    assert.equal(await verify('codex'), false);
    assert.equal(await verify(), true, 'with no set-up provider known, a protected provider command is enough');
    assert.equal(await launchers.verifyRollbackRepositoryLaunchers('0.2.224', after, 'claude'), true);
    assert.equal(await launchers.verifyRollbackRepositoryLaunchers('0.2.224', after, 'codex'), false);
    await chmod(join(providerDirectory, 'claude'), 0o722);
    assert.equal(await verify(), false);
  } finally {await rm(root, {recursive: true, force: true});}
});

function stableLauncher(launchers: Record<string, any>, runtime: Record<string, unknown>): {shell: string; windows: string} {
  return launchers.stableRepositoryLauncherContents('0.2.224', runtime);
}

// PR #425 fix round 2 (2): the launcher carried only the provider being set up, so setting up codex after claude in
// one checkout, or relay upgrade with providerIds [claude, codex], dropped the other provider's bin directory.
test('Linux launcher carries the bin directory of every set-up provider, the first one first on PATH', async () => {
  const launchers: Record<string, any> = await import('./repositoryLaunchers.js');
  const runtime = {platform: 'linux' as const, nodeDirectory: '/approved/node/bin', npmCliPath: '/approved/npm/bin/npm-cli.js'};
  const single = launchers.stableRepositoryLauncherContents('0.2.224', {...runtime, providerDirectory: '/approved/claude/bin'});
  assert.deepEqual(launchers.stableRepositoryLauncherContents('0.2.224', {...runtime, providerDirectory: ['/approved/claude/bin']}), single,
    'one directory keeps the bytes written before');
  const both = launchers.stableRepositoryLauncherContents('0.2.224',
    {...runtime, providerDirectory: ['/approved/claude/bin', '/approved/codex/bin']});
  assert.ok(both.shell.startsWith(`#!/bin/sh\nexport PATH='/approved/node/bin':"$PATH"\n`
    + `export PATH='/approved/codex/bin':"$PATH"\nexport PATH='/approved/claude/bin':"$PATH"\n`));
  assert.equal(launchers.recordedRepositoryNodeDirectory('0.2.224', both, 'linux'), '/approved/node/bin');
  assert.throws(() => launchers.stableRepositoryLauncherContents('0.2.224',
    {...runtime, providerDirectory: ['/approved/codex/bin', '/approved/codex/bin']}), /relay_startup_provider_path_invalid/);
  assert.throws(() => launchers.stableRepositoryLauncherContents('0.2.224', {...runtime, providerDirectory: []}),
    /relay_startup_provider_path_invalid/);
  assert.equal(typeof launchers.providerDirectoriesInPathOrder, 'function');
  assert.deepEqual(launchers.providerDirectoriesInPathOrder(['/b', undefined, '/a', '/b'], '/x:/a:/b'), ['/a', '/b'],
    'directories keep the order of the PATH each provider was resolved from');
});

test('actual Linux launcher with two set-up providers reaches both and verifies each directory', {skip: process.platform !== 'linux'}, async () => {
  const launchers: Record<string, any> = await import('./repositoryLaunchers.js');
  const root = await realpath(await mkdtemp(join(tmpdir(), 'fabric-two-providers-')));
  try {
    const nodeDirectory = join(root, 'node'), npmDirectory = join(root, 'npm');
    const claudeDirectory = join(root, 'local', 'bin'), codexDirectory = join(root, 'npm-global', 'bin');
    for (const directory of [nodeDirectory, npmDirectory, claudeDirectory, codexDirectory]) await mkdir(directory, {recursive: true, mode: 0o700});
    await copyFile(process.execPath, join(nodeDirectory, 'node')); await chmod(join(nodeDirectory, 'node'), 0o700);
    const npmCliPath = join(npmDirectory, 'bin', 'npm-cli.js'); await mkdir(dirname(npmCliPath), {mode: 0o700});
    await writeFile(join(npmDirectory, 'package.json'), JSON.stringify({name: 'npm', bin: {npm: 'bin/npm-cli.js'}}), {mode: 0o600});
    await writeFile(npmCliPath, "const c=require('node:child_process');process.stdout.write(JSON.stringify(['claude','codex'].map(n=>c.spawnSync(n,[],{encoding:'utf8'}).stdout)));", {mode: 0o600});
    await writeFile(join(claudeDirectory, 'claude'), '#!/bin/sh\nprintf "own-claude"\n', {mode: 0o700});
    await writeFile(join(codexDirectory, 'codex'), '#!/bin/sh\nprintf "own-codex"\n', {mode: 0o700});
    const searchPath = `${claudeDirectory}:${codexDirectory}`;
    const resolved = await Promise.all(['codex', 'claude'].map(provider => launchers.resolveRepositoryProviderDirectory({provider, searchPath})));
    const providerDirectory = launchers.providerDirectoriesInPathOrder(resolved, searchPath);
    assert.deepEqual(providerDirectory, [claudeDirectory, codexDirectory]);
    const after = launchers.stableRepositoryLauncherContents('0.2.224', {platform: 'linux', nodeDirectory, npmCliPath, providerDirectory});
    await writeFile(join(root, 'after.sh'), after.shell);
    const {stdout} = await promisify(execFile)('/bin/sh', [join(root, 'after.sh')], {env: {PATH: join(root, 'absent'), HOME: root}});
    assert.deepEqual(JSON.parse(stdout), ['own-claude', 'own-codex'], 'the relay reaches both set-up providers');
    const verify = () => launchers.verifyRecordedRepositoryLaunchers('0.2.224', after, {platform: 'linux', nodePath: process.execPath, npmCliPath});
    assert.equal(await verify(), true);
    assert.equal(await launchers.verifyRollbackRepositoryLaunchers('0.2.224', after, ['claude', 'codex']), true);
    assert.equal(await launchers.verifyRollbackRepositoryLaunchers('0.2.224', after, ['claude']), false,
      'each directory must hold a set-up provider');
    await chmod(join(codexDirectory, 'codex'), 0o722);
    assert.equal(await verify(), false, 'every recorded directory is checked, not only the first');
    assert.equal(await launchers.verifyRollbackRepositoryLaunchers('0.2.224', after, ['claude', 'codex']), false);
  } finally {await rm(root, {recursive: true, force: true});}
});

// PR #424 review F3 (3x6=18): the relay guard applied setup's mode rule, which refused any group-writable entry.
// Stock Ubuntu login sessions use umask 0002 with a private group per user, so a claude installed under ~ has 0775
// directories that only this user can write. 0.2.223 ran it; 0.2.224 stopped. A group-writable entry is accepted
// only when its group is this user's own private group; world-writable entries and shared groups stay refused.
type AccountFiles = {group: string; passwd: string; groupLookup?: (gid: number) => Promise<string | undefined>};
type ProviderPathChecks = {
  providerFirstOnPathUnsafe(provider: string, options: {searchPath?: string; accounts?: AccountFiles}): Promise<boolean>;
  resolveRepositoryProviderDirectory(options: {provider?: string; searchPath?: string; accounts?: AccountFiles}): Promise<string | undefined>;
  providerUnsafePathDiagnosis(provider: string, options: {searchPath?: string; accounts?: AccountFiles}):
    Promise<{path: string; remedy: string} | null>;
};

async function privateGroupHost(run: (host: {root: string; local: string; bin: string;
  accounts(group: string, otherUsers?: string): Promise<AccountFiles>}) => Promise<void>) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'fabric-private-group-')));
  try {
    const user = userInfo().username, uid = process.getuid!(), gid = process.getgid!();
    // As a native Claude install under umask 0002 leaves it: ~/.local and its bin directory are 0775.
    const local = join(root, 'local'), bin = join(local, 'bin');
    await mkdir(bin, {recursive: true});
    await chmod(local, 0o775); await chmod(bin, 0o775);
    await writeFile(join(bin, 'claude'), '#!/bin/sh\nexit 0\n'); await chmod(join(bin, 'claude'), 0o775);
    await run({root, local, bin, accounts: async (group, otherUsers = '') => {
      await writeFile(join(root, 'group'), `root:x:0:\n${group.replace(/<user>/g, user).replace('<gid>', String(gid))}\n`);
      await writeFile(join(root, 'passwd'),
        `root:x:0:0:root:/root:/bin/sh\n${user}:x:${uid}:${gid}::${root}:/bin/sh\n${otherUsers.replace('<gid>', String(gid))}`);
      return {group: join(root, 'group'), passwd: join(root, 'passwd')};
    }});
  } finally {await rm(root, {recursive: true, force: true});}
}

test('relay guard and setup accept a 0775 provider tree whose group is the user\'s own private group', {skip: process.platform !== 'linux'}, async () => {
  const launchers = await import('./repositoryLaunchers.js' as string) as ProviderPathChecks;
  await privateGroupHost(async ({bin, accounts}) => {
    const own = await accounts('<user>:x:<gid>:');
    assert.equal(await launchers.providerFirstOnPathUnsafe('claude', {searchPath: bin, accounts: own}), false);
    assert.equal(await launchers.resolveRepositoryProviderDirectory({provider: 'claude', searchPath: bin, accounts: own}), bin);
    assert.equal(await launchers.providerUnsafePathDiagnosis('claude', {searchPath: bin, accounts: own}), null);
  });
});

test('a group-writable provider tree stays refused when the group is shared or the entry is world-writable', {skip: process.platform !== 'linux'}, async () => {
  const launchers = await import('./repositoryLaunchers.js' as string) as ProviderPathChecks;
  await privateGroupHost(async ({bin, accounts}) => {
    // Each case writes the account files just before its checks, as all cases share one pair of files.
    for (const [groups, otherUsers] of [
      ['<user>:x:<gid>:alice', ''], // another member
      ['staff:x:<gid>:', ''], // not named after the user
      ['<user>:x:<gid>:', 'alice:x:4242:<gid>::/home/alice:/bin/sh\n'], // another user's primary group
      ['other:x:1:', ''], // the group is not listed at all
    ] as const) {
      const shared = await accounts(groups, otherUsers);
      assert.equal(await launchers.providerFirstOnPathUnsafe('claude', {searchPath: bin, accounts: shared}), true);
      await assert.rejects(launchers.resolveRepositoryProviderDirectory({provider: 'claude', searchPath: bin, accounts: shared}),
        /^Error: relay_startup_claude_path_invalid: /);
    }
    const own = await accounts('<user>:x:<gid>:');
    await chmod(bin, 0o777);
    assert.equal(await launchers.providerFirstOnPathUnsafe('claude', {searchPath: bin, accounts: own}), true);
    await chmod(bin, 0o775); await chmod(join(bin, 'claude'), 0o777);
    assert.equal(await launchers.providerFirstOnPathUnsafe('claude', {searchPath: bin, accounts: own}), true);
  });
});

// CLI 0.2.224 review C1 (2x4=8): the devcontainers node feature puts nvm in /usr/local/share/nvm, owned USER:nvm with
// g+rws under umask 0002, and adds only this user to the group nvm. Each version's bin directory is then writable by a
// group other than the user's primary one, so the F3 rule refused claude, agy and hermes installed there by npm -g,
// which 0.2.223 ran. A supplementary group of this user is private in effect, and accepted, when /etc/group lists no
// member but this user and no /etc/passwd entry has it as primary group. A group with another member stays refused.
// N2 (1x8): an empty member list counted as private too; a supplementary group must list this user, and only them.
test('relay guard and setup accept a group-writable provider tree whose supplementary group has no other member', {skip: process.platform !== 'linux'}, async t => {
  const launchers = await import('./repositoryLaunchers.js' as string) as ProviderPathChecks;
  const supplementary = process.getgroups!().find(gid => gid !== process.getgid!() && gid !== 0);
  if (supplementary === undefined) {t.skip('this user has no supplementary group'); return;}
  await privateGroupHost(async ({root, accounts}) => {
    const share = join(root, 'share'), nvm = join(share, 'nvm'), versionBin = join(nvm, 'versions', 'node', 'v22', 'bin');
    const pkg = join(nvm, 'versions', 'node', 'v22', 'lib', 'node_modules', '@anthropic-ai', 'claude-code');
    await mkdir(versionBin, {recursive: true}); await mkdir(pkg, {recursive: true});
    await writeFile(join(pkg, 'cli.js'), '#!/bin/sh\nexit 0\n');
    await symlink(join('..', 'lib', 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js'), join(versionBin, 'claude'));
    await symlink(join('versions', 'node', 'v22'), join(nvm, 'current'));
    for (const path of [nvm, join(nvm, 'versions'), join(nvm, 'versions', 'node'), join(nvm, 'versions', 'node', 'v22'), versionBin,
      join(nvm, 'versions', 'node', 'v22', 'lib'), join(nvm, 'versions', 'node', 'v22', 'lib', 'node_modules'),
      join(nvm, 'versions', 'node', 'v22', 'lib', 'node_modules', '@anthropic-ai'), pkg]) {
      await chown(path, -1, supplementary); await chmod(path, 0o2775);
    }
    await chown(join(pkg, 'cli.js'), -1, supplementary); await chmod(join(pkg, 'cli.js'), 0o775);
    await chmod(share, 0o755);
    // main's relay and setup take only a PATH entry that is its own real path, so this forward-port puts the version's
    // real bin directory on PATH, where the release branch uses nvm's current link.
    const entry = versionBin;
    const group = (members: string) => `<user>:x:<gid>:\nnvm:x:${supplementary}:${members}`;
    const own = await accounts(group('<user>'));
    assert.equal(await launchers.providerFirstOnPathUnsafe('claude', {searchPath: entry, accounts: own}), false, 'relay');
    assert.equal(await launchers.resolveRepositoryProviderDirectory({provider: 'claude', searchPath: entry, accounts: own}), versionBin, 'setup');
    assert.equal(await launchers.providerUnsafePathDiagnosis('claude', {searchPath: entry, accounts: own}), null, 'status');
    // Each case writes the account files just before its checks, as all cases share one pair of files.
    for (const [groups, otherUsers, why] of [
      [group('<user>,alice'), '', 'another member'],
      [group('<user>'), `alice:x:4242:${supplementary}::/home/alice:/bin/sh\n`, "another user's primary group"],
      ['<user>:x:<gid>:', '', 'the group is not listed'],
      // N2: the user is in it by some other means, such as NSS or --group-add, so who else is in it is unknown.
      [group(''), '', 'group listed with no members'],
    ] as const) {
      const shared = await accounts(groups, otherUsers);
      assert.equal(await launchers.providerFirstOnPathUnsafe('claude', {searchPath: entry, accounts: shared}), true, why);
      await assert.rejects(launchers.resolveRepositoryProviderDirectory({provider: 'claude', searchPath: entry, accounts: shared}),
        /^Error: relay_startup_claude_path_invalid: /, why);
    }
    await chmod(versionBin, 0o2777);
    assert.equal(await launchers.providerFirstOnPathUnsafe('claude', {searchPath: entry, accounts: own}), true, 'world-writable');
  });
});

// CLI 0.2.224 review R424-2 (1x5=5): NSS user private groups, as sssd's auto_private_groups and FreeIPA make them, are
// not in /etc/group, so after the upgrade a 0775 provider tree owned by the user's own primary group was refused. The
// primary group also counts as private when its id is the user's id and the NSS entry (getent group) names it after
// the user with no other member; anything else stays refused, and `dharma status` names the case.
test('relay guard and setup accept a 0775 provider tree whose primary group is an NSS user private group', {skip: process.platform !== 'linux'}, async () => {
  const launchers = await import('./repositoryLaunchers.js' as string) as ProviderPathChecks;
  const user = userInfo().username, uid = process.getuid!(), gid = process.getgid!();
  await privateGroupHost(async ({bin, accounts}) => {
    const nss = async (line: string | undefined) => ({...await accounts('other:x:1:'), groupLookup: async (id: number) =>
      id === gid ? line : undefined});
    const own = await nss(`${user}:*:${gid}:`);
    // Only a primary group whose id is the user's id is looked up.
    assert.equal(await launchers.providerFirstOnPathUnsafe('claude', {searchPath: bin, accounts: own}), uid !== gid, 'relay');
    if (uid === gid) {
      assert.equal(await launchers.resolveRepositoryProviderDirectory({provider: 'claude', searchPath: bin, accounts: own}), bin, 'setup');
      assert.equal(await launchers.providerUnsafePathDiagnosis('claude', {searchPath: bin, accounts: own}), null, 'status');
    }
    for (const [line, why] of [[`staff:*:${gid}:`, 'not named after the user'], [`${user}:*:${gid}:alice`, 'another member'],
      [undefined, 'no NSS entry']] as const) {
      const shared = await nss(line);
      assert.equal(await launchers.providerFirstOnPathUnsafe('claude', {searchPath: bin, accounts: shared}), true, why);
      await assert.rejects(launchers.resolveRepositoryProviderDirectory({provider: 'claude', searchPath: bin, accounts: shared}),
        /^Error: relay_startup_claude_path_invalid: /, why);
      const diagnosis = await launchers.providerUnsafePathDiagnosis('claude', {searchPath: bin, accounts: shared});
      assert.ok(diagnosis?.remedy.includes(`getent group ${gid}`), `status names the private-group case: ${diagnosis?.remedy}`);
    }
  });
});

// Writes the access ACL user::rwx, user:65534:rwx, group::r-x, mask::rwx, other::r-x on `path` as the raw xattr, since
// setfacl is often not installed. False when this host cannot (no python3, or a file system without ACLs).
async function grantOtherUserByAcl(path: string) {
  const script = 'import os,struct,sys\n'
    + 'e=[(1,7,0xffffffff),(2,7,65534),(4,5,0xffffffff),(16,7,0xffffffff),(32,5,0xffffffff)]\n'
    + "os.setxattr(sys.argv[1],'system.posix_acl_access',struct.pack('<I',2)+b''.join(struct.pack('<HHI',*x) for x in e))\n";
  try {await promisify(execFile)('python3', ['-I', '-c', script, path], {timeout: 10000}); return true;} catch {return false;}
}

// CLI 0.2.224 review A1 (1x7=7): with a POSIX ACL, the group bits of st_mode are the ACL mask, which also bounds named
// users and named groups. A 0775 directory of the user's private group with the entry user:<other>:rwx passed the
// private-group exemption, though that other user can create, rename or replace entries in it. For codex this was a
// regression: 0.2.223 refused any group write bit. The exemption now holds only for an entry with no ACL.
test('relay and setup refuse a private-group provider directory that an ACL opens to another user', {skip: process.platform !== 'linux'}, async t => {
  const launchers = await import('./repositoryLaunchers.js' as string) as ProviderPathChecks;
  await privateGroupHost(async ({bin, accounts}) => {
    await writeFile(join(bin, 'codex'), '#!/bin/sh\nexit 0\n'); await chmod(join(bin, 'codex'), 0o755);
    const own = await accounts('<user>:x:<gid>:');
    for (const provider of ['claude', 'codex']) {
      assert.equal(await launchers.providerFirstOnPathUnsafe(provider, {searchPath: bin, accounts: own}), false, `relay: ${provider} with no ACL`);
      assert.equal(await launchers.resolveRepositoryProviderDirectory({provider, searchPath: bin, accounts: own}), bin, `setup: ${provider} with no ACL`);
    }
    if (!await grantOtherUserByAcl(bin)) {t.skip('this host cannot write a POSIX ACL'); return;}
    assert.equal((await lstat(bin)).mode & 0o777, 0o775, 'the ACL mask shows as the group bits');
    for (const provider of ['claude', 'codex']) {
      assert.equal(await launchers.providerFirstOnPathUnsafe(provider, {searchPath: bin, accounts: own}), true, `relay: ${provider} behind an ACL`);
      await assert.rejects(launchers.resolveRepositoryProviderDirectory({provider, searchPath: bin, accounts: own}),
        new RegExp(`^Error: relay_startup_${provider}_path_invalid: `), `setup: ${provider} behind an ACL`);
      assert.equal((await launchers.providerUnsafePathDiagnosis(provider, {searchPath: bin, accounts: own}))?.path, bin,
        `status names the directory the ACL opens: ${provider}`);
    }
  });
});

test('the unsafe-path diagnosis names the failing entry and the command that fixes it', {skip: process.platform !== 'linux'}, async () => {
  const launchers = await import('./repositoryLaunchers.js' as string) as ProviderPathChecks;
  await privateGroupHost(async ({local, bin, accounts}) => {
    const shared = await accounts('<user>:x:<gid>:alice');
    await chmod(bin, 0o755); await chmod(join(bin, 'claude'), 0o755);
    // The bin directory itself is fine; its parent is the entry another member of the group can write.
    const diagnosis = await launchers.providerUnsafePathDiagnosis('claude', {searchPath: bin, accounts: shared});
    assert.equal(diagnosis?.path, local);
    assert.ok(diagnosis?.remedy.includes(`chmod go-w '${local}'`), diagnosis?.remedy);
    await chmod(local, 0o755);
    assert.equal(await launchers.providerUnsafePathDiagnosis('claude', {searchPath: bin, accounts: shared}), null);
    await chmod(join(bin, 'claude'), 0o757);
    assert.equal((await launchers.providerUnsafePathDiagnosis('claude', {searchPath: bin, accounts: shared}))?.path, join(bin, 'claude'));
  });
});

// CLI 0.2.224 review S1 (1x6=6): the provider on each PATH entry was probed at path.join(entry, provider), which
// drops a '..' part as text, while execvp hands '<entry>/claude' to the kernel, which follows links first. An entry
// '/home/u/link/../bin' with link pointing elsewhere was skipped, so the relay and setup passed the next, protected
// claude while the shell ran a claude from a directory others can write. The entry is now probed as execvp does, so a
// '..' entry that holds the provider is checked, and refused as a relative entry.
test('relay and setup refuse a provider found through a .. PATH entry that crosses a link', {skip: process.platform !== 'linux'}, async () => {
  const launchers: Record<string, any> = await import('./repositoryLaunchers.js');
  const root = await realpath(await mkdtemp(join(tmpdir(), 'fabric-provider-dotdot-entry-')));
  const open = join(root, 'other', 'bin');
  try {
    await mkdir(join(root, 'a'), {mode: 0o700});
    await mkdir(join(root, 'other', 'deep'), {recursive: true, mode: 0o700});
    await mkdir(open, {mode: 0o700});
    await symlink(join(root, 'other', 'deep'), join(root, 'a', 'link'));
    await writeFile(join(open, 'claude'), '#!/bin/sh\nprintf "other-claude"\n', {mode: 0o755});
    await chmod(open, 0o777);
    const safe = join(root, 'safe'); await mkdir(safe, {mode: 0o700});
    await writeFile(join(safe, 'claude'), '#!/bin/sh\nprintf "own-claude"\n', {mode: 0o700});
    // The kernel resolves a/link/.. to other, so the shell runs other/bin/claude, not the protected one in safe.
    const entry = `${root}/a/link/../bin`, searchPath = `${entry}:${safe}`;
    assert.equal(await launchers.providerFirstOnPathUnsafe('claude', {searchPath}), true, 'relay: claude through a .. entry');
    await assert.rejects(launchers.resolveRepositoryProviderDirectory({provider: 'claude', searchPath}),
      /^Error: relay_startup_claude_path_invalid/, 'setup: claude through a .. entry');
    assert.equal((await launchers.providerUnsafePathDiagnosis('claude', {searchPath}))?.path, entry, 'status names the .. entry');
  } finally {await chmod(open, 0o700).catch(() => {}); await rm(root, {recursive: true, force: true});}
});

// CLI 0.2.224 review R5-1 (2x4=8): a PATH entry ahead of the provider that this user cannot search (EACCES, such as
// /root/.local/bin in a devcontainer that runs as vscode) or that is a file (ENOTDIR) made the relay refuse claude,
// agy and hermes and setup refuse them, although execvp skips such an entry and 0.2.223 had no check for it. Those
// entries are now skipped for every provider but codex, which keeps the 0.2.223 rule and refuses them.
test('relay and setup skip an unsearchable or file PATH entry ahead of claude, but not ahead of codex', {skip: process.platform !== 'linux'}, async t => {
  if (process.getuid!() === 0) {t.skip('root can search a 0000 directory'); return;}
  const launchers: Record<string, any> = await import('./repositoryLaunchers.js');
  const root = await realpath(await mkdtemp(join(tmpdir(), 'fabric-provider-skipped-entry-')));
  const closed = join(root, 'closed');
  try {
    await mkdir(closed, {mode: 0o700});
    const file = join(root, 'file'); await writeFile(file, 'not a directory\n', {mode: 0o600});
    const bin = join(root, 'bin'); await mkdir(bin, {mode: 0o700});
    for (const provider of ['claude', 'codex']) await writeFile(join(bin, provider), `#!/bin/sh\nprintf "own-${provider}"\n`, {mode: 0o700});
    await chmod(closed, 0o000);
    const searchPath = `${closed}:${file}:${bin}`;
    assert.equal(await launchers.providerFirstOnPathUnsafe('claude', {searchPath}), false, 'relay: claude after skipped entries');
    assert.equal(await launchers.resolveRepositoryProviderDirectory({provider: 'claude', searchPath}), bin, 'setup: claude after skipped entries');
    assert.equal(await launchers.providerUnsafePathDiagnosis('claude', {searchPath}), null, 'status: claude after skipped entries');
    for (const entry of [closed, file]) {
      assert.equal(await launchers.providerFirstOnPathUnsafe('codex', {searchPath: `${entry}:${bin}`}), true, `relay: codex after ${entry}`);
      await assert.rejects(launchers.resolveRepositoryProviderDirectory({provider: 'codex', searchPath: `${entry}:${bin}`}),
        /^Error: relay_startup_codex_path_invalid/, `setup: codex after ${entry}`);
      assert.equal((await launchers.providerUnsafePathDiagnosis('codex', {searchPath: `${entry}:${bin}`}))?.path, entry, `status: codex after ${entry}`);
    }
  } finally {await chmod(closed, 0o700).catch(() => {}); await rm(root, {recursive: true, force: true});}
});

// CLI 0.2.224 review R1: setup and relay upgrade rewrote the launcher with only the bundle holders and the provider
// set up, so a first agent whose shared package was still pending (no ACTIVE_BUNDLE) dropped off the relay PATH.
// 0.2.223 always carried codex. The directories the launcher being replaced carries are kept while they still pass.
test('the launcher being replaced names its protected provider directories, from any agent-fabric version', {skip: process.platform !== 'linux'}, async () => {
  const launchers: Record<string, any> = await import('./repositoryLaunchers.js');
  assert.equal(typeof launchers.protectedLauncherProviderDirectories, 'function');
  const root = await realpath(await mkdtemp(join(tmpdir(), 'fabric-current-launcher-')));
  try {
    const codexDirectory = join(root, 'npm-global', 'bin'), claudeDirectory = join(root, 'local', 'bin');
    for (const directory of [codexDirectory, claudeDirectory]) await mkdir(directory, {recursive: true, mode: 0o700});
    await writeFile(join(codexDirectory, 'codex'), '#!/bin/sh\nprintf "own-codex"\n', {mode: 0o700});
    await writeFile(join(claudeDirectory, 'claude'), '#!/bin/sh\nprintf "own-claude"\n', {mode: 0o700});
    const runtime = {platform: 'linux' as const, nodeDirectory: dirname(process.execPath), npmCliPath: '/approved/npm/bin/npm-cli.js'};
    const read = (contents: unknown) => launchers.protectedLauncherProviderDirectories(contents);
    // The single-directory launcher 0.2.223 wrote for codex.
    const codexOnly = launchers.stableRepositoryLauncherContents('0.2.223', {...runtime, providerDirectory: codexDirectory});
    assert.deepEqual(await read(codexOnly), [{provider: 'codex', directory: codexDirectory}]);
    const both = launchers.stableRepositoryLauncherContents('0.2.224', {...runtime, providerDirectory: [claudeDirectory, codexDirectory]});
    assert.deepEqual(await read(both), [{provider: 'claude', directory: claudeDirectory}, {provider: 'codex', directory: codexDirectory}]);
    assert.deepEqual(await read(launchers.stableRepositoryLauncherContents('0.2.224', runtime)), [], 'no provider directory');
    assert.deepEqual(await read({...codexOnly, shell: codexOnly.shell + 'echo foreign\n'}), [], 'not a launcher setup wrote');
    assert.deepEqual(await read(null), []);
    await chmod(join(codexDirectory, 'codex'), 0o722);
    assert.deepEqual(await read(both), [{provider: 'claude', directory: claudeDirectory}], 'a directory that no longer passes is dropped');
  } finally {await rm(root, {recursive: true, force: true});}
});

// CLI 0.2.224 review R2: claude, agy and hermes were held to codex's launcher rules (the PATH entry is its own real
// path; a node there hash-equals the running one), so fnm's per-shell bin directory, a symlink, was refused. The real
// directory is checked and recorded instead; it is refused only when another user owns it or others can write to it.
test('a non-codex provider in a symlinked fnm-style bin directory resolves to its protected real directory', {skip: process.platform !== 'linux'}, async () => {
  const launchers: Record<string, any> = await import('./repositoryLaunchers.js');
  const root = await realpath(await mkdtemp(join(tmpdir(), 'fabric-fnm-provider-')));
  try {
    const installation = join(root, 'fnm', 'node-versions', 'v22', 'installation'), real = join(installation, 'bin');
    await mkdir(real, {recursive: true, mode: 0o700});
    await copyFile(process.execPath, join(real, 'node')); await chmod(join(real, 'node'), 0o700);
    await writeFile(join(real, 'claude'), '#!/bin/sh\nprintf "fnm-claude"\n', {mode: 0o700});
    await writeFile(join(real, 'codex'), '#!/bin/sh\nprintf "fnm-codex"\n', {mode: 0o700});
    const multishell = join(root, 'fnm_multishells', '4242_1762560000000');
    await mkdir(dirname(multishell), {mode: 0o700}); await symlink(installation, multishell);
    const entry = join(multishell, 'bin');
    assert.equal(await launchers.resolveRepositoryProviderDirectory({provider: 'claude', searchPath: entry}), real);
    assert.equal(await launchers.providerFirstOnPathUnsafe('claude', {searchPath: entry}), false);
    const after = launchers.stableRepositoryLauncherContents('0.2.224', {platform: 'linux', nodeDirectory: dirname(process.execPath),
      providerDirectory: real});
    assert.equal(await launchers.verifyRollbackRepositoryLaunchers('0.2.224', after, 'claude'), true);
    await assert.rejects(launchers.resolveRepositoryProviderDirectory({provider: 'codex', searchPath: entry}),
      /^Error: relay_startup_codex_path_invalid/, 'codex keeps the 0.2.223 rules');
    await chmod(real, 0o777);
    await assert.rejects(launchers.resolveRepositoryProviderDirectory({provider: 'claude', searchPath: entry}),
      /^Error: relay_startup_claude_path_invalid/, 'a world-writable real directory is refused');
    assert.equal(await launchers.providerFirstOnPathUnsafe('claude', {searchPath: entry}), true);
  } finally {await chmod(join(root, 'fnm', 'node-versions', 'v22', 'installation', 'bin'), 0o700).catch(() => {});
    await rm(root, {recursive: true, force: true});}
});
