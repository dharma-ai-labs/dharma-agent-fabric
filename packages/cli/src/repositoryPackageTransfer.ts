import { createHash } from 'node:crypto';
import { types } from 'node:util';

export const REPOSITORY_PACKAGE_TRANSFER_LIMITS = Object.freeze({
  maximumFiles: 512, maximumFileBytes: 262_144, maximumTotalBytes: 4_194_304,
  chunkBytes: 65_536, maximumChunks: 1024, maximumIndexBytes: 1_048_576,
});
type Digest = `sha256:${string}`;
interface Scope {
  organizationId: string;
  repositoryAgentId: string;
  releaseId: string;
  gitCommit: string;
}
export interface RepositoryTransferFile {
  path: string;
  contentBase64: string;
  sha256: string;
  sizeBytes: number;
}
export interface RepositoryTransferIndex extends Scope {
  schema: 'dharma.repository-package-transfer/v1';
  totalBytes: number;
  files: Array<{ path: string; sha256: string; sizeBytes: number; chunkHashes: string[] }>;
}
export interface RepositoryTransferChunk {
  schema: 'dharma.repository-package-chunk/v1';
  indexHash: string;
  fileIndex: number;
  chunkIndex: number;
  contentBase64: string;
}
const limits = REPOSITORY_PACKAGE_TRANSFER_LIMITS;
const hash = (bytes: Uint8Array | string): Digest => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const digestPattern = /^sha256:[0-9a-f]{64}(?![\s\S])/;

