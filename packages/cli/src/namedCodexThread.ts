import { isAbsolute, resolve } from 'node:path';
import type { CodexAppServerTransport } from '@dharma-ai-labs/agent-fabric-provider-adapters/experimental/codex-session';
import { CODEX_PEER_TOOLS } from './codexPeerTools.js';
import { CODEX_SETUP_TOOL } from './codexSetupAdmission.js';
import type {BootstrapHostScope} from './bootstrapHostScope.js';

export async function startNamedCodexThread(transport: CodexAppServerTransport, workspaceRoot: string, name: string) {
  return startThread(transport, workspaceRoot, name);
}

export async function startNamedCodexSetupThread(transport: CodexAppServerTransport,
  workspaceRoot: string, name: string, scope: BootstrapHostScope) {
  return startThread(transport, workspaceRoot, name, scope);
}

async function startThread(transport: CodexAppServerTransport, workspaceRoot: string,
  name: string, setupScope?: BootstrapHostScope) {
  const request = (method: string, params: Record<string, unknown>) => setupScope
    ? setupScope.step(() => transport.request(method, params)) : transport.request(method, params);
  if (!/^[a-z][a-z0-9-]{0,47}$/.test(name) || !isAbsolute(workspaceRoot) || resolve(workspaceRoot) !== workspaceRoot) {
    throw new Error('named_session_thread_invalid');
  }
  const created = await request('thread/start', { cwd: workspaceRoot,
    approvalPolicy: 'never', permissions: 'dharma_bridge', ephemeral: false,
    dynamicTools: setupScope ? structuredClone([...CODEX_PEER_TOOLS, CODEX_SETUP_TOOL]) : CODEX_PEER_TOOLS }) as { thread?: { id?: string; cwd?: string; status?: { type?: string } } };
  const thread = created?.thread;
  if (!thread || typeof thread.id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(thread.id)
    || thread.cwd !== workspaceRoot || thread.status?.type !== 'idle') throw new Error('named_session_thread_invalid');
  // Codex lazily persists an empty rollout; its supported naming call flushes it before remote registration.
  await request('thread/name/set', { threadId: thread.id, name });
  const read = await request('thread/read', { threadId: thread.id, includeTurns: false }) as {
    thread?: { id?: string; cwd?: string; name?: string; status?: { type?: string } };
  };
  if (read?.thread?.id !== thread.id || read.thread.cwd !== workspaceRoot || read.thread.name !== name
    || read.thread.status?.type !== 'idle') throw new Error('named_session_thread_invalid');
  return thread.id;
}
