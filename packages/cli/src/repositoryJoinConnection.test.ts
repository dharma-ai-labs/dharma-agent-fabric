import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { installRepositoryJoinConnection, type RepositoryJoinConnection } from './repositoryJoinConnection.js';
import { installNativeAgentFabricBootstrap, verifyAgentFabricSkillInstallation } from './index.js';

async function fixture(t: test.TestContext): Promise<RepositoryJoinConnection> {
  const workspace = await mkdtemp(join(tmpdir(), 'dharma-join-connection-'));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const input = { workspace, workspaceId: 'workspace-join', organizationId: 'org_join',
    bindingId: 'binding-join', sourceFingerprint: `sha256:${'a'.repeat(64)}`,
    repositoryAgentId: 'agent-join', repositoryAgentKey: 'repo:join', controlBranch: 'agents/join',
    hqUrl: 'https://www.dharma-ai.io', policyRevision: 'policy-one', onboardingMarkdown: '# Operating contract\n' };
  await mkdir(join(workspace, '.dharma'));
  await writeFile(join(workspace, '.dharma/join-identity.json'), JSON.stringify({
    organizationId: input.organizationId, bindingId: input.bindingId, sourceFingerprint: input.sourceFingerprint,
  }));
  return input;
}

test('join connection is persistent and resumes without source inventory or catalog creation', async t => {
  const input = await fixture(t);
  const result = await installRepositoryJoinConnection(input);
  const path = join(input.workspace, result.connectionPath);
  const first = await readFile(path, 'utf8');
  await installRepositoryJoinConnection(input);
  assert.equal(await readFile(path, 'utf8'), first);
  assert.equal(JSON.parse(first).accessMode, 'knowledge_only');
  assert.equal(JSON.parse(first).repositoryBindingId, input.bindingId);
  assert.doesNotMatch(first, /token|grant|secret/i);
  assert.ok(!first.includes(input.workspace));
  assert.deepEqual((await readdir(join(input.workspace, '.agents/skills/dharma-agent-fabric'))).sort(),
    ['.dharma-agent-fabric.json', 'SKILL.md', 'references']);
  assert.deepEqual((await readdir(join(input.workspace, '.dharma'))).sort(),
    ['agent-fabric.json', 'join-identity.json', 'repository-agent.json']);
});

test('foreign join identity is rejected before any connection write', async t => {
  const input = await fixture(t);
  await assert.rejects(installRepositoryJoinConnection({ ...input, organizationId: 'org_foreign' }),
    /repository_join_workspace_identity_conflict/);
  assert.deepEqual(await readdir(join(input.workspace, '.dharma')), ['join-identity.json']);
});

test('foreign connection remains untouched on resume', async t => {
  const input = await fixture(t);
  await installRepositoryJoinConnection(input);
  const path = join(input.workspace, '.dharma/agent-fabric.json');
  const prior = JSON.parse(await readFile(path, 'utf8'));
  await writeFile(path, JSON.stringify({ ...prior, workspaceId: 'foreign-workspace' }));
  const before = await readFile(path, 'utf8');
  await assert.rejects(installRepositoryJoinConnection(input), /repository_join_connection_scope_conflict/);
  assert.equal(await readFile(path, 'utf8'), before);
});

test('join repair preserves signed skill and ownership byte-for-byte', async t => {
  const input = await fixture(t);
  const root = join(input.workspace, '.agents/skills/dharma-agent-fabric');
  await mkdir(root, { recursive: true });
  const signed = { skillId: 'dharma-agent-fabric', workspaceId: input.workspaceId,
    bundleId: '11111111-1111-4111-8111-111111111111' };
  await writeFile(join(root, '.dharma-agent-fabric.json'), JSON.stringify(signed));
  await writeFile(join(root, 'SKILL.md'), '# Signed skill content\n');
  await installRepositoryJoinConnection(input);
  assert.equal(await readFile(join(root, 'SKILL.md'), 'utf8'), '# Signed skill content\n');
  assert.equal(await readFile(join(root, '.dharma-agent-fabric.json'), 'utf8'), JSON.stringify(signed));
});

test('join refuses unmanaged skill files', async t => {
  const input = await fixture(t);
  const root = join(input.workspace, '.agents/skills/dharma-agent-fabric');
  await mkdir(root, { recursive: true });
  await writeFile(join(root, 'SKILL.md'), '# Customer skill\n');
  await assert.rejects(installRepositoryJoinConnection(input), /unmanaged repository skill/);
  assert.equal(await readFile(join(root, 'SKILL.md'), 'utf8'), '# Customer skill\n');
});

test('join connection repairs bootstrap verification without claiming signed lifecycle readiness', async t => {
  const input = await fixture(t);
  const previous = process.env.DHARMA_HOME;
  const home = await mkdtemp(join(tmpdir(), 'dharma-join-test-home-'));
  process.env.DHARMA_HOME = home;
  t.after(async () => {
    if (previous === undefined) delete process.env.DHARMA_HOME; else process.env.DHARMA_HOME = previous;
    await rm(home, { recursive: true, force: true });
  });
  const native = { provider: 'codex' as const, workspace: input.workspace, workspaceId: input.workspaceId,
    organizationId: input.organizationId, hqUrl: input.hqUrl, home, env: { HOME: home, CODEX_HOME: join(home, '.codex') } };
  await installNativeAgentFabricBootstrap(native);
  const before = await verifyAgentFabricSkillInstallation(native);
  assert.equal(before.ready, false);
  assert.equal(before.repositoryInstalled, false);
  await installRepositoryJoinConnection(input);
  const after = await verifyAgentFabricSkillInstallation(native);
  assert.equal(after.ready, true);
  assert.equal(after.workspaceId, input.workspaceId);
  assert.equal(after.repositoryInstalled, true);
  assert.equal(after.verificationScope, 'generic_bootstrap');
  assert.equal(after.signedLifecycleReady, false);
  assert.equal(after.activeBundleId, null);
});

test('join identity symlink is rejected without changing its target', async t => {
  const input = await fixture(t);
  const marker = join(input.workspace, '.dharma/join-identity.json');
  const target = join(input.workspace, 'foreign-marker.json');
  const original = await readFile(marker, 'utf8');
  await writeFile(target, original);
  await unlink(marker);
  await symlink(target, marker);
  await assert.rejects(installRepositoryJoinConnection(input), /symlink is forbidden/);
  assert.equal(await readFile(target, 'utf8'), original);
});
