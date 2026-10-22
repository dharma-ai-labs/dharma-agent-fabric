// Regressions for the pure raw MCP tools/list RESULT projector. Offline only:
// no SDK, server, subprocess, network or file output. Uses the existing
// comparator, offline assembler and contracts unchanged.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import test from 'node:test';
import { compareSnapshotManifest } from './mcp-catalog-drift.mjs';
import { assembleSnapshotManifest } from './mcp-snapshot-manifest-assemble.mjs';
import { PROJECTION_CODES, PROJECTION_LIMITS, PROJECTION_SCHEMA, projectToolsListResult } from './mcp-tools-list-project.mjs';

const require = createRequire(import.meta.url);
const Ajv2020 = require('ajv/dist/2020.js').default;
const formatsModule = require('ajv-formats');
const root = resolve(import.meta.dirname, '..');
const readJson = path => JSON.parse(readFileSync(resolve(root, path), 'utf8'));
const PROJECTION_ID = 'https://schemas.dharma-ai.io/mcp-tools-list-projection/v1';
const MANIFEST_ID = 'https://schemas.dharma-ai.io/mcp-snapshot-manifest/v1';

function contracts() {
  const ajv = new Ajv2020({ allErrors: true, strict: true, strictRequired: false });
  (formatsModule.default ?? formatsModule)(ajv);
  ajv.addSchema(readJson('schemas/mcp-snapshot-manifest.schema.json'));
  ajv.addSchema(readJson('schemas/mcp-tools-list-projection.schema.json'));
  return { projection: ajv.getSchema(PROJECTION_ID), manifest: ajv.getSchema(MANIFEST_ID) };
}

const CANARY_KEY = 'PRIVATE_KEY_CANARY_7f3a';
const CANARY_VALUE = 'PRIVATE_VALUE_CANARY_9c1e';
const DOC_CANARY = 'ALLOWED_DOC_CANARY_51b2';
const SCHEMA_CANARY = 'ALLOWED_SCHEMA_CANARY_e44d';

function rawResult() {
  return {
    tools: [
      {
        name: 'a_read', title: 'Read A', description: `Reads A ${DOC_CANARY}`,
        inputSchema: { type: 'object', properties: { id: { type: 'string', description: SCHEMA_CANARY } }, required: ['id'] },
        outputSchema: { type: 'object' },
        annotations: { title: 'Read A', readOnlyHint: true, destructiveHint: false, [CANARY_KEY]: CANARY_VALUE },
        _meta: { [CANARY_KEY]: CANARY_VALUE }, icons: [{ src: CANARY_VALUE }], [CANARY_KEY]: CANARY_VALUE,
      },
      { name: 'b_write', inputSchema: { type: 'object', properties: { body: { type: 'string' } } } },
    ],
    _meta: { [CANARY_KEY]: CANARY_VALUE },
    [CANARY_KEY]: CANARY_VALUE,
  };
}
const ready = value => { assert.equal(value.status, 'ready', JSON.stringify(value)); return value; };
const rejected = (value, code) => { assert.deepEqual(value, { schema: PROJECTION_SCHEMA, status: 'rejected', code }); };
const noPrivate = value => {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  assert.equal(text.includes(CANARY_KEY), false, 'private key leaked');
  assert.equal(text.includes(CANARY_VALUE), false, 'private value leaked');
};

test('API surface: fixed schema id, codes and limits; projection contract compiles strictly', () => {
  assert.equal(PROJECTION_SCHEMA, 'dharma.mcp-tools-list-projection/v1');
  assert.deepEqual([...PROJECTION_CODES].sort(), ['envelope_not_result', 'incomplete_pagination', 'input_not_json',
    'input_too_deep', 'input_too_large', 'output_too_large', 'result_not_object', 'tool_malformed', 'tools_missing',
    'tools_not_array', 'tools_too_many']);
  assert.deepEqual(Object.keys(PROJECTION_LIMITS).sort(), ['maxDepth', 'maxInputBytes', 'maxNodes', 'maxOutputBytes', 'maxTools']);
  const schema = readJson('schemas/mcp-tools-list-projection.schema.json');
  assert.equal(schema.$schema, 'https://json-schema.org/draft/2020-12/schema');
  assert.equal(schema.$id, PROJECTION_ID);
  assert.equal(typeof contracts().projection, 'function');
});

