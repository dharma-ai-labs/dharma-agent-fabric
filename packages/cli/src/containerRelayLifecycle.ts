import { createHash, randomUUID } from 'node:crypto';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

export interface ContainerProcessIdentity { pid: number; uid: number; startTicks: string; argv: string[] }
export interface ContainerChildIdentity { pid: number; uid: number; parentPid: number; startTicks: string }
// OS-boundary injection for deterministic process fixtures; no CLI/environment override.
export interface ContainerRuntime {
  identity?: () => Promise<ContainerProcessIdentity>;
  childIdentity?: (pid: number) => Promise<ContainerChildIdentity>;
  canonicalEntrypoint?: string;
  runtimeVersion?: string;
}
export interface ContainerLifecycleOptions { home: string; uid?: number; containerRuntime?: ContainerRuntime }
export interface ContainerRelayRegistration {
  schema: 'dharma.relay-autostart/v3'; backend: 'container-entrypoint'; launcher: string;
  workspace: string; policy: string; version: string; taskName: null;
}
interface Marker { schema: 'dharma.container-entrypoint/v1'; home: string; pid: number; uid: number; startTicks: string }
interface Control { schema: 'dharma.container-relay-control/v1'; home: string; registrationHash: string; running: boolean }
interface Heartbeat {
  schema: 'dharma.container-relay-heartbeat/v1'; home: string; startTicks: string;
  polledAt: number; lifecycle: 'unconfigured' | 'paused' | 'blocked' | 'starting' | 'running';
  reason: string | null; registrationHash: string | null; childPid: number | null; childStartTicks: string | null;
}
const unavailable = () => new Error('container_startup_unavailable: an owned live container entrypoint is required.');
const privatePath = (home: string, name: string) => join(home, 'relay', name);
const ownUid = (options: ContainerLifecycleOptions) => options.uid ?? process.getuid?.() ?? -1;

async function privateDirectory(options: ContainerLifecycleOptions) {
  if (!isAbsolute(options.home) || resolve(options.home) !== options.home || ownUid(options) <= 0) throw unavailable();
  for (const path of [options.home, join(options.home, 'relay')]) {
    const stat = await lstat(path);
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== ownUid(options) || (stat.mode & 0o077) !== 0) throw unavailable();
  }
}

async function privateJson(options: ContainerLifecycleOptions, name: string): Promise<unknown | null> {
  try {
    const path = privatePath(options.home, name);
    // Validate the opened descriptor, not two different path snapshots. An
    // owned atomic rename can legitimately replace the path between lstat/open.
    // O_NOFOLLOW and fstat still reject symlinks, foreign owners and unsafe modes.
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      await privateDirectory(options);
      const current = await file.stat();
      if (!current.isFile() || current.uid !== ownUid(options) || (current.mode & 0o077) !== 0
        || current.size > 32_768) throw unavailable();
      const text = await file.readFile('utf8');
      if (Buffer.byteLength(text) > 32_768) throw unavailable();
      return JSON.parse(text) as unknown;
    } finally { await file.close(); }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw unavailable();
  }
}

function exactObject(value: unknown, keys: string[]): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key)));
}

export async function readContainerPid1Identity(): Promise<ContainerProcessIdentity> {
  const [stat, command, owner] = await Promise.all([
    readFile('/proc/1/stat', 'utf8'), readFile('/proc/1/cmdline'), lstat('/proc/1'),
  ]);
  if (stat.length > 8192 || command.length > 8192) throw unavailable();
  const fields = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/);
  return { pid: 1, uid: owner.uid, startTicks: fields[19] || '',
    argv: command.toString('utf8').split('\0').filter(Boolean) };
}

async function publicRuntimeBytes(path: string, limit: number, executingCaller = false) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || !executingCaller && (stat.mode & 0o022) !== 0 || stat.size > limit) throw unavailable();
    const bytes = await file.readFile();
    if (bytes.length > limit) throw unavailable();
    return bytes;
  } finally { await file.close(); }
}

