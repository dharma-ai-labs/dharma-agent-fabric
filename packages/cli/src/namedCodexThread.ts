import { isAbsolute, resolve } from 'node:path';
import type { CodexAppServerTransport } from '@dharma-ai-labs/agent-fabric-provider-adapters/experimental/codex-session';
import { CODEX_PEER_TOOLS } from './codexPeerTools.js';

export async function startNamedCodexThread(transport: CodexAppServerTransport, workspaceRoot: string, name: string) {
  if (!/^[a-z][a-z0-9-]{0,47}$/.test(name) || !isAbsolute(workspaceRoot) || resolve(workspaceRoot) !== workspaceRoot) {
    throw new Error('named_session_thread_invalid');
  }
  const created = await transport.request('thread/start', { cwd: workspaceRoot,
    approvalPolicy: 'never', permissions: 'dharma_bridge', ephemeral: false,
    dynamicTools: CODEX_PEER_TOOLS }) as { thread?: { id?: string; cwd?: string; status?: { type?: string } } };
  const thread = created?.thread;
  if (!thread || typeof thread.id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(thread.id)
    || thread.cwd !== workspaceRoot || thread.status?.type !== 'idle') throw new Error('named_session_thread_invalid');
  // Codex lazily persists an empty rollout; its supported naming call flushes it before remote registration.
  await transport.request('thread/name/set', { threadId: thread.id, name });
  const read = await transport.request('thread/read', { threadId: thread.id, includeTurns: false }) as {
    thread?: { id?: string; cwd?: string; name?: string; status?: { type?: string } };
  };
  if (read?.thread?.id !== thread.id || read.thread.cwd !== workspaceRoot || read.thread.name !== name
    || read.thread.status?.type !== 'idle') throw new Error('named_session_thread_invalid');
  return thread.id;
}
