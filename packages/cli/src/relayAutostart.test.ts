import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, posix } from 'node:path';
import test from 'node:test';
import * as startup from './relayAutostart.js';
import type { RelayAutostartOptions } from './relayAutostart.js';
import {
  disableRelayAutostart, enableRelayAutostart, linuxRelayUnit,
  relayAutostartStatus, windowsRelayStartupScript,
  startRelayAutostart, stopRelayAutostart, inspectOwnedRelayAutostart, macRelayLaunchAgent,
} from './relayAutostart.js';

const startupPreflight = async (options: RelayAutostartOptions) => {
  const check = Reflect.get(startup, 'assertRelayStartupOwnership');
  assert.equal(typeof check, 'function', 'startup ownership must be checked before enrollment');
  await check(options);
};

test('Linux startup preflight rejects a second device home without modifying its existing anchor', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dharma-startup-preflight-'));
  const calls: string[] = [];
  const options = { platform: 'linux' as const, home: join(root, 'accepted'), userHome: root,
    workspace: '/fixtures/accepted', launcher: '/fixtures/accepted/.dharma/bin/dharma',
    policy: '/fixtures/accepted/.dharma/approved-policy.json', version: '0.2.174',
    run: async (file: string) => { calls.push(file); return { stdout: 'enabled\n' }; } };
  await enableRelayAutostart(options);
  const unit = join(root, '.config', 'systemd', 'user', 'dharma-agent-fabric.service');
  const receipt = join(options.home, 'relay', 'autostart.json');
  const before = await readFile(unit, 'utf8'), registration = await readFile(receipt, 'utf8');
  calls.length = 0;
  await assert.rejects(startupPreflight({ ...options, home: join(root, 'fresh') }), /autostart_conflict/);
  assert.equal(await readFile(unit, 'utf8'), before);
  assert.equal(await readFile(receipt, 'utf8'), registration);
  await assert.rejects(readFile(join(root, 'fresh', 'relay', 'autostart.json')), { code: 'ENOENT' });
  assert.deepEqual(calls, [], 'preflight may not run any startup control');
});

test('Linux startup preflight permits an absent or exactly owned current and legacy anchor', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dharma-startup-preflight-owned-'));
  const options = { platform: 'linux' as const, home: join(root, 'device'), userHome: root,
    workspace: '/fixtures/repository', launcher: '/fixtures/repository/.dharma/bin/dharma',
    policy: null, version: '0.2.174', run: async () => ({ stdout: 'enabled\n' }) };
  await startupPreflight(options);
  await enableRelayAutostart(options);
  await startupPreflight(options);
  const unit = join(root, '.config', 'systemd', 'user', 'dharma-agent-fabric.service');
  const current = await readFile(unit, 'utf8');
  const legacy = current.replace(/^WorkingDirectory=.*$/m, `WorkingDirectory="${options.workspace}"`);
  await writeFile(unit, legacy);
  await startupPreflight(options);
  assert.equal(await readFile(unit, 'utf8'), legacy, 'preflight does not migrate the anchor');
  await writeFile(unit, `${current}# unowned modification\n`);
  await assert.rejects(startupPreflight(options), /autostart_conflict/);
});

test('Linux startup preflight fails closed on invalid receipts and unreadable anchors', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dharma-startup-preflight-invalid-'));
  const home = join(root, 'device'), options = { platform: 'linux' as const, home, userHome: root };
  await mkdir(join(home, 'relay'), { recursive: true });
  await writeFile(join(home, 'relay', 'autostart.json'), '{broken');
  await assert.rejects(startupPreflight(options), /autostart_receipt_invalid/);
  const fresh = { ...options, home: join(root, 'fresh') };
  await mkdir(join(root, '.config', 'systemd', 'user', 'dharma-agent-fabric.service'), { recursive: true });
  await assert.rejects(startupPreflight(fresh));
});

test('Linux startup preflight rejects an orphaned systemd receipt without recreating its missing unit', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dharma-startup-preflight-orphan-'));
  const calls: string[][] = [];
  const options = { platform: 'linux' as const, home: join(root, 'device'), userHome: root,
    workspace: '/fixtures/repository', launcher: '/fixtures/repository/.dharma/bin/dharma',
    policy: null, version: '0.2.174',
    run: async (file: string, args: string[]) => { calls.push([file, ...args]); return { stdout: 'enabled\n' }; } };
  await enableRelayAutostart(options);
  const unit = join(root, '.config', 'systemd', 'user', 'dharma-agent-fabric.service');
  const receipt = join(options.home, 'relay', 'autostart.json');
  const before = await readFile(receipt, 'utf8');
  await rm(unit);
  calls.length = 0;
  await assert.rejects(startupPreflight(options), /autostart_conflict/);
  assert.equal(await readFile(receipt, 'utf8'), before);
  await assert.rejects(readFile(unit), { code: 'ENOENT' });
  assert.deepEqual(calls, []);
});

