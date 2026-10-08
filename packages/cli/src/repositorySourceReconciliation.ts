import { canonicalize } from '@dharma-ai-labs/agent-fabric-contracts';
import { createHash } from 'node:crypto';
import { rebuildRepositoryPackageSnapshot, serializeRepositoryPackageSnapshot,
  type RepositoryPackageFile, type RepositoryPackageManifest,
  type RepositoryPackageSnapshot } from './repositoryPackage.js';

type Skill = RepositoryPackageManifest['skills'][number];
type Blob = RepositoryPackageSnapshot['blobs'][number];
const HASH = /^sha256:[a-f0-9]{64}$(?![\s\S])/;
const digest = (value: unknown) => `sha256:${createHash('sha256').update(canonicalize(value)).digest('hex')}`;
const RESOLUTION_LIFETIME_MS = 15 * 60_000;

export interface RepositorySourceResolutionPlan {
  schema: 'dharma.repository-source-resolution/v1';
  organizationId: string;
  workspaceId: string;
  repositoryBindingId: string;
  repositoryAgentId: string;
  policyGenerationId: string;
  policyHash: string;
  baselineSnapshotHash: string;
  localSnapshotHash: string;
  publishedFingerprint: string;
  publishedInventoryHash: string;
  createdAt: string;
  expiresAt: string;
  conflicts: Array<{ kind: 'file' | 'skill'; path: string; baselineHash: string; localHash: string; publishedHash: string }>;
}

type SourceInput = { local: RepositoryPackageSnapshot; previousLocal: RepositoryPackageSnapshot | null;
  published: PublishedRepositorySource | null };
export type RepositorySourceResolution = { plan: RepositorySourceResolutionPlan; planHash: string; now?: Date };
export class RepositorySourceConflictError extends Error {
  readonly code = 'repository_source_conflict';
  constructor(kind: string, path: string) {
    super(`Repository source ${kind} changed concurrently at ${path}.`);
    this.name = 'RepositorySourceConflictError';
  }
}

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
  previousLocal: T[], published: T[], approvedConflicts?: Set<string>): T[] {
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
      if (!approvedConflicts?.has(`${label}:${path}`)) {
        throw new RepositorySourceConflictError(label, path);
      }
    }
    const chosen = localChanged ? current : remote;
    if (chosen) result.push(chosen);
  }
  return result;
}

function checkedInput(input: SourceInput) {
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
}

function conflictEntries<T extends { path: string }>(kind: 'file' | 'skill', local: T[], baseline: T[], published: T[]) {
  const current = indexed(local, `${kind} local inventory`), previous = indexed(baseline, `${kind} published local baseline`);
  const remote = indexed(published, `${kind} published inventory`);
  const conflicts: RepositorySourceResolutionPlan['conflicts'] = [];
  for (const path of [...new Set([...current.keys(), ...previous.keys(), ...remote.keys()])].sort()) {
    const a = current.get(path) ?? null, b = previous.get(path) ?? null, c = remote.get(path) ?? null;
    if (!same(a, b) && !same(c, b) && !same(a, c)) {
      conflicts.push({ kind, path, baselineHash: digest(b), localHash: digest(a), publishedHash: digest(c) });
    }
  }
  return conflicts;
}

export function planRepositorySourceResolution(input: SourceInput & { now?: Date }) {
  checkedInput(input);
  const manifest = input.local.manifest, authorization = manifest.sourceAuthorization;
  const now = input.now ?? new Date();
  if (!input.previousLocal || !input.published || !authorization || !Number.isFinite(now.getTime())
    || !authorization.policy.automaticValidatedPublication || !HASH.test(input.published.sourceFingerprint)) {
    throw new Error('repository_source_resolution_prerequisite_missing');
  }
  const files = (value: RepositoryPackageSnapshot) => value.manifest.files.filter(file => file.role !== 'knowledge');
  const conflicts = [
    ...conflictEntries('file', files(input.local), files(input.previousLocal), input.published.files),
    ...conflictEntries('skill', manifest.skills, input.previousLocal.manifest.skills, input.published.skills),
  ];
  if (!conflicts.length) throw new Error('repository_source_resolution_not_required');
  const plan: RepositorySourceResolutionPlan = {
    schema: 'dharma.repository-source-resolution/v1', organizationId: manifest.organizationId, workspaceId: manifest.workspaceId,
    repositoryBindingId: authorization.repositoryBindingId, repositoryAgentId: authorization.repositoryAgentId,
    policyGenerationId: authorization.generationId, policyHash: authorization.policyHash,
    baselineSnapshotHash: input.previousLocal.manifest.snapshotHash, localSnapshotHash: manifest.snapshotHash,
    publishedFingerprint: input.published.sourceFingerprint,
    publishedInventoryHash: digest({ files: input.published.files, skills: input.published.skills }),
    createdAt: now.toISOString(), expiresAt: new Date(now.getTime() + RESOLUTION_LIFETIME_MS).toISOString(), conflicts,
  };
  return { plan, planHash: digest(plan) };
}

function approvedConflictSet(input: SourceInput, resolution: RepositorySourceResolution) {
  const { plan, planHash } = resolution, now = resolution.now ?? new Date();
  const created = new Date(plan?.createdAt);
  if (!Number.isFinite(now.getTime()) || !Number.isFinite(created.getTime())
    || plan.createdAt !== created.toISOString() || created.getTime() > now.getTime()
    || now.getTime() >= created.getTime() + RESOLUTION_LIFETIME_MS || !HASH.test(planHash)) {
    throw new Error('repository_source_resolution_expired_or_invalid');
  }
  const expected = planRepositorySourceResolution({ ...input, now: created });
  if (expected.planHash !== planHash || canonicalize(expected.plan) !== canonicalize(plan)) {
    throw new Error('repository_source_resolution_context_changed');
  }
  return new Set(plan.conflicts.map(entry => `${entry.kind}:${entry.path}`));
}

export function reconcileRepositorySourceSnapshot(input: SourceInput & { resolution?: RepositorySourceResolution }): RepositoryPackageSnapshot {
  checkedInput(input);
  const approved = input.resolution ? approvedConflictSet(input, input.resolution) : undefined;
  if (!input.published) return input.local;
  const local = input.local.manifest;
  const prior = input.previousLocal?.manifest;
  const sourceFiles = (manifest: RepositoryPackageManifest | undefined) =>
    manifest?.files.filter(file => file.role !== 'knowledge') ?? [];
  const files = reconcileEntries('file', sourceFiles(local), sourceFiles(prior), input.published.files, approved);
  const skills = reconcileEntries('skill', local.skills, prior?.skills ?? [], input.published.skills, approved);
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
