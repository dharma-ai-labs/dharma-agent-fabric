import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  planRepositoryPackageTransfer,
  createRepositoryPackageTransferReceiver,
  REPOSITORY_PACKAGE_TRANSFER_LIMITS,
  planRepositoryPackageTransferV2,
  createRepositoryPackageTransferReceiverV2,
  REPOSITORY_PACKAGE_TRANSFER_V2_LIMITS,
} from './repositoryPackageTransfer.js';

const scope = {
  organizationId: 'org_transfer_fixture',
  repositoryBindingId: 'a24b5a90-3b7a-4a81-9503-c9f49be790c3',
  repositoryAgentId: 'b24b5a90-3b7a-4a81-9503-c9f49be790c3',
  releaseId: 'c24b5a90-3b7a-4a81-9503-c9f49be790c3',
  generation: 1,
  gitCommit: 'a'.repeat(40),
};
const scopeKeys = ['organizationId', 'repositoryBindingId', 'repositoryAgentId',
  'releaseId', 'generation', 'gitCommit'] as const;
const legacyScope = () => ({
  organizationId: scope.organizationId, repositoryAgentId: scope.repositoryAgentId,
  releaseId: scope.releaseId, gitCommit: scope.gitCommit,
});
const digest = (bytes: Uint8Array | string) =>
  'sha256:' + createHash('sha256').update(bytes).digest('hex');
const file = (path: string, bytes: Uint8Array) => ({
  path, contentBase64: Buffer.from(bytes).toString('base64'),
  sha256: digest(bytes), sizeBytes: bytes.length,
});
const smallFiles = () => [file('skills/task/payload.bin', Buffer.from([0, 255, 13, 10, 128]))];
type Plan = ReturnType<typeof planRepositoryPackageTransferV2>;
const expected = (plan: Plan) => ({ ...scope, expectedIndexHash: plan.indexHash });
const receiver = (plan: Plan) => createRepositoryPackageTransferReceiverV2(plan.index, expected(plan));
const planUnsafe = (input: unknown) =>
  planRepositoryPackageTransferV2(input as Parameters<typeof planRepositoryPackageTransferV2>[0]);
const receiveUnsafe = (index: unknown, expectation: unknown) =>
  createRepositoryPackageTransferReceiverV2(index,
    expectation as Parameters<typeof createRepositoryPackageTransferReceiverV2>[1]);

// Independent canonical index hashing; a caller must obtain this pin from a
// verified release. These tests prove transfer bytes, not release authority.
function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value !== null && typeof value === 'object') return '{' + Object.entries(value)
    .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([key, item]) => JSON.stringify(key) + ':' + canonical(item)).join(',') + '}';
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error('Fixture has a non-JSON value.');
  return encoded;
}
const repin = (index: unknown) => ({ ...scope, expectedIndexHash: digest(canonical(index)) });
function completeCapacityFiles() {
  return Array.from({ length: 516 }, (_, index) =>
    file('skills/full/file-' + String(index).padStart(3, '0') + '.bin',
      Buffer.alloc(index < 20 ? 262_144 : 0, index + 1)));
}
function foreign(key: typeof scopeKeys[number]): string | number {
  if (key === 'organizationId') return 'org_foreign';
  if (key === 'generation') return 2;
  if (key === 'gitCommit') return 'b'.repeat(40);
  return 'd24b5a90-3b7a-4a81-9503-c9f49be790c3';
}

test('v2 exposes exact frozen budgets without changing v1 budgets', () => {
  assert.deepEqual(REPOSITORY_PACKAGE_TRANSFER_V2_LIMITS, {
    maximumFiles: 516, maximumFileBytes: 262_144, maximumTotalBytes: 5_242_880,
    chunkBytes: 65_536, maximumChunks: 1024, maximumIndexBytes: 1_048_576,
  });
  assert.equal(Object.isFrozen(REPOSITORY_PACKAGE_TRANSFER_V2_LIMITS), true);
  assert.deepEqual(REPOSITORY_PACKAGE_TRANSFER_LIMITS, {
    maximumFiles: 512, maximumFileBytes: 262_144, maximumTotalBytes: 4_194_304,
    chunkBytes: 65_536, maximumChunks: 1024, maximumIndexBytes: 1_048_576,
  });
});

