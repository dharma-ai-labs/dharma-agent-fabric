import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import {
  PROBE_CHECKS,
  SANDBOX_FIX,
  SANDBOX_HOME,
  SANDBOX_POLICY_VERSION,
  parseSandboxStatus,
  probeRegisteredCommandSandbox,
  registeredCommandAdmission,
  registeredCommandSandboxLogLine,
  sandboxCommandEnvironment,
  sandboxCommandLine,
  type HostLayout,
  type ProbeDependencies,
  type SandboxRefusalReason,
  type UsableSandbox,
} from './index.js';

// Tests for running registered commands inside an operating-system sandbox.
// Everything here is pure or uses injected dependencies, so it runs on every operating system.
// registeredCommandSandbox.linux.test.ts runs the real bubblewrap on Linux.

const MERGED_USR: HostLayout = { bin: 'symlink', sbin: 'symlink', lib: 'symlink', lib32: 'absent', lib64: 'symlink', libx32: 'absent' };
const SPLIT_USR: HostLayout = { bin: 'directory', sbin: 'directory', lib: 'directory', lib32: 'absent', lib64: 'directory', libx32: 'absent' };

function usable(overrides: Partial<UsableSandbox> = {}): UsableSandbox {
  return {
    usable: true, host: 'linux', bwrapPath: '/usr/bin/bwrap', bwrapVersion: '0.9.0',
    bwrapSha256: `sha256:${'a'.repeat(64)}`, policy: SANDBOX_POLICY_VERSION, layout: MERGED_USR,
    nodePrefix: '/usr', bindNodePrefix: false, nodeMounts: [], disableUserns: true, ...overrides,
  };
}

const W = '/home/relay/.dharma/relay/worktrees/task_1';
const NAMESPACE_FLAGS = ['--unshare-user', '--unshare-pid', '--unshare-ipc', '--unshare-uts', '--unshare-cgroup', '--unshare-net'];
const MOUNT_FLAGS = new Set(['--ro-bind', '--ro-bind-try', '--bind', '--bind-try', '--dev-bind', '--dev-bind-try',
  '--symlink', '--tmpfs', '--proc', '--dev', '--dir', '--file', '--bind-data', '--ro-bind-data']);

function mounts(args: string[]) {
  const result: Array<{ flag: string; source: string; destination: string }> = [];
  const end = args.indexOf('--');
  for (let index = 0; index < end; index++) {
    const flag = args[index]!;
    if (['--ro-bind', '--ro-bind-try', '--bind', '--bind-try', '--dev-bind', '--dev-bind-try', '--symlink'].includes(flag)) {
      result.push({ flag, source: args[index + 1]!, destination: args[index + 2]! }); index += 2;
    } else if (['--tmpfs', '--proc', '--dev', '--dir'].includes(flag)) {
      result.push({ flag, source: '', destination: args[index + 1]! }); index += 1;
    }
  }
  return result;
}

test('argument list for merged /usr, Node under /usr, bubblewrap 0.9.0', () => {
  assert.deepEqual(sandboxCommandLine(usable(), { worktree: W, cwd: W, argv: ['npm', 'run', 'test'] }), [
    ...NAMESPACE_FLAGS, '--disable-userns',
    '--die-with-parent', '--new-session', '--cap-drop', 'ALL', '--hostname', 'dharma-sandbox', '--json-status-fd', '3',
    '--ro-bind', '/usr', '/usr',
    '--symlink', 'usr/bin', '/bin', '--symlink', 'usr/sbin', '/sbin', '--symlink', 'usr/lib', '/lib',
    '--symlink', 'usr/lib64', '/lib64',
    '--ro-bind-try', '/etc/alternatives', '/etc/alternatives',
    '--ro-bind-try', '/etc/ld.so.cache', '/etc/ld.so.cache',
    '--ro-bind-try', '/etc/ld.so.conf', '/etc/ld.so.conf',
    '--ro-bind-try', '/etc/ld.so.conf.d', '/etc/ld.so.conf.d',
    '--ro-bind-try', '/etc/localtime', '/etc/localtime',
    '--ro-bind-try', '/etc/nsswitch.conf', '/etc/nsswitch.conf',
    '--ro-bind-try', '/etc/passwd', '/etc/passwd',
    '--ro-bind-try', '/etc/group', '/etc/group',
    '--ro-bind-try', '/etc/hosts', '/etc/hosts',
    '--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp', '--tmpfs', SANDBOX_HOME,
    '--bind', W, W, '--ro-bind', `${W}/.git`, `${W}/.git`,
    '--remount-ro', '/', '--chdir', W, '--', 'npm', 'run', 'test',
  ]);
});

