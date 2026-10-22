// Contract tests for the offline MCP snapshot manifest (input) and
// compatibility receipt (output) schemas. They validate the receipts actually
// emitted by scripts/mcp-catalog-drift.mjs; they do not re-implement or modify
// the comparator. Offline only: no SDK, server process or network.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import test from 'node:test';
import { BOUNDARIES, KNOWN_ANNOTATIONS, compareSnapshotManifest, referenceFromCatalog } from './mcp-catalog-drift.mjs';

const require = createRequire(import.meta.url);
const Ajv2020 = require('ajv/dist/2020.js').default ?? require('ajv/dist/2020.js');
const addFormatsModule = require('ajv-formats');
const addFormats = addFormatsModule.default ?? addFormatsModule;

const root = resolve(import.meta.dirname, '..');
const schemaDir = resolve(root, 'schemas');
const MANIFEST_ID = 'https://schemas.dharma-ai.io/mcp-snapshot-manifest/v1';
const RECEIPT_ID = 'https://schemas.dharma-ai.io/mcp-snapshot-compatibility-receipt/v1';
const readJson = path => JSON.parse(readFileSync(path, 'utf8'));
const manifestSchema = () => readJson(resolve(schemaDir, 'mcp-snapshot-manifest.schema.json'));
const receiptSchema = () => readJson(resolve(schemaDir, 'mcp-snapshot-compatibility-receipt.schema.json'));
const fixture = readJson(resolve(root, 'scripts/fixtures/mcp-catalog-drift/cases.json'));
const catalog = readJson(resolve(root, 'plugins/dharma-agent-fabric/openai-app/mcp-tool-catalog.json'));
const clone = value => structuredClone(value);

function validators() {
  // Same options as scripts/validate-schemas.mjs.
  const ajv = new Ajv2020({ allErrors: true, strict: true, strictRequired: false });
  addFormats(ajv);
  ajv.addSchema(manifestSchema());
  ajv.addSchema(receiptSchema());
  return { manifest: ajv.getSchema(MANIFEST_ID), receipt: ajv.getSchema(RECEIPT_ID), ajv };
}
const accepts = (validate, value) => validate(value) === true;

test('both contracts exist, use JSON Schema 2020-12, follow the $id convention and compile under strict Ajv', () => {
  const manifest = manifestSchema();
  const receipt = receiptSchema();
  for (const [schema, id] of [[manifest, MANIFEST_ID], [receipt, RECEIPT_ID]]) {
    assert.equal(schema.$schema, 'https://json-schema.org/draft/2020-12/schema');
    assert.equal(schema.$id, id);
    assert.equal(schema.additionalProperties, false);
  }
  assert.equal(manifest.properties.schema.const, 'dharma.mcp-snapshot-manifest/v1');
  assert.equal(receipt.properties.schema.const, 'dharma.mcp-snapshot-compatibility-receipt/v1');
  const { manifest: m, receipt: r } = validators();
  assert.equal(typeof m, 'function');
  assert.equal(typeof r, 'function');
  const otherIds = readdirSync(schemaDir).filter(name => name.endsWith('.schema.json')
    && !name.startsWith('mcp-snapshot-')).map(name => readJson(resolve(schemaDir, name)).$id);
  assert.equal(otherIds.includes(MANIFEST_ID) || otherIds.includes(RECEIPT_ID), false, 'no $id collision');
});

test('every receipt the comparator emits for the fixture cases validates, covering all four verdicts', () => {
  const { receipt } = validators();
  const verdicts = new Set();
  for (const [name, manifest] of Object.entries(fixture.cases)) {
    const emitted = compareSnapshotManifest(clone(manifest), fixture.reference);
    assert.ok(accepts(receipt, emitted), `${name}: ${JSON.stringify(receipt.errors)}`);
    verdicts.add(emitted.verdict);
  }
  const extra = [
    compareSnapshotManifest(null, fixture.reference),
    compareSnapshotManifest({ schema: 'dharma.mcp-snapshot-manifest/v1', expected: { identity: 'a', version: '1' }, snapshots: [] }, fixture.reference),
    compareSnapshotManifest({ schema: 'other/v1' }, referenceFromCatalog(catalog)),
  ];
  for (const emitted of extra) {
    assert.ok(accepts(receipt, emitted), JSON.stringify(receipt.errors));
    verdicts.add(emitted.verdict);
  }
  for (const verdict of ['compatible', 'unknown', 'incompatible', 'invalid']) assert.ok(verdicts.has(verdict), verdict);
});