test('projects manifest v1 fields and drops unknown keys and values at envelope, tool and annotation boundaries', () => {
  const { projection, manifest } = contracts();
  const out = ready(projectToolsListResult(rawResult()));
  assert.ok(projection(out), JSON.stringify(projection.errors));
  noPrivate(out);
  assert.deepEqual(Object.keys(out).sort(), ['counts', 'schema', 'status', 'tools']);
  assert.deepEqual(out.tools[0], {
    name: 'a_read', title: 'Read A', description: `Reads A ${DOC_CANARY}`,
    annotations: { title: 'Read A', readOnlyHint: true, destructiveHint: false },
    inputSchema: { type: 'object', properties: { id: { type: 'string', description: SCHEMA_CANARY } }, required: ['id'] },
    outputSchema: { type: 'object' },
  });
  // Missing metadata stays absent; confirmation is never invented.
  assert.deepEqual(out.tools[1], { name: 'b_write', inputSchema: { type: 'object', properties: { body: { type: 'string' } } } });
  for (const tool of out.tools) assert.equal(Object.hasOwn(tool, 'confirmation'), false);
  assert.deepEqual(out.counts, { tools: 2, droppedResultKeys: 2, droppedToolKeys: 3, droppedAnnotationKeys: 1 });
  // Allowed documentation/schema content is deliberately retained (not a secret sanitizer).
  assert.ok(JSON.stringify(out).includes(DOC_CANARY));
  assert.ok(JSON.stringify(out).includes(SCHEMA_CANARY));
  const snapshot = { schema: 'dharma.mcp-snapshot-manifest/v1', expected: { identity: 'x', version: '1' },
    snapshots: [{ boundary: 'server', provenance: { observed: true, identity: 'x', version: '1' }, tools: out.tools }] };
  assert.ok(manifest(snapshot), JSON.stringify(manifest.errors));
});

test('projection contract rejects extras, wrong codes and confirmation; accepts both actual result forms', () => {
  const { projection } = contracts();
  const good = ready(projectToolsListResult(rawResult()));
  assert.ok(projection({ schema: PROJECTION_SCHEMA, status: 'rejected', code: 'tool_malformed' }));
  const bad = [
    { ...good, extra: 1 },
    { ...good, counts: { ...good.counts, private: 1 } },
    { ...good, tools: [{ ...good.tools[0], confirmation: true }] },
    { ...good, tools: [{ ...good.tools[0], _meta: {} }] },
    { ...good, status: 'partial' },
    { schema: PROJECTION_SCHEMA, status: 'rejected', code: 'PRIVATE_CODE' },
    { schema: PROJECTION_SCHEMA, status: 'rejected', code: 'tool_malformed', tools: [] },
    { schema: PROJECTION_SCHEMA, status: 'ready', code: 'tool_malformed' },
  ];
  for (const value of bad) assert.equal(projection(value), false, JSON.stringify(value).slice(0, 80));
});

test('rejected results never echo private names or values, including thrown paths', () => {
  const cases = [
    { ...rawResult(), nextCursor: CANARY_VALUE },
    { tools: [{ name: `${CANARY_VALUE}!`, [CANARY_KEY]: 1 }] },
    { [CANARY_KEY]: { nested: [Number.NaN] }, tools: [] },
    { jsonrpc: '2.0', id: 1, error: { code: -1, message: CANARY_VALUE } },
  ];
  for (const raw of cases) {
    let out;
    try { out = projectToolsListResult(raw); } catch (error) { noPrivate(String(error?.message)); noPrivate(String(error?.stack)); continue; }
    assert.equal(out.status, 'rejected');
    noPrivate(out);
  }
});

