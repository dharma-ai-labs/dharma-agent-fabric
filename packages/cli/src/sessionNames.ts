import type { KeyObject } from 'node:crypto';

export interface SessionMessageTransport {
  signedGet(route: string): Promise<Record<string, unknown>>;
  signedPost(route: string, body: unknown): Promise<Record<string, unknown>>;
}
export interface SessionMessagingDevice { organizationId: string; deviceId: string; privateKey: KeyObject }
export interface SessionMessagingHost {
  home: string; cwd: string; env: Record<string, string | undefined>; now(): Date;
  device(): Promise<SessionMessagingDevice>; transport(): Promise<SessionMessageTransport>;
}
export interface LocalSessionAttachment {
  schema: 'dharma.local-session-attachment/v1'; name: string; provider: 'codex' | 'claude';
  delivery: 'codex_queue' | 'claude_hook'; bindingId: string; organizationId: string; deviceId: string;
  membershipId: string | null; revision: number; pending: boolean; threadId?: string; claudeSessionId?: string;
  cwd?: string; updatedAt: string;
}
export async function sessionNamesCommand(_action: string, _flags: Map<string, string | boolean>,
  _host: SessionMessagingHost): Promise<Record<string, unknown>> { throw new Error('not_implemented'); }
export async function readSessionAttachment(_home: string, _name: string): Promise<LocalSessionAttachment | null> {
  throw new Error('not_implemented');
}
export async function recordClaudeSessionStart(_home: string, _record: { sessionId: string; cwd: string; at: string }) {
  throw new Error('not_implemented');
}
