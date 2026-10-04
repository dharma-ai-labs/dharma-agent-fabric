import { createHash } from 'node:crypto';
import { isAbsolute, resolve } from 'node:path';
import { assertCodexWorkPrompt, createCodexTurnCapture, type CodexTurnEvidenceSink, type CodexWorkRequest } from './codexTurnCapture.js';
export type { CodexLocalWorkCapture, CodexTurnEvidenceSink } from './codexTurnCapture.js';
export { assertCodexWorkPrompt, codexWorkCaptureSchemaId, containsCredential } from './codexTurnCapture.js';
export { readCodexPublicContext } from './codexPublicContext.js';
export type { CodexPublicContext } from './codexPublicContext.js';
import {
  inspectSessionQuestionForBinding,
  verifySessionQuestionForBinding,
  type SessionBindingScope,
  type SessionQuestion,
  type SessionQuestionVerifier,
} from '@dharma-ai-labs/agent-fabric-contracts';

export interface CodexAppServerTransport {
  request(method: string, params: Record<string, unknown>): Promise<unknown>;
  onNotification(listener: (event: unknown) => void): () => void;
  onToolCall?(handler: CodexToolHandler): () => void;
}

export type CodexToolResult = { success: boolean; contentItems: Array<{ type: 'inputText'; text: string }> };
export type CodexToolHandler = (params: Record<string, unknown>, context?: { signal: AbortSignal }) => Promise<CodexToolResult>;

export interface CodexBridgeBinding extends SessionBindingScope {
  owner: string;
  threadId: string;
  workspaceRoot: string;
}

export interface CodexSessionExclusiveLease {
  assertHeld(): Promise<boolean>;
}

export interface CodexSessionBudget {
  // The caller must use a durable, idempotent reservation keyed by questionId.
  reserve(questionId: string, maximumProviderCostCents: number): Promise<boolean>;
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('codex_session_response_invalid');
  return value as Record<string, unknown>;
}

function scopedThread(value: unknown, threadId: string) {
  const thread = object(object(value).thread);
  if (thread.id !== threadId) throw new Error('codex_session_thread_mismatch');
  return thread;
}

async function assertRestrictedProfile(transport: CodexAppServerTransport, workspaceRoot: string,
  name: 'dharma_bridge' | 'dharma_work' = 'dharma_bridge', writeRoots: string[] = [],
  additionalFilesystemRules: Readonly<Record<string, 'read' | 'deny'>> = {}) {
  // Only trusted runtime preparation supplies these exact public-code/private-home rules.
  for (const [path, access] of Object.entries(additionalFilesystemRules)) {
    if (!isAbsolute(path) || resolve(path) !== path || /[\u0000-\u001f\u007f]/.test(path)
      || (access !== 'read' && access !== 'deny')) throw new Error('codex_session_profile_unavailable');
  }
  const expectedRoots: Record<string, string> = { '.': 'read' };
  for (const root of writeRoots) {
    if (!/^(?:\.|[a-zA-Z0-9_-]+)$/.test(root)) throw new Error('codex_session_profile_unavailable');
    expectedRoots[root] = 'write';
  }
  const listed = object(await transport.request('permissionProfile/list', { cwd: workspaceRoot }));
  if (!Array.isArray(listed.data)
    || !listed.data.some(item => {
      try { const profile = object(item); return profile.id === name && profile.allowed === true; }
      catch { return false; }
    })) throw new Error('codex_session_profile_unavailable');
  const config = object(object(await transport.request('config/read', { includeLayers: false })).config);
  const profile = object(object(config.permissions)[name]);
  const filesystem = object(profile.filesystem);
  const roots = object(filesystem[':workspace_roots']);
  const network = object(profile.network);
  const disabledNetworkOptions = ['domains', 'unix_sockets', 'proxy_url', 'socks_url', 'enable_socks5',
    'enable_socks5_udp', 'allow_upstream_proxy', 'dangerously_allow_non_loopback_proxy',
    'dangerously_allow_all_unix_sockets', 'mode', 'allow_local_binding', 'mitm'];
  if (Object.keys(profile).some(key => !['description', 'extends', 'workspace_roots', 'filesystem', 'network'].includes(key))
    || (profile.description != null && (typeof profile.description !== 'string' || profile.description.length > 1000))
    || profile.extends != null || profile.workspace_roots != null
    || filesystem[':minimal'] !== 'read'
    || Object.keys(filesystem).some(key => !['glob_scan_max_depth', ':minimal', ':workspace_roots'].includes(key)
      && !Object.hasOwn(additionalFilesystemRules, key))
    || Object.entries(additionalFilesystemRules).some(([key, access]) => filesystem[key] !== access)
    || Object.keys(roots).length !== Object.keys(expectedRoots).length
    || Object.entries(expectedRoots).some(([key, access]) => roots[key] !== access)
    || network.enabled !== false
    || Object.keys(network).some(key => key !== 'enabled'
      && (!disabledNetworkOptions.includes(key) || network[key] != null))) {
    throw new Error('codex_session_profile_unavailable');
  }
}

