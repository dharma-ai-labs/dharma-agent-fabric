import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { canonicalEndpointRole, canonicalRepositoryPackage, canonicalRepositoryPackagePolicyGeneration,
  repositoryPackageNeedsPolicyRefresh } from './index.js';

const ids = {
  candidateId: '77f61652-a5eb-46e4-930c-9478cd4a9c31',
  releaseId: '87f61652-a5eb-46e4-930c-9478cd4a9c31',
};

test('repository connect package state distinguishes unseen and published canonical repositories', () => {
  assert.deepEqual(canonicalRepositoryPackage({ state: 'absent', candidateId: null, operationId: null,
    snapshotHash: null, sourceManifestHash: null, releaseId: null, generation: 0, consolidationMode: null }), {
    state: 'absent', candidateId: null, operationId: null, snapshotHash: null, sourceManifestHash: null,
    releaseId: null, generation: 0, consolidationMode: null,
  });
  const published = { state: 'published', candidateId: ids.candidateId, operationId: `sha256:${'a'.repeat(64)}`,
    snapshotHash: `sha256:${'b'.repeat(64)}`, sourceManifestHash: `sha256:${'c'.repeat(64)}`,
    releaseId: ids.releaseId, generation: 4, consolidationMode: 'initial_repository' };
  assert.deepEqual(canonicalRepositoryPackage(published), published);
  assert.throws(() => canonicalRepositoryPackage({ ...published, releaseId: null }), /inconsistent/);
  const withGeneration = { ...published, sourcePolicyGenerationId: ids.candidateId };
  assert.deepEqual(canonicalRepositoryPackage(withGeneration), withGeneration);
  assert.throws(() => canonicalRepositoryPackage({ ...withGeneration, sourcePolicyGenerationId: 'wrong' }), /invalid/);
});

test('onboarding refreshes a published package only after its source policy generation changes', () => {
  const published = canonicalRepositoryPackage({ state: 'published', candidateId: ids.candidateId,
    operationId: `sha256:${'a'.repeat(64)}`, snapshotHash: `sha256:${'b'.repeat(64)}`,
    sourceManifestHash: `sha256:${'c'.repeat(64)}`, releaseId: ids.releaseId,
    generation: 4, consolidationMode: 'repository_update', sourcePolicyGenerationId: ids.candidateId });
  assert.equal(repositoryPackageNeedsPolicyRefresh(published, ids.candidateId), false);
  assert.equal(repositoryPackageNeedsPolicyRefresh(published, ids.releaseId), true);
  assert.equal(repositoryPackageNeedsPolicyRefresh({ ...published, sourcePolicyGenerationId: undefined }, ids.releaseId), false);
});

test('package policy generation is a separately validated backward-compatible connect hint', () => {
  assert.equal(canonicalRepositoryPackagePolicyGeneration(ids.candidateId), ids.candidateId);
  assert.equal(canonicalRepositoryPackagePolicyGeneration(null), null);
  assert.equal(canonicalRepositoryPackagePolicyGeneration(undefined), undefined);
  assert.throws(() => canonicalRepositoryPackagePolicyGeneration('wrong'), /invalid/);
});

test('repository connect endpoint role state is exact and revisioned', () => {
  assert.equal(canonicalEndpointRole(null), null);
  assert.deepEqual(canonicalEndpointRole({ revision: 2, profileHash: `sha256:${'d'.repeat(64)}` }),
    { revision: 2, profileHash: `sha256:${'d'.repeat(64)}` });
  assert.throws(() => canonicalEndpointRole({ revision: 0, profileHash: `sha256:${'d'.repeat(64)}` }), /invalid/);
});

test('one prompt submits initial knowledge only for an absent package and derives a role without flags', async () => {
  const source = await readFile(new URL('../src/index.ts', import.meta.url), 'utf8');
  const onboard = source.slice(source.indexOf('async function onboard('), source.indexOf('async function evidenceSync('));
  assert.match(onboard, /canonicalPackage\.state === 'absent'/);
  assert.match(onboard, /canonicalPackage\.state === 'absent' \|\| refreshPolicy/);
  assert.match(onboard, /snapshot: initialSnapshot, initialRepository: canonicalPackage\.state === 'absent'/);
  assert.match(onboard, /: await adoptRepositoryCandidate\(/);
  assert.match(onboard, /const derivedRole = deriveRepositoryRole\(/);
  assert.match(onboard, /const roleInput = roleRequested \?/);
  assert.match(onboard, /registerRepositoryRoleMetadata\(/);
  assert.ok(onboard.indexOf('evidencePreview(onboardingEvidenceFlags)') < onboard.indexOf('synchronizeRepositoryCandidate('));
  assert.ok(onboard.indexOf('capture(onboardingEvidenceFlags, true)') < onboard.indexOf('synchronizeRepositoryCandidate('));
  assert.ok(onboard.indexOf('synchronizeRepositoryCandidate(') < onboard.indexOf('startRelayDaemon('));
});

test('relay polls candidate state independently and activates only after an idle task boundary', async () => {
  const source = await readFile(new URL('../src/index.ts', import.meta.url), 'utf8');
  const relay = source.slice(source.indexOf('async function relayStart('), source.indexOf('export async function run('));
  assert.match(relay, /await pollRepositoryCandidate\(/);
  assert.ok(relay.indexOf('await pollRepositoryCandidate(') < relay.indexOf('scanRepositorySourceChanges('));
  assert.ok(relay.indexOf('const result = await executeOneTask(') < relay.indexOf('await takeCachedSkillUpdate('));
  assert.match(relay, /if \(!result\.taskId && performance\.now\(\) >= nextSkillActivationAt\)/);
});
