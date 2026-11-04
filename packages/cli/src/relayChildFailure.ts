// The local receipt for a relay child that exited. It holds stable codes only:
// error text can quote paths or server values, so it is never stored here.
const SCHEMA = 'dharma.local-relay-child-failure/v1';
const CODE = /^[a-z0-9_]{1,80}$/;

export interface RelayChildExit { pid: number | null; exitCode: number | null; signal: NodeJS.Signals | null }

export function relayChildFailureCode(error: unknown): string {
  const message = error instanceof Error ? error.message : '';
  if (message.startsWith('Workspace authorization replay state is missing or invalid')) {
    return 'workspace_authorization_replay_state_invalid';
  }
  if (message === 'Relay requires current enrollment.') return 'relay_enrollment_missing';
  if (message.startsWith('Relay policy ')) return 'relay_policy_not_registered';
  if (message.startsWith('Another relay process') || message.startsWith('Cannot start a second relay')) {
    return 'relay_lease_unavailable';
  }
  return 'relay_start_failed';
}

export function relayStartFailureReceipt(input: { error: unknown; pid: number; version: string;
  workspaceId: string | null; at?: string }) {
  return { schema: SCHEMA, code: relayChildFailureCode(input.error), at: input.at ?? new Date().toISOString(),
    pid: input.pid, version: input.version, workspaceId: input.workspaceId };
}

// The child's own code wins. A child that left none still leaves its exit status.
export function relayChildExitReceipt(input: { previous: unknown; exit: RelayChildExit; supervisorPid: number;
  version: string; at?: string }) {
  const previous = input.previous as Record<string, unknown> | null;
  const own = previous?.schema === SCHEMA && previous.pid === input.exit.pid && input.exit.pid !== null
    && typeof previous.code === 'string' && CODE.test(previous.code);
  return { schema: SCHEMA, code: own ? previous.code as string : 'relay_child_exited',
    at: input.at ?? new Date().toISOString(), pid: input.exit.pid, version: input.version,
    workspaceId: own && typeof previous.workspaceId === 'string' ? previous.workspaceId : null,
    supervisorPid: input.supervisorPid, exitCode: input.exit.exitCode, signal: input.exit.signal };
}

export function currentRelayChildFailure(receipt: unknown, supervisorPid: number) {
  const value = receipt as Record<string, unknown> | null;
  if (!value || value.schema !== SCHEMA || !Number.isSafeInteger(supervisorPid) || supervisorPid <= 0
    || value.supervisorPid !== supervisorPid || typeof value.code !== 'string' || !CODE.test(value.code)
    || typeof value.at !== 'string' || !Number.isFinite(Date.parse(value.at))) return null;
  return { code: value.code, at: value.at, exitCode: value.exitCode ?? null, signal: value.signal ?? null };
}
