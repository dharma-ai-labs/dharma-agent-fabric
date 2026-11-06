import { resolve } from 'node:path';

// Red-test scaffold: these exports keep today's behavior (no recorded reason) until the fix lands.

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

export class SkillActivationError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'SkillActivationError';
    this.code = code;
  }
}

export function skillActivationErrorCode(_error: unknown, _stage: SkillActivationStage): string {
  return 'unclassified';
}

export function nextSkillActivationResult(_previous: SkillActivationResult | undefined,
  attempt: SkillActivationResult): SkillActivationResult {
  return attempt;
}

export function relaySkillActivationPath(home: string, workspaceId: string): string {
  return resolve(home, 'relay', 'repositories', workspaceId, 'skill-activation.json');
}

export function parseRelaySkillActivationState(_value: unknown, _workspaceId: string): RelaySkillActivationState | null {
  return null;
}

export async function readRelaySkillActivationState(_home: string, _workspaceId: string): Promise<RelaySkillActivationState | null> {
  return null;
}

export function repositoryReadinessPendingCode(_state: RelaySkillActivationState | null, _provider: string,
  _sinceMs: number): string | null {
  return null;
}
