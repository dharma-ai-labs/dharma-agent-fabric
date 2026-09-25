import { createHash, randomUUID } from 'node:crypto';
import { constants, readFileSync } from 'node:fs';
import { link, lstat, mkdir, open, readdir, realpath, unlink } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Ajv2020, type ValidateFunction } from 'ajv/dist/2020.js';
import type { FormatsPlugin } from 'ajv-formats';

const addFormats = createRequire(import.meta.url)('ajv-formats').default as FormatsPlugin;

const SKILL_ROOT = '.agents/skills/dharma-agent-fabric';
const KNOWLEDGE_ROOT = `${SKILL_ROOT}/knowledge`;
export const REPOSITORY_KNOWLEDGE_CATALOG_PATH = `${KNOWLEDGE_ROOT}/CATALOG.json`;
export const REPOSITORY_KNOWLEDGE_INIT_PATH = `${SKILL_ROOT}/.repository-knowledge-init.json`;
export const REPOSITORY_KNOWLEDGE_RELEASE_MANIFEST_PATH = `${SKILL_ROOT}/MANIFEST.json`;
const MAXIMUM_BYTES = 1_048_576;
const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,159}$/;
const ORGANIZATION_ID = /^org_[A-Za-z0-9_]{1,156}$/;
const HASH = /^sha256:[0-9a-f]{64}$/;
const CONCEPT_ID = /^concept_[a-z0-9][a-z0-9_-]{0,79}$/;
const CONCEPT_PATH = /^concepts\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+\.(?:json|md)$/;
const UNSAFE_COMPONENT = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)|(?:^|[._-])(?:secrets?|credentials?|passwords?|private[-_]?keys?|tokens?|keystore)(?:[._-]|$)/i;

export interface RepositoryKnowledgeIdentity {
  organizationId: string;
  repositoryAgentId: string;
}
export interface RepositoryKnowledgeCatalog extends RepositoryKnowledgeIdentity {
  schema: 'dharma.repository-knowledge/v1';
  managedBy: 'dharma-agent-fabric';
  knowledgeBaseId: string;
  initializedAt: string;
  provenance: { origin: 'locally_initialized'; authority: 'unsigned'; serverReleaseId: null };
  repoAtlas: RepositoryKnowledgeIdentity & { association: 'local_scope_only'; findingsState: 'not_observed' };
  concepts: Array<{ conceptId: string; relativePath: string; sha256: string }>;
  catalogHash: string;
}
export interface RepositoryKnowledgeInput extends RepositoryKnowledgeIdentity {
  workspace: string;
}
export interface RepositoryKnowledgeRetentionReference extends RepositoryKnowledgeIdentity {
  schema: 'dharma.repository-knowledge-retention/v1';
  authority: 'unverified_prior_release_reference';
  repositoryBindingId: string;
  generation: number;
  catalogPath: typeof REPOSITORY_KNOWLEDGE_CATALOG_PATH;
  manifestPath: typeof REPOSITORY_KNOWLEDGE_RELEASE_MANIFEST_PATH;
  catalogHash: string;
  manifestHash: string;
  catalogSizeBytes: number;
  manifestSizeBytes: number;
}
export interface RepositoryDeliveredKnowledgeCatalog extends RepositoryKnowledgeIdentity {
  schema: 'dharma.repository-knowledge/v2';
  managedBy: 'dharma-agent-fabric';
  knowledgeBaseId: string;
  generation: number;
  authority: 'requires_verified_release';
  policyHash: string;
  sourceSnapshotHash: string;
  sourceLocalCatalogHash: string;
  projectionHash: string;
  repoAtlas: RepositoryKnowledgeIdentity & { associationId: string; knowledgeBaseId: string;
    basis: 'repository_initialization' | 'semantic_analysis'; sourceWindowIds: string[]; analysisHash: string | null };
  concepts: Array<{ conceptId: string; canonicalName: string; aliases: string[]; definition: string;
    sources: Array<{ sourceId: string; sourceHash: string; firstLine: number; lastLine: number; quote: string }> }>;
  unresolved: Array<{ proposalHash: string; reason: string; conceptId: string }>;
}
export type RepositoryKnowledgeSource =
  | { kind: 'local_v1_unsigned'; catalog: RepositoryKnowledgeCatalog; catalogBytes: Buffer }
  | { kind: 'delivered_v2_requires_verified_release'; catalog: RepositoryDeliveredKnowledgeCatalog; catalogBytes: Buffer;
    manifestBytes: Buffer; reference: RepositoryKnowledgeRetentionReference };
