import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  disableRelayAutostart, enableRelayAutostart, linuxRelayUnit,
  relayAutostartStatus, windowsRelayStartupScript,
} from './relayAutostart.js';

test('Linux startup invokes only the pinned launcher and canonical policy', () => {
  const unit = linuxRelayUnit('/home/a b/repo/.dharma/bin/dharma', '/home/a b/repo/.dharma/approved-policy.json', '/home/a b/repo');
  assert.match(unit, /ExecStart="\/home\/a b\/repo\/\.dharma\/bin\/dharma" relay supervise --policy/);
  assert.match(unit, /Restart=on-failure/);
  assert.doesNotMatch(unit, /grant|token|password/i);
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
    workspace: join(root, 'repo'), launcher: join(root, 'repo', '.dharma', 'bin', 'dharma'),
    policy: join(root, 'repo', '.dharma', 'approved-policy.json'), version: '0.2.101', run,
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
    policy: 'C:\\Work Space\\repo\\.dharma\\approved-policy.json', version: '0.2.101', run,
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
    workspace: join(root, 'repo'), launcher: join(root, 'repo', '.dharma', 'bin', 'dharma'),
    policy: join(root, 'repo', '.dharma', 'approved-policy.json'), version: '0.2.101',
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
    workspace: join(root, 'repo'), launcher: join(root, 'repo', 'dharma'),
    policy: join(root, 'repo', 'policy.json'), version: '0.2.101',
    run: async () => ({ stdout: '' }),
  }), /autostart_conflict/);
  assert.equal(await readFile(unit, 'utf8'), '[Service]\nExecStart=/custom/relay\n');
});

test('Windows registration refuses an existing task without an ownership receipt', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dharma-task-conflict-'));
  await assert.rejects(enableRelayAutostart({
    platform: 'win32', home: join(root, 'dharma'), userHome: root,
    workspace: 'C:\\Work', launcher: 'C:\\Work\\dharma.cmd',
    policy: 'C:\\Work\\policy.json', version: '0.2.101',
    run: async (_file, args) => ({ stdout: Buffer.from(args.at(-1) || '', 'base64').toString('utf16le')
      .includes('Get-ScheduledTask') ? 'exists\n' : '' }),
  }), /autostart_conflict/);
});
