import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  planRepositoryPackageTransfer,
  createRepositoryPackageTransferReceiver,
  REPOSITORY_PACKAGE_TRANSFER_LIMITS,
} from './repositoryPackageTransfer.js';

const scope = { organizationId: 'org_fixture', repositoryAgentId: 'repo_fixture',
  releaseId: 'release_fixture', gitCommit: 'a'.repeat(40) };
const digest = (bytes: Uint8Array) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const file = (path: string, bytes: Uint8Array) => ({ path, contentBase64: Buffer.from(bytes).toString('base64'),
  sha256: digest(bytes), sizeBytes: bytes.length });
const receiver = (plan: ReturnType<typeof planRepositoryPackageTransfer>) =>
  createRepositoryPackageTransferReceiver(plan.index, { ...scope, expectedIndexHash: plan.indexHash });

test('complete byte transfer preserves 129 files and binary bytes', () => {
  const files = Array.from({ length: 129 }, (_, index) => file(`skills/example/companion-${index}.bin`,
    Buffer.from([0, 255, index, 13, 10])));
  const plan = planRepositoryPackageTransfer({ ...scope, files });
  const consumer = receiver(plan);
  assert.equal(consumer.finish(), null);
  for (const chunk of [...plan.chunks].reverse()) consumer.accept(chunk);
  const result = consumer.finish()!;
  assert.equal(result.length, 129);
  assert.deepEqual(result.map(row => row.sha256), files.map(row => row.sha256));
  assert.deepEqual(Buffer.from(result[128]!.contentBase64, 'base64'), Buffer.from([0, 255, 128, 13, 10]));
});

test('complete transfer exceeds 1 MiB without truncation and checks raw byte limit', () => {
  const files = Array.from({ length: 17 }, (_, index) => file(`skills/large/${index}.bin`, Buffer.alloc(65_537, index)));
  const plan = planRepositoryPackageTransfer({ ...scope, files });
  assert.ok(plan.index.totalBytes > 1_048_576);
  assert.ok(plan.chunks.every(chunk => Buffer.from(chunk.contentBase64, 'base64').length <= 65_536));
  const consumer = receiver(plan);
  plan.chunks.forEach(chunk => consumer.accept(chunk));
  assert.deepEqual(consumer.finish(), files);
});

test('missing chunks stay pending; exact duplicates are idempotent; changed chunks reject', () => {
  const plan = planRepositoryPackageTransfer({ ...scope, files: [file('skills/task/payload.bin', Buffer.alloc(65_537, 7))] });
  const consumer = receiver(plan);
  consumer.accept(plan.chunks[0]);
  consumer.accept(plan.chunks[0]);
  assert.equal(consumer.finish(), null);
  assert.throws(() => consumer.accept({ ...plan.chunks[0], contentBase64: Buffer.from('altered').toString('base64') }));
  consumer.accept(plan.chunks[1]);
  assert.deepEqual(consumer.finish(), [file('skills/task/payload.bin', Buffer.alloc(65_537, 7))]);
});

test('foreign organization, repository, release, commit and index hash reject', () => {
  const plan = planRepositoryPackageTransfer({ ...scope, files: [file('MANIFEST.json', Buffer.from('{}'))] });
  for (const key of ['organizationId', 'repositoryAgentId', 'releaseId', 'gitCommit'] as const) {
    assert.throws(() => createRepositoryPackageTransferReceiver(plan.index, { ...scope,
      [key]: key === 'gitCommit' ? 'b'.repeat(40) : 'foreign', expectedIndexHash: plan.indexHash }));
  }
  assert.throws(() => createRepositoryPackageTransferReceiver(plan.index,
    { ...scope, expectedIndexHash: `sha256:${'0'.repeat(64)}` }));
  const consumer = receiver(plan);
  assert.throws(() => consumer.accept({ ...plan.chunks[0], indexHash: `sha256:${'0'.repeat(64)}` }));
});

