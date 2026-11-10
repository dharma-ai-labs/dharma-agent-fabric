import type { KeyObject } from 'node:crypto';
import type { LocalSessionAttachment, SessionMessageTransport, SessionMessagingHost } from './sessionNames.js';
export interface CodexQueueResult { exitCode: number | null; stdout: string }
export interface CodexRolloutView {
  find(key: string): { turnId: string; outcome: 'processed' | 'aborted' | 'merged' | null } | null; idleSince: Date | null;
}
export interface CodexDeliveryPort {
  queue(threadId: string, message: string): Promise<CodexQueueResult>;
  pendingRow(threadId: string, key: string): Promise<boolean | 'unknown'>;
  rollout(threadId: string): Promise<CodexRolloutView>;
}
const no = (): never => { throw new Error('not_implemented'); };
export function parseCodexRollout(_text: string, _threadId: string): CodexRolloutView { return no(); }
export function createCodexDeliveryPort(_i: { codexHome: string; codexCommand: { file: string; args: string[] } }): CodexDeliveryPort { return no(); }
export async function watchCodexSessionOnce(_i: { host: SessionMessagingHost; attachment: LocalSessionAttachment; port: CodexDeliveryPort;
  transport: SessionMessageTransport; device: { organizationId: string; deviceId: string; privateKey: KeyObject } }):
  Promise<{ entries: Array<{ messageId: string; action: string }> }> { return no(); }
export async function sessionWatchCommand(_f: Map<string, string | boolean>, _h: SessionMessagingHost,
  _p?: (i: { codexHome: string }) => CodexDeliveryPort): Promise<Record<string, unknown>> { return no(); }