const OPT_NODE = '/opt/hostedtoolcache/node/22.22.0/x64';
const OPT_NODE_MOUNTS = [
  { kind: 'bind', path: `${OPT_NODE}/bin/node` },
  { kind: 'bind', path: `${OPT_NODE}/lib/node_modules/npm` },
  { kind: 'symlink', target: '../lib/node_modules/npm/bin/npm-cli.js', path: `${OPT_NODE}/bin/npm` },
] as const;

test('argument list for split /usr, Node under /opt, bubblewrap 0.6.1', () => {
  const sandbox = usable({ layout: SPLIT_USR, bwrapVersion: '0.6.1', disableUserns: false,
    nodePrefix: OPT_NODE, bindNodePrefix: true, nodeMounts: OPT_NODE_MOUNTS });
  const args = sandboxCommandLine(sandbox, { worktree: W, cwd: `${W}/packages/a`, argv: ['node', '--test'] });
  assert.equal(args.includes('--disable-userns'), false, 'bubblewrap below 0.8.0 has no --disable-userns');
  for (const name of ['bin', 'sbin', 'lib', 'lib64']) {
    const index = args.findIndex((value, i) => value === '--ro-bind' && args[i + 1] === `/${name}`);
    assert.ok(index > 0, `/${name} is bound read-only on split /usr`);
    assert.equal(args[index + 2], `/${name}`);
  }
  assert.deepEqual(mounts(args).filter(({ destination }) => destination.startsWith(OPT_NODE))
    .map(({ flag, source, destination }) => [flag, source, destination]), [
    ['--ro-bind', `${OPT_NODE}/bin/node`, `${OPT_NODE}/bin/node`],
    ['--ro-bind', `${OPT_NODE}/lib/node_modules/npm`, `${OPT_NODE}/lib/node_modules/npm`],
    ['--symlink', '../lib/node_modules/npm/bin/npm-cli.js', `${OPT_NODE}/bin/npm`],
  ], 'only the Node binary, the npm package and its link are visible; the prefix itself and its etc folder are not');
  assert.equal(args[args.indexOf('--chdir') + 1], `${W}/packages/a`);
});

test('argument list keeps every hard rule', () => {
  const variants = [usable(), usable({ layout: SPLIT_USR, disableUserns: false, bwrapVersion: '0.6.1' }),
    usable({ nodePrefix: OPT_NODE, bindNodePrefix: true, nodeMounts: OPT_NODE_MOUNTS })];
  for (const sandbox of variants) {
    const argv = ['npm', 'run', '--', '--sandbox=off', '--bind', '/', '/'];
    const args = sandboxCommandLine(sandbox, { worktree: W, cwd: W, argv });
    const separator = args.indexOf('--');
    assert.deepEqual(args.slice(separator + 1), argv, 'the command argv follows the -- separator unchanged');
    for (const flag of NAMESPACE_FLAGS) {
      assert.ok(args.slice(0, separator).includes(flag), `${flag} is present`);
      assert.equal(args.includes(`${flag}-try`), false, `${flag}-try is never used`);
    }
    assert.equal(args.slice(0, separator).some(value => value === '--share-net' || value === '--setenv'
      || value === '--clearenv' || value === '--unsetenv'), false);
    const list = mounts(args);
    const allowedSources = new Set(['/usr', '/bin', '/sbin', '/lib', '/lib32', '/lib64', '/libx32', W, `${W}/.git`,
      ...sandbox.nodeMounts.filter(({ kind }) => kind === 'bind').map(({ path }) => path)]);
    for (const { flag, source } of list) {
      if (flag === '--symlink' || source === '') continue;
      if (source.startsWith('/etc/')) { assert.equal(flag, '--ro-bind-try'); continue; }
      assert.ok(allowedSources.has(source), `mount source ${source} is allowed`);
    }
    for (const forbidden of ['/run', '/var', '/sys', '/mnt', '/home', '/root', '/init', '/tmp', '/home/relay',
      '/home/relay/.dharma', '/home/relay/.dharma/relay']) {
      assert.equal(list.some(({ flag, source }) => flag !== '--symlink' && source === forbidden), false, `${forbidden} is never a source`);
    }
    const remount = args.indexOf('--remount-ro');
    assert.equal(args[remount + 1], '/');
    const lastMount = Math.max(...args.slice(0, separator).map((value, index) => MOUNT_FLAGS.has(value) ? index : -1));
    assert.ok(remount > lastMount, '--remount-ro / comes after the last mount');
    const write = list.filter(({ flag }) => flag === '--bind');
    assert.deepEqual(write.map(({ source }) => source), [W], 'the worktree is the only read-write bind');
  }
});

