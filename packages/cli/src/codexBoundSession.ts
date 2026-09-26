import { inspectSessionQuestionForBinding, type SessionQuestionVerifier } from '@dharma-ai-labs/agent-fabric-contracts';
import type { LocalProviderSessionIdentity, LocalVault } from '@dharma-ai-labs/agent-fabric-local-vault';
import { runCodexBridgeQuestion, type CodexSessionBudget } from '@dharma-ai-labs/agent-fabric-provider-adapters/experimental/codex-session';
import type { CodexStdioTransport } from '@dharma-ai-labs/agent-fabric-provider-adapters/experimental/codex-transport';

interface CodexBoundSessionInput {
  vault: LocalVault;
  bindingId: string;
  identity: LocalProviderSessionIdentity;
  // The factory must close its child process before rejecting initialization.
  openTransport(): Promise<CodexStdioTransport>;
  verifier: SessionQuestionVerifier;
  budget: CodexSessionBudget;
}

export async function openCodexBoundSession(input: CodexBoundSessionInput) {
  const binding = input.vault.getProviderSessionBinding(input.bindingId, input.identity);
  if (!binding || binding.provider !== 'codex') throw new Error('codex_session_binding_unavailable');
  const codexBinding = { ...binding, threadId: binding.sessionId };
  const lease = input.vault.tryAcquireProviderSessionLease(input.bindingId, input.identity);
  if (!lease) throw new Error('codex_session_lease_unavailable');
  const heldLease = lease;
  let transport: CodexStdioTransport;
  try { transport = await input.openTransport(); }
  catch (error) { lease.release(); throw error; }
  let running = false;
  let closing = false;
  let closed = false;
  let shutdown: Promise<void> | null = null;

  async function close() {
    closing = true;
    if (closed) return;
    if (shutdown) return shutdown;
    shutdown = (async () => {
      // Never release the fence while a provider child could still accept turns.
      await transport.close();
      heldLease.release();
      closed = true;
    })();
    try { await shutdown; }
    finally { shutdown = null; }
  }

  return {
    close,
    async assertActive() { return !closing && !closed && await heldLease.assertHeld(); },
    async runQuestion(request: { question: unknown; now?: Date; timeoutMs?: number }) {
      if (closing) throw new Error('codex_session_closed');
      if (running) throw new Error('codex_session_busy');
      const inspected = inspectSessionQuestionForBinding(request.question, codexBinding,
        input.verifier, request.now ?? new Date());
      if (!inspected.ok) throw new Error(inspected.reason);
      running = true;
      try {
        const result = await runCodexBridgeQuestion({
          transport, binding: codexBinding, question: request.question,
          verifier: input.verifier, exclusiveLease: lease, budget: input.budget,
          now: request.now, timeoutMs: request.timeoutMs,
        });
        if (closing) throw new Error('codex_session_closed');
        return result;
      } catch (error) {
        // Both failures happen before turn/start; retain an empty thread for retry.
        const reason = error instanceof Error ? error.message : '';
        if (!['codex_session_budget_unavailable', 'replayed'].includes(reason)) {
          try { await close(); }
          catch { /* Keep the fence and disable dispatch until shutdown is confirmed. */ }
        }
        throw error;
      } finally { running = false; }
    },
  };
}

export async function runCodexBoundSessionQuestion(input: CodexBoundSessionInput & {
  question: unknown;
  now?: Date;
  timeoutMs?: number;
}) {
  const binding = input.vault.getProviderSessionBinding(input.bindingId, input.identity);
  if (!binding || binding.provider !== 'codex') throw new Error('codex_session_binding_unavailable');
  const codexBinding = { ...binding, threadId: binding.sessionId };
  const inspected = inspectSessionQuestionForBinding(input.question, codexBinding,
    input.verifier, input.now ?? new Date());
  if (!inspected.ok) throw new Error(inspected.reason);
  const owner = await openCodexBoundSession(input);
  try {
    const result = await owner.runQuestion(input);
    await owner.close();
    return result;
  } catch (error) {
    try { await owner.close(); }
    catch { /* Retain ownership if process termination cannot be confirmed. */ }
    throw error;
  }
}
