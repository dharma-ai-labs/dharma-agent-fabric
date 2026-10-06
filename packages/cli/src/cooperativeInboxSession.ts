import { canonicalize, inspectSessionQuestionForBinding, sha256, type SessionBindingScope, type SessionQuestion,
  type SessionQuestionVerifier } from '@dharma-ai-labs/agent-fabric-contracts';
import type { LocalProviderSessionIdentity, LocalVault, ScopedLocalVault } from '@dharma-ai-labs/agent-fabric-local-vault';
import { createProviderSessionChannel } from './providerSessionChannel.js';
import { reconcileProviderSessionReply } from './providerSessionReplyRecovery.js';

export interface CooperativeSessionContext {
  provider: 'codex'; sessionId: string; workspaceRoot: string; active: boolean;
}

// The embedding agent owns this callback. No provider transport, external resume,
// fresh-worker fallback, desktop injection or idle-chat wake mechanism exists here.
export async function openCooperativeInboxSession(input: {
  vault: LocalVault | ScopedLocalVault; bindingId: string; identity: LocalProviderSessionIdentity;
  currentSession(): Promise<CooperativeSessionContext | null>;
  channelTransport: Parameters<typeof createProviderSessionChannel>[0]['transport'];
  verifier: SessionQuestionVerifier;
  budget: { reserve(input: { questionId: string; maximumCostCents: number }): Promise<boolean> };
  authorizeContent: Parameters<typeof createProviderSessionChannel>[0]['authorizeContent'];
}) {
  const binding = await input.vault.getProviderSessionBinding(input.bindingId, input.identity);
  if (!binding || binding.provider !== 'codex' || binding.owner !== 'cooperative_session') {
    throw new Error('cooperative_session_binding_unavailable');
  }
  const lease = await input.vault.tryAcquireProviderSessionLease(input.bindingId, input.identity);
  if (!lease) throw new Error('cooperative_session_lease_unavailable');
  let stopped = false, running = false, released = false;
  let releaseResult: Promise<void> | null = null;
  let settle: (() => void) | null = null, activeRun: Promise<void> | null = null;
  let pulse: Promise<void> | null = null;
  function release(): Promise<void> {
    if (released) return Promise.resolve();
    return releaseResult ??= Promise.resolve().then(() => lease!.release()).then(() => {released = true;})
      .finally(() => {releaseResult = null;});
  }
  async function assertOwner() {
    if (stopped || !await lease!.assertHeld()) return false;
    const context = await input.currentSession();
    return !stopped && await lease!.assertHeld() && context?.active === true
      && context.provider === binding!.provider && context.sessionId === binding!.sessionId
      && context.workspaceRoot === binding!.workspaceRoot;
  }
  async function requireOwner() {
    if (!await assertOwner()) throw new Error('cooperative_session_owner_lost');
  }
  const scope: SessionBindingScope = {
    organizationId: binding.organizationId, repositoryBindingId: binding.repositoryBindingId,
    workspaceId: binding.workspaceId, endpointId: binding.endpointId, membershipId: binding.membershipId,
    deviceId: binding.deviceId, bindingId: binding.bindingId, provider: binding.provider,
    expiresAt: binding.expiresAt, maximumProviderCostCents: binding.maximumProviderCostCents,
  };
  const channel = createProviderSessionChannel({ transport: input.channelTransport, scope, mode: 'cooperative',
    expectedRevision: 0, assertOwner, verifier: input.verifier, authorizeContent: input.authorizeContent });
  function requireOffer(offer: SessionQuestion) {
    const inspected = inspectSessionQuestionForBinding(offer, scope, input.verifier, new Date());
    if (!inspected.ok) throw new Error(`cooperative_session_${inspected.reason}`);
  }
  try { await requireOwner(); await channel.reconnect(); }
  catch (error) { stopped = true; await release(); throw error; }
  const timer = setInterval(() => {
    if (stopped || pulse) return;
    pulse = channel.heartbeat().then(() => undefined).catch(() => {
      stopped = true; clearInterval(timer);
      // Failed cooperative cleanup remains retryable by close; never claim it settled.
      if (!running) void release().catch(() => undefined);
    }).finally(() => { pulse = null; });
  }, 20_000);
  timer.unref();
  function stop() { stopped = true; clearInterval(timer); }
  async function close() {
    stop();
    if (pulse) await pulse;
    if (activeRun) await activeRun;
    await release();
    return { serverDetached: false, consumerClosed: true as const };
  }
  return {
    close,
    async retire() {
      if (running) throw new Error('cooperative_session_busy');
      let serverDetached = false;
      try { await requireOwner(); await channel.detach(); serverDetached = true; }
      finally {
        stop(); if (pulse) await pulse;
        try {await input.vault.revokeProviderSessionBinding(input.bindingId, input.identity);}
        finally {await release();}
      }
      return { serverDetached, consumerClosed: true as const };
    },
    async runNext(answerInCurrentSession: (offer: SessionQuestion) => Promise<string>) {
      if (stopped) throw new Error('cooperative_session_unavailable');
      if (running) throw new Error('cooperative_session_busy');
      running = true;
      activeRun = new Promise<void>(resolve => { settle = resolve; });
      try {
        await requireOwner();
        const recovered = await reconcileProviderSessionReply({ vault: input.vault, bindingId: input.bindingId,
          identity: input.identity, channel });
        await requireOwner();
        if (recovered) { if (recovered.state === 'reply_pending') stop(); return recovered; }
        const offer = (await channel.inbox())[0];
        if (!offer) return { state: 'idle' as const };
        Object.freeze(offer.authority.readPaths); Object.freeze(offer.authority);
        Object.freeze(offer.source); Object.freeze(offer.target); Object.freeze(offer);
        await requireOwner();
        // Content authorization and reserved cost must precede acceptance and the
        // durable replay claim. Delivery cannot authorize broader chat actions.
        if (!await input.authorizeContent(offer.question, 'question')) {
          throw new Error('cooperative_session_content_denied');
        }
        await requireOwner();
        const reserved = await input.budget.reserve({ questionId: offer.questionId,
          maximumCostCents: offer.authority.maximumProviderCostCents });
        await requireOwner();
        if (!reserved) return { state: 'budget_denied' as const, questionId: offer.questionId, taskId: offer.taskId };
        requireOffer(offer);
        await channel.accept(offer.questionId, offer.taskId);
        await requireOwner();
        if (!await input.verifier.consume(offer.questionId)) throw new Error('cooperative_session_replayed');
        await requireOwner();
        requireOffer(offer);
        let answer: string;
        try { answer = await answerInCurrentSession(offer); }
        catch {
          await requireOwner(); requireOffer(offer);
          try {
            return await channel.reply({ questionId: offer.questionId, taskId: offer.taskId,
              outcome: 'failed', answer: '', failureCode: 'execution_failed' });
          } catch { throw new Error('cooperative_session_failure_delivery_unconfirmed'); }
        }
        await requireOwner();
        requireOffer(offer);
        if (typeof answer !== 'string' || answer.trim().length === 0 || answer.length > 2000
          || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(answer)) {
          throw new Error('cooperative_session_answer_invalid');
        }
        const completionHash = await input.vault.stageProviderSessionReply(input.bindingId, input.identity,
          offer.questionId, Buffer.from(canonicalize({
            schema: 'dharma.provider-session-completion/v1', organizationId: scope.organizationId,
            repositoryBindingId: scope.repositoryBindingId, membershipId: scope.membershipId,
            deviceId: scope.deviceId, workspaceId: scope.workspaceId, endpointId: scope.endpointId,
            questionId: offer.questionId, taskId: offer.taskId, bindingId: scope.bindingId,
            targetEndpointId: scope.endpointId, answer, answerHash: sha256(answer),
          }), 'utf8'));
        await requireOwner();
        try {
          const receipt = await channel.reply({ questionId: offer.questionId, taskId: offer.taskId,
            outcome: 'answered', answer, failureCode: null });
          await input.vault.acknowledgeProviderSessionReply(input.bindingId, input.identity, offer.questionId, completionHash);
          return { ...receipt, completionHash };
        } catch {
          stop();
          return { state: 'reply_pending' as const, questionId: offer.questionId, taskId: offer.taskId, completionHash };
        }
      } catch (error) { stop(); throw error; }
      finally {
        running = false; settle?.(); settle = null; activeRun = null;
        if (stopped) await release();
      }
    },
  };
}
