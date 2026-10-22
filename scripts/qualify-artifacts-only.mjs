import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repository = 'dharma-ai-labs/dharma-agent-fabric';
const workflowRef = `${repository}/.github/workflows/publish.yml@refs/heads/main`;
export const artifactOnlyPackages = Object.freeze([
  ['provider-adapters', '0.1.38'], ['task-runner', '0.1.40'], ['relay-client', '0.2.35'], ['cli', '0.2.213'],
].map(([workspace, version]) => Object.freeze({ workspace: `packages/${workspace}`,
  name: `@dharma-ai-labs/${workspace === 'cli' ? 'agent-fabric' : `agent-fabric-${workspace}`}`, version })));

export function assertArtifactOnlySource(expected, snapshot) {
  assert.match(expected ?? '', /^[a-f0-9]{40}$(?![\s\S])/, 'exact reviewed main required');
  assert.equal(snapshot.head, expected, 'dispatched source mismatch');
  assert.equal(snapshot.remoteMain, expected, 'current remote main required');
  assert.equal(snapshot.githubSha, expected, 'workflow source mismatch');
  assert.equal(snapshot.workflowSha, expected, 'workflow definition mismatch');
  assert.equal(snapshot.githubActions, 'true', 'GitHub Actions context required');
  assert.equal(snapshot.repository, repository, 'qualification repository mismatch');
  assert.equal(snapshot.ref, 'refs/heads/main', 'main-only qualification');
  assert.equal(snapshot.workflowRef, workflowRef, 'existing workflow required');
  assert.equal(snapshot.event, 'workflow_dispatch', 'explicit dispatch required');
  assert.equal(snapshot.artifactsOnly, 'true', 'explicit artifacts-only mode required');
  assert.deepEqual(snapshot.otherScopes, ['false', 'false', 'false'], 'mutually exclusive scope required');
  assert.equal(snapshot.runAttempt, '1', 'reconcile rather than rerun qualification');
  assert.match(snapshot.runId ?? '', /^[1-9][0-9]{0,19}$(?![\s\S])/, 'workflow run identity required');
  assert.equal(snapshot.platform, 'linux', 'Linux publisher-platform qualification required');
  assert.equal(snapshot.nodeVersion, 'v22.22.3', 'pinned Node required');
  assert.equal(snapshot.npmVersion, '11.5.1', 'pinned npm required');
  assert.equal(snapshot.dirty, '', 'clean source required');
  const outputNames = new Set(['artifact-qualification.json', 'SHA256SUMS', ...artifactOnlyPackages.map(item =>
    `${item.name.slice(1).replace('/', '-')}-${item.version}.tgz`)]);
  assert(Array.isArray(snapshot.untracked) && snapshot.untracked.every(path =>
    path.startsWith('release/') && outputNames.has(path.slice(8))), 'untracked source or output requires reconciliation');
}

