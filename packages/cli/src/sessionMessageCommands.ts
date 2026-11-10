import { createPublicKey, randomUUID, type KeyObject } from 'node:crypto';
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
  pollSessionMessages,
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

export interface AcceptedSessionMessage { message: SessionMessage; frame: string }

/** Poll for one attached name, verify every envelope (own org, attested sender key, exact recipient),
 * and keep each verified message locally. Refused envelopes are neither stored nor delivered.
 * The caller reports `delivered` on its own channel. */
export async function receiveSessionMessages(host: SessionMessagingHost, attachment: LocalSessionAttachment,
  transport: SessionMessageTransport, device: SessionMessagingDevice) {
  const accepted: AcceptedSessionMessage[] = [];
  const refused: Array<{ messageId: string; reason: SessionMessageVerificationReason }> = [];
  for (const item of await pollSessionMessages(transport, attachment.name)) {
    const verified = verifySessionMessage(item.envelope, { organizationId: device.organizationId,
      resolveDevicePublicKey: attestedKey(item), recipientName: attachment.name }, host.now());
    if (!verified.ok) { refused.push({ messageId: String(item.envelope.messageId), reason: verified.reason }); continue; }
    const message = item.envelope;
    const record: ReceivedSessionMessage = { schema: 'dharma.received-session-message/v1', envelope: message,
      replyToken: sha256(item.replyToken) === message.replyTokenHash ? item.replyToken : null,
      recipientName: attachment.name, receivedAt: host.now().toISOString() };
    await writeSessionStateFile(receivedPath(host.home, message.messageId), record);
    accepted.push({ message, frame: frameSessionMessage(message) });
  }
  return { accepted, refused };
}

function conflict(error: unknown) {
  return error instanceof Error && /session_message_delivery_conflict/.test(error.message)
    || (error as { status?: unknown })?.status === 409;
}

/** Report one delivery; a message already delivered on another channel is reported as such, not retried. */
export async function reportReceivedDelivery(transport: SessionMessageTransport, messageId: string, report: SessionDeliveredReport) {
  try { await reportSessionMessageDelivered(transport, messageId, report); return 'reported' as const; } catch (error) {
    if (conflict(error)) return 'already_delivered' as const;
    throw error;
  }
}

function text(flags: Map<string, string | boolean>, key: string) {
  const value = flags.get(key);
  if (typeof value !== 'string' || !value) throw new Error(OPTIONS_INVALID);
  return value;
}

async function send(flags: Map<string, string | boolean>, host: SessionMessagingHost) {
  assertSessionFlags(flags, ['to', 'body', 'from', 'json'], ['json'], OPTIONS_INVALID);
  const to = text(flags, 'to');
  const body = text(flags, 'body');
  if (!SESSION_NAME_PATTERN.test(to) || flags.has('from') && !SESSION_NAME_PATTERN.test(String(flags.get('from')))) {
    throw new Error(OPTIONS_INVALID);
  }
  const from = await localAttachment(host.home, flags.get('from') as string | undefined, null);
  const device = await host.device();
  await localAttachment(host.home, from.name, device);
  const { envelope, replyToken } = buildSessionMessage(device, from, { to, body, replyTo: null, now: host.now() });
  const result = await sendSessionMessage(await host.transport(), { envelope, replyToken });
  return { ok: true, messageId: envelope.messageId, from: from.name, to, state: result.state, replay: result.replay,
    expiresAt: envelope.expiresAt };
}

async function inbox(flags: Map<string, string | boolean>, host: SessionMessagingHost) {
  assertSessionFlags(flags, ['name', 'json'], ['json'], OPTIONS_INVALID);
  if (flags.has('name') && !SESSION_NAME_PATTERN.test(String(flags.get('name')))) throw new Error(OPTIONS_INVALID);
  const name = flags.get('name') as string | undefined;
  await localAttachment(host.home, name, null);
  const device = await host.device();
  const attachment = await localAttachment(host.home, name, device);
  const transport = await host.transport();
  const { accepted, refused } = await receiveSessionMessages(host, attachment, transport, device);
  const messages = [];
  for (const { message, frame } of accepted) {
    // Recorded before it is shown: a manual pull stops any later automatic delivery of this message.
    const delivery = await reportReceivedDelivery(transport, message.messageId, { channel: 'manual_pull' });
    messages.push({ messageId: message.messageId, from: message.sender.name, to: message.recipient.name,
      sentAt: message.createdAt, replyTo: message.replyTo, delivery, frame });
  }
  return { ok: true, channel: 'manual_pull', name: attachment.name, messages, refused };
}

async function received(flags: Map<string, string | boolean>, host: SessionMessagingHost) {
  const messageId = text(flags, 'message');
  if (!UUID.test(messageId)) throw new Error(OPTIONS_INVALID);
  const record = await readReceivedSessionMessage(host.home, messageId);
  if (!record) throw new Error('session_message_not_received');
  return record;
}

async function reply(flags: Map<string, string | boolean>, host: SessionMessagingHost) {
  assertSessionFlags(flags, ['message', 'body', 'json'], ['json'], OPTIONS_INVALID);
  const body = text(flags, 'body');
  const original = await received(flags, host);
  if (!original.replyToken) throw new Error('session_reply_token_unavailable');
  const device = await host.device();
  const from = await localAttachment(host.home, original.recipientName, device);
  const { envelope, replyToken } = buildSessionMessage(device, from, { to: original.envelope.sender.name, body,
    replyTo: original.envelope.messageId, now: host.now() });
  const result = await replySessionMessage(await host.transport(), { originalMessageId: original.envelope.messageId,
    envelope, replyToken: original.replyToken, nextReplyToken: replyToken });
  return { ok: true, messageId: envelope.messageId, replyTo: original.envelope.messageId, from: from.name,
    to: envelope.recipient.name, state: result.state };
}

async function ack(flags: Map<string, string | boolean>, host: SessionMessagingHost) {
  assertSessionFlags(flags, ['message', 'json'], ['json'], OPTIONS_INVALID);
  const original = await received(flags, host);
  const result = await acknowledgeSessionMessage(await host.transport(), original.envelope.messageId);
  return { ok: true, messageId: original.envelope.messageId, state: result.state };
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