test('bootstrap may inspect an exact owned legacy anchor for migration without admitting legacy start', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dharma-startup-preflight-legacy-'));
  const calls: string[][] = [];
  const options = { platform: 'linux' as const, home: join(root, 'device'), userHome: root,
    workspace: '/fixtures/repository', launcher: '/fixtures/repository/.dharma/bin/dharma',
    policy: null, version: '0.2.174',
    run: async (file: string, args: string[]) => { calls.push([file, ...args]); return { stdout: 'enabled\n' }; } };
  await enableRelayAutostart(options);
  const unit = join(root, '.config', 'systemd', 'user', 'dharma-agent-fabric.service');
  const legacy = (await readFile(unit, 'utf8')).replace(/^WorkingDirectory=.*$/m, `WorkingDirectory="${options.workspace}"`);
  await writeFile(unit, legacy);
  calls.length = 0;
  await startupPreflight(options);
  assert.equal((await relayAutostartStatus(options)).state, 'unavailable');
  await assert.rejects(inspectOwnedRelayAutostart(options), /autostart_conflict/);
  const registration = await Reflect.apply(inspectOwnedRelayAutostart, undefined, [options, { allowLegacy: true }]);
  assert.equal(registration.workspace, options.workspace);
  await assert.rejects(startRelayAutostart(options), /autostart_conflict/);
  assert.equal(await readFile(unit, 'utf8'), legacy);
  assert.deepEqual(calls, [], 'inspection cannot migrate, enable or start the legacy unit');
  assert.equal((await enableRelayAutostart(options)).state, 'enabled');
  assert.match(await readFile(unit, 'utf8'), /^WorkingDirectory=\//m);
  await writeFile(unit, `${legacy}# foreign modification\n`);
  await assert.rejects(Reflect.apply(inspectOwnedRelayAutostart, undefined, [options, { allowLegacy: true }]), /autostart_conflict/);
});

test('Linux-only startup preflight leaves Windows and macOS registration behavior unchanged', async () => {
  for (const platform of ['win32', 'darwin'] as const) {
    await startupPreflight({ platform, home: '/not-read', userHome: '/not-read',
      run: async () => { throw new Error('preflight must not execute an OS command'); } });
  }
});

async function macFixture() {
  const root = await mkdtemp(join(tmpdir(), 'dharma-mac-startup-'));
  const calls: string[][] = [];
  let loaded = false, disabled = true, foreign = false;
  const options = { platform: 'darwin' as const, uid: 501, userHome: root, home: join(root, 'dharma'),
    workspace: '/Users/fixture/Repo Space', launcher: '/Users/fixture/Repo Space/.dharma/bin/dharma',
    policy: '/Users/fixture/Repo Space/.dharma/policy.json', version: '0.2.130',
    run: async (file: string, args: string[]) => {
      calls.push([file, ...args]);
      if (file === '/usr/bin/plutil') return { stdout: 'OK\n' };
      assert.equal(file, '/bin/launchctl');
      if (args[0] === 'print') {
        if (!loaded) throw Object.assign(new Error('not loaded'), { code: 113, stderr: 'Could not find service' });
        return { stdout: `gui/501/io.dharma.agent-fabric.relay = {\n`
          + ` path = ${join(root, 'Library', 'LaunchAgents', 'io.dharma.agent-fabric.relay.plist')}\n`
          + ` program = ${foreign ? '/foreign' : options.launcher}\n arguments = {\n`
          + ` ${options.launcher}\n relay\n supervise\n --policy\n ${options.policy}\n }\n`
          + ` working directory = ${options.workspace}\n environment = {\n DHARMA_HOME => ${options.home}\n }\n}\n` };
      }
      if (args[0] === 'print-disabled') return { stdout: `disabled services = {\n "io.dharma.agent-fabric.relay" => ${disabled}\n}\n` };
      if (args[0] === 'enable') disabled = false;
      if (args[0] === 'disable') disabled = true;
      if (args[0] === 'bootstrap') { assert.equal(loaded, false); loaded = true; }
      if (args[0] === 'bootout') loaded = false;
      return { stdout: '' };
    } };
  return { options, calls, plist: join(root, 'Library', 'LaunchAgents', 'io.dharma.agent-fabric.relay.plist'),
    setForeign: () => { foreign = true; }, setLoaded: () => { loaded = true; } };
}

// Windows permission bits cannot model launchd's private-file ownership checks.
const macFilesystem = { skip: process.platform === 'win32' };

