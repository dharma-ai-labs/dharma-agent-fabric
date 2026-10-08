import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { link, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test, { type TestContext } from 'node:test';
import { canonicalize } from '@dharma-ai-labs/agent-fabric-contracts';
import type { RepositorySourceResolutionPlan } from './repositorySourceReconciliation.js';
import { activateRepositorySourceResolution, readActiveRepositorySourceResolution,
  readRepositorySourceResolutionPlan, saveRepositorySourceResolutionPlan } from './repositorySourceResolutionStore.js';

const digest = (value: unknown) => `sha256:${createHash('sha256').update(canonicalize(value)).digest('hex')}`;
const hash = `sha256:${'a'.repeat(64)}`;
const now = new Date('2026-10-08T03:00:00.000Z');
function proposed() {
  const plan: RepositorySourceResolutionPlan = {
    schema: 'dharma.repository-source-resolution/v1', organizationId: 'org_fixture',
    workspaceId: '11111111-1111-4111-8111-111111111111',
    repositoryBindingId: '22222222-2222-4222-8222-222222222222',
    repositoryAgentId: '33333333-3333-4333-8333-333333333333',
    policyGenerationId: '44444444-4444-4444-8444-444444444444', policyHash: hash,
    baselineSnapshotHash: hash, localSnapshotHash: hash, publishedFingerprint: hash, publishedInventoryHash: hash,
    createdAt: now.toISOString(), expiresAt: new Date(now.getTime() + 900000).toISOString(),
    conflicts: [{ kind: 'file', path: 'src/taskprocessor.ts', baselineHash: hash, localHash: hash, publishedHash: hash }],
  };
  return { plan, planHash: digest(plan), now };
}
async function fixture(t: TestContext) {
  const workspace = await mkdtemp(resolve(tmpdir(), 'source-resolution-store-'));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  return { workspace, root: resolve(workspace, '.dharma/repository-source/resolutions') };
}

test('plan preparation is immutable and does not activate; activation is explicit and idempotent', async t => {
  const f = await fixture(t), value = proposed();
  assert.equal(await readActiveRepositorySourceResolution(f.workspace), null);
  await saveRepositorySourceResolutionPlan(f.workspace, value);
  await saveRepositorySourceResolutionPlan(f.workspace, value);
  assert.equal(await readActiveRepositorySourceResolution(f.workspace), null);
  assert.deepEqual(await readRepositorySourceResolutionPlan(f.workspace, value.planHash), { plan: value.plan, planHash: value.planHash });
  await activateRepositorySourceResolution(f.workspace, value);
  await activateRepositorySourceResolution(f.workspace, value);
  assert.equal((await readActiveRepositorySourceResolution(f.workspace))?.planHash, value.planHash);
  assert.deepEqual((await readdir(f.root)).sort(), [value.planHash.slice(7) + '.json', 'ACTIVE'].sort());
});

test('store rejects additional fields, path controls, invalid dates, extended lifetime and hash mismatch', async t => {
  const f = await fixture(t), value = proposed();
  const plans = [
    { ...value.plan, credential: 'SYNTHETIC_NOT_A_SECRET' },
    { ...value.plan, createdAt: '2026-02-30T03:00:00.000Z' },
    { ...value.plan, expiresAt: '2026-10-08T03:16:00.000Z' },
    ...['src\\file.ts', 'src/\nfile.ts', 'src/\u0000file.ts', '../outside', '/absolute/file'].map(path => ({ ...value.plan,
      conflicts: [{ ...value.plan.conflicts[0]!, path }] })),
  ];
  for (const plan of plans) {
    await assert.rejects(saveRepositorySourceResolutionPlan(f.workspace, { plan, planHash: digest(plan) }), /plan_invalid/);
  }
  await assert.rejects(saveRepositorySourceResolutionPlan(f.workspace, { ...value, planHash: `sha256:${'b'.repeat(64)}` }), /plan_invalid/);
  assert.equal(await readActiveRepositorySourceResolution(f.workspace), null);
});

test('expired, future-dated, invalid-clock or altered proposals cannot activate', async t => {
  const f = await fixture(t), value = proposed();
  await saveRepositorySourceResolutionPlan(f.workspace, value);
  for (const at of [new Date(now.getTime() - 1), new Date(now.getTime() + 900000), new Date(NaN)]) {
    await assert.rejects(activateRepositorySourceResolution(f.workspace, { ...value, now: at }), /expired_or_invalid/);
  }
  await assert.rejects(activateRepositorySourceResolution(f.workspace, { ...value,
    plan: { ...value.plan, organizationId: 'org_other' } }), /context_changed/);
  assert.equal(await readActiveRepositorySourceResolution(f.workspace), null);
});

test('corrupted, oversized, hard-linked and malformed active files fail closed', async t => {
  const f = await fixture(t), value = proposed();
  await saveRepositorySourceResolutionPlan(f.workspace, value);
  const path = resolve(f.root, value.planHash.slice(7) + '.json');
  await writeFile(path, '{}');
  await assert.rejects(readRepositorySourceResolutionPlan(f.workspace, value.planHash), /plan_invalid/);
  await writeFile(path, Buffer.alloc(1024 * 1024 + 1));
  await assert.rejects(readRepositorySourceResolutionPlan(f.workspace, value.planHash), /file_invalid/);
  await writeFile(path, canonicalize(value.plan));
  await link(path, resolve(f.root, 'extra-link'));
  await assert.rejects(readRepositorySourceResolutionPlan(f.workspace, value.planHash), /file_invalid/);
  await writeFile(resolve(f.root, 'ACTIVE'), '../outside');
  await assert.rejects(readActiveRepositorySourceResolution(f.workspace), /hash_invalid/);
  await writeFile(resolve(f.root, 'ACTIVE'), 'x'.repeat(72));
  await assert.rejects(readActiveRepositorySourceResolution(f.workspace), /file_invalid/);
});

test('resolution directories cannot redirect writes through junctions or symbolic links', async t => {
  const f = await fixture(t), outside = await fixture(t), value = proposed();
  await symlink(outside.workspace, resolve(f.workspace, '.dharma'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(saveRepositorySourceResolutionPlan(f.workspace, value), /path_invalid/);
  assert.deepEqual(await readdir(outside.workspace), []);
});

test('canonical parent aliases are accepted without accepting a symbolic workspace leaf', async t => {
  const f = await fixture(t), value = proposed();
  const physical = resolve(f.workspace, 'physical');
  await mkdir(resolve(physical, 'checkout'), { recursive: true });
  const alias = resolve(f.workspace, 'parent-alias');
  await symlink(physical, alias, process.platform === 'win32' ? 'junction' : 'dir');
  await saveRepositorySourceResolutionPlan(resolve(alias, 'checkout'), value);
  assert.equal((await readRepositorySourceResolutionPlan(resolve(physical, 'checkout'), value.planHash)).planHash, value.planHash);
  const leaf = resolve(f.workspace, 'workspace-alias');
  await symlink(resolve(physical, 'checkout'), leaf, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(saveRepositorySourceResolutionPlan(leaf, value), /path_invalid/);
});

test('an existing plan filename is never overwritten with untrusted bytes', async t => {
  const f = await fixture(t), value = proposed();
  await mkdir(f.root, { recursive: true });
  const path = resolve(f.root, value.planHash.slice(7) + '.json');
  await writeFile(path, 'preserve-existing-invalid-file');
  await assert.rejects(saveRepositorySourceResolutionPlan(f.workspace, value), /EEXIST/);
  assert.equal(await readFile(path, 'utf8'), 'preserve-existing-invalid-file');
});
