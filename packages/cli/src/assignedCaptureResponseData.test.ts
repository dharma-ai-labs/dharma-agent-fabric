import assert from 'node:assert/strict';
import { test } from 'node:test';
import { canonicalize, sha256 } from '@dharma-ai-labs/agent-fabric-contracts';
import {
  selectAssignedCapture,
  type CaptureAssignment,
  type AssignedCaptureBinding,
  type ExactSessionReader,
  type ExactSessionReadRequest,
  type AssignedCaptureSelection,
} from './assignedCapture.js';

type Response = Awaited<ReturnType<ExactSessionReader['readExactSession']>>;
type Provider = CaptureAssignment['target']['provider'];
const NOW = Date.parse('2026-10-21T11:35:00Z');
const CANARY = 'SYNTHETIC_RAW_CAPTURE_PRIVATE_CANARY';
const FAILURE = 'capture_selected_source_mismatch';
const id = (n: string) => `${n.repeat(8)}-${n.repeat(4)}-4${n.repeat(3)}-8${n.repeat(3)}-${n.repeat(12)}`;

function fixture(provider: Provider = 'codex', windows = false, generousLimits = false) {
  const assignment: CaptureAssignment = {
    schema: 'dharma.capture-assignment/v1', assignmentId: id('1'), organizationId: 'org_fixture',
    createdAt: '2026-10-21T11:30:00Z', expiresAt: '2026-10-21T12:00:00Z',
    target: {
      accountId: 'user_fixture', membershipId: id('2'), hostId: 'fixture-host', deviceId: id('3'),
      workspaceId: id('4'), endpointId: id('5'), repositoryFingerprint: 'sha256:' + 'a'.repeat(64),
      workspacePath: windows ? 'C:\\Source\\Product' : '/source/product', provider, sessionId: 'fixture-session',
    },
    source: {
      sourceClass: 'explicit_import', locator: windows ? 'C:\\Export\\selected.jsonl' : '/export/selected.jsonl',
      sha256: 'sha256:' + 'b'.repeat(64),
      maximumBytes: generousLimits ? 4_000_000 : 4096,
      maximumRecordBytes: generousLimits ? 262_144 : 1024, maximumRecords: 10,
      since: '2026-10-21T11:00:00Z', until: '2026-10-21T11:29:00Z',
    },
    policy: {
      sourceRevision: 'source-v1', sourceHash: 'sha256:' + 'c'.repeat(64),
      disclosureRevision: 'metadata-v1', disclosureHash: 'sha256:' + 'd'.repeat(64),
      consentRevision: 'consent-v1', retentionDays: 7,
    },
    effects: { sync: false, analysis: false, learning: false, maximumModelCostCents: 0 },
    integrity: { sha256: '' },
  };
  const { integrity: _integrity, ...body } = assignment;
  assignment.integrity.sha256 = sha256(canonicalize(body));
  const binding: AssignedCaptureBinding = {
    organizationId: assignment.organizationId, target: structuredClone(assignment.target),
    policy: structuredClone(assignment.policy), approvedAssignmentHash: assignment.integrity.sha256,
    active: true, consentActive: true, allowedSourceLocators: [assignment.source.locator],
  };
  const response: Response = {
    session: {
      provider, sessionId: assignment.target.sessionId, sourcePath: assignment.source.locator,
      workspace: assignment.target.workspacePath, coverage: 'observed',
      startedAt: '2026-10-21T11:01:00Z', endedAt: '2026-10-21T11:02:00Z',
      records: [{
        native: { type: 'user_message', text: CANARY },
        sourcePath: assignment.source.locator, line: 1, workspace: assignment.target.workspacePath,
        timestamp: '2026-10-21T11:01:00Z', kind: 'user_message', coverage: 'observed',
      }],
    },
    sourceSha256: assignment.source.sha256, sourceBytes: generousLimits ? 250_000 : 1024,
  };
  let returned: unknown = response;
  const requests: ExactSessionReadRequest[] = [];
  const effects: string[] = [];
  const forbidden = (name: string) => () => { effects.push(name); throw new Error(CANARY); };
  const reader = {
    async readExactSession(request: ExactSessionReadRequest): Promise<Response> {
      requests.push(request); return returned as Response;
    },
    discover: forbidden('discover'), capture: forbidden('broad_capture'), syncTrajectory: forbidden('upload'),
    analyze: forbidden('analysis'), admitLearning: forbidden('learning'), putBlob: forbidden('persist'),
  };
  return {
    assignment, binding, response, requests, effects,
    setResponse(value: unknown) { returned = value; },
    run: () => selectAssignedCapture({ assignment, binding, now: () => NOW }, reader),
  };
}
type Fixture = ReturnType<typeof fixture>;
function setNative(f: Fixture, value: unknown) {
  const record = f.response.session.records[0]! as unknown as { native: unknown };
  record.native = value;
}

