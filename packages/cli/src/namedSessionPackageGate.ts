import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, opendir } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { calculateBundleHash, type SkillBundle } from '@dharma-ai-labs/agent-fabric-skill-manager';

const BUNDLE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_SKILL_BYTES = 5 * 1024 * 1024;
const MAX_FILE_BYTES = 262_144;

async function readStableFile(path: string, maximumBytes: number): Promise<Buffer> {
  const before = await lstat(path);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > maximumBytes) {
    throw new Error('named_session_skill_tree_invalid');
  }
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0));
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.nlink !== 1 || opened.size !== before.size
      || opened.ino !== before.ino || opened.dev !== before.dev) {
      throw new Error('named_session_skill_tree_changed');
    }
    const buffer = Buffer.alloc(before.size + 1);
    let size = 0;
    while (size < buffer.length) {
      const result = await handle.read(buffer, size, buffer.length - size, size);
      if (!result.bytesRead) break;
      size += result.bytesRead;
    }
    const after = await handle.stat();
    const current = await lstat(path);
    if (size !== before.size || !current.isFile() || current.nlink !== 1
      || current.ino !== before.ino || current.dev !== before.dev
      || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs
      || current.mtimeMs !== after.mtimeMs || current.ctimeMs !== after.ctimeMs) {
      throw new Error('named_session_skill_tree_changed');
    }
    return buffer.subarray(0, size);
  } finally { await handle.close(); }
}

export function requireNamedSessionSignedPackage(
  installation: { signedLifecycleReady: boolean; activeBundleId: string | null;
    signedMarkerBundleId: string | null },
  sharedRepositoryReady: boolean,
): string {
  if (!sharedRepositoryReady || installation.signedLifecycleReady !== true
    || !installation.activeBundleId || !BUNDLE_ID.test(installation.activeBundleId)
    || installation.signedMarkerBundleId !== installation.activeBundleId) {
    throw new Error('named_session_repository_package_pending');
  }
  return installation.activeBundleId;
}

async function skillTree(root: string) {
  const files = new Map<string, string>();
  const hash = createHash('sha256');
  let entries = 0, totalBytes = 0;
  async function visit(path: string, prefix: string, depth: number): Promise<void> {
    if (++entries > 4096 || depth > 12) throw new Error('named_session_skill_tree_limit');
    const before = await lstat(path);
    if (before.isSymbolicLink()) throw new Error('named_session_skill_tree_invalid');
    if (before.isDirectory()) {
      const names: string[] = [];
      const directory = await opendir(path);
      for await (const entry of directory) {
        if (names.length >= 4096) throw new Error('named_session_skill_tree_limit');
        names.push(entry.name);
      }
      for (const name of names.sort()) await visit(resolve(path, name), `${prefix}${name}/`, depth + 1);
      const after = await lstat(path);
      if (after.ino !== before.ino || after.dev !== before.dev || after.mtimeMs !== before.mtimeMs
        || after.ctimeMs !== before.ctimeMs) throw new Error('named_session_skill_tree_changed');
      return;
    }
    if (!before.isFile() || before.nlink !== 1 || before.size > MAX_FILE_BYTES) {
      throw new Error('named_session_skill_tree_invalid');
    }
    const bytes = await readStableFile(path, MAX_FILE_BYTES);
    totalBytes += bytes.length;
    if (totalBytes > MAX_SKILL_BYTES) throw new Error('named_session_skill_tree_limit');
    const relative = prefix.slice(basename(root).length + 1, -1);
    files.set(relative, createHash('sha256').update(bytes).digest('hex'));
    hash.update(prefix.slice(0, -1)); hash.update('\0'); hash.update(bytes); hash.update('\0');
  }
  await visit(root, `${basename(root)}/`, 0);
  return { contentHash: `sha256:${hash.digest('hex')}`, files };
}

export async function verifyNamedSessionVisibleSkill(
  installation: { signedLifecycleReady: boolean; activeBundleId: string | null;
    signedMarkerBundleId: string | null; activeBundleHash: string | null;
    workspaceId: string | null; nativeSkillPath: string },
  sharedRepositoryReady: boolean,
): Promise<string> {
  const bundleId = requireNamedSessionSignedPackage(installation, sharedRepositoryReady);
  if (!installation.workspaceId || !installation.activeBundleHash) {
    throw new Error('named_session_repository_package_pending');
  }
  const nativeRoot = dirname(dirname(installation.nativeSkillPath));
  const activeRoot = resolve(nativeRoot, '.dharma-managed', 'workspaces', installation.workspaceId, 'active');
  const authorizationPath = resolve(activeRoot, 'AUTHORIZATION.json');
  const authorizationBytes = await readStableFile(authorizationPath, 1_048_576);
  const bundle = JSON.parse(authorizationBytes.toString('utf8')) as SkillBundle;
  const { signature: _signature, bundleHash: _bundleHash, ...unsigned } = bundle;
  const skill = bundle.skills?.find(entry => entry.skillId === 'dharma-agent-fabric');
  if (bundle.bundleId !== bundleId || bundle.bundleHash !== installation.activeBundleHash
    || calculateBundleHash(unsigned) !== installation.activeBundleHash
    || bundle.operation !== 'install' || !skill || skill.path !== '.agents/skills/dharma-agent-fabric') {
    throw new Error('named_session_repository_package_pending');
  }
  const active = await skillTree(resolve(activeRoot, 'dharma-agent-fabric'));
  if (active.contentHash !== skill.contentHash) throw new Error('named_session_repository_package_pending');
  const visible = await skillTree(dirname(installation.nativeSkillPath));
  const marker = '.dharma-agent-fabric.json';
  const markerPresent = visible.files.delete(marker);
  active.files.delete(marker);
  if (!markerPresent || active.files.size !== visible.files.size
    || [...active.files].some(([path, hash]) => visible.files.get(path) !== hash)
    || [...visible.files.keys()].some(path => !active.files.has(path))) {
    throw new Error('named_session_repository_package_pending');
  }
  if (!authorizationBytes.equals(await readStableFile(authorizationPath, 1_048_576))) {
    throw new Error('named_session_repository_package_pending');
  }
  return bundleId;
}
