import { createPublicKey, randomUUID, type KeyObject } from 'node:crypto';
import { readdir, readFile, rm, stat } from 'node:fs/promises';
import {
  createSessionReplyToken,
  sessionMessageBodyHash,
  sha256,
  signSessionMessage,
  verifySessionMessage,
  SESSION_MESSAGE_MAX_LIFETIME_MS,
  SESSION_NAME_PATTERN,
  type SessionMessage,
  type SessionMessageVerificationReason,
} from '@dharma-ai-labs/agent-fabric-contracts';
import {
  acknowledgeSessionMessage,
  isUncertainSessionTransportFailure,
  pollSessionMessages,
  readSessionMessageDelivery,
  replySessionMessage,
  reportSessionMessageDelivered,
  sendSessionMessage,
  type PolledSessionMessage,
  type SessionDeliveredReport,
} from './sessionMessageClient.js';
import { frameSessionMessage } from './sessionMessageFrame.js';
import {
  assertSessionFlags,
  listSessionAttachments,
  readSessionAttachment,
  readSessionStateFile,
  sessionStatePath,
  writeSessionStateFile,
  type LocalSessionAttachment,
  type SessionMessageTransport,
  type SessionMessagingDevice,
  type SessionMessagingHost,
} from './sessionNames.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const OPTIONS_INVALID = 'session_message_options_invalid';

/** A verified message this device received, kept so the recipient can reply or acknowledge later.
 * The raw reply token is kept only here (private file), never printed, framed or logged. */
export interface ReceivedSessionMessage {
  schema: 'dharma.received-session-message/v1';
  envelope: SessionMessage;
  replyToken: string | null;
  recipientName: string;
  receivedAt: string;
}

function receivedPath(home: string, messageId: string) {
  if (!UUID.test(messageId)) throw new Error('session_message_id_invalid');
  return sessionStatePath(home, 'received', `${messageId.toLowerCase()}.json`);
}

export async function readReceivedSessionMessage(home: string, messageId: string): Promise<ReceivedSessionMessage | null> {
  const value = await readSessionStateFile<ReceivedSessionMessage>(receivedPath(home, messageId));
  if (value && (value.schema !== 'dharma.received-session-message/v1' || value.envelope?.messageId !== messageId)) {
    throw new Error('session_received_record_invalid');
  }
  return value;
}

/** The sender name: `--from`, or this device's only attached name. */
async function localAttachment(home: string, name: string | undefined, device: SessionMessagingDevice | null) {
  let attachment: LocalSessionAttachment | null | undefined;
  if (name !== undefined) {
    attachment = await readSessionAttachment(home, name);
    if (!attachment || attachment.pending) throw new Error('session_message_sender_unattached');
  } else {
    const all = await listSessionAttachments(home);
    if (all.length === 0) throw new Error('session_message_sender_unattached');
    if (all.length > 1) throw new Error('session_message_sender_ambiguous');
    attachment = all[0]!;
  }
  if (device && (attachment.organizationId !== device.organizationId || attachment.deviceId !== device.deviceId
    || !attachment.membershipId)) throw new Error('session_attachment_device_changed');
  return attachment;
}

/** Builds and signs a new envelope from an attached name. The raw token goes to the platform beside it. */
export function buildSessionMessage(device: SessionMessagingDevice, from: LocalSessionAttachment,
  input: { to: string; body: string; replyTo: string | null; now: Date }) {
  const { token, tokenHash } = createSessionReplyToken();
  const createdAt = new Date(input.now.getTime());
  const envelope = signSessionMessage({ schema: 'dharma.session-message/v1', messageId: randomUUID(),
    organizationId: device.organizationId,
    sender: { membershipId: from.membershipId!, deviceId: device.deviceId, name: from.name },
    recipient: { name: input.to }, createdAt: createdAt.toISOString(),
    expiresAt: new Date(createdAt.getTime() + SESSION_MESSAGE_MAX_LIFETIME_MS).toISOString(),
    body: input.body, bodyHash: sessionMessageBodyHash(input.body), replyTo: input.replyTo,
    replyTokenHash: tokenHash }, device.privateKey);
  return { envelope, replyToken: token };
}

