import { constants } from 'node:fs';
import { lstat, mkdir, open, rename, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { canonicalize } from '@dharma-ai-labs/agent-fabric-contracts';

const HASH = /^sha256:[a-f0-9]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ORG = /^org_[A-Za-z0-9_]{1,156}$/;

export type DemoSourceBaseline = {
  schema: 'dharma.demo-source-baseline/v1';
  organizationId: string;
  repositoryId: string;
  workspaceId: string;
  policyHash: string;
  localFingerprint: string;
  publishedFingerprint: string | null;
  pendingFingerprint: string | null;
  firstObservedAt: number | null;
};

export type DemoSourceBaselineScope = Pick<DemoSourceBaseline,
  'organizationId' | 'repositoryId' | 'workspaceId' | 'policyHash'>;

function path(root: string, scope: DemoSourceBaselineScope) {
  if (!ORG.test(scope.organizationId) || !UUID.test(scope.repositoryId)
    || !UUID.test(scope.workspaceId) || !HASH.test(scope.policyHash)) {
    throw new Error('Demo source baseline scope is invalid.');
  }
  return resolve(root, 'demo-source-baselines', scope.organizationId,
    scope.repositoryId, `${scope.workspaceId}.json`);
}

function parse(value: unknown, scope: DemoSourceBaselineScope): DemoSourceBaseline {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Demo source baseline is invalid.');
  }
  const row = value as Record<string, unknown>;
  const keys = ['schema', 'organizationId', 'repositoryId', 'workspaceId', 'policyHash',
    'localFingerprint', 'publishedFingerprint', 'pendingFingerprint', 'firstObservedAt'];
  if (Object.keys(row).length !== keys.length || keys.some(key => !Object.hasOwn(row, key))
    || row.schema !== 'dharma.demo-source-baseline/v1'
    || row.organizationId !== scope.organizationId || row.repositoryId !== scope.repositoryId
    || row.workspaceId !== scope.workspaceId || row.policyHash !== scope.policyHash
    || typeof row.localFingerprint !== 'string' || !HASH.test(row.localFingerprint)
    || row.publishedFingerprint !== null
      && (typeof row.publishedFingerprint !== 'string' || !HASH.test(row.publishedFingerprint))
    || row.pendingFingerprint !== null
      && (typeof row.pendingFingerprint !== 'string' || !HASH.test(row.pendingFingerprint))
    || (row.pendingFingerprint === null) !== (row.firstObservedAt === null)
    || row.firstObservedAt !== null
      && (!Number.isSafeInteger(row.firstObservedAt) || (row.firstObservedAt as number) < 0)) {
    throw new Error('Demo source baseline is invalid.');
  }
  return row as DemoSourceBaseline;
}

export async function readDemoSourceBaseline(root: string, scope: DemoSourceBaselineScope,
  options: { priorPolicyHash?: string } = {}) {
  const target = path(root, scope);
  let entry;
  try { entry = await lstat(target); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  if (!entry.isFile() || entry.isSymbolicLink()) {
    throw new Error('Demo source baseline symlink or file type is invalid.');
  }
  let handle;
  try { handle = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW || 0)); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  try {
    const stat = await handle.stat();
    const after = await lstat(target);
    if (!stat.isFile() || stat.size > 4096 || !after.isFile() || after.isSymbolicLink()
      || (entry.ino !== 0 && stat.ino !== entry.ino)
      || (after.ino !== 0 && stat.ino !== after.ino)) {
      throw new Error('Demo source baseline file is invalid.');
    }
    const stored: unknown = JSON.parse(await handle.readFile({ encoding: 'utf8' }));
    const policyHash = stored && typeof stored === 'object' && !Array.isArray(stored)
      ? (stored as Record<string, unknown>).policyHash : null;
    const accepted = policyHash === scope.policyHash ? scope.policyHash
      : typeof options.priorPolicyHash === 'string' && policyHash === options.priorPolicyHash
        ? options.priorPolicyHash : scope.policyHash;
    return parse(stored, { ...scope, policyHash: accepted });
  } finally { await handle.close(); }
}

export async function writeDemoSourceBaseline(root: string, value: DemoSourceBaseline) {
  parse(value, value);
  const target = path(root, value);
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
  const handle = await open(temporary,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW || 0), 0o600);
  try { await handle.writeFile(`${canonicalize(value)}\n`); await handle.sync(); }
  finally { await handle.close(); }
  try { await rename(temporary, target); }
  finally { await rm(temporary, { force: true }); }
}

export function observeDemoSource(input: {
  baseline: DemoSourceBaseline | null;
  scope: DemoSourceBaselineScope;
  localFingerprint: string;
  publishedFingerprint: string;
  now: number;
  debounceMs?: number;
}): { state: 'seeded' | 'unchanged' | 'debouncing' | 'stable' | 'remote_changed' | 'remote_reconciled';
  baseline: DemoSourceBaseline } {
  const { scope, localFingerprint, publishedFingerprint, now } = input;
  const debounceMs = input.debounceMs ?? 15_000;
  if (!HASH.test(localFingerprint) || !HASH.test(publishedFingerprint)
    || !Number.isSafeInteger(now) || now < 0
    || !Number.isSafeInteger(debounceMs) || debounceMs < 1000 || debounceMs > 60000) {
    throw new Error('Demo source observation is invalid.');
  }
  const current = input.baseline;
  if (!current) return { state: 'seeded', baseline: {
    schema: 'dharma.demo-source-baseline/v1', ...scope, localFingerprint,
    publishedFingerprint, pendingFingerprint: null, firstObservedAt: null,
  } };
  parse(current, scope);
  if (current.publishedFingerprint === null && current.localFingerprint === publishedFingerprint) {
    return observeDemoSource({ ...input, baseline: { ...current, publishedFingerprint } });
  }
  if (current.publishedFingerprint !== publishedFingerprint) {
    if (localFingerprint === publishedFingerprint) {
      return { state: 'remote_reconciled', baseline: { ...current, localFingerprint,
        publishedFingerprint, pendingFingerprint: null, firstObservedAt: null } };
    }
    return { state: 'remote_changed', baseline: current };
  }
  if (localFingerprint === current.localFingerprint) {
    return { state: 'unchanged', baseline: { ...current,
      pendingFingerprint: null, firstObservedAt: null } };
  }
  if (current.pendingFingerprint !== localFingerprint
    || current.firstObservedAt === null || now < current.firstObservedAt) {
    return { state: 'debouncing', baseline: { ...current,
      pendingFingerprint: localFingerprint, firstObservedAt: now } };
  }
  return { state: now - current.firstObservedAt >= debounceMs ? 'stable' : 'debouncing',
    baseline: current };
}
