import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { canonicalize, sha256, validateContract } from '@dharma-ai-labs/agent-fabric-contracts';
import type { ProviderSession } from '@dharma-ai-labs/agent-fabric-provider-adapters';
import { selectAssignedCapture, type CaptureAssignment, type AssignedCaptureBinding } from './assignedCapture.js';

const schemaDirectory = fileURLToPath(new URL('../../../schemas/', import.meta.url));
const now = Date.parse('2026-10-21T11:35:00Z');
const id = (n: string) => `${n.repeat(8)}-${n.repeat(4)}-4${n.repeat(3)}-8${n.repeat(3)}-${n.repeat(12)}`;
function fixture(provider: CaptureAssignment['target']['provider'] = 'codex', windows = false) {
  const assignment: CaptureAssignment = {
    schema: 'dharma.capture-assignment/v1', assignmentId: id('1'), organizationId: 'org_fixture',
    createdAt: '2026-10-21T11:30:00Z', expiresAt: '2026-10-21T12:00:00Z',
    target: { accountId: 'user_fixture', membershipId: id('2'), hostId: 'fixture-host', deviceId: id('3'),
      workspaceId: id('4'), endpointId: id('5'), repositoryFingerprint: `sha256:${'a'.repeat(64)}`,
      workspacePath: windows ? 'C:\\Source\\Product' : '/source/product', provider, sessionId: 'fixture-session' },
    source: { sourceClass: 'explicit_import', locator: windows ? 'C:\\Export\\selected.jsonl' : '/export/selected.jsonl',
      sha256: `sha256:${'b'.repeat(64)}`, maximumBytes: 4096, maximumRecordBytes: 1024, maximumRecords: 10,
      since: '2026-10-21T11:00:00Z', until: '2026-10-21T11:29:00Z' },
    policy: { sourceRevision: 'source-v1', sourceHash: `sha256:${'c'.repeat(64)}`,
      disclosureRevision: 'metadata-v1', disclosureHash: `sha256:${'d'.repeat(64)}`,
      consentRevision: 'consent-v1', retentionDays: 7 },
    effects: { sync: false, analysis: false, learning: false, maximumModelCostCents: 0 },
    integrity: { sha256: '' },
  };
  function seal() { const { integrity: _, ...body } = assignment; assignment.integrity.sha256 = sha256(canonicalize(body)); }
  seal();
  const binding: AssignedCaptureBinding = { organizationId: assignment.organizationId,
    target: structuredClone(assignment.target), policy: structuredClone(assignment.policy),
    approvedAssignmentHash: assignment.integrity.sha256, active: true, consentActive: true,
    allowedSourceLocators: [assignment.source.locator] };
  const session: ProviderSession = { provider, sessionId: assignment.target.sessionId,
    sourcePath: assignment.source.locator, workspace: assignment.target.workspacePath, coverage: 'observed',
    startedAt: '2026-10-21T11:01:00Z', endedAt: '2026-10-21T11:02:00Z',
    records: [{ native: { type: 'user_message', text: 'PRIVATE_CONTENT_CANARY' },
      sourcePath: assignment.source.locator, line: 1, workspace: assignment.target.workspacePath,
      timestamp: '2026-10-21T11:01:00Z', kind: 'user_message', coverage: 'observed' }] };
  const calls: unknown[] = [];
  const reader = { async readExactSession(request: unknown) {
    calls.push(request); return { session, sourceSha256: assignment.source.sha256, sourceBytes: 1024 };
  } };
  function approveChanges() { seal(); binding.approvedAssignmentHash = assignment.integrity.sha256; }
  return { assignment, binding, session, reader, calls, approveChanges,
    run: (value: unknown = assignment) => selectAssignedCapture({ assignment: value, binding, now: () => now }, reader) };
}

test('schema and type fixture agree; unknown fields and sync authority are refused', async () => {
  const f = fixture();
  assert.equal((await validateContract(schemaDirectory, 'https://schemas.dharma-ai.io/capture-assignment/v1', f.assignment)).ok, true);
  for (const value of [{ ...f.assignment, privateKey: 'SECRET_CANARY' },
    { ...f.assignment, effects: { ...f.assignment.effects, sync: true } }]) {
    assert.equal((await validateContract(schemaDirectory, 'https://schemas.dharma-ai.io/capture-assignment/v1', value)).ok, false);
  }
});

