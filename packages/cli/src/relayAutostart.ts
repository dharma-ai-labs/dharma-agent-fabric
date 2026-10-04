import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { promisify } from 'node:util';
import { containerEntrypointAvailable, containerStartupControl, containerStartupState, ownsContainerStartup,
  writeContainerRegistration, readContainerRegistration, type ContainerRuntime, type ContainerRelayRegistration } from './containerRelayLifecycle.js';

const execFileAsync = promisify(execFile);
const UNIT_NAME = 'dharma-agent-fabric.service';
const MAC_LABEL = 'io.dharma.agent-fabric.relay';
const VERSION = /^(?=.{1,64}$)\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/;

type Runner = (file: string, args: string[]) => Promise<{ stdout: string }>;

export interface RelayAutostartOptions {
  home: string;
  userHome?: string;
  platform?: NodeJS.Platform;
  uid?: number;
  run?: Runner;
  containerRuntime?: ContainerRuntime;
}

interface RegistrationFields {
  backend: 'systemd-user' | 'windows-task' | 'launchd-user' | 'container-entrypoint';
  launcher: string;
  workspace: string;
  version: string;
  taskName: string | null;
}

export type RelayAutostartRegistration = RegistrationFields & ({ schema: 'dharma.relay-autostart/v1'; policy: string }
  | { schema: 'dharma.relay-autostart/v2'; mode: 'demo-only'; policy: null }
  | { schema: 'dharma.relay-autostart/v3'; policy: string });
type Registration = RelayAutostartRegistration;

export type RelayAutostartState = {
  state: 'enabled' | 'disabled' | 'unavailable' | 'unsupported';
  backend: Registration['backend'] | null;
  version?: string;
  reason?: string;
  lifecycle?: 'configured' | 'unconfigured' | 'paused' | 'blocked' | 'starting' | 'running';
  restartCoverage?: 'container-entrypoint-only';
  windowsVisibility?: 'legacy' | 'hidden';
  migrationRequired?: boolean;
};

const defaultRunner: Runner = async (file, args) => {
  const { stdout } = await execFileAsync(file, args, { timeout: 15_000, maxBuffer: 64 * 1024, windowsHide: true });
  return { stdout };
};

function safeLine(value: string) {
  if (!value || value.length > 4096 || /[\r\n\0]/.test(value)) {
    throw new Error('Autostart paths must be bounded nonempty single lines.');
  }
  return value;
}

function systemdValue(value: string) {
  return `"${safeLine(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/%/g, '%%')}"`;
}

function psLiteral(value: string) {
  return `'${safeLine(value).replace(/'/g, "''")}'`;
}

function xmlString(value: string) {
  const line = safeLine(value);
  if (/[\x00-\x1f]/.test(line)) throw new Error('Invalid LaunchAgent path.');
  return `<string>${line.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;')}</string>`;
}

export function macRelayLaunchAgent(launcher: string, policy: string | null, workspace: string, home: string) {
  if (![launcher, workspace, home, ...(policy === null ? [] : [policy])].every(isAbsolute)) {
    throw new Error('LaunchAgent paths must be absolute.');
  }
  const args = [launcher, 'relay', 'supervise', ...(policy === null ? ['--demo-only'] : ['--policy', policy])];
  return '<?xml version="1.0" encoding="UTF-8"?>\n'
    + '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n'
    + '<plist version="1.0"><dict>\n'
    + `<key>Label</key>${xmlString(MAC_LABEL)}\n`
    + `<key>ProgramArguments</key><array>${args.map(xmlString).join('')}</array>\n`
    + `<key>WorkingDirectory</key>${xmlString(workspace)}\n`
    + `<key>EnvironmentVariables</key><dict><key>DHARMA_HOME</key>${xmlString(home)}</dict>\n`
    + '<key>RunAtLoad</key><true/>\n<key>KeepAlive</key><true/>\n'
    + '<key>ThrottleInterval</key><integer>10</integer>\n'
    + '<key>LimitLoadToSessionType</key><string>Aqua</string>\n'
    + '<key>StandardOutPath</key><string>/dev/null</string>\n'
    + '<key>StandardErrorPath</key><string>/dev/null</string>\n'
    + '</dict></plist>\n';
}

function backendPlatform(backend: Registration['backend']): NodeJS.Platform {
  return backend === 'systemd-user' || backend === 'container-entrypoint' ? 'linux' : backend === 'launchd-user' ? 'darwin' : 'win32';
}

function macDomain(options: RelayAutostartOptions) {
  const uid = options.uid ?? process.getuid?.();
  if (!Number.isSafeInteger(uid) || uid! <= 0) throw new Error('launchd_user_unavailable: a non-root signed-in user is required.');
  return `gui/${uid}`;
}

function macPath(options: RelayAutostartOptions) {
  return join(options.userHome || homedir(), 'Library', 'LaunchAgents', `${MAC_LABEL}.plist`);
}

function startupPath(options: RelayAutostartOptions, backend: Registration['backend']) {
  return backend === 'systemd-user' ? unitPath(options.userHome || homedir())
    : backend === 'launchd-user' ? macPath(options) : scriptPath(options.home);
}

function startupContents(options: RelayAutostartOptions, registration: Registration) {
  return registration.backend === 'systemd-user'
    ? linuxRelayUnit(registration.launcher, registration.policy, registration.workspace, options.home)
    : registration.backend === 'launchd-user'
      ? macRelayLaunchAgent(registration.launcher, registration.policy, registration.workspace, options.home)
      : windowsRelayStartupScript(registration.launcher, registration.policy, options.home);
}

