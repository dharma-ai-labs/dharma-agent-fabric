import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { compareSnapshotManifest } from './mcp-catalog-drift.mjs';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';

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

test('overflow cannot turn invalid raw schema evidence into a compatible rewritten manifest', t => {
  const ws = workspace(t);
  const targetName = good.snapshots[0].tools[0].name;
  const snapshots = good.snapshots.map(snapshot => {
    const value = clone(snapshot);
    value.tools.find(tool => tool.name === targetName).inputSchema = { const: 'SYNTHETIC_OVERFLOW_NUMBER' };
    return JSON.stringify(value).replace('"SYNTHETIC_OVERFLOW_NUMBER"', '1e400');
  });
  const original = { ...clone(good), snapshots: snapshots.map(value => JSON.parse(value)) };
  assert.equal(compareSnapshotManifest(original, fixtures.reference).verdict, 'invalid');
  const args = [...expectedArgs, ...snapshots.flatMap((value, index) => ['--snapshot', ws.file(`overflow-${index}.json`, value)])];
  const result = run(args);
  if (result.status === 0) {
    const rewritten = compareSnapshotManifest(JSON.parse(result.stdout), fixtures.reference);
    assert.fail(`Invalid numeric evidence was rewritten; comparator verdict became ${rewritten.verdict}`);
  }
  assert.equal(result.error, undefined);
  assert.equal(result.status, 2);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, 'snapshot_assembly_invalid\n');
});

test('non-finite JSON numbers are rejected recursively, including arrays and ignored documentation', t => {
  const ws = workspace(t);
  for (const [index, schema] of [
    { enum: ['SYNTHETIC_OVERFLOW_NUMBER'] },
    { type: 'object', properties: { x: { const: 'SYNTHETIC_OVERFLOW_NUMBER' } } },
    { type: 'string', examples: [{ nested: ['SYNTHETIC_OVERFLOW_NUMBER'] }] },
  ].entries()) {
    const snapshot = clone(good.snapshots[0]);
    snapshot.tools[0].outputSchema = schema;
    const raw = JSON.stringify(snapshot).replace('"SYNTHETIC_OVERFLOW_NUMBER"', '-1e400');
    rejected([...expectedArgs, '--snapshot', ws.file(`nested-overflow-${index}.json`, raw)], 'snapshot_assembly_invalid');
  }
});

