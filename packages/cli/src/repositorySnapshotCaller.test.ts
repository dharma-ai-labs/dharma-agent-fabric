import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('bound repository snapshot forwards its complete registered identity', async () => {
  const source = await readFile(new URL('../src/index.ts', import.meta.url), 'utf8');
  const command = source.slice(source.indexOf('async function repositorySnapshotCommand('), source.indexOf('async function onboard('));
  assert.match(command, /const registeredWorkspace = \(await registry\(\)\)\.find\(/);
  assert.match(command, /record\.organizationId === flags\.get\('organization-id'\)/);
  assert.match(command, /record\.workspaceId === flags\.get\('workspace-id'\)/);
  assert.match(command, /repositoryAgentId: registeredWorkspace\?\.repositoryAgentId/);
  assert.match(command, /repositoryBindingId: registeredWorkspace\?\.repositoryBindingId/);
  assert.match(command, /fetchRepositorySourceAuthorization\(await client\(\), \{/);
  assert.match(command, /sourceAuthorization,/);
});
