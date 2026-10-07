import {types} from 'node:util';
import type {OnboardingStage} from './onboardingStage.js';

const stages: readonly OnboardingStage[] = ['local_skill_inventory', 'first_learning_preview',
  'first_learning_sync', 'package_snapshot', 'package_publication', 'role_registration',
  'native_skill_install', 'relay_start', 'autostart', 'named_session', 'readiness'];
const categories = new Set(['codex_setup_host_scope_unavailable', 'codex_setup_host_source_mismatch',
  'codex_setup_host_operation_failed', 'codex_setup_execution_lease_unavailable',
  'setup_session_sender_unavailable', 'setup_session_scope_changed', 'setup_session_invalid',
  'setup_session_start_unconfirmed', 'setup_session_owner_unconfirmed', 'setup_runtime_first_learning_unconfirmed',
  'setup_session_receiver_timeout', 'setup_session_accepted_unconfirmed',
  'setup_session_authorization_unconfirmed', 'setup_session_scope_unavailable', 'setup_session_owner_unavailable',
  'setup_runtime_startup_changed', 'setup_execution_unconfirmed', 'setup_operation_conflict',
  'setup_operation_integrity_failed', 'named_session_readiness_unavailable',
  'named_session_readiness_scope_mismatch', 'named_session_startup_failed',
  'shared_repository_pending', 'shared_repository_blocked', 'named_session_pending',
  'first_learning_pending', 'role_registration_pending', 'synchronization_pending',
  'autostart_pending', 'repository_source_authorization_required', 'approve_device']);

export interface CodexSetupFailureDiagnostic {
  readonly schema: 'dharma.codex-setup-failure-diagnostic/v1';
  readonly stage: OnboardingStage | 'bootstrap' | 'completion';
  readonly category: string;
}
export type CodexSetupFailureObserver = (failure: Readonly<CodexSetupFailureDiagnostic>) => void;

/** Fixed classifications only: no messages, causes, commands or private values leave this function. */
export function classifyCodexSetupFailure(error: unknown,
  fallback: 'bootstrap' | 'completion'): Readonly<CodexSetupFailureDiagnostic> {
  const safeFallback = fallback === 'completion' ? 'completion' : 'bootstrap';
  let stage: CodexSetupFailureDiagnostic['stage'] = safeFallback, category = 'setup_runtime_unclassified';
  const seen = new Set<object>();
  for (let depth = 0; depth < 4; depth++) {
    if (!error || typeof error !== 'object' || types.isProxy(error) || seen.has(error)) break;
    seen.add(error);
    const message = Object.getOwnPropertyDescriptor(error, 'message');
    if (message && Object.hasOwn(message, 'value') && typeof message.value === 'string') {
      if (stage === safeFallback) {
        const found = stages.find(value => message.value.startsWith(`agent_fabric_onboarding_${value}:`));
        if (found) stage = found;
      }
      if (category === 'setup_runtime_unclassified' && categories.has(message.value)) category = message.value;
    }
    const cause = Object.getOwnPropertyDescriptor(error, 'cause');
    error = cause && Object.hasOwn(cause, 'value') ? cause.value : undefined;
  }
  return Object.freeze({schema: 'dharma.codex-setup-failure-diagnostic/v1', stage, category});
}

export function reportCodexSetupFailure(observer: CodexSetupFailureObserver | undefined,
  error: unknown, fallback: 'bootstrap' | 'completion'): void {
  if (typeof observer !== 'function') return;
  try {
    const reported: unknown = observer(classifyCodexSetupFailure(error, fallback));
    if (reported !== undefined) void Promise.resolve(reported).catch(() => {});
  } catch { /* Diagnostics cannot change admission or cleanup. */ }
}
