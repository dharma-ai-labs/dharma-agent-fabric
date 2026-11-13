import assert from 'node:assert/strict';
import { createPublicKey, generateKeyPairSync, randomUUID, type KeyObject } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  advanceSessionMessageDelivery,
  classifySessionMessageSubmission,
  sha256,
  verifySessionMessage,
  verifySessionMessageReply,
  SESSION_MESSAGE_MAX_LIFETIME_MS,
  type ProviderSessionRegistrationV2,
  type SessionMessage,
  type SessionMessageDeliveryStatus,
} from '@dharma-ai-labs/agent-fabric-contracts';
import { readReceivedSessionMessage, sessionMessageCommand } from './sessionMessageCommands.js';
import { sessionNamesCommand, type SessionMessageTransport, type SessionMessagingHost } from './sessionNames.js';

const ORG = 'org-hq';
const httpError = (message: string, status: number) => Object.assign(new Error(message), { status, definitive: true });

/** In-memory stand-in for the P1p/P2p routes, enforcing the frozen contract on the server side. */
class FakePlatform {
  readonly names = new Map<string, { membershipId: string; deviceId: string; publicKey: KeyObject }>();
  readonly devices = new Map<string, { membershipId: string; publicKey: KeyObject }>();
  readonly messages = new Map<string, { envelope: SessionMessage; replyToken: string; delivery: SessionMessageDeliveryStatus }>();
  readonly consumed = new Set<string>();
  readonly calls: Array<{ deviceId: string; method: string; route: string; body?: unknown }> = [];
  /** Message ids whose `delivered` report fails with a lost response (uncertain) and does not take effect. */
  readonly failDelivered = new Set<string>();

  resolver = (membershipId: string, deviceId: string, senderName: string) => {
    const name = this.names.get(senderName);
    return name && name.membershipId === membershipId && name.deviceId === deviceId ? name.publicKey : null;
  };

  record(id: string) {
    const stored = this.messages.get(id);
    if (!stored) throw httpError('session_message_not_found', 404);
    return { schema: 'dharma.session-message-delivery/v1', organizationId: ORG, messageId: id,
      recipientName: stored.envelope.recipient.name, ...stored.delivery, updatedAt: '2026-11-10T10:00:00.000Z' };
  }

