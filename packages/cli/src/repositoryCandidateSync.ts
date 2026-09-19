import { constants } from 'node:fs';
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { canonicalize, sha256 } from '@dharma-ai-labs/agent-fabric-contracts';
import {
  serializeRepositoryPackageSnapshot,
  type RepositoryPackageSnapshot,
} from './repositoryPackage.js';

export type RepositoryCandidateState = 'accepted' | 'processing' | 'published' | 'blocked';

export interface RepositoryCandidateScope {
  organizationId: string;
  workspaceId: string;
  repositoryBindingId: string;
  repositoryAgentId: string;
}

export interface RepositoryCandidateTransport {
  signedGet(route: string): Promise<Record<string, unknown>>;
  signedPost(route: string, body: unknown): Promise<Record<string, unknown>>;
}

export type RepositoryCandidateReceipt = {
  candidateId: string;
  operationId: string;
  snapshotHash: string;
  state: RepositoryCandidateState;
  releaseId: string | null;
};

type CandidateOutbox = {
  schema: 'dharma.repository-candidate-outbox/v1';
  scope: RepositoryCandidateScope;
  operationId: string;
  sourceManifestHash: string;
  snapshotHash: string;
  consolidation: {
    mode: 'initial_repository' | 'repository_update';
    includeApprovedOutputs: true;
    requireAtlasAssociation: true;
  };
  candidateId: string | null;
  state: 'pending_upload' | RepositoryCandidateState;
  releaseId: string | null;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$(?![\s\S])/i;
const HASH = /^sha256:[0-9a-f]{64}$(?![\s\S])/;
const ORG = /^org_[A-Za-z0-9_]{1,156}$(?![\s\S])/;
const STATES = new Set<RepositoryCandidateState>(['accepted', 'processing', 'published', 'blocked']);
const OUTBOX_STATES = new Set<CandidateOutbox['state']>(['pending_upload', ...STATES]);

function requireFact(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

function checkedScope(value: RepositoryCandidateScope): RepositoryCandidateScope {
  requireFact(ORG.test(value.organizationId), 'Repository candidate organization is invalid.');
  for (const id of [value.workspaceId, value.repositoryBindingId, value.repositoryAgentId]) {
    requireFact(typeof id === 'string' && UUID.test(id), 'Repository candidate scope is incomplete.');
  }
  return { ...value };
}

function receipt(value: unknown, scope: RepositoryCandidateScope, operationId: string, snapshotHash: string): RepositoryCandidateReceipt {
  requireFact(value !== null && typeof value === 'object' && !Array.isArray(value), 'Repository candidate response is invalid.');
  const response = value as Record<string, unknown>;
  requireFact(response.ok === true && response.organizationId === scope.organizationId
    && response.candidate !== null && typeof response.candidate === 'object' && !Array.isArray(response.candidate),
  'Repository candidate response scope is invalid.');
  const candidate = response.candidate as Record<string, unknown>;
  requireFact(Reflect.ownKeys(candidate).every(key => typeof key === 'string')
    && ['candidateId', 'operationId', 'snapshotHash', 'state', 'releaseId'].every(key => Object.hasOwn(candidate, key))
    && Object.keys(candidate).every(key => ['candidateId', 'operationId', 'snapshotHash', 'state', 'releaseId'].includes(key)),
  'Repository candidate receipt is invalid.');
  requireFact(typeof candidate.candidateId === 'string' && UUID.test(candidate.candidateId)
    && candidate.operationId === operationId && candidate.snapshotHash === snapshotHash
    && typeof candidate.state === 'string' && STATES.has(candidate.state as RepositoryCandidateState)
    && (candidate.releaseId === null || typeof candidate.releaseId === 'string' && UUID.test(candidate.releaseId))
    && (candidate.state === 'published') === (candidate.releaseId !== null),
  'Repository candidate receipt is inconsistent.');
  return candidate as RepositoryCandidateReceipt;
}

function outboxPath(root: string, scope: RepositoryCandidateScope) {
  return resolve(root, `${scope.workspaceId}.json`);
}

async function writeOutbox(path: string, value: CandidateOutbox) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  const bytes = `${canonicalize(value)}\n`;
  const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW || 0), 0o600);
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
  try { await rename(temporary, path); } finally { await rm(temporary, { force: true }); }
}