function completedTurn(event: unknown, threadId: string, turnId: string): Record<string, unknown> | null {
  try {
    const message = object(event);
    if (message.method !== 'turn/completed') return null;
    const params = object(message.params);
    if (params.threadId !== threadId) return null;
    const turn = object(params.turn);
    return turn.id === turnId ? turn : null;
  } catch { return null; }
}

function finalAnswer(turn: Record<string, unknown>): string {
  if (turn.status !== 'completed' || !Array.isArray(turn.items)) throw new Error('codex_session_turn_failed');
  const finals = turn.items.filter(item => {
    try {
      const message = object(item);
      return message.type === 'agentMessage' && message.phase === 'final_answer';
    } catch { return false; }
  });
  const last = finals.at(-1);
  const answer = last ? object(last).text : null;
  if (typeof answer !== 'string' || !answer.trim() || answer.length > 8_000
    || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(answer)) {
    throw new Error('codex_session_answer_missing_or_invalid');
  }
  return answer;
}

export interface CodexTokenUsageBreakdown {
  inputTokens: number; cachedInputTokens: number; outputTokens: number;
  reasoningOutputTokens: number; totalTokens: number; cacheWriteInputTokens?: number;
}

export interface CodexProviderUsage {
  total: CodexTokenUsageBreakdown; last: CodexTokenUsageBreakdown; modelContextWindow: number | null;
}

function providerUsage(value: unknown): CodexProviderUsage | null {
  try {
    const usage = object(value);
    const breakdown = (value: unknown): CodexTokenUsageBreakdown => {
      const counters = object(value);
      const keys = ['inputTokens', 'cachedInputTokens', 'outputTokens', 'reasoningOutputTokens', 'totalTokens'];
      if (keys.some(key => !Number.isSafeInteger(counters[key]) || Number(counters[key]) < 0)
        || counters.cacheWriteInputTokens != null && (!Number.isSafeInteger(counters.cacheWriteInputTokens)
          || Number(counters.cacheWriteInputTokens) < 0)) throw new Error('invalid_usage');
      return Object.fromEntries([...keys, ...(counters.cacheWriteInputTokens != null ? ['cacheWriteInputTokens'] : [])]
        .map(key => [key, counters[key]])) as unknown as CodexTokenUsageBreakdown;
    };
    if (usage.modelContextWindow != null && (!Number.isSafeInteger(usage.modelContextWindow)
      || Number(usage.modelContextWindow) < 1)) return null;
    return { total: breakdown(usage.total), last: breakdown(usage.last),
      modelContextWindow: usage.modelContextWindow == null ? null : Number(usage.modelContextWindow) };
  } catch { return null; }
}

export class CodexSessionAnswerTooLargeError extends Error {
  readonly result!: Awaited<ReturnType<typeof runScopedTurn>>;
  constructor(result: Awaited<ReturnType<typeof runScopedTurn>>) {
    super('codex_session_answer_too_large');
    this.name = 'CodexSessionAnswerTooLargeError';
    Object.defineProperty(this, 'result', { value: result, enumerable: false });
  }
}

