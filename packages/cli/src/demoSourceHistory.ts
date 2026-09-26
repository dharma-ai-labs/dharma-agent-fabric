import { constants } from 'node:fs';
import { lstat, mkdir, open, rename, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { canonicalize } from '@dharma-ai-labs/agent-fabric-contracts';
import type { DemoSourceBaselineScope } from './demoSourceBaseline.js';

const HASH = /^sha256:[a-f0-9]{64}$/;
export type DemoSourceHistory = DemoSourceBaselineScope & {
  schema: 'dharma.demo-source-history/v1';
  localSnapshotHash: string;
  pending: { localSnapshotHash: string; snapshotHash: string; sourceFingerprint: string; capturedAt: string } | null;
};

function checked(value: unknown, scope: DemoSourceBaselineScope): DemoSourceHistory {
  const row = value as DemoSourceHistory | null;
  const keys = ['schema', 'organizationId', 'repositoryId', 'workspaceId', 'policyHash', 'localSnapshotHash', 'pending'];
  if (!row || typeof row !== 'object' || Array.isArray(row)
    || Object.keys(row).length !== keys.length || keys.some(key => !Object.hasOwn(row, key))
    || row.schema !== 'dharma.demo-source-history/v1'
    || row.organizationId !== scope.organizationId || row.repositoryId !== scope.repositoryId
    || row.workspaceId !== scope.workspaceId || row.policyHash !== scope.policyHash
    || !HASH.test(row.localSnapshotHash)
    || row.pending !== null && (!row.pending || typeof row.pending !== 'object'
      || Array.isArray(row.pending) || Object.keys(row.pending).sort().join(',') !== 'capturedAt,localSnapshotHash,snapshotHash,sourceFingerprint'
      || ![row.pending.localSnapshotHash, row.pending.snapshotHash, row.pending.sourceFingerprint]
        .every(hash => typeof hash === 'string' && HASH.test(hash))
      || typeof row.pending.capturedAt !== 'string' || !Number.isFinite(Date.parse(row.pending.capturedAt))
      || new Date(row.pending.capturedAt).toISOString() !== row.pending.capturedAt)) {
    throw new Error('Demo source history integrity or scope is invalid.');
  }
  return row;
}

function path(root: string, scope: DemoSourceBaselineScope) {
  if (!/^org_[A-Za-z0-9_]{1,156}$/.test(scope.organizationId)
    || ![scope.repositoryId, scope.workspaceId].every(id => /^[a-f0-9-]{36}$/i.test(id))) {
    throw new Error('Demo source history scope is invalid.');
  }
  return resolve(root, 'demo-source-history', scope.organizationId, scope.repositoryId, `${scope.workspaceId}.json`);
}

export async function readDemoSourceHistory(root: string, scope: DemoSourceBaselineScope,
  priorPolicyHash?: string): Promise<DemoSourceHistory | null> {
  const target = path(root, scope);
  let entry;
  try { entry = await lstat(target); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  if (!entry.isFile() || entry.isSymbolicLink()) throw new Error('Demo source history file is unsafe.');
  const handle = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    const stat = await handle.stat();
    const after = await lstat(target);
    if (!stat.isFile() || stat.size > 4096 || after.isSymbolicLink()
      || !after.isFile() || entry.ino !== 0 && entry.ino !== stat.ino
      || after.ino !== 0 && after.ino !== stat.ino) throw new Error('Demo source history file changed or exceeds its limit.');
    const row = JSON.parse(await handle.readFile({ encoding: 'utf8' }));
    return checked(row, { ...scope, policyHash: priorPolicyHash && row.policyHash === priorPolicyHash
      ? priorPolicyHash : scope.policyHash });
  } finally { await handle.close(); }
}

export async function writeDemoSourceHistory(root: string, row: DemoSourceHistory) {
  checked(row, row);
  const target = path(root, row);
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
  const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL
    | (constants.O_NOFOLLOW || 0), 0o600);
  try { await handle.writeFile(`${canonicalize(row)}\n`); await handle.sync(); }
  finally { await handle.close(); }
  try { await rename(temporary, target); }
  finally { await rm(temporary, { force: true }); }
}