// launchctl print is diagnostic text: unknown layouts fail closed until qualified.
async function macLoaded(options: RelayAutostartOptions, registration: Registration): Promise<boolean> {
  let output: string;
  try {
    output = (await (options.run || defaultRunner)('/bin/launchctl', ['print', `${macDomain(options)}/${MAC_LABEL}`])).stdout;
  } catch (error) {
    const failure = error as { code?: number; stderr?: string };
    if (failure.code === 113 && /Could not find service/.test(failure.stderr || '')) return false;
    throw error;
  }
  const path = output.match(/^\s*path = (.+)$/m)?.[1];
  const program = output.match(/^\s*program = (.+)$/m)?.[1];
  const workspace = output.match(/^\s*working directory = (.+)$/m)?.[1];
  const environment = output.match(/^\s*environment = \{\n([\s\S]*?)^\s*\}/m)?.[1];
  const home = environment?.match(/^\s*DHARMA_HOME => (.+)$/m)?.[1];
  const args = output.match(/^\s*arguments = \{\n([\s\S]*?)^\s*\}/m)?.[1]
    ?.trim().split('\n').map(line => line.trim());
  const expected = [registration.launcher, 'relay', 'supervise',
    ...(registration.policy === null ? ['--demo-only'] : ['--policy', registration.policy])];
  if (path !== macPath(options) || program !== registration.launcher
    || workspace !== registration.workspace || home !== options.home
    || JSON.stringify(args) !== JSON.stringify(expected)) {
    throw new Error('autostart_conflict: loaded LaunchAgent does not match its ownership receipt.');
  }
  return true;
}

export function linuxRelayUnit(launcher: string, policy: string | null, workspace: string, home?: string) {
  return renderLinuxRelayUnit(launcher, policy, workspace, home, false);
}

function renderLinuxRelayUnit(launcher: string, policy: string | null, workspace: string,
  home: string | undefined, legacy: boolean) {
  // WorkingDirectory is a literal path, unlike ExecStart/Environment word lists.
  const directory = legacy ? systemdValue(workspace) : safeLine(workspace).replace(/%/g, '%%');
  if (!legacy && (!workspace.startsWith('/') || /[\x00-\x1f]|\s$|\\$/.test(workspace))) {
    throw new Error('Linux autostart working directory must be an absolute representable path.');
  }
  return `[Unit]\nDescription=Dharma Agent Fabric relay\nAfter=network-online.target\nWants=network-online.target\n\n`
    + `[Service]\nType=simple\nWorkingDirectory=${directory}\n`
    + (home ? `Environment=${systemdValue(`DHARMA_HOME=${home}`)}\n` : '')
    + `ExecStart=${systemdValue(launcher)} relay supervise `
    + (policy === null ? '--demo-only\n' : `--policy ${systemdValue(policy)}\n`)
    + `Restart=on-failure\nRestartSec=10s\nTimeoutStopSec=30s\n\n`
    + `[Install]\nWantedBy=default.target\n`;
}

export function windowsRelayStartupScript(launcher: string, policy: string | null, home?: string) {
  return `$ErrorActionPreference = 'Stop'\r\n`
    + (home ? `$env:DHARMA_HOME = ${psLiteral(home)}\r\n` : '')
    + `& ${psLiteral(launcher)} relay supervise `
    + (policy === null ? '--demo-only\r\n' : `--policy ${psLiteral(policy)}\r\n`)
    + `exit $LASTEXITCODE\r\n`;
}

function encodedPowerShell(command: string) {
  return ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(command, 'utf16le').toString('base64')];
}

function registrationPath(home: string) { return join(home, 'relay', 'autostart.json'); }
function unitPath(userHome: string) { return join(userHome, '.config', 'systemd', 'user', UNIT_NAME); }
function scriptPath(home: string) { return join(home, 'relay', 'autostart.ps1'); }
function taskName(home: string) {
  return `DharmaAgentFabric-${createHash('sha256').update(home.toLowerCase()).digest('hex').slice(0, 12)}`;
}

async function readRegistration(options: RelayAutostartOptions): Promise<Registration | null> {
  const home = options.home;
  try {
    if ((options.platform || process.platform) === 'linux' && await containerEntrypointAvailable(options)) {
      return await readContainerRegistration(options);
    }
    if ((options.platform || process.platform) === 'win32') {
      const path = registrationPath(home);
      const stat = await lstat(path);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16384 || await realpath(path) !== path) {
        throw new Error('Invalid startup receipt.');
      }
    }
    const value = JSON.parse(await readFile(registrationPath(home), 'utf8')) as Registration;
    if (!value || typeof value !== 'object' || Array.isArray(value)
      || !['systemd-user', 'windows-task', 'launchd-user', 'container-entrypoint'].includes(value.backend)
      || typeof value.version !== 'string' || !VERSION.test(value.version)
      || typeof value.launcher !== 'string' || typeof value.workspace !== 'string'
      || (value.backend === 'windows-task' ? value.taskName !== taskName(home) : value.taskName !== null)) {
      throw new Error('Invalid startup receipt.');
    }
    const keys = ['schema', 'backend', 'launcher', 'policy', 'workspace', 'version', 'taskName'];
    if (value.schema === 'dharma.relay-autostart/v1' || value.schema === 'dharma.relay-autostart/v3') {
      if (typeof value.policy !== 'string') throw new Error('Invalid startup receipt.');
      safeLine(value.policy);
    } else if (value.schema === 'dharma.relay-autostart/v2') {
      if (value.policy !== null || value.mode !== 'demo-only') throw new Error('Invalid startup receipt.');
      keys.push('mode');
    } else throw new Error('Invalid startup receipt.');
    if (Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) {
      throw new Error('Invalid startup receipt.');
    }
    safeLine(value.launcher);
    safeLine(value.workspace);
    if ((value.schema === 'dharma.relay-autostart/v3' && value.backend !== 'container-entrypoint')
      || value.backend === 'container-entrypoint' && (value.schema !== 'dharma.relay-autostart/v3'
      || !isAbsolute(value.launcher) || !isAbsolute(value.workspace) || value.policy !== join(value.workspace, '.dharma', 'approved-policy.json'))) {
      throw new Error('Invalid container startup receipt.');
    }
    return value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    if (error instanceof Error && error.message.startsWith('container_startup_unavailable:')) throw error;
    throw new Error('autostart_receipt_invalid: startup ownership could not be verified.');
  }
}

