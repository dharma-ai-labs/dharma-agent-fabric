import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { BOUNDARIES, compareSnapshotManifest, referenceFromCatalog } from './mcp-catalog-drift.mjs';

const root = resolve(import.meta.dirname, '..');
const verifier = resolve(root, 'scripts/verify-mcp-catalog.mjs');
const fixture = JSON.parse(readFileSync(resolve(root, 'scripts/fixtures/mcp-catalog-drift/cases.json'), 'utf8'));
const { reference, cases } = fixture;
const clone = value => structuredClone(value);
const byBoundary = (receipt, boundary) => receipt.boundaries.find(item => item.boundary === boundary);
// Apply one mutation to the a_read tool of every boundary in the compatible case.
const mutateAll = (mutate) => {
  const manifest = clone(cases.compatible);
  for (const snapshot of manifest.snapshots) mutate(snapshot.tools.find(tool => tool.name === 'a_read'), snapshot);
  return manifest;
};
const nest = (depth) => { let schema = { type: 'string' }; for (let i = 0; i < depth; i++) schema = { type: 'array', items: schema }; return schema; };
const catalogManifest = () => {
  const catalog = JSON.parse(readFileSync(resolve(root, 'plugins/dharma-agent-fabric/openai-app/mcp-tool-catalog.json'), 'utf8'));
  const tools = catalog.tools.map(tool => ({ name: tool.name, confirmation: tool.confirmation, annotations: tool.annotations,
    inputSchema: { type: 'object' }, outputSchema: { type: 'object' } }));
  return { schema: 'dharma.mcp-snapshot-manifest/v1', expected: { identity: 'dharma-agent-fabric', version: '1.0.0' },
    snapshots: BOUNDARIES.map(boundary => ({ boundary, provenance: { observed: true, identity: 'dharma-agent-fabric', version: '1.0.0' },
      tools: structuredClone(tools) })) };
};
const runVerifier = (manifest) => {
  const dir = mkdtempSync(join(tmpdir(), 'mcp-drift-neg-'));
  try {
    const path = join(dir, 'manifest.json');
    writeFileSync(path, JSON.stringify(manifest));
    return spawnSync(process.execPath, [verifier, '--snapshot-manifest', path], { cwd: root, encoding: 'utf8', timeout: 30_000 });
  } finally { rmSync(dir, { recursive: true, force: true }); }
};

test('F1: a supported constraint difference (minLength 10 vs 1) is a schema mismatch, not equal', () => {
  const manifest = mutateAll((tool, snapshot) => {
    tool.inputSchema.properties.id.minLength = snapshot.boundary === 'source' ? 10 : 1;
  });
  const receipt = compareSnapshotManifest(manifest, reference);
  const released = byBoundary(receipt, 'released');
  assert.equal(released.tools.find(tool => tool.name === 'a_read').inputSchema, 'different');
  assert.equal(receipt.verdict, 'incompatible');
});

test('F1: unsupported schema keywords are UNKNOWN, never silently dropped into equality', () => {
  for (const extra of [{ $ref: '#/$defs/x' }, { allOf: [{ type: 'string' }] }, { oneOf: [{ type: 'string' }] }, { not: { type: 'null' } }]) {
    const manifest = mutateAll(tool => Object.assign(tool.inputSchema.properties.id, structuredClone(extra)));
    const receipt = compareSnapshotManifest(manifest, reference);
    assert.notEqual(receipt.verdict, 'compatible', JSON.stringify(extra));
    assert.ok(byBoundary(receipt, 'host').reasons.includes('schema_unsupported'), JSON.stringify(extra));
  }
});

test('F1: identical malformed or over-depth schemas are INVALID evidence, never a hashable PASS', () => {
  for (const bad of [{ type: 42 }, { type: 'strng' }, { type: 'string', minLength: 'ten' }, { type: 'object', required: [7] }, nest(40)]) {
    const manifest = mutateAll(tool => { tool.inputSchema = structuredClone(bad); });
    const receipt = compareSnapshotManifest(manifest, reference);
    assert.equal(receipt.verdict, 'invalid', JSON.stringify(bad).slice(0, 60));
    assert.ok(byBoundary(receipt, 'server').reasons.includes('schema_malformed'));
  }
});

