// Offline MCP tool snapshot compatibility comparator.
//
// Compares explicitly supplied snapshots at five evidence boundaries against
// the public catalog reference. Names and counts never prove execution.
// Missing, unobserved, partial or malformed evidence is UNKNOWN or INVALID,
// never compatible. The receipt carries only fixed codes, boundary names and
// validated tool names: no descriptions, defaults, examples, schema property
// names, provenance extras or invalid names are echoed.
import { createHash } from 'node:crypto';

export const BOUNDARIES = Object.freeze(['source', 'host', 'server', 'submitted', 'released']);
export const MANIFEST_SCHEMA = 'dharma.mcp-snapshot-manifest/v1';
export const RECEIPT_SCHEMA = 'dharma.mcp-snapshot-compatibility-receipt/v1';
const TOOL_NAME = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;
const MAX_TOOLS = 1000;
const MAX_DEPTH = 32;
const SEVERITY = { compatible: 0, unknown: 1, incompatible: 2, invalid: 3 };

const isPlain = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
const sorted = values => [...new Set(values)].sort();
const worst = (a, b) => (SEVERITY[b] > SEVERITY[a] ? b : a);

// Provenance identity/version must be meaningful: non-blank, bounded strings.
const nonBlank = value => typeof value === 'string' && value.trim() !== '' && value.length <= 200;

// Only explicit standard MCP tool annotation hints are compared or emitted.
// Unknown keys are counted, never echoed; `title` is documentation only.
export const KNOWN_ANNOTATIONS = Object.freeze(['destructiveHint', 'idempotentHint', 'openWorldHint', 'readOnlyHint']);
const DOCUMENTATION_ANNOTATIONS = new Set(['title']);
function readAnnotations(value) {
  if (!isPlain(value)) return null;
  const values = {};
  let unknownFields = 0;
  let malformed = false;
  for (const key of Object.keys(value)) {
    if (KNOWN_ANNOTATIONS.includes(key)) {
      if (typeof value[key] === 'boolean') values[key] = value[key];
      else malformed = true;
    } else if (!DOCUMENTATION_ANNOTATIONS.has(key)) unknownFields++;
  }
  return { values, unknownFields, malformed };
}

// Bounded structural schema contract. Supported validation constraints are
// preserved in the digest; documentation keywords are ignored; any other
// keyword ($ref, allOf, oneOf, anyOf, not, if/then/else, patternProperties,
// ...) is UNSUPPORTED and malformed values or over-depth nesting are
// MALFORMED. Neither is ever digested as comparable evidence. Property names
// and constraint values participate in the digest but are never output.
const SCHEMA_TYPES = new Set(['string', 'number', 'integer', 'boolean', 'object', 'array', 'null']);
const DOCUMENTATION_KEYWORDS = new Set(['description', 'title', 'default', 'examples', '$comment', 'deprecated',
  'readOnly', 'writeOnly', '$schema', '$id']);
const NUMBER_KEYWORDS = new Set(['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf']);
const COUNT_KEYWORDS = new Set(['minLength', 'maxLength', 'minItems', 'maxItems', 'minProperties', 'maxProperties']);
const STRING_KEYWORDS = new Set(['pattern', 'format']);
class SchemaIssue { constructor(kind) { this.kind = kind; } }
const MAX_PATTERN_LENGTH = 1024;
// Compile-only check; the pattern is never executed against data.
function compiles(pattern, flags) {
  if (pattern.length > MAX_PATTERN_LENGTH) return false;
  try { new RegExp(pattern, flags); return true; } catch { return false; }
}
const malformed = () => new SchemaIssue('malformed');

