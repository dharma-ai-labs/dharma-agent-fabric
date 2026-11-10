import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import * as cli from './index.js';

// G20 finding 2: after setup, the local relay synced only capsules already queued in the vault, so a
// member's later provider sessions reached the server only after a manual `evidence capture-batch --sync`.

type Capsule = Record<string, unknown> & { trajectoryId: string; revision: number; capsuleHash: string };
type QueueResult = 'queued' | 'unchanged' | 'pending';
type CaptureModule = {
  RELAY_SESSION_CAPTURE_INTERVAL_MS: number;
  runRelaySessionCapture<S extends { endedAt: string }>(input: { providers: readonly string[]; since: Map<string, Date>;
    now: number; discover: (provider: string, since: Date | undefined) => Promise<readonly S[] | null>;
    queue: (session: S) => Promise<QueueResult>; stopping: () => boolean }): Promise<{ queued: number; failures: number }>;
  deferDailyUploadLimit<T>(operation: () => Promise<T>): Promise<{ state: 'completed'; value: T }
    | { state: 'deferred'; reason: 'daily_upload_limit' }>;
};
// Resolved at run time, so the red commit fails these tests instead of the build.
const captureModule = async () => await import(String(new URL('./relaySessionCapture.js', import.meta.url))) as CaptureModule;
const exported = cli as unknown as Record<string, unknown>;

const organizationId = 'org_northstar';
const deviceId = '22222222-2222-4222-8222-222222222222';
const workspaceId = 'workspace-northstar';

function session(sessionId: string, records: number) {
  return {
    provider: 'codex' as const, sessionId, sourcePath: '/private/codex.jsonl',
    workspace: '/repo', coverage: 'observed' as const,
    startedAt: '2026-11-09T23:30:00.000Z', endedAt: `2026-11-09T23:3${records}:00.000Z`,
    records: Array.from({ length: records }, (_, index) => ({ native: { type: 'message', index },
      sourcePath: '/private/codex.jsonl', line: index + 1, workspace: '/repo',
      timestamp: `2026-11-09T23:3${index}:00.000Z`, kind: 'metadata' as const })),
  };
}

function memoryVault() {
  const capsules = new Map<string, Capsule[]>();
  const queue: Array<{ trajectoryId: string; revision: number }> = [];
  const retired = new Set<string>();
  return {
    capsules, queue, retired,
    getLatestCapsuleMetadata: (trajectoryId: string) => {
      const latest = capsules.get(trajectoryId)?.at(-1);
      return latest ? { revision: latest.revision, capsuleHash: latest.capsuleHash, blobContentId: 'blob' } : null;
    },
    getLatestCapsule: async (trajectoryId: string) => {
      const latest = capsules.get(trajectoryId)?.at(-1);
      if (!latest) throw new Error('Trajectory capsule is not available.');
      return structuredClone(latest);
    },
    commitCapture: async (input: { capsule: { plaintext: Uint8Array } }) => {
      const capsule = JSON.parse(Buffer.from(input.capsule.plaintext).toString('utf8')) as Capsule;
      capsules.set(capsule.trajectoryId, [...capsules.get(capsule.trajectoryId) ?? [], capsule]);
      return { rawContentId: 'raw', capsuleContentId: 'capsule' };
    },
    queueCapsuleSync: (trajectoryId: string, revision: number) => { queue.push({ trajectoryId, revision }); },
    listPendingCapsuleSyncs: async () => queue.map(item => ({ ...item,
      capsule: capsules.get(item.trajectoryId)!.find(capsule => capsule.revision === item.revision)! })),
    markCapsuleSynced: (trajectoryId: string, revision: number) => {
      queue.splice(queue.findIndex(item => item.trajectoryId === trajectoryId && item.revision === revision), 1);
    },
    discardPendingCapsuleSync: (trajectoryId: string, revision: number) => {
      retired.add(`${trajectoryId}:${revision}`);
      queue.splice(queue.findIndex(item => item.trajectoryId === trajectoryId && item.revision === revision), 1);
    },
    capsuleSyncState: (trajectoryId: string, revision: number) =>
      queue.some(item => item.trajectoryId === trajectoryId && item.revision === revision) ? 'pending'
        : retired.has(`${trajectoryId}:${revision}`) ? 'retired' : null,
  };
}