async function ownsStartupFile(options: RelayAutostartOptions, registration: Registration, allowLegacy = false) {
  if (registration.backend === 'container-entrypoint') return ownsContainerStartup(options, registration as ContainerRelayRegistration);
  const path = startupPath(options, registration.backend);
  if (registration.backend === 'windows-task') {
    const stat = await lstat(path).catch(() => null);
    if (!stat?.isFile() || stat.isSymbolicLink() || stat.size > 16384 || await realpath(path) !== path) return false;
  }
  if (registration.backend === 'launchd-user') {
    const stat = await lstat(path).catch(() => null);
    if (!stat?.isFile() || stat.isSymbolicLink() || (stat.mode & 0o022) !== 0) return false;
  }
  const expected = startupContents(options, registration);
  const actual = await readFile(path, 'utf8').catch(() => null);
  return actual === expected || (allowLegacy && registration.backend === 'systemd-user'
    && actual === renderLinuxRelayUnit(registration.launcher, registration.policy,
      registration.workspace, options.home, true));
}

export function windowsRelayTaskArguments(home: string, visibility: 'legacy' | 'hidden' = 'hidden') {
  const path = safeLine(scriptPath(home));
  if (path.includes('"')) throw new Error('Autostart script path cannot contain a double quote.');
  return `-NoProfile -NonInteractive${visibility === 'hidden' ? ' -WindowStyle Hidden' : ''} -File "${path}"`;
}

function windowsTaskGuard(registration: Registration, home: string) {
  return `$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent(); `
    + `$principalMatches = $false; try { `
    + `$definition = [xml](Export-ScheduledTask -TaskName ${psLiteral(registration.taskName || '')} `
    + `-TaskPath $task.TaskPath -ErrorAction Stop); `
    + `$principals = @($definition.Task.Principals.Principal); `
    + `$principalMatches = $principals.Count -eq 1 -and $principals[0].UserId -eq $identity.User.Value `
    + `} catch { $principalMatches = $false }; `
    + `$actions = @($task.Actions); `
    + `if ($null -eq $task -or $task.TaskPath -cne '\\' -or $actions.Count -ne 1 `
    + `-or $actions[0].Execute -cne 'powershell.exe' `
    + `-or ($actions[0].Arguments -cne ${psLiteral(windowsRelayTaskArguments(home, 'legacy'))} `
    + `-and $actions[0].Arguments -cne ${psLiteral(windowsRelayTaskArguments(home))}) `
    + `-or $actions[0].WorkingDirectory -cne ${psLiteral(registration.workspace)} `
    + `-or $task.Principal.RunLevel -ne 'Limited' -or $task.Principal.LogonType -ne 'Interactive' `
    + `-or -not $principalMatches) `
    + `{ throw 'autostart_conflict' }; `;
}

function windowsTaskLookup(registration: Registration) {
  return `$task = $null; try { $task = Get-ScheduledTask -TaskName ${psLiteral(registration.taskName || '')} -ErrorAction Stop } `
    + `catch { if ($_.CategoryInfo.Category -ne 'ObjectNotFound') { throw 'autostart_task_lookup_failed' } }; `;
}

type WindowsVisibility = 'legacy' | 'hidden';
type WindowsTaskState = { state: 'enabled' | 'disabled' | 'absent'; visibility: WindowsVisibility | null; running: boolean };

async function inspectWindowsTask(options: RelayAutostartOptions, registration: Registration): Promise<WindowsTaskState> {
  const { stdout } = await (options.run || defaultRunner)('powershell.exe', encodedPowerShell(
    windowsTaskLookup(registration)
    + `if ($null -eq $task) { @{ state='absent'; visibility=$null; running=$false } | ConvertTo-Json -Compress; exit 0 }; `
    + windowsTaskGuard(registration, options.home)
    + `$visibility = if ($task.Actions[0].Arguments -ceq ${psLiteral(windowsRelayTaskArguments(options.home))}) { 'hidden' } else { 'legacy' }; `
    + `$state = if ($task.State -eq 'Disabled') { 'disabled' } else { 'enabled' }; `
    + `@{ state=$state; visibility=$visibility; running=($task.State -eq 'Running') } | ConvertTo-Json -Compress`));
  let value: WindowsTaskState;
  try { value = JSON.parse(stdout); } catch { throw new Error('autostart_task_readback_invalid'); }
  if (!value || Object.keys(value).length !== 3 || !['enabled', 'disabled', 'absent'].includes(value.state)
    || typeof value.running !== 'boolean' || (value.state === 'absent'
      ? value.visibility !== null || value.running : !['legacy', 'hidden'].includes(String(value.visibility)))) {
    throw new Error('autostart_task_readback_invalid');
  }
  return value;
}