function attestedKey(item: PolledSessionMessage) {
  return (membershipId: string, deviceId: string, senderName: string): KeyObject | null => {
    if (membershipId !== item.sender.membershipId || deviceId !== item.sender.deviceId || senderName !== item.sender.name) return null;
    try { return createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: item.sender.publicKeyEd25519 }, format: 'jwk' }); }
    catch { return null; }
  };
}

export interface AcceptedSessionMessage { message: SessionMessage; frame: string; queued: boolean }

/** Poll for one attached name, verify every envelope (own org, attested sender key, exact recipient),
 * and keep each verified message locally. Refused envelopes are neither stored nor delivered.
 * The caller reports `delivered` on its own channel.
 * The platform poll also lists `delivered` messages whose reply token is unused, so the recipient can still
 * reply. Those are not new deliveries: a deliverer (hook, watcher) gets only `queued` ones; the manual
 * inbox passes `includeDelivered` to list them again, marked `queued: false`. */
export async function receiveSessionMessages(host: SessionMessagingHost, attachment: LocalSessionAttachment,
  transport: SessionMessageTransport, device: SessionMessagingDevice, options: { includeDelivered?: boolean } = {}) {
  const accepted: AcceptedSessionMessage[] = [];
  const refused: Array<{ messageId: string; reason: SessionMessageVerificationReason }> = [];
  for (const item of await pollSessionMessages(transport, attachment.name)) {
    const queued = item.delivery.state === 'queued';
    if (!queued && (options.includeDelivered !== true || item.delivery.state !== 'delivered')) continue;
    const verified = verifySessionMessage(item.envelope, { organizationId: device.organizationId,
      resolveDevicePublicKey: attestedKey(item), recipientName: attachment.name }, host.now());
    if (!verified.ok) { refused.push({ messageId: String(item.envelope.messageId), reason: verified.reason }); continue; }
    const message = item.envelope;
    const record: ReceivedSessionMessage = { schema: 'dharma.received-session-message/v1', envelope: message,
      replyToken: sha256(item.replyToken) === message.replyTokenHash ? item.replyToken : null,
      recipientName: attachment.name, receivedAt: host.now().toISOString() };
    await writeSessionStateFile(receivedPath(host.home, message.messageId), record);
    accepted.push({ message, frame: frameSessionMessage(message), queued });
  }
  return { accepted, refused };
}

function conflict(error: unknown) {
  return error instanceof Error && /session_message_delivery_conflict/.test(error.message)
    || (error as { status?: unknown })?.status === 409;
}

/** Report one delivery; a message already delivered on another channel is reported as such, not retried.
 * With `home`, a reply or ack the recipient parked during the delivering turn is posted right after. One whose
 * post is uncertain stays parked and one the platform refuses is kept marked failed: `msg inbox` retries or shows it. */
export async function reportReceivedDelivery(transport: SessionMessageTransport, messageId: string, report: SessionDeliveredReport,
  home?: string) {
  let result: 'reported' | 'already_delivered';
  try { await reportSessionMessageDelivered(transport, messageId, report); result = 'reported'; } catch (error) {
    if (!conflict(error)) throw error;
    result = 'already_delivered';
  }
  if (home !== undefined) {
    try { await flushSessionOutbox(home, transport, messageId); } catch { /* stays parked; the next flush retries */ }
  }
  return result;
}

/** A reply or ack the recipient made while its message was still `queued` on the platform: the frozen
 * contract allows `acknowledged` only after `delivered`, and a deliverer reports `delivered` only once the
 * turn that carries the message has ended. The recipient's own request waits here (private file: it holds
 * raw reply tokens) and is posted unchanged once the message is delivered. Nothing else ever acks. */
