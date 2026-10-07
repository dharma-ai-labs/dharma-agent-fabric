import {AsyncLocalStorage} from 'node:async_hooks';
import {canonicalize, sha256} from '@dharma-ai-labs/agent-fabric-contracts';
import type {LocalVault, ScopedLocalVault} from '@dharma-ai-labs/agent-fabric-local-vault';
import {parseLocalCodexSetupSessionRequest, parseLocalCodexSetupSessionResult,
  type LocalCodexSetupSessionRequest, type LocalCodexSetupSessionResult}
  from '@dharma-ai-labs/agent-fabric-local-vault/setup-session';
import {currentBootstrapHostScope, inspectCodexBootstrapHostPreparation, type BootstrapHostScope} from './bootstrapHostScope.js';
import {assertCodexSetupExecutionLease, type CodexSetupExecutionLease, type CodexSetupIntent} from './codexSetupAdmission.js';
import {currentNamedSessionChildOwner, type NamedSessionChildOwner} from './namedSessionChildOwner.js';
import type {OrganizationPolicy} from '@dharma-ai-labs/agent-fabric-policy';
import {reportCodexSetupFailure, type CodexSetupFailureObserver} from './codexSetupDiagnostic.js';

export function codexSetupSessionPolicyHash(policy: OrganizationPolicy): string {
  if (!policy.serverAuthorization) throw new Error('setup_session_scope_changed');
  // Bind all permissions and authority identities, not renewable envelope bytes.
  // Callers must still verify the current signature, expiry and replay anchor.
  const authorization = Object.fromEntries(Object.entries(policy.serverAuthorization)
    .filter(([key]) => !['issuedAt', 'expiresAt', 'signature'].includes(key)));
  return sha256(canonicalize({...policy, serverAuthorization: authorization}));
}

type SenderVault = Pick<ScopedLocalVault, 'stageCodexSetupSession' | 'readCodexSetupSession'>;
type ReceiverVault = Pick<LocalVault, 'listPendingCodexSetupSessions' | 'readCodexSetupSession' | 'acceptCodexSetupSession'>;
type Sender = Readonly<{scope: BootstrapHostScope; vault: SenderVault; lease: Readonly<CodexSetupExecutionLease>;
  intent: Readonly<CodexSetupIntent>; active: {value: boolean}}>;
const originalSenders = new WeakMap<BootstrapHostScope, Sender>();

/** Private original-lease continuation. Public-shaped JSON is not admission. */
export async function withCodexSetupSessionSender<T>(input: {scope: BootstrapHostScope; vault: SenderVault;
  lease: Readonly<CodexSetupExecutionLease>}, operation: () => Promise<T>): Promise<T> {
  const prepared = await inspectCodexBootstrapHostPreparation(input.scope);
  await input.scope.step(() => assertCodexSetupExecutionLease(input.lease, prepared.intent));
  if (originalSenders.has(input.scope)) throw new Error('setup_session_sender_conflict');
  const sender: Sender = Object.freeze({...input, intent: prepared.intent, active: {value: true}});
  originalSenders.set(input.scope, sender);
  try {return await operation();}
  finally {sender.active.value = false; originalSenders.delete(input.scope);}
}

export async function originalCodexSetupSessionSender(scope: BootstrapHostScope): Promise<Sender> {
  const sender = originalSenders.get(scope);
  if (!sender?.active.value || currentBootstrapHostScope() !== scope) throw new Error('setup_session_sender_unavailable');
  await scope.step(() => assertCodexSetupExecutionLease(sender.lease, sender.intent));
  if (!sender.active.value || originalSenders.get(scope) !== sender) throw new Error('setup_session_sender_unavailable');
  return sender;
}

/** Original setup caller stages a request; it never starts or adopts a daemon. */
export async function awaitCodexSetupSession(input: {vault: SenderVault; scope: BootstrapHostScope;
  leaseId: string; request: LocalCodexSetupSessionRequest; waitMs?: number;
  acceptedWaitMs?: number}): Promise<Readonly<LocalCodexSetupSessionResult>> {
  const request = parseLocalCodexSetupSessionRequest(input.request), waitMs = input.waitMs ?? 30_000;
  const acceptedWaitMs = input.acceptedWaitMs ?? 120_000;
  if (!Number.isSafeInteger(waitMs) || waitMs < 1 || waitMs > 30_000
    || !Number.isSafeInteger(acceptedWaitMs) || acceptedWaitMs < 1 || acceptedWaitMs > 120_000) {
    throw new Error('setup_session_invalid');
  }
  const submission = await input.scope.step(() => input.vault.stageCodexSetupSession(input.leaseId, request.intentDigest, request));
  try {
    const expiresAt = Date.parse(request.expiresAt);
    let deadline = Math.min(Date.now() + waitMs, expiresAt);
    let accepted = false;
    do {
      if (Date.now() >= expiresAt) break;
      const observation = await input.scope.step(() => input.vault.readCodexSetupSession(request.operationId, request.intentDigest));
      if (!observation || canonicalize(observation.request) !== canonicalize(request) || observation.state === 'withdrawn') {
        throw new Error('setup_session_scope_changed');
      }
      if (accepted && observation.state !== 'accepted') throw new Error('setup_session_scope_changed');
      if (Date.now() >= deadline) break;
      // Acceptance is not readiness. Keep the original caller alive while its
      // standing owner performs bounded startup, without a second submission.
      if (!accepted && observation.state === 'accepted') deadline = Math.min(Date.now() + acceptedWaitMs, expiresAt);
      accepted = observation.state === 'accepted';
      if (Date.now() >= expiresAt) break;
      if (observation.state === 'accepted' && observation.result) return parseLocalCodexSetupSessionResult(observation.result);
      await input.scope.step(() => new Promise<void>(resolveWait => {
        const finish = () => {clearTimeout(timer); input.scope.signal.removeEventListener('abort', finish); resolveWait();};
        const timer = setTimeout(finish, Math.min(100, Math.max(1, deadline - Date.now())));
        input.scope.signal.addEventListener('abort', finish, {once: true});
        if (input.scope.signal.aborted) finish();
      }));
    } while (Date.now() < deadline);
    throw new Error(accepted ? 'setup_session_accepted_unconfirmed' : 'setup_session_receiver_timeout');
  } finally {
    // Exact pending-request cleanup remains available after scope withdrawal.
    // An accepted request is not cancelled or represented as rolled back.
    await submission.withdraw();
  }
}

