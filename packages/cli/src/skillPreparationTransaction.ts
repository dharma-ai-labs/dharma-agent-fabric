import { constants, lstatSync, realpathSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { lstat, mkdir, open } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { parse, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { canonicalize, sha256, type ProviderId } from '@dharma-ai-labs/agent-fabric-contracts';

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$(?![\s\S])/;
const PROVIDERS = ['codex', 'claude', 'agy', 'hermes'];
const require = createRequire(import.meta.url);
const execFileAsync = promisify(execFile);
const ACL_SCRIPT = `$ErrorActionPreference='Stop';
  $path=[Environment]::GetEnvironmentVariable('DHARMA_PREPARATION_ACL_PATH');
  $acl=[System.IO.DirectoryInfo]::new($path).GetAccessControl();
  $descriptor=[System.Security.AccessControl.RawSecurityDescriptor]::new($acl.GetSecurityDescriptorBinaryForm(),0);
  $rules=@($acl.GetAccessRules($true,$true,[System.Security.Principal.SecurityIdentifier]) |
    Where-Object { $_.AccessControlType -eq [System.Security.AccessControl.AccessControlType]::Allow } |
    ForEach-Object { @{sid=$_.IdentityReference.Value;rights=[int64]$_.FileSystemRights;
      inheritOnly=(($_.PropagationFlags -band [System.Security.AccessControl.PropagationFlags]::InheritOnly) -ne 0)} });
  @{currentUserSid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value;
    ownerSid=$acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value;allowRules=$rules;
    daclPresent=(($descriptor.ControlFlags -band [System.Security.AccessControl.ControlFlags]::DiscretionaryAclPresent) -ne 0);
    daclNull=($null -eq $descriptor.DiscretionaryAcl)} |
    ConvertTo-Json -Depth 4 -Compress`;
const PRIVATE_DIRECTORY_ACL_SCRIPT = `$ErrorActionPreference='Stop';
  $path=[Environment]::GetEnvironmentVariable('DHARMA_PREPARATION_ACL_PATH');
  $current=[System.Security.Principal.WindowsIdentity]::GetCurrent().User;
  $acl=[System.Security.AccessControl.DirectorySecurity]::new();
  $acl.SetOwner($current);
  $acl.SetAccessRuleProtection($true,$false);
  $inherit=[System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor
    [System.Security.AccessControl.InheritanceFlags]::ObjectInherit;
  $propagation=[System.Security.AccessControl.PropagationFlags]::None;
  foreach($sid in @($current,[System.Security.Principal.SecurityIdentifier]::new('S-1-5-18'),
      [System.Security.Principal.SecurityIdentifier]::new('S-1-5-32-544'))){
    $rule=[System.Security.AccessControl.FileSystemAccessRule]::new($sid,
      [System.Security.AccessControl.FileSystemRights]::FullControl,$inherit,$propagation,
      [System.Security.AccessControl.AccessControlType]::Allow);
    [void]$acl.AddAccessRule($rule);
  }
  [System.IO.DirectoryInfo]::new($path).SetAccessControl($acl)`;

function powershellEnvironment(path: string): NodeJS.ProcessEnv {
  return { SystemRoot: process.env.SystemRoot, PATH: process.env.PATH,
    TEMP: process.env.TEMP, TMP: process.env.TMP, PSModulePath: process.env.PSModulePath,
    DHARMA_PREPARATION_ACL_PATH: path };
}

export function assertWindowsSkillPreparationAcl(value: unknown): void {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid Windows preparation ACL.');
  const acl = value as Record<string, unknown>;
  const sid = (value: unknown): value is string => typeof value === 'string' && /^S-1-[0-9-]{1,160}$(?![\s\S])/.test(value);
  if (!sid(acl.currentUserSid) || !sid(acl.ownerSid) || acl.daclPresent !== true || acl.daclNull !== false
    || !Array.isArray(acl.allowRules) || acl.allowRules.length > 128) {
    throw new Error('Invalid Windows preparation ACL.');
  }
  const trusted = new Set([acl.currentUserSid, 'S-1-5-18', 'S-1-5-32-544']);
  if (!trusted.has(acl.ownerSid)) throw new Error('Windows preparation path is not privately owned.');
  const harmless = 8 | 32 | 128 | 131072 | 1048576;
  for (const value of acl.allowRules) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid Windows preparation ACL rule.');
    const row = value as Record<string, unknown>;
    if (!sid(row.sid) || !Number.isSafeInteger(row.rights) || (row.rights as number) < 0
      || (row.rights as number) > 2147483647 || typeof row.inheritOnly !== 'boolean') throw new Error('Invalid Windows preparation ACL rule.');
    const creatorOwner = row.sid === 'S-1-3-0' && row.inheritOnly === true;
    if (!trusted.has(row.sid) && !creatorOwner && ((row.rights as number) & ~harmless) !== 0) {
      throw new Error('Windows preparation path is not private.');
    }
  }
}

export async function assertPrivatePath(path: string, stat: Awaited<ReturnType<typeof lstat>>): Promise<void> {
  if (process.platform !== 'win32') {
    const getuid = process.getuid;
    if (typeof getuid !== 'function' || typeof stat.uid !== 'number' || typeof stat.mode !== 'number'
      || stat.uid !== getuid() || (stat.mode & 0o077) !== 0) {
      throw new Error('Skill preparation path must be privately owned.');
    }
    return;
  }
  try {
    const { stdout } = await execFileAsync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', ACL_SCRIPT], {
      windowsHide: true, timeout: 5000, maxBuffer: 65536,
      env: powershellEnvironment(path),
    });
    assertWindowsSkillPreparationAcl(JSON.parse(stdout.replace(/^\uFEFF/, '')));
  } catch { throw new Error('Windows preparation private access could not be verified.'); }
}

