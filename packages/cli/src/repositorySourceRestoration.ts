import { createHash, type KeyObject } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { canonicalize, validateContract, verifyCanonicalObject } from '@dharma-ai-labs/agent-fabric-contracts';
import { validateRepositoryKnowledgeRetention } from './repositoryKnowledge.js';
import { inventoryRepositoryPackage, type RepositoryPackageSnapshot } from './repositoryPackage.js';
import { fetchPublishedRepositorySource } from './repositorySourceInventoryClient.js';
import { reconcileRepositorySourceSnapshot, RepositorySourceConflictError, type RepositorySourceResolution } from './repositorySourceReconciliation.js';
import { fetchRepositorySourceAuthorization, type BoundRepositorySource } from './repositorySourceSync.js';
import type { RepositorySourceAuthorization } from './repositorySourceAuthorization.js';
import { repositoryCandidateOperationId } from './repositoryCandidateSync.js';

type Transport = { signedGet(route: string): Promise<Record<string, unknown>> };
const HASH = /^sha256:[a-f0-9]{64}$(?![\s\S])/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$(?![\s\S])/i;
const digest = (value: string | Buffer) => `sha256:${createHash('sha256').update(value).digest('hex')}`;
const fail = (): never => { throw new Error('repository_source_restoration_reference_invalid'); };
const row = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value)
  ? value as Record<string, unknown> : fail();

// A prior signed catalog is only a candidate input, never current activation.
export async function fetchRepositorySourceRestoration(input: {
  transport: Transport; scope: BoundRepositorySource; authorization: RepositorySourceAuthorization;
  serverPublicKey: KeyObject; now?: () => Date;
  operationId?: string;
}) {
  const { scope, authorization } = input;
  const route = `/agent-fabric/repository-agents/${encodeURIComponent(scope.repositoryAgentId)}/source-inventory`;
  if (input.operationId !== undefined && !HASH.test(input.operationId)) fail();
  const query = new URLSearchParams({ workspaceId: scope.workspaceId, restoration: 'true' });
  if (input.operationId) query.set('restorationOperationId', input.operationId);
  const response = row(await input.transport.signedGet(`${route}?${query}`));
  if (response.ok !== true || response.organizationId !== scope.organizationId
    || response.repositoryBindingId !== scope.repositoryBindingId || response.repositoryAgentId !== scope.repositoryAgentId
    || response.policyGenerationId !== authorization.generationId) fail();
  if (response.restoration === null) throw new Error('repository_source_restoration_not_required');
  const reference = row(response.restoration), source = row(response.source);
  if (!(await validateContract(fileURLToPath(new URL('./schemas/', import.meta.url)),
    'https://schemas.dharma-ai.io/repository-knowledge-restoration/v1', reference)).ok
    || !HASH.test(String(source.sourceFingerprint)) || !HASH.test(String(source.sourceSnapshotHash))
    || !UUID.test(String(source.candidateId))) fail();
  if (input.operationId && response.restorationOperationId !== input.operationId) fail();
  const envelope = row(reference.envelope);
  if (!(await validateContract(fileURLToPath(new URL('./schemas/', import.meta.url)),
    'https://schemas.dharma-ai.io/repository-package-envelope/v1', envelope)).ok) fail();
  const { signature, ...unsigned } = envelope;
  if (typeof signature !== 'string' || !verifyCanonicalObject(unsigned, signature, input.serverPublicKey)) fail();
  const descriptor = row(envelope.descriptor);
  const assertCurrent = () => {
    const now = (input.now ?? (() => new Date()))().getTime();
    if (!Number.isFinite(now) || Date.parse(String(descriptor.createdAt)) > now
      || Date.parse(String(descriptor.expiresAt)) <= now) fail();
  };
  assertCurrent();
  if (descriptor.organizationId !== scope.organizationId || descriptor.repositoryBindingId !== scope.repositoryBindingId
    || descriptor.repositoryAgentId !== scope.repositoryAgentId || descriptor.policyHash !== authorization.policyHash) fail();
  const decode = (value: unknown, expectedHash: unknown) => {
    if (typeof value !== 'string' || value.length < 1 || value.length > 349528) return fail();
    const bytes = Buffer.from(value, 'base64');
    if (bytes.length > 262144 || bytes.toString('base64') !== value || digest(bytes) !== expectedHash) fail();
    return bytes;
  };
  const catalogBytes = decode(reference.catalogBase64, descriptor.catalogHash);
  const manifestBytes = decode(reference.manifestBase64, descriptor.manifestHash);
  const retained = validateRepositoryKnowledgeRetention({ identity: scope, catalogBytes, manifestBytes });
  const manifest = row(JSON.parse(manifestBytes.toString('utf8')));
  if (retained.reference.generation !== descriptor.generation || retained.catalog.policyHash !== descriptor.policyHash
    || retained.catalog.sourceSnapshotHash !== descriptor.sourceSnapshotHash
    || retained.catalog.sourceLocalCatalogHash !== descriptor.sourceLocalCatalogHash
    || manifest.sourceManifestHash !== descriptor.sourceManifestHash) fail();
  assertCurrent();
  return { catalogBytes, manifestBytes, sourceFingerprint: String(source.sourceFingerprint),
    headCandidateId: String(source.candidateId), headSnapshotHash: String(source.sourceSnapshotHash),
    releaseId: String(descriptor.releaseId), generation: retained.reference.generation, assertCurrent };
}

