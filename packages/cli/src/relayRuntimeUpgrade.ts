import { createHash, randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, readFile, realpath, rename, writeFile } from 'node:fs/promises';
import { join, posix } from 'node:path';

type Launchers = { shell: string; windows: string };
type State = 'prepared' | 'installed' | 'completed' | 'rolled_back' | 'rollback_failed';
type Input = { home: string; workspace: string; version: string; organizationId: string;
  deviceId: string; workspaceId: string; dryRun?: boolean; rollback?: boolean };
export type RelayUpgradeDependencies = {
  recoverableJournal?(version: string, previousVersion: string): boolean;
  launcherContents(version: string): Launchers;
  legacyLauncherContents?(version: string): Launchers;
  verifyPriorLaunchers?(version: string, contents: Launchers): Promise<boolean>;
  recordNextLaunchers?: boolean;
  verifyRecoveryLaunchers?(version: string, contents: Launchers): Promise<boolean>;
  assertStopped(): Promise<void>;
  inspectStartup(): Promise<{ version: string; workspace: string; codexHome?: string }>;
  configureStartup(version: string, restore?: {codexHome: string | null}): Promise<unknown>;
  start(): Promise<unknown>;
  stop(): Promise<unknown>;
  verify(version: string, since: string): Promise<void>;
};
type Journal = { schema: 'dharma.local-relay-upgrade/v1' | 'dharma.local-relay-upgrade-journal/v2' | 'dharma.local-relay-upgrade-journal/v3'; upgradeId: string; organizationId: string;
  deviceId: string; workspaceId: string; workspace: string; previousVersion: string; version: string;
  startedAt: string; updatedAt: string; state: State; previous: Launchers; previousHash: string;
  previousCodexHome?: string | null; next?: Launchers; nextHash?: string };
