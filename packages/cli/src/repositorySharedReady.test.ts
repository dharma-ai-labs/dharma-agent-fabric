import assert from 'node:assert/strict';
import test from 'node:test';
import { repositorySharedReady } from './index.js';

const workspace = {
  workspaceId: 'workspace-fixture',
  organizationId: 'org-fixture',
  name: 'fixture',
  path: '/fixture',
  routeHash: 'route-fixture',
  repositoryRemoteHash: null,
  repositoryAgentId: 'agent-fixture',
  repositoryBindingId: 'binding-fixture',
  defaultBranch: 'main',
  status: 'active' as const,
  repositoryPackage: {
    state: 'blocked' as const,
    candidateId: 'candidate-fixture',
    operationId: 'operation-fixture',
    snapshotHash: 'snapshot-fixture',
    sourceManifestHash: 'manifest-fixture',
    releaseId: null,
    generation: 0,
    consolidationMode: 'initial_repository' as const,
  },
};

test('a signed installed release is ready despite a blocked older candidate', async () => {
  assert.equal(await repositorySharedReady(workspace, async () => ({ generation: 10 })), true);
});

test('a published candidate alone cannot establish installed readiness', async () => {
  const published = { ...workspace, repositoryPackage: {
    ...workspace.repositoryPackage, state: 'published' as const, releaseId: 'release-fixture', generation: 10,
  } };
  assert.equal(await repositorySharedReady(published, async () => null), false);
  assert.equal(await repositorySharedReady(published, async () => { throw new Error('Invalid signature'); }), false);
});
