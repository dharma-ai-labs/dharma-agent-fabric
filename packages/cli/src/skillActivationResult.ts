import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { AgentFabricRequestError } from '@dharma-ai-labs/agent-fabric-relay-client';

// The relay records the last automatic skill preparation or activation result per provider, so setup
// and `dharma status` can say why a shared repository package has not installed. Only fixed codes are
// kept: no error messages, paths or server text leave this module.

export type SkillActivationStage = 'preparation' | 'activation';
export type SkillActivationOutcome = 'activated' | 'up_to_date' | 'no_rollout' | 'failed';
export type SkillActivationResult = {
  at: string;
  outcome: SkillActivationOutcome;
  rolloutId: string | null;
  bundleId: string | null;
  errorCode: string | null;
};
export type SkillActivationCounters = {
  preparationsCompleted: number;
  preparationFailures: number;
  activationsCompleted: number;
  activationFailures: number;
};
export type RelaySkillActivationState = {
  schema: 'dharma.relay-skill-activation/v1';
  workspaceId: string;
  updatedAt: string;
  counters: SkillActivationCounters;
  providers: Partial<Record<string, SkillActivationResult>>;
};

const SCHEMA = 'dharma.relay-skill-activation/v1';
const PROVIDERS = new Set(['codex', 'claude', 'agy', 'hermes']);
const OUTCOMES = new Set<SkillActivationOutcome>(['activated', 'up_to_date', 'no_rollout', 'failed']);
const ERROR_CODE = /^[a-z][a-z0-9_]{0,63}(?::[a-z0-9_]{1,32})?$/;
const HQ_CODE = /^([a-z][a-z0-9_]{0,63}): /;
const ERRNO = /^[A-Z][A-Z0-9_]{1,31}$/;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const TIMESTAMP = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$/;

export class SkillActivationError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'SkillActivationError';
    this.code = code;
  }
}

function errnoCode(error: unknown): string | null {
  for (const candidate of [error, error instanceof Error ? error.cause : undefined]) {
    const code = candidate && typeof candidate === 'object' ? (candidate as { code?: unknown }).code : undefined;
    if (typeof code === 'string' && ERRNO.test(code)) return code.toLowerCase();
  }
  return null;
}

export function skillActivationErrorCode(error: unknown, stage: SkillActivationStage): string {
  if (error instanceof SkillActivationError && ERROR_CODE.test(error.code)) return error.code;
  if (error instanceof AgentFabricRequestError) {
    const code = HQ_CODE.exec(error.message)?.[1];
    return code && code !== 'request_failed' ? code : `http_${error.status}`;
  }
  if (error instanceof Error && error.message === 'Skill bundle has expired.') return 'skill_bundle_expired';
  const errno = errnoCode(error);
  const failed = stage === 'activation' ? 'install_failed' : 'preparation_failed';
  return errno ? `${failed}:${errno}` : failed;
}

/** An install that resolves with a receipt other than 'active' did not install the bundle. */
export function requireActiveSkillInstall(status: unknown): void {
  if (status === 'active') return;
  const suffix = typeof status === 'string' && /^[a-z0-9_]{1,32}$/.test(status) ? status : 'unknown';
  throw new SkillActivationError(`install_failed:${suffix}`, 'Skill installation finished without an active bundle.');
}

/**
 * An empty poll after an activation means the installed release is current, not that none was offered.
 * An empty poll after a failure carries no newer reason, so the failure stays the reported one, with the time
 * it was observed: a readiness wait that began later must not report it as current.
 */
export function nextSkillActivationResult(previous: SkillActivationResult | undefined,
  attempt: SkillActivationResult): SkillActivationResult {
  if (attempt.outcome === 'no_rollout' && (previous?.outcome === 'activated' || previous?.outcome === 'up_to_date')) {
    return { ...previous, at: attempt.at, outcome: 'up_to_date' };
  }
  if (attempt.outcome === 'no_rollout' && previous?.outcome === 'failed') return previous;
  return attempt;
}

export function relaySkillActivationPath(home: string, workspaceId: string): string {
  return resolve(home, 'relay', 'repositories', workspaceId, 'skill-activation.json');
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const isTimestamp = (value: unknown): value is string =>
  typeof value === 'string' && TIMESTAMP.test(value) && Number.isFinite(Date.parse(value));
const hasExactly = (value: Record<string, unknown>, keys: readonly string[]) =>
  Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const isCount = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
const isIdentifier = (value: unknown) => value === null || typeof value === 'string' && IDENTIFIER.test(value);

function parseResult(value: unknown): SkillActivationResult | null {
  if (!isRecord(value) || !hasExactly(value, ['at', 'outcome', 'rolloutId', 'bundleId', 'errorCode'])
    || !isTimestamp(value.at) || !OUTCOMES.has(value.outcome as SkillActivationOutcome)
    || !isIdentifier(value.rolloutId) || !isIdentifier(value.bundleId)
    || !(value.errorCode === null || typeof value.errorCode === 'string' && ERROR_CODE.test(value.errorCode))
    || (value.outcome === 'failed') !== (value.errorCode !== null)) return null;
  return { at: value.at, outcome: value.outcome as SkillActivationOutcome, rolloutId: value.rolloutId as string | null,
    bundleId: value.bundleId as string | null, errorCode: value.errorCode as string | null };
}

export function parseRelaySkillActivationState(value: unknown, workspaceId: string): RelaySkillActivationState | null {
  if (!isRecord(value) || !hasExactly(value, ['schema', 'workspaceId', 'updatedAt', 'counters', 'providers'])
    || value.schema !== SCHEMA || value.workspaceId !== workspaceId || !isTimestamp(value.updatedAt)
    || !isRecord(value.counters) || !isRecord(value.providers)
    || !hasExactly(value.counters, ['preparationsCompleted', 'preparationFailures', 'activationsCompleted', 'activationFailures'])) {
    return null;
  }
  const { preparationsCompleted, preparationFailures, activationsCompleted, activationFailures } = value.counters;
  if (![preparationsCompleted, preparationFailures, activationsCompleted, activationFailures].every(isCount)) return null;
  const providers: RelaySkillActivationState['providers'] = {};
  for (const [provider, result] of Object.entries(value.providers)) {
    const parsed = PROVIDERS.has(provider) ? parseResult(result) : null;
    if (!parsed) return null;
    providers[provider] = parsed;
  }
  return { schema: SCHEMA, workspaceId, updatedAt: value.updatedAt,
    counters: { preparationsCompleted, preparationFailures, activationsCompleted, activationFailures } as SkillActivationCounters,
    providers };
}

export async function readRelaySkillActivationState(home: string, workspaceId: string): Promise<RelaySkillActivationState | null> {
  try {
    return parseRelaySkillActivationState(JSON.parse(await readFile(relaySkillActivationPath(home, workspaceId), 'utf8')), workspaceId);
  } catch {
    return null;
  }
}

/** The reason a shared repository package is still pending, from results recorded since the wait began. */
export function repositoryReadinessPendingCode(state: RelaySkillActivationState | null, provider: string,
  sinceMs: number): string {
  const result = state?.providers[provider];
  if (!result || !(Date.parse(result.at) >= sinceMs)) return 'skill_activation_not_observed';
  if (result.outcome === 'failed') return result.errorCode ?? 'install_failed';
  if (result.outcome === 'no_rollout') return 'rollout_not_offered';
  return 'installed_bundle_lacks_repository_knowledge';
}