test('v2 preserves exact 516-file and 5-MiB simultaneous capacity in reverse chunk order', () => {
  const files = completeCapacityFiles();
  const plan = planRepositoryPackageTransferV2({ ...scope, files });
  assert.equal(plan.index.schema, 'dharma.repository-package-transfer/v2');
  assert.equal(plan.index.files.length, 516);
  assert.equal(plan.index.totalBytes, 5_242_880);
  assert.equal(plan.chunks.length, 80);
  assert.ok(Buffer.byteLength(canonical(plan.index)) <= 1_048_576);
  assert.equal(plan.indexHash, digest(canonical(plan.index)));
  for (const key of scopeKeys) assert.equal(plan.index[key], scope[key]);
  assert.deepEqual(Object.keys(plan.index).sort(), [...scopeKeys, 'schema', 'totalBytes', 'files'].sort());
  for (const chunk of plan.chunks) {
    assert.equal(chunk.schema, 'dharma.repository-package-chunk/v2');
    assert.equal(chunk.indexHash, plan.indexHash);
    assert.equal(Buffer.from(chunk.contentBase64, 'base64').length, 65_536);
  }
  const consumer = receiver(plan);
  assert.equal(consumer.finish(), null);
  [...plan.chunks].reverse().forEach(chunk => consumer.accept(chunk));
  assert.deepEqual(consumer.finish(), files);
});

test('v1 rejects v2 full capacity, file-only excess and byte-only excess', () => {
  assert.throws(() => planRepositoryPackageTransfer({ ...legacyScope(), files: completeCapacityFiles() }));
  assert.throws(() => planRepositoryPackageTransfer({ ...legacyScope(),
    files: Array.from({ length: 516 }, (_, index) => file('empty/' + index, Buffer.alloc(0))) }));
  assert.throws(() => planRepositoryPackageTransfer({ ...legacyScope(),
    files: Array.from({ length: 20 }, (_, index) => file('large/' + index, Buffer.alloc(262_144))) }));
});

test('v1 retains exact 512-file and 4-MiB simultaneous capacity', () => {
  const files = Array.from({ length: 512 }, (_, index) => file('legacy/' + index, Buffer.alloc(8192, index)));
  const plan = planRepositoryPackageTransfer({ ...legacyScope(), files });
  assert.equal(plan.index.schema, 'dharma.repository-package-transfer/v1');
  assert.equal(plan.index.totalBytes, 4_194_304);
  const consumer = createRepositoryPackageTransferReceiver(plan.index,
    { ...legacyScope(), expectedIndexHash: plan.indexHash });
  plan.chunks.forEach(chunk => consumer.accept(chunk));
  assert.deepEqual(consumer.finish(), files);
});

test('v1 rejects v2 indexes even with added scope removed and a recomputed pin', () => {
  const plan = planRepositoryPackageTransferV2({ ...scope, files: smallFiles() });
  assert.throws(() => createRepositoryPackageTransferReceiver(plan.index,
    { ...legacyScope(), expectedIndexHash: plan.indexHash }));
  const { repositoryBindingId: _binding, generation: _generation, ...index } = plan.index;
  assert.throws(() => createRepositoryPackageTransferReceiver(index,
    { ...legacyScope(), expectedIndexHash: digest(canonical(index)) }));
});

test('v2 rejects v1 indexes even with complete v2 scope added and a recomputed pin', () => {
  const plan = planRepositoryPackageTransfer({ ...legacyScope(), files: smallFiles() });
  assert.throws(() => receiveUnsafe(plan.index, { ...scope, expectedIndexHash: plan.indexHash }));
  const index = { ...plan.index, repositoryBindingId: scope.repositoryBindingId, generation: scope.generation };
  assert.throws(() => receiveUnsafe(index, repin(index)));
});

test('v1 rejects v2 chunks even when their index pin is replaced with the correct v1 pin', () => {
  const v1 = planRepositoryPackageTransfer({ ...legacyScope(), files: smallFiles() });
  const v2 = planRepositoryPackageTransferV2({ ...scope, files: smallFiles() });
  const consumer = createRepositoryPackageTransferReceiver(v1.index,
    { ...legacyScope(), expectedIndexHash: v1.indexHash });
  assert.throws(() => consumer.accept({ ...v2.chunks[0], indexHash: v1.indexHash }));
  assert.equal(consumer.finish(), null);
  v1.chunks.forEach(chunk => consumer.accept(chunk));
  assert.deepEqual(consumer.finish(), smallFiles());
});