test('exact approved selection is provider-neutral and never returns raw records or paths', async () => {
  for (const provider of ['codex', 'claude', 'agy', 'hermes'] as const) {
    const f = fixture(provider); const result = await f.run();
    assert.equal(f.calls.length, 1); assert.equal(result.provider, provider);
    assert.equal(result.sessionId, 'fixture-session'); assert.equal(result.sourceClass, 'explicit_import');
    assert.equal(result.recordCount, 1); assert.equal(result.bindingMatched, true);
    assert.equal(result.nativeExecutionVerified, false); assert.equal(result.learningAdmitted, false);
    assert.equal(result.syncAllowed, false); assert.equal(result.analysisAllowed, false); assert.equal(result.persisted, false);
    const text = JSON.stringify(result); assert(!text.includes('PRIVATE_CONTENT_CANARY'));
    assert(!text.includes('/export/')); assert(!text.includes('/source/'));
  }
});

test('missing, ambiguous and extra secret-bearing assignment fields refuse before source access', async () => {
  for (const value of [null, {}, [], { ...fixture().assignment, target: {} },
    { ...fixture().assignment, credentials: { token: 'SECRET_CANARY' } }]) {
    const f = fixture(); await assert.rejects(() => f.run(value), /capture_assignment_invalid/);
    assert.equal(f.calls.length, 0);
  }
});

test('tenant/account/member/host/device/workspace/endpoint/provider/session/source mismatch has no source effect', async () => {
  for (const field of ['accountId', 'membershipId', 'hostId', 'deviceId', 'workspaceId', 'endpointId',
    'repositoryFingerprint', 'workspacePath', 'provider', 'sessionId'] as const) {
    const f = fixture(); (f.binding.target as unknown as Record<string, unknown>)[field] = 'foreign';
    await assert.rejects(() => f.run(), /capture_assignment_binding_mismatch/); assert.equal(f.calls.length, 0);
  }
  const f = fixture(); f.binding.organizationId = 'org_other';
  await assert.rejects(() => f.run(), /capture_assignment_binding_mismatch/); assert.equal(f.calls.length, 0);
});

test('changed policy, revoked consent and unenrolled binding are refused before source access', async () => {
  for (const mutate of [(f: ReturnType<typeof fixture>) => { f.binding.active = false; },
    (f: ReturnType<typeof fixture>) => { f.binding.consentActive = false; },
    (f: ReturnType<typeof fixture>) => { f.binding.policy.sourceHash = `sha256:${'e'.repeat(64)}`; },
    (f: ReturnType<typeof fixture>) => { f.binding.policy.consentRevision = 'new-consent'; }]) {
    const f = fixture(); mutate(f);
    await assert.rejects(() => f.run(), /capture_assignment_binding_mismatch/); assert.equal(f.calls.length, 0);
  }
});

test('tampering, even with a recomputed self-hash, cannot replace the separately approved hash', async () => {
  const f = fixture(); f.assignment.source.maximumBytes++;
  await assert.rejects(() => f.run(), /capture_assignment_integrity_mismatch/); assert.equal(f.calls.length, 0);
  const { integrity: _, ...body } = f.assignment; f.assignment.integrity.sha256 = sha256(canonicalize(body));
  await assert.rejects(() => f.run(), /capture_assignment_integrity_mismatch/); assert.equal(f.calls.length, 0);
});

test('expiry, future issuance and invalid source time windows refuse before source access', async () => {
  for (const change of [{ expiresAt: '2026-10-21T11:35:00Z' }, { createdAt: '2026-10-21T11:36:00Z' },
    { source: { ...fixture().assignment.source, until: '2026-10-21T10:59:00Z' } }]) {
    const f = fixture(); Object.assign(f.assignment, change); f.approveChanges();
    await assert.rejects(() => f.run(), /capture_assignment_window_invalid/); assert.equal(f.calls.length, 0);
  }
});