export interface RepositoryKnowledgeSourceInput extends RepositoryKnowledgeInput {
  repositoryBindingId?: string | null;
  workspaceId?: string | null;
}
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$(?![\s\S])/;
const RETENTION_MAXIMUM_BYTES = 262144;
let retentionValidators: { catalog: ValidateFunction; manifest: ValidateFunction; reference: ValidateFunction } | undefined;
function knowledgeRetentionValidators() {
  if (!retentionValidators) {
    const ajv = new Ajv2020({ allErrors: true, strict: true, strictRequired: false });
    addFormats(ajv);
    for (const name of ['repository-knowledge-v2', 'repository-release-manifest', 'repository-knowledge-retention-v1']) {
      ajv.addSchema(JSON.parse(readFileSync(fileURLToPath(new URL(`./schemas/${name}.schema.json`, import.meta.url)), 'utf8')));
    }
    retentionValidators = { catalog: ajv.getSchema('https://schemas.dharma-ai.io/repository-knowledge/v2')!,
      manifest: ajv.getSchema('https://schemas.dharma-ai.io/repository-release-manifest/v1')!,
      reference: ajv.getSchema('https://schemas.dharma-ai.io/repository-knowledge-retention/v1')! };
  }
  return retentionValidators;
}
function retentionDocument(bytes: Buffer) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 1 || bytes.length > RETENTION_MAXIMUM_BYTES) throw new Error('Repository knowledge retention byte limit.');
  const text = bytes.toString('utf8');
  if (!Buffer.from(text).equals(bytes)) throw new Error('Invalid repository knowledge retention encoding.');
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new Error('Invalid repository knowledge retention JSON.'); }
  if (`${canonical(value)}\n` !== text) throw new Error('Repository knowledge retention requires canonical release bytes.');
  return value;
}
function byteHash(bytes: Buffer) { return `sha256:${createHash('sha256').update(bytes).digest('hex')}`; }

