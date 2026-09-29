import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

type Row = Record<string, unknown>;

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
    && row.organization_agent_id === binding.organization_agent_id && row.status === 'active'));
  if (matchingEndpoints.length > 1) throw new Error('registry_recovery_endpoint_ambiguous');
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
  let bytes: Buffer | null = null;
  try {
    const metadata = await lstat(path);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1) {
      throw new Error('registry_recovery_registry_file_unsafe');
    }
    bytes = await readFile(path);
  } catch (error) {
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
  return {
    kind: bytes === null ? 'absent' as const : bytes.length === 0 ? 'corrupt_zero' as const : 'valid' as const,
    bytes, records,
    hash: bytes === null ? null : `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
  };
}

export async function backupRegistryRecoveryFile(input: {
  home: string;
  path: string;
  expectedBytes: Buffer | null;
}) {
  if (input.expectedBytes === null) return null;
  const directory = resolve(input.home, 'registry', 'recovery-backups');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if (!(await lstat(directory)).isDirectory()) throw new Error('registry_recovery_backup_directory_unsafe');
  const backup = resolve(directory, `workspaces-${Date.now()}-${randomUUID()}.bin`);
  await writeFile(backup, input.expectedBytes, { flag: 'wx', mode: 0o600 });
  const current = await readFile(input.path);
  if (!current.equals(input.expectedBytes)) throw new Error('registry_recovery_registry_changed');
  return backup;
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
  const current = await inspectRegistryRecoveryFile<T>(input.path);
  if (current.kind !== input.expectedKind || current.hash !== input.expectedHash) {
    throw new Error('registry_recovery_registry_changed');
  }
  const final = appendRecoveredWorkspace(current.records, input.entry);
  if (final.alreadyPresent) return { state: 'already_present' as const, backup: null,
    previousHash: current.hash, restoredCount: final.records.length };
  const backup = await backupRegistryRecoveryFile({ home: input.home, path: input.path,
    expectedBytes: current.bytes });
  const temporary = `${input.path}.${process.pid}.${randomUUID()}.tmp`;
  await mkdir(dirname(input.path), { recursive: true, mode: 0o700 });
  try {
    await writeFile(temporary, `${JSON.stringify(final.records, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    const beforeReplace = await inspectRegistryRecoveryFile<T>(input.path);
    if (beforeReplace.kind !== current.kind || beforeReplace.hash !== current.hash) {
      throw new Error('registry_recovery_registry_changed');
    }
    await rename(temporary, input.path);
  } finally {
    await unlink(temporary).catch(error => {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    });
  }
  const confirmed = await inspectRegistryRecoveryFile<T>(input.path);
  if (confirmed.kind !== 'valid' || confirmed.records.length !== final.records.length
    || !confirmed.records.some(row => row.workspaceId === input.entry.workspaceId && row.path === input.entry.path)) {
    throw new Error('registry_recovery_write_unconfirmed');
  }
  return { state: 'recovered' as const, backup, previousHash: current.hash,
    restoredCount: confirmed.records.length };
}
