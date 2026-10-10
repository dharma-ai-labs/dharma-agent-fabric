import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const source = '68d61b4b8f5b96cc57e2df2d5acfd856282020ec';
const tree = 'd80a643d2eedcacab3ffd0612fd9c8ee9af82389';
const repository = 'https://github.com/dharma-ai-labs/dharma-agent-fabric';
export const approvedPackages = Object.freeze([
  { workspace: 'packages/contracts', name: '@dharma-ai-labs/agent-fabric-contracts', version: '0.1.15' },
  { workspace: 'packages/secure-store', name: '@dharma-ai-labs/agent-fabric-secure-store', version: '0.1.9' },
  { workspace: 'packages/relay-client', name: '@dharma-ai-labs/agent-fabric-relay-client', version: '0.2.32' },
  { workspace: 'packages/cli', name: '@dharma-ai-labs/agent-fabric', version: '0.2.179' },
].map(Object.freeze));

function assertArtifact(item, packed, metadata) {
  assert.equal(metadata.name, item.name, 'registry name mismatch');
  assert.equal(metadata.version, item.version, 'registry version mismatch');
  assert.equal(metadata.dist?.integrity, packed.integrity, 'existing artifact integrity mismatch');
  const url = new URL(metadata.dist?.attestations?.url);
  assert.equal(url.origin, 'https://registry.npmjs.org', 'unexpected attestation origin');
  assert.ok(url.pathname.startsWith('/-/npm/v1/attestations/'), 'unexpected attestation path');
}

export async function publishBoundedRelease(expectedHead, io) {
  assert.match(expectedHead || '', /^[a-f0-9]{40}$/, 'explicit reviewed main SHA required');
  await io.verifySource(expectedHead);
  const prepared = [];
  // Validate every selected release before the first externally visible write.
  for (const item of approvedPackages) {
    const manifest = await io.manifest(item);
    assert.equal(manifest.name, item.name, 'approved package name mismatch');
    assert.equal(manifest.version, item.version, 'approved package version mismatch');
    const packed = await io.pack(item);
    const existing = await io.lookup(item);
    if (existing) {
      assertArtifact(item, packed, existing);
      await io.verifyPublished(item, packed, existing, expectedHead);
    }
    prepared.push({ item, packed, existing });
  }
  for (const { item, packed, existing } of prepared) {
    if (existing) continue;
    await io.publish(item, packed);
    const metadata = await io.lookup(item, true);
    assert.ok(metadata, 'published artifact not visible; reconcile before another attempt');
    assertArtifact(item, packed, metadata);
    await io.verifyPublished(item, packed, metadata, expectedHead);
  }
}

export function assertSourceSnapshot(expectedHead, snapshot) {
  assert.equal(snapshot.head, expectedHead, 'dispatched source mismatch');
  assert.equal(snapshot.ref, 'refs/heads/main', 'main-only publication');
  assert.equal(snapshot.tree, tree, 'approved source tree mismatch');
  assert.equal(snapshot.dirty, '', 'tracked source is dirty');
  assert.equal(snapshot.lifecycleLauncher,
    '100755 blob c7a500e580923098dff6121e1bf13a01f19b9b9d\tpackages/lifecycle-adapter/bin/run.mjs',
    'reviewed launcher bytes and executable mode required');
  const allowed = new Set(['.github/workflows/publish.yml', 'package.json',
    'scripts/publish-workflow.test.mjs', 'scripts/publish-onboarding-release.mjs',
    'scripts/publish-onboarding-release.test.mjs', 'packages/lifecycle-adapter/bin/run.mjs']);
  assert.ok(snapshot.changed.every((file) => allowed.has(file)), 'unreviewed product source delta');
  assert.ok(snapshot.untracked.every((file) => file.startsWith('release/')), 'unexpected untracked source');
  const baseline = structuredClone(snapshot.baselineManifest);
  baseline.scripts['pack:verify'] = 'node --test scripts/publish-workflow.test.mjs scripts/publish-onboarding-release.test.mjs scripts/verify-package-pins.test.mjs && node scripts/verify-package.mjs';
  baseline.scripts['publish:onboarding'] = 'node scripts/publish-onboarding-release.mjs';
  assert.deepEqual(snapshot.manifest, baseline, 'unreviewed root manifest delta');
}

