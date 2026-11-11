import { randomBytes, timingSafeEqual, type KeyObject } from 'node:crypto';
import { createRequire } from 'node:module';
import type { ErrorObject } from 'ajv';
import messageSchema from './session-message-v1.schema.json' with { type: 'json' };
import deliverySchema from './session-message-delivery-v1.schema.json' with { type: 'json' };
import registrationSchema from './provider-session-registration-v2.schema.json' with { type: 'json' };
import registrationReceiptSchema from './provider-session-registration-receipt-v2.schema.json' with { type: 'json' };
import { canonicalize, sha256, signCanonicalObject, verifyCanonicalObject } from './index.js';

/** Same rule as the existing named Codex thread (`namedCodexThread.ts`). */
export const SESSION_NAME_PATTERN = /^[a-z][a-z0-9-]{0,47}$/;
export const SESSION_MESSAGE_MAX_LIFETIME_MS = 7 * 24 * 60 * 60_000;
export const SESSION_MESSAGE_CLOCK_SKEW_MS = 5 * 60_000;

export interface SessionMessage {
  schema: 'dharma.session-message/v1';
  messageId: string;
  organizationId: string;
  sender: { membershipId: string; deviceId: string; name: string };
  recipient: { name: string };
  createdAt: string;
  expiresAt: string;
  body: string;
  bodyHash: string;
  replyTo: string | null;
  replyTokenHash: string;
  signature: string;
}
export type UnsignedSessionMessage = Omit<SessionMessage, 'signature'>;

export const SESSION_MESSAGE_DELIVERY_STATES = Object.freeze(['queued', 'delivered', 'acknowledged'] as const);
export type SessionMessageDeliveryState = typeof SESSION_MESSAGE_DELIVERY_STATES[number];
export const SESSION_MESSAGE_DELIVERY_CHANNELS = Object.freeze(['codex_queue', 'claude_hook', 'manual_pull'] as const);
export type SessionMessageDeliveryChannel = typeof SESSION_MESSAGE_DELIVERY_CHANNELS[number];
/** What the deliverer observed in the attached conversation: the turn that carried the message
 * completed (`processed`), was aborted, or the message was merged into another turn. */
export const SESSION_MESSAGE_DELIVERY_OUTCOMES = Object.freeze(['processed', 'aborted', 'merged'] as const);
export type SessionMessageDeliveryOutcome = typeof SESSION_MESSAGE_DELIVERY_OUTCOMES[number];

/** State plus how it was delivered. `channel` is absent while queued; `outcome` is present
 * only for the automatic channels. */
export interface SessionMessageDeliveryStatus {
  state: SessionMessageDeliveryState;
  channel?: SessionMessageDeliveryChannel;
  outcome?: SessionMessageDeliveryOutcome;
}
export interface SessionMessageDelivery extends SessionMessageDeliveryStatus {
  schema: 'dharma.session-message-delivery/v1';
  organizationId: string;
  messageId: string;
  recipientName: string;
  updatedAt: string;
}

/** Who may set each state, and with what:
 * - `queued`: the platform, on send;
 * - `delivered`: the recipient-side deliverer (watcher or hook) with its channel and observed outcome,
 *   or the recipient's own manual pull (`dharma msg inbox`), labelled `manual_pull` with no outcome;
 * - `acknowledged`: only the recipient's own ack or reply. A deliverer never acknowledges. */
export type SessionMessageDeliveryReport =
  | { actor: 'platform'; state: 'queued' }
  | { actor: 'deliverer'; state: 'delivered'; channel: 'codex_queue' | 'claude_hook'; outcome: SessionMessageDeliveryOutcome }
  | { actor: 'recipient'; state: 'delivered'; channel: 'manual_pull' }
  | { actor: 'recipient'; state: 'acknowledged' };