test('relay session capture queues a new session once and a changed session as its next revision', async () => {
  const queueRelaySessionCapture = exported.queueRelaySessionCapture as
    ((vault: never, input: Record<string, unknown>) => Promise<QueueResult>) | undefined;
  assert.equal(typeof queueRelaySessionCapture, 'function', 'the relay needs a session capture step');
  const syncPending = exported.syncPendingRetentionCapsules as (vault: never, fabric: never, policy: unknown,
    workspaceId: string) => Promise<number>;
  const materialize = exported.materializeWorkspacePolicy as (input: Record<string, unknown>) => Promise<{ policy: unknown }>;
  const root = await mkdtemp(join(tmpdir(), 'dharma-relay-session-capture-'));
  try {
    const { policy } = await materialize({ workspace: root, organizationId, revision: 'local' });
    const vault = memoryVault();
    const sent: Array<{ trajectoryId: string; revision: number }> = [];
    const fabric = { config: { organizationId, deviceId },
      syncTrajectory: async (capsule: Capsule) => { sent.push({ trajectoryId: capsule.trajectoryId, revision: capsule.revision }); } };
    const scope = { organizationId, deviceId, workspaceId, policy };
    const queue = (records: number) => queueRelaySessionCapture!(vault as never, { ...scope, session: session('member-session', records) });
    const sync = () => syncPending(vault as never, fabric as never, policy, workspaceId);

    assert.equal(await queue(2), 'queued', 'a session the vault has not seen is queued');
    assert.equal(await sync(), 1, 'the relay pending sync uploads it');
    assert.equal(await queue(2), 'unchanged', 'an unchanged session is not queued again');
    assert.equal(await sync(), 0);
    assert.equal(await queue(3), 'queued', 'a session that grew is queued as a new revision');
    assert.equal(await sync(), 1);

    assert.deepEqual(sent.map(item => item.revision), [1, 2]);
    assert.equal(sent[0]!.trajectoryId, sent[1]!.trajectoryId);
    const [first, second] = vault.capsules.get(sent[0]!.trajectoryId)!;
    assert.equal(second!.previousRevisionHash, first!.capsuleHash);
    assert.equal((second!.captureProvenance as { sourceClass?: string }).sourceClass, 'provider_discovery');
  } finally { await rm(root, { recursive: true, force: true }); }
});

const minute = 60_000;
const quiet = (sessionId: string) => ({ sessionId, endedAt: '2026-11-09T00:00:00.000Z' });

test('one provider or session failure does not stop the rest of a relay capture cycle', async () => {
  const { runRelaySessionCapture, RELAY_SESSION_CAPTURE_INTERVAL_MS } = await captureModule();
  const queued: string[] = [];
  const now = Date.parse('2026-11-10T00:00:00.000Z');
  const cycle = await runRelaySessionCapture<{ sessionId: string; endedAt: string }>({ providers: ['codex', 'claude', 'hermes'],
    since: new Map(), now,
    discover: async provider => {
      if (provider === 'codex') throw new Error('unreadable provider history');
      return provider === 'claude' ? [quiet('a'), quiet('broken'), quiet('b')] : [quiet('unchanged')];
    },
    queue: async value => {
      if (value.sessionId === 'broken') throw new Error('capsule failed validation');
      queued.push(value.sessionId); return value.sessionId === 'unchanged' ? 'unchanged' : 'queued';
    },
    stopping: () => false });
  assert.deepEqual(cycle, { queued: 2, failures: 2 });
  assert.deepEqual(queued, ['a', 'b', 'unchanged']);
  assert.equal(RELAY_SESSION_CAPTURE_INTERVAL_MS, 300_000);
  let calls = 0;
  assert.deepEqual(await runRelaySessionCapture({ providers: ['codex', 'claude'], since: new Map(), now,
    discover: async () => { calls += 1; return [quiet('a')]; }, queue: async () => 'queued' as const, stopping: () => calls > 0 }),
  { queued: 0, failures: 0 }, 'a stopping relay ends the cycle');
});

