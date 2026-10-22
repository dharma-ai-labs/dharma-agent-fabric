// Unsigned raw-input integrity for the offline snapshot assembler.
// verifySnapshotInputIntegrity(sidecar, rawInputs) checks one ordered
// sha256/byte-length entry per raw input buffer and returns either
// { ok: true, inputCount } or { ok: false, code } with a fixed code. A match is
// structural byte integrity only: no provenance, issuer, authenticity,
// observation or permission is established, and comparator evidence is never
// upgraded. Inputs are inspected through own data properties and intrinsic
// typed-array getters only; no user getter, proxy trap or toJSON is invoked.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { types } from 'node:util';

export const SNAPSHOT_INPUT_INTEGRITY_SCHEMA = 'dharma.mcp-snapshot-input-integrity/v1';
export const MAX_SIDECAR_BYTES = 64 * 1024;

const MAX_INPUTS = 32;
const require = createRequire(import.meta.url);
const utf8 = new TextDecoder('utf-8', { fatal: true });
const intrinsicByteLength = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Uint8Array.prototype), 'byteLength').get;
let validateSidecar;

function sidecarValidator() {
  if (!validateSidecar) {
    const Ajv2020 = require('ajv/dist/2020.js').default;
    const ajv = new Ajv2020({ allErrors: true, strict: true, strictRequired: false });
    validateSidecar = ajv.compile(JSON.parse(readFileSync(
      new URL('../schemas/mcp-snapshot-provenance.schema.json', import.meta.url), 'utf8')));
  }
  return validateSidecar;
}

// Plain JSON data only: no proxies, accessors, symbols, custom prototypes or
// non-finite numbers. Depth is small because the closed envelope is shallow.
function plainJson(value, depth = 0) {
  if (depth > 4) return false;
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value !== 'object' || types.isProxy(value)) return false;
  const array = Array.isArray(value);
  const prototype = Object.getPrototypeOf(value);
  if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) return false;
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string') return false;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!Object.hasOwn(descriptor, 'value')) return false;
    if (array && key === 'length') continue;
    if (!descriptor.enumerable || !plainJson(descriptor.value, depth + 1)) return false;
  }
  return true;
}

function ownDataList(value) {
  if (typeof value !== 'object' || value === null || types.isProxy(value) || !Array.isArray(value)
    || Object.getPrototypeOf(value) !== Array.prototype) return null;
  const length = Object.getOwnPropertyDescriptor(value, 'length').value;
  if (length > MAX_INPUTS) return null;
  const items = [];
  for (let index = 0; index < length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) return null;
    items.push(descriptor.value);
  }
  return items;
}

function exactBytes(value) {
  if (typeof value !== 'object' || value === null || types.isProxy(value) || !types.isUint8Array(value)) return null;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Uint8Array.prototype && prototype !== Buffer.prototype) return null;
  for (const key of ['byteLength', 'byteOffset', 'buffer', 'length']) {
    if (Object.getOwnPropertyDescriptor(value, key)) return null;
  }
  return value;
}

export function verifySnapshotInputIntegrity(sidecar, rawInputs) {
  if (!plainJson(sidecar) || sidecar === null || !sidecarValidator()(sidecar)) {
    return { ok: false, code: 'snapshot_sidecar_invalid' };
  }
  const items = ownDataList(rawInputs);
  const buffers = items?.map(exactBytes);
  if (!buffers || buffers.length > MAX_INPUTS || buffers.some(item => item === null)) {
    return { ok: false, code: 'snapshot_input_integrity_inputs_invalid' };
  }
  if (sidecar.inputs.length !== buffers.length) return { ok: false, code: 'snapshot_sidecar_invalid' };
  for (const [index, bytes] of buffers.entries()) {
    const expected = sidecar.inputs[index];
    if (Reflect.apply(intrinsicByteLength, bytes, []) !== expected.bytes
      || createHash('sha256').update(bytes).digest('hex') !== expected.sha256) {
      return { ok: false, code: 'snapshot_input_integrity_mismatch' };
    }
  }
  return { ok: true, inputCount: buffers.length };
}

// Strict UTF-8/JSON decode of already-read sidecar bytes. Unreadable text or
// JSON and invalid structure have distinct fixed codes; nothing is echoed.
export function decodeSnapshotSidecar(bytes) {
  let value;
  try {
    value = JSON.parse(utf8.decode(bytes));
  } catch {
    return { ok: false, code: 'snapshot_sidecar_unreadable' };
  }
  if (!plainJson(value) || value === null || !sidecarValidator()(value)) return { ok: false, code: 'snapshot_sidecar_invalid' };
  return { ok: true, sidecar: value };
}
