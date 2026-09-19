import { constants, fstatSync, lstatSync, readSync, unlinkSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { lstat, open, realpath, rename, rm } from 'node:fs/promises';
import { basename, dirname, parse, relative, resolve, sep } from 'node:path';
import { canonicalize, sha256, validateContract, type ProviderId } from '@dharma-ai-labs/agent-fabric-contracts';
import { serializeSkillPreparationRecord } from './skillPreparationRecord.js';
import { assertPrivatePath, skillPreparationScopeRoot } from './skillPreparationTransaction.js';

type ExpectedPreparation = {
  organizationId: string;
  deviceId: string;
  repositoryAgentId: string;
  repositoryBindingId: string | null;
  policyHash: string;
  rolloutId: string;
  bundleId: string;
  bundleHash: string;
};

export type SkillPreparationCachePublication = {
  home: string;
  workspaceId: string;
  provider: ProviderId;
  sourceRoot: string;
  recordBytes: string;
  expected: ExpectedPreparation;
  assertCurrent: () => void;
  onCommitted: () => void;
};

export type SkillPreparationCacheExpectation = Omit<ExpectedPreparation, 'rolloutId' | 'bundleId' | 'bundleHash'> & {
  home: string;
  workspaceId: string;
  provider: ProviderId;
  assertCurrent: () => void;
};

const ATTEMPT = /^attempt-[A-Za-z0-9]{6}$(?![\s\S])/;
const METADATA_LIMIT = 3 * 1024 * 1024;
type Stat = Awaited<ReturnType<typeof lstat>>;

function sameIdentity(left: Stat, right: Stat): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

async function privateDirectory(path: string): Promise<Stat> {
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Invalid preparation cache directory.');
  await assertPrivatePath(path, stat);
  return stat;
}

async function privateFile(path: string, limit: number) {
  const initial = await lstat(path);
  if (!initial.isFile() || initial.isSymbolicLink() || initial.nlink !== 1 || initial.size > limit) {
    throw new Error('Invalid preparation cache file.');
  }
  await assertPrivatePath(path, initial);
  const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    const held = await file.stat();
    if (!held.isFile() || held.nlink !== 1 || !sameIdentity(initial, held)) throw new Error('Preparation cache file changed.');
    await assertPrivatePath(path, held);
    const buffer = Buffer.alloc(limit + 1); let length = 0;
    while (length <= limit) {
      const read = await file.read(buffer, length, buffer.length - length, length);
      if (!read.bytesRead) break;
      length += read.bytesRead;
    }
    if (length > limit || length !== held.size) throw new Error('Preparation cache file exceeds its stable byte limit.');
    const assertStable = async () => {
      const current = await lstat(path); const now = await file.stat();
      if (!current.isFile() || current.isSymbolicLink() || current.nlink !== 1
        || !sameIdentity(held, current) || !sameIdentity(held, now)
        || now.nlink !== 1 || now.size !== held.size || now.mtimeMs !== held.mtimeMs
        || current.size !== held.size || current.mtimeMs !== held.mtimeMs) throw new Error('Preparation cache file changed.');
      await assertPrivatePath(path, current); await assertPrivatePath(path, now);
    };
    await assertStable();
    const rawBytes = buffer.subarray(0, length);
    let text: string;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(rawBytes); }
    catch { throw new Error('Invalid preparation cache UTF8 bytes.'); }
    return { file, rawBytes, text, assertStable };
  } catch (error) { await file.close(); throw error; }
}

async function syncDirectory(path: string, expected: Stat) {
  if (process.platform === 'win32') {
    if (!sameIdentity(expected, await privateDirectory(path))) throw new Error('Preparation cache directory changed.');
    return;
  }
  const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    const held = await file.stat();
    if (!held.isDirectory() || !sameIdentity(expected, held)) throw new Error('Preparation cache directory changed.');
    await assertPrivatePath(path, held);
    await file.sync();
    if (!sameIdentity(held, await privateDirectory(path))) throw new Error('Preparation cache directory changed.');
  } finally { await file.close(); }
}

