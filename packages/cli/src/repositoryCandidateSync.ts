import { constants } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { link, lstat, mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalize, sha256, validateContract } from '@dharma-ai-labs/agent-fabric-contracts';
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
    expectedLatestSourceFingerprint?: string;
  };
  candidateId: string | null;
  state: 'pending_upload' | 'fenced' | RepositoryCandidateState;
  releaseId: string | null;
  restoration?: RestorationCheckpoint;
  fence?: RepositoryCandidateFence;
};

type RestorationCheckpoint = {
  planHash: string;
  localSnapshotHash: string;
  baselineSnapshotHash: string | null;
  previousOperationId: string | null;
  priorReleaseId: string;
  attemptId?: string;
  headCandidateId?: string;
};

type RestorationContext = { headCandidateId: string; priorReleaseId: string };

type RepositoryCandidateFence = {
  fenceId: string; operationId: string; workspaceId: string; repositoryBindingId: string; repositoryAgentId: string;
  sourceSnapshotHash: string; sourceManifestHash: string; policyGenerationId: string;
  state: 'fenced'; createdAt: string;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$(?![\s\S])/i;
const HASH = /^sha256:[0-9a-f]{64}$(?![\s\S])/;
const ORG = /^org_[A-Za-z0-9_]{1,156}$(?![\s\S])/;
const STATES = new Set<RepositoryCandidateState>(['accepted', 'processing', 'published', 'blocked']);
const OUTBOX_STATES = new Set<CandidateOutbox['state']>(['pending_upload', 'fenced', ...STATES]);

export function repositoryCandidateOperationId(input: {
  scope: RepositoryCandidateScope; snapshotHash: string; sourceManifestHash: string;
  consolidation: CandidateOutbox['consolidation']; recoveryAttempt?: boolean; restorationAttempt?: string;
  restorationContext?: RestorationContext;
}) {
  requireFact(input.restorationAttempt === undefined || UUID.test(input.restorationAttempt), 'Repository restoration attempt is invalid.');
  requireFact(input.restorationContext === undefined || UUID.test(input.restorationContext.headCandidateId)
    && UUID.test(input.restorationContext.priorReleaseId), 'Repository restoration context is invalid.');
  return sha256(canonicalize({ schema: 'dharma.repository-candidate-operation/v1',
    organizationId: input.scope.organizationId, workspaceId: input.scope.workspaceId,
    repositoryBindingId: input.scope.repositoryBindingId, repositoryAgentId: input.scope.repositoryAgentId,
    snapshotHash: input.snapshotHash, sourceManifestHash: input.sourceManifestHash, consolidation: input.consolidation,
    ...(input.recoveryAttempt ? { recoveryAttempt: 1 } : {}),
    ...(input.restorationAttempt ? { restorationAttempt: input.restorationAttempt } : {}),
    ...(input.restorationContext ? { restorationContext: input.restorationContext } : {}) }));
}

function requireFact(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

function restorationCheckpoint(value: unknown): RestorationCheckpoint {
  requireFact(value !== null && typeof value === 'object' && !Array.isArray(value), 'Repository restoration checkpoint is invalid.');
  const row = value as Record<string, unknown>;
  requireFact(Object.keys(row).sort().join(',') === ['baselineSnapshotHash', 'localSnapshotHash', 'planHash',
    'previousOperationId', 'priorReleaseId', ...(Object.hasOwn(row, 'attemptId') ? ['attemptId'] : []),
    ...(Object.hasOwn(row, 'headCandidateId') ? ['headCandidateId'] : [])].sort().join(',')
    && typeof row.planHash === 'string' && HASH.test(row.planHash)
    && typeof row.localSnapshotHash === 'string' && HASH.test(row.localSnapshotHash)
    && (row.baselineSnapshotHash === null || typeof row.baselineSnapshotHash === 'string' && HASH.test(row.baselineSnapshotHash))
    && (row.previousOperationId === null || typeof row.previousOperationId === 'string' && HASH.test(row.previousOperationId))
    && typeof row.priorReleaseId === 'string' && UUID.test(row.priorReleaseId)
    && (row.attemptId === undefined || typeof row.attemptId === 'string' && UUID.test(row.attemptId))
    && (!Object.hasOwn(row, 'headCandidateId') || typeof row.headCandidateId === 'string' && UUID.test(row.headCandidateId)),
  'Repository restoration checkpoint is invalid.');
  return row as RestorationCheckpoint;
}

function restorationContext(checkpoint: RestorationCheckpoint | undefined): RestorationContext | undefined {
  return checkpoint?.headCandidateId ? { headCandidateId: checkpoint.headCandidateId, priorReleaseId: checkpoint.priorReleaseId } : undefined;
}

function checkedScope(value: RepositoryCandidateScope): RepositoryCandidateScope {
  requireFact(ORG.test(value.organizationId), 'Repository candidate organization is invalid.');
  for (const id of [value.workspaceId, value.repositoryBindingId, value.repositoryAgentId]) {
    requireFact(typeof id === 'string' && UUID.test(id), 'Repository candidate scope is incomplete.');
  }
  return { ...value };
}

function receipt(value: unknown, scope: RepositoryCandidateScope, operationId: string, snapshotHash: string,
  archivedReleaseId?: string): RepositoryCandidateReceipt {
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
  requireFact(candidate.state !== 'published' || candidate.releaseId !== archivedReleaseId,
    'Repository restoration cannot reuse the archived release identity.');
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
    && keys.every(key => Object.hasOwn(row, key)) && Object.keys(row).every(key => keys.includes(key) || key === 'restoration' || key === 'fence'),
  'Repository candidate outbox is invalid.');
  const scope = checkedScope(row.scope as RepositoryCandidateScope);
  if (expectedScope) requireFact(canonicalize(scope) === canonicalize(expectedScope), 'Repository candidate outbox scope is invalid.');
  requireFact(typeof row.operationId === 'string' && HASH.test(row.operationId)
    && typeof row.sourceManifestHash === 'string' && HASH.test(row.sourceManifestHash)
    && typeof row.snapshotHash === 'string' && HASH.test(row.snapshotHash)
    && typeof row.state === 'string' && OUTBOX_STATES.has(row.state as CandidateOutbox['state'])
    && (row.candidateId === null || typeof row.candidateId === 'string' && UUID.test(row.candidateId))
    && (row.releaseId === null || typeof row.releaseId === 'string' && UUID.test(row.releaseId))
    && ['pending_upload', 'fenced'].includes(String(row.state)) === (row.candidateId === null)
    && (row.state === 'published') === (row.releaseId !== null), 'Repository candidate outbox is inconsistent.');
  requireFact(row.consolidation !== null && typeof row.consolidation === 'object' && !Array.isArray(row.consolidation),
    'Repository candidate consolidation is invalid.');
  const consolidation = row.consolidation as Record<string, unknown>;
  requireFact(Object.keys(consolidation).sort().join(',') === (Object.hasOwn(consolidation, 'expectedLatestSourceFingerprint')
    ? 'expectedLatestSourceFingerprint,includeApprovedOutputs,mode,requireAtlasAssociation'
    : 'includeApprovedOutputs,mode,requireAtlasAssociation')
    && ['initial_repository', 'repository_update'].includes(String(consolidation.mode))
    && consolidation.includeApprovedOutputs === true && consolidation.requireAtlasAssociation === true
    && (consolidation.expectedLatestSourceFingerprint === undefined
      || consolidation.mode === 'repository_update' && typeof consolidation.expectedLatestSourceFingerprint === 'string'
        && HASH.test(consolidation.expectedLatestSourceFingerprint)),
  'Repository candidate consolidation is invalid.');
  const restoration = Object.hasOwn(row, 'restoration') ? restorationCheckpoint(row.restoration) : undefined;
  requireFact((row.state === 'fenced') === Object.hasOwn(row, 'fence') && (row.state !== 'fenced' || Boolean(restoration)),
    'Repository candidate fence checkpoint is inconsistent.');
  const fence = row.state === 'fenced' ? checkedFence(row.fence, scope, String(row.operationId),
    String(row.snapshotHash), String(row.sourceManifestHash)) : undefined;
  return { schema: 'dharma.repository-candidate-outbox/v1', scope,
    operationId: row.operationId as string, sourceManifestHash: row.sourceManifestHash as string,
    snapshotHash: row.snapshotHash as string, consolidation: consolidation as CandidateOutbox['consolidation'],
    candidateId: row.candidateId as string | null, state: row.state as CandidateOutbox['state'],
    releaseId: row.releaseId as string | null,
    ...(restoration ? { restoration } : {}), ...(fence ? { fence } : {}) };
}

function checkedFence(value: unknown, scope: RepositoryCandidateScope, operationId: string, snapshotHash: string,
  sourceManifestHash: string, policyGenerationId?: string): RepositoryCandidateFence {
  requireFact(value !== null && typeof value === 'object' && !Array.isArray(value), 'Repository candidate fence receipt is invalid.');
  const row = value as Record<string, unknown>;
  requireFact(Object.keys(row).sort().join(',') === 'createdAt,fenceId,operationId,policyGenerationId,repositoryAgentId,repositoryBindingId,sourceManifestHash,sourceSnapshotHash,state,workspaceId'
    && typeof row.fenceId === 'string' && UUID.test(row.fenceId) && row.operationId === operationId
    && row.workspaceId === scope.workspaceId && row.repositoryBindingId === scope.repositoryBindingId && row.repositoryAgentId === scope.repositoryAgentId
    && row.sourceSnapshotHash === snapshotHash && row.sourceManifestHash === sourceManifestHash && row.state === 'fenced'
    && typeof row.policyGenerationId === 'string' && UUID.test(row.policyGenerationId)
    && (policyGenerationId === undefined || row.policyGenerationId === policyGenerationId)
    && typeof row.createdAt === 'string' && Number.isFinite(Date.parse(row.createdAt))
    && new Date(row.createdAt).toISOString() === row.createdAt, 'Repository candidate fence receipt is inconsistent.');
  return row as RepositoryCandidateFence;
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
  expectedLatestSourceFingerprint?: string;
  blockedCandidate?: RepositoryCandidateReceipt;
  restoration?: RestorationCheckpoint;
}): Promise<RepositoryCandidateReceipt> {
  const scope = checkedScope(input.scope);
  const serialized = serializeRepositoryPackageSnapshot(input.snapshot);
  requireFact(Buffer.byteLength(serialized) <= 8_388_608, 'Repository candidate exceeds its upload byte limit.');
  requireFact(input.snapshot.schema === 'dharma.repository-package-snapshot/v1'
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(input.snapshot.capturedAt)
    && Number.isFinite(Date.parse(input.snapshot.capturedAt))
    && new Date(input.snapshot.capturedAt).toISOString() === input.snapshot.capturedAt,
  'Repository candidate envelope metadata is invalid.');
  const contentAddressed = JSON.parse(serialized) as Pick<RepositoryPackageSnapshot, 'manifest' | 'blobs'>;
  const snapshot: RepositoryPackageSnapshot = {
    schema: input.snapshot.schema,
    capturedAt: input.snapshot.capturedAt,
    manifest: contentAddressed.manifest,
    blobs: contentAddressed.blobs,
  };
  requireFact(snapshot.manifest.organizationId === scope.organizationId
    && snapshot.manifest.workspaceId === scope.workspaceId
    && snapshot.manifest.knowledge?.repositoryAgentId === scope.repositoryAgentId
    && HASH.test(snapshot.manifest.snapshotHash), 'Repository candidate snapshot scope is invalid.');
  const sourceManifestHash = sha256(canonicalize(snapshot.manifest));
  requireFact(input.expectedLatestSourceFingerprint === undefined
    || !input.initialRepository && HASH.test(input.expectedLatestSourceFingerprint),
  'Repository candidate expected source parent is invalid.');
  requireFact(input.blockedCandidate === undefined || input.initialRepository
    && input.blockedCandidate.state === 'blocked' && UUID.test(input.blockedCandidate.candidateId)
    && HASH.test(input.blockedCandidate.operationId) && HASH.test(input.blockedCandidate.snapshotHash)
    && input.blockedCandidate.releaseId === null,
  'Repository candidate recovery requires a blocked initial publication.');
  const consolidation: CandidateOutbox['consolidation'] = {
    mode: input.initialRepository ? 'initial_repository' : 'repository_update',
    includeApprovedOutputs: true, requireAtlasAssociation: true,
    ...(input.expectedLatestSourceFingerprint ? {
      expectedLatestSourceFingerprint: input.expectedLatestSourceFingerprint,
    } : {}),
  };
  const restoration = input.restoration === undefined ? undefined : restorationCheckpoint(input.restoration);
  requireFact(!restoration || !input.initialRepository && Boolean(input.expectedLatestSourceFingerprint)
    && !input.blockedCandidate, 'Repository restoration checkpoint requires an update.');
  const operationId = repositoryCandidateOperationId({ scope, snapshotHash: snapshot.manifest.snapshotHash,
    sourceManifestHash, consolidation, recoveryAttempt: Boolean(input.blockedCandidate), restorationAttempt: restoration?.attemptId,
    restorationContext: restorationContext(restoration) });
  const path = outboxPath(input.outboxRoot, scope);
  const prior = await readOutbox(path, scope);
  if (prior?.state === 'fenced') {
    requireFact(prior.fence && restoration?.attemptId === prior.fence.fenceId && prior.operationId !== operationId,
      'A fenced operation requires its verified new restoration attempt.');
    await archiveFencedCheckpoint(input.outboxRoot, prior);
  }
  if (prior && (prior.operationId !== operationId || canonicalize(prior.scope) !== canonicalize(scope))) {
    requireFact(['published', 'blocked', 'fenced'].includes(prior.state)
      || input.blockedCandidate?.candidateId === prior.candidateId,
    'A different repository candidate is still pending.');
  }
  const pending: CandidateOutbox = prior?.operationId === operationId ? prior : {
    schema: 'dharma.repository-candidate-outbox/v1', scope, operationId,
    sourceManifestHash, snapshotHash: snapshot.manifest.snapshotHash, consolidation,
    candidateId: null, state: 'pending_upload', releaseId: null,
    ...(restoration ? { restoration } : {}),
  };
  requireFact(pending.sourceManifestHash === sourceManifestHash && pending.snapshotHash === snapshot.manifest.snapshotHash
    && canonicalize(pending.consolidation) === canonicalize(consolidation)
    && canonicalize(pending.restoration ?? null) === canonicalize(restoration ?? null),
  'Repository candidate outbox does not match the current upload.');
  await writeOutbox(path, pending);
  const route = `/agent-fabric/repository-agents/${encodeURIComponent(scope.repositoryAgentId)}/package-candidates`;
  let accepted: RepositoryCandidateReceipt;
  if (pending.candidateId) {
    const query = new URLSearchParams({ workspaceId: scope.workspaceId, operationId });
    accepted = receipt(await input.transport.signedGet(`${route}/${encodeURIComponent(pending.candidateId)}?${query}`),
      scope, operationId, snapshot.manifest.snapshotHash, restoration?.priorReleaseId);
  } else {
    accepted = receipt(await input.transport.signedPost(route, {
      schema: 'dharma.repository-candidate-upload/v1', operationId, workspaceId: scope.workspaceId,
      repositoryBindingId: scope.repositoryBindingId, repositoryAgentId: scope.repositoryAgentId,
      sourceSnapshotHash: snapshot.manifest.snapshotHash, sourceManifestHash: pending.sourceManifestHash,
      consolidation: pending.consolidation, snapshot,
      ...(restoration?.attemptId ? { restorationAttempt: restoration.attemptId } : {}),
      ...(restorationContext(restoration) ? { restorationContext: restorationContext(restoration) } : {}),
    }), scope, operationId, snapshot.manifest.snapshotHash, restoration?.priorReleaseId);
  }
  await writeOutbox(path, { ...pending, candidateId: accepted.candidateId, state: accepted.state, releaseId: accepted.releaseId });
  return accepted;
}

