import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, readdir, readFile, readlink, realpath } from 'node:fs/promises';
import { userInfo } from 'node:os';
import { dirname, join, posix, win32 } from 'node:path';

type Launchers = { shell: string; windows: string };
const VERSION = /^(?=.{1,64}$)\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/;
// providerDirectory lists the bin directories of the set-up providers, the first one first on PATH.
type LauncherRuntime = {platform: NodeJS.Platform; nodeDirectory: string; npmCliPath?: string;
  providerDirectory?: string | readonly string[]};
// Executable names of the local provider adapters. A launcher prepends the bin directories of the ones set up.
const PROVIDER_COMMANDS = ['codex', 'claude', 'agy', 'hermes'] as const;
export type ProviderCommand = typeof PROVIDER_COMMANDS[number];
const unsafeProviderOnPath = (provider: ProviderCommand) => `relay_startup_${provider}_path_invalid: the first ${provider} on PATH `
  + `belongs to another user or is not protected. Put your own ${provider} first on PATH, or remove the other one from PATH.`
  + ` If you set up another provider, pass --provider <${PROVIDER_COMMANDS.join('|')}>.`;

/**
 * The resolved provider bin directories, once each, in the order of the PATH they were resolved from. A symlinked
 * entry's real directory takes that entry's place, so each provider stays first on PATH where setup found it (CLI
 * 0.2.224 review round 2). One no PATH entry reaches, kept from the launcher being replaced, follows in the given order.
 */
export async function providerDirectoriesInPathOrder(directories: readonly (string | undefined)[],
  searchPath: string | undefined): Promise<string[]> {
  const order = (searchPath ?? '').split(':');
  const unique = [...new Set(directories.filter((directory): directory is string => directory !== undefined))];
  let real: (string | undefined)[] | undefined;
  const rank = new Map<string, number>();
  for (const directory of unique) {
    let index = order.indexOf(directory);
    if (index < 0) {
      real ??= await Promise.all(order.map(entry => posix.isAbsolute(entry) ? realpath(entry).catch(() => undefined) : undefined));
      index = real.indexOf(directory);
    }
    rank.set(directory, index < 0 ? order.length : index);
  }
  return unique.sort((left, right) => rank.get(left)! - rank.get(right)!);
}

function providerDirectoryPath(value: string) {
  if (!value || value.length > 4096 || !posix.isAbsolute(value) || value === '/'
    || posix.resolve(value) !== value || /[\x00-\x1f\x7f:]/.test(value)) {
    throw new Error('relay_startup_provider_path_invalid');
  }
  return value;
}