async function capturedError(f: Fixture): Promise<unknown> {
  try { await f.run(); } catch (error) { return error; }
  return undefined;
}
function assertRefusal(f: Fixture, error: unknown) {
  assert.equal(f.requests.length, 1, 'exact reader is called once without retry');
  assert.deepEqual(f.effects, []);
  assert.ok(error instanceof Error, 'response must be rejected');
  assert.equal(error.message, FAILURE);
  assert.equal(String(error).includes(CANARY), false);
}
async function rejectResponse(f: Fixture) { assertRefusal(f, await capturedError(f)); }

function metadata(f: Fixture, result: AssignedCaptureSelection, recordCount = 1) {
  assert.deepEqual(Object.keys(result).sort(), [
    'schema', 'assignmentId', 'organizationId', 'assignmentHash', 'provider', 'sessionId', 'workspaceId',
    'sourceClass', 'sourceSha256', 'sourceLocatorHash', 'coverage', 'recordCount', 'bindingMatched',
    'syncAllowed', 'analysisAllowed', 'learningAdmitted', 'nativeExecutionVerified', 'persisted',
  ].sort());
  assert.equal(result.schema, 'dharma.assigned-capture-selection/v1');
  assert.equal(result.assignmentHash, f.assignment.integrity.sha256);
  assert.equal(result.provider, f.assignment.target.provider);
  assert.equal(result.sessionId, f.assignment.target.sessionId);
  assert.equal(result.sourceSha256, f.assignment.source.sha256);
  assert.equal(result.sourceLocatorHash, sha256(f.assignment.source.locator));
  assert.equal(result.recordCount, recordCount); assert.equal(result.bindingMatched, true);
  for (const value of [result.syncAllowed, result.analysisAllowed, result.learningAdmitted,
    result.nativeExecutionVerified, result.persisted]) assert.equal(value, false);
  assert.equal(f.assignment.effects.maximumModelCostCents, 0);
  assert.equal(f.requests.length, 1); assert.deepEqual(f.effects, []);
  const encoded = JSON.stringify(result);
  for (const privateValue of [CANARY, f.assignment.source.locator, f.assignment.target.workspacePath]) {
    assert.equal(encoded.includes(privateValue), false);
  }
}
function nullPrototypeTree(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(nullPrototypeTree);
  const output = Object.create(null) as Record<string, unknown>;
  for (const [key, item] of Object.entries(value)) output[key] = nullPrototypeTree(item);
  return output;
}
function chain(links: number): unknown {
  let value: unknown = 'leaf';
  for (let i = 0; i < links; i++) value = { child: value };
  return value;
}

test("plain response JSON trees remain provider-neutral across exact POSIX and Windows paths", { timeout: 10_000 }, async () => {
  for (const provider of ['codex', 'claude', 'agy', 'hermes'] as const) {
    for (const windows of [false, true]) {
      const f = fixture(provider, windows);
      setNative(f, { text: CANARY, scalar: [null, true, false, 0, 1.5, 'same', 'same'], nested: { value: 'data' } });
      const result = await f.run(); metadata(f, result);
      assert.equal(result.coverage, 'observed');
    }
  }
});

test("null-prototype response and nested JSON objects remain supported without raw projection", { timeout: 10_000 }, async () => {
  const f = fixture();
  setNative(f, { text: CANARY, nested: { value: null }, list: [{ finite: 3 }, false] });
  f.setResponse(nullPrototypeTree(f.response));
  metadata(f, await f.run());
});

