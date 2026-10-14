import {execFile} from 'node:child_process';
import {createHash} from 'node:crypto';
import {lstat, readFile, realpath, rm, writeFile} from 'node:fs/promises';
import {userInfo} from 'node:os';
import {join, resolve} from 'node:path';
import {captureBootstrapHostChild, currentBootstrapHostScope} from './bootstrapHostScope.js';

type Context = {distribution: string; linuxUser: string};
type Runner = (script: string) => Promise<{stdout: string}>;
export interface WslHostOptions {
  home: string;
  wslHost?: {context(): Promise<Context | null>; run?: Runner};
  run?: (file: string, args: string[]) => Promise<{stdout: string}>;
}
type Receipt = Context & {schema: 'dharma.wsl-relay-host/v1'; windowsSid: string;
  executable: string; taskName: string; arguments: string; description: string};
type State = {exists: boolean; enabled: boolean; running: boolean};
const fail = (conflict = false): never => {throw new Error(conflict
  ? 'autostart_conflict: the WSL host task is not owned by this installation.' : 'wsl_host_startup_unavailable');};
const receiptPath = (home: string) => join(home, 'relay', 'wsl-host.json');
const literal = (value: string) => `'${value.replace(/'/g, "''")}'`;
const object = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const digest = (home: string, context: Context) => createHash('sha256').update(JSON.stringify([home, context.distribution, context.linuxUser])).digest('hex');
const windowsArgs = (script: string) => ['/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe',
  '-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')];

export function resolveWslRelayContext(distribution: string | undefined, linuxUser: string, installed: unknown = null): Context {
  if (!distribution) {
    if (!object(installed) || installed.schema !== 'dharma.wsl-relay-host/v1'
      || installed.linuxUser !== linuxUser || typeof installed.distribution !== 'string') return fail();
    distribution = installed.distribution;
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$/.test(distribution) || distribution.trim() !== distribution
    || !/^[a-z_][a-z0-9_-]{0,31}$/.test(linuxUser)) return fail();
  return {distribution, linuxUser};
}

async function privateParent(options: WslHostOptions) {
  for (const path of [options.home, join(options.home, 'relay')]) {
    const stat = await lstat(path);
    if (!stat.isDirectory() || stat.isSymbolicLink() || await realpath(path) !== resolve(path)
      || process.platform !== 'win32' && ((stat.mode & 0o077) !== 0 || stat.uid !== process.getuid!())) return fail(true);
  }
}

async function windows(script: string): Promise<{stdout: string}> {
  const scope = currentBootstrapHostScope();
  const operation = () => new Promise<{stdout: string}>((accept, reject) => {
    const child = execFile('/init', windowsArgs(script),
    {cwd: '/mnt/c/Windows/System32', timeout: 15000, maxBuffer: 16384, signal: scope?.signal},
    (error, stdout) => error ? reject(error) : accept({stdout}));
    if (scope) captureBootstrapHostChild(scope, child);
  });
  return operation();
}

async function context(options: WslHostOptions): Promise<Context | null> {
  let value: Context | null;
  if (options.wslHost) value = await options.wslHost.context();
  else {
    if (process.platform !== 'linux') return null;
    for (const marker of ['/.dockerenv', '/run/.containerenv']) {
      try {await lstat(marker); return null;} catch (error) {if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return fail();}
    }
    const kernel = await readFile('/proc/sys/kernel/osrelease', 'utf8');
    if (!/microsoft/i.test(kernel)) return null;
    if (!process.getuid?.()) return fail();
    value = resolveWslRelayContext(process.env.WSL_DISTRO_NAME, userInfo().username,
      process.env.WSL_DISTRO_NAME ? null : await saved(options));
  }
  if (value === null) return null;
  if (!object(value) || Object.keys(value).sort().join(',') !== 'distribution,linuxUser'
    || typeof value.distribution !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$/.test(value.distribution)
    || value.distribution.trim() !== value.distribution || typeof value.linuxUser !== 'string'
    || !/^[a-z_][a-z0-9_-]{0,31}$/.test(value.linuxUser)) return fail();
  return value;
}

async function invoke(options: WslHostOptions, script: string): Promise<unknown> {
  const scope = currentBootstrapHostScope();
  try {
    if (windowsArgs(script).at(-1)!.length > 28000) return fail();
    const run: Runner = options.wslHost?.run || (options.run
      ? value => options.run!('/init', windowsArgs(value)) : windows);
    const result = await (scope ? scope.step(() => run(script)) : run(script));
    if (Buffer.byteLength(result.stdout) > 16384) return fail();
    return JSON.parse(result.stdout.replace(/^\uFEFF/, '').trim());
  } catch {await scope?.assert(); return fail();}
}