async function pauseWindowsTask(options: RelayAutostartOptions, registration: Registration, previous: Registration | null = null) {
  await (options.run || defaultRunner)('powershell.exe', encodedPowerShell(
    windowsReplacementGuard(registration, options.home, previous)
    + `if ($null -ne $task) { Disable-ScheduledTask -TaskName ${psLiteral(registration.taskName!)} -ErrorAction Stop | Out-Null }`));
}

function windowsReplacementGuard(registration: Registration, home: string, previous: Registration | null,
  expectAbsent = false) {
  return windowsTaskLookup(registration)
    + (expectAbsent ? `if ($null -ne $task) { throw 'autostart_conflict' }; `
      : `if ($null -ne $task) { try { ${windowsTaskGuard(registration, home)} } catch { `
        + (previous ? windowsTaskGuard(previous, home) : `throw 'autostart_conflict'; `)
        + `}; if ($task.State -eq 'Running') { throw 'autostart_runtime_busy' } }; `);
}

function windowsRegistrationCommand(registration: Registration, home: string, visibility: WindowsVisibility,
  previous: Registration | null, expectAbsent = false) {
  return windowsReplacementGuard(registration, home, previous, expectAbsent)
    + `$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name; `
    + `$action = New-ScheduledTaskAction -Execute 'powershell.exe' `
    + `-Argument ${psLiteral(windowsRelayTaskArguments(home, visibility))} `
    + `-WorkingDirectory ${psLiteral(registration.workspace)}; `
    + `$trigger = New-ScheduledTaskTrigger -AtLogOn -User $identity; `
    + `$principal = New-ScheduledTaskPrincipal -UserId $identity -LogonType Interactive -RunLevel Limited; `
    + `$settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero) `
    + `-RestartCount 10 -RestartInterval (New-TimeSpan -Minutes 1); `
    + `Register-ScheduledTask -TaskName ${psLiteral(registration.taskName!)} -Action $action `
    + `-Trigger $trigger -Principal $principal -Settings $settings -Force -ErrorAction Stop | Out-Null`;
}

type WindowsJournal = { schema: 'dharma.windows-startup-transaction/v1'; state: 'prepared' | 'completed' | 'rolled_back';
  home: string; previous: Registration | null; previousReceipt: string | null; next: Registration;
  previousTask: WindowsTaskState; visibility: WindowsVisibility };
const windowsJournalPath = (home: string) => join(home, 'relay', 'windows-startup-transaction.json');

async function assertNoWindowsRecovery(options: RelayAutostartOptions) {
  if ((await readWindowsJournal(options))?.state === 'prepared') {
    throw new Error('autostart_recovery_required: use the stopped-runtime upgrade rollback.');
  }
}

async function atomicStartupFile(path: string, contents: string) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, contents, { mode: 0o600, flag: 'wx' });
  try { await rename(temporary, path); } finally { await rm(temporary, { force: true }); }
}

function validWindowsReceipt(value: unknown, home: string): value is Registration {
  const registration = value as Registration;
  if (!registration || typeof registration !== 'object' || Array.isArray(registration)
    || registration.backend !== 'windows-task' || registration.taskName !== taskName(home)
    || !VERSION.test(registration.version) || typeof registration.launcher !== 'string'
    || typeof registration.workspace !== 'string') return false;
  const keys = ['schema', 'backend', 'launcher', 'policy', 'workspace', 'version', 'taskName'];
  if (registration.schema === 'dharma.relay-autostart/v1') {
    if (typeof registration.policy !== 'string') return false;
  } else if (registration.schema === 'dharma.relay-autostart/v2') {
    if (registration.policy !== null || registration.mode !== 'demo-only') return false;
    keys.push('mode');
  } else return false;
  try { for (const path of [registration.launcher, registration.workspace, ...(registration.policy === null ? [] : [registration.policy])]) safeLine(path); }
  catch { return false; }
  return Object.keys(registration).length === keys.length && keys.every(key => Object.hasOwn(registration, key));
}

async function readWindowsJournal(options: RelayAutostartOptions): Promise<WindowsJournal | null> {
  const path = windowsJournalPath(options.home);
  const stat = await lstat(path).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return null; throw error; });
  if (!stat) return null;
  try {
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 65536 || await realpath(path) !== path) throw new Error();
    const value = JSON.parse(await readFile(path, 'utf8')) as WindowsJournal;
    const keys = ['schema', 'state', 'home', 'previous', 'previousReceipt', 'next', 'previousTask', 'visibility'];
    if (!value || Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))
      || value.schema !== 'dharma.windows-startup-transaction/v1' || value.home !== options.home
      || !['prepared', 'completed', 'rolled_back'].includes(value.state)
      || !['legacy', 'hidden'].includes(value.visibility) || !validWindowsReceipt(value.next, options.home)
      || (value.previous !== null && !validWindowsReceipt(value.previous, options.home))
      || (value.previous === null ? value.previousReceipt !== null || value.previousTask.state !== 'absent'
        : typeof value.previousReceipt !== 'string' || value.previousReceipt.length > 16384
          || JSON.stringify(JSON.parse(value.previousReceipt)) !== JSON.stringify(value.previous))
      || !value.previousTask || Object.keys(value.previousTask).length !== 3
      || !['enabled', 'disabled', 'absent'].includes(value.previousTask.state)
      || value.previousTask.running !== false || (value.previousTask.state === 'absent'
        ? value.previousTask.visibility !== null : !['legacy', 'hidden'].includes(String(value.previousTask.visibility)))) throw new Error();
    return value;
  } catch { throw new Error('autostart_transaction_invalid'); }
}

