import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { compareSnapshotManifest } from './mcp-catalog-drift.mjs';

const root = resolve(import.meta.dirname, '..');
const script = join(root, 'scripts/mcp-snapshot-manifest-assemble.mjs');
const fixtures = JSON.parse(readFileSync(join(root, 'scripts/fixtures/mcp-catalog-drift/cases.json'), 'utf8'));
const good = fixtures.cases.compatible;
const clone = value => structuredClone(value);
const expectedArgs = ['--expected-identity', good.expected.identity, '--expected-version', good.expected.version];
const run = args => spawnSync(process.execPath, [script, ...args], {
  cwd: root, encoding: 'utf8', timeout: 10_000, maxBuffer: 2 * 1024 * 1024,
});
function workspace(t) {
  const dir = mkdtempSync(join(tmpdir(), 'mcp-offline-assembly-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return { dir, file(name, value) {
    const path = join(dir, name);
    writeFileSync(path, typeof value === 'string' ? value : JSON.stringify(value));
    return path;
  } };
}
function assembled(args) {
  const result = run([...expectedArgs, ...args]);
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  return { result, manifest: JSON.parse(result.stdout) };
}
function rejected(args, code) {
  const result = run(args);
  assert.equal(result.error, undefined);
  assert.equal(result.status, 2);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, `${code}\n`);
}

test('empty assembly is valid input, not compatibility or observation proof', () => {
  const { manifest } = assembled([]);
  assert.deepEqual(manifest, { schema: good.schema, expected: good.expected, snapshots: [] });
  const receipt = compareSnapshotManifest(manifest, fixtures.reference);
  assert.equal(receipt.verdict, 'unknown');
  assert.ok(receipt.boundaries.every(item => item.reasons.includes('not_supplied')));
  assert.equal(receipt.executionProven, false);
});

test('supplied boundaries, tools and literal versions survive unchanged and deterministically', t => {
  const ws = workspace(t);
  const args = good.snapshots.flatMap((snapshot, index) => ['--snapshot', ws.file(`${index}.json`, snapshot)]);
  const first = assembled(args);
  assert.deepEqual(first.manifest, good);
  assert.equal(assembled(args).result.stdout, first.result.stdout);
  assert.equal(first.result.stdout.includes('\r'), false);
  assert.equal(compareSnapshotManifest(first.manifest, fixtures.reference).verdict, 'compatible');
});

test('partial and explicitly unobserved evidence is never promoted', t => {
  const snapshot = clone(good.snapshots[0]);
  snapshot.provenance.observed = false;
  const { manifest } = assembled(['--snapshot', workspace(t).file('partial.json', snapshot)]);
  assert.deepEqual(manifest.snapshots, [snapshot]);
  const receipt = compareSnapshotManifest(manifest, fixtures.reference);
  assert.equal(receipt.verdict, 'unknown');
  assert.equal(receipt.boundaries.filter(item => item.reasons.includes('not_supplied')).length, 4);
});

test('null tools remain missing evidence rather than an empty captured catalog', t => {
  const snapshot = { ...clone(good.snapshots[0]), tools: null };
  const { manifest } = assembled(['--snapshot', workspace(t).file('missing.json', snapshot)]);
  assert.equal(manifest.snapshots[0].tools, null);
  assert.ok(compareSnapshotManifest(manifest, fixtures.reference).boundaries[0].reasons.includes('tools_missing'));
});

test('duplicate boundaries are not deduplicated or rewritten', t => {
  const path = workspace(t).file('duplicate.json', good.snapshots[0]);
  const { manifest } = assembled(['--snapshot', path, '--snapshot', path]);
  assert.equal(manifest.snapshots.length, 2);
  const receipt = compareSnapshotManifest(manifest, fixtures.reference);
  assert.equal(receipt.verdict, 'invalid');
  assert.ok(receipt.manifestErrors.includes('duplicate_boundary'));
});

test('duplicate tools and identity/version mismatches remain comparator failures', t => {
  const ws = workspace(t);
  for (const kind of ['duplicate', 'identity', 'version']) {
    const snapshot = clone(good.snapshots[0]);
    if (kind === 'duplicate') snapshot.tools.push(clone(snapshot.tools[0]));
    else snapshot.provenance[kind] = 'different';
    const { manifest } = assembled(['--snapshot', ws.file(`${kind}.json`, snapshot)]);
    const receipt = compareSnapshotManifest(manifest, fixtures.reference);
    assert.equal(receipt.verdict, 'invalid');
    assert.ok(receipt.boundaries[0].reasons.includes(kind === 'duplicate' ? 'duplicate_tool' : `${kind}_mismatch`));
  }
});

test('same-name missing metadata is UNKNOWN, while membership drift still dominates', t => {
  const ws = workspace(t);
  const snapshot = clone(good.snapshots[0]);
  snapshot.tools = snapshot.tools.map(tool => ({ name: tool.name }));
  let manifest = assembled(['--snapshot', ws.file('names.json', snapshot)]).manifest;
  assert.equal(compareSnapshotManifest(manifest, fixtures.reference).verdict, 'unknown');
  snapshot.tools.push({ name: 'synthetic_extra' });
  manifest = assembled(['--snapshot', ws.file('extra.json', snapshot)]).manifest;
  assert.equal(compareSnapshotManifest(manifest, fixtures.reference).verdict, 'incompatible');
});