function canonicalSchema(schema, depth = 0) {
  if (depth > MAX_DEPTH || !isPlain(schema)) throw malformed();
  const out = {};
  for (const key of Object.keys(schema).sort()) {
    const value = schema[key];
    if (DOCUMENTATION_KEYWORDS.has(key)) continue;
    if (key === 'type') {
      // Scalar known type, or a non-empty array of unique known types.
      // Duplicates are rejected before sorting so they cannot normalize away.
      const types = Array.isArray(value) ? value : [value];
      if (!types.length || !types.every(item => typeof item === 'string' && SCHEMA_TYPES.has(item))
        || new Set(types).size !== types.length) throw malformed();
      out.type = Array.isArray(value) ? [...types].sort() : value;
    } else if (key === 'properties') {
      if (!isPlain(value)) throw malformed();
      out.properties = Object.fromEntries(Object.keys(value).sort().map(name => [name, canonicalSchema(value[name], depth + 1)]));
    } else if (key === 'required') {
      // Array of unique strings (empty allowed); duplicates rejected before sorting.
      if (!Array.isArray(value) || !value.every(item => typeof item === 'string')
        || new Set(value).size !== value.length) throw malformed();
      out.required = [...value].sort();
    } else if (key === 'items') {
      if (Array.isArray(value)) throw new SchemaIssue('unsupported');
      out.items = canonicalSchema(value, depth + 1);
    } else if (key === 'additionalProperties') {
      out.additionalProperties = typeof value === 'boolean' ? value : canonicalSchema(value, depth + 1);
    } else if (key === 'enum') {
      if (!Array.isArray(value)) throw malformed();
      out.enum = value.map(item => JSON.stringify(item)).sort();
    } else if (key === 'const') {
      out.const = JSON.stringify(value);
    } else if (key === 'uniqueItems') {
      if (typeof value !== 'boolean') throw malformed();
      out.uniqueItems = value;
    } else if (NUMBER_KEYWORDS.has(key)) {
      // Draft-4 boolean exclusiveMinimum/exclusiveMaximum is a valid but
      // unimplemented form: UNKNOWN rather than malformed.
      if ((key === 'exclusiveMinimum' || key === 'exclusiveMaximum') && typeof value === 'boolean') {
        throw new SchemaIssue('unsupported');
      }
      if (typeof value !== 'number' || !Number.isFinite(value)) throw malformed();
      if (key === 'multipleOf' && !(value > 0)) throw malformed();
      out[key] = value;
    } else if (COUNT_KEYWORDS.has(key)) {
      if (!Number.isSafeInteger(value) || value < 0) throw malformed();
      out[key] = value;
    } else if (key === 'pattern') {
      // ECMA-262 dialect, checked with the unicode flag. A pattern that only
      // compiles without it is a dialect form not implemented here (UNKNOWN);
      // one that compiles in neither mode is malformed (INVALID).
      if (typeof value !== 'string') throw malformed();
      if (!compiles(value, 'u')) throw compiles(value, '') ? new SchemaIssue('unsupported') : malformed();
      out.pattern = value;
    } else if (STRING_KEYWORDS.has(key)) {
      if (typeof value !== 'string') throw malformed();
      out[key] = value;
    } else throw new SchemaIssue('unsupported');
  }
  return out;
}

// { kind: 'missing' | 'malformed' | 'unsupported' | 'ok', digest? }
function schemaEvidence(schema) {
  if (schema === undefined || schema === null || typeof schema === 'boolean') return { kind: 'missing' };
  try {
    return { kind: 'ok', digest: createHash('sha256').update(JSON.stringify(canonicalSchema(schema))).digest('hex') };
  } catch (error) {
    if (error instanceof SchemaIssue) return { kind: error.kind };
    throw error;
  }
}

export function referenceFromCatalog(catalog) {
  return {
    tools: (Array.isArray(catalog?.tools) ? catalog.tools : []).map(tool => ({
      name: tool.name, confirmation: tool.confirmation === true, outputSchema: tool.outputSchema === true,
      annotations: readAnnotations(tool.annotations)?.values ?? {},
    })),
  };
}