test('POSIX and Windows exact canonical paths work; aliases, siblings and traversal do not gain access', async () => {
  for (const windows of [false, true]) { const f = fixture('codex', windows); assert.equal((await f.run()).recordCount, 1); }
  for (const locator of ['/export/../private/file.jsonl', 'relative/file.jsonl', 'C:\\Export\\..\\Private\\file.jsonl']) {
    const f = fixture(); f.assignment.source.locator = locator; f.binding.allowedSourceLocators = [locator]; f.approveChanges();
    await assert.rejects(() => f.run(), /capture_assignment_invalid/); assert.equal(f.calls.length, 0);
  }
  const f = fixture(); f.binding.allowedSourceLocators = ['/export/sibling.jsonl'];
  await assert.rejects(() => f.run(), /capture_assignment_source_not_allowed/); assert.equal(f.calls.length, 0);
});

test('missing exact-source bridge is unavailable and cannot fall back to broad discovery', async () => {
  const f = fixture(); await assert.rejects(() => selectAssignedCapture({ assignment: f.assignment,
    binding: f.binding, now: () => now }), /capture_source_unavailable/);
  assert.equal(f.calls.length, 0);
});

test('foreign, changed-source and out-of-window reader results are rejected without exposing their body', async () => {
  for (const mutate of [(f: ReturnType<typeof fixture>) => { f.session.workspace += '-sibling'; },
    (f: ReturnType<typeof fixture>) => { f.session.sessionId = 'foreign'; },
    (f: ReturnType<typeof fixture>) => { f.session.provider = 'claude'; },
    (f: ReturnType<typeof fixture>) => { f.session.sourcePath = '/private/forbidden'; },
    (f: ReturnType<typeof fixture>) => { f.session.endedAt = '2026-10-21T12:30:00Z'; },
    (f: ReturnType<typeof fixture>) => { f.session.records[0]!.timestamp = '2026-10-21T10:00:00Z'; }]) {
    const f = fixture(); mutate(f); await assert.rejects(() => f.run(), /capture_selected_source_mismatch/);
    assert.equal(f.calls.length, 1);
  }
  const f = fixture(); f.reader.readExactSession = async () => ({ session: f.session,
    sourceSha256: `sha256:${'f'.repeat(64)}`, sourceBytes: 1024 });
  await assert.rejects(() => f.run(), /capture_selected_source_mismatch/);
});

test('record and byte bounds fail closed after the bounded exact reader result', async () => {
  for (const mutate of [(f: ReturnType<typeof fixture>) => { f.assignment.source.maximumRecordBytes = 1; },
    (f: ReturnType<typeof fixture>) => { f.session.records = Array.from({ length: 11 }, () => structuredClone(f.session.records[0]!)); }]) {
    const f = fixture(); mutate(f); f.approveChanges();
    await assert.rejects(() => f.run(), /capture_selected_source_bound_exceeded/); assert.equal(f.calls.length, 1);
  }
  const f = fixture(); f.reader.readExactSession = async request => {
    f.calls.push(request); return { session: f.session, sourceSha256: f.assignment.source.sha256, sourceBytes: 4097 };
  };
  await assert.rejects(() => f.run(), /capture_selected_source_bound_exceeded/); assert.equal(f.calls.length, 1);
});

test('reader failures are sanitized and never retried or expanded to another source', async () => {
  const f = fixture(); let attempts = 0; f.reader.readExactSession = async () => { attempts++; throw Error('SECRET_TOKEN_CANARY'); };
  await assert.rejects(() => f.run(), error => {
    assert.equal((error as Error).message, 'capture_source_unavailable'); return true;
  }); assert.equal(attempts, 1);
});

test('binding changes while awaiting source prevent a selected result', async () => {
  const f = fixture(); f.reader.readExactSession = async () => { f.binding.consentActive = false;
    return { session: f.session, sourceSha256: f.assignment.source.sha256, sourceBytes: 1024 }; };
  await assert.rejects(() => f.run(), /capture_assignment_binding_mismatch/);
});

test('selection cannot list/drain pending capsules, enqueue, upload, analyze or increment learning', async () => {
  const f = fixture(), effects: string[] = [];
  const forbidden = (name: string) => () => { effects.push(name); throw Error(name); };
  const ports = { ...f.reader, listPendingCapsuleSyncs: forbidden('list_pending'),
    queueCapsuleSync: forbidden('queue'), markCapsuleSynced: forbidden('mark'), syncTrajectory: forbidden('upload'),
    analyze: forbidden('analysis'), admitLearning: forbidden('learning') };
  const result = await selectAssignedCapture({ assignment: f.assignment, binding: f.binding,
    now: () => now }, ports);
  assert.equal(result.persisted, false); assert.deepEqual(effects, []); assert.equal(f.calls.length, 1);
});

