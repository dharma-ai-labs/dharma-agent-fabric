import { createHash } from 'node:crypto';
import { types } from 'node:util';
import { fileURLToPath } from 'node:url';
import { canonicalize, validateContract } from '@dharma-ai-labs/agent-fabric-contracts';

export type RepositoryReleaseMetadataScope = {
  organizationId: string;
  repositoryBindingId: string;
  repositoryAgentId: string;
  generation: number;
  policyHash: string;
  sourceSnapshotHash: string;
  sourceManifestHash: string;
  sourceLocalCatalogHash: string;
  catalogHash: string;
  manifestHash: string;
};

export type RepositoryReleaseMetadataFile = {
  path: string;
  contentBase64: string;
  sha256: string;
  sizeBytes: number;
};

const ROOT = '.agents/skills/dharma-agent-fabric/';
const CATALOG = `${ROOT}knowledge/CATALOG.json`;
const MANIFEST = `${ROOT}MANIFEST.json`;
const PROMPT = '.dharma/onboarding-prompt.md';
const HASH = /^sha256:[a-f0-9]{64}$(?![\s\S])/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$(?![\s\S])/i;
const digest = (bytes: string | Buffer) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
type Row = Record<string, unknown>;
function requireFact(condition: unknown): asserts condition {
  if (!condition) throw new Error('Repository release metadata does not match the complete scoped contract.');
}

// Snapshot bounded plain data before parsing, hashing or awaiting schema reads.
function snapshot(value: unknown): unknown {
  let nodes = 0;
  let encodedBytes = 0;
  const seen = new Set<object>();
  function charge(bytes: number) {
    requireFact(bytes <= 8388608 - encodedBytes);
    encodedBytes += bytes;
  }
  function stringBytes(value: string) {
    requireFact(value.length <= 349528 && Buffer.byteLength(value) + 2 <= 8388608 - encodedBytes);
    requireFact(Buffer.from(value).toString('utf8') === value);
    return Buffer.byteLength(JSON.stringify(value));
  }
  function visit(item: unknown, depth: number): unknown {
    requireFact(++nodes <= 150000 && depth <= 12);
    if (item === null || typeof item === 'boolean') { charge(item === null || item === true ? 4 : 5); return item; }
    if (typeof item === 'string') {
      charge(stringBytes(item));
      return item;
    }
    if (typeof item === 'number') { requireFact(Number.isSafeInteger(item)); charge(String(item).length); return item; }
    requireFact(typeof item === 'object' && !types.isProxy(item) && !seen.has(item));
    const prototype = Object.getPrototypeOf(item);
    requireFact(Array.isArray(item) ? prototype === Array.prototype : prototype === Object.prototype || prototype === null);
    requireFact(!Object.getOwnPropertyDescriptor(Object.prototype, 'toJSON') && !Object.getOwnPropertyDescriptor(Array.prototype, 'toJSON'));
    if (Array.isArray(item)) requireFact(item.length <= 516);
    const keys = Reflect.ownKeys(item);
    requireFact(keys.length <= (Array.isArray(item) ? 517 : 64) && keys.every(key => typeof key === 'string'));
    const descriptors = Object.getOwnPropertyDescriptors(item);
    requireFact(Object.values(descriptors).every(descriptor => 'value' in descriptor));
    seen.add(item);
    try {
      if (Array.isArray(item)) {
        requireFact(item.length <= 516 && Object.keys(descriptors).length === item.length + 1);
        charge(2 + Math.max(0, item.length - 1));
        return Array.from({ length: item.length }, (_, index) => {
          const descriptor = descriptors[String(index)];
          requireFact(descriptor?.enumerable);
          return visit(descriptor.value, depth + 1);
        });
      }
      const result: Row = Object.create(null);
      charge(2);
      for (const [key, descriptor] of Object.entries(descriptors)) {
        requireFact(descriptor.enumerable && key.length <= 128 && !['__proto__', 'constructor', 'prototype', 'toJSON'].includes(key));
        charge(stringBytes(key) + 2);
        result[key] = visit(descriptor.value, depth + 1);
      }
      return result;
    } finally { seen.delete(item); }
  }
  return visit(value, 0);
}
function row(value: unknown, keys?: string[], optional: string[] = []): Row {
  requireFact(value !== null && typeof value === 'object' && !Array.isArray(value));
  const result = value as Row;
  if (keys) requireFact(keys.every(key => Object.hasOwn(result, key))
    && Object.keys(result).every(key => keys.includes(key) || optional.includes(key)));
  return result;
}
function safePath(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 500 && value.split('/').every(part =>
    /^[A-Za-z0-9._ -]{1,160}$(?![\s\S])/.test(part) && part !== '.' && part !== '..' && !part.endsWith('.') && !part.endsWith(' ')
    && !/^(?:\.env.*|\.git|node_modules|\.ssh|\.npmrc|credentials?|secrets?|id_rsa|id_ed25519|con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)
    && !/\.(?:pem|key|p12|pfx|jks)$/i.test(part));
}
function releasePath(value: unknown): value is string {
  return safePath(value) && (value.startsWith(ROOT) || value === PROMPT);
}
function normalized(value: string) { return value.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase(); }
function ordered(values: string[]) { return values.every((value, index) => index === 0 || values[index - 1]! <= value); }
function checkedText(bytes: Buffer) {
  const text = bytes.toString('utf8');
  requireFact(Buffer.from(text).equals(bytes) && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(text)
    && !/-----BEGIN (?:[A-Z ]*PRIVATE KEY|OPENSSH PRIVATE KEY)-----/.test(text));
  return text;
}
async function document(text: string, schema: string): Promise<Row> {
  const value: unknown = JSON.parse(text);
  snapshot(value);
  requireFact(`${canonicalize(value)}\n` === text);
  const contract = await validateContract(fileURLToPath(new URL('./schemas/', import.meta.url)), schema, value);
  requireFact(contract.ok);
  return row(value);
}