async function checkWindowsStartupFiles(options: RelayAutostartOptions, create = true) {
  if (create) await mkdir(join(options.home, 'relay'), { recursive: true, mode: 0o700 });
  if (await realpath(join(options.home, 'relay')) !== join(options.home, 'relay')) throw new Error('autostart_conflict');
  for (const path of [registrationPath(options.home), scriptPath(options.home)]) {
    const stat = await lstat(path).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return null; throw error; });
    if (stat && (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16384 || await realpath(path) !== path)) throw new Error('autostart_conflict');
  }
}

async function inspectWindowsRecovery(options: RelayAutostartOptions, journal: WindowsJournal) {
  await checkWindowsStartupFiles(options, false);
  const receipt = await readFile(registrationPath(options.home), 'utf8').catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return null; throw error; });
  const script = await readFile(scriptPath(options.home), 'utf8').catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return null; throw error; });
  const nextReceipt = `${JSON.stringify(journal.next, null, 2)}\n`;
  if (![journal.previousReceipt, nextReceipt].includes(receipt)
    || ![journal.previous ? startupContents(options, journal.previous) : null, startupContents(options, journal.next)].includes(script)) {
    throw new Error('autostart_conflict');
  }
  // The task may be old or new after a lost scheduler acknowledgement, but never foreign.
  let actual: WindowsTaskState;
  try { actual = await inspectWindowsTask(options, journal.next); }
  catch (error) {
    if (!(error instanceof Error) || !error.message.includes('autostart_conflict') || !journal.previous) throw error;
    actual = await inspectWindowsTask(options, journal.previous);
  }
  if (actual.running) throw new Error('autostart_runtime_busy');
  return actual;
}

async function restoreWindowsStartup(options: RelayAutostartOptions, journal: WindowsJournal) {
  const actual = await inspectWindowsRecovery(options, journal);
  const run = options.run || defaultRunner;
  if (actual.state !== 'absent') {
    await pauseWindowsTask(options, journal.next, journal.previous);
  }
  // Keep the logon trigger disabled while restoring the compatible local pair.
  if (journal.previous) {
    await atomicStartupFile(scriptPath(options.home), startupContents(options, journal.previous));
    await atomicStartupFile(registrationPath(options.home), journal.previousReceipt!);
  }
  if (journal.previous && journal.previousTask.state !== 'absent') {
    await run('powershell.exe', encodedPowerShell(windowsRegistrationCommand(journal.previous,
      options.home, journal.previousTask.visibility!, journal.next)));
    if (journal.previousTask.state === 'disabled') await run('powershell.exe', encodedPowerShell(
      windowsTaskLookup(journal.previous) + windowsTaskGuard(journal.previous, options.home)
      + `Disable-ScheduledTask -TaskName ${psLiteral(journal.previous.taskName!)} -ErrorAction Stop | Out-Null`));
    const restored = await inspectWindowsTask(options, journal.previous);
    if (restored.visibility !== journal.previousTask.visibility || restored.state !== journal.previousTask.state || restored.running) {
      throw new Error('autostart_restore_unverified');
    }
  } else if (actual.state !== 'absent') {
    await run('powershell.exe', encodedPowerShell(windowsTaskLookup(journal.next) + windowsTaskGuard(journal.next, options.home)
      + `Unregister-ScheduledTask -TaskName ${psLiteral(journal.next.taskName!)} -Confirm:$false -ErrorAction Stop`));
    if ((await inspectWindowsTask(options, journal.next)).state !== 'absent') throw new Error('autostart_restore_unverified');
  }
  if (!journal.previous) {
    await rm(scriptPath(options.home), { force: true });
    await rm(registrationPath(options.home), { force: true });
  }
  await atomicStartupFile(windowsJournalPath(options.home), `${JSON.stringify({ ...journal, state: 'rolled_back' }, null, 2)}\n`);
}

export async function recoverWindowsRelayAutostart(options: RelayAutostartOptions & {
  dryRun?: boolean; workspace: string; launcher: string; policy: string | null;
}) {
  if ((options.platform || process.platform) !== 'win32') return { state: 'not_required' as const };
  const journal = await readWindowsJournal(options);
  if (!journal || journal.state !== 'prepared') return { state: 'not_required' as const };
  if (journal.next.workspace !== options.workspace || (journal.previous && journal.previous.workspace !== options.workspace)) {
    throw new Error('autostart_recovery_workspace_conflict');
  }
  if ([journal.next, ...(journal.previous ? [journal.previous] : [])]
    .some(receipt => receipt.launcher !== options.launcher || receipt.policy !== options.policy)) {
    throw new Error('autostart_recovery_scope_conflict');
  }
  if (options.dryRun) {
    await inspectWindowsRecovery(options, journal);
    return { state: 'planned' as const, reason: 'autostart_recovery_required' };
  }
  await restoreWindowsStartup(options, journal);
  return { state: 'rolled_back' as const };
}

