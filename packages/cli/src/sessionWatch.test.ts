import assert from 'node:assert/strict';
import { createPublicKey, generateKeyPairSync, randomUUID } from 'node:crypto';
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import {
  advanceSessionMessageDelivery,
  createSessionReplyToken,
  sessionMessageBodyHash,
  signSessionMessage,
  SESSION_MESSAGE_MAX_LIFETIME_MS,
  type SessionMessage,
  type SessionMessageDeliveryStatus,
} from '@dharma-ai-labs/agent-fabric-contracts';
import { readSessionDeliveryReceipt } from './sessionDeliveryReceipt.js';
import { frameSessionMessage, sessionMessageFrameKey } from './sessionMessageFrame.js';
import { writeSessionStateFile, sessionStatePath, type LocalSessionAttachment, type SessionMessageTransport,
  type SessionMessagingHost } from './sessionNames.js';
import {
  createCodexDeliveryPort,
  parseCodexRollout,
  sessionMessageFrameHeaderPrefix,
  sessionWatchCommand,
  watchCodexSessionOnce,
  type CodexDeliveryPort,
  type CodexQueueResult,
} from './sessionWatch.js';

const ORG = 'org-hq';
const START = Date.parse('2026-11-10T12:00:00.000Z');
const httpError = (message: string, status: number) => Object.assign(new Error(message), { status, definitive: true });

/** JSONL lines in the recorded Codex rollout shape (S1, codex-cli 0.165.0). */
class Rollout {
  readonly lines: string[] = [];
  constructor(readonly threadId: string, at: number) {
    this.add(at, 'session_meta', { id: threadId, session_id: threadId, cli_version: '0.165.0' });
  }
  add(at: number, type: string, payload: Record<string, unknown>) {
    this.lines.push(JSON.stringify({ timestamp: new Date(at).toISOString(), type, payload }));
    return this;
  }
  started(at: number, turnId: string) { return this.add(at, 'event_msg', { type: 'task_started', turn_id: turnId }); }
  user(at: number, turnId: string, text: string) {
    return this.add(at, 'response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text }],
      internal_chat_message_metadata_passthrough: { turn_id: turnId } });
  }
  assistant(at: number, turnId: string, text: string) {
    return this.add(at, 'response_item', { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }],
      internal_chat_message_metadata_passthrough: { turn_id: turnId } });
  }
  complete(at: number, turnId: string) { return this.add(at, 'event_msg', { type: 'task_complete', turn_id: turnId }); }
  aborted(at: number, turnId: string) { return this.add(at, 'event_msg', { type: 'turn_aborted', turn_id: turnId, reason: 'interrupted' }); }
  text() { return this.lines.map(line => `${line}\n`).join(''); }
}

/** Platform stand-in: poll returns queued messages for `ef`; it records delivered reports and refuses any ack. */
class Platform {
  readonly sender = generateKeyPairSync('ed25519');
  readonly senderIds = { membershipId: randomUUID(), deviceId: randomUUID(), name: 'ops-claude' };
  readonly messages = new Map<string, { envelope: SessionMessage; replyToken: string; delivery: SessionMessageDeliveryStatus }>();
  readonly reports: Array<{ messageId: string; body: unknown }> = [];
  readonly acks: string[] = [];