test('argument list rejects a working directory outside the worktree and relative paths', () => {
  assert.throws(() => sandboxCommandLine(usable(), { worktree: W, cwd: '/home/relay', argv: ['true'] }), /working directory/i);
  assert.throws(() => sandboxCommandLine(usable(), { worktree: 'relative', cwd: 'relative', argv: ['true'] }), /absolute/i);
  assert.throws(() => sandboxCommandLine(usable(), { worktree: '/', cwd: '/', argv: ['true'] }), /worktree/i);
  assert.throws(() => sandboxCommandLine(usable(), { worktree: W, cwd: W, argv: [] }), /command/i);
});

test('environment transform rewrites home and temporary folders and adds nothing from the relay environment', () => {
  const before = { ...process.env };
  process.env.SANDBOX_TEST_RELAY_ONLY = 'relay-only-value';
  try {
    const source = { PATH: '/usr/bin:/bin', HOME: '/home/relay', TMPDIR: '/var/tmp', XDG_CONFIG_HOME: '/home/relay/.config',
      LANG: 'C.UTF-8', DHARMA_TASK_WORKTREE: W, PERMITTED_INPUT: 'kept' };
    const plain = sandboxCommandEnvironment(source, usable());
    assert.deepEqual(plain, { PATH: '/usr/bin:/bin', HOME: SANDBOX_HOME, TMPDIR: '/tmp',
      XDG_CONFIG_HOME: `${SANDBOX_HOME}/.config`, XDG_CACHE_HOME: `${SANDBOX_HOME}/.cache`,
      LANG: 'C.UTF-8', DHARMA_TASK_WORKTREE: W, PERMITTED_INPUT: 'kept' });
    const withPrefix = sandboxCommandEnvironment(source, usable({ nodePrefix: '/opt/node', bindNodePrefix: true }));
    assert.equal(withPrefix.PATH, '/opt/node/bin:/usr/bin:/bin');
    assert.equal(Object.hasOwn(withPrefix, 'SANDBOX_TEST_RELAY_ONLY'), false);
    assert.deepEqual(source.HOME, '/home/relay', 'the input is not changed');
    const args = sandboxCommandLine(usable(), { worktree: W, cwd: W, argv: ['true'] });
    for (const value of Object.values(plain)) {
      // These three are mount points, so they are on the list as paths, not as environment values.
      if ([W, SANDBOX_HOME, '/tmp'].includes(value)) continue;
      assert.equal(args.includes(value), false, `environment value ${value} is not on the argument list`);
    }
  } finally { process.env = before; }
});

test('status descriptor records are parsed line by line', () => {
  assert.deepEqual(parseSandboxStatus(''), { childPid: null, exitCode: null });
  assert.deepEqual(parseSandboxStatus('{ "child-pid": 42 }\n'), { childPid: 42, exitCode: null });
  assert.deepEqual(parseSandboxStatus('{ "child-pid": 42, "cgroup-namespace": 1 }\n{ "exit-code": 3 }\n'), { childPid: 42, exitCode: 3 });
  assert.deepEqual(parseSandboxStatus('garbage\n{ "exit-code": 0 }'), { childPid: null, exitCode: 0 });
});

type Call = string;
function stats(overrides: Partial<{ file: boolean; link: boolean; dir: boolean; uid: number; mode: number }> = {}) {
  const value = { file: true, link: false, dir: false, uid: 0, mode: 0o100755, ...overrides };
  return { isFile: () => value.file, isSymbolicLink: () => value.link, isDirectory: () => value.dir, uid: value.uid, mode: value.mode };
}

