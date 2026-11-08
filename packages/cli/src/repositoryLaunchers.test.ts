import assert from 'node:assert/strict';
import { chmod, chown, copyFile, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
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
  assert.deepEqual(await launchers.providerDirectoriesInPathOrder(['/b', undefined, '/a', '/b'], '/x:/a:/b'), ['/a', '/b'],
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
    const providerDirectory = await launchers.providerDirectoriesInPathOrder(resolved, searchPath);
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
type AccountFiles = {group: string; passwd: string};
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
    for (const shared of [
      await accounts('<user>:x:<gid>:alice'), // another member
      await accounts('staff:x:<gid>:'), // not named after the user
      await accounts('<user>:x:<gid>:', 'alice:x:4242:<gid>::/home/alice:/bin/sh\n'), // another user's primary group
      await accounts('other:x:1:'), // the group is not listed at all
    ]) {
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
    const entry = join(nvm, 'current', 'bin');
    const group = (members: string) => `<user>:x:<gid>:\nnvm:x:${supplementary}:${members}`;
    const own = await accounts(group('<user>'));
    assert.equal(await launchers.providerFirstOnPathUnsafe('claude', {searchPath: entry, accounts: own}), false, 'relay');
    assert.equal(await launchers.resolveRepositoryProviderDirectory({provider: 'claude', searchPath: entry, accounts: own}), versionBin, 'setup');
    assert.equal(await launchers.providerUnsafePathDiagnosis('claude', {searchPath: entry, accounts: own}), null, 'status');
    for (const [shared, why] of [
      [await accounts(group('<user>,alice')), 'another member'],
      [await accounts(group('<user>'), `alice:x:4242:${supplementary}::/home/alice:/bin/sh\n`), "another user's primary group"],
      [await accounts('<user>:x:<gid>:'), 'the group is not listed'],
    ] as const) {
      assert.equal(await launchers.providerFirstOnPathUnsafe('claude', {searchPath: entry, accounts: shared}), true, why);
      await assert.rejects(launchers.resolveRepositoryProviderDirectory({provider: 'claude', searchPath: entry, accounts: shared}),
        /^Error: relay_startup_claude_path_invalid: /, why);
    }
    await chmod(versionBin, 0o2777);
    assert.equal(await launchers.providerFirstOnPathUnsafe('claude', {searchPath: entry, accounts: own}), true, 'world-writable');
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
    // The link and every directory on the way to it are this user's and closed to others, so the relay accepts it.
    assert.equal(await launchers.providerFirstOnPathUnsafe('claude', {searchPath: entry}), false);
    assert.equal(await launchers.providerFirstOnPathUnsafe('claude', {searchPath: `${real}:${entry}`}), false);
    const after = launchers.stableRepositoryLauncherContents('0.2.224', {platform: 'linux', nodeDirectory: dirname(process.execPath),
      providerDirectory: real});
    assert.equal(await launchers.verifyRollbackRepositoryLaunchers('0.2.224', after, 'claude'), true);
    await assert.rejects(launchers.resolveRepositoryProviderDirectory({provider: 'codex', searchPath: entry}),
      /^Error: relay_startup_codex_path_invalid/, 'codex keeps the 0.2.223 rules');
    await chmod(real, 0o777);
    await assert.rejects(launchers.resolveRepositoryProviderDirectory({provider: 'claude', searchPath: entry}),
      /^Error: relay_startup_claude_path_invalid/, 'a world-writable real directory is refused');
    assert.equal(await launchers.providerFirstOnPathUnsafe('claude', {searchPath: real}), true);
  } finally {await chmod(join(root, 'fnm', 'node-versions', 'v22', 'installation', 'bin'), 0o700).catch(() => {});
    await rm(root, {recursive: true, force: true});}
});

