import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { canonicalize } from '@dharma-ai-labs/agent-fabric-contracts';
import { LocalVault, type LocalProviderSessionBinding } from '@dharma-ai-labs/agent-fabric-local-vault';
import type { CodexLocalWorkCapture } from '@dharma-ai-labs/agent-fabric-provider-adapters/experimental/codex-session';
import { inventoryRepositoryPackage } from './repositoryPackage.js';
import type { RepositorySourceAuthorization } from './repositorySourceAuthorization.js';
import { retainNamedSessionRepositoryState } from './namedSessionRepositoryState.js';
import { initializeRepositoryKnowledge } from './repositoryKnowledge.js';

test('task source states retain approved bytes encrypted and reject foreign or changed authority', async t => {
  const root = await mkdtemp(join(tmpdir(), 'named-state-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const vault = await LocalVault.open({ root: join(root, 'vault'), masterKey: randomBytes(32) });
  t.after(() => vault.close());
  const binding: LocalProviderSessionBinding = { schema: 'dharma.local-provider-session-binding/v1',
    organizationId: 'org_synthetic', workspaceId: randomUUID(), repositoryBindingId: randomUUID(),
    endpointId: randomUUID(), membershipId: randomUUID(), deviceId: randomUUID(), bindingId: randomUUID(),
    provider: 'codex', sessionId: randomUUID(), owner: 'dharma_bridge', workspaceRoot: root,
    createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60000).toISOString(), maximumProviderCostCents: 10 };
  const policy: RepositorySourceAuthorization['policy'] = { action: 'authorize', confirmed: true,
    requestId: randomUUID(), repositoryBindingId: binding.repositoryBindingId, expectedRevision: 0,
    allowedContentClasses: ['approved_outputs', 'repository_content', 'repository_skills'], approvedRepositoryPaths: ['README.md'], approvedOutputFolders: [],
    automaticValidatedPublication: true, retentionDays: 30, maximumFileBytes: 262144,
    maximumSnapshotBytes: 4194304, maximumDailyUploadBytes: 8388608, expiresAt: null };
  const generationId = randomUUID();
  const sourceAuthorization: RepositorySourceAuthorization = {
    schema: 'dharma.repository-source-authorization/v1', organizationId: binding.organizationId,
    workspaceId: binding.workspaceId, repositoryBindingId: binding.repositoryBindingId, repositoryAgentId: randomUUID(),
    revision: 1, generationId, receiptId: `repo_consent_${generationId}`, policyRevision: `repository-source-${generationId}`,
    confirmedAt: new Date().toISOString(), policyHash: `sha256:${createHash('sha256').update(canonicalize(policy)).digest('hex')}`, policy };
  const snapshotInput = { workspace: root, organizationId: binding.organizationId, workspaceId: binding.workspaceId,
    repositoryAgentId: sourceAuthorization.repositoryAgentId, repositoryBindingId: binding.repositoryBindingId, sourceAuthorization };
  const skillRoot = join(root, '.agents/skills/dharma-agent-fabric');
  await mkdir(skillRoot, { recursive: true });
  await writeFile(join(skillRoot, '.dharma-agent-fabric.json'), JSON.stringify({ managedBy: 'dharma-agent-fabric', workspaceId: binding.workspaceId }));
  await initializeRepositoryKnowledge(snapshotInput);
  await writeFile(join(root, 'README.md'), 'SYNTHETIC_BEFORE_CANARY');
  await writeFile(join(root, 'private-grader.txt'), 'PRIVATE_GRADER_MUST_NOT_BE_CAPTURED');
  const before = await inventoryRepositoryPackage(snapshotInput);
  await writeFile(join(root, 'README.md'), 'SYNTHETIC_AFTER_CANARY');
  const after = await inventoryRepositoryPackage(snapshotInput);
  const workId = randomUUID(), closedAt = new Date().toISOString();
  const capture: CodexLocalWorkCapture = { schema: 'dharma.codex-local-work-capture/v1', captureId: randomUUID(),
    organizationId: binding.organizationId, repositoryBindingId: binding.repositoryBindingId,
    workspaceId: binding.workspaceId, endpointId: binding.endpointId, membershipId: binding.membershipId,
    deviceId: binding.deviceId, provider: 'codex', bindingId: binding.bindingId, workId,
    providerThreadId: binding.sessionId, providerTurnId: randomUUID(), startedAt: closedAt, closedAt,
    workOutcome: 'completed', providerTurnState: 'completed', captureScope: 'turn_notifications', coverage: 'observed',
    limitations: [], droppedEvents: 0, acceptedLearningObservation: false, executedModel: null,
    events: [], eventsHash: `sha256:${createHash('sha256').update('[]').digest('hex')}` };
  const input = { vault, binding, workId, capture, before, after, activeBundleId: randomUUID(), activeBundleHash: `sha256:${'a'.repeat(64)}` };
  const receipt = await retainNamedSessionRepositoryState(input);
  assert.notEqual(receipt.sourceSnapshotHash, receipt.resultSnapshotHash);
  assert.equal(receipt.acceptedLearningObservation, false);
  for (const [contentHash, canary] of [[receipt.sourceContentHash, 'SYNTHETIC_BEFORE_CANARY'],
    [receipt.resultContentHash, 'SYNTHETIC_AFTER_CANARY']]) {
    const stored = JSON.parse((await vault.getBlob(contentHash!)).toString());
    assert.ok(stored.blobs.some((blob: { contentBase64: string }) => Buffer.from(blob.contentBase64, 'base64').toString() === canary));
    assert.equal(stored.manifest.files.some((file: { relativePath: string }) => file.relativePath === 'private-grader.txt'), false);
    const hash = contentHash!.slice(7);
    assert.equal((await readFile(join(root, 'vault/blobs', hash.slice(0, 2), `${hash}.blob`))).includes(Buffer.from(canary!)), false);
  }
  assert.equal(JSON.stringify(receipt).includes('CANARY'), false);
  await assert.rejects(retainNamedSessionRepositoryState({ ...input, workId: randomUUID() }), /scope_mismatch/);
  await assert.rejects(retainNamedSessionRepositoryState({ ...input, binding: { ...binding, deviceId: randomUUID() } }), /scope_mismatch/);
  await assert.rejects(retainNamedSessionRepositoryState({ ...input, after: { ...after, manifest: { ...after.manifest,
    sourceAuthorization: { ...sourceAuthorization, revision: 2 } } } }), /policy_changed/);
  await assert.rejects(retainNamedSessionRepositoryState({ ...input, after: { ...after, blobs: [] } }), /blob is missing/);
});
