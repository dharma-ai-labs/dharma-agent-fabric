import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const source = '6a3843f374d126fab5621303921f40be5122d86d';
const tree = 'f624f1efae2f686c6d99e28d44a46f519e299148';
const repository = 'https://github.com/dharma-ai-labs/dharma-agent-fabric';
export const approvedPackages = Object.freeze([
  { workspace: 'packages/contracts', name: '@dharma-ai-labs/agent-fabric-contracts', version: '0.1.16',
    existingArtifact: Object.freeze({source: '6c7d48916de11ccc837933a7ef7e8d2600184b54',
      integrity: 'sha512-ccumvrKW2MRxVobFxpmEYXzOdY7syggdPswC8BBuuLnnjSvOUz0tYtwZEaF7n1A4RK6yNuttmavZ/rCV5smtMQ=='}) },
  { workspace: 'packages/provider-adapters', name: '@dharma-ai-labs/agent-fabric-provider-adapters', version: '0.1.36',
    existingArtifact: Object.freeze({source: '3038b4f53afcfa2825025e51f09d834c937115d4',
      integrity: 'sha512-NdKtgL7IWIMtkN+pm0xRX4lP3zspwz4+c4N7IY/kNpqmcu32snIp3Z1oP5nYjIAyRcCxWPz6LEoEzU3CQ1WUaw=='}) },
  { workspace: 'packages/task-runner', name: '@dharma-ai-labs/agent-fabric-task-runner', version: '0.1.38',
    existingArtifact: Object.freeze({source: '3038b4f53afcfa2825025e51f09d834c937115d4',
      integrity: 'sha512-8wwADswTKRNidXWP2kGcCBsctY/wEJ43m5etVqyeBKxaUqca7GarhkrYoe/WseOYJFDGt1XfWxDDuXz2SPMXIg=='}) },
  { workspace: 'packages/evidence-reduction', name: '@dharma-ai-labs/agent-fabric-evidence-reduction', version: '0.2.35',
    existingArtifact: Object.freeze({source: '3038b4f53afcfa2825025e51f09d834c937115d4',
      integrity: 'sha512-Sr3Rv1kLvZ3GE8vrrmYZDoFp41ypdAhinR3kZKS2jtsMmNBUIQpA+Q2OV1OtmtsrDs1yEo/rvMqYEIYUUAb5Aw=='}) },
  { workspace: 'packages/secure-store', name: '@dharma-ai-labs/agent-fabric-secure-store', version: '0.1.10',
    existingArtifact: Object.freeze({source: '1b8483f59dc1ba9f7aa0aef78ca984f309714e61',
      integrity: 'sha512-n3nah4kTTqhx+VKdrT/zzomGo8yxCaW44y4JrlAb3G+DhOl802VUzwhniCU9eAXucvp4Uhu7VXMKmSkVYEHwGw=='}) },
  { workspace: 'packages/relay-client', name: '@dharma-ai-labs/agent-fabric-relay-client', version: '0.2.33',
    existingArtifact: Object.freeze({source: '1b8483f59dc1ba9f7aa0aef78ca984f309714e61',
      integrity: 'sha512-slzUPm+stPzF99vy6D0w2YWzT5wcDDq4zgJxq7JQBc/QB6v2JOPDK4t5NCIAeNW74E6W4J8qmJ6oGAvuKjxr4A=='}) },
  { workspace: 'packages/local-vault', name: '@dharma-ai-labs/agent-fabric-local-vault', version: '0.1.31',
    existingArtifact: Object.freeze({source: '51c3a9ae10f43ff80efa4b0b63212c8ef2b7a824',
      integrity: 'sha512-cPbjNh+//3PiibUDhMCNsQ8oTZmlRbd871aeIDpfnWwp6V5hiQ4NXFSjCVOEIwu4bHoM99AnZBI5dTuziHdbaQ=='}) },
  { workspace: 'packages/cli', name: '@dharma-ai-labs/agent-fabric', version: '0.2.208' },
].map(Object.freeze));

