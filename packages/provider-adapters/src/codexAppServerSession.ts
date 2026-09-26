import { createHash } from 'node:crypto';
import { isAbsolute, resolve } from 'node:path';
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
}

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

async function assertRestrictedProfile(transport: CodexAppServerTransport, workspaceRoot: string) {
  const listed = object(await transport.request('permissionProfile/list', { cwd: workspaceRoot }));
  if (!Array.isArray(listed.data)
    || !listed.data.some(item => {
      try { const profile = object(item); return profile.id === 'dharma_bridge' && profile.allowed === true; }
      catch { return false; }
    })) throw new Error('codex_session_profile_unavailable');
  const config = object(object(await transport.request('config/read', { includeLayers: false })).config);
  const profile = object(object(config.permissions).dharma_bridge);
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
    || Object.keys(filesystem).some(key => !['glob_scan_max_depth', ':minimal', ':workspace_roots'].includes(key))
    || Object.keys(roots).length !== 1 || roots['.'] !== 'read'
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

export async function runCodexBridgeQuestion(input: {
  transport: CodexAppServerTransport;
  binding: CodexBridgeBinding;
  question: unknown;
  verifier: SessionQuestionVerifier;
  exclusiveLease: CodexSessionExclusiveLease;
  budget: CodexSessionBudget;
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
  const question = input.question as SessionQuestion;
  const timeoutMs = input.timeoutMs ?? 60_000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300_000) {
    throw new Error('codex_session_timeout_invalid');
  }
  await assertRestrictedProfile(transport, binding.workspaceRoot);
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
  const claimed = await verifySessionQuestionForBinding(question, binding, input.verifier, input.now ?? new Date());
  if (!claimed.ok) throw new Error(claimed.reason);

  const arrivals: unknown[] = [];
  let resolveArrival: ((value: unknown) => void) | null = null;
  const unsubscribe = transport.onNotification(event => {
    if (resolveArrival) {
      const resolvePending = resolveArrival;
      resolveArrival = null;
      resolvePending(event);
    } else if (arrivals.length < 64) arrivals.push(event);
  });
  let timer: NodeJS.Timeout | undefined;
  try {
    const started = object(await transport.request('turn/start', {
      threadId: binding.threadId,
      input: [{ type: 'text', text: `Repository question (${question.category}; task ${question.taskId}): ${question.question}\nAnswer only from authorized repository material. Do not modify files, use network access, or request broader permissions.` }],
      cwd: binding.workspaceRoot,
      approvalPolicy: 'never',
      permissions: 'dharma_bridge',
    }));
    const turnId = object(started.turn).id;
    if (typeof turnId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(turnId)) {
      throw new Error('codex_session_turn_invalid');
    }
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
      const answer = finalAnswer(turn);
      return {
        questionId: question.questionId, taskId: question.taskId,
        bindingId: binding.bindingId, targetEndpointId: binding.endpointId,
        answer, answerHash: `sha256:${createHash('sha256').update(answer).digest('hex')}`,
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
    if (timer) clearTimeout(timer);
    resolveArrival = null;
    unsubscribe();
  }
}
