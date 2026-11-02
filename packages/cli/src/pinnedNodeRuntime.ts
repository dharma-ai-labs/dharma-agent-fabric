import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { nodeRuntimeVersion } from './runtime-bootstrap.js';

// A supported Node.js release the CLI fetches for itself when the current Node is not
// supported and no supported runtime is installed (#398). Digests are the official
// https://nodejs.org/dist/v24.22.2/SHASUMS256.txt entries; change version and digests together.
export const PINNED_NODE_VERSION = '24.22.2';
const PINNED_NODE_SHA256: Record<string, string> = {
  'darwin-arm64.tar.gz': 'aa9549349e47dffaa42dcf95d6e06ade8c4bdafc980979883b88767670df385a',
  'darwin-x64.tar.gz': 'd5e336d588c45be0c37dbd52cc29895593009ca4997a77a1fd02815131ed0e52',
  'linux-arm64.tar.gz': '95c264150aceb7f3437a29fd6984924f5f8d1511ea3cbd6c508b83f6c555dae2',
  'linux-x64.tar.gz': '361718c444e49af2ca5a110c83ba6a8901143f23ab285ebbef0341f391f482a9',
  'win-arm64.zip': 'f47968c213105077f64c6510f007632c0ca2574802a0b5067c327c49abe1c468',
  'win-x64.zip': 'ca1bff5d8ead13c9f2ea404a176db46bd430704d5b5113734049fa365e7799e2',
};

export type PinnedNodeArchive = {
  file: string; directory: string; executable: string; sha256: string; url: string;
};

export function pinnedNodeArchive(platform: NodeJS.Platform, arch: string): PinnedNodeArchive | null {
  const os = platform === 'win32' ? 'win' : platform;
  const extension = platform === 'win32' ? 'zip' : 'tar.gz';
  const sha256 = PINNED_NODE_SHA256[`${os}-${arch}.${extension}`];
  if (!sha256) return null;
  const directory = `node-v${PINNED_NODE_VERSION}-${os}-${arch}`;
  const file = `${directory}.${extension}`;
  return {
    file, directory, sha256,
    executable: platform === 'win32' ? 'node.exe' : join('bin', 'node'),
    url: `https://nodejs.org/dist/v${PINNED_NODE_VERSION}/${file}`,
  };
}

export function defaultDharmaHome(env: NodeJS.ProcessEnv = process.env) {
  return resolve(env.DHARMA_HOME || join(homedir(), '.dharma'));
}

async function downloadArchive(url: string) {
  const response = await fetch(url, { signal: AbortSignal.timeout(300_000) });
  if (!response.ok) throw new Error(`node_runtime_download_failed: HTTP ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

// Windows 10+ ships bsdtar as System32\tar.exe, which reads zip; a Git Bash `tar` on PATH does not.
function extractArchive(platform: NodeJS.Platform) {
  return (file: string, destination: string) => new Promise<void>((done, fail) => {
    const tar = platform === 'win32' ? join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
    const child = spawn(tar, [platform === 'win32' ? '-xf' : '-xzf', file, '-C', destination], { stdio: 'ignore' });
    child.once('error', fail);
    child.once('exit', code => code === 0 ? done() : fail(new Error(`node_runtime_extract_failed: exit ${code}`)));
  });
}

/** Returns the pinned Node executable under <Dharma home>/runtime, fetching and
 * SHA-256-checking the official archive first if it is not installed yet. */
export async function ensurePinnedNodeRuntime(input: {
  dharmaHome: string; archive?: PinnedNodeArchive; platform?: NodeJS.Platform;
  download?: (url: string) => Promise<Buffer>;
  extract?: (file: string, destination: string) => Promise<void>;
  runtimeVersion?: (executable: string) => string;
}): Promise<string> {
  const platform = input.platform || process.platform;
  const archive = input.archive || pinnedNodeArchive(platform, process.arch);
  if (!archive) throw new Error(`node_runtime_platform_unsupported: ${platform}-${process.arch}`);
  const version = input.runtimeVersion || nodeRuntimeVersion;
  const root = join(input.dharmaHome, 'runtime');
  const installed = join(root, archive.directory);
  const executable = join(installed, archive.executable);
  const ready = () => existsSync(executable) && version(executable) === `v${PINNED_NODE_VERSION}`;
  if (ready()) return executable;

  await mkdir(input.dharmaHome, { recursive: true, mode: 0o700 });
  await mkdir(root, { recursive: true, mode: 0o700 });
  const staging = await mkdtemp(join(root, '.staging-'));
  try {
    const bytes = await (input.download || downloadArchive)(archive.url);
    if (createHash('sha256').update(bytes).digest('hex') !== archive.sha256) throw new Error('node_runtime_digest_mismatch');
    const file = join(staging, archive.file);
    await writeFile(file, bytes, { mode: 0o600 });
    const unpacked = join(staging, 'unpacked');
    await mkdir(unpacked, { mode: 0o700 });
    await (input.extract || extractArchive(platform))(file, unpacked);
    if (!ready()) {
      // A broken earlier install (no executable or wrong version) is replaced.
      await rm(installed, { recursive: true, force: true });
      try {
        await rename(join(unpacked, archive.directory), installed);
      } catch (error) {
        if (!ready()) throw error; // otherwise another CLI process installed it first
      }
    }
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
  if (!ready()) throw new Error('node_runtime_install_unverified');
  return executable;
}
