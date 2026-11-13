import {
  advanceSessionMessageDelivery,
  SESSION_NAME_PATTERN,
  validateSessionMessageDeliveryContract,
  type SessionMessage,
  type SessionMessageDelivery,
  type SessionMessageDeliveryOutcome,
  type SessionMessageDeliveryReport,
} from '@dharma-ai-labs/agent-fabric-contracts';
import type { SessionMessageTransport } from './sessionNames.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function messageRoute(messageId: string, leaf: string) {
  if (!UUID.test(messageId)) throw new Error('session_message_id_invalid');
  return `/agent-fabric/session-messages/${messageId}/${leaf}`;
}

/** Device-signed route shapes for P2p (stubs until the platform routes exist). The signed client
 * prefixes each with `/api/v1/orgs/<organizationId>`. */
export const SESSION_MESSAGE_ROUTES = Object.freeze({
  attach: '/agent-fabric/session-names/attach',
  directory: '/agent-fabric/session-names',
  send: '/agent-fabric/session-messages',
  poll: '/agent-fabric/session-messages/poll',
  delivery: (messageId: string) => messageRoute(messageId, 'delivery'),
  delivered: (messageId: string) => messageRoute(messageId, 'delivered'),
  ack: (messageId: string) => messageRoute(messageId, 'ack'),
  reply: (messageId: string) => messageRoute(messageId, 'reply'),
});

/** A definitive platform rejection (`AgentFabricRequestError.definitive`) is final; anything else
 * (network error, timeout, 5xx, a lost response) leaves the outcome unknown. */
export function isUncertainSessionTransportFailure(error: unknown): boolean {
  return !(error && typeof error === 'object' && (error as { definitive?: unknown }).definitive === true);
}
function isNotFound(error: unknown) {
  return !isUncertainSessionTransportFailure(error) && (error as { status?: unknown }).status === 404;
}

function deliveryRecord(value: unknown, messageId: string): SessionMessageDelivery {
  if (!validateSessionMessageDeliveryContract(value).ok || (value as SessionMessageDelivery).messageId !== messageId) {
    throw new Error('session_message_delivery_response_invalid');
  }
  return value as SessionMessageDelivery;
}

/** The platform's current delivery record for one message, or null when it stores none. */
export async function readSessionMessageDelivery(transport: SessionMessageTransport, messageId: string) {
  let value: Record<string, unknown>;
  try { value = await transport.signedGet(SESSION_MESSAGE_ROUTES.delivery(messageId)); } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
  return deliveryRecord(value, messageId);
}

/** One uncertain call: reconcile from the platform state first; retry the identical call at most once,
 * and only when the reconcile shows the call did not take effect. */
async function reconciled<T>(call: () => Promise<T>, reconcile: () => Promise<T | null>, uncertain: string): Promise<T> {
  try { return await call(); } catch (error) {
    if (!isUncertainSessionTransportFailure(error)) throw error;
  }
  const state = await reconcile();
  if (state !== null) return state;
  try { return await call(); } catch (error) {
    if (!isUncertainSessionTransportFailure(error)) throw error;
    throw new Error(uncertain, { cause: error });
  }
}

export type SessionSendResult = SessionMessageDelivery & { replay: boolean };

function sendResult(value: Record<string, unknown>, messageId: string): SessionSendResult {
  if (typeof value.replay !== 'boolean') throw new Error('session_message_send_response_invalid');
  return { ...deliveryRecord(value.delivery, messageId), replay: value.replay };
}

/** Send a signed envelope. The raw reply token goes to the platform beside the envelope (never in it),
 * for the platform to hand to the recipient with the polled message. An uncertain send resubmits the
 * same envelope, which the platform classifies as a replay. */
export async function sendSessionMessage(transport: SessionMessageTransport,
  input: { envelope: SessionMessage; replyToken: string }): Promise<SessionSendResult> {
  const { messageId } = input.envelope;
  const body = { envelope: input.envelope, replyToken: input.replyToken };
  return reconciled(
    async () => sendResult(await transport.signedPost(SESSION_MESSAGE_ROUTES.send, body), messageId),
    async () => {
      const stored = await readSessionMessageDelivery(transport, messageId);
      return stored && { ...stored, replay: true };
    },
    'session_message_send_uncertain');
}

export interface PolledSessionMessage {
  envelope: SessionMessage;
  /** Raw one-use reply token for this message; kept on this device, never printed or framed. */
  replyToken: string;
  /** The platform's attestation of who attached the sender name, with that device's active key. */
  sender: { membershipId: string; deviceId: string; name: string; publicKeyEd25519: string };
  delivery: { state: string; channel?: string; outcome?: string };
}

