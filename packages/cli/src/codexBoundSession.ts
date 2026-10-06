import { inspectSessionQuestionForBinding, type SessionQuestionVerifier } from '@dharma-ai-labs/agent-fabric-contracts';
import type { LocalProviderSessionIdentity, LocalVault, ScopedLocalVault } from '@dharma-ai-labs/agent-fabric-local-vault';
import { CodexSessionAnswerTooLargeError, runCodexBridgeQuestion, runCodexLocalWork, type CodexSessionBudget, type CodexToolHandler, type CodexTurnEvidenceSink } from '@dharma-ai-labs/agent-fabric-provider-adapters/experimental/codex-session';
import type { CodexStdioTransport } from '@dharma-ai-labs/agent-fabric-provider-adapters/experimental/codex-transport';

interface CodexBoundSessionInput {
  vault: LocalVault | ScopedLocalVault;
  bindingId: string;
  identity: LocalProviderSessionIdentity;
  // The factory must close its child process before rejecting initialization.
  openTransport(): Promise<CodexStdioTransport>;
  verifier: SessionQuestionVerifier;
  budget: CodexSessionBudget;
  localWriteRoots?: string[];
  additionalFilesystemRules?: Readonly<Record<string, 'read' | 'deny'>>;
  localToolHandler?: CodexToolHandler;
}

export async function openCodexBoundSession(input: CodexBoundSessionInput) {
  const binding = await input.vault.getProviderSessionBinding(input.bindingId, input.identity);
  if (!binding || binding.provider !== 'codex' || binding.owner !== 'dharma_bridge') {
    throw new Error('codex_session_binding_unavailable');
  }
  if (process.platform !== 'linux') throw new Error('codex_session_sandbox_unqualified');
  const currentBinding = async () => {
    const current = await input.vault.getProviderSessionBinding(input.bindingId, input.identity);
    if (!current) throw new Error('codex_session_lease_unavailable');
    if (current.sessionId !== binding.sessionId || current.workspaceRoot !== binding.workspaceRoot
      || current.owner !== binding.owner || current.maximumProviderCostCents !== binding.maximumProviderCostCents) {
      throw new Error('codex_session_binding_unavailable');
    }
    return { ...current, threadId: current.sessionId };
  };
  const lease = await input.vault.tryAcquireProviderSessionLease(input.bindingId, input.identity);
  if (!lease) throw new Error('codex_session_lease_unavailable');
  const heldLease = lease;
  let transport: CodexStdioTransport;
  try { transport = await input.openTransport(); }
  catch (error) { await lease.release(); throw error; }
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
      await heldLease.release();
      closed = true;
    })();
    try { await shutdown; }
    finally { shutdown = null; }
  }

  return {
    close,
    async assertActive() { return !closing && !closed && await heldLease.assertHeld(); },
    async runWork(request: { workId: string; prompt: string; maximumProviderCostCents: number; timeoutMs?: number;
      onTurnEvidence?: CodexTurnEvidenceSink }) {
      if (closing) throw new Error('codex_session_closed');
      if (running) throw new Error('codex_session_busy');
      running = true;
      try {
        const result = await runCodexLocalWork({ ...request, transport, binding: await currentBinding(),
          exclusiveLease: heldLease, budget: input.budget, writeRoots: input.localWriteRoots ?? [],
          toolHandler: input.localToolHandler, additionalFilesystemRules: input.additionalFilesystemRules });
        if (closing) throw new Error('codex_session_closed');
        return result;
      } catch (error) {
        if (!(error instanceof Error) || !['codex_session_budget_unavailable', 'codex_session_work_invalid'].includes(error.message)) {
          try { await close(); } catch { /* Retain the fence until shutdown is confirmed. */ }
        }
        throw error;
      } finally { running = false; }
    },
    async runQuestion(request: { question: unknown; now?: Date; timeoutMs?: number }) {
      if (closing) throw new Error('codex_session_closed');
      if (running) throw new Error('codex_session_busy');
      running = true;
      let codexBinding: Awaited<ReturnType<typeof currentBinding>>;
      try {
        try { codexBinding = await currentBinding(); }
        catch (error) { try { await close(); } catch { /* Retain an unconfirmed owner fence. */ } throw error; }
        const inspected = inspectSessionQuestionForBinding(request.question, codexBinding,
          input.verifier, request.now ?? new Date());
        if (!inspected.ok) throw new Error(inspected.reason);
      } catch (error) {running = false; throw error;}
      try {
        const result = await runCodexBridgeQuestion({
          transport, binding: codexBinding, question: request.question,
          verifier: input.verifier, exclusiveLease: lease, budget: input.budget,
          now: request.now, timeoutMs: request.timeoutMs,
          additionalFilesystemRules: input.additionalFilesystemRules,
        });
        if (closing) throw new Error('codex_session_closed');
        return result;
      } catch (error) {
        // Retain a completed rejected turn only until the inbox records its failure.
        const reason = error instanceof Error ? error.message : '';
        if (!(error instanceof CodexSessionAnswerTooLargeError)
          && !['codex_session_budget_unavailable', 'replayed'].includes(reason)) {
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
  const binding = await input.vault.getProviderSessionBinding(input.bindingId, input.identity);
  if (!binding || binding.provider !== 'codex' || binding.owner !== 'dharma_bridge') {
    throw new Error('codex_session_binding_unavailable');
  }
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