export function stableRepositoryLauncherContents(version: string,
  runtime?: LauncherRuntime): Launchers {
  if (!VERSION.test(version)) throw new Error('Managed launcher version is invalid.');
  // Preserve journal/rollback bytes; newly extracted packages must not inherit group-writable modes.
  const [major, minor, patch] = version.split('-')[0]!.split('.').map(Number);
  const privatePackageFiles = major! > 0 || minor! > 2 || minor === 2 && patch! >= 206;
  let shellEnvironment = '', windowsEnvironment = '';
  if (runtime) {
    const directory = runtime.nodeDirectory;
    if (!directory || directory.length > 4096 || /[\r\n\0]/.test(directory)
      || !(runtime.platform === 'win32' ? win32 : posix).isAbsolute(directory)) {
      throw new Error('Managed launcher runtime directory is invalid.');
    }
    if (runtime.platform === 'win32') {
      if (directory.includes('"')) throw new Error('Managed launcher runtime directory is invalid.');
      windowsEnvironment = `setlocal DisableDelayedExpansion\r\nset "PATH=${directory.replace(/%/g, '%%')};%PATH%"\r\n`;
    } else shellEnvironment = `export PATH='${directory.replace(/'/g, "'\\''")}':"$PATH"\n`;
  }
  const invocation = `npm exec --yes -- @dharma-ai-labs/agent-fabric@${version}`;
  const npmArguments = `exec --yes ${privatePackageFiles ? '--umask=077 ' : ''}-- @dharma-ai-labs/agent-fabric@${version}`;
  let shellInvocation = `npm ${npmArguments}`;
  if (runtime?.npmCliPath !== undefined) {
    const entry = runtime.npmCliPath;
    if (runtime.platform !== 'linux' || !posix.isAbsolute(entry) || posix.basename(entry) !== 'npm-cli.js'
      || entry.length > 4096 || /[\r\n\0]/.test(entry)) {
      throw new Error('Managed launcher npm path is invalid.');
    }
    const quote = (value: string) => `'${value.replace(/'/g, "'\\''")}'`;
    shellInvocation = `${quote(posix.join(runtime.nodeDirectory, 'node'))} ${quote(entry)} ${npmArguments}`;
  }
  if (runtime?.providerDirectory !== undefined) {
    const directories = typeof runtime.providerDirectory === 'string' ? [runtime.providerDirectory] : [...runtime.providerDirectory];
    if (runtime.platform !== 'linux' || !directories.length || new Set(directories).size !== directories.length) {
      throw new Error('relay_startup_provider_path_invalid');
    }
    // Preserve only the qualified provider bin directories, not the login environment. Each line prepends, so the
    // last one written is first on PATH.
    for (const directory of directories.reverse().map(providerDirectoryPath)) {
      shellEnvironment += `export PATH='${directory.replace(/'/g, "'\\''")}':"$PATH"\n`;
    }
  }
  return { shell: `#!/bin/sh\n${shellEnvironment}${privatePackageFiles ? 'umask 077\n' : ''}exec ${shellInvocation} "$@"\n`,
    windows: `@echo off\r\n${windowsEnvironment}${invocation} %*\r\n` };
}