async function canonicalEntrypoint(options: ContainerLifecycleOptions, identity: ContainerProcessIdentity) {
  if (options.containerRuntime?.canonicalEntrypoint) return options.containerRuntime.canonicalEntrypoint;
  try {
    const current = await realpath(fileURLToPath(new URL('./bin.js', import.meta.url)));
    const candidate = identity.argv[1];
    if (!candidate || !isAbsolute(candidate) || candidate.length > 4096 || /[\r\n\0]/.test(candidate)
      || await realpath(candidate) !== candidate || !candidate.endsWith('/dist/bin.js')) throw unavailable();
    const manifest = JSON.parse((await publicRuntimeBytes(join(dirname(dirname(candidate)), 'package.json'), 65_536)).toString('utf8')) as { name?: unknown; version?: unknown };
    const own = JSON.parse((await publicRuntimeBytes(join(dirname(dirname(current)), 'package.json'), 65_536, true)).toString('utf8')) as { name?: unknown; version?: unknown };
    if (manifest.name !== '@dharma-ai-labs/agent-fabric' || manifest.name !== own.name || manifest.version !== own.version) throw unavailable();
    // Image and npm execution prefixes can differ. Verify the entrypoint and
    // bootstrap/lifecycle executable bytes, not an arbitrary path alias.
    for (const name of ['bin.js', 'index.js', 'containerRelayLifecycle.js']) {
      const [installed, caller] = await Promise.all([
        publicRuntimeBytes(join(dirname(candidate), name), 2_097_152), publicRuntimeBytes(join(dirname(current), name), 2_097_152, true),
      ]);
      if (!installed.equals(caller)) throw unavailable();
    }
    return candidate;
  } catch { throw unavailable(); }
}

function ownedIdentity(identity: ContainerProcessIdentity, uid: number, entrypoint: string) {
  return identity.pid === 1 && identity.uid === uid && Number.isSafeInteger(uid) && uid > 0 && /^\d{1,20}$/.test(identity.startTicks)
    && identity.argv.length === 4 && identity.argv[2] === 'relay' && identity.argv[3] === 'container-entrypoint'
    && identity.argv[1] === entrypoint && isAbsolute(entrypoint);
}

export async function readContainerChildIdentity(pid: number): Promise<ContainerChildIdentity> {
  if (!Number.isSafeInteger(pid) || pid <= 1) throw unavailable();
  const [stat, owner] = await Promise.all([readFile(`/proc/${pid}/stat`, 'utf8'), lstat(`/proc/${pid}`)]);
  if (stat.length > 8192 || Number(stat.slice(0, stat.indexOf(' '))) !== pid) throw unavailable();
  const fields = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/);
  if (fields[0] === 'Z' || fields[0] === 'X' || !/^\d{1,20}$/.test(fields[19] || '')) throw unavailable();
  return { pid, uid: owner.uid, parentPid: Number(fields[1]), startTicks: fields[19]! };
}

async function ownedChild(options: ContainerLifecycleOptions, pid: number, startTicks?: string) {
  const identity = await (options.containerRuntime?.childIdentity || readContainerChildIdentity)(pid);
  if (identity.pid !== pid || identity.uid !== ownUid(options) || identity.parentPid !== 1
    || !/^\d{1,20}$/.test(identity.startTicks) || startTicks !== undefined && identity.startTicks !== startTicks) throw unavailable();
  return identity;
}

export async function containerEntrypointAvailable(options: ContainerLifecycleOptions): Promise<boolean> {
  const value = await privateJson(options, 'container-entrypoint.json');
  if (value === null) return false;
  if (!exactObject(value, ['schema', 'home', 'pid', 'uid', 'startTicks'])) throw unavailable();
  const identity = await (options.containerRuntime?.identity || readContainerPid1Identity)().catch(() => { throw unavailable(); });
  if (value.schema !== 'dharma.container-entrypoint/v1' || value.home !== options.home
    || value.pid !== 1 || value.uid !== ownUid(options) || value.startTicks !== identity.startTicks
    || !ownedIdentity(identity, ownUid(options), await canonicalEntrypoint(options, identity))) throw unavailable();
  return true;
}