test('v2 rejects v1 chunks even when their index pin is replaced with the correct v2 pin', () => {
  const v1 = planRepositoryPackageTransfer({ ...legacyScope(), files: smallFiles() });
  const v2 = planRepositoryPackageTransferV2({ ...scope, files: smallFiles() });
  const consumer = receiver(v2);
  assert.throws(() => consumer.accept({ ...v1.chunks[0], indexHash: v2.indexHash }));
  assert.equal(consumer.finish(), null);
  v2.chunks.forEach(chunk => consumer.accept(chunk));
  assert.deepEqual(consumer.finish(), smallFiles());
});

for (const key of scopeKeys) {
  test('v2 binds expected scope and repinned index scope: ' + key, () => {
    const plan = planRepositoryPackageTransferV2({ ...scope, files: smallFiles() });
    assert.throws(() => receiveUnsafe(plan.index, { ...expected(plan), [key]: foreign(key) }));
    const forged = { ...plan.index, [key]: foreign(key) };
    assert.throws(() => receiveUnsafe(forged, repin(forged)));
    const foreignPlan = planUnsafe({ ...scope, [key]: foreign(key), files: smallFiles() });
    const consumer = receiver(plan);
    foreignPlan.chunks.forEach(chunk => assert.throws(() => consumer.accept(chunk)));
    assert.equal(consumer.finish(), null);
  });

  test('v2 requires scope without defaults or implicit upgrades: ' + key, () => {
    const input: Record<string, unknown> = { ...scope, files: smallFiles() };
    delete input[key];
    assert.throws(() => planUnsafe(input));
    const plan = planRepositoryPackageTransferV2({ ...scope, files: smallFiles() });
    const index: Record<string, unknown> = { ...structuredClone(plan.index) };
    delete index[key];
    assert.throws(() => receiveUnsafe(index, repin(index)));
    const expectation: Record<string, unknown> = expected(plan);
    delete expectation[key];
    assert.throws(() => receiveUnsafe(plan.index, expectation));
  });
}

for (const key of ['organizationId', 'repositoryBindingId', 'repositoryAgentId', 'releaseId', 'gitCommit'] as const) {
  test('v2 rejects newline-suffixed scope throughout the boundary: ' + key, () => {
    const plan = planRepositoryPackageTransferV2({ ...scope, files: smallFiles() });
    assert.throws(() => planUnsafe({ ...scope, [key]: scope[key] + '\n', files: smallFiles() }));
    assert.throws(() => receiveUnsafe(plan.index, { ...expected(plan), [key]: scope[key] + '\n' }));
    const index = { ...plan.index, [key]: scope[key] + '\n' };
    assert.throws(() => receiveUnsafe(index, { ...repin(index), [key]: scope[key] + '\n' }));
  });
}

for (const key of ['repositoryBindingId', 'repositoryAgentId', 'releaseId'] as const) {
  test('v2 requires normalized UUID scope identities: ' + key, () => {
    for (const value of ['repo_fixture', scope[key].toUpperCase(), scope[key].replaceAll('-', ''),
      ' ' + scope[key], '00000000-0000-0000-0000-000000000000',
      scope[key].replace('-4a81-', '-9a81-'), scope[key].replace('-9503-', '-7503-'), 123, null]) {
      assert.throws(() => planUnsafe({ ...scope, [key]: value, files: smallFiles() }));
    }
  });
}

test('v2 rejects malformed Clerk organizations and mutable or noncanonical commits', () => {
  for (const organizationId of ['org_', 'other_fixture', 'org_with-hyphen', ' org_fixture',
    'org_' + 'a'.repeat(157), 123, null]) {
    assert.throws(() => planUnsafe({ ...scope, organizationId, files: smallFiles() }));
  }
  for (const gitCommit of ['main', 'HEAD', 'a'.repeat(39), 'a'.repeat(41), 'a'.repeat(63), 'a'.repeat(65),
    'A'.repeat(40), 'sha256:' + 'a'.repeat(64), 123, null]) {
    assert.throws(() => planUnsafe({ ...scope, gitCommit, files: smallFiles() }));
  }
});

test('v2 roundtrips an immutable lowercase 64-character commit with matching expected scope', () => {
  const scope64 = { ...scope, gitCommit: 'b'.repeat(64) };
  const files = smallFiles();
  const plan = planRepositoryPackageTransferV2({ ...scope64, files });
  assert.equal(plan.index.gitCommit, scope64.gitCommit);
  assert.equal(plan.indexHash, digest(canonical(plan.index)));
  const consumer = createRepositoryPackageTransferReceiverV2(plan.index,
    { ...scope64, expectedIndexHash: plan.indexHash });
  plan.chunks.forEach(chunk => consumer.accept(chunk));
  assert.deepEqual(consumer.finish(), files);
});