test('512-file and 4-MiB exact limits succeed; over-limit packages fail before planning', () => {
  const limits = REPOSITORY_PACKAGE_TRANSFER_LIMITS;
  const files = Array.from({ length: limits.maximumFiles }, (_, index) => file(`skills/task/${index}.bin`, Buffer.alloc(8192)));
  const plan = planRepositoryPackageTransfer({ ...scope, files });
  assert.equal(plan.index.totalBytes, limits.maximumTotalBytes);
  assert.equal(plan.index.files.length, limits.maximumFiles);
  const consumer = receiver(plan);
  plan.chunks.forEach(chunk => consumer.accept(chunk));
  assert.deepEqual(consumer.finish(), files);
  assert.throws(() => planRepositoryPackageTransfer({ ...scope,
    files: [...files, file('skills/task/extra.bin', Buffer.alloc(0))] }));
  assert.throws(() => planRepositoryPackageTransfer({ ...scope, files: files.map((row, index) =>
    index === 0 ? file(row.path, Buffer.alloc(8193)) : row) }));
  assert.throws(() => planRepositoryPackageTransfer({ ...scope,
    files: [file('skills/task/oversize.bin', Buffer.alloc(limits.maximumFileBytes + 1))] }));
});

test('accessors, array hooks, sparse arrays and proxies reject without invocation', () => {
  let calls = 0;
  const ordinary = file('skills/task/a', Buffer.from('a'));
  const accessor = { ...ordinary };
  Object.defineProperty(accessor, 'contentBase64', { enumerable: true, get() { calls++; return 'YQ=='; } });
  assert.throws(() => planRepositoryPackageTransfer({ ...scope, files: [accessor] }));
  const hooked = [ordinary];
  Object.defineProperty(hooked, 'map', { get() { calls++; return Array.prototype.map; } });
  assert.throws(() => planRepositoryPackageTransfer({ ...scope, files: hooked }));
  assert.throws(() => planRepositoryPackageTransfer({ ...scope, files: new Array(1) }));
  const proxy = new Proxy(ordinary, { ownKeys() { calls++; return Reflect.ownKeys(ordinary); } });
  assert.throws(() => planRepositoryPackageTransfer({ ...scope, files: [proxy] }));
  const hidden = { ...ordinary };
  Object.defineProperty(hidden, 'extra', { value: 'hidden' });
  assert.throws(() => planRepositoryPackageTransfer({ ...scope, files: [hidden] }));
  const symbol = { ...ordinary, [Symbol('extra')]: 'hidden' };
  assert.throws(() => planRepositoryPackageTransfer({ ...scope, files: [symbol] }));
  const plan = planRepositoryPackageTransfer({ ...scope, files: [ordinary] });
  plan.index.files[0]!.chunkHashes = new Array(1);
  assert.throws(() => receiver(plan));
  assert.equal(calls, 0);
});

test('trailing-newline identities and digests reject', () => {
  const files = [file('skills/task/a', Buffer.from('a'))];
  for (const key of ['organizationId', 'repositoryAgentId', 'releaseId', 'gitCommit'] as const) {
    assert.throws(() => planRepositoryPackageTransfer({ ...scope, [key]: `${scope[key]}\n`, files }));
  }
  const plan = planRepositoryPackageTransfer({ ...scope, files });
  assert.throws(() => createRepositoryPackageTransferReceiver(plan.index,
    { ...scope, expectedIndexHash: `${plan.indexHash}\n` }));
  plan.index.files[0]!.sha256 += '\n';
  assert.throws(() => receiver(plan));
});

