import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { observeDemoSource, readDemoSourceBaseline, writeDemoSourceBaseline } from './demoSourceBaseline.js';

const scope = { organizationId: 'org_fixture',
  repositoryId: '10000000-0000-4000-8000-000000000001',
  workspaceId: '40000000-0000-4000-8000-000000000001',
  policyHash: `sha256:${'a'.repeat(64)}` };
const a = `sha256:${'b'.repeat(64)}`;
const b = `sha256:${'c'.repeat(64)}`;
const c = `sha256:${'d'.repeat(64)}`;

test('new member seeds a local baseline and only a stable later edit becomes eligible', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'demo-source-baseline-'));
  const seeded = observeDemoSource({ scope, baseline: null,
    localFingerprint: a, publishedFingerprint: b, now: 1_000 });
  assert.equal(seeded.state, 'seeded');
  await writeDemoSourceBaseline(root, seeded.baseline);
  const stored = await readDemoSourceBaseline(root, scope);
  assert.deepEqual(stored, seeded.baseline);
  const unchanged = observeDemoSource({ scope, baseline: stored,
    localFingerprint: a, publishedFingerprint: b, now: 2_000 });
  assert.equal(unchanged.state, 'unchanged');
  const changed = observeDemoSource({ scope, baseline: unchanged.baseline,
    localFingerprint: c, publishedFingerprint: b, now: 3_000 });
  assert.equal(changed.state, 'debouncing');
  assert.equal(observeDemoSource({ scope, baseline: changed.baseline,
    localFingerprint: c, publishedFingerprint: b, now: 17_999 }).state, 'debouncing');
  assert.equal(observeDemoSource({ scope, baseline: changed.baseline,
    localFingerprint: c, publishedFingerprint: b, now: 18_000 }).state, 'stable');
});

test('a remote release cannot be overwritten by an unchanged or divergent checkout', () => {
  const baseline = observeDemoSource({ scope, baseline: null,
    localFingerprint: a, publishedFingerprint: a, now: 1_000 }).baseline;
  assert.equal(observeDemoSource({ scope, baseline,
    localFingerprint: a, publishedFingerprint: b, now: 2_000 }).state, 'remote_changed');
  const reconciled = observeDemoSource({ scope, baseline,
    localFingerprint: b, publishedFingerprint: b, now: 2_000 });
  assert.equal(reconciled.state, 'remote_reconciled');
  assert.equal(reconciled.baseline.localFingerprint, b);
});

test('a previously submitted initial source anchors the first published release', () => {
  const baseline = { ...scope, schema: 'dharma.demo-source-baseline/v1' as const,
    localFingerprint: a, publishedFingerprint: null,
    pendingFingerprint: null, firstObservedAt: null };
  const observed = observeDemoSource({ scope, baseline,
    localFingerprint: b, publishedFingerprint: a, now: 1_000 });
  assert.equal(observed.state, 'debouncing');
  assert.equal(observed.baseline.publishedFingerprint, a);
});

test('baseline storage does not follow a symlink or accept foreign scope', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'demo-source-symlink-'));
  const baseline = observeDemoSource({ scope, baseline: null,
    localFingerprint: a, publishedFingerprint: a, now: 1_000 }).baseline;
  await writeDemoSourceBaseline(root, baseline);
  assert.equal(await readDemoSourceBaseline(root, { ...scope,
    repositoryId: '10000000-0000-4000-8000-000000000002' }), null);
  const path = resolve(root, 'demo-source-baselines', scope.organizationId,
    scope.repositoryId, `${scope.workspaceId}.json`);
  assert.equal((await readFile(path, 'utf8')).includes('grant'), false);
  await writeFile(path, JSON.stringify({ ...baseline,
    repositoryId: '10000000-0000-4000-8000-000000000002' }));
  await assert.rejects(readDemoSourceBaseline(root, scope), /invalid/);
  await writeDemoSourceBaseline(root, baseline);
  const linkedRoot = await mkdtemp(resolve(tmpdir(), 'demo-source-link-'));
  const linkedPath = resolve(linkedRoot, 'demo-source-baselines', scope.organizationId,
    scope.repositoryId, `${scope.workspaceId}.json`);
  await mkdir(dirname(linkedPath), { recursive: true });
  await symlink(path, linkedPath);
  await assert.rejects(readDemoSourceBaseline(linkedRoot, scope), /ELOOP|symlink/);
});