function polledItem(value: unknown): PolledSessionMessage {
  const invalid = () => new Error('session_message_poll_response_invalid');
  if (!value || typeof value !== 'object' || Object.keys(value).sort().join(',') !== 'delivery,envelope,replyToken,sender') throw invalid();
  const item = value as Record<string, unknown>;
  const sender = item.sender as Record<string, unknown> | null;
  const envelope = item.envelope as Record<string, unknown> | null;
  if (typeof item.replyToken !== 'string' || !item.replyToken || item.replyToken.length > 256
    || !envelope || typeof envelope !== 'object' || typeof envelope.messageId !== 'string'
    || !sender || typeof sender !== 'object' || Object.keys(sender).sort().join(',') !== 'deviceId,membershipId,name,publicKeyEd25519'
    || [sender.membershipId, sender.deviceId, sender.name, sender.publicKeyEd25519].some(field => typeof field !== 'string')
    || !item.delivery || typeof item.delivery !== 'object') throw invalid();
  return value as PolledSessionMessage;
}

/** Pull undelivered messages for one attached name (a page of at most 20). Nothing here is trusted:
 * each envelope must still pass `verifySessionMessage` with `recipientName` set. */
export async function pollSessionMessages(transport: SessionMessageTransport, recipientName: string) {
  if (!SESSION_NAME_PATTERN.test(recipientName)) throw new Error('session_name_invalid');
  const response = await transport.signedPost(SESSION_MESSAGE_ROUTES.poll, { recipientName, limit: 20 });
  if (!Array.isArray(response.messages) || Object.keys(response).join(',') !== 'messages') {
    throw new Error('session_message_poll_response_invalid');
  }
  return response.messages.map(polledItem);
}

export type SessionDeliveredReport =
  | { channel: 'codex_queue' | 'claude_hook'; outcome: SessionMessageDeliveryOutcome }
  | { channel: 'manual_pull' };

function frozenReport(report: SessionDeliveredReport): SessionMessageDeliveryReport {
  const value = report as unknown as Record<string, unknown>;
  const typed = (value.channel === 'manual_pull'
    ? { actor: 'recipient', state: 'delivered', ...value }
    : { actor: 'deliverer', state: 'delivered', ...value }) as SessionMessageDeliveryReport;
  // Throws session_message_delivery_report_invalid for a wrong actor, channel or outcome.
  advanceSessionMessageDelivery({ state: 'queued' }, typed);
  return typed;
}

/** Report `delivered` for one message: a deliverer (`codex_queue`/`claude_hook`, with the observed
 * outcome) or the recipient's manual pull. Never an acknowledgement. */
export async function reportSessionMessageDelivered(transport: SessionMessageTransport, messageId: string,
  report: SessionDeliveredReport): Promise<SessionMessageDelivery> {
  const typed = frozenReport(report);
  const body = report.channel === 'manual_pull' ? { channel: 'manual_pull' } : { channel: report.channel, outcome: report.outcome };
  return reconciled(
    async () => deliveryRecord(await transport.signedPost(SESSION_MESSAGE_ROUTES.delivered(messageId), body), messageId),
    async () => {
      const stored = await readSessionMessageDelivery(transport, messageId);
      if (!stored || stored.state === 'queued') return null;
      // Same report again is a no-op; another channel or outcome throws session_message_delivery_conflict.
      advanceSessionMessageDelivery({ state: stored.state, channel: stored.channel, outcome: stored.outcome },
        stored.state === 'delivered' ? typed : { actor: 'recipient', state: 'acknowledged' });
      return stored;
    },
    'session_message_delivered_uncertain');
}

/** The recipient's own acknowledgement. A watcher or hook never calls this. */
export async function acknowledgeSessionMessage(transport: SessionMessageTransport, messageId: string) {
  return reconciled(
    async () => deliveryRecord(await transport.signedPost(SESSION_MESSAGE_ROUTES.ack(messageId), {}), messageId),
    async () => {
      const stored = await readSessionMessageDelivery(transport, messageId);
      return stored?.state === 'acknowledged' ? stored : null;
    },
    'session_message_ack_uncertain');
}

/** Reply to a received message with its raw one-use token. The reply is a new envelope with its own
 * `nextReplyToken`; the platform acknowledges the original. Reconciled by the reply's message id. */
export async function replySessionMessage(transport: SessionMessageTransport, input: {
  originalMessageId: string; envelope: SessionMessage; replyToken: string; nextReplyToken: string;
}) {
  const body = { envelope: input.envelope, replyToken: input.replyToken, nextReplyToken: input.nextReplyToken };
  const { messageId } = input.envelope;
  return reconciled(
    async () => deliveryRecord(await transport.signedPost(SESSION_MESSAGE_ROUTES.reply(input.originalMessageId), body), messageId),
    () => readSessionMessageDelivery(transport, messageId),
    'session_message_reply_uncertain');
}