// This validates a retention claim, never its signature, current authority or scientific truth.
export function validateRepositoryKnowledgeRetention(input: {
  identity: RepositoryKnowledgeIdentity & { repositoryBindingId: string };
  catalogBytes: Buffer;
  manifestBytes: Buffer;
  reference?: unknown;
}) {
  validateIdentity(input.identity);
  if (!UUID.test(input.identity.repositoryBindingId) || !UUID.test(input.identity.repositoryAgentId)) throw new Error('Repository knowledge retention requires bound repository identity.');
  const catalogValue = retentionDocument(input.catalogBytes), manifestValue = retentionDocument(input.manifestBytes);
  const validators = knowledgeRetentionValidators();
  if (!validators.catalog(catalogValue) || !validators.manifest(manifestValue)) throw new Error('Repository knowledge retention release schema is invalid.');
  const catalog = catalogValue as RepositoryDeliveredKnowledgeCatalog;
  const manifest = manifestValue as { organizationId: string; repositoryAgentId: string; generation: number;
    knowledgeBaseId: string; atlasAssociationId: string; sourceSnapshotHash: string; policyHash: string;
    files: Array<{ path: string; sha256: string; sizeBytes: number; role: string }> };
  const atlas = catalog.repoAtlas;
  if (catalog.organizationId !== input.identity.organizationId || catalog.repositoryAgentId !== input.identity.repositoryAgentId
    || catalog.knowledgeBaseId !== knowledgeBaseId(input.identity) || manifest.organizationId !== catalog.organizationId
    || manifest.repositoryAgentId !== catalog.repositoryAgentId || manifest.generation !== catalog.generation
    || manifest.knowledgeBaseId !== catalog.knowledgeBaseId || manifest.atlasAssociationId !== atlas.associationId
    || manifest.sourceSnapshotHash !== catalog.sourceSnapshotHash || manifest.policyHash !== catalog.policyHash
    || atlas.organizationId !== catalog.organizationId || atlas.repositoryAgentId !== catalog.repositoryAgentId
    || atlas.knowledgeBaseId !== catalog.knowledgeBaseId) throw new Error('Repository knowledge retention release scope conflict.');
  const catalogs = manifest.files.filter(file => file.path === REPOSITORY_KNOWLEDGE_CATALOG_PATH);
  if (catalogs.length !== 1 || catalogs[0]!.role !== 'knowledge' || catalogs[0]!.sha256 !== byteHash(input.catalogBytes)
    || catalogs[0]!.sizeBytes !== input.catalogBytes.length
    || new Set(manifest.files.map(file => file.path.toLowerCase())).size !== manifest.files.length) {
    throw new Error('Repository knowledge retention release inventory conflict.');
  }
  const reference: RepositoryKnowledgeRetentionReference = { schema: 'dharma.repository-knowledge-retention/v1',
    authority: 'unverified_prior_release_reference', organizationId: catalog.organizationId,
    repositoryBindingId: input.identity.repositoryBindingId, repositoryAgentId: catalog.repositoryAgentId, generation: catalog.generation,
    catalogPath: REPOSITORY_KNOWLEDGE_CATALOG_PATH, manifestPath: REPOSITORY_KNOWLEDGE_RELEASE_MANIFEST_PATH,
    catalogHash: byteHash(input.catalogBytes), manifestHash: byteHash(input.manifestBytes),
    catalogSizeBytes: input.catalogBytes.length, manifestSizeBytes: input.manifestBytes.length };
  if (input.reference !== undefined && (!validators.reference(input.reference) || canonical(input.reference) !== canonical(reference))) {
    throw new Error('Repository knowledge retention reference integrity failed.');
  }
  return { catalog, reference };
}

