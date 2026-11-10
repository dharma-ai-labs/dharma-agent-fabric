import type { SessionMessageTransport } from './sessionNames.js';
const id = (_value: string): string => { throw new Error('not_implemented'); };
export const SESSION_MESSAGE_ROUTES = { attach: '', directory: '', send: '', poll: '',
  delivery: id, delivered: id, ack: id, reply: id };
const stub = async (..._args: unknown[]): Promise<never> => { throw new Error('not_implemented'); };
export const sendSessionMessage: (t: SessionMessageTransport, i: { envelope: unknown; replyToken: string }) => Promise<Record<string, unknown>> = stub;
export const pollSessionMessages: (t: SessionMessageTransport, name: string) => Promise<Array<{ sender: { name: string } }>> = stub;
export const reportSessionMessageDelivered: (t: SessionMessageTransport, id: string, r: { channel: string; outcome?: string }) => Promise<Record<string, unknown>> = stub;
export const acknowledgeSessionMessage: (t: SessionMessageTransport, id: string) => Promise<Record<string, unknown>> = stub;
export const replySessionMessage: (t: SessionMessageTransport, i: { originalMessageId: string; envelope: unknown; replyToken: string; nextReplyToken: string }) => Promise<Record<string, unknown>> = stub;
export const readSessionMessageDelivery: (t: SessionMessageTransport, id: string) => Promise<Record<string, unknown> | null> = stub;