function probeDeps(calls: Call[], overrides: Partial<ProbeDependencies> = {}): ProbeDependencies {
  const enoent = () => Object.assign(new Error('missing'), { code: 'ENOENT' });
  return {
    platform: 'linux',
    relayStateDirectory: '',
    execPath: '/usr/bin/node',
    homedir: () => '/home/relay',
    relayPid: 4242,
    lstat: async (path: string) => {
      calls.push(`lstat:${path}`);
      if (path === '/usr/bin/bwrap') return stats();
      if (['/bin', '/sbin', '/lib', '/lib64'].includes(path)) return stats({ file: false, link: true });
      throw enoent();
    },
    readlink: async (path: string) => { calls.push(`readlink:${path}`); return `usr${path}`; },
    realpath: async (path: string) => { calls.push(`realpath:${path}`); return path; },
    readFile: async (path: string) => {
      calls.push(`readFile:${path}`);
      if (path === '/proc/sys/kernel/osrelease') return Buffer.from('6.8.0-1015-azure\n');
      if (path === '/usr/bin/bwrap') return Buffer.from('synthetic bubblewrap');
      if (path === '/proc/sys/kernel/apparmor_restrict_unprivileged_userns') return Buffer.from('1\n');
      if (path === '/proc/sys/user/max_user_namespaces') return Buffer.from('63429\n');
      throw enoent();
    },
    execFile: async (file: string, args: string[]) => {
      calls.push(`execFile:${file} ${args.join(' ')}`);
      return { stdout: 'bubblewrap 0.9.0\n', stderr: '' };
    },
    runSandboxed: async () => {
      calls.push('runSandboxed');
      return { started: true, exitCode: 0, timedOut: false,
        stdout: `${JSON.stringify({ checks: Object.fromEntries([...PROBE_CHECKS.base, ...PROBE_CHECKS.disableUserns].map(name => [name, true])) })}\n`,
        stderr: '' };
    },
    ...overrides,
  };
}

async function withState<T>(run: (directory: string) => Promise<T>) {
  const directory = await mkdtemp(resolve(tmpdir(), 'dharma-sandbox-probe-unit-'));
  try { return await run(directory); } finally { await rm(directory, { recursive: true, force: true }); }
}

test('macOS and native Windows refuse with no file access and no process start', async () => {
  for (const platform of ['darwin', 'win32'] as const) {
    const calls: Call[] = [];
    const result = await probeRegisteredCommandSandbox(probeDeps(calls, { platform }));
    assert.deepEqual(result, { usable: false, reason: 'platform_unsupported',
      detail: `platform=${platform}`, fix: SANDBOX_FIX.platform_unsupported });
    assert.deepEqual(calls, []);
  }
});

test('bubblewrap is looked up only at fixed paths and must be trusted and recent', async () => {
  const cases: Array<[string, Partial<ProbeDependencies>, SandboxRefusalReason]> = [
    ['missing', { lstat: async () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); } }, 'bubblewrap_missing'],
    ['too old', { execFile: async () => ({ stdout: 'bubblewrap 0.5.0\n', stderr: '' }) }, 'bubblewrap_too_old'],
    ['unparseable version', { execFile: async () => ({ stdout: 'bwrap\n', stderr: '' }) }, 'bubblewrap_too_old'],
    ['not root-owned', { lstat: async () => stats({ uid: 1000 }) }, 'bubblewrap_untrusted'],
    ['writable by others', { lstat: async () => stats({ mode: 0o100777 }) }, 'bubblewrap_untrusted'],
    ['writable by group', { lstat: async () => stats({ mode: 0o100775 }) }, 'bubblewrap_untrusted'],
    ['setuid', { lstat: async () => stats({ mode: 0o104755 }) }, 'bubblewrap_untrusted'],
    ['symbolic link', { lstat: async () => stats({ file: false, link: true }) }, 'bubblewrap_untrusted'],
  ];
  for (const [name, overrides, reason] of cases) {
    const calls: Call[] = [];
    const result = await withState(directory => probeRegisteredCommandSandbox(probeDeps(calls, { relayStateDirectory: directory, ...overrides })));
    assert.equal(result.usable, false, name);
    if (result.usable) continue;
    assert.equal(result.reason, reason, name);
    assert.equal(result.fix, SANDBOX_FIX[reason]);
    assert.equal(calls.includes('runSandboxed'), false, `${name}: the probe command never starts`);
    assert.equal(calls.some(call => call.startsWith('execFile:') && !call.startsWith('execFile:/usr/bin/bwrap')
      && !call.startsWith('execFile:/bin/bwrap')), false, `${name}: bubblewrap is never looked up on PATH`);
  }
});

