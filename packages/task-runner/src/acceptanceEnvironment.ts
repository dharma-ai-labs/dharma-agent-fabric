import { RESERVED_ENVIRONMENT_PREFIX, type CommandPolicy } from '@dharma-ai-labs/agent-fabric-policy';

// Operating-system essentials that registered build, test and lint commands commonly need.
// HOME, USERPROFILE, APPDATA, LOCALAPPDATA and XDG_CONFIG_HOME are not harmless: they locate
// per-user tool configuration and credential files. They are passed because npm and Git need
// them; the command still runs as the relay user, so this list is not a filesystem boundary.
const WINDOWS_ESSENTIALS = [
  'PATH', 'PATHEXT', 'SystemRoot', 'windir', 'ComSpec', 'SystemDrive', 'TEMP', 'TMP',
  'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'ProgramFiles', 'ProgramFiles(x86)', 'ProgramW6432',
  'ProgramData', 'CommonProgramFiles', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE', 'OS',
];
const POSIX_ESSENTIALS = [
  'PATH', 'HOME', 'TMPDIR', 'LANG', 'LANGUAGE', 'LC_ALL', 'LC_CTYPE', 'LC_MESSAGES', 'LC_COLLATE',
  'LC_NUMERIC', 'LC_TIME', 'LC_MONETARY', 'TZ', 'USER', 'LOGNAME', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME',
];

export interface AcceptanceCommandEnvironmentInput {
  /** The relay process environment that values are read from. */
  source: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  /** The command's working directory inside the task worktree. */
  cwd: string;
  command: Pick<CommandPolicy, 'environment'>;
  /** Values from a verified action-decision receipt, when the task carries one. */
  actionDecision?: { externalIdempotencyKey: string; actionDigest: string };
}

/**
 * Builds the complete environment for one registered acceptance command: operating-system
 * essentials, then the names the command's approved policy entry lists, then the runner-owned
 * names. Nothing else from the relay environment is passed.
 */
export function acceptanceCommandEnvironment(input: AcceptanceCommandEnvironmentInput): Record<string, string> {
  const windows = input.platform === 'win32';
  const normalize = (name: string) => windows ? name.toUpperCase() : name;
  const sourceNames = new Map<string, string>();
  for (const [name, value] of Object.entries(input.source)) {
    if (typeof value === 'string' && !sourceNames.has(normalize(name))) sourceNames.set(normalize(name), name);
  }
  const environment: Record<string, string> = {};
  const copy = (name: string) => {
    const sourceName = sourceNames.get(normalize(name));
    if (sourceName !== undefined) environment[sourceName] = input.source[sourceName]!;
  };
  for (const name of windows ? WINDOWS_ESSENTIALS : POSIX_ESSENTIALS) copy(name);
  for (const name of input.command.environment?.inherit ?? []) {
    if (name.toUpperCase().startsWith(RESERVED_ENVIRONMENT_PREFIX)) {
      throw new Error('Acceptance command environment cannot inherit a runner-owned name.');
    }
    copy(name);
  }
  environment.DHARMA_TASK_WORKTREE = input.cwd;
  if (input.actionDecision) {
    environment.DHARMA_EXTERNAL_IDEMPOTENCY_KEY = input.actionDecision.externalIdempotencyKey;
    environment.DHARMA_ACTION_DIGEST = input.actionDecision.actionDigest;
  }
  return environment;
}
