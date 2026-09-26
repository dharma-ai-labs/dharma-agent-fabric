import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const UNIT_NAME = 'dharma-agent-fabric.service';
const VERSION = /^(?=.{1,64}$)\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/;

type Runner = (file: string, args: string[]) => Promise<{ stdout: string }>;

export interface RelayAutostartOptions {
  home: string;
  userHome?: string;
  platform?: NodeJS.Platform;
  run?: Runner;
}

interface RegistrationFields {
  backend: 'systemd-user' | 'windows-task';
  launcher: string;
  workspace: string;
  version: string;
  taskName: string | null;
}

type Registration = RegistrationFields & ({ schema: 'dharma.relay-autostart/v1'; policy: string }
  | { schema: 'dharma.relay-autostart/v2'; mode: 'demo-only'; policy: null });

export type RelayAutostartState = {
  state: 'enabled' | 'disabled' | 'unavailable' | 'unsupported';
  backend: Registration['backend'] | null;
  version?: string;
  reason?: string;
};

const defaultRunner: Runner = async (file, args) => {
  const { stdout } = await execFileAsync(file, args, { timeout: 15_000, maxBuffer: 64 * 1024 });
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

async function readRegistration(home: string): Promise<Registration | null> {
  try {
    const value = JSON.parse(await readFile(registrationPath(home), 'utf8')) as Registration;
    if (!value || typeof value !== 'object' || Array.isArray(value)
      || !['systemd-user', 'windows-task'].includes(value.backend)
      || typeof value.version !== 'string' || !VERSION.test(value.version)
      || typeof value.launcher !== 'string' || typeof value.workspace !== 'string'
      || (value.backend === 'windows-task' ? value.taskName !== taskName(home) : value.taskName !== null)) {
      throw new Error('Invalid startup receipt.');
    }
    const keys = ['schema', 'backend', 'launcher', 'policy', 'workspace', 'version', 'taskName'];
    if (value.schema === 'dharma.relay-autostart/v1') {
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
    return value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new Error('autostart_receipt_invalid: startup ownership could not be verified.');
  }
}

async function ownsStartupFile(options: RelayAutostartOptions, registration: Registration, allowLegacy = false) {
  const path = registration.backend === 'systemd-user'
    ? unitPath(options.userHome || homedir()) : scriptPath(options.home);
  const expected = registration.backend === 'systemd-user'
    ? linuxRelayUnit(registration.launcher, registration.policy, registration.workspace, options.home)
    : windowsRelayStartupScript(registration.launcher, registration.policy, options.home);
  const actual = await readFile(path, 'utf8').catch(() => null);
  return actual === expected || (allowLegacy && registration.backend === 'systemd-user'
    && actual === renderLinuxRelayUnit(registration.launcher, registration.policy,
      registration.workspace, options.home, true));
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
    + `if ($null -eq $task -or $actions.Count -ne 1 `
    + `-or $actions[0].Execute -cne 'powershell.exe' `
    + `-or $actions[0].Arguments -cne ${psLiteral(`-NoProfile -NonInteractive -File "${scriptPath(home)}"`)} `
    + `-or $actions[0].WorkingDirectory -cne ${psLiteral(registration.workspace)} `
    + `-or -not $principalMatches) `
    + `{ throw 'autostart_conflict' }; `;
}

function windowsTaskLookup(registration: Registration) {
  return `$task = Get-ScheduledTask -TaskName ${psLiteral(registration.taskName || '')} -ErrorAction SilentlyContinue; `;
}

export async function relayAutostartStatus(options: RelayAutostartOptions): Promise<RelayAutostartState> {
  let registration;
  try { registration = await readRegistration(options.home); }
  catch { return { state: 'unavailable', backend: null, reason: 'autostart_receipt_invalid' }; }
  if (!registration) return { state: 'disabled', backend: null };
  const platform = options.platform || process.platform;
  const run = options.run || defaultRunner;
  if ((platform === 'linux' && registration.backend !== 'systemd-user')
    || (platform === 'win32' && registration.backend !== 'windows-task')) {
    return { state: 'unavailable', backend: registration.backend, version: registration.version, reason: 'platform_mismatch' };
  }
  if (!await ownsStartupFile(options, registration)) {
    return { state: 'unavailable', backend: registration.backend, version: registration.version,
      reason: 'autostart_conflict' };
  }
  try {
    const result = registration.backend === 'systemd-user'
      ? await run('systemctl', ['--user', 'is-enabled', UNIT_NAME])
      : await run('powershell.exe', encodedPowerShell(
        windowsTaskLookup(registration)
        + `if ($null -eq $task) { 'disabled'; exit 0 }; `
        + `try { ${windowsTaskGuard(registration, options.home)} } catch { 'conflict'; exit 0 }; `
        + `if ($task.State -ne 'Disabled') { 'enabled' } else { 'disabled' }`,
      ));
    if (result.stdout.trim() === 'conflict') return { state: 'unavailable', backend: registration.backend,
      version: registration.version, reason: 'autostart_conflict' };
    return { state: result.stdout.trim() === 'enabled' ? 'enabled' : 'disabled',
      backend: registration.backend, version: registration.version };
  } catch {
    return { state: 'unavailable', backend: registration.backend, version: registration.version,
      reason: registration.backend === 'systemd-user' ? 'systemd_user_unavailable' : 'task_scheduler_unavailable' };
  }
}

export async function enableRelayAutostart(options: RelayAutostartOptions & {
  workspace: string; launcher: string; policy: string | null; version: string;
}): Promise<RelayAutostartState> {
  const platform = options.platform || process.platform;
  if (platform !== 'linux' && platform !== 'win32') {
    throw new Error(`Relay autostart is unsupported on ${platform}.`);
  }
  if (!VERSION.test(options.version)) throw new Error('Autostart version must be a bounded release version.');
  const userHome = options.userHome || homedir();
  const run = options.run || defaultRunner;
  const previous = await readRegistration(options.home);
  if (previous && previous.backend !== (platform === 'linux' ? 'systemd-user' : 'windows-task')) {
    throw new Error('Existing relay autostart belongs to a different operating system.');
  }
  // Demo scopes share a standard service when one already owns this user's startup entry.
  const policy = options.policy ?? previous?.policy ?? null;
  const workspace = options.policy === null && previous?.policy ? previous.workspace : options.workspace;
  const registration: Registration = {
    ...(policy === null ? { schema: 'dharma.relay-autostart/v2' as const, mode: 'demo-only' as const, policy: null }
      : { schema: 'dharma.relay-autostart/v1' as const, policy: safeLine(policy) }),
    backend: platform === 'linux' ? 'systemd-user' : 'windows-task',
    launcher: safeLine(options.launcher),
    workspace: safeLine(workspace), version: options.version,
    taskName: platform === 'win32' ? taskName(options.home) : null,
  };
  if (platform === 'win32' && !previous) {
    const probe = await run('powershell.exe', encodedPowerShell(
      `$task = Get-ScheduledTask -TaskName ${psLiteral(registration.taskName!)} -ErrorAction SilentlyContinue; `
      + `if ($null -ne $task) { 'exists' } else { 'absent' }`,
    ));
    if (probe.stdout.trim() !== 'absent') {
      throw new Error('autostart_conflict: a Windows startup task exists without this enrollment receipt.');
    }
  }
  const destination = platform === 'linux' ? unitPath(userHome) : scriptPath(options.home);
  const existingContents = await readFile(destination, 'utf8').catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  const ownedContents = previous && (platform === 'linux'
    ? linuxRelayUnit(previous.launcher, previous.policy, previous.workspace, options.home)
    : windowsRelayStartupScript(previous.launcher, previous.policy, options.home));
  const ownedLegacyContents = previous && platform === 'linux'
    ? renderLinuxRelayUnit(previous.launcher, previous.policy, previous.workspace, options.home, true) : null;
  if (existingContents !== null && existingContents !== ownedContents && existingContents !== ownedLegacyContents) {
    throw new Error('autostart_conflict: the user startup entry is not owned by this enrollment.');
  }
  if (platform === 'win32' && previous) {
    await run('powershell.exe', encodedPowerShell(windowsTaskLookup(previous)
      + `if ($null -ne $task) { ${windowsTaskGuard(previous, options.home)} }`));
  }
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
  await mkdir(dirname(registrationPath(options.home)), { recursive: true, mode: 0o700 });
  await writeFile(destination, platform === 'linux'
    ? linuxRelayUnit(registration.launcher, registration.policy, registration.workspace, options.home)
    : windowsRelayStartupScript(registration.launcher, registration.policy, options.home), { mode: 0o600 });
  await writeFile(registrationPath(options.home), `${JSON.stringify(registration, null, 2)}\n`, { mode: 0o600 });
  if (platform === 'linux') {
    await run('systemctl', ['--user', 'daemon-reload']);
    await run('systemctl', ['--user', 'enable', UNIT_NAME]);
  } else {
    const script = scriptPath(options.home);
    const command = `$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name; `
      + `$action = New-ScheduledTaskAction -Execute 'powershell.exe' `
      + `-Argument ${psLiteral(`-NoProfile -NonInteractive -File "${script}"`)} `
      + `-WorkingDirectory ${psLiteral(registration.workspace)}; `
      + `$trigger = New-ScheduledTaskTrigger -AtLogOn -User $identity; `
      + `$principal = New-ScheduledTaskPrincipal -UserId $identity -LogonType Interactive -RunLevel Limited; `
      + `$settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero) `
      + `-RestartCount 10 -RestartInterval (New-TimeSpan -Minutes 1); `
      + `Register-ScheduledTask -TaskName ${psLiteral(registration.taskName!)} -Action $action `
      + `-Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null`;
    await run('powershell.exe', encodedPowerShell(command));
  }
  const status = await relayAutostartStatus(options);
  if (status.state !== 'enabled') throw new Error(`Relay autostart registration was not verified (${status.state}).`);
  return status;
}

export async function disableRelayAutostart(options: RelayAutostartOptions): Promise<RelayAutostartState> {
  const registration = await readRegistration(options.home);
  if (!registration) return { state: 'disabled', backend: null };
  const platform = options.platform || process.platform;
  if (platform !== (registration.backend === 'systemd-user' ? 'linux' : 'win32')) {
    throw new Error('autostart_conflict: startup registration belongs to a different operating system.');
  }
  if (!await ownsStartupFile(options, registration, true)) {
    throw new Error('autostart_conflict: the startup file no longer matches its ownership receipt.');
  }
  const run = options.run || defaultRunner;
  if (registration.backend === 'systemd-user') {
    await run('systemctl', ['--user', 'disable', UNIT_NAME]);
    await rm(unitPath(options.userHome || homedir()), { force: true });
    await run('systemctl', ['--user', 'daemon-reload']);
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
  const registration = await readRegistration(options.home);
  const status = await relayAutostartStatus(options);
  if (!registration || status.state !== 'enabled') {
    throw new Error(`autostart_conflict: an enabled owned startup entry is required (${status.reason ?? status.state}).`);
  }
  const run = options.run || defaultRunner;
  if (registration.backend === 'systemd-user') {
    await run('systemctl', ['--user', 'start', UNIT_NAME]);
  } else {
    await run('powershell.exe', encodedPowerShell(windowsTaskLookup(registration)
      + windowsTaskGuard(registration, options.home)
      + `Start-ScheduledTask -TaskName ${psLiteral(registration.taskName || '')}`));
  }
  return { state: 'start_requested' as const, backend: registration.backend, version: registration.version };
}
