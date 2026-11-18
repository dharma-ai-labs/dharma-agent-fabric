import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import {
  acknowledgeSessionMessage,
  pollSessionMessages,
  readSessionMessageDelivery,
  replySessionMessage,
  reportSessionMessageDelivered,
  sendSessionMessage,
  SESSION_MESSAGE_ROUTES,
} from './sessionMessageClient.js';
import type { SessionMessageTransport } from './sessionNames.js';

type Call = { method: 'GET' | 'POST'; route: string; body?: unknown };
const ORG = 'org-hq';

function delivery(messageId: string, state: string, extra: Record<string, unknown> = {}) {
  return { schema: 'dharma.session-message-delivery/v1', organizationId: ORG, messageId, recipientName: 'ef',
    state, updatedAt: '2026-11-10T10:00:00.000Z', ...extra };
}
const notFound = () => Object.assign(new Error('session_message_not_found'), { status: 404, definitive: true });
const lost = () => new Error('fetch failed');

function transport(handlers: {
  post?: (route: string, body: unknown, attempt: number) => Promise<Record<string, unknown>>;
  get?: (route: string, attempt: number) => Promise<Record<string, unknown>>;
}) {
  const calls: Call[] = [];
  let posts = 0, gets = 0;
  const value: SessionMessageTransport = {
    async signedPost(route, body) {
      calls.push({ method: 'POST', route, body: JSON.parse(JSON.stringify(body)) });
      posts += 1;
      if (!handlers.post) throw new Error('unexpected_post');
      return handlers.post(route, body, posts);
    },
    async signedGet(route) {
      calls.push({ method: 'GET', route });
      gets += 1;
      if (!handlers.get) throw new Error('unexpected_get');
      return handlers.get(route, gets);
    },
  };
  return { value, calls };
}

const envelope = (messageId = randomUUID()) => ({ schema: 'dharma.session-message/v1', messageId } as never);

test('routes are the P2p stub shapes under the device-signed organization prefix', () => {
  const id = randomUUID();
  assert.equal(SESSION_MESSAGE_ROUTES.attach, '/agent-fabric/session-names/attach');
  assert.equal(SESSION_MESSAGE_ROUTES.directory, '/agent-fabric/session-names');
  assert.equal(SESSION_MESSAGE_ROUTES.send, '/agent-fabric/session-messages');
  assert.equal(SESSION_MESSAGE_ROUTES.poll, '/agent-fabric/session-messages/poll');
  assert.equal(SESSION_MESSAGE_ROUTES.delivery(id), `/agent-fabric/session-messages/${id}/delivery`);
  assert.equal(SESSION_MESSAGE_ROUTES.delivered(id), `/agent-fabric/session-messages/${id}/delivered`);
  assert.equal(SESSION_MESSAGE_ROUTES.ack(id), `/agent-fabric/session-messages/${id}/ack`);
  assert.equal(SESSION_MESSAGE_ROUTES.reply(id), `/agent-fabric/session-messages/${id}/reply`);
  assert.throws(() => SESSION_MESSAGE_ROUTES.ack('../x'), /session_message_id_invalid/);
});

test('send posts the envelope and the raw reply token once and returns the queued state', async () => {
  const message = envelope();
  const t = transport({ post: async () => ({ delivery: delivery((message as { messageId: string }).messageId, 'queued'), replay: false }) });
  const result = await sendSessionMessage(t.value, { envelope: message, replyToken: 'token-1' });
  assert.deepEqual(t.calls, [{ method: 'POST', route: '/agent-fabric/session-messages',
    body: { envelope: message, replyToken: 'token-1' } }]);
  assert.equal(result.state, 'queued');
  assert.equal(result.replay, false);
});