async function expected(options: WslHostOptions, current: Context): Promise<Receipt> {
  const identity = await invoke(options, '# dharma-wsl-host:identity\n$ErrorActionPreference="Stop"; '
    + '$sid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value; '
    + '$exe=Join-Path $env:SystemRoot "System32\\wsl.exe"; '
    + '@{sid=$sid;executable=$exe}|ConvertTo-Json -Compress');
  if (!object(identity) || Object.keys(identity).sort().join(',') !== 'executable,sid'
    || typeof identity.sid !== 'string' || !/^S-1-5-21-(?:\d{1,10}-){2}\d{1,10}-\d{1,10}$/.test(identity.sid)
    || typeof identity.executable !== 'string' || !/^[A-Za-z]:\\Windows\\System32\\wsl\.exe$/i.test(identity.executable)) return fail();
  const hash = digest(options.home, current);
  return {...current, schema: 'dharma.wsl-relay-host/v1', windowsSid: identity.sid,
    executable: identity.executable, taskName: `DharmaAgentFabric-WSL-${hash.slice(0, 24)}`,
    arguments: `--distribution "${current.distribution}" --user "${current.linuxUser}" --cd / --exec /usr/bin/systemctl --user start --wait dharma-agent-fabric.service`,
    description: `Dharma Agent Fabric owned WSL host ${hash}`};
}

async function saved(options: WslHostOptions): Promise<Receipt | null> {
  try {
    const path = receiptPath(options.home), stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 8192
      || process.platform !== 'win32' && ((stat.mode & 0o077) !== 0 || stat.uid !== process.getuid!())) return fail(true);
    await privateParent(options);
    const value: unknown = JSON.parse(await readFile(path, 'utf8'));
    if (!object(value)) return fail(true);
    return value as Receipt;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    return fail(true);
  }
}

function sameReceipt(value: Receipt, target: Receipt): boolean {
  const keys = Object.keys(target);
  return Object.keys(value).length === keys.length && keys.every(key => Reflect.get(value, key) === Reflect.get(target, key));
}

function lookup(receipt: Receipt, required = false) {
  return `$task=Get-ScheduledTask -TaskPath '\\' -TaskName ${literal(receipt.taskName)}${required ? '' : ' -ErrorAction SilentlyContinue'}; `;
}

function taskPreamble(receipt: Receipt, operation: string): string {
  return `# dharma-wsl-host:${operation}\n$ErrorActionPreference="Stop"; `
    + `$current=[System.Security.Principal.WindowsIdentity]::GetCurrent(); `
    + `if ($current.User.Value -cne ${literal(receipt.windowsSid)}) {throw 'wsl_host_identity_conflict'}; `
    + lookup(receipt)
    + `function Assert-OwnedTask($value) { $actions=@($value.Actions); $triggers=@($value.Triggers); `
    + `if ($value.Description -cne ${literal(receipt.description)} -or $actions.Count -ne 1 `
    + `-or $actions[0].Execute -cne ${literal(receipt.executable)} -or $actions[0].Arguments -cne ${literal(receipt.arguments)} `
    + `-or ($value.Principal.UserId -cne $current.User.Value -and $value.Principal.UserId -cne $current.Name) `
    + `-or [string]$value.Principal.LogonType -ne 'Interactive' -or [string]$value.Principal.RunLevel -ne 'Limited' `
    + `-or $triggers.Count -ne 1 -or $triggers[0].CimClass.CimClassName -ne 'MSFT_TaskLogonTrigger' -or !$triggers[0].Enabled `
    + `-or ($triggers[0].UserId -cne $current.User.Value -and $triggers[0].UserId -cne $current.Name) `
    + `-or [string]$value.Settings.MultipleInstances -ne 'IgnoreNew' `
    + `-or $value.Settings.ExecutionTimeLimit -ne 'PT0S' -or $value.Settings.RestartCount -ne 0 `
    + `-or $value.Settings.DisallowStartIfOnBatteries -or $value.Settings.StopIfGoingOnBatteries) {throw 'wsl_host_task_conflict'} }; `;
}

const renderState = `if ($null -eq $task) { @{exists=$false;enabled=$false;running=$false}|ConvertTo-Json -Compress } `
  + `else { Assert-OwnedTask $task; @{exists=$true;enabled=($task.State -ne 'Disabled');running=($task.State -eq 'Running')}|ConvertTo-Json -Compress }`;