function requireFact(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
function record(value: unknown, keys: string[]): asserts value is Record<string, unknown> {
  requireFact(value !== null && typeof value === 'object' && !Array.isArray(value)
    && !types.isProxy(value)
    && Object.getPrototypeOf(value) === Object.prototype
    && Reflect.ownKeys(value).every(key => typeof key === 'string')
    && Reflect.ownKeys(value).sort().join(',') === [...keys].sort().join(','), 'Invalid transfer record.');
  for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) {
    requireFact(Object.hasOwn(descriptor, 'value') && descriptor.enumerable, 'Transfer accessors or hidden fields are forbidden.');
  }
}
function denseArray(value: unknown, maximum: number): asserts value is unknown[] {
  requireFact(Array.isArray(value) && !types.isProxy(value) && Object.getPrototypeOf(value) === Array.prototype
    && value.length <= maximum, 'Invalid transfer array.');
  const keys = Reflect.ownKeys(value);
  requireFact(keys.length === value.length + 1 && keys.every(key => key === 'length'
    || (typeof key === 'string' && /^(?:0|[1-9][0-9]*)(?![\s\S])/.test(key) && Number(key) < value.length)),
  'Sparse or extended transfer arrays are forbidden.');
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    requireFact(descriptor && Object.hasOwn(descriptor, 'value') && (key === 'length' || descriptor.enumerable),
      'Transfer array accessors are forbidden.');
  }
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') return `{${Object.entries(value)
    .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
  return JSON.stringify(value);
}
function scope(value: Scope) {
  requireFact(typeof value.organizationId === 'string'
    && /^org_[A-Za-z0-9_]{1,156}(?![\s\S])/.test(value.organizationId), 'Invalid transfer organization.');
  for (const id of [value.repositoryAgentId, value.releaseId]) {
    requireFact(typeof id === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,159}(?![\s\S])/.test(id), 'Invalid transfer identity.');
  }
  requireFact(typeof value.gitCommit === 'string' && /^(?:[0-9a-f]{40}|[0-9a-f]{64})(?![\s\S])/.test(value.gitCommit), 'Invalid transfer commit.');
}
function path(value: unknown): asserts value is string {
  requireFact(typeof value === 'string' && value.length > 0 && value.length <= 500
    && Buffer.from(value, 'utf8').toString('utf8') === value && value === value.normalize('NFC')
    && !/[\\:<>"|?*\u0000-\u001f\u007f]/.test(value), 'Invalid transfer path.');
  for (const part of value.split('/')) {
    requireFact(part && part !== '.' && part !== '..' && !/[. ]$/.test(part)
      && !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)
      && !/^(?:\.git|\.env(?:\..*)?|credentials?|secrets?|private[-_]?keys?|keystore)$/i.test(part),
    'Unsafe transfer path.');
  }
}
function bytes(value: unknown, maximum: number): Buffer {
  requireFact(typeof value === 'string' && value.length <= Math.ceil(maximum / 3) * 4,
    'Transfer encoding exceeds limit.');
  const decoded = Buffer.from(value, 'base64');
  requireFact(decoded.length <= maximum && decoded.toString('base64') === value, 'Invalid canonical transfer encoding.');
  return decoded;
}
function checkedIndex(value: unknown): RepositoryTransferIndex {
  record(value, ['schema', 'organizationId', 'repositoryAgentId', 'releaseId', 'gitCommit', 'totalBytes', 'files']);
  const index = value as unknown as RepositoryTransferIndex;
  scope(index);
  denseArray(index.files, limits.maximumFiles);
  requireFact(index.schema === 'dharma.repository-package-transfer/v1'
    && Array.isArray(index.files) && index.files.length > 0 && index.files.length <= limits.maximumFiles,
  'Invalid transfer index.');
  const paths = new Set<string>();
  let total = 0;
  let chunks = 0;
  for (const file of index.files) {
    record(file, ['path', 'sha256', 'sizeBytes', 'chunkHashes']);
    path(file.path);
    requireFact(!paths.has(file.path.toLowerCase()), 'Transfer path collision.');
    paths.add(file.path.toLowerCase());
    denseArray(file.chunkHashes, Math.ceil(limits.maximumFileBytes / limits.chunkBytes));
    requireFact(typeof file.sha256 === 'string' && digestPattern.test(file.sha256)
      && Number.isSafeInteger(file.sizeBytes) && file.sizeBytes >= 0 && file.sizeBytes <= limits.maximumFileBytes
      && Array.isArray(file.chunkHashes) && file.chunkHashes.length === Math.ceil(file.sizeBytes / limits.chunkBytes)
      && file.chunkHashes.every(item => typeof item === 'string' && digestPattern.test(item)), 'Invalid transfer file metadata.');
    total += file.sizeBytes;
    chunks += file.chunkHashes.length;
    requireFact(total <= limits.maximumTotalBytes && chunks <= limits.maximumChunks, 'Transfer package exceeds limit.');
    if (!file.sizeBytes) requireFact(file.sha256 === hash(Buffer.alloc(0)), 'Invalid empty-file digest.');
  }
  for (const filePath of paths) {
    const components = filePath.split('/');
    for (let length = 1; length < components.length; length++) {
      requireFact(!paths.has(components.slice(0, length).join('/')), 'Transfer file/ancestor collision.');
    }
  }
  requireFact(Number.isSafeInteger(index.totalBytes) && index.totalBytes === total, 'Transfer byte total mismatch.');
  requireFact(Buffer.byteLength(canonical(index)) <= limits.maximumIndexBytes, 'Transfer index exceeds limit.');
  return structuredClone(index);
}

// Pure byte planning: callers must independently enforce disclosure and release authorization.
export function planRepositoryPackageTransfer(input: Scope & { files: RepositoryTransferFile[] }) {
  record(input, ['organizationId', 'repositoryAgentId', 'releaseId', 'gitCommit', 'files']);
  scope(input);
  denseArray(input.files, limits.maximumFiles);
  requireFact(Array.isArray(input.files) && input.files.length > 0 && input.files.length <= limits.maximumFiles,
    'Transfer file count exceeds limit.');
  let totalBytes = 0;
  const decoded: Buffer[] = [];
  const files = input.files.map(file => {
    record(file, ['path', 'contentBase64', 'sha256', 'sizeBytes']);
    path(file.path);
    const content = bytes(file.contentBase64, limits.maximumFileBytes);
    requireFact(file.sizeBytes === content.length && file.sha256 === hash(content), 'Transfer source digest or size mismatch.');
    totalBytes += content.length;
    requireFact(totalBytes <= limits.maximumTotalBytes, 'Transfer package exceeds limit.');
    decoded.push(content);
    const chunkHashes: string[] = [];
    for (let offset = 0; offset < content.length; offset += limits.chunkBytes) {
      chunkHashes.push(hash(content.subarray(offset, offset + limits.chunkBytes)));
    }
    return { path: file.path, sha256: file.sha256, sizeBytes: file.sizeBytes, chunkHashes };
  });
  const index = checkedIndex({ schema: 'dharma.repository-package-transfer/v1', organizationId: input.organizationId,
    repositoryAgentId: input.repositoryAgentId, releaseId: input.releaseId, gitCommit: input.gitCommit, totalBytes, files });
  const indexHash = hash(canonical(index));
  const chunks: RepositoryTransferChunk[] = [];
  decoded.forEach((content, fileIndex) => {
    for (let offset = 0; offset < content.length; offset += limits.chunkBytes) chunks.push({
      schema: 'dharma.repository-package-chunk/v1', indexHash, fileIndex,
      chunkIndex: offset / limits.chunkBytes, contentBase64: content.subarray(offset, offset + limits.chunkBytes).toString('base64'),
    });
  });
  return { index, indexHash, chunks };
}

// expectedIndexHash must come from the existing verified release, not an untrusted response.
// Completion proves bytes only. It never authorizes publication, installation or activation.
export function createRepositoryPackageTransferReceiver(value: unknown, expected: Scope & { expectedIndexHash: string }) {
  record(expected, ['organizationId', 'repositoryAgentId', 'releaseId', 'gitCommit', 'expectedIndexHash']);
  scope(expected);
  const index = checkedIndex(value);
  for (const key of ['organizationId', 'repositoryAgentId', 'releaseId', 'gitCommit'] as const) {
    requireFact(index[key] === expected[key], 'Transfer scope mismatch.');
  }
  const indexHash = hash(canonical(index));
  requireFact(typeof expected.expectedIndexHash === 'string'
    && digestPattern.test(expected.expectedIndexHash) && indexHash === expected.expectedIndexHash,
    'Transfer index digest mismatch.');
  const received = new Map<string, Buffer>();
  return {
    accept(value: unknown): void {
      record(value, ['schema', 'indexHash', 'fileIndex', 'chunkIndex', 'contentBase64']);
      const chunk = value as unknown as RepositoryTransferChunk;
      requireFact(chunk.schema === 'dharma.repository-package-chunk/v1' && chunk.indexHash === indexHash
        && Number.isSafeInteger(chunk.fileIndex) && chunk.fileIndex >= 0 && chunk.fileIndex < index.files.length,
      'Invalid or foreign transfer chunk.');
      const file = index.files[chunk.fileIndex];
      requireFact(file, 'Transfer file index out of range.');
      requireFact(Number.isSafeInteger(chunk.chunkIndex) && chunk.chunkIndex >= 0
        && chunk.chunkIndex < file.chunkHashes.length, 'Transfer chunk index out of range.');
      const content = bytes(chunk.contentBase64, limits.chunkBytes);
      const expectedBytes = Math.min(limits.chunkBytes, file.sizeBytes - chunk.chunkIndex * limits.chunkBytes);
      requireFact(content.length === expectedBytes && hash(content) === file.chunkHashes[chunk.chunkIndex],
        'Transfer chunk integrity mismatch.');
      const key = `${chunk.fileIndex}:${chunk.chunkIndex}`;
      const previous = received.get(key);
      requireFact(!previous || previous.equals(content), 'Conflicting duplicate transfer chunk.');
      if (!previous) received.set(key, content);
    },
    finish(): RepositoryTransferFile[] | null {
      const result: RepositoryTransferFile[] = [];
      for (const [fileIndex, file] of index.files.entries()) {
        const content: Buffer[] = [];
        for (let chunkIndex = 0; chunkIndex < file.chunkHashes.length; chunkIndex++) {
          const chunk = received.get(`${fileIndex}:${chunkIndex}`);
          if (!chunk) return null;
          content.push(chunk);
        }
        const joined = Buffer.concat(content, file.sizeBytes);
        requireFact(joined.length === file.sizeBytes && hash(joined) === file.sha256, 'Transfer file integrity mismatch.');
        result.push({ path: file.path, contentBase64: joined.toString('base64'), sha256: file.sha256, sizeBytes: file.sizeBytes });
      }
      return result;
    },
  };
}