export async function runCodexBridgeQuestion(input: {
  transport: CodexAppServerTransport;
  binding: CodexBridgeBinding;
  question: unknown;
  verifier: SessionQuestionVerifier;
  exclusiveLease: CodexSessionExclusiveLease;
  budget: CodexSessionBudget;
  additionalFilesystemRules?: Readonly<Record<string, 'read' | 'deny'>>;
  now?: Date;
  timeoutMs?: number;
}) {
  const { transport, binding } = input;
  const now = input.now ?? new Date();
  if (binding.owner !== 'dharma_bridge' || binding.provider !== 'codex'
    || !/^[A-Za-z0-9_-]{1,128}$/.test(binding.threadId)
    || !isAbsolute(binding.workspaceRoot) || resolve(binding.workspaceRoot) !== binding.workspaceRoot) {
    throw new Error('codex_session_binding_invalid');
  }
  const inspected = inspectSessionQuestionForBinding(input.question, binding, input.verifier, now);
  if (!inspected.ok) throw new Error(inspected.reason);
  if (!await input.exclusiveLease.assertHeld()) throw new Error('codex_session_lease_unavailable');
  // A declared permission profile did not enforce the native Windows boundary.
  // Admit only the host whose read/write/network isolation was exercised live.
  if (process.platform !== 'linux') throw new Error('codex_session_sandbox_unqualified');
  const question = input.question as SessionQuestion;
  const timeoutMs = input.timeoutMs ?? 60_000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300_000) {
    throw new Error('codex_session_timeout_invalid');
  }
  await assertRestrictedProfile(transport, binding.workspaceRoot, 'dharma_bridge', [], input.additionalFilesystemRules);
  const read = scopedThread(await transport.request('thread/read', {
    threadId: binding.threadId, includeTurns: false,
  }), binding.threadId);
  if (read.cwd !== binding.workspaceRoot) throw new Error('codex_session_workspace_mismatch');
  const status = object(read.status).type;
  if (status !== 'idle' && status !== 'notLoaded') throw new Error('codex_session_unavailable');
  // A thread created in this transport is already loaded, even before it has a rollout.
  if (status === 'notLoaded') {
    const resumed = scopedThread(await transport.request('thread/resume', {
      threadId: binding.threadId,
    }), binding.threadId);
    if (resumed.cwd !== binding.workspaceRoot) throw new Error('codex_session_workspace_mismatch');
    if (object(resumed.status).type !== 'idle') throw new Error('codex_session_unavailable');
  }
  if (!await input.exclusiveLease.assertHeld()) throw new Error('codex_session_lease_unavailable');
  if (!await input.budget.reserve(question.questionId, question.authority.maximumProviderCostCents)) {
    throw new Error('codex_session_budget_unavailable');
  }
  if (!await input.exclusiveLease.assertHeld()) throw new Error('codex_session_lease_unavailable');
  const claimed = await verifySessionQuestionForBinding(question, binding, input.verifier, input.now ?? new Date());
  if (!claimed.ok) throw new Error(claimed.reason);
  if (!await input.exclusiveLease.assertHeld()) throw new Error('codex_session_lease_unavailable');

  const result = await runScopedTurn({ ...input, timeoutMs, permissions: 'dharma_bridge',
    prompt: `Repository question (${question.category}; task ${question.taskId}): ${question.question}\nAnswer only from authorized repository material in at most 2000 characters. Do not modify files, use network access, or request broader permissions.` });
  if (result.answer.length > 2000) throw new CodexSessionAnswerTooLargeError(result);
  return { questionId: question.questionId, taskId: question.taskId,
    bindingId: binding.bindingId, targetEndpointId: binding.endpointId, ...result };
}