async function query(options: WslHostOptions, receipt: Receipt): Promise<State> {
  const value = await invoke(options, taskPreamble(receipt, 'status') + renderState);
  if (!object(value) || Object.keys(value).sort().join(',') !== 'enabled,exists,running'
    || Object.values(value).some(field => typeof field !== 'boolean')) return fail();
  if (!value.exists && (value.enabled || value.running) || value.running && !value.enabled) return fail();
  return value as State;
}

export async function assertWslHostPreflight(options: WslHostOptions): Promise<void> {
  const current = await context(options); if (!current) return;
  const target = await expected(options, current), previous = await saved(options);
  if (previous && !sameReceipt(previous, target)) return fail(true);
  const state = await query(options, target);
  if (state.exists && !previous) return fail(true);
}

export async function enableWslRelayHost(options: WslHostOptions): Promise<void> {
  const current = await context(options); if (!current) return;
  const target = await expected(options, current), previous = await saved(options);
  if (previous && !sameReceipt(previous, target)) return fail(true);
  const before = await query(options, target);
  if (before.exists && !previous) return fail(true);
  await privateParent(options);
  if (!previous) await writeFile(receiptPath(options.home), `${JSON.stringify(target, null, 2)}\n`, {flag: 'wx', mode: 0o600});
  if (before.exists && before.enabled) return;
  // Preserve ownership before external mutation. Lost responses require readback,
  // not replacement of a possibly foreign task.
  await invoke(options, taskPreamble(target, 'register')
    + `if ($null -ne $task) { Assert-OwnedTask $task; Enable-ScheduledTask -TaskPath '\\' -TaskName ${literal(target.taskName)}|Out-Null } else { `
    + `$action=New-ScheduledTaskAction -Execute ${literal(target.executable)} -Argument ${literal(target.arguments)}; `
    + `$trigger=New-ScheduledTaskTrigger -AtLogOn -User $current.User.Value; `
    + `$principal=New-ScheduledTaskPrincipal -UserId $current.User.Value -LogonType Interactive -RunLevel Limited; `
    + `$settings=New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries; `
    + `Register-ScheduledTask -TaskPath '\\' -TaskName ${literal(target.taskName)} -Description ${literal(target.description)} `
    + `-Action $action -Trigger $trigger -Principal $principal -Settings $settings|Out-Null }; `
    + lookup(target, true) + renderState);
  const after = await query(options, target);
  if (!after.exists || !after.enabled) return fail();
}

export async function wslRelayHostStatus(options: WslHostOptions) {
  const current = await context(options); if (!current) return null;
  const previous = await saved(options); if (!previous) return fail();
  const target = await expected(options, current); if (!sameReceipt(previous, target)) return fail(true);
  return query(options, target);
}

export async function startWslRelayHost(options: WslHostOptions): Promise<void> {
  const current = await context(options); if (!current) return;
  const target = await expected(options, current), previous = await saved(options);
  if (!previous || !sameReceipt(previous, target)) return fail(true);
  const before = await query(options, target); if (!before.exists || !before.enabled) return fail();
  if (before.running) return;
  await invoke(options, taskPreamble(target, 'start') + `if ($null -eq $task) {throw 'wsl_host_missing'}; Assert-OwnedTask $task; `
    + `Start-ScheduledTask -TaskPath '\\' -TaskName ${literal(target.taskName)}; `
    + `for ($attempt=0; $attempt -lt 40; $attempt++) { ` + lookup(target, true)
    + `Assert-OwnedTask $task; if ($task.State -eq 'Running') {break}; Start-Sleep -Milliseconds 100 }; ` + renderState);
  if (!(await query(options, target)).running) return fail();
}

export async function disableWslRelayHost(options: WslHostOptions): Promise<void> {
  const previous = await saved(options); if (!previous) return;
  const current = await context(options); if (!current) return fail(true);
  const target = await expected(options, current); if (!sameReceipt(previous, target)) return fail(true);
  await query(options, target);
  await invoke(options, taskPreamble(target, 'disable') + `if ($null -ne $task) { Assert-OwnedTask $task; `
    + `Unregister-ScheduledTask -TaskPath '\\' -TaskName ${literal(target.taskName)} -Confirm:$false }; `
    + lookup(target) + renderState);
  if ((await query(options, target)).exists) return fail();
  await rm(receiptPath(options.home));
}
