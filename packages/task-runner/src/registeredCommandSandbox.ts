import { createHash, randomUUID } from 'node:crypto';
import { mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { createServer, type AddressInfo } from 'node:net';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import type { TaskEnvelope } from './index.js';

// Registered commands (acceptance commands and the external-effect receipt command) run code that
// the provider may have written. They run only inside a bubblewrap sandbox on Linux and WSL2: an
// empty root with read-only system folders, the task worktree as the only writable folder, no
// network, and a private process, IPC, host-name and cgroup view. Every other host refuses tasks
// that name them, before the provider starts. There is no opt-out.

/** Changes whenever the bubblewrap argument list changes. */
export const SANDBOX_POLICY_VERSION = 'bwrap-policy/2';
/** The command's home folder inside the sandbox: an empty temporary file system. */
export const SANDBOX_HOME = '/dharma-sandbox/home';
const SANDBOX_HOSTNAME = 'dharma-sandbox';
const MINIMUM_BWRAP = [0, 6, 0] as const;
const DISABLE_USERNS_BWRAP = [0, 8, 0] as const;
const BWRAP_PATHS = ['/usr/bin/bwrap', '/bin/bwrap'] as const;
const LAYOUT_NAMES = ['bin', 'sbin', 'lib', 'lib32', 'lib64', 'libx32'] as const;
const ETC_FILES = ['alternatives', 'ld.so.cache', 'ld.so.conf', 'ld.so.conf.d', 'localtime', 'nsswitch.conf',
  'passwd', 'group', 'hosts'] as const;

export type SandboxRefusalReason =
  | 'platform_unsupported'
  | 'bubblewrap_missing'
  | 'bubblewrap_too_old'
  | 'bubblewrap_untrusted'
  | 'user_namespaces_unavailable'
  | 'sandbox_probe_failed'
  | 'network_not_denied';

/** One fix line per refusal reason, shown in the relay start line and in the documentation. */
export const SANDBOX_FIX: Readonly<Record<SandboxRefusalReason, string>> = Object.freeze({
  platform_unsupported: 'Run the relay on Linux or WSL2; macOS and native Windows refuse tasks that name registered commands.',
  bubblewrap_missing: 'Install bubblewrap from the distribution (for example: sudo apt-get install bubblewrap), then restart the relay.',
  bubblewrap_too_old: 'Install bubblewrap 0.6.0 or newer from the distribution, then restart the relay.',
  bubblewrap_untrusted: 'Reinstall bubblewrap from the distribution so /usr/bin/bwrap is a root-owned, non-setuid file that only root can change.',
  user_namespaces_unavailable: 'Allow unprivileged user namespaces for bubblewrap (an administrator setting), use WSL2 rather than WSL1, and run the relay on the host rather than in a container.',
  sandbox_probe_failed: 'The sandbox started but a policy check failed; run the relay on a supported Linux or WSL2 host and report the named check.',
  network_not_denied: 'Give tasks that name registered commands the network authority deny.',
});

export type HostLayoutEntry = 'symlink' | 'directory' | 'absent';
export type HostLayout = Record<typeof LAYOUT_NAMES[number], HostLayoutEntry>;

/** One path of the relay's Node installation made visible inside the sandbox. */
export type NodeMount =
  | { kind: 'bind'; path: string }
  | { kind: 'symlink'; target: string; path: string };

export interface UsableSandbox {
  usable: true;
  host: 'linux' | 'wsl2';
  /** /usr/bin/bwrap or /bin/bwrap, never a PATH lookup. */
  bwrapPath: string;
  bwrapVersion: string;
  bwrapSha256: string;
  policy: string;
  layout: HostLayout;
  /** The relay's Node installation prefix (the folder above bin/node). */
  nodePrefix: string;
  /** True when the Node prefix is outside /usr and must be bound read-only. */
  bindNodePrefix: boolean;
  /**
   * The only Node paths visible when the prefix is bound: the Node binary, the npm package and the
   * npm/npx links into it. The rest of the prefix is not, because it can be a general per-user
   * folder (for example ~/.local) that also holds other tools' data.
   */
  nodeMounts: readonly NodeMount[];
  /** True on bubblewrap 0.8.0 or newer. */
  disableUserns: boolean;
  /**
   * The live probe that made this sandbox usable: the named policy checks it required, all of
   * which passed, and when it ran. A sandbox object exists outside the probe only when it passed.
   */
  probe: { checks: readonly string[]; probedAt: string };
}

export interface RefusedSandbox {
  usable: false;
  reason: SandboxRefusalReason;
  /** Names failed checks or host settings only, never file contents or environment values. */
  detail: string;
  fix: string;
}

export type RegisteredCommandSandbox = UsableSandbox | RefusedSandbox;

/** Thrown when bubblewrap exits without reporting its child: the command never ran, here or on the host. */
export class RegisteredCommandSandboxFailedError extends Error {
  readonly code = 'registered_command_sandbox_failed';

  constructor(readonly stderrFirstLine = '') {
    super('registered_command_sandbox_failed: the operating-system sandbox did not start the command; it was not run.');
    this.name = 'RegisteredCommandSandboxFailedError';
  }
}

function within(path: string, root: string) {
  const route = relative(root, path);
  return route === '' || (!route.startsWith('..') && !isAbsolute(route));
}

/**
 * The bubblewrap arguments for one command, without the bubblewrap path itself. Pure. The
 * environment is not on this list: it is passed as the spawn environment, because other host
 * processes can read a process's arguments.
 */
export function sandboxCommandLine(sandbox: UsableSandbox, input: { worktree: string; cwd: string; argv: string[] }): string[] {
  const { worktree, cwd, argv } = input;
  if (!isAbsolute(worktree) || !isAbsolute(cwd)) throw new Error('Sandbox paths must be absolute.');
  if (dirname(worktree) === worktree || dirname(dirname(worktree)) === dirname(worktree)) {
    throw new Error('The sandbox worktree must be a task worktree, not a top-level folder.');
  }
  if (!within(cwd, worktree)) throw new Error('The sandbox working directory must be inside the worktree.');
  if (argv.length === 0) throw new Error('The sandbox needs a command to run.');
  const args = ['--unshare-user', '--unshare-pid', '--unshare-ipc', '--unshare-uts', '--unshare-cgroup', '--unshare-net'];
  if (sandbox.disableUserns) args.push('--disable-userns');
  args.push('--die-with-parent', '--new-session', '--cap-drop', 'ALL', '--hostname', SANDBOX_HOSTNAME,
    '--json-status-fd', '3', '--ro-bind', '/usr', '/usr');
  for (const name of LAYOUT_NAMES) {
    if (sandbox.layout[name] === 'symlink') args.push('--symlink', `usr/${name}`, `/${name}`);
    else if (sandbox.layout[name] === 'directory') args.push('--ro-bind', `/${name}`, `/${name}`);
  }
  for (const name of ETC_FILES) args.push('--ro-bind-try', `/etc/${name}`, `/etc/${name}`);
  if (sandbox.bindNodePrefix) {
    for (const mount of sandbox.nodeMounts) {
      if (mount.kind === 'bind') args.push('--ro-bind', mount.path, mount.path);
      else args.push('--symlink', mount.target, mount.path);
    }
  }
  args.push('--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp', '--tmpfs', SANDBOX_HOME,
    '--bind', worktree, worktree, '--ro-bind', `${worktree}/.git`, `${worktree}/.git`,
    '--remount-ro', '/', '--chdir', cwd, '--', ...argv);
  return args;
}

/**
 * The sandboxed command's environment, from the explicit acceptance-command environment. Pure.
 * Home and temporary folders point at the sandbox's own empty ones; nothing is added from the
 * relay environment.
 */
export function sandboxCommandEnvironment(environment: Record<string, string>, sandbox: UsableSandbox): Record<string, string> {
  const result: Record<string, string> = { ...environment, HOME: SANDBOX_HOME, TMPDIR: '/tmp',
    XDG_CONFIG_HOME: `${SANDBOX_HOME}/.config`, XDG_CACHE_HOME: `${SANDBOX_HOME}/.cache` };
  if (sandbox.bindNodePrefix) {
    const nodeBin = `${sandbox.nodePrefix}/bin`;
    result.PATH = environment.PATH ? `${nodeBin}:${environment.PATH}` : nodeBin;
  }
  return result;
}

/** Parses bubblewrap's --json-status-fd records. */
export function parseSandboxStatus(text: string): { childPid: number | null; exitCode: number | null } {
  let childPid: number | null = null;
  let exitCode: number | null = null;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let record: unknown;
    try { record = JSON.parse(line); } catch { continue; }
    if (!record || typeof record !== 'object') continue;
    const pid = Reflect.get(record, 'child-pid');
    const code = Reflect.get(record, 'exit-code');
    if (Number.isInteger(pid)) childPid = pid as number;
    if (Number.isInteger(code)) exitCode = code as number;
  }
  return { childPid, exitCode };
}