export async function readRepositoryKnowledgeSource(input: RepositoryKnowledgeSourceInput): Promise<RepositoryKnowledgeSource | null> {
  const workspace = await workspaceRoot(input);
  const catalogBytes = await readOptional(workspace, REPOSITORY_KNOWLEDGE_CATALOG_PATH, RETENTION_MAXIMUM_BYTES);
  let candidate: unknown;
  try { candidate = catalogBytes ? JSON.parse(catalogBytes.toString('utf8')) : null; }
  catch { throw new Error('Invalid repository knowledge JSON.'); }
  if ((candidate as { schema?: unknown } | null)?.schema !== 'dharma.repository-knowledge/v2') {
    const catalog = await readRepositoryKnowledge(input);
    if (!catalog) return null;
    const bytes = await readOptional(workspace, REPOSITORY_KNOWLEDGE_CATALOG_PATH);
    if (!bytes || canonical(parseCatalog(bytes, input)) !== canonical(catalog)) throw new Error('Repository knowledge changed during collection.');
    return { kind: 'local_v1_unsigned', catalog, catalogBytes: bytes };
  }
  if (typeof input.repositoryBindingId !== 'string' || !UUID.test(input.repositoryBindingId)
    || typeof input.workspaceId !== 'string' || !UUID.test(input.workspaceId)) throw new Error('Repository knowledge retention requires complete bound identity.');
  const markerBytes = await readOptional(workspace, `${SKILL_ROOT}/.dharma-agent-fabric.json`, 4096);
  let marker: { managedBy?: unknown; bundleId?: unknown; skillId?: unknown; workspaceId?: unknown } | null;
  try { marker = JSON.parse(markerBytes?.toString('utf8') ?? 'null'); } catch { throw new Error('Invalid managed repository knowledge marker.'); }
  const markerWorkspaceIds = new Set([input.workspaceId]);
  if (input.repositoryBindingId === input.repositoryAgentId) markerWorkspaceIds.add(input.repositoryBindingId);
  if (!marker || !(marker.managedBy === 'dharma-agent-fabric'
    && (marker.workspaceId === undefined || markerWorkspaceIds.has(marker.workspaceId as string)) || (typeof marker.bundleId === 'string'
    && UUID.test(marker.bundleId) && typeof marker.skillId === 'string' && ID.test(marker.skillId)
    && markerWorkspaceIds.has(marker.workspaceId as string)))) {
    throw new Error('Unmanaged repository knowledge retention root.');
  }
  const manifestBytes = await readOptional(workspace, REPOSITORY_KNOWLEDGE_RELEASE_MANIFEST_PATH, RETENTION_MAXIMUM_BYTES);
  if (!manifestBytes || !catalogBytes) throw new Error('Repository knowledge retention release manifest missing.');
  const result = validateRepositoryKnowledgeRetention({ identity: { ...input, repositoryBindingId: input.repositoryBindingId }, catalogBytes, manifestBytes });
  const intent = await readOptional(workspace, REPOSITORY_KNOWLEDGE_INIT_PATH);
  if (intent) parseCatalog(intent, input);
  if (!(await readOptional(workspace, REPOSITORY_KNOWLEDGE_CATALOG_PATH, RETENTION_MAXIMUM_BYTES))?.equals(catalogBytes)
    || !(await readOptional(workspace, REPOSITORY_KNOWLEDGE_RELEASE_MANIFEST_PATH, RETENTION_MAXIMUM_BYTES))?.equals(manifestBytes)) {
    throw new Error('Repository knowledge retention changed during collection.');
  }
  return { kind: 'delivered_v2_requires_verified_release', catalog: result.catalog, catalogBytes, manifestBytes, reference: result.reference };
}
export interface RepositoryKnowledgeInitializationInput extends RepositoryKnowledgeInput {
  now?: Date;
  dryRun?: boolean;
}
export interface RepositoryKnowledgeInitializationResult {
  catalog: RepositoryKnowledgeCatalog;
  relativePath: typeof REPOSITORY_KNOWLEDGE_CATALOG_PATH;
  disposition: 'initialized' | 'reused' | 'planned';
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
  return JSON.stringify(value);
}
function hash(value: unknown) { return `sha256:${createHash('sha256').update(canonical(value)).digest('hex')}`; }
function validateIdentity(identity: RepositoryKnowledgeIdentity) {
  if (typeof identity.organizationId !== 'string' || typeof identity.repositoryAgentId !== 'string'
    || !ORGANIZATION_ID.test(identity.organizationId) || !ID.test(identity.repositoryAgentId)) {
    throw new Error('Invalid repository knowledge identity.');
  }
}
function knowledgeBaseId(identity: RepositoryKnowledgeIdentity) {
  return `repository-kb:${hash({ schema: 'dharma.repository-knowledge-identity/v1',
    organizationId: identity.organizationId, repositoryAgentId: identity.repositoryAgentId })}`;
}
function record(value: unknown, keys: string[]) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).sort().join(',') !== keys.sort().join(',')) throw new Error('Invalid repository knowledge catalog.');
  return value as Record<string, unknown>;
}

