import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import test, { type TestContext } from 'node:test';
import { canonicalize } from '@dharma-ai-labs/agent-fabric-contracts';
import { initializeRepositoryKnowledge } from './repositoryKnowledge.js';
import { readRepositoryPackageSnapshot } from './repositoryPackage.js';
import { BlockedRepositorySourceRetry, fetchRepositorySourceAuthorization, RepositorySourceWatcher, scanRepositorySourceChanges } from './repositorySourceSync.js';

const scope = { organizationId: 'org_source_sync_fixture', workspaceId: '056b63dc-ebed-48ed-85d8-02c72f623ea8',
  repositoryBindingId: '73a95988-fd64-41ba-a0b9-6c8867d03788', repositoryAgentId: '57f61652-a5eb-46e4-930c-9478cd4a9c31' };
const A = `sha256:${'a'.repeat(64)}`, B = `sha256:${'b'.repeat(64)}`;
function response() {
  const generation = '1a731db0-d1bb-469c-8ffd-e1f10bece914';
  const policy = { action: 'authorize', confirmed: true, requestId: '5ff2ee1b-6cb3-459e-a977-ea99c757bf30',
    repositoryBindingId: scope.repositoryBindingId, expectedRevision: 0,
    allowedContentClasses: ['approved_outputs', 'repository_content', 'repository_skills'],
    approvedRepositoryPaths: ['README.md', 'docs'], approvedOutputFolders: ['output/approved'],
    automaticValidatedPublication: true, retentionDays: 30, maximumFileBytes: 262144,
    maximumSnapshotBytes: 4194304, maximumDailyUploadBytes: 8388608, expiresAt: null as string | null };
  return { ok: true, organizationId: scope.organizationId, policy: {
    organizationId: scope.organizationId, repositoryBindingId: scope.repositoryBindingId, repositoryAgentId: scope.repositoryAgentId,
    current: { active: true, reason: 'authorized', revision: 1, generationId: generation,
      receiptId: `repo_consent_${generation}`, policyRevision: `repository-source-${generation}`,
      confirmedAt: '2020-01-01T00:00:00+00:00', policy,
      policyHash: `sha256:${createHash('sha256').update(canonicalize(policy)).digest('hex')}` } } };
}
async function fixture(t: TestContext) {
  const workspace = await mkdtemp(resolve(tmpdir(), 'repository-source-sync-'));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const put = async (path: string, text: string) => {
    await mkdir(dirname(resolve(workspace, path)), { recursive: true });
    await writeFile(resolve(workspace, path), text);
  };
  await put('.agents/skills/dharma-agent-fabric/.dharma-agent-fabric.json',
    JSON.stringify({ managedBy: 'dharma-agent-fabric', workspaceId: scope.workspaceId }));
  await initializeRepositoryKnowledge({ ...scope, workspace });
  await put('README.md', '# Shared repository');
  await put('.codex/skills/review/SKILL.md', '# Review');
  const watcher = new RepositorySourceWatcher(1000);
  let now = 0;
  const calls: string[] = [];
  let view = response();
  const transport = { signedGet: async (route: string) => { calls.push(route); return structuredClone(view); } };
  const input = { ...scope, workspace, watcher, transport, monotonicNow: () => now };
  return { input, put, calls, setNow: (value: number) => { now = value; }, setView: (value: ReturnType<typeof response>) => { view = value; } };
}

