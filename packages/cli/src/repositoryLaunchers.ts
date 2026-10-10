import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, readdir, readFile, realpath } from 'node:fs/promises';
import { dirname, join, posix, win32 } from 'node:path';

type Launchers = { shell: string; windows: string };
const VERSION = /^(?=.{1,64}$)\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/;
type LauncherRuntime = {platform: NodeJS.Platform; nodeDirectory: string; npmCliPath?: string; codexDirectory?: string};

function codexDirectoryPath(value: string) {
  if (!value || value.length > 4096 || !posix.isAbsolute(value) || value === '/'
    || posix.resolve(value) !== value || /[\x00-\x1f\x7f:]/.test(value)) {
    throw new Error('relay_startup_codex_path_invalid');
  }
  return value;
}

export function stableRepositoryLauncherContents(version: string,
  runtime?: LauncherRuntime): Launchers {
  if (!VERSION.test(version)) throw new Error('Managed launcher version is invalid.');
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
  let shellInvocation = invocation;
  if (runtime?.npmCliPath !== undefined) {
    const entry = runtime.npmCliPath;
    if (runtime.platform !== 'linux' || !posix.isAbsolute(entry) || posix.basename(entry) !== 'npm-cli.js'
      || entry.length > 4096 || /[\r\n\0]/.test(entry)) {
      throw new Error('Managed launcher npm path is invalid.');
    }
    const quote = (value: string) => `'${value.replace(/'/g, "'\\''")}'`;
    shellInvocation = `${quote(posix.join(runtime.nodeDirectory, 'node'))} ${quote(entry)} exec --yes -- @dharma-ai-labs/agent-fabric@${version}`;
  }
  if (runtime?.codexDirectory !== undefined) {
    if (runtime.platform !== 'linux') throw new Error('relay_startup_codex_path_invalid');
    const directory = codexDirectoryPath(runtime.codexDirectory);
    // Preserve only the qualified provider bin directory, not the login environment.
    shellEnvironment += `export PATH='${directory.replace(/'/g, "'\\''")}':"$PATH"\n`;
  }
  return { shell: `#!/bin/sh\n${shellEnvironment}exec ${shellInvocation} "$@"\n`,
    windows: `@echo off\r\n${windowsEnvironment}${invocation} %*\r\n` };
}

function recordedRuntime(version: string, launchers: Launchers, platform: NodeJS.Platform) {
  try {
    if (typeof launchers.shell !== 'string' || typeof launchers.windows !== 'string'
      || launchers.shell.length > 16384 || launchers.windows.length > 16384) return undefined;
    let shell = launchers.shell;
    const providerPrefix = platform === 'linux'
      ? shell.match(/^#!\/bin\/sh\nexport PATH='([^\n]*)':"\$PATH"\nexport PATH='([^\n]*)':"\$PATH"\n/) : undefined;
    const codexDirectory = providerPrefix ? codexDirectoryPath(providerPrefix[2]!.replace(/'\\''/g, "'")) : undefined;
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
      ...(codexDirectory === undefined ? {} : {codexDirectory})};
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

async function protectedCodexDirectory(directory: string) {
  codexDirectoryPath(directory);
  if (await realpath(directory) !== directory) throw Error();
  const protectParents = async (path: string) => {
    for (let current = path; ; current = dirname(current)) {
      const parent = await lstat(current);
      // Root-owned sticky temporary roots cannot replace this user's child directories.
      const stickyRoot = current !== path && parent.uid === 0 && (parent.mode & 0o1000);
      if (!parent.isDirectory() || parent.isSymbolicLink() || ![0, process.getuid!()].includes(parent.uid)
        || ((parent.mode & 0o022) && !stickyRoot)) throw Error();
      if (dirname(current) === current) break;
    }
  };
  await protectParents(directory);
  const executable = await realpath(join(directory, 'codex'));
  await protectParents(dirname(executable));
  await protectedBinaryHash(executable, 'linux');
  if (!((await lstat(executable)).mode & 0o111)) throw Error();
  return directory;
}

export async function resolveRepositoryCodexDirectory(options: {searchPath?: string; platform?: NodeJS.Platform} = {}) {
  if ((options.platform ?? process.platform) !== 'linux') return undefined;
  for (const directory of (options.searchPath ?? process.env.PATH ?? '').split(':')) {
    if (!directory) continue;
    try {await lstat(join(directory, 'codex'));} catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw new Error('relay_startup_codex_path_invalid');
    }
    // Do not skip an unsafe first match and silently select a different provider.
    try {return await protectedCodexDirectory(directory);} catch {throw new Error('relay_startup_codex_path_invalid');}
  }
  return undefined;
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

export async function verifyRecordedRepositoryLaunchers(version: string, launchers: Launchers,
  runtime: {platform: NodeJS.Platform; nodePath: string; npmCliPath?: string} = { platform: process.platform, nodePath: process.execPath }): Promise<boolean> {
  return verifyRecordedRuntime(version, launchers, runtime, 'active');
}

// Recovery compares stored bytes but never executes the recorded replacement launcher.
export async function verifyRollbackRepositoryLaunchers(version: string, launchers: Launchers): Promise<boolean> {
  return verifyRecordedRuntime(version, launchers, {platform: process.platform, nodePath: process.execPath}, 'recorded');
}

async function verifyRecordedRuntime(version: string, launchers: Launchers,
  runtime: {platform: NodeJS.Platform; nodePath: string; npmCliPath?: string}, npmContext: 'active' | 'recorded'): Promise<boolean> {
  const recorded = recordedRuntime(version, launchers, runtime.platform);
  if (!recorded) return false;
  const directory = recorded.nodeDirectory;
  // A changed npm cache path is not a new trust root: require the already running Node bytes.
  const node = join(directory, runtime.platform === 'win32' ? 'node.exe' : 'node');
  try {
    if (recorded.codexDirectory !== undefined) await protectedCodexDirectory(recorded.codexDirectory);
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
