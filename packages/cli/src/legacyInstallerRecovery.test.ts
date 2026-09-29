import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, writeFile, symlink, unlink, link } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { recoverLegacyRepositoryInstaller, selectLegacyInstallerRecoveryWorkspace } from './legacyInstallerRecovery.js';
import { workspaceIdForDevice } from './onboardingWorkspace.js';
import { run } from './index.js';
import { writeRepositoryInstallerFile } from './repositoryInstallerFiles.js';

const oldId = '11111111-1111-4111-8111-111111111111';
const newId = '22222222-2222-4222-8222-222222222222';
const key = 'repo:c12dc094ccfdc09f70f40421';
const root = '.agents/skills/dharma-agent-fabric';
const marker = `${root}/.dharma-agent-fabric.json`;
const git = promisify(execFile);
for (const path of ['C:\\repo\\competitive', '/repo/competitive']) {
  test(`canonical server workspace selection remains bound to the current device route: ${path}`, () => {
    const scope = { organizationId: 'org_current', deviceId: newId, path,
      repositoryRemoteHash: 'sha256:abc', workspaceId: oldId };
    const current = { ...scope, workspaceId: workspaceIdForDevice(scope), routeHash: 'sha256:route' };
    const canonical = { ...current, workspaceId: oldId };
    assert.equal(selectLegacyInstallerRecoveryWorkspace([current, canonical], scope), canonical);
    assert.throws(() => selectLegacyInstallerRecoveryWorkspace([canonical], scope), /canonical/);
    assert.throws(() => selectLegacyInstallerRecoveryWorkspace([current, canonical, canonical], scope), /canonical/);
    for (const changed of [{ organizationId: 'org_other' }, { path: `${path}-other` },
      { routeHash: 'sha256:other' }, { repositoryRemoteHash: 'sha256:other' }]) {
      assert.throws(() => selectLegacyInstallerRecoveryWorkspace([current, { ...canonical, ...changed }], scope), /canonical/);
    }
  });
}
test('CLI recovery requires exactly one explicit plan or apply mode before enrollment', async () => {
  await assert.rejects(() => run(['repositories', 'recover-installer']), /exactly one/);
  await assert.rejects(() => run(['repositories', 'recover-installer', '--apply', '--dry-run']), /exactly one/);
  await assert.rejects(() => run(['repositories', 'recover-installer', '--dry-run']), /from-workspace-id/);
});
async function fixture() {
  const workspace = await mkdtemp(join(tmpdir(), 'dharma-legacy-installer-'));
  await mkdir(join(workspace, root, 'references'), { recursive: true });
  await mkdir(join(workspace, '.dharma'));
  const files: Record<string, string> = {
    [marker]: JSON.stringify({ managedBy: 'dharma-agent-fabric', workspaceId: oldId }),
    [`${root}/SKILL.md`]: '# Legacy bootstrap\n',
    [`${root}/references/organization.md`]: '# Old organization\n',
    '.dharma/agent-fabric.json': JSON.stringify({ schema: 'dharma.repository-connection/v2', workspaceId: oldId,
      organizationId: 'org_old', repositoryAgentKey: key }),
    '.dharma/repository-agent.json': JSON.stringify({ schema: 'dharma.repository-agent/v1', workspaceId: oldId,
      organizationId: 'org_old', agentKey: key }),
  };
  for (const [path, content] of Object.entries(files)) await writeFile(join(workspace, path), content);
  await git('git', ['init', workspace]);
  await git('git', ['-C', workspace, 'add', '.']);
  await git('git', ['-C', workspace, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test',
    'commit', '-m', 'legacy bootstrap']);
  return { workspace, files, input: { workspace, fromWorkspaceId: oldId, workspaceId: newId,
    repositoryAgentKey: key, apply: true } };
}

test('explicit legacy recovery preserves originals and changes only unsigned workspace ownership', async () => {
  const { workspace, files, input } = await fixture();
  const receipt = await recoverLegacyRepositoryInstaller(input);
  assert.equal(receipt.applied, true);
  assert.equal(receipt.signedLifecycleReady, false);
  assert.deepEqual(JSON.parse(await readFile(join(workspace, marker), 'utf8')),
    { managedBy: 'dharma-agent-fabric', workspaceId: newId });
  for (const [path, original] of Object.entries(files)) {
    assert.equal(await readFile(join(workspace, receipt.backupDirectory!, path), 'utf8'), original);
    if (path !== marker) assert.equal(await readFile(join(workspace, path), 'utf8'), original);
  }
  await assert.rejects(() => recoverLegacyRepositoryInstaller(input), /foreign/);
});

test('dry-run has no local mutation or backup', async () => {
  const { workspace, files, input } = await fixture();
  const plan = await recoverLegacyRepositoryInstaller({ ...input, apply: false });
  assert.equal(plan.applied, false);
  assert.equal(plan.backupDirectory, null);
  for (const [path, content] of Object.entries(files)) assert.equal(await readFile(join(workspace, path), 'utf8'), content);
  assert.deepEqual((await readdir(join(workspace, '.dharma'))).sort(), ['agent-fabric.json', 'repository-agent.json']);
});

test('Windows CRLF checkout conversion preserves original backup bytes', async () => {
  const { workspace, input } = await fixture();
  await writeFile(join(workspace, root, 'SKILL.md'), '# Legacy bootstrap\r\n');
  const result = await recoverLegacyRepositoryInstaller(input);
  assert.equal(await readFile(join(workspace, result.backupDirectory!, root, 'SKILL.md'), 'utf8'), '# Legacy bootstrap\r\n');
});

test('replacement refuses a changed destination and preserves it', async () => {
  const { workspace } = await fixture();
  const expected = await readFile(join(workspace, marker));
  await writeFile(join(workspace, marker), '{"changed":true}');
  await assert.rejects(() => writeRepositoryInstallerFile(workspace, marker, '{}', expected), /changed before replacement/);
  assert.equal(await readFile(join(workspace, marker), 'utf8'), '{"changed":true}');
});

for (const kind of ['signed', 'malformed', 'modified', 'extra', 'wrong_repository', 'untracked', 'hardlink', 'symlink'] as const) {
  test(`recovery rejects ${kind} state without changing ownership`, async () => {
    const { workspace, input } = await fixture();
    if (kind === 'signed') await writeFile(join(workspace, marker), JSON.stringify({ skillId: 'dharma-agent-fabric',
      bundleId: '33333333-3333-4333-8333-333333333333', workspaceId: oldId }));
    if (kind === 'malformed') await writeFile(join(workspace, marker), '{}');
    if (kind === 'modified') await writeFile(join(workspace, root, 'SKILL.md'), '# User modification\n');
    if (kind === 'extra') await writeFile(join(workspace, root, 'custom.md'), '# Custom skill\n');
    if (kind === 'wrong_repository') input.repositoryAgentKey = 'repo:aaaaaaaaaaaaaaaaaaaaaaaa';
    if (kind === 'untracked') await git('git', ['-C', workspace, 'rm', '--cached', `${root}/SKILL.md`]);
    if (kind === 'hardlink' || kind === 'symlink') {
      const path = join(workspace, root, 'SKILL.md');
      const target = join(workspace, 'outside.md');
      await writeFile(target, '# Outside\n');
      await unlink(path);
      if (kind === 'hardlink') await link(target, path);
      else await symlink(target, path);
    }
    const before = await readFile(join(workspace, marker), 'utf8');
    await assert.rejects(() => recoverLegacyRepositoryInstaller(input));
    assert.equal(await readFile(join(workspace, marker), 'utf8'), before);
  });
}