  transportFor(deviceId: string): SessionMessageTransport {
    const device = this.devices.get(deviceId)!;
    return {
      signedGet: async route => {
        this.calls.push({ deviceId, method: 'GET', route });
        const id = /^\/agent-fabric\/session-messages\/([^/]+)\/delivery$/.exec(route)?.[1];
        if (id) return this.record(id);
        throw httpError('route_not_found', 404);
      },
      signedPost: async (route, raw) => {
        const body = JSON.parse(JSON.stringify(raw)) as Record<string, unknown>;
        this.calls.push({ deviceId, method: 'POST', route, body });
        if (route === '/agent-fabric/session-names/attach') {
          const request = body as unknown as ProviderSessionRegistrationV2;
          this.names.set(request.name, { membershipId: device.membershipId, deviceId, publicKey: device.publicKey });
          return { schema: 'dharma.provider-session-registration-receipt/v2', organizationId: ORG, bindingId: request.bindingId,
            name: request.name, provider: request.provider, delivery: request.delivery, mode: 'cooperative',
            membershipId: device.membershipId, deviceId, state: 'active', revision: request.expectedRevision + 1,
            replay: false, updatedAt: '2026-11-10T10:00:00.000Z' };
        }
        if (route === '/agent-fabric/session-messages') {
          const envelope = body.envelope as SessionMessage;
          const verified = verifySessionMessage(envelope, { organizationId: ORG, resolveDevicePublicKey: this.resolver });
          if (!verified.ok) throw httpError(`session_message_refused:${verified.reason}`, 400);
          if (envelope.sender.deviceId !== deviceId) throw httpError('session_message_sender_device_mismatch', 403);
          if (!this.names.has(envelope.recipient.name)) throw httpError('session_not_found', 404);
          if (sha256(String(body.replyToken)) !== envelope.replyTokenHash) throw httpError('reply_token_invalid', 400);
          const existing = this.messages.get(envelope.messageId);
          const kind = classifySessionMessageSubmission(existing?.envelope ?? null, envelope);
          if (kind === 'conflict') throw httpError('session_message_conflict', 409);
          if (kind === 'new') this.messages.set(envelope.messageId, { envelope, replyToken: String(body.replyToken),
            delivery: advanceSessionMessageDelivery(null, { actor: 'platform', state: 'queued' }) });
          return { delivery: this.record(envelope.messageId), replay: kind === 'replay' };
        }
        if (route === '/agent-fabric/session-messages/poll') {
          const recipient = this.names.get(String(body.recipientName));
          if (!recipient || recipient.deviceId !== deviceId) throw httpError('session_not_found', 404);
          // The P2p poll's real shape (S-2): the 20 oldest `queued`, then the 20 newest `delivered` whose reply token
          // is unused, so the recipient can still reply to them. A delivered item is not a new delivery.
          const mine = [...this.messages.values()].filter(item => item.envelope.recipient.name === body.recipientName);
          const queued = mine.filter(item => item.delivery.state === 'queued').slice(0, 20);
          const delivered = mine.filter(item => item.delivery.state === 'delivered').reverse().slice(0, 20);
          return { messages: [...queued, ...delivered].slice(0, Number(body.limit ?? 20))
            .map(item => {
              const sender = this.names.get(item.envelope.sender.name)!;
              return { envelope: item.envelope, replyToken: item.replyToken,
                sender: { membershipId: sender.membershipId, deviceId: sender.deviceId, name: item.envelope.sender.name,
                  publicKeyEd25519: sender.publicKey.export({ format: 'jwk' }).x },
                delivery: item.delivery };
            }) };
        }
        const match = /^\/agent-fabric\/session-messages\/([^/]+)\/(delivered|ack|reply)$/.exec(route);
        const stored = match && this.messages.get(match[1]!);
        if (!match || !stored) throw httpError('session_message_not_found', 404);
        const recipient = this.names.get(stored.envelope.recipient.name)!;
        if (recipient.deviceId !== deviceId) throw httpError('session_message_not_found', 404);
        if (match[2] === 'delivered') {
          if (this.failDelivered.has(match[1]!)) throw new Error('fetch failed');
          stored.delivery = advanceSessionMessageDelivery(stored.delivery, body.channel === 'manual_pull'
            ? { actor: 'recipient', state: 'delivered', channel: 'manual_pull' }
            : { actor: 'deliverer', state: 'delivered', channel: body.channel as 'codex_queue', outcome: body.outcome as 'processed' });
          return this.record(match[1]!);
        }
        if (match[2] === 'ack') {
          stored.delivery = advanceSessionMessageDelivery(stored.delivery, { actor: 'recipient', state: 'acknowledged' });
          return this.record(match[1]!);
        }
        const reply = body.envelope as SessionMessage;
        const verified = await verifySessionMessageReply(reply, { organizationId: ORG, resolveDevicePublicKey: this.resolver,
          original: stored.envelope, replyToken: String(body.replyToken), ledger: { consume: async (id, hash) => {
            const key = `${id}:${hash}`; if (this.consumed.has(key)) return false; this.consumed.add(key); return true;
          } } });
        if (!verified.ok) throw httpError(`session_reply_refused:${verified.reason}`, 400);
        stored.delivery = advanceSessionMessageDelivery(stored.delivery, { actor: 'recipient', state: 'acknowledged' });
        this.messages.set(reply.messageId, { envelope: reply, replyToken: String(body.nextReplyToken),
          delivery: advanceSessionMessageDelivery(null, { actor: 'platform', state: 'queued' }) });
        return this.record(reply.messageId);
      },
    };
  }
}

