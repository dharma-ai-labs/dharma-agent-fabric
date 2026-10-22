// Offline assembly only: supplied snapshots retain their issuer's literal
// provenance. Exit 0 means structural assembly, not compatibility, observed
// execution, issuer authenticity or redaction of permitted schema content.
// --expected-identity <s> --expected-version <s> [--snapshot <file.json>]...
//   [--snapshot-sidecar <file.json>]
// The optional sidecar is an unsigned raw-byte integrity precondition checked
// against the exact bytes parsed; it never adds or upgrades provenance.
// No acquisition, projection, sidecar inference, version mapping or file writes.
import { constants, closeSync, fstatSync, lstatSync, openSync, readFileSync, readSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { MANIFEST_SCHEMA } from './mcp-catalog-drift.mjs';
import { MAX_SIDECAR_BYTES, decodeSnapshotSidecar, verifySnapshotInputIntegrity } from './mcp-snapshot-provenance.mjs';

const MAX_BYTES = 1024 * 1024;
const MAX_FILES = 32;
const require = createRequire(import.meta.url);
const utf8 = new TextDecoder('utf-8', { fatal: true });
let validateManifest;
class AssemblyIssue extends Error {}
const fail = code => { throw new AssemblyIssue(code); };
const nonBlank = value => typeof value === 'string' && value.trim() !== '' && value.length <= 200;

function validator() {
  if (!validateManifest) {
    const Ajv2020 = require('ajv/dist/2020.js').default;
    const formats = require('ajv-formats');
    const ajv = new Ajv2020({ allErrors: true, strict: true, strictRequired: false });
    (formats.default ?? formats)(ajv);
    validateManifest = ajv.compile(JSON.parse(readFileSync(
      new URL('../schemas/mcp-snapshot-manifest.schema.json', import.meta.url), 'utf8')));
  }
  return validateManifest;
}

export function assembleSnapshotManifest(expected, snapshots) {
  const manifest = { schema: MANIFEST_SCHEMA, expected, snapshots };
  if (!validator()(manifest)) fail('snapshot_assembly_invalid');
  // Duplicates and mismatches intentionally remain for the comparator to
  // diagnose. No missing boundary, metadata, schema or observation is invented.
  const output = `${JSON.stringify(manifest, (_key, value) => {
    // JSON.parse accepts overflow as Infinity; JSON.stringify would silently
    // replace it with null, changing opaque schema evidence before comparison.
    if (typeof value === 'number' && !Number.isFinite(value)) fail('snapshot_assembly_invalid');
    return value;
  })}\n`;
  if (Buffer.byteLength(output) > MAX_BYTES) fail('snapshot_assembly_too_large');
  return output;
}

// Reads one bounded regular file exactly once and returns its raw bytes.
function readBounded(path, limit, code) {
  let fd;
  try {
    const before = lstatSync(path);
    if (!before.isFile() || before.isSymbolicLink() || before.size > limit) throw new Error();
    // NONBLOCK prevents a regular-file -> FIFO race from hanging on POSIX.
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino
      || opened.size > limit) throw new Error();
    const buffer = Buffer.alloc(limit + 1);
    let size = 0;
    while (size < buffer.length) {
      const count = readSync(fd, buffer, size, buffer.length - size, size);
      if (count === 0) break;
      size += count;
    }
    const after = fstatSync(fd);
    if (size > limit || size !== opened.size || after.size !== opened.size
      || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs) throw new Error();
    return buffer.subarray(0, size);
  } catch {
    fail(code);
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

// Parses the same buffer that was read (and, with a sidecar, hashed).
function parseSnapshot(bytes) {
  try {
    return JSON.parse(utf8.decode(bytes));
  } catch {
    fail('snapshot_input_unreadable');
  }
}

function parseArguments(args) {
  const values = new Map();
  const paths = [];
  let sidecarPath = null;
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (typeof value !== 'string' || value === '' || value.startsWith('--')) fail('snapshot_assembly_arguments_invalid');
    if (flag === '--snapshot') paths.push(resolve(value));
    else if (flag === '--snapshot-sidecar' && sidecarPath === null) sidecarPath = resolve(value);
    else if (['--expected-identity', '--expected-version'].includes(flag) && !values.has(flag)) values.set(flag, value);
    else fail('snapshot_assembly_arguments_invalid');
  }
  const expected = { identity: values.get('--expected-identity'), version: values.get('--expected-version') };
  if (!nonBlank(expected.identity) || !nonBlank(expected.version) || paths.length > MAX_FILES) {
    fail('snapshot_assembly_arguments_invalid');
  }
  return { expected, paths, sidecarPath };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const { expected, paths, sidecarPath } = parseArguments(process.argv.slice(2));
    let sidecar = null;
    if (sidecarPath !== null) {
      // Independent 64 KiB budget; not deducted from the 1 MiB snapshot budget.
      const decoded = decodeSnapshotSidecar(readBounded(sidecarPath, MAX_SIDECAR_BYTES, 'snapshot_sidecar_unreadable'));
      if (!decoded.ok) fail(decoded.code);
      sidecar = decoded.sidecar;
    }
    const rawInputs = [];
    let remaining = MAX_BYTES;
    for (const path of paths) {
      const bytes = readBounded(path, remaining, 'snapshot_input_unreadable');
      rawInputs.push(bytes);
      remaining -= bytes.length;
    }
    if (sidecar !== null) {
      const integrity = verifySnapshotInputIntegrity(sidecar, rawInputs);
      if (!integrity.ok) fail(integrity.code);
    }
    const snapshots = rawInputs.map(parseSnapshot);
    process.stdout.write(assembleSnapshotManifest(expected, snapshots));
  } catch (error) {
    process.stderr.write(`${error instanceof AssemblyIssue ? error.message : 'snapshot_assembly_unavailable'}\n`);
    process.exitCode = 2;
  }
}
