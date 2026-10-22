// Pure projector: raw MCP tools/list RESULT object -> closed tool fragment.
//
// API: projectToolsListResult(result) returns either
//   { schema, status: 'ready', tools: [...], counts: { tools, droppedResultKeys,
//     droppedToolKeys, droppedAnnotationKeys } }
// or { schema, status: 'rejected', code } with a code from PROJECTION_CODES.
// Input problems never throw; the only thrown error is a fixed internal
// contract message. No file/network/process access and no provenance,
// identity, version, observation, confirmation or consent is produced: the
// caller supplies those when it builds a manifest v1 snapshot.
//
// Tools keep only manifest v1 fields (name, title, description, annotations,
// inputSchema, outputSchema) and known annotation keys; everything else is
// dropped and only counted. Kept values are copied verbatim (order,
// duplicates and opaque schema keywords preserved). This is not a secret
// sanitizer: allowed documentation and schema text is retained.
import { createRequire } from 'node:module';
import { types } from 'node:util';

export const PROJECTION_SCHEMA = 'dharma.mcp-tools-list-projection/v1';
export const PROJECTION_CODES = Object.freeze(['input_not_json', 'input_too_deep', 'input_too_large',
  'result_not_object', 'envelope_not_result', 'tools_missing', 'tools_not_array', 'incomplete_pagination',
  'tools_too_many', 'tool_malformed', 'output_too_large']);
export const PROJECTION_LIMITS = Object.freeze({
  maxTools: 1000,
  maxDepth: 128,
  maxNodes: 100_000,
  maxInputBytes: 4 * 1024 * 1024, // Exact JSON.stringify representation, not unobserved wire bytes.
  maxOutputBytes: 1024 * 1024,
});

const TOOL_FIELDS = Object.freeze(['name', 'title', 'description', 'annotations', 'inputSchema', 'outputSchema']);
const ANNOTATION_FIELDS = Object.freeze(['title', 'readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint']);
// A JSON-RPC response or error object is not a tools/list result.
const ENVELOPE_KEYS = Object.freeze(['jsonrpc', 'result', 'error']);
const MANIFEST_ID = 'https://schemas.dharma-ai.io/mcp-snapshot-manifest/v1';
const PROJECTION_ID = 'https://schemas.dharma-ai.io/mcp-tools-list-projection/v1';

const require = createRequire(import.meta.url);
let contracts;
function projectionContracts() {
  if (contracts) return contracts;
  const Ajv2020 = require('ajv/dist/2020.js').default;
  const formatsModule = require('ajv-formats');
  const ajv = new Ajv2020({ allErrors: true, strict: true, strictRequired: false });
  (formatsModule.default ?? formatsModule)(ajv);
  ajv.addSchema(require('../schemas/mcp-snapshot-manifest.schema.json'));
  ajv.addSchema(require('../schemas/mcp-tools-list-projection.schema.json'));
  contracts = Object.freeze({
    input: ajv.getSchema(`${PROJECTION_ID}#/$defs/inputResult`),
    tool: ajv.compile({ $ref: `${MANIFEST_ID}#/$defs/tool` }),
    output: ajv.getSchema(PROJECTION_ID),
  });
  return contracts;
}

class Rejection { constructor(code) { this.code = code; } }
const reject = code => { throw new Rejection(code); };

function countBytes(state, bytes) {
  state.bytes += bytes;
  if (state.bytes > PROJECTION_LIMITS.maxInputBytes) reject('input_too_large');
}

function countString(state, value) {
  // A primitive string cannot invoke toJSON. The length guard bounds the
  // temporary escaped representation even for dropped control-character data.
  if (value.length > PROJECTION_LIMITS.maxInputBytes - state.bytes) reject('input_too_large');
  countBytes(state, Buffer.byteLength(JSON.stringify(value), 'utf8'));
}

