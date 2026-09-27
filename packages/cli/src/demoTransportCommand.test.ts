import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { run } from './index.js';
const exec = promisify(execFile);

test('transport recovery dry-run verifies repository and target without issuing grants or keys', async t => {
  const workspace = await mkdtemp(resolve(tmpdir(), 'dharma-transport-command-'));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  await exec('git', ['init', '-q', workspace]);
  await exec('git', ['-C', workspace, 'remote', 'add', 'origin', 'https://github.com/fixture/showcase.git']);
  const args = ['demo', 'transport-connect', '--hq-url', 'https://original.example', '--organization-id', 'org_fixture',
    '--repository-id', '10000000-0000-4000-8000-000000000001', '--normalized-repository', 'github.com/fixture/showcase',
    '--workspace', workspace, '--dry-run'];
  await assert.rejects(run(args), /transport-origin/);
  for (const target of ['http://corrected.example', 'https://corrected.example/', 'https://original.example']) {
    await assert.rejects(run([...args, '--transport-origin', target]), /target_invalid/);
  }
  assert.deepEqual(await run([...args, '--transport-origin', 'https://corrected.example']), {
    ok: true, stage: 'demo_transport_plan', organizationId: 'org_fixture',
    repositoryId: '10000000-0000-4000-8000-000000000001', normalizedRepository: 'github.com/fixture/showcase',
    workspaceVerified: true, repositoryPackageState: 'not_connected', transportOrigin: 'https://corrected.example' });
});