test('v2 generations are positive safe integers without coercion', () => {
  const files = smallFiles();
  const plan = planRepositoryPackageTransferV2({ ...scope, generation: Number.MAX_SAFE_INTEGER, files });
  const consumer = receiveUnsafe(plan.index, { ...scope, generation: Number.MAX_SAFE_INTEGER,
    expectedIndexHash: plan.indexHash });
  plan.chunks.forEach(chunk => consumer.accept(chunk));
  assert.deepEqual(consumer.finish(), files);
  for (const generation of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity, '1', '1\n', true, null]) {
    assert.throws(() => planUnsafe({ ...scope, generation, files }));
    const index = { ...plan.index, generation };
    assert.throws(() => receiveUnsafe(index, { ...repin(index), generation }));
  }
});

test('v2 requires the independently expected canonical index pin', () => {
  const plan = planRepositoryPackageTransferV2({ ...scope, files: smallFiles() });
  assert.equal(plan.indexHash, digest(canonical(plan.index)));
  const reordered = Object.fromEntries(Object.entries(plan.index).reverse());
  const consumer = receiveUnsafe(reordered, expected(plan));
  plan.chunks.forEach(chunk => consumer.accept(chunk));
  assert.deepEqual(consumer.finish(), smallFiles());
  for (const expectedIndexHash of ['sha256:' + '0'.repeat(64), plan.indexHash + '\n',
    plan.indexHash.toUpperCase(), plan.indexHash.slice(7), 'sha256:' + 'a'.repeat(63), null]) {
    assert.throws(() => receiveUnsafe(plan.index, { ...scope, expectedIndexHash }));
  }
  const renamed = structuredClone(plan.index);
  renamed.files[0]!.path = 'skills/task/renamed.bin';
  assert.throws(() => receiveUnsafe(renamed, expected(plan)));
});

test('v2 missing chunks remain pending and exact duplicate replay is idempotent', () => {
  const files = [file('skills/task/big.bin', Buffer.alloc(65_537, 7))];
  const plan = planRepositoryPackageTransferV2({ ...scope, files });
  const consumer = receiver(plan);
  assert.equal(consumer.finish(), null);
  consumer.accept(plan.chunks[1]);
  consumer.accept(structuredClone(plan.chunks[1]));
  assert.equal(consumer.finish(), null);
  consumer.accept(plan.chunks[0]);
  assert.deepEqual(consumer.finish(), files);
  plan.chunks.forEach(chunk => consumer.accept(chunk));
  assert.deepEqual(consumer.finish(), files);
});

test('v2 supports all-empty inventories independently of chunk delivery', () => {
  const files = Array.from({ length: 516 }, (_, index) => file('empty/' + index, Buffer.alloc(0)));
  const plan = planRepositoryPackageTransferV2({ ...scope, files });
  assert.equal(plan.index.totalBytes, 0);
  assert.deepEqual(plan.chunks, []);
  assert.deepEqual(receiver(plan).finish(), files);
});

test('v2 preserves mixed empty files, file ordering and chunk boundary byte values', () => {
  const bytes = Buffer.alloc(131_073);
  for (let index = 0; index < bytes.length; index++) bytes[index] = index % 256;
  const files = [file('z/empty', Buffer.alloc(0)), file('a/binary', bytes), file('m/empty', Buffer.alloc(0))];
  const plan = planRepositoryPackageTransferV2({ ...scope, files });
  assert.deepEqual(plan.chunks.map(chunk => chunk.fileIndex), [1, 1, 1]);
  assert.deepEqual(plan.chunks.map(chunk => Buffer.from(chunk.contentBase64, 'base64').length), [65_536, 65_536, 1]);
  const consumer = receiver(plan);
  [...plan.chunks].reverse().forEach(chunk => consumer.accept(chunk));
  assert.deepEqual(consumer.finish(), files);
});

test('v2 rejects corruption and conflicting replay without destroying accepted state', () => {
  const files = [file('skills/task/big', Buffer.alloc(65_537, 7))];
  const plan = planRepositoryPackageTransferV2({ ...scope, files });
  const consumer = receiver(plan);
  const corrupt = { ...plan.chunks[0], contentBase64: Buffer.alloc(65_536, 8).toString('base64') };
  assert.throws(() => consumer.accept(corrupt));
  assert.equal(consumer.finish(), null);
  consumer.accept(plan.chunks[0]);
  assert.throws(() => consumer.accept(corrupt));
  consumer.accept(plan.chunks[1]);
  assert.deepEqual(consumer.finish(), files);
});

