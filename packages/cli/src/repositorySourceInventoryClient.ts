import { createHash } from 'node:crypto';
import { canonicalize } from '@dharma-ai-labs/agent-fabric-contracts';
import type { RepositoryPackageFile, RepositoryPackageManifest,
  RepositoryPackageSnapshot } from './repositoryPackage.js';
import { repositorySourcePathAllowed, repositorySourcePathSafe,
  type RepositorySourceAuthorization } from './repositorySourceAuthorization.js';
import type { BoundRepositorySource } from './repositorySourceSync.js';
import type { PublishedRepositorySource } from './repositorySourceReconciliation.js';

type Transport = { signedGet(route: string): Promise<Record<string, unknown>> };
type Skill = RepositoryPackageManifest['skills'][number];
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const HASH = /^sha256:[a-f0-9]{64}$/;
const digest = (value: string | Buffer) => `sha256:${createHash('sha256').update(value).digest('hex')}`;

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Repository source ${label} is invalid.`);
  return value as Record<string, unknown>;
}

function checkedInventory(value: unknown, scope: BoundRepositorySource,
  authorization: RepositorySourceAuthorization) {
  const row = record(value, 'inventory');
  if (!UUID.test(String(row.candidateId)) || !UUID.test(String(row.workspaceId))
    || !HASH.test(String(row.sourceSnapshotHash)) || !HASH.test(String(row.sourceManifestHash))
    || !HASH.test(String(row.sourceFingerprint)) || !Array.isArray(row.files)
    || !Array.isArray(row.skills) || row.files.length > 512 || row.skills.length > 512) {
    throw new Error('Repository source inventory fields are invalid.');
  }
  const files: RepositoryPackageFile[] = [];
  const paths = new Set<string>();
  for (const raw of row.files) {
    const file = record(raw, 'file');
    if (typeof file.path !== 'string' || !repositorySourcePathSafe(file.path)
      || typeof file.sha256 !== 'string' || !HASH.test(file.sha256)
      || !Number.isSafeInteger(file.sizeBytes) || Number(file.sizeBytes) < 0
      || Number(file.sizeBytes) > authorization.policy.maximumFileBytes
      || !['skill', 'dependency', 'approved_output', 'repository_content'].includes(String(file.role))
      || (file.managedPath !== undefined && typeof file.managedPath !== 'string')
      || paths.has(file.path.toLowerCase())) throw new Error('Repository source file metadata is invalid.');
    const contentClass = file.role === 'approved_output' ? 'approved_outputs'
      : file.role === 'repository_content' ? 'repository_content' : 'repository_skills';
    if (!repositorySourcePathAllowed(authorization, file.path, contentClass)
      && !(file.role === 'dependency' && (repositorySourcePathAllowed(authorization, file.path, 'repository_content')
        || repositorySourcePathAllowed(authorization, file.path, 'approved_outputs')))) {
      throw new Error('Repository source file exceeds current policy.');
    }
    paths.add(file.path.toLowerCase());
    files.push(file as unknown as RepositoryPackageFile);
  }
  const skills = row.skills as Skill[];
  if (skills.some(skill => !skill || typeof skill !== 'object' || Array.isArray(skill)
    || typeof skill.path !== 'string' || !repositorySourcePathSafe(skill.path)
    || !Array.isArray(skill.filePaths) || skill.filePaths.length > 512)) {
    throw new Error('Repository source skill metadata is invalid.');
  }
  const fingerprint = digest(canonicalize({ organizationId: scope.organizationId,
    repositoryBindingId: scope.repositoryBindingId, repositoryAgentId: scope.repositoryAgentId,
    generationId: authorization.generationId, policyHash: authorization.policyHash, files, skills }));
  if (fingerprint !== row.sourceFingerprint) throw new Error('Repository source fingerprint integrity failed.');
  return { candidateId: String(row.candidateId), workspaceId: String(row.workspaceId),
    sourceSnapshotHash: String(row.sourceSnapshotHash), sourceFingerprint: fingerprint,
    files, skills };
}

export async function fetchPublishedRepositorySource(input: {
  transport: Transport;
  scope: BoundRepositorySource;
  authorization: RepositorySourceAuthorization;
  local: RepositoryPackageSnapshot;
}): Promise<PublishedRepositorySource | null> {
  const { transport, scope, authorization, local } = input;
  const route = `/agent-fabric/repository-agents/${encodeURIComponent(scope.repositoryAgentId)}/source-inventory`;
  const response = record(await transport.signedGet(`${route}?workspaceId=${encodeURIComponent(scope.workspaceId)}`), 'response');
  if (response.ok !== true || response.organizationId !== scope.organizationId
    || response.repositoryBindingId !== scope.repositoryBindingId
    || response.repositoryAgentId !== scope.repositoryAgentId
    || response.policyGenerationId !== authorization.generationId) {
    throw new Error('Repository source inventory authority does not match this device.');
  }
  if (response.source === null) return null;
  const source = checkedInventory(response.source, scope, authorization);
  if (response.workspaceBaseline !== null && response.workspaceBaseline !== undefined) {
    const baseline = checkedInventory(response.workspaceBaseline, scope, authorization);
    if (baseline.workspaceId !== scope.workspaceId || baseline.candidateId === source.candidateId) {
      throw new Error('Repository source workspace baseline is not bound to this device.');
    }
  }
  const localHashes = new Set(local.blobs.map(blob => blob.sha256));
  const wanted = new Map(source.files.filter(file => !localHashes.has(file.sha256)).map(file => [file.sha256, file]));
  const pending = [...wanted.values()];
  const fetched: PublishedRepositorySource['blobs'] = [];
  for (let offset = 0; offset < pending.length; offset += 8) {
    const batch = await Promise.all(pending.slice(offset, offset + 8).map(async file => {
      const query = new URLSearchParams({ workspaceId: scope.workspaceId, path: file.path });
      const raw = await transport.signedGet(`${route}/${source.candidateId}/blobs/${encodeURIComponent(file.sha256)}?${query}`);
      const body = record(raw, 'blob response');
      if (body.ok !== true || body.organizationId !== scope.organizationId
        || body.repositoryBindingId !== scope.repositoryBindingId
        || body.repositoryAgentId !== scope.repositoryAgentId
        || body.candidateId !== source.candidateId
        || body.sourceSnapshotHash !== source.sourceSnapshotHash
        || body.sourceFingerprint !== source.sourceFingerprint
        || body.path !== file.path || body.sha256 !== file.sha256 || body.role !== file.role
        || body.sizeBytes !== file.sizeBytes || typeof body.contentBase64 !== 'string') {
        throw new Error('Repository source blob response does not match the published inventory.');
      }
      const bytes = Buffer.from(body.contentBase64, 'base64');
      if (bytes.toString('base64') !== body.contentBase64 || bytes.length !== file.sizeBytes
        || digest(bytes) !== file.sha256) throw new Error('Repository source blob integrity failed.');
      return { sha256: file.sha256, contentBase64: body.contentBase64 };
    }));
    fetched.push(...batch);
  }
  return { files: source.files, skills: source.skills, blobs: fetched,
    sourceFingerprint: source.sourceFingerprint };
}