  add(body: string): SessionMessage {
    const { token, tokenHash } = createSessionReplyToken();
    const createdAt = new Date(START - 60_000);
    const envelope = signSessionMessage({ schema: 'dharma.session-message/v1', messageId: randomUUID(), organizationId: ORG,
      sender: this.senderIds, recipient: { name: 'ef' }, createdAt: createdAt.toISOString(),
      expiresAt: new Date(createdAt.getTime() + SESSION_MESSAGE_MAX_LIFETIME_MS).toISOString(), body,
      bodyHash: sessionMessageBodyHash(body), replyTo: null, replyTokenHash: tokenHash }, this.sender.privateKey);
    this.messages.set(envelope.messageId, { envelope, replyToken: token, delivery: { state: 'queued' } });
    return envelope;
  }
  record(id: string) {
    const stored = this.messages.get(id)!;
    return { schema: 'dharma.session-message-delivery/v1', organizationId: ORG, messageId: id, recipientName: 'ef',
      ...stored.delivery, updatedAt: new Date(START).toISOString() };
  }
  transport(): SessionMessageTransport {
    return {
      signedGet: async route => {
        const id = /\/session-messages\/([^/]+)\/delivery$/.exec(route)?.[1];
        if (id && this.messages.has(id)) return this.record(id);
        throw httpError('session_message_not_found', 404);
      },
      signedPost: async (route, raw) => {
        const body = JSON.parse(JSON.stringify(raw)) as Record<string, unknown>;
        if (route === '/agent-fabric/session-messages/poll') {
          return { messages: [...this.messages.values()].filter(item => item.delivery.state === 'queued').map(item => ({
            envelope: item.envelope, replyToken: item.replyToken,
            sender: { ...this.senderIds, publicKeyEd25519: createPublicKey(this.sender.privateKey).export({ format: 'jwk' }).x },
            delivery: item.delivery })) };
        }
        const match = /\/session-messages\/([^/]+)\/(delivered|ack)$/.exec(route);
        if (match?.[2] === 'ack') { this.acks.push(match[1]!); throw new Error('watcher_must_never_ack'); }
        if (match?.[2] === 'delivered') {
          const stored = this.messages.get(match[1]!)!;
          this.reports.push({ messageId: match[1]!, body });
          stored.delivery = advanceSessionMessageDelivery(stored.delivery, { actor: 'deliverer', state: 'delivered',
            channel: body.channel as 'codex_queue', outcome: body.outcome as 'processed' });
          return this.record(match[1]!);
        }
        throw httpError('route_not_found', 404);
      },
    };
  }
}

/** Codex stand-in: queue rows plus a rollout built in the recorded shape and parsed by the real parser. */
class FakeCodex implements CodexDeliveryPort {
  readonly rows = new Map<string, string>();
  readonly calls: string[] = [];
  readonly rollout_: Rollout;
  pendingUnknown = false;
  constructor(readonly threadId: string, readonly behaviour: Array<(message: string) => CodexQueueResult>,
    readonly onQueue?: (message: string) => Promise<void>) {
    this.rollout_ = new Rollout(threadId, START - 3_600_000);
  }
  async queue(threadId: string, message: string) {
    assert.equal(threadId, this.threadId);
    await this.onQueue?.(message);
    this.calls.push(message);
    const next = this.behaviour[this.calls.length - 1] ?? this.behaviour.at(-1)!;
    return next(message);
  }
  async pendingRow(_threadId: string, key: string) {
    if (this.pendingUnknown) return 'unknown' as const;
    return [...this.rows.values()].some(text => text.includes(key));
  }
  async rollout(threadId: string) { return parseCodexRollout(this.rollout_.text(), threadId); }
  commit(message: string, qid = randomUUID()) { this.rows.set(qid, message); return qid; }
  /** The loaded app takes the row and runs it as a turn. */
  drain(at: number, outcome: 'complete' | 'aborted' | 'open' = 'complete', extraUser?: string) {
    const [qid, text] = [...this.rows.entries()][0]!;
    this.rows.delete(qid);
    const turn = randomUUID();
    this.rollout_.started(at, turn).user(at + 10, turn, text);
    if (extraUser) this.rollout_.user(at + 20, turn, extraUser);
    if (outcome === 'complete') this.rollout_.assistant(at + 500, turn, 'done').complete(at + 600, turn);
    if (outcome === 'aborted') this.rollout_.aborted(at + 100, turn);
    return turn;
  }
}

const ok = (fake: () => FakeCodex) => (message: string): CodexQueueResult =>
  ({ exitCode: 0, stdout: `Queued message ${fake().commit(message)} for thread ${fake().threadId}.\n` });
const killedAfterCommit = (fake: () => FakeCodex) => (message: string): CodexQueueResult => { fake().commit(message); return { exitCode: 137, stdout: '' }; };
const killedBeforeCommit = (): CodexQueueResult => ({ exitCode: 137, stdout: '' });