/**
 * True when a task names registered commands: a non-empty `authority.commands` or
 * `acceptance.commands`. The relay checks this at preflight and `executeTask()` checks it again.
 */
export function taskNamesRegisteredCommands(task: Pick<TaskEnvelope, 'authority' | 'acceptance'>) {
  return task.authority.commands.length > 0 || task.acceptance.commands.length > 0;
}

/**
 * Admission for one task. Pure. Tasks without registered commands are admitted. Command-bearing
 * tasks need network `deny` (checked first, no probe cost) and a usable sandbox.
 */
export function registeredCommandAdmission(task: Pick<TaskEnvelope, 'authority' | 'acceptance'>,
  sandbox: RegisteredCommandSandbox | undefined): { admitted: true } | { admitted: false; reason: SandboxRefusalReason } {
  if (!taskNamesRegisteredCommands(task)) return { admitted: true };
  if (task.authority.network !== 'deny') return { admitted: false, reason: 'network_not_denied' };
  if (!sandbox) return { admitted: false, reason: 'sandbox_probe_failed' };
  if (!sandbox.usable) return { admitted: false, reason: sandbox.reason };
  return { admitted: true };
}

/** The receipt revision that records the command sandbox. A receipt without `schema` is revision 1. */
export const TASK_RECEIPT_SCHEMA = 'dharma.task-receipt/v2';