test('F2: an unknown boolean annotation KEY is never echoed and blocks compatibility', () => {
  const manifest = mutateAll((tool, snapshot) => { if (snapshot.boundary === 'host') tool.annotations.PRIVATE_SCHEMA_METADATA_CANARY = true; });
  const receipt = compareSnapshotManifest(manifest, reference);
  assert.doesNotMatch(JSON.stringify(receipt), /PRIVATE_SCHEMA_METADATA_CANARY/);
  assert.ok(byBoundary(receipt, 'host').reasons.includes('annotation_unknown_field'));
  assert.notEqual(receipt.verdict, 'compatible');
  for (const item of receipt.boundaries.flatMap(b => b.tools ?? [])) {
    for (const key of item.annotationDifferences) assert.ok(['readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint'].includes(key));
  }
});

test('F3: blank or whitespace expected/observed identity and version never pass', () => {
  for (const [identity, version] of [['', '1.0.0'], ['dharma-agent-fabric', ''], ['   ', '1.0.0'], ['dharma-agent-fabric', '\t ']]) {
    const manifest = clone(cases.compatible);
    manifest.expected = { identity, version };
    for (const snapshot of manifest.snapshots) Object.assign(snapshot.provenance, { identity, version });
    const receipt = compareSnapshotManifest(manifest, reference);
    assert.equal(receipt.verdict, 'invalid', JSON.stringify([identity, version]));
    assert.ok(receipt.manifestErrors.includes('expected_provenance_missing'));
    assert.ok(byBoundary(receipt, 'source').reasons.includes('provenance_incomplete'));
  }
});

test('F1/F2/F3: the real verifier consumer rejects constrained, unsupported, canary-key and blank-provenance manifests', () => {
  const variants = {
    constrained: m => { m.snapshots[0].tools[0].inputSchema = { type: 'object', minProperties: 2 }; m.snapshots.slice(1).forEach(s => { s.tools[0].inputSchema = { type: 'object', minProperties: 1 }; }); },
    unsupported: m => m.snapshots.forEach(s => { s.tools[0].inputSchema = { $ref: '#/x' }; }),
    malformed: m => m.snapshots.forEach(s => { s.tools[0].inputSchema = { type: 42 }; }),
    canary: m => { m.snapshots[1].tools[0].annotations = { ...m.snapshots[1].tools[0].annotations, PRIVATE_SCHEMA_METADATA_CANARY: true }; },
    blank: m => { m.expected = { identity: ' ', version: ' ' }; m.snapshots.forEach(s => Object.assign(s.provenance, { identity: ' ', version: ' ' })); },
  };
  for (const [name, mutate] of Object.entries(variants)) {
    const manifest = catalogManifest();
    mutate(manifest);
    const child = runVerifier(manifest);
    assert.equal(child.status, 1, `${name}: ${child.stderr}`);
    assert.notEqual(JSON.parse(child.stdout).verdict, 'compatible', name);
    assert.doesNotMatch(child.stdout, /PRIVATE_SCHEMA_METADATA_CANARY/, name);
  }
});