// Validates the whole input as plain JSON data without invoking getters,
// proxies or toJSON, before anything is copied or serialized.
function inspect(value, depth, state) {
  if (depth > PROJECTION_LIMITS.maxDepth) reject('input_too_deep');
  if (++state.nodes > PROJECTION_LIMITS.maxNodes) reject('input_too_large');
  if (value === null) countBytes(state, 4);
  else if (typeof value === 'string') countString(state, value);
  else if (typeof value === 'boolean') countBytes(state, value ? 4 : 5);
  else if (typeof value === 'number') {
    if (!Number.isFinite(value)) reject('input_not_json');
    countBytes(state, String(value).length);
  } else if (typeof value === 'object') {
    if (types.isProxy(value)) reject('input_not_json');
    const keys = Reflect.ownKeys(value);
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype || keys.length !== value.length + 1) reject('input_not_json');
      countBytes(state, 2 + Math.max(0, value.length - 1));
      for (let index = 0; index < value.length; index++) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor || !Object.hasOwn(descriptor, 'value')) reject('input_not_json');
        inspect(descriptor.value, depth + 1, state);
      }
    } else {
      const prototype = Object.getPrototypeOf(value);
      if (prototype !== Object.prototype && prototype !== null) reject('input_not_json');
      countBytes(state, 2 + Math.max(0, keys.length - 1));
      for (const key of keys) {
        if (typeof key !== 'string') reject('input_not_json');
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) reject('input_not_json');
        countString(state, key);
        countBytes(state, 1);
        inspect(descriptor.value, depth + 1, state);
      }
    }
  } else reject('input_not_json');
}

const isPlainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

// Verbatim copy of inspected JSON data; own keys are defined, never assigned,
// so a "__proto__" key stays data and cannot change any prototype.
function copy(value) {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(copy);
  const out = {};
  for (const key of Object.keys(value)) {
    Object.defineProperty(out, key, { value: copy(value[key]), enumerable: true, writable: true, configurable: true });
  }
  return out;
}

function projectTool(tool, counts) {
  if (!isPlainObject(tool)) reject('tool_malformed');
  const projected = {};
  for (const key of Object.keys(tool)) if (!TOOL_FIELDS.includes(key)) counts.droppedToolKeys++;
  for (const field of TOOL_FIELDS) {
    if (!Object.hasOwn(tool, field)) continue;
    const value = tool[field];
    if (field === 'annotations' && isPlainObject(value)) {
      const annotations = {};
      for (const key of Object.keys(value)) {
        if (ANNOTATION_FIELDS.includes(key)) annotations[key] = value[key];
        else counts.droppedAnnotationKeys++;
      }
      projected.annotations = annotations;
    } else projected[field] = copy(value);
  }
  if (!projectionContracts().tool(projected)) reject('tool_malformed');
  return projected;
}

function project(result) {
  inspect(result, 0, { nodes: 0, bytes: 0 });
  if (!isPlainObject(result)) reject('result_not_object');
  const keys = Object.keys(result);
  if (keys.some(key => ENVELOPE_KEYS.includes(key))) reject('envelope_not_result');
  if (!Object.hasOwn(result, 'tools')) reject('tools_missing');
  if (!Array.isArray(result.tools)) reject('tools_not_array');
  // Any continuation marker, including empty, null or malformed cursors, means
  // the list may be incomplete: fail closed rather than truncate.
  if (Object.hasOwn(result, 'nextCursor')) reject('incomplete_pagination');
  if (result.tools.length > PROJECTION_LIMITS.maxTools) reject('tools_too_many');
  if (!projectionContracts().input(result)) reject('tool_malformed');
  const counts = { tools: result.tools.length, droppedResultKeys: keys.filter(key => key !== 'tools').length,
    droppedToolKeys: 0, droppedAnnotationKeys: 0 };
  const tools = result.tools.map(tool => projectTool(tool, counts));
  const output = { schema: PROJECTION_SCHEMA, status: 'ready', tools, counts };
  if (Buffer.byteLength(JSON.stringify(output), 'utf8') > PROJECTION_LIMITS.maxOutputBytes) reject('output_too_large');
  return output;
}

export function projectToolsListResult(result) {
  let output;
  try {
    output = project(result);
  } catch (error) {
    if (!(error instanceof Rejection)) throw new Error('tools_list_projection_failed');
    output = { schema: PROJECTION_SCHEMA, status: 'rejected', code: error.code };
  }
  if (!projectionContracts().output(output)) throw new Error('tools_list_projection_contract_invalid');
  return output;
}