test('v2 checks final file digest independently of valid chunk digests', () => {
  const plan = planRepositoryPackageTransferV2({ ...scope, files: smallFiles() });
  const index = structuredClone(plan.index);
  index.files[0]!.sha256 = 'sha256:' + '0'.repeat(64);
  const expectation = repin(index);
  const consumer = receiveUnsafe(index, expectation);
  plan.chunks.forEach(chunk => consumer.accept({ ...chunk, indexHash: expectation.expectedIndexHash }));
  assert.throws(() => consumer.finish());
});

test('v2 rejects foreign and newline chunk pins, invalid coordinates and oversized chunks', () => {
  const plan = planRepositoryPackageTransferV2({ ...scope, files: smallFiles() });
  const consumer = receiver(plan);
  for (const indexHash of ['sha256:' + '0'.repeat(64), plan.indexHash + '\n', null]) {
    assert.throws(() => consumer.accept({ ...plan.chunks[0], indexHash }));
  }
  for (const key of ['fileIndex', 'chunkIndex'] as const) {
    for (const value of [-1, 1, 0.5, Number.MAX_SAFE_INTEGER + 1, '0', null]) {
      assert.throws(() => consumer.accept({ ...plan.chunks[0], [key]: value }));
    }
  }
  assert.throws(() => consumer.accept({ ...plan.chunks[0], contentBase64: Buffer.alloc(65_537).toString('base64') }));
  assert.equal(consumer.finish(), null);
});

test('v2 rejects noncanonical chunk encoding and unexpected byte lengths', () => {
  const plan = planRepositoryPackageTransferV2({ ...scope, files: [file('a', Buffer.from('a'))] });
  const consumer = receiver(plan);
  for (const contentBase64 of ['YQ', 'YQ==\n', 'YR==', 'Y Q==', '', 'YWE=', 123, null]) {
    assert.throws(() => consumer.accept({ ...plan.chunks[0], contentBase64 }));
  }
  consumer.accept(plan.chunks[0]);
  assert.deepEqual(consumer.finish(), [file('a', Buffer.from('a'))]);
});

test('v2 rejects source hash, size and encoding mismatches', () => {
  const ordinary = file('a', Buffer.from('a'));
  for (const change of [{ sha256: ordinary.sha256 + '\n' }, { sha256: 'sha256:' + '0'.repeat(64) },
    { sha256: ordinary.sha256.toUpperCase() }, { sizeBytes: 2 }, { sizeBytes: '1' },
    { contentBase64: 'YQ' }, { contentBase64: 'YR==' }, { contentBase64: 'YQ==\n' }]) {
    assert.throws(() => planUnsafe({ ...scope, files: [{ ...ordinary, ...change }] }));
  }
});

test('v2 rejects malformed repinned inventory digests, chunk counts and byte totals', () => {
  const plan = planRepositoryPackageTransferV2({ ...scope, files: smallFiles() });
  const indexes = [];
  for (const sha256 of [plan.index.files[0]!.sha256 + '\n', 'sha256:' + 'A'.repeat(64), 'a'.repeat(64)]) {
    const index = structuredClone(plan.index);
    index.files[0]!.sha256 = sha256;
    indexes.push(index);
  }
  for (const chunkHash of [plan.index.files[0]!.chunkHashes[0]! + '\n', 'sha256:' + 'A'.repeat(64)]) {
    const index = structuredClone(plan.index);
    index.files[0]!.chunkHashes[0] = chunkHash;
    indexes.push(index);
  }
  for (const chunkHashes of [[], Array.from({ length: 1025 }, () => digest(Buffer.from('a')))]) {
    const index = structuredClone(plan.index);
    index.files[0]!.chunkHashes = chunkHashes;
    indexes.push(index);
  }
  for (const sizeBytes of [-1, 0.5, 262_145]) {
    const index = structuredClone(plan.index);
    index.files[0]!.sizeBytes = sizeBytes;
    indexes.push(index);
  }
  for (const index of indexes) assert.throws(() => receiveUnsafe(index, repin(index)));
  for (const totalBytes of [-1, plan.index.totalBytes + 1, 5_242_881, '5']) {
    const index = { ...plan.index, totalBytes };
    assert.throws(() => receiveUnsafe(index, repin(index)));
  }
});