test('macOS owned registration supports restart, stop, same-device upgrade and disable', macFilesystem, async () => {
  const { options, calls, plist } = await macFixture();
  assert.equal((await enableRelayAutostart(options)).state, 'enabled');
  const xml = await readFile(plist, 'utf8');
  assert.match(xml, /RunAtLoad/);
  assert.match(xml, /KeepAlive/);
  assert.doesNotMatch(xml, /--grant|token|password/);
  assert.equal((await inspectOwnedRelayAutostart(options)).backend, 'launchd-user');
  await stopRelayAutostart(options);
  assert.equal((await relayAutostartStatus(options)).state, 'enabled');
  await startRelayAutostart(options);
  assert.equal(calls.filter(call => call[1] === 'bootstrap').length, 2);
  assert.equal((await enableRelayAutostart({ ...options, version: '0.2.131' })).state, 'enabled');
  assert.equal((await relayAutostartStatus(options)).version, '0.2.131');
  assert.equal((await disableRelayAutostart(options)).state, 'disabled');
  assert.equal((await relayAutostartStatus(options)).state, 'disabled');
});

test('macOS preserves the established startup anchor for another repository', macFilesystem, async () => {
  const { options, calls, plist } = await macFixture();
  await enableRelayAutostart(options);
  const before = await readFile(plist, 'utf8');
  calls.length = 0;
  await enableRelayAutostart({ ...options, workspace: '/Users/other', launcher: '/Users/other/dharma',
    policy: '/Users/other/policy.json', preserveStandardAnchor: true });
  assert.equal(await readFile(plist, 'utf8'), before);
  assert.ok(!calls.some(call => ['bootstrap', 'bootout'].includes(call[1]!)));
});

test('macOS refuses foreign loaded services and tampered startup files', macFilesystem, async () => {
  const fixture = await macFixture();
  await enableRelayAutostart(fixture.options);
  fixture.setForeign();
  fixture.calls.length = 0;
  await assert.rejects(enableRelayAutostart(fixture.options), /autostart_conflict/);
  await assert.rejects(stopRelayAutostart(fixture.options), /autostart_conflict/);
  await assert.rejects(disableRelayAutostart(fixture.options), /autostart_conflict/);
  assert.ok(!fixture.calls.some(call => ['bootout', 'disable'].includes(call[1]!)));
  const clean = await macFixture();
  await enableRelayAutostart(clean.options);
  await writeFile(clean.plist, 'foreign');
  clean.calls.length = 0;
  assert.equal((await relayAutostartStatus(clean.options)).reason, 'autostart_conflict');
  await assert.rejects(disableRelayAutostart(clean.options), /autostart_conflict/);
  assert.deepEqual(clean.calls, []);
});

test('macOS will not take over a loaded service without a receipt', async () => {
  const fixture = await macFixture();
  fixture.setLoaded();
  await assert.rejects(enableRelayAutostart(fixture.options), /without an ownership receipt/);
  assert.ok(!fixture.calls.some(call => call[1] === 'bootout'));
});

test('macOS will not follow a plist symlink', { skip: process.platform === 'win32' }, async () => {
  const linked = await macFixture();
  await mkdir(join(linked.options.userHome, 'Library', 'LaunchAgents'), { recursive: true });
  await writeFile(join(linked.options.userHome, 'foreign.plist'), 'foreign');
  await symlink(join(linked.options.userHome, 'foreign.plist'), linked.plist);
  await assert.rejects(enableRelayAutostart(linked.options), /private regular file/);
  assert.equal(await readFile(linked.plist, 'utf8'), 'foreign');
});

test('macOS loaded scope and argument mismatches fail before mutation', macFilesystem, async () => {
  for (const [from, to] of [[' supervise\n', ' bootstrap\n'], [' working directory = ', ' wrong directory = '],
    [' DHARMA_HOME => ', ' FOREIGN_HOME => '], [' path = ', ' unknown path = ']]) {
    const fixture = await macFixture();
    await enableRelayAutostart(fixture.options);
    const run = fixture.options.run;
    const modified = { ...fixture.options, run: async (file: string, args: string[]) => {
      const result = await run(file, args);
      return { stdout: args[0] === 'print' ? result.stdout.replace(from!, to!) : result.stdout };
    } };
    fixture.calls.length = 0;
    assert.equal((await relayAutostartStatus(modified)).reason, 'autostart_conflict');
    await assert.rejects(enableRelayAutostart(modified), /autostart_conflict/);
    await assert.rejects(disableRelayAutostart(modified), /autostart_conflict/);
    assert.ok(!fixture.calls.some(call => ['bootout', 'disable'].includes(call[1]!)));
  }
});

