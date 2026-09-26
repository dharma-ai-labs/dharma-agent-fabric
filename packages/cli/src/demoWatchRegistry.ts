import { constants } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { link, lstat, mkdir, open, readdir, realpath, unlink } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { normalizeHqUrl } from '@dharma-ai-labs/agent-fabric-relay-client';

const MAXIMUM_REGISTRATIONS = 32;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const FILE = /^[a-f0-9]{64}\.json$/;

export type DemoWatchRegistration = {
  schema: 'dharma.demo-watch/v1';
  hqUrl: string;
  organizationId: string;
  repositoryId: string;
  normalizedRepository: string;
  provider: 'codex' | 'claude' | 'agy' | 'hermes';
  workspace: string;
};

function validate(value: unknown): DemoWatchRegistration {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Demo watch registration is invalid.');
  }
  const row = value as Record<string, unknown>;
  const keys = ['schema', 'hqUrl', 'organizationId', 'repositoryId',
    'normalizedRepository', 'provider', 'workspace'];
  if (Object.keys(row).length !== keys.length || keys.some(key => !Object.hasOwn(row, key))
    || row.schema !== 'dharma.demo-watch/v1'
    || typeof row.hqUrl !== 'string' || normalizeHqUrl(row.hqUrl) !== row.hqUrl
    || typeof row.organizationId !== 'string' || !/^org_[A-Za-z0-9]+$/.test(row.organizationId)
    || typeof row.repositoryId !== 'string' || !UUID.test(row.repositoryId)
    || typeof row.normalizedRepository !== 'string' || row.normalizedRepository.length > 500
    || !/^[A-Za-z0-9.-]+\/[A-Za-z0-9._/-]+$/.test(row.normalizedRepository)
    || row.normalizedRepository.split('/').some(part => !part || part === '.' || part === '..')
    || typeof row.provider !== 'string' || !['codex', 'claude', 'agy', 'hermes'].includes(row.provider)
    || typeof row.workspace !== 'string' || !isAbsolute(row.workspace)
    || resolve(row.workspace) !== row.workspace || row.workspace.length > 4096
    || /[\r\n\0]/.test(row.workspace)) {
    throw new Error('Demo watch registration is invalid or contains untrusted fields.');
  }
  return row as DemoWatchRegistration;
}

export function demoWatchRegistrationKey(registration: DemoWatchRegistration) {
  const row = validate(registration);
  return createHash('sha256').update(`${row.hqUrl}\0${row.organizationId}\0${row.repositoryId}`)
    .digest('hex');
}

async function directory(home: string, create: boolean): Promise<string | null> {
  let current = resolve(home);
  for (const segment of ['', 'relay', 'demo-watches']) {
    if (segment) current = join(current, segment);
    if (create && segment) await mkdir(current, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'EEXIST') throw error;
    });
    const stat = await lstat(current).catch((error: NodeJS.ErrnoException) => {
      if (!create && error.code === 'ENOENT') return null;
      throw error;
    });
    if (!stat) return null;
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error('Demo watch registry directory or symlink is invalid.');
    }
  }
  return current;
}

async function readRegistration(path: string): Promise<DemoWatchRegistration> {
  const entry = await lstat(path);
  if (!entry.isFile() || entry.isSymbolicLink() || entry.size > 8192) {
    throw new Error('Demo watch registry file or symlink is invalid.');
  }
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    const actual = await handle.stat();
    if (!actual.isFile() || actual.size > 8192 || (entry.ino !== 0 && actual.ino !== entry.ino)) {
      throw new Error('Demo watch registry file changed during validation.');
    }
    return validate(JSON.parse(await handle.readFile({ encoding: 'utf8' })));
  } finally { await handle.close(); }
}

export async function listDemoWatchRegistrations(home: string): Promise<DemoWatchRegistration[]> {
  const root = await directory(home, false);
  if (!root) return [];
  const names = (await readdir(root)).filter(name => FILE.test(name)).sort();
  if (names.length > MAXIMUM_REGISTRATIONS) throw new Error('Demo watch registration limit exceeded.');
  const result: DemoWatchRegistration[] = [];
  for (const name of names) {
    const row = await readRegistration(join(root, name));
    if (name !== `${demoWatchRegistrationKey(row)}.json`) {
      throw new Error('Demo watch registry identity does not match its filename.');
    }
    result.push(row);
  }
  return result;
}

function assertSame(existing: DemoWatchRegistration, requested: DemoWatchRegistration) {
  if (existing.workspace !== requested.workspace) {
    throw new Error('demo_watch_workspace_conflict: this repository is watched from another checkout.');
  }
  if (existing.provider !== requested.provider) {
    throw new Error('demo_watch_provider_conflict: this repository has another provider registration.');
  }
  if (JSON.stringify(existing) !== JSON.stringify(requested)) {
    const keys = Object.keys(requested) as (keyof DemoWatchRegistration)[];
    if (keys.some(key => existing[key] !== requested[key])) {
      throw new Error('Demo watch registration conflicts with its existing scope.');
    }
  }
}

export async function registerDemoWatch(home: string, input: DemoWatchRegistration) {
  const row = validate(input);
  if (await realpath(row.workspace) !== row.workspace) {
    throw new Error('Demo watch workspace must be its canonical path.');
  }
  const root = (await directory(home, true))!;
  const key = demoWatchRegistrationKey(row);
  const target = join(root, `${key}.json`);
  const temporary = join(root, `.${key}.${randomUUID()}.tmp`);
  const handle = await open(temporary,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW || 0), 0o600);
  try { await handle.writeFile(`${JSON.stringify(row)}\n`); await handle.sync(); }
  finally { await handle.close(); }
  let created = false;
  try {
    // A no-replace link makes simultaneous enrollment idempotent without overwriting another checkout.
    try { await link(temporary, target); created = true; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      assertSame(await readRegistration(target), row);
    }
    try { await listDemoWatchRegistrations(home); }
    catch (error) { if (created) await unlink(target); throw error; }
    return { created, key };
  } finally { await unlink(temporary); }
}

export async function unregisterDemoWatch(home: string, input: DemoWatchRegistration) {
  const row = validate(input);
  const root = await directory(home, false);
  if (!root) return false;
  const target = join(root, `${demoWatchRegistrationKey(row)}.json`);
  let existing;
  try { existing = await readRegistration(target); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
  assertSame(existing, row);
  await unlink(target);
  return true;
}