test('v2 validates empty-file digest without waiting for nonexistent chunks', () => {
  const plan = planRepositoryPackageTransferV2({ ...scope, files: [file('empty', Buffer.alloc(0))] });
  const index = structuredClone(plan.index);
  index.files[0]!.sha256 = 'sha256:' + '0'.repeat(64);
  assert.throws(() => receiveUnsafe(index, repin(index)));
});

test('v2 rejects count and raw-byte overages without truncation', () => {
  assert.throws(() => planRepositoryPackageTransferV2({ ...scope, files: [] }));
  assert.throws(() => planRepositoryPackageTransferV2({ ...scope,
    files: Array.from({ length: 517 }, (_, index) => file('empty/' + index, Buffer.alloc(0))) }));
  assert.throws(() => planRepositoryPackageTransferV2({ ...scope,
    files: [...completeCapacityFiles(), file('extra', Buffer.from('a'))] }));
  assert.throws(() => planRepositoryPackageTransferV2({ ...scope,
    files: [...completeCapacityFiles().slice(0, 20), file('extra', Buffer.from('a'))] }));
  assert.throws(() => planRepositoryPackageTransferV2({ ...scope,
    files: [file('oversize', Buffer.alloc(262_145))] }));
});

test('v2 rejects repinned index file count excess and empty inventory', () => {
  const plan = planRepositoryPackageTransferV2({ ...scope, files: [file('empty', Buffer.alloc(0))] });
  for (const files of [[], Array.from({ length: 517 }, (_, index) => ({
    ...plan.index.files[0]!, path: 'empty/' + index, chunkHashes: [],
  }))]) {
    const index = { ...plan.index, files };
    assert.throws(() => receiveUnsafe(index, repin(index)));
  }
});

test('v2 snapshots source inputs and returned plan values independently', () => {
  const files = smallFiles();
  const original = structuredClone(files);
  const input = { ...scope, files };
  const plan = planRepositoryPackageTransferV2(input);
  input.organizationId = 'org_mutated';
  input.generation = 2;
  files[0]!.path = 'mutated';
  files[0]!.contentBase64 = '';
  assert.deepEqual(plan.index.files.map(row => row.path), original.map(row => row.path));
  const consumer = receiver(plan);
  plan.chunks.forEach(chunk => consumer.accept(chunk));
  assert.deepEqual(consumer.finish(), original);
  plan.index.files[0]!.path = 'plan-mutated';
  assert.equal(files[0]!.path, 'mutated');
});

test('v2 snapshots receiver index, expectation and accepted chunks against later mutations', () => {
  const files = smallFiles();
  const plan = planRepositoryPackageTransferV2({ ...scope, files });
  const expectation = expected(plan);
  const consumer = receiveUnsafe(plan.index, expectation);
  const chunks = structuredClone(plan.chunks);
  plan.index.files[0]!.path = 'changed';
  plan.index.files[0]!.chunkHashes[0] = 'sha256:' + '0'.repeat(64);
  plan.index.organizationId = 'org_changed';
  expectation.expectedIndexHash = 'sha256:' + '0'.repeat(64);
  for (const chunk of chunks) {
    consumer.accept(chunk);
    chunk.contentBase64 = '';
    chunk.indexHash = 'sha256:' + '0'.repeat(64);
  }
  assert.deepEqual(consumer.finish(), files);
  const first = consumer.finish()!;
  first[0]!.path = 'returned-mutated';
  first[0]!.contentBase64 = '';
  first.push(file('extra', Buffer.alloc(0)));
  assert.deepEqual(consumer.finish(), files);
});

test('v2 rejects arbitrary extra nonce, URL, authority and serialization hooks', () => {
  let calls = 0;
  const plan = planRepositoryPackageTransferV2({ ...scope, files: smallFiles() });
  for (const key of ['nonce', 'url', 'token', 'authority', 'toJSON']) {
    const extra = { [key]: key === 'toJSON' ? () => { calls++; return {}; } : 'extra' };
    assert.throws(() => planUnsafe({ ...scope, files: smallFiles(), ...extra }));
    assert.throws(() => receiveUnsafe({ ...plan.index, ...extra }, expected(plan)));
    assert.throws(() => receiveUnsafe(plan.index, { ...expected(plan), ...extra }));
    assert.throws(() => receiver(plan).accept({ ...plan.chunks[0], ...extra }));
  }
  assert.throws(() => planUnsafe({ ...scope, files: [{ ...smallFiles()[0], nonce: 'extra' }] }));
  assert.equal(calls, 0);
});