test('macOS rejects relative or control-character paths and root registration', async () => {
  assert.throws(() => macRelayLaunchAgent('relative', null, '/repo', '/home'), /absolute/);
  assert.throws(() => macRelayLaunchAgent('/bin/true', null, '/repo\tbad', '/home'), /Invalid LaunchAgent path/);
  const { options, calls } = await macFixture();
  await assert.rejects(enableRelayAutostart({ ...options, uid: 0 }), /non-root/);
  assert.deepEqual(calls, []);
});

test('macOS launchd failure does not produce enabled status', macFilesystem, async () => {
  const { options } = await macFixture();
  await enableRelayAutostart(options);
  const unavailable = { ...options, run: async () => { throw new Error('GUI domain unavailable'); } };
  assert.equal((await relayAutostartStatus(unavailable)).state, 'unavailable');
  await assert.rejects(startRelayAutostart(unavailable), /autostart_conflict/);
});

test('macOS generated plist passes the native property-list parser', { skip: process.platform !== 'darwin' }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'dharma-native-plist-'));
  const file = join(root, 'test.plist');
  await writeFile(file, macRelayLaunchAgent('/bin/true', '/Users/test/Policy & "quote"', '/Users/test/Repo Space', root));
  const result = spawnSync('/usr/bin/plutil', ['-lint', file], { encoding: 'utf8', timeout: 15_000 });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

// Mock Linux OS paths remain POSIX even when receipt files live on Windows.
const linuxWorkspace = (root: string, name: string) => posix.join('/fixtures', basename(root), name);

test('Linux startup invokes only the pinned launcher and canonical policy', () => {
  const unit = linuxRelayUnit('/home/a b/repo/.dharma/bin/dharma', '/home/a b/repo/.dharma/approved-policy.json', '/home/a b/repo');
  assert.match(unit, /ExecStart="\/home\/a b\/repo\/\.dharma\/bin\/dharma" relay supervise --policy/);
  assert.match(unit, /Restart=on-failure/);
  assert.doesNotMatch(unit, /grant|token|password/i);
  assert.match(unit, /^WorkingDirectory=\/home\/a b\/repo$/m);
});

test('Linux generated unit passes the actual systemd parser with spaces and literal specifiers', {
  skip: process.platform !== 'linux' || spawnSync('systemd-analyze', ['--version']).status !== 0,
}, async () => {
  const root = await mkdtemp(join(tmpdir(), 'dharma-unit-parser-'));
  const workspace = join(root, 'repo space % quote"');
  await mkdir(workspace);
  const file = join(root, 'dharma-parser-test.service');
  await writeFile(file, linuxRelayUnit('/bin/true', null, workspace, join(root, 'private home')));
  const result = spawnSync('systemd-analyze', ['--user', 'verify', file], { encoding: 'utf8', timeout: 15_000 });
  assert.equal(result.status, 0, result.stderr || String(result.error));
});

test('Linux rejects nonabsolute or unrepresentable working directories before registration', () => {
  for (const workspace of ['relative/repo', '/tmp/repo ', '/tmp/repo\\', '/tmp/repo\t']) {
    assert.throws(() => linuxRelayUnit('/bin/true', null, workspace), /working directory/i);
  }
});

test('Linux enable migrates only an exact owned legacy unit without enabling it prematurely', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dharma-legacy-unit-'));
  const options = { platform: 'linux' as const, home: join(root, 'dharma'), userHome: root,
    workspace: linuxWorkspace(root, 'repo space'), launcher: '/bin/true', policy: null, version: '0.2.104',
    run: async () => ({ stdout: 'enabled\n' }) };
  await enableRelayAutostart(options);
  const file = join(root, '.config', 'systemd', 'user', 'dharma-agent-fabric.service');
  const legacy = linuxRelayUnit(options.launcher, null, options.workspace, options.home)
    .replace(/^WorkingDirectory=.*$/m, `WorkingDirectory="${options.workspace}"`);
  await writeFile(file, legacy);
  assert.equal((await relayAutostartStatus(options)).state, 'unavailable');
  await assert.rejects(startRelayAutostart(options), /autostart_conflict/);
  assert.equal((await enableRelayAutostart(options)).state, 'enabled');
  assert.match(await readFile(file, 'utf8'), /^WorkingDirectory=\//m);
  assert.equal((await startRelayAutostart(options)).state, 'start_requested');
  await writeFile(file, `${legacy}# foreign modification\n`);
  await assert.rejects(enableRelayAutostart(options), /autostart_conflict/);
  await assert.rejects(disableRelayAutostart(options), /autostart_conflict/);
  assert.equal(await readFile(file, 'utf8'), `${legacy}# foreign modification\n`);
  await writeFile(file, legacy);
  assert.equal((await disableRelayAutostart(options)).state, 'disabled');
});

