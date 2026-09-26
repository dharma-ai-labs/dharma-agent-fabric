import { resolve } from 'node:path';
import { sha256, validateContract } from '@dharma-ai-labs/agent-fabric-contracts';
import type { LocalProviderSessionIdentity, LocalVault } from '@dharma-ai-labs/agent-fabric-local-vault';
import type { createProviderSessionChannel } from './providerSessionChannel.js';

interface Completion {
  schema: 'dharma.provider-session-completion/v1'; organizationId: string; repositoryBindingId: string;
  membershipId: string; deviceId: string; workspaceId: string; endpointId: string;
  questionId: string; taskId: string; bindingId: string; targetEndpointId: string; answer: string; answerHash: string;
}

// Reconcile one durable result before admitting more provider work. This function
// has no provider transport or budget API, so upload recovery cannot rerun a turn.
export async function reconcileProviderSessionReply(input: {
  vault: LocalVault; bindingId: string; identity: LocalProviderSessionIdentity;
  channel: Pick<ReturnType<typeof createProviderSessionChannel>, 'read' | 'reply'>;
}) {
  const pending = input.vault.listProviderSessionReplies(input.bindingId, input.identity)[0];
  if (!pending) return null;
  const bytes = await input.vault.getBlob(pending.completionHash);
  if (bytes.length > 16384) throw new Error('provider_session_completion_invalid');
  let value: unknown;
  try { value = JSON.parse(bytes.toString('utf8')); }
  catch { throw new Error('provider_session_completion_invalid'); }
  const contract = await validateContract(resolve(import.meta.dirname, 'schemas'),
    'https://schemas.dharma-ai.io/provider-session-completion/v1', value);
  if (!contract.ok) throw new Error('provider_session_completion_invalid');
  const completion = value as Completion;
  if (!input.vault.getProviderSessionBinding(input.bindingId, input.identity)
    || completion.bindingId !== input.bindingId || completion.questionId !== pending.questionId
    || ['organizationId', 'repositoryBindingId', 'membershipId', 'deviceId', 'workspaceId', 'endpointId']
      .some(key => completion[key as keyof Completion] !== input.identity[key as keyof LocalProviderSessionIdentity])
    || completion.targetEndpointId !== input.identity.endpointId || completion.answerHash !== sha256(completion.answer)) {
    throw new Error('provider_session_completion_scope_mismatch');
  }
  let observed: Awaited<ReturnType<typeof input.channel.read>>;
  try {
    observed = await input.channel.read(completion.questionId, completion.taskId, completion.bindingId);
    if (observed.state === 'accepted') {
      await input.channel.reply({ questionId: completion.questionId, taskId: completion.taskId,
        outcome: 'answered', answer: completion.answer, failureCode: null });
      observed = await input.channel.read(completion.questionId, completion.taskId, completion.bindingId);
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : '';
    const reasonCode = reason === 'provider_session_channel_input' ? 'content_or_contract_blocked' as const
      : reason === 'provider_session_channel_response' ? 'receipt_invalid' as const
        : reason === 'provider_session_channel_uncertain' ? 'delivery_unconfirmed' as const : null;
    if (!reasonCode) throw error;
    return { state: 'reply_pending' as const, questionId: completion.questionId, taskId: completion.taskId,
      completionHash: pending.completionHash, reasonCode };
  }
  if (observed.state !== 'answered' || observed.answer !== completion.answer || !observed.replyReceiptHash) {
    return { state: 'reply_pending' as const, questionId: completion.questionId, taskId: completion.taskId,
      completionHash: pending.completionHash,
      reasonCode: observed.state === 'answered' ? 'answer_conflict' as const : 'remote_not_answered' as const };
  }
  input.vault.acknowledgeProviderSessionReply(input.bindingId, input.identity, completion.questionId, pending.completionHash);
  return { state: 'reply_reconciled' as const, questionId: completion.questionId, taskId: completion.taskId,
    completionHash: pending.completionHash, replyReceiptHash: observed.replyReceiptHash, correlationId: observed.correlationId };
}