for (const path of ['../escape', '/absolute', 'C:/drive', 'skills\\escape', '.git/config', 'skills/.env',
  'skills/secrets', 'skills/CON', 'skills/com1.txt', 'skills/trailing.', 'skills/trailing ',
  'skills//empty', 'skills/./alias', 'skills/<invalid', 'skills/>invalid', 'skills/"invalid',
  'skills/|invalid', 'skills/?invalid', 'skills/*invalid', 'skills/\u0000', 'skills/\ud800',
  'skills/cafe\u0301', 'a'.repeat(501)]) {
  test('v2 rejects unsafe portable path ' + JSON.stringify(path), () => {
    assert.throws(() => planRepositoryPackageTransferV2({ ...scope, files: [file(path, Buffer.from('a'))] }));
    const plan = planRepositoryPackageTransferV2({ ...scope, files: smallFiles() });
    const index = structuredClone(plan.index);
    index.files[0]!.path = path;
    assert.throws(() => receiveUnsafe(index, repin(index)));
  });
}

test('v2 rejects case-folded aliases and file-ancestor collisions in either input order', () => {
  for (const paths of [['skills/A', 'skills/a'], ['skills/task', 'skills/task/file'],
    ['skills/TASK/file', 'skills/task']]) {
    const files = paths.map(path => file(path, Buffer.from('a')));
    assert.throws(() => planRepositoryPackageTransferV2({ ...scope, files }));
    assert.throws(() => planRepositoryPackageTransferV2({ ...scope, files: [...files].reverse() }));
    const plan = planRepositoryPackageTransferV2({ ...scope,
      files: [file('one', Buffer.from('a')), file('two', Buffer.from('a'))] });
    const index = structuredClone(plan.index);
    index.files.forEach((row, position) => { row.path = paths[position]!; });
    assert.throws(() => receiveUnsafe(index, repin(index)));
  }
});

test('v2 accepts normalized portable Unicode and the exact 500-character path limit', () => {
  const files = [file('skills/caf\u00e9/file', Buffer.from('a')),
    file('a'.repeat(249) + '/' + 'b'.repeat(250), Buffer.alloc(0))];
  const plan = planRepositoryPackageTransferV2({ ...scope, files });
  const consumer = receiver(plan);
  plan.chunks.forEach(chunk => consumer.accept(chunk));
  assert.deepEqual(consumer.finish(), files);
});

test('v2 rejects accessors across source, scope, index, expected pin and chunk without invocation', () => {
  let calls = 0;
  const accessor = <T extends object>(value: T, key: keyof T) => {
    const copy = { ...value };
    Object.defineProperty(copy, key, { enumerable: true, get() { calls++; return value[key]; } });
    return copy;
  };
  assert.throws(() => planUnsafe(accessor({ ...scope, files: smallFiles() }, 'organizationId')));
  assert.throws(() => planUnsafe({ ...scope, files: [accessor(smallFiles()[0]!, 'contentBase64')] }));
  const plan = planRepositoryPackageTransferV2({ ...scope, files: smallFiles() });
  assert.throws(() => receiveUnsafe(accessor(plan.index, 'files'), expected(plan)));
  const index = structuredClone(plan.index);
  index.files[0] = accessor(index.files[0]!, 'chunkHashes');
  assert.throws(() => receiveUnsafe(index, expected(plan)));
  assert.throws(() => receiveUnsafe(plan.index, accessor(expected(plan), 'expectedIndexHash')));
  assert.throws(() => receiver(plan).accept(accessor(plan.chunks[0]!, 'contentBase64')));
  assert.equal(calls, 0);
});

test('v2 rejects proxies at every boundary without triggering reflection traps', () => {
  let calls = 0;
  const proxy = <T extends object>(value: T) => new Proxy(value, {
    get() { calls++; throw new Error('Proxy get executed.'); },
    ownKeys() { calls++; throw new Error('Proxy reflection executed.'); },
    getPrototypeOf() { calls++; throw new Error('Proxy prototype executed.'); },
  });
  assert.throws(() => planUnsafe(proxy({ ...scope, files: smallFiles() })));
  assert.throws(() => planUnsafe({ ...scope, files: proxy(smallFiles()) }));
  assert.throws(() => planUnsafe({ ...scope, files: [proxy(smallFiles()[0]!)] }));
  const plan = planRepositoryPackageTransferV2({ ...scope, files: smallFiles() });
  assert.throws(() => receiveUnsafe(proxy(plan.index), expected(plan)));
  assert.throws(() => receiveUnsafe({ ...plan.index, files: proxy(plan.index.files) }, expected(plan)));
  assert.throws(() => receiveUnsafe({ ...plan.index, files: [proxy(plan.index.files[0]!)] }, expected(plan)));
  const index = structuredClone(plan.index);
  index.files[0]!.chunkHashes = proxy(index.files[0]!.chunkHashes);
  assert.throws(() => receiveUnsafe(index, expected(plan)));
  assert.throws(() => receiveUnsafe(plan.index, proxy(expected(plan))));
  assert.throws(() => receiver(plan).accept(proxy(plan.chunks[0]!)));
  assert.equal(calls, 0);
});