test('genuine result envelope only: null, arrays, JSON-RPC wrappers, errors and nested result fail with fixed codes', () => {
  rejected(projectToolsListResult(null), 'result_not_object');
  rejected(projectToolsListResult([]), 'result_not_object');
  rejected(projectToolsListResult('tools'), 'result_not_object');
  rejected(projectToolsListResult({ jsonrpc: '2.0', id: 1, result: { tools: [] } }), 'envelope_not_result');
  rejected(projectToolsListResult({ jsonrpc: '2.0', id: 1, error: { code: -32601, message: 'x' } }), 'envelope_not_result');
  rejected(projectToolsListResult({ result: { tools: [] } }), 'envelope_not_result');
  rejected(projectToolsListResult({ error: { code: 1 } }), 'envelope_not_result');
  rejected(projectToolsListResult({ tools: [], jsonrpc: '2.0' }), 'envelope_not_result');
  rejected(projectToolsListResult({}), 'tools_missing');
  rejected(projectToolsListResult({ tools: null }), 'tools_not_array');
  rejected(projectToolsListResult({ tools: { a: 1 } }), 'tools_not_array');
  assert.deepEqual(ready(projectToolsListResult({ tools: [] })).tools, []);
});

test('pagination: any continuation fails closed; absent cursor permits projection without an acquisition claim', () => {
  for (const nextCursor of ['abc', '', null, 0, false, {}, ['x']]) {
    rejected(projectToolsListResult({ tools: [{ name: 'a_read' }], nextCursor }), 'incomplete_pagination');
  }
  assert.equal(ready(projectToolsListResult({ tools: [{ name: 'a_read' }] })).tools.length, 1);
});

test('malformed permitted fields are rejected using the strict manifest tool contract', () => {
  const bad = [
    { name: 'bad name!' }, { name: 7 }, {}, { name: 'a', title: 1 }, { name: 'a', description: null },
    { name: 'a', annotations: null }, { name: 'a', annotations: [] }, { name: 'a', annotations: { readOnlyHint: 'yes' } },
    { name: 'a', annotations: { title: false } }, { name: 'a', inputSchema: 'object' }, { name: 'a', outputSchema: null },
    { name: 'a', inputSchema: [] }, 'a_read', null,
  ];
  for (const tool of bad) rejected(projectToolsListResult({ tools: [tool] }), 'tool_malformed');
  for (const inputSchema of [true, false, {}]) {
    assert.deepEqual(ready(projectToolsListResult({ tools: [{ name: 'a', inputSchema }] })).tools[0].inputSchema, inputSchema);
  }
});

test('JSON domain: non-finite anywhere (including dropped fields), non-plain values, accessors and proxies reject before serialization', () => {
  const nonJson = [
    { tools: [{ name: 'a', inputSchema: { type: 'object', maximum: Number.POSITIVE_INFINITY } }] },
    { tools: [{ name: 'a', inputSchema: { enum: [[1, [Number.NaN]]] } }] },
    { tools: [{ name: 'a', _meta: { deep: [{ x: Number.NEGATIVE_INFINITY }] } }] },
    { tools: [], ignored: Number.NaN },
    { tools: [{ name: 'a', inputSchema: { default: undefined } }] },
    { tools: [{ name: 'a', inputSchema: { toJSON: () => ({}) } }] },
    { tools: [{ name: 'a', inputSchema: { big: 1n } }] },
    { tools: [{ name: 'a', inputSchema: { when: new Date(0) } }] },
    { tools: [{ name: 'a', inputSchema: { [Symbol('s')]: 1 } }] },
    { tools: [, { name: 'a' }] }, // eslint-disable-line no-sparse-arrays
    { tools: [new Proxy({ name: 'a' }, {})] },
    new Proxy({ tools: [] }, {}),
  ];
  for (const raw of nonJson) rejected(projectToolsListResult(raw), 'input_not_json');
  let getterCalls = 0;
  const accessor = { name: 'a' };
  Object.defineProperty(accessor, 'description', { enumerable: true, get() { getterCalls++; return 'x'; } });
  rejected(projectToolsListResult({ tools: [accessor] }), 'input_not_json');
  assert.equal(getterCalls, 0, 'getter must never execute');
  const cyclic = { type: 'object' };
  cyclic.properties = { self: cyclic };
  rejected(projectToolsListResult({ tools: [{ name: 'a', inputSchema: cyclic }] }), 'input_too_deep');
  // Finite nested numbers, including negative zero and exponents, survive unchanged.
  const finite = ready(projectToolsListResult({ tools: [{ name: 'a', inputSchema: { enum: [[1.5e300, -0, [0.1]]], minimum: -1e-7 } }] }));
  assert.deepEqual(finite.tools[0].inputSchema, { enum: [[1.5e300, -0, [0.1]]], minimum: -1e-7 });
});