test("frozen ordinary response data remains legitimate", { timeout: 10_000 }, async () => {
  const f = fixture();
  Object.freeze(f.response.session.records[0]!.native);
  Object.freeze(f.response.session.records[0]);
  Object.freeze(f.response.session.records);
  Object.freeze(f.response.session);
  Object.freeze(f.response);
  metadata(f, await f.run());
});

test("root response Proxy is rejected before any supplied reflection trap", { timeout: 10_000 }, async () => {
  const f = fixture(); let traps = 0;
  const fail = (): never => { traps++; throw new Error(CANARY); };
  // No get trap: ordinary Promise then lookup delegates without a user callback.
  f.setResponse(new Proxy(f.response, {
    getPrototypeOf: fail, ownKeys: fail, getOwnPropertyDescriptor: fail,
  }));
  const error = await capturedError(f);
  assert.equal(traps, 0); assertRefusal(f, error);
});

test("nested session native and array Proxies are rejected without traps", { timeout: 10_000 }, async () => {
  for (const location of ['session', 'native', 'nested', 'array'] as const) {
    const f = fixture(); let traps = 0;
    const fail = (): never => { traps++; throw new Error(CANARY); };
    const target = location === 'session' ? f.response.session : location === 'array' ? [] : { text: CANARY };
    const proxy = new Proxy(target, { get: fail, getPrototypeOf: fail, ownKeys: fail, getOwnPropertyDescriptor: fail });
    if (location === 'session') f.response.session = proxy as Response['session'];
    else setNative(f, location === 'nested' ? { child: proxy } : proxy);
    const error = await capturedError(f);
    assert.equal(traps, 0); assertRefusal(f, error);
  }
});

test("revoked Proxies nested in an ordinary resolved response get fixed data refusal", { timeout: 10_000 }, async () => {
  for (const location of ['session', 'native', 'nested'] as const) {
    const f = fixture(), revoked = Proxy.revocable({}, {}); revoked.revoke();
    if (location === 'session') f.response.session = revoked.proxy as Response['session'];
    else setNative(f, location === 'nested' ? { child: revoked.proxy } : revoked.proxy);
    assertRefusal(f, await capturedError(f));
  }
});

test("response accessors at every data layer are refused without getter or setter invocation", { timeout: 10_000 }, async () => {
  for (const layer of ['root', 'session', 'record', 'native', 'array'] as const) {
    for (const kind of ['get', 'set'] as const) {
      const f = fixture(); let callbacks = 0;
      let target: object = f.response; let key = 'sourceSha256';
      if (layer === 'session') { target = f.response.session; key = 'coverage'; }
      if (layer === 'record') { target = f.response.session.records[0]!; key = 'timestamp'; }
      if (layer === 'native') {
        const native = { value: 'data' }; setNative(f, native); target = native; key = 'value';
      }
      if (layer === 'array') {
        const array = ['data']; setNative(f, array); target = array; key = '0';
      }
      Object.defineProperty(target, key, kind === 'get'
        ? { enumerable: true, configurable: true, get() { callbacks++; throw new Error(CANARY); } }
        : { enumerable: true, configurable: true, set(_value: unknown) { callbacks++; throw new Error(CANARY); } });
      const error = await capturedError(f);
      assert.equal(callbacks, 0); assertRefusal(f, error);
    }
  }
});

test("toJSON and conversion callbacks never run during response snapshot or projection", { timeout: 10_000 }, async () => {
  for (const kind of ['toJSON', 'toString', 'valueOf', 'primitive'] as const) {
    const f = fixture(); let callbacks = 0;
    const fail = (): never => { callbacks++; throw new Error(CANARY); };
    const native = kind === 'primitive' ? { [Symbol.toPrimitive]: fail } : { [kind]: fail };
    setNative(f, native);
    const error = await capturedError(f);
    assert.equal(callbacks, 0); assertRefusal(f, error);
  }
});

test("nonplain hidden and symbol response values are refused instead of normalized away", { timeout: 10_000 }, async () => {
  class NativeValue { text = CANARY; }
  const hidden = { text: CANARY }; Object.defineProperty(hidden, 'extra', { value: 'hidden', enumerable: false });
  for (const native of [new NativeValue(), new Date(0), new Map(), new Set(),
    Object.create({ inherited: CANARY }), hidden, { [Symbol('extra')]: CANARY }]) {
    const f = fixture(); setNative(f, native); await rejectResponse(f);
  }
});

