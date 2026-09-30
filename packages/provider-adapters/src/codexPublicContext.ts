import { createHash } from 'node:crypto';
import { canonicalize } from '@dharma-ai-labs/agent-fabric-contracts';
import type { CodexAppServerTransport } from './codexAppServerSession.js';
import { containsCredential } from './codexTurnCapture.js';
import { stripProtectedNativeContent } from './index.js';

export interface CodexPublicContext {
  schema: 'dharma.codex-public-context/v1';
  threadId: string;
  capturedAt: string;
  configuredModel: string;
  configuredModelProvider: string;
  configuredReasoningEffort: string | null;
  executedModel: null;
  replayMode: 'task_level';
  limitations: ['public_history_only', 'executed_model_unreported'];
  turns: unknown[];
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('codex_public_context_invalid');
  return value as Record<string, unknown>;
}
function scopedThread(response: unknown, threadId: string, cwd: string, allowUnloaded = false) {
  const thread = object(object(response).thread);
  if (thread.id !== threadId || thread.cwd !== cwd
    || !['idle', ...(allowUnloaded ? ['notLoaded'] : [])].includes(String(object(thread.status).type))) {
    throw new Error('codex_public_context_scope_mismatch');
  }
  return thread;
}
function boundedName(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_.:/-]{1,200}$/.test(value) || containsCredential(value)) {
    throw new Error('codex_public_context_configuration_unavailable');
  }
  return value;
}

// Resume identifies this thread's configuration, not the model executed by a later turn.
// The owning runtime must hold its exclusive activation boundary throughout this call.
export async function readCodexPublicContext(transport: CodexAppServerTransport,
  scope: { threadId: string; workspaceRoot: string }): Promise<{ context: CodexPublicContext; contextHash: string; bytes: string }> {
  const first = scopedThread(await transport.request('thread/read', {
    threadId: scope.threadId, includeTurns: false }), scope.threadId, scope.workspaceRoot, true);
  if (Array.isArray(first.turns) && first.turns.some(turn => object(turn).status === 'inProgress')) {
    throw new Error('codex_public_context_active_turn');
  }
  const resumed = object(await transport.request('thread/resume', { threadId: scope.threadId }));
  scopedThread(resumed, scope.threadId, scope.workspaceRoot);
  const thread = scopedThread(await transport.request('thread/read', {
    threadId: scope.threadId, includeTurns: true }), scope.threadId, scope.workspaceRoot);
  if (!Array.isArray(thread.turns) || thread.turns.length > 2048
    || Buffer.byteLength(JSON.stringify(thread.turns)) > 2 * 1024 * 1024) throw new Error('codex_public_context_history_unavailable');
  const turns = thread.turns.map(value => {
    const turn = object(value);
    if (typeof turn.id !== 'string' || !['completed', 'failed', 'interrupted'].includes(String(turn.status))
      || !Array.isArray(turn.items)) throw new Error('codex_public_context_history_unavailable');
    return { id: turn.id, status: turn.status,
      items: turn.items.filter(item => object(item).type !== 'reasoning').map(stripProtectedNativeContent) };
  });
  if (containsCredential(turns)) throw new Error('codex_public_context_credentials_forbidden');
  const context: CodexPublicContext = { schema: 'dharma.codex-public-context/v1', threadId: scope.threadId,
    capturedAt: new Date().toISOString(), configuredModel: boundedName(resumed.model),
    configuredModelProvider: boundedName(resumed.modelProvider),
    configuredReasoningEffort: resumed.reasoningEffort == null ? null : boundedName(resumed.reasoningEffort),
    executedModel: null, replayMode: 'task_level', limitations: ['public_history_only', 'executed_model_unreported'], turns };
  const bytes = canonicalize(context);
  return { context, bytes, contextHash: `sha256:${createHash('sha256').update(bytes).digest('hex')}` };
}
