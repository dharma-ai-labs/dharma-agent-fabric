import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open, readdir, realpath } from 'node:fs/promises';
import { dirname, join, posix, win32 } from 'node:path';

type Launchers = { shell: string; windows: string };
const VERSION = /^(?=.{1,64}$)\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/;

export function stableRepositoryLauncherContents(version: string,
  runtime?: { platform: NodeJS.Platform; nodeDirectory: string }): Launchers {
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
  return { shell: `#!/bin/sh\n${shellEnvironment}exec ${invocation} "$@"\n`,
    windows: `@echo off\r\n${windowsEnvironment}${invocation} %*\r\n` };
}

export function recordedRepositoryNodeDirectory(version: string, launchers: Launchers, platform: NodeJS.Platform) {
  try {
    if (typeof launchers.shell !== 'string' || typeof launchers.windows !== 'string'
      || launchers.shell.length > 16384 || launchers.windows.length > 16384) return undefined;
    const captured = platform === 'win32'
      ? launchers.windows.match(/^@echo off\r\nsetlocal DisableDelayedExpansion\r\nset "PATH=([^\r\n]*);%PATH%"\r\n/)?.[1]
      : launchers.shell.match(/^#!\/bin\/sh\nexport PATH='([^\n]*)':"\$PATH"\n/)?.[1];
    if (!captured) return undefined;
    const directory = platform === 'win32' ? captured.replace(/%%/g, '%') : captured.replace(/'\\''/g, "'");
    const expected = stableRepositoryLauncherContents(version, { platform, nodeDirectory: directory });
    return expected.shell === launchers.shell && expected.windows === launchers.windows ? directory : undefined;
  } catch { return undefined; }
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
  runtime = { platform: process.platform, nodePath: process.execPath }): Promise<boolean> {
  const directory = recordedRepositoryNodeDirectory(version, launchers, runtime.platform);
  if (!directory) return false;
  // A changed npm cache path is not a new trust root: require the already running Node bytes.
  const node = join(directory, runtime.platform === 'win32' ? 'node.exe' : 'node');
  try {
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