test('not_supplied, duplicate-boundary and missing-tools receipts validate with their exact actual shapes', () => {
  const { receipt } = validators();
  const base = { schema: 'dharma.mcp-snapshot-manifest/v1', expected: { identity: 'dharma-agent-fabric', version: '1.0.0' } };
  const provenance = { observed: true, identity: 'dharma-agent-fabric', version: '1.0.0' };
  const empty = compareSnapshotManifest({ ...base, snapshots: [] }, fixture.reference);
  assert.deepEqual(empty.boundaries.map(item => item.reasons), BOUNDARIES.map(() => ['not_supplied']));
  assert.ok(accepts(receipt, empty), JSON.stringify(receipt.errors));
  const duplicate = compareSnapshotManifest({ ...base, snapshots: [
    { boundary: 'host', provenance, tools: [] }, { boundary: 'host', provenance, tools: [] }] }, fixture.reference);
  assert.equal(duplicate.verdict, 'invalid');
  assert.ok(duplicate.manifestErrors.includes('duplicate_boundary'));
  assert.ok(accepts(receipt, duplicate), JSON.stringify(receipt.errors));
  const missingTools = compareSnapshotManifest({ ...base, snapshots: [{ boundary: 'server', provenance, tools: null }] }, fixture.reference);
  assert.ok(missingTools.boundaries.find(item => item.boundary === 'server').reasons.includes('tools_missing'));
  assert.ok(accepts(receipt, missingTools), JSON.stringify(receipt.errors));
});

test('receipt contract rejects private fields, unknown codes, wrong verdicts, signed claims and malformed boundaries', () => {
  const { receipt } = validators();
  const good = compareSnapshotManifest(clone(fixture.cases.drift), fixture.reference);
  assert.ok(accepts(receipt, good));
  const evaluatedIndex = good.boundaries.findIndex(item => Array.isArray(item.tools) && item.tools.length > 0);
  assert.ok(evaluatedIndex >= 0);
  const mutations = {
    topLevelToken: r => { r.token = 'CANARY_SECRET'; },
    verdictPass: r => { r.verdict = 'pass'; },
    executionProvenTrue: r => { r.executionProven = true; },
    negativeCount: r => { r.referenceToolCount = -1; },
    unknownManifestError: r => { r.manifestErrors = ['private_reason']; },
    fourBoundaries: r => { r.boundaries = r.boundaries.slice(0, 4); },
    reorderedBoundaries: r => { r.boundaries = [...r.boundaries].reverse(); },
    boundaryExtraField: r => { r.boundaries[evaluatedIndex].description = 'CANARY'; },
    boundaryBadStatus: r => { r.boundaries[evaluatedIndex].status = 'ok'; },
    boundaryUnknownReason: r => { r.boundaries[evaluatedIndex].reasons = ['PRIVATE_REASON']; },
    toolPrivateField: r => { r.boundaries[evaluatedIndex].tools[0].schemaBody = { secret: true }; },
    toolBadName: r => { r.boundaries[evaluatedIndex].tools[0].name = 'token=SECRET'; },
    annotationCanary: r => { r.boundaries[evaluatedIndex].tools[0].annotationDifferences = ['PRIVATE_SCHEMA_METADATA_CANARY']; },
    toolBadSchemaStatus: r => { r.boundaries[evaluatedIndex].tools[0].inputSchema = 'same'; },
    missingToolBadName: r => { r.boundaries[evaluatedIndex].missingTools = ['bad name!']; },
    notSuppliedExtraReason: r => { r.boundaries[0] = { boundary: r.boundaries[0].boundary, status: 'unknown', reasons: ['not_supplied', 'unobserved'] }; },
    notSuppliedWrongStatus: r => { r.boundaries[0] = { boundary: r.boundaries[0].boundary, status: 'compatible', reasons: ['not_supplied'] }; },
    signedClaim: r => { r.signature = 'sig'; },
  };
  for (const [name, mutate] of Object.entries(mutations)) {
    const value = clone(good);
    mutate(value);
    assert.equal(accepts(receipt, value), false, name);
  }
  for (const key of KNOWN_ANNOTATIONS) {
    const value = clone(good);
    value.boundaries[evaluatedIndex].tools[0].annotationDifferences = [key];
    assert.ok(accepts(receipt, value), `${key}: ${JSON.stringify(receipt.errors)}`);
  }
});