function registrationHash(home: string, registration: ContainerRelayRegistration) {
  return createHash('sha256').update(JSON.stringify([home, registration.schema, registration.backend,
    registration.launcher, registration.workspace, registration.policy, registration.version, registration.taskName])).digest('hex');
}

async function writePrivateJson(options: ContainerLifecycleOptions, name: string, value: unknown) {
  await privateDirectory(options);
  // Refuse a substituted/symlink/world-accessible receipt before replacing it.
  await privateJson(options, name);
  const destination = privatePath(options.home, name);
  const temporary = `${destination}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(value) + '\n', { mode: 0o600, flag: 'wx' });
    await rename(temporary, destination);
  } finally { await rm(temporary, { force: true }); }
}

export async function containerStartupControl(options: ContainerLifecycleOptions,
  registration: ContainerRelayRegistration, running: boolean) {
  if (!await containerEntrypointAvailable(options)) throw unavailable();
  await writePrivateJson(options, 'container-control.json', {
    schema: 'dharma.container-relay-control/v1', home: options.home,
    registrationHash: registrationHash(options.home, registration), running,
  } satisfies Control);
}

export async function containerStartupState(options: ContainerLifecycleOptions, registration: ContainerRelayRegistration) {
  if (!await containerEntrypointAvailable(options)) throw unavailable();
  const value = await privateJson(options, 'container-control.json');
  if (!exactObject(value, ['schema', 'home', 'registrationHash', 'running'])
    || value.schema !== 'dharma.container-relay-control/v1' || value.home !== options.home
    || value.registrationHash !== registrationHash(options.home, registration) || typeof value.running !== 'boolean') throw unavailable();
  // Stop pauses the owned relay; it does not unregister its persistent lifecycle.
  const heartbeat = await privateJson(options, 'container-heartbeat.json');
  const marker = await privateJson(options, 'container-entrypoint.json') as Marker;
  let lifecycle: Heartbeat['lifecycle'] | 'configured' = 'configured';
  if (heartbeat !== null) {
    if (!exactObject(heartbeat, ['schema', 'home', 'startTicks', 'polledAt', 'lifecycle', 'reason', 'registrationHash', 'childPid', 'childStartTicks'])
      || heartbeat.schema !== 'dharma.container-relay-heartbeat/v1' || heartbeat.home !== options.home
      || heartbeat.startTicks !== marker.startTicks || typeof heartbeat.polledAt !== 'number' || !Number.isSafeInteger(heartbeat.polledAt)
      || heartbeat.polledAt > Date.now() + 1000 || Date.now() - heartbeat.polledAt > 10_000
      || !['unconfigured', 'paused', 'blocked', 'starting', 'running'].includes(String(heartbeat.lifecycle))
      || heartbeat.reason !== null && heartbeat.reason !== 'consumer_store_locked_or_unavailable' && heartbeat.reason !== 'relay_runtime_upgrade_required'
      || heartbeat.registrationHash !== null && !/^[a-f0-9]{64}$/.test(String(heartbeat.registrationHash))) throw unavailable();
    if (heartbeat.lifecycle === 'running') {
      if (!value.running || !Number.isSafeInteger(heartbeat.childPid) || Number(heartbeat.childPid) <= 1
        || typeof heartbeat.childStartTicks !== 'string') throw unavailable();
      await ownedChild(options, Number(heartbeat.childPid), heartbeat.childStartTicks);
    } else if (heartbeat.childPid !== null || heartbeat.childStartTicks !== null) throw unavailable();
    if (heartbeat.registrationHash === registrationHash(options.home, registration)) lifecycle = heartbeat.lifecycle as Heartbeat['lifecycle'];
  }
  return { state: 'enabled' as const, backend: 'container-entrypoint' as const, version: registration.version,
    lifecycle, restartCoverage: 'container-entrypoint-only' as const };
}

export async function ownsContainerStartup(options: ContainerLifecycleOptions, registration: ContainerRelayRegistration) {
  // Stop/disable authority comes from the private matching configuration, not a
  // transient child heartbeat. A child may be exiting when control is paused.
  try {
    if (!await containerEntrypointAvailable(options)) return false;
    const value = await privateJson(options, 'container-control.json');
    return exactObject(value, ['schema', 'home', 'registrationHash', 'running'])
      && value.schema === 'dharma.container-relay-control/v1' && value.home === options.home
      && value.registrationHash === registrationHash(options.home, registration) && typeof value.running === 'boolean';
  } catch { return false; }
}

export async function writeContainerRegistration(options: ContainerLifecycleOptions, registration: ContainerRelayRegistration) {
  await writePrivateJson(options, 'autostart.json', registration);
}

function validRegistration(value: unknown): value is ContainerRelayRegistration {
  return exactObject(value, ['schema', 'backend', 'launcher', 'workspace', 'policy', 'version', 'taskName'])
    && value.schema === 'dharma.relay-autostart/v3' && value.backend === 'container-entrypoint'
    && typeof value.launcher === 'string' && value.launcher.length <= 4096 && isAbsolute(value.launcher) && !/[\r\n\0]/.test(value.launcher)
    && typeof value.workspace === 'string' && value.workspace.length <= 4096 && isAbsolute(value.workspace) && !/[\r\n\0]/.test(value.workspace)
    && value.policy === join(value.workspace, '.dharma', 'approved-policy.json')
    && typeof value.version === 'string' && /^(?=.{1,64}$)\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(value.version)
    && value.taskName === null;
}

export async function readContainerRegistration(options: ContainerLifecycleOptions) {
  const value = await privateJson(options, 'autostart.json');
  if (value === null) return null;
  if (!validRegistration(value)) throw unavailable();
  return value;
}

async function readConfiguration(options: ContainerLifecycleOptions) {
  const value = await privateJson(options, 'autostart.json');
  if (value === null) return null;
  if (!validRegistration(value)) throw unavailable();
  const control = await privateJson(options, 'container-control.json');
  if (control === null) return null; // atomic registration precedes its control receipt
  if (!exactObject(control, ['schema', 'home', 'registrationHash', 'running'])
    || control.schema !== 'dharma.container-relay-control/v1' || control.home !== options.home
    || typeof control.running !== 'boolean' || typeof control.registrationHash !== 'string') throw unavailable();
  if (control.registrationHash !== registrationHash(options.home, value)) return null; // fail closed during an owned update
  return { registration: value, running: control.running };
}

async function wait(milliseconds: number, signal: AbortSignal) {
  if (signal.aborted) return;
  await new Promise<void>(resolveWait => {
    const finish = () => { clearTimeout(timer); signal.removeEventListener('abort', finish); resolveWait(); };
    const timer = setTimeout(finish, milliseconds);
    signal.addEventListener('abort', finish, { once: true });
    if (signal.aborted) finish();
  });
}

const execFileAsync = promisify(execFile);
export async function containerConsumerStoreReady(): Promise<boolean> {
  // Metadata only: no Secret Service lookup/get/store and no credential values.
  try {
    const alias = await execFileAsync('dbus-send', ['--session', '--print-reply', '--dest=org.freedesktop.secrets',
      '/org/freedesktop/secrets', 'org.freedesktop.Secret.Service.ReadAlias', 'string:default'],
    { timeout: 5000, maxBuffer: 8192 });
    const paths = [...alias.stdout.matchAll(/object path "([/a-zA-Z0-9_]+)"/g)];
    if (paths.length !== 1 || !paths[0]![1]!.startsWith('/org/freedesktop/secrets/collection/')) return false;
    const locked = await execFileAsync('dbus-send', ['--session', '--print-reply', '--dest=org.freedesktop.secrets',
      paths[0]![1]!, 'org.freedesktop.DBus.Properties.Get', 'string:org.freedesktop.Secret.Collection', 'string:Locked'],
    { timeout: 5000, maxBuffer: 8192 });
    return /variant\s+boolean false\s*$/.test(locked.stdout);
  } catch { return false; }
}

async function stopOwnedChild(child: ChildProcess, options: ContainerLifecycleOptions, identity: ContainerChildIdentity | null) {
  if (child.exitCode !== null || child.signalCode !== null || !child.pid) return;
  // Never signal a recycled PID or a process outside this owned parent/UID.
  if (identity && !await ownedChild(options, child.pid, identity.startTicks).catch(() => null)) return;
  // On an initial /proc failure, the freshly spawned ChildProcess handle is
  // still ours. Drain it immediately; never leave unverified work running.
  // This function accepts no raw PID and only receives this loop's own spawn.
  const exited = new Promise<void>(resolveWait => {
    child.once('exit', () => resolveWait()); child.once('error', () => resolveWait());
  });
  child.kill('SIGTERM');
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([exited, new Promise<void>(resolveWait => { timer = setTimeout(resolveWait, 10_000); })]);
  if (timer) clearTimeout(timer);
  if (child.exitCode === null && child.signalCode === null
    && (!identity || await ownedChild(options, child.pid, identity.startTicks).catch(() => null))) { child.kill('SIGKILL'); await exited; }
}

export async function runOwnedContainerEntrypoint(options: ContainerLifecycleOptions & {
  signal: AbortSignal; spawnRelay?: (registration: ContainerRelayRegistration) => ChildProcess;
  consumerStoreReady?: () => Promise<boolean>; pollMs?: number; restartDelayMs?: number;
}) {
  const identity = await (options.containerRuntime?.identity || readContainerPid1Identity)();
  const bin = await canonicalEntrypoint(options, identity);
  const runtimeVersion: unknown = options.containerRuntime?.runtimeVersion
    ?? (JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as { version?: unknown }).version;
  if (typeof runtimeVersion !== 'string' || !/^(?=.{1,64}$)\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(runtimeVersion)) throw unavailable();
  if (!ownedIdentity(identity, ownUid(options), bin)) throw unavailable();
  await mkdir(join(options.home, 'relay'), { recursive: true, mode: 0o700 });
  await privateDirectory(options);
  const marker: Marker = { schema: 'dharma.container-entrypoint/v1', home: options.home,
    pid: 1, uid: identity.uid, startTicks: identity.startTicks };
  const previous = await privateJson(options, 'container-entrypoint.json');
  if (previous !== null && (!exactObject(previous, ['schema', 'home', 'pid', 'uid', 'startTicks'])
    || previous.schema !== marker.schema || previous.home !== marker.home || previous.uid !== marker.uid || previous.pid !== 1
    || typeof previous.startTicks !== 'string' || !/^\d{1,20}$/.test(previous.startTicks))) throw unavailable();
  const lockPath = privatePath(options.home, 'container-entrypoint.lock');
  const oldLock = await privateJson(options, 'container-entrypoint.lock');
  if (oldLock !== null) {
    if (!exactObject(oldLock, ['schema', 'home', 'pid', 'uid', 'startTicks'])
      || oldLock.schema !== marker.schema || oldLock.home !== marker.home || oldLock.uid !== marker.uid || oldLock.pid !== 1
      || typeof oldLock.startTicks !== 'string' || !/^\d{1,20}$/.test(oldLock.startTicks)) throw unavailable();
    if (oldLock.startTicks === marker.startTicks) throw new Error('container_entrypoint_busy: an owned entrypoint is already active.');
    await rm(lockPath); // an earlier boot's private lock; actual PID1 identity was verified
  }
  try { await writeFile(lockPath, JSON.stringify(marker), { mode: 0o600, flag: 'wx' }); }
  catch { throw new Error('container_entrypoint_busy: an owned entrypoint is already active.'); }
  let child: ChildProcess | null = null;
  let childHash: string | null = null;
  let childIdentity: ContainerChildIdentity | null = null;
  let childFailed = false;
  let restarts = 0;
  let retryAt = 0;
  const pollMs = options.pollMs ?? 1000;
  const restartDelayMs = options.restartDelayMs ?? 5000;
  const spawnRelay = options.spawnRelay || ((registration: ContainerRelayRegistration) => spawn(process.execPath,
    [bin, 'relay', 'supervise', '--policy', registration.policy], { cwd: registration.workspace, stdio: 'ignore',
      env: { ...process.env, DHARMA_HOME: options.home } }));
  try {
    await writePrivateJson(options, 'container-entrypoint.json', marker);
    while (!options.signal.aborted) {
      if (!await containerEntrypointAvailable(options)) throw unavailable();
      const configuration = await readConfiguration(options);
      const hash = configuration ? registrationHash(options.home, configuration.registration) : null;
      const compatibleRuntime = configuration?.registration.version === runtimeVersion;
      const protectedConsumer = configuration?.running && compatibleRuntime
        ? await (options.consumerStoreReady || containerConsumerStoreReady)().catch(() => false) : false;
      if (options.signal.aborted) break; // no new child after interrupted preflight
      const shouldRun = Boolean(configuration?.running && protectedConsumer);
      if (child && (childFailed || child.exitCode !== null || child.signalCode !== null)) {
        child = null; childIdentity = null; childHash = null; childFailed = false; restarts++; retryAt = Date.now() + restartDelayMs;
      }
      if (child && (!shouldRun || hash !== childHash)) {
        await stopOwnedChild(child, options, childIdentity); child = null; childIdentity = null; childHash = null;
      }
      if (shouldRun && !child && Date.now() >= retryAt) {
        child = spawnRelay(configuration!.registration);
        childHash = hash;
        child.on('error', () => { childFailed = true; });
        childIdentity = child.pid ? await ownedChild(options, child.pid).catch(() => null) : null;
        if (child.pid && !childIdentity && child.exitCode === null && child.signalCode === null) throw unavailable();
      }
      const running = Boolean(child?.pid && childIdentity && !childFailed && child.exitCode === null && child.signalCode === null);
      const heartbeat: Heartbeat = { schema: 'dharma.container-relay-heartbeat/v1', home: options.home,
        startTicks: marker.startTicks, polledAt: Date.now(), registrationHash: hash, childPid: running ? child!.pid! : null,
        childStartTicks: running ? childIdentity!.startTicks : null,
        lifecycle: !configuration ? 'unconfigured' : !configuration.running ? 'paused'
          : !protectedConsumer ? 'blocked' : running ? 'running' : 'starting',
        reason: configuration?.running && !compatibleRuntime ? 'relay_runtime_upgrade_required'
          : configuration?.running && !protectedConsumer ? 'consumer_store_locked_or_unavailable' : null };
      await writePrivateJson(options, 'container-heartbeat.json', heartbeat);
      await wait(pollMs, options.signal);
    }
    return { stopped: true, restarts };
  } catch { throw unavailable(); }
  finally {
    if (child) await stopOwnedChild(child, options, childIdentity);
    const current = await privateJson(options, 'container-entrypoint.json').catch(() => null) as Marker | null;
    if (current?.startTicks === marker.startTicks && current.home === marker.home) {
      await rm(privatePath(options.home, 'container-entrypoint.json'), { force: true });
      await rm(privatePath(options.home, 'container-heartbeat.json'), { force: true });
    }
    const lock = await privateJson(options, 'container-entrypoint.lock').catch(() => null) as Marker | null;
    if (lock?.startTicks === marker.startTicks && lock.home === marker.home) await rm(lockPath, { force: true });
  }
}