export async function runCodexLocalWork(input: {
  transport: CodexAppServerTransport;
  binding: CodexBridgeBinding;
  exclusiveLease: CodexSessionExclusiveLease;
  budget: CodexSessionBudget;
  workId: string;
  prompt: string;
  maximumProviderCostCents: number;
  writeRoots: string[];
  additionalFilesystemRules?: Readonly<Record<string, 'read' | 'deny'>>;
  toolHandler?: CodexToolHandler;
  timeoutMs?: number;
  onTurnEvidence?: CodexTurnEvidenceSink;
}) {
  assertCodexWorkPrompt(input.prompt);
  const { binding, transport } = input;
  if (process.platform !== 'linux') throw new Error('codex_session_sandbox_unqualified');
  if (binding.owner !== 'dharma_bridge' || binding.provider !== 'codex'
    || !/^[A-Za-z0-9_-]{1,128}$/.test(binding.threadId)
    || !isAbsolute(binding.workspaceRoot) || resolve(binding.workspaceRoot) !== binding.workspaceRoot
    || !Number.isFinite(Date.parse(binding.expiresAt)) || Date.parse(binding.expiresAt) <= Date.now()) {
    throw new Error('codex_session_binding_invalid');
  }
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(input.workId) || !input.prompt.trim() || input.prompt.length > 16000
    || !Number.isInteger(input.maximumProviderCostCents) || input.maximumProviderCostCents < 1
    || input.maximumProviderCostCents > binding.maximumProviderCostCents) throw new Error('codex_session_work_invalid');
  const timeoutMs = input.timeoutMs ?? 300_000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300_000) throw new Error('codex_session_timeout_invalid');
  if (!await input.exclusiveLease.assertHeld()) throw new Error('codex_session_lease_unavailable');
  if (!Array.isArray(input.writeRoots) || !input.writeRoots.length) throw new Error('codex_session_work_invalid');
  if (input.toolHandler && !transport.onToolCall) throw new Error('codex_session_tool_handler_unavailable');
  await assertRestrictedProfile(transport, binding.workspaceRoot, 'dharma_work', input.writeRoots, input.additionalFilesystemRules);
  const read = scopedThread(await transport.request('thread/read', {
    threadId: binding.threadId, includeTurns: false,
  }), binding.threadId);
  if (read.cwd !== binding.workspaceRoot) throw new Error('codex_session_workspace_mismatch');
  const status = object(read.status).type;
  if (status !== 'idle' && status !== 'notLoaded') throw new Error('codex_session_unavailable');
  if (status === 'notLoaded') {
    const resumed = scopedThread(await transport.request('thread/resume', { threadId: binding.threadId }), binding.threadId);
    if (resumed.cwd !== binding.workspaceRoot || object(resumed.status).type !== 'idle') throw new Error('codex_session_unavailable');
  }
  if (!await input.exclusiveLease.assertHeld()) throw new Error('codex_session_lease_unavailable');
  if (!await input.budget.reserve(input.workId, input.maximumProviderCostCents)) throw new Error('codex_session_budget_unavailable');
  if (!await input.exclusiveLease.assertHeld()) throw new Error('codex_session_lease_unavailable');
  const capture = input.onTurnEvidence ? createCodexTurnCapture(binding, input.workId) : undefined;
  let workOutcome: 'completed' | 'failed' = 'failed';
  try {
    const result = await runScopedTurn({ ...input, capture, timeoutMs, permissions: 'dharma_work',
      prompt: `Local coding work ${input.workId}: ${input.prompt}\nConsult the installed Agent Fabric manifest, knowledge catalog, lexicon and applicable skills before relevant work. Work only in this repository. Network and broader permissions are unavailable. Report changes and actual test outcomes.` });
    workOutcome = 'completed';
    return { workId: input.workId, bindingId: binding.bindingId, ...result };
  } finally {
    if (capture) {
      try { await input.onTurnEvidence!(capture.finish(workOutcome)); }
      catch { throw new Error('codex_session_evidence_persistence_failed'); }
    }
  }
}