// Caller holds the scoped OS transaction. Cache provenance is never activation authority.
// onCommitted must synchronously, non-throwingly transfer root ownership to the caller.
export async function publishSkillPreparationCache(input: SkillPreparationCachePublication): Promise<void> {
  input.assertCurrent();
  const home = await realpath(resolve(input.home));
  const scopeRoot = skillPreparationScopeRoot(home, input.workspaceId, input.provider);
  const sourceRoot = await realpath(resolve(input.sourceRoot));
  if (dirname(sourceRoot) !== scopeRoot || !ATTEMPT.test(basename(sourceRoot))) throw new Error('Preparation cache scope mismatch.');
  if (Buffer.byteLength(input.recordBytes) > METADATA_LIMIT) throw new Error('Preparation metadata exceeds its limit.');
  let ancestor = parse(home).root;
  for (const part of relative(ancestor, sourceRoot).split(sep).filter(Boolean)) {
    ancestor = resolve(ancestor, part);
    const stat = await lstat(ancestor);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Invalid preparation cache ancestor.');
    input.assertCurrent();
  }
  const directories = new Map<string, Stat>();
  for (const path of [home, resolve(home, 'relay'), resolve(home, 'relay', 'skill-pending-sources'), scopeRoot, sourceRoot]) {
    directories.set(path, await privateDirectory(path)); input.assertCurrent();
  }
  const assertDirectories = async () => {
    for (const [path, stat] of directories) {
      if (!sameIdentity(stat, await privateDirectory(path))) throw new Error('Preparation cache directory changed.');
      input.assertCurrent();
    }
  };
  const metadata = await privateFile(resolve(sourceRoot, 'PREPARED.json'), METADATA_LIMIT);
  const pointerPath = resolve(scopeRoot, 'CURRENT.json');
  const temporary = resolve(scopeRoot, `.CURRENT-${randomUUID()}.json`);
  let pointerWriter: Awaited<ReturnType<typeof open>> | undefined;
  let pointerCandidate: Awaited<ReturnType<typeof privateFile>> | undefined;
  let pointerIdentity: Stat | undefined;
  let committed = false;
  try {
    input.assertCurrent();
    if (!metadata.rawBytes.equals(Buffer.from(input.recordBytes, 'utf8'))) throw new Error('Preparation metadata bytes mismatch.');
    const record = JSON.parse(metadata.text) as Record<string, unknown>;
    if (await serializeSkillPreparationRecord(record) !== metadata.text) throw new Error('Preparation metadata is not canonical.');
    input.assertCurrent();
    const bundle = record.bundle as { bundleId: string; bundleHash: string };
    for (const key of ['organizationId', 'deviceId', 'repositoryAgentId', 'repositoryBindingId', 'policyHash', 'rolloutId'] as const) {
      if (record[key] !== input.expected[key]) throw new Error('Preparation metadata expected scope mismatch.');
    }
    if (record.workspaceId !== input.workspaceId || record.provider !== input.provider
      || bundle.bundleId !== input.expected.bundleId || bundle.bundleHash !== input.expected.bundleHash) {
      throw new Error('Preparation metadata workspace or bundle scope mismatch.');
    }
    const checkExistingPointer = async () => {
      let previous;
      try { previous = await privateFile(pointerPath, 65536); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
      try {
        const value = JSON.parse(previous.text) as Record<string, unknown>;
        const valid = await validateContract(resolve(import.meta.dirname, 'schemas'),
          'https://schemas.dharma-ai.io/skill-preparation-pointer/v1', value);
        if (!valid.ok || value.workspaceId !== input.workspaceId || value.provider !== input.provider
          || !ATTEMPT.test(value.sourceDirectory as string)) throw new Error('Invalid preparation cache pointer scope.');
        for (const key of ['organizationId', 'deviceId', 'repositoryAgentId', 'repositoryBindingId'] as const) {
          if (value[key] !== input.expected[key]) throw new Error('Foreign preparation cache pointer scope.');
        }
        await privateDirectory(resolve(scopeRoot, value.sourceDirectory as string));
        await previous.assertStable();
      } finally { await previous.file.close(); }
    };
    await checkExistingPointer(); input.assertCurrent();
    const pointer = { schema: 'dharma.skill-preparation-pointer/v1', cacheId: randomUUID(),
      organizationId: record.organizationId, deviceId: record.deviceId, workspaceId: input.workspaceId,
      repositoryAgentId: record.repositoryAgentId, repositoryBindingId: record.repositoryBindingId,
      provider: input.provider, policyHash: record.policyHash, rolloutId: record.rolloutId,
      bundleId: bundle.bundleId, bundleHash: bundle.bundleHash, metadataHash: sha256(metadata.rawBytes),
      sourceDirectory: basename(sourceRoot), preparedAt: record.preparedAt, cachedAt: new Date().toISOString(),
      activationAuthorized: false };
    const valid = await validateContract(resolve(import.meta.dirname, 'schemas'),
      'https://schemas.dharma-ai.io/skill-preparation-pointer/v1', pointer);
    if (!valid.ok) throw new Error('Invalid preparation cache pointer contract.');
    input.assertCurrent(); await metadata.assertStable();
    await metadata.file.sync(); input.assertCurrent();
    await syncDirectory(sourceRoot, directories.get(sourceRoot)!); input.assertCurrent();
    const pointerBytes = Buffer.from(canonicalize(pointer) + '\n', 'utf8');
    pointerWriter = await open(temporary, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW || 0), 0o600);
    pointerIdentity = await pointerWriter.stat();
    await assertPrivatePath(temporary, pointerIdentity);
    await pointerWriter.writeFile(pointerBytes);
    await pointerWriter.sync();
    pointerIdentity = await pointerWriter.stat();
    await assertDirectories(); await metadata.assertStable(); await checkExistingPointer();
    pointerCandidate = await privateFile(temporary, 65536);
    if (!pointerCandidate.rawBytes.equals(pointerBytes)
      || !sameIdentity(pointerIdentity, await pointerCandidate.file.stat())) throw new Error('Preparation cache pointer identity changed.');
    await pointerCandidate.assertStable();
    input.assertCurrent();
    // No callback or await may separate these final checks from rename invocation.
    for (const stat of [lstatSync(temporary), fstatSync(pointerWriter.fd), fstatSync(pointerCandidate.file.fd)]) {
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || !sameIdentity(pointerIdentity, stat)
        || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0
        || stat.size !== pointerBytes.length || stat.mtimeMs !== pointerIdentity.mtimeMs) throw new Error('Preparation cache pointer identity changed.');
    }
    const candidateBytes = Buffer.alloc(pointerBytes.length + 1); let length = 0;
    while (length < candidateBytes.length) {
      const read = readSync(pointerCandidate.file.fd, candidateBytes, length, candidateBytes.length - length, length);
      if (!read) break;
      length += read;
    }
    if (!candidateBytes.subarray(0, length).equals(pointerBytes)) throw new Error('Preparation cache pointer bytes changed.');
    for (const stat of [lstatSync(temporary), fstatSync(pointerWriter.fd), fstatSync(pointerCandidate.file.fd)]) {
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || !sameIdentity(pointerIdentity, stat)
        || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0
        || stat.size !== pointerBytes.length || stat.mtimeMs !== pointerIdentity.mtimeMs) throw new Error('Preparation cache pointer identity changed.');
    }
    await rename(temporary, pointerPath);
    committed = true;
    input.onCommitted();
    // The cache is recoverable staging, never activation authority. Windows does
    // not expose a portable directory fsync, so verify the committed file there;
    // a lost directory entry only causes safe re-preparation after restart.
    await syncDirectory(scopeRoot, directories.get(scopeRoot)!);
    if (process.platform === 'win32') {
      const committedPointer = await privateFile(pointerPath, 65536);
      try {
        if (!committedPointer.rawBytes.equals(pointerBytes)) throw new Error('Preparation cache pointer bytes changed.');
        await committedPointer.assertStable();
      } finally { await committedPointer.file.close(); }
    }
    input.assertCurrent();
  } finally {
    try {
      if (pointerIdentity && !committed) {
        try {
          if (sameIdentity(pointerIdentity, lstatSync(temporary))) unlinkSync(temporary);
        } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      }
    } finally {
      try { await metadata.file.close(); }
      finally {
        try { await pointerCandidate?.file.close(); }
        finally { await pointerWriter?.close(); }
      }
    }
  }
}