function readTools(tools, result) {
  const valid = new Map();
  if (!Array.isArray(tools)) return valid;
  if (tools.length > MAX_TOOLS) { result.reasons.push('tools_too_many'); result.status = 'invalid'; return valid; }
  for (const tool of tools) {
    if (!isPlain(tool)) { result.reasons.push('tool_malformed'); result.status = 'invalid'; continue; }
    if (typeof tool.name !== 'string' || !TOOL_NAME.test(tool.name)) {
      result.invalidToolNameCount++; result.reasons.push('invalid_tool_name'); result.status = 'invalid'; continue;
    }
    if (valid.has(tool.name)) { result.reasons.push('duplicate_tool'); result.status = 'invalid'; continue; }
    valid.set(tool.name, tool);
  }
  return valid;
}

function evaluate(snapshot, expected, referenceTools, sourceSchemas) {
  const result = { boundary: snapshot.boundary, status: 'compatible', reasons: [], invalidToolNameCount: 0,
    missingTools: [], extraTools: [], tools: [] };
  const raise = (status, reason) => { result.status = worst(result.status, status); result.reasons.push(reason); };
  const provenance = snapshot.provenance;
  if (!isPlain(provenance) || !nonBlank(provenance.identity) || !nonBlank(provenance.version)) {
    raise('invalid', 'provenance_incomplete');
  } else {
    if (provenance.identity !== expected.identity) raise('invalid', 'identity_mismatch');
    if (provenance.version !== expected.version) raise('invalid', 'version_mismatch');
  }
  if (!isPlain(provenance) || provenance.observed !== true) raise('unknown', 'unobserved');
  if (snapshot.tools === null || snapshot.tools === undefined) { raise('unknown', 'tools_missing'); return result; }
  if (!Array.isArray(snapshot.tools)) { raise('invalid', 'tools_malformed'); return result; }
  const tools = readTools(snapshot.tools, result);
  const referenceNames = new Set(referenceTools.map(tool => tool.name));
  result.missingTools = sorted([...referenceNames].filter(name => !tools.has(name)));
  result.extraTools = sorted([...tools.keys()].filter(name => !referenceNames.has(name)));
  if (result.missingTools.length) raise('incompatible', 'missing_tools');
  if (result.extraTools.length) raise('incompatible', 'extra_tools');
  for (const reference of [...referenceTools].sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const tool = tools.get(reference.name);
    if (!tool) continue;
    const entry = { name: reference.name };
    entry.confirmation = typeof tool.confirmation === 'boolean'
      ? (tool.confirmation === reference.confirmation ? 'equal' : 'different') : 'unknown';
    if (entry.confirmation === 'different') raise('incompatible', 'confirmation_mismatch');
    if (entry.confirmation === 'unknown') raise('unknown', 'confirmation_evidence_missing');
    const annotations = readAnnotations(tool.annotations);
    if (annotations === null) {
      entry.annotations = 'unknown'; entry.annotationDifferences = [];
      raise('unknown', 'annotation_evidence_missing');
    } else {
      if (annotations.malformed) raise('invalid', 'annotation_malformed');
      if (annotations.unknownFields > 0) raise('unknown', 'annotation_unknown_field');
      // Emitted identifiers come only from the fixed KNOWN_ANNOTATIONS list.
      entry.annotationDifferences = KNOWN_ANNOTATIONS.filter(key => annotations.values[key] !== reference.annotations[key]);
      entry.annotations = entry.annotationDifferences.length ? 'different'
        : (annotations.malformed || annotations.unknownFields > 0 ? 'unknown' : 'equal');
      if (entry.annotationDifferences.length) raise('incompatible', 'annotation_mismatch');
    }
    for (const field of ['inputSchema', 'outputSchema']) {
      const evidence = schemaEvidence(tool[field]);
      const expectedEvidence = sourceSchemas?.get(reference.name)?.[field];
      if (evidence.kind === 'missing') { entry[field] = 'unknown'; raise('unknown', 'schema_evidence_missing'); }
      else if (evidence.kind === 'malformed') { entry[field] = 'invalid'; raise('invalid', 'schema_malformed'); }
      else if (evidence.kind === 'unsupported') { entry[field] = 'unknown'; raise('unknown', 'schema_unsupported'); }
      else if (expectedEvidence?.kind !== 'ok') { entry[field] = 'unknown'; raise('unknown', 'schema_reference_missing'); }
      else {
        entry[field] = evidence.digest === expectedEvidence.digest ? 'equal' : 'different';
        if (entry[field] === 'different') raise('incompatible', 'schema_mismatch');
      }
    }
    result.tools.push(entry);
  }
  return result;
}