// Only reconcile an already admitted operation. This never uploads or obtains
// new restoration authority, even if the original registry write was lost.
export async function recoverRepositoryRestorationCandidate(input: {
  transport: Pick<RepositoryCandidateTransport, 'signedGet'>;
  outboxRoot: string; scope: RepositoryCandidateScope; planHash: string;
}) {
  const scope = checkedScope(input.scope);
  requireFact(HASH.test(input.planHash), 'Repository restoration plan hash is invalid.');
  const path = outboxPath(input.outboxRoot, scope), pending = await readOutbox(path, scope);
  if (!pending?.restoration || pending.state === 'fenced' || pending.restoration.planHash !== input.planHash) return null;
  requireFact(pending.consolidation.mode === 'repository_update' && Boolean(pending.consolidation.expectedLatestSourceFingerprint)
    && repositoryCandidateOperationId({ scope, snapshotHash: pending.snapshotHash,
      sourceManifestHash: pending.sourceManifestHash, consolidation: pending.consolidation,
      restorationAttempt: pending.restoration.attemptId, restorationContext: restorationContext(pending.restoration) }) === pending.operationId,
  'Repository restoration checkpoint operation is invalid.');
  const query = new URLSearchParams({ workspaceId: scope.workspaceId, operationId: pending.operationId });
  const suffix = pending.candidateId ? `/${encodeURIComponent(pending.candidateId)}` : '';
  const response = await input.transport.signedGet(
    `/agent-fabric/repository-agents/${encodeURIComponent(scope.repositoryAgentId)}/package-candidates${suffix}?${query}`);
  if (!pending.candidateId && response.ok === true && response.organizationId === scope.organizationId && response.candidate === null) {
    throw new Error('repository_source_restoration_upload_unresolved');
  }
  const candidate = receipt(response, scope, pending.operationId, pending.snapshotHash, pending.restoration.priorReleaseId);
  requireFact(!pending.candidateId || candidate.candidateId === pending.candidateId, 'Repository restoration checkpoint candidate changed.');
  return { candidate, sourceManifestHash: pending.sourceManifestHash, ...pending.restoration };
}

