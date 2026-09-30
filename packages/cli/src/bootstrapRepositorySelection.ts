import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, realpath, rename, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export type BootstrapRepositorySelection = 'existing' | 'managed_cloned' | 'managed_reused';

export interface BootstrapRepositoryWorkspace {
  workspace: string;
  selection: BootstrapRepositorySelection;
}

export interface BootstrapRepositorySelectionInput {
  workspace: string;
  selectedRemoteBase64url: string;
  organizationId: string;
  home: string;
  normalizeRemote: (remote: string) => string;
  withLock: (path: string) => Promise<() => Promise<void>>;
  cloneRepository?: (remote: string, target: string) => Promise<void>;
}

export function decodeSelectedRepositoryUrl(encoded: string): string {
  if (!/^[A-Za-z0-9_-]{1,4096}$/.test(encoded)) {
    throw new Error('repository_selection_invalid_url: selected repository URL encoding is invalid.');
  }
  const bytes = Buffer.from(encoded, 'base64url');
  if (bytes.toString('base64url') !== encoded) {
    throw new Error('repository_selection_invalid_url: selected repository URL encoding is invalid.');
  }
  const raw = bytes.toString('utf8');
  let url: URL;
  try { url = new URL(raw); }
  catch { throw new Error('repository_selection_invalid_url: selected repository must be a hosted HTTPS URL.'); }
  const segments = url.pathname.split('/').filter(Boolean);
  if (raw.length > 2048 || /[\u0000-\u001f\u007f]/.test(raw) || url.protocol !== 'https:'
    || !url.hostname || url.username || url.password || url.search || url.hash || segments.length < 2
    || /^(localhost|127(?:\.\d{1,3}){3}|\[?::1\]?)$/i.test(url.hostname)
    || segments.some((segment) => {
      let decoded: string;
      try { decoded = decodeURIComponent(segment); }
      catch { return true; }
      return decoded === '.' || decoded === '..' || /[\\/\u0000-\u001f\u007f]/.test(decoded);
    })) {
    throw new Error('repository_selection_invalid_url: selected repository must be a credential-free hosted HTTPS URL.');
  }
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
}

async function gitValue(workspace: string, args: string[]): Promise<string | null> {
  try {
    return (await execFileAsync('git', ['-C', workspace, ...args], { timeout: 10_000 })).stdout.trim() || null;
  } catch { return null; }
}

async function existingPath(path: string) {
  try { return await lstat(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

async function qualifiedCheckout(
  path: string,
  expectedRemote: string,
  normalizeRemote: (remote: string) => string,
): Promise<string | null> {
  const root = await gitValue(path, ['rev-parse', '--show-toplevel']);
  if (!root) return null;
  const remote = await gitValue(root, ['config', '--get', 'remote.origin.url']);
  if (!remote) return null;
  try {
    const parsed = remote.includes('://') ? new URL(remote) : null;
    if (parsed && (parsed.password || (parsed.username && !(parsed.protocol === 'ssh:' && parsed.username === 'git')))) return null;
    if (normalizeRemote(remote) !== expectedRemote) return null;
  } catch { return null; }
  const treeBytes = Number(await gitValue(root, ['cat-file', '-s', 'HEAD^{tree}']));
  if (!(await gitValue(root, ['rev-parse', '--verify', 'HEAD'])) || !Number.isSafeInteger(treeBytes) || treeBytes <= 0) {
    throw new Error('repository_checkout_empty: selected repository has no commit and tracked source files.');
  }
  return realpath(root);
}

async function cloneSelectedRepository(remote: string, target: string): Promise<void> {
  await execFileAsync('git', [
    '-c', 'protocol.file.allow=never', '-c', 'protocol.ext.allow=never', 'clone', '--', remote, target,
  ], {
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    timeout: 300_000,
    maxBuffer: 16_384,
  });
}

export async function resolveBootstrapRepositoryWorkspace(
  input: BootstrapRepositorySelectionInput,
): Promise<BootstrapRepositoryWorkspace> {
  const remote = decodeSelectedRepositoryUrl(input.selectedRemoteBase64url);
  const expectedRemote = input.normalizeRemote(remote);
  const existing = await qualifiedCheckout(input.workspace, expectedRemote, input.normalizeRemote);
  if (existing) return { workspace: existing, selection: 'existing' };

  const key = createHash('sha256').update(`${input.organizationId}\n${expectedRemote}`).digest('hex');
  const managedRoot = resolve(input.home, 'repository-checkouts');
  await mkdir(managedRoot, { recursive: true, mode: 0o700 });
  const rootStat = await lstat(managedRoot);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error('repository_checkout_conflict: managed checkout directory is not a private directory.');
  }
  const target = resolve(managedRoot, key);
  const release = await input.withLock(resolve(input.home, 'locks', `repository-checkout-${key}.lock`));
  try {
    const targetStat = await existingPath(target);
    if (targetStat) {
      if (!targetStat.isDirectory() || targetStat.isSymbolicLink()) {
        throw new Error('repository_checkout_conflict: managed checkout path is not a repository directory.');
      }
      const found = await qualifiedCheckout(target, expectedRemote, input.normalizeRemote);
      if (found !== await realpath(target)) {
        throw new Error('repository_checkout_conflict: managed checkout does not match the selected repository.');
      }
      return { workspace: found, selection: 'managed_reused' };
    }

    const stage = resolve(managedRoot, `.${key}.${randomUUID()}.tmp`);
    try {
      try { await (input.cloneRepository || cloneSelectedRepository)(remote, stage); }
      catch { throw new Error('repository_checkout_failed: Git could not clone the selected repository using existing device access; grant not redeemed.'); }
      const found = await qualifiedCheckout(stage, expectedRemote, input.normalizeRemote);
      if (found !== await realpath(stage)) {
        throw new Error('repository_checkout_invalid: cloned source does not match the selected repository.');
      }
      if (await existingPath(target)) {
        throw new Error('repository_checkout_conflict: managed checkout appeared during clone.');
      }
      await rename(stage, target);
      return { workspace: await realpath(target), selection: 'managed_cloned' };
    } finally {
      // stage is generated below managedRoot, never a user-supplied path.
      await rm(stage, { recursive: true, force: true });
    }
  } finally { await release(); }
}