test('opaque schemas are preserved verbatim: order, duplicates, unsupported keywords and __proto__ keys without pollution', () => {
  const raw = JSON.parse(`{"tools":[{"name":"a","inputSchema":{"z":1,"anyOf":[{"type":"string"},{"type":"string"}],
    "$schema":"http://json-schema.org/draft-07/schema#","required":["b","a","b"],"__proto__":{"polluted":true},
    "properties":{"b":{"type":"string"},"a":{"$ref":"#/x"}}}}]}`);
  const out = ready(projectToolsListResult(raw));
  const schema = out.tools[0].inputSchema;
  assert.deepEqual(Object.keys(schema), ['z', 'anyOf', '$schema', 'required', '__proto__', 'properties']);
  assert.deepEqual(schema.required, ['b', 'a', 'b']);
  assert.deepEqual(Object.keys(schema.properties), ['b', 'a']);
  assert.equal(Object.getPrototypeOf(schema), Object.prototype);
  assert.ok(Object.hasOwn(schema, '__proto__'));
  assert.equal(({}).polluted, undefined);
  assert.equal(JSON.stringify(out.tools[0].inputSchema), JSON.stringify(raw.tools[0].inputSchema));
  assert.notEqual(out.tools[0].inputSchema, raw.tools[0].inputSchema, 'output is a copy, not the input object');
});

test('comparator consumption: unsupported schemas stay UNKNOWN, duplicate tools stay INVALID, missing boundaries stay UNKNOWN', () => {
  const reference = { tools: [{ name: 'a_read', confirmation: false, outputSchema: true, annotations: { readOnlyHint: true } }] };
  const provenance = { observed: true, identity: 'dharma-agent-fabric', version: 'v-test' };
  const base = { schema: 'dharma.mcp-snapshot-manifest/v1', expected: { identity: 'dharma-agent-fabric', version: 'v-test' } };
  const unsupported = ready(projectToolsListResult({ tools: [{ name: 'a_read', annotations: { readOnlyHint: true },
    inputSchema: { anyOf: [{ type: 'string' }] }, outputSchema: { type: 'object' } }] })).tools;
  const receipt = compareSnapshotManifest({ ...base, snapshots: [
    { boundary: 'source', provenance, tools: unsupported }, { boundary: 'server', provenance, tools: unsupported }] }, reference);
  const server = receipt.boundaries.find(item => item.boundary === 'server');
  assert.equal(server.status, 'unknown');
  assert.ok(server.reasons.includes('schema_unsupported'));
  assert.ok(server.reasons.includes('confirmation_evidence_missing'), 'confirmation is not inferred');
  for (const boundary of ['host', 'submitted', 'released']) {
    assert.deepEqual(receipt.boundaries.find(item => item.boundary === boundary).reasons, ['not_supplied']);
  }
  const duplicate = ready(projectToolsListResult({ tools: [{ name: 'a_read' }, { name: 'a_read' }] })).tools;
  assert.equal(duplicate.length, 2, 'duplicates retained, not deduplicated');
  const dupReceipt = compareSnapshotManifest({ ...base, snapshots: [{ boundary: 'server', provenance, tools: duplicate }] }, reference);
  assert.equal(dupReceipt.verdict, 'invalid');
  assert.ok(dupReceipt.boundaries.find(item => item.boundary === 'server').reasons.includes('duplicate_tool'));
});