async function configureWindowsStartup(options: RelayAutostartOptions, registration: Registration,
  previous: Registration | null, visibility: WindowsVisibility) {
  const pending = await readWindowsJournal(options);
  if (pending?.state === 'prepared') throw new Error('autostart_recovery_required: use the stopped-runtime upgrade rollback.');
  await checkWindowsStartupFiles(options);
  const actual = await inspectWindowsTask(options, previous || registration);
  if (!previous && actual.state !== 'absent') throw new Error('autostart_conflict');
  if (previous && JSON.stringify(previous) === JSON.stringify(registration) && actual.state === 'enabled'
    && actual.visibility === visibility) return;
  if (actual.running) throw new Error('autostart_runtime_busy: stop the owned relay before migrating startup.');
  const journal: WindowsJournal = { schema: 'dharma.windows-startup-transaction/v1', home: options.home,
    state: 'prepared', previous, next: registration, previousTask: actual, visibility,
    previousReceipt: previous ? await readFile(registrationPath(options.home), 'utf8') : null };
  await atomicStartupFile(windowsJournalPath(options.home), `${JSON.stringify(journal, null, 2)}\n`);
  try {
    if (actual.state !== 'absent') await pauseWindowsTask(options, previous || registration);
    await atomicStartupFile(scriptPath(options.home), startupContents(options, registration));
    await atomicStartupFile(registrationPath(options.home), `${JSON.stringify(registration, null, 2)}\n`);
    // Recheck the old action immediately before replacement, after local writes.
    const checked = await inspectWindowsTask(options, previous || registration);
    const expected = actual.state === 'absent' ? actual : { ...actual, state: 'disabled' };
    if (JSON.stringify(checked) !== JSON.stringify(expected)) throw new Error('autostart_conflict');
    await (options.run || defaultRunner)('powershell.exe', encodedPowerShell(
      windowsRegistrationCommand(registration, options.home, visibility, previous, actual.state === 'absent')));
    const observed = await inspectWindowsTask(options, registration);
    if (observed.state !== 'enabled' || observed.visibility !== visibility || observed.running) throw new Error('autostart_registration_unverified');
    await atomicStartupFile(windowsJournalPath(options.home), `${JSON.stringify({ ...journal, state: 'completed' }, null, 2)}\n`);
  } catch {
    try { await restoreWindowsStartup(options, journal); }
    catch { throw new Error('autostart_recovery_required: startup rollback is unverified; preserve the transaction.'); }
    throw new Error('autostart_registration_failed: previous startup restored.');
  }
}

export async function relayAutostartStatus(options: RelayAutostartOptions): Promise<RelayAutostartState> {
  if ((options.platform || process.platform) === 'win32') {
    try { await assertNoWindowsRecovery(options); }
    catch (error) { return { state: 'unavailable', backend: 'windows-task',
      reason: error instanceof Error && error.message.startsWith('autostart_recovery_required')
        ? 'autostart_recovery_required' : 'autostart_journal_invalid' }; }
  }
  let registration;
  try { registration = await readRegistration(options); }
  catch { return { state: 'unavailable', backend: null, reason: 'autostart_receipt_invalid' }; }
  if (!registration) return { state: 'disabled', backend: null };
  const platform = options.platform || process.platform;
  const run = options.run || defaultRunner;
  if (platform !== backendPlatform(registration.backend)) {
    return { state: 'unavailable', backend: registration.backend, version: registration.version, reason: 'platform_mismatch' };
  }
  if (!await ownsStartupFile(options, registration)) {
    return { state: 'unavailable', backend: registration.backend, version: registration.version,
      reason: 'autostart_conflict' };
  }
  try {
    if (registration.backend === 'container-entrypoint') return await containerStartupState(options, registration as ContainerRelayRegistration);
    if (registration.backend === 'launchd-user') {
      await macLoaded(options, registration);
      const disabled = (await run('/bin/launchctl', ['print-disabled', macDomain(options)])).stdout;
      const match = disabled.match(/"io\.dharma\.agent-fabric\.relay"\s*=>\s*(true|false)/);
      return { state: match?.[1] === 'false' ? 'enabled' : 'disabled',
        backend: registration.backend, version: registration.version };
    }
    if (registration.backend === 'windows-task') {
      const observed = await inspectWindowsTask(options, registration);
      return { state: observed.state === 'absent' ? 'disabled' : observed.state,
        backend: registration.backend, version: registration.version,
        ...(observed.visibility ? { windowsVisibility: observed.visibility,
          migrationRequired: observed.visibility === 'legacy' } : {}) };
    }
    const result = await run('systemctl', ['--user', 'is-enabled', UNIT_NAME]);
    return { state: result.stdout.trim() === 'enabled' ? 'enabled' : 'disabled',
      backend: registration.backend, version: registration.version };
  } catch (error) {
    return { state: 'unavailable', backend: registration.backend, version: registration.version,
      reason: error instanceof Error && error.message.includes('autostart_conflict') ? 'autostart_conflict'
        : registration.backend === 'container-entrypoint' ? 'container_startup_unavailable'
        : registration.backend === 'systemd-user' ? 'systemd_user_unavailable'
        : registration.backend === 'launchd-user' ? 'launchd_user_unavailable' : 'task_scheduler_unavailable' };
  }
}