test('Windows startup escapes paths as PowerShell literals without embedding credentials', () => {
  const script = windowsRelayStartupScript("C:\\A's Repo\\.dharma\\bin\\dharma.cmd", "C:\\A's Repo\\.dharma\\approved-policy.json");
  assert.match(script, /A''s Repo/);
  assert.match(script, /relay supervise --policy/);
  assert.doesNotMatch(script, /grant|token|password/i);
});

test('Linux enable, status and disable preserve an explicit OS registration receipt', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dharma-autostart-'));
  const calls: string[] = [];
  const run = async (file: string, args: string[]) => {
    calls.push(`${file} ${args.join(' ')}`);
    return { stdout: args.includes('is-enabled') ? 'enabled\n' : '' };
  };
  const options = {
    platform: 'linux' as const, home: join(root, 'dharma'), userHome: root,
    workspace: linuxWorkspace(root, 'repo'), launcher: join(root, 'repo', '.dharma', 'bin', 'dharma'),
    policy: join(root, 'repo', '.dharma', 'approved-policy.json'), version: '0.2.102', run,
  };
  const installed = await enableRelayAutostart(options);
  assert.equal(installed.state, 'enabled');
  assert.match(await readFile(join(root, '.config', 'systemd', 'user', 'dharma-agent-fabric.service'), 'utf8'), /relay supervise/);
  assert.match(calls.join('\n'), /systemctl --user enable dharma-agent-fabric.service/);
  assert.equal((await relayAutostartStatus(options)).state, 'enabled');
  assert.equal((await disableRelayAutostart(options)).state, 'disabled');
  assert.match(calls.join('\n'), /systemctl --user disable dharma-agent-fabric.service/);
});

test('startup status never calls a missing OS registration healthy', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dharma-autostart-missing-'));
  const result = await relayAutostartStatus({
    platform: 'linux', home: join(root, 'dharma'), userHome: root,
    run: async () => { throw new Error('No systemd user bus'); },
  });
  assert.equal(result.state, 'disabled');
});

test('a second standard repository preserves the verified user startup anchor on Linux and Windows', async () => {
  for (const platform of ['linux', 'win32'] as const) {
    const root = await mkdtemp(join(tmpdir(), 'dharma-startup-anchor-'));
    const calls: string[] = [];
    const run = async (file: string, args: string[]) => {
      const text = file === 'powershell.exe' ? Buffer.from(args.at(-1)!, 'base64').toString('utf16le') : args.join(' ');
      calls.push(text);
      return { stdout: text.includes("'exists'") ? 'absent\n' : 'enabled\n' };
    };
    const options = { platform, home: join(root, 'dharma'), userHome: root,
      workspace: platform === 'linux' ? '/fixtures/first' : 'C:\\first',
      launcher: platform === 'linux' ? '/fixtures/first/.dharma/bin/dharma' : 'C:\\first\\.dharma\\bin\\dharma.cmd',
      policy: platform === 'linux' ? '/fixtures/first/.dharma/approved-policy.json' : 'C:\\first\\.dharma\\approved-policy.json',
      version: '0.2.119', run };
    await enableRelayAutostart(options);
    const receipt = join(options.home, 'relay', 'autostart.json');
    const file = platform === 'linux' ? join(root, '.config', 'systemd', 'user', 'dharma-agent-fabric.service')
      : join(options.home, 'relay', 'autostart.ps1');
    const before = await readFile(receipt, 'utf8'), startup = await readFile(file, 'utf8');
    calls.length = 0;
    const second = { ...options, workspace: platform === 'linux' ? '/fixtures/second' : 'C:\\second',
      launcher: platform === 'linux' ? '/fixtures/second/.dharma/bin/dharma' : 'C:\\second\\.dharma\\bin\\dharma.cmd',
      policy: platform === 'linux' ? '/fixtures/second/.dharma/approved-policy.json' : 'C:\\second\\.dharma\\approved-policy.json',
      preserveStandardAnchor: true };
    assert.equal((await enableRelayAutostart(second)).state, 'enabled');
    assert.equal(await readFile(receipt, 'utf8'), before);
    assert.equal(await readFile(file, 'utf8'), startup);
    assert.ok(!calls.some(call => call.includes('daemon-reload') || call.includes('Register-ScheduledTask')));
    await assert.rejects(enableRelayAutostart({ ...second, version: '0.2.120' }), /relay_runtime_upgrade_required/);
    assert.equal(await readFile(receipt, 'utf8'), before);
    assert.equal(await readFile(file, 'utf8'), startup);
    await writeFile(file, `${startup}# foreign\n`);
    await assert.rejects(enableRelayAutostart(second), /autostart_conflict/);
    assert.equal(await readFile(file, 'utf8'), `${startup}# foreign\n`);
    assert.ok(!calls.join('\n').includes(second.launcher));
  }
});

