import assert from 'node:assert/strict';
import test from 'node:test';
import { deriveRepositoryRole } from './repositoryRoleDerivation.js';
import type { RepositoryPackageSnapshot } from './repositoryPackage.js';

function fixture(name = 'security-audit') {
  const text = `---\nname: ${name}\ndescription: fixture\n---\n`;
  return {
    schema: 'dharma.repository-package-snapshot/v1', capturedAt: '2030-01-01T00:00:00.000Z',
    manifest: { schema: 'dharma.repository-package/v1', organizationId: 'org_fixture', workspaceId: 'fixture',
      snapshotId: 'fixture', snapshotHash: `sha256:${'a'.repeat(64)}`, authority: 'local_inventory_not_signed',
      roots: ['.agents/skills'], files: [{ path: `.agents/skills/${name}/SKILL.md`, role: 'skill',
        sha256: `sha256:${'b'.repeat(64)}`, sizeBytes: Buffer.byteLength(text) }],
      skills: [{ path: `.agents/skills/${name}`, providerRoot: '.agents/skills',
        entryPath: `.agents/skills/${name}/SKILL.md`, filePaths: [`.agents/skills/${name}/SKILL.md`],
        contentHash: `sha256:${'c'.repeat(64)}`, availability: 'available',
        observation: { state: 'not_observed', authority: 'caller_supplied_not_runtime_verified', references: [] } }],
      exclusions: [] }, blobs: [{ sha256: `sha256:${'b'.repeat(64)}`, contentBase64: Buffer.from(text).toString('base64') }],
  } as RepositoryPackageSnapshot;
}

test('repository role derives bounded categories from skill identity and provider', () => {
  assert.deepEqual(deriveRepositoryRole({ snapshot: fixture(), providers: ['codex'] }), {
    roleName: 'Codex Repository Maintainer',
    questionCategories: ['codex-implementation', 'documentation', 'repository-maintenance', 'security-review', 'verification'],
    description: 'Maintains this canonical repository using 2 captured repository skill identities; routes bounded questions through signed Agent Fabric tasks.',
  });
});

test('repository role has deterministic safe fallbacks without repository skills', () => {
  const snapshot = fixture();
  snapshot.manifest.skills = [];
  snapshot.manifest.files = [];
  snapshot.blobs = [];
  assert.deepEqual(deriveRepositoryRole({ snapshot, providers: ['hermes', 'claude', 'claude'] }).questionCategories,
    ['claude-implementation', 'documentation', 'hermes-implementation', 'repository-maintenance']);
});