// CLI 0.2.224 review round 2 (relay guard): the relay looks a provider the launcher does not carry up on PATH and runs
// it through that PATH entry. A symlinked entry passed once its real directory was checked, but the link and the
// directory holding it were not, so a link in a directory another user can write (fnm's /tmp/fnm_multishells made 0777
// by someone else) could be repointed after the check. The relay keeps the 0.2.223 rule: the entry is its own real path.
test('the relay refuses a symlinked provider PATH entry whose link another user can replace', {skip: process.platform !== 'linux'}, async () => {
  const launchers: Record<string, any> = await import('./repositoryLaunchers.js');
  const root = await realpath(await mkdtemp(join(tmpdir(), 'fabric-relay-symlink-')));
  const multishells = join(root, 'fnm_multishells');
  try {
    const installation = join(root, 'fnm', 'node-versions', 'v22', 'installation'), real = join(installation, 'bin');
    await mkdir(real, {recursive: true, mode: 0o700});
    await writeFile(join(real, 'agy'), '#!/bin/sh\nprintf "own-agy"\n', {mode: 0o700});
    await mkdir(multishells, {mode: 0o700}); await chmod(multishells, 0o777);
    const link = join(multishells, '4242_1762560000000'); await symlink(installation, link);
    const entry = join(link, 'bin');
    assert.equal(await launchers.providerFirstOnPathUnsafe('agy', {searchPath: entry}), true,
      'the link sits in a directory others can write');
    assert.equal((await launchers.providerUnsafePathDiagnosis('agy', {searchPath: entry}))?.path, multishells,
      '`dharma status` names the directory that lets others repoint the entry (CLI 0.2.224 R2b)');
    assert.equal(await launchers.providerFirstOnPathUnsafe('agy', {searchPath: `${real}:${entry}`}), false,
      'the protected real directory first on PATH, as the launcher writes it, passes');
    assert.equal(await launchers.providerUnsafePathDiagnosis('agy', {searchPath: `${real}:${entry}`}), null);
  } finally {await chmod(multishells, 0o700).catch(() => {}); await rm(root, {recursive: true, force: true});}
});

// CLI 0.2.224 review R2b: the relay refused every symlinked PATH entry, so a protected one, such as a bin directory
// that is a link owned by this user or root in directories only they can write, stopped a claude 0.2.223 ran. A link
// is accepted when the link and every directory passed on the way to it and to its target are owned by this user or
// root and closed to others, so no one else can repoint it after the check. codex keeps the 0.2.223 real-path rule.
test('the relay accepts a symlinked provider entry only when no other user can repoint it', {skip: process.platform !== 'linux'}, async () => {
  const launchers: Record<string, any> = await import('./repositoryLaunchers.js');
  const root = await realpath(await mkdtemp(join(tmpdir(), 'fabric-relay-protected-link-')));
  const opened: string[] = [];
  try {
    // This user's primary group is not private to them here, so a group write bit counts as another user's.
    const user = userInfo().username, uid = process.getuid!(), gid = process.getgid!();
    await writeFile(join(root, 'group'), 'root:x:0:\nother:x:1:\n');
    await writeFile(join(root, 'passwd'), `root:x:0:0:root:/root:/bin/sh\n${user}:x:${uid}:${gid}::${root}:/bin/sh\n`);
    const accounts = {group: join(root, 'group'), passwd: join(root, 'passwd')};
    const unsafe = (provider: string, searchPath: string) => launchers.providerFirstOnPathUnsafe(provider, {searchPath, accounts});
    const real = join(root, 'opt', 'claude', 'bin');
    await mkdir(real, {recursive: true, mode: 0o700});
    for (const provider of ['claude', 'codex']) await writeFile(join(real, provider), `#!/bin/sh\nprintf "own-${provider}"\n`, {mode: 0o700});
    const links = join(root, 'links'); await mkdir(links, {mode: 0o700});
    const bin = join(links, 'bin'); await symlink(join('..', 'opt', 'claude', 'bin'), bin);
    assert.equal(await unsafe('claude', bin), false, 'a protected linked bin directory');
    assert.equal(await unsafe('codex', bin), true, 'codex keeps the 0.2.223 rule');
    const installation = join(root, 'fnm', 'node-versions', 'v22', 'installation');
    await mkdir(join(installation, 'bin'), {recursive: true, mode: 0o700});
    await writeFile(join(installation, 'bin', 'claude'), '#!/bin/sh\nprintf "fnm-claude"\n', {mode: 0o700});
    const multishells = join(root, 'fnm_multishells'); await mkdir(multishells, {mode: 0o700});
    const entry = join(multishells, '4242_1762560000000', 'bin'); await symlink(installation, dirname(entry));
    assert.equal(await unsafe('claude', entry), false, 'fnm multishell link, closed parents');
    for (const [directory, mode, why] of [[multishells, 0o777, 'link in a world-writable directory'],
      [multishells, 0o770, 'link in a group-writable directory'], [root, 0o777, 'a world-writable directory above the link'],
      [links, 0o777, 'linked bin directory in a world-writable directory'],
      [join(root, 'opt'), 0o777, 'a world-writable directory the link target passes']] as const) {
      opened.push(directory); await chmod(directory, mode);
      const searchPath = directory === links || directory === join(root, 'opt') ? bin : entry;
      assert.equal(await unsafe('claude', searchPath), true, why);
      await chmod(directory, 0o700);
    }
    // The existing diagnosis names the directory that lets another user repoint the link.
    await chmod(multishells, 0o777);
    const diagnosis = await launchers.providerUnsafePathDiagnosis('claude', {searchPath: entry, accounts});
    assert.equal(diagnosis?.path, multishells);
    assert.ok(diagnosis?.remedy.includes(`chmod go-w '${multishells}'`), diagnosis?.remedy);
    await chmod(multishells, 0o700);
  } finally {for (const directory of opened) await chmod(directory, 0o700).catch(() => {});
    await rm(root, {recursive: true, force: true});}
});

