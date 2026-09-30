import type { LocalVault, LocalProviderSessionBinding } from '@dharma-ai-labs/agent-fabric-local-vault';
import type { CodexLocalWorkCapture } from '@dharma-ai-labs/agent-fabric-provider-adapters/experimental/codex-session';
import { serializeRepositoryPackageSnapshot, type RepositoryPackageSnapshot } from './repositoryPackage.js';

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
  acceptedLearningObservation: false;
}

export type NamedSessionRepositoryStateDisposition = NamedSessionRepositoryState
  | { state: 'not_authorized'; acceptedLearningObservation: false }
  | { state: 'blocked'; code: 'source_state_unavailable'; acceptedLearningObservation: false };

// Local inventory proves captured bytes, not an independent grade or server acceptance.
export async function retainNamedSessionRepositoryState(input: {
  vault: LocalVault;
  binding: LocalProviderSessionBinding;
  workId: string;
  capture: CodexLocalWorkCapture;
  before: RepositoryPackageSnapshot;
  after: RepositoryPackageSnapshot;
  activeBundleId: string;
  activeBundleHash: string;
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
  return { schema: 'dharma.named-session-repository-state/v1', workId: capture.workId,
    captureHash: await input.vault.putBlob(Buffer.from(JSON.stringify(capture)), 'raw-provider-turn'),
    sourceSnapshotHash: before.manifest.snapshotHash, resultSnapshotHash: after.manifest.snapshotHash,
    sourceContentHash: await input.vault.putBlob(Buffer.from(sourceBytes), 'named-session-source-state'),
    resultContentHash: await input.vault.putBlob(Buffer.from(resultBytes), 'named-session-result-state'),
    activeBundleId: input.activeBundleId, activeBundleHash: input.activeBundleHash,
    acceptedLearningObservation: false };
}