export async function enableRelayAutostart(options: RelayAutostartOptions & {
  workspace: string; launcher: string; policy: string | null; version: string;
  preserveStandardAnchor?: boolean;
  windowsVisibility?: WindowsVisibility;
}): Promise<RelayAutostartState> {
  const platform = options.platform || process.platform;
  if (platform !== 'linux' && platform !== 'win32' && platform !== 'darwin') {
    throw new Error(`Relay autostart is unsupported on ${platform}.`);
  }
  if (!VERSION.test(options.version)) throw new Error('Autostart version must be a bounded release version.');
  if (platform === 'win32') await assertNoWindowsRecovery(options);
  const userHome = options.userHome || homedir();
  const run = options.run || defaultRunner;
  const previous = await readRegistration(options);
  const backend = platform === 'linux'
    ? await containerEntrypointAvailable(options) ? 'container-entrypoint' : 'systemd-user'
    : platform === 'darwin' ? 'launchd-user' : 'windows-task';
  if (previous && previous.backend !== backend) {
    throw new Error('Existing relay autostart belongs to a different operating system.');
  }
  // Demo scopes share a standard service when one already owns this user's startup entry.
  const preserve = options.preserveStandardAnchor && previous?.policy !== null && Boolean(previous);
  if (preserve && previous!.version !== options.version) {
    throw new Error('relay_runtime_upgrade_required: upgrade the existing startup anchor before connecting another repository.');
  }
  const policy = preserve ? previous!.policy : options.policy ?? previous?.policy ?? null;
  const workspace = preserve || (options.policy === null && previous?.policy) ? previous!.workspace : options.workspace;
  const registration: Registration = {
    ...(policy === null ? { schema: 'dharma.relay-autostart/v2' as const, mode: 'demo-only' as const, policy: null }
      : { schema: backend === 'container-entrypoint' ? 'dharma.relay-autostart/v3' as const : 'dharma.relay-autostart/v1' as const,
        policy: safeLine(policy) }),
    backend,
    launcher: safeLine(preserve ? previous!.launcher : options.launcher),
    workspace: safeLine(workspace), version: options.version,
    taskName: platform === 'win32' ? taskName(options.home) : null,
  };
  if (backend === 'container-entrypoint') {
    if (registration.schema !== 'dharma.relay-autostart/v3' || !isAbsolute(registration.launcher)
      || !isAbsolute(registration.workspace) || registration.policy !== join(registration.workspace, '.dharma', 'approved-policy.json')) {
      throw new Error('container_startup_unavailable: a canonical enrolled repository policy is required.');
    }
    if (previous && !await ownsStartupFile(options, previous)) throw new Error('autostart_conflict: container startup is not owned.');
    await writeContainerRegistration(options, registration as ContainerRelayRegistration);
    await containerStartupControl(options, registration as ContainerRelayRegistration, true);
    return containerStartupState(options, registration as ContainerRelayRegistration);
  }
  if (platform === 'win32' && !previous) {
    const probe = await run('powershell.exe', encodedPowerShell(
      windowsTaskLookup(registration)
      + `if ($null -ne $task) { 'exists' } else { 'absent' }`,
    ));
    if (probe.stdout.trim() !== 'absent') {
      throw new Error('autostart_conflict: a Windows startup task exists without this enrollment receipt.');
    }
  }
  const destination = startupPath({ ...options, userHome }, backend);
  if (platform === 'darwin') {
    const stat = await lstat(destination).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (stat && (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o022) !== 0)) {
      throw new Error('autostart_conflict: LaunchAgent must be a private regular file.');
    }
    // Validate paths before touching an already loaded service.
    startupContents(options, registration);
  }
  const existingContents = await readFile(destination, 'utf8').catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  const ownedContents = previous && startupContents(options, previous);
  const ownedLegacyContents = previous && platform === 'linux'
    ? renderLinuxRelayUnit(previous.launcher, previous.policy, previous.workspace, options.home, true) : null;
  if (existingContents !== null && existingContents !== ownedContents && existingContents !== ownedLegacyContents) {
    throw new Error('autostart_conflict: the user startup entry is not owned by this enrollment.');
  }
  if (platform === 'win32' && previous) {
    await run('powershell.exe', encodedPowerShell(windowsTaskLookup(previous)
      + `if ($null -ne $task) { ${windowsTaskGuard(previous, options.home)} }`));
  }
  if (preserve) {
    const status = await relayAutostartStatus(options);
    if (status.state === 'enabled') return status;
  }
  if (platform === 'win32') {
    await configureWindowsStartup(options, registration, previous, options.windowsVisibility ?? 'hidden');
    const status = await relayAutostartStatus(options);
    if (status.state !== 'enabled') throw new Error('autostart_registration_unverified');
    return status;
  }
  if (platform === 'darwin') {
    const loaded = await macLoaded(options, previous || registration);
    if (loaded && !previous) throw new Error('autostart_conflict: LaunchAgent exists without an ownership receipt.');
    if (loaded) await run('/bin/launchctl', ['bootout', `${macDomain(options)}/${MAC_LABEL}`]);
  }
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
  await mkdir(dirname(registrationPath(options.home)), { recursive: true, mode: 0o700 });
  await writeFile(destination, startupContents(options, registration), { mode: 0o600 });
  await writeFile(registrationPath(options.home), `${JSON.stringify(registration, null, 2)}\n`, { mode: 0o600 });
  if (platform === 'linux') {
    await run('systemctl', ['--user', 'daemon-reload']);
    await run('systemctl', ['--user', 'enable', UNIT_NAME]);
  } else if (platform === 'darwin') {
    await run('/usr/bin/plutil', ['-lint', destination]);
    await run('/bin/launchctl', ['enable', `${macDomain(options)}/${MAC_LABEL}`]);
    await run('/bin/launchctl', ['bootstrap', macDomain(options), destination]);
  }
  const status = await relayAutostartStatus(options);
  if (status.state !== 'enabled') throw new Error(`Relay autostart registration was not verified (${status.state}).`);
  return status;
}

