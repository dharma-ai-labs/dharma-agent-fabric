import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readFile, realpath, rename, unlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { canonicalize } from '@dharma-ai-labs/agent-fabric-contracts';
import type { RepositorySourceResolution, RepositorySourceResolutionPlan } from './repositorySourceReconciliation.js';
import { currentBootstrapHostScope } from './bootstrapHostScope.js';
import { repositorySourcePathSafe } from './repositorySourceAuthorization.js';

const HASH = /^sha256:[a-f0-9]{64}$(?![\s\S])/;
const LIMIT = 1024 * 1024;
const digest = (value: unknown) => `sha256:${createHash('sha256').update(canonicalize(value)).digest('hex')}`;
let validator: Promise<ReturnType<Ajv2020['compile']>> | undefined;
async function checkedPlan(value: unknown, hash: string): Promise<RepositorySourceResolutionPlan> {
  validator ??= readFile(new URL('./schemas/repository-source-resolution.schema.json', import.meta.url), 'utf8')
    .then(bytes => new Ajv2020({ strict: true }).compile(JSON.parse(bytes)));
  if (!HASH.test(hash) || !(await validator)(value) || digest(value) !== hash) {
    throw new Error('repository_source_resolution_plan_invalid');
  }
  const plan = value as RepositorySourceResolutionPlan;
  const created = new Date(plan.createdAt), expires = new Date(plan.expiresAt);
  if (!Number.isFinite(created.getTime()) || !Number.isFinite(expires.getTime())
    || created.toISOString() !== plan.createdAt || expires.toISOString() !== plan.expiresAt
    || expires.getTime() - created.getTime() !== 15 * 60_000
    || plan.conflicts.some(conflict => !repositorySourcePathSafe(conflict.path))) {
    throw new Error('repository_source_resolution_plan_invalid');
  }
  return plan;
}
async function step<T>(fn: () => Promise<T>): Promise<T> {
  const scope = currentBootstrapHostScope();
  return scope ? scope.step(fn) : fn();
}
async function directory(workspace: string, create: boolean): Promise<string | null> {
  const anchor = resolve(workspace);
  if (await step(() => realpath(anchor)) !== anchor || !(await step(() => lstat(anchor))).isDirectory()) {
    throw new Error('repository_source_resolution_path_invalid');
  }
  let path = anchor;
  for (const part of ['.dharma', 'repository-source', 'resolutions']) {
    path = resolve(path, part);
    if (create) await step(() => mkdir(path, { mode: 0o700 })).catch(error => { if (error.code !== 'EEXIST') throw error; });
    const entry = await step(() => lstat(path)).catch(error => {
      if (!create && error.code === 'ENOENT') return null;
      throw error;
    });
    if (!entry) return null;
    if (!entry.isDirectory() || entry.isSymbolicLink() || await step(() => realpath(path)) !== path) {
      throw new Error('repository_source_resolution_path_invalid');
    }
  }
  return path;
}
async function readRegular(path: string, limit: number): Promise<string> {
  const before = await step(() => lstat(path));
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > limit) {
    throw new Error('repository_source_resolution_file_invalid');
  }
  const file = await step(() => open(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0)));
  try {
    const actual = await step(() => file.stat());
    if (actual.dev !== before.dev || actual.ino !== before.ino || actual.size !== before.size || !actual.isFile()) {
      throw new Error('repository_source_resolution_file_changed');
    }
    const bytes = Buffer.alloc(limit + 1);
    let count = 0;
    while (count < bytes.length) {
      const result = await step(() => file.read(bytes, count, bytes.length - count, count));
      if (!result.bytesRead) break;
      count += result.bytesRead;
    }
    const after = await step(() => file.stat());
    if (count > limit || count !== actual.size || after.size !== actual.size || after.mtimeMs !== actual.mtimeMs
      || after.ctimeMs !== actual.ctimeMs || after.nlink !== 1) {
      throw new Error('repository_source_resolution_file_changed');
    }
    return bytes.subarray(0, count).toString('utf8');
  } finally { await file.close(); }
}

export async function saveRepositorySourceResolutionPlan(workspace: string, proposed: { plan: RepositorySourceResolutionPlan; planHash: string }) {
  const plan = structuredClone(proposed.plan), hash = proposed.planHash;
  const bytes = canonicalize(await checkedPlan(plan, hash));
  if (Buffer.byteLength(bytes) > LIMIT) throw new Error('repository_source_resolution_plan_invalid');
  const root = (await directory(workspace, true))!;
  const path = resolve(root, hash.slice(7) + '.json');
  let file: Awaited<ReturnType<typeof open>> | undefined;
  try {
    file = await step(() => open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW || 0), 0o600));
    await step(() => file!.writeFile(bytes));
    await step(() => file!.sync());
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || await readRegular(path, LIMIT) !== bytes) throw error;
  } finally { await file?.close(); }
  if (await directory(workspace, false) !== root) throw new Error('repository_source_resolution_path_changed');
  return { planHash: hash, expiresAt: plan.expiresAt };
}

export async function readRepositorySourceResolutionPlan(workspace: string, hash: string) {
  if (!HASH.test(hash)) throw new Error('repository_source_resolution_hash_invalid');
  const root = await directory(workspace, false);
  if (!root) throw new Error('repository_source_resolution_plan_missing');
  const value: unknown = JSON.parse(await readRegular(resolve(root, hash.slice(7) + '.json'), LIMIT));
  const plan = await checkedPlan(value, hash);
  if (await directory(workspace, false) !== root) throw new Error('repository_source_resolution_path_changed');
  return { plan, planHash: hash };
}

export async function activateRepositorySourceResolution(workspace: string, proposed: RepositorySourceResolution) {
  const { plan, planHash } = await readRepositorySourceResolutionPlan(workspace, proposed.planHash);
  if (canonicalize(plan) !== canonicalize(proposed.plan)) throw new Error('repository_source_resolution_context_changed');
  const now = proposed.now ?? new Date();
  if (!Number.isFinite(now.getTime()) || Date.parse(plan.createdAt) > now.getTime() || Date.parse(plan.expiresAt) <= now.getTime()) {
    throw new Error('repository_source_resolution_expired_or_invalid');
  }
  const root = (await directory(workspace, false))!, path = resolve(root, 'ACTIVE');
  const temporary = resolve(root, `active-${process.pid}-${randomUUID()}.tmp`);
  const file = await step(() => open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW || 0), 0o600));
  try {
    await step(() => file.writeFile(planHash));
    await step(() => file.sync());
    if (await directory(workspace, false) !== root) throw new Error('repository_source_resolution_path_changed');
    await step(() => rename(temporary, path));
  } finally {
    await file.close();
    await step(() => unlink(temporary)).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
  return { planHash, expiresAt: plan.expiresAt };
}

export async function readActiveRepositorySourceResolution(workspace: string): Promise<RepositorySourceResolution | null> {
  const root = await directory(workspace, false);
  if (!root) return null;
  const hash = await readRegular(resolve(root, 'ACTIVE'), 71).catch(error => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (hash === null) return null;
  return readRepositorySourceResolutionPlan(workspace, hash);
}