test('bounds: tool count, depth, nodes, input bytes and output bytes fail closed without truncation', () => {
  const tools = Array.from({ length: PROJECTION_LIMITS.maxTools + 1 }, (_, i) => ({ name: `t${i}` }));
  rejected(projectToolsListResult({ tools }), 'tools_too_many');
  assert.equal(ready(projectToolsListResult({ tools: tools.slice(0, PROJECTION_LIMITS.maxTools) })).tools.length, PROJECTION_LIMITS.maxTools);
  let deep = { type: 'object' };
  for (let i = 0; i < PROJECTION_LIMITS.maxDepth + 1; i++) deep = { properties: { x: deep } };
  rejected(projectToolsListResult({ tools: [{ name: 'a', inputSchema: deep }] }), 'input_too_deep');
  rejected(projectToolsListResult({ tools: [{ name: 'a', inputSchema: { enum: Array.from({ length: PROJECTION_LIMITS.maxNodes }, (_, i) => i) } }] }), 'input_too_large');
  rejected(projectToolsListResult({ tools: [], _meta: { blob: 'x'.repeat(PROJECTION_LIMITS.maxInputBytes) } }), 'input_too_large');
  const half = 'y'.repeat(Math.ceil(PROJECTION_LIMITS.maxOutputBytes / 2) + 10);
  rejected(projectToolsListResult({ tools: [{ name: 'a', description: half }, { name: 'b', description: half }] }), 'output_too_large');
});

test('deterministic and side-effect free: same input gives identical output; input is not mutated', () => {
  const raw = rawResult();
  const before = JSON.stringify(raw);
  const first = projectToolsListResult(raw);
  const second = projectToolsListResult(structuredClone(raw));
  assert.equal(JSON.stringify(first), JSON.stringify(second));
  assert.equal(JSON.stringify(raw), before);
});

test('escaped dropped strings cannot bypass the exact serialized input byte budget', () => {
  const raw = { tools: [], ignored: '\u0000'.repeat(Math.floor(PROJECTION_LIMITS.maxInputBytes / 6) + 1) };
  assert.ok(Buffer.byteLength(JSON.stringify(raw), 'utf8') > PROJECTION_LIMITS.maxInputBytes);
  rejected(projectToolsListResult(raw), 'input_too_large');
});

test('exact JSON representation budget accepts the boundary and rejects one extra escaped or Unicode unit', () => {
  const overhead = Buffer.byteLength(JSON.stringify({ tools: [], ignored: '' }), 'utf8');
  for (const unit of ['x', '\u0000', '\n', '"', '\\', '\ud800', '\udc00', '\ud83d\ude00', '\u00e9']) {
    const cost = Buffer.byteLength(JSON.stringify(unit), 'utf8') - 2;
    const count = Math.floor((PROJECTION_LIMITS.maxInputBytes - overhead) / cost);
    const raw = { tools: [], ignored: unit.repeat(count) };
    assert.ok(Buffer.byteLength(JSON.stringify(raw), 'utf8') <= PROJECTION_LIMITS.maxInputBytes);
    ready(projectToolsListResult(raw));
    raw.ignored += unit;
    assert.ok(Buffer.byteLength(JSON.stringify(raw), 'utf8') > PROJECTION_LIMITS.maxInputBytes);
    rejected(projectToolsListResult(raw), 'input_too_large');
  }
});

