import assert from 'node:assert/strict';
import { appendFile, mkdir, mkdtemp, realpath, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { canonicalize, validateContract } from '@dharma-ai-labs/agent-fabric-contracts';
import type { TrajectoryCapsule } from '@dharma-ai-labs/agent-fabric-evidence-reduction';
import type { OrganizationPolicy } from '@dharma-ai-labs/agent-fabric-policy';
import {
  captureSessionSegments,
  relaySessionCaptureSettings,
  type SessionSegmentCaptureInput,
} from './sessionSegmentCapture.js';

const schemas = resolve(fileURLToPath(new URL('.', import.meta.url)), 'schemas');
const ORGANIZATION = 'org_test';
const DEVICE = '22222222-2222-4222-8222-222222222222';
const WORKSPACE_ID = '33333333-3333-4333-8333-333333333333';

const policy = (maximumCapsuleBytes: number, maximumDailyUploadBytes = 50_000_000): OrganizationPolicy => ({
  schema: 'dharma.organization-policy/v1', organizationId: ORGANIZATION, revision: 'rev_segments',
  evidence: {
    defaultMode: 'deep', registeredWorkspaceOnly: true, excludePaths: [], maximumCapsuleBytes,
    maximumDailyUploadBytes, maximumExpansionBytes: 100_000, pseudonymizeIdentity: true,
  },
  tasks: { defaultNetwork: 'deny', defaultGit: 'task_branch', allowedCommands: {}, writePaths: [], requireLocalConfirmationFor: [] },
  skills: { automaticInstall: true, automaticPromotionMaxRisk: 'R2', canaryPercent: 10 },
  retention: {}, budgets: {},
});

const at = (turn: number, second = 0) => new Date(Date.UTC(2026, 10, 18, 8, 0, 0) + turn * 60_000 + second * 1_000).toISOString();

function claudeTurn(cwd: string, turn: number, options: { outputBytes?: number; tools?: number } = {}) {
  const tools = options.tools ?? 1;
  const records: Array<Record<string, unknown>> = [
    { type: 'user', cwd, timestamp: at(turn, 0), message: { role: 'user', content: `task ${turn} ${'p'.repeat(turn)}` } },
  ];
  for (let tool = 0; tool < tools; tool += 1) {
    records.push(
      { type: 'assistant', cwd, timestamp: at(turn, 1 + tool * 2), message: { role: 'assistant', content: [
        { type: 'tool_use', id: `toolu_${turn}_${tool}`, name: 'Read', input: { file_path: `src/file-${tool}-${'f'.repeat(turn)}.ts` } },
      ] } },
      { type: 'user', cwd, timestamp: at(turn, 2 + tool * 2), message: { role: 'user', content: [
        { type: 'tool_result', tool_use_id: `toolu_${turn}_${tool}`, content: 'y'.repeat((options.outputBytes ?? 32) + tool) },
      ] } },
    );
  }
  records.push({ type: 'assistant', cwd, timestamp: at(turn, 2 + tools * 2), message: { role: 'assistant', content: [{ type: 'text', text: `done ${turn} ${'d'.repeat(turn)}` }] } });
  return records;
}

const jsonl = (records: unknown[]) => records.map((record) => JSON.stringify(record)).join('\n') + '\n';

async function fixture(prefix: string, turns: number, options: { outputBytes?: number; tools?: number } = {}) {
  const root = await mkdtemp(join(tmpdir(), prefix));
  const workspace = join(root, 'repo');
  await mkdir(workspace);
  const canonical = await realpath(workspace);
  const source = join(root, 'session.jsonl');
  // Distinct output sizes keep each reduced event distinct, so record counts are exact.
  const records = Array.from({ length: turns }, (_, turn) => claudeTurn(canonical, turn, {
    ...options, outputBytes: (options.outputBytes ?? 32) + turn * 7,
  })).flat();
  await writeFile(source, jsonl(records));
  return { root, workspace: canonical, source, records: records.length, ledgerRoot: join(root, 'ledger') };
}

function fakeStore(options: { heads?: Map<string, { revision: number; capsuleHash: string }>; failSync?: boolean } = {}) {
  const committed: TrajectoryCapsule[] = [];
  const synced: TrajectoryCapsule[] = [];
  const heads = options.heads ?? new Map();
  return {
    committed, synced, heads,
    store: {
      async commit(input: { capsule: TrajectoryCapsule; raw: Buffer; rawContentId: string }) {
        assert.equal(input.capsule.contentIndex[0]!.contentId, input.rawContentId);
        assert.equal(input.capsule.contentIndex[0]!.bytes, input.raw.byteLength);
        committed.push(input.capsule);
      },
      async head(capsule: TrajectoryCapsule) { return heads.get(capsule.trajectoryId) ?? null; },
      async sync(capsule: TrajectoryCapsule) {
        if (options.failSync) throw new Error('fetch failed');
        synced.push(capsule);
        heads.set(capsule.trajectoryId, { revision: capsule.revision, capsuleHash: capsule.capsuleHash });
      },
    },
  };
}

const validate = async (capsule: TrajectoryCapsule) => {
  const result = await validateContract(schemas, 'https://schemas.dharma-ai.io/trajectory-capsule/v2', capsule);
  assert.equal(result.ok, true, JSON.stringify('errors' in result ? result.errors : null));
};

function input(base: Awaited<ReturnType<typeof fixture>>, overrides: Partial<SessionSegmentCaptureInput>): SessionSegmentCaptureInput {
  return {
    organizationId: ORGANIZATION, deviceId: DEVICE, workspaceId: WORKSPACE_ID, workspacePath: base.workspace,
    provider: 'claude', sources: [base.source], policy: policy(60_000), ledgerRoot: base.ledgerRoot,
    idleMinutes: 30, validate, ...overrides,
  };
}

async function idleNow(path: string, minutes = 31) {
  return new Date((await stat(path)).mtimeMs + minutes * 60_000);
}

test('a session larger than the 8 MiB window becomes consecutive observed segments that cover every record', async () => {
  const base = await fixture('dharma-segments-long-', 60, { outputBytes: 170_000 });
  assert.ok((await stat(base.source)).size > 9 * 1024 * 1024);
  const { store, committed, synced } = fakeStore();
  const report = await captureSessionSegments(input(base, { store, now: () => new Date(Date.parse(at(60)) + 31 * 60_000) }));
  const now = await idleNow(base.source);
  const finished = await captureSessionSegments(input(base, { store, now: () => now }));

  const capsules = [...committed];
  assert.ok(capsules.length >= 3, `expected several segments, got ${capsules.length}`);
  assert.equal(report.stoppedReason, null);
  assert.equal(finished.stoppedReason, null);
  assert.deepEqual(synced.map((capsule) => capsule.trajectoryId), capsules.map((capsule) => capsule.trajectoryId));
  const link = capsules[0]!.sessionId.replace(/:segment:\d{6}$/, '');
  capsules.forEach((capsule, index) => {
    assert.equal(capsule.status, 'completed');
    assert.equal(capsule.coverage.state, 'observed');
    assert.deepEqual(capsule.coverage.missingFields, []);
    assert.equal(capsule.sessionId, `${link}:segment:${String(index).padStart(6, '0')}`);
    assert.ok(Buffer.byteLength(canonicalize(capsule)) <= 60_000);
    assert.equal(capsule.localAnalysis!.toolDiscipline.unmatchedCalls, 0, 'segments end on complete turns');
    if (index > 0) {
      assert.ok(Date.parse(capsule.timeRange.start) >= Date.parse(capsules[index - 1]!.timeRange.end), 'time ranges are ordered');
    }
  });
  assert.equal(capsules.reduce((total, capsule) => total + capsule.localAnalysis!.recordCount, 0), base.records);
  for (const capsule of capsules) await validate(capsule);
});

test('the open tail of an active session is held until the session is idle', async () => {
  const base = await fixture('dharma-segments-tail-', 30, { outputBytes: 2_000 });
  const { store, committed } = fakeStore();
  const activeAt = await idleNow(base.source, 1);
  const active = await captureSessionSegments(input(base, { store, now: () => activeAt }));
  assert.equal(active.sessions[0]!.held, true);
  const heldCount = committed.length;
  assert.ok(heldCount >= 1);
  const idle = await captureSessionSegments(input(base, { store, now: () => new Date(Date.now() + 3_600_000) }));
  assert.equal(idle.sessions[0]!.held, false);
  assert.equal(committed.length, heldCount + 1, 'only the tail segment is added once the session is idle');
});

test('re-running capture is idempotent and later turns continue the same segment sequence', async () => {
  const base = await fixture('dharma-segments-rerun-', 30, { outputBytes: 2_000 });
  const { store, committed, synced } = fakeStore();
  const later = () => new Date(Date.now() + 3_600_000);
  await captureSessionSegments(input(base, { store, now: later }));
  const first = committed.length;
  const rerun = await captureSessionSegments(input(base, { store, now: later }));
  assert.equal(committed.length, first, 'already-sent segments are skipped');
  assert.equal(synced.length, first);
  assert.equal(rerun.sessions[0]!.segmentsSkipped, first);
  assert.equal(rerun.sessions[0]!.segmentsCommitted, 0);

  await appendFile(base.source, jsonl([30, 31, 32].flatMap((turn) => claudeTurn(base.workspace, turn, { outputBytes: 50_000 + turn }))));
  await captureSessionSegments(input(base, { store, now: later }));
  assert.ok(committed.length > first);
  const added = committed.slice(first);
  assert.equal(added[0]!.sessionId.endsWith(`:segment:${String(first).padStart(6, '0')}`), true);
  assert.ok(Date.parse(added[0]!.timeRange.start) >= Date.parse(committed[first - 1]!.timeRange.end));
  assert.equal(new Set(committed.map((capsule) => capsule.trajectoryId)).size, committed.length);
});

test('a per-run upload budget stops cleanly and the next run continues without duplicates', async () => {
  const base = await fixture('dharma-segments-budget-', 40, { outputBytes: 2_000 });
  const reference = fakeStore();
  const later = () => new Date(Date.now() + 3_600_000);
  await captureSessionSegments(input(base, { store: reference.store, now: later, ledgerRoot: join(base.root, 'reference') }));
  const segmentBytes = Buffer.byteLength(canonicalize(reference.committed[0]!));

  const { store, committed } = fakeStore();
  const limited = await captureSessionSegments(input(base, { store, now: later, maximumUploadBytes: Math.floor(segmentBytes * 1.5) }));
  assert.equal(limited.budgetExhausted, true);
  assert.equal(committed.length, 1);
  assert.ok(limited.uploadedBytes <= Math.floor(segmentBytes * 1.5));
  for (let run = 0; run < 20 && committed.length < reference.committed.length; run += 1) {
    await captureSessionSegments(input(base, { store, now: later, maximumUploadBytes: Math.floor(segmentBytes * 1.5) }));
  }
  assert.deepEqual(committed.map((capsule) => capsule.capsuleHash), reference.committed.map((capsule) => capsule.capsuleHash));
});

test('the per-run budget never exceeds the policy daily upload limit', async () => {
  const base = await fixture('dharma-segments-daily-', 60, { outputBytes: 2_000 });
  const { store, committed } = fakeStore();
  const report = await captureSessionSegments(input(base, {
    store, now: () => new Date(Date.now() + 3_600_000), policy: policy(60_000, 70_000), maximumUploadBytes: 10_000_000,
  }));
  assert.equal(report.budgetExhausted, true);
  assert.ok(report.uploadedBytes <= 70_000);
  assert.equal(committed.length, 1);
});

test('one turn larger than a capsule is split only between complete tool exchanges', async () => {
  const base = await fixture('dharma-segments-giant-turn-', 2, { tools: 400, outputBytes: 100 });
  const { store, committed } = fakeStore();
  await captureSessionSegments(input(base, { store, now: () => new Date(Date.now() + 3_600_000), policy: policy(40_000) }));
  assert.ok(committed.length >= 3);
  for (const capsule of committed) {
    assert.equal(capsule.status, 'completed');
    assert.equal(capsule.coverage.state, 'observed');
    assert.equal(capsule.localAnalysis!.toolDiscipline.unmatchedCalls, 0);
    assert.equal(capsule.localAnalysis!.toolDiscipline.orphanResults, 0);
  }
  assert.equal(committed.reduce((total, capsule) => total + capsule.localAnalysis!.recordCount, 0), base.records);
});

test('plan mode writes nothing and reports the same segments a sync run commits', async () => {
  const base = await fixture('dharma-segments-plan-', 30, { outputBytes: 2_000 });
  const later = () => new Date(Date.now() + 3_600_000);
  const plan = await captureSessionSegments(input(base, { now: later }));
  assert.equal(plan.mode, 'plan');
  assert.ok(plan.segments.every((segment) => segment.outcome === 'planned'));
  const { store, committed } = fakeStore();
  await captureSessionSegments(input(base, { store, now: later }));
  assert.deepEqual(plan.segments.map((segment) => segment.capsuleHash), committed.map((capsule) => capsule.capsuleHash));
});

test('a segment already accepted by HQ is not uploaded again and a conflicting head stops that session', async () => {
  const base = await fixture('dharma-segments-heads-', 30, { outputBytes: 2_000 });
  const later = () => new Date(Date.now() + 3_600_000);
  const reference = fakeStore();
  await captureSessionSegments(input(base, { store: reference.store, now: later, ledgerRoot: join(base.root, 'reference') }));

  const accepted = fakeStore({ heads: new Map(reference.heads) });
  const report = await captureSessionSegments(input(base, { store: accepted.store, now: later }));
  assert.equal(accepted.synced.length, 0);
  assert.ok(report.segments.every((segment) => segment.outcome === 'already_on_server'));

  const conflicting = new Map([[reference.committed[0]!.trajectoryId, { revision: 1, capsuleHash: `sha256:${'b'.repeat(64)}` }]]);
  const conflict = fakeStore({ heads: conflicting });
  const stopped = await captureSessionSegments(input(base, { store: conflict.store, now: later, ledgerRoot: join(base.root, 'conflict') }));
  assert.equal(stopped.sessions[0]!.stoppedReason, 'segment_conflict');
  assert.equal(conflict.synced.length, 0);
});

test('a rewritten session source is refused instead of re-segmented', async () => {
  const base = await fixture('dharma-segments-rewrite-', 30, { outputBytes: 2_000 });
  const later = () => new Date(Date.now() + 3_600_000);
  const { store, committed } = fakeStore();
  await captureSessionSegments(input(base, { store, now: later }));
  const before = committed.length;
  await writeFile(base.source, jsonl(Array.from({ length: 40 }, (_, turn) => claudeTurn(base.workspace, turn, { outputBytes: 9_000 })).flat()));
  const report = await captureSessionSegments(input(base, { store, now: later }));
  assert.equal(report.sessions[0]!.stoppedReason, 'session_source_changed');
  assert.equal(committed.length, before);
});

test('a failed upload keeps the committed segment queued and is not committed twice', async () => {
  const base = await fixture('dharma-segments-offline-', 30, { outputBytes: 2_000 });
  const later = () => new Date(Date.now() + 3_600_000);
  const offline = fakeStore({ failSync: true });
  const report = await captureSessionSegments(input(base, { store: offline.store, now: later }));
  assert.equal(report.stoppedReason, 'sync_failed');
  assert.equal(offline.committed.length, 1);
  await captureSessionSegments(input(base, { store: offline.store, now: later }));
  assert.equal(new Set(offline.committed.map((capsule) => capsule.trajectoryId)).size, offline.committed.length);
});

test('the relay capture timer is refused while HQ would count every segment toward its automatic window', () => {
  assert.throws(() => relaySessionCaptureSettings(new Map([['capture-sessions', true]])), /session_segment_upload_unavailable/);
  assert.deepEqual(relaySessionCaptureSettings(new Map()), { enabled: false });
});

test('relay session capture is off unless explicitly enabled and its timer is bounded', () => {
  assert.deepEqual(relaySessionCaptureSettings(new Map()), { enabled: false });
  const enabled = relaySessionCaptureSettings(new Map([['capture-sessions', true]]));
  assert.deepEqual(enabled, {
    enabled: true, intervalMs: 15 * 60_000, lookbackHours: 24, idleMinutes: 30, providers: ['claude', 'codex'],
  });
  assert.deepEqual(relaySessionCaptureSettings(new Map<string, string | boolean>([
    ['capture-sessions', true], ['capture-interval-minutes', '60'], ['capture-lookback-hours', '72'], ['capture-idle-minutes', '45'],
  ])), { enabled: true, intervalMs: 3_600_000, lookbackHours: 72, idleMinutes: 45, providers: ['claude', 'codex'] });
  for (const [key, value] of [['capture-interval-minutes', '1'], ['capture-lookback-hours', '0'], ['capture-idle-minutes', 'soon']]) {
    assert.throws(() => relaySessionCaptureSettings(new Map<string, string | boolean>([['capture-sessions', true], [key!, value!]])),
      /relay_session_capture_setting_invalid/);
  }
  assert.throws(() => relaySessionCaptureSettings(new Map<string, string | boolean>([['capture-interval-minutes', '30']])),
    /relay_session_capture_setting_invalid/, 'timer settings without the opt-in flag are refused');
});