test('Windows task registration uses the enrolled user without an embedded password', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dharma-windows-autostart-'));
  const calls: string[] = [];
  const run = async (_file: string, args: string[]) => {
    const decoded = Buffer.from(args.at(-1) || '', 'base64').toString('utf16le');
    calls.push(decoded);
    return { stdout: decoded.includes("'exists'") ? 'absent\n'
      : decoded.includes('Get-ScheduledTask') ? 'enabled\n' : '' };
  };
  const options = {
    platform: 'win32' as const, home: join(root, 'dharma'), userHome: root,
    workspace: 'C:\\Work Space\\repo', launcher: 'C:\\Work Space\\repo\\.dharma\\bin\\dharma.cmd',
    policy: 'C:\\Work Space\\repo\\.dharma\\approved-policy.json', version: '0.2.102', run,
  };
  assert.equal((await enableRelayAutostart(options)).state, 'enabled');
  const script = await readFile(join(root, 'dharma', 'relay', 'autostart.ps1'), 'utf8');
  assert.match(script, /DHARMA_HOME/);
  assert.match(calls.join('\n'), /-LogonType Interactive\b/);
  assert.doesNotMatch(calls.join('\n'), /-Password|bootstrapGrant|--grant/);
  assert.equal((await disableRelayAutostart(options)).state, 'disabled');
  assert.match(calls.at(-1) || '', /Unregister-ScheduledTask/);
});

test('failed OS registration remains unavailable instead of reporting completion', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dharma-failed-autostart-'));
  const options = {
    platform: 'linux' as const, home: join(root, 'dharma'), userHome: root,
    workspace: linuxWorkspace(root, 'repo'), launcher: join(root, 'repo', '.dharma', 'bin', 'dharma'),
    policy: join(root, 'repo', '.dharma', 'approved-policy.json'), version: '0.2.102',
    run: async () => { throw new Error('No systemd user bus'); },
  };
  await assert.rejects(enableRelayAutostart(options), /No systemd user bus/);
  assert.equal((await relayAutostartStatus(options)).state, 'unavailable');
});

test('registration refuses to replace an unmanaged user startup entry', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dharma-autostart-conflict-'));
  const unit = join(root, '.config', 'systemd', 'user', 'dharma-agent-fabric.service');
  await mkdir(join(root, '.config', 'systemd', 'user'), { recursive: true });
  await writeFile(unit, '[Service]\nExecStart=/custom/relay\n');
  await assert.rejects(enableRelayAutostart({
    platform: 'linux', home: join(root, 'dharma'), userHome: root,
    workspace: linuxWorkspace(root, 'repo'), launcher: join(root, 'repo', 'dharma'),
    policy: join(root, 'repo', 'policy.json'), version: '0.2.102',
    run: async () => ({ stdout: '' }),
  }), /autostart_conflict/);
  assert.equal(await readFile(unit, 'utf8'), '[Service]\nExecStart=/custom/relay\n');
});

test('Windows registration refuses an existing task without an ownership receipt', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dharma-task-conflict-'));
  await assert.rejects(enableRelayAutostart({
    platform: 'win32', home: join(root, 'dharma'), userHome: root,
    workspace: 'C:\\Work', launcher: 'C:\\Work\\dharma.cmd',
    policy: 'C:\\Work\\policy.json', version: '0.2.102',
    run: async (_file, args) => ({ stdout: Buffer.from(args.at(-1) || '', 'base64').toString('utf16le')
      .includes('Get-ScheduledTask') ? 'exists\n' : '' }),
  }), /autostart_conflict/);
});

test('Demo-only startup has no fake policy or persistent credential on either OS', () => {
  const linux = linuxRelayUnit('/opt/test launcher', null, '/opt/workspace', '/opt/private-home');
  const windows = windowsRelayStartupScript("C:\\A's Repo\\dharma.cmd", null, 'C:\\Private Home');
  assert.match(linux, /relay supervise --demo-only\n/);
  assert.match(windows, /relay supervise --demo-only\r\n/);
  assert.match(windows, /A''s Repo/);
  assert.doesNotMatch(linux + windows, /--policy|--grant|token|password/);
});