test('raw result and tool input definitions compile and validate before projection', () => {
  const ajv = new Ajv2020({ allErrors: true, strict: true, strictRequired: false });
  (formatsModule.default ?? formatsModule)(ajv);
  ajv.addSchema(readJson('schemas/mcp-snapshot-manifest.schema.json'));
  ajv.addSchema(readJson('schemas/mcp-tools-list-projection.schema.json'));
  const input = ajv.getSchema(`${PROJECTION_ID}#/$defs/inputResult`);
  assert.equal(typeof input, 'function');
  assert.equal(input(rawResult()), true);
  for (const raw of [null, [], { tools: null }, { tools: [{}] }, { tools: [{ name: 'a', title: 1 }] },
    { tools: [{ name: 'a', annotations: { readOnlyHint: 'yes' } }] },
    { tools: [], nextCursor: '' }, { tools: [], jsonrpc: '2.0' }, { tools: [], error: {} }]) {
    assert.equal(input(raw), false);
    assert.equal(projectToolsListResult(raw).status, 'rejected');
  }
});

test('output byte budget accepts the exact boundary and rejects the next byte without mutating input', () => {
  const empty = { tools: [{ name: 'a', description: '' }] };
  const overhead = Buffer.byteLength(JSON.stringify(ready(projectToolsListResult(empty))), 'utf8');
  const raw = { tools: [{ name: 'a', description: 'x'.repeat(PROJECTION_LIMITS.maxOutputBytes - overhead) }] };
  const before = JSON.stringify(raw);
  const out = ready(projectToolsListResult(raw));
  assert.equal(Buffer.byteLength(JSON.stringify(out), 'utf8'), PROJECTION_LIMITS.maxOutputBytes);
  assert.equal(JSON.stringify(raw), before);
  raw.tools[0].description += 'x';
  rejected(projectToolsListResult(raw), 'output_too_large');
  assert.equal(raw.tools[0].description.length, PROJECTION_LIMITS.maxOutputBytes - overhead + 1);
});

test('input inspection rejects hostile descriptors and proxies without invoking their code', () => {
  let effects = 0;
  const accessor = {};
  Object.defineProperty(accessor, 'tools', { enumerable: true, get() { effects++; throw new Error(CANARY_VALUE); } });
  const array = [];
  Object.defineProperty(array, '0', { enumerable: true, get() { effects++; throw new Error(CANARY_VALUE); } });
  const proxy = new Proxy({ tools: [] }, {
    ownKeys() { effects++; throw new Error(CANARY_VALUE); },
    getPrototypeOf() { effects++; throw new Error(CANARY_VALUE); },
    get() { effects++; throw new Error(CANARY_VALUE); },
  });
  const revoked = Proxy.revocable({ tools: [] }, {});
  revoked.revoke();
  for (const raw of [accessor, { tools: array }, proxy, revoked.proxy,
    { tools: [], ignored: { toJSON() { effects++; throw new Error(CANARY_VALUE); } } }]) {
    rejected(projectToolsListResult(raw), 'input_not_json');
  }
  assert.equal(effects, 0);
});

test('null-prototype JSON data is copied without sharing nested objects or changing prototypes', () => {
  const schema = Object.assign(Object.create(null), { properties: Object.assign(Object.create(null), {
    x: { enum: [{ nested: [1, 2, 3] }] },
  }) });
  const tool = Object.assign(Object.create(null), { name: 'a', inputSchema: schema });
  const raw = Object.assign(Object.create(null), { tools: [tool] });
  const before = JSON.stringify(raw);
  const out = ready(projectToolsListResult(raw));
  assert.equal(JSON.stringify(out.tools[0]), JSON.stringify(tool));
  assert.equal(Object.getPrototypeOf(raw), null);
  assert.equal(Object.getPrototypeOf(raw.tools[0].inputSchema), null);
  assert.equal(Object.getPrototypeOf(out.tools[0].inputSchema), Object.prototype);
  out.tools[0].inputSchema.properties.x.enum[0].nested.push(4);
  assert.equal(JSON.stringify(raw), before);
});