// Residual F1: every supported keyword family is shape-validated before digest.
// Identical schemas are placed at all five boundaries, so the verdict isolates
// classification: valid -> compatible, malformed -> invalid, unimplemented -> unknown.
const SHAPE_TABLE = [
  // [family, schema, expected verdict]
  ['type scalar', { type: 'string' }, 'compatible'],
  ['type unique array', { type: ['string', 'null'] }, 'compatible'],
  ['type duplicate array', { type: ['string', 'string'] }, 'invalid'],
  ['type empty array', { type: [] }, 'invalid'],
  ['type unknown name', { type: 'strng' }, 'invalid'],
  ['type non-string', { type: 7 }, 'invalid'],
  ['required empty', { type: 'object', required: [] }, 'compatible'],
  ['required unique', { type: 'object', required: ['id', 'name'] }, 'compatible'],
  ['required duplicate', { type: 'object', required: ['id', 'id'] }, 'invalid'],
  ['required non-array', { type: 'object', required: 'id' }, 'invalid'],
  ['required non-string', { type: 'object', required: [1] }, 'invalid'],
  ['multipleOf positive fraction', { type: 'number', multipleOf: 0.5 }, 'compatible'],
  ['multipleOf zero', { type: 'number', multipleOf: 0 }, 'invalid'],
  ['multipleOf negative', { type: 'number', multipleOf: -1 }, 'invalid'],
  ['multipleOf string', { type: 'number', multipleOf: '2' }, 'invalid'],
  ['minimum negative finite', { type: 'number', minimum: -3.5 }, 'compatible'],
  ['minimum string', { type: 'number', minimum: '0' }, 'invalid'],
  ['maximum non-finite', { type: 'number', maximum: Number.POSITIVE_INFINITY }, 'invalid'],
  ['exclusiveMinimum number', { type: 'number', exclusiveMinimum: 0 }, 'compatible'],
  ['exclusiveMinimum draft-4 boolean', { type: 'number', exclusiveMinimum: true }, 'unknown'],
  ['minLength zero', { type: 'string', minLength: 0 }, 'compatible'],
  ['minLength fraction', { type: 'string', minLength: 1.5 }, 'invalid'],
  ['maxItems negative', { type: 'array', maxItems: -1 }, 'invalid'],
  ['maxProperties boolean', { type: 'object', maxProperties: true }, 'invalid'],
  ['uniqueItems boolean', { type: 'array', uniqueItems: true }, 'compatible'],
  ['uniqueItems string', { type: 'array', uniqueItems: 'yes' }, 'invalid'],
  ['items schema', { type: 'array', items: { type: 'string' } }, 'compatible'],
  ['items tuple form', { type: 'array', items: [{ type: 'string' }] }, 'unknown'],
  ['items number', { type: 'array', items: 7 }, 'invalid'],
  ['properties object', { type: 'object', properties: { a: { type: 'string' } } }, 'compatible'],
  ['properties array', { type: 'object', properties: [] }, 'invalid'],
  ['additionalProperties boolean', { type: 'object', additionalProperties: false }, 'compatible'],
  ['additionalProperties schema', { type: 'object', additionalProperties: { type: 'string' } }, 'compatible'],
  ['additionalProperties string', { type: 'object', additionalProperties: 'no' }, 'invalid'],
  ['enum array', { enum: [1, 'a', null] }, 'compatible'],
  ['enum non-array', { enum: 'a' }, 'invalid'],
  ['const any JSON', { const: null }, 'compatible'],
  ['pattern valid', { type: 'string', pattern: '^[a-z]+$' }, 'compatible'],
  ['pattern invalid regex', { type: 'string', pattern: '(' }, 'invalid'],
  ['pattern non-unicode-only escape', { type: 'string', pattern: '\\-' }, 'unknown'],
  ['pattern non-string', { type: 'string', pattern: 5 }, 'invalid'],
  ['format string', { type: 'string', format: 'uri' }, 'compatible'],
  ['format non-string', { type: 'string', format: 7 }, 'invalid'],
];

test('residual F1: supported keyword shapes are validated before digest (positive and negative family table)', () => {
  const failures = [];
  for (const [family, schema, expected] of SHAPE_TABLE) {
    const manifest = mutateAll(tool => { tool.inputSchema = structuredClone(schema); });
    const verdict = compareSnapshotManifest(manifest, reference).verdict;
    if (verdict !== expected) failures.push(`${family}: expected ${expected}, got ${verdict}`);
  }
  assert.deepEqual(failures, []);
});

