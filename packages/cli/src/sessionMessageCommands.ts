import type { SessionMessage } from '@dharma-ai-labs/agent-fabric-contracts';
import type { SessionMessagingHost } from './sessionNames.js';
export async function sessionMessageCommand(_action: string, _flags: Map<string, string | boolean>,
  _host: SessionMessagingHost): Promise<Record<string, unknown>> { throw new Error('not_implemented'); }
export async function readReceivedSessionMessage(_home: string, _id: string):
  Promise<{ envelope: SessionMessage; replyToken: string | null } | null> { throw new Error('not_implemented'); }