export interface AcceptedSetupSessionScope {
  readonly request: Readonly<LocalCodexSetupSessionRequest>;
  step<T>(operation: () => Promise<T>): Promise<T>;
}
const receiverContext = new WeakSet<AcceptedSetupSessionScope>();
const acceptedContext = new AsyncLocalStorage<AcceptedSetupSessionScope>();
/** Closed descendants keep the closed context; they never become unscoped. */
export function currentAcceptedSetupSessionScope() {return acceptedContext.getStore();}

/** Only an existing standing owner can consume once. This component does not
 * confer signed policy, enrollment or provider authority on a JSON request. */
export async function consumeCodexSetupSessions(input: {vault: ReceiverVault; owner: NamedSessionChildOwner;
  signal: AbortSignal; authorize(request: Readonly<LocalCodexSetupSessionRequest>): Promise<boolean>;
  start(scope: AcceptedSetupSessionScope): Promise<LocalCodexSetupSessionResult>;
  onFailure?: CodexSetupFailureObserver}): Promise<number> {
  const reportFailure = (error: unknown) => reportCodexSetupFailure(input.onFailure,
    new Error('agent_fabric_onboarding_named_session:', {cause: error}), 'bootstrap');
  const assertOwner = () => {
    if (input.signal.aborted || currentNamedSessionChildOwner() !== input.owner) throw new Error('setup_session_owner_unavailable');
    input.owner.assert();
  };
  assertOwner();
  let consumed = 0;
  for (const entry of input.vault.listPendingCodexSetupSessions()) {
    assertOwner();
    const observation = input.vault.readCodexSetupSession(entry.operationId, entry.intentDigest);
    if (!observation || observation.state !== 'pending') continue;
    const request = parseLocalCodexSetupSessionRequest(observation.request);
    const assertLifetime = () => {
      assertOwner();
      if (Date.now() < Date.parse(request.issuedAt) || Date.now() >= Date.parse(request.expiresAt)) {
        throw new Error('setup_session_scope_unavailable');
      }
    };
    assertLifetime();
    if (!await input.authorize(request)) {
      reportFailure(new Error('setup_session_authorization_unconfirmed'));
      continue;
    }
    assertLifetime();
    const cleanup = input.owner.checkpoint(request.name);
    const acceptance = input.vault.acceptCodexSetupSession(entry.operationId, entry.intentDigest, sha256(canonicalize(request)));
    if (!acceptance) continue;
    consumed++;
    let active = true;
    const scope: AcceptedSetupSessionScope = Object.freeze({request, async step<T>(operation: () => Promise<T>) {
      if (!active || !receiverContext.has(scope)) throw new Error('setup_session_scope_unavailable');
      assertLifetime();
      if (!await input.authorize(request)) throw new Error('setup_session_scope_unavailable');
      // Recheck synchronously after the policy yield and before each effect.
      assertLifetime();
      if (!active || !receiverContext.has(scope)) throw new Error('setup_session_scope_unavailable');
      const value = await operation();
      assertLifetime();
      if (!active || !receiverContext.has(scope) || !await input.authorize(request)) throw new Error('setup_session_scope_unavailable');
      assertLifetime();
      if (!active || !receiverContext.has(scope)) throw new Error('setup_session_scope_unavailable');
      return value;
    }});
    receiverContext.add(scope);
    try {
      const result = await scope.step(() => acceptedContext.run(scope, () => input.start(scope)));
      const accepted = parseLocalCodexSetupSessionResult(result);
      if (accepted.state === 'started' && (accepted.supervisorPid !== process.pid
        || input.owner.ownedPid(request.name) !== accepted.sessionPid)) throw new Error('setup_session_owner_unconfirmed');
      if (accepted.state === 'unconfirmed') await cleanup.stopFresh();
      acceptance.record(accepted);
    } catch (error) {
      // Accepted-but-interrupted is durable, not a retry license. Withhold all
      // provider/private diagnostics and do not signal unrelated workers.
      // Drain only this request's newly captured child, even after withdrawal.
      // Unconfirmed cleanup must not be masked by a recorded disposition.
      await cleanup.stopFresh();
      assertOwner();
      acceptance.record({state: 'unconfirmed', code: 'session_start_unconfirmed'});
      reportFailure(error);
    } finally {active = false; receiverContext.delete(scope);}
  }
  return consumed;
}