// Called only after the command's final authority, CAS and stopped-runtime
// checks. Keep restoration provenance if the following registry write fails.
export async function checkpointRepositoryRestorationCandidate(input: {
  outboxRoot: string; scope: RepositoryCandidateScope;
  recovered: NonNullable<Awaited<ReturnType<typeof recoverRepositoryRestorationCandidate>>>;
}): Promise<RepositoryCandidateReceipt> {
  const scope = checkedScope(input.scope), recovered = input.recovered;
  const path = outboxPath(input.outboxRoot, scope), pending = await readOutbox(path, scope);
  const expected = restorationCheckpoint({ planHash: recovered.planHash, localSnapshotHash: recovered.localSnapshotHash,
    baselineSnapshotHash: recovered.baselineSnapshotHash, previousOperationId: recovered.previousOperationId,
    priorReleaseId: recovered.priorReleaseId, ...(recovered.attemptId ? { attemptId: recovered.attemptId } : {}),
    ...(recovered.headCandidateId ? { headCandidateId: recovered.headCandidateId } : {}) });
  requireFact(pending?.restoration && pending.state !== 'fenced' && canonicalize(pending.restoration) === canonicalize(expected)
    && pending.sourceManifestHash === recovered.sourceManifestHash
    && pending.consolidation.mode === 'repository_update' && Boolean(pending.consolidation.expectedLatestSourceFingerprint)
    && repositoryCandidateOperationId({ scope, snapshotHash: pending.snapshotHash,
      sourceManifestHash: pending.sourceManifestHash, consolidation: pending.consolidation,
      restorationAttempt: pending.restoration.attemptId, restorationContext: restorationContext(pending.restoration) }) === pending.operationId,
  'Repository restoration checkpoint changed.');
  const candidate = receipt({ ok: true, organizationId: scope.organizationId, candidate: recovered.candidate },
    scope, pending.operationId, pending.snapshotHash, pending.restoration.priorReleaseId);
  requireFact(!pending.candidateId || pending.candidateId === candidate.candidateId,
    'Repository restoration checkpoint candidate changed.');
  requireFact(!['published', 'blocked'].includes(pending.state)
    || pending.state === candidate.state && pending.releaseId === candidate.releaseId,
  'Repository restoration checkpoint terminal state changed.');
  await writeOutbox(path, { ...pending, ...candidate });
  return candidate;
}