const VERSION = /^(?=.{1,64}$)\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/;
const hash = (value: Launchers) => `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
const same = (left: Launchers, right: Launchers) => left.shell === right.shell && left.windows === right.windows;
const fail = (code: string): never => { throw new Error(`relay_upgrade_${code}`); };
const profilePath = (value: unknown): value is string => typeof value === 'string' && value.length <= 4096
  && value.startsWith('/') && value !== '/' && !/[\x00-\x1f\x7f]|\s$|\\$/.test(value) && posix.resolve(value) === value;

async function atomic(path: string, contents: string, mode: number) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, contents, { mode, flag: 'wx' });
  await rename(temporary, path);
  if (process.platform !== 'win32') await chmod(path, mode);
}

async function readLaunchers(workspace: string): Promise<Launchers> {
  const paths = [join(workspace, '.dharma', 'bin', 'dharma'), join(workspace, '.dharma', 'bin', 'dharma.cmd')] as const;
  for (const path of paths) {
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16384) fail('launcher_conflict');
    if (await realpath(path) !== path) fail('launcher_conflict');
  }
  return { shell: await readFile(paths[0], 'utf8'), windows: await readFile(paths[1], 'utf8') };
}

async function installLaunchers(workspace: string, contents: Launchers) {
  await atomic(join(workspace, '.dharma', 'bin', 'dharma'), contents.shell, 0o700);
  await atomic(join(workspace, '.dharma', 'bin', 'dharma.cmd'), contents.windows, 0o600);
}

async function expectedPrevious(journal: Journal, deps: RelayUpgradeDependencies) {
  return same(journal.previous, deps.launcherContents(journal.previousVersion))
    || Boolean(deps.legacyLauncherContents && same(journal.previous, deps.legacyLauncherContents(journal.previousVersion)))
    || Boolean(journal.schema === 'dharma.local-relay-upgrade-journal/v3' && deps.verifyRecoveryLaunchers
      && await deps.verifyRecoveryLaunchers(journal.previousVersion, journal.previous))
    || Boolean(deps.verifyPriorLaunchers && await deps.verifyPriorLaunchers(journal.previousVersion, journal.previous));
}

async function expectedNext(journal: Journal, deps: RelayUpgradeDependencies) {
  const next = journal.next;
  return Boolean(next && typeof next === 'object' && !Array.isArray(next) && Object.keys(next).length === 2
    && typeof next.shell === 'string' && next.shell.length <= 16384
    && typeof next.windows === 'string' && next.windows.length <= 16384 && journal.nextHash === hash(next)
    && deps.verifyRecoveryLaunchers && await deps.verifyRecoveryLaunchers(journal.version, next));
}

const nextLaunchers = (journal: Journal, deps: RelayUpgradeDependencies) =>
  journal.schema === 'dharma.local-relay-upgrade-journal/v3' ? journal.next! : deps.launcherContents(journal.version);

async function validateJournal(value: unknown, input: Input, deps: RelayUpgradeDependencies) {
  const journal = value as Journal;
  const keys = ['schema', 'upgradeId', 'organizationId', 'deviceId', 'workspaceId', 'workspace',
    'previousVersion', 'version', 'startedAt', 'updatedAt', 'state', 'previous', 'previousHash'];
  if (journal?.schema === 'dharma.local-relay-upgrade-journal/v2'
    || journal?.schema === 'dharma.local-relay-upgrade-journal/v3') keys.push('previousCodexHome');
  if (journal?.schema === 'dharma.local-relay-upgrade-journal/v3') keys.push('next', 'nextHash');
  if (!journal || typeof journal !== 'object' || Array.isArray(journal)
    || Object.keys(journal).length !== keys.length || Object.keys(journal).some(key => !keys.includes(key))
    || !['dharma.local-relay-upgrade/v1', 'dharma.local-relay-upgrade-journal/v2', 'dharma.local-relay-upgrade-journal/v3'].includes(journal.schema)
    || journal.schema !== 'dharma.local-relay-upgrade/v1'
      && journal.previousCodexHome !== null && !profilePath(journal.previousCodexHome)
    || journal.organizationId !== input.organizationId || journal.deviceId !== input.deviceId
    || journal.workspaceId !== input.workspaceId || journal.workspace !== input.workspace
    || typeof journal.version !== 'string' || !VERSION.test(journal.version)
    || journal.version !== input.version && !(input.rollback === true
      && deps.recoverableJournal?.(journal.version, journal.previousVersion) === true)
    || typeof journal.previousVersion !== 'string' || !VERSION.test(journal.previousVersion)
    || typeof journal.upgradeId !== 'string' || !/^[0-9a-f-]{36}$/.test(journal.upgradeId)
    || !Number.isFinite(Date.parse(journal.startedAt)) || !Number.isFinite(Date.parse(journal.updatedAt))
    || !['prepared', 'installed', 'completed', 'rolled_back', 'rollback_failed'].includes(journal.state)
    || !journal.previous || Object.keys(journal.previous).length !== 2
    || typeof journal.previous.shell !== 'string' || typeof journal.previous.windows !== 'string'
    || journal.previousHash !== hash(journal.previous) || !await expectedPrevious(journal, deps)
    || journal.schema === 'dharma.local-relay-upgrade-journal/v3' && !await expectedNext(journal, deps)) {
    fail('journal_invalid');
  }
}

export async function upgradeRelayRuntime(input: Input, deps: RelayUpgradeDependencies) {
  if (!VERSION.test(input.version)) fail('version_invalid');
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/.test(input.organizationId)
    || ![input.deviceId, input.workspaceId].every(id => /^[0-9a-f-]{36}$/i.test(id))) fail('identity_invalid');
  // Validated rollback owns the startup pause; an auto-restarting relay cannot be stopped first.
  if (!input.rollback) await deps.assertStopped();
  const journalPath = join(input.home, 'relay', 'runtime-upgrade.json');
  let saved: unknown;
  try {
    const stat = await lstat(journalPath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 65536 || await realpath(journalPath) !== journalPath) {
      fail('journal_invalid');
    }
    saved = JSON.parse(await readFile(journalPath, 'utf8'));
    if ((saved as Journal)?.schema === 'dharma.local-relay-upgrade-journal/v3' && process.platform !== 'win32'
      && (stat.uid !== process.getuid!() || (stat.mode & 0o077))) fail('journal_invalid');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  if (saved) {
    // A different release may replace a completed journal, but cannot take over unfinished recovery.
    const old = saved as Journal;
    if (!input.rollback && ['completed', 'rolled_back'].includes(old.state)) {
      await validateJournal(old, { ...input, version: old.version }, deps);
      saved = undefined;
    }
    else await validateJournal(saved, input, deps);
  }
  if (saved && !input.rollback) fail('recovery_required');
  if (input.rollback && !saved) fail('rollback_unavailable');
  const startup = await deps.inspectStartup();
  if (startup.workspace !== input.workspace) fail('workspace_conflict');
  if (startup.codexHome !== undefined && !profilePath(startup.codexHome)) fail('startup_context_invalid');
  const previous = await readLaunchers(input.workspace);
  let journal: Journal;
  if (saved) {
    journal = saved as Journal;
    if (journal.schema === 'dharma.local-relay-upgrade/v1' && startup.codexHome !== undefined
      || journal.previousCodexHome && journal.previousCodexHome !== startup.codexHome) fail('journal_invalid');
    const next = nextLaunchers(journal, deps);
    if (![journal.version, journal.previousVersion].includes(startup.version)
      || ![journal.previous.shell, next.shell].includes(previous.shell)
      || ![journal.previous.windows, next.windows].includes(previous.windows)) {
      fail('launcher_conflict');
    }
  } else {
    if (!VERSION.test(startup.version)) fail('version_invalid');
    const previousNumbers = startup.version.split('-')[0]!.split('.').map(Number);
    const nextNumbers = input.version.split('-')[0]!.split('.').map(Number);
    for (let index = 0; index < 3; index++) {
      if (nextNumbers[index]! > previousNumbers[index]!) break;
      if (nextNumbers[index]! < previousNumbers[index]!) fail('downgrade_requires_rollback');
    }
    const next = deps.recordNextLaunchers ? deps.launcherContents(input.version) : undefined;
    journal = { schema: next ? 'dharma.local-relay-upgrade-journal/v3' : 'dharma.local-relay-upgrade-journal/v2', upgradeId: randomUUID(),
      organizationId: input.organizationId, deviceId: input.deviceId, workspaceId: input.workspaceId,
      workspace: input.workspace, previousVersion: startup.version, version: input.version,
      startedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), state: 'prepared',
      previous, previousHash: hash(previous), previousCodexHome: startup.codexHome ?? null,
      ...(next ? {next, nextHash: hash(next)} : {}) };
    if (!await expectedPrevious(journal, deps)) fail('launcher_conflict');
    if (next && !await expectedNext(journal, deps)) fail('launcher_conflict');
  }
  const receipt = (state: State | 'planned') => ({ ok: state === 'completed' || state === 'planned',
    schema: 'dharma.local-relay-upgrade/v1', upgradeId: journal.upgradeId, organizationId: input.organizationId,
    deviceId: input.deviceId, workspaceId: input.workspaceId, previousVersion: journal.previousVersion,
    version: journal.version, state, createdAt: new Date().toISOString(), previousLauncherHash: journal.previousHash,
    enrollmentChanged: false, skillsChanged: false,
    runtimeObservation: state === 'planned' ? 'not_performed' as const
      : state === 'rollback_failed' ? 'unconfirmed' as const : 'local_process_and_poll' as const,
    serverSignatureVerified: false });
  if (input.dryRun) return receipt('planned');
  await mkdir(join(input.home, 'relay'), { recursive: true, mode: 0o700 });
  if (await realpath(join(input.home, 'relay')) !== join(input.home, 'relay')) fail('journal_invalid');
  const save = async (state: State) => {
    journal.state = state; journal.updatedAt = new Date().toISOString();
    await atomic(journalPath, `${JSON.stringify(journal, null, 2)}\n`, 0o600);
  };
  const rollback = async () => {
    try {
      await deps.stop();
      await deps.assertStopped();
      const actual = await readLaunchers(input.workspace);
      // A crash between the two atomic writes can leave one old and one new launcher.
      const next = nextLaunchers(journal, deps);
      if (![journal.previous.shell, next.shell].includes(actual.shell)
        || ![journal.previous.windows, next.windows].includes(actual.windows)) fail('launcher_conflict');
      await installLaunchers(input.workspace, journal.previous);
      await deps.configureStartup(journal.previousVersion, journal.schema !== 'dharma.local-relay-upgrade/v1'
        ? {codexHome: journal.previousCodexHome!} : {codexHome: null});
      const since = new Date().toISOString();
      await deps.start(); await deps.verify(journal.previousVersion, since);
      await save('rolled_back');
      return receipt('rolled_back');
    } catch {
      await save('rollback_failed');
      return receipt('rollback_failed');
    }
  };
  if (input.rollback) return rollback();
  await save('prepared');
  try {
    await deps.assertStopped();
    if (!same(await readLaunchers(input.workspace), previous)) fail('launcher_conflict');
    await installLaunchers(input.workspace, nextLaunchers(journal, deps));
    await deps.configureStartup(input.version);
    await save('installed');
    const since = new Date().toISOString();
    await deps.start(); await deps.verify(input.version, since);
    await save('completed');
    return receipt('completed');
  } catch {
    return rollback();
  }
}

export function relayRuntimeObservationReady(input: {
  version: string; workspaceId: string; since: string; now?: number; allowLegacyPoll?: boolean;
  supervisorPid: number; relayPid: number; supervisor: unknown; lastPoll: unknown;
}) {
  const supervisor = input.supervisor as Record<string, unknown> | null;
  const poll = input.lastPoll as Record<string, unknown> | null;
  const at = typeof poll?.at === 'string' ? Date.parse(poll.at) : NaN;
  const now = input.now ?? Date.now();
  return Number.isSafeInteger(input.supervisorPid) && input.supervisorPid > 0
    && Number.isSafeInteger(input.relayPid) && input.relayPid > 0
    && supervisor?.pid === input.supervisorPid && supervisor.version === input.version
    && supervisor.workspaceId === input.workspaceId && poll?.workspaceId === input.workspaceId
    && poll.version === input.version && at >= Date.parse(input.since) && at <= now
    && now - at <= 300000
    && (poll.pid === input.relayPid || (poll.pid === undefined && input.allowLegacyPoll === true));
}