function outbox(value: unknown, expectedScope?: RepositoryCandidateScope): CandidateOutbox {
  requireFact(value !== null && typeof value === 'object' && !Array.isArray(value), 'Repository candidate outbox is invalid.');
  const row = value as Record<string, unknown>;
  const keys = ['schema', 'scope', 'operationId', 'sourceManifestHash', 'snapshotHash', 'consolidation',
    'candidateId', 'state', 'releaseId'];
  requireFact(row.schema === 'dharma.repository-candidate-outbox/v1'
    && Reflect.ownKeys(row).every(key => typeof key === 'string')
    && keys.every(key => Object.hasOwn(row, key)) && Object.keys(row).every(key => keys.includes(key)),
  'Repository candidate outbox is invalid.');
  const scope = checkedScope(row.scope as RepositoryCandidateScope);
  if (expectedScope) requireFact(canonicalize(scope) === canonicalize(expectedScope), 'Repository candidate outbox scope is invalid.');
  requireFact(typeof row.operationId === 'string' && HASH.test(row.operationId)
    && typeof row.sourceManifestHash === 'string' && HASH.test(row.sourceManifestHash)
    && typeof row.snapshotHash === 'string' && HASH.test(row.snapshotHash)
    && typeof row.state === 'string' && OUTBOX_STATES.has(row.state as CandidateOutbox['state'])
    && (row.candidateId === null || typeof row.candidateId === 'string' && UUID.test(row.candidateId))
    && (row.releaseId === null || typeof row.releaseId === 'string' && UUID.test(row.releaseId))
    && (row.state === 'pending_upload') === (row.candidateId === null)
    && (row.state === 'published') === (row.releaseId !== null), 'Repository candidate outbox is inconsistent.');
  requireFact(row.consolidation !== null && typeof row.consolidation === 'object' && !Array.isArray(row.consolidation),
    'Repository candidate consolidation is invalid.');
  const consolidation = row.consolidation as Record<string, unknown>;
  requireFact(Object.keys(consolidation).sort().join(',') === 'includeApprovedOutputs,mode,requireAtlasAssociation'
    && ['initial_repository', 'repository_update'].includes(String(consolidation.mode))
    && consolidation.includeApprovedOutputs === true && consolidation.requireAtlasAssociation === true,
  'Repository candidate consolidation is invalid.');
  return { schema: 'dharma.repository-candidate-outbox/v1', scope,
    operationId: row.operationId as string, sourceManifestHash: row.sourceManifestHash as string,
    snapshotHash: row.snapshotHash as string, consolidation: consolidation as CandidateOutbox['consolidation'],
    candidateId: row.candidateId as string | null, state: row.state as CandidateOutbox['state'],
    releaseId: row.releaseId as string | null };
}

async function readOutbox(path: string, expectedScope?: RepositoryCandidateScope): Promise<CandidateOutbox | null> {
  try {
    const bytes = await readFile(path);
    requireFact(bytes.length <= 65_536, 'Repository candidate outbox exceeds its byte limit.');
    return outbox(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)), expectedScope);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