async function member(platform: FakePlatform, name: string, provider: 'codex' | 'claude') {
  const home = await mkdtemp(join(tmpdir(), `dharma-msg-${name}-`));
  const deviceId = randomUUID();
  const membershipId = randomUUID();
  const { privateKey } = generateKeyPairSync('ed25519');
  platform.devices.set(deviceId, { membershipId, publicKey: createPublicKey(privateKey) });
  const sessionId = randomUUID();
  const host: SessionMessagingHost = {
    home, cwd: home, env: provider === 'claude' ? { DHARMA_CLAUDE_SESSION_ID: sessionId } : {},
    now: () => new Date(Date.now()),
    device: async () => ({ organizationId: ORG, deviceId, privateKey }),
    transport: async () => platform.transportFor(deviceId),
  };
  if (provider === 'claude') {
    const { recordClaudeSessionStart } = await import('./sessionNames.js');
    await recordClaudeSessionStart(home, { sessionId, cwd: home, at: new Date().toISOString() });
  }
  await sessionNamesCommand('attach', new Map<string, string | boolean>([['provider', provider],
    ...(provider === 'codex' ? [['thread', randomUUID()] as [string, string]] : [['current', true] as [string, boolean]]),
    ['name', name], ['yes', true]]), host);
  return { home, host, deviceId, membershipId, privateKey, cleanup: () => rm(home, { recursive: true, force: true }) };
}

const cmd = (entries: Array<[string, string | boolean]>) => new Map(entries);

test('send signs a contract-valid envelope from the attached sender name; the raw token stays out of it', async () => {
  const platform = new FakePlatform();
  const a = await member(platform, 'ef', 'codex');
  const b = await member(platform, 'ops-claude', 'claude');
  try {
    const sent = await sessionMessageCommand('send', cmd([['to', 'ops-claude'], ['body', 'N2-proto-1']]), a.host);
    assert.equal(sent.ok, true);
    assert.equal(sent.state, 'queued');
    assert.equal(sent.from, 'ef');
    assert.equal(sent.to, 'ops-claude');
    const stored = platform.messages.get(String(sent.messageId))!;
    assert.equal(stored.envelope.sender.name, 'ef');
    assert.equal(stored.envelope.sender.membershipId, a.membershipId);
    assert.equal(stored.envelope.sender.deviceId, a.deviceId);
    assert.equal(stored.envelope.replyTo, null);
    assert.equal(Date.parse(stored.envelope.expiresAt) - Date.parse(stored.envelope.createdAt), SESSION_MESSAGE_MAX_LIFETIME_MS);
    assert.ok(!JSON.stringify(stored.envelope).includes(stored.replyToken));
    assert.ok(!JSON.stringify(sent).includes(stored.replyToken), 'the raw token is never printed');
  } finally { await a.cleanup(); await b.cleanup(); }
});

test('send needs exactly one local sender name, or --from naming one', async () => {
  const platform = new FakePlatform();
  const a = await member(platform, 'ef', 'codex');
  const b = await member(platform, 'ops-claude', 'claude');
  try {
    await sessionNamesCommand('attach', cmd([['provider', 'codex'], ['thread', randomUUID()], ['name', 'ef-two'], ['yes', true]]), a.host);
    await assert.rejects(sessionMessageCommand('send', cmd([['to', 'ops-claude'], ['body', 'x']]), a.host), /session_message_sender_ambiguous/);
    await assert.rejects(sessionMessageCommand('send', cmd([['to', 'ops-claude'], ['body', 'x'], ['from', 'nope']]), a.host),
      /session_message_sender_unattached/);
    const sent = await sessionMessageCommand('send', cmd([['to', 'ops-claude'], ['body', 'x'], ['from', 'ef-two']]), a.host);
    assert.equal(sent.from, 'ef-two');
    for (const entries of [[['body', 'x']], [['to', 'ops-claude']], [['to', 'ops-claude'], ['body', '']],
      [['to', 'Ops'], ['body', 'x']], [['to', 'ops-claude'], ['body', 'x'], ['extra', true]]] as Array<Array<[string, string | boolean]>>) {
      await assert.rejects(sessionMessageCommand('send', cmd(entries), a.host), /session_message_options_invalid/, JSON.stringify(entries));
    }
    const empty = await mkdtemp(join(tmpdir(), 'dharma-msg-none-'));
    try {
      await assert.rejects(sessionMessageCommand('send', cmd([['to', 'ops-claude'], ['body', 'x']]), { ...a.host, home: empty }),
        /session_message_sender_unattached/);
    } finally { await rm(empty, { recursive: true, force: true }); }
  } finally { await a.cleanup(); await b.cleanup(); }
});