async function setup(behaviour: (fake: () => FakeCodex) => Array<(message: string) => CodexQueueResult>,
  onQueue?: (home: string) => (message: string) => Promise<void>) {
  const home = await mkdtemp(join(tmpdir(), 'dharma-watch-'));
  const threadId = randomUUID();
  let clock = START;
  const platform = new Platform();
  const { privateKey } = generateKeyPairSync('ed25519');
  const deviceId = randomUUID();
  const attachment: LocalSessionAttachment = { schema: 'dharma.local-session-attachment/v1', name: 'ef', provider: 'codex',
    delivery: 'codex_queue', bindingId: randomUUID(), organizationId: ORG, deviceId, membershipId: randomUUID(), revision: 1,
    pending: false, threadId, updatedAt: new Date(START).toISOString() };
  await writeSessionStateFile(sessionStatePath(home, 'attachments', 'ef.json'), attachment);
  const host: SessionMessagingHost = { home, cwd: home, env: {}, now: () => new Date(clock),
    device: async () => ({ organizationId: ORG, deviceId, privateKey }), transport: async () => platform.transport() };
  let codex!: FakeCodex;
  codex = new FakeCodex(threadId, behaviour(() => codex), onQueue?.(home));
  const tick = (port: CodexDeliveryPort = codex) => watchCodexSessionOnce({ host, attachment, port,
    transport: platform.transport(), device: { organizationId: ORG, deviceId, privateKey } });
  return { home, threadId, platform, codex, host, attachment, tick,
    at: (ms: number) => { clock = START + ms; }, cleanup: () => rm(home, { recursive: true, force: true }) };
}

function actions(result: Awaited<ReturnType<typeof watchCodexSessionOnce>>) {
  return result.entries.map(entry => entry.action);
}

test('the rollout parser finds the framed id in a user record and the outcome of its turn', () => {
  const thread = randomUUID();
  const id = randomUUID();
  const key = sessionMessageFrameKey(id);
  const head = `${sessionMessageFrameHeaderPrefix(id)}ops-claude to session ef, sent x, new conversation.]\nbody`;
  const processed = new Rollout(thread, START).started(START + 1, 't1').user(START + 2, 't1', head)
    .assistant(START + 3, 't1', `quoting ${sessionMessageFrameHeaderPrefix(randomUUID())}`).complete(START + 4, 't1');
  const view = parseCodexRollout(processed.text(), thread);
  assert.deepEqual(view.find(key), { turnId: 't1', outcome: 'processed' });
  assert.equal(view.idleSince?.toISOString(), new Date(START + 4).toISOString());
  assert.equal(view.find(sessionMessageFrameKey(randomUUID())), null, 'an assistant quote is not a delivery');
  const other = randomUUID();
  const spoof = new Rollout(thread, START).started(START + 1, 't1')
    .user(START + 2, 't1', `${sessionMessageFrameHeaderPrefix(randomUUID())}x to session ef.]\nsee ${sessionMessageFrameKey(other)} `
      + `and ${sessionMessageFrameHeaderPrefix(other)}`).complete(START + 3, 't1');
  assert.equal(parseCodexRollout(spoof.text(), thread).find(sessionMessageFrameKey(other)), null,
    "a body naming another message's id is not that message's delivery");

  const open = new Rollout(thread, START).started(START + 1, 't1').user(START + 2, 't1', head);
  assert.deepEqual(parseCodexRollout(open.text(), thread).find(key), { turnId: 't1', outcome: null });
  assert.equal(parseCodexRollout(open.text(), thread).idleSince, null, 'an open turn means busy');

  const aborted = new Rollout(thread, START).started(START + 1, 't1').user(START + 2, 't1', head).aborted(START + 3, 't1');
  assert.equal(parseCodexRollout(aborted.text(), thread).find(key)?.outcome, 'aborted');

  const merged = new Rollout(thread, START).started(START + 1, 't1')
    .user(START + 2, 't1', '<environment_context>\n  <cwd>x</cwd>\n</environment_context>')
    .user(START + 3, 't1', head).user(START + 4, 't1', 'S1 resume probe').complete(START + 5, 't1');
  assert.equal(parseCodexRollout(merged.text(), thread).find(key)?.outcome, 'merged');

  const context = new Rollout(thread, START).started(START + 1, 't1')
    .user(START + 2, 't1', '# AGENTS.md instructions\n<INSTRUCTIONS>x</INSTRUCTIONS>').user(START + 3, 't1', head).complete(START + 4, 't1');
  assert.equal(parseCodexRollout(context.text(), thread).find(key)?.outcome, 'processed', 'context injections are not merged input');

  assert.throws(() => parseCodexRollout(processed.text(), randomUUID()), /codex_rollout_thread_mismatch/);
  assert.throws(() => parseCodexRollout('not json\n', thread), /codex_rollout_thread_mismatch/);
});