export async function synchronizeRepositoryCandidate(input: {
  transport: RepositoryCandidateTransport;
  outboxRoot: string;
  scope: RepositoryCandidateScope;
  snapshot: RepositoryPackageSnapshot;
  initialRepository: boolean;
}): Promise<RepositoryCandidateReceipt> {
  const scope = checkedScope(input.scope);
  const serialized = serializeRepositoryPackageSnapshot(input.snapshot);
  requireFact(Buffer.byteLength(serialized) <= 8_388_608, 'Repository candidate exceeds its upload byte limit.');
  const snapshot = JSON.parse(serialized) as RepositoryPackageSnapshot;
  requireFact(snapshot.manifest.organizationId === scope.organizationId
    && snapshot.manifest.workspaceId === scope.workspaceId
    && snapshot.manifest.knowledge?.repositoryAgentId === scope.repositoryAgentId
    && HASH.test(snapshot.manifest.snapshotHash), 'Repository candidate snapshot scope is invalid.');
  const sourceManifestHash = sha256(canonicalize(snapshot.manifest));
  const consolidation: CandidateOutbox['consolidation'] = {
    mode: input.initialRepository ? 'initial_repository' : 'repository_update',
    includeApprovedOutputs: true, requireAtlasAssociation: true,
  };
  const operationId = sha256(canonicalize({ schema: 'dharma.repository-candidate-operation/v1', ...scope,
    snapshotHash: snapshot.manifest.snapshotHash, sourceManifestHash, consolidation }));
  const path = outboxPath(input.outboxRoot, scope);
  const prior = await readOutbox(path, scope);
  if (prior && (prior.operationId !== operationId || canonicalize(prior.scope) !== canonicalize(scope))) {
    requireFact(['published', 'blocked'].includes(prior.state), 'A different repository candidate is still pending.');
  }
  const pending: CandidateOutbox = prior?.operationId === operationId ? prior : {
    schema: 'dharma.repository-candidate-outbox/v1', scope, operationId,
    sourceManifestHash, snapshotHash: snapshot.manifest.snapshotHash, consolidation,
    candidateId: null, state: 'pending_upload', releaseId: null,
  };
  requireFact(pending.sourceManifestHash === sourceManifestHash && pending.snapshotHash === snapshot.manifest.snapshotHash
    && canonicalize(pending.consolidation) === canonicalize(consolidation),
  'Repository candidate outbox does not match the current upload.');
  await writeOutbox(path, pending);
  const route = `/agent-fabric/repository-agents/${encodeURIComponent(scope.repositoryAgentId)}/package-candidates`;
  let accepted: RepositoryCandidateReceipt;
  if (pending.candidateId) {
    const query = new URLSearchParams({ workspaceId: scope.workspaceId, operationId });
    accepted = receipt(await input.transport.signedGet(`${route}/${encodeURIComponent(pending.candidateId)}?${query}`),
      scope, operationId, snapshot.manifest.snapshotHash);
  } else {
    accepted = receipt(await input.transport.signedPost(route, {
      schema: 'dharma.repository-candidate-upload/v1', operationId, workspaceId: scope.workspaceId,
      repositoryBindingId: scope.repositoryBindingId, repositoryAgentId: scope.repositoryAgentId,
      sourceSnapshotHash: snapshot.manifest.snapshotHash, sourceManifestHash: pending.sourceManifestHash,
      consolidation: pending.consolidation, snapshot,
    }), scope, operationId, snapshot.manifest.snapshotHash);
  }
  await writeOutbox(path, { ...pending, candidateId: accepted.candidateId, state: accepted.state, releaseId: accepted.releaseId });
  return accepted;
}

export async function pollRepositoryCandidate(input: {
  transport: Pick<RepositoryCandidateTransport, 'signedGet'>;
  outboxRoot: string;
  scope: RepositoryCandidateScope;
}): Promise<RepositoryCandidateReceipt | null> {
  const scope = checkedScope(input.scope);
  const path = outboxPath(input.outboxRoot, scope);
  const pending = await readOutbox(path, scope);
  if (!pending || pending.state === 'pending_upload') return null;
  if (pending.state === 'published' || pending.state === 'blocked') {
    return { candidateId: pending.candidateId!, operationId: pending.operationId, snapshotHash: pending.snapshotHash,
      state: pending.state, releaseId: pending.releaseId };
  }
  const route = `/agent-fabric/repository-agents/${encodeURIComponent(scope.repositoryAgentId)}/package-candidates`;
  const query = new URLSearchParams({ workspaceId: scope.workspaceId, operationId: pending.operationId });
  const current = receipt(await input.transport.signedGet(
    `${route}/${encodeURIComponent(pending.candidateId!)}?${query}`,
  ), scope, pending.operationId, pending.snapshotHash);
  await writeOutbox(path, { ...pending, candidateId: current.candidateId, state: current.state, releaseId: current.releaseId });
  return current;
}

export async function adoptRepositoryCandidate(input: {
  outboxRoot: string;
  scope: RepositoryCandidateScope;
  sourceManifestHash: string;
  consolidationMode: CandidateOutbox['consolidation']['mode'];
  candidate: RepositoryCandidateReceipt;
}): Promise<RepositoryCandidateReceipt> {
  const scope = checkedScope(input.scope);
  requireFact(HASH.test(input.sourceManifestHash), 'Canonical repository candidate manifest hash is invalid.');
  const candidate = receipt({ ok: true, organizationId: scope.organizationId, candidate: input.candidate },
    scope, input.candidate.operationId, input.candidate.snapshotHash);
  requireFact(candidate.state !== 'accepted' || candidate.candidateId !== null,
    'Canonical repository candidate is incomplete.');
  await writeOutbox(outboxPath(input.outboxRoot, scope), {
    schema: 'dharma.repository-candidate-outbox/v1', scope, operationId: candidate.operationId,
    sourceManifestHash: input.sourceManifestHash, snapshotHash: candidate.snapshotHash,
    consolidation: { mode: input.consolidationMode, includeApprovedOutputs: true, requireAtlasAssociation: true },
    candidateId: candidate.candidateId, state: candidate.state, releaseId: candidate.releaseId,
  });
  return candidate;
}