test('expiry during result validation cannot return a selected plan', async () => {
  const f = fixture(); let checks = 0;
  await assert.rejects(() => selectAssignedCapture({ assignment: f.assignment, binding: f.binding,
    now: () => ++checks >= 3 ? Date.parse(f.assignment.expiresAt) : now }, f.reader),
  /capture_assignment_window_invalid/);
  assert.equal(f.calls.length, 1);
});

test('the reader cannot mutate its selected scope or gain retry behavior', async () => {
  const f = fixture(); let attempts = 0;
  f.reader.readExactSession = async request => {
    attempts++; (request as { target: { sessionId: string } }).target.sessionId = 'foreign';
    return { session: f.session, sourceSha256: f.assignment.source.sha256, sourceBytes: 1024 };
  };
  await assert.rejects(() => f.run(), /capture_source_unavailable/); assert.equal(attempts, 1);
});

test('provenance is preserved; a signed-task assertion without genuine proof is not accepted', async () => {
  const f = fixture(); f.assignment.source.sourceClass = 'provider_discovery'; f.approveChanges();
  const result = await f.run(); assert.equal(result.sourceClass, 'provider_discovery');
  assert.equal(result.nativeExecutionVerified, false); assert.equal(result.learningAdmitted, false);
  const invalid = { ...f.assignment, source: { ...f.assignment.source, sourceClass: 'signed_task_execution' } };
  const g = fixture(); await assert.rejects(() => g.run(invalid), /capture_assignment_invalid/);
  assert.equal(g.calls.length, 0);
});

test('inconsistent limits and unavailable coverage do not become observed evidence', async () => {
  const f = fixture(); f.assignment.source.maximumRecordBytes = f.assignment.source.maximumBytes + 1; f.approveChanges();
  await assert.rejects(() => f.run(), /capture_assignment_invalid/); assert.equal(f.calls.length, 0);
  const g = fixture(); g.session.coverage = 'unavailable';
  await assert.rejects(() => g.run(), /capture_source_unavailable/); assert.equal(g.calls.length, 1);
});

test('a post-check serialization callback cannot inject nested private values into metadata', async () => {
  const f = fixture(); let callbacks = 0;
  const captured = { session: f.session, sourceSha256: f.assignment.source.sha256, sourceBytes: 1024 };
  f.session.records[0]!.native = { toJSON() {
    callbacks++; (captured as unknown as Record<string, unknown>).sourceSha256 = { privateKey: 'SECRET_CANARY' };
    (f.session as unknown as Record<string, unknown>).coverage = { privateKey: 'SECRET_CANARY' };
    return { text: 'apparently-small' };
  } };
  f.reader.readExactSession = async () => captured;
  await assert.rejects(() => f.run(), error => {
    assert.equal((error as Error).message, 'capture_selected_source_mismatch'); return true;
  });
  assert.equal(callbacks, 0);
});

test('accessors are rejected without invocation and errors do not echo private data', async () => {
  const f = fixture(); let getters = 0;
  Object.defineProperty(f.session, 'coverage', { enumerable: true, get() {
    getters++; throw Error('SECRET_ACCESSOR_CANARY');
  } });
  await assert.rejects(() => f.run(), error => {
    assert.equal((error as Error).message, 'capture_selected_source_mismatch'); return true;
  });
  assert.equal(getters, 0);
});

test('plain-data snapshot rejects cycles, custom prototypes, structural overflow and shared object identities', async () => {
  const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic;
  const deep: Record<string, unknown> = {}; let cursor = deep;
  for (let index = 0; index < 65; index++) { const child = {}; cursor.child = child; cursor = child; }
  for (const native of [cyclic, { value: new Date() }, deep, { value: new Array(100_001) }, { value: NaN }]) {
    const f = fixture(); f.session.records[0]!.native = native;
    await assert.rejects(() => f.run(), /capture_selected_source_mismatch/);
  }
  const f = fixture(), shared = { value: 'plain' };
  f.session.records[0]!.native = { first: shared, second: shared };
  await assert.rejects(() => f.run(), /capture_selected_source_mismatch/);
});