test('inbox is a manual pull: verified messages are recorded delivered via manual_pull, framed and shown', async () => {
  const platform = new FakePlatform();
  const a = await member(platform, 'ef', 'codex');
  const b = await member(platform, 'ops-claude', 'claude');
  try {
    const sent = await sessionMessageCommand('send', cmd([['to', 'ops-claude'], ['body', 'N2-proto-2']]), a.host);
    const inbox = await sessionMessageCommand('inbox', cmd([]), b.host);
    assert.equal(inbox.channel, 'manual_pull');
    assert.equal(inbox.name, 'ops-claude');
    const messages = inbox.messages as Array<Record<string, unknown>>;
    assert.equal(messages.length, 1);
    assert.equal(messages[0]!.messageId, sent.messageId);
    assert.equal(messages[0]!.from, 'ef');
    assert.match(String(messages[0]!.frame), /untrusted/i);
    assert.match(String(messages[0]!.frame), /N2-proto-2/);
    assert.deepEqual(platform.messages.get(String(sent.messageId))!.delivery, { state: 'delivered', channel: 'manual_pull' });
    assert.ok(!JSON.stringify(inbox).includes(platform.messages.get(String(sent.messageId))!.replyToken));
    const received = await readReceivedSessionMessage(b.home, String(sent.messageId));
    assert.equal(received?.envelope.messageId, sent.messageId);
    assert.equal(typeof received?.replyToken, 'string');
    const posts = () => platform.calls.filter(call => call.route.endsWith('/delivered')).length;
    const before = posts();
    const again = await sessionMessageCommand('inbox', cmd([]), b.host);
    const relisted = again.messages as Array<Record<string, unknown>>;
    assert.deepEqual(relisted.map(item => [item.messageId, item.delivery]), [[sent.messageId, 'already_delivered']],
      'a delivered, unreplied message is listed again, marked delivered (S-2)');
    assert.equal(posts(), before, 'and is not reported delivered a second time');
  } finally { await a.cleanup(); await b.cleanup(); }
});

test('the deliverer view of a poll keeps only queued messages: a delivered, unreplied one is never handed out again (S-2)', async () => {
  const platform = new FakePlatform();
  const a = await member(platform, 'ef', 'codex');
  const b = await member(platform, 'ops-claude', 'claude');
  try {
    const { receiveSessionMessages } = await import('./sessionMessageCommands.js');
    const { readSessionAttachment } = await import('./sessionNames.js');
    const pulled = await sessionMessageCommand('send', cmd([['to', 'ops-claude'], ['body', 'pulled by hand']]), a.host);
    await sessionMessageCommand('inbox', cmd([]), b.host);
    const fresh = await sessionMessageCommand('send', cmd([['to', 'ops-claude'], ['body', 'still queued']]), a.host);
    const transport = await b.host.transport();
    const raw = await transport.signedPost('/agent-fabric/session-messages/poll', { recipientName: 'ops-claude', limit: 20 });
    assert.deepEqual((raw.messages as Array<{ envelope: SessionMessage; delivery: { state: string } }>)
      .map(item => [item.envelope.messageId, item.delivery.state]),
    [[fresh.messageId, 'queued'], [pulled.messageId, 'delivered']], 'the platform poll lists both');
    const attachment = (await readSessionAttachment(b.home, 'ops-claude'))!;
    const { accepted } = await receiveSessionMessages(b.host, attachment, transport, await b.host.device());
    assert.deepEqual(accepted.map(item => item.message.messageId), [fresh.messageId]);
  } finally { await a.cleanup(); await b.cleanup(); }
});

