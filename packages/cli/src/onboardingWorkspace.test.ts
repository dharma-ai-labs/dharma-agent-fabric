import assert from 'node:assert/strict';
import test from 'node:test';
import { onboardingResumeCommand, selectDeviceWorkspace, workspaceIdForDevice } from './onboardingWorkspace.js';

const path = process.platform === 'win32' ? 'C:\\repo' : '/repo';

test('onboarding selects the current device workspace instead of the first row for a path', () => {
  const scope = { organizationId: 'org-a', deviceId: 'device-current', path };
  const stale = {
    workspaceId: 'workspace-stale', organizationId: 'org-a', path, repositoryRemoteHash: 'sha256:repo',
  };
  const current = {
    workspaceId: workspaceIdForDevice(scope), organizationId: 'org-a', path, repositoryRemoteHash: 'sha256:repo',
  };

  assert.equal(selectDeviceWorkspace([stale, current], {
    ...scope,
    repositoryRemoteHash: current.repositoryRemoteHash,
  }), current);
});

test('onboarding does not reuse a workspace from another organization, device, path, or repository identity', () => {
  const scope = { organizationId: 'org-a', deviceId: 'device-current', path };
  const workspaceId = workspaceIdForDevice(scope);
  const records = [
    { workspaceId, organizationId: 'org-b', path, repositoryRemoteHash: 'sha256:repo' },
    { workspaceId: 'workspace-other', organizationId: 'org-a', path, repositoryRemoteHash: 'sha256:repo' },
    { workspaceId: 'workspace-other-2', organizationId: 'org-a', path, repositoryRemoteHash: 'sha256:repo' },
    { workspaceId, organizationId: 'org-a', path: `${path}-other`, repositoryRemoteHash: 'sha256:repo' },
    { workspaceId, organizationId: 'org-a', path, repositoryRemoteHash: 'sha256:other' },
  ];

  assert.equal(selectDeviceWorkspace(records, {
    ...scope, repositoryRemoteHash: 'sha256:repo',
  }), null);
});

test('onboarding resume preserves the repository identity and selected providers', () => {
  assert.equal(onboardingResumeCommand({
    organizationId: 'org-a',
    policyRevision: 'policy-a',
    repositoryKey: 'github.com/dharma-ai-labs/example',
    providerIds: ['codex', 'claude'],
  }), 'dharma onboard --resume --organization-id org-a --workspace . --policy-revision policy-a'
    + ' --repository-key github.com/dharma-ai-labs/example --providers codex,claude');
});

test('onboarding refuses conflicting duplicate records for the deterministic device workspace', () => {
  const scope = { organizationId: 'org-a', deviceId: 'device-current', path };
  const record = { workspaceId: workspaceIdForDevice(scope), organizationId: 'org-a', path, repositoryRemoteHash: null };
  assert.throws(() => selectDeviceWorkspace([record, { ...record }], scope), /ambiguous/i);
  assert.throws(() => selectDeviceWorkspace([
    { ...record, repositoryRemoteHash: 'sha256:repo' },
    { ...record, repositoryRemoteHash: 'sha256:other' },
  ], { ...scope, repositoryRemoteHash: 'sha256:repo' }), /ambiguous/i);
});