export async function disableRelayAutostart(options: RelayAutostartOptions): Promise<RelayAutostartState> {
  if ((options.platform || process.platform) === 'win32') await assertNoWindowsRecovery(options);
  const registration = await readRegistration(options);
  if (!registration) return { state: 'disabled', backend: null };
  const platform = options.platform || process.platform;
  if (platform !== backendPlatform(registration.backend)) {
    throw new Error('autostart_conflict: startup registration belongs to a different operating system.');
  }
  if (!await ownsStartupFile(options, registration, true)) {
    throw new Error('autostart_conflict: the startup file no longer matches its ownership receipt.');
  }
  const run = options.run || defaultRunner;
  if (registration.backend === 'container-entrypoint') {
    await containerStartupControl(options, registration as ContainerRelayRegistration, false);
    await rm(join(options.home, 'relay', 'container-control.json'), { force: true });
  } else if (registration.backend === 'systemd-user') {
    await run('systemctl', ['--user', 'disable', UNIT_NAME]);
    await rm(unitPath(options.userHome || homedir()), { force: true });
    await run('systemctl', ['--user', 'daemon-reload']);
  } else if (registration.backend === 'launchd-user') {
    if (await macLoaded(options, registration)) await run('/bin/launchctl', ['bootout', `${macDomain(options)}/${MAC_LABEL}`]);
    await run('/bin/launchctl', ['disable', `${macDomain(options)}/${MAC_LABEL}`]);
    await rm(macPath(options), { force: true });
  } else {
    if (registration.taskName !== taskName(options.home)) throw new Error('Relay autostart task identity is invalid.');
    await run('powershell.exe', encodedPowerShell(
      windowsTaskLookup(registration) + `if ($null -ne $task) { ${windowsTaskGuard(registration, options.home)} `
      + `Unregister-ScheduledTask -TaskName ${psLiteral(registration.taskName)} -Confirm:$false }`,
    ));
    await rm(scriptPath(options.home), { force: true });
  }
  await rm(registrationPath(options.home), { force: true });
  return { state: 'disabled', backend: registration.backend, version: registration.version };
}

export async function startRelayAutostart(options: RelayAutostartOptions) {
  const registration = await readRegistration(options);
  const status = await relayAutostartStatus(options);
  if (!registration || status.state !== 'enabled') {
    throw new Error(`autostart_conflict: an enabled owned startup entry is required (${status.reason ?? status.state}).`);
  }
  const run = options.run || defaultRunner;
  if (registration.backend === 'container-entrypoint') {
    await containerStartupControl(options, registration as ContainerRelayRegistration, true);
  } else if (registration.backend === 'systemd-user') {
    await run('systemctl', ['--user', 'start', UNIT_NAME]);
  } else if (registration.backend === 'launchd-user') {
    if (!await macLoaded(options, registration)) {
      await run('/bin/launchctl', ['bootstrap', macDomain(options), macPath(options)]);
    }
    await run('/bin/launchctl', ['kickstart', `${macDomain(options)}/${MAC_LABEL}`]);
  } else {
    await run('powershell.exe', encodedPowerShell(windowsTaskLookup(registration)
      + windowsTaskGuard(registration, options.home)
      + `Start-ScheduledTask -TaskName ${psLiteral(registration.taskName || '')}`));
  }
  return { state: 'start_requested' as const, backend: registration.backend, version: registration.version };
}

export async function inspectOwnedRelayAutostart(options: RelayAutostartOptions) {
  if ((options.platform || process.platform) === 'win32') await assertNoWindowsRecovery(options);
  const registration = await readRegistration(options);
  if (!registration || !await ownsStartupFile(options, registration)) {
    throw new Error('autostart_conflict: a verified owned startup entry is required.');
  }
  const platform = options.platform || process.platform;
  if (platform !== backendPlatform(registration.backend)) {
    throw new Error('autostart_conflict: startup registration belongs to another operating system.');
  }
  if (registration.backend === 'windows-task') {
    const observed = await inspectWindowsTask(options, registration);
    if (!observed.visibility) throw new Error('autostart_conflict: owned startup task is absent.');
    return { ...registration, windowsVisibility: observed.visibility };
  }
  if (registration.backend === 'launchd-user') await macLoaded(options, registration);
  return registration;
}

export async function stopRelayAutostart(options: RelayAutostartOptions) {
  const registration = await inspectOwnedRelayAutostart(options);
  const run = options.run || defaultRunner;
  if (registration.backend === 'container-entrypoint') {
    await containerStartupControl(options, registration as ContainerRelayRegistration, false);
  } else if (registration.backend === 'systemd-user') {
    await run('systemctl', ['--user', 'stop', UNIT_NAME]);
  } else if (registration.backend === 'launchd-user') {
    if (await macLoaded(options, registration)) await run('/bin/launchctl', ['bootout', `${macDomain(options)}/${MAC_LABEL}`]);
  } else {
    await run('powershell.exe', encodedPowerShell(windowsTaskLookup(registration)
      + windowsTaskGuard(registration, options.home)
      + `Stop-ScheduledTask -TaskName ${psLiteral(registration.taskName || '')}`));
  }
  return { state: 'stop_requested' as const, backend: registration.backend, version: registration.version };
}
