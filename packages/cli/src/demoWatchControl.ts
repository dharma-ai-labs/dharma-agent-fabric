import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { readDemoWatchHealth, type DemoWatchHealth } from './demoWatchHealth.js';
import { demoWatchRegistrationKey, listDemoWatchRegistrations, registerDemoWatch,
  unregisterDemoWatch, type DemoWatchRegistration } from './demoWatchRegistry.js';

export type DemoWatchSupervisor = { state: 'running' | 'stopped' | 'unknown' | 'legacy' | 'version_mismatch'; pid: number | null };
type Input = { home: string; registration: DemoWatchRegistration; version: string; dryRun?: boolean };
export type DemoWatchControlDependencies = {
  verify: () => Promise<void>;
  prepareStartup: () => Promise<void>;
  start: () => Promise<void>;
  supervisor: () => Promise<DemoWatchSupervisor>;
  autostart: () => Promise<'enabled' | 'disabled' | 'unavailable' | 'unsupported'>;
  exclusive: <T>(operation: () => Promise<T>) => Promise<T>;
  wait?: () => Promise<void>;
};

function fail(code: string, stage: string, cause?: unknown): never {
  throw Object.assign(new Error(`${code}: ${stage}; preserve enrollment and resume with the same scope.`, { cause }),
    { code, stage });
}

async function verify(deps: DemoWatchControlDependencies) {
  try { await deps.verify(); }
  catch (error) {
    const code = (error as { code?: unknown } | null)?.code;
    fail(typeof code === 'string' && /^[a-z0-9_]{1,80}$/.test(code) ? code : 'demo_watch_scope_unverified',
      'signed_device_verification', error);
  }
}

function key(input: Input) {
  if (!/^(?=.{1,64}$)\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(input.version)) {
    fail('demo_watch_version_invalid', 'local_registration_validation');
  }
  return demoWatchRegistrationKey(input.registration);
}

async function registered(input: Input) {
  const selected = (await listDemoWatchRegistrations(input.home))
    .find(row => demoWatchRegistrationKey(row) === key(input));
  if (selected && (Object.keys(selected) as (keyof DemoWatchRegistration)[])
    .some(field => selected[field] !== input.registration[field])) {
    fail('demo_watch_registration_conflict', 'local_registration_validation');
  }
  return Boolean(selected);
}

export async function inspectDemoWatchSupervisor(home: string, version: string,
  processState: () => Promise<'running' | 'stopped' | 'unknown'>): Promise<DemoWatchSupervisor> {
  try {
    const state = await processState();
    if (state !== 'running') return { state, pid: null };
    const pid = Number((await readFile(join(home, 'relay', 'supervisor.pid'), 'utf8')).trim());
    const binding = JSON.parse(await readFile(join(home, 'relay', 'supervisor-workspace.json'), 'utf8'));
    if (!Number.isSafeInteger(pid) || pid < 1 || binding?.pid !== pid) return { state: 'unknown', pid: null };
    if (binding.version !== version) return { state: 'version_mismatch', pid };
    if (binding.demoWatches !== true) return { state: 'legacy', pid };
    return { state: 'running', pid };
  } catch { return { state: 'unknown', pid: null }; }
}

async function snapshot(input: Input, deps: DemoWatchControlDependencies, stage?: string) {
  const registrationKey = key(input);
  const isRegistered = await registered(input);
  const supervisor = await deps.supervisor();
  let observation: DemoWatchHealth | null = null;
  let invalidHealth = false;
  if (isRegistered && supervisor.state === 'running' && supervisor.pid !== null) {
    try { observation = await readDemoWatchHealth(input.home, registrationKey,
      { pid: supervisor.pid, version: input.version }); }
    catch { invalidHealth = true; }
  }
  return { schema: 'dharma.demo-watch-control/v1' as const, ok: true, version: input.version,
    stage: stage ?? (!isRegistered ? 'demo_watch_unregistered'
      : supervisor.state !== 'running' ? `demo_watch_${supervisor.state}`
        : invalidHealth ? 'demo_watch_health_invalid'
          : !observation ? 'demo_watch_pending'
            : observation.state === 'completed' ? 'demo_watch_cycle_observed' : 'demo_watch_failed'),
    key: registrationKey, registered: isRegistered, supervisor: supervisor.state,
    autostart: await deps.autostart(), observation, fullWorkflowReady: false as const };
}

export async function demoWatchStatus(input: Input, deps: DemoWatchControlDependencies) {
  key(input);
  await verify(deps);
  return snapshot(input, deps);
}

export async function enableDemoWatch(input: Input, deps: DemoWatchControlDependencies) {
  key(input);
  if (input.dryRun) return snapshot(input, deps, 'demo_watch_plan');
  await verify(deps);
  return deps.exclusive(async () => {
    await registered(input);
    const previous = await deps.supervisor();
    if (previous.state !== 'stopped' && previous.state !== 'running') {
      fail('demo_watch_supervisor_conflict', previous.state);
    }
    await registerDemoWatch(input.home, input.registration);
    try { await deps.prepareStartup(); }
    catch (error) { fail('demo_watch_startup_failed', 'startup_registration', error); }
    if (previous.state === 'stopped') {
      try { await deps.start(); }
      catch (error) { fail('demo_watch_start_failed', 'startup_dispatch', error); }
      for (let attempt = 0; attempt < 40; attempt += 1) {
        const current = await deps.supervisor();
        if (current.state === 'running') break;
        if (current.state !== 'stopped') fail('demo_watch_supervisor_conflict', current.state);
        if (attempt < 39) await (deps.wait ?? (() => new Promise<void>(resolve => setTimeout(resolve, 250))))();
      }
    }
    return snapshot(input, deps);
  });
}

export async function disableDemoWatch(input: Input, deps: DemoWatchControlDependencies) {
  key(input);
  if (input.dryRun) return snapshot(input, deps, 'demo_watch_plan');
  // Local removal must remain possible with a revoked or offline server identity.
  return deps.exclusive(async () => {
    await registered(input);
    await unregisterDemoWatch(input.home, input.registration);
    return snapshot(input, deps, 'demo_watch_disabled');
  });
}