test('a sandbox that never reports its child is user_namespaces_unavailable with the host settings', async () => {
  const calls: Call[] = [];
  const result = await withState(directory => probeRegisteredCommandSandbox(probeDeps(calls, { relayStateDirectory: directory,
    runSandboxed: async () => ({ started: false, exitCode: 1, timedOut: false, stdout: '',
      stderr: 'bwrap: setting up uid map: Permission denied\nsecond line\n' }) })));
  assert.equal(result.usable, false);
  if (result.usable) return;
  assert.equal(result.reason, 'user_namespaces_unavailable');
  assert.match(result.detail, /bwrap: setting up uid map: Permission denied/);
  assert.doesNotMatch(result.detail, /second line/);
  assert.match(result.detail, /apparmor_restrict_unprivileged_userns=1/);
  assert.match(result.detail, /max_user_namespaces=63429/);
  assert.match(result.detail, /unprivileged_userns_clone=absent/);
});

test('a bubblewrap setup error after the child is reported is also user_namespaces_unavailable', async () => {
  const result = await withState(directory => probeRegisteredCommandSandbox(probeDeps([], { relayStateDirectory: directory,
    runSandboxed: async () => ({ started: true, exitCode: 1, timedOut: false, stdout: '',
      stderr: 'bwrap: setting up uid map: Permission denied\n' }) })));
  assert.equal(result.usable ? 'usable' : result.reason, 'user_namespaces_unavailable');
  assert.match(result.usable ? '' : result.detail, /^bwrap: setting up uid map: Permission denied; apparmor_restrict_unprivileged_userns=1/);
});

test('a write the probe made outside the worktree that reaches the host fails outside_write_denied', async () => {
  const result = await withState(directory => probeRegisteredCommandSandbox(probeDeps([], { relayStateDirectory: directory,
    runSandboxed: async (_sandbox, input) => {
      const { outsideWrite } = JSON.parse(input.argv.at(-1)!) as { outsideWrite: string };
      await writeFile(outsideWrite, 'arrived on the host');
      return { started: true, exitCode: 0, timedOut: false, stderr: '',
        stdout: `${JSON.stringify({ checks: Object.fromEntries([...PROBE_CHECKS.base, ...PROBE_CHECKS.disableUserns].map(name => [name, true])) })}\n` };
    } })));
  assert.equal(result.usable ? 'usable' : result.detail, 'failed checks: outside_write_denied');
});

test('a failed policy check is sandbox_probe_failed and names only the check', async () => {
  const checks = Object.fromEntries([...PROBE_CHECKS.base, ...PROBE_CHECKS.disableUserns].map(name => [name, true]));
  checks.home_hidden = false;
  const calls: Call[] = [];
  const result = await withState(directory => probeRegisteredCommandSandbox(probeDeps(calls, { relayStateDirectory: directory,
    runSandboxed: async () => ({ started: true, exitCode: 0, timedOut: false,
      stdout: `${JSON.stringify({ checks, leaked: '/home/relay/.ssh/id_ed25519' })}\n`, stderr: 'secret-looking stderr' }) })));
  assert.equal(result.usable, false);
  if (result.usable) return;
  assert.equal(result.reason, 'sandbox_probe_failed');
  assert.equal(result.detail, 'failed checks: home_hidden');
  for (const variant of [
    { started: true, exitCode: 1, timedOut: false, stdout: 'secret-stdout', stderr: 'secret-stderr' },
    { started: true, exitCode: null, timedOut: true, stdout: '', stderr: '' },
    { started: true, exitCode: 0, timedOut: false, stdout: '{"checks":{}}\n', stderr: '' },
  ]) {
    const failed = await withState(directory => probeRegisteredCommandSandbox(probeDeps([], { relayStateDirectory: directory,
      runSandboxed: async () => variant })));
    assert.equal(failed.usable ? 'usable' : failed.reason, 'sandbox_probe_failed');
    assert.equal(failed.usable ? '' : failed.detail.includes('secret'), false);
  }
});