export async function collectRepositorySourceRestoration(input: BoundRepositorySource & {
  workspace: string; transport: Transport; serverPublicKey: KeyObject;
  loadPublishedLocalBaseline: () => Promise<RepositoryPackageSnapshot | null>;
  loadResolution: () => Promise<RepositorySourceResolution | null>;
  restorationAttempt?: string;
}) {
  const authorization = await fetchRepositorySourceAuthorization(input.transport, input);
  if (!authorization.policy.automaticValidatedPublication) throw new Error('repository_source_restoration_publication_denied');
  const retained = await fetchRepositorySourceRestoration({ ...input, scope: input, authorization });
  const local = await inventoryRepositoryPackage({ ...input, retainedKnowledge: retained, sourceAuthorization: authorization });
  const published = await fetchPublishedRepositorySource({ ...input, scope: input, authorization, local, restoration: true });
  if (!published || published.sourceFingerprint !== retained.sourceFingerprint) throw new Error('repository_source_restoration_head_changed');
  const previousLocal = await input.loadPublishedLocalBaseline();
  let resolution: RepositorySourceResolution | null = null;
  let snapshot: RepositoryPackageSnapshot;
  try { snapshot = reconcileRepositorySourceSnapshot({ local, previousLocal, published }); }
  catch (error) {
    if (!(error instanceof RepositorySourceConflictError)) throw error;
    resolution = await input.loadResolution();
    if (!resolution) throw error;
    snapshot = reconcileRepositorySourceSnapshot({ local, previousLocal, published, resolution });
  }
  const operationId = repositoryCandidateOperationId({ scope: input, snapshotHash: snapshot.manifest.snapshotHash,
    sourceManifestHash: digest(canonicalize(snapshot.manifest)), consolidation: { mode: 'repository_update',
      includeApprovedOutputs: true, requireAtlasAssociation: true, expectedLatestSourceFingerprint: retained.sourceFingerprint },
    restorationAttempt: input.restorationAttempt,
    restorationContext: { headCandidateId: retained.headCandidateId, priorReleaseId: retained.releaseId } });
  const assertLocalCurrent = async () => {
    retained.assertCurrent();
    const currentLocal = await inventoryRepositoryPackage({ ...input, retainedKnowledge: retained, sourceAuthorization: authorization });
    if (currentLocal.manifest.sourceFingerprint !== local.manifest.sourceFingerprint) throw new Error('repository_source_restoration_workspace_changed');
    if (resolution) {
      const active = await input.loadResolution();
      if (!active || canonicalize(active) !== canonicalize(resolution)) throw new Error('repository_source_resolution_withdrawn');
      reconcileRepositorySourceSnapshot({ local: currentLocal, previousLocal, published, resolution: active });
    }
    retained.assertCurrent();
  };
  const assertCurrent = async () => {
    retained.assertCurrent();
    const current = await fetchRepositorySourceAuthorization(input.transport, input);
    if (canonicalize(current) !== canonicalize(authorization)) throw new Error('repository_source_restoration_policy_changed');
    const next = await fetchRepositorySourceRestoration({ ...input, scope: input, authorization: current, operationId });
    if (next.sourceFingerprint !== retained.sourceFingerprint || next.releaseId !== retained.releaseId
      || next.headCandidateId !== retained.headCandidateId || next.headSnapshotHash !== retained.headSnapshotHash
      || !next.catalogBytes.equals(retained.catalogBytes) || !next.manifestBytes.equals(retained.manifestBytes)) {
      throw new Error('repository_source_restoration_head_changed');
    }
    await assertLocalCurrent();
  };
  await assertCurrent();
  return { local, snapshot, expectedLatestSourceFingerprint: retained.sourceFingerprint,
    headCandidateId: retained.headCandidateId, headSnapshotHash: retained.headSnapshotHash, operationId,
    priorReleaseId: retained.releaseId, priorGeneration: retained.generation, assertCurrent, assertLocalCurrent };
}
