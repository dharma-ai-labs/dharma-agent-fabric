import type { SessionQuestion } from '@dharma-ai-labs/agent-fabric-contracts';
import type { LocalProviderSessionIdentity } from '@dharma-ai-labs/agent-fabric-local-vault';
import { openCooperativeInboxSession } from './cooperativeInboxSession.js';

export interface OriginalSessionContext extends LocalProviderSessionIdentity {
  sessionId: string;
  workspaceRoot: string;
  state: 'ready' | 'busy' | 'pending_user' | 'stopped';
}

// Only the owning runtime can supply this port. Hook JSON, MCP arguments and
// caller-selected thread IDs are not an implementation of the host interface.
export interface OriginalSessionRuntimeHost {
  // Acquires only the calling runtime's current safe delivery slot. This is not
  // a request to select/resume a thread, answer a human prompt, or wake an idle chat.
  tryAcquireCurrentDelivery(): Promise<
    { state: 'busy' | 'pending_user' | 'stopped' } |
    { state: 'acquired'; lease: {
      assertHeld(): Promise<boolean>;
      currentSession(): Promise<OriginalSessionContext | null>;
      // The runtime must enforce the signed read paths/network policy, cost,
      // deadline and deliberate stops. Hook metadata alone is not this API.
      answerInCurrentSession(offer: SessionQuestion): Promise<{
        sessionId: string; questionId: string; taskId: string; nonce: string; answer: string;
      }>;
      release(): Promise<void>;
    } }
  >;
}

type ConsumerInput = Parameters<typeof openCooperativeInboxSession>[0];
type Consumer = Awaited<ReturnType<typeof openCooperativeInboxSession>>;
type ConsumerResult = Awaited<ReturnType<Consumer['runNext']>>;
export interface OriginalSessionHostInput extends Omit<ConsumerInput, 'currentSession'> {
  nativeSessionId: string;
  workspaceRoot: string;
  host: OriginalSessionRuntimeHost | null;
}
export type OriginalSessionHostResult = ConsumerResult |
  { state: 'not_supported'; reason: 'current_session_delivery_api_unavailable' | 'provider_in_session_consumer_unavailable' } |
  { state: 'deferred'; reason: 'busy' | 'pending_user' | 'stopped' };

export async function runOriginalSessionInboxOnce(input: OriginalSessionHostInput): Promise<OriginalSessionHostResult> {
  // The current cooperative consumer is Codex-specific. Do not manufacture a
  // Claude continuation by routing through a fresh provider or app-server.
  if (input.identity.provider !== 'codex') {
    return { state: 'not_supported', reason: 'provider_in_session_consumer_unavailable' };
  }
  const host = input.host;
  if (!host || typeof host.tryAcquireCurrentDelivery !== 'function') {
    return { state: 'not_supported', reason: 'current_session_delivery_api_unavailable' };
  }
  const identity = Object.freeze({ ...input.identity });
  const nativeSessionId = input.nativeSessionId, workspaceRoot = input.workspaceRoot;
  const bindingId = input.bindingId;
  const keys = ['organizationId', 'repositoryBindingId', 'workspaceId', 'endpointId',
    'membershipId', 'deviceId', 'provider'] as const;
  if (![bindingId, nativeSessionId, workspaceRoot, ...keys.map(key => identity[key])]
    .every(value => typeof value === 'string' && value.length > 0 && value.length <= 4096
      && !/[\u0000-\u001f\u007f]/.test(value))) {
    throw new Error('original_session_host_scope_invalid');
  }
  let acquired: Awaited<ReturnType<OriginalSessionRuntimeHost['tryAcquireCurrentDelivery']>>;
  try { acquired = await host.tryAcquireCurrentDelivery(); }
  catch { throw new Error('original_session_host_acquisition_unconfirmed'); }
  if (acquired?.state === 'busy' || acquired?.state === 'pending_user' || acquired?.state === 'stopped') {
    return { state: 'deferred', reason: acquired.state };
  }
  if (acquired?.state !== 'acquired' || !acquired.lease) {
    throw new Error('original_session_host_delivery_invalid');
  }
  const lease = acquired.lease;
  let consumer: Consumer | undefined;
  async function currentSession() {
    if (!await lease.assertHeld()) return null;
    const context = await lease.currentSession();
    if (!await lease.assertHeld() || !context || context.state !== 'ready'
      || context.sessionId !== nativeSessionId || context.workspaceRoot !== workspaceRoot
      || keys.some(key => context[key] !== identity[key])) return null;
    return { provider: 'codex' as const, sessionId: nativeSessionId, workspaceRoot, active: true };
  }
  async function requireOwner() {
    if (!await currentSession()) throw new Error('original_session_host_owner_unavailable');
  }
  try {
    if (['assertHeld', 'currentSession', 'answerInCurrentSession', 'release']
      .some(key => typeof lease[key as keyof typeof lease] !== 'function')) {
      throw new Error('original_session_host_delivery_invalid');
    }
    await requireOwner();
    const binding = await input.vault.getProviderSessionBinding(bindingId, identity);
    await requireOwner();
    if (!binding || binding.owner !== 'cooperative_session' || binding.bindingId !== bindingId
      || binding.sessionId !== nativeSessionId || binding.workspaceRoot !== workspaceRoot
      || keys.some(key => binding[key] !== identity[key])) {
      throw new Error('original_session_host_binding_mismatch');
    }
    consumer = await openCooperativeInboxSession({ ...input, bindingId, identity, currentSession });
    return await consumer.runNext(async offer => {
      await requireOwner();
      const answer = await lease.answerInCurrentSession(offer);
      await requireOwner();
      if (!answer || answer.sessionId !== nativeSessionId || answer.questionId !== offer.questionId
        || answer.taskId !== offer.taskId || answer.nonce !== offer.nonce) {
        throw new Error('original_session_host_answer_mismatch');
      }
      return answer.answer;
    });
  } catch {
    // A callback/transport may throw private diagnostics or may have crossed an
    // acceptance boundary. Preserve uncertainty without leaking or replaying it.
    throw new Error('original_session_host_operation_unconfirmed');
  } finally {
    let cleanupUnconfirmed = false;
    try { await consumer?.close(); } catch { cleanupUnconfirmed = true; }
    try {
      if (typeof lease.release !== 'function') cleanupUnconfirmed = true;
      else await lease.release();
    } catch { cleanupUnconfirmed = true; }
    if (cleanupUnconfirmed) throw new Error('original_session_host_cleanup_unconfirmed');
  }
}