test('residual F1: the real verifier consumer rejects Docs examples and accepts valid controls', () => {
  for (const [name, schema, status, verdict] of [
    ['multipleOf zero', { type: 'number', multipleOf: 0 }, 1, 'invalid'],
    ['type duplicate', { type: ['string', 'string'] }, 1, 'invalid'],
    ['required duplicate', { type: 'object', required: ['id', 'id'] }, 1, 'invalid'],
    ['multipleOf positive control', { type: 'number', multipleOf: 0.25 }, 0, 'compatible'],
  ]) {
    const manifest = catalogManifest();
    for (const snapshot of manifest.snapshots) snapshot.tools[0].inputSchema = structuredClone(schema);
    const child = runVerifier(manifest);
    assert.equal(child.status, status, `${name}: ${child.stderr}`);
    assert.equal(JSON.parse(child.stdout).verdict, verdict, name);
  }
});

test('constraint JSON values ignore recursive object-key order but preserve array order', () => {
  const left = { a: { nested: [{ x: 1, y: 2 }, 3] }, b: true };
  const reordered = { b: true, a: { nested: [{ y: 2, x: 1 }, 3] } };
  for (const keyword of ['const', 'enum']) {
    const manifest = mutateAll((tool, snapshot) => {
      const value = snapshot.boundary === 'released' ? reordered : left;
      tool.inputSchema = { [keyword]: keyword === 'enum' ? [value, null] : value };
    });
    assert.equal(compareSnapshotManifest(manifest, reference).verdict, 'compatible', keyword);
    const released = manifest.snapshots.find(snapshot => snapshot.boundary === 'released');
    const tool = released.tools.find(item => item.name === 'a_read');
    const changed = { a: { nested: [3, { x: 1, y: 2 }] }, b: true };
    tool.inputSchema = { [keyword]: keyword === 'enum' ? [changed, null] : changed };
    assert.equal(compareSnapshotManifest(manifest, reference).verdict, 'incompatible', `${keyword} array order`);
  }
});

test('constraint JSON values are depth-bounded and enum members must be nonempty and unique', () => {
  let deep = null;
  for (let index = 0; index < 40; index++) deep = { nested: deep };
  for (const schema of [{ enum: [] }, { enum: [{ a: 1, b: 2 }, { b: 2, a: 1 }] }, { const: deep }]) {
    const manifest = mutateAll(tool => { tool.inputSchema = structuredClone(schema); });
    assert.equal(compareSnapshotManifest(manifest, reference).verdict, 'invalid');
  }
});

test('explicit 2020-12 declarations match the bounded MCP default dialect', () => {
  const manifest = mutateAll((tool, snapshot) => {
    if (snapshot.boundary !== 'source') {
      tool.inputSchema.$schema = 'https://json-schema.org/draft/2020-12/schema';
      tool.outputSchema.$schema = 'https://json-schema.org/draft/2020-12/schema#';
    }
  });
  assert.equal(compareSnapshotManifest(manifest, reference).verdict, 'compatible');
});

test('unsupported and changed dialects are unknown instead of silently erasing const semantics', () => {
  for (const dialect of ['http://json-schema.org/draft-04/schema#',
    'http://json-schema.org/draft-07/schema#', 'https://example.test/PRIVATE_DIALECT_CANARY']) {
    const manifest = mutateAll((tool, snapshot) => {
      tool.inputSchema = { $schema: snapshot.boundary === 'released' ? dialect
        : 'https://json-schema.org/draft/2020-12/schema',
      type: 'object', properties: { id: { const: 'approved' } } };
    });
    const receipt = compareSnapshotManifest(manifest, reference);
    assert.equal(receipt.verdict, 'unknown', dialect);
    assert.ok(byBoundary(receipt, 'released').reasons.includes('schema_unsupported'));
    assert.doesNotMatch(JSON.stringify(receipt), /PRIVATE_DIALECT_CANARY/);
  }
  const originalReviewExample = mutateAll((tool, snapshot) => {
    tool.inputSchema = { $schema: snapshot.boundary === 'released'
      ? 'http://json-schema.org/draft-04/schema#' : 'http://json-schema.org/draft-07/schema#',
    type: 'object', properties: { id: { const: 'approved' } } };
  });
  assert.equal(compareSnapshotManifest(originalReviewExample, reference).verdict, 'unknown');
});

