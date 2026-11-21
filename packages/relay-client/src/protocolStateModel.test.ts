import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { test } from 'node:test';
import type { SecureSecretStore } from '@dharma-ai-labs/agent-fabric-secure-store';
import {
  AgentFabricClient, loadOrCreateDeviceIdentity, saveDeviceConfig, saveDeviceEnrollmentAnchor, withDeviceSigningControl,
} from './index.js';

// A seeded model of every party that shares one protocol-state file: 2 to 4 workspace owners that stop and restart,
// clients that send other owners' due requests, a minimal model of the relay client that v0.2.225 ships, an idle cap
// that removes entries without a kept request, removal of the file, write-back of an older copy, and processes that
// stop inside a state write right after a signature or between the state write and the send. Every signed request of
// every party is collected and checked against the protocol-state invariants.

const RUNS = Number(process.env.RELAY_PROTOCOL_MODEL_RUNS || 500);
const STEPS = 8;
const DECISION = '33333333-3333-4333-8333-333333333333';
const ACKNOWLEDGEMENT = /\/agent-fabric\/decisions\/[^/]+\/enforcements$/;

type Call = { by: string; path: string; body: string; messageId: string; sessionId: string; sequence: number;
  /** The method, path, every header and the body, for a byte-for-byte comparison. */
  envelope: string };
type Pending = { method: 'GET' | 'POST'; pathname: string; body: string; headers: Record<string, string> };
type Entry = { pending: Pending | null; keptCompletions?: Array<{ taskId: string }> };
type State = { schema: string; sessionId: string | null; nextSequence: number; pending: Pending | null;
  recoveredTaskCompletions?: Array<{ taskId: string }>; outboxes?: Record<string, Entry> };
type Party = { by: string; client: AgentFabricClient; stop: { armed: boolean; fired: boolean }; opened: boolean };

function seeded(seed: number) {
  let value = seed >>> 0;
  return () => {
    value = (value + 0x6d2b79f5) >>> 0;
    let mixed = Math.imul(value ^ (value >>> 15), value | 1);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4_294_967_296;
  };
}
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
const json = (body: unknown, status: number) => new Response(JSON.stringify(body), { status });

function memoryStore(): SecureSecretStore {
  const values = new Map<string, string>();
  return {
    backend: 'linux-secret-service',
    async get(account) { return values.get(account) || null; },
    async put(account, value) { values.set(account, value); },
    async delete(account) { values.delete(account); },
  };
}

async function modelDevice() {
  const store = memoryStore();
  const root = await mkdtemp(resolve(tmpdir(), 'fabric-protocol-model-'));
  const identity = await loadOrCreateDeviceIdentity({ hqUrl: 'https://hq.example', organizationId: 'org_a', store });
  const configPath = resolve(root, 'device.json'), statePath = resolve(root, 'state.json');
  const config = {
    schema: 'dharma.device-config/v1' as const, hqUrl: 'https://hq.example', organizationId: 'org_a',
    deviceId: randomUUID(), deviceName: 'Model', platform: 'linux' as const,
    publicKeyEd25519: identity.publicKeyEd25519, serverPublicKeyEd25519: identity.publicKeyEd25519,
    relayUrl: 'wss://relay.example', enrolledAt: new Date().toISOString(),
  };
  await saveDeviceConfig(configPath, config);
  await saveDeviceEnrollmentAnchor({ config: JSON.parse(await readFile(configPath, 'utf8')), store });
  return { store, configPath, statePath, config };
}