test('unsupported schema evidence is retained and never normalized into compatibility', t => {
  const snapshot = clone(good.snapshots[0]);
  snapshot.tools[0].inputSchema = { anyOf: [{ type: 'null' }, { type: 'string' }] };
  const { manifest } = assembled(['--snapshot', workspace(t).file('unsupported.json', snapshot)]);
  assert.deepEqual(manifest.snapshots[0].tools, snapshot.tools);
  assert.ok(compareSnapshotManifest(manifest, fixtures.reference).boundaries[0].reasons.includes('schema_unsupported'));
});

test('private envelope keys and values never escape failed structural validation', t => {
  const ws = workspace(t);
  const canary = 'PRIVATE_KEY_AND_VALUE_CANARY';
  for (const kind of ['snapshot', 'provenance', 'tool', 'annotation']) {
    const snapshot = clone(good.snapshots[0]);
    const target = kind === 'snapshot' ? snapshot : kind === 'provenance' ? snapshot.provenance
      : kind === 'tool' ? snapshot.tools[0] : snapshot.tools[0].annotations;
    target[canary] = canary;
    rejected([...expectedArgs, '--snapshot', ws.file(`${kind}-${canary}.json`, snapshot)], 'snapshot_assembly_invalid');
  }
});

test('assembler does not pretend to redact allowed documentation or embedded schema content', t => {
  const snapshot = clone(good.snapshots[0]);
  snapshot.tools[0].description = 'SYNTHETIC_ALLOWED_DOCUMENTATION';
  snapshot.tools[0].inputSchema = { type: 'object', properties: { SYNTHETIC_SCHEMA_KEY: { const: 'synthetic' } } };
  const { manifest } = assembled(['--snapshot', workspace(t).file('permitted.json', snapshot)]);
  assert.deepEqual(manifest.snapshots[0], snapshot);
});

test('malformed JSON, invalid UTF-8, directories and missing files have fixed non-echoing diagnostics', t => {
  const ws = workspace(t);
  const malformed = ws.file('PRIVATE_PATH_CANARY.json', '{"PRIVATE_VALUE_CANARY":');
  const invalidUtf8 = join(ws.dir, 'invalid-utf8.json');
  writeFileSync(invalidUtf8, Buffer.from([0xc3, 0x28]));
  for (const path of [malformed, invalidUtf8, ws.dir, join(ws.dir, 'missing-PRIVATE_PATH_CANARY.json')]) {
    rejected([...expectedArgs, '--snapshot', path], 'snapshot_input_unreadable');
  }
});

test('leaf symlink is not followed', t => {
  const ws = workspace(t);
  const target = ws.file('target.json', good.snapshots[0]);
  const link = join(ws.dir, 'link.json');
  try { symlinkSync(target, link); } catch (error) {
    if (process.platform === 'win32' && ['EPERM', 'EACCES'].includes(error.code)) {
      t.skip('Windows symlink creation requires a privilege unavailable to this synthetic fixture');
      return;
    }
    throw error;
  }
  rejected([...expectedArgs, '--snapshot', link], 'snapshot_input_unreadable');
});

test('per-file, aggregate input and emitted-output byte budgets fail closed', t => {
  const ws = workspace(t);
  rejected([...expectedArgs, '--snapshot', ws.file('too-large.json', ' '.repeat(1024 * 1024 + 1))], 'snapshot_input_unreadable');
  const snapshot = clone(good.snapshots[0]);
  snapshot.tools[0].description = '\u0000'.repeat(100_000);
  const path = ws.file('aggregate.json', snapshot);
  rejected([...expectedArgs, '--snapshot', path, '--snapshot', path], 'snapshot_input_unreadable');
  const compact = ws.file('expansion.json', `{"boundary":"source","provenance":{"observed":true,"identity":"a","version":"1"},"tools":[{"name":"a","description":"${'x'.repeat(1024 * 1024 - 150)}"}]}`);
  rejected([...expectedArgs, '--snapshot', compact], 'snapshot_assembly_too_large');
});

test('argument contract rejects incomplete, duplicate, unsupported and excessive input without echo', () => {
  for (const args of [[], ['--expected-identity'], [...expectedArgs, '--snapshot'],
    [...expectedArgs, '--expected-version', 'duplicate'], [...expectedArgs, '--token', 'PRIVATE_CANARY'],
    ['--expected-identity', ' ', '--expected-version', '1'],
    ['--expected-identity', 'a', '--expected-version', 'x'.repeat(201)],
    [...expectedArgs, ...Array.from({ length: 33 }, () => ['--snapshot', 'PRIVATE_CANARY.json']).flat()]]) {
    rejected(args, 'snapshot_assembly_arguments_invalid');
  }
});
