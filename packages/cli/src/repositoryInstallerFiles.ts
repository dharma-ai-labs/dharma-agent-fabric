import { constants } from 'node:fs';
import { lstat, mkdir, open, readFile, realpath, rename, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { types } from 'node:util';
import { currentBootstrapHostScope, type BootstrapHostScope } from './bootstrapHostScope.js';
import { validateRepositorySourceAuthorization } from './repositorySourceAuthorization.js';

const ROOT = '.agents/skills/dharma-agent-fabric';
const MARKER = `${ROOT}/.dharma-agent-fabric.json`;
const FILES = [MARKER, `${ROOT}/SKILL.md`, `${ROOT}/references/organization.md`,
  '.dharma/agent-fabric.json', '.dharma/repository-agent.json'] as const;
type InstallerFile = typeof FILES[number];

export interface RepositoryInstallerInput {
  workspace: string;
  hqUrl: string;
  organizationId: string;
  workspaceId: string;
  policyRevision: string;
  repositoryAgentId?: string | null;
  repositoryBindingId?: string | null;
  sourceAuthorization?: unknown;
  repositoryAgentKey?: string | null;
  controlBranch?: string | null;
}

// Capture the approved connection before any asynchronous owner check can yield.
export function captureRepositoryInstallerInput(input: RepositoryInstallerInput): RepositoryInstallerInput {
  let captured: RepositoryInstallerInput;
  if (currentBootstrapHostScope()) {
    if (!input || typeof input !== 'object' || Array.isArray(input) || types.isProxy(input)) {
      throw new Error('repository_installer_input_invalid');
    }
    const fields = Object.getOwnPropertyDescriptors(input);
    const required = ['workspace', 'hqUrl', 'organizationId', 'workspaceId', 'policyRevision'] as const;
    const optional = ['repositoryAgentId', 'repositoryBindingId', 'repositoryAgentKey', 'controlBranch'] as const;
    const values: Record<string, unknown> = Object.create(null);
    for (const name of [...required, ...optional]) {
      const field = fields[name];
      if (field && !Object.hasOwn(field, 'value')) throw new Error('repository_installer_input_invalid');
      const value = field?.value;
      if (required.includes(name as typeof required[number])
        ? typeof value !== 'string' || value.length === 0 || value.length > 8192
        : value !== undefined && value !== null && (typeof value !== 'string' || value.length > 8192)) {
        throw new Error('repository_installer_input_invalid');
      }
      values[name] = value;
    }
    const authorization = fields.sourceAuthorization;
    if (authorization && !Object.hasOwn(authorization, 'value')) throw new Error('repository_installer_input_invalid');
    captured = values as unknown as RepositoryInstallerInput;
    captured.sourceAuthorization = authorization?.value;
  } else captured = {...input};
  if (captured.sourceAuthorization !== undefined) captured.sourceAuthorization =
    validateRepositorySourceAuthorization(captured.sourceAuthorization, captured, new Date());
  return Object.freeze(captured);
}

function errorCode(error: unknown): string | undefined {
  try {
    if (!error || typeof error !== 'object' || types.isProxy(error)) return undefined;
    const field = Object.getOwnPropertyDescriptor(error, 'code');
    return field && Object.hasOwn(field, 'value') && typeof field.value === 'string' ? field.value : undefined;
  } catch {return undefined;}
}

export async function prepareRepositoryInstallerWorkspace(workspace: string, workspaceId: string) {
  const scope = currentBootstrapHostScope();
  await assertRepositoryInstallerOwnership(workspace, workspaceId);
  workspace = await installerEffect(scope, () => realpath(workspace));
  const ownership = await assertRepositoryInstallerOwnership(workspace, workspaceId);
  const paths = ownership === 'signed' ? ['.dharma']
    : ['.agents', '.agents/skills', ROOT, `${ROOT}/references`, '.dharma'];
  for (const path of paths) {
    const target = resolve(workspace, path);
    if (!await checkedPath(workspace, dirname(target), 'directory', scope)) {
      throw new Error('Repository installer parent directory is missing.');
    }
    if (!await checkedPath(workspace, target, 'directory', scope)) {
      try {await installerEffect(scope, () => mkdir(target, {mode: 0o700}));}
      catch (error) {await scope?.assert(); if (errorCode(error) !== 'EEXIST') throw error;}
      if (!await checkedPath(workspace, target, 'directory', scope)) {
        throw new Error('Repository installer directory is missing.');
      }
    }
  }
  await scope?.assert();
  return {workspace, ownership};
}

async function installerEffect<T>(scope: BootstrapHostScope | undefined, operation: () => Promise<T>): Promise<T> {
  if (!scope) return operation();
  try {return await scope.step(operation);}
  catch (error) {
    await scope.assert();
    const code = errorCode(error);
    // Preserve only typed absence/collision, never native paths or vendor diagnostics.
    if (code === 'ENOENT' || code === 'ENOTDIR' || code === 'EEXIST') {
      throw Object.assign(new Error('repository_installer_storage_unavailable'), {code});
    }
    throw new Error('repository_installer_storage_unavailable');
  }
}

export async function checkedPath(workspace: string, path: string, leaf: 'file' | 'directory',
  scope = currentBootstrapHostScope()) {
  await scope?.assert();
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
    try { metadata = await installerEffect(scope, () => lstat(component)); }
    catch (error) {await scope?.assert(); if (errorCode(error) === 'ENOENT') return false; throw error;}
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
  const scope = currentBootstrapHostScope();
  await scope?.assert();
  if (!await checkedPath(workspace, resolve(workspace), 'directory', scope)) throw new Error('Repository installer workspace is missing.');
  const rootExists = await checkedPath(workspace, resolve(workspace, ROOT), 'directory', scope);
  for (const path of FILES) await checkedPath(workspace, resolve(workspace, path), 'file', scope);
  if (!rootExists) return 'absent' as const;
  const markerPath = resolve(workspace, MARKER);
  if (!await checkedPath(workspace, markerPath, 'file', scope)) {
    throw new Error('Refusing to replace an unmanaged repository skill at .agents/skills/dharma-agent-fabric.');
  }
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    await installerEffect(scope, async () => {
      handle = await open(markerPath, constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0));
    });
    const before = await installerEffect(scope, () => handle!.stat());
    if (!before.isFile() || before.nlink !== 1 || before.size > 4096) throw new Error('Invalid repository skill ownership marker.');
    const buffer = Buffer.alloc(4097);
    const { bytesRead } = await installerEffect(scope, () => handle!.read(buffer, 0, buffer.length, 0));
    const after = await installerEffect(scope, () => handle!.stat());
    const current = await installerEffect(scope, () => lstat(markerPath));
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
  } finally {
    try {await handle?.close();}
    catch (error) {if (scope) throw new Error('repository_installer_cleanup_unconfirmed'); throw error;}
  }
}

