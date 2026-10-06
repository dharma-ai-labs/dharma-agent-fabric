import {randomUUID} from 'node:crypto';
import type {CodexStdioTransport} from '@dharma-ai-labs/agent-fabric-provider-adapters/experimental/codex-transport';
import {verifyCodexSetupReadOnlyProfile, type CodexToolHandler, type CodexToolResult}
  from '@dharma-ai-labs/agent-fabric-provider-adapters/experimental/codex-session';
import {drainBootstrapHostChildren, prepareCodexBootstrapHost, type BootstrapHostScope} from './bootstrapHostScope.js';
import {createCodexSetupAdmission, type CodexSetupIntent, type CodexSetupJournal} from './codexSetupAdmission.js';
import {startNamedCodexSetupThread} from './namedCodexThread.js';

type Admission = Parameters<typeof createCodexSetupAdmission>[0];
type Input = {
  /** Already owned, individually qualified native connection; never a peer's process. */
  transport: CodexStdioTransport; workspace: string; name: string; intent: CodexSetupIntent;
  openJournal(scope: BootstrapHostScope): Promise<CodexSetupJournal & {close(): void | Promise<void>}>;
  signal: AbortSignal; maximumProviderCostCents: number;
  additionalFilesystemRules?: Readonly<Record<string, 'read' | 'deny'>>;
  /** Requalifies package/source, provider account, host ownership and signed scope. */
  current(): Promise<boolean>;
  reserve(operationId: string, cents: number): Promise<boolean>;
  execute(intent: Readonly<CodexSetupIntent>, signal: AbortSignal, current: () => Promise<boolean>,
    lease: Parameters<Admission['execute']>[3], scope: BootstrapHostScope): Promise<unknown>;
  verifyReadiness: Admission['verifyReadiness'];
};
function record(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  try {
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (Reflect.ownKeys(descriptors).some(key => typeof key !== 'string' || !Object.hasOwn(descriptors[key]!, 'value'))) return null;
    return Object.fromEntries(Object.entries(descriptors).map(([key, field]) => [key, field.value]));
  } catch {return null;}
}
const deny = (): CodexToolResult => ({success: false,
  contentItems: [{type: 'inputText', text: '{"code":"codex_setup_not_authorized"}'}]});