test('a seeded model of owners, other clients, the earlier version, idle eviction, file removal, older copies and stopped processes keeps the protocol-state invariants (shared protocol state)', async () => {
  const device = await modelDevice();
  const { statePath, config } = device;
  const realNow = Date.now;
  for (let seed = 1; seed <= RUNS; seed++) {
    const random = seeded(seed);
    const chance = (p: number) => random() < p;
    const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)]!;
    const where = (step: number | string) => `seed ${seed}, step ${step}`;

    // The server accepts a session's sequences only in increasing order, answers a replayed message id as it did the
    // first time, and fails some calls: before it records them, or after (the answer is lost).
    const calls: Call[] = [];
    const highest = new Map<string, number>();
    const answers = new Map<string, Response>();
    const definite = new Set<string>();
    let flaky = true;
    const respond = (call: Call): Response => {
      const replayed = answers.get(call.messageId);
      if (replayed) { definite.add(call.messageId); return replayed.clone(); }
      if ((highest.get(call.sessionId) ?? 0) >= call.sequence) {
        definite.add(call.messageId);
        return json({ ok: false, error: { code: 'sequence_out_of_order', message: 'Out of order.' } }, 409);
      }
      const roll = flaky ? random() : 1;
      const unavailable = json({ ok: false, error: { code: 'upstream_unavailable', message: 'Try again.' } }, 503);
      if (roll < 0.2) return unavailable;
      const task = call.path.match(/^\/agent-fabric\/tasks\/([^/]+)\/events$/)?.[1];
      const answer = json({ ok: true, ...(task ? { receipt: { hash: `sha256:${sha256(task)}` } } : {}) }, 201);
      highest.set(call.sessionId, call.sequence);
      answers.set(call.messageId, answer);
      if (roll < 0.3) return unavailable;
      definite.add(call.messageId);
      return answer.clone();
    };
    /** Every signed request, including one a process signed and stopped before sending. */
    const signed = (by: string, url: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      const call: Call = { by, path: new URL(String(url)).pathname.replace('/api/v1/orgs/org_a', ''), body: String(init?.body ?? ''),
        messageId: headers.get('x-dharma-message-id')!, sessionId: headers.get('x-dharma-session-id')!,
        sequence: Number(headers.get('x-dharma-sequence')),
        envelope: JSON.stringify([init?.method ?? 'GET', String(url), [...headers.entries()], String(init?.body ?? '')]) };
      calls.push(call);
      return call;
    };
    const send = (by: string, url: string | URL | Request, init?: RequestInit) => respond(signed(by, url, init));

    await rm(statePath, { force: true });
    let parties = 0;
    const open = async (ownerKey?: string): Promise<Party> => {
      const by = `${ownerKey ?? 'client'}#${++parties}`;
      const stop = { armed: false, fired: false };
      const fetcher = async (url: string | URL | Request, init?: RequestInit) => {
        if (stop.armed) {
          stop.armed = false;
          stop.fired = true;
          signed(by, url, init);
          throw new Error('the process stopped before the send');
        }
        return send(by, url, init);
      };
      const client = await AgentFabricClient.open({ configPath: device.configPath, statePath, store: device.store, fetcher,
        ...(ownerKey ? { ownerKey } : {}) });
      return { by, client, stop, opened: false };
    };
    const read = async (): Promise<State | null> => {
      try { return JSON.parse(await readFile(statePath, 'utf8')) as State; } catch { return null; }
    };

    const keys = Array.from({ length: 2 + Math.floor(random() * 3) }, (_, index) => `relay:model-${index}`);
    const owners = new Map<string, Party | null>(keys.map(key => [key, null]));
    /** Owner processes that stopped, and requests whose only record such a stop or a destructive write may have lost. */
    const stopped = new Set<string>();
    const lostByDesign = new Set<string>();
    let destructiveSince = new Set<string>();
    const snapshots: string[] = [];
    let acknowledged = new Set<string>();
    let earlier: { phase: 'replayed'; snapshot: State } | null = null;
    let completions = 0;

    const run = async (party: Party, work: (client: AgentFabricClient) => Promise<unknown>, step: number | string) => {
      const before = await readFile(statePath, 'utf8').catch(() => null);
      const inPersist = chance(0.5);
      if (chance(0.1)) party.stop.armed = true;
      try { await work(party.client); } catch (error) {
        const message = (error as Error).message;
        assert.doesNotMatch(message, /protocol state is invalid/, `${where(step)}: every written file is accepted by the reader`);
        assert.ok(!(party.opened && message === 'Relay session is not open.'), `${where(step)}: an owner keeps its session`);
      }
      party.stop.armed = false;
      if (!party.stop.fired) return;
      // The process stopped: either inside the state write right after its signature (the write never landed) or
      // between that write and the send.
      stopped.add(party.by);
      if (inPersist) {
        if (before === null) await rm(statePath, { force: true }); else await writeFile(statePath, before);
        for (const call of calls) if (call.by === party.by) lostByDesign.add(call.messageId);
      }
      const key = [...owners].find(([, owner]) => owner === party)?.[0];
      if (key) owners.set(key, null);
    };
    const destructive = () => { for (const by of stopped) destructiveSince.add(by); };
    const earlierSend = (pending: Pending) => {
      const answer = send('earlier', `https://hq.example${pending.pathname}`, { method: pending.method, headers: pending.headers,
        body: pending.method === 'GET' ? undefined : pending.body });
      return answer.status;
    };

    const operations: Record<string, (step: number) => Promise<void>> = {
      async call(step) {
        const key = pick(keys);
        let party = owners.get(key);
        if (!party) { party = await open(key); owners.set(key, party); }
        if (!party.opened) {
          const owner = party;
          await run(owner, async client => { await client.openSession(); owner.opened = true; }, step);
          return;
        }
        const kind = pick(['workspace', 'workspace', 'completion', 'acknowledgement', 'acknowledgement', 'poll'] as const);
        await run(party, client => {
          if (kind === 'workspace') return client.registerWorkspace({ workspaceId: `w${step}` });
          if (kind === 'completion') {
            return client.postTaskEvent(randomUUID(), 'completed', { trajectoryCapsuleHash: `sha256:${sha256(`c${++completions}`)}` });
          }
          if (kind === 'acknowledgement') {
            return client.postActionEnforcement(DECISION, { taskId: '11111111-1111-4111-8111-111111111111',
              endpointId: '22222222-2222-4222-8222-222222222222', actionDigest: `sha256:${'a'.repeat(64)}`, disposition: 'executed',
              externalIdempotencyKeyHash: 'b'.repeat(64), resultDigest: `sha256:${'c'.repeat(64)}`,
              acknowledgedAt: new Date(Date.now()).toISOString() });
          }
          return client.pollTask();
        }, step);
      },
      async reopen(step) {
        const key = pick(keys);
        let party = owners.get(key);
        if (!party) { party = await open(key); owners.set(key, party); }
        const owner = party;
        await run(owner, async client => { await client.openSession(); owner.opened = true; }, step);
      },
      async adopt(step) {
        const adopter = await open();
        await run(adopter, client => client.openSession(), step);
      },
      async earlierVersion() {
        if (!earlier) {
          // It reads only the top level, replays the kept request there and re-signs a stale action acknowledgement one
          // sequence higher in that request's session.
          const snapshot = await read() ?? { schema: 'dharma.protocol-state/v1', sessionId: null, nextSequence: 1, pending: null };
          const pending = snapshot.pending;
          if (pending) {
            let replay = pending;
            if (ACKNOWLEDGEMENT.test(pending.pathname)) {
              const at = Date.parse(JSON.parse(pending.body).acknowledgedAt);
              if (Date.now() - at > 8 * 60_000 || at > Date.now() + 5 * 60_000) {
                replay = { ...pending, body: JSON.stringify({ ...JSON.parse(pending.body), acknowledgedAt: new Date(Date.now()).toISOString() }),
                  headers: { ...pending.headers, 'x-dharma-message-id': randomUUID(),
                    'x-dharma-sequence': String(Number(pending.headers['x-dharma-sequence']) + 1) } };
              }
            }
            const status = earlierSend(replay);
            const answered = (status >= 200 && status < 300) || (status >= 400 && status < 500);
            snapshot.pending = answered ? null : replay;
            snapshot.nextSequence = Number(replay.headers['x-dharma-sequence']) + (answered ? 1 : 0);
          }
          earlier = { phase: 'replayed', snapshot };
          return;
        }
        // Until it opens its session it writes back the whole file it read; after that, a file without outboxes.
        const { snapshot } = earlier;
        if (chance(0.5)) await writeFile(statePath, JSON.stringify(snapshot));
        const session = randomUUID();
        earlierSend({ method: 'POST', pathname: '/api/v1/orgs/org_a/agent-fabric/sessions', body: '{}', headers: {
          'x-dharma-session-id': session, 'x-dharma-message-id': randomUUID(), 'x-dharma-sequence': '1' } });
        await writeFile(statePath, JSON.stringify({ schema: 'dharma.protocol-state/v1', sessionId: session, nextSequence: 2,
          pending: null, recoveredTaskCompletions: snapshot.recoveredTaskCompletions ?? [] }));
        destructive();
        acknowledged = new Set();
        earlier = null;
      },
      async evict() {
        const state = await read();
        const idle = Object.entries(state?.outboxes ?? {}).filter(([, entry]) => !entry.pending && !entry.keptCompletions);
        if (!state || !idle.length) return;
        delete state.outboxes![pick(idle)[0]];
        await writeFile(statePath, JSON.stringify(state));
      },
      async remove() {
        await rm(statePath, { force: true });
        destructive();
      },
      async older() {
        if (!snapshots.length) return;
        await writeFile(statePath, pick(snapshots));
        destructive();
        acknowledged = new Set();
      },
      async acknowledge(step) {
        const party = owners.get(pick(keys));
        const listed = party?.client.listRecoveredTaskCompletions() ?? [];
        if (!party || !listed.length) return;
        const item = pick(listed);
        await party.client.acknowledgeRecoveredTaskCompletion(item.taskId, item.receiptHash)
          .catch((error: Error) => assert.doesNotMatch(error.message, /protocol state is invalid/, where(step)));
        acknowledged.add(item.taskId);
      },
    };
    const weighted = ['call', 'call', 'call', 'call', 'reopen', 'adopt', 'earlierVersion', 'evict', 'remove', 'older',
      'acknowledge'] as const;

    for (let step = 0; step < STEPS; step++) {
      const offset = pick([0, 0, 0, 5, 9, 11, 22]) * 60_000;
      Date.now = () => realNow() + offset;
      try {
        await operations[pick(weighted)]!(step);
        await withDeviceSigningControl({ config }, async () => undefined);
      } finally { Date.now = realNow; }
      const state = await read();
      if (state) {
        snapshots.push(JSON.stringify(state));
        assert.ok(!state.pending || !ACKNOWLEDGEMENT.test(state.pending.pathname),
          `${where(step)}: the copy for an earlier version is never an action acknowledgement`);
        const stored = [...state.recoveredTaskCompletions ?? [], ...Object.values(state.outboxes ?? {})
          .flatMap(entry => entry.keptCompletions ?? [])].map(item => item.taskId);
        assert.deepEqual(stored.filter(taskId => acknowledged.has(taskId)), [],
          `${where(step)}: an acknowledged completion never comes back (I3)`);
      }
    }

    // Drain: the server answers everything, the earlier version opens its session, every owner opens its session (a
    // stopped one restarts), and other clients send what is left once it is due.
    flaky = false;
    if (earlier) await operations.earlierVersion!(STEPS);
    for (const key of keys) {
      const party = owners.get(key) ?? await open(key);
      owners.set(key, party);
      await party.client.openSession();
      party.opened = true;
    }
    const due = (state: State | null) => Object.values(state?.outboxes ?? {}).some(entry => entry.pending
      && !ACKNOWLEDGEMENT.test(entry.pending.pathname) && !entry.pending.pathname.endsWith('/poll')
      && !entry.pending.pathname.endsWith('/sessions'));
    for (let round = 0; round < 12 && due(await read()); round++) {
      Date.now = () => realNow() + 11 * 60_000;
      try { await (await open()).client.openSession(); } finally { Date.now = realNow; }
    }
    assert.equal(due(await read()), false, `${where('drain')}: every kept request is sent`);

    // I1: one message id per session and sequence, over every party's signed requests.
    const slots = new Map<string, string>();
    for (const call of calls) {
      const slot = `${call.sessionId}:${call.sequence}`;
      assert.equal(slots.get(slot) ?? call.messageId, call.messageId, `${where('end')}: sequence ${slot} is signed twice`);
      slots.set(slot, call.messageId);
    }
    // Only the process that opened a session signs in it; every other party sends there only exactly as signed: the
    // signed headers and the body byte for byte as its owner last signed them. A process with the same owner key (a
    // restarted workspace loop) is that owner. The earlier version is checked by I1 only.
    const opener = new Map<string, string>(), first = new Map<string, Call>();
    const owner = (by: string) => by.startsWith('relay:') ? by.slice(0, by.indexOf('#')) : by;
    const signedByOwner = new Map<string, Set<string>>();
    for (const call of calls) {
      if (call.path === '/agent-fabric/sessions' && !opener.has(call.sessionId)) opener.set(call.sessionId, call.by);
      const earliest = first.get(call.messageId);
      if (earliest) {
        assert.deepEqual([call.sessionId, call.sequence], [earliest.sessionId, earliest.sequence],
          `${where('end')}: ${call.by} sends another party's request only exactly as signed`);
        if (call.by === 'earlier') continue;
        if (owner(call.by) === owner(earliest.by)) signedByOwner.get(call.messageId)!.add(call.envelope);
        else {
          assert.ok(signedByOwner.get(call.messageId)!.has(call.envelope),
            `${where('end')}: ${call.by} sends ${earliest.by}'s request ${call.path} byte for byte as its owner signed it`);
        }
      } else {
        signedByOwner.set(call.messageId, new Set([call.envelope]));
        assert.equal(opener.get(call.sessionId), call.by, `${where('end')}: ${call.by} signs only in a session it opened`);
        first.set(call.messageId, call);
      }
    }
    // I2: a kept request with an unknown outcome is sent until it has a definite answer, unless its only record was
    // in a process that stopped inside its state write, or in a stopped process's entry that a destructive write
    // removed (file removal, an older copy, or the earlier version).
    for (const [messageId, call] of first) {
      if (call.by === 'earlier' || ACKNOWLEDGEMENT.test(call.path) || call.path.endsWith('/poll')
        || call.path.endsWith('/sessions') || definite.has(messageId) || lostByDesign.has(messageId)) continue;
      assert.ok(destructiveSince.has(call.by), `${where('end')}: ${call.by}'s request ${call.path} is never dropped unsent (I2)`);
    }
    destructiveSince = new Set();
  }
});