// Replace owned generated leaves atomically; never truncate an existing inode.
export async function writeRepositoryInstallerFile(workspace: string, path: InstallerFile, content: string, expectedContent?: Buffer) {
  const scope = currentBootstrapHostScope();
  expectedContent = expectedContent === undefined ? undefined : Buffer.from(expectedContent);
  await scope?.assert();
  if (!(FILES as readonly string[]).includes(path)) throw new Error('Unsupported repository installer file.');
  const target = resolve(workspace, path);
  await checkedPath(workspace, dirname(target), 'directory', scope);
  await checkedPath(workspace, target, 'file', scope);
  const temporary = `${target}.staging-${randomUUID()}`;
  let handle: Awaited<ReturnType<typeof open>> | undefined, closeResult: Promise<void> | undefined;
  let identity: {dev: bigint; ino: bigint} | undefined, published = false;
  const closeOwned = (): Promise<void> => closeResult ??= (async () => {
    try {await handle?.close();}
    catch (error) {if (scope) throw new Error('repository_installer_cleanup_unconfirmed'); throw error;}
  })();
  try {
    await installerEffect(scope, async () => {
      handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY
        | (constants.O_NOFOLLOW || 0), 0o600);
    });
    if (scope) {
      const metadata = await installerEffect(scope, () => handle!.stat({bigint: true}));
      identity = {dev: metadata.dev, ino: metadata.ino};
    }
    await installerEffect(scope, () => handle!.writeFile(content));
    await installerEffect(scope, () => handle!.sync());
    await closeOwned();
    await checkedPath(workspace, dirname(target), 'directory', scope);
    await checkedPath(workspace, target, 'file', scope);
    if (expectedContent && !(await installerEffect(scope, () => readFile(target))).equals(expectedContent)) {
      throw new Error('Repository installer destination changed before replacement.');
    }
    await installerEffect(scope, async () => {await rename(temporary, target); published = true;});
  } finally {
    if (handle) await closeOwned();
    if (!published && handle) {
      if (scope) {
        // Withdrawn authority keeps staging evidence; cleanup cannot target a reused name.
        if (await scope.current()) {
          if (!identity) throw new Error('repository_installer_cleanup_unconfirmed');
          try {
            const current = await installerEffect(scope, () => lstat(temporary, {bigint: true}));
            if (!current.isFile() || current.nlink !== 1n || current.dev !== identity.dev || current.ino !== identity.ino) {
              throw new Error('repository_installer_cleanup_unconfirmed');
            }
            await installerEffect(scope, () => unlink(temporary));
          } catch {
            await scope.assert();
            throw new Error('repository_installer_cleanup_unconfirmed');
          }
        }
      } else if (await checkedPath(workspace, temporary, 'file')) await unlink(temporary);
    }
  }
}