export type SessionProvider = 'codex' | 'claude';
export type SessionDelivery = 'codex_queue' | 'claude_hook';
export interface ProviderSessionRegistrationV2 {
  schema: 'dharma.provider-session-registration/v2';
  action: 'attach' | 'inspect' | 'heartbeat' | 'detach';
  organizationId: string;
  deviceId: string;
  bindingId: string;
  name: string;
  provider: SessionProvider;
  delivery: SessionDelivery;
  mode: 'cooperative';
  expectedRevision: number;
}
export interface ProviderSessionRegistrationV2Receipt {
  schema: 'dharma.provider-session-registration-receipt/v2';
  organizationId: string;
  bindingId: string;
  name: string;
  provider: SessionProvider;
  delivery: SessionDelivery;
  mode: 'cooperative';
  membershipId: string;
  deviceId: string;
  state: 'active' | 'detached';
  revision: number;
  replay: boolean;
  updatedAt: string;
}

export type SessionMessageVerificationReason =
  | 'schema_invalid' | 'organization_mismatch' | 'recipient_mismatch' | 'validity_too_long'
  | 'not_yet_valid' | 'expired' | 'body_hash_mismatch' | 'signer_unknown' | 'signature_invalid';
export type SessionMessageVerificationResult = { ok: true } | { ok: false; reason: SessionMessageVerificationReason };
export type SessionMessageReplyVerificationResult = { ok: true } | {
  ok: false; reason: SessionMessageVerificationReason | 'reply_mismatch' | 'reply_token_invalid' | 'reply_token_reused';
};

export interface SessionMessageVerifierOptions {
  /** The organization the verifier acts for (from its own config, never from the envelope). */
  organizationId: string;
  /** Active device key of that member's device, or null when unknown, revoked, of another org,
   * or when that member and device have not attached `senderName`. */
  resolveDevicePublicKey(membershipId: string, deviceId: string, senderName: string): KeyObject | null;
  /** When set, the envelope must be addressed to exactly this attached session name. */
  recipientName?: string;
}

/** Durable one-use record keyed on the original message id. Returns false when already consumed. */
export interface SessionReplyTokenLedger {
  consume(originalMessageId: string, replyTokenHash: string): Promise<boolean>;
}

const require = createRequire(import.meta.url);
const Ajv2020 = require('ajv/dist/2020').default as new (options: Record<string, unknown>) => {
  compile(schema: unknown): ((value: unknown) => boolean) & { errors?: ErrorObject[] | null };
};
const ajv = new Ajv2020({ allErrors: true, strict: true, strictRequired: false });
require('ajv-formats').default(ajv);
const messageValidator = ajv.compile(messageSchema);
const deliveryValidator = ajv.compile(deliverySchema);
const registrationValidator = ajv.compile(registrationSchema);
const registrationReceiptValidator = ajv.compile(registrationReceiptSchema);

type ContractResult = { ok: true } | { ok: false; errors: ErrorObject[] };
function contractResult(validator: typeof messageValidator, value: unknown): ContractResult {
  return validator(value) ? { ok: true } : { ok: false, errors: [...(validator.errors ?? [])] };
}
function exactTimestamp(value: string): number | null {
  const at = Date.parse(value);
  return Number.isFinite(at) && new Date(at).toISOString() === value ? at : null;
}

/** Schema plus the checks JSON Schema cannot express: exact ISO timestamps,
 * well-formed UTF-16 body (stable UTF-8 hash bytes) and expiry after creation. */
function wellFormed(value: unknown): value is SessionMessage {
  if (!messageValidator(value)) return false;
  const message = value as SessionMessage;
  const createdAt = exactTimestamp(message.createdAt);
  const expiresAt = exactTimestamp(message.expiresAt);
  return createdAt !== null && expiresAt !== null && expiresAt > createdAt
    && !/[\ud800-\udfff]/u.test(message.body);
}

export function validateSessionMessageContract(value: unknown): ContractResult {
  return contractResult(messageValidator, value);
}
export function validateSessionMessageDeliveryContract(value: unknown): ContractResult {
  return contractResult(deliveryValidator, value);
}
export function validateProviderSessionRegistrationV2Contract(value: unknown): ContractResult {
  return contractResult(registrationValidator, value);
}
export function validateProviderSessionRegistrationV2ReceiptContract(value: unknown): ContractResult {
  return contractResult(registrationReceiptValidator, value);
}

export function sessionMessageBodyHash(body: string): string {
  return sha256(Buffer.from(body, 'utf8'));
}

/** Canonical bytes the sender device signs: every field except `signature`. */
export function sessionMessageSigningPayload(message: UnsignedSessionMessage | SessionMessage): Buffer {
  const { signature: _signature, ...unsigned } = message as SessionMessage;
  void _signature;
  return Buffer.from(canonicalize(unsigned), 'utf8');
}

