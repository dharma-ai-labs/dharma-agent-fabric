import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import * as cli from './index.js';

// G20 finding 2: after setup, the local relay synced only capsules already queued in the vault, so a
// member's later provider sessions reached the server only after a manual `evidence capture-batch --sync`.

type Capsule = Record<string, unknown> & { trajectoryId: string; revision: number; capsuleHash: string };
type CaptureModule = {
  RELAY_SESSION_CAPTURE_INTERVAL_MS: number;
  runRelaySessionCapture<S>(input: { providers: readonly string[]; discover: (provider: string) => Promise<readonly S[]>;
    queue: (session: S) => Promise<boolean>; stopping: () => boolean }): Promise<{ queued: number; failures: number }>;
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
  return {
    capsules, queue,
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
    discardPendingCapsuleSync: () => { throw new Error('unexpected discard'); },
  };
}

test('relay session capture queues a new session once and a changed session as its next revision', async () => {
  const queueRelaySessionCapture = exported.queueRelaySessionCapture as
    ((vault: never, input: Record<string, unknown>) => Promise<boolean>) | undefined;
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

    assert.equal(await queue(2), true, 'a session the vault has not seen is queued');
    assert.equal(await sync(), 1, 'the relay pending sync uploads it');
    assert.equal(await queue(2), false, 'an unchanged session is not queued again');
    assert.equal(await sync(), 0);
    assert.equal(await queue(3), true, 'a session that grew is queued as a new revision');
    assert.equal(await sync(), 1);

    assert.deepEqual(sent.map(item => item.revision), [1, 2]);
    assert.equal(sent[0]!.trajectoryId, sent[1]!.trajectoryId);
    const [first, second] = vault.capsules.get(sent[0]!.trajectoryId)!;
    assert.equal(second!.previousRevisionHash, first!.capsuleHash);
    assert.equal((second!.captureProvenance as { sourceClass?: string }).sourceClass, 'provider_discovery');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('one provider or session failure does not stop the rest of a relay capture cycle', async () => {
  const { runRelaySessionCapture, RELAY_SESSION_CAPTURE_INTERVAL_MS } = await captureModule();
  const queued: string[] = [];
  const cycle = await runRelaySessionCapture<string>({ providers: ['codex', 'claude', 'hermes'],
    discover: async provider => {
      if (provider === 'codex') throw new Error('unreadable provider history');
      return provider === 'claude' ? ['a', 'broken', 'b'] : ['unchanged'];
    },
    queue: async value => {
      if (value === 'broken') throw new Error('capsule failed validation');
      queued.push(value); return value !== 'unchanged';
    },
    stopping: () => false });
  assert.deepEqual(cycle, { queued: 2, failures: 2 });
  assert.deepEqual(queued, ['a', 'b', 'unchanged']);
  assert.equal(RELAY_SESSION_CAPTURE_INTERVAL_MS, 300_000);
  let calls = 0;
  assert.deepEqual(await runRelaySessionCapture<string>({ providers: ['codex', 'claude'],
    discover: async () => { calls += 1; return ['a']; }, queue: async () => true, stopping: () => calls > 0 }),
  { queued: 0, failures: 0 }, 'a stopping relay ends the cycle');
});

test('a reached daily upload limit defers the relay evidence cycle instead of failing the relay', async () => {
  const { deferDailyUploadLimit } = await captureModule();
  assert.deepEqual(await deferDailyUploadLimit(async () => {
    throw new Error('Organization daily content upload limit would be exceeded.');
  }), { state: 'deferred', reason: 'daily_upload_limit' });
  await assert.rejects(deferDailyUploadLimit(async () => { throw new Error('other failure'); }), /^Error: other failure$/);
  assert.deepEqual(await deferDailyUploadLimit(async () => 3), { state: 'completed', value: 3 });
});

test('actual relay captures provider sessions on its schedule before the pending capsule sync', async () => {
  const text = await readFile(new URL('../src/index.ts', import.meta.url), 'utf8');
  const relay = text.slice(text.indexOf('async function relayWorkspaceLoop('), text.indexOf('export async function run('));
  const capture = relay.indexOf('runRelaySessionCapture({');
  assert.ok(capture > 0, 'the relay loop must capture new provider sessions');
  assert.ok(capture < relay.indexOf("withRepositoryRelayStage('evidence_sync'"), 'captured sessions upload in the same cycle');
  assert.match(relay, /performance\.now\(\) >= nextSessionCaptureAt/);
  assert.match(relay, /nextSessionCaptureAt = performance\.now\(\) \+ RELAY_SESSION_CAPTURE_INTERVAL_MS;/);
  assert.match(relay, /queue: session => queueRelaySessionCapture\(vault, \{/);
  assert.match(relay, /deferDailyUploadLimit\(\(\) => syncPendingRetentionCapsules\(/);
  assert.match(relay, /sessionCapturesQueued, sessionCaptureFailures,/);
});
