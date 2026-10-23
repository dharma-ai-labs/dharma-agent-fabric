import { randomUUID } from 'node:crypto';
import { canonicalize, inspectSessionQuestionForBinding, sha256, type SessionBindingScope, type SessionQuestion,
  type SessionQuestionVerifier } from '@dharma-ai-labs/agent-fabric-contracts';
import type { LocalProviderSessionIdentity, LocalVault, ScopedLocalVault } from '@dharma-ai-labs/agent-fabric-local-vault';
import { createProviderSessionChannel } from './providerSessionChannel.js';
import { reconcileProviderSessionReply } from './providerSessionReplyRecovery.js';
import { snapshotCooperativeSessionAnswer, type CooperativeSessionAnswer } from './cooperativeSessionSubmission.js';

export type { CooperativeSessionAnswer } from './cooperativeSessionSubmission.js';

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
  let handedOff: {offer: SessionQuestion; offerHash: string; attemptId: string} | null = null;
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
  async function retire() {
    if (running) throw new Error('cooperative_session_busy');
    let serverDetached = false;
    try { await requireOwner(); await channel.detach(); serverDetached = true; }
    finally {
      stop(); if (pulse) await pulse;
      try {await input.vault.revokeProviderSessionBinding(input.bindingId, input.identity);}
      finally {await release();}
    }
    return { serverDetached, consumerClosed: true as const };
  }
  async function drive(answerInCurrentSession?: (offer: SessionQuestion) => Promise<string>, submission?: CooperativeSessionAnswer) {
    if (stopped) throw new Error('cooperative_session_unavailable');
    if (running) throw new Error('cooperative_session_busy');
    if (handedOff && answerInCurrentSession) throw new Error('cooperative_session_handoff_pending');
    running = true;
    activeRun = new Promise<void>(resolve => { settle = resolve; });
    try {
      let submitted: CooperativeSessionAnswer | undefined;
      if (submission !== undefined) {
        submitted = snapshotCooperativeSessionAnswer(submission);
      }
      await requireOwner();
      if (submitted) {
        const held = handedOff;
        if (!held || submitted.questionId !== held.offer.questionId || submitted.taskId !== held.offer.taskId
          || submitted.nonce !== held.offer.nonce || submitted.offerHash !== held.offerHash
          || submitted.attemptId !== held.attemptId) throw new Error('cooperative_session_submission_mismatch');
        const key = input.verifier.resolvePublicKey(held.offer.signerKeyVersion);
        if (!key || key.type !== 'public') throw new Error('cooperative_session_signer_untrusted');
        const durable = await input.vault.readProviderSessionOfferCheckpoint(input.bindingId, input.identity,
          submitted.questionId, {version: held.offer.signerKeyVersion,
            publicKeyPem: key.export({type: 'spki', format: 'pem'}).toString()});
        const handoff = await input.vault.readProviderSessionOfferHandoff(input.bindingId, input.identity, submitted.questionId);
        await requireOwner(); requireOffer(held.offer);
        if (durable?.state !== 'recovery_required' || durable.offerHash !== held.offerHash
          || canonicalize(durable.question) !== canonicalize(held.offer)
          || handoff?.state !== 'handed_off' || handoff.attemptId !== held.attemptId
          || handoff.offerHash !== held.offerHash) throw new Error('cooperative_session_submission_mismatch');
        return await complete(held.offer, held.offerHash, submitted.answer, held.attemptId);
      }
      if (handedOff) return {state: 'checkpoint_pending' as const, questionId: handedOff.offer.questionId,
        taskId: handedOff.offer.taskId, offerHash: handedOff.offerHash, attemptId: handedOff.attemptId};
      const recovered = await reconcileProviderSessionReply({ vault: input.vault, bindingId: input.bindingId,
        identity: input.identity, channel, verifier: input.verifier });
      await requireOwner();
      if (recovered) { if (recovered.state === 'reply_pending') stop(); return recovered; }
      const pending = (await input.vault.listProviderSessionOfferCheckpoints(input.bindingId, input.identity))[0];
      await requireOwner();
      if (pending) {
        // Acceptance/computation may have crossed the crash boundary. The
        // encrypted offer is evidence for reconciliation, never a replay grant.
        stop();
        return {state: 'offer_recovery_required' as const, ...pending};
      }
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
      const key = input.verifier.resolvePublicKey(offer.signerKeyVersion);
      if (!key || key.type !== 'public') throw new Error('cooperative_session_signer_untrusted');
      const offerHash = await input.vault.stageProviderSessionOfferCheckpoint(input.bindingId, input.identity, offer, {
        version: offer.signerKeyVersion, publicKeyPem: key.export({type: 'spki', format: 'pem'}).toString(),
      });
      await requireOwner();
      requireOffer(offer);
      await channel.accept(offer.questionId, offer.taskId);
      await requireOwner();
      if (!await input.verifier.consume(offer.questionId)) throw new Error('cooperative_session_replayed');
      await requireOwner();
      requireOffer(offer);
      if (!answerInCurrentSession) {
        const attemptId = randomUUID();
        await input.vault.handoffProviderSessionOfferCheckpoint(input.bindingId, input.identity,
          offer.questionId, offerHash, attemptId);
        await requireOwner(); requireOffer(offer);
        handedOff = {offer, offerHash, attemptId};
        return Object.freeze({state: 'handed_off' as const, offer, offerHash, attemptId});
      }
      let answer: string;
      try { answer = await answerInCurrentSession(offer); }
      catch {
        await requireOwner(); requireOffer(offer);
        try {
          return await channel.reply({ questionId: offer.questionId, taskId: offer.taskId,
            outcome: 'failed', answer: '', failureCode: 'execution_failed' }, {expiresAt: offer.expiresAt});
        } catch { throw new Error('cooperative_session_failure_delivery_unconfirmed'); }
      }
      return await complete(offer, offerHash, answer);
    } catch (error) { stop(); throw error; }
    finally {
      running = false; settle?.(); settle = null; activeRun = null;
      if (stopped) await release();
    }
  }
  async function complete(offer: SessionQuestion, offerHash: string, answer: string, attemptId?: string) {
    await requireOwner(); requireOffer(offer);
    if (typeof answer !== 'string' || answer.trim().length === 0 || answer.length > 2000
      || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(answer)) {
      throw new Error('cooperative_session_answer_invalid');
    }
    const completionHash = await input.vault.stageProviderSessionReply(input.bindingId, input.identity,
      offer.questionId, Buffer.from(canonicalize({
        schema: attemptId ? 'dharma.provider-session-completion/v2' : 'dharma.provider-session-completion/v1',
        organizationId: scope.organizationId,
        repositoryBindingId: scope.repositoryBindingId, membershipId: scope.membershipId,
        deviceId: scope.deviceId, workspaceId: scope.workspaceId, endpointId: scope.endpointId,
        questionId: offer.questionId, taskId: offer.taskId, bindingId: scope.bindingId,
        targetEndpointId: scope.endpointId, answer, answerHash: sha256(answer),
        ...(attemptId ? {offerHash, nonce: offer.nonce, attemptId,
          nativeSessionId: binding!.sessionId, workspaceRootHash: sha256(binding!.workspaceRoot),
          createdAt: new Date().toISOString(),
          expiresAt: new Date(Math.min(Date.parse(offer.expiresAt), Date.parse(binding!.expiresAt))).toISOString()} : {}),
      }), 'utf8'));
    await requireOwner();
    requireOffer(offer);
    if (attemptId) {
      const current = await input.vault.readProviderSessionOfferHandoff(input.bindingId, input.identity, offer.questionId);
      await requireOwner(); requireOffer(offer);
      if (current?.state !== 'handed_off' || current.attemptId !== attemptId || current.offerHash !== offerHash) {
        throw new Error('cooperative_session_submission_mismatch');
      }
    }
    try {
      const receipt = await channel.reply({ questionId: offer.questionId, taskId: offer.taskId,
        outcome: 'answered', answer, failureCode: null }, {expiresAt: offer.expiresAt});
      await input.vault.acknowledgeProviderSessionOfferReply(input.bindingId, input.identity,
        offer.questionId, offerHash, completionHash);
      handedOff = null;
      return { ...receipt, completionHash };
    } catch {
      stop();
      return { state: 'reply_pending' as const, questionId: offer.questionId, taskId: offer.taskId, completionHash };
    }
  }
  return {close, retire,
    checkpoint: () => drive(),
    submitAnswer: async (submission: CooperativeSessionAnswer) => {
      if (!submission) throw new Error('cooperative_session_submission_invalid');
      return drive(undefined, submission);
    },
    runNext: async (answerInCurrentSession: (offer: SessionQuestion) => Promise<string>) => {
      if (typeof answerInCurrentSession !== 'function') throw new Error('cooperative_session_handler_invalid');
      return drive(answerInCurrentSession);
    },
  };
}
