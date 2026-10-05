import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import {currentBootstrapHostScope, type BootstrapHostScope} from './bootstrapHostScope.js';

type Row = Record<string, unknown>;

function step<T>(scope: BootstrapHostScope | undefined, operation: () => Promise<T>): Promise<T> {
  return scope ? scope.step(operation) : operation();
}

async function failure(scope: BootstrapHostScope | undefined, error: unknown, code: string): Promise<never> {
  if (!scope) throw error;
  await scope.assert();
  const safe = error instanceof Error && [
    'registry_recovery_registry_file_unsafe', 'registry_recovery_nonempty_registry_invalid',
    'registry_recovery_backup_directory_unsafe', 'registry_recovery_registry_changed',
    'registry_recovery_existing_rows_invalid', 'registry_recovery_foreign_organization',
    'registry_recovery_existing_rows_ambiguous', 'registry_recovery_existing_row_conflict',
    'registry_recovery_write_unconfirmed', 'registry_recovery_cleanup_unconfirmed',
  ].includes(error.message) ? error.message : code;
  throw new Error(safe);
}

function object(value: unknown): Row | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Row : null;
}

function unique(rows: unknown[], predicate: (row: Row) => boolean, code: string): Row {
  const matching = rows.map(object).filter((row): row is Row => Boolean(row && predicate(row)));
  if (matching.length !== 1) throw new Error(code);
  return matching[0]!;
}

export function resolveRegistryRecoveryProjection(input: {
  organizationId: string;
  deviceId: string;
  workspaceId: string;
  policyRevision: string;
  repositoryFingerprint: string;
  workspaces: unknown;
  repositoryAgents: unknown;
}) {
  const workspaces = object(input.workspaces);
  const agents = object(input.repositoryAgents);
  if (workspaces?.ok !== true || workspaces.organizationId !== input.organizationId
    || !Array.isArray(workspaces.workspaces)
    || agents?.ok !== true || agents.organizationId !== input.organizationId
    || !Array.isArray(agents.repositoryAgents)) {
    throw new Error('registry_recovery_server_scope_mismatch');
  }
  const workspace = unique(workspaces.workspaces, row => row.id === input.workspaceId,
    'registry_recovery_workspace_missing_or_ambiguous');
  if (workspace.device_id !== input.deviceId || workspace.status !== 'active'
    || workspace.policy_revision !== input.policyRevision
    || typeof workspace.repository_binding_id !== 'string') {
    throw new Error('registry_recovery_workspace_authority_mismatch');
  }
  const binding = unique(agents.repositoryAgents,
    row => row.id === workspace.repository_binding_id,
    'registry_recovery_binding_missing_or_ambiguous');
  if (binding.status !== 'active'
    || binding.source_repository_fingerprint !== input.repositoryFingerprint
    || typeof binding.organization_agent_id !== 'string'
    || typeof binding.control_branch !== 'string' || !binding.control_branch) {
    throw new Error('registry_recovery_repository_mismatch');
  }
  const agent = object(binding.agent);
  if (!agent || agent.id !== binding.organization_agent_id
    || typeof agent.agent_key !== 'string' || !agent.agent_key) {
    throw new Error('registry_recovery_agent_mismatch');
  }
  if (!Array.isArray(binding.workspaces)
    || !binding.workspaces.some(value => {
      const row = object(value);
      return row?.id === input.workspaceId && row.device_id === input.deviceId
        && row.repository_binding_id === binding.id && row.status === 'active';
    })) {
    throw new Error('registry_recovery_binding_workspace_mismatch');
  }
  const endpoints = Array.isArray(binding.endpoints) ? binding.endpoints : [];
  const matchingEndpoints = endpoints.map(object).filter((row): row is Row => Boolean(row
    && row.workspace_id === input.workspaceId && row.device_id === input.deviceId
    && row.organization_agent_id === binding.organization_agent_id && row.status === 'active'
    && row.endpoint_kind === 'local_provider' && row.credential_boundary === 'local_device'));
  if (matchingEndpoints.length === 0) throw new Error('registry_recovery_endpoint_missing');
  const providerOrder = ['codex', 'claude', 'agy', 'hermes'];
  if (matchingEndpoints.some(row => typeof row.id !== 'string' || typeof row.provider !== 'string')
    || new Set(matchingEndpoints.map(row => row.provider)).size !== matchingEndpoints.length) {
    throw new Error('registry_recovery_endpoint_ambiguous');
  }
  matchingEndpoints.sort((left, right) => {
    const rank = (provider: unknown) => {
      const index = providerOrder.indexOf(String(provider));
      return index < 0 ? providerOrder.length : index;
    };
    return rank(left.provider) - rank(right.provider) || String(left.id).localeCompare(String(right.id));
  });
  return {
    repositoryBindingId: binding.id as string,
    repositoryAgentId: binding.organization_agent_id as string,
    repositoryAgentKey: agent.agent_key as string,
    controlBranch: binding.control_branch as string,
    endpointId: typeof matchingEndpoints[0]?.id === 'string' ? matchingEndpoints[0].id : null,
    name: typeof workspace.name === 'string' && workspace.name ? workspace.name : null,
    defaultBranch: typeof workspace.default_branch === 'string' ? workspace.default_branch : null,
  };
}

