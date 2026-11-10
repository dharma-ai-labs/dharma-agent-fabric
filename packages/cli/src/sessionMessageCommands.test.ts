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
          return { messages: [...this.messages.values()]
            .filter(item => item.envelope.recipient.name === body.recipientName && item.delivery.state === 'queued')
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
    const again = await sessionMessageCommand('inbox', cmd([]), b.host);
    assert.deepEqual(again.messages, [], 'a delivered message is not pulled twice');
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
