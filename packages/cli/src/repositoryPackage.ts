import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { link, lstat, mkdir, open, opendir, realpath, rename, rmdir, unlink } from 'node:fs/promises';
import { isAbsolute, posix, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalize, validateContract } from '@dharma-ai-labs/agent-fabric-contracts';
import { redactValue, type RedactionStats } from '@dharma-ai-labs/agent-fabric-evidence-reduction';
import { readRepositoryKnowledge, validateRepositoryKnowledgeCatalog, REPOSITORY_KNOWLEDGE_CATALOG_PATH } from './repositoryKnowledge.js';

export const REPOSITORY_SKILL_ROOTS = ['.agents/skills', '.claude/skills', '.codex/skills', 'skills'] as const;
const GENERATED_ROOT = '.agents/skills/dharma-agent-fabric';
const DEFAULT_LIMITS = { maximumEntries: 4096, maximumFiles: 512, maximumFileBytes: 262_144,
  maximumTotalBytes: 4_194_304, maximumDepth: 12, maximumDependencies: 256 };
export type RepositoryPackageLimits = typeof DEFAULT_LIMITS;
export interface RepositoryPackageObservation {
  skillPath: string;
  skillHash: string;
  sourcePath: string;
  sourceHash: string;
}
export interface RepositoryPackageFile {
  path: string;
  managedPath?: string;
  sha256: string;
  sizeBytes: number;
  role: 'skill' | 'dependency' | 'approved_output' | 'knowledge';
}
export interface RepositoryPackageManifest {
  schema: 'dharma.repository-package/v1';
  organizationId: string;
  workspaceId: string;
  snapshotId: string;
  snapshotHash: string;
  authority: 'local_inventory_not_signed';
  roots: string[];
  files: RepositoryPackageFile[];
  skills: Array<{ path: string; managedPath?: string; providerRoot: string; entryPath: string; contentHash: string;
    availability: 'available' | 'partial' | 'unavailable'; filePaths: string[];
    observation: { state: 'not_observed' | 'reported_observed'; authority: 'caller_supplied_not_runtime_verified';
      references: RepositoryPackageObservation[] } }>;
  exclusions: Array<{ path: string; reason: string }>;
  knowledge?: { repositoryAgentId: string; knowledgeBaseId: string; catalogPath: string;
    catalogHash: string; authority: 'locally_initialized_unsigned'; atlasAssociation: 'local_scope_only' };
}
export interface RepositoryPackageSnapshot {
  schema: 'dharma.repository-package-snapshot/v1';
  capturedAt: string;
  manifest: RepositoryPackageManifest;
  blobs: Array<{ sha256: string; contentBase64: string }>;
}
export interface RepositoryPackageInventoryInput {
  workspace: string;
  organizationId: string;
  workspaceId: string;
  repositoryAgentId?: string | null;
  approvedOutputs?: string[];
  observations?: RepositoryPackageObservation[];
  limits?: Partial<RepositoryPackageLimits>;
  now?: Date;
}

