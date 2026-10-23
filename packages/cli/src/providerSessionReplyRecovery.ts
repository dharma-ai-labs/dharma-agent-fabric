import { resolve } from 'node:path';
import { canonicalize, inspectSessionQuestionForBinding, sha256, validateContract,
  type SessionQuestion, type SessionQuestionVerifier } from '@dharma-ai-labs/agent-fabric-contracts';
import type { LocalProviderSessionIdentity, LocalVault, ScopedLocalVault } from '@dharma-ai-labs/agent-fabric-local-vault';
import type { createProviderSessionChannel } from './providerSessionChannel.js';
import { NamedPeerContentAuthorizationError } from './namedPeerContentAuthorization.js';
import { providerSessionDispatchDeadline, requireProviderSessionDispatch, snapshotProviderSessionDispatchContext,
  type ProviderSessionDispatchContext } from './providerSessionDispatchContext.js';

interface Completion {
  schema: 'dharma.provider-session-completion/v1'; organizationId: string; repositoryBindingId: string;
  membershipId: string; deviceId: string; workspaceId: string; endpointId: string;
  questionId: string; taskId: string; bindingId: string; targetEndpointId: string; answer: string; answerHash: string;
}

interface SplitCompletion extends Omit<Completion, 'schema'> {
  schema: 'dharma.provider-session-completion/v2'; offerHash: string; nonce: string;
  attemptId: string; nativeSessionId: string; workspaceRootHash: string; createdAt: string; expiresAt: string;
}