// This path can only create local build artifacts. It has no registry publish,
// release-create or installed-consumer operation and validates all manifests first.
export async function qualifyArtifactsOnly(expected, io) {
  const identity = await io.verifySource(expected);
  for (const item of artifactOnlyPackages) {
    const manifest = await io.manifest(item);
    assert.equal(manifest.name, item.name, 'package name mismatch');
    assert.equal(manifest.version, item.version, 'package version mismatch');
    if (item.workspace === 'packages/cli') {
      for (const dependency of artifactOnlyPackages.slice(0, 3)) {
        assert.equal(manifest.dependencies?.[dependency.name], dependency.version, 'new cohort edge mismatch');
      }
      assert.equal(manifest.dependencies?.['@dharma-ai-labs/agent-fabric-evidence-reduction'], '0.2.36', 'preserved evidence edge mismatch');
    }
  }
  await io.prepareDirectory();
  const artifacts = [];
  for (const item of artifactOnlyPackages) {
    await io.verifySource(expected);
    const packed = await io.pack(item), filename = `${item.name.slice(1).replace('/', '-')}-${item.version}.tgz`;
    assert.equal(packed.name, item.name, 'packed name mismatch');
    assert.equal(packed.version, item.version, 'packed version mismatch');
    assert.equal(packed.filename, filename, 'packed filename mismatch');
    const bytes = await io.readArtifact(filename);
    assert(Buffer.isBuffer(bytes) && bytes.length > 0 && bytes.length <= 8 * 1024 * 1024, 'bounded artifact required');
    const integrity = `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
    assert.equal(packed.integrity, integrity, 'actual artifact integrity mismatch');
    artifacts.push({ name: item.name, version: item.version, filename, bytes: bytes.length, integrity,
      sha256: createHash('sha256').update(bytes).digest('hex') });
  }
  await io.verifySource(expected);
  const result = { schema: 'dharma.artifacts-only-qualification/v1', state: 'packed_not_published',
    head: expected, repository, workflowRef, runId: identity.runId, runAttempt: identity.runAttempt,
    toolchain: { platform: 'linux', node: 'v22.22.3', npm: '11.5.1' }, artifacts,
    published: false, installedConsumerQualified: false,
    provenance: 'subsequent_workflow_attestation_requires_independent_verification' };
  await io.writeTuple(result);
  return result;
}

function realIo() {
  assert.equal(process.platform, 'linux', 'Linux qualification only');
  assert.equal(process.version, 'v22.22.3', 'pinned Node required');
  assert.equal(process.env.ARTIFACTS_ONLY, 'true', 'explicit artifacts-only mode required');
  assert.equal(process.env.GITHUB_EVENT_NAME, 'workflow_dispatch', 'explicit workflow dispatch required');
  assert.equal(process.env.GITHUB_ACTIONS, 'true', 'GitHub Actions context required');
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..'), directory = join(root, 'release');
  const run = (file, args, limit = 4 * 1024 * 1024) => execFileSync(file, args,
    { cwd: root, encoding: 'utf8', timeout: 20000, maxBuffer: limit, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const snapshot = () => {
    const remote = run('git', ['ls-remote', '--exit-code', 'origin', 'refs/heads/main']);
    assert.match(remote, /^[a-f0-9]{40}\trefs\/heads\/main$(?![\s\S])/, 'exact current main required');
    return { head: run('git', ['rev-parse', 'HEAD']), remoteMain: remote.slice(0, 40), githubSha: process.env.GITHUB_SHA,
      workflowSha: process.env.GITHUB_WORKFLOW_SHA, githubActions: process.env.GITHUB_ACTIONS,
      repository: process.env.GITHUB_REPOSITORY, ref: process.env.GITHUB_REF, workflowRef: process.env.GITHUB_WORKFLOW_REF,
      event: process.env.GITHUB_EVENT_NAME, artifactsOnly: process.env.ARTIFACTS_ONLY,
      otherScopes: ['ONBOARDING_ONLY', 'CONTRACTS_ONLY', 'DEVICE_MAINTENANCE_ONLY'].map(key => process.env[key]),
      runAttempt: process.env.GITHUB_RUN_ATTEMPT, runId: process.env.GITHUB_RUN_ID,
      platform: process.platform, nodeVersion: process.version, npmVersion: run('npm', ['--version']),
      dirty: run('git', ['status', '--porcelain', '--untracked-files=no']),
      untracked: run('git', ['ls-files', '--others', '--exclude-standard']).split('\n').filter(Boolean) };
  };
  return {
    async verifySource(expected) { const value = snapshot(); assertArtifactOnlySource(expected, value); return value; },
    async manifest(item) { return JSON.parse(readFileSync(join(root, item.workspace, 'package.json'), 'utf8')); },
    async prepareDirectory() {
      assert(!existsSync(directory), 'existing release output requires reconciliation');
      mkdirSync(directory);
    },
    async pack(item) {
      const results = JSON.parse(run('npm', ['pack', '--workspace', item.workspace, '--pack-destination', directory, '--json']));
      assert.equal(results.length, 1, 'single selected package required'); return results[0];
    },
    async readArtifact(filename) {
      const path = join(directory, filename), stat = lstatSync(path);
      assert(stat.isFile() && !stat.isSymbolicLink() && stat.size > 0 && stat.size <= 8 * 1024 * 1024, 'bounded regular artifact required');
      return readFileSync(path);
    },
    async writeTuple(value) {
      const filename = 'artifact-qualification.json', content = JSON.stringify(value, null, 2) + '\n';
      writeFileSync(join(directory, filename), content, { flag: 'wx' });
      const sums = [...value.artifacts.map(item => `${item.sha256}  ${item.filename}`),
        `${createHash('sha256').update(content).digest('hex')}  ${filename}`].join('\n') + '\n';
      writeFileSync(join(directory, 'SHA256SUMS'), sums, { flag: 'wx' });
    },
  };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2), admission = args.at(-1) === '--admission-only';
  assert.deepEqual(args.slice(0, 1), ['--expected-head'], 'exact qualification arguments required');
  assert.equal(args.length, admission ? 3 : 2, 'unexpected qualification arguments');
  const io = realIo();
  const result = admission ? (await io.verifySource(args[1]), { state: 'admitted_artifacts_only_not_published', head: args[1] })
    : await qualifyArtifactsOnly(args[1], io);
  process.stdout.write(JSON.stringify(result) + '\n');
}