interface ParkedSessionRequest {
  schema: 'dharma.parked-session-request/v1';
  messageId: string;
  kind: 'reply' | 'ack';
  reply: { envelope: SessionMessage; replyToken: string; nextReplyToken: string } | null;
  parkedAt: string;
  /** Set when the platform definitively refused the post where nobody saw it; kept until it is shown. */
  failed?: { code: string };
}

function outboxPath(home: string, messageId: string) {
  if (!UUID.test(messageId)) throw new Error('session_message_id_invalid');
  return sessionStatePath(home, 'outbox', `${messageId.toLowerCase()}.json`);
}

async function readParked(home: string, messageId: string) {
  const value = await readSessionStateFile<ParkedSessionRequest>(outboxPath(home, messageId));
  if (value && (value.schema !== 'dharma.parked-session-request/v1' || value.messageId !== messageId)) {
    throw new Error('session_parked_request_invalid');
  }
  return value;
}

async function postParked(transport: SessionMessageTransport, parked: ParkedSessionRequest) {
  if (parked.kind === 'ack') return acknowledgeSessionMessage(transport, parked.messageId);
  return replySessionMessage(transport, { originalMessageId: parked.messageId, ...parked.reply! });
}

export type SessionOutboxAction = 'parked' | 'sent' | 'failed';
export interface SessionOutboxResult { messageId: string; kind: 'reply' | 'ack'; action: SessionOutboxAction; code?: string }

const errorCode = (error: unknown) => error instanceof Error ? error.message.slice(0, 120) : 'unknown';

/** One parked request: still `parked` while its message is `queued` or the post is uncertain (with the code);
 * `sent` once posted, or when the platform refuses a reply it already holds (posted before a crash or by a
 * concurrent flush); otherwise a definitive refusal is `failed` with its code. */
async function flushParked(transport: SessionMessageTransport, parked: ParkedSessionRequest): Promise<SessionOutboxResult> {
  const { messageId, kind } = parked;
  if (parked.failed) return { messageId, kind, action: 'failed', code: parked.failed.code };
  try {
    const delivery = await readSessionMessageDelivery(transport, messageId);
    if (!delivery || delivery.state === 'queued') return { messageId, kind, action: 'parked' };
    await postParked(transport, parked);
    return { messageId, kind, action: 'sent' };
  } catch (error) {
    const code = errorCode(error);
    if (isUncertainSessionTransportFailure(error)) return { messageId, kind, action: 'parked', code };
    try {
      if (kind === 'reply' && await readSessionMessageDelivery(transport, parked.reply!.envelope.messageId)) {
        return { messageId, kind, action: 'sent' };
      }
    } catch (check) { return { messageId, kind, action: 'parked', code: errorCode(check) }; }
    return { messageId, kind, action: 'failed', code };
  }
}

/** Posts every parked request (or the one for `messageId`) whose message the platform no longer shows as
 * `queued`. Sent requests are removed; parked ones stay. A failed one is removed when the caller shows the
 * results (`shown`: `msg inbox`, `msg reply`, `msg ack`); otherwise it is kept marked failed until one does. */