export async function readRepositoryRestorationAttempt(input: { outboxRoot: string; scope: RepositoryCandidateScope }) {
  const scope = checkedScope(input.scope), pending = await readOutbox(outboxPath(input.outboxRoot, scope), scope);
  return pending?.state === 'fenced' ? pending.fence!.fenceId
    : pending?.state === 'pending_upload' ? pending.restoration?.attemptId : undefined;
}

// Explicit recovery only: this can fence an unadmitted operation but never
// cancels admitted work, uploads source, or retires a local checkpoint.
export async function fenceRepositoryRestorationUpload(input: {
  transport: RepositoryCandidateTransport; outboxRoot: string; scope: RepositoryCandidateScope;
  planHash: string; policyGenerationId: string; expectedPreviousOperationId: string | null;
}) {
  const scope = checkedScope(input.scope);
  requireFact(HASH.test(input.planHash) && UUID.test(input.policyGenerationId), 'Repository restoration fence authority is invalid.');
  const pending = await readOutbox(outboxPath(input.outboxRoot, scope), scope);
  requireFact(pending?.restoration && pending.restoration.planHash === input.planHash
    && pending.restoration.previousOperationId === input.expectedPreviousOperationId
    && ['pending_upload', 'fenced'].includes(pending.state) && pending.candidateId === null
    && pending.consolidation.mode === 'repository_update' && Boolean(pending.consolidation.expectedLatestSourceFingerprint)
    && repositoryCandidateOperationId({ scope, snapshotHash: pending.snapshotHash, sourceManifestHash: pending.sourceManifestHash,
      consolidation: pending.consolidation, restorationAttempt: pending.restoration.attemptId,
      restorationContext: restorationContext(pending.restoration) }) === pending.operationId,
  'Repository restoration fence checkpoint is invalid.');
  const body = {
      schema: 'dharma.repository-candidate-fence/v1', operationId: pending.operationId,
      workspaceId: scope.workspaceId, repositoryBindingId: scope.repositoryBindingId, repositoryAgentId: scope.repositoryAgentId,
      sourceSnapshotHash: pending.snapshotHash, sourceManifestHash: pending.sourceManifestHash, consolidation: pending.consolidation,
      ...(pending.restoration.attemptId ? { restorationAttempt: pending.restoration.attemptId } : {}),
      ...(restorationContext(pending.restoration) ? { restorationContext: restorationContext(pending.restoration) } : {}),
    };
  const schemaDirectory = fileURLToPath(new URL('./schemas/', import.meta.url));
  requireFact((await validateContract(schemaDirectory, 'https://schemas.dharma-ai.io/repository-candidate-fence/v1', body)).ok
    && Buffer.byteLength(canonicalize(body)) <= 4096, 'Repository restoration fence metadata is invalid.');
  const response = await input.transport.signedPost(
    `/agent-fabric/repository-agents/${encodeURIComponent(scope.repositoryAgentId)}/package-candidates/fence`, body);
  requireFact(response.ok === true && response.organizationId === scope.organizationId
    && Object.hasOwn(response, 'candidate') && Object.hasOwn(response, 'fence')
    && (response.candidate === null) !== (response.fence === null), 'Repository restoration fence response is invalid.');
  const fence = response.fence === null ? null : checkedFence(response.fence, scope, pending.operationId,
    pending.snapshotHash, pending.sourceManifestHash, input.policyGenerationId);
  requireFact(!fence || (await validateContract(schemaDirectory,
    'https://schemas.dharma-ai.io/repository-candidate-fence/v1#/$defs/fence', fence)).ok,
  'Repository restoration fence receipt schema is invalid.');
  const candidate = fence ? null : receipt(response, scope, pending.operationId, pending.snapshotHash, pending.restoration.priorReleaseId);
  requireFact(pending.state !== 'fenced' || fence && canonicalize(fence) === canonicalize(pending.fence),
    'Repository restoration terminal fence changed.');
  return { checkpointHash: sha256(canonicalize(pending)), pending, fence, candidate };
}