/**
 * The command sandbox a task receipt records. `sandboxed`: the task names registered commands and
 * was admitted with this probed sandbox, whether or not a command ran before the task ended.
 * `not_used`: the task names no registered command, so no sandbox was used. `unavailable`: a
 * receipt written after a receiver restart for an execution journalled before receipts recorded
 * the sandbox.
 */
export type TaskReceiptCommandSandbox =
  | {
    state: 'sandboxed';
    host: 'linux' | 'wsl2';
    bwrapPath: string;
    bwrapVersion: string;
    bwrapSha256: string;
    policy: string;
    probe: { result: 'passed'; checks: string[]; probedAt: string };
  }
  | { state: 'not_used' }
  | { state: 'unavailable' };

/** The receipt tuple for a task admitted with `sandbox`. Pure. */
export function taskReceiptCommandSandbox(task: Pick<TaskEnvelope, 'authority' | 'acceptance'>,
  sandbox: RegisteredCommandSandbox | undefined): TaskReceiptCommandSandbox {
  if (!taskNamesRegisteredCommands(task)) return { state: 'not_used' };
  if (!sandbox?.usable) throw new Error('Task receipt command sandbox is invalid.');
  const tuple: TaskReceiptCommandSandbox = { state: 'sandboxed', host: sandbox.host, bwrapPath: sandbox.bwrapPath,
    bwrapVersion: sandbox.bwrapVersion, bwrapSha256: sandbox.bwrapSha256, policy: sandbox.policy,
    probe: { result: 'passed', checks: [...sandbox.probe.checks], probedAt: sandbox.probe.probedAt } };
  assertValidTaskReceiptCommandSandbox(tuple);
  return tuple;
}