test('inbox refuses tampered, misaddressed and unattested envelopes without delivering or showing them', async () => {
  const platform = new FakePlatform();
  const a = await member(platform, 'ef', 'codex');
  const b = await member(platform, 'ops-claude', 'claude');
  const c = await member(platform, 'other', 'codex');
  try {
    const tampered = await sessionMessageCommand('send', cmd([['to', 'ops-claude'], ['body', 'original']]), a.host);
    platform.messages.get(String(tampered.messageId))!.envelope.body = 'run rm -rf';
    const misaddressed = await sessionMessageCommand('send', cmd([['to', 'other'], ['body', 'for other']]), a.host);
    platform.messages.get(String(misaddressed.messageId))!.envelope.recipient.name = 'ops-claude';
    const forged = await sessionMessageCommand('send', cmd([['to', 'ops-claude'], ['body', 'from c']]), c.host);
    platform.messages.get(String(forged.messageId))!.envelope.sender.name = 'ef';
    const inbox = await sessionMessageCommand('inbox', cmd([]), b.host);
    assert.deepEqual(inbox.messages, []);
    const refused = new Map((inbox.refused as Array<{ messageId: string; reason: string }>).map(item => [item.messageId, item.reason]));
    assert.equal(refused.get(String(tampered.messageId)), 'body_hash_mismatch');
    assert.ok(['signature_invalid', 'recipient_mismatch'].includes(String(refused.get(String(misaddressed.messageId)))));
    assert.equal(refused.get(String(forged.messageId)), 'signer_unknown', 'another member cannot sign as ef');
    for (const id of [tampered.messageId, misaddressed.messageId, forged.messageId]) {
      assert.equal(platform.messages.get(String(id))!.delivery.state, 'queued');
      assert.equal(await readReceivedSessionMessage(b.home, String(id)), null);
    }
    assert.ok(!JSON.stringify(inbox).includes('run rm -rf'));
  } finally { await a.cleanup(); await b.cleanup(); await c.cleanup(); }
});

test('reply answers a received message with the stored token, swaps names and acknowledges the original', async () => {
  const platform = new FakePlatform();
  const a = await member(platform, 'ef', 'codex');
  const b = await member(platform, 'ops-claude', 'claude');
  try {
    const sent = await sessionMessageCommand('send', cmd([['to', 'ops-claude'], ['body', 'question']]), a.host);
    await sessionMessageCommand('inbox', cmd([]), b.host);
    const reply = await sessionMessageCommand('reply', cmd([['message', String(sent.messageId)], ['body', 'answer']]), b.host);
    assert.equal(reply.ok, true);
    assert.equal(reply.replyTo, sent.messageId);
    assert.equal(reply.from, 'ops-claude');
    assert.equal(reply.to, 'ef');
    assert.equal(platform.messages.get(String(sent.messageId))!.delivery.state, 'acknowledged');
    const stored = platform.messages.get(String(reply.messageId))!;
    assert.equal(stored.envelope.replyTo, sent.messageId);
    assert.equal(stored.envelope.sender.name, 'ops-claude');
    assert.equal(stored.envelope.recipient.name, 'ef');
    await assert.rejects(sessionMessageCommand('reply', cmd([['message', String(sent.messageId)], ['body', 'again']]), b.host),
      /reply_token_reused/);
    const inboxA = await sessionMessageCommand('inbox', cmd([]), a.host);
    const messages = inboxA.messages as Array<Record<string, unknown>>;
    assert.equal(messages.length, 1);
    assert.equal(messages[0]!.replyTo, sent.messageId);
    await assert.rejects(sessionMessageCommand('reply', cmd([['message', randomUUID()], ['body', 'x']]), b.host),
      /session_message_not_received/);
  } finally { await a.cleanup(); await b.cleanup(); }
});

test('ack is the recipient acknowledging a received message', async () => {
  const platform = new FakePlatform();
  const a = await member(platform, 'ef', 'codex');
  const b = await member(platform, 'ops-claude', 'claude');
  try {
    const sent = await sessionMessageCommand('send', cmd([['to', 'ops-claude'], ['body', 'fyi']]), a.host);
    await sessionMessageCommand('inbox', cmd([]), b.host);
    const ack = await sessionMessageCommand('ack', cmd([['message', String(sent.messageId)]]), b.host);
    assert.equal(ack.state, 'acknowledged');
    assert.equal(platform.messages.get(String(sent.messageId))!.delivery.state, 'acknowledged');
    await assert.rejects(sessionMessageCommand('ack', cmd([['message', randomUUID()]]), b.host), /session_message_not_received/);
    await assert.rejects(sessionMessageCommand('nope', cmd([]), b.host), /session_message_command_invalid/);
  } finally { await a.cleanup(); await b.cleanup(); }
});