test('malformed dialect declarations are invalid and embedded resource dialects remain unsupported', () => {
  for (const value of [42, null, {}, []]) {
    const manifest = mutateAll(tool => { tool.inputSchema.$schema = value; });
    assert.equal(compareSnapshotManifest(manifest, reference).verdict, 'invalid');
  }
  const nested = mutateAll(tool => {
    tool.inputSchema.properties.id = { $id: 'https://example.test/embedded',
      $schema: 'http://json-schema.org/draft-04/schema#', const: 'approved' };
  });
  assert.equal(compareSnapshotManifest(nested, reference).verdict, 'unknown');
});

test('real verifier accepts canonical JSON values and rejects unsupported dialect semantics', () => {
  const manifest = catalogManifest();
  for (const snapshot of manifest.snapshots) {
    snapshot.tools[0].inputSchema = { const: snapshot.boundary === 'released'
      ? { b: [2, { y: 4, x: 3 }], a: 1 } : { a: 1, b: [2, { x: 3, y: 4 }] } };
  }
  const compatible = runVerifier(manifest);
  assert.equal(compatible.status, 0, compatible.stderr);
  assert.equal(JSON.parse(compatible.stdout).verdict, 'compatible');
  for (const snapshot of manifest.snapshots) {
    snapshot.tools[0].inputSchema = { $schema: snapshot.boundary === 'released'
      ? 'http://json-schema.org/draft-04/schema#' : 'http://json-schema.org/draft-07/schema#',
    type: 'object', properties: { id: { const: 'approved' } } };
  }
  const unsupported = runVerifier(manifest);
  assert.equal(unsupported.status, 1, unsupported.stderr);
  assert.equal(JSON.parse(unsupported.stdout).verdict, 'unknown');
});

test('runtime input contract rejects malformed envelopes without echoing them and preserves partial unknown evidence', () => {
  for (const mutate of [
    manifest => { manifest.credentials = 'PRIVATE_RUNTIME_CONTRACT_CANARY'; },
    manifest => { manifest.expected.extra = 'PRIVATE_RUNTIME_CONTRACT_CANARY'; },
    manifest => { manifest.snapshots[0].provenance.observed = 'yes'; },
  ]) {
    const manifest = clone(cases.compatible);
    mutate(manifest);
    const receipt = compareSnapshotManifest(manifest, reference);
    assert.equal(receipt.verdict, 'invalid');
    assert.ok(receipt.manifestErrors.includes('manifest_malformed'));
    assert.doesNotMatch(JSON.stringify(receipt), /PRIVATE_RUNTIME_CONTRACT_CANARY/);
  }
  const partial = clone(cases.compatible);
  partial.snapshots = partial.snapshots.slice(0, 1);
  assert.equal(compareSnapshotManifest(partial, reference).verdict, 'unknown');
});

test('real verifier enforces the manifest contract while retaining parser-safe invalid receipts', () => {
  const manifest = catalogManifest();
  manifest.credentials = 'PRIVATE_RUNTIME_CONTRACT_CANARY';
  const child = runVerifier(manifest);
  assert.equal(child.status, 1, child.stderr);
  const receipt = JSON.parse(child.stdout);
  assert.equal(receipt.verdict, 'invalid');
  assert.ok(receipt.manifestErrors.includes('manifest_malformed'));
  assert.doesNotMatch(child.stdout, /PRIVATE_RUNTIME_CONTRACT_CANARY/);
});

test('all five observed matching boundaries are compatible, ignoring description and key order', () => {
  const receipt = compareSnapshotManifest(clone(cases.compatible), reference);
  assert.deepEqual([...BOUNDARIES], ['source', 'host', 'server', 'submitted', 'released']);
  assert.equal(receipt.verdict, 'compatible');
  assert.deepEqual(receipt.boundaries.map(item => [item.boundary, item.status]),
    BOUNDARIES.map(boundary => [boundary, 'compatible']));
  assert.equal(receipt.executionProven, false, 'names and counts never prove execution');
});