test('manifest contract accepts complete, partial, empty and duplicate-boundary inputs without forcing completeness', () => {
  const { manifest } = validators();
  for (const name of ['compatible', 'drift', 'unknown']) {
    assert.ok(accepts(manifest, clone(fixture.cases[name])), `${name}: ${JSON.stringify(manifest.errors)}`);
  }
  const base = { schema: 'dharma.mcp-snapshot-manifest/v1', expected: { identity: 'dharma-agent-fabric', version: '1.0.0' } };
  const provenance = { observed: true, identity: 'dharma-agent-fabric', version: '1.0.0' };
  assert.ok(accepts(manifest, { ...base, snapshots: [] }), 'empty snapshot list is structurally valid (all boundaries UNKNOWN)');
  assert.ok(accepts(manifest, { ...base, snapshots: [{ boundary: 'host', provenance, tools: [] }] }), 'partial');
  const duplicate = { ...base, snapshots: [{ boundary: 'host', provenance, tools: [] }, { boundary: 'host', provenance, tools: [] }] };
  assert.ok(accepts(manifest, duplicate), 'duplicate boundary is a semantic check, left to the comparator');
  assert.equal(compareSnapshotManifest(duplicate, fixture.reference).verdict, 'invalid');
  // Embedded tool schemas remain arbitrary legitimate JSON Schema evidence.
  for (const inputSchema of [true, false, { $ref: '#/$defs/x', $defs: { x: { type: 'string' } } },
    { allOf: [{ type: 'string' }], 'x-vendor': { anything: [1, 2] } }]) {
    assert.ok(accepts(manifest, { ...base, snapshots: [{ boundary: 'server', provenance,
      tools: [{ name: 'a_read', inputSchema, outputSchema: { type: 'object' } }] }] }), JSON.stringify(manifest.errors));
  }
});

test('manifest contract rejects malformed provenance, statuses, envelopes and private fields', () => {
  const { manifest } = validators();
  const good = clone(fixture.cases.compatible);
  assert.ok(accepts(manifest, good));
  const mutations = {
    wrongSchema: m => { m.schema = 'dharma.mcp-snapshot-manifest/v2'; },
    missingExpected: m => { delete m.expected; },
    blankExpectedIdentity: m => { m.expected.identity = '   '; },
    emptyExpectedVersion: m => { m.expected.version = ''; },
    longIdentity: m => { m.expected.identity = 'x'.repeat(201); },
    expectedExtra: m => { m.expected.token = 'CANARY'; },
    topLevelExtra: m => { m.credentials = 'CANARY'; },
    snapshotsNotArray: m => { m.snapshots = {}; },
    unsupportedBoundary: m => { m.snapshots[0].boundary = 'staging'; },
    snapshotExtra: m => { m.snapshots[0].status = 'compatible'; },
    provenanceMissingObserved: m => { delete m.snapshots[0].provenance.observed; },
    provenanceObservedString: m => { m.snapshots[0].provenance.observed = 'yes'; },
    provenanceBlankVersion: m => { m.snapshots[0].provenance.version = '\t '; },
    provenanceExtraToken: m => { m.snapshots[0].provenance.token = 'CANARY'; },
    toolsString: m => { m.snapshots[0].tools = 'all'; },
    toolBadName: m => { m.snapshots[0].tools[0].name = 'bad name!'; },
    toolPrivateField: m => { m.snapshots[0].tools[0].apiKey = 'CANARY'; },
    toolConfirmationString: m => { m.snapshots[0].tools[0].confirmation = 'true'; },
    annotationNonBoolean: m => { m.snapshots[0].tools[0].annotations.readOnlyHint = 'true'; },
    annotationUnknownKey: m => { m.snapshots[0].tools[0].annotations.PRIVATE_SCHEMA_METADATA_CANARY = true; },
    toolSchemaString: m => { m.snapshots[0].tools[0].inputSchema = 'object'; },
  };
  for (const [name, mutate] of Object.entries(mutations)) {
    const value = clone(good);
    mutate(value);
    assert.equal(accepts(manifest, value), false, name);
  }
  for (const name of ['invalidDuplicate', 'provenanceMismatch', 'secret']) {
    assert.equal(accepts(manifest, clone(fixture.cases[name])), false, `${name} fixture is structurally invalid input`);
  }
});