/** Registers setup on one original native turn. Callback settlement is not process termination. */
export async function startCodexSetupNativeHost(input: Input) {
  const {transport, workspace, name, openJournal, reserve, execute, verifyReadiness} = input;
  const maximumCost = input.maximumProviderCostCents;
  if (!Number.isInteger(maximumCost) || maximumCost < 1 || maximumCost > 10_000
    || typeof reserve !== 'function' || typeof execute !== 'function' || typeof verifyReadiness !== 'function'
    || typeof openJournal !== 'function') {
    throw new Error('codex_setup_native_input_invalid');
  }
  const prepared = prepareCodexBootstrapHost({intent: input.intent, workspace, current: input.current,
    signal: AbortSignal.any([input.signal, transport.signal])});
  const {scope, intent} = prepared, connectionId = randomUUID();
  const filesystem = Object.freeze({...input.additionalFilesystemRules});
  let threadId = '', turnId = '', closed = false, terminalObserved = false;
  let admission: ReturnType<typeof createCodexSetupAdmission> | undefined;
  let journal: (CodexSetupJournal & {close(): void | Promise<void>}) | undefined;
  let journalClosing: Promise<void> | undefined;
  const closeJournal = () => {
    if (!journal) return Promise.resolve();
    const owned = journal;
    return journalClosing ??= Promise.resolve().then(() => owned.close()).catch(() => {
      throw new Error('codex_setup_native_journal_close_unconfirmed');
    });
  };
  let unregisterTools = () => {}, unsubscribe = () => {};
  const callbacks = new Set<Promise<CodexToolResult>>(), completions = new Set<string>();
  let bind!: () => void, finish!: () => void, fail!: (error: Error) => void;
  const bound = new Promise<void>(resolve => {bind = resolve;});
  const settled = new Promise<void>((resolve, reject) => {finish = resolve; fail = reject;});
  void settled.catch(() => {});
  const withdraw = () => {
    if (closed) return;
    closed = true; scope.close(); admission?.close(); bind(); unregisterTools(); unsubscribe();
    scope.signal.removeEventListener('abort', withdraw);
    void Promise.allSettled([...callbacks, ...(admission ? [admission.settled] : [])]).then(async () => {
      let failure: string | undefined;
      try {await drainBootstrapHostChildren(scope);} catch {failure = 'codex_setup_native_child_stop_unconfirmed';}
      try {await closeJournal();} catch {failure ??= 'codex_setup_native_journal_close_unconfirmed';}
      if (failure) fail(new Error(failure)); else finish();
    });
  };
  scope.signal.addEventListener('abort', withdraw, {once: true});
  if (scope.signal.aborted) withdraw();
  let closing: Promise<void> | undefined;
  const close = () => closing ??= (async () => {
    withdraw();
    let interrupted = true;
    if (threadId && turnId && !terminalObserved && !transport.signal.aborted) {
      try {await transport.request('turn/interrupt', {threadId, turnId});}
      catch {interrupted = false;}
    }
    await settled; await closeJournal();
    if (!interrupted) throw new Error('codex_setup_native_interrupt_unconfirmed');
  })();
  try {
    await scope.assert();
    const verifyProfile = async () => {
      try {await verifyCodexSetupReadOnlyProfile(transport, workspace, scope, filesystem);}
      catch {await scope.assert(); throw new Error('codex_setup_native_profile_unavailable');}
    };
    await verifyProfile();
    await scope.step(async () => {journal = await openJournal(scope);});
    threadId = await startNamedCodexSetupThread(transport, workspace, name, scope);
    unsubscribe = transport.onNotification(value => {
      const event = record(value), params = record(event?.params), turn = record(params?.turn);
      if (event?.method !== 'turn/completed' || params?.threadId !== threadId || typeof turn?.id !== 'string') return;
      if (!turnId) {if (completions.size < 64) completions.add(turn.id); return;}
      if (turn.id === turnId) {terminalObserved = true; withdraw();}
    });
    if (closed) {unsubscribe(); throw new Error('codex_setup_host_scope_unavailable');}
    const handler: CodexToolHandler = (raw, context) => {
      // Snapshot native data before waiting for turn/start; do not invoke accessors.
      const params = record(raw), arguments_ = record(params?.arguments);
      if (!params || !arguments_ || !context || !(context.signal instanceof AbortSignal)) return Promise.resolve(deny());
      const snapshot = Object.freeze({...params, arguments: Object.freeze({...arguments_})});
      const signal = context.signal;
      const owned = (async () => {
        await bound;
        if (closed || !admission || signal.aborted) return deny();
        return admission.handler(snapshot, {signal: AbortSignal.any([signal, scope.signal])});
      })();
      callbacks.add(owned); void owned.then(() => callbacks.delete(owned), () => callbacks.delete(owned));
      return owned;
    };
    unregisterTools = transport.onToolCall(handler);
    if (closed) {unregisterTools(); throw new Error('codex_setup_host_scope_unavailable');}
    if (await scope.step(() => reserve(intent.operationId, maximumCost)) !== true) throw new Error('codex_setup_native_budget_unavailable');
    await verifyProfile();
    await scope.step(async () => {
      const started = record(await transport.request('turn/start', {
        threadId, cwd: workspace, approvalPolicy: 'never', permissions: 'dharma_bridge',
        input: [{type: 'text', text: `Perform the recipient-bound Agent Fabric setup using dharma_setup_reference with operationId ${intent.operationId} and setupReference ${intent.setupReference}. Browser approval remains required for the intended recipient. In-progress is not readiness. If functions.exec returns a running cell, use functions.wait on that same cell until the setup tool returns a terminal result or the approved operation expires. Prefer 120000ms waits instead of rapid polling. Do not end this turn or send a final answer while the setup tool is pending: ending the original turn cancels setup, even when browser approval is still pending. Never terminate or restart the setup operation merely to report that approval is needed. Do not run setup shell commands, read private storage, request broader permissions or use peer tools during setup.`}],
      }));
      const turn = record(started?.turn);
      if (typeof turn?.id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$(?![\s\S])/.test(turn.id)) throw new Error('codex_setup_native_start_failed');
      // Preserve the original owned turn before a post-response scope check can fail.
      turnId = turn.id; terminalObserved = completions.has(turnId);
    });
    const binding = Object.freeze({connectionId, threadId, turnId, hostContextId: intent.hostContextId});
    // Keep this setup-only tool pending for browser approval. An early preview
    // lets the model end its original turn and correctly withdraw the lease.
    admission = createCodexSetupAdmission({...binding, intent, journal: journal!,
      responseWaitMs: Math.max(1, Math.min(900_000, Date.parse(intent.expiresAt) - Date.now())),
      execute: async (requested, signal, current, lease) => {
        const cancel = () => scope.close();
        signal.addEventListener('abort', cancel, {once: true});
        if (signal.aborted) cancel();
        try {
          await scope.assert();
          if (!await current()) throw new Error('codex_setup_host_scope_unavailable');
          const result = await execute(requested, signal, current, lease, scope);
          await scope.assert();
          if (!await current()) throw new Error('codex_setup_host_scope_unavailable');
          return result;
        } finally {signal.removeEventListener('abort', cancel);}
      }, verifyReadiness,
      current: async () => ({...binding, mode: closed ? 'peer' : 'setup'}),
      qualifyHost: async () => scope.current()});
    if (completions.has(turnId)) {terminalObserved = true; withdraw();}
    bind();
    return Object.freeze({threadId, turnId, close, settled});
  } catch (error) {
    await close();
    const safe = new Set(['codex_setup_native_input_invalid', 'codex_setup_native_profile_unavailable',
      'codex_setup_native_budget_unavailable', 'codex_setup_host_scope_invalid', 'codex_setup_host_scope_unavailable']);
    throw new Error(error instanceof Error && safe.has(error.message) ? error.message : 'codex_setup_native_start_failed');
  }
}