test('missing boundaries are unobserved and block a compatible verdict', () => {
  const manifest = clone(cases.compatible);
  manifest.snapshots = manifest.snapshots.filter(item => item.boundary !== 'released');
  const receipt = compareSnapshotManifest(manifest, reference);
  assert.equal(byBoundary(receipt, 'released').status, 'unknown');
  assert.deepEqual(byBoundary(receipt, 'released').reasons, ['not_supplied']);
  assert.equal(receipt.verdict, 'unknown');
});

test('schema, confirmation, annotation, missing and extra tool drift is reported structurally', () => {
  const receipt = compareSnapshotManifest(clone(cases.drift), reference);
  assert.equal(receipt.verdict, 'incompatible');
  const released = byBoundary(receipt, 'released');
  assert.equal(released.status, 'incompatible');
  assert.deepEqual(released.extraTools, ['c_new']);
  assert.deepEqual(released.missingTools, []);
  const tools = Object.fromEntries(released.tools.map(item => [item.name, item]));
  assert.equal(tools.a_read.inputSchema, 'different');
  assert.deepEqual(tools.a_read.annotationDifferences, ['destructiveHint']);
  assert.equal(tools.b_write.confirmation, 'different');
  assert.deepEqual(byBoundary(receipt, 'host').missingTools, ['b_write']);
});

test('unobserved snapshots and missing schemas are UNKNOWN, never equal', () => {
  const receipt = compareSnapshotManifest(clone(cases.unknown), reference);
  assert.equal(byBoundary(receipt, 'host').status, 'unknown');
  assert.ok(byBoundary(receipt, 'host').reasons.includes('unobserved'));
  const server = byBoundary(receipt, 'server');
  assert.equal(server.status, 'unknown');
  for (const tool of server.tools) {
    assert.equal(tool.inputSchema, 'unknown');
    assert.equal(tool.outputSchema, 'unknown');
  }
  assert.ok(server.reasons.includes('schema_evidence_missing'));
  assert.notEqual(receipt.verdict, 'compatible');
});

test('schemas compare against the source boundary; without one they are unknown', () => {
  const manifest = clone(cases.compatible);
  manifest.snapshots = manifest.snapshots.filter(item => item.boundary !== 'source');
  const receipt = compareSnapshotManifest(manifest, reference);
  assert.equal(byBoundary(receipt, 'server').status, 'unknown');
  assert.ok(byBoundary(receipt, 'server').reasons.includes('schema_reference_missing'));
});

test('duplicate tools, invalid names, duplicate and unsupported boundaries are invalid', () => {
  const receipt = compareSnapshotManifest(clone(cases.invalidDuplicate), reference);
  assert.equal(receipt.verdict, 'invalid');
  assert.deepEqual(receipt.manifestErrors, ['duplicate_boundary', 'unsupported_boundary']);
  const server = byBoundary(receipt, 'server');
  assert.equal(server.status, 'invalid');
  assert.ok(server.reasons.includes('duplicate_tool'));
  assert.ok(server.reasons.includes('invalid_tool_name'));
  assert.equal(server.invalidToolNameCount, 1);
});

test('identity, version and incomplete provenance mismatches never pass', () => {
  const receipt = compareSnapshotManifest(clone(cases.provenanceMismatch), reference);
  assert.ok(byBoundary(receipt, 'submitted').reasons.includes('version_mismatch'));
  assert.ok(byBoundary(receipt, 'released').reasons.includes('identity_mismatch'));
  assert.ok(byBoundary(receipt, 'host').reasons.includes('provenance_incomplete'));
  for (const boundary of ['submitted', 'released', 'host']) assert.equal(byBoundary(receipt, boundary).status, 'invalid');
  assert.equal(receipt.verdict, 'invalid');
});

test('malformed manifests are rejected with fixed codes, not echoed content', () => {
  for (const manifest of [null, [], 'x', { schema: 'other/v1', snapshots: [] }, { schema: 'dharma.mcp-snapshot-manifest/v1' },
    { schema: 'dharma.mcp-snapshot-manifest/v1', expected: { identity: 'a', version: '1' }, snapshots: [7] }]) {
    const receipt = compareSnapshotManifest(manifest, reference);
    assert.equal(receipt.verdict, 'invalid');
    assert.ok(receipt.manifestErrors.length > 0);
  }
});

