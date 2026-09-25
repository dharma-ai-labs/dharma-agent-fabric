import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const UNIT_NAME = 'dharma-agent-fabric.service';

type Runner = (file: string, args: string[]) => Promise<{ stdout: string }>;

export interface RelayAutostartOptions {
  home: string;
  userHome?: string;
  platform?: NodeJS.Platform;
  run?: Runner;
}

interface Registration {
  schema: 'dharma.relay-autostart/v1';
  backend: 'systemd-user' | 'windows-task';
  launcher: string;
  policy: string;
  workspace: string;
  version: string;
  taskName: string | null;
}

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
  if (!value || /[\r\n\0]/.test(value)) throw new Error('Autostart paths must be nonempty single lines.');
  return value;
}

function systemdValue(value: string) {
  return `"${safeLine(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/%/g, '%%')}"`;
}

function psLiteral(value: string) {
  return `'${safeLine(value).replace(/'/g, "''")}'`;
}

export function linuxRelayUnit(launcher: string, policy: string, workspace: string, home?: string) {
  return `[Unit]\nDescription=Dharma Agent Fabric relay\nAfter=network-online.target\nWants=network-online.target\n\n`
    + `[Service]\nType=simple\nWorkingDirectory=${systemdValue(workspace)}\n`
    + (home ? `Environment=${systemdValue(`DHARMA_HOME=${home}`)}\n` : '')
    + `ExecStart=${systemdValue(launcher)} relay supervise --policy ${systemdValue(policy)}\n`
    + `Restart=on-failure\nRestartSec=10s\nTimeoutStopSec=30s\n\n`
    + `[Install]\nWantedBy=default.target\n`;
}

export function windowsRelayStartupScript(launcher: string, policy: string, home?: string) {
  return `$ErrorActionPreference = 'Stop'\r\n`
    + (home ? `$env:DHARMA_HOME = ${psLiteral(home)}\r\n` : '')
    + `& ${psLiteral(launcher)} relay supervise --policy ${psLiteral(policy)}\r\n`
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
    if (value.schema !== 'dharma.relay-autostart/v1'
      || !['systemd-user', 'windows-task'].includes(value.backend)) return null;
    return value;
  } catch { return null; }
}

export async function relayAutostartStatus(options: RelayAutostartOptions): Promise<RelayAutostartState> {
  const registration = await readRegistration(options.home);
  if (!registration) return { state: 'disabled', backend: null };
  const platform = options.platform || process.platform;
  const run = options.run || defaultRunner;
  if ((platform === 'linux' && registration.backend !== 'systemd-user')
    || (platform === 'win32' && registration.backend !== 'windows-task')) {
    return { state: 'unavailable', backend: registration.backend, version: registration.version, reason: 'platform_mismatch' };
  }
  try {
    const result = registration.backend === 'systemd-user'
      ? await run('systemctl', ['--user', 'is-enabled', UNIT_NAME])
      : await run('powershell.exe', encodedPowerShell(
        `$task = Get-ScheduledTask -TaskName ${psLiteral(registration.taskName || '')} -ErrorAction SilentlyContinue; `
        + `if ($task -and $task.State -ne 'Disabled') { 'enabled' } else { 'disabled' }`,
      ));
    return { state: result.stdout.trim() === 'enabled' ? 'enabled' : 'disabled',
      backend: registration.backend, version: registration.version };
  } catch {
    return { state: 'unavailable', backend: registration.backend, version: registration.version,
      reason: registration.backend === 'systemd-user' ? 'systemd_user_unavailable' : 'task_scheduler_unavailable' };
  }
}

export async function enableRelayAutostart(options: RelayAutostartOptions & {
  workspace: string; launcher: string; policy: string; version: string;
}): Promise<RelayAutostartState> {
  const platform = options.platform || process.platform;
  if (platform !== 'linux' && platform !== 'win32') {
    throw new Error(`Relay autostart is unsupported on ${platform}.`);
  }
  const userHome = options.userHome || homedir();
  const run = options.run || defaultRunner;
  const previous = await readRegistration(options.home);
  if (previous && previous.backend !== (platform === 'linux' ? 'systemd-user' : 'windows-task')) {
    throw new Error('Existing relay autostart belongs to a different operating system.');
  }
  const registration: Registration = {
    schema: 'dharma.relay-autostart/v1',
    backend: platform === 'linux' ? 'systemd-user' : 'windows-task',
    launcher: safeLine(options.launcher), policy: safeLine(options.policy),
    workspace: safeLine(options.workspace), version: options.version,
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
  if (existingContents !== null && existingContents !== ownedContents) {
    throw new Error('autostart_conflict: the user startup entry is not owned by this enrollment.');
  }
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
  await mkdir(dirname(registrationPath(options.home)), { recursive: true, mode: 0o700 });
  await writeFile(destination, platform === 'linux'
    ? linuxRelayUnit(options.launcher, options.policy, options.workspace, options.home)
    : windowsRelayStartupScript(options.launcher, options.policy, options.home), { mode: 0o600 });
  await writeFile(registrationPath(options.home), `${JSON.stringify(registration, null, 2)}\n`, { mode: 0o600 });
  if (platform === 'linux') {
    await run('systemctl', ['--user', 'daemon-reload']);
    await run('systemctl', ['--user', 'enable', UNIT_NAME]);
  } else {
    const script = scriptPath(options.home);
    const command = `$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name; `
      + `$action = New-ScheduledTaskAction -Execute 'powershell.exe' `
      + `-Argument ${psLiteral(`-NoProfile -NonInteractive -File "${script}"`)} `
      + `-WorkingDirectory ${psLiteral(options.workspace)}; `
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
  const run = options.run || defaultRunner;
  if (registration.backend === 'systemd-user') {
    await run('systemctl', ['--user', 'disable', UNIT_NAME]);
    await rm(unitPath(options.userHome || homedir()), { force: true });
    await run('systemctl', ['--user', 'daemon-reload']);
  } else {
    if (registration.taskName !== taskName(options.home)) throw new Error('Relay autostart task identity is invalid.');
    await run('powershell.exe', encodedPowerShell(
      `Unregister-ScheduledTask -TaskName ${psLiteral(registration.taskName)} -Confirm:$false -ErrorAction SilentlyContinue`,
    ));
    await rm(scriptPath(options.home), { force: true });
  }
  await rm(registrationPath(options.home), { force: true });
  return { state: 'disabled', backend: registration.backend, version: registration.version };
}