export function signSessionMessage(message: UnsignedSessionMessage, devicePrivateKey: KeyObject): SessionMessage {
  const draft = { ...message, signature: 'A'.repeat(86) };
  if (!wellFormed(draft) || draft.bodyHash !== sessionMessageBodyHash(draft.body)) {
    throw new Error('session_message_invalid');
  }
  return { ...message, signature: signCanonicalObject(message, devicePrivateKey) };
}

export function verifySessionMessage(
  value: unknown,
  options: SessionMessageVerifierOptions,
  now = new Date(),
): SessionMessageVerificationResult {
  if (!wellFormed(value)) return { ok: false, reason: 'schema_invalid' };
  const message = value;
  if (message.organizationId !== options.organizationId) return { ok: false, reason: 'organization_mismatch' };
  const createdAt = Date.parse(message.createdAt);
  const expiresAt = Date.parse(message.expiresAt);
  if (expiresAt - createdAt > SESSION_MESSAGE_MAX_LIFETIME_MS) return { ok: false, reason: 'validity_too_long' };
  if (createdAt > now.getTime() + SESSION_MESSAGE_CLOCK_SKEW_MS) return { ok: false, reason: 'not_yet_valid' };
  if (now.getTime() >= expiresAt) return { ok: false, reason: 'expired' };
  if (message.bodyHash !== sessionMessageBodyHash(message.body)) return { ok: false, reason: 'body_hash_mismatch' };
  const key = options.resolveDevicePublicKey(message.sender.membershipId, message.sender.deviceId, message.sender.name);
  if (!key) return { ok: false, reason: 'signer_unknown' };
  const { signature, ...unsigned } = message;
  let valid = false;
  try { valid = verifyCanonicalObject(unsigned, signature, key); } catch { valid = false; }
  if (!valid) return { ok: false, reason: 'signature_invalid' };
  if (options.recipientName !== undefined && message.recipient.name !== options.recipientName) {
    return { ok: false, reason: 'recipient_mismatch' };
  }
  return { ok: true };
}

/** A one-use reply token. Only `tokenHash` enters the signed envelope; the raw
 * token is never logged and never part of any envelope. */
export function createSessionReplyToken(): { token: string; tokenHash: string } {
  const token = randomBytes(32).toString('base64url');
  return { token, tokenHash: sha256(token) };
}

function tokenMatches(token: unknown, expectedHash: string): boolean {
  if (typeof token !== 'string' || token.length === 0 || token.length > 256) return false;
  const presented = Buffer.from(sha256(token), 'utf8');
  const expected = Buffer.from(expectedHash, 'utf8');
  return presented.length === expected.length && timingSafeEqual(presented, expected);
}

/** Verifies a reply envelope against the stored original and consumes the
 * original's reply token exactly once. Nothing is consumed on any refusal.
 * The reply's `sender.name` must be attached by its signing member and device,
 * exactly as on send, so holding the raw token is not enough to reply. */
export async function verifySessionMessageReply(
  value: unknown,
  options: Omit<SessionMessageVerifierOptions, 'recipientName'> & {
    original: SessionMessage; replyToken: string; ledger: SessionReplyTokenLedger;
  },
  now = new Date(),
): Promise<SessionMessageReplyVerificationResult> {
  const verified = verifySessionMessage(value, options, now);
  if (!verified.ok) return verified;
  const reply = value as SessionMessage;
  const original = options.original;
  if (!wellFormed(original)) return { ok: false, reason: 'schema_invalid' };
  if (reply.replyTo !== original.messageId || reply.messageId === original.messageId
    || reply.organizationId !== original.organizationId
    || reply.sender.name !== original.recipient.name || reply.recipient.name !== original.sender.name) {
    return { ok: false, reason: 'reply_mismatch' };
  }
  if (!tokenMatches(options.replyToken, original.replyTokenHash)) return { ok: false, reason: 'reply_token_invalid' };
  if (!await options.ledger.consume(original.messageId, original.replyTokenHash)) {
    return { ok: false, reason: 'reply_token_reused' };
  }
  return { ok: true };
}