const SANDBOXED_KEYS = ['bwrapPath', 'bwrapSha256', 'bwrapVersion', 'host', 'policy', 'probe', 'state'].join();

/** Checks a recorded tuple against schemas/task-receipt-v2.schema.json (`$defs.commandSandbox`). */
export function assertValidTaskReceiptCommandSandbox(value: unknown): asserts value is TaskReceiptCommandSandbox {
  const invalid = () => new Error('Task receipt command sandbox is invalid.');
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid();
  const tuple = value as Record<string, unknown>;
  const keys = Object.keys(tuple).sort().join();
  if (tuple.state === 'not_used' || tuple.state === 'unavailable') {
    if (keys !== 'state') throw invalid();
    return;
  }
  if (tuple.state !== 'sandboxed' || keys !== SANDBOXED_KEYS
    || !['linux', 'wsl2'].includes(String(tuple.host))
    || !(BWRAP_PATHS as readonly unknown[]).includes(tuple.bwrapPath)
    || typeof tuple.bwrapVersion !== 'string' || !/^[0-9]{1,4}\.[0-9]{1,4}\.[0-9]{1,4}$/.test(tuple.bwrapVersion)
    || typeof tuple.bwrapSha256 !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(tuple.bwrapSha256)
    || typeof tuple.policy !== 'string' || !/^bwrap-policy\/[1-9][0-9]{0,3}$/.test(tuple.policy)) throw invalid();
  const probe = tuple.probe;
  if (!probe || typeof probe !== 'object' || Array.isArray(probe)) throw invalid();
  const { result, checks, probedAt } = probe as Record<string, unknown>;
  if (Object.keys(probe).sort().join() !== 'checks,probedAt,result' || result !== 'passed'
    || !Array.isArray(checks) || checks.length < 1 || checks.length > 32
    || checks.some(check => typeof check !== 'string' || !/^[a-z][a-z0-9_]{0,63}$/.test(check))
    || new Set(checks).size !== checks.length
    || typeof probedAt !== 'string' || !Number.isFinite(Date.parse(probedAt))) throw invalid();
}

/** One JSON line for the relay start log. */
export function registeredCommandSandboxLogLine(sandbox: RegisteredCommandSandbox): string {
  return JSON.stringify(sandbox.usable
    ? { event: 'registered_command_sandbox', usable: true, host: sandbox.host, bwrapPath: sandbox.bwrapPath,
      bwrapVersion: sandbox.bwrapVersion, bwrapSha256: sandbox.bwrapSha256, policy: sandbox.policy }
    : { event: 'registered_command_sandbox', usable: false, reason: sandbox.reason, detail: sandbox.detail, fix: sandbox.fix,
      effect: 'tasks that name registered commands are refused' });
}

/** Named checks the probe command reports. */
export const PROBE_CHECKS = Object.freeze({
  base: Object.freeze(['outside_canary_hidden', 'home_hidden', 'relay_process_hidden', 'network_denied',
    'outside_write_denied', 'worktree_writable', 'git_pointer_readonly', 'descriptors_closed',
    'capabilities_dropped', 'sockets_hidden']),
  disableUserns: Object.freeze(['nested_userns_denied']),
  wsl: Object.freeze(['wsl_interop_cut']),
});

