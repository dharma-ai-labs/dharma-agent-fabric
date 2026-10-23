import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import test from 'node:test';
import ts from 'typescript';
import { canonicalize, sha256 } from '@dharma-ai-labs/agent-fabric-contracts';
import type { ProviderSession } from '@dharma-ai-labs/agent-fabric-provider-adapters';
import { runAssignedCaptureCommand, type AssignedCaptureCommandContext, type CaptureAssignment } from './assignedCapture.js';

const now = Date.parse('2026-10-21T19:00:00Z');
const id = (n: string) => `${n.repeat(8)}-${n.repeat(4)}-4${n.repeat(3)}-8${n.repeat(3)}-${n.repeat(12)}`;
type Run = (argv: string[], context?: AssignedCaptureCommandContext) => Promise<unknown>;

async function dispatcher(bootstrapScope = false) {
  const text = await readFile(fileURLToPath(new URL('../src/index.ts', import.meta.url)), 'utf8');
  const source = ts.createSourceFile('index.ts', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const definitions = ['parseCliOptions', 'run'].map(name => {
    const matches = source.statements.filter(node => ts.isFunctionDeclaration(node) && node.name?.text === name);
    assert.equal(matches.length, 1, name);
    return matches[0]!.getText(source);
  });
  const compiled = ts.transpileModule(definitions.join('\n'), {
    compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.None }, reportDiagnostics: true,
  });
  assert.equal(compiled.diagnostics?.filter(item => item.category === ts.DiagnosticCategory.Error).length, 0);
  const effects: string[] = [];
  const forbidden = (name: string) => () => { effects.push(name); throw new Error(`forbidden_${name}`); };
  const run = runInNewContext(`${compiled.outputText}\nrun`, {
    exports: {}, Error, USAGE: 'unsupported_command',
    currentBootstrapHostScope: () => bootstrapScope ? {} : undefined,
    providerAdapters: [{ capability: forbidden('capability') }],
    receiptAwareProviderCapabilities: forbidden('receiver'),
    runAssignedCaptureCommand,
    capture: async () => { effects.push('legacy_capture'); return { legacy: true }; },
    evidenceSync: forbidden('sync'), providerAdapter: forbidden('discover'), registry: forbidden('registry'),
    readFile: forbidden('read_file'), openBootstrapVault: forbidden('vault'), client: forbidden('client'),
    syncPendingRetentionCapsules: forbidden('drain'), reserveDailyContentUpload: forbidden('reserve'),
    inspectCodexBootstrapHostPreparation: forbidden('bootstrap'), repositoriesList: forbidden('metadata'),
    runOrganizationCommand: forbidden('organization'), fetch: forbidden('network'),
  }, { timeout: 1000, contextCodeGeneration: { strings: false, wasm: false } }) as Run;
  return { run, effects };
}

function fixture(provider: CaptureAssignment['target']['provider'] = 'codex', windows = false) {
  const workspace = windows ? 'C:\\Source\\Product' : '/source/product';
  const locator = windows ? 'C:\\Export\\selected.jsonl' : '/export/selected.jsonl';
  const assignment: CaptureAssignment = {
    schema: 'dharma.capture-assignment/v1', assignmentId: id('1'), organizationId: 'org_fixture',
    createdAt: '2026-10-21T18:55:00Z', expiresAt: '2026-10-21T19:15:00Z',
    target: { accountId: 'user_fixture', membershipId: id('2'), hostId: 'fixture-host', deviceId: id('3'),
      workspaceId: id('4'), endpointId: id('5'), repositoryFingerprint: `sha256:${'a'.repeat(64)}`,
      workspacePath: workspace, provider, sessionId: 'fixture-session' },
    source: { sourceClass: 'explicit_import', locator, sha256: `sha256:${'b'.repeat(64)}`,
      maximumBytes: 4096, maximumRecordBytes: 1024, maximumRecords: 2,
      since: '2026-10-21T18:00:00Z', until: '2026-10-21T18:50:00Z' },
    policy: { sourceRevision: 'source-v1', sourceHash: `sha256:${'c'.repeat(64)}`,
      disclosureRevision: 'metadata-v1', disclosureHash: `sha256:${'d'.repeat(64)}`,
      consentRevision: 'consent-v1', retentionDays: 7 },
    effects: { sync: false, analysis: false, learning: false, maximumModelCostCents: 0 },
    integrity: { sha256: '' },
  };
  const { integrity: _, ...body } = assignment;
  assignment.integrity.sha256 = sha256(canonicalize(body));
  const session: ProviderSession = { provider, sessionId: 'fixture-session', workspace, sourcePath: locator,
    coverage: 'observed', startedAt: '2026-10-21T18:01:00Z', endedAt: '2026-10-21T18:02:00Z',
    records: [{ native: { text: 'PRIVATE_SOURCE_CANARY' }, workspace, sourcePath: locator, line: 1,
      timestamp: '2026-10-21T18:01:00Z', kind: 'user_message', coverage: 'observed' }] };
  let reads = 0;
  const context: AssignedCaptureCommandContext = {
    assignment, binding: { organizationId: assignment.organizationId, target: structuredClone(assignment.target),
      policy: structuredClone(assignment.policy), approvedAssignmentHash: assignment.integrity.sha256,
      active: true, consentActive: true, allowedSourceLocators: [locator] }, now: () => now,
    reader: { async readExactSession(request) {
      reads++; assert.equal(request.assignmentId, assignment.assignmentId);
      return { session, sourceSha256: assignment.source.sha256, sourceBytes: 1024 };
    } },
  };
  return { assignment, context, reads: () => reads };
}