// CLI 0.2.224 review round 2 (ordering): the real directory of a symlinked entry ranked after every directory on PATH,
// so a later PATH directory holding the codex that was set up and a leftover claude came first on the relay PATH, and
// the relay ran a claude setup never checked. Each directory keeps the place of the PATH entry it was resolved from.
test('the real directory of a symlinked entry keeps the place on PATH of the entry it was resolved from', {skip: process.platform !== 'linux'}, async () => {
  const launchers: Record<string, any> = await import('./repositoryLaunchers.js');
  const root = await realpath(await mkdtemp(join(tmpdir(), 'fabric-provider-order-')));
  try {
    const nodeDirectory = join(root, 'node'), npmDirectory = join(root, 'npm'), local = join(root, 'local', 'bin');
    const installation = join(root, 'fnm', 'node-versions', 'v22', 'installation'), real = join(installation, 'bin');
    for (const directory of [nodeDirectory, npmDirectory, local, real]) await mkdir(directory, {recursive: true, mode: 0o700});
    await copyFile(process.execPath, join(nodeDirectory, 'node')); await chmod(join(nodeDirectory, 'node'), 0o700);
    const npmCliPath = join(npmDirectory, 'bin', 'npm-cli.js'); await mkdir(dirname(npmCliPath), {mode: 0o700});
    await writeFile(join(npmDirectory, 'package.json'), JSON.stringify({name: 'npm', bin: {npm: 'bin/npm-cli.js'}}), {mode: 0o600});
    await writeFile(npmCliPath, "process.stdout.write(require('node:child_process').spawnSync('claude',[],{encoding:'utf8'}).stdout);", {mode: 0o600});
    await writeFile(join(real, 'claude'), '#!/bin/sh\nprintf "fnm-claude"\n', {mode: 0o700});
    await writeFile(join(local, 'codex'), '#!/bin/sh\nprintf "own-codex"\n', {mode: 0o700});
    await writeFile(join(local, 'claude'), '#!/bin/sh\nprintf "leftover-claude"\n', {mode: 0o700});
    const multishell = join(root, 'fnm_multishells', '4242_1762560000000');
    await mkdir(dirname(multishell), {mode: 0o700}); await symlink(installation, multishell);
    const searchPath = `${join(multishell, 'bin')}:${local}`;
    const resolved: (string | undefined)[] = [];
    for (const provider of ['codex', 'claude']) resolved.push(await launchers.resolveRepositoryProviderDirectory({provider, searchPath}));
    assert.deepEqual(resolved, [local, real]);
    const providerDirectory = await launchers.providerDirectoriesInPathOrder(resolved, searchPath);
    assert.deepEqual(providerDirectory, [real, local], 'claude keeps the first place its fnm entry has on PATH');
    const after = launchers.stableRepositoryLauncherContents('0.2.224', {platform: 'linux', nodeDirectory, npmCliPath, providerDirectory});
    await writeFile(join(root, 'after.sh'), after.shell);
    const {stdout} = await promisify(execFile)('/bin/sh', [join(root, 'after.sh')], {env: {PATH: join(root, 'absent'), HOME: root}});
    assert.equal(stdout, 'fnm-claude', 'the relay runs the claude setup checked');
    const kept = join(root, 'kept', 'bin');
    assert.deepEqual(await launchers.providerDirectoriesInPathOrder([kept, real, local], searchPath), [real, local, kept],
      'a kept directory no PATH entry reaches follows');
  } finally {await rm(root, {recursive: true, force: true});}
});