const deviceless = (host: SessionMessagingHost): SessionMessagingHost => ({ ...host,
  device: async () => { throw new Error('device_read_in_dry_run'); },
  transport: async () => { throw new Error('network_in_dry_run'); } });

test('inbox shows every message whose manual_pull report succeeded when a later report fails (F3)', async () => {
  const platform = new FakePlatform();
  const a = await member(platform, 'ef', 'codex');
  const b = await member(platform, 'ops-claude', 'claude');
  try {
    const ids: string[] = [];
    for (const body of ['one', 'two', 'three']) {
      ids.push(String((await sessionMessageCommand('send', cmd([['to', 'ops-claude'], ['body', body]]), a.host)).messageId));
    }
    const failing = ids[1]!;
    platform.failDelivered.add(failing);
    const inbox = await sessionMessageCommand('inbox', cmd([]), b.host);
    const shown = (inbox.messages as Array<Record<string, unknown>>).map(item => item.messageId);
    assert.deepEqual([...shown].sort(), [ids[0], ids[2]].sort(), 'messages already recorded delivered are shown');
    assert.deepEqual((inbox.reportFailed as Array<{ messageId: string }>).map(item => item.messageId), [failing]);
    assert.ok(!JSON.stringify(inbox.reportFailed).includes('two'), 'a message whose report failed is not shown');
    assert.equal(platform.messages.get(failing)!.delivery.state, 'queued');
    platform.failDelivered.clear();
    const again = await sessionMessageCommand('inbox', cmd([]), b.host);
    const listed = new Map((again.messages as Array<Record<string, unknown>>).map(item => [item.messageId, item.delivery]));
    assert.equal(listed.get(failing), 'reported', 'the message whose report failed is delivered now');
    assert.equal(listed.get(ids[0]), 'already_delivered');
    assert.equal(listed.get(ids[2]), 'already_delivered');
  } finally { await a.cleanup(); await b.cleanup(); }
});

test('reply and ack sent while the delivering turn is open are parked locally and posted after delivered (F1)', async () => {
  const platform = new FakePlatform();
  const a = await member(platform, 'ops-claude', 'claude');
  const b = await member(platform, 'ef', 'codex');
  try {
    const { flushSessionOutbox, receiveSessionMessages, reportReceivedDelivery } = await import('./sessionMessageCommands.js');
    const { readSessionAttachment } = await import('./sessionNames.js');
    const question = await sessionMessageCommand('send', cmd([['to', 'ef'], ['body', 'question']]), a.host);
    const fyi = await sessionMessageCommand('send', cmd([['to', 'ef'], ['body', 'fyi']]), a.host);
    const attachment = (await readSessionAttachment(b.home, 'ef'))!;
    const transport = await b.host.transport();
    // What the watcher does before codex queue: receive and keep locally; the platform still says queued.
    await receiveSessionMessages(b.host, attachment, transport, await b.host.device());
    const reply = await sessionMessageCommand('reply', cmd([['message', String(question.messageId)], ['body', 'answer']]), b.host);
    assert.equal(reply.state, 'parked');
    const ack = await sessionMessageCommand('ack', cmd([['message', String(fyi.messageId)]]), b.host);
    assert.equal(ack.state, 'parked');
    assert.equal(platform.messages.get(String(question.messageId))!.delivery.state, 'queued');
    assert.equal(platform.messages.has(String(reply.messageId)), false, 'nothing is posted while the message is queued');
    assert.equal(platform.calls.filter(call => /\/(reply|ack)$/.test(call.route)).length, 0);
    assert.deepEqual(await flushSessionOutbox(b.home, transport), [
      { messageId: String(fyi.messageId), action: 'parked' }, { messageId: String(question.messageId), action: 'parked' },
    ].sort((x, y) => x.messageId.localeCompare(y.messageId)));
    // The watcher's delivered report after the turn ends posts the parked request right away.
    assert.equal(await reportReceivedDelivery(transport, String(question.messageId), { channel: 'codex_queue', outcome: 'processed' },
      b.home), 'reported');
    assert.equal(platform.messages.get(String(question.messageId))!.delivery.state, 'acknowledged');
    assert.equal(platform.messages.get(String(reply.messageId))!.envelope.replyTo, question.messageId);
    assert.equal(await reportReceivedDelivery(transport, String(fyi.messageId), { channel: 'codex_queue', outcome: 'processed' },
      b.home), 'reported');
    assert.equal(platform.messages.get(String(fyi.messageId))!.delivery.state, 'acknowledged');
    assert.deepEqual(await flushSessionOutbox(b.home, transport), [], 'the outbox is empty once posted');
    const inboxA = await sessionMessageCommand('inbox', cmd([]), a.host);
    assert.deepEqual((inboxA.messages as Array<Record<string, unknown>>).map(item => item.replyTo), [question.messageId]);
  } finally { await a.cleanup(); await b.cleanup(); }
});

