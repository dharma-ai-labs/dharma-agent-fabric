import assert from 'node:assert/strict';
import {mkdtemp, readFile, readdir, rm, writeFile} from 'node:fs/promises';
import {readFileSync, existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';
import test from 'node:test';
import {loadOrCreateInstallationId} from './index.js';
import {runCodexBootstrapHost} from './bootstrapHostScope.js';

async function fixture(t: {after(fn: () => Promise<void>): void}) {
  const root = await mkdtemp(resolve(tmpdir(), 'dharma-installation-scope-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const now = Date.now(), digest = `sha256:${'a'.repeat(64)}`;
  const id = (n: number) => `${String(n).padStart(8, '0')}-1111-4111-8111-111111111111`;
  return {root, path: resolve(root, 'state', 'installation.json'), input: {workspace: root,
    signal: new AbortController().signal, current: async () => true, intent: {
      schema: 'dharma.codex-setup-intent/v1' as const, operationId: id(1), setupReference: id(2),
      organizationId: 'org_demo', recipientMembershipId: id(3), origin: 'https://hq.example',
      repositoryFingerprint: digest, policyRevision: 'policy-v1', scopeDigest: digest, contractDigest: digest,
      hostContextId: id(4), issuedAt: new Date(now - 1000).toISOString(), expiresAt: new Date(now + 60_000).toISOString()}}};
}

test('installation creation refuses a closed owning scope before any filesystem effect', async t => {
  const f = await fixture(t); let outcome: PromiseSettledResult<string>[] = [];
  await assert.rejects(runCodexBootstrapHost(f.input, async prepared => {
    prepared.scope.close(); outcome = await Promise.allSettled([loadOrCreateInstallationId(f.path)]);
  }), {message: 'codex_setup_host_scope_unavailable'});
  assert.equal(outcome[0]?.status, 'rejected');
  if (outcome[0]?.status === 'rejected') assert.equal(outcome[0].reason.message, 'codex_setup_host_scope_unavailable');
  assert.deepEqual(await readdir(f.root), []);
});

test('installation creation preserves a partial owned file after withdrawal without returning an identity', async t => {
  const f = await fixture(t); let returned = false;
  await assert.rejects(runCodexBootstrapHost({...f.input,
    current: async () => !existsSync(f.path) || readFileSync(f.path).length === 0},
  async () => {const value = await loadOrCreateInstallationId(f.path); returned = true; return value;}),
  {message: 'codex_setup_host_scope_unavailable'});
  assert.equal(returned, false);
  const value = JSON.parse(await readFile(f.path, 'utf8'));
  assert.equal(value.schema, 'dharma.installation-identity/v1');
  assert.match(value.installationId, /^[a-f0-9-]{36}$/);
  // The cleanup must have closed the acquired handle; this is not a replacement identity.
  await rm(f.path); assert.deepEqual(await readdir(resolve(f.root, 'state')), []);
});

test('installation creation stops after owned acquisition when authority is withdrawn', async t => {
  const f = await fixture(t);
  await assert.rejects(runCodexBootstrapHost({...f.input, current: async () => !existsSync(f.path)},
    () => loadOrCreateInstallationId(f.path)), {message: 'codex_setup_host_scope_unavailable'});
  assert.equal((await readFile(f.path)).length, 0);
  await rm(f.path);
});

test('current-scoped installation preserves ordinary durable UUID reuse', async t => {
  const f = await fixture(t);
  const first = await runCodexBootstrapHost(f.input, () => loadOrCreateInstallationId(f.path));
  const before = await readFile(f.path, 'utf8');
  assert.equal(await runCodexBootstrapHost(f.input, () => loadOrCreateInstallationId(f.path)), first);
  assert.equal(await loadOrCreateInstallationId(f.path), first);
  assert.equal(await readFile(f.path, 'utf8'), before);
});

test('scoped corrupt installation is preserved and parser diagnostics are withheld', async t => {
  const f = await fixture(t), path = resolve(f.root, 'installation.json');
  const original = '{private-installation-parser-canary'; await writeFile(path, original);
  await assert.rejects(runCodexBootstrapHost(f.input, () => loadOrCreateInstallationId(path)),
    {message: 'codex_setup_host_installation_failed'});
  assert.equal(await readFile(path, 'utf8'), original);
});