async function archiveFencedCheckpoint(root: string, pending: CandidateOutbox) {
  requireFact(pending.state === 'fenced' && pending.fence && pending.restoration, 'Repository restoration terminal fence is required.');
  const { fence, ...checkpoint } = pending;
  const value = { checkpoint: { ...checkpoint, state: 'pending_upload' }, fence };
  const bytes = `${canonicalize(value)}\n`, directory = resolve(root, 'fenced');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const directoryStat = await lstat(directory);
  requireFact(directoryStat.isDirectory() && !directoryStat.isSymbolicLink(), 'Repository restoration archive directory is invalid.');
  const path = resolve(directory, `${pending.scope.workspaceId}.${fence.fenceId}.json`);
  const temporary = resolve(directory, `.${pending.scope.workspaceId}.${fence.fenceId}.${randomUUID()}.tmp`);
  const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW || 0), 0o600);
  try {
    try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
    // Publishing a fully flushed inode with a link cannot replace an existing archive.
    try { await link(temporary, path); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const before = await lstat(path);
      requireFact(before.isFile() && !before.isSymbolicLink() && before.size <= 65_536, 'Repository restoration archive is invalid.');
      const existing = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
      try {
        const after = await existing.stat();
        requireFact(after.isFile() && before.ino === after.ino && before.dev === after.dev && after.size <= 65_536
          && await existing.readFile('utf8') === bytes, 'Repository restoration archive changed.');
      } finally { await existing.close(); }
    }
    if (process.platform !== 'win32') {
      const parent = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | (constants.O_NOFOLLOW || 0));
      try { await parent.sync(); } finally { await parent.close(); }
    }
  } finally { await rm(temporary, { force: true }); }
}