test('receipt never echoes descriptions, defaults, examples, property names, provenance extras or invalid names', () => {
  const receipt = compareSnapshotManifest(clone(cases.secret), reference);
  const text = JSON.stringify(receipt);
  assert.doesNotMatch(text, /SECRET_CANARY|token=/);
  assert.equal(byBoundary(receipt, 'server').invalidToolNameCount, 1);
});

test('comparison is deterministic and does not mutate input', () => {
  const input = clone(cases.drift);
  const before = JSON.stringify(input);
  const first = JSON.stringify(compareSnapshotManifest(input, reference));
  const reversed = clone(cases.drift);
  reversed.snapshots.reverse();
  for (const snapshot of reversed.snapshots) snapshot.tools?.reverse();
  assert.equal(JSON.stringify(compareSnapshotManifest(reversed, reference)), first);
  assert.equal(JSON.stringify(input), before);
  assert.doesNotMatch(first, /\d{4}-\d\d-\d\dT/);
});

test('reference derives from the actual catalog without hardcoded host inventory counts', () => {
  const catalog = JSON.parse(readFileSync(resolve(root, 'plugins/dharma-agent-fabric/openai-app/mcp-tool-catalog.json'), 'utf8'));
  const derived = referenceFromCatalog(catalog);
  assert.equal(derived.tools.length, catalog.tools.length);
  assert.deepEqual(derived.tools.map(tool => tool.name), catalog.tools.map(tool => tool.name));
});

test('no-argument verifier keeps its exact existing output', () => {
  const child = spawnSync(process.execPath, [verifier], { cwd: root, encoding: 'utf8', timeout: 30_000 });
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stdout, '{"ok":true,"toolCount":65,"confirmationCount":38}\n');
});

test('verifier opt-in snapshot mode runs the comparator against the real catalog', () => {
  const catalog = JSON.parse(readFileSync(resolve(root, 'plugins/dharma-agent-fabric/openai-app/mcp-tool-catalog.json'), 'utf8'));
  const tools = catalog.tools.map(tool => ({ name: tool.name, confirmation: tool.confirmation, annotations: tool.annotations,
    inputSchema: { type: 'object' }, outputSchema: { type: 'object' } }));
  const provenance = { observed: true, identity: 'dharma-agent-fabric', version: '1.0.0' };
  const manifest = { schema: 'dharma.mcp-snapshot-manifest/v1', expected: { identity: 'dharma-agent-fabric', version: '1.0.0' },
    snapshots: BOUNDARIES.map(boundary => ({ boundary, provenance, tools })) };
  const dir = mkdtempSync(join(tmpdir(), 'mcp-drift-'));
  try {
    const path = join(dir, 'manifest.json');
    writeFileSync(path, JSON.stringify(manifest));
    const ok = spawnSync(process.execPath, [verifier, '--snapshot-manifest', path], { cwd: root, encoding: 'utf8', timeout: 30_000 });
    assert.equal(ok.status, 0, ok.stderr);
    const receipt = JSON.parse(ok.stdout);
    assert.equal(receipt.verdict, 'compatible');
    assert.equal(receipt.referenceToolCount, catalog.tools.length);
    manifest.snapshots[4].tools = tools.slice(1);
    writeFileSync(path, JSON.stringify(manifest));
    const drift = spawnSync(process.execPath, [verifier, '--snapshot-manifest', path], { cwd: root, encoding: 'utf8', timeout: 30_000 });
    assert.equal(drift.status, 1);
    assert.equal(JSON.parse(drift.stdout).verdict, 'incompatible');
    for (const args of [['--snapshot-manifest'], ['--unknown'], ['--snapshot-manifest', join(dir, 'missing.json')], ['--snapshot-manifest', path, '--snapshot-manifest', path]]) {
      const bad = spawnSync(process.execPath, [verifier, ...args], { cwd: root, encoding: 'utf8', timeout: 30_000 });
      assert.notEqual(bad.status, 0, args.join(' '));
      assert.doesNotMatch(bad.stdout, /"ok":true/);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