async function hardenWindowsPrivateDirectory(path: string): Promise<void> {
  if (process.platform !== 'win32') return;
  try {
    await execFileAsync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', PRIVATE_DIRECTORY_ACL_SCRIPT], {
      windowsHide: true, timeout: 5000, maxBuffer: 65536, env: powershellEnvironment(path),
    });
  } catch { throw new Error('Windows preparation private access could not be established.'); }
}

function canonicalExistingHome(path: string): string {
  const resolved = resolve(path);
  try {
    const stat = lstatSync(resolved);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return resolved;
    return realpathSync.native(resolved);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return resolved;
    throw error;
  }
}

async function preflightAncestors(path: string): Promise<void> {
  let current = parse(resolve(path)).root;
  for (const part of relative(current, resolve(path)).split(sep).filter(Boolean)) {
    current = resolve(current, part);
    try {
      const stat = await lstat(current);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Skill preparation ancestor is not a real directory.');
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
  }
}

export function skillPreparationScopeRoot(home: string, workspaceId: string, provider: string): string {
  if (!home || !UUID.test(workspaceId) || !PROVIDERS.includes(provider)) {
    throw new Error('Skill preparation requires a canonical workspace and supported provider.');
  }
  const key = sha256(canonicalize({ schema: 'dharma.skill-preparation-scope/v1', workspaceId, provider })).slice(7);
  return resolve(canonicalExistingHome(home), 'relay', 'skill-pending-sources', key);
}

async function ensureDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Skill preparation directory is not an owned real directory.');
  await hardenWindowsPrivateDirectory(path);
  await assertPrivatePath(path, stat);
}

export async function withSkillPreparationTransaction<T>(input: {
  home: string;
  workspaceId: string;
  provider: ProviderId;
  assertCurrent: () => void;
  timeoutMs?: number;
}, operation: (scopeRoot: string) => Promise<T>): Promise<T> {
  const home = canonicalExistingHome(input.home);
  const root = skillPreparationScopeRoot(home, input.workspaceId, input.provider);
  const timeout = input.timeoutMs ?? 30000;
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 30000) throw new Error('Invalid skill preparation lock wait.');
  input.assertCurrent();
  await preflightAncestors(home);
  input.assertCurrent();
  for (const path of [home, resolve(home, 'relay'), resolve(home, 'relay', 'skill-pending-sources'), root]) {
    await ensureDirectory(path);
    input.assertCurrent();
  }
  // Permanent inode: never unlink or rename this file, including after a crash.
  const path = resolve(root, '.LOCK');
  try {
    const prior = await lstat(path);
    if (!prior.isFile() || prior.isSymbolicLink() || prior.nlink !== 1) throw new Error('Invalid skill preparation lock file.');
    await assertPrivatePath(path, prior);
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  input.assertCurrent();
  const file = await open(path, constants.O_RDWR | constants.O_CREAT | (constants.O_NOFOLLOW || 0), 0o600);
  let acquired = false;
  let native: { tryLock: (fd: number) => boolean; unlock: (fd: number) => void } | undefined;
  try {
    const held = await file.stat();
    await assertPrivatePath(path, held);
    const assertStableName = async () => {
      const current = await lstat(path);
      if (!held.isFile() || held.nlink !== 1 || !current.isFile() || current.isSymbolicLink()
        || current.dev !== held.dev || current.ino !== held.ino || current.nlink !== 1) {
        throw new Error('Skill preparation lock identity changed.');
      }
      input.assertCurrent();
    };
    await assertStableName();
    // Missing addon or unsupported locking fails closed; no stale-PID fallback.
    native = require('fs-native-extensions') as typeof native;
    if (!native || typeof native.tryLock !== 'function' || typeof native.unlock !== 'function') {
      throw new Error('Native skill preparation locking is unavailable.');
    }
    const deadline = Date.now() + timeout;
    while (!acquired) {
      input.assertCurrent();
      acquired = native.tryLock(file.fd);
      if (acquired) break;
      if (Date.now() >= deadline) throw new Error('Skill preparation lock was not granted within the wait limit.');
      await new Promise<void>(resolveWait => setTimeout(resolveWait, 25));
    }
    await assertStableName();
    const result = await operation(root);
    await assertStableName();
    return result;
  } finally {
    try { if (acquired) native!.unlock(file.fd); }
    finally { await file.close(); }
  }
}