// The command invokes this only after the registry CAS, current authority and
// stopped-runtime guards. Persist the terminal archive before replacement.
export async function checkpointRepositoryRestorationFence(input: {
  outboxRoot: string; scope: RepositoryCandidateScope;
  fenced: Awaited<ReturnType<typeof fenceRepositoryRestorationUpload>>;
}) {
  const scope = checkedScope(input.scope), path = outboxPath(input.outboxRoot, scope), pending = await readOutbox(path, scope);
  requireFact(pending && sha256(canonicalize(pending)) === input.fenced.checkpointHash
    && input.fenced.fence && input.fenced.candidate === null, 'Repository restoration fence checkpoint changed.');
  const fence = checkedFence(input.fenced.fence, scope, pending.operationId, pending.snapshotHash, pending.sourceManifestHash);
  const next: CandidateOutbox = { ...pending, state: 'fenced', fence };
  await archiveFencedCheckpoint(input.outboxRoot, next);
  if (canonicalize(next) !== canonicalize(pending)) await writeOutbox(path, next);
  return fence;
}

export async function pollRepositoryCandidate(input: {
  transport: Pick<RepositoryCandidateTransport, 'signedGet'>;
  outboxRoot: string;
  scope: RepositoryCandidateScope;
}): Promise<RepositoryCandidateReceipt | null> {
  const scope = checkedScope(input.scope);
  const path = outboxPath(input.outboxRoot, scope);
  const pending = await readOutbox(path, scope);
  if (!pending || pending.state === 'pending_upload' || pending.state === 'fenced') return null;
  if (pending.state === 'published' || pending.state === 'blocked') {
    requireFact(pending.state !== 'published' || pending.releaseId !== pending.restoration?.priorReleaseId,
      'Repository restoration cannot reuse the archived release identity.');
    return { candidateId: pending.candidateId!, operationId: pending.operationId, snapshotHash: pending.snapshotHash,
      state: pending.state, releaseId: pending.releaseId };
  }
  const route = `/agent-fabric/repository-agents/${encodeURIComponent(scope.repositoryAgentId)}/package-candidates`;
  const query = new URLSearchParams({ workspaceId: scope.workspaceId, operationId: pending.operationId });
  const current = receipt(await input.transport.signedGet(
    `${route}/${encodeURIComponent(pending.candidateId!)}?${query}`,
  ), scope, pending.operationId, pending.snapshotHash, pending.restoration?.priorReleaseId);
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
  const prior = await readOutbox(outboxPath(input.outboxRoot, scope), scope);
  if (prior?.state === 'fenced') {
    requireFact(prior.operationId !== candidate.operationId, 'A fenced operation cannot be adopted.');
    await archiveFencedCheckpoint(input.outboxRoot, prior);
  } else requireFact(!prior?.restoration || ['published', 'blocked'].includes(prior.state),
    'An unresolved restoration checkpoint cannot be replaced by adoption.');
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
