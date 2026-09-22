import { constants } from 'node:fs';
import { lstat, open, rename, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, isAbsolute, relative, resolve } from 'node:path';

const ROOT = '.agents/skills/dharma-agent-fabric';
const MARKER = `${ROOT}/.dharma-agent-fabric.json`;
const FILES = [MARKER, `${ROOT}/SKILL.md`, `${ROOT}/references/organization.md`,
  '.dharma/agent-fabric.json', '.dharma/repository-agent.json'] as const;
type InstallerFile = typeof FILES[number];

async function checkedPath(workspace: string, path: string, leaf: 'file' | 'directory') {
  const boundary = resolve(workspace), within = relative(boundary, path);
  if (isAbsolute(within) || within === '..' || within.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)) {
    throw new Error('Repository installer path escapes the workspace.');
  }
  const components = [path];
  // System ancestors may be aliases (for example macOS /var); owned paths may not.
  while (components[0] !== boundary) components.unshift(dirname(components[0]!));
  let exists = false;
  for (const [index, component] of components.entries()) {
    let metadata;
    try { metadata = await lstat(component); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
    if (metadata.isSymbolicLink()) throw new Error('Repository installer symlink is forbidden.');
    const isLeaf = index === components.length - 1;
    if ((!isLeaf || leaf === 'directory') && !metadata.isDirectory()) {
      throw new Error('Invalid repository installer directory.');
    }
    if (isLeaf && leaf === 'file' && (!metadata.isFile() || metadata.nlink !== 1)) {
      throw new Error('Repository installer hardlink or non-regular destination is forbidden.');
    }
    exists = isLeaf;
  }
  return exists;
}

export async function assertRepositoryInstallerOwnership(workspace: string, workspaceId: string) {
  if (!await checkedPath(workspace, resolve(workspace), 'directory')) throw new Error('Repository installer workspace is missing.');
  const rootExists = await checkedPath(workspace, resolve(workspace, ROOT), 'directory');
  for (const path of FILES) await checkedPath(workspace, resolve(workspace, path), 'file');
  if (!rootExists) return 'absent' as const;
  const markerPath = resolve(workspace, MARKER);
  if (!await checkedPath(workspace, markerPath, 'file')) {
    throw new Error('Refusing to replace an unmanaged repository skill at .agents/skills/dharma-agent-fabric.');
  }
  const handle = await open(markerPath, constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0));
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.nlink !== 1 || before.size > 4096) throw new Error('Invalid repository skill ownership marker.');
    const buffer = Buffer.alloc(4097);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const after = await handle.stat(), current = await lstat(markerPath);
    if (bytesRead !== before.size || before.size !== after.size || before.mtimeMs !== after.mtimeMs
      || current.isSymbolicLink() || current.ino !== before.ino || current.dev !== before.dev
      || current.nlink !== 1 || current.mtimeMs !== after.mtimeMs) throw new Error('Repository ownership marker changed.');
    let marker: unknown;
    try { marker = JSON.parse(buffer.subarray(0, bytesRead).toString('utf8')); }
    catch { throw new Error('Invalid repository skill ownership marker.'); }
    if (!marker || typeof marker !== 'object' || Array.isArray(marker)) {
      throw new Error('Invalid or foreign repository skill ownership marker.');
    }
    const value = marker as Record<string, unknown>;
    const installerOwned = Object.keys(value).sort().join(',') === 'managedBy,workspaceId'
      && value.managedBy === 'dharma-agent-fabric' && value.workspaceId === workspaceId;
    const signedOwned = Object.keys(value).sort().join(',') === 'bundleId,skillId,workspaceId'
      && value.skillId === 'dharma-agent-fabric' && value.workspaceId === workspaceId
      && typeof value.bundleId === 'string'
      && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value.bundleId);
    if (!installerOwned && !signedOwned) throw new Error('Invalid or foreign repository skill ownership marker.');
    return signedOwned ? 'signed' as const : 'installer' as const;
  } finally { await handle.close(); }
}

// Replace owned generated leaves atomically; never truncate an existing inode.
export async function writeRepositoryInstallerFile(workspace: string, path: InstallerFile, content: string) {
  if (!(FILES as readonly string[]).includes(path)) throw new Error('Unsupported repository installer file.');
  const target = resolve(workspace, path);
  await checkedPath(workspace, dirname(target), 'directory');
  await checkedPath(workspace, target, 'file');
  const temporary = `${target}.staging-${randomUUID()}`;
  const handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY
    | (constants.O_NOFOLLOW || 0), 0o600);
  let published = false;
  try {
    try {
      await handle.writeFile(content);
      await handle.sync();
    } finally { await handle.close(); }
    await checkedPath(workspace, dirname(target), 'directory');
    await checkedPath(workspace, target, 'file');
    await rename(temporary, target);
    published = true;
  } finally {
    if (!published && await checkedPath(workspace, temporary, 'file')) await unlink(temporary);
  }
}