// Hashes detect local corruption; neither the catalog nor its Atlas scope is a signed release.
export function validateRepositoryKnowledgeCatalog(value: unknown, identity: RepositoryKnowledgeIdentity): RepositoryKnowledgeCatalog {
  validateIdentity(identity);
  const row = record(value, ['schema', 'managedBy', 'organizationId', 'repositoryAgentId', 'knowledgeBaseId',
    'initializedAt', 'provenance', 'repoAtlas', 'concepts', 'catalogHash']);
  if (row.schema !== 'dharma.repository-knowledge/v1' || row.managedBy !== 'dharma-agent-fabric') {
    throw new Error('Invalid or unmanaged repository knowledge catalog.');
  }
  if (row.organizationId !== identity.organizationId || row.repositoryAgentId !== identity.repositoryAgentId
    || row.knowledgeBaseId !== knowledgeBaseId(identity)) throw new Error('Repository knowledge identity scope mismatch.');
  if (typeof row.initializedAt !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(row.initializedAt)
    || !Number.isFinite(Date.parse(row.initializedAt)) || new Date(row.initializedAt).toISOString() !== row.initializedAt) {
    throw new Error('Invalid repository knowledge timestamp.');
  }
  const provenance = record(row.provenance, ['origin', 'authority', 'serverReleaseId']);
  if (provenance.origin !== 'locally_initialized' || provenance.authority !== 'unsigned' || provenance.serverReleaseId !== null) {
    throw new Error('Invalid repository knowledge provenance.');
  }
  const atlas = record(row.repoAtlas, ['association', 'findingsState', 'organizationId', 'repositoryAgentId']);
  if (atlas.association !== 'local_scope_only' || atlas.findingsState !== 'not_observed'
    || atlas.organizationId !== identity.organizationId || atlas.repositoryAgentId !== identity.repositoryAgentId) {
    throw new Error('Invalid repository Atlas identity scope.');
  }
  if (!Array.isArray(row.concepts) || row.concepts.length > 256) throw new Error('Invalid repository knowledge concepts.');
  const ids = new Set<string>();
  const paths = new Set<string>();
  for (const value of row.concepts) {
    const concept = record(value, ['conceptId', 'relativePath', 'sha256']);
    if (typeof concept.conceptId !== 'string' || !CONCEPT_ID.test(concept.conceptId)
      || typeof concept.relativePath !== 'string' || concept.relativePath.length > 500 || !CONCEPT_PATH.test(concept.relativePath)
      || concept.relativePath.split('/').some(part => UNSAFE_COMPONENT.test(part))
      || typeof concept.sha256 !== 'string' || !HASH.test(concept.sha256)
      || ids.has(concept.conceptId) || paths.has(concept.relativePath.toLowerCase())) throw new Error('Invalid or unsafe repository knowledge concept.');
    ids.add(concept.conceptId);
    paths.add(concept.relativePath.toLowerCase());
  }
  const { catalogHash, ...content } = row;
  if (typeof catalogHash !== 'string' || !HASH.test(catalogHash) || hash(content) !== catalogHash) {
    throw new Error('Repository knowledge catalog integrity is invalid.');
  }
  return value as RepositoryKnowledgeCatalog;
}

function initialCatalog(input: RepositoryKnowledgeInitializationInput): RepositoryKnowledgeCatalog {
  validateIdentity(input);
  const timestamp = input.now ?? new Date();
  if (!Number.isFinite(timestamp.getTime())) throw new Error('Invalid repository knowledge timestamp.');
  const content = {
    schema: 'dharma.repository-knowledge/v1' as const,
    managedBy: 'dharma-agent-fabric' as const,
    organizationId: input.organizationId,
    repositoryAgentId: input.repositoryAgentId,
    knowledgeBaseId: knowledgeBaseId(input),
    initializedAt: timestamp.toISOString(),
    provenance: { origin: 'locally_initialized' as const, authority: 'unsigned' as const, serverReleaseId: null },
    repoAtlas: { association: 'local_scope_only' as const, findingsState: 'not_observed' as const,
      organizationId: input.organizationId, repositoryAgentId: input.repositoryAgentId },
    concepts: [],
  };
  return validateRepositoryKnowledgeCatalog({ ...content, catalogHash: hash(content) }, input);
}
function missing(error: unknown) { return (error as NodeJS.ErrnoException).code === 'ENOENT'; }