export function appendRecoveredWorkspace<T extends {
  workspaceId: string; organizationId: string; path: string; repositoryRemoteHash: string | null;
}>(records: readonly T[], recovered: T): { records: T[]; alreadyPresent: boolean } {
  if (records.some(row => !row || typeof row.workspaceId !== 'string'
    || typeof row.organizationId !== 'string' || typeof row.path !== 'string')) {
    throw new Error('registry_recovery_existing_rows_invalid');
  }
  if (records.some(row => row.organizationId !== recovered.organizationId)) {
    throw new Error('registry_recovery_foreign_organization');
  }
  const matches = records.filter(row => row.workspaceId === recovered.workspaceId || row.path === recovered.path);
  if (matches.length > 1) throw new Error('registry_recovery_existing_rows_ambiguous');
  if (matches.length === 1) {
    const row = matches[0]!;
    if (row.workspaceId !== recovered.workspaceId || row.path !== recovered.path
      || row.organizationId !== recovered.organizationId
      || row.repositoryRemoteHash !== recovered.repositoryRemoteHash) {
      throw new Error('registry_recovery_existing_row_conflict');
    }
    return { records: [...records], alreadyPresent: true };
  }
  return { records: [...records, recovered], alreadyPresent: false };
}

export async function inspectRegistryRecoveryFile<T>(path: string) {
  const scope = currentBootstrapHostScope();
  let bytes: Buffer | null = null;
  try {
    try {
      const metadata = await step(scope, () => lstat(path));
      if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1) {
        throw new Error('registry_recovery_registry_file_unsafe');
      }
      bytes = await step(scope, () => readFile(path));
    } catch (error) {
      await scope?.assert();
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    let records: T[] = [];
    if (bytes && bytes.length > 0) {
      let parsed: unknown;
      try { parsed = JSON.parse(bytes.toString('utf8')); }
      catch { throw new Error('registry_recovery_nonempty_registry_invalid'); }
      if (!Array.isArray(parsed)) throw new Error('registry_recovery_nonempty_registry_invalid');
      records = parsed as T[];
    }
    await scope?.assert();
    return {
      kind: bytes === null ? 'absent' as const : bytes.length === 0 ? 'corrupt_zero' as const : 'valid' as const,
      bytes, records,
      hash: bytes === null ? null : `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
    };
  } catch (error) {
    return failure(scope, error, 'registry_recovery_read_failed');
  }
}

export async function backupRegistryRecoveryFile(input: {
  home: string;
  path: string;
  expectedBytes: Buffer | null;
}) {
  const scope = currentBootstrapHostScope();
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    const home = input.home, path = input.path;
    const expected = input.expectedBytes === null ? null : Buffer.from(input.expectedBytes);
    await scope?.assert();
    if (expected === null) return null;
    const directory = resolve(home, 'registry', 'recovery-backups');
    await step(scope, () => mkdir(directory, { recursive: true, mode: 0o700 }));
    const metadata = await step(scope, () => lstat(directory));
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new Error('registry_recovery_backup_directory_unsafe');
    }
    const backup = resolve(directory, `workspaces-${Date.now()}-${randomUUID()}.bin`);
    await step(scope, async () => {handle = await open(backup, 'wx', 0o600);});
    await step(scope, () => handle!.writeFile(expected));
    await step(scope, () => handle!.sync());
    const current = await step(scope, () => readFile(path));
    if (!current.equals(expected)) throw new Error('registry_recovery_registry_changed');
    await scope?.assert();
    return backup;
  } catch (error) {
    return await failure(scope, error, 'registry_recovery_backup_failed');
  } finally {
    // A created backup is evidence, including when installation is interrupted.
    if (handle) {
      try {await handle.close();} catch (error) {
        if (scope) throw new Error('registry_recovery_backup_close_unconfirmed');
        throw error;
      }
    }
  }
}

export async function applyRegistryRecoveryFile<T extends {
  workspaceId: string; organizationId: string; path: string; repositoryRemoteHash: string | null;
}>(input: {
  home: string;
  path: string;
  expectedKind: 'absent' | 'corrupt_zero' | 'valid';
  expectedHash: string | null;
  entry: T;
}) {
  const scope = currentBootstrapHostScope();
  try {
    const snapshot = structuredClone(input);
    await scope?.assert();
    const current = await step(scope, () => inspectRegistryRecoveryFile<T>(snapshot.path));
    if (current.kind !== snapshot.expectedKind || current.hash !== snapshot.expectedHash) {
      throw new Error('registry_recovery_registry_changed');
    }
    const final = appendRecoveredWorkspace(current.records, snapshot.entry);
    if (final.alreadyPresent) {
      await scope?.assert();
      return {state: 'already_present' as const, backup: null,
        previousHash: current.hash, restoredCount: final.records.length};
    }
    const serialized = Buffer.from(`${JSON.stringify(final.records, null, 2)}\n`);
    const backup = await step(scope, () => backupRegistryRecoveryFile({home: snapshot.home, path: snapshot.path,
      expectedBytes: current.bytes}));
    const temporary = `${snapshot.path}.${process.pid}.${randomUUID()}.tmp`;
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    let owned: {dev: bigint; ino: bigint} | undefined;
    let renamed = false;
    await step(scope, () => mkdir(dirname(snapshot.path), {recursive: true, mode: 0o700}));
    try {
      await step(scope, async () => {
        handle = await open(temporary, 'wx', 0o600);
        const metadata = await handle.stat({bigint: true});
        owned = {dev: metadata.dev, ino: metadata.ino};
      });
      await step(scope, () => handle!.writeFile(serialized));
      await step(scope, () => handle!.sync());
      await step(scope, async () => {await handle!.close(); handle = undefined;});
      const beforeReplace = await step(scope, () => inspectRegistryRecoveryFile<T>(snapshot.path));
      if (beforeReplace.kind !== current.kind || beforeReplace.hash !== current.hash) {
        throw new Error('registry_recovery_registry_changed');
      }
      const metadata = await step(scope, () => lstat(temporary, {bigint: true}));
      if (!owned || metadata.dev !== owned.dev || metadata.ino !== owned.ino
        || !metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1n) {
        throw new Error('registry_recovery_cleanup_unconfirmed');
      }
      await step(scope, async () => {await rename(temporary, snapshot.path); renamed = true;});
    } finally {
      let cleanupFailed = false;
      if (handle) {
        try {await handle.close();} catch {cleanupFailed = true;}
      }
      // Cooperatively clean only this exclusive-open inode, even after withdrawal.
      if (!renamed && owned) {
        try {
          const metadata = await lstat(temporary, {bigint: true});
          if (metadata.dev !== owned.dev || metadata.ino !== owned.ino
            || !metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1n) cleanupFailed = true;
          else await unlink(temporary);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') cleanupFailed = true;
        }
      } else if (!renamed && handle && !owned) cleanupFailed = true;
      if (cleanupFailed) throw new Error('registry_recovery_cleanup_unconfirmed');
    }
    const confirmed = await step(scope, () => inspectRegistryRecoveryFile<T>(snapshot.path));
    if (confirmed.kind !== 'valid' || !confirmed.bytes?.equals(serialized)) {
      throw new Error('registry_recovery_write_unconfirmed');
    }
    await scope?.assert();
    return {state: 'recovered' as const, backup, previousHash: current.hash,
      restoredCount: confirmed.records.length};
  } catch (error) {
    // Preserve an ownership/close failure even if the owning scope also closed.
    if (error instanceof Error && ['registry_recovery_cleanup_unconfirmed',
      'registry_recovery_backup_close_unconfirmed'].includes(error.message)) throw error;
    return failure(scope, error, 'registry_recovery_write_failed');
  }
}
