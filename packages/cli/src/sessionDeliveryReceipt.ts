import type { SessionMessageDeliveryOutcome } from '@dharma-ai-labs/agent-fabric-contracts';
import { readSessionStateFile, sessionStatePath, writeSessionStateFile } from './sessionNames.js';

/** Local evidence of one watcher delivery attempt. None of these states is a platform state:
 * `queued` here means only that `codex queue` accepted the message (S1 3.1).
 * - `submitting`: written before every queue call; the queue id is not known yet.
 * - `queued`: a queue id was read from stdout.
 * - `observed`: the framed id was seen in the attached thread's rollout; its turn is still open.
 * - `reported`: the `delivered` report (channel `codex_queue`, observed outcome) reached the platform.
 * - `uncertain`: no trace after the one allowed retry; never retried again. */
export interface SessionDeliveryReceipt {
  schema: 'dharma.session-delivery-receipt/v1';
  messageId: string;
  recipientName: string;
  threadId: string;
  state: 'submitting' | 'queued' | 'observed' | 'reported' | 'uncertain';
  /** `codex queue` calls made for this message (at most 2). */
  attempts: number;
  queueId: string | null;
  submittedAt: string | null;
  queuedAt: string | null;
  /** Reconcile reads since the last attempt that found no stdout queue id, no pending row and no rollout hit. */
  emptyReads: string[];
  turnId: string | null;
  outcome: SessionMessageDeliveryOutcome | null;
  queuedNotLoadedAt: string | null;
  report: 'reported' | 'already_delivered' | null;
  updatedAt: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function sessionDeliveryReceiptPath(home: string, messageId: string): string {
  if (!UUID.test(messageId)) throw new Error('session_message_id_invalid');
  return sessionStatePath(home, 'receipts', `${messageId.toLowerCase()}.json`);
}

export async function readSessionDeliveryReceipt(home: string, messageId: string): Promise<SessionDeliveryReceipt | null> {
  const value = await readSessionStateFile<SessionDeliveryReceipt>(sessionDeliveryReceiptPath(home, messageId));
  if (value && (value.schema !== 'dharma.session-delivery-receipt/v1' || value.messageId !== messageId
    || !Number.isSafeInteger(value.attempts) || !Array.isArray(value.emptyReads))) {
    throw new Error('session_delivery_receipt_invalid');
  }
  return value;
}

export async function writeSessionDeliveryReceipt(home: string, receipt: SessionDeliveryReceipt): Promise<void> {
  await writeSessionStateFile(sessionDeliveryReceiptPath(home, receipt.messageId), receipt);
}

export function newSessionDeliveryReceipt(input: { messageId: string; recipientName: string; threadId: string; now: Date }):
  SessionDeliveryReceipt {
  return { schema: 'dharma.session-delivery-receipt/v1', messageId: input.messageId, recipientName: input.recipientName,
    threadId: input.threadId, state: 'submitting', attempts: 0, queueId: null, submittedAt: null, queuedAt: null,
    emptyReads: [], turnId: null, outcome: null, queuedNotLoadedAt: null, report: null, updatedAt: input.now.toISOString() };
}

/** `Queued message <queue-id> for thread <thread-id>.` (codex-cli 0.165.0). Read before the exit code:
 * a killed CLI can still have printed it (S1 q12). Only a complete line for the attached thread counts. */
export function parseCodexQueueStdout(stdout: string, threadId: string): string | null {
  for (const line of stdout.split(/\r?\n/)) {
    const match = /^Queued message ([0-9A-Za-z-]{1,64}) for thread ([0-9A-Za-z-]{1,64})\.$/.exec(line.trim());
    if (match && match[2]!.toLowerCase() === threadId.toLowerCase()) return match[1]!;
  }
  return null;
}
