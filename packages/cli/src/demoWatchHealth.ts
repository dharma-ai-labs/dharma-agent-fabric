import { constants } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { DemoWatchObservation } from './demoSupervisor.js';

export type DemoWatchHealth = Omit<DemoWatchObservation, 'key'> & {
  schema: 'dharma.demo-watch-health/v1'; key: string;
  pid: number; version: string; observedAt: string;
};

function assertKey(key: string) {
  if (!/^[a-f0-9]{64}$/.test(key)) throw new Error('Demo watch health key is invalid.');
}

function validate(value: unknown, key: string): DemoWatchHealth {
  const row = value as DemoWatchHealth | null;
  const keys = ['schema', 'key', 'pid', 'version', 'observedAt', 'state', 'stage', 'sourceState', 'code'];
  const bounded = (value: unknown) => typeof value === 'string' && /^[a-z0-9_]{1,80}$/.test(value);
  if (!row || typeof row !== 'object' || Array.isArray(row)
    || Object.keys(row).length !== keys.length || keys.some(field => !Object.hasOwn(row, field))
    || row.schema !== 'dharma.demo-watch-health/v1' || row.key !== key
    || !Number.isSafeInteger(row.pid) || row.pid < 1
    || typeof row.version !== 'string' || !/^(?=.{1,64}$)\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(row.version)
    || typeof row.observedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(row.observedAt)
    || !Number.isFinite(Date.parse(row.observedAt)) || new Date(row.observedAt).toISOString() !== row.observedAt
    || !['completed', 'failed', 'timed_out'].includes(row.state)
    || (row.stage !== null && !bounded(row.stage))
    || (row.sourceState !== null && !bounded(row.sourceState))
    || (row.state === 'completed' ? !bounded(row.stage) || row.code !== null
      : row.stage !== null || row.sourceState !== null || !bounded(row.code))) {
    throw new Error('Demo watch health receipt is invalid.');
  }
  assertKey(row.key);
  return row;
}

async function directory(home: string, create: boolean): Promise<string | null> {
  let path = resolve(home);
  for (const segment of ['', 'relay', 'demo-watch-health']) {
    if (segment) path = join(path, segment);
    if (create && segment) await mkdir(path, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'EEXIST') throw error;
    });
    const entry = await lstat(path).catch((error: NodeJS.ErrnoException) => {
      if (!create && error.code === 'ENOENT') return null;
      throw error;
    });
    if (!entry) return null;
    if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error('Demo watch health directory or symlink is invalid.');
  }
  return path;
}

async function fileEntry(path: string) {
  const entry = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (entry && (!entry.isFile() || entry.isSymbolicLink() || entry.size > 8192)) {
    throw new Error('Demo watch health file or symlink is invalid.');
  }
  return entry;
}

export async function writeDemoWatchHealth(home: string, value: DemoWatchHealth) {
  const row = validate(value, value?.key);
  const root = (await directory(home, true))!;
  const target = join(root, `${row.key}.json`);
  await fileEntry(target);
  const supervisor = Number((await readFile(join(home, 'relay', 'supervisor.pid'), 'utf8')).trim());
  if (supervisor !== row.pid) throw new Error('Demo watch health supervisor changed before publication.');
  const temporary = join(root, `.${row.key}.${randomUUID()}.tmp`);
  try {
    const handle = await open(temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW || 0), 0o600);
    try { await handle.writeFile(`${JSON.stringify(row)}\n`); await handle.sync(); }
    finally { await handle.close(); }
    // The caller retains the singleton lease until its serialized receipt writes finish.
    if (Number((await readFile(join(home, 'relay', 'supervisor.pid'), 'utf8')).trim()) !== row.pid) {
      throw new Error('Demo watch health supervisor changed before publication.');
    }
    await rename(temporary, target);
  } finally {
    await unlink(temporary).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; });
  }
}

export async function readDemoWatchHealth(home: string, key: string,
  expected: { pid: number; version: string; now?: number }): Promise<DemoWatchHealth | null> {
  assertKey(key);
  const root = await directory(home, false);
  if (!root) return null;
  const path = join(root, `${key}.json`);
  const entry = await fileEntry(path);
  if (!entry) return null;
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  let row;
  try {
    const actual = await handle.stat();
    if (!actual.isFile() || actual.size > 8192 || (entry.ino !== 0 && actual.ino !== entry.ino)) {
      throw new Error('Demo watch health file changed during validation.');
    }
    let parsed: unknown;
    try { parsed = JSON.parse(await handle.readFile({ encoding: 'utf8' })); }
    catch { throw new Error('Demo watch health receipt is invalid.'); }
    row = validate(parsed, key);
  } finally { await handle.close(); }
  const age = (expected.now ?? Date.now()) - Date.parse(row.observedAt);
  if (row.pid !== expected.pid || row.version !== expected.version || age < -5_000 || age > 180_000) return null;
  return row;
}

export function createDemoWatchHealthRecorder(input: {
  home: string; pid: number; version: string; now?: () => number;
  write?: typeof writeDemoWatchHealth;
}) {
  const pending = new Map<string, DemoWatchHealth>();
  const write = input.write ?? writeDemoWatchHealth;
  let worker: Promise<void> | null = null;
  const failedScopes = new Set<string>();
  let invalid = false;
  const flush = async () => {
    while (pending.size) {
      const [key, row] = pending.entries().next().value!;
      pending.delete(key);
      try { await write(input.home, row); failedScopes.delete(key); }
      catch {
        if (failedScopes.has(key) || failedScopes.size < 32) failedScopes.add(key);
        else invalid = true;
      }
    }
  };
  const schedule = () => {
    worker ??= Promise.resolve().then(flush).finally(() => {
      worker = null;
      if (pending.size) schedule();
    });
  };
  return {
    available: (key?: string) => !invalid && (key ? !failedScopes.has(key) : failedScopes.size === 0),
    record(observation: DemoWatchObservation) {
      if (observation.key === null) return;
      try {
        const row = validate({ schema: 'dharma.demo-watch-health/v1', key: observation.key,
          pid: input.pid, version: input.version, observedAt: new Date((input.now ?? Date.now)()).toISOString(),
          state: observation.state, stage: observation.stage, sourceState: observation.sourceState,
          code: observation.code }, observation.key);
        if (!pending.has(row.key) && pending.size >= 32) throw new Error('Health queue is full.');
        pending.set(row.key, row);
        schedule();
      } catch { invalid = true; }
    },
    async drain() { while (worker) await worker; },
  };
}