function finalize(result) {
  return { ...result, reasons: sorted(result.reasons) };
}

export function compareSnapshotManifest(manifest, reference) {
  const referenceTools = Array.isArray(reference?.tools) ? reference.tools.filter(tool => TOOL_NAME.test(tool?.name ?? '')) : [];
  const manifestErrors = [];
  const supplied = new Map();
  if (!isPlain(manifest)) manifestErrors.push('manifest_malformed');
  else {
    if (manifest.schema !== MANIFEST_SCHEMA) manifestErrors.push('manifest_schema_unsupported');
    if (!isPlain(manifest.expected) || !nonBlank(manifest.expected.identity)
      || !nonBlank(manifest.expected.version)) manifestErrors.push('expected_provenance_missing');
    if (!Array.isArray(manifest.snapshots)) manifestErrors.push('snapshots_malformed');
  }
  const expected = isPlain(manifest?.expected) ? manifest.expected : {};
  const snapshots = Array.isArray(manifest?.snapshots) ? manifest.snapshots : [];
  for (const snapshot of snapshots) {
    if (!isPlain(snapshot)) { manifestErrors.push('snapshot_malformed'); continue; }
    if (!BOUNDARIES.includes(snapshot.boundary)) { manifestErrors.push('unsupported_boundary'); continue; }
    if (!supplied.has(snapshot.boundary)) supplied.set(snapshot.boundary, []);
    supplied.get(snapshot.boundary).push(snapshot);
  }
  // Schema reference: the single, valid, observed source snapshot only.
  let sourceSchemas = null;
  const source = supplied.get('source');
  if (source?.length === 1) {
    const check = evaluate(source[0], expected, referenceTools, null);
    if (check.status !== 'invalid' && !check.reasons.includes('unobserved') && Array.isArray(source[0].tools)) {
      sourceSchemas = new Map(source[0].tools.filter(tool => isPlain(tool) && TOOL_NAME.test(tool.name ?? ''))
        .map(tool => [tool.name, { inputSchema: schemaEvidence(tool.inputSchema), outputSchema: schemaEvidence(tool.outputSchema) }]));
    }
  }
  const boundaries = BOUNDARIES.map(boundary => {
    const occurrences = supplied.get(boundary);
    if (!occurrences) return { boundary, status: 'unknown', reasons: ['not_supplied'] };
    if (occurrences.length > 1) {
      manifestErrors.push('duplicate_boundary');
      const merged = occurrences.map(snapshot => evaluate(snapshot, expected, referenceTools, sourceSchemas));
      return finalize({ boundary, status: 'invalid',
        reasons: ['duplicate_boundary', ...merged.flatMap(item => item.reasons)],
        invalidToolNameCount: merged.reduce((sum, item) => sum + item.invalidToolNameCount, 0),
        missingTools: [], extraTools: [], tools: [] });
    }
    return finalize(evaluate(occurrences[0], expected, referenceTools, sourceSchemas));
  });
  const errors = sorted(manifestErrors);
  let verdict = errors.length ? 'invalid' : 'compatible';
  for (const item of boundaries) verdict = worst(verdict, item.status);
  return { schema: RECEIPT_SCHEMA, verdict, executionProven: false, referenceToolCount: referenceTools.length,
    manifestErrors: errors, boundaries };
}
