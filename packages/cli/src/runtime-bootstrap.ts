import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';

export const MINIMUM_NODE_VERSION = '22.20.0';

export function isSupportedNodeVersion(version: string) {
  const [major = 0, minor = 0] = version.replace(/^v/, '').split('.').map(Number);
  return (major === 22 && minor >= 20) || (major > 22 && major < 25);
}

function directoryChildren(path: string) {
  try {
    return readdirSync(path, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
      .map((entry) => entry.name)
      .sort((left, right) => right.localeCompare(left, undefined, { numeric: true }));
  } catch {
    return [];
  }
}

function isTrustedAutomaticCandidate(candidate: string, platform: NodeJS.Platform) {
  if (platform === 'win32') return true;
  const uid = process.getuid?.();
  let current = candidate;
  try {
    while (true) {
      const metadata = statSync(current);
      if ((metadata.mode & 0o022) !== 0) return false;
      if (uid !== undefined && metadata.uid !== 0 && metadata.uid !== uid) return false;
      const parent = dirname(current);
      if (parent === current) return true;
      current = parent;
    }
  } catch {
    return false;
  }
}

export function nodeRuntimeCandidates(input: {
  env?: NodeJS.ProcessEnv;
  home?: string;
  platform?: NodeJS.Platform;
  execPath?: string;
} = {}) {
  const env = input.env || process.env;
  const home = input.home || homedir();
  const platform = input.platform || process.platform;
  const executable = platform === 'win32' ? 'node.exe' : 'node';
  const explicit = env.DHARMA_NODE_BINARY;
  const currentRuntime = input.execPath || process.execPath;
  const candidates = [
    explicit,
    currentRuntime,
    join(home, '.local', 'bin', executable),
    join(home, '.volta', 'bin', executable),
  ];

  const miseRoot = join(home, '.local', 'share', 'mise', 'installs', 'node');
  for (const version of directoryChildren(miseRoot)) candidates.push(join(miseRoot, version, 'bin', executable));
  const nvmRoot = join(home, '.nvm', 'versions', 'node');
  for (const version of directoryChildren(nvmRoot)) candidates.push(join(nvmRoot, version, 'bin', executable));

  if (platform === 'win32') {
    if (env.LOCALAPPDATA) candidates.push(join(env.LOCALAPPDATA, 'Programs', 'nodejs', executable));
    for (const root of [env.ProgramFiles, env['ProgramFiles(x86)']].filter(Boolean) as string[]) {
      candidates.push(join(root, 'nodejs', executable));
    }
  } else {
    candidates.push(join('/usr/local/bin', executable), join('/usr/bin', executable));
    if (platform === 'darwin') candidates.push(join('/opt/homebrew/bin', executable), join('/opt/local/bin', executable));
  }

  const seen = new Set<string>();
  return candidates.flatMap((candidate) => {
    if (!candidate || !existsSync(candidate)) return [];
    let resolved = candidate;
    try { resolved = realpathSync(candidate); } catch { /* use the original path */ }
    const explicitlyTrusted = candidate === explicit || candidate === currentRuntime;
    if (!explicitlyTrusted && !isTrustedAutomaticCandidate(resolved, platform)) return [];
    const key = platform === 'win32' ? resolved.toLowerCase() : resolved;
    if (seen.has(key)) return [];
    seen.add(key);
    return [resolved];
  });
}

export function launchWithRuntime(executable: string, script: string, args: string[], env: NodeJS.ProcessEnv) {
  return spawnSync(executable, [script, ...args], {
    stdio: 'inherit',
    env: { ...env, DHARMA_NODE_BOOTSTRAPPED: '1' },
  });
}

export function nodeRuntimeVersion(executable: string) {
  try {
    return execFileSync(executable, ['--version'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5_000,
    }).trim();
  } catch {
    return '';
  }
}

export function findSupportedNodeRuntime(input: Parameters<typeof nodeRuntimeCandidates>[0] = {}) {
  for (const candidate of nodeRuntimeCandidates(input)) {
    if (isSupportedNodeVersion(nodeRuntimeVersion(candidate))) return candidate;
  }
  return null;
}

export function runtimeBootstrapHint(env: NodeJS.ProcessEnv = process.env) {
  const explicit = env.DHARMA_NODE_BINARY
    ? ` DHARMA_NODE_BINARY currently points to ${basename(env.DHARMA_NODE_BINARY)} but it is not a supported runtime.`
    : '';
  return `Dharma Agent Fabric requires Node.js ${MINIMUM_NODE_VERSION} or newer (Node 22 or 24).${explicit} `
    + 'Install the current Node.js 22 LTS release or set DHARMA_NODE_BINARY to its executable, then rerun the command.';
}