// Review B2: a session still in progress grew every cycle, so each 5-minute cycle uploaded a full new revision.
test('relay capture waits until a session has been quiet for one interval before queuing it', async () => {
  const { runRelaySessionCapture, RELAY_SESSION_CAPTURE_INTERVAL_MS } = await captureModule();
  const start = Date.parse('2026-11-10T12:00:00.000Z');
  // One member session, written every minute for 20 minutes, then quiet. Discovery honors `since` like the adapters.
  const lastWrite = start + 20 * minute;
  const member = (now: number) => ({ sessionId: 'member', endedAt: new Date(Math.min(now, lastWrite)).toISOString() });
  const since = new Map<string, Date>(); const queued: string[] = [];
  for (let now = start; now <= start + 40 * minute; now += RELAY_SESSION_CAPTURE_INTERVAL_MS) {
    await runRelaySessionCapture({ providers: ['codex'], since, now,
      discover: async (_provider, after) => {
        const current = member(now);
        return after && Date.parse(current.endedAt) < after.getTime() ? [] : [current];
      },
      // Like the vault: the same evidence twice is unchanged.
      queue: async session => {
        if (queued.includes(session.endedAt)) return 'unchanged' as const;
        queued.push(session.endedAt); return 'queued' as const;
      }, stopping: () => false });
  }
  assert.deepEqual(queued, [new Date(lastWrite).toISOString()], 'only the finished session is queued, once');
});

// Review B6: every cycle re-read and rebuilt up to 20 sessions per provider before task polling.
test('relay capture discovers only sessions changed since the last complete cycle of that provider', async () => {
  const { runRelaySessionCapture, RELAY_SESSION_CAPTURE_INTERVAL_MS } = await captureModule();
  const now = Date.parse('2026-11-10T12:00:00.000Z');
  const since = new Map<string, Date>(); const asked: Array<[string, string | undefined]> = [];
  const cycle = (at: number, results: Record<string, 'throw' | 'null' | 'fail' | QueueResult>) => runRelaySessionCapture({
    providers: Object.keys(results), since, now: at,
    discover: async (provider, after) => {
      asked.push([provider, after?.toISOString()]);
      if (results[provider] === 'throw') throw new Error('unreadable');
      return results[provider] === 'null' ? null : [quiet(provider)];
    },
    queue: async session => {
      const result = results[session.sessionId]!;
      if (result === 'fail') throw new Error('capsule failed');
      return result as QueueResult;
    }, stopping: () => false });
  await cycle(now, { codex: 'queued', claude: 'throw', hermes: 'null', agy: 'pending', gemini: 'fail' });
  const next = now + RELAY_SESSION_CAPTURE_INTERVAL_MS;
  await cycle(next, { codex: 'unchanged', claude: 'unchanged', hermes: 'unchanged', agy: 'unchanged', gemini: 'unchanged' });
  const window = new Date(now - RELAY_SESSION_CAPTURE_INTERVAL_MS).toISOString();
  assert.deepEqual(asked.slice(0, 5).map(([, after]) => after), [undefined, undefined, undefined, undefined, undefined]);
  assert.deepEqual(asked.slice(5), [['codex', window], ['claude', undefined], ['hermes', undefined], ['agy', undefined],
    ['gemini', undefined]], 'a provider whose cycle failed, was skipped or still waits keeps its full window');
  assert.equal(since.get('claude')?.toISOString(), new Date(next - RELAY_SESSION_CAPTURE_INTERVAL_MS).toISOString());
});

function retireRevision(vault: ReturnType<typeof memoryVault>, revision: number) {
  const [trajectoryId] = [...vault.capsules.keys()];
  vault.discardPendingCapsuleSync(trajectoryId!, revision);
}