test('an uncertain send reads the platform state first and resubmits the same envelope only when nothing is stored', async () => {
  const message = envelope();
  const id = (message as { messageId: string }).messageId;
  const stored = transport({
    post: async () => { throw lost(); },
    get: async () => delivery(id, 'queued'),
  });
  const reconciled = await sendSessionMessage(stored.value, { envelope: message, replyToken: 'token-1' });
  assert.deepEqual(stored.calls.map(call => `${call.method} ${call.route}`), [
    'POST /agent-fabric/session-messages', `GET /agent-fabric/session-messages/${id}/delivery`]);
  assert.equal(reconciled.state, 'queued');
  assert.equal(reconciled.replay, true);

  const absent = transport({
    post: async (_route, _body, attempt) => {
      if (attempt === 1) throw lost();
      return { delivery: delivery(id, 'queued'), replay: false };
    },
    get: async () => { throw notFound(); },
  });
  await sendSessionMessage(absent.value, { envelope: message, replyToken: 'token-1' });
  assert.deepEqual(absent.calls.map(call => `${call.method} ${call.route}`), [
    'POST /agent-fabric/session-messages', `GET /agent-fabric/session-messages/${id}/delivery`,
    'POST /agent-fabric/session-messages']);
  assert.deepEqual(absent.calls[2]!.body, absent.calls[0]!.body, 'the resubmission is byte-identical');

  const definitive = transport({ post: async () => {
    throw Object.assign(new Error('session_not_found'), { status: 404, definitive: true });
  } });
  await assert.rejects(sendSessionMessage(definitive.value, { envelope: message, replyToken: 'token-1' }), /session_not_found/);
  assert.equal(definitive.calls.length, 1);

  const twice = transport({ post: async () => { throw lost(); }, get: async () => { throw notFound(); } });
  await assert.rejects(sendSessionMessage(twice.value, { envelope: message, replyToken: 'token-1' }), /session_message_send_uncertain/);
  assert.equal(twice.calls.filter(call => call.method === 'POST').length, 2, 'at most one resubmission');
});

test('a lost ACK is reconciled before any retry and the ACK is not repeated when the platform recorded it', async () => {
  const id = randomUUID();
  const recorded = transport({ post: async () => { throw lost(); }, get: async () => delivery(id, 'acknowledged', { channel: 'manual_pull' }) });
  const result = await acknowledgeSessionMessage(recorded.value, id);
  assert.equal(result.state, 'acknowledged');
  assert.deepEqual(recorded.calls.map(call => `${call.method} ${call.route}`), [
    `POST /agent-fabric/session-messages/${id}/ack`, `GET /agent-fabric/session-messages/${id}/delivery`]);

  const notYet = transport({
    post: async (_route, _body, attempt) => { if (attempt === 1) throw lost(); return delivery(id, 'acknowledged', { channel: 'manual_pull' }); },
    get: async () => delivery(id, 'delivered', { channel: 'manual_pull' }),
  });
  await acknowledgeSessionMessage(notYet.value, id);
  assert.deepEqual(notYet.calls.map(call => `${call.method} ${call.route}`), [
    `POST /agent-fabric/session-messages/${id}/ack`, `GET /agent-fabric/session-messages/${id}/delivery`,
    `POST /agent-fabric/session-messages/${id}/ack`]);
});

test('delivered reports are checked against the frozen actor rules before any network call', async () => {
  const id = randomUUID();
  const t = transport({ post: async () => delivery(id, 'delivered', { channel: 'codex_queue', outcome: 'processed' }) });
  for (const report of [
    { channel: 'manual_pull', outcome: 'processed' },
    { channel: 'codex_queue' },
    { channel: 'claude_hook', outcome: 'read' },
    { channel: 'local_queue_succeeded', outcome: 'processed' },
  ]) {
    await assert.rejects(reportSessionMessageDelivered(t.value, id, report as never), /session_message_delivery_report_invalid/);
  }
  assert.equal(t.calls.length, 0);
  const result = await reportSessionMessageDelivered(t.value, id, { channel: 'codex_queue', outcome: 'processed' });
  assert.equal(result.state, 'delivered');
  assert.deepEqual(t.calls, [{ method: 'POST', route: `/agent-fabric/session-messages/${id}/delivered`,
    body: { channel: 'codex_queue', outcome: 'processed' } }]);
  await reportSessionMessageDelivered(t.value, id, { channel: 'manual_pull' });
  assert.deepEqual(t.calls[1]!.body, { channel: 'manual_pull' });
});