test('assigned CLI capture uses the real selector once across providers and path styles without legacy effects', async () => {
  for (const provider of ['codex', 'claude', 'agy', 'hermes'] as const) {
    for (const windows of [false, true]) {
      const f = fixture(provider, windows), d = await dispatcher();
      const prefix = windows ? ['capture'] : ['evidence', 'capture'];
      const result = await d.run([...prefix, '--assignment-id', f.assignment.assignmentId, '--json'], f.context) as {
        ok: boolean; selection: { assignmentId: string; provider: string; persisted: boolean; syncAllowed: boolean };
      };
      assert.equal(result.ok, true); assert.equal(result.selection.assignmentId, f.assignment.assignmentId);
      assert.equal(result.selection.provider, provider); assert.equal(result.selection.persisted, false);
      assert.equal(result.selection.syncAllowed, false); assert.equal(f.reads(), 1); assert.deepEqual(d.effects, []);
      const output = JSON.stringify(result);
      for (const value of ['PRIVATE_SOURCE_CANARY', f.assignment.source.locator, f.assignment.target.workspacePath]) {
        assert.equal(output.includes(value), false);
      }
    }
  }
});

test('assigned CLI capture without a host capability refuses before ambient state or legacy capture', async () => {
  const d = await dispatcher();
  await assert.rejects(() => d.run(['capture', '--assignment-id', id('1')]), /capture_source_unavailable/);
  assert.deepEqual(d.effects, []);
});

test('assigned CLI capture rejects effect flags, batch and unrelated commands before the exact reader', async () => {
  for (const argv of [
    ['capture', '--assignment-id', id('1'), '--sync'],
    ['capture', '--assignment-id', id('1'), '--source-root', '/private'],
    ['capture', '--assignment-id', id('1'), '--workspace', '/foreign'],
    ['capture', '--assignment-id', id('1'), '--binding-file', '/self-approved.json'],
    ['evidence', 'capture-batch', '--assignment-id', id('1')],
    ['evidence', 'sync', '--assignment-id', id('1'), '--file', '/private'],
    ['repositories', 'metadata', '--assignment-id', id('1')],
  ]) {
    const f = fixture(), d = await dispatcher();
    await assert.rejects(() => d.run(argv, f.context), /capture_assignment_command_invalid/);
    assert.equal(f.reads(), 0); assert.deepEqual(d.effects, []);
  }
});

test('assigned CLI capture rejects missing, duplicate or malformed selectors and extra positionals', async () => {
  for (const argv of [
    ['capture'], ['capture', '--assignment-id'], ['capture', '--assignment-id', 'not-an-id'],
    ['capture', '--assignment-id', id('1') + '\n'],
    ['capture', '--assignment-id', id('1'), '--assignment-id', id('1')],
    ['capture', 'extra', '--assignment-id', id('1')],
    ['capture', '--assignment-id', id('1'), '--json=false'],
  ]) {
    const f = fixture(), d = await dispatcher();
    await assert.rejects(() => d.run(argv, f.context), /capture_assignment_command_invalid/);
    assert.equal(f.reads(), 0); assert.deepEqual(d.effects, []);
  }
});

test('an assigned host context cannot fall through to another CLI operation or bootstrap scope', async () => {
  for (const argv of [['providers', 'list'], ['repositories', 'metadata'], ['evidence', 'sync']]) {
    const f = fixture(), d = await dispatcher();
    await assert.rejects(() => d.run(argv, f.context), /capture_assignment_command_invalid/);
    assert.equal(f.reads(), 0); assert.deepEqual(d.effects, []);
  }
  const f = fixture(), d = await dispatcher(true);
  await assert.rejects(() => d.run(['capture', '--assignment-id', id('1')], f.context), /capture_assignment_command_invalid/);
  assert.equal(f.reads(), 0); assert.deepEqual(d.effects, []);
});