test('a tiny shared DAG is rejected before amplification without allocating an expanded payload', async () => {
  const f = fixture(); let graph: Record<string, unknown> = { value: 'x' };
  for (let index = 0; index < 4; index++) graph = { left: graph, right: graph };
  f.session.records[0]!.native = graph;
  await assert.rejects(() => f.run(), /capture_selected_source_mismatch/);
});

test('assignment accessors are refused before callbacks or exact-source access', async () => {
  for (const nested of [false, true]) {
    const f = fixture(); let callbacks = 0;
    const target = nested ? f.assignment.target : f.assignment;
    const field = nested ? 'sessionId' : 'target';
    Object.defineProperty(target, field, {enumerable: true, get() {callbacks++; throw new Error('PRIVATE_ASSIGNMENT_CANARY');}});
    await assert.rejects(() => f.run(), {message: 'capture_assignment_invalid'});
    assert.equal(callbacks, 0); assert.equal(f.calls.length, 0);
  }
});

test('assignment hidden symbol and custom-prototype data cannot disappear during cloning', async () => {
  for (const variant of ['hidden', 'symbol', 'prototype'] as const) {
    const f = fixture();
    if (variant === 'hidden') Object.defineProperty(f.assignment, 'extra', {value: 'PRIVATE_CANARY', enumerable: false});
    if (variant === 'symbol') Object.defineProperty(f.assignment, Symbol('extra'), {value: true});
    if (variant === 'prototype') Object.setPrototypeOf(f.assignment.target, {inherited: true});
    await assert.rejects(() => f.run(), {message: 'capture_assignment_invalid'});
    assert.equal(f.calls.length, 0);
  }
});

test('selection input controls use data descriptors rather than invoking accessors', async () => {
  for (const field of ['assignment', 'binding', 'now'] as const) {
    const f = fixture(); let callbacks = 0;
    const input = {assignment: f.assignment, binding: f.binding, now: () => now};
    Object.defineProperty(input, field, {enumerable: true, get() {callbacks++; throw new Error('PRIVATE_CONTROL_CANARY');}});
    await assert.rejects(() => selectAssignedCapture(input, f.reader), {message: 'capture_assignment_invalid'});
    assert.equal(callbacks, 0); assert.equal(f.calls.length, 0);
  }
});

test('live binding data rejects accessors and Proxies without callbacks or reads', async () => {
  for (const variant of ['root-getter', 'nested-getter', 'proxy', 'revoked'] as const) {
    const f = fixture(); let callbacks = 0;
    const fail = (): never => {callbacks++; throw new Error('PRIVATE_BINDING_CANARY');};
    let binding = f.binding;
    if (variant === 'root-getter') Object.defineProperty(binding, 'consentActive', {enumerable: true, get: fail});
    if (variant === 'nested-getter') Object.defineProperty(binding.target, 'deviceId', {enumerable: true, get: fail});
    if (variant === 'proxy') binding = new Proxy(binding, {get: fail, getPrototypeOf: fail, ownKeys: fail, getOwnPropertyDescriptor: fail});
    if (variant === 'revoked') {const proxy = Proxy.revocable(binding, {}); proxy.revoke(); binding = proxy.proxy;}
    await assert.rejects(() => selectAssignedCapture({assignment: f.assignment, binding, now: () => now}, f.reader),
      {message: 'capture_assignment_binding_mismatch'});
    assert.equal(callbacks, 0); assert.equal(f.calls.length, 0);
  }
});

test('exact-reader control accessors and Proxies cannot execute during source resolution', async () => {
  for (const variant of ['getter', 'proxy', 'revoked', 'prototype-proxy', 'method-proxy'] as const) {
    const f = fixture(); let callbacks = 0;
    const fail = (): never => {callbacks++; throw new Error('PRIVATE_READER_CANARY');};
    let reader = f.reader;
    if (variant === 'getter') Object.defineProperty(reader, 'readExactSession', {enumerable: true, get: fail});
    if (variant === 'proxy') reader = new Proxy(reader, {get: fail, getPrototypeOf: fail, ownKeys: fail, getOwnPropertyDescriptor: fail});
    if (variant === 'revoked') {const proxy = Proxy.revocable(reader, {}); proxy.revoke(); reader = proxy.proxy;}
    if (variant === 'prototype-proxy') reader = Object.create(new Proxy({}, {get: fail, getPrototypeOf: fail, getOwnPropertyDescriptor: fail}));
    if (variant === 'method-proxy') reader = {readExactSession: new Proxy(f.reader.readExactSession, {apply: fail})};
    await assert.rejects(() => selectAssignedCapture({assignment: f.assignment, binding: f.binding, now: () => now}, reader),
      {message: 'capture_source_unavailable'});
    assert.equal(callbacks, 0); assert.equal(f.calls.length, 0);
  }
});