test('a normal delivery: receipt before the queue call, queue id from stdout, delivered once with the observed outcome, never an ack', async () => {
  const f = await setup(fake => [ok(fake)], home => async () => {
    const receipts = (await import('node:fs/promises')).readdir(join(home, 'session-messages', 'receipts'));
    const [name] = await receipts;
    const receipt = JSON.parse(await readFile(join(home, 'session-messages', 'receipts', name!), 'utf8'));
    assert.equal(receipt.state, 'submitting', 'the receipt is written before codex queue runs');
    assert.equal(receipt.attempts, 1);
  });
  try {
    const message = f.platform.add('N2-proto-3');
    assert.deepEqual(actions(await f.tick()), ['queued']);
    const receipt = await readSessionDeliveryReceipt(f.home, message.messageId);
    assert.equal(receipt?.state, 'queued');
    assert.match(String(receipt?.queueId), /^[0-9a-f-]{36}$/);
    assert.match(f.codex.calls[0]!, new RegExp(sessionMessageFrameKey(message.messageId)));
    assert.match(f.codex.calls[0]!, /untrusted/i);
    assert.equal(f.codex.calls[0], frameSessionMessage(message));
    assert.ok(f.codex.calls[0]!.startsWith(sessionMessageFrameHeaderPrefix(message.messageId)));
    f.at(5_000);
    assert.deepEqual(actions(await f.tick()), ['waiting'], 'a pending row is waited for, never re-queued');
    f.codex.drain(START + 6_000);
    f.at(8_000);
    assert.deepEqual(actions(await f.tick()), ['reported']);
    assert.deepEqual(f.platform.reports, [{ messageId: message.messageId, body: { channel: 'codex_queue', outcome: 'processed' } }]);
    assert.equal((await readSessionDeliveryReceipt(f.home, message.messageId))?.state, 'reported');
    f.at(20_000);
    assert.deepEqual(actions(await f.tick()), []);
    assert.equal(f.codex.calls.length, 1);
    assert.deepEqual(f.platform.acks, []);
  } finally { await f.cleanup(); }
});

test('exit code lost but stdout ACK kept (S1 q12): stdout wins and nothing is retried', async () => {
  const f = await setup(fake => [message => ({ ...ok(fake)(message), exitCode: 137 })]);
  try {
    f.platform.add('q12');
    assert.deepEqual(actions(await f.tick()), ['queued']);
    for (const ms of [5_000, 21_000, 40_000]) { f.at(ms); assert.deepEqual(actions(await f.tick()), ['waiting']); }
    assert.equal(f.codex.calls.length, 1);
  } finally { await f.cleanup(); }
});

test('MANDATORY (S1 6.4, in-memory): row committed, no stdout, exit 137, then restart: one queue call, one delivery', async () => {
  const f = await setup(fake => [killedAfterCommit(fake)]);
  try {
    const message = f.platform.add('lost ack');
    assert.deepEqual(actions(await f.tick()), ['submitted_unconfirmed']);
    assert.equal((await readSessionDeliveryReceipt(f.home, message.messageId))?.state, 'submitting');
    f.at(5_000);
    assert.deepEqual(actions(await f.tick()), ['waiting'], 'the pending row is found: wait, never queue again');
    f.at(30_000);
    assert.deepEqual(actions(await f.tick()), ['waiting']);
    f.codex.drain(START + 31_000);
    f.at(33_000);
    assert.deepEqual(actions(await f.tick()), ['reported']);
    assert.equal(f.codex.calls.length, 1);
    assert.equal(f.platform.reports.length, 1);
    assert.deepEqual(f.platform.acks, []);
  } finally { await f.cleanup(); }
});

test('no trace after exit 137: one retry only after two empty reads at least 15 s apart', async () => {
  const f = await setup(fake => [killedBeforeCommit, ok(fake)]);
  try {
    f.platform.add('no trace');
    assert.deepEqual(actions(await f.tick()), ['submitted_unconfirmed']);
    f.at(5_000);
    assert.deepEqual(actions(await f.tick()), ['reconciling']);
    f.at(12_000);
    assert.deepEqual(actions(await f.tick()), ['reconciling'], 'two reads 7 s apart are not enough');
    assert.equal(f.codex.calls.length, 1);
    f.at(21_000);
    assert.deepEqual(actions(await f.tick()), ['queued'], 'reads at 5 s and 21 s are 16 s apart: one retry');
    assert.equal(f.codex.calls.length, 2);
    f.codex.drain(START + 25_000);
    f.at(27_000);
    assert.deepEqual(actions(await f.tick()), ['reported']);
    assert.equal(f.platform.reports.length, 1);
  } finally { await f.cleanup(); }
});