// CLI 0.2.224 review F1 (2x8=16): the provider executable's own link chain was resolved with plain realpath and only
// the final directory was checked, so a link on the way to the executable that sat in a directory another user can
// write (bin/claude -> shared/claude -> real/claude, shared 0777) passed, and could be repointed after the check while
// the relay runs the provider by name through PATH. codex's sibling node had the same gap. The executable, and codex's
// node, are now resolved with the same component walk as the PATH entry, by both relay and setup.
test('relay and setup refuse a provider executable whose link chain passes a directory others can write', {skip: process.platform !== 'linux'}, async () => {
  const launchers: Record<string, any> = await import('./repositoryLaunchers.js');
  const root = await realpath(await mkdtemp(join(tmpdir(), 'fabric-provider-link-chain-')));
  const shared = join(root, 'shared');
  try {
    const bin = join(root, 'bin'), real = join(root, 'real');
    for (const directory of [bin, real, shared]) await mkdir(directory, {mode: 0o700});
    for (const provider of ['claude', 'codex']) {
      await writeFile(join(real, provider), `#!/bin/sh\nprintf "own-${provider}"\n`, {mode: 0o700});
      await symlink(join(real, provider), join(shared, provider));
      await symlink(join('..', 'shared', provider), join(bin, provider));
    }
    await copyFile(process.execPath, join(real, 'node')); await chmod(join(real, 'node'), 0o700);
    await symlink(join(real, 'node'), join(shared, 'node'));
    const codexBin = join(root, 'codex-bin'); await mkdir(codexBin, {mode: 0o700});
    await writeFile(join(codexBin, 'codex'), '#!/bin/sh\nprintf "own-codex"\n', {mode: 0o700});
    await symlink(join('..', 'shared', 'node'), join(codexBin, 'node'));
    // N1: a node beside claude is the env-node a node-script claude runs with, since the launcher and the relay put the
    // provider directory before the recorded Node directory on PATH. Its link chain is checked as codex's node is.
    const claudeBin = join(root, 'claude-bin'); await mkdir(claudeBin, {mode: 0o700});
    await writeFile(join(claudeBin, 'claude'), '#!/bin/sh\nprintf "own-claude"\n', {mode: 0o700});
    await symlink(join('..', 'shared', 'node'), join(claudeBin, 'node'));
    // Every link and directory on the way is this user's and closed to others: all pass.
    assert.equal(await launchers.providerFirstOnPathUnsafe('claude', {searchPath: bin}), false);
    assert.equal(await launchers.resolveRepositoryProviderDirectory({provider: 'claude', searchPath: bin}), bin);
    assert.equal(await launchers.resolveRepositoryProviderDirectory({provider: 'codex', searchPath: codexBin}), codexBin);
    assert.equal(await launchers.providerFirstOnPathUnsafe('claude', {searchPath: claudeBin}), false);
    assert.equal(await launchers.resolveRepositoryProviderDirectory({provider: 'claude', searchPath: claudeBin}), claudeBin);
    assert.equal(await launchers.providerUnsafePathDiagnosis('claude', {searchPath: claudeBin}), null);
    await chmod(shared, 0o777);
    assert.equal(await launchers.providerFirstOnPathUnsafe('claude', {searchPath: bin}), true, 'relay: link in a 0777 directory');
    await assert.rejects(launchers.resolveRepositoryProviderDirectory({provider: 'claude', searchPath: bin}),
      /^Error: relay_startup_claude_path_invalid/, 'setup: claude link in a 0777 directory');
    await assert.rejects(launchers.resolveRepositoryProviderDirectory({provider: 'codex', searchPath: codexBin}),
      /^Error: relay_startup_codex_path_invalid/, "setup: codex's node link in a 0777 directory");
    assert.equal(await launchers.providerFirstOnPathUnsafe('claude', {searchPath: claudeBin}), true,
      "relay: claude's node link in a 0777 directory (N1)");
    await assert.rejects(launchers.resolveRepositoryProviderDirectory({provider: 'claude', searchPath: claudeBin}),
      /^Error: relay_startup_claude_path_invalid/, "setup: claude's node link in a 0777 directory (N1)");
    assert.equal((await launchers.providerUnsafePathDiagnosis('claude', {searchPath: claudeBin}))?.path, shared,
      "status names the directory that lets others repoint claude's node (N1)");
  } finally {await chmod(shared, 0o700).catch(() => {}); await rm(root, {recursive: true, force: true});}
});
