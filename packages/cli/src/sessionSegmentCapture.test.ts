import assert from 'node:assert/strict';
import { appendFile, mkdir, mkdtemp, realpath, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { generateKeyPairSync } from 'node:crypto';
import { canonicalize, signCanonicalObject, validateContract } from '@dharma-ai-labs/agent-fabric-contracts';
import { containsDisallowedLocalPath, type TrajectoryCapsule } from '@dharma-ai-labs/agent-fabric-evidence-reduction';
import { verifyServerAuthorizedPolicy, type OrganizationPolicy } from '@dharma-ai-labs/agent-fabric-policy';
import {
  captureSessionSegments,
  relaySessionCaptureBlocked,
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

// A content-disclosure policy as the CLI holds it after verifying HQ's signed authorization.
function contentPolicy(maximumCapsuleBytes: number): OrganizationPolicy {
  const keys = generateKeyPairSync('ed25519');
  const disclosure = {
    mode: 'customer_authorized_content' as const, consentReceiptId: 'consent_segments_test',
    allowedContentClasses: ['native_provider_payload' as const],
  };
  const now = Date.now();
  const unsigned = {
    schema: 'dharma.workspace-policy-authorization/v1' as const, organizationId: ORGANIZATION, workspaceId: WORKSPACE_ID,
    policy: { revision: 'rev_segments', evidence: {
      automaticDisclosure: disclosure, maximumCapsuleBytes, maximumDailyUploadBytes: 50_000_000,
      maximumExpansionBytes: 100_000, excludePaths: [], pseudonymizeIdentity: true as const,
    } },
    issuedAt: new Date(now - 60_000).toISOString(), expiresAt: new Date(now + 3_600_000).toISOString(), keyVersion: 'test',
  };
  const base = policy(maximumCapsuleBytes);
  return verifyServerAuthorizedPolicy({
    policy: { ...base, schema: 'dharma.organization-policy/v2', evidence: { ...base.evidence, automaticDisclosure: disclosure },
      serverAuthorization: { ...unsigned, signature: signCanonicalObject(unsigned, keys.privateKey) } },
    publicKeyEd25519: keys.publicKey.export({ format: 'jwk' }).x!, organizationId: ORGANIZATION, workspaceId: WORKSPACE_ID,
    now: new Date(now),
  });
}

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

test('a time budget stops a run after a whole segment and the next run continues from the ledger', async () => {
  const base = await fixture('dharma-segments-deadline-', 40, { outputBytes: 2_000 });
  const later = new Date(Date.now() + 3_600_000);
  const reference = fakeStore();
  await captureSessionSegments(input(base, {
    store: reference.store, now: () => later, policy: policy(25_000), ledgerRoot: join(base.root, 'reference'),
  }));
  assert.ok(reference.committed.length >= 3);

  // The deadline has already passed, yet every run still adds one whole segment.
  const { store, committed } = fakeStore();
  const run = () => captureSessionSegments(input(base, { store, now: () => later, policy: policy(25_000), deadline: later.getTime() - 1 }));
  const first = await run();
  assert.equal(first.stoppedReason, 'time_budget_exhausted');
  assert.equal(committed.length, 1);
  for (let attempt = 0; attempt < 20 && committed.length < reference.committed.length; attempt += 1) await run();
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

test('an idle tail whose last tool call has no result yet is held instead of splitting the call from its result', async () => {
  const later = () => new Date(Date.now() + 3_600_000);
  const assertClosed = (capsules: TrajectoryCapsule[]) => {
    for (const capsule of capsules) {
      assert.equal(capsule.localAnalysis!.toolDiscipline.unmatchedCalls, 0);
      assert.equal(capsule.localAnalysis!.toolDiscipline.orphanResults, 0);
    }
  };

  // A permission prompt or a long subagent leaves the file idle with a call waiting.
  const base = await fixture('dharma-segments-open-call-', 20, { outputBytes: 2_000 });
  const open = claudeTurn(base.workspace, 20, { outputBytes: 2_100 });
  await appendFile(base.source, jsonl(open.slice(0, 2)));
  const small = fakeStore();
  const waiting = await captureSessionSegments(input(base, { store: small.store, now: later }));
  assert.equal(waiting.sessions[0]!.held, true);
  await appendFile(base.source, jsonl(open.slice(2)));
  await captureSessionSegments(input(base, { store: small.store, now: later }));
  assertClosed(small.committed);
  assert.equal(small.committed.reduce((total, capsule) => total + capsule.localAnalysis!.recordCount, 0), base.records + open.length);

  // The same inside a turn too large for one capsule.
  const giant = await fixture('dharma-segments-open-call-giant-', 0);
  const records = claudeTurn(giant.workspace, 0, { tools: 400, outputBytes: 100 });
  await writeFile(giant.source, jsonl(records.slice(0, -2)));
  const split = fakeStore();
  const held = await captureSessionSegments(input(giant, { store: split.store, now: later, policy: policy(40_000) }));
  assert.equal(held.sessions[0]!.held, true);
  await appendFile(giant.source, jsonl(records.slice(-2)));
  await captureSessionSegments(input(giant, { store: split.store, now: later, policy: policy(40_000) }));
  assertClosed(split.committed);
  assert.equal(split.committed.reduce((total, capsule) => total + capsule.localAnalysis!.recordCount, 0), records.length);
});

test('a turn whose records were all left out marks the segment around it partial', async () => {
  const base = await fixture('dharma-segments-excluded-turn-', 0);
  const elsewhere = join(base.root, 'elsewhere');
  // A left-out turn in the middle joins the next turn; the last one of an idle file stands alone.
  const left = [20, 39];
  const turns = Array.from({ length: 40 }, (_, turn) => claudeTurn(left.includes(turn) ? elsewhere : base.workspace, turn, { outputBytes: 2_000 + turn }));
  await writeFile(base.source, jsonl(turns.flat()));
  const { store, committed } = fakeStore();
  await captureSessionSegments(input(base, { store, now: () => new Date(Date.now() + 3_600_000), policy: policy(25_000) }));
  assert.ok(committed.length >= 3);
  const partial = committed.map((capsule, index) => capsule.coverage.state === 'partial' ? index : -1).filter((index) => index >= 0);
  assert.equal(partial.length, 2, 'the segments that cover a left-out turn are partial');
  assert.equal(partial.at(-1), committed.length - 1);
  assert.equal(committed.reduce((total, capsule) => total + capsule.localAnalysis!.recordCount, 0),
    turns.flat().length - turns[20]!.length - turns[39]!.length);
});

test('one failing session does not stop the sessions after it, and its reason is reported', async () => {
  const base = await fixture('dharma-segments-failing-session-', 20, { outputBytes: 2_000 });
  const second = join(base.root, 'session-2.jsonl');
  await writeFile(second, jsonl(Array.from({ length: 5 }, (_, turn) => claudeTurn(base.workspace, 100 + turn)).flat()));
  const { store, committed } = fakeStore();
  let commits = 0;
  const failing = {
    ...store,
    async commit(item: Parameters<typeof store.commit>[0]) {
      if (commits++ === 0) throw new Error('Trajectory capsule revision hash conflict');
      return store.commit(item);
    },
  };
  const report = await captureSessionSegments(input(base, {
    store: failing as unknown as SessionSegmentCaptureInput['store'], sources: [base.source, second],
    now: () => new Date(Date.now() + 3_600_000),
  }));
  assert.equal(report.stoppedReason, null);
  assert.equal(report.sessions[0]!.stoppedReason, 'session_capture_failed');
  assert.equal(report.sessions[0]!.failure, 'vault_revision_conflict');
  assert.equal(report.sessions[1]!.stoppedReason, null);
  assert.equal(report.sessions[1]!.segmentsCommitted, committed.length);
  assert.ok(committed.length >= 1);
});

test('another spelling of the same session path is the same session and sends nothing again', async () => {
  const base = await fixture('dharma-segments-path-spelling-', 30, { outputBytes: 2_000 });
  await mkdir(join(base.root, 'nested'));
  const spellings = [`${base.root}${sep}nested${sep}..${sep}session.jsonl`];
  if (process.platform === 'win32') {
    spellings.push(base.source.replaceAll('\\', '/'), join(base.root, 'SESSION.JSONL'));
  }
  const { store, committed } = fakeStore();
  const later = () => new Date(Date.now() + 3_600_000);
  const original = await captureSessionSegments(input(base, { store, now: later }));
  const sent = committed.length;
  assert.ok(sent >= 1);
  for (const spelling of spellings) {
    const again = await captureSessionSegments(input(base, { store, now: later, sources: [spelling] }));
    assert.equal(again.sessions[0]!.sessionId, original.sessions[0]!.sessionId, spelling);
    assert.equal(again.sessions[0]!.segmentsSkipped, sent, spelling);
  }
  assert.equal(committed.length, sent);
});

test('secrets and local paths are redacted in every segment, on both sides of each boundary', async () => {
  const base = await fixture('dharma-segments-redaction-', 0);
  const secret = `ghp_${'A1b2C3d4'.repeat(5)}`;
  const outside = process.platform === 'win32' ? 'C:\\Users\\alice\\private\\notes.txt' : '/home/alice/private/notes.txt';
  const turns = Array.from({ length: 40 }, (_, turn) => {
    const records = claudeTurn(base.workspace, turn, { outputBytes: 2_000 + turn });
    const block = (records[2] as { message: { content: Array<{ content: string }> } }).message.content[0]!;
    block.content = `${secret} read ${outside} ${block.content}`;
    return records;
  });
  await writeFile(base.source, jsonl(turns.flat()));
  const local = policy(25_000);
  const content = contentPolicy(25_000);
  for (const evidencePolicy of [local, content]) {
    const { store, committed } = fakeStore();
    const report = await captureSessionSegments(input(base, {
      store, now: () => new Date(Date.now() + 3_600_000), policy: evidencePolicy,
      ledgerRoot: join(base.root, `ledger-${evidencePolicy === content ? 'content' : 'local'}`),
    }));
    assert.ok(committed.length >= 3, JSON.stringify({ mode: evidencePolicy === content, segments: committed.length,
      sessions: report.sessions, bytes: report.segments.map((segment) => segment.bytes) }));
    for (const capsule of committed) {
      const encoded = JSON.stringify(capsule);
      if (evidencePolicy === content) {
        assert.equal(capsule.automaticDisclosureMode, 'customer_authorized_content');
        assert.ok(encoded.includes('y'.repeat(64)), 'content mode carries the tool output');
      }
      assert.equal(encoded.includes(secret), false, 'no secret in any segment');
      assert.equal(encoded.includes('alice'), false, 'no local path outside the workspace in any segment');
      assert.equal(encoded.includes(base.workspace.replaceAll('\\', '\\\\')), false, 'no absolute workspace path');
      assert.equal(containsDisallowedLocalPath(capsule), false);
    }
  }
});

test('records whose cwd spells the workspace with forward slashes or another drive-letter case are kept', {
  skip: process.platform !== 'win32',
}, async () => {
  const base = await fixture('dharma-segments-windows-cwd-', 0);
  const spellings = [base.workspace.replaceAll('\\', '/'), base.workspace[0]!.toLowerCase() + base.workspace.slice(1)];
  const records = Array.from({ length: 20 }, (_, turn) => claudeTurn(spellings[turn % 2]!, turn, { outputBytes: 2_000 + turn })).flat();
  await writeFile(base.source, jsonl(records));
  const { store, committed } = fakeStore();
  await captureSessionSegments(input(base, { store, now: () => new Date(Date.now() + 3_600_000) }));
  assert.ok(committed.length >= 1);
  assert.ok(committed.every((capsule) => capsule.coverage.state === 'observed'));
  assert.equal(committed.reduce((total, capsule) => total + capsule.localAnalysis!.recordCount, 0), records.length);
});

test('a split turn resumed after its held piece continues without unmatched calls or lost records', async () => {
  const giant = await fixture('dharma-segments-resume-split-', 0);
  const turn = claudeTurn(giant.workspace, 0, { tools: 400, outputBytes: 100 });
  const half = 1 + 2 * 250;
  await writeFile(giant.source, jsonl(turn.slice(0, half)));
  const { store, committed } = fakeStore();
  const run = (now: () => Date) => captureSessionSegments(input(giant, { store, now, policy: policy(40_000) }));
  const active = await run(() => new Date());
  assert.equal(active.sessions[0]!.held, true);
  assert.ok(committed.length >= 1, 'closed pieces of the open turn are sent');
  await appendFile(giant.source, jsonl([...turn.slice(half), ...claudeTurn(giant.workspace, 1)]));
  await run(() => new Date(Date.now() + 3_600_000));
  for (const capsule of committed) {
    assert.equal(capsule.localAnalysis!.toolDiscipline.unmatchedCalls, 0);
    assert.equal(capsule.localAnalysis!.toolDiscipline.orphanResults, 0);
  }
  assert.equal(committed.reduce((total, capsule) => total + capsule.localAnalysis!.recordCount, 0), turn.length + claudeTurn(giant.workspace, 1).length);
});

test('turns with identical content are each covered once', async () => {
  const base = await fixture('dharma-segments-identical-', 0);
  const same = (turn: number) => claudeTurn(base.workspace, 0, { outputBytes: 2_000 }).map((record) => ({ ...record, timestamp: at(turn) }));
  const records = Array.from({ length: 40 }, (_, turn) => same(turn)).flat();
  await writeFile(base.source, jsonl(records));
  const { store, committed } = fakeStore();
  await captureSessionSegments(input(base, { store, now: () => new Date(Date.now() + 3_600_000), policy: policy(25_000) }));
  assert.ok(committed.length >= 1);
  assert.equal(committed.reduce((total, capsule) => total + capsule.localAnalysis!.recordCount, 0), records.length);
  for (const capsule of committed) {
    assert.equal(capsule.coverage.state, 'observed');
    assert.ok(Buffer.byteLength(canonicalize(capsule)) <= 25_000);
  }
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

test('in content mode the relay timer captures only sessions a person listed after a preview', () => {
  const available = { uploadAvailable: true };
  const local = policy(60_000);
  const content: OrganizationPolicy = { ...local, evidence: { ...local.evidence,
    automaticDisclosure: { mode: 'customer_authorized_content', consentReceiptId: 'consent_test' } } };
  const unlisted = relaySessionCaptureSettings(new Map([['capture-sessions', true]]), available);
  assert.equal(relaySessionCaptureBlocked(unlisted, content), 'session_capture_requires_session_allowlist');
  assert.equal(relaySessionCaptureBlocked(unlisted, local), null);
  const listed = relaySessionCaptureSettings(new Map<string, string | boolean>([
    ['capture-sessions', true], ['capture-session-ids-file', 'previewed-sessions.json'],
  ]), available);
  assert.equal(listed.enabled && listed.sessionIdsFile, resolve('previewed-sessions.json'));
  assert.equal(relaySessionCaptureBlocked(listed, content), null);
  assert.throws(() => relaySessionCaptureSettings(new Map([['capture-session-ids-file', 'previewed-sessions.json']]), available),
    /relay_session_capture_setting_invalid/, 'the allowlist without the opt-in flag is refused');
});

test('relay session capture is off unless explicitly enabled and its timer is bounded', () => {
  const available = { uploadAvailable: true };
  assert.deepEqual(relaySessionCaptureSettings(new Map(), available), { enabled: false });
  const enabled = relaySessionCaptureSettings(new Map([['capture-sessions', true]]), available);
  assert.deepEqual(enabled, {
    enabled: true, intervalMs: 15 * 60_000, lookbackHours: 24, idleMinutes: 30, providers: ['claude', 'codex'], sessionIdsFile: null,
  });
  assert.deepEqual(relaySessionCaptureSettings(new Map<string, string | boolean>([
    ['capture-sessions', true], ['capture-interval-minutes', '60'], ['capture-lookback-hours', '72'], ['capture-idle-minutes', '45'],
  ]), available), {
    enabled: true, intervalMs: 3_600_000, lookbackHours: 72, idleMinutes: 45, providers: ['claude', 'codex'], sessionIdsFile: null,
  });
  for (const [key, value] of [['capture-interval-minutes', '1'], ['capture-lookback-hours', '0'], ['capture-idle-minutes', 'soon']]) {
    assert.throws(() => relaySessionCaptureSettings(new Map<string, string | boolean>([['capture-sessions', true], [key!, value!]]), available),
      /relay_session_capture_setting_invalid/);
  }
  assert.throws(() => relaySessionCaptureSettings(new Map<string, string | boolean>([['capture-interval-minutes', '30']])),
    /relay_session_capture_setting_invalid/, 'timer settings without the opt-in flag are refused');
});
