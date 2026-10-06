import type { LocalVault, ScopedLocalVault, LocalProviderSessionBinding } from '@dharma-ai-labs/agent-fabric-local-vault';
import type { CodexLocalWorkCapture } from '@dharma-ai-labs/agent-fabric-provider-adapters/experimental/codex-session';
import { serializeRepositoryPackageSnapshot, type RepositoryPackageSnapshot } from './repositoryPackage.js';
import type { OrganizationPolicy } from '@dharma-ai-labs/agent-fabric-policy';
import type { NamedSessionTaskExportResult } from './namedSessionTaskExport.js';
import { stageNamedSessionTaskExport } from './namedSessionTaskExportSync.js';

export interface NamedSessionRepositoryState {
  schema: 'dharma.named-session-repository-state/v1';
  workId: string;
  captureHash: string;
  sourceSnapshotHash: string;
  resultSnapshotHash: string;
  sourceContentHash: string;
  resultContentHash: string;
  activeBundleId: string;
  activeBundleHash: string;
  packageContent?: { manifestHash: string; catalogHash: string; skillsHash: string };
  providerContext?: { retainedContextHash: string; contextContentHash: string; runtimeVersion: string;
    requestedModel: string; executedModel: null; replayMode: 'task_level' };
  portableExport?: Omit<Extract<NamedSessionTaskExportResult, { state: 'ready' }>, 'bytes'>
    | Exclude<NamedSessionTaskExportResult, { state: 'ready' }>;
  exportOutbox?: { state: 'pending'; workKey: string; descriptorHash: string; acceptedLearningObservation: false };
  acceptedLearningObservation: false;
}

export type NamedSessionRepositoryStateDisposition = NamedSessionRepositoryState
  | { state: 'not_authorized'; acceptedLearningObservation: false }
  | { state: 'blocked'; code: 'source_state_unavailable' | 'public_context_unavailable' | 'runtime_version_unavailable'; acceptedLearningObservation: false };

// Local inventory proves captured bytes, not an independent grade or server acceptance.
export async function retainNamedSessionRepositoryState(input: {
  vault: LocalVault | ScopedLocalVault;
  binding: LocalProviderSessionBinding;
  workId: string;
  capture: CodexLocalWorkCapture;
  before: RepositoryPackageSnapshot;
  after: RepositoryPackageSnapshot;
  activeBundleId: string;
  activeBundleHash: string;
  taskExport?: { policy: OrganizationPolicy; contextBytes: Uint8Array; contextHash: string };
}): Promise<NamedSessionRepositoryState> {
  const { binding, capture, before, after } = input;
  for (const key of ['organizationId', 'repositoryBindingId', 'workspaceId', 'deviceId',
    'endpointId', 'membershipId', 'bindingId', 'provider'] as const) {
    if (capture[key] !== binding[key]) throw new Error('named_session_repository_state_scope_mismatch');
  }
  if (capture.workId !== input.workId || capture.providerThreadId !== binding.sessionId
    || !/^sha256:[a-f0-9]{64}$/.test(input.activeBundleHash) || !input.activeBundleId) {
    throw new Error('named_session_repository_state_scope_mismatch');
  }
  const source = before.manifest.sourceAuthorization, result = after.manifest.sourceAuthorization;
  if (!source || !result || source.receiptId !== result.receiptId
    || source.revision !== result.revision || source.policyHash !== result.policyHash) {
    throw new Error('named_session_repository_state_policy_changed');
  }
  for (const snapshot of [before, after]) {
    if (snapshot.manifest.organizationId !== binding.organizationId
      || snapshot.manifest.workspaceId !== binding.workspaceId
      || snapshot.manifest.sourceAuthorization?.repositoryBindingId !== binding.repositoryBindingId) {
      throw new Error('named_session_repository_state_scope_mismatch');
    }
  }
  const sourceBytes = serializeRepositoryPackageSnapshot(before);
  const resultBytes = serializeRepositoryPackageSnapshot(after);
  let portableExport: NamedSessionRepositoryState['portableExport'];
  let exportOutbox: NamedSessionRepositoryState['exportOutbox'];
  if (input.taskExport) {
    const staged = await stageNamedSessionTaskExport(input.vault, { capture, binding, ...input.taskExport });
    const exported = staged.exported;
    if (exported.state === 'ready') {
      const storedHash = await input.vault.putBlob(Buffer.from(exported.bytes), 'named-session-portable-task-export');
      if (storedHash !== exported.exportHash) throw new Error('named_session_portable_export_integrity_failed');
      portableExport = { state: 'ready', exportHash: storedHash, acceptedLearningObservation: false };
      exportOutbox = staged.outbox;
    } else portableExport = exported;
  }
  return { schema: 'dharma.named-session-repository-state/v1', workId: capture.workId,
    captureHash: await input.vault.putBlob(Buffer.from(JSON.stringify(capture)), 'raw-provider-turn'),
    sourceSnapshotHash: before.manifest.snapshotHash, resultSnapshotHash: after.manifest.snapshotHash,
    sourceContentHash: await input.vault.putBlob(Buffer.from(sourceBytes), 'named-session-source-state'),
    resultContentHash: await input.vault.putBlob(Buffer.from(resultBytes), 'named-session-result-state'),
    activeBundleId: input.activeBundleId, activeBundleHash: input.activeBundleHash,
    ...(portableExport ? { portableExport } : {}),
    ...(exportOutbox ? { exportOutbox } : {}),
    acceptedLearningObservation: false };
}
