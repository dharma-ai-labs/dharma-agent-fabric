import { createHash } from 'node:crypto';

export type OnboardingWorkspaceRecord = {
  workspaceId: string;
  organizationId: string;
  path: string;
  repositoryRemoteHash: string | null;
};

export function workspaceIdForDevice(input: { organizationId: string; deviceId: string; path: string }): string {
  const bytes = createHash('sha256')
    .update(`${input.organizationId}:${input.deviceId}:${input.path}`)
    .digest()
    .subarray(0, 16);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x50;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function selectDeviceWorkspace<T extends OnboardingWorkspaceRecord>(
  records: readonly T[],
  input: { organizationId: string; deviceId: string; path: string; repositoryRemoteHash?: string },
): T | null {
  const workspaceId = workspaceIdForDevice(input);
  const candidates = records.filter(record => record.organizationId === input.organizationId
    && record.path === input.path
    && record.workspaceId === workspaceId);
  if (candidates.length > 1) {
    throw new Error('Ambiguous registry records for the current device workspace.');
  }
  const candidate = candidates[0];
  if (!candidate || (input.repositoryRemoteHash !== undefined
    && candidate.repositoryRemoteHash !== input.repositoryRemoteHash)) {
    return null;
  }
  return candidate;
}

export function onboardingResumeCommand(input: {
  organizationId: string;
  policyRevision: string;
  repositoryKey: string | null;
  providerIds: readonly string[] | null;
}): string {
  const repositoryOption = input.repositoryKey ? ` --repository-key ${input.repositoryKey}` : '';
  const providerOption = input.providerIds?.length ? ` --providers ${input.providerIds.join(',')}` : '';
  return `dharma onboard --resume --organization-id ${input.organizationId} --workspace . --policy-revision ${input.policyRevision}${repositoryOption}${providerOption}`;
}