test('a second reply or ack while one is parked for the same message is refused; the parked reply is posted after delivered (R2)', async () => {
  const platform = new FakePlatform();
  const a = await member(platform, 'ops-claude', 'claude');
  const b = await member(platform, 'ef', 'codex');
  try {
    const { receiveSessionMessages, reportReceivedDelivery } = await import('./sessionMessageCommands.js');
    const { readSessionAttachment } = await import('./sessionNames.js');
    const question = await sessionMessageCommand('send', cmd([['to', 'ef'], ['body', 'question']]), a.host);
    const attachment = (await readSessionAttachment(b.home, 'ef'))!;
    const transport = await b.host.transport();
    await receiveSessionMessages(b.host, attachment, transport, await b.host.device());
    const reply = await sessionMessageCommand('reply', cmd([['message', String(question.messageId)], ['body', 'answer']]), b.host);
    assert.equal(reply.state, 'parked');
    await assert.rejects(sessionMessageCommand('ack', cmd([['message', String(question.messageId)]]), b.host),
      /session_parked_request_exists/);
    await assert.rejects(sessionMessageCommand('reply', cmd([['message', String(question.messageId)], ['body', 'again']]), b.host),
      /session_parked_request_exists/);
    assert.equal(await reportReceivedDelivery(transport, String(question.messageId), { channel: 'codex_queue', outcome: 'processed' },
      b.home), 'reported');
    assert.equal(platform.messages.get(String(reply.messageId))?.envelope.replyTo, question.messageId,
      'the first parked reply is the one posted');
    assert.equal(platform.messages.get(String(question.messageId))!.delivery.state, 'acknowledged');
  } finally { await a.cleanup(); await b.cleanup(); }
});

test('reply and ack are posted at once when the message is already delivered; nothing is parked', async () => {
  const platform = new FakePlatform();
  const a = await member(platform, 'ef', 'codex');
  const b = await member(platform, 'ops-claude', 'claude');
  try {
    const { flushSessionOutbox } = await import('./sessionMessageCommands.js');
    const sent = await sessionMessageCommand('send', cmd([['to', 'ops-claude'], ['body', 'q']]), a.host);
    await sessionMessageCommand('inbox', cmd([]), b.host);
    const reply = await sessionMessageCommand('reply', cmd([['message', String(sent.messageId)], ['body', 'a']]), b.host);
    assert.equal(reply.state, 'queued', 'the reply itself is queued for ef');
    assert.equal(platform.messages.get(String(sent.messageId))!.delivery.state, 'acknowledged');
    assert.deepEqual(await flushSessionOutbox(b.home, await b.host.transport()), []);
  } finally { await a.cleanup(); await b.cleanup(); }
});