test('a passing probe returns a usable sandbox bound to the probed bubblewrap', async () => {
  const calls: Call[] = [];
  let probeInput: Parameters<ProbeDependencies['runSandboxed']>[1] | undefined;
  const result = await withState(directory => probeRegisteredCommandSandbox(probeDeps(calls, { relayStateDirectory: directory,
    runSandboxed: async (sandbox, input) => {
      probeInput = input;
      assert.equal(sandbox.bwrapPath, '/usr/bin/bwrap');
      return { started: true, exitCode: 0, timedOut: false, stderr: '',
        stdout: `${JSON.stringify({ checks: Object.fromEntries([...PROBE_CHECKS.base, ...PROBE_CHECKS.disableUserns].map(name => [name, true])) })}\n` };
    } })));
  assert.equal(result.usable, true);
  if (!result.usable) return;
  assert.deepEqual({ ...result, bwrapSha256: result.bwrapSha256.slice(0, 7) }, {
    usable: true, host: 'linux', bwrapPath: '/usr/bin/bwrap', bwrapVersion: '0.9.0', bwrapSha256: 'sha256:',
    policy: SANDBOX_POLICY_VERSION, layout: MERGED_USR, nodePrefix: '/usr', bindNodePrefix: false, nodeMounts: [],
    disableUserns: true,
  });
  assert.match(result.bwrapSha256, /^sha256:[0-9a-f]{64}$/);
  assert.ok(calls.includes('execFile:/usr/bin/bwrap --version'));
  assert.ok(probeInput, 'the probe ran through the production sandbox runner');
  assert.equal(probeInput!.argv[0], '/usr/bin/node');
  assert.equal(Object.keys(probeInput!.env).includes('SANDBOX_PROBE_SENTINEL'), false,
    'the sentinel added to the source environment does not reach the command environment');
  const args = JSON.parse(probeInput!.argv.at(-1)!) as { sentinel: string; relayPid: number; home: string };
  assert.equal(args.relayPid, 4242);
  assert.equal(args.home, '/home/relay');
  assert.match(args.sentinel, /^[0-9a-f-]{36}$/);
});

test('a relay Node installed in a general folder under the home exposes only node and npm, never the whole folder', async () => {
  // Node unpacked into ~/.local (or installed there by a version manager): the folder above
  // bin/node also holds the user's share/ and state/ folders, where tools keep credentials.
  const prefix = '/home/relay/.local';
  const enoent = () => Object.assign(new Error('missing'), { code: 'ENOENT' });
  let probeArgs = '';
  let probed: UsableSandbox | undefined;
  const base = probeDeps([]);
  const result = await withState(directory => probeRegisteredCommandSandbox(probeDeps([], { relayStateDirectory: directory,
    execPath: `${prefix}/bin/node`,
    lstat: async (path: string) => {
      if (path === `${prefix}/lib/node_modules/npm`) return stats({ file: false, dir: true });
      if (path === `${prefix}/bin/npm` || path === `${prefix}/bin/npx`) return stats({ file: false, link: true });
      if (path === `${prefix}/etc` || path.startsWith(`${prefix}/`)) throw enoent();
      return base.lstat(path);
    },
    readlink: async (path: string) => {
      if (path === `${prefix}/bin/npm`) return '../lib/node_modules/npm/bin/npm-cli.js';
      if (path === `${prefix}/bin/npx`) return '../lib/node_modules/npm/bin/npx-cli.js';
      return base.readlink(path);
    },
    runSandboxed: async (sandbox, input) => {
      probed = sandbox;
      probeArgs = input.argv.at(-1)!;
      return { started: true, exitCode: 0, timedOut: false, stderr: '',
        stdout: `${JSON.stringify({ checks: Object.fromEntries([...PROBE_CHECKS.base, ...PROBE_CHECKS.disableUserns].map(name => [name, true])) })}\n` };
    } })));
  assert.equal(result.usable, true);
  if (!result.usable) return;
  assert.equal(probed, result, 'the probe ran with the same mounts the commands get');
  const args = sandboxCommandLine(result, { worktree: W, cwd: W, argv: ['npm', 'test'] });
  const underPrefix = mounts(args).filter(({ flag, destination }) => flag !== '--symlink' && destination.startsWith(prefix));
  assert.deepEqual(underPrefix.map(({ flag, source, destination }) => [flag, source, destination]), [
    ['--ro-bind', `${prefix}/bin/node`, `${prefix}/bin/node`],
    ['--ro-bind', `${prefix}/lib/node_modules/npm`, `${prefix}/lib/node_modules/npm`],
  ], 'only the Node binary and the npm package are bound from the prefix');
  const links = mounts(args).filter(({ flag, destination }) => flag === '--symlink' && destination.startsWith(prefix));
  assert.deepEqual(links.map(({ source, destination }) => [source, destination]), [
    ['../lib/node_modules/npm/bin/npm-cli.js', `${prefix}/bin/npm`],
    ['../lib/node_modules/npm/bin/npx-cli.js', `${prefix}/bin/npx`],
  ]);
  assert.equal(sandboxCommandEnvironment({ PATH: '/usr/bin:/bin' }, result).PATH, `${prefix}/bin:/usr/bin:/bin`);
  const parsed = JSON.parse(probeArgs) as Record<string, unknown>;
  assert.equal(Object.values(parsed).some(value => value === prefix
    || (Array.isArray(value) && value.includes(prefix))), false,
  'the probe does not count the whole prefix as an allowed path under the home');
});

