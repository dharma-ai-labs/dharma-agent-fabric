import { resolve } from 'node:path';

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
const ENVIRONMENT_NAME = /^[A-Z_][A-Z0-9_]{0,127}$/;
const MAXIMUM_INHERITED_NAMES = 32;
// The relay and the task runner own every name with this prefix, including the runner-set
// DHARMA_TASK_WORKTREE, DHARMA_EXTERNAL_IDEMPOTENCY_KEY and DHARMA_ACTION_DIGEST.
const RESERVED_PREFIX = 'DHARMA_';

/** Optional `environment` entry of a registered command in `tasks.allowedCommands`. */
export interface AcceptanceCommandEnvironmentPolicy {
  /** Variable names the command may read from the relay environment, besides operating-system essentials. */
  inherit: string[];
}

/**
 * Returns the validated `environment` entry of a registered command, or `undefined` when it has none.
 * Names are unique case-insensitively and cannot start with `DHARMA_` in any letter case.
 */
export function acceptanceCommandEnvironmentPolicy(
  command: object,
  commandId: string,
): AcceptanceCommandEnvironmentPolicy | undefined {
  const environment: unknown = Reflect.get(command, 'environment');
  if (environment === undefined) return undefined;
  const invalid = () => new Error(`Registered command has an invalid environment policy: ${commandId}`);
  if (!environment || typeof environment !== 'object' || Array.isArray(environment)
    || Object.keys(environment).some((key) => key !== 'inherit')) {
    throw invalid();
  }
  const inherit = (environment as { inherit?: unknown }).inherit;
  if (!Array.isArray(inherit) || inherit.length > MAXIMUM_INHERITED_NAMES) throw invalid();
  const names = new Set<string>();
  for (const name of inherit) {
    // Windows compares environment names case-insensitively, so names must be unique on every platform.
    const key = typeof name === 'string' ? name.toUpperCase() : '';
    if (!ENVIRONMENT_NAME.test(key) || key.startsWith(RESERVED_PREFIX) || names.has(key)) throw invalid();
    names.add(key);
  }
  return { inherit: [...inherit] as string[] };
}

function sourceNameLookup(source: NodeJS.ProcessEnv, platform: NodeJS.Platform) {
  const windows = platform === 'win32';
  const normalize = (name: string) => windows ? name.toUpperCase() : name;
  const sourceNames = new Map<string, string>();
  for (const [name, value] of Object.entries(source)) {
    if (typeof value === 'string' && !sourceNames.has(normalize(name))) sourceNames.set(normalize(name), name);
  }
  return (name: string) => sourceNames.get(normalize(name));
}

function operatingSystemEssentials(source: NodeJS.ProcessEnv, platform: NodeJS.Platform, extraNames: string[] = []) {
  const lookup = sourceNameLookup(source, platform);
  const environment: Record<string, string> = {};
  for (const name of [...(platform === 'win32' ? WINDOWS_ESSENTIALS : POSIX_ESSENTIALS), ...extraNames]) {
    const sourceName = lookup(name);
    if (sourceName !== undefined) environment[sourceName] = source[sourceName]!;
  }
  return environment;
}

/**
 * Builds the environment for the relay's own Git calls: operating-system essentials, with the home
 * and configuration folders replaced by a relay-owned empty folder, the system configuration turned
 * off and the global configuration replaced by a relay-owned empty file. Git can start helper
 * programs named in configuration, which a provider or command may change.
 */
export function relayGitEnvironment(source: NodeJS.ProcessEnv, platform: NodeJS.Platform,
  isolation: { home: string; emptyFile: string }): Record<string, string> {
  const environment = operatingSystemEssentials(source, platform);
  const replaced = new Set(['HOME', 'XDG_CONFIG_HOME']);
  for (const name of Object.keys(environment)) {
    if (replaced.has(platform === 'win32' ? name.toUpperCase() : name)) delete environment[name];
  }
  environment.HOME = isolation.home;
  environment.XDG_CONFIG_HOME = isolation.home;
  environment.GIT_CONFIG_NOSYSTEM = '1';
  environment.GIT_CONFIG_GLOBAL = isolation.emptyFile;
  return environment;
}

/**
 * Builds the environment for the relay's Git calls before any task code runs (the checkout and the
 * reads of the operator's checkout settings): operating-system essentials, so Git reads the
 * operator's system and global configuration as the operator's own checkout does.
 */
export function operatorGitEnvironment(source: NodeJS.ProcessEnv, platform: NodeJS.Platform): Record<string, string> {
  return operatingSystemEssentials(source, platform);
}

/**
 * The global exclude file Git uses in `environment` when `core.excludesFile` is not set:
 * `$XDG_CONFIG_HOME/git/ignore`, else `<home>/.config/git/ignore`. Git for Windows uses
 * `USERPROFILE` as the home folder when `HOME` is not set.
 */
export function defaultGitExcludesFile(environment: Record<string, string>, platform: NodeJS.Platform): string | undefined {
  const lookup = sourceNameLookup(environment, platform);
  const value = (name: string) => {
    const sourceName = lookup(name);
    return sourceName === undefined ? undefined : environment[sourceName] || undefined;
  };
  const configHome = value('XDG_CONFIG_HOME');
  if (configHome) return resolve(configHome, 'git', 'ignore');
  const home = value('HOME') ?? (platform === 'win32' ? value('USERPROFILE') : undefined);
  return home ? resolve(home, '.config', 'git', 'ignore') : undefined;
}

export interface RegisteredCommandEnvironmentInput {
  /** The environment that values are read from. */
  source: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  /** The registered command, as resolved from the approved command policy. */
  command: object;
  commandId?: string;
}

/**
 * Builds the environment for a registered command that runs outside a task, such as a
 * skill smoke check: operating-system essentials and the names the command's approved
 * policy entry lists. It adds no runner-owned names.
 */
export function registeredCommandEnvironment(input: RegisteredCommandEnvironmentInput): Record<string, string> {
  const policy = acceptanceCommandEnvironmentPolicy(input.command, input.commandId ?? 'registered command');
  return operatingSystemEssentials(input.source, input.platform, policy?.inherit);
}

export interface AcceptanceCommandEnvironmentInput {
  /** The relay process environment that values are read from. */
  source: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  /** The command's working directory inside the task worktree. */
  cwd: string;
  /** The registered command, as resolved from the approved command policy. */
  command: object;
  commandId?: string;
  /** Values from a verified action-decision receipt, when the task carries one. */
  actionDecision?: { externalIdempotencyKey: string; actionDigest: string };
}

/**
 * Builds the complete environment for one registered acceptance command: operating-system
 * essentials, then the names the command's approved policy entry lists, then the runner-owned
 * names. Nothing else from the relay environment is passed.
 */
export function acceptanceCommandEnvironment(input: AcceptanceCommandEnvironmentInput): Record<string, string> {
  const environment = registeredCommandEnvironment({ source: input.source, platform: input.platform,
    command: input.command, commandId: input.commandId ?? 'acceptance command' });
  environment.DHARMA_TASK_WORKTREE = input.cwd;
  if (input.actionDecision) {
    environment.DHARMA_EXTERNAL_IDEMPOTENCY_KEY = input.actionDecision.externalIdempotencyKey;
    environment.DHARMA_ACTION_DIGEST = input.actionDecision.actionDigest;
  }
  return environment;
}
