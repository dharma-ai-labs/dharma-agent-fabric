export interface SessionDeliveryReceipt {
  schema: 'dharma.session-delivery-receipt/v1'; messageId: string; recipientName: string; threadId: string;
  state: 'submitting' | 'queued' | 'observed' | 'reported' | 'uncertain'; attempts: number; queueId: string | null;
  submittedAt: string | null; queuedAt: string | null; emptyReads: string[]; turnId: string | null;
  outcome: 'processed' | 'aborted' | 'merged' | null; queuedNotLoadedAt: string | null;
  report: 'reported' | 'already_delivered' | null; updatedAt: string;
}
const no = (): never => { throw new Error('not_implemented'); };
export function sessionDeliveryReceiptPath(_home: string, _id: string): string { return no(); }
export async function readSessionDeliveryReceipt(_home: string, _id: string): Promise<SessionDeliveryReceipt | null> { return no(); }
export async function writeSessionDeliveryReceipt(_home: string, _r: SessionDeliveryReceipt): Promise<void> { return no(); }
export function newSessionDeliveryReceipt(_i: { messageId: string; recipientName: string; threadId: string; now: Date }): SessionDeliveryReceipt { return no(); }
export function parseCodexQueueStdout(_stdout: string, _threadId: string): string | null { return no(); }
