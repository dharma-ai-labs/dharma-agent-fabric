import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const freeze = value => {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
};
export const preservedEvidenceProvider = freeze(JSON.parse(readFileSync(
  new URL('./preserved-evidence-provider-0.1.37.json', import.meta.url), 'utf8')));
const stable = value => Array.isArray(value) ? value.map(stable) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])) : value;
export const packageManifestHash = value => createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');

export function assertPreservedEvidenceManifest(manifest) {
  const expected = preservedEvidenceProvider.evidence;
  assert.equal(manifest.name, expected.name, 'preserved_evidence_name');
  assert.equal(manifest.version, expected.version, 'preserved_evidence_version');
  assert.equal(packageManifestHash(manifest), expected.manifestSha256, 'preserved_evidence_manifest');
}

// One immutable artifact edge, not an exemption for arbitrary old dependencies.
export function assertPreservedEvidenceProvider(input) {
  const expected = preservedEvidenceProvider;
  assert.equal(input.cliVersion, expected.newCohort.cli, 'preserved_provider_cli_cohort');
  assert.equal(input.providerVersion, expected.newCohort.provider, 'preserved_provider_current_cohort');
  assert.equal(input.taskRunnerVersion, expected.newCohort.taskRunner, 'preserved_provider_task_cohort');
  assert.equal(input.relayClientVersion, expected.newCohort.relayClient, 'preserved_provider_relay_cohort');
  assertPreservedEvidenceManifest(input.evidenceManifest);
  assert.equal(input.sourceTree, expected.evidence.sourceTree, 'preserved_evidence_source_tree');
  assert.equal(input.worktreeChanges, '', 'preserved_evidence_worktree_changes');
  assert.equal(input.untracked, '', 'preserved_evidence_untracked_source');
  const locked = input.lockEntry;
  assert.ok(locked && locked.link !== true, 'preserved_provider_registry_artifact_required');
  for (const key of ['version', 'resolved', 'integrity']) assert.equal(locked[key], expected.provider[key], `preserved_provider_lock_${key}`);
  assert.equal(input.installedManifest.name, expected.provider.name, 'preserved_provider_installed_name');
  assert.equal(input.installedManifest.version, expected.provider.version, 'preserved_provider_installed_version');
  assert.equal(packageManifestHash(input.installedManifest), expected.provider.manifestSha256, 'preserved_provider_installed_manifest');
  assert.deepEqual(input.runtimeHashes, expected.provider.runtimeHashes, 'preserved_provider_installed_runtime');
}