test('Linux Demo-only enable, repeat and disable use one owned versioned registration', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dharma-demo-autostart-'));
  const calls: string[] = [];
  const options = { platform: 'linux' as const, home: join(root, 'dharma'), userHome: root,
    workspace: linuxWorkspace(root, 'repo'), launcher: join(root, 'repo', 'dharma'),
    policy: null, version: '0.2.103', run: async (file: string, args: string[]) => {
      calls.push(`${file} ${args.join(' ')}`);
      return { stdout: args.includes('is-enabled') ? 'enabled\n' : '' };
    } };
  assert.equal((await enableRelayAutostart(options)).state, 'enabled');
  const receiptPath = join(options.home, 'relay', 'autostart.json');
  const first = JSON.parse(await readFile(receiptPath, 'utf8'));
  assert.equal(first.schema, 'dharma.relay-autostart/v2');
  assert.equal(first.mode, 'demo-only');
  assert.equal(first.policy, null);
  assert.doesNotMatch(JSON.stringify(first), /grant|token|credential/);
  assert.equal((await enableRelayAutostart(options)).state, 'enabled');
  assert.deepEqual(JSON.parse(await readFile(receiptPath, 'utf8')), first);
  assert.equal((await disableRelayAutostart(options)).state, 'disabled');
  assert.equal(calls.filter(call => call.includes(' disable ')).length, 1);
});

test('Windows Demo-only registration reuses the same task and verifies its script', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dharma-demo-task-'));
  const calls: string[] = [];
  const options = { platform: 'win32' as const, home: join(root, 'dharma'), userHome: root,
    workspace: 'C:\\Demo Repo', launcher: 'C:\\Demo Repo\\dharma.cmd', policy: null, version: '0.2.103',
    run: async (_file: string, args: string[]) => {
      const decoded = Buffer.from(args.at(-1) || '', 'base64').toString('utf16le');
      calls.push(decoded);
      return { stdout: decoded.includes("'exists'") ? 'absent\n'
        : decoded.includes('Get-ScheduledTask') ? 'enabled\n' : '' };
    } };
  assert.equal((await enableRelayAutostart(options)).state, 'enabled');
  const first = JSON.parse(await readFile(join(options.home, 'relay', 'autostart.json'), 'utf8'));
  assert.equal((await enableRelayAutostart(options)).state, 'enabled');
  const second = JSON.parse(await readFile(join(options.home, 'relay', 'autostart.json'), 'utf8'));
  assert.equal(second.taskName, first.taskName);
  assert.match(await readFile(join(options.home, 'relay', 'autostart.ps1'), 'utf8'), /relay supervise --demo-only/);
  assert.doesNotMatch(calls.join('\n'), /-Password|--grant/);
});

test('Demo enable preserves an existing standard policy and workspace rather than downgrading it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dharma-demo-standard-preserved-'));
  const options = { platform: 'linux' as const, home: join(root, 'dharma'), userHome: root,
    workspace: linuxWorkspace(root, 'standard'), launcher: join(root, 'standard', 'dharma'),
    policy: join(root, 'standard', 'policy.json'), version: '0.2.102',
    run: async (_file: string, args: string[]) => ({ stdout: args.includes('is-enabled') ? 'enabled\n' : '' }) };
  await enableRelayAutostart(options);
  await enableRelayAutostart({ ...options, workspace: linuxWorkspace(root, 'demo'),
    launcher: join(root, 'demo', 'dharma'), policy: null, version: '0.2.103' });
  const receipt = JSON.parse(await readFile(join(options.home, 'relay', 'autostart.json'), 'utf8'));
  assert.equal(receipt.schema, 'dharma.relay-autostart/v1');
  assert.equal(receipt.policy, options.policy);
  assert.equal(receipt.workspace, options.workspace);
  assert.equal(receipt.launcher, join(root, 'demo', 'dharma'));
  const unit = await readFile(join(root, '.config', 'systemd', 'user', 'dharma-agent-fabric.service'), 'utf8');
  assert.match(unit, /relay supervise --policy/);
  assert.doesNotMatch(unit, /--demo-only/);
});

test('Demo-only registration can be promoted to a standard enrollment without a competing service', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dharma-demo-standard-upgrade-'));
  const options = { platform: 'linux' as const, home: join(root, 'dharma'), userHome: root,
    workspace: linuxWorkspace(root, 'repo'), launcher: join(root, 'repo', 'dharma'), policy: null, version: '0.2.103',
    run: async (_file: string, args: string[]) => ({ stdout: args.includes('is-enabled') ? 'enabled\n' : '' }) };
  await enableRelayAutostart(options);
  const policy = join(root, 'standard', 'policy.json');
  await enableRelayAutostart({ ...options, policy, workspace: linuxWorkspace(root, 'standard') });
  const receipt = JSON.parse(await readFile(join(options.home, 'relay', 'autostart.json'), 'utf8'));
  assert.equal(receipt.schema, 'dharma.relay-autostart/v1');
  assert.equal(receipt.policy, policy);
});