// Review B3: a revision chained onto a retired local revision made the relay evidence stage throw every cycle.
test('a session whose latest revision was retired is not chained onto it and the next sync does not throw', async () => {
  const queueRelaySessionCapture = exported.queueRelaySessionCapture as
    (vault: never, input: Record<string, unknown>) => Promise<QueueResult>;
  const syncPending = exported.syncPendingRetentionCapsules as (vault: never, fabric: never, policy: unknown,
    workspaceId: string) => Promise<number>;
  const materialize = exported.materializeWorkspacePolicy as (input: Record<string, unknown>) => Promise<{ policy: unknown }>;
  const { runRelaySessionCapture } = await captureModule();
  const root = await mkdtemp(join(tmpdir(), 'dharma-relay-session-retired-'));
  try {
    const { policy } = await materialize({ workspace: root, organizationId, revision: 'local' });
    const vault = memoryVault(); const sent: number[] = [];
    const fabric = { config: { organizationId, deviceId }, syncTrajectory: async (capsule: Capsule) => { sent.push(capsule.revision); } };
    const scope = { organizationId, deviceId, workspaceId, policy };
    const queue = (records: number) => queueRelaySessionCapture(vault as never, { ...scope, session: session('member-session', records) });
    assert.equal(await queue(2), 'queued');
    assert.equal(await syncPending(vault as never, fabric as never, policy, workspaceId), 1);
    assert.equal(await queue(3), 'queued');
    retireRevision(vault, 2);
    const cycle = await runRelaySessionCapture({ providers: ['codex'], since: new Map(), now: Date.now(),
      discover: async () => [session('member-session', 4)],
      queue: grown => queueRelaySessionCapture(vault as never, { ...scope, session: grown }), stopping: () => false });
    assert.deepEqual(cycle, { queued: 0, failures: 1 }, 'the retired session is counted, not chained');
    assert.deepEqual([...vault.capsules.values()][0]!.map(capsule => capsule.revision), [1, 2]);
    assert.equal(await syncPending(vault as never, fabric as never, policy, workspaceId), 0, 'the next sync does not throw');
    assert.deepEqual(sent, [1]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

// Review B4: while sync was deferred, each cycle stacked another full revision onto the unsynced one.
test('a session with a revision still waiting for sync gets no new revision until that one is accepted', async () => {
  const queueRelaySessionCapture = exported.queueRelaySessionCapture as
    (vault: never, input: Record<string, unknown>) => Promise<QueueResult>;
  const syncPending = exported.syncPendingRetentionCapsules as (vault: never, fabric: never, policy: unknown,
    workspaceId: string) => Promise<number>;
  const materialize = exported.materializeWorkspacePolicy as (input: Record<string, unknown>) => Promise<{ policy: unknown }>;
  const root = await mkdtemp(join(tmpdir(), 'dharma-relay-session-pending-'));
  try {
    const { policy } = await materialize({ workspace: root, organizationId, revision: 'local' });
    const vault = memoryVault(); const sent: number[] = [];
    const fabric = { config: { organizationId, deviceId }, syncTrajectory: async (capsule: Capsule) => { sent.push(capsule.revision); } };
    const scope = { organizationId, deviceId, workspaceId, policy };
    const queue = (records: number) => queueRelaySessionCapture(vault as never, { ...scope, session: session('member-session', records) });
    assert.equal(await queue(2), 'queued');
    assert.equal(await queue(3), 'pending', 'sync is deferred: the grown session waits');
    assert.equal(await queue(4), 'pending');
    assert.deepEqual(vault.queue.map(item => item.revision), [1]);
    assert.equal(await syncPending(vault as never, fabric as never, policy, workspaceId), 1);
    assert.equal(await queue(4), 'queued', 'after the upload, the latest state is one new revision');
    assert.equal(await syncPending(vault as never, fabric as never, policy, workspaceId), 1);
    assert.deepEqual(sent, [1, 2]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('a reached daily upload limit defers the relay evidence cycle instead of failing the relay', async () => {
  const { deferDailyUploadLimit } = await captureModule();
  assert.deepEqual(await deferDailyUploadLimit(async () => {
    throw new Error('Organization daily content upload limit would be exceeded.');
  }), { state: 'deferred', reason: 'daily_upload_limit' });
  await assert.rejects(deferDailyUploadLimit(async () => { throw new Error('other failure'); }), /^Error: other failure$/);
  assert.deepEqual(await deferDailyUploadLimit(async () => 3), { state: 'completed', value: 3 });
});