function digest(value: string | Buffer) { return `sha256:${createHash('sha256').update(value).digest('hex')}`; }
function compare(a: string, b: string) { return a < b ? -1 : a > b ? 1 : 0; }
function missing(error: unknown) { return ['ENOENT', 'ENOTDIR'].includes(String((error as NodeJS.ErrnoException).code)); }
function pathKey(value: string) {
  if (!value || value.includes('\\') || isAbsolute(value) || /^[A-Za-z]:/.test(value)) throw new Error('Invalid repository package path.');
  const parts = value.split('/');
  if (parts.some(part => !part || part === '.' || part === '..' || !/^[A-Za-z0-9._ -]{1,160}$/.test(part))) {
    throw new Error('Invalid repository package path.');
  }
  if (value.length > 500) throw new Error('Repository package path limit exceeded.');
  if (safeContent(Buffer.from(value))) throw new Error('Unsafe repository package path.');
  return value;
}
function generated(path: string) {
  return REPOSITORY_SKILL_ROOTS.some(root => path === `${root}/dharma-agent-fabric` || path.startsWith(`${root}/dharma-agent-fabric/`));
}
function prohibited(path: string) {
  return generated(path) || path.split('/').some(part => /^(?:\.env.*|\.netrc|\.npmrc|\.pypirc|\.git|\.dharma|node_modules|\.ssh|\.aws|\.gnupg|id_rsa|id_ed25519)$/i.test(part)
    || /(?:^|[._ -])(?:secrets?|credentials?|passwords?|private[-_ ]?keys?|keystore)(?:[._ -]|$)/i.test(part)
    || /\.(?:pem|key|p12|pfx|jks|kdbx)$/i.test(part));
}
function safeContent(bytes: Buffer) {
  const text = bytes.toString('utf8');
  if (!Buffer.from(text).equals(bytes) || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(text)) return 'binary_content';
  const stats: RedactionStats = { classes: new Set(), redactedValues: 0, excludedPaths: 0,
    inputBytes: bytes.length, outputBytes: bytes.length };
  let value: unknown = text;
  try { value = JSON.parse(text); } catch { /* Non-JSON companions are scanned as text. */ }
  redactValue(value, stats);
  // Evidence's local-path heuristic also matches ordinary relative links. Keep
  // its secret classes, and check absolute paths at an actual path boundary.
  if ([...stats.classes].some(name => name !== 'local_path') || /-----BEGIN (?:[A-Z ]*PRIVATE KEY|OPENSSH PRIVATE KEY)-----/.test(text)
    || /\b(?:[A-Za-z0-9_]*(?:password|passwd|secret|api_key|access_token|refresh_token|credential)[A-Za-z0-9_]*|token)["']?\s*[:=]\s*["']?[^\s"',;]+/i.test(text)) return 'secret_content';
  if (/(?:^|[\s"'(=])(?:\/(?:home|Users|root|mnt)\/|[A-Za-z]:[\\/]|\\\\)/m.test(text)) return 'local_path_content';
  return null;
}

// Reject every symlink component, not just links escaping the repository.
async function checkedPath(workspace: string, path: string) {
  pathKey(path);
  let current = workspace;
  for (const part of path.split('/')) {
    current = resolve(current, part);
    const metadata = await lstat(current);
    if (metadata.isSymbolicLink()) throw new Error('Repository package symlink is excluded.');
  }
  const resolved = await realpath(current);
  const route = relative(workspace, resolved);
  if (route === '..' || route.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || isAbsolute(route)) {
    throw new Error('Repository package path escapes its workspace.');
  }
  return current;
}
async function readStable(workspace: string, path: string, maximumBytes: number) {
  const source = await checkedPath(workspace, path);
  if (!(await lstat(source)).isFile()) throw new Error('Repository package requires regular files.');
  const handle = await open(source, constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0));
  try {
    const before = await handle.stat();
    if (!before.isFile()) throw new Error('Repository package requires regular files.');
    if (before.size > maximumBytes) throw new Error('Repository package file byte limit exceeded.');
    const buffer = Buffer.alloc(before.size + 1);
    let size = 0;
    while (size < buffer.length) {
      const result = await handle.read(buffer, size, buffer.length - size, size);
      if (!result.bytesRead) break;
      size += result.bytesRead;
    }
    const after = await handle.stat();
    const current = await lstat(await checkedPath(workspace, path));
    if (size !== before.size || before.size !== after.size || before.mtimeMs !== after.mtimeMs
      || before.ctimeMs !== after.ctimeMs || current.ino !== before.ino || current.dev !== before.dev
      || current.size !== after.size || current.mtimeMs !== after.mtimeMs) throw new Error('Repository package source changed during snapshot.');
    return buffer.subarray(0, size);
  } finally { await handle.close(); }
}
function dependencies(text: string) {
  const paths = new Set<string>();
  for (const match of text.matchAll(/\]\(([^\s)]+)(?:\s+[^)]*)?\)|`((?:\.\.?\/|references\/|scripts\/|assets\/)[^`\s]+)`/g)) {
    const value = (match[1] || match[2] || '').split('#')[0]!.split('?')[0]!;
    if (value && !/^[a-z][a-z0-9+.-]*:/i.test(value) && !value.startsWith('#')) paths.add(value);
  }
  return [...paths].sort(compare);
}

export async function inventoryRepositoryPackage(input: RepositoryPackageInventoryInput): Promise<RepositoryPackageSnapshot> {
  if (![input.organizationId, input.workspaceId].every(value => /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(value))) {
    throw new Error('Repository package requires bounded organization and workspace identities.');
  }
  const workspace = await realpath(input.workspace);
  const limits = { ...DEFAULT_LIMITS, ...input.limits };
  for (const key of Object.keys(DEFAULT_LIMITS) as Array<keyof RepositoryPackageLimits>) {
    if (!Number.isSafeInteger(limits[key]) || limits[key] < 1 || limits[key] > DEFAULT_LIMITS[key]) throw new Error('Invalid repository package limit.');
  }
  const exclusions = new Map<string, string>();
  const affectedPaths = new Set<string>();
  const diskFiles = new Set<string>();
  const skillRoots = new Map<string, string>();
  let entries = 0;
  function exclude(path: string, reason: string) {
    affectedPaths.add(path);
    const key = (() => { try { return pathKey(path); } catch { return `excluded-${digest(path).slice(7)}`; } })();
    exclusions.set(key, reason);
  }
  async function walk(path: string, depth: number, providerRoot: string) {
    if (generated(path)) return;
    if (++entries > limits.maximumEntries || depth > limits.maximumDepth) throw new Error('Repository package traversal limit exceeded.');
    try { pathKey(path); } catch { exclude(path, 'unsupported_path'); return; }
    if (prohibited(path)) { exclude(path, 'excluded_path'); return; }
    try {
      const source = await checkedPath(workspace, path);
      const metadata = await lstat(source);
      if (metadata.isDirectory()) {
        const names: string[] = [];
        const directory = await opendir(source);
        for await (const entry of directory) {
          names.push(entry.name);
          if (names.length + entries > limits.maximumEntries) throw new Error('Repository package directory entry limit exceeded.');
        }
        for (const name of names.sort(compare)) await walk(`${path}/${name}`, depth + 1, providerRoot);
      } else if (metadata.isFile()) {
        diskFiles.add(path);
        if (posix.basename(path) === 'SKILL.md') skillRoots.set(posix.dirname(path), providerRoot);
      } else exclude(path, 'not_regular_file');
    } catch (error) {
      if (missing(error)) return;
      if (String(error).includes('symlink')) { exclude(path, 'symlink'); return; }
      if (String(error).includes('limit')) throw error;
      if (['EACCES', 'EPERM'].includes(String((error as NodeJS.ErrnoException).code))) { exclude(path, 'unavailable'); return; }
      throw error;
    }
  }
  for (const root of REPOSITORY_SKILL_ROOTS) await walk(root, 0, root);
  const approved = new Set((input.approvedOutputs || []).map(pathKey));
  if (approved.size > limits.maximumFiles || [...approved].some(prohibited)) throw new Error('Approved repository outputs exceed scope or limit.');
  const files = new Map<string, RepositoryPackageFile>();
  const blobs = new Map<string, string>();
  const texts = new Map<string, string>();
  const edges = new Map<string, Set<string>>();
  const queue = new Map<string, RepositoryPackageFile['role']>();
  for (const path of [...diskFiles].sort(compare)) {
    if ([...skillRoots.keys()].some(root => path.startsWith(`${root}/`))) queue.set(path, 'skill');
  }
  for (const path of [...approved].sort(compare)) queue.set(path, queue.get(path) || 'approved_output');
  const visited = new Set<string>();
  let totalBytes = 0;
  let dependencyCount = 0;
  while (queue.size) {
    const [path, role] = queue.entries().next().value!;
    queue.delete(path);
    if (visited.has(path)) continue;
    visited.add(path);
    if (visited.size > limits.maximumFiles) throw new Error('Repository package file count limit exceeded.');
    if (prohibited(path)) { if (!generated(path)) exclude(path, 'excluded_path'); continue; }
    let content: Buffer;
    try { content = await readStable(workspace, path, limits.maximumFileBytes); }
    catch (error) {
      if (String(error).includes('limit') || String(error).includes('changed during')) throw error;
      exclude(path, missing(error) ? 'missing_dependency' : String(error).includes('symlink') ? 'symlink' : 'unavailable');
      continue;
    }
    const unsafe = safeContent(content);
    if (unsafe) { exclude(path, unsafe); continue; }
    totalBytes += content.length;
    if (totalBytes > limits.maximumTotalBytes) throw new Error('Repository package total byte limit exceeded.');
    const hash = digest(content);
    files.set(path, { path, role, sha256: hash, sizeBytes: content.length });
    blobs.set(hash, content.toString('base64'));
    texts.set(path, content.toString('utf8'));
    // Outputs are opaque approved snapshots; they never trigger more collection.
    if (role === 'approved_output') continue;
    for (const reference of dependencies(texts.get(path)!)) {
      if (++dependencyCount > limits.maximumDependencies) throw new Error('Repository package dependency limit exceeded.');
      const target = posix.normalize(posix.join(posix.dirname(path), reference));
      try {
        if (isAbsolute(reference) || reference.includes('\\')) throw new Error('Invalid dependency.');
        pathKey(target);
      } catch { exclude(path, 'invalid_dependency'); continue; }
      const targets = edges.get(path) || new Set<string>();
      targets.add(target);
      edges.set(path, targets);
      if (generated(target)) { exclude(path, 'generated_dependency'); continue; }
      if (!visited.has(target) && !queue.has(target)) queue.set(target, approved.has(target) ? 'approved_output' : 'dependency');
    }
  }
  const skills: RepositoryPackageManifest['skills'] = [];
  for (const [path, providerRoot] of [...skillRoots].sort(([a], [b]) => compare(a, b))) {
    const owned = new Set([...diskFiles].filter(file => file.startsWith(`${path}/`)));
    const pending = [...owned];
    const seen = new Set<string>();
    while (pending.length) {
      const file = pending.pop()!;
      if (seen.has(file)) continue;
      seen.add(file);
      for (const target of edges.get(file) || []) { owned.add(target); if (!seen.has(target)) pending.push(target); }
    }
    const filePaths = [...owned].filter(file => files.has(file)).sort(compare);
    const partial = [...owned].some(file => !files.has(file)) || [...affectedPaths].some(file => file === path || file.startsWith(`${path}/`) || owned.has(file));
    skills.push({ path, managedPath: copyPath(path), providerRoot, entryPath: `${path}/SKILL.md`, filePaths,
      contentHash: digest(canonicalize(filePaths.map(file => ({ path: file, sha256: files.get(file)!.sha256 })))),
      availability: !files.has(`${path}/SKILL.md`) ? 'unavailable' : partial ? 'partial' : 'available',
      observation: { state: 'not_observed', authority: 'caller_supplied_not_runtime_verified', references: [] } });
  }
  for (const path of new Set(skills.flatMap(skill => skill.filePaths))) files.get(path)!.managedPath = copyPath(path);
  if ((input.observations || []).length > 256) throw new Error('Repository package observation limit exceeded.');
  for (const reference of input.observations || []) {
    const skill = skills.find(skill => skill.path === reference.skillPath);
    const source = files.get(reference.sourcePath);
    if (!skill || skill.availability !== 'available' || skill.contentHash !== reference.skillHash
      || !approved.has(reference.sourcePath) || source?.sha256 !== reference.sourceHash
      || Object.keys(reference).sort().join(',') !== 'skillHash,skillPath,sourceHash,sourcePath') {
      throw new Error('Repository package observation is not bound to an available skill and approved source snapshot.');
    }
    skill.observation.state = 'reported_observed';
    if (!skill.observation.references.some(item => canonicalize(item) === canonicalize(reference))) skill.observation.references.push({ ...reference });
    skill.observation.references.sort((a, b) => compare(canonicalize(a), canonicalize(b)));
  }
  let knowledge: RepositoryPackageManifest['knowledge'];
  if (input.repositoryAgentId) {
    const catalog = await readRepositoryKnowledge({ workspace, organizationId: input.organizationId,
      repositoryAgentId: input.repositoryAgentId });
    if (catalog) {
      const knowledgePaths = [REPOSITORY_KNOWLEDGE_CATALOG_PATH,
        ...catalog.concepts.map(concept => `${GENERATED_ROOT}/knowledge/${concept.relativePath}`)];
      for (const path of knowledgePaths) {
        pathKey(path);
        const content = await readStable(workspace, path, limits.maximumFileBytes);
        if (safeContent(content)) throw new Error('Repository knowledge contains unsafe content.');
        totalBytes += content.length;
        const hash = digest(content);
        files.set(path, { path, role: 'knowledge', sha256: hash, sizeBytes: content.length });
        blobs.set(hash, content.toString('base64'));
      }
      if (files.size > limits.maximumFiles || totalBytes > limits.maximumTotalBytes) throw new Error('Repository knowledge package limit exceeded.');
      knowledge = { repositoryAgentId: catalog.repositoryAgentId, knowledgeBaseId: catalog.knowledgeBaseId,
        catalogPath: REPOSITORY_KNOWLEDGE_CATALOG_PATH, catalogHash: catalog.catalogHash,
        authority: 'locally_initialized_unsigned', atlasAssociation: 'local_scope_only' };
    }
  }
  const base = { schema: 'dharma.repository-package/v1' as const, organizationId: input.organizationId,
    workspaceId: input.workspaceId, authority: 'local_inventory_not_signed' as const, roots: [...REPOSITORY_SKILL_ROOTS],
    files: [...files.values()].sort((a, b) => compare(a.path, b.path)), skills,
    exclusions: [...exclusions].sort(([a], [b]) => compare(a, b)).map(([path, reason]) => ({ path, reason })),
    ...(knowledge ? { knowledge } : {}) };
  const snapshotHash = digest(canonicalize(base));
  return { schema: 'dharma.repository-package-snapshot/v1', capturedAt: (input.now || new Date()).toISOString(),
    manifest: { ...base, snapshotHash, snapshotId: `repository-package-${snapshotHash.slice(7)}` },
    blobs: [...blobs].sort(([a], [b]) => compare(a, b)).map(([sha256, contentBase64]) => ({ sha256, contentBase64 })) };
}

export function serializeRepositoryPackageSnapshot(snapshot: RepositoryPackageSnapshot): string {
  const { snapshotHash, snapshotId, ...base } = snapshot.manifest;
  if (safeContent(Buffer.from(canonicalize(base)))) throw new Error('Repository package metadata contains unsafe content.');
  if (snapshot.schema !== 'dharma.repository-package-snapshot/v1' || base.schema !== 'dharma.repository-package/v1'
    || base.authority !== 'local_inventory_not_signed' || digest(canonicalize(base)) !== snapshotHash
    || snapshotId !== `repository-package-${snapshotHash.slice(7)}`) throw new Error('Repository package manifest integrity failed.');
  const blobs = new Map<string, Buffer>();
  if (snapshot.blobs.length > DEFAULT_LIMITS.maximumFiles || base.files.length > DEFAULT_LIMITS.maximumFiles
    || base.skills.length > DEFAULT_LIMITS.maximumFiles || base.skills.some(skill => skill.filePaths.length > DEFAULT_LIMITS.maximumFiles)
    || Buffer.byteLength(canonicalize(snapshot.manifest)) + 1 > METADATA_LIMIT) throw new Error('Repository package serialization limit exceeded.');
  let bytes = 0;
  for (const blob of snapshot.blobs) {
    if (blob.contentBase64.length > Math.ceil(DEFAULT_LIMITS.maximumFileBytes / 3) * 4) throw new Error('Repository package blob limit exceeded.');
    const content = Buffer.from(blob.contentBase64, 'base64');
    bytes += content.length;
    if (blobs.has(blob.sha256) || content.toString('base64') !== blob.contentBase64 || digest(content) !== blob.sha256 || safeContent(content)) {
      throw new Error('Repository package blob integrity failed.');
    }
    blobs.set(blob.sha256, content);
  }
  if (bytes > DEFAULT_LIMITS.maximumTotalBytes) throw new Error('Repository package serialization byte limit exceeded.');
  const paths = new Set<string>();
  const knowledgePaths = new Set<string>();
  if (base.knowledge) {
    if (base.knowledge.catalogPath !== REPOSITORY_KNOWLEDGE_CATALOG_PATH
      || base.knowledge.authority !== 'locally_initialized_unsigned'
      || base.knowledge.atlasAssociation !== 'local_scope_only') throw new Error('Repository knowledge mapping integrity failed.');
    const catalogFile = base.files.find(file => file.path === REPOSITORY_KNOWLEDGE_CATALOG_PATH && file.role === 'knowledge');
    const bytes = catalogFile ? blobs.get(catalogFile.sha256) : undefined;
    if (!bytes) throw new Error('Repository knowledge catalog blob is missing.');
    const catalog = validateRepositoryKnowledgeCatalog(JSON.parse(bytes.toString('utf8')),
      { organizationId: base.organizationId, repositoryAgentId: base.knowledge.repositoryAgentId });
    if (catalog.knowledgeBaseId !== base.knowledge.knowledgeBaseId || catalog.catalogHash !== base.knowledge.catalogHash) {
      throw new Error('Repository knowledge mapping integrity failed.');
    }
    knowledgePaths.add(REPOSITORY_KNOWLEDGE_CATALOG_PATH);
    for (const concept of catalog.concepts) {
      const path = `${GENERATED_ROOT}/knowledge/${concept.relativePath}`;
      const file = base.files.find(item => item.path === path && item.role === 'knowledge');
      if (file?.sha256 !== concept.sha256) throw new Error('Repository knowledge concept integrity failed.');
      knowledgePaths.add(path);
    }
  }
  for (const file of base.files) {
    pathKey(file.path);
    const approvedKnowledge = file.role === 'knowledge' && knowledgePaths.has(file.path) && file.managedPath === undefined;
    if ((file.role === 'knowledge' ? !approvedKnowledge : prohibited(file.path))
      || paths.has(file.path) || blobs.get(file.sha256)?.length !== file.sizeBytes) throw new Error('Repository package file integrity failed.');
    paths.add(file.path);
  }
  const copied = new Set(base.skills.flatMap(skill => skill.filePaths));
  const byPath = new Map(base.files.map(file => [file.path, file]));
  for (const skill of base.skills) {
    pathKey(skill.path);
    if (!REPOSITORY_SKILL_ROOTS.includes(skill.providerRoot as typeof REPOSITORY_SKILL_ROOTS[number])
      || !(skill.path === skill.providerRoot || skill.path.startsWith(`${skill.providerRoot}/`))
      || prohibited(skill.path) || skill.entryPath !== `${skill.path}/SKILL.md`
      || new Set(skill.filePaths).size !== skill.filePaths.length
      || skill.filePaths.some(path => !paths.has(path))
      || skill.contentHash !== digest(canonicalize(skill.filePaths.map(path => ({ path, sha256: byPath.get(path)!.sha256 }))))
      || (skill.managedPath !== undefined && skill.managedPath !== copyPath(skill.path))) {
      throw new Error('Repository package skill mapping integrity failed.');
    }
  }
  for (const file of base.files) {
    if (file.managedPath !== undefined && (!copied.has(file.path) || file.managedPath !== copyPath(file.path))) {
      throw new Error('Repository package file mapping integrity failed.');
    }
  }
  if (blobs.size !== new Set(base.files.map(file => file.sha256)).size) throw new Error('Repository package contains unreferenced blobs.');
  // Capture time is envelope metadata, not part of the immutable CAS object.
  return `${canonicalize({ manifest: snapshot.manifest, blobs: snapshot.blobs })}\n`;
}

async function persistSnapshot(input: RepositoryPackageWriteInput, workspace: string) {
  const serialized = serializeRepositoryPackageSnapshot(input.snapshot);
  const validated = await validateContract(fileURLToPath(new URL('./schemas/', import.meta.url)),
    'https://schemas.dharma-ai.io/repository-package/v1', input.snapshot.manifest);
  if (!validated.ok) throw new Error('Repository package manifest schema is invalid.');
  const manifestPath = `${GENERATED_ROOT}/MANIFEST.json`;
  const snapshotPath = `${GENERATED_ROOT}/snapshots/${input.snapshot.manifest.snapshotHash.slice(7)}.json`;
  const existingSkill = await checkedPath(workspace, `${GENERATED_ROOT}/SKILL.md`).then(() => true, error => {
    if (missing(error)) return false;
    throw error;
  });
  if (existingSkill) {
    let marker;
    try {
      marker = JSON.parse((await readStable(workspace, `${GENERATED_ROOT}/.dharma-agent-fabric.json`, 4096)).toString('utf8'));
    } catch (error) {
      if (String(error).includes('symlink')) throw error;
      throw new Error('Refusing to write into an unmanaged repository skill.');
    }
    if (marker.managedBy !== 'dharma-agent-fabric') throw new Error('Refusing to write into an unmanaged repository skill.');
  }
  let current = '';
  for (const part of posix.dirname(snapshotPath).split('/')) {
    current = current ? `${current}/${part}` : part;
    try { await mkdir(resolve(workspace, current), { mode: 0o700 }); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    await checkedPath(workspace, current);
  }
  await checkedPath(workspace, posix.dirname(snapshotPath));
  const stagedSnapshot = `${GENERATED_ROOT}/snapshots/.snapshot-${randomUUID()}.tmp`;
  try {
    const handle = await open(resolve(workspace, stagedSnapshot), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW || 0), 0o600);
    try { await handle.writeFile(serialized); await handle.sync(); } finally { await handle.close(); }
    await checkedPath(workspace, posix.dirname(snapshotPath));
    try { await link(resolve(workspace, stagedSnapshot), resolve(workspace, snapshotPath)); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const existing = await readStable(workspace, snapshotPath, 8_388_608);
      if (existing.toString('utf8') !== serialized) throw new Error('Repository package CAS conflict.');
    }
  } finally { await unlink(resolve(workspace, stagedSnapshot)).catch(error => { if (!missing(error)) throw error; }); }
  await syncDirectory(workspace, posix.dirname(snapshotPath));
  await withCopyLock(workspace, async () => {
    await recoverCopies(workspace);
    await prepareCopies(workspace, input.snapshot, input.onCopyCheckpoint);
  });
  return { manifestPath, snapshotPath, snapshotHash: input.snapshot.manifest.snapshotHash,
    managedCopiesPath: `${GENERATED_ROOT}/skills/source`,
    authority: 'local_inventory_not_signed' as const };
}

export type RepositoryPackageCopyCheckpoint = 'journal_prepared' | 'file_backed_up' | 'file_installed'
  | 'copies_index_written' | 'manifest_written' | 'cleanup_file_removed';
export interface RepositoryPackageWriteInput {
  workspace: string;
  snapshot: RepositoryPackageSnapshot;
  onCopyCheckpoint?: (point: RepositoryPackageCopyCheckpoint) => void | Promise<void>;
}
const writers = new Map<string, Promise<unknown>>();
export async function writeRepositoryPackageSnapshot(input: RepositoryPackageWriteInput) {
  const workspace = await realpath(input.workspace);
  const previous = writers.get(workspace) || Promise.resolve();
  const operation = previous.catch(() => {}).then(() => persistSnapshot(input, workspace));
  writers.set(workspace, operation);
  try { return await operation; } finally { if (writers.get(workspace) === operation) writers.delete(workspace); }
}

function copyPath(source: string) {
  pathKey(source);
  const path = `skills/source/${source}`;
  pathKey(`${GENERATED_ROOT}/${path}`);
  if (process.platform === 'win32' && source.split('/').some(part => /[. ]$/.test(part)
    || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) throw new Error('Unsupported Windows managed mapping.');
  return path;
}
type CopyFile = { path: string; sha256: string; sizeBytes: number };
interface CopyIndex {
  schema: 'dharma.repository-package-copies/v1'; snapshotHash: string;
  organizationId: string; workspaceId: string; files: CopyFile[]; indexHash: string;
}
interface CopyJournal {
  schema: 'dharma.repository-package-copy-journal/v1'; transactionId: string;
  previous: CopyIndex | null; previousManifestHash: string | null; desired: CopyIndex; journalHash: string;
}
const INDEX_PATH = `${GENERATED_ROOT}/COPY-INDEX.json`;
const JOURNAL_PATH = `${GENERATED_ROOT}/COPY-JOURNAL.json`;
const LOCK_PATH = `${GENERATED_ROOT}/COPY-LOCK.json`;
const METADATA_LIMIT = 1_048_576;
function indexFor(manifest: RepositoryPackageManifest): CopyIndex {
  const copied = new Set(manifest.skills.flatMap(skill => skill.filePaths));
  const files = manifest.files.filter(file => copied.has(file.path)).map(file => ({
    path: file.path, sha256: file.sha256, sizeBytes: file.sizeBytes,
  })).sort((a, b) => compare(a.path, b.path));
  if (process.platform === 'win32' && new Set(files.map(file => file.path.toLowerCase())).size !== files.length) {
    throw new Error('Windows managed mapping collision.');
  }
  for (const file of files) copyPath(file.path);
  const base = { schema: 'dharma.repository-package-copies/v1' as const, snapshotHash: manifest.snapshotHash,
    organizationId: manifest.organizationId, workspaceId: manifest.workspaceId, files };
  return { ...base, indexHash: digest(canonicalize(base)) };
}
async function optionalBytes(workspace: string, path: string, limit = METADATA_LIMIT) {
  try { return await readStable(workspace, path, limit); } catch (error) { if (missing(error)) return null; throw error; }
}
async function directories(workspace: string, path: string) {
  let current = '';
  for (const part of pathKey(path).split('/')) {
    current = current ? `${current}/${part}` : part;
    try { await mkdir(resolve(workspace, current), { mode: 0o700 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    if (!(await lstat(await checkedPath(workspace, current))).isDirectory()) throw new Error('Managed mapping directory conflict.');
  }
}
async function syncDirectory(workspace: string, path: string) {
  if (process.platform === 'win32') return; // Windows does not support opening directories for fsync.
  const handle = await open(await checkedPath(workspace, path), constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try { await handle.sync(); } finally { await handle.close(); }
}
async function freshFile(workspace: string, path: string, bytes: string | Buffer) {
  await directories(workspace, posix.dirname(path));
  const handle = await open(resolve(workspace, path), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW || 0), 0o600);
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
  await syncDirectory(workspace, posix.dirname(path));
}
async function atomicMetadata(workspace: string, path: string, value: unknown) {
  const temporary = `${GENERATED_ROOT}/.metadata-${randomUUID()}.tmp`;
  await freshFile(workspace, temporary, `${canonicalize(value)}\n`);
  try {
    await checkedPath(workspace, GENERATED_ROOT);
    await optionalBytes(workspace, path);
    await rename(resolve(workspace, temporary), resolve(workspace, path));
    await syncDirectory(workspace, GENERATED_ROOT);
  } finally { await unlink(resolve(workspace, temporary)).catch(error => { if (!missing(error)) throw error; }); }
}
async function snapshotFor(workspace: string, hash: string) {
  if (!/^sha256:[a-f0-9]{64}$/.test(hash)) throw new Error('Managed copies snapshot integrity failed.');
  const bytes = await readStable(workspace, `${GENERATED_ROOT}/snapshots/${hash.slice(7)}.json`, 8_388_608);
  const snapshot: RepositoryPackageSnapshot = { ...JSON.parse(bytes.toString('utf8')), schema: 'dharma.repository-package-snapshot/v1', capturedAt: '' };
  if (snapshot.manifest.snapshotHash !== hash || serializeRepositoryPackageSnapshot(snapshot) !== bytes.toString('utf8')) {
    throw new Error('Managed copies snapshot integrity failed.');
  }
  const validated = await validateContract(fileURLToPath(new URL('./schemas/', import.meta.url)),
    'https://schemas.dharma-ai.io/repository-package/v1', snapshot.manifest);
  if (!validated.ok) throw new Error('Managed copies snapshot schema integrity failed.');
  return snapshot;
}
async function verifyIndex(workspace: string, index: CopyIndex) {
  if (!index || canonicalize(index) !== canonicalize(indexFor((await snapshotFor(workspace, index.snapshotHash)).manifest))) {
    throw new Error('Managed copies ownership index integrity failed.');
  }
}
function changes(journal: CopyJournal) {
  const before = new Map((journal.previous?.files || []).map(file => [file.path, file]));
  const after = new Map(journal.desired.files.map(file => [file.path, file]));
  return [...new Set([...before.keys(), ...after.keys()])].sort(compare)
    .filter(path => before.get(path)?.sha256 !== after.get(path)?.sha256)
    .map(path => ({ path, before: before.get(path), after: after.get(path) }));
}
function stagePaths(journal: CopyJournal, number: number) {
  const root = `${GENERATED_ROOT}/.copy-transactions/${journal.transactionId}`;
  return { root, staged: `${root}/new/${number}`, backup: `${root}/old/${number}` };
}
async function matches(workspace: string, path: string, file: CopyFile | undefined) {
  const bytes = await optionalBytes(workspace, path, DEFAULT_LIMITS.maximumFileBytes);
  if (bytes && (!file || bytes.length !== file.sizeBytes || digest(bytes) !== file.sha256)) throw new Error('Managed copies file conflict.');
  return bytes !== null;
}
async function sameFile(workspace: string, a: string, b: string) {
  const one = await lstat(await checkedPath(workspace, a));
  const two = await lstat(await checkedPath(workspace, b));
  return one.ino === two.ino && one.dev === two.dev && one.ino !== 0;
}
async function prepareCopies(workspace: string, snapshot: RepositoryPackageSnapshot, checkpoint?: RepositoryPackageWriteInput['onCopyCheckpoint']) {
  const desired = indexFor(snapshot.manifest);
  const bytes = await optionalBytes(workspace, INDEX_PATH);
  const previous: CopyIndex | null = bytes ? JSON.parse(bytes.toString('utf8')) : null;
  if (previous) {
    await verifyIndex(workspace, previous);
    if (previous.organizationId !== desired.organizationId || previous.workspaceId !== desired.workspaceId) throw new Error('Managed copies identity conflict.');
  }
  const manifestBytes = await optionalBytes(workspace, `${GENERATED_ROOT}/MANIFEST.json`);
  const previousManifestHash: string | null = manifestBytes ? JSON.parse(manifestBytes.toString('utf8')).snapshotHash : null;
  if (manifestBytes) {
    const prior = await snapshotFor(workspace, previousManifestHash!);
    if (manifestBytes.toString('utf8') !== `${canonicalize(prior.manifest)}\n`
      || prior.manifest.organizationId !== desired.organizationId || prior.manifest.workspaceId !== desired.workspaceId
      || (previous && previous.snapshotHash !== previousManifestHash)) throw new Error('Managed copies unmanaged manifest conflict.');
  } else if (previous) throw new Error('Managed copies missing manifest conflict.');
  const old = new Map((previous?.files || []).map(file => [file.path, file]));
  for (const file of previous?.files || []) {
    if (!await matches(workspace, `${GENERATED_ROOT}/${copyPath(file.path)}`, file)) throw new Error('Managed copies missing owned file conflict.');
  }
  for (const file of desired.files) {
    if (!old.has(file.path) && await optionalBytes(workspace, `${GENERATED_ROOT}/${copyPath(file.path)}`, DEFAULT_LIMITS.maximumFileBytes)) {
      throw new Error('Refusing unmanaged managed-copy destination conflict.');
    }
  }
  const base = { schema: 'dharma.repository-package-copy-journal/v1' as const, transactionId: randomUUID(), previous, previousManifestHash, desired };
  const journal = { ...base, journalHash: digest(canonicalize(base)) };
  const operations = changes(journal);
  const blobs = new Map(snapshot.blobs.map(blob => [blob.sha256, Buffer.from(blob.contentBase64, 'base64')]));
  for (const [number, operation] of operations.entries()) {
    const { staged, backup } = stagePaths(journal, number);
    await directories(workspace, posix.dirname(backup));
    if (operation.after) await freshFile(workspace, staged, blobs.get(operation.after.sha256)!);
  }
  await atomicMetadata(workspace, JOURNAL_PATH, journal);
  await checkpoint?.('journal_prepared');
  await applyJournal(workspace, journal, snapshot, checkpoint);
}
async function recoverCopies(workspace: string) {
  const bytes = await optionalBytes(workspace, JOURNAL_PATH);
  if (!bytes) return;
  const journal: CopyJournal = JSON.parse(bytes.toString('utf8'));
  const { journalHash, ...base } = journal;
  if (journal.schema !== 'dharma.repository-package-copy-journal/v1'
    || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(journal.transactionId)
    || journalHash !== digest(canonicalize(base))) throw new Error('Managed copies journal integrity failed.');
  await verifyIndex(workspace, journal.desired);
  if (journal.previous) {
    await verifyIndex(workspace, journal.previous);
    if (journal.previous.organizationId !== journal.desired.organizationId || journal.previous.workspaceId !== journal.desired.workspaceId) {
      throw new Error('Managed copies journal identity conflict.');
    }
  }
  if (journal.previousManifestHash !== null) {
    const prior = (await snapshotFor(workspace, journal.previousManifestHash)).manifest;
    if (prior.organizationId !== journal.desired.organizationId || prior.workspaceId !== journal.desired.workspaceId
      || (journal.previous && journal.previous.snapshotHash !== journal.previousManifestHash)) throw new Error('Managed copies journal manifest conflict.');
  } else if (journal.previous) throw new Error('Managed copies journal manifest integrity failed.');
  await applyJournal(workspace, journal, await snapshotFor(workspace, journal.desired.snapshotHash));
}
async function verifyMetadata(workspace: string, journal: CopyJournal, desiredManifest: string) {
  const currentIndex = await optionalBytes(workspace, INDEX_PATH);
  const currentManifest = await optionalBytes(workspace, `${GENERATED_ROOT}/MANIFEST.json`);
  const previousManifest = journal.previousManifestHash === null ? null
    : `${canonicalize((await snapshotFor(workspace, journal.previousManifestHash)).manifest)}\n`;
  if (currentIndex && currentIndex.toString('utf8') !== `${canonicalize(journal.desired)}\n`
    && currentIndex.toString('utf8') !== `${canonicalize(journal.previous)}\n`) throw new Error('Managed copies index conflict.');
  if (!currentIndex && journal.previous) throw new Error('Managed copies missing index conflict.');
  if (currentManifest && currentManifest.toString('utf8') !== desiredManifest && currentManifest.toString('utf8') !== previousManifest) {
    throw new Error('Managed copies unmanaged manifest conflict.');
  }
  if (!currentManifest && previousManifest) throw new Error('Managed copies missing manifest conflict.');
  return currentIndex?.toString('utf8') === `${canonicalize(journal.desired)}\n` && currentManifest?.toString('utf8') === desiredManifest;
}
async function verifyCopies(workspace: string, journal: CopyJournal) {
  for (const file of journal.desired.files) {
    if (!await matches(workspace, `${GENERATED_ROOT}/${copyPath(file.path)}`, file)) throw new Error('Managed copies missing desired file conflict.');
  }
  for (const operation of changes(journal).filter(operation => !operation.after)) {
    if (await optionalBytes(workspace, `${GENERATED_ROOT}/${copyPath(operation.path)}`, DEFAULT_LIMITS.maximumFileBytes)) {
      throw new Error('Managed copies stale destination conflict.');
    }
  }
}
async function applyJournal(workspace: string, journal: CopyJournal, snapshot: RepositoryPackageSnapshot,
  checkpoint?: RepositoryPackageWriteInput['onCopyCheckpoint']) {
  const desiredManifest = `${canonicalize(snapshot.manifest)}\n`;
  const committed = await verifyMetadata(workspace, journal, desiredManifest);
  const operations = changes(journal);
  if (!committed) {
    for (const [number, operation] of operations.entries()) {
      const target = `${GENERATED_ROOT}/${copyPath(operation.path)}`;
      const { staged, backup } = stagePaths(journal, number);
      const saved = await matches(workspace, backup, operation.before);
      const targetBytes = await optionalBytes(workspace, target, DEFAULT_LIMITS.maximumFileBytes);
      const installed = !!operation.after && !!targetBytes && digest(targetBytes) === operation.after.sha256
        && await matches(workspace, staged, operation.after) && await sameFile(workspace, target, staged);
      if (targetBytes && !installed) {
        if (!operation.before || saved || !await matches(workspace, target, operation.before)) throw new Error('Managed copies unmanaged destination conflict.');
        await rename(resolve(workspace, target), resolve(workspace, backup));
        await syncDirectory(workspace, posix.dirname(target));
        await syncDirectory(workspace, posix.dirname(backup));
        await checkpoint?.('file_backed_up');
      } else if (operation.before && !saved && !installed) throw new Error('Managed copies missing backup conflict.');
      if (operation.after && !installed) {
        if (!await matches(workspace, staged, operation.after)) throw new Error('Managed copies missing staged file conflict.');
        await directories(workspace, posix.dirname(target));
        try { await link(resolve(workspace, staged), resolve(workspace, target)); }
        catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('Managed copies unmanaged destination conflict.'); throw error; }
        await syncDirectory(workspace, posix.dirname(target));
        await checkpoint?.('file_installed');
      }
    }
    await verifyCopies(workspace, journal);
    await verifyMetadata(workspace, journal, desiredManifest);
    await atomicMetadata(workspace, INDEX_PATH, journal.desired);
    await checkpoint?.('copies_index_written');
    await verifyMetadata(workspace, journal, desiredManifest);
    await atomicMetadata(workspace, `${GENERATED_ROOT}/MANIFEST.json`, snapshot.manifest);
    await checkpoint?.('manifest_written');
  }
  await verifyCopies(workspace, journal);
  for (const [number, operation] of operations.entries()) {
    const { staged, backup } = stagePaths(journal, number);
    for (const [path, file] of [[staged, operation.after], [backup, operation.before]] as const) {
      if (await matches(workspace, path, file)) {
        await unlink(resolve(workspace, path));
        await syncDirectory(workspace, posix.dirname(path));
        await checkpoint?.('cleanup_file_removed');
      }
    }
  }
  // Only empty known directories are removed; unmanaged neighbors remain untouched.
  const folders = new Set<string>();
  for (const [number, operation] of operations.entries()) {
    const { root, staged, backup } = stagePaths(journal, number);
    for (const folder of [posix.dirname(staged), posix.dirname(backup), root]) folders.add(folder);
    if (!operation.after) {
      let folder = posix.dirname(`${GENERATED_ROOT}/${copyPath(operation.path)}`);
      while (folder.startsWith(`${GENERATED_ROOT}/skills/source/`)) { folders.add(folder); folder = posix.dirname(folder); }
    }
  }
  for (const folder of [...folders].sort((a, b) => b.split('/').length - a.split('/').length || compare(a, b))) {
    try { await rmdir(await checkedPath(workspace, folder)); }
    catch (error) { if (!missing(error) && !['ENOTEMPTY', 'EEXIST'].includes(String((error as NodeJS.ErrnoException).code))) throw error; }
  }
  const bytes = await readStable(workspace, JOURNAL_PATH, METADATA_LIMIT);
  if (bytes.toString('utf8') !== `${canonicalize(journal)}\n`) throw new Error('Managed copies journal conflict.');
  await unlink(resolve(workspace, JOURNAL_PATH));
  await syncDirectory(workspace, GENERATED_ROOT);
}
async function withCopyLock(workspace: string, action: () => Promise<void>) {
  const lock = { schema: 'dharma.repository-package-copy-lock/v1', platform: process.platform, pid: process.pid, nonce: randomUUID() };
  const text = `${canonicalize(lock)}\n`;
  const temporary = `${GENERATED_ROOT}/.lock-${lock.nonce}.tmp`;
  await freshFile(workspace, temporary, text);
  let acquired = false;
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      try { await link(resolve(workspace, temporary), resolve(workspace, LOCK_PATH)); acquired = true; break; }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        const bytes = await readStable(workspace, LOCK_PATH, 4096);
        const existing = JSON.parse(bytes.toString('utf8'));
        if (existing.schema !== lock.schema || existing.platform !== lock.platform || !Number.isSafeInteger(existing.pid) || existing.pid < 1) {
          throw new Error('Managed copies lock conflict.');
        }
        try { process.kill(existing.pid, 0); throw new Error('Managed copies writer is active; retry later.'); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
        if (!(await readStable(workspace, LOCK_PATH, 4096)).equals(bytes)) throw new Error('Managed copies lock conflict.');
        await unlink(resolve(workspace, LOCK_PATH));
      }
    }
    if (!acquired) throw new Error('Managed copies lock conflict.');
    await action();
  } finally {
    if (acquired) {
      if ((await readStable(workspace, LOCK_PATH, 4096)).toString('utf8') !== text) throw new Error('Managed copies lock conflict.');
      await unlink(resolve(workspace, LOCK_PATH));
      await syncDirectory(workspace, GENERATED_ROOT);
    }
    await unlink(resolve(workspace, temporary));
  }
}