function recordedRuntime(version: string, launchers: Launchers, platform: NodeJS.Platform) {
  try {
    if (typeof launchers.shell !== 'string' || typeof launchers.windows !== 'string'
      || launchers.shell.length > 16384 || launchers.windows.length > 16384) return undefined;
    // Normalize only for parsing. Exact regeneration below still requires both protection clauses.
    let shell = launchers.shell.replace('\numask 077\nexec ', '\nexec ')
      .replace(' exec --yes --umask=077 -- ', ' exec --yes -- ');
    const providerPrefix = platform === 'linux'
      ? shell.match(/^#!\/bin\/sh\nexport PATH='([^\n]*)':"\$PATH"\n((?:export PATH='[^\n]*':"\$PATH"\n)+)/) : undefined;
    const providerDirectories = providerPrefix ? [...providerPrefix[2]!.matchAll(/export PATH='([^\n]*)':"\$PATH"\n/g)]
      .map(line => providerDirectoryPath(line[1]!.replace(/'\\''/g, "'"))).reverse() : undefined;
    const providerDirectory = providerDirectories?.length === 1 ? providerDirectories[0] : providerDirectories;
    if (providerPrefix) shell = `#!/bin/sh\nexport PATH='${providerPrefix[1]}':"$PATH"\n` + shell.slice(providerPrefix[0].length);
    const captured = platform === 'win32'
      ? launchers.windows.match(/^@echo off\r\nsetlocal DisableDelayedExpansion\r\nset "PATH=([^\r\n]*);%PATH%"\r\n/)?.[1]
      : shell.match(/^#!\/bin\/sh\nexport PATH='([^\n]*)':"\$PATH"\n/)?.[1];
    if (!captured) return undefined;
    const directory = platform === 'win32' ? captured.replace(/%%/g, '%') : captured.replace(/'\\''/g, "'");
    let npmCliPath: string | undefined;
    if (platform === 'linux') {
      const quote = (value: string) => `'${value.replace(/'/g, "'\\''")}'`;
      const prefix = `#!/bin/sh\nexport PATH=${quote(directory)}:"$PATH"\nexec ${quote(posix.join(directory, 'node'))} `;
      const suffix = ` exec --yes -- @dharma-ai-labs/agent-fabric@${version} "$@"\n`;
      if (shell.startsWith(prefix) && shell.endsWith(suffix)) {
        const token = shell.slice(prefix.length, -suffix.length);
        if (!token.startsWith("'") || !token.endsWith("'")) return undefined;
        npmCliPath = token.slice(1, -1).replace(/'\\''/g, "'");
      }
    }
    const runtime = {platform, nodeDirectory: directory, ...(npmCliPath === undefined ? {} : {npmCliPath}),
      ...(providerDirectory === undefined ? {} : {providerDirectory})};
    const expected = stableRepositoryLauncherContents(version, runtime);
    return expected.shell === launchers.shell && expected.windows === launchers.windows ? runtime : undefined;
  } catch { return undefined; }
}

export function recordedRepositoryNodeDirectory(version: string, launchers: Launchers, platform: NodeJS.Platform) {
  return recordedRuntime(version, launchers, platform)?.nodeDirectory;
}

async function protectedNpmCli(path: string, platform: NodeJS.Platform) {
  if (!(platform === 'win32' ? win32 : posix).isAbsolute(path)) throw Error();
  const entry = await realpath(path);
  const packageRoot = dirname(dirname(entry));
  if (!(platform === 'win32' ? win32 : posix).isAbsolute(entry)
    || !entry.endsWith(`${platform === 'win32' ? '\\' : '/'}bin${platform === 'win32' ? '\\' : '/'}npm-cli.js`)) throw Error();
  for (const directory of [packageRoot, dirname(entry)]) {
    const stat = await lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || await realpath(directory) !== directory
      || platform !== 'win32' && (![0, process.getuid!()].includes(stat.uid) || (stat.mode & 0o022))) throw Error();
  }
  const manifestPath = join(packageRoot, 'package.json');
  const manifestStat = await lstat(manifestPath);
  const entryStat = await lstat(entry);
  if (manifestStat.size > 64 * 1024 || entryStat.size > 1024 * 1024) throw Error();
  await protectedBinaryHash(entry, platform);
  const manifestHash = await protectedBinaryHash(manifestPath, platform);
  const manifestBytes = await readFile(manifestPath);
  if (createHash('sha256').update(manifestBytes).digest('hex') !== manifestHash) throw Error();
  const manifest = JSON.parse(manifestBytes.toString('utf8'));
  if (manifest.name !== 'npm' || manifest.bin?.npm !== 'bin/npm-cli.js') throw Error();
  return entry;
}

export async function resolveRepositoryNpmCli(options: {npmExecPath?: string; searchPath?: string; platform?: NodeJS.Platform} = {}) {
  const platform = options.platform ?? process.platform;
  const selected = options.npmExecPath ?? process.env.npm_execpath;
  try {
    // Invalid explicit context is not permission to search for another executable.
    if (selected !== undefined) return await protectedNpmCli(selected, platform);
    for (const directory of (options.searchPath ?? process.env.PATH ?? '').split(platform === 'win32' ? ';' : ':')) {
      if (!directory || !(platform === 'win32' ? win32 : posix).isAbsolute(directory)) continue;
      const candidate = join(directory, 'npm');
      try {await lstat(candidate);} catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw error;
      }
      return await protectedNpmCli(candidate, platform);
    }
  } catch { throw new Error('relay_startup_npm_unavailable'); }
  throw new Error('relay_startup_npm_unavailable');
}

/** The account databases that say whether this user's primary group is private to them. Tests pass copies. */
export type AccountFiles = {group?: string; passwd?: string};

/**
 * This user's primary group id when that group is private to them: named after the user, with no other member and
 * no other user's primary group. Its write bit then grants no one else anything. Stock Ubuntu login sessions use
 * umask 0002 with such groups, so a provider installed under ~ has 0775 directories. Otherwise null.
 */
async function ownPrivateGroup(accounts: AccountFiles = {}): Promise<number | null> {
  try {
    const gid = String(process.getgid!()), user = userInfo().username;
    const entries = async (path: string) => (await readFile(path, 'utf8')).split('\n').filter(Boolean).map(line => line.split(':'));
    const groups = (await entries(accounts.group ?? '/etc/group')).filter(fields => fields[2] === gid);
    const members = (groups[0]?.[3] ?? '').split(',').filter(Boolean);
    const sharers = (await entries(accounts.passwd ?? '/etc/passwd')).filter(fields => fields[3] === gid && fields[0] !== user);
    return groups.length === 1 && groups[0]![0] === user && members.every(member => member === user) && !sharers.length
      ? Number(gid) : null;
  } catch { return null; }
}

// Names the entry a provider check refused, so `dharma status` can say which one and how to fix it.
class UnsafeProviderEntry extends Error {
  constructor(readonly path: string, readonly writable: boolean) { super('unsafe_provider_entry'); }
}

function protectedEntry(path: string, stat: {uid: number; gid: number; mode: number}, privateGroup: number | null,
  exempt = false) {
  if (![0, process.getuid!()].includes(stat.uid)) throw new UnsafeProviderEntry(path, false);
  if (!exempt && ((stat.mode & 0o002) || ((stat.mode & 0o020) && stat.gid !== privateGroup))) {
    throw new UnsafeProviderEntry(path, true);
  }
}

async function protectParents(path: string, privateGroup: number | null) {
  for (let current = path; ; current = dirname(current)) {
    const parent = await lstat(current);
    // Root-owned sticky temporary roots cannot replace this user's child directories.
    const stickyRoot = current !== path && parent.uid === 0 && (parent.mode & 0o1000) !== 0;
    if (!parent.isDirectory() || parent.isSymbolicLink()) throw new UnsafeProviderEntry(current, false);
    protectedEntry(current, parent, privateGroup, stickyRoot);
    if (dirname(current) === current) break;
  }
}

// Resolves an absolute path as realpath does, one component at a time. Every link followed and every directory passed
// on the way, through link targets too, is owned by this user or root, and every such directory is closed to others
// (a root-owned sticky directory above the end excepted), so no other user can repoint the path after the check. A
// link's own mode is not checked: Linux ignores it. Protected links, such as a linked bin directory or fnm's per-shell
// directory in the user's own state directory, pass; a link in a directory others can write does not (CLI 0.2.224 R2b).
async function protectedPathResolution(path: string, privateGroup: number | null) {
  providerDirectoryPath(path);
  const pending = path.split('/').filter(Boolean);
  let resolved = '/', links = 0;
  const protectedDirectory = async (directory: string, end: boolean) => {
    const stat = await lstat(directory);
    if (!stat.isDirectory()) throw new UnsafeProviderEntry(directory, false);
    protectedEntry(directory, stat, privateGroup, !end && stat.uid === 0 && (stat.mode & 0o1000) !== 0);
  };
  await protectedDirectory(resolved, !pending.length);
  while (pending.length) {
    const name = pending.shift()!;
    if (name === '.') continue;
    if (name === '..') {resolved = posix.dirname(resolved); continue;}
    const next = posix.join(resolved, name);
    const stat = await lstat(next);
    if (stat.isSymbolicLink()) {
      protectedEntry(next, stat, privateGroup, true);
      if (++links > 40) throw Error();
      const target = await readlink(next);
      if (target.startsWith('/')) resolved = '/';
      pending.unshift(...target.split('/').filter(Boolean));
      continue;
    }
    await protectedDirectory(next, !pending.length);
    resolved = next;
  }
  return resolved;
}

// The provider bin directory and the executable it resolves to are owned by this user or root, and neither they
// nor their parents can be written by anyone else; the user's own private group is not anyone else. A codex PATH
// entry must be its own real path, as in 0.2.223. Another provider's entry may be a symlink, as fnm's per-shell bin
// directory is: its real directory is checked and is the one the launcher records (CLI 0.2.224 review R2).
async function protectedProviderExecutable(directory: string, provider: ProviderCommand, privateGroup: number | null) {
  providerDirectoryPath(directory);
  const real = await realpath(directory);
  if (real !== directory && (provider === 'codex' || providerDirectoryPath(real) !== real)) throw Error();
  await protectParents(real, privateGroup);
  const executable = await realpath(join(real, provider));
  await protectParents(dirname(executable), privateGroup);
  return {directory: real, executable};
}

async function protectedExecutableFile(executable: string, privateGroup: number | null) {
  const stat = await lstat(executable);
  if (!stat.isFile()) throw new UnsafeProviderEntry(executable, false);
  protectedEntry(executable, stat, privateGroup);
}

async function protectedProviderDirectory(path: string, provider: ProviderCommand, nodePath: string,
  privateGroup: number | null) {
  const {directory, executable} = await protectedProviderExecutable(path, provider, privateGroup);
  if (provider === 'codex') await protectedBinaryHash(executable, 'linux');
  // A native Claude binary can exceed the hashing bound; its ownership and mode are what protect it.
  else await protectedExecutableFile(executable, privateGroup);
  if (!((await lstat(executable)).mode & 0o111)) throw Error();
  // Only codex is held to the Node rule below, as in 0.2.223; another provider's own protected directory is the
  // user's runtime, such as fnm's Node beside claude (CLI 0.2.224 review R2).
  if (provider !== 'codex') return directory;
  let hasNode = true;
  try {await lstat(join(directory, 'node'));} catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    hasNode = false;
  }
  // npm's CLI child uses env-node; provider priority must not replace its runtime.
  if (hasNode) {
    const selectedNode = await realpath(join(directory, 'node'));
    await protectParents(dirname(selectedNode), privateGroup);
    if (!((await lstat(selectedNode)).mode & 0o111)
      || await protectedBinaryHash(selectedNode, 'linux') !== await protectedBinaryHash(nodePath, 'linux')) throw Error();
  }
  return directory;
}

export async function resolveRepositoryProviderDirectory(options: {provider?: ProviderCommand; searchPath?: string;
  platform?: NodeJS.Platform; accounts?: AccountFiles} = {}) {
  if ((options.platform ?? process.platform) !== 'linux') return undefined;
  const provider = options.provider ?? 'codex';
  const privateGroup = await ownPrivateGroup(options.accounts);
  return firstProviderOnPath(provider, options.searchPath,
    directory => protectedProviderDirectory(directory, provider, process.execPath, privateGroup));
}

async function firstProviderOnPath<T>(provider: ProviderCommand, searchPath: string | undefined,
  check: (directory: string) => Promise<T>): Promise<T | undefined> {
  for (const directory of (searchPath ?? process.env.PATH ?? '').split(':')) {
    if (!directory) continue;
    try {await lstat(join(directory, provider));} catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw new Error(unsafeProviderOnPath(provider));
    }
    // Do not skip an unsafe first match and silently select a different executable.
    try {return await check(directory);} catch {throw new Error(unsafeProviderOnPath(provider));}
  }
  return undefined;
}

/**
 * Whether the first `provider` on PATH fails setup's ownership and mode rules, as on a shared host where it belongs
 * to another user. Setup refuses such a provider; the relay, which writes no launcher, must not run it either. Only
 * the launcher's own Node and hashing checks are left out. Linux only, as setup's check.
 */
export async function providerFirstOnPathUnsafe(provider: ProviderCommand,
  options: {searchPath?: string; platform?: NodeJS.Platform; accounts?: AccountFiles} = {}): Promise<boolean> {
  if ((options.platform ?? process.platform) !== 'linux') return false;
  const privateGroup = await ownPrivateGroup(options.accounts);
  return firstProviderOnPath(provider, options.searchPath, directory => relayProviderExecutable(directory, provider, privateGroup))
    .then(() => false, () => true);
}

async function relayProviderExecutable(directory: string, provider: ProviderCommand, privateGroup: number | null) {
  // The relay runs the provider through this entry, so no other user may be able to repoint it after the check
  // (CLI 0.2.224 review round 2). The launcher writes each set-up provider's real directory first on the relay PATH.
  await protectedPathResolution(directory, privateGroup);
  const {executable} = await protectedProviderExecutable(directory, provider, privateGroup);
  await protectedExecutableFile(executable, privateGroup);
  if (!((await lstat(executable)).mode & 0o111)) throw Error();
}

/**
 * For `dharma status`: the PATH entry that makes the first `provider` unsafe under providerFirstOnPathUnsafe's rules,
 * and the command that fixes it. Null when that provider is safe or absent. Linux only, as the check.
 */
export async function providerUnsafePathDiagnosis(provider: ProviderCommand,
  options: {searchPath?: string; platform?: NodeJS.Platform; accounts?: AccountFiles} = {}): Promise<{path: string; remedy: string} | null> {
  if ((options.platform ?? process.platform) !== 'linux') return null;
  const privateGroup = await ownPrivateGroup(options.accounts);
  for (const directory of (options.searchPath ?? process.env.PATH ?? '').split(':')) {
    if (!directory) continue;
    try {
      try {await lstat(join(directory, provider));} catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw error;
      }
      await relayProviderExecutable(directory, provider, privateGroup);
      return null;
    } catch (error) {
      const entry = error instanceof UnsafeProviderEntry ? error : null;
      const path = entry?.path ?? directory;
      const quoted = `'${path.replace(/'/g, "'\\''")}'`;
      return {path, remedy: entry?.writable
        ? `Other users can write to ${path}. Run chmod go-w ${quoted}, or put your own ${provider} first on PATH.`
        : `${path} belongs to another user or is not a protected ${provider}. Put your own ${provider} first on PATH, or remove ${directory} from PATH.`};
    }
  }
  return null;
}

// A recorded launcher names only the directories, each written as its real path. Verify each for one of the set-up
// providers; when none is known, accept a directory once any provider command in it passes. Returns that command.
async function protectedRecordedProviderDirectory(directory: string, providers: ProviderCommand | readonly ProviderCommand[] | undefined,
  nodePath: string, privateGroup: number | null): Promise<ProviderCommand> {
  for (const command of providers === undefined ? PROVIDER_COMMANDS : typeof providers === 'string' ? [providers] : providers) {
    try {if (await protectedProviderDirectory(directory, command, nodePath, privateGroup) === directory) return command;} catch {}
  }
  throw Error();
}

/**
 * The provider bin directories the launcher being replaced carries, written by any agent-fabric version, that still
 * pass setup's check today, each with the provider command it passes for. Setup and relay upgrade keep them, so an
 * agent whose shared package is still pending stays on the relay PATH (CLI 0.2.224 review R1). Linux only.
 */
export async function protectedLauncherProviderDirectories(launchers: Launchers | null,
  platform: NodeJS.Platform = process.platform): Promise<{provider: ProviderCommand; directory: string}[]> {
  if (platform !== 'linux' || typeof launchers?.shell !== 'string') return [];
  const version = launchers.shell.match(/ -- @dharma-ai-labs\/agent-fabric@([^\s"]+) "\$@"\n$/)?.[1];
  const recorded = version && VERSION.test(version) ? recordedRuntime(version, launchers, platform) : undefined;
  const kept: {provider: ProviderCommand; directory: string}[] = [];
  const privateGroup = await ownPrivateGroup();
  for (const directory of [recorded?.providerDirectory ?? []].flat()) {
    try {kept.push({provider: await protectedRecordedProviderDirectory(directory, undefined, process.execPath, privateGroup), directory});}
    catch {}
  }
  return kept;
}

async function protectedBinaryHash(path: string, platform: NodeJS.Platform) {
  if (await realpath(path) !== path) throw new Error('noncanonical_node_binary');
  const file = await open(path, constants.O_RDONLY | (platform === 'win32' ? 0 : constants.O_NOFOLLOW));
  try {
    const before = await file.stat();
    if (!before.isFile() || before.size < 1 || before.size > 256 * 1024 * 1024
      || (platform !== 'win32' && (![0, process.getuid!()].includes(before.uid) || (before.mode & 0o022)))) {
      throw new Error('unprotected_node_binary');
    }
    const digest = createHash('sha256');
    for await (const chunk of file.createReadStream({ autoClose: false })) digest.update(chunk);
    const after = await file.stat();
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
      || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || await realpath(path) !== path) {
      throw new Error('node_binary_changed');
    }
    return digest.digest('hex');
  } finally { await file.close(); }
}

type VerifiedRuntime = {platform: NodeJS.Platform; nodePath: string; npmCliPath?: string;
  provider?: ProviderCommand | readonly ProviderCommand[]};

export async function verifyRecordedRepositoryLaunchers(version: string, launchers: Launchers,
  runtime: VerifiedRuntime = { platform: process.platform, nodePath: process.execPath }): Promise<boolean> {
  return verifyRecordedRuntime(version, launchers, runtime, 'active');
}

// Recovery compares stored bytes but never executes the recorded replacement launcher.
export async function verifyRollbackRepositoryLaunchers(version: string, launchers: Launchers,
  provider?: ProviderCommand | readonly ProviderCommand[]): Promise<boolean> {
  return verifyRecordedRuntime(version, launchers, {platform: process.platform, nodePath: process.execPath,
    ...(provider === undefined ? {} : {provider})}, 'recorded');
}

async function verifyRecordedRuntime(version: string, launchers: Launchers,
  runtime: VerifiedRuntime, npmContext: 'active' | 'recorded'): Promise<boolean> {
  const recorded = recordedRuntime(version, launchers, runtime.platform);
  if (!recorded) return false;
  const directory = recorded.nodeDirectory;
  // A changed npm cache path is not a new trust root: require the already running Node bytes.
  const node = join(directory, runtime.platform === 'win32' ? 'node.exe' : 'node');
  try {
    const privateGroup = runtime.platform === 'linux' ? await ownPrivateGroup() : null;
    for (const providerDirectory of [recorded.providerDirectory ?? []].flat()) {
      await protectedRecordedProviderDirectory(providerDirectory, runtime.provider, runtime.nodePath, privateGroup);
    }
    if (recorded.npmCliPath !== undefined) {
      const activeNpm = npmContext === 'recorded' ? await protectedNpmCli(recorded.npmCliPath, runtime.platform)
        : await resolveRepositoryNpmCli({npmExecPath: runtime.npmCliPath, platform: runtime.platform});
      if (activeNpm !== recorded.npmCliPath) return false;
    }
    if (directory === dirname(runtime.nodePath)) {
      await protectedBinaryHash(node, runtime.platform);
      return true;
    }
    const binaryName = runtime.platform === 'win32' ? 'node.exe' : 'node';
    // The old cache directory may supply Node, but must not shadow npm or another PATH executable.
    const entries = await readdir(directory);
    if (entries.length !== 1 || entries[0] !== binaryName) return false;
    const matched = await protectedBinaryHash(node, runtime.platform) === await protectedBinaryHash(runtime.nodePath, runtime.platform);
    const after = await readdir(directory);
    return matched && after.length === 1 && after[0] === binaryName;
  } catch { return false; }
}