test('a different assignment id or missing exact reader cannot select another source', async () => {
  for (const missingReader of [false, true]) {
    const f = fixture(), d = await dispatcher();
    if (missingReader) delete f.context.reader;
    await assert.rejects(() => d.run(['capture', '--assignment-id', id(missingReader ? '1' : '9')], f.context),
      /capture_source_unavailable/);
    assert.equal(f.reads(), 0); assert.deepEqual(d.effects, []);
  }
});

test('assignment integrity, current binding and consent checks still precede the CLI exact read', async () => {
  for (const change of ['tampered', 'foreign', 'revoked', 'expired'] as const) {
    const f = fixture(), d = await dispatcher();
    if (change === 'tampered') f.assignment.source.maximumBytes++;
    if (change === 'foreign') f.context.binding.target.deviceId = id('9');
    if (change === 'revoked') f.context.binding.consentActive = false;
    if (change === 'expired') f.context.now = () => Date.parse(f.assignment.expiresAt);
    await assert.rejects(() => d.run(['capture', '--assignment-id', id('1')], f.context), /capture_assignment_/);
    assert.equal(f.reads(), 0); assert.deepEqual(d.effects, []);
  }
});

test('withdrawal during exact capture and private reader errors never return or persist a selection', async () => {
  for (const fail of [false, true]) {
    const f = fixture(), d = await dispatcher(), reader = f.context.reader!;
    f.context.reader = { async readExactSession(request) {
      if (fail) throw Error('PRIVATE_SOURCE_CANARY');
      const result = await reader.readExactSession(request); f.context.binding.consentActive = false; return result;
    } };
    await assert.rejects(() => d.run(['capture', '--assignment-id', id('1')], f.context), error => {
      assert.equal((error as Error).message, fail ? 'capture_source_unavailable' : 'capture_assignment_binding_mismatch');
      assert.equal(String(error).includes('PRIVATE_SOURCE_CANARY'), false); return true;
    });
    assert.deepEqual(d.effects, []);
  }
});

test('legacy CLI capture remains on its existing route when no assignment capability or selector is supplied', async () => {
  const d = await dispatcher();
  assert.deepEqual(JSON.parse(JSON.stringify(await d.run(['capture', '--workspace', '/fixture']))), { legacy: true });
  assert.deepEqual(d.effects, ['legacy_capture']);
});

test('assigned CLI context accessors are rejected without callbacks or ambient effects', async () => {
  for (const field of ['assignment', 'binding', 'now'] as const) {
    const f = fixture(), d = await dispatcher(); let callbacks = 0;
    Object.defineProperty(f.context, field, {enumerable: true, get() {callbacks++; throw new Error('PRIVATE_CONTEXT_CANARY');}});
    await assert.rejects(() => d.run(['capture', '--assignment-id', id('1')], f.context),
      {message: 'capture_assignment_invalid'});
    assert.equal(callbacks, 0); assert.equal(f.reads(), 0); assert.deepEqual(d.effects, []);
  }
});

test('assigned CLI reader slot stays lazy and descriptor-safe after authorization', async () => {
  for (const tampered of [false, true]) {
    const f = fixture(), d = await dispatcher(); let callbacks = 0;
    if (tampered) f.assignment.source.maximumBytes++;
    Object.defineProperty(f.context, 'reader', {enumerable: true, get() {callbacks++; throw new Error('PRIVATE_READER_CANARY');}});
    await assert.rejects(() => d.run(['capture', '--assignment-id', id('1')], f.context),
      {message: tampered ? 'capture_assignment_integrity_mismatch' : 'capture_source_unavailable'});
    assert.equal(callbacks, 0); assert.equal(f.reads(), 0); assert.deepEqual(d.effects, []);
  }
});

test('assigned CLI rejects Proxy and revoked contexts without running traps or ambient routes', async () => {
  const f = fixture(), d = await dispatcher(); let callbacks = 0;
  const fail = (): never => {callbacks++; throw new Error('PRIVATE_CONTEXT_PROXY_CANARY');};
  const proxy = new Proxy(f.context, {get: fail, getPrototypeOf: fail, ownKeys: fail, getOwnPropertyDescriptor: fail});
  const revoked = Proxy.revocable(f.context, {}); revoked.revoke();
  for (const context of [proxy, revoked.proxy]) {
    await assert.rejects(() => d.run(['capture', '--assignment-id', id('1')], context), {message: 'capture_assignment_invalid'});
    assert.equal(callbacks, 0); assert.equal(f.reads(), 0); assert.deepEqual(d.effects, []);
  }
});