// Transfers one verified private cache root to the caller. The pointer is removed
// before return, so a cache can never be activated twice or mistaken for authority.
export async function takeSkillPreparationCache(input: SkillPreparationCacheExpectation): Promise<{
  sourceRoot: string;
  record: Record<string, unknown>;
} | null> {
  input.assertCurrent();
  if (process.platform === 'win32') return null;
  const scopeRoot = skillPreparationScopeRoot(resolve(input.home), input.workspaceId, input.provider);
  const pointerPath = resolve(scopeRoot, 'CURRENT.json');
  let pointerFile: Awaited<ReturnType<typeof privateFile>>;
  try { pointerFile = await privateFile(pointerPath, 65_536); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  let metadataFile: Awaited<ReturnType<typeof privateFile>> | undefined;
  let consumingPath: string | undefined;
  try {
    const pointer = JSON.parse(pointerFile.text) as Record<string, unknown>;
    const valid = await validateContract(resolve(import.meta.dirname, 'schemas'),
      'https://schemas.dharma-ai.io/skill-preparation-pointer/v1', pointer);
    if (!valid.ok || pointer.workspaceId !== input.workspaceId || pointer.provider !== input.provider
      || !ATTEMPT.test(pointer.sourceDirectory as string)) throw new Error('Invalid preparation cache pointer scope.');
    for (const key of ['organizationId', 'deviceId', 'repositoryAgentId', 'repositoryBindingId', 'policyHash'] as const) {
      if (pointer[key] !== input[key]) throw new Error('Preparation cache pointer current scope mismatch.');
    }
    const sourceRoot = resolve(scopeRoot, pointer.sourceDirectory as string);
    await privateDirectory(sourceRoot);
    metadataFile = await privateFile(resolve(sourceRoot, 'PREPARED.json'), METADATA_LIMIT);
    if (sha256(metadataFile.rawBytes) !== pointer.metadataHash) throw new Error('Preparation cache metadata hash mismatch.');
    const record = JSON.parse(metadataFile.text) as Record<string, unknown>;
    if (await serializeSkillPreparationRecord(record) !== metadataFile.text) throw new Error('Preparation cache metadata is not canonical.');
    const bundle = record.bundle as { bundleId: string; bundleHash: string };
    for (const key of ['organizationId', 'deviceId', 'workspaceId', 'repositoryAgentId', 'repositoryBindingId', 'provider',
      'policyHash', 'rolloutId'] as const) {
      if (record[key] !== pointer[key]) throw new Error('Preparation cache record scope mismatch.');
    }
    if (bundle.bundleId !== pointer.bundleId || bundle.bundleHash !== pointer.bundleHash) {
      throw new Error('Preparation cache bundle mismatch.');
    }
    input.assertCurrent(); await pointerFile.assertStable(); await metadataFile.assertStable();
    consumingPath = resolve(scopeRoot, `.CONSUMING-${pointer.cacheId}.json`);
    await rename(pointerPath, consumingPath);
    input.assertCurrent();
    await rm(consumingPath, { force: true });
    consumingPath = undefined;
    return { sourceRoot, record };
  } finally {
    await metadataFile?.file.close();
    await pointerFile.file.close();
    if (consumingPath) await rm(consumingPath, { force: true });
  }
}