async function runScopedTurn(input: {
  transport: CodexAppServerTransport; binding: CodexBridgeBinding;
  exclusiveLease: CodexSessionExclusiveLease; timeoutMs: number;
  toolHandler?: CodexToolHandler;
  permissions: 'dharma_bridge' | 'dharma_work'; prompt: string;
  capture?: ReturnType<typeof createCodexTurnCapture>;
}) {
  const { transport, binding, timeoutMs } = input;

  const startedAt = Date.now();
  let activeTurnId: string | null = null;
  const calls = new Set<string>();
  const removeTools = input.permissions === 'dharma_work' && input.toolHandler && transport.onToolCall
    ? transport.onToolCall(async (params, context) => {
      if (context?.signal.aborted || !activeTurnId || params.threadId !== binding.threadId || params.turnId !== activeTurnId
        || typeof params.callId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(params.callId)
        || calls.has(params.callId) || calls.size >= 8 || !await input.exclusiveLease.assertHeld() || context?.signal.aborted) {
        return { success: false, contentItems: [{ type: 'inputText', text: 'codex_session_tool_not_authorized' }] };
      }
      calls.add(params.callId);
      const result = await input.toolHandler!(params, context);
      return !context?.signal.aborted && activeTurnId === params.turnId && await input.exclusiveLease.assertHeld() && !context?.signal.aborted
        ? result : { success: false, contentItems: [{ type: 'inputText', text: 'codex_session_tool_not_authorized' }] };
    }) : undefined;
  const usageByTurn = new Map<string, CodexProviderUsage | null>();
  const finalItemsByTurn = new Map<string, Map<string, Record<string, unknown>>>();
  const conflictingFinalTurns = new Set<string>();
  const arrivals: unknown[] = [];
  let resolveArrival: ((value: unknown) => void) | null = null;
  const unsubscribe = transport.onNotification(event => {
    input.capture?.observe(event);
    try {
      const notification = object(event), params = object(notification.params);
      if (params.threadId !== binding.threadId) return;
      if (notification.method === 'item/completed' && typeof params.turnId === 'string') {
        const item = object(params.item);
        if (item.type === 'agentMessage' && item.phase === 'final_answer'
          && typeof item.id === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(item.id)) {
          let items = finalItemsByTurn.get(params.turnId);
          if (!items && finalItemsByTurn.size < 32) {
            items = new Map(); finalItemsByTurn.set(params.turnId, items);
          }
          if (items) {
            if (typeof item.text !== 'string' || !item.text.trim() || item.text.length > 8000
              || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(item.text)) {
              conflictingFinalTurns.add(params.turnId); return;
            }
            const previous = items.get(item.id);
            if (previous && previous.text !== item.text) conflictingFinalTurns.add(params.turnId);
            else if (items.size < 16) items.set(item.id, item);
            else conflictingFinalTurns.add(params.turnId);
          }
        }
        return;
      }
      if (notification.method === 'thread/tokenUsage/updated') {
        if (typeof params.turnId === 'string' && usageByTurn.size < 32) {
          usageByTurn.set(params.turnId, providerUsage(params.tokenUsage));
        }
        return;
      }
      // Streaming deltas must not crowd out the exact completion notification.
      if (notification.method !== 'turn/completed') return;
    } catch { return; }
    if (resolveArrival) {
      const resolvePending = resolveArrival;
      resolveArrival = null;
      resolvePending(event);
    } else if (arrivals.length < 64) arrivals.push(event);
  });
  let timer: NodeJS.Timeout | undefined;
  try {
    const params = {
      threadId: binding.threadId,
      input: [{ type: 'text', text: input.prompt }] as [{ type: 'text'; text: string }],
      cwd: binding.workspaceRoot,
      approvalPolicy: 'never' as const,
      permissions: input.permissions,
    };
    if (input.capture) input.capture.retainRequest(params as CodexWorkRequest['params']);
    const started = object(await transport.request('turn/start', params));
    const turnId = object(started.turn).id;
    if (typeof turnId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(turnId)) {
      throw new Error('codex_session_turn_invalid');
    }
    activeTurnId = turnId;
    input.capture?.bind(turnId);
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const event = arrivals.shift() ?? await Promise.race([
        new Promise<unknown>(resolveEvent => { resolveArrival = resolveEvent; }),
        new Promise<null>(resolveTimeout => { timer = setTimeout(() => resolveTimeout(null), deadline - Date.now()); }),
      ]);
      if (timer) { clearTimeout(timer); timer = undefined; }
      if (event === null) break;
      const turn = completedTurn(event, binding.threadId, turnId);
      if (!turn) continue;
      if (!await input.exclusiveLease.assertHeld()) throw new Error('codex_session_lease_unavailable');
      if (conflictingFinalTurns.has(turnId)) throw new Error('codex_session_answer_missing_or_invalid');
      // Codex may omit items from the terminal event; use only completed live items from this exact turn.
      const completed = Array.isArray(turn.items) && turn.items.length === 0
        ? { ...turn, items: [...(finalItemsByTurn.get(turnId)?.values() ?? [])] } : turn;
      const answer = finalAnswer(completed);
      return {
        answer, answerHash: `sha256:${createHash('sha256').update(answer).digest('hex')}`,
        providerThreadId: binding.threadId, providerTurnId: turnId, elapsedMs: Date.now() - startedAt,
        // Total is cumulative thread usage; last is the last request, not a billed turn cost.
        providerUsage: usageByTurn.get(turnId) ?? null,
      };
    }
    try {
      await Promise.race([
        transport.request('turn/interrupt', { threadId: binding.threadId, turnId }),
        new Promise(resolveTimeout => setTimeout(resolveTimeout, 1_000)),
      ]);
    } catch { /* The timeout remains unconfirmed; never report a completed answer. */ }
    throw new Error('codex_session_turn_timeout');
  } finally {
    activeTurnId = null;
    removeTools?.();
    if (timer) clearTimeout(timer);
    resolveArrival = null;
    unsubscribe();
  }
}
