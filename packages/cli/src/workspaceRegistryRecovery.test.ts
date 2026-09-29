import assert from 'node:assert/strict';
import { link, mkdtemp, mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { appendRecoveredWorkspace, applyRegistryRecoveryFile, backupRegistryRecoveryFile, inspectRegistryRecoveryFile,
  resolveRegistryRecoveryProjection } from './workspaceRegistryRecovery.js';

const scope = { organizationId: 'org_test', deviceId: 'device_test', workspaceId: 'workspace_test',
  policyRevision: 'policy_test', repositoryFingerprint: 'sha256:source' };
const workspaces = { ok: true, organizationId: scope.organizationId, workspaces: [{
  id: scope.workspaceId, device_id: scope.deviceId, status: 'active', repository_binding_id: 'binding_test',
  name: 'repo', default_branch: 'main', policy_revision: scope.policyRevision,
}] };
const repositoryAgents = { ok: true, organizationId: scope.organizationId, repositoryAgents: [{
  id: 'binding_test', status: 'active', source_repository_fingerprint: scope.repositoryFingerprint,
  organization_agent_id: 'agent_test', control_branch: 'agent-fabric/control',
  agent: { id: 'agent_test', agent_key: 'repo-key' },
  workspaces: [{ id: scope.workspaceId, device_id: scope.deviceId, repository_binding_id: 'binding_test', status: 'active' }],
  endpoints: [{ id: 'endpoint_test', workspace_id: scope.workspaceId, device_id: scope.deviceId,
    organization_agent_id: 'agent_test', status: 'active', endpoint_kind: 'local_provider',
    credential_boundary: 'local_device', provider: 'codex' }],
}] };

test('registry recovery accepts only one current-device canonical binding', () => {
  assert.deepEqual(resolveRegistryRecoveryProjection({ ...scope, workspaces, repositoryAgents }), {
    repositoryBindingId: 'binding_test', repositoryAgentId: 'agent_test', repositoryAgentKey: 'repo-key',
    controlBranch: 'agent-fabric/control', endpointId: 'endpoint_test', name: 'repo', defaultBranch: 'main',
  });
});

test('registry recovery selects the same local endpoint as repository connect', () => {
  const binding = repositoryAgents.repositoryAgents[0]!;
  const codex = binding.endpoints[0]!;
  const claude = { ...codex, id: 'endpoint_claude', provider: 'claude' };
  const managed = { ...codex, id: 'endpoint_managed', endpoint_kind: 'managed_runtime' };
  const foreignCredential = { ...codex, id: 'endpoint_foreign_credential', credential_boundary: 'cloud' };
  const projection = resolveRegistryRecoveryProjection({ ...scope, workspaces,
    repositoryAgents: { ...repositoryAgents, repositoryAgents: [{ ...binding,
      endpoints: [claude, managed, foreignCredential, codex] }] } });
  assert.equal(projection.endpointId, 'endpoint_test');
});

test('registry recovery rejects foreign, revoked, duplicate and mismatched projections', () => {
  const resolve = (workspaceRows: unknown, agentRows: unknown) =>
    resolveRegistryRecoveryProjection({ ...scope, workspaces: workspaceRows, repositoryAgents: agentRows });
  assert.throws(() => resolve({ ...workspaces, organizationId: 'org_other' }, repositoryAgents), /scope_mismatch/);
  assert.throws(() => resolve({ ...workspaces, workspaces: [workspaces.workspaces[0], workspaces.workspaces[0]] },
    repositoryAgents), /workspace_missing_or_ambiguous/);
  assert.throws(() => resolve({ ...workspaces, workspaces: [{ ...workspaces.workspaces[0], device_id: 'foreign' }] },
    repositoryAgents), /workspace_authority_mismatch/);
  assert.throws(() => resolve({ ...workspaces, workspaces: [{ ...workspaces.workspaces[0], status: 'revoked' }] },
    repositoryAgents), /workspace_authority_mismatch/);
  assert.throws(() => resolve({ ...workspaces, workspaces: [{ ...workspaces.workspaces[0], policy_revision: 'newer' }] },
    repositoryAgents), /workspace_authority_mismatch/);
  const binding = repositoryAgents.repositoryAgents[0]!;
  assert.throws(() => resolve(workspaces, { ...repositoryAgents, repositoryAgents: [{ ...binding,
    source_repository_fingerprint: 'sha256:other' }] }), /repository_mismatch/);
  assert.throws(() => resolve(workspaces, { ...repositoryAgents, repositoryAgents: [{ ...binding,
    workspaces: [] }] }), /binding_workspace_mismatch/);
  assert.throws(() => resolve(workspaces, { ...repositoryAgents, repositoryAgents: [{ ...binding,
    endpoints: [{ ...binding.endpoints[0], status: 'revoked' }] }] }), /endpoint_missing/);
  assert.throws(() => resolve(workspaces, { ...repositoryAgents, repositoryAgents: [{ ...binding,
    endpoints: [binding.endpoints[0], binding.endpoints[0]] }] }), /endpoint_ambiguous/);
  assert.throws(() => resolve(workspaces, { ...repositoryAgents, repositoryAgents: [{ ...binding,
    endpoints: [binding.endpoints[0], { ...binding.endpoints[0], id: 'second_codex' }] }] }), /endpoint_ambiguous/);
});

test('registry recovery appends without overwriting another workspace or foreign state', () => {
  const first = { workspaceId: 'first', organizationId: 'org_test', path: '/first', repositoryRemoteHash: 'sha256:first' };
  const second = { workspaceId: 'second', organizationId: 'org_test', path: '/second', repositoryRemoteHash: 'sha256:second' };
  assert.deepEqual(appendRecoveredWorkspace([first], second), { records: [first, second], alreadyPresent: false });
  assert.deepEqual(appendRecoveredWorkspace([first], first), { records: [first], alreadyPresent: true });
  assert.throws(() => appendRecoveredWorkspace([first], { ...second, path: '/first' }), /existing_row_conflict/);
  assert.throws(() => appendRecoveredWorkspace([first, first], first), /existing_rows_ambiguous/);
  assert.throws(() => appendRecoveredWorkspace([{ ...first, organizationId: 'foreign' }], second),
    /foreign_organization/);
});

test('registry recovery preserves zero-byte evidence and rejects changed files', async () => {
  const home = await mkdtemp(join(tmpdir(), 'registry-recovery-'));
  const directory = join(home, 'registry');
  await mkdir(directory);
  const path = join(directory, 'workspaces.json');
  await writeFile(path, '');
  const snapshot = await inspectRegistryRecoveryFile(path);
  assert.equal(snapshot.kind, 'corrupt_zero');
  assert.equal(snapshot.hash, 'sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  const backup = await backupRegistryRecoveryFile({ home, path, expectedBytes: snapshot.bytes });
  assert.ok(backup);
  assert.equal((await readFile(backup)).length, 0);
  assert.equal((await readFile(path)).length, 0);
  await writeFile(path, '[]');
  await assert.rejects(backupRegistryRecoveryFile({ home, path, expectedBytes: snapshot.bytes }),
    /registry_recovery_registry_changed/);
  assert.equal((await inspectRegistryRecoveryFile(path)).kind, 'valid');
  await writeFile(path, '{');
  await assert.rejects(inspectRegistryRecoveryFile(path), /registry_recovery_nonempty_registry_invalid/);
  assert.equal((await readFile(path, 'utf8')), '{');
});

test('registry recovery refuses symlinked registry and does not follow its target', async () => {
  const home = await mkdtemp(join(tmpdir(), 'registry-recovery-link-'));
  const target = join(home, 'target.json');
  await writeFile(target, '[]');
  await mkdir(join(home, 'registry'));
  await symlink(target, join(home, 'registry', 'workspaces.json'));
  await assert.rejects(inspectRegistryRecoveryFile(join(home, 'registry', 'workspaces.json')),
    /registry_recovery_registry_file_unsafe/);
  assert.equal(await readFile(target, 'utf8'), '[]');
});

test('registry recovery refuses a hardlinked registry file', async () => {
  const home = await mkdtemp(join(tmpdir(), 'registry-recovery-hardlink-'));
  const target = join(home, 'target.json');
  await writeFile(target, '[]');
  await mkdir(join(home, 'registry'));
  await link(target, join(home, 'registry', 'workspaces.json'));
  await assert.rejects(inspectRegistryRecoveryFile(join(home, 'registry', 'workspaces.json')),
    /registry_recovery_registry_file_unsafe/);
  assert.equal(await readFile(target, 'utf8'), '[]');
});

test('registry recovery applies one row atomically and preserves the corrupt file', async () => {
  const home = await mkdtemp(join(tmpdir(), 'registry-recovery-apply-'));
  const directory = join(home, 'registry');
  await mkdir(directory);
  const path = join(directory, 'workspaces.json');
  await writeFile(path, '');
  const entry = { workspaceId: 'anchor', organizationId: 'org_test', path: '/anchor',
    repositoryRemoteHash: 'sha256:source' };
  const expectedHash = (await inspectRegistryRecoveryFile(path)).hash;
  const applied = await applyRegistryRecoveryFile({ home, path, expectedKind: 'corrupt_zero', expectedHash, entry });
  assert.equal(applied.state, 'recovered');
  assert.ok(applied.backup);
  assert.equal((await readFile(applied.backup!)).length, 0);
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), [entry]);
  await assert.rejects(applyRegistryRecoveryFile({ home, path, expectedKind: 'corrupt_zero', expectedHash, entry }),
    /registry_recovery_registry_changed/);
  const second = { ...entry, workspaceId: 'second', path: '/second' };
  const currentHash = (await inspectRegistryRecoveryFile(path)).hash;
  const added = await applyRegistryRecoveryFile({ home, path, expectedKind: 'valid', expectedHash: currentHash,
    entry: second });
  assert.equal(added.restoredCount, 2);
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), [entry, second]);
});