test('modified startup files cannot be reported enabled or removed through an old receipt', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dharma-startup-tampered-'));
  const calls: string[][] = [];
  const options = { platform: 'linux' as const, home: join(root, 'dharma'), userHome: root,
    workspace: linuxWorkspace(root, 'repo'), launcher: join(root, 'repo', 'dharma'), policy: null, version: '0.2.103',
    run: async (_file: string, args: string[]) => {
      calls.push(args); return { stdout: args.includes('is-enabled') ? 'enabled\n' : '' };
    } };
  await enableRelayAutostart(options);
  const unit = join(root, '.config', 'systemd', 'user', 'dharma-agent-fabric.service');
  await writeFile(unit, '[Service]\nExecStart=/another/owner\n');
  calls.length = 0;
  assert.deepEqual(await relayAutostartStatus(options), { state: 'unavailable', backend: 'systemd-user',
    version: '0.2.103', reason: 'autostart_conflict' });
  await assert.rejects(disableRelayAutostart(options), /autostart_conflict/);
  assert.deepEqual(calls, []);
  assert.equal(await readFile(unit, 'utf8'), '[Service]\nExecStart=/another/owner\n');
});

test('invalid registration is unavailable and cannot be silently replaced or removed', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dharma-startup-receipt-invalid-'));
  const home = join(root, 'dharma');
  await mkdir(join(home, 'relay'), { recursive: true });
  const receiptPath = join(home, 'relay', 'autostart.json');
  await writeFile(receiptPath, '{malformed-private');
  const options = { home, userHome: root, platform: 'linux' as const,
    workspace: linuxWorkspace(root, 'repo'), launcher: join(root, 'repo', 'dharma'), policy: null, version: '0.2.103',
    run: async () => { throw new Error('Must not query OS for invalid ownership'); } };
  assert.equal((await relayAutostartStatus(options)).reason, 'autostart_receipt_invalid');
  await assert.rejects(enableRelayAutostart(options), /autostart_receipt_invalid/);
  await assert.rejects(disableRelayAutostart(options), /autostart_receipt_invalid/);
  assert.equal(await readFile(receiptPath, 'utf8'), '{malformed-private');
});

test('start invokes the single owned service and refuses a modified startup file', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dharma-start-owned-'));
  const calls: string[][] = [];
  const options = { platform: 'linux' as const, home: join(root, 'dharma'), userHome: root,
    workspace: linuxWorkspace(root, 'repo'), launcher: join(root, 'repo', 'dharma'), policy: null, version: '0.2.103',
    run: async (_file: string, args: string[]) => {
      calls.push(args); return { stdout: args.includes('is-enabled') ? 'enabled\n' : '' };
    } };
  await enableRelayAutostart(options);
  assert.equal((await startRelayAutostart(options)).state, 'start_requested');
  assert.deepEqual(calls.at(-1), ['--user', 'start', 'dharma-agent-fabric.service']);
  await writeFile(join(root, '.config', 'systemd', 'user', 'dharma-agent-fabric.service'), 'foreign');
  calls.length = 0;
  await assert.rejects(startRelayAutostart(options), /autostart_conflict/);
  assert.deepEqual(calls, []);
});

test('Windows owned operations guard the exact action, arguments, workspace and current user', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dharma-start-task-owned-'));
  const commands: string[] = [];
  const options = { platform: 'win32' as const, home: join(root, 'dharma'), userHome: root,
    workspace: 'C:\\Demo Repo', launcher: 'C:\\Demo Repo\\dharma.cmd', policy: null, version: '0.2.103',
    run: async (_file: string, args: string[]) => {
      const decoded = Buffer.from(args.at(-1) || '', 'base64').toString('utf16le');
      commands.push(decoded);
      return { stdout: decoded.includes("'exists'") ? 'absent\n'
        : decoded.includes('Get-ScheduledTask') ? 'enabled\n' : '' };
    } };
  await enableRelayAutostart(options);
  await enableRelayAutostart(options);
  await startRelayAutostart(options);
  await disableRelayAutostart(options);
  for (const verb of ['Start-ScheduledTask', 'Unregister-ScheduledTask']) {
    const command = commands.find(value => value.includes(verb))!;
    assert.match(command, /Actions/);
    assert.match(command, /Arguments/);
    assert.match(command, /WorkingDirectory/);
    assert.match(command, /definition\.Task\.Principals\.Principal/);
    assert.match(command, /WindowsIdentity/);
    assert.match(command, /\[xml\]\(Export-ScheduledTask/);
    assert.match(command, /-TaskPath \$task\.TaskPath -ErrorAction Stop/);
    assert.match(command, /\$principals\.Count -eq 1 -and \$principals\[0\]\.UserId -eq \$identity\.User\.Value/);
    assert.match(command, /autostart_conflict/);
    assert.ok(command.indexOf('autostart_conflict') < command.indexOf(verb));
  }
});