test('v2 rejects sparse, extended and accessor arrays without executing hooks', () => {
  let calls = 0;
  const ordinary = smallFiles()[0]!;
  const hooked = [ordinary];
  Object.defineProperty(hooked, 'map', { get() { calls++; return Array.prototype.map; } });
  const accessor = [ordinary];
  Object.defineProperty(accessor, '0', { enumerable: true, get() { calls++; return ordinary; } });
  for (const files of [new Array(1), hooked, accessor]) {
    assert.throws(() => planUnsafe({ ...scope, files }));
  }
  const plan = planRepositoryPackageTransferV2({ ...scope, files: smallFiles() });
  assert.throws(() => receiveUnsafe({ ...plan.index, files: new Array(1) }, expected(plan)));
  const index = structuredClone(plan.index);
  index.files[0]!.chunkHashes = new Array(1);
  assert.throws(() => receiveUnsafe(index, expected(plan)));
  const hashes = structuredClone(plan.index.files[0]!.chunkHashes);
  Object.defineProperty(hashes, '0', { enumerable: true, get() { calls++; return plan.index.files[0]!.chunkHashes[0]; } });
  const indexed = structuredClone(plan.index);
  indexed.files[0]!.chunkHashes = hashes;
  assert.throws(() => receiveUnsafe(indexed, expected(plan)));
  assert.equal(calls, 0);
});

test('v2 rejects hidden, symbolic and exotic prototype records', () => {
  const ordinary = smallFiles()[0]!;
  const hidden = { ...ordinary };
  Object.defineProperty(hidden, 'extra', { value: 'hidden' });
  for (const row of [hidden, { ...ordinary, [Symbol('extra')]: 'extra' },
    Object.assign(Object.create(null), ordinary), Object.assign(Object.create({}), ordinary)]) {
    assert.throws(() => planUnsafe({ ...scope, files: [row] }));
  }
  const plan = planRepositoryPackageTransferV2({ ...scope, files: smallFiles() });
  assert.throws(() => receiveUnsafe(Object.assign(Object.create(null), plan.index), expected(plan)));
  assert.throws(() => receiveUnsafe(plan.index, Object.assign(Object.create(null), expected(plan))));
  assert.throws(() => receiver(plan).accept(Object.assign(Object.create(null), plan.chunks[0])));
});

test('v2 rejects digest coercion hooks without invocation', () => {
  let calls = 0;
  const plan = planRepositoryPackageTransferV2({ ...scope, files: smallFiles() });
  const object = { [Symbol.toPrimitive]() { calls++; return plan.indexHash; } };
  assert.throws(() => receiveUnsafe(plan.index, { ...scope, expectedIndexHash: object }));
  assert.throws(() => receiver(plan).accept({ ...plan.chunks[0], indexHash: object }));
  assert.throws(() => planUnsafe({ ...scope, files: [{ ...smallFiles()[0], sha256: object }] }));
  assert.equal(calls, 0);
});

test('v2 rejects primitive, array and malformed record shapes', () => {
  const plan = planRepositoryPackageTransferV2({ ...scope, files: smallFiles() });
  for (const value of [null, undefined, true, 1, 'transfer', []]) {
    assert.throws(() => planUnsafe(value));
    assert.throws(() => receiveUnsafe(value, expected(plan)));
    assert.throws(() => receiveUnsafe(plan.index, value));
    assert.throws(() => receiver(plan).accept(value));
  }
  for (const schema of ['dharma.repository-package-transfer/v1', 'dharma.repository-package-transfer/v2\n', 'other']) {
    const index = { ...plan.index, schema };
    assert.throws(() => receiveUnsafe(index, repin(index)));
  }
  for (const schema of ['dharma.repository-package-chunk/v1', 'dharma.repository-package-chunk/v2\n', 'other']) {
    assert.throws(() => receiver(plan).accept({ ...plan.chunks[0], schema }));
  }
});