export async function validateRepositoryReleaseMetadata(input: {
  scope: RepositoryReleaseMetadataScope;
  files: RepositoryReleaseMetadataFile[];
}) {
  const bound = row(snapshot(input), ['scope', 'files']);
  const scope = row(bound.scope, ['organizationId', 'repositoryBindingId', 'repositoryAgentId', 'generation',
    'policyHash', 'sourceSnapshotHash', 'sourceManifestHash', 'sourceLocalCatalogHash', 'catalogHash', 'manifestHash']);
  requireFact(typeof scope.organizationId === 'string' && /^org_[A-Za-z0-9_]{1,156}$(?![\s\S])/.test(scope.organizationId)
    && typeof scope.repositoryBindingId === 'string' && UUID.test(scope.repositoryBindingId)
    && typeof scope.repositoryAgentId === 'string' && UUID.test(scope.repositoryAgentId)
    && Number.isSafeInteger(scope.generation) && Number(scope.generation) >= 1);
  for (const key of ['policyHash', 'sourceSnapshotHash', 'sourceManifestHash', 'sourceLocalCatalogHash', 'catalogHash', 'manifestHash']) {
    requireFact(typeof scope[key] === 'string' && HASH.test(scope[key]));
  }
  requireFact(Array.isArray(bound.files) && bound.files.length >= 4 && bound.files.length <= 516);
  const files = new Map<string, { sha256: string; sizeBytes: number; text: string }>();
  const paths = new Set<string>();
  let totalBytes = 0;
  for (const item of bound.files) {
    const file = row(item, ['path', 'contentBase64', 'sha256', 'sizeBytes']);
    requireFact(releasePath(file.path) && !paths.has(file.path.toLowerCase())
      && typeof file.contentBase64 === 'string' && file.contentBase64.length <= 349528
      && typeof file.sha256 === 'string' && HASH.test(file.sha256)
      && Number.isSafeInteger(file.sizeBytes) && Number(file.sizeBytes) >= 0 && Number(file.sizeBytes) <= 262144);
    const bytes = Buffer.from(file.contentBase64, 'base64');
    requireFact(bytes.toString('base64') === file.contentBase64 && bytes.length === file.sizeBytes && digest(bytes) === file.sha256);
    totalBytes += bytes.length;
    requireFact(totalBytes <= 5242880);
    paths.add(file.path.toLowerCase());
    files.set(file.path, { sha256: file.sha256, sizeBytes: bytes.length, text: checkedText(bytes) });
  }
  requireFact([...files.keys()].every(path => path.split('/').slice(1).every((_, index) =>
    !paths.has(path.split('/').slice(0, index + 1).join('/').toLowerCase()))));
  const catalogFile = files.get(CATALOG), manifestFile = files.get(MANIFEST);
  requireFact(catalogFile && manifestFile);
  requireFact(catalogFile?.sha256 === scope.catalogHash && manifestFile?.sha256 === scope.manifestHash
    && files.has(`${ROOT}SKILL.md`) && files.get(PROMPT)?.sizeBytes);
  const catalog = await document(catalogFile.text, 'https://schemas.dharma-ai.io/repository-knowledge/v2');
  const manifest = await document(manifestFile.text, 'https://schemas.dharma-ai.io/repository-release-manifest/v1');
  const knowledgeBaseId = `repository-kb:${digest(canonicalize({ schema: 'dharma.repository-knowledge-identity/v1',
    organizationId: scope.organizationId, repositoryAgentId: scope.repositoryAgentId }))}`;
  for (const artifact of [catalog, manifest]) {
    for (const key of ['organizationId', 'repositoryAgentId', 'generation', 'policyHash', 'sourceSnapshotHash']) {
      requireFact(artifact[key] === scope[key]);
    }
    requireFact(artifact.knowledgeBaseId === knowledgeBaseId);
  }
  requireFact(catalog.sourceLocalCatalogHash === scope.sourceLocalCatalogHash && manifest.sourceManifestHash === scope.sourceManifestHash);
  const atlas = row(catalog.repoAtlas);
  requireFact(atlas.organizationId === scope.organizationId && atlas.repositoryAgentId === scope.repositoryAgentId
    && atlas.knowledgeBaseId === knowledgeBaseId && atlas.associationId === manifest.atlasAssociationId);
  const windows = atlas.sourceWindowIds as string[];
  requireFact(new Set(windows).size === windows.length
    && (atlas.basis === 'repository_initialization' ? windows.length === 0 && atlas.analysisHash === null : windows.length > 0 && atlas.analysisHash !== null));
  const inventory = manifest.files as Row[];
  requireFact(inventory.length === files.size - 1 && ordered(inventory.map(file => file.path as string)));
  const inventoried = new Set<string>();
  for (const file of inventory) {
    requireFact(releasePath(file.path) && file.path !== MANIFEST && !inventoried.has(file.path));
    const actual = files.get(file.path);
    requireFact(actual && actual.sha256 === file.sha256 && actual.sizeBytes === file.sizeBytes);
    const expectedRole = file.path === PROMPT ? 'onboarding_prompt' : file.path === CATALOG ? 'knowledge'
      : file.path === `${ROOT}SKILL.md` ? 'skill' : null;
    requireFact(expectedRole ? file.role === expectedRole
      : file.path.startsWith(`${ROOT}skills/source/`) && ['skill', 'dependency'].includes(file.role as string));
    inventoried.add(file.path);
  }
  requireFact([...files.keys()].every(path => path === MANIFEST || inventoried.has(path)));
  const copies = [...files.entries()].filter(([path]) => path.startsWith(`${ROOT}skills/source/`));
  requireFact(copies.reduce((sum, [, file]) => sum + file.sizeBytes, 0) <= 4194304);
  const skills = manifest.sourceSkills as unknown[];
  const skillPaths = new Set<string>();
  const skillFiles = new Set<string>();
  let referenceCount = 0;
  for (const item of skills) {
    const skill = row(item, ['path', 'providerRoot', 'entryPath', 'contentHash', 'availability', 'filePaths', 'observation'], ['managedPath']);
    requireFact(safePath(skill.path) && !skillPaths.has(skill.path.toLowerCase())
      && typeof skill.providerRoot === 'string' && ['.agents/skills', '.claude/skills', '.codex/skills', 'skills'].includes(skill.providerRoot)
      && (skill.path === skill.providerRoot || skill.path.startsWith(`${skill.providerRoot}/`)) && skill.entryPath === `${skill.path}/SKILL.md`
      && (skill.managedPath === undefined || skill.managedPath === `skills/source/${skill.path}`)
      && ['available', 'partial', 'unavailable'].includes(skill.availability as string)
      && Array.isArray(skill.filePaths) && skill.filePaths.length <= 512
      && ordered(skill.filePaths as string[]) && new Set(skill.filePaths).size === skill.filePaths.length);
    skillPaths.add(skill.path.toLowerCase());
    const hashes = (skill.filePaths as unknown[]).map(path => {
      requireFact(safePath(path));
      const actual = files.get(`${ROOT}skills/source/${path}`);
      requireFact(actual);
      skillFiles.add(`${ROOT}skills/source/${path}`);
      return { path, sha256: actual.sha256 };
    });
    requireFact(skill.contentHash === digest(canonicalize(hashes))
      && (skill.availability === 'unavailable' ? !skill.filePaths.includes(skill.entryPath) : skill.filePaths.includes(skill.entryPath)));
    const observation = row(skill.observation, ['state', 'authority', 'references']);
    requireFact(['not_observed', 'reported_observed'].includes(observation.state as string)
      && observation.authority === 'caller_supplied_not_runtime_verified' && Array.isArray(observation.references)
      && (referenceCount += observation.references.length) <= 256
      && (observation.state === 'not_observed' ? observation.references.length === 0 : observation.references.length > 0));
    requireFact(observation.state !== 'reported_observed' || skill.availability === 'available');
    for (const reference of observation.references) {
      const ref = row(reference, ['skillPath', 'skillHash', 'sourcePath', 'sourceHash']);
      requireFact(ref.skillPath === skill.path && ref.skillHash === skill.contentHash && safePath(ref.sourcePath)
        && typeof ref.sourceHash === 'string' && HASH.test(ref.sourceHash));
    }
  }
  requireFact(inventory.every(file => !['skill', 'dependency'].includes(file.role as string)
    || file.path === `${ROOT}SKILL.md` || skillFiles.has(file.path as string)));
  const concepts = catalog.concepts as Row[];
  requireFact(ordered(concepts.map(concept => concept.conceptId as string)));
  const labels = new Set<string>(), ids = new Set<string>();
  for (const concept of concepts) {
    const name = concept.canonicalName as string;
    requireFact(concept.conceptId === `concept_${digest(canonicalize({ schema: 'dharma.repository-concept-identity/v1',
      organizationId: scope.organizationId, repositoryAgentId: scope.repositoryAgentId, name: normalized(name) })).slice(7)}`
      && !ids.has(concept.conceptId as string) && ordered(concept.aliases as string[]));
    ids.add(concept.conceptId as string);
    for (const label of [name, ...concept.aliases as string[]]) {
      requireFact(label.trim() === label && !labels.has(normalized(label)));
      labels.add(normalized(label));
    }
    const sources = concept.sources as Row[];
    requireFact(ordered(sources.map(source => digest(canonicalize(source)))));
    for (const source of sources) requireFact(Number(source.lastLine) >= Number(source.firstLine)
      && Number(source.lastLine) - Number(source.firstLine) < 128);
  }
  requireFact(ordered((catalog.unresolved as Row[]).map(item => item.proposalHash as string)));
  return {
    stage: 'repository_release_metadata_observed',
    sharedRepositoryReady: false,
    signatureVerified: false,
    activationVerified: false,
    currentAuthorizationVerified: false,
    projectionVerified: false,
    nativeUseVerified: false,
    repositoryBindingVerified: false,
    catalog,
    manifest,
    limitations: ['metadata_integrity_only', 'repository_binding_requires_authorized_mapping', 'signature_not_verified',
      'activation_not_verified', 'source_approval_not_verified', 'semantic_truth_not_verified', 'native_use_not_verified'],
  };
}
