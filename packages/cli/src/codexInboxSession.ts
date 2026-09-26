import { canonicalize, type SessionBindingScope, type SessionQuestion } from '@dharma-ai-labs/agent-fabric-contracts';
import { openCodexBoundSession } from './codexBoundSession.js';
import { createProviderSessionChannel } from './providerSessionChannel.js';
import { reconcileProviderSessionReply } from './providerSessionReplyRecovery.js';

// Only a bridge-owned thread can be driven through app-server. Cooperative desktop
// chats must consume in their own session; knowing a thread ID is not ownership.
export async function openCodexInboxSession(input: Parameters<typeof openCodexBoundSession>[0] & {
  channelTransport: Parameters<typeof createProviderSessionChannel>[0]['transport'];
  expectedRevision: number;
  authorizeContent: Parameters<typeof createProviderSessionChannel>[0]['authorizeContent'];
}) {
  const binding = input.vault.getProviderSessionBinding(input.bindingId, input.identity);
  if (!binding || binding.owner !== 'dharma_bridge' || binding.provider !== 'codex') {
    throw new Error('codex_inbox_binding_unavailable');
  }
  const scope: SessionBindingScope = {
    organizationId: binding.organizationId, repositoryBindingId: binding.repositoryBindingId,
    workspaceId: binding.workspaceId, endpointId: binding.endpointId, membershipId: binding.membershipId,
    deviceId: binding.deviceId, bindingId: binding.bindingId, provider: binding.provider,
    expiresAt: binding.expiresAt, maximumProviderCostCents: binding.maximumProviderCostCents,
  };
  let current: SessionQuestion | null = null;
  let channel: ReturnType<typeof createProviderSessionChannel>;
  const owner = await openCodexBoundSession({ ...input, verifier: {
    resolvePublicKey: keyVersion => input.verifier.resolvePublicKey(keyVersion),
    consume: async questionId => {
      if (!current || current.questionId !== questionId) return false;
      await channel.accept(questionId, current.taskId);
      return input.verifier.consume(questionId);
    },
  } });
  channel = createProviderSessionChannel({ transport: input.channelTransport, scope, mode: 'bridge_owned',
    expectedRevision: input.expectedRevision, assertOwner: owner.assertActive,
    verifier: input.verifier, authorizeContent: input.authorizeContent });
  try { await channel.attach(); }
  catch (error) { try { await owner.close(); } catch { /* Keep the fence if shutdown is unconfirmed. */ } throw error; }

  let stopped = false, running = false, closing: Promise<{ serverDetached: boolean; providerClosed: true }> | null = null;
  let pulse: Promise<void> | null = null;
  const timer = setInterval(() => {
    if (stopped || pulse) return;
    pulse = channel.heartbeat().then(() => undefined).catch(async () => {
      stopped = true; clearInterval(timer);
      try { await owner.close(); } catch { /* The retained owner remains fenced. */ }
    }).finally(() => { pulse = null; });
  }, 20_000);
  timer.unref();
  async function close(options: { retire?: boolean } = {}) {
    if (closing) return closing;
    stopped = true; clearInterval(timer);
    closing = (async () => {
      if (pulse) await pulse;
      let serverDetached = false;
      if (options.retire) {
        try { await channel.detach(); serverDetached = true; } catch { /* Remote presence expires; it is not reported as detached. */ }
      }
      await owner.close();
      return { serverDetached, providerClosed: true as const };
    })();
    try { return await closing; } catch (error) { closing = null; throw error; }
  }
  return {
    close,
    retire: () => close({ retire: true }),
    async runNext() {
      if (stopped) throw new Error('codex_inbox_session_unavailable');
      if (running) throw new Error('codex_inbox_session_busy');
      running = true;
      try {
        const recovered = await reconcileProviderSessionReply({ vault: input.vault, bindingId: input.bindingId,
          identity: input.identity, channel });
        if (recovered) {
          if (recovered.state === 'reply_pending') await close();
          return recovered;
        }
        const offers = await channel.inbox();
        const offer = offers[0];
        if (!offer) return { state: 'idle' as const };
        current = offer;
        let result: Awaited<ReturnType<typeof owner.runQuestion>>;
        try { result = await owner.runQuestion({ question: offer }); }
        catch (error) {
          if (error instanceof Error && error.message === 'codex_session_budget_unavailable') {
            return { state: 'budget_denied' as const, questionId: offer.questionId, taskId: offer.taskId };
          }
          throw error;
        }
        const completionHash = await input.vault.stageProviderSessionReply(input.bindingId, input.identity,
          offer.questionId, Buffer.from(canonicalize({
          schema: 'dharma.provider-session-completion/v1', organizationId: scope.organizationId,
          repositoryBindingId: scope.repositoryBindingId, membershipId: scope.membershipId,
          deviceId: scope.deviceId, workspaceId: scope.workspaceId, endpointId: scope.endpointId,
          ...result,
        }), 'utf8'));
        try {
          const receipt = await channel.reply({ questionId: offer.questionId, taskId: offer.taskId,
            outcome: 'answered', answer: result.answer, failureCode: null });
          input.vault.acknowledgeProviderSessionReply(input.bindingId, input.identity, offer.questionId, completionHash);
          return { ...receipt, completionHash };
        } catch (error) {
          // Preserve the encrypted completed result. Never repeat the provider turn
          // because its upload was denied or the network acknowledgement was lost.
          let providerShutdownConfirmed = false;
          try { providerShutdownConfirmed = (await close()).providerClosed; } catch { /* An unconfirmed shutdown retains the fence. */ }
          const reasonCode = error instanceof Error && error.message === 'provider_session_channel_input' ? 'content_or_contract_blocked'
            : error instanceof Error && error.message === 'provider_session_channel_response' ? 'receipt_invalid'
              : 'delivery_unconfirmed';
          return { state: 'reply_pending' as const, questionId: offer.questionId, taskId: offer.taskId,
            completionHash, reasonCode, providerShutdownConfirmed };
        }
      } catch (error) {
        try { await close(); } catch { /* Fail closed without reporting successful termination. */ }
        throw error;
      } finally { current = null; running = false; }
    },
  };
}