export async function flushSessionOutbox(home: string, transport: SessionMessageTransport, messageId?: string,
  options: { shown?: boolean } = {}): Promise<SessionOutboxResult[]> {
  let ids: string[];
  if (messageId !== undefined) ids = [messageId];
  else {
    try {
      ids = (await readdir(sessionStatePath(home, 'outbox'))).filter(entry => entry.endsWith('.json'))
        .map(entry => entry.slice(0, -'.json'.length)).filter(id => UUID.test(id)).sort();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
  }
  const results: SessionOutboxResult[] = [];
  for (const id of ids) {
    const parked = await readParked(home, id);
    if (!parked) continue;
    const result = await flushParked(transport, parked);
    results.push(result);
    if (result.action === 'parked') continue;
    if (result.action === 'sent' || options.shown) await rm(outboxPath(home, id), { force: true });
    else if (!parked.failed) await writeSessionStateFile(outboxPath(home, id), { ...parked, failed: { code: result.code ?? 'unknown' } });
  }
  return results;
}

const parkedExists = (kind: string) => new Error(`session_parked_request_exists: a ${kind} for this message is already parked`
  + ' on this device; it is sent once the message is recorded delivered, and dharma msg inbox retries it');

/** Park the recipient's request while the platform still shows its message `queued`; post it otherwise.
 * Returns `parked`, or the state the post left (the reply's own state, or the acknowledged original), and
 * `outbox`: what became of an earlier request parked for this message, posted first. */
async function postOrPark(home: string, transport: SessionMessageTransport, parked: ParkedSessionRequest):
  Promise<{ state: string; outbox: SessionOutboxResult[] }> {
  const delivery = await readSessionMessageDelivery(transport, parked.messageId);
  // One parked request per message: a second reply or ack would replace or overtake the first, which was
  // already reported accepted. Once the message is no longer queued (a flush after delivered may have failed),
  // the earlier request is posted first and its result is returned; this one goes ahead only when that one is
  // no longer parked.
  let outbox: SessionOutboxResult[] = [];
  const earlier = await readParked(home, parked.messageId);
  if (earlier) {
    if (delivery?.state === 'queued') throw parkedExists(earlier.kind);
    outbox = await flushSessionOutbox(home, transport, parked.messageId, { shown: true });
    if (outbox[0]?.action === 'parked') throw parkedExists(earlier.kind);
  }
  if (delivery?.state !== 'queued') return { state: (await postParked(transport, parked)).state, outbox };
  // Created exclusively: a request another process parked since the read above is refused, never replaced.
  try { await writeSessionStateFile(outboxPath(home, parked.messageId), parked, { exclusive: true }); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    throw parkedExists((await readParked(home, parked.messageId))?.kind ?? parked.kind);
  }
  // A deliverer may have reported between the read and the write: flush once more, so nothing waits for
  // a report that already happened.
  const [flushed] = await flushSessionOutbox(home, transport, parked.messageId, { shown: true });
  if (flushed?.action === 'failed') throw new Error(flushed.code ?? 'session_parked_request_failed');
  return { state: flushed?.action === 'sent' ? (parked.kind === 'ack' ? 'acknowledged' : 'queued') : 'parked', outbox };
}

function text(flags: Map<string, string | boolean>, key: string) {
  const value = flags.get(key);
  if (typeof value !== 'string' || !value) throw new Error(OPTIONS_INVALID);
  return value;
}

const MAX_BODY_FILE_BYTES = 262_144;

/** Reads all of a bounded stream (for `--body-file -`). */
export function readSessionMessageStdin(stream: NodeJS.ReadableStream, maxBytes = MAX_BODY_FILE_BYTES): Promise<string> {
  return new Promise((done, fail) => {
    let text = '';
    stream.setEncoding('utf8');
    stream.on('data', (chunk: string) => {
      text += chunk;
      if (Buffer.byteLength(text) > maxBytes) { stream.removeAllListeners('data'); fail(new Error(OPTIONS_INVALID)); }
    });
    stream.once('end', () => done(text));
    stream.once('error', fail);
  });
}

/** `--body <text>` or `--body-file <path|->`, exactly one. A file or stdin body is taken literally, so a
 * quoted heredoc reaches the platform with no shell expansion; one trailing newline is dropped. */
async function bodyOption(flags: Map<string, string | boolean>, host: SessionMessagingHost) {
  if (flags.has('body') === flags.has('body-file')) throw new Error(OPTIONS_INVALID);
  if (flags.has('body')) return text(flags, 'body');
  const source = text(flags, 'body-file');
  let raw: string;
  if (source === '-') {
    if (!host.stdin) throw new Error(OPTIONS_INVALID);
    raw = await host.stdin();
  } else {
    if ((await stat(source)).size > MAX_BODY_FILE_BYTES) throw new Error(OPTIONS_INVALID);
    raw = await readFile(source, 'utf8');
  }
  const body = raw.replace(/\r?\n$/, '');
  if (!body.trim()) throw new Error(OPTIONS_INVALID);
  return body;
}

const dryRun = (flags: Map<string, string | boolean>) => flags.get('dry-run') === true;
const expiry = (host: SessionMessagingHost) => new Date(host.now().getTime() + SESSION_MESSAGE_MAX_LIFETIME_MS).toISOString();

async function send(flags: Map<string, string | boolean>, host: SessionMessagingHost) {
  assertSessionFlags(flags, ['to', 'body', 'body-file', 'from', 'dry-run', 'json'], ['dry-run', 'json'], OPTIONS_INVALID);
  const to = text(flags, 'to');
  if (!SESSION_NAME_PATTERN.test(to) || flags.has('from') && !SESSION_NAME_PATTERN.test(String(flags.get('from')))) {
    throw new Error(OPTIONS_INVALID);
  }
  const body = await bodyOption(flags, host);
  const from = await localAttachment(host.home, flags.get('from') as string | undefined, null);
  if (dryRun(flags)) {
    return { ok: true, stage: 'plan', effects: false, action: 'send', from: from.name, to, replyTo: null,
      bodyCharacters: [...body].length, expiresAt: expiry(host) };
  }
  const device = await host.device();
  await localAttachment(host.home, from.name, device);
  const { envelope, replyToken } = buildSessionMessage(device, from, { to, body, replyTo: null, now: host.now() });
  const result = await sendSessionMessage(await host.transport(), { envelope, replyToken });
  return { ok: true, messageId: envelope.messageId, from: from.name, to, state: result.state, replay: result.replay,
    expiresAt: envelope.expiresAt };
}

async function inbox(flags: Map<string, string | boolean>, host: SessionMessagingHost) {
  assertSessionFlags(flags, ['name', 'dry-run', 'json'], ['dry-run', 'json'], OPTIONS_INVALID);
  if (flags.has('name') && !SESSION_NAME_PATTERN.test(String(flags.get('name')))) throw new Error(OPTIONS_INVALID);
  const name = flags.get('name') as string | undefined;
  const planned = await localAttachment(host.home, name, null);
  // The plan does not poll: that is a network call. It names the session a real inbox would pull for.
  if (dryRun(flags)) return { ok: true, stage: 'plan', effects: false, action: 'inbox', channel: 'manual_pull', name: planned.name };
  const device = await host.device();
  const attachment = await localAttachment(host.home, name, device);
  const transport = await host.transport();
  // Every parked request is retried first, so one left by a failed flush never waits for a report that already
  // happened, and each result is shown. Requests on messages this pull records delivered are flushed once more.
  const outbox = new Map<string, Record<string, unknown>>();
  const flushOutbox = async () => {
    for (const result of await flushSessionOutbox(host.home, transport, undefined, { shown: true })) {
      outbox.set(result.messageId, result.action === 'parked' ? { ...result, note: OUTBOX_PARKED_NOTE } : { ...result });
    }
  };
  await flushOutbox();
  const { accepted, refused } = await receiveSessionMessages(host, attachment, transport, device, { includeDelivered: true });
  const messages = [];
  const reportFailed: Array<{ messageId: string; code: string }> = [];
  let reported = false;
  for (const { message, frame, queued } of accepted) {
    // Recorded before it is shown: a manual pull stops any later automatic delivery of this message.
    // A failed report is not shown (the message stays queued and comes back on the next inbox), and every
    // message already recorded delivered is still shown. A message the platform already lists as delivered
    // (not yet replied to) is listed again as `already_delivered`, with no second report.
    let delivery: 'reported' | 'already_delivered' = 'already_delivered';
    if (queued) try {
      delivery = await reportReceivedDelivery(transport, message.messageId, { channel: 'manual_pull' });
      reported = true;
    } catch (error) {
      reportFailed.push({ messageId: message.messageId, code: errorCode(error) });
      continue;
    }
    messages.push({ messageId: message.messageId, from: message.sender.name, to: message.recipient.name,
      sentAt: message.createdAt, replyTo: message.replyTo, delivery, frame });
  }
  if (reported) await flushOutbox();
  return { ok: true, channel: 'manual_pull', name: attachment.name, messages, reportFailed, refused, outbox: [...outbox.values()] };
}

async function received(flags: Map<string, string | boolean>, host: SessionMessagingHost) {
  const messageId = text(flags, 'message');
  if (!UUID.test(messageId)) throw new Error(OPTIONS_INVALID);
  const record = await readReceivedSessionMessage(host.home, messageId);
  if (!record) throw new Error('session_message_not_received');
  return record;
}

const PARKED_NOTE = 'The message is still being delivered to this session; this is sent as soon as its delivery is recorded,'
  + ' and dharma msg inbox retries it if that send fails.';
const OUTBOX_PARKED_NOTE = 'Still parked on this device: sent once its message is recorded delivered; the next dharma msg inbox retries it.';
const withOutbox = (outbox: SessionOutboxResult[]) => outbox.length ? { outbox } : {};
const postedState = (state: string) => state === 'parked' ? { state, note: PARKED_NOTE } : { state };

async function reply(flags: Map<string, string | boolean>, host: SessionMessagingHost) {
  assertSessionFlags(flags, ['message', 'body', 'body-file', 'dry-run', 'json'], ['dry-run', 'json'], OPTIONS_INVALID);
  const body = await bodyOption(flags, host);
  const original = await received(flags, host);
  if (!original.replyToken) throw new Error('session_reply_token_unavailable');
  if (dryRun(flags)) {
    await localAttachment(host.home, original.recipientName, null);
    return { ok: true, stage: 'plan', effects: false, action: 'reply', from: original.recipientName,
      to: original.envelope.sender.name, replyTo: original.envelope.messageId, bodyCharacters: [...body].length,
      expiresAt: expiry(host) };
  }
  const device = await host.device();
  const from = await localAttachment(host.home, original.recipientName, device);
  const { envelope, replyToken } = buildSessionMessage(device, from, { to: original.envelope.sender.name, body,
    replyTo: original.envelope.messageId, now: host.now() });
  const { state, outbox } = await postOrPark(host.home, await host.transport(), { schema: 'dharma.parked-session-request/v1',
    messageId: original.envelope.messageId, kind: 'reply',
    reply: { envelope, replyToken: original.replyToken, nextReplyToken: replyToken }, parkedAt: host.now().toISOString() });
  return { ok: true, messageId: envelope.messageId, replyTo: original.envelope.messageId, from: from.name,
    to: envelope.recipient.name, ...postedState(state), ...withOutbox(outbox) };
}

async function ack(flags: Map<string, string | boolean>, host: SessionMessagingHost) {
  assertSessionFlags(flags, ['message', 'dry-run', 'json'], ['dry-run', 'json'], OPTIONS_INVALID);
  const original = await received(flags, host);
  if (dryRun(flags)) {
    return { ok: true, stage: 'plan', effects: false, action: 'ack', messageId: original.envelope.messageId,
      from: original.recipientName };
  }
  const { state, outbox } = await postOrPark(host.home, await host.transport(), { schema: 'dharma.parked-session-request/v1',
    messageId: original.envelope.messageId, kind: 'ack', reply: null, parkedAt: host.now().toISOString() });
  return { ok: true, messageId: original.envelope.messageId, ...postedState(state), ...withOutbox(outbox) };
}

/** `dharma msg send|inbox|reply|ack`. Inbox is the recipient's manual pull (channel `manual_pull`). */
export async function sessionMessageCommand(action: string, flags: Map<string, string | boolean>,
  host: SessionMessagingHost): Promise<Record<string, unknown>> {
  if (action === 'send') return send(flags, host);
  if (action === 'inbox') return inbox(flags, host);
  if (action === 'reply') return reply(flags, host);
  if (action === 'ack') return ack(flags, host);
  throw new Error('session_message_command_invalid');
}