// Runs inside the sandbox through the production argument builder. Its only argument is a JSON
// object of paths, a process id, a port and a synthetic sentinel. It prints one JSON line of
// named true/false checks and nothing else.
const PROBE_SCRIPT = String.raw`
const fs = require('node:fs'), path = require('node:path'), net = require('node:net'), cp = require('node:child_process');
const a = JSON.parse(process.argv[1]);
const exists = p => { try { fs.lstatSync(p); return true; } catch { return false; } };
const writable = p => { try { fs.writeFileSync(p, 'probe'); try { fs.unlinkSync(p); } catch {} return true; } catch { return false; } };
const inside = (p, root) => p === root || p.startsWith(root.endsWith('/') ? root : root + '/');
const keep = [a.worktree].concat(a.nodePaths);
const onlyPathsTo = dir => {
  let names; try { names = fs.readdirSync(dir); } catch { return true; }
  for (const name of names) {
    const full = path.join(dir, name);
    if (keep.includes(full)) continue;
    if (keep.some(k => inside(k, full))) { if (!onlyPathsTo(full)) return false; continue; }
    return false;
  }
  return true;
};
const environHas = value => {
  if (Object.values(process.env).includes(value)) return true;
  for (const pid of fs.readdirSync('/proc').filter(name => /^\d+$/.test(name))) {
    try { if (fs.readFileSync('/proc/' + pid + '/environ').includes(value)) return true; } catch {}
  }
  return false;
};
const checks = {};
checks.outside_canary_hidden = !exists(a.outsideCanary);
checks.home_hidden = !exists(a.home) || onlyPathsTo(a.home);
checks.relay_process_hidden = !exists('/proc/' + a.relayPid) && !environHas(a.sentinel);
// The worktree's parent may sit inside the sandbox's private /tmp, so a write there is tried and
// the host checks afterwards that it did not arrive.
try { fs.writeFileSync(a.outsideWrite, 'probe'); } catch {}
checks.outside_write_denied = ['/', '/usr', '/etc'].every(dir => !writable(path.join(dir, '.dharma-probe-' + process.pid)));
checks.worktree_writable = writable(path.join(a.worktree, '.dharma-probe-' + process.pid));
checks.git_pointer_readonly = (() => {
  const pointer = path.join(a.worktree, '.git');
  try { fs.appendFileSync(pointer, ''); return false; } catch {}
  try { fs.renameSync(pointer, pointer + '.moved'); fs.renameSync(pointer + '.moved', pointer); return false; } catch {}
  return true;
})();
checks.descriptors_closed = fs.readdirSync('/proc/self/fd').map(Number).filter(fd => fd > 2).every(fd => {
  let target = ''; try { target = fs.readlinkSync('/proc/self/fd/' + fd); } catch { return true; }
  return !target.startsWith('socket:') && !target.startsWith('/');
});
checks.capabilities_dropped = /\nCapEff:\s*0+\n/.test(fs.readFileSync('/proc/self/status', 'utf8'));
checks.sockets_hidden = !exists('/run') && !exists('/var') && !process.env.SSH_AUTH_SOCK
  && !process.env.DBUS_SESSION_BUS_ADDRESS && !process.env.XDG_RUNTIME_DIR;
if (a.checks.includes('nested_userns_denied')) {
  const result = cp.spawnSync('/usr/bin/unshare', ['--user', 'true'], { stdio: 'ignore', windowsHide: true });
  checks.nested_userns_denied = !result.error && result.status !== 0;
}
if (a.checks.includes('wsl_interop_cut')) {
  const program = path.join(a.worktree, '.dharma-probe.exe');
  let ran = false;
  try { fs.writeFileSync(program, Buffer.from('MZ')); fs.chmodSync(program, 0o755); ran = cp.spawnSync(program, [], { stdio: 'ignore', windowsHide: true }).status === 0; } catch {}
  try { fs.unlinkSync(program); } catch {}
  checks.wsl_interop_cut = !ran && !exists('/init') && !exists('/mnt') && !exists('/run/WSL') && !process.env.WSL_INTEROP;
}
const devices = fs.readFileSync('/proc/net/dev', 'utf8').split('\n').slice(2).map(line => line.split(':')[0].trim()).filter(Boolean);
const socket = net.connect(a.port, '127.0.0.1');
let done = false;
const finish = reached => {
  if (done) return; done = true; socket.destroy();
  checks.network_denied = !reached && devices.join(',') === 'lo';
  process.stdout.write(JSON.stringify({ checks }) + '\n');
  process.exit(0);
};
socket.once('connect', () => finish(true));
socket.once('error', () => finish(false));
setTimeout(() => finish(false), 2000);
`;

