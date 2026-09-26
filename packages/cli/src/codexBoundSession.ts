import { inspectSessionQuestionForBinding, type SessionQuestionVerifier } from '@dharma-ai-labs/agent-fabric-contracts';
import type { LocalProviderSessionIdentity, LocalVault } from '@dharma-ai-labs/agent-fabric-local-vault';
import { runCodexBridgeQuestion, type CodexSessionBudget } from '@dharma-ai-labs/agent-fabric-provider-adapters/experimental/codex-session';
import type { CodexStdioTransport } from '@dharma-ai-labs/agent-fabric-provider-adapters/experimental/codex-transport';

export async function runCodexBoundSessionQuestion(input: {
  vault: LocalVault;
  bindingId: string;
  identity: LocalProviderSessionIdentity;
  // The factory must close its child process before rejecting initialization.
  openTransport(): Promise<CodexStdioTransport>;
  question: unknown;
  verifier: SessionQuestionVerifier;
  budget: CodexSessionBudget;
  now?: Date;
  timeoutMs?: number;
}) {
  const binding = input.vault.getProviderSessionBinding(input.bindingId, input.identity);
  if (!binding || binding.provider !== 'codex') throw new Error('codex_session_binding_unavailable');
  const codexBinding = { ...binding, threadId: binding.sessionId };
  const inspected = inspectSessionQuestionForBinding(input.question, codexBinding,
    input.verifier, input.now ?? new Date());
  if (!inspected.ok) throw new Error(inspected.reason);
  const lease = input.vault.tryAcquireProviderSessionLease(input.bindingId, input.identity);
  if (!lease) throw new Error('codex_session_lease_unavailable');
  let transport: CodexStdioTransport | null = null;
  try {
    transport = await input.openTransport();
    const result = await runCodexBridgeQuestion({
      transport,
      binding: codexBinding,
      question: input.question,
      verifier: input.verifier,
      exclusiveLease: lease,
      budget: input.budget,
      now: input.now,
      timeoutMs: input.timeoutMs,
    });
    await transport.close();
    lease.release();
    return result;
  } catch (error) {
    // A failed or ambiguously completed turn may still be executing.
    try { if (transport) await transport.close(); lease.release(); }
    catch { /* Retain ownership if process termination cannot be confirmed. */ }
    throw error;
  }
}