test('source policy fetch uses the enrolled signed GET and the bound workspace', async () => {
  const routes: string[] = [];
  const result = await fetchRepositorySourceAuthorization({ signedGet: async route => { routes.push(route); return response(); } }, scope);
  assert.deepEqual(routes, [`/agent-fabric/repository-source-policy?workspaceId=${scope.workspaceId}`]);
  assert.equal(result.repositoryBindingId, scope.repositoryBindingId);
  assert.equal(result.repositoryAgentId, scope.repositoryAgentId);
});
test('an incomplete repository identity cannot dispatch a source-policy read', async () => {
  let calls = 0;
  await assert.rejects(fetchRepositorySourceAuthorization({ signedGet: async () => { calls++; return response(); } },
    { ...scope, repositoryBindingId: '' }), /complete bound identity/);
  assert.equal(calls, 0);
});
test('source policy fetch rejects a foreign repository binding', async () => {
  const view = response(); view.policy.repositoryBindingId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  await assert.rejects(fetchRepositorySourceAuthorization({ signedGet: async () => view }, scope), /foreign|scope/);
});
test('source policy fetch rejects inactive or revoked grants rather than falling back', async () => {
  const view = response(); view.policy.current.active = false; view.policy.current.reason = 'revoked';
  await assert.rejects(fetchRepositorySourceAuthorization({ signedGet: async () => view }, scope), /inactive/);
});
test('source policy fetch rejects an expired current grant', async () => {
  const view = response(); view.policy.current.policy.expiresAt = '2021-01-01T00:00:00.000Z';
  view.policy.current.policyHash = `sha256:${createHash('sha256').update(canonicalize(view.policy.current.policy)).digest('hex')}`;
  await assert.rejects(fetchRepositorySourceAuthorization({ signedGet: async () => view }, scope), /expired/);
});
test('source policy fetch propagates transport failure without an unsigned fallback', async () => {
  const failure = new Error('fixture_offline');
  await assert.rejects(fetchRepositorySourceAuthorization({ signedGet: async () => { throw failure; } }, scope), failure);
});
test('watcher requires a stable debounce and suppresses completed fingerprints', () => {
  const watcher = new RepositorySourceWatcher(1000);
  assert.equal(watcher.observe(A, 0), 'debouncing');
  assert.throws(() => watcher.complete(A), /conflicts/);
  assert.equal(watcher.observe(A, 999), 'debouncing');
  assert.equal(watcher.observe(A, 1000), 'stable');
  watcher.complete(A);
  assert.equal(watcher.observe(A, 2000), 'unchanged');
  assert.equal(watcher.observe(B, 2001), 'debouncing');
});
test('watcher resumes from an integrity-checked persisted source fingerprint', () => {
  const watcher = new RepositorySourceWatcher(1000);
  watcher.seed(A);
  assert.equal(watcher.observe(A, 0), 'unchanged');
  assert.equal(watcher.observe(B, 1), 'debouncing');
  assert.equal(watcher.observe(B, 1001), 'stable');
  assert.throws(() => watcher.seed(A), /Invalid repository source baseline/);
  assert.throws(() => new RepositorySourceWatcher(1000).seed('unverified'), /Invalid repository source baseline/);
});
test('blocked source retries once only after a distinct verified knowledge release is installed', () => {
  const gate = new BlockedRepositorySourceRetry();
  const local = { authority: 'locally_initialized_unsigned' as const };
  const first = { catalogBytes: Buffer.from('signed catalog 1'), manifestBytes: Buffer.from('signed manifest 1') };
  const second = { catalogBytes: Buffer.from('signed catalog 2'), manifestBytes: Buffer.from('signed manifest 2') };
  assert.equal(gate.consider('candidate-a', local, null), false);
  assert.equal(gate.consider('candidate-a', local, first), true);
  assert.equal(gate.consider('candidate-a', local, first), false);
  const retained = { authority: 'unverified_prior_release_reference' as const, priorRelease: {
    catalogHash: `sha256:${createHash('sha256').update(first.catalogBytes).digest('hex')}`,
    manifestHash: `sha256:${createHash('sha256').update(first.manifestBytes).digest('hex')}`,
  } };
  assert.equal(gate.consider('candidate-b', retained, first), false);
  assert.equal(gate.consider('candidate-b', retained, second), true);
  assert.equal(gate.consider('candidate-b', retained, second), false);
  assert.equal(gate.consider('candidate-c', retained, second), true);
});
test('changing content restarts debounce and rejects stale completion', () => {
  const watcher = new RepositorySourceWatcher(1000);
  watcher.observe(A, 0); watcher.observe(B, 999);
  assert.equal(watcher.observe(B, 1000), 'debouncing');
  assert.throws(() => watcher.complete(A), /conflicts/);
  assert.equal(watcher.observe(B, 1999), 'stable');
});
test('invalid fingerprints and backwards clocks reset watcher state', () => {
  const watcher = new RepositorySourceWatcher(1000);
  watcher.observe(A, 1000);
  assert.throws(() => watcher.observe(A, 999), /Invalid/);
  assert.equal(watcher.observe(A, 0), 'debouncing');
  assert.throws(() => watcher.observe(`${A}\n`, 1), /Invalid/);
  assert.throws(() => new RepositorySourceWatcher(0), /Invalid/);
});
test('relay source scan captures real approved sources only after stable observations', async t => {
  const f = await fixture(t);
  await f.put('output/approved/report.md', 'Canonical term: evidence ledger.');
  assert.equal((await scanRepositorySourceChanges(f.input)).state, 'debouncing');
  await assert.rejects(readFile(resolve(f.input.workspace, '.agents/skills/dharma-agent-fabric/MANIFEST.json')), /ENOENT/);
  f.setNow(1000);
  const collected = await scanRepositorySourceChanges(f.input);
  assert.equal(collected.state, 'local_candidate_collected');
  assert.equal(collected.sharedAuthority, 'pending');
  assert.equal(collected.localMutation, true);
  assert.equal(f.calls.length, 3);
  assert.ok(collected.persisted);
  assert.equal(collected.persisted.disposition, 'candidate_only');
  assert.equal(collected.persisted.managedCopiesPath, null);
  await assert.rejects(readFile(resolve(f.input.workspace, '.agents/skills/dharma-agent-fabric/MANIFEST.json')), /ENOENT/);
  const manifest = JSON.parse(await readFile(resolve(f.input.workspace, collected.persisted.manifestPath), 'utf8'));
  assert.equal(manifest.schema, 'dharma.repository-package/v2');
  assert.ok(manifest.knowledge);
  assert.ok(manifest.files.some((file: { path: string }) => file.path === 'output/approved/report.md'));
  f.setNow(2000);
  assert.equal((await scanRepositorySourceChanges(f.input)).state, 'unchanged');
});
test('a restarted relay does not submit unchanged source from its persisted snapshot', async t => {
  const f = await fixture(t);
  await scanRepositorySourceChanges(f.input);
  f.setNow(1000);
  const collected = await scanRepositorySourceChanges(f.input);
  assert.ok(collected.persisted);
  const previous = await readRepositoryPackageSnapshot(f.input.workspace, collected.persisted.snapshotHash);
  const restarted = new RepositorySourceWatcher(1000);
  restarted.seed(previous.manifest.sourceFingerprint!);
  let submissions = 0;
  const result = await scanRepositorySourceChanges({ ...f.input, watcher: restarted,
    submitCandidate: async () => { submissions++; return { state: 'accepted' }; } });
  assert.equal(result.state, 'unchanged');
  assert.equal(submissions, 0);
  await f.put('README.md', '# Shared repository\n\nNew approved source.');
  f.setNow(2000);
  assert.equal((await scanRepositorySourceChanges({ ...f.input, watcher: restarted })).state, 'debouncing');
});
test('candidate submission must succeed before a source fingerprint is completed', async t => {
  const f = await fixture(t);
  let submissions = 0;
  const input = { ...f.input, submitCandidate: async () => {
    submissions += 1;
    if (submissions === 1) throw new Error('candidate unavailable');
    return { state: 'accepted' };
  } };
  await scanRepositorySourceChanges(input); f.setNow(1000);
  await assert.rejects(scanRepositorySourceChanges(input), /candidate unavailable/);
  f.setNow(2000);
  assert.equal((await scanRepositorySourceChanges(input)).state, 'debouncing');
  f.setNow(3000);
  assert.equal((await scanRepositorySourceChanges(input)).state, 'local_candidate_collected');
  assert.equal(submissions, 2);
});
test('an uncommitted report edit is collected autonomously on later scans', async t => {
  const f = await fixture(t);
  await f.put('output/approved/report.md', 'First observation.');
  await scanRepositorySourceChanges(f.input); f.setNow(1000);
  const first = await scanRepositorySourceChanges(f.input);
  await f.put('output/approved/report.md', 'Second observation.'); f.setNow(2000);
  assert.equal((await scanRepositorySourceChanges(f.input)).state, 'debouncing');
  f.setNow(3000);
  const second = await scanRepositorySourceChanges(f.input);
  assert.notEqual(first.snapshotId, second.snapshotId);
});
test('revoked source permission prevents local capture and resets previous debounce', async t => {
  const f = await fixture(t);
  await scanRepositorySourceChanges(f.input);
  const revoked = response(); revoked.policy.current.active = false; revoked.policy.current.reason = 'revoked';
  f.setView(revoked); f.setNow(1000);
  await assert.rejects(scanRepositorySourceChanges(f.input), /inactive/);
  f.setView(response()); f.setNow(2000);
  assert.equal((await scanRepositorySourceChanges(f.input)).state, 'debouncing');
  await assert.rejects(readFile(resolve(f.input.workspace, '.agents/skills/dharma-agent-fabric/MANIFEST.json')), /ENOENT/);
});
test('permission change between collection and local persistence fails closed', async t => {
  const f = await fixture(t);
  await scanRepositorySourceChanges(f.input); f.setNow(1000);
  let calls = 0;
  const transport = { signedGet: async () => {
    const view = response();
    if (++calls === 2) {
      view.policy.current.policy.retentionDays = 31;
      view.policy.current.policyHash = `sha256:${createHash('sha256').update(canonicalize(view.policy.current.policy)).digest('hex')}`;
    }
    return view;
  } };
  await assert.rejects(scanRepositorySourceChanges({ ...f.input, transport }), /changed during collection/);
  await assert.rejects(readFile(resolve(f.input.workspace, '.agents/skills/dharma-agent-fabric/MANIFEST.json')), /ENOENT/);
});
test('unsupported secret files stay excluded in relay collection', async t => {
  const f = await fixture(t);
  await f.put('docs/.env.local', 'AUTH_TOKEN=secret_fixture');
  await scanRepositorySourceChanges(f.input); f.setNow(1000);
  const collected = await scanRepositorySourceChanges(f.input);
  assert.ok(collected.persisted);
  const manifest = JSON.parse(await readFile(resolve(f.input.workspace, collected.persisted.manifestPath), 'utf8'));
  assert.equal(manifest.files.some((file: { path: string }) => file.path.includes('.env')), false);
});

test('expiry during the second signed GET prevents persistence of a local candidate', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2030-01-01T00:00:00.000Z') });
  const f = await fixture(t);
  const view = response();
  view.policy.current.policy.expiresAt = '2030-01-01T00:00:00.500Z';
  view.policy.current.policyHash = `sha256:${createHash('sha256').update(canonicalize(view.policy.current.policy)).digest('hex')}`;
  let reads = 0;
  const transport = { signedGet: async () => {
    if (++reads === 3) t.mock.timers.tick(1000);
    return structuredClone(view);
  } };
  const input = { ...f.input, transport };
  assert.equal((await scanRepositorySourceChanges(input)).state, 'debouncing');
  f.setNow(1000);
  await assert.rejects(scanRepositorySourceChanges(input), /expired/);
  await assert.rejects(readFile(resolve(f.input.workspace, '.agents/skills/dharma-agent-fabric/MANIFEST.json')), /ENOENT/);
});