test('two attempts without any trace end in uncertain, with no third queue call', async () => {
  const f = await setup(() => [killedBeforeCommit]);
  try {
    const message = f.platform.add('never');
    await f.tick();
    for (const ms of [5_000, 21_000]) { f.at(ms); await f.tick(); }
    assert.equal(f.codex.calls.length, 2);
    for (const ms of [26_000, 42_000]) { f.at(ms); await f.tick(); }
    const receipt = await readSessionDeliveryReceipt(f.home, message.messageId);
    assert.equal(receipt?.state, 'uncertain');
    f.at(100_000);
    assert.deepEqual(actions(await f.tick()), ['uncertain']);
    assert.equal(f.codex.calls.length, 2);
    assert.deepEqual(f.platform.reports, []);
  } finally { await f.cleanup(); }
});

test('queued_not_loaded only after 60 s of rollout-idle with the row pending; a busy thread is never flagged', async () => {
  const idle = await setup(fake => [ok(fake)]);
  try {
    const message = idle.platform.add('nobody loaded it');
    await idle.tick();
    idle.at(30_000);
    assert.deepEqual(actions(await idle.tick()), ['waiting']);
    idle.at(61_000);
    assert.deepEqual(actions(await idle.tick()), ['queued_not_loaded']);
    assert.ok((await readSessionDeliveryReceipt(idle.home, message.messageId))?.queuedNotLoadedAt);
    idle.at(200_000);
    await idle.tick();
    assert.equal(idle.codex.calls.length, 1, 'never re-queued');
  } finally { await idle.cleanup(); }
  const busy = await setup(fake => [ok(fake)]);
  try {
    busy.codex.rollout_.started(START - 1_000, 'long-turn');
    busy.platform.add('thread is busy');
    await busy.tick();
    for (const ms of [61_000, 150_000]) { busy.at(ms); assert.deepEqual(actions(await busy.tick()), ['waiting']); }
    busy.codex.rollout_.complete(START + 151_000, 'long-turn');
    busy.at(170_000);
    assert.deepEqual(actions(await busy.tick()), ['waiting'], 'idle time counts from the last turn end');
    busy.at(212_000);
    assert.deepEqual(actions(await busy.tick()), ['queued_not_loaded']);
  } finally { await busy.cleanup(); }
});

test('aborted, merged and still-open turns: delivered is reported only with an observed outcome', async () => {
  for (const [shape, expected] of [['aborted', 'aborted'], ['merged', 'merged']] as const) {
    const f = await setup(fake => [ok(fake)]);
    try {
      f.platform.add(shape);
      await f.tick();
      if (shape === 'aborted') f.codex.drain(START + 1_000, 'aborted');
      else f.codex.drain(START + 1_000, 'complete', 'another user prompt in the same turn');
      f.at(3_000);
      assert.deepEqual(actions(await f.tick()), ['reported']);
      assert.deepEqual(f.platform.reports[0]!.body, { channel: 'codex_queue', outcome: expected });
    } finally { await f.cleanup(); }
  }
  const f = await setup(fake => [ok(fake)]);
  try {
    f.platform.add('long answer');
    await f.tick();
    const turn = f.codex.drain(START + 1_000, 'open');
    f.at(3_000);
    assert.deepEqual(actions(await f.tick()), ['observed_turn_open']);
    assert.deepEqual(f.platform.reports, []);
    f.codex.rollout_.complete(START + 4_000, turn);
    f.at(5_000);
    assert.deepEqual(actions(await f.tick()), ['reported']);
    assert.equal(f.codex.calls.length, 1);
  } finally { await f.cleanup(); }
});

test('an unreadable queue table fails closed: no queue call without evidence', async () => {
  const f = await setup(fake => [ok(fake)]);
  try {
    f.codex.pendingUnknown = true;
    f.platform.add('x');
    assert.deepEqual(actions(await f.tick()), ['waiting']);
    assert.equal(f.codex.calls.length, 0);
  } finally { await f.cleanup(); }
});