export interface SandboxedRun {
  /** False when bubblewrap never reported its child: the command did not start. */
  started: boolean;
  exitCode: number | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
}

type FileStats = { isFile(): boolean; isSymbolicLink(): boolean; isDirectory(): boolean; uid: number; mode: number };

export interface ProbeDependencies {
  platform: NodeJS.Platform;
  relayStateDirectory: string;
  execPath: string;
  homedir: () => string;
  relayPid: number;
  lstat: (path: string) => Promise<FileStats>;
  readlink: (path: string) => Promise<string>;
  realpath: (path: string) => Promise<string>;
  readFile: (path: string) => Promise<Buffer>;
  execFile: (file: string, args: string[], options: { env: Record<string, string>; timeout: number }) => Promise<{ stdout: string; stderr: string }>;
  /** Runs one command through the production sandbox launcher. */
  runSandboxed: (sandbox: UsableSandbox, input: { worktree: string; cwd: string; argv: string[];
    env: Record<string, string>; timeoutMs: number }) => Promise<SandboxedRun>;
  /** Builds the command environment from a source environment, as the acceptance loop does. */
  commandEnvironment?: (source: NodeJS.ProcessEnv, cwd: string) => Record<string, string>;
}

function refused(reason: SandboxRefusalReason, detail: string): RefusedSandbox {
  return { usable: false, reason, detail, fix: SANDBOX_FIX[reason] };
}