async function workspaceRoot(input: RepositoryKnowledgeInput) {
  validateIdentity(input);
  if (typeof input.workspace !== 'string' || !input.workspace || input.workspace.includes('\0')) throw new Error('Invalid knowledge workspace.');
  const absolute = resolve(input.workspace);
  // OS ancestors can be aliases; the workspace and all managed descendants cannot.
  const metadata = await lstat(absolute);
  if (metadata.isSymbolicLink()) throw new Error('Repository knowledge workspace symlink is forbidden.');
  if (!metadata.isDirectory()) throw new Error('Invalid repository knowledge workspace.');
  return realpath(absolute);
}
async function checkedPath(workspace: string, path: string): Promise<string | null> {
  let current = workspace;
  for (const component of path.split('/')) {
    current = resolve(current, component);
    let metadata;
    try { metadata = await lstat(current); } catch (error) { if (missing(error)) return null; throw error; }
    if (metadata.isSymbolicLink()) throw new Error('Repository knowledge symlink is forbidden.');
    const actual = await realpath(current);
    const route = relative(workspace, actual);
    if (isAbsolute(route) || route === '..' || route.startsWith(`..${sep}`)) throw new Error('Repository knowledge path escape.');
  }
  return current;
}
async function readOptional(workspace: string, path: string, maximumBytes = MAXIMUM_BYTES): Promise<Buffer | null> {
  const target = await checkedPath(workspace, path);
  if (!target) return null;
  if (!(await lstat(target)).isFile()) throw new Error('Invalid repository knowledge regular file.');
  const handle = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0));
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size > maximumBytes) throw new Error('Repository knowledge file limit or type is invalid.');
    const buffer = Buffer.alloc(before.size + 1);
    let count = 0;
    while (count < buffer.length) {
      const result = await handle.read(buffer, count, buffer.length - count, count);
      if (!result.bytesRead) break;
      count += result.bytesRead;
    }
    const after = await handle.stat();
    const checked = await checkedPath(workspace, path);
    if (!checked) throw new Error('Repository knowledge file changed.');
    const current = await lstat(checked);
    if (count !== before.size || before.size !== after.size || before.mtimeMs !== after.mtimeMs
      || current.ino !== before.ino || current.dev !== before.dev
      || current.size !== after.size || current.mtimeMs !== after.mtimeMs) {
      throw new Error('Repository knowledge file changed.');
    }
    return buffer.subarray(0, count);
  } finally { await handle.close(); }
}
function parseCatalog(bytes: Buffer, input: RepositoryKnowledgeIdentity) {
  const text = bytes.toString('utf8');
  if (!Buffer.from(text).equals(bytes)) throw new Error('Invalid repository knowledge encoding.');
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new Error('Invalid repository knowledge JSON.'); }
  return validateRepositoryKnowledgeCatalog(value, input);
}
async function managedWorkspace(input: RepositoryKnowledgeInput) {
  const workspace = await workspaceRoot(input);
  const marker = await readOptional(workspace, `${SKILL_ROOT}/.dharma-agent-fabric.json`, 4096);
  let value: { managedBy?: unknown };
  try { value = JSON.parse(marker?.toString('utf8') ?? 'null'); } catch { throw new Error('Invalid managed repository skill marker.'); }
  if (!value || value.managedBy !== 'dharma-agent-fabric') throw new Error('Unmanaged repository skill root.');
  const directory = await checkedPath(workspace, KNOWLEDGE_ROOT);
  if (directory && !(await lstat(directory)).isDirectory()) throw new Error('Invalid repository knowledge directory.');
  return workspace;
}

export async function readRepositoryKnowledge(input: RepositoryKnowledgeInput): Promise<RepositoryKnowledgeCatalog | null> {
  const workspace = await managedWorkspace(input);
  let intent = await readOptional(workspace, REPOSITORY_KNOWLEDGE_INIT_PATH);
  if (intent) parseCatalog(intent, input);
  const bytes = await readOptional(workspace, REPOSITORY_KNOWLEDGE_CATALOG_PATH);
  if (bytes) return parseCatalog(bytes, input);
  const directory = await checkedPath(workspace, KNOWLEDGE_ROOT);
  if (directory) {
    intent ??= await readOptional(workspace, REPOSITORY_KNOWLEDGE_INIT_PATH);
    if (!intent) throw new Error('Unmanaged repository knowledge directory.');
    parseCatalog(intent, input);
    const replay = await readOptional(workspace, REPOSITORY_KNOWLEDGE_CATALOG_PATH);
    if (replay) return parseCatalog(replay, input);
    if ((await readdir(directory)).some(name => name !== 'CATALOG.json')) {
      throw new Error('Unmanaged files in interrupted repository knowledge initialization.');
    }
  }
  return null;
}
async function syncDirectory(path: string) {
  if (process.platform === 'win32') return;
  const handle = await open(path, constants.O_RDONLY);
  try { await handle.sync(); } finally { await handle.close(); }
}