test('MANDATORY (S1 6.4, real receipt file and process runner): fake codex commits the row, prints nothing, exits 137', async () => {
  const f = await setup(() => [killedBeforeCommit]);
  const codexHome = join(f.home, 'codex-home');
  const sessions = join(codexHome, 'sessions', '2026', '11', '10');
  await mkdir(sessions, { recursive: true });
  const database = join(codexHome, 'queue_1.sqlite');
  const db = new DatabaseSync(database);
  db.exec('CREATE TABLE queued_items (id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, payload_json TEXT NOT NULL, '
    + 'queue_order INTEGER NOT NULL, created_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL)');
  db.close();
  const rolloutPath = join(sessions, `rollout-2026-11-10T04-00-00-${f.threadId}.jsonl`);
  const rollout = new Rollout(f.threadId, START - 3_600_000);
  await writeFile(rolloutPath, rollout.text());
  const callLog = join(f.home, 'fake-codex-calls.log');
  const script = join(f.home, 'fake-codex.mjs');
  await writeFile(script, [
    "import { appendFileSync } from 'node:fs';",
    "import { randomUUID } from 'node:crypto';",
    "import { DatabaseSync } from 'node:sqlite';",
    'const args = process.argv.slice(2);',
    "if (args[0] !== 'queue' || args[1] !== '--thread' || args[3] !== '--message' || args.length !== 5) process.exit(2);",
    `appendFileSync(${JSON.stringify(callLog)}, JSON.stringify(args) + '\\n');`,
    `const db = new DatabaseSync(${JSON.stringify(database)});`,
    "db.prepare('INSERT INTO queued_items VALUES (?, ?, ?, 1, 0, 0)').run(randomUUID(), args[2],",
    "  JSON.stringify({ UserInput: { content: [{ type: 'text', text: args[4] }] } }));",
    'db.close();',
    'process.exit(137);',
  ].join('\n'));
  const port = () => createCodexDeliveryPort({ codexHome, codexCommand: { file: process.execPath, args: [script] } });
  try {
    const message = f.platform.add('real runner, lost ack');
    assert.deepEqual(actions(await f.tick(port())), ['submitted_unconfirmed']);
    assert.equal((await readSessionDeliveryReceipt(f.home, message.messageId))?.state, 'submitting');
    // Restart: a new port and a new tick read only the durable receipt, the queue table and the rollout.
    f.at(5_000);
    const restarted = port();
    assert.deepEqual(actions(await f.tick(restarted)), ['waiting']);
    f.at(25_000);
    assert.deepEqual(actions(await f.tick(restarted)), ['waiting']);
    const reader = new DatabaseSync(database);
    const row = reader.prepare('SELECT id, payload_json FROM queued_items').get() as { id: string; payload_json: string };
    reader.prepare('DELETE FROM queued_items WHERE id = ?').run(row.id);
    reader.close();
    const text = (JSON.parse(row.payload_json) as { UserInput: { content: Array<{ text: string }> } }).UserInput.content[0]!.text;
    const drained = new Rollout(f.threadId, START).started(START + 26_000, 'turn-1').user(START + 26_010, 'turn-1', text)
      .assistant(START + 27_000, 'turn-1', 'ok').complete(START + 27_100, 'turn-1');
    await appendFile(rolloutPath, drained.lines.slice(1).map(line => `${line}\n`).join(''));
    f.at(30_000);
    assert.deepEqual(actions(await f.tick(restarted)), ['reported']);
    f.at(45_000);
    assert.deepEqual(actions(await f.tick(port())), []);
    assert.equal((await readFile(callLog, 'utf8')).trim().split('\n').length, 1, 'exactly one codex queue call');
    assert.deepEqual(f.platform.reports, [{ messageId: message.messageId, body: { channel: 'codex_queue', outcome: 'processed' } }]);
    assert.deepEqual(f.platform.acks, []);
  } finally { await f.cleanup(); }
});

test('watch needs --provider codex, a codex attachment and the explicit wake consent', async () => {
  const f = await setup(fake => [ok(fake)]);
  try {
    const run = (entries: Array<[string, string | boolean]>) => sessionWatchCommand(new Map(entries), f.host, () => f.codex);
    await assert.rejects(run([['provider', 'codex'], ['once', true]]), /session_watch_wake_consent_required/);
    await assert.rejects(run([['provider', 'claude'], ['allow-wake', true], ['once', true]]), /session_watch_options_invalid/);
    await assert.rejects(run([['provider', 'codex'], ['allow-wake', 'yes'], ['once', true]]), /session_watch_options_invalid/);
    await assert.rejects(run([['provider', 'codex'], ['allow-wake', true], ['once', true], ['exec-resume', true]]),
      /session_watch_options_invalid/);
    f.platform.add('via command');
    const result = await run([['provider', 'codex'], ['allow-wake', true], ['once', true]]);
    assert.equal(result.ok, true);
    assert.equal(result.name, 'ef');
    assert.match(String(result.consent), /starts a turn/);
    assert.deepEqual((result.entries as Array<{ action: string }>).map(entry => entry.action), ['queued']);
  } finally { await f.cleanup(); }
});