test("cycles and shared object or array identities are refused before graph amplification", { timeout: 10_000 }, async () => {
  const cycle: Record<string, unknown> = {}; cycle.self = cycle;
  const shared = { text: CANARY }, array: unknown[] = [];
  let dag: unknown = { value: 'leaf' };
  for (let i = 0; i < 4; i++) dag = { left: dag, right: dag };
  for (const native of [cycle, { left: shared, right: shared }, [array, array], dag]) {
    const f = fixture(); setNative(f, native); await rejectResponse(f);
  }
});

test("reader data depth64 remains allowed while depth65 is refused", { timeout: 10_000 }, async () => {
  const accepted = fixture(); setNative(accepted, chain(60));
  metadata(accepted, await accepted.run());
  const rejected = fixture(); setNative(rejected, chain(61));
  await rejectResponse(rejected);
});

test("dense native arrays at100000 are allowed and100001 are refused before byte projection", { timeout: 10_000 }, async () => {
  const accepted = fixture('codex', false, true);
  setNative(accepted, Array.from({ length: 100_000 }, () => 0));
  metadata(accepted, await accepted.run());
  const rejected = fixture('codex', false, true);
  setNative(rejected, Array.from({ length: 100_001 }, () => 0));
  await rejectResponse(rejected);
});

test("one-million-node guard remains distinct from array and per-record byte limits", { timeout: 10_000 }, async () => {
  const f = fixture('codex', false, true);
  const base = f.response.session.records[0]!;
  const records = Array.from({ length: 10 }, () => ({
    ...base, native: Array.from({ length: 100_000 }, () => 0),
  }));
  f.response.session.records = records as unknown as Response['session']['records'];
  f.response.sourceBytes = 2_100_000;
  assert.equal(f.response.session.records.length, f.assignment.source.maximumRecords);
  assert.ok(Buffer.byteLength(JSON.stringify(f.response.session.records[0]), 'utf8') < f.assignment.source.maximumRecordBytes);
  assert.ok(Buffer.byteLength(JSON.stringify(f.response.session.records), 'utf8') < f.assignment.source.maximumBytes);
  await rejectResponse(f);
});

test("sparse arrays hidden indices and extra array properties are not dense JSON data", { timeout: 10_000 }, async () => {
  const hole = new Array<unknown>(3); hole[0] = 'a'; hole[2] = 'b';
  const trailing = new Array<unknown>(2); trailing[0] = 'a';
  const hidden = ['a']; Object.defineProperty(hidden, '0', { value: 'a', enumerable: false });
  const variants: unknown[] = [hole, trailing, hidden];
  for (const key of ['extra', '01', '-1', '1.0']) {
    const array = ['a', 'b']; Object.defineProperty(array, key, { value: CANARY, enumerable: true }); variants.push(array);
  }
  for (const native of variants) {
    const f = fixture(); setNative(f, native); await rejectResponse(f);
  }
});

test("non-JSON scalar response data fails with no coercion or reader retry", { timeout: 10_000 }, async () => {
  for (const native of [undefined, NaN, Infinity, -Infinity, 1n, Symbol('synthetic'), () => CANARY]) {
    const f = fixture(); setNative(f, native); await rejectResponse(f);
  }
});

test("successful result is detached metadata only with all effects false and exactly one read", { timeout: 10_000 }, async () => {
  const f = fixture();
  const result = await f.run(), expected = { ...result };
  metadata(f, result);
  f.response.sourceSha256 = 'sha256:' + 'e'.repeat(64);
  f.response.session.coverage = 'partial';
  setNative(f, { changed: CANARY });
  f.response.session.records.length = 0;
  assert.deepEqual(result, expected);
  assert.equal(f.requests.length, 1); assert.deepEqual(f.effects, []);
});

test("malformed ordinary resolved response roots return fixed data mismatch without retry", { timeout: 10_000 }, async () => {
  for (const response of [null, undefined, [], CANARY, 42, false]) {
    const f = fixture(); f.setResponse(response); await rejectResponse(f);
  }
});