test('binding-reference replacement cannot replace the originally authorized capability', async () => {
  const f = fixture(), input = {assignment: f.assignment, binding: f.binding, now: () => now};
  f.reader.readExactSession = async request => {
    f.calls.push(request); input.binding = structuredClone(f.binding);
    return {session: f.session, sourceSha256: f.assignment.source.sha256, sourceBytes: 1024};
  };
  await assert.rejects(() => selectAssignedCapture(input, f.reader), {message: 'capture_assignment_binding_mismatch'});
  assert.equal(f.calls.length, 1);
});

test('prototype data-method readers retain their original receiver and live consent still revokes', async () => {
  for (const revoke of [false, true]) {
    const f = fixture(); let calls = 0;
    class Reader {
      marker = 'original-receiver';
      async readExactSession() {
        assert.equal(this.marker, 'original-receiver'); calls++;
        if (revoke) f.binding.consentActive = false;
        return {session: f.session, sourceSha256: f.assignment.source.sha256, sourceBytes: 1024};
      }
    }
    const operation = selectAssignedCapture({assignment: f.assignment, binding: f.binding, now: () => now}, new Reader());
    if (revoke) await assert.rejects(() => operation, {message: 'capture_assignment_binding_mismatch'});
    else assert.equal((await operation).persisted, false);
    assert.equal(calls, 1);
  }
});

test('existing larger exact-source allowlists are not narrowed by assignment snapshot limits', async () => {
  const f = fixture();
  f.binding.allowedSourceLocators = [...Array.from({length: 256}, (_, index) => `/export/other-${index}.jsonl`), f.assignment.source.locator];
  assert.equal((await f.run()).recordCount, 1); assert.equal(f.calls.length, 1);
});

test('assignment and trusted clock are captured before the first validation await', async () => {
  const f = fixture(); let callbacks = 0;
  const input = {assignment: f.assignment, binding: f.binding, now: () => now};
  const operation = selectAssignedCapture(input, f.reader);
  Object.defineProperty(input, 'now', {enumerable: true, get() {callbacks++; throw new Error('PRIVATE_LATE_CLOCK_CANARY');}});
  f.assignment.target.workspacePath = '/unrelated/changed';
  const result = await operation;
  assert.equal(result.persisted, false); assert.equal(callbacks, 0); assert.equal(f.calls.length, 1);
});

test('later binding accessors and private clock failures stay fixed and fail before a source call', async () => {
  for (const clockThrows of [false, true]) {
    const f = fixture(); let callbacks = 0;
    await assert.rejects(() => selectAssignedCapture({assignment: f.assignment, binding: f.binding, now: () => {
      if (clockThrows) throw new Error('PRIVATE_CLOCK_CANARY');
      Object.defineProperty(f.binding, 'consentActive', {enumerable: true, get() {callbacks++; throw new Error('PRIVATE_LIVE_BINDING_CANARY');}});
      return now;
    }}, f.reader), {message: clockThrows ? 'capture_assignment_window_invalid' : 'capture_assignment_binding_mismatch'});
    assert.equal(callbacks, 0); assert.equal(f.calls.length, 0);
  }
});

test('selection input Proxy and revoked Proxy are rejected without invoking traps', async () => {
  const f = fixture(); let callbacks = 0;
  const fail = (): never => {callbacks++; throw new Error('PRIVATE_INPUT_CANARY');};
  const input = {assignment: f.assignment, binding: f.binding, now: () => now};
  const proxy = new Proxy(input, {get: fail, getPrototypeOf: fail, ownKeys: fail, getOwnPropertyDescriptor: fail});
  const revoked = Proxy.revocable(input, {}); revoked.revoke();
  for (const value of [proxy, revoked.proxy]) {
    await assert.rejects(() => selectAssignedCapture(value, f.reader), {message: 'capture_assignment_invalid'});
    assert.equal(callbacks, 0); assert.equal(f.calls.length, 0);
  }
});
