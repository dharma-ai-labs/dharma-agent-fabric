import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { run } from './index.js';
import { readWorkspaceRegistry } from './workspaceRegistry.js';
import {runCodexBootstrapHost} from './bootstrapHostScope.js';

function intent(workspace: string) {
  const now = Date.now(), hash = `sha256:${'a'.repeat(64)}`;
  const id = (n: number) => `${String(n).padStart(8, '0')}-1111-4111-8111-111111111111`;
  return {workspace, current: async () => true, signal: new AbortController().signal,
    intent: {schema: 'dharma.codex-setup-intent/v1' as const, operationId: id(1), setupReference: id(2),
      organizationId: 'org_demo', recipientMembershipId: id(3), origin: 'https://hq.example',
      repositoryFingerprint: hash, policyRevision: 'policy-v1', scopeDigest: hash, contractDigest: hash,
      hostContextId: id(4), issuedAt: new Date(now - 1000).toISOString(), expiresAt: new Date(now + 60_000).toISOString()}};
}

test('scoped registry read refuses a closed owner before invoking its reader', async () => {
  let reads = 0, result: PromiseSettledResult<unknown>[] = [];
  await assert.rejects(runCodexBootstrapHost(intent(tmpdir()), async ({scope}) => {
    scope.close(); result = await Promise.allSettled([readWorkspaceRegistry('/unused', async () => {reads++; return '[]';})]);
  }), {message: 'codex_setup_host_scope_unavailable'});
  assert.equal(result[0]?.status, 'rejected'); assert.equal(reads, 0);
});

test('scoped registry read cannot return data or absence after reader withdrawal', async () => {
  for (const absent of [false, true]) {
    let returned = false;
    await assert.rejects(runCodexBootstrapHost(intent(tmpdir()), async ({scope}) => {
      const result = await readWorkspaceRegistry('/unused', async () => {
        scope.close();
        if (absent) throw Object.assign(new Error('private-reader-canary'), {code: 'ENOENT'});
        return '[{"workspaceId":"private-row-canary"}]';
      });
      returned = true; return result;
    }), {message: 'codex_setup_host_scope_unavailable'});
    assert.equal(returned, false);
  }
});

test('scoped registry failures withhold reader and parser diagnostic causes', async () => {
  for (const read of [async () => {throw new Error('private-reader-canary');}, async () => '{private-parser-canary']) {
    let captured: unknown;
    await runCodexBootstrapHost(intent(tmpdir()), async () => {
      try {await readWorkspaceRegistry('/unused', read);} catch (error) {captured = error;}
    });
    assert.ok(captured instanceof Error);
    assert.equal(captured.cause, undefined); assert.doesNotMatch(captured.message, /private/);
  }
});

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