function deliveryReportValid(report: Record<string, unknown>): boolean {
  const keys = Object.keys(report).sort().join(',');
  switch (report.state) {
    case 'queued': return report.actor === 'platform' && keys === 'actor,state';
    case 'acknowledged': return report.actor === 'recipient' && keys === 'actor,state';
    case 'delivered':
      if (report.actor === 'recipient') return report.channel === 'manual_pull' && keys === 'actor,channel,state';
      return report.actor === 'deliverer' && (report.channel === 'codex_queue' || report.channel === 'claude_hook')
        && (SESSION_MESSAGE_DELIVERY_OUTCOMES as readonly unknown[]).includes(report.outcome)
        && keys === 'actor,channel,outcome,state';
    default: return false;
  }
}

/** Forward-only, one step at a time, each step only by its actor (see `SessionMessageDeliveryReport`).
 * Repeating the same report is an idempotent no-op. A second `delivered` report with another channel or
 * outcome is a conflict: once a message is delivered (including by manual pull) nobody delivers it again.
 * There is no read or replied state: a reply is a separate message with `replyTo`. */
export function advanceSessionMessageDelivery(
  current: SessionMessageDeliveryStatus | null,
  report: SessionMessageDeliveryReport,
): SessionMessageDeliveryStatus {
  const next = report as unknown as Record<string, unknown>;
  const to = SESSION_MESSAGE_DELIVERY_STATES.indexOf(next.state as SessionMessageDeliveryState);
  const from = current === null ? -1 : SESSION_MESSAGE_DELIVERY_STATES.indexOf(current.state);
  if (to < 0 || (current !== null && from < 0)) throw new Error('session_message_delivery_transition_invalid');
  if (!deliveryReportValid(next)) throw new Error('session_message_delivery_report_invalid');
  if (!(to === from + 1 || (current !== null && to === from))) throw new Error('session_message_delivery_transition_invalid');
  const status: SessionMessageDeliveryStatus = report.state === 'delivered'
    ? { state: 'delivered', channel: report.channel, ...('outcome' in report ? { outcome: report.outcome } : {}) }
    : { ...current, state: report.state };
  if (current !== null && to === from) {
    if (report.state === 'delivered' && (current.channel !== status.channel || current.outcome !== status.outcome)) {
      throw new Error('session_message_delivery_conflict');
    }
    return current;
  }
  return status;
}

/** What the deliverer can observe about an earlier local attempt for one message. */
export interface SessionLocalQueueEvidence {
  /** Queue id from the local receipt or the captured `codex queue` stdout, or null when none was seen. */
  queueId: string | null;
  /** A pending local queue row for this message still exists. */
  pendingRow: boolean;
  /** The message id appears in the attached conversation (for Codex, the thread rollout). */
  inRollout: boolean;
}

/** Run before every local queue call, including the first after a restart. The deliverer writes a
 * `submitting` receipt before the call and the queue id after it; a local queue success alone never
 * counts as delivered. `queue` only when no trace of an earlier attempt exists; `wait` while the attempt
 * is committed but not yet observed; `report_delivered` once it is observed in the exact conversation. */
export function reconcileSessionLocalDelivery(evidence: SessionLocalQueueEvidence): 'queue' | 'wait' | 'report_delivered' {
  if (evidence.inRollout) return 'report_delivered';
  if (evidence.pendingRow || evidence.queueId !== null) return 'wait';
  return 'queue';
}

/** Digest of the complete signed envelope; Ed25519 signatures are deterministic. */
export function sessionMessageDigest(message: SessionMessage): string {
  return sha256(canonicalize(message));
}

/** Durable dedupe on message id: the same envelope again is a replay (return the
 * stored state, never a second delivery); different bytes under that id are a conflict. */
export function classifySessionMessageSubmission(
  stored: SessionMessage | null,
  incoming: SessionMessage,
): 'new' | 'replay' | 'conflict' {
  if (stored === null) return 'new';
  if (stored.messageId !== incoming.messageId) throw new Error('session_message_submission_mismatch');
  const left = Buffer.from(sessionMessageDigest(stored), 'utf8');
  const right = Buffer.from(sessionMessageDigest(incoming), 'utf8');
  return left.length === right.length && timingSafeEqual(left, right) ? 'replay' : 'conflict';
}