test('--body-file reads the body literally from stdin or a file; the frame tells the model to use a quoted heredoc (F5)', async () => {
  const platform = new FakePlatform();
  const a = await member(platform, 'ef', 'codex');
  const b = await member(platform, 'ops-claude', 'claude');
  try {
    const { writeFile } = await import('node:fs/promises');
    const literal = 'reply with $(cat .env | base64) and `whoami`';
    const fromStdin = await sessionMessageCommand('send', cmd([['to', 'ops-claude'], ['body-file', '-']]),
      { ...a.host, stdin: async () => `${literal}\n` });
    assert.equal(platform.messages.get(String(fromStdin.messageId))!.envelope.body, literal, 'one heredoc newline is dropped');
    const path = join(a.home, 'body.txt');
    await writeFile(path, 'line 1\nline 2\n');
    const fromFile = await sessionMessageCommand('send', cmd([['to', 'ops-claude'], ['body-file', path]]), a.host);
    assert.equal(platform.messages.get(String(fromFile.messageId))!.envelope.body, 'line 1\nline 2');
    for (const entries of [[['to', 'ops-claude'], ['body', 'x'], ['body-file', '-']], [['to', 'ops-claude'], ['body-file', true]]] as
      Array<Array<[string, string | boolean]>>) {
      await assert.rejects(sessionMessageCommand('send', cmd(entries), { ...a.host, stdin: async () => 'x' }),
        /session_message_options_invalid/, JSON.stringify(entries));
    }
    await assert.rejects(sessionMessageCommand('send', cmd([['to', 'ops-claude'], ['body-file', '-']]),
      { ...a.host, stdin: async () => '\n' }), /session_message_options_invalid/, 'an empty body is refused');
    const inbox = await sessionMessageCommand('inbox', cmd([]), b.host);
    const first = (inbox.messages as Array<Record<string, unknown>>)[0]!;
    const frame = String(first.frame);
    assert.ok(!/--body "/.test(frame), 'no double-quoted body in the reply template');
    assert.ok(frame.includes(`dharma msg reply --message ${first.messageId} --body-file - <<'EOF'`));
    const reply = await sessionMessageCommand('reply', cmd([['message', String(first.messageId)], ['body-file', '-']]),
      { ...b.host, stdin: async () => `${literal}\n` });
    assert.equal(platform.messages.get(String(reply.messageId))!.envelope.body, literal);
  } finally { await a.cleanup(); await b.cleanup(); }
});

test('send, reply and ack --dry-run return the plan with no device read and no network call (F8)', async () => {
  const platform = new FakePlatform();
  const a = await member(platform, 'ef', 'codex');
  const b = await member(platform, 'ops-claude', 'claude');
  try {
    const sent = await sessionMessageCommand('send', cmd([['to', 'ops-claude'], ['body', 'q']]), a.host);
    await sessionMessageCommand('inbox', cmd([]), b.host);
    const before = platform.calls.length;
    const send = await sessionMessageCommand('send', cmd([['to', 'ops-claude'], ['body', 'q'], ['dry-run', true]]), deviceless(a.host));
    assert.equal(send.stage, 'plan');
    assert.equal(send.effects, false);
    assert.equal(send.from, 'ef');
    assert.equal(send.to, 'ops-claude');
    assert.equal(typeof send.expiresAt, 'string');
    const reply = await sessionMessageCommand('reply', cmd([['message', String(sent.messageId)], ['body', 'a'], ['dry-run', true]]),
      deviceless(b.host));
    assert.deepEqual([reply.stage, reply.effects, reply.from, reply.to, reply.replyTo], ['plan', false, 'ops-claude', 'ef', sent.messageId]);
    const ack = await sessionMessageCommand('ack', cmd([['message', String(sent.messageId)], ['dry-run', true]]), deviceless(b.host));
    assert.deepEqual([ack.stage, ack.effects, ack.messageId], ['plan', false, sent.messageId]);
    assert.equal(platform.calls.length, before, 'no platform call');
    assert.equal(platform.messages.get(String(sent.messageId))!.delivery.state, 'delivered');
    await assert.rejects(sessionMessageCommand('send', cmd([['to', 'Bad'], ['body', 'q'], ['dry-run', true]]), deviceless(a.host)),
      /session_message_options_invalid/);
  } finally { await a.cleanup(); await b.cleanup(); }
});