test('offline composition preserves caller provenance, duplicates and missing evidence through assembly and comparison', () => {
  const expected = { identity: 'dharma-agent-fabric', version: 'v-test' };
  const provenance = { observed: true, ...expected };
  const reference = { tools: [{ name: 'a_read', confirmation: false, outputSchema: true,
    annotations: { readOnlyHint: true } }] };
  const raw = { tools: [{ name: 'a_read', inputSchema: true, outputSchema: true,
    annotations: { readOnlyHint: true }, confirmation: true, _meta: { [CANARY_KEY]: CANARY_VALUE } }] };
  const projected = ready(projectToolsListResult(raw));
  assert.equal(Object.hasOwn(projected.tools[0], 'confirmation'), false);
  noPrivate(projected);
  const cases = [
    { provenance, tools: projected.tools, status: 'unknown', reason: 'confirmation_evidence_missing' },
    { provenance: { ...provenance, identity: 'different' }, tools: projected.tools,
      status: 'invalid', reason: 'identity_mismatch' },
    { provenance: { ...provenance, version: 'different' }, tools: projected.tools,
      status: 'invalid', reason: 'version_mismatch' },
    { provenance, tools: [...projected.tools, ...projected.tools], status: 'invalid', reason: 'duplicate_tool' },
  ];
  for (const fixture of cases) {
    const snapshots = [{ boundary: 'source', provenance, tools: projected.tools },
      { boundary: 'server', provenance: fixture.provenance, tools: fixture.tools }];
    const before = JSON.stringify(snapshots);
    const serialized = assembleSnapshotManifest(expected, snapshots);
    noPrivate(serialized);
    const manifest = JSON.parse(serialized);
    assert.deepEqual(manifest.snapshots, snapshots);
    assert.equal(JSON.stringify(snapshots), before);
    const comparison = compareSnapshotManifest(manifest, reference);
    const server = comparison.boundaries.find(item => item.boundary === 'server');
    assert.equal(server.status, fixture.status);
    assert.ok(server.reasons.includes(fixture.reason));
    for (const boundary of ['host', 'submitted', 'released']) {
      assert.deepEqual(comparison.boundaries.find(item => item.boundary === boundary).reasons, ['not_supplied']);
    }
  }
  const unobserved = { boundary: 'server', provenance: { ...provenance, observed: false }, tools: projected.tools };
  const uncaptured = { boundary: 'host', provenance, tools: null };
  const retained = JSON.parse(assembleSnapshotManifest(expected, [unobserved, uncaptured]));
  assert.deepEqual(retained.snapshots, [unobserved, uncaptured]);
  assert.equal(compareSnapshotManifest(retained, reference).verdict, 'unknown');
});

test('ready projection does not waive the independent aggregate manifest byte budget', () => {
  const overhead = Buffer.byteLength(JSON.stringify(ready(projectToolsListResult({ tools: [{ name: 'a', description: '' }] }))));
  const projected = ready(projectToolsListResult({ tools: [{ name: 'a',
    description: 'x'.repeat(PROJECTION_LIMITS.maxOutputBytes - overhead) }] }));
  assert.equal(Buffer.byteLength(JSON.stringify(projected)), PROJECTION_LIMITS.maxOutputBytes);
  const expected = { identity: 'dharma-agent-fabric', version: 'v-test' };
  const provenance = { observed: true, ...expected };
  const snapshots = ['source', 'server'].map(boundary => ({ boundary, provenance, tools: projected.tools }));
  const before = JSON.stringify(snapshots);
  assert.throws(() => assembleSnapshotManifest(expected, snapshots), { message: 'snapshot_assembly_too_large' });
  assert.equal(JSON.stringify(snapshots), before);
});