test('an uncertain delivered report reconciles: same channel is done, another channel is a conflict, queued retries once', async () => {
  const id = randomUUID();
  const same = transport({ post: async () => { throw lost(); },
    get: async () => delivery(id, 'delivered', { channel: 'codex_queue', outcome: 'processed' }) });
  assert.equal((await reportSessionMessageDelivered(same.value, id, { channel: 'codex_queue', outcome: 'processed' })).state, 'delivered');
  assert.equal(same.calls.length, 2);

  const other = transport({ post: async () => { throw lost(); },
    get: async () => delivery(id, 'delivered', { channel: 'manual_pull' }) });
  await assert.rejects(reportSessionMessageDelivered(other.value, id, { channel: 'codex_queue', outcome: 'processed' }),
    /session_message_delivery_conflict/);
  assert.equal(other.calls.length, 2);

  const queued = transport({
    post: async (_route, _body, attempt) => {
      if (attempt === 1) throw lost();
      return delivery(id, 'delivered', { channel: 'claude_hook', outcome: 'processed' });
    },
    get: async () => delivery(id, 'queued'),
  });
  await reportSessionMessageDelivered(queued.value, id, { channel: 'claude_hook', outcome: 'processed' });
  assert.deepEqual(queued.calls.map(call => call.method), ['POST', 'GET', 'POST']);
});

test('poll returns the polled items and refuses a malformed response', async () => {
  const id = randomUUID();
  const item = { envelope: { messageId: id }, replyToken: 'raw', sender: { membershipId: randomUUID(), deviceId: randomUUID(),
    name: 'ops-claude', publicKeyEd25519: 'A'.repeat(43) }, delivery: { state: 'queued' } };
  const t = transport({ post: async () => ({ messages: [item] }) });
  const items = await pollSessionMessages(t.value, 'ef');
  assert.deepEqual(t.calls, [{ method: 'POST', route: '/agent-fabric/session-messages/poll', body: { recipientName: 'ef', limit: 20 } }]);
  assert.equal(items.length, 1);
  assert.equal(items[0]!.sender.name, 'ops-claude');
  for (const bad of [{}, { messages: 'x' }, { messages: [{ ...item, sender: { ...item.sender, publicKeyEd25519: 7 } }] },
    { messages: [{ ...item, replyToken: undefined }] }, { messages: [{ ...item, extra: 1 }] }]) {
    const b = transport({ post: async () => bad as Record<string, unknown> });
    await assert.rejects(pollSessionMessages(b.value, 'ef'), /session_message_poll_response_invalid/, JSON.stringify(bad));
  }
  await assert.rejects(pollSessionMessages(t.value, 'Bad Name'), /session_name_invalid/);
});

test('reply posts to the original message route and reconciles an uncertain reply by the reply id', async () => {
  const original = randomUUID();
  const reply = envelope();
  const replyId = (reply as { messageId: string }).messageId;
  const t = transport({ post: async () => { throw lost(); }, get: async () => delivery(replyId, 'queued') });
  const result = await replySessionMessage(t.value, { originalMessageId: original, envelope: reply,
    replyToken: 'original-raw', nextReplyToken: 'next-raw' });
  assert.equal(result.state, 'queued');
  assert.deepEqual(t.calls, [
    { method: 'POST', route: `/agent-fabric/session-messages/${original}/reply`,
      body: { envelope: reply, replyToken: 'original-raw', nextReplyToken: 'next-raw' } },
    { method: 'GET', route: `/agent-fabric/session-messages/${replyId}/delivery` },
  ]);
});

test('reading the delivery state validates the record and maps 404 to null', async () => {
  const id = randomUUID();
  assert.equal(await readSessionMessageDelivery(transport({ get: async () => { throw notFound(); } }).value, id), null);
  assert.equal((await readSessionMessageDelivery(transport({ get: async () => delivery(id, 'queued') }).value, id))?.state, 'queued');
  await assert.rejects(readSessionMessageDelivery(transport({ get: async () => delivery(id, 'read') }).value, id),
    /session_message_delivery_response_invalid/);
  await assert.rejects(readSessionMessageDelivery(transport({ get: async () => delivery(randomUUID(), 'queued') }).value, id),
    /session_message_delivery_response_invalid/);
});