async function publicGet(url, json = true) {
  const target = new URL(url);
  assert.equal(target.origin, 'https://registry.npmjs.org', 'unexpected registry origin');
  const response = await fetch(target, { redirect: 'error', signal: AbortSignal.timeout(30_000) });
  if (response.status === 404) return null;
  assert.ok(response.ok, `registry HTTP ${response.status}`);
  return json ? response.json() : Buffer.from(await response.arrayBuffer());
}

export function assertProvenance(item, packed, attestations, expectedHead) {
  const statements = attestations.attestations.map((entry) =>
    JSON.parse(Buffer.from(entry.bundle.dsseEnvelope.payload, 'base64').toString('utf8')));
  const statement = statements.find((entry) => entry.predicateType === 'https://slsa.dev/provenance/v1');
  assert.ok(statement, 'published provenance missing');
  const definition = statement.predicate.buildDefinition;
  assert.deepEqual(definition.externalParameters.workflow, {
    ref: 'refs/heads/main', repository, path: '.github/workflows/publish.yml',
  }, 'publisher workflow mismatch');
  assert.ok(definition.resolvedDependencies.some((entry) => entry.digest?.gitCommit === expectedHead
    && entry.uri === `git+${repository}@refs/heads/main`), 'publisher source mismatch');
  const digest = Buffer.from(packed.integrity.replace(/^sha512-/, ''), 'base64').toString('hex');
  assert.ok(statement.subject.some((entry) => entry.name === `pkg:npm/${item.name.replace('@', '%40')}@${item.version}`
    && entry.digest.sha512 === digest), 'provenance subject mismatch');
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const root = resolve(import.meta.dirname, '..');
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  const npm = (...args) => execFileSync(process.execPath, [process.env.npm_execpath, ...args], {
    cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120_000,
  }).trim();
  assert.ok(process.env.npm_execpath, 'invoke through npm exec');
  const directory = mkdtempSync(join(tmpdir(), 'dharma-approved-release-'));
  const expectedHead = process.argv[process.argv.indexOf('--expected-head') + 1];
  await publishBoundedRelease(expectedHead, {
    verifySource: async (expected) => {
      git('merge-base', '--is-ancestor', source, 'HEAD');
      assertSourceSnapshot(expected, {
        head: git('rev-parse', 'HEAD'), ref: process.env.GITHUB_REF,
        tree: git('rev-parse', `${source}^{tree}`), dirty: git('status', '--porcelain', '--untracked-files=no'),
        lifecycleLauncher: git('ls-tree', 'HEAD', 'packages/lifecycle-adapter/bin/run.mjs'),
        changed: git('diff', '--name-only', source, 'HEAD').split('\n').filter(Boolean),
        untracked: git('ls-files', '--others', '--exclude-standard').split('\n').filter(Boolean),
        baselineManifest: JSON.parse(git('show', `${source}:package.json`)),
        manifest: JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')),
      });
    },
    manifest: async (item) => JSON.parse(readFileSync(join(root, item.workspace, 'package.json'), 'utf8')),
    pack: async (item) => JSON.parse(npm('pack', '--workspace', item.workspace, '--json', '--pack-destination', directory))[0],
    lookup: async (item, justPublished = false) => {
      for (let attempt = 0; attempt < (justPublished ? 5 : 1); attempt++) {
        const metadata = await publicGet(`https://registry.npmjs.org/${encodeURIComponent(item.name)}/${item.version}`);
        if (metadata) return metadata;
        if (justPublished) await new Promise((resolve) => setTimeout(resolve, 1000 * (attempt + 1)));
      }
      return null;
    },
    publish: async (item, packed) => {
      console.log(`Publishing approved ${item.name}@${item.version} ${packed.integrity}`);
      console.log(npm('publish', join(directory, packed.filename), '--access', 'public', '--tag', 'latest', '--provenance'));
    },
    verifyPublished: async (item, packed, metadata, expected) => {
      const bytes = await publicGet(metadata.dist.tarball, false);
      assert.ok(bytes, 'published tarball missing');
      assert.equal(`sha512-${createHash('sha512').update(bytes).digest('base64')}`, packed.integrity, 'tarball integrity mismatch');
      assertProvenance(item, packed, await publicGet(metadata.dist.attestations.url), expected);
      console.log(`Verified ${item.name}@${item.version} integrity and publisher source ${expected}`);
    },
  });
}