test('prototype pollution cannot make accessor descriptors appear to contain a value', () => {
  let calls = 0;
  const ordinary = file('skills/task/a', Buffer.from('a'));
  const accessor = { ...ordinary };
  Object.defineProperty(accessor, 'contentBase64', { enumerable: true, get() { calls++; return 'YQ=='; } });
  const array = [ordinary];
  Object.defineProperty(array, '0', { enumerable: true, get() { calls++; return ordinary; } });
  const previous = Object.getOwnPropertyDescriptor(Object.prototype, 'value');
  const errors: unknown[] = [];
  try {
    Object.defineProperty(Object.prototype, 'value', { value: 'polluted', configurable: true });
    for (const files of [[accessor], array]) {
      try { planRepositoryPackageTransfer({ ...scope, files }); } catch (error) { errors.push(error); }
    }
  } finally {
    Reflect.deleteProperty(Object.prototype, 'value');
    if (previous) Object.defineProperty(Object.prototype, 'value', previous);
  }
  assert.equal(errors.length, 2);
  assert.equal(calls, 0);
});

test('expected digest objects reject without coercion', () => {
  let calls = 0;
  const plan = planRepositoryPackageTransfer({ ...scope, files: [file('skills/task/a', Buffer.from('a'))] });
  const digestObject = { [Symbol.toPrimitive]() { calls++; return plan.indexHash; } };
  assert.throws(() => createRepositoryPackageTransferReceiver(plan.index,
    { ...scope, expectedIndexHash: digestObject as unknown as string }));
  assert.equal(calls, 0);
});

test('portable paths reject invalid Windows characters and case-folded ancestors', () => {
  const payload = Buffer.from('a');
  for (const path of ['skills/<invalid', 'skills/>invalid', 'skills/"invalid', 'skills/|invalid',
    'skills/?invalid', 'skills/*invalid', 'skills/\ud800']) {
    assert.throws(() => planRepositoryPackageTransfer({ ...scope, files: [file(path, payload)] }), path);
  }
  for (const files of [[file('skills/task', payload), file('skills/task/payload.bin', payload)],
    [file('skills/TASK/payload.bin', payload), file('skills/task', payload)]]) {
    assert.throws(() => planRepositoryPackageTransfer({ ...scope, files }));
  }
  const plan = planRepositoryPackageTransfer({ ...scope, files: [file('skills/caf\u00e9/companion.bin', payload)] });
  const consumer = receiver(plan);
  assert.throws(() => createRepositoryPackageTransferReceiver(plan.index,
    { ...scope, organizationId: 'org_foreign', expectedIndexHash: plan.indexHash }));
  consumer.accept(plan.chunks[0]);
  assert.equal(consumer.finish()![0]!.path, 'skills/caf\u00e9/companion.bin');
});

test('path aliases, escapes, metadata mismatch and noncanonical encodings reject', () => {
  const bytes = Buffer.from('a');
  for (const path of ['../escape', '/absolute', 'C:/drive', 'skills\\escape', '.git/config', 'skills/CON',
    'skills/trailing.', 'skills/trailing ', 'skills//empty', 'skills/./alias', 'skills/.env']) {
    assert.throws(() => planRepositoryPackageTransfer({ ...scope, files: [file(path, bytes)] }), path);
  }
  assert.throws(() => planRepositoryPackageTransfer({ ...scope,
    files: [file('skills/A.md', bytes), file('skills/a.md', bytes)] }));
  assert.throws(() => planRepositoryPackageTransfer({ ...scope,
    files: [{ ...file('skills/task/a', bytes), sizeBytes: 2 }] }));
  assert.throws(() => planRepositoryPackageTransfer({ ...scope,
    files: [{ ...file('skills/task/a', bytes), contentBase64: 'YQ' }] }));
});

test('empty files preserve hashes and returned values cannot mutate receiver state', () => {
  const files = [file('skills/task/empty', Buffer.alloc(0)), file('skills/task/value', Buffer.from('value'))];
  const plan = planRepositoryPackageTransfer({ ...scope, files });
  const consumer = receiver(plan);
  plan.index.files[0]!.path = 'modified';
  plan.chunks.forEach(chunk => consumer.accept(chunk));
  const first = consumer.finish()!;
  first[0]!.path = 'changed';
  assert.deepEqual(consumer.finish(), files);
});