export const approvedProductSourceHashes = Object.freeze({
  "packages/cli/src/bootstrapProcessCaller.test.ts": "932da4d624c3e35546ce98c46e9765b0a789a1073d000e53e83abc678ab9e1fe",
  "packages/cli/src/codexSetupSessionCaller.test.ts": "ab767b3d90f21491b3afea2ccd4536138e1cc7c81f27e36f43102b849fa01ee0",
  "packages/cli/src/index.ts": "a64e17b1345eb7bfdfdb79a3b5cfb703deb8ea7eccb87e43187c9e833c7cfa30",
  "packages/cli/src/namedSessionService.ts": "8a67fd1833a628022d82606b7158f6737de500ff090eef6e7f307442fdd36511",
  "packages/cli/src/namedSessionTransportDiagnostic.ts": "e79125eacdb858c3acf01cfc462729b23d0efd6aaa4574c5023488b4e9dfcaf8",
  "packages/cli/src/namedSessionTransportDiagnostic.test.ts": "3d43b44a78a96936d5ba0b556135b3e9b7577c19d7be0f27caba46af9d9f98d0",
  "packages/cli/src/usage.ts": "6197e396fddcb8473718c5346c10cdcef8af9591beb4cdb4f9be2eb8456c0cd1",
  "packages/cli/README.md": "7c851e781f5f10e8e0ae7c3dcdb3db68cbcfd2d840cba309973f970b402ed90c",
  "schemas/named-session-readiness-diagnostic.schema.json": "c77348ea4ebe675a3534411746bdfdb6c932fa23931e4fb5dfcf9ba238dd83a9"
});
export function sourceTextSha256(text) {
  return createHash('sha256').update(text.replace(/\r\n/g, '\n')).digest('hex');
}

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
    'packages/cli/package.json', 'package-lock.json', ...Object.keys(approvedProductSourceHashes)]);
  assert.ok(snapshot.changed.every((file) => allowed.has(file)), 'unreviewed product source delta');
  assert.ok(snapshot.untracked.every((file) => file.startsWith('release/')), 'unexpected untracked source');
  assert.deepEqual(snapshot.productSourceHashes, approvedProductSourceHashes, 'unreviewed product source bytes');
  assert.deepEqual(snapshot.manifest, snapshot.baselineManifest, 'unreviewed root manifest delta');
  const cliManifest = structuredClone(snapshot.baselineCliManifest);
  cliManifest.version = '0.2.208';
  for (const [name, version] of [['provider-adapters', '0.1.36'], ['task-runner', '0.1.38'], ['evidence-reduction', '0.2.35']]) {
    cliManifest.dependencies[`@dharma-ai-labs/agent-fabric-${name}`] = version;
  }
  assert.deepEqual(snapshot.cliManifest, cliManifest, 'unreviewed CLI manifest delta');
  const runtimePins = [['packages/secure-store', '0.1.10'], ['packages/relay-client', '0.2.33'],
    ['packages/local-vault', '0.1.31'], ['packages/provider-adapters', '0.1.36'],
    ['packages/task-runner', '0.1.38'], ['packages/evidence-reduction', '0.2.35'],
    ['packages/lifecycle-adapter', '0.1.0']];
  const runtimePaths = runtimePins.map(([path]) => path).sort();
  assert.deepEqual(Object.keys(snapshot.runtimeManifests).sort(), runtimePaths, 'unreviewed runtime manifest set');
  assert.deepEqual(Object.keys(snapshot.baselineRuntimeManifests).sort(), runtimePaths, 'unreviewed runtime baseline set');
  for (const [path, version] of runtimePins) {
    const expected = structuredClone(snapshot.baselineRuntimeManifests[path]);
    expected.version = version;
    if (['packages/task-runner', 'packages/evidence-reduction'].includes(path)) {
      expected.dependencies['@dharma-ai-labs/agent-fabric-provider-adapters'] = '0.1.36';
    }
    if (path === 'packages/lifecycle-adapter') {
      expected.dependencies['@dharma-ai-labs/agent-fabric-evidence-reduction'] = '0.2.35';
    }
    assert.deepEqual(snapshot.runtimeManifests[path], expected,
      `unreviewed runtime manifest delta:${path}`);
  }
  const lock = structuredClone(snapshot.baselineLock);
  lock.packages['packages/cli'].version = '0.2.208';
  for (const [name, version] of [['provider-adapters', '0.1.36'], ['task-runner', '0.1.38'], ['evidence-reduction', '0.2.35']]) {
    lock.packages[`packages/${name}`].version = version;
    lock.packages['packages/cli'].dependencies[`@dharma-ai-labs/agent-fabric-${name}`] = version;
  }
  for (const name of ['task-runner', 'evidence-reduction']) {
    lock.packages[`packages/${name}`].dependencies['@dharma-ai-labs/agent-fabric-provider-adapters'] = '0.1.36';
  }
  lock.packages['packages/lifecycle-adapter'].dependencies['@dharma-ai-labs/agent-fabric-evidence-reduction'] = '0.2.35';
  assert.deepEqual(snapshot.lock, lock, 'unreviewed lockfile delta');
  const previousVersion = "const VERSION = '0.2.207';";
  assert.equal(snapshot.baselineCliSource.split(previousVersion).length, 2, 'reviewed CLI version anchor required');
  assert.equal(sourceTextSha256(snapshot.cliSource),
    approvedProductSourceHashes['packages/cli/src/index.ts'], 'unreviewed CLI source delta');
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
  assert.ok(Array.isArray(attestations?.attestations), 'published provenance missing');
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

export async function verifyPublishedProvenance(item, packed, expectedHead, read, clock) {
  const attestations = await lookupPublishedArtifact(read, clock);
  assert.ok(attestations, 'published provenance not visible; reconcile before another attempt');
  assertProvenance(item, packed, attestations, expectedHead);
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
        baselineRuntimeManifests: Object.fromEntries(['secure-store', 'relay-client', 'local-vault', 'provider-adapters',
          'task-runner', 'evidence-reduction', 'lifecycle-adapter'].map(name =>
          [`packages/${name}`, JSON.parse(git('show', `${source}:packages/${name}/package.json`))])),
        runtimeManifests: Object.fromEntries(['secure-store', 'relay-client', 'local-vault', 'provider-adapters',
          'task-runner', 'evidence-reduction', 'lifecycle-adapter'].map(name =>
          [`packages/${name}`, JSON.parse(readFileSync(join(root, 'packages', name, 'package.json'), 'utf8'))])),
        baselineLock: JSON.parse(git('show', `${source}:package-lock.json`)),
        lock: JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8')),
        baselineCliSource: execFileSync('git', ['show', `${source}:packages/cli/src/index.ts`],
          {cwd: root, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024}),
        cliSource: readFileSync(join(root, 'packages/cli/src/index.ts'), 'utf8'),
        productSourceHashes: Object.fromEntries(Object.keys(approvedProductSourceHashes).map(path =>
          [path, sourceTextSha256(readFileSync(join(root,path),'utf8'))])),
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
      await verifyPublishedProvenance(item, packed, expected,
        timeout => publicGet(metadata.dist.attestations.url, true, timeout));
      console.log(`Verified ${item.name}@${item.version} integrity and publisher source ${expected}`);
    },
  });
}