test('npm links that leave the npm package are not recreated in the sandbox', async () => {
  const prefix = '/home/relay/.nvm/versions/node/v22.22.0';
  const enoent = () => Object.assign(new Error('missing'), { code: 'ENOENT' });
  const base = probeDeps([]);
  const result = await withState(directory => probeRegisteredCommandSandbox(probeDeps([], { relayStateDirectory: directory,
    execPath: `${prefix}/bin/node`,
    lstat: async (path: string) => {
      if (path === `${prefix}/lib/node_modules/npm`) return stats({ file: false, dir: true });
      if (path === `${prefix}/bin/npm` || path === `${prefix}/bin/npx`) return stats({ file: false, link: true });
      if (path.startsWith(`${prefix}/`)) throw enoent();
      return base.lstat(path);
    },
    readlink: async (path: string) => {
      if (path === `${prefix}/bin/npm`) return '../../../../../.ssh/id_ed25519';
      if (path === `${prefix}/bin/npx`) return '/home/relay/.local/share/tool/auth.json';
      return base.readlink(path);
    } })));
  assert.equal(result.usable, true);
  if (!result.usable) return;
  const args = sandboxCommandLine(result, { worktree: W, cwd: W, argv: ['true'] });
  assert.deepEqual(mounts(args).filter(({ destination }) => destination.startsWith(prefix)).map(({ flag, source }) => [flag, source]), [
    ['--ro-bind', `${prefix}/bin/node`],
    ['--ro-bind', `${prefix}/lib/node_modules/npm`],
  ]);
});

test('WSL hosts must also prove the Windows interop cut', async () => {
  let checksRequested: string[] = [];
  const result = await withState(directory => probeRegisteredCommandSandbox(probeDeps([], { relayStateDirectory: directory,
    readFile: async (path: string) => {
      if (path === '/proc/sys/kernel/osrelease') return Buffer.from('5.15.167.4-microsoft-standard-WSL2\n');
      if (path === '/usr/bin/bwrap') return Buffer.from('x');
      throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    },
    runSandboxed: async (_sandbox, input) => {
      checksRequested = JSON.parse(input.argv.at(-1)!).checks;
      const names = [...PROBE_CHECKS.base, ...PROBE_CHECKS.disableUserns];
      return { started: true, exitCode: 0, timedOut: false, stderr: '',
        stdout: `${JSON.stringify({ checks: Object.fromEntries(names.map(name => [name, true])) })}\n` };
    } })));
  assert.ok(checksRequested.includes('wsl_interop_cut'));
  assert.equal(result.usable ? 'usable' : result.reason, 'sandbox_probe_failed', 'a missing interop check refuses');
});

test('admission: tasks without commands pass; network first; then the probe result', () => {
  const task = (commands: string[], network = 'deny') => ({
    authority: { commands: commands.map(commandId => ({ commandId })), network },
    acceptance: { commands: commands.map(commandId => ({ commandId })) },
  }) as never;
  const refused = { usable: false as const, reason: 'bubblewrap_missing' as const, detail: '', fix: SANDBOX_FIX.bubblewrap_missing };
  assert.deepEqual(registeredCommandAdmission(task([]), undefined), { admitted: true });
  assert.deepEqual(registeredCommandAdmission(task([], 'allow'), refused), { admitted: true });
  assert.deepEqual(registeredCommandAdmission(task(['repo.test'], 'allow'), usable()), { admitted: false, reason: 'network_not_denied' });
  assert.deepEqual(registeredCommandAdmission(task(['repo.test'], 'allowlist'), refused), { admitted: false, reason: 'network_not_denied' });
  assert.deepEqual(registeredCommandAdmission(task(['repo.test']), refused), { admitted: false, reason: 'bubblewrap_missing' });
  assert.deepEqual(registeredCommandAdmission(task(['repo.test']), undefined), { admitted: false, reason: 'sandbox_probe_failed' });
  assert.deepEqual(registeredCommandAdmission(task(['repo.test']), usable()), { admitted: true });
});