test('large finite numbers and overflow-looking strings retain their actual JSON values', t => {
  const snapshot = clone(good.snapshots[0]);
  snapshot.tools[0].inputSchema = { const: 1e300, examples: ['1e400', '-1e400'] };
  const { manifest } = assembled(['--snapshot', workspace(t).file('finite.json', snapshot)]);
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

// R527: optional unsigned raw-input integrity sidecar. A match is structural
// byte integrity only; it never adds provenance, authenticity or observation.
const SIDECAR_SCHEMA = 'dharma.mcp-snapshot-input-integrity/v1';
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const sidecarFor = buffers => ({ schema: SIDECAR_SCHEMA, inputs: buffers.map(bytes => ({ sha256: sha256(bytes), bytes: bytes.length })) });
const SIDECAR_CANARY = 'PRIVATE_SIDECAR_CANARY_KEY_AND_VALUE';
function rawFile(ws, name, bytes) {
  const path = join(ws.dir, name);
  writeFileSync(path, bytes);
  return path;
}
function rejectedQuietly(args, code) {
  const result = run(args);
  assert.equal(result.error, undefined);
  assert.equal(result.status, 2, result.stderr);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, `${code}\n`);
  assert.equal(result.stderr.includes(SIDECAR_CANARY), false);
}
const helper = () => import('./mcp-snapshot-provenance.mjs');

test('absent sidecar flag keeps the exact default output bytes', t => {
  const ws = workspace(t);
  const args = good.snapshots.flatMap((snapshot, index) => ['--snapshot', ws.file(`d${index}.json`, snapshot)]);
  assert.equal(assembled(args).result.stdout, `${JSON.stringify(good)}\n`);
});

test('matching sidecar is a byte-identical structural precondition, not an upgrade', t => {
  const ws = workspace(t);
  const buffers = good.snapshots.map(snapshot => Buffer.from(JSON.stringify(snapshot)));
  const paths = buffers.map((bytes, index) => rawFile(ws, `m${index}.json`, bytes));
  const args = paths.flatMap(path => ['--snapshot', path]);
  const plain = assembled(args).result.stdout;
  const sidecar = ws.file('sidecar.json', sidecarFor(buffers));
  assert.equal(assembled([...args, '--snapshot-sidecar', sidecar]).result.stdout, plain);
  const empty = ws.file('empty-sidecar.json', sidecarFor([]));
  assert.equal(assembled(['--snapshot-sidecar', empty]).result.stdout, assembled([]).result.stdout);
});

test('tampered or resized input fails closed with no stdout', t => {
  const ws = workspace(t);
  const bytes = Buffer.from(JSON.stringify(good.snapshots[0]));
  const path = rawFile(ws, 'tamper.json', bytes);
  const tampered = Buffer.from(bytes);
  tampered[tampered.length - 2] = tampered[tampered.length - 2] === 0x5d ? 0x5d : tampered[tampered.length - 2];
  const wrongHash = sidecarFor([bytes]);
  wrongHash.inputs[0].sha256 = sha256(Buffer.concat([bytes, Buffer.from(' ')]));
  rejectedQuietly([...expectedArgs, '--snapshot', path, '--snapshot-sidecar', ws.file('h.json', wrongHash)], 'snapshot_input_integrity_mismatch');
  const wrongBytes = sidecarFor([bytes]);
  wrongBytes.inputs[0].bytes += 1;
  rejectedQuietly([...expectedArgs, '--snapshot', path, '--snapshot-sidecar', ws.file('b.json', wrongBytes)], 'snapshot_input_integrity_mismatch');
});

test('raw bytes are hashed: LF, CRLF+BOM and whitespace variants are distinct', t => {
  const ws = workspace(t);
  const text = JSON.stringify(good.snapshots[0], null, 2);
  const variants = [Buffer.from(text), Buffer.from(`﻿${text.replace(/\n/g, '\r\n')}`), Buffer.from(`${text} \n`)];
  assert.equal(new Set(variants.map(sha256)).size, 3);
  const paths = variants.map((bytes, index) => rawFile(ws, `v${index}.json`, bytes));
  const outputs = paths.map((path, index) => assembled(['--snapshot', path,
    '--snapshot-sidecar', ws.file(`vs${index}.json`, sidecarFor([variants[index]]))]).result.stdout);
  assert.equal(new Set(outputs).size, 1, 'parsed content is identical, so output is identical');
  const lfSidecar = ws.file('lf.json', sidecarFor([variants[0]]));
  rejectedQuietly([...expectedArgs, '--snapshot', paths[1], '--snapshot-sidecar', lfSidecar], 'snapshot_input_integrity_mismatch');
  rejectedQuietly([...expectedArgs, '--snapshot', paths[2], '--snapshot-sidecar', lfSidecar], 'snapshot_input_integrity_mismatch');
});

test('sidecar count, order and duplicate-file handling', t => {
  const ws = workspace(t);
  const [a, b] = [good.snapshots[0], good.snapshots[1]].map(snapshot => Buffer.from(JSON.stringify(snapshot)));
  const [pa, pb] = [rawFile(ws, 'a.json', a), rawFile(ws, 'b.json', b)];
  rejectedQuietly([...expectedArgs, '--snapshot', pa, '--snapshot', pb, '--snapshot-sidecar', ws.file('one.json', sidecarFor([a]))], 'snapshot_sidecar_invalid');
  rejectedQuietly([...expectedArgs, '--snapshot', pa, '--snapshot-sidecar', ws.file('two.json', sidecarFor([a, b]))], 'snapshot_sidecar_invalid');
  rejectedQuietly([...expectedArgs, '--snapshot', pa, '--snapshot', pb, '--snapshot-sidecar', ws.file('swap.json', sidecarFor([b, a]))], 'snapshot_input_integrity_mismatch');
  const { manifest } = assembled(['--snapshot', pa, '--snapshot', pa, '--snapshot-sidecar', ws.file('dup.json', sidecarFor([a, a]))]);
  assert.equal(manifest.snapshots.length, 2);
  assert.ok(compareSnapshotManifest(manifest, fixtures.reference).manifestErrors.includes('duplicate_boundary'));
});

test('closed sidecar schema rejects extra, private and invalid fields without echo', t => {
  const ws = workspace(t);
  const bytes = Buffer.from(JSON.stringify(good.snapshots[0]));
  const path = rawFile(ws, 's.json', bytes);
  const base = () => sidecarFor([bytes]);
  const mutations = [
    s => { s[SIDECAR_CANARY] = SIDECAR_CANARY; },
    s => { s.inputs[0][SIDECAR_CANARY] = SIDECAR_CANARY; },
    s => { s.inputs[0].path = SIDECAR_CANARY; },
    s => { s.identity = SIDECAR_CANARY; },
    s => { s.observed = true; },
    s => { s.schema = 'dharma.mcp-snapshot-provenance/v1'; },
    s => { s.inputs[0].sha256 = s.inputs[0].sha256.toUpperCase(); },
    s => { s.inputs[0].sha256 = s.inputs[0].sha256.slice(1); },
    s => { s.inputs[0].bytes = -1; },
    s => { s.inputs[0].bytes = 1.5; },
    s => { s.inputs[0].bytes = String(s.inputs[0].bytes); },
    s => { delete s.inputs[0].bytes; },
    s => { delete s.inputs; },
    s => { s.inputs = {}; },
  ];
  for (const [index, mutate] of mutations.entries()) {
    const sidecar = base();
    mutate(sidecar);
    rejectedQuietly([...expectedArgs, '--snapshot', path, '--snapshot-sidecar', ws.file(`neg${index}.json`, sidecar)], 'snapshot_sidecar_invalid');
  }
  const tooMany = { schema: SIDECAR_SCHEMA, inputs: Array.from({ length: 33 }, () => base().inputs[0]) };
  rejectedQuietly([...expectedArgs, '--snapshot', path, '--snapshot-sidecar', ws.file('33.json', tooMany)], 'snapshot_sidecar_invalid');
});

test('sidecar file discipline: missing, directory, UTF-8, JSON, non-finite, oversize and flag misuse', t => {
  const ws = workspace(t);
  const bytes = Buffer.from(JSON.stringify(good.snapshots[0]));
  const path = rawFile(ws, 'f.json', bytes);
  const good1 = JSON.stringify(sidecarFor([bytes]));
  const cases = [
    [join(ws.dir, `missing-${SIDECAR_CANARY}.json`), 'snapshot_sidecar_unreadable'],
    [ws.dir, 'snapshot_sidecar_unreadable'],
    [rawFile(ws, 'bad-utf8.json', Buffer.from([0xc3, 0x28])), 'snapshot_sidecar_unreadable'],
    [ws.file(`malformed-${SIDECAR_CANARY}.json`, `{"${SIDECAR_CANARY}":`), 'snapshot_sidecar_unreadable'],
    [ws.file('oversize.json', `${good1}${' '.repeat(64 * 1024)}`), 'snapshot_sidecar_unreadable'],
    [ws.file('nonfinite.json', good1.replace(/"bytes":\d+/, '"bytes":1e400')), 'snapshot_sidecar_invalid'],
  ];
  for (const [sidecar, code] of cases) rejectedQuietly([...expectedArgs, '--snapshot', path, '--snapshot-sidecar', sidecar], code);
  const ok = ws.file('ok.json', good1);
  rejectedQuietly([...expectedArgs, '--snapshot', path, '--snapshot-sidecar', ok, '--snapshot-sidecar', ok], 'snapshot_assembly_arguments_invalid');
  rejectedQuietly([...expectedArgs, '--snapshot', path, '--snapshot-sidecar'], 'snapshot_assembly_arguments_invalid');
});

test('sidecar budget is independent of the unchanged 1 MiB aggregate input and output limits', t => {
  const ws = workspace(t);
  const snapshot = { boundary: 'source', provenance: { observed: true, identity: 'a', version: '1' },
    tools: [{ name: 'a', description: 'x'.repeat(1_000_000) }] };
  const bytes = Buffer.from(JSON.stringify(snapshot));
  assert.ok(bytes.length > 1024 * 1024 - 60_000 && bytes.length < 1024 * 1024);
  const padded = ws.file('padded.json', `${JSON.stringify(sidecarFor([bytes]))}${' '.repeat(60_000)}`);
  const result = run(['--expected-identity', 'a', '--expected-version', '1', '--snapshot', rawFile(ws, 'big.json', bytes), '--snapshot-sidecar', padded]);
  assert.equal(result.status, 0, result.stderr);
  const big = clone(good.snapshots[0]);
  big.tools[0].description = '\u0000'.repeat(100_000);
  const bigBytes = Buffer.from(JSON.stringify(big));
  const bigPath = rawFile(ws, 'agg.json', bigBytes);
  rejectedQuietly([...expectedArgs, '--snapshot', bigPath, '--snapshot', bigPath,
    '--snapshot-sidecar', ws.file('agg-sidecar.json', sidecarFor([bigBytes, bigBytes]))], 'snapshot_input_unreadable');
});

test('integrity match never repairs comparator INVALID/UNKNOWN or partial evidence', t => {
  const ws = workspace(t);
  const cases = [
    [s => { s.provenance.identity = 'different'; }, 'invalid'],
    [s => { s.provenance.observed = false; }, 'unknown'],
    [s => { s.tools = null; }, 'unknown'],
  ];
  for (const [index, [mutate, verdict]] of cases.entries()) {
    const snapshot = clone(good.snapshots[0]);
    mutate(snapshot);
    const bytes = Buffer.from(JSON.stringify(snapshot));
    const path = rawFile(ws, `c${index}.json`, bytes);
    const plain = assembled(['--snapshot', path]).manifest;
    const withSidecar = assembled(['--snapshot', path, '--snapshot-sidecar', ws.file(`cs${index}.json`, sidecarFor([bytes]))]).manifest;
    assert.deepEqual(withSidecar, plain);
    const receipt = compareSnapshotManifest(withSidecar, fixtures.reference);
    assert.equal(receipt.verdict, verdict);
    assert.equal(receipt.boundaries.filter(item => item.reasons.includes('not_supplied')).length, 4);
  }
});

test('each input and the sidecar are opened exactly once, never re-read, and every descriptor is closed', t => {
  const ws = workspace(t);
  const bytes = Buffer.from(JSON.stringify(good.snapshots[0]));
  const path = rawFile(ws, 'once.json', bytes);
  const countFile = join(ws.dir, 'counts.out');
  const preload = `import fs from 'node:fs'; import { syncBuiltinESMExports } from 'node:module';
const counts = { open: {}, readFile: [], close: 0 }; const o = fs.openSync, c = fs.closeSync, r = fs.readFileSync, w = fs.writeFileSync;
fs.openSync = (p, ...a) => { const k = String(p); counts.open[k] = (counts.open[k] || 0) + 1; return o(p, ...a); };
fs.closeSync = fd => { counts.close++; return c(fd); };
fs.readFileSync = (p, ...a) => { if (typeof p === 'string') counts.readFile.push(p); return r(p, ...a); };
syncBuiltinESMExports(); process.on('exit', () => w(process.env.FS_COUNT_FILE, JSON.stringify(counts)));`;
  const runCounted = args => spawnSync(process.execPath, ['--import', `data:text/javascript,${encodeURIComponent(preload)}`, script, ...expectedArgs, ...args], {
    cwd: root, encoding: 'utf8', timeout: 10_000, env: { ...process.env, FS_COUNT_FILE: countFile },
  });
  const sidecarPath = ws.file('once-sidecar.json', sidecarFor([bytes]));
  for (const [args, status] of [[['--snapshot', path, '--snapshot', path, '--snapshot-sidecar', sidecarPath], 2],
    [['--snapshot', path, '--snapshot-sidecar', sidecarPath], 0]]) {
    const result = runCounted(args);
    assert.equal(result.status, status, result.stderr);
    const counts = JSON.parse(readFileSync(countFile, 'utf8'));
    const opens = Object.values(counts.open).reduce((sum, value) => sum + value, 0);
    assert.equal(counts.open[resolve(sidecarPath)], 1);
    assert.equal(counts.open[resolve(path)], args.filter(item => item === path).length);
    assert.equal(counts.readFile.includes(resolve(path)) || counts.readFile.includes(resolve(sidecarPath)), false);
    assert.equal(counts.close, opens, 'every opened descriptor is closed, including the failure path');
  }
});

test('leaf-symlink sidecar is not followed; FIFO race is an explicit platform skip', t => {
  const ws = workspace(t);
  const bytes = Buffer.from(JSON.stringify(good.snapshots[0]));
  const path = rawFile(ws, 'l.json', bytes);
  const target = ws.file('real-sidecar.json', sidecarFor([bytes]));
  const link = join(ws.dir, 'sidecar-link.json');
  try { symlinkSync(target, link); } catch (error) {
    if (process.platform === 'win32' && ['EPERM', 'EACCES'].includes(error.code)) {
      t.skip('Windows symlink creation requires a privilege unavailable to this synthetic fixture');
      return;
    }
    throw error;
  }
  rejectedQuietly([...expectedArgs, '--snapshot', path, '--snapshot-sidecar', link], 'snapshot_sidecar_unreadable');
});

test('FIFO sidecar race fixture', t => {
  t.skip('Creating a FIFO needs mkfifo, which this offline builtin-only suite does not spawn; O_NONBLOCK and fstat regular-file checks are shared with snapshot reads');
});

test('pure helper verifies exact byte buffers and never invokes accessors or conversions', async () => {
  const { verifySnapshotInputIntegrity, SNAPSHOT_INPUT_INTEGRITY_SCHEMA } = await helper();
  assert.equal(SNAPSHOT_INPUT_INTEGRITY_SCHEMA, SIDECAR_SCHEMA);
  const bytes = Buffer.from('{"a":1}\r\n');
  const sidecar = sidecarFor([bytes]);
  assert.deepEqual(verifySnapshotInputIntegrity(sidecar, [bytes]), { ok: true, inputCount: 1 });
  assert.deepEqual(verifySnapshotInputIntegrity(sidecar, [new Uint8Array(bytes)]), { ok: true, inputCount: 1 });
  assert.deepEqual(verifySnapshotInputIntegrity(sidecarFor([]), []), { ok: true, inputCount: 0 });
  assert.deepEqual(verifySnapshotInputIntegrity(sidecar, [Buffer.from('{"a":1}\n')]), { ok: false, code: 'snapshot_input_integrity_mismatch' });
  let touched = 0;
  const getterInput = new Uint8Array(bytes);
  Object.defineProperty(getterInput, 'byteLength', { get() { touched++; return 0; } });
  const getterSidecar = { schema: SIDECAR_SCHEMA };
  Object.defineProperty(getterSidecar, 'inputs', { enumerable: true, get() { touched++; return sidecar.inputs; } });
  class Sub extends Uint8Array {}
  const badInputs = [[bytes.toString('utf8')], [Array.from(bytes)], [bytes.buffer], [new Proxy(bytes, {})],
    [new Sub(bytes)], [getterInput], new Proxy([bytes], {}), [{ toJSON() { touched++; return bytes; } }], 'not-array'];
  for (const raw of badInputs) {
    assert.deepEqual(verifySnapshotInputIntegrity(sidecar, raw), { ok: false, code: 'snapshot_input_integrity_inputs_invalid' });
  }
  for (const bad of [getterSidecar, new Proxy(sidecar, {}), null, { ...sidecar, [SIDECAR_CANARY]: SIDECAR_CANARY },
    { schema: SIDECAR_SCHEMA, inputs: [{ sha256: sidecar.inputs[0].sha256, bytes: Number.POSITIVE_INFINITY }] }]) {
    const result = verifySnapshotInputIntegrity(bad, [bytes]);
    assert.deepEqual(result, { ok: false, code: 'snapshot_sidecar_invalid' });
    assert.equal(JSON.stringify(result).includes(SIDECAR_CANARY), false);
  }
  assert.deepEqual(verifySnapshotInputIntegrity(sidecar, [bytes, bytes]), { ok: false, code: 'snapshot_sidecar_invalid' });
  assert.equal(touched, 0, 'no accessor or toJSON was invoked');
});

test('raw input count cap rejects before inspecting entries', async () => {
  const { verifySnapshotInputIntegrity } = await helper();
  const emptySidecar = sidecarFor([]);
  assert.deepEqual(verifySnapshotInputIntegrity(emptySidecar, []), { ok: true, inputCount: 0 });
  for (const bytes of [Buffer.from('x'), new Uint8Array([120])]) {
    const overLimit = Array.from({ length: 33 }, () => bytes);
    const getDescriptor = Object.getOwnPropertyDescriptor;
    let entryReads = 0;
    Object.getOwnPropertyDescriptor = (target, key) => {
      if (target === overLimit && key !== 'length') entryReads++;
      return getDescriptor(target, key);
    };
    try {
      assert.deepEqual(verifySnapshotInputIntegrity(emptySidecar, overLimit),
        { ok: false, code: 'snapshot_input_integrity_inputs_invalid' });
      assert.equal(entryReads, 0, 'reject the array length before copying or inspecting any entry');
    } finally {
      Object.getOwnPropertyDescriptor = getDescriptor;
    }
    const atLimit = Array.from({ length: 32 }, () => bytes);
    assert.deepEqual(verifySnapshotInputIntegrity(sidecarFor(atLimit), atLimit), { ok: true, inputCount: 32 });
  }
});

test('sidecar schema is a closed 2020-12 contract under the strict Ajv consumer', () => {
  const schema = JSON.parse(readFileSync(join(root, 'schemas/mcp-snapshot-provenance.schema.json'), 'utf8'));
  assert.equal(schema.$schema, 'https://json-schema.org/draft/2020-12/schema');
  assert.equal(schema.additionalProperties, false);
  assert.equal(schema.properties.schema.const, SIDECAR_SCHEMA);
  const require = createRequire(import.meta.url);
  const Ajv2020 = require('ajv/dist/2020.js').default;
  const validate = new Ajv2020({ allErrors: true, strict: true, strictRequired: false }).compile(schema);
  assert.equal(validate(sidecarFor([Buffer.from('x')])), true);
  assert.equal(validate({ ...sidecarFor([]), issuer: 'x' }), false);
});