function version(text: string): [number, number, number] | null {
  const match = /^bubblewrap (\d+)\.(\d+)\.(\d+)/m.exec(text);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

function atLeast(value: readonly number[], minimum: readonly number[]) {
  for (let index = 0; index < 3; index++) {
    if (value[index]! !== minimum[index]!) return value[index]! > minimum[index]!;
  }
  return true;
}

const missing = (error: unknown) => ['ENOENT', 'ENOTDIR'].includes(String((error as NodeJS.ErrnoException)?.code));

async function hostSettings(deps: ProbeDependencies) {
  const values: string[] = [];
  for (const [name, path] of [
    ['apparmor_restrict_unprivileged_userns', '/proc/sys/kernel/apparmor_restrict_unprivileged_userns'],
    ['max_user_namespaces', '/proc/sys/user/max_user_namespaces'],
    ['unprivileged_userns_clone', '/proc/sys/kernel/unprivileged_userns_clone'],
  ] as const) {
    const value = await deps.readFile(path).then(buffer => buffer.toString('utf8').trim(), () => 'absent');
    values.push(`${name}=${/^\d+$/.test(value) ? value : 'absent'}`);
  }
  return values.join(' ');
}

/**
 * Probes the sandbox policy on this host by running a check command through the production
 * argument builder and launcher. Runs before every task that names registered commands; a
 * "usable" answer is never cached. Never throws: an unexpected error is `sandbox_probe_failed`.
 */
export async function probeRegisteredCommandSandbox(deps: ProbeDependencies): Promise<RegisteredCommandSandbox> {
  if (deps.platform !== 'linux') return refused('platform_unsupported', `platform=${deps.platform}`);
  try {
    const osRelease = await deps.readFile('/proc/sys/kernel/osrelease').then(buffer => buffer.toString('utf8'), () => '');
    const host = /microsoft/i.test(osRelease) ? 'wsl2' as const : 'linux' as const;

    let bwrapPath: string | null = null;
    let bwrapStats: FileStats | null = null;
    for (const candidate of BWRAP_PATHS) {
      try { bwrapStats = await deps.lstat(candidate); bwrapPath = candidate; break; }
      catch (error) { if (!missing(error)) throw error; }
    }
    if (!bwrapPath || !bwrapStats) return refused('bubblewrap_missing', `looked at ${BWRAP_PATHS.join(', ')}`);
    const untrusted: string[] = [];
    if (bwrapStats.isSymbolicLink() || !bwrapStats.isFile()) untrusted.push('not_regular_file');
    if (bwrapStats.uid !== 0) untrusted.push('not_root_owned');
    if ((bwrapStats.mode & 0o022) !== 0) untrusted.push('writable_by_group_or_others');
    if ((bwrapStats.mode & 0o6000) !== 0) untrusted.push('setuid_or_setgid');
    if (untrusted.length) return refused('bubblewrap_untrusted', `${bwrapPath}: ${untrusted.join(', ')}`);

    const versionOutput = await deps.execFile(bwrapPath, ['--version'], { env: { PATH: '/usr/bin:/bin' }, timeout: 2_000 })
      .then(({ stdout }) => stdout, () => '');
    const parsed = version(versionOutput);
    if (!parsed || !atLeast(parsed, MINIMUM_BWRAP)) {
      return refused('bubblewrap_too_old', parsed ? `version=${parsed.join('.')}` : 'version unreadable');
    }
    const bwrapSha256 = `sha256:${createHash('sha256').update(await deps.readFile(bwrapPath)).digest('hex')}`;

    const layout = {} as HostLayout;
    for (const name of LAYOUT_NAMES) {
      try {
        const entry = await deps.lstat(`/${name}`);
        if (entry.isSymbolicLink()) {
          const target = await deps.readlink(`/${name}`);
          layout[name] = target === `usr/${name}` || target === `/usr/${name}` ? 'symlink' : 'directory';
        } else layout[name] = entry.isDirectory() || !entry.isFile() ? 'directory' : 'absent';
      } catch (error) {
        if (!missing(error)) throw error;
        layout[name] = 'absent';
      }
    }
    const node = await deps.realpath(deps.execPath);
    const nodePrefix = dirname(dirname(node));
    const bindNodePrefix = !within(nodePrefix, '/usr');
    if (nodePrefix === '/' || within('/proc', nodePrefix) || within(deps.relayStateDirectory, nodePrefix)) {
      return refused('sandbox_probe_failed', 'failed checks: node_prefix_supported');
    }
    const nodeMounts = bindNodePrefix ? await nodeInstallationMounts(deps, nodePrefix, node) : [];
    const disableUserns = atLeast(parsed, DISABLE_USERNS_BWRAP);
    const checks = Object.freeze([...PROBE_CHECKS.base, ...(disableUserns ? PROBE_CHECKS.disableUserns : []),
      ...(host === 'wsl2' ? PROBE_CHECKS.wsl : [])]);
    // Returned only when every one of these checks passes.
    const sandbox: UsableSandbox = { usable: true, host, bwrapPath, bwrapVersion: parsed.join('.'), bwrapSha256,
      policy: SANDBOX_POLICY_VERSION, layout, nodePrefix, bindNodePrefix, nodeMounts, disableUserns,
      probe: { checks, probedAt: new Date().toISOString() } };
    return await runProbe(deps, sandbox, node);
  } catch (error) {
    return refused('sandbox_probe_failed', `probe error ${String((error as NodeJS.ErrnoException)?.code ?? 'unexpected')}`);
  }
}

/**
 * The Node paths to show inside the sandbox: the Node binary, `<prefix>/lib/node_modules/npm` when
 * it is a folder, and `<prefix>/bin/npm` and `npx` when they are links into that folder.
 */
async function nodeInstallationMounts(deps: ProbeDependencies, nodePrefix: string, node: string): Promise<NodeMount[]> {
  const mounts: NodeMount[] = [{ kind: 'bind', path: node }];
  const npm = `${nodePrefix}/lib/node_modules/npm`;
  const npmEntry = await deps.lstat(npm).catch((error: unknown) => { if (missing(error)) return null; throw error; });
  if (!npmEntry || npmEntry.isSymbolicLink() || !npmEntry.isDirectory()) return mounts;
  mounts.push({ kind: 'bind', path: npm });
  for (const name of ['npm', 'npx']) {
    const link = `${nodePrefix}/bin/${name}`;
    if (link === node) continue;
    const entry = await deps.lstat(link).catch((error: unknown) => { if (missing(error)) return null; throw error; });
    if (!entry?.isSymbolicLink()) continue;
    const target = await deps.readlink(link);
    const resolved = resolve(dirname(link), target);
    if (resolved !== npm && within(resolved, npm)) mounts.push({ kind: 'symlink', target, path: link });
  }
  return mounts;
}

async function runProbe(deps: ProbeDependencies, sandbox: UsableSandbox, node: string): Promise<RegisteredCommandSandbox> {
  const probeRoot = resolve(deps.relayStateDirectory, 'sandbox-probe', randomUUID());
  const worktree = resolve(probeRoot, 'worktree');
  const outsideCanary = resolve(probeRoot, 'outside-canary');
  const outsideWrite = resolve(probeRoot, 'outside-write');
  const server = createServer(socket => socket.destroy());
  try {
    await mkdir(worktree, { recursive: true, mode: 0o700 });
    await writeFile(resolve(worktree, '.git'), 'gitdir: /dharma-sandbox-probe/not-a-repository\n');
    await writeFile(outsideCanary, 'synthetic canary\n');
    await new Promise<void>((accept, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', accept); });
    const sentinel = randomUUID();
    const checks = sandbox.probe.checks;
    const args = { outsideCanary, outsideWrite, home: deps.homedir(), relayPid: deps.relayPid, sentinel, worktree,
      nodePaths: sandbox.bindNodePrefix ? sandbox.nodeMounts.map(mount => mount.path) : [], port: (server.address() as AddressInfo).port, checks };
    const source = { ...process.env, SANDBOX_PROBE_SENTINEL: sentinel };
    const env = deps.commandEnvironment ? deps.commandEnvironment(source, worktree)
      : { PATH: process.env.PATH ?? '/usr/bin:/bin', DHARMA_TASK_WORKTREE: worktree };
    const run = await deps.runSandboxed(sandbox, { worktree, cwd: worktree,
      argv: [node, '-e', PROBE_SCRIPT, JSON.stringify(args)], env, timeoutMs: 10_000 });
    const firstLine = run.stderr.split('\n').find(line => line.trim()) ?? '';
    // bubblewrap reports its child as soon as it is cloned. A host that lets the user namespace be
    // created but then denies setting it up (for example an AppArmor restriction) fails after
    // that, with bubblewrap's own message and no probe output.
    const setupFailed = run.started && run.exitCode !== 0 && !run.stdout.trim() && firstLine.startsWith('bwrap:');
    if (!run.started || setupFailed) {
      return refused('user_namespaces_unavailable',
        `${firstLine.slice(0, 200)}${firstLine ? '; ' : ''}${await hostSettings(deps)}`);
    }
    if (run.timedOut) return refused('sandbox_probe_failed', 'probe timed out');
    if (run.exitCode !== 0) return refused('sandbox_probe_failed', `probe exit code ${run.exitCode}`);
    let reported: Record<string, unknown> = {};
    try {
      const line = run.stdout.trim().split('\n').at(-1) ?? '';
      const parsed = JSON.parse(line) as { checks?: unknown };
      if (parsed.checks && typeof parsed.checks === 'object') reported = parsed.checks as Record<string, unknown>;
    } catch { return refused('sandbox_probe_failed', 'probe output unreadable'); }
    const leaked = await stat(outsideWrite).then(() => true, () => false);
    if (leaked) reported.outside_write_denied = false;
    const failed = checks.filter(name => reported[name] !== true);
    if (failed.length) return refused('sandbox_probe_failed', `failed checks: ${failed.join(', ')}`);
    return sandbox;
  } finally {
    await new Promise<void>(accept => server.close(() => accept()));
    await rm(probeRoot, { recursive: true, force: true }).catch(() => undefined);
  }
}