// Reconcile one durable result before admitting more provider work. This function
// has no provider transport or budget API, so upload recovery cannot rerun a turn.
export async function reconcileProviderSessionReply(input: {
  vault: LocalVault | ScopedLocalVault; bindingId: string; identity: LocalProviderSessionIdentity;
  channel: Pick<ReturnType<typeof createProviderSessionChannel>, 'read' | 'reply'>;
  verifier?: SessionQuestionVerifier;
  context?: ProviderSessionDispatchContext;
}) {
  const context = snapshotProviderSessionDispatchContext(input.context);
  requireProviderSessionDispatch(context);
  const pending = (await input.vault.listProviderSessionReplies(input.bindingId, input.identity))[0];
  requireProviderSessionDispatch(context);
  if (!pending) return null;
  const bytes = await input.vault.getBlob(pending.completionHash);
  if (bytes.length > 16384) throw new Error('provider_session_completion_invalid');
  let value: unknown;
  try { value = JSON.parse(bytes.toString('utf8')); }
  catch { throw new Error('provider_session_completion_invalid'); }
  const version = (value as {schema?: unknown} | null)?.schema === 'dharma.provider-session-completion/v2' ? 'v2' : 'v1';
  const contract = await validateContract(resolve(import.meta.dirname, 'schemas'),
    `https://schemas.dharma-ai.io/provider-session-completion/${version}`, value);
  if (!contract.ok) throw new Error('provider_session_completion_invalid');
  const completion = value as Completion | SplitCompletion;
  const binding = await input.vault.getProviderSessionBinding(input.bindingId, input.identity);
  if (!binding
    || completion.bindingId !== input.bindingId || completion.questionId !== pending.questionId
    || ['organizationId', 'repositoryBindingId', 'membershipId', 'deviceId', 'workspaceId', 'endpointId']
      .some(key => completion[key as keyof Completion] !== input.identity[key as keyof LocalProviderSessionIdentity])
    || completion.targetEndpointId !== input.identity.endpointId || completion.answerHash !== sha256(completion.answer)) {
    throw new Error('provider_session_completion_scope_mismatch');
  }
  let replyExpiresAt: string | undefined;
  if (completion.schema === 'dharma.provider-session-completion/v2') {
    const handoff = await input.vault.readProviderSessionOfferHandoff(input.bindingId, input.identity, completion.questionId);
    let offer: SessionQuestion;
    try {
      const offerBytes = await input.vault.getBlob(completion.offerHash);
      if (!input.verifier || offerBytes.length > 16384 || sha256(offerBytes) !== completion.offerHash) throw new Error();
      offer = JSON.parse(offerBytes.toString('utf8')) as SessionQuestion;
      if (canonicalize(offer) !== offerBytes.toString('utf8')
        || !inspectSessionQuestionForBinding(offer, binding, input.verifier, new Date(offer.createdAt)).ok
        || handoff?.state !== 'handed_off' || handoff.offerHash !== completion.offerHash
        || handoff.attemptId !== completion.attemptId || offer.questionId !== completion.questionId
        || offer.taskId !== completion.taskId || offer.nonce !== completion.nonce
        || completion.nativeSessionId !== binding.sessionId || completion.workspaceRootHash !== sha256(binding.workspaceRoot)
        || Date.parse(completion.expiresAt) !== Math.min(Date.parse(offer.expiresAt), Date.parse(binding.expiresAt))
        || Date.parse(completion.createdAt) >= Date.parse(completion.expiresAt)) throw new Error();
    } catch {throw new Error('provider_session_completion_handoff_mismatch');}
    replyExpiresAt = completion.expiresAt;
  }
  let observed: Awaited<ReturnType<typeof input.channel.read>>;
  try {
    requireProviderSessionDispatch(context);
    observed = await input.channel.read(completion.questionId, completion.taskId, completion.bindingId, context);
    requireProviderSessionDispatch(context);
    if (observed.state === 'accepted' && (!replyExpiresAt || Date.now() < Date.parse(replyExpiresAt))) {
      await input.channel.reply({ questionId: completion.questionId, taskId: completion.taskId,
        outcome: 'answered', answer: completion.answer, failureCode: null },
      replyExpiresAt ? providerSessionDispatchDeadline(context, replyExpiresAt) : context);
      requireProviderSessionDispatch(context);
      observed = await input.channel.read(completion.questionId, completion.taskId, completion.bindingId, context);
      requireProviderSessionDispatch(context);
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : '';
    const reasonCode = reason === 'provider_session_channel_input' ? 'content_or_contract_blocked' as const
      : reason === 'provider_session_channel_response' ? 'receipt_invalid' as const
        : reason === 'provider_session_channel_uncertain' ? 'delivery_unconfirmed' as const
          : reason === 'provider_session_channel_deadline' ? 'signed_deadline_expired' as const
            : reason === 'provider_session_channel_cancelled' ? 'dispatch_cancelled' as const : null;
    if (!reasonCode) throw error;
    return { state: 'reply_pending' as const, questionId: completion.questionId, taskId: completion.taskId,
      completionHash: pending.completionHash, reasonCode,
      ...(error instanceof NamedPeerContentAuthorizationError ? { blocker: error.blocker } : {}) };
  }
  if (observed.state === 'expired') {
    const dispositionHash = await input.vault.quarantineExpiredProviderSessionReply(input.bindingId, input.identity,
      completion.questionId, pending.completionHash, {
        state: 'expired', taskId: completion.taskId, correlationId: observed.correlationId,
      });
    return { state: 'reply_quarantined' as const, questionId: completion.questionId, taskId: completion.taskId,
      completionHash: pending.completionHash, dispositionHash, reasonCode: 'question_expired' as const,
      delivered: false as const };
  }
  if (observed.state !== 'answered' || observed.answer !== completion.answer || !observed.replyReceiptHash) {
    return { state: 'reply_pending' as const, questionId: completion.questionId, taskId: completion.taskId,
      completionHash: pending.completionHash,
      reasonCode: observed.state === 'answered' ? 'answer_conflict' as const
        : observed.state === 'accepted' && replyExpiresAt && Date.now() >= Date.parse(replyExpiresAt)
          ? 'signed_deadline_expired' as const : 'remote_not_answered' as const };
  }
  const offer = binding.owner === 'cooperative_session'
    ? (await input.vault.listProviderSessionOfferCheckpoints(input.bindingId, input.identity))
      .find(item => item.questionId === completion.questionId) : undefined;
  if (offer) {
    requireProviderSessionDispatch(context);
    await input.vault.acknowledgeProviderSessionOfferReply(input.bindingId, input.identity,
      completion.questionId, offer.offerHash, pending.completionHash);
  } else {
    requireProviderSessionDispatch(context);
    await input.vault.acknowledgeProviderSessionReply(input.bindingId, input.identity, completion.questionId, pending.completionHash);
  }
  return { state: 'reply_reconciled' as const, questionId: completion.questionId, taskId: completion.taskId,
    completionHash: pending.completionHash, replyReceiptHash: observed.replyReceiptHash, correlationId: observed.correlationId };
}