export async function initializeRepositoryKnowledge(input: RepositoryKnowledgeInitializationInput): Promise<RepositoryKnowledgeInitializationResult> {
  const workspace = await managedWorkspace(input);
  const result = (catalog: RepositoryKnowledgeCatalog, disposition: RepositoryKnowledgeInitializationResult['disposition']): RepositoryKnowledgeInitializationResult =>
    ({ catalog, relativePath: REPOSITORY_KNOWLEDGE_CATALOG_PATH, disposition });
  const existing = await readRepositoryKnowledge(input);
  if (existing) return result(existing, 'reused');

  let intentBytes = await readOptional(workspace, REPOSITORY_KNOWLEDGE_INIT_PATH);
  if (!intentBytes && await checkedPath(workspace, KNOWLEDGE_ROOT)) {
    // Another initializer may have published its intent since the first read.
    intentBytes = await readOptional(workspace, REPOSITORY_KNOWLEDGE_INIT_PATH);
    if (!intentBytes) throw new Error('Unmanaged repository knowledge directory.');
  }
  let catalog = intentBytes ? parseCatalog(intentBytes, input) : initialCatalog(input);
  const directory = await checkedPath(workspace, KNOWLEDGE_ROOT);
  if (directory) {
    const names = await readdir(directory);
    if (names.some(name => name !== 'CATALOG.json')) throw new Error('Unmanaged files in interrupted repository knowledge initialization.');
  }
  if (input.dryRun) return result(catalog, 'planned');

  if (!intentBytes) {
    const staging = `${SKILL_ROOT}/.knowledge-init-${randomUUID()}.tmp`;
    const parent = await checkedPath(workspace, SKILL_ROOT);
    if (!parent) throw new Error('Unmanaged repository skill root.');
    const handle = await open(resolve(workspace, staging), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW || 0), 0o600);
    try {
      await handle.writeFile(`${canonical(catalog)}\n`, 'utf8');
      await handle.sync();
    } finally { await handle.close(); }
    try {
      await checkedPath(workspace, staging);
      await checkedPath(workspace, SKILL_ROOT);
      try { await link(resolve(workspace, staging), resolve(workspace, REPOSITORY_KNOWLEDGE_INIT_PATH)); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
      await syncDirectory(parent);
      intentBytes = await readOptional(workspace, REPOSITORY_KNOWLEDGE_INIT_PATH);
      if (!intentBytes) throw new Error('Repository knowledge initialization record missing.');
      catalog = parseCatalog(intentBytes, input);
    } finally {
      const target = await checkedPath(workspace, staging);
      if (target) await unlink(target);
    }
  }

  await checkedPath(workspace, SKILL_ROOT);
  try { await mkdir(resolve(workspace, KNOWLEDGE_ROOT), { mode: 0o700 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  const targetDirectory = await checkedPath(workspace, KNOWLEDGE_ROOT);
  if (!targetDirectory || !(await lstat(targetDirectory)).isDirectory()) throw new Error('Invalid repository knowledge directory.');
  const existingAfterIntent = await readRepositoryKnowledge(input);
  if (existingAfterIntent) return result(existingAfterIntent, 'reused');
  if ((await readdir(targetDirectory)).length) {
    const replay = await readRepositoryKnowledge(input);
    if (replay) return result(replay, 'reused');
    throw new Error('Unmanaged files in interrupted repository knowledge initialization.');
  }
  const source = await checkedPath(workspace, REPOSITORY_KNOWLEDGE_INIT_PATH);
  if (!source) throw new Error('Repository knowledge initialization record missing.');
  try { await link(source, resolve(workspace, REPOSITORY_KNOWLEDGE_CATALOG_PATH)); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    const replay = await readRepositoryKnowledge(input);
    if (!replay) throw new Error('Repository knowledge catalog missing.');
    return result(replay, 'reused');
  }
  await syncDirectory(targetDirectory);
  await syncDirectory(resolve(workspace, SKILL_ROOT));
  const published = await readRepositoryKnowledge(input);
  if (!published) throw new Error('Repository knowledge catalog missing.');
  return result(published, 'initialized');
}
