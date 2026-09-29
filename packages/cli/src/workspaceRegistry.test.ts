import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { run } from './index.js';
import { readWorkspaceRegistry } from './workspaceRegistry.js';

test('workspace registry distinguishes absence from a valid empty registry', async () => {
  assert.deepEqual(await readWorkspaceRegistry('/unused', async () => {
    throw Object.assign(new Error('missing'), { code: 'ENOENT' });
  }), { state: 'absent', records: [] });
  assert.deepEqual(await readWorkspaceRegistry('/unused', async () => '[]'), {
    state: 'valid', records: [],
  });
});

test('workspace registry fails closed on unreadable or malformed state', async () => {
  await assert.rejects(readWorkspaceRegistry('/unused', async () => {
    throw Object.assign(new Error('denied'), { code: 'EACCES' });
  }), /workspace_registry_read_failed/);
  await assert.rejects(readWorkspaceRegistry('/unused', async () => '{'), /workspace_registry_invalid/);
  await assert.rejects(readWorkspaceRegistry('/unused', async () => '{}'), /workspace_registry_invalid/);
});

test('diagnostic status reports registry health instead of masking corruption', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dharma-registry-health-'));
  await writeFile(join(home, 'device.json'), JSON.stringify({
    organizationId: 'org_test', deviceId: 'device_test',
  }));
  const previous = process.env.DHARMA_HOME;
  process.env.DHARMA_HOME = home;
  try {
    const absent = await run(['status', '--diagnostic']) as Record<string, unknown>;
    assert.deepEqual(absent.workspaceRegistry, { state: 'absent', count: 0 });
    assert.deepEqual(absent.repositoryRelays, {
      state: 'unavailable', repositories: [], reason: 'workspace_registry_missing',
    });
    await mkdir(join(home, 'registry'));
    await writeFile(join(home, 'registry', 'workspaces.json'), '[]');
    const valid = await run(['status', '--diagnostic']) as Record<string, unknown>;
    assert.deepEqual(valid.workspaceRegistry, { state: 'valid', count: 0 });
    await writeFile(join(home, 'registry', 'workspaces.json'), '{');
    const invalid = await run(['status', '--diagnostic']) as Record<string, unknown>;
    assert.deepEqual(invalid.workspaceRegistry, {
      state: 'unavailable', reason: 'workspace_registry_invalid',
    });
    assert.deepEqual(invalid.repositoryRelays, {
      state: 'unavailable', repositories: [], reason: 'workspace_registry_invalid',
    });
    await assert.rejects(run(['repositories', 'list']), /workspace_registry_invalid/);
  } finally {
    if (previous === undefined) delete process.env.DHARMA_HOME;
    else process.env.DHARMA_HOME = previous;
  }
});