test('every refusal reason has one fix line and the relay start line shows it', () => {
  const reasons: SandboxRefusalReason[] = ['platform_unsupported', 'bubblewrap_missing', 'bubblewrap_too_old',
    'bubblewrap_untrusted', 'user_namespaces_unavailable', 'sandbox_probe_failed', 'network_not_denied'];
  assert.deepEqual(Object.keys(SANDBOX_FIX).sort(), [...reasons].sort());
  for (const reason of reasons) {
    assert.equal(SANDBOX_FIX[reason].includes('\n'), false);
    const line = JSON.parse(registeredCommandSandboxLogLine({ usable: false, reason, detail: 'd', fix: SANDBOX_FIX[reason] }));
    assert.deepEqual(line, { event: 'registered_command_sandbox', usable: false, reason, detail: 'd', fix: SANDBOX_FIX[reason],
      effect: 'tasks that name registered commands are refused' });
  }
  const line = JSON.parse(registeredCommandSandboxLogLine(usable()));
  assert.deepEqual(line, { event: 'registered_command_sandbox', usable: true, host: 'linux', bwrapPath: '/usr/bin/bwrap',
    bwrapVersion: '0.9.0', bwrapSha256: `sha256:${'a'.repeat(64)}`, policy: SANDBOX_POLICY_VERSION });
});

test('the customer guide names what is not visible inside the sandbox and asks for namespace changes only on that reason', async () => {
  const guide = await readFile(new URL('../../../docs/onboarding/customer-guide.md', import.meta.url), 'utf8');
  const section = guide.slice(guide.indexOf('## Host requirements for registered commands'));
  const requirements = section.slice(0, section.indexOf('\n## ', 1));
  assert.match(requirements, /`\/opt`/, 'toolchains under /opt are named as not visible');
  assert.match(requirements, /OpenJDK/, 'distribution packages that keep configuration under /etc are named');
  assert.match(requirements, /exit code/, 'the symptom of a missing toolchain is named');
  assert.doesNotMatch(requirements, /install bubblewrap, allow user\s+namespaces, then restart/,
    'enrolled devices change user namespaces only when the relay reports user_namespaces_unavailable');
  assert.match(requirements, /only if[\s\S]{0,80}`user_namespaces_unavailable`/);
});

test('plausible opt-out names change nothing', async () => {
  const before = { ...process.env };
  for (const name of ['DHARMA_SANDBOX', 'DHARMA_UNSAFE_COMMANDS', 'DHARMA_DISABLE_SANDBOX', 'DHARMA_ALLOW_UNSANDBOXED_COMMANDS', 'DHARMA_SANDBOX_EXPECT']) {
    process.env[name] = name === 'DHARMA_SANDBOX' ? 'off' : '1';
  }
  try {
    for (const platform of ['darwin', 'win32'] as const) {
      const result = await probeRegisteredCommandSandbox(probeDeps([], { platform }));
      assert.equal(result.usable ? 'usable' : result.reason, 'platform_unsupported');
    }
    const missing = await withState(directory => probeRegisteredCommandSandbox(probeDeps([], { relayStateDirectory: directory,
      lstat: async () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); } })));
    assert.equal(missing.usable ? 'usable' : missing.reason, 'bubblewrap_missing');
    const task = { authority: { commands: [{ commandId: 'repo.test' }], network: 'deny' }, acceptance: { commands: [] } } as never;
    assert.deepEqual(registeredCommandAdmission(task, undefined), { admitted: false, reason: 'sandbox_probe_failed' });
    const args = sandboxCommandLine(usable(), { worktree: W, cwd: W, argv: ['true'] });
    assert.ok(args.includes('--unshare-net'));
  } finally { process.env = before; }
});
