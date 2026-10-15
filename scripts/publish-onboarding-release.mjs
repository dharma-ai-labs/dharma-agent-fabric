import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const source = 'c45261f9bf28b7f19ffece0b1d50e88dd1048990';
const tree = '77586a4cde50a6fcaf632ab73abcf01c30b0b6db';
const repository = 'https://github.com/dharma-ai-labs/dharma-agent-fabric';
export const approvedPackages = Object.freeze([
  { workspace: 'packages/contracts', name: '@dharma-ai-labs/agent-fabric-contracts', version: '0.1.16',
    existingArtifact: Object.freeze({source: '6c7d48916de11ccc837933a7ef7e8d2600184b54',
      integrity: 'sha512-ccumvrKW2MRxVobFxpmEYXzOdY7syggdPswC8BBuuLnnjSvOUz0tYtwZEaF7n1A4RK6yNuttmavZ/rCV5smtMQ=='}) },
  { workspace: 'packages/provider-adapters', name: '@dharma-ai-labs/agent-fabric-provider-adapters', version: '0.1.34',
    existingArtifact: Object.freeze({source: 'd67f9218e9073875cbbff262174b62e3d629902c',
      integrity: 'sha512-J7YNsv+3iBbRTNL/6m4aBVPv2NTFzR/u3svpruDU1tA/wXePxynPHm6yevocqfTBnDcjeJ6VyZRj0+bvJ1k+0Q=='}) },
  { workspace: 'packages/task-runner', name: '@dharma-ai-labs/agent-fabric-task-runner', version: '0.1.36',
    existingArtifact: Object.freeze({source: 'd67f9218e9073875cbbff262174b62e3d629902c',
      integrity: 'sha512-OA5j8f/gxaXDn4cWiUwgoW+hCK+5DBPI8jtptPjiZBtT1VfSWjnkIh6Iitb4bvcPUYsCdLiCAjecB26ebcHexA=='}) },
  { workspace: 'packages/evidence-reduction', name: '@dharma-ai-labs/agent-fabric-evidence-reduction', version: '0.2.33',
    existingArtifact: Object.freeze({source: 'd67f9218e9073875cbbff262174b62e3d629902c',
      integrity: 'sha512-uJOnIe/zkiUCLxPXt4R1TUlULp8yUheD1V5jg1XHRYVDzD+xMxxETmwGR0z/8YVndR0sYxSfxt8wZi6jsweGYA=='}) },
  { workspace: 'packages/local-vault', name: '@dharma-ai-labs/agent-fabric-local-vault', version: '0.1.29',
    existingArtifact: Object.freeze({source: 'bbaeecb75a3139c6a5b65b6dc0cd351fb10b872d',
      integrity: 'sha512-h2Bq42d9cbGFiJzXjffI3fGoGnXEsJvmlyelr8vQHG2Ry1hyG+vTl0a6x9N658WGNpGB+hEgpN1AFunZjr7OHg=='}) },
  { workspace: 'packages/cli', name: '@dharma-ai-labs/agent-fabric', version: '0.2.200' },
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
    if (item.existingArtifact) assert.equal(packed.integrity, item.existingArtifact.integrity, 'reconciled artifact integrity mismatch');
    const existing = await io.lookup(item);
    if (item.existingArtifact) assert.ok(existing, 'reconciled artifact unavailable; no republish allowed');
    if (existing) {
      assertArtifact(item, packed, existing);
      await io.verifyPublished(item, packed, existing, item.existingArtifact?.source || expectedHead);
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
  const allowed = new Set(['scripts/publish-onboarding-release.mjs', 'scripts/publish-onboarding-release.test.mjs',
    'packages/cli/package.json', 'package-lock.json']);
  assert.ok(snapshot.changed.every((file) => allowed.has(file)), 'unreviewed product source delta');
  assert.ok(snapshot.untracked.every((file) => file.startsWith('release/')), 'unexpected untracked source');
  assert.deepEqual(snapshot.manifest, snapshot.baselineManifest, 'unreviewed root manifest delta');
  const cliManifest = structuredClone(snapshot.baselineCliManifest);
  cliManifest.version = '0.2.200';
  assert.deepEqual(snapshot.cliManifest, cliManifest, 'unreviewed CLI manifest delta');
  const lock = structuredClone(snapshot.baselineLock);
  lock.packages['packages/cli'].version = '0.2.200';
  assert.deepEqual(snapshot.lock, lock, 'unreviewed lockfile delta');
}

export async function lookupPublishedArtifact(read, {now = () => performance.now(),
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms))} = {}) {
  const deadline = now() + 360_000;
  // Poll metadata only. Publication is never retried by this reconciliation path.
  for (let attempt = 0; attempt < 12; attempt++) {
    const remaining = Math.floor(deadline - now());
    if (remaining <= 0) return null;
    const value = await read(Math.min(30_000, remaining));
    if (now() >= deadline) return null;
    if (value) return value;
    if (attempt === 11) return null;
    await sleep(Math.max(0, Math.min(30_000, deadline - now())));
  }
  return null;
}

async function publicGet(url, json = true, timeoutMs = 30_000) {
  const target = new URL(url);
  assert.equal(target.origin, 'https://registry.npmjs.org', 'unexpected registry origin');
  const response = await fetch(target, { redirect: 'error', signal: AbortSignal.timeout(timeoutMs) });
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
        baselineCliManifest: JSON.parse(git('show', `${source}:packages/cli/package.json`)),
        cliManifest: JSON.parse(readFileSync(join(root, 'packages/cli/package.json'), 'utf8')),
        baselineLock: JSON.parse(git('show', `${source}:package-lock.json`)),
        lock: JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8')),
      });
    },
    manifest: async (item) => JSON.parse(readFileSync(join(root, item.workspace, 'package.json'), 'utf8')),
    pack: async (item) => JSON.parse(npm('pack', '--workspace', item.workspace, '--json', '--pack-destination', directory))[0],
    lookup: async (item, justPublished = false) => {
      const read = timeout => publicGet(`https://registry.npmjs.org/${encodeURIComponent(item.name)}/${item.version}`, true, timeout);
      return justPublished ? lookupPublishedArtifact(read) : read(30_000);
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
