import { canonicalize } from '@dharma-ai-labs/agent-fabric-contracts';
import { rebuildRepositoryPackageSnapshot, serializeRepositoryPackageSnapshot,
  type RepositoryPackageFile, type RepositoryPackageManifest,
  type RepositoryPackageSnapshot } from './repositoryPackage.js';

type Skill = RepositoryPackageManifest['skills'][number];
type Blob = RepositoryPackageSnapshot['blobs'][number];

export interface PublishedRepositorySource {
  files: RepositoryPackageFile[];
  skills: Skill[];
  blobs: Blob[];
  sourceFingerprint: string;
}

function indexed<T extends { path: string }>(entries: T[], label: string) {
  const result = new Map<string, T>();
  for (const entry of entries) {
    const key = entry.path.toLowerCase();
    if (result.has(key)) throw new Error(`Repository source ${label} contains a conflicting path.`);
    result.set(key, entry);
  }
  return result;
}

function same(left: unknown, right: unknown) {
  return canonicalize(left) === canonicalize(right);
}

function reconcileEntries<T extends { path: string }>(label: string, local: T[],
  previousLocal: T[], published: T[]): T[] {
  const localByPath = indexed(local, `${label} local inventory`);
  const baseByPath = indexed(previousLocal, `${label} published local baseline`);
  const publishedByPath = indexed(published, `${label} published inventory`);
  const paths = new Set([...localByPath.keys(), ...baseByPath.keys(), ...publishedByPath.keys()]);
  const result: T[] = [];
  for (const path of [...paths].sort()) {
    const current = localByPath.get(path);
    const base = baseByPath.get(path);
    const remote = publishedByPath.get(path);
    const localChanged = !same(current ?? null, base ?? null);
    const remoteChanged = !same(remote ?? null, base ?? null);
    if (localChanged && remoteChanged && !same(current ?? null, remote ?? null)) {
      throw new Error(`Repository source ${label} changed concurrently at ${path}.`);
    }
    const chosen = localChanged ? current : remote;
    if (chosen) result.push(chosen);
  }
  return result;
}

export function reconcileRepositorySourceSnapshot(input: {
  local: RepositoryPackageSnapshot;
  previousLocal: RepositoryPackageSnapshot | null;
  published: PublishedRepositorySource | null;
}): RepositoryPackageSnapshot {
  serializeRepositoryPackageSnapshot(input.local);
  if (input.previousLocal) {
    serializeRepositoryPackageSnapshot(input.previousLocal);
    const prior = input.previousLocal.manifest;
    const current = input.local.manifest;
    if (prior.organizationId !== current.organizationId || prior.workspaceId !== current.workspaceId
      || prior.sourceAuthorization?.repositoryBindingId !== current.sourceAuthorization?.repositoryBindingId
      || prior.sourceAuthorization?.repositoryAgentId !== current.sourceAuthorization?.repositoryAgentId
      || prior.sourceAuthorization?.generationId !== current.sourceAuthorization?.generationId) {
      throw new Error('Repository source local baseline has a different authority.');
    }
  }
  if (!input.published) return input.local;
  const local = input.local.manifest;
  const prior = input.previousLocal?.manifest;
  const sourceFiles = (manifest: RepositoryPackageManifest | undefined) =>
    manifest?.files.filter(file => file.role !== 'knowledge') ?? [];
  const files = reconcileEntries('file', sourceFiles(local), sourceFiles(prior), input.published.files);
  const skills = reconcileEntries('skill', local.skills, prior?.skills ?? [], input.published.skills);
  const allFiles = [...local.files.filter(file => file.role === 'knowledge'), ...files];
  const available = new Map<string, Blob>();
  for (const blob of [...input.published.blobs, ...input.local.blobs]) available.set(blob.sha256, blob);
  const blobs = [...new Set(allFiles.map(file => file.sha256))].map(hash => {
    const blob = available.get(hash);
    if (!blob) throw new Error('Repository source reconciliation is missing a content-addressed blob.');
    return blob;
  });
  return rebuildRepositoryPackageSnapshot(input.local, { files: allFiles, skills, blobs });
}
