import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { parse } from 'yaml';
import { artifactOnlyPackages, assertArtifactOnlySource, qualifyArtifactsOnly } from './qualify-artifacts-only.mjs';

const head = 'a'.repeat(40), repo = 'dharma-ai-labs/dharma-agent-fabric';
const source = () => ({ head, remoteMain: head, githubSha: head, workflowSha: head, githubActions: 'true', repository: repo, ref: 'refs/heads/main',
  workflowRef: `${repo}/.github/workflows/publish.yml@refs/heads/main`, event: 'workflow_dispatch',
  artifactsOnly: 'true', otherScopes: ['false', 'false', 'false'], runAttempt: '1', runId: '123456',
  platform: 'linux', nodeVersion: 'v22.22.3', npmVersion: '11.5.1', dirty: '', untracked: [] });
function fixture() {
  const events = [], snapshot = source(), payloads = new Map(); let tuple;
  for (const item of artifactOnlyPackages) payloads.set(item.name, Buffer.from(`synthetic fixture ${item.name}@${item.version}`));
  const io = {
    async verifySource(expected) { events.push('source'); assertArtifactOnlySource(expected, snapshot); return snapshot; },
    async manifest(item) { return { name: item.name, version: item.version,
      dependencies: Object.fromEntries([...artifactOnlyPackages.slice(0, 3).map(value => [value.name, value.version]),
        ['@dharma-ai-labs/agent-fabric-evidence-reduction', '0.2.36']]) }; },
    async prepareDirectory() { events.push('directory'); },
    async pack(item) { events.push(`pack:${item.name}`); return { name: item.name, version: item.version,
      filename: `${item.name.slice(1).replace('/', '-')}-${item.version}.tgz`,
      integrity: `sha512-${createHash('sha512').update(payloads.get(item.name)).digest('base64')}` }; },
    async readArtifact(filename) { return payloads.get(artifactOnlyPackages.find(item => filename.includes(item.version)).name); },
    async writeTuple(value) { events.push('tuple'); tuple = value; },
    async publish() { throw Error('publication must be unreachable'); },
    async install() { throw Error('installation must be unreachable'); },
  };
  return { io, snapshot, events, payloads, tuple: () => tuple };
}
test('artifact-only qualification creates only four selected local artifacts and exact byte hashes', async () => {
  const f = fixture(), result = await qualifyArtifactsOnly(head, f.io);
  assert.equal(result.state, 'packed_not_published'); assert.equal(result.published, false); assert.equal(result.installedConsumerQualified, false);
  assert.deepEqual(result.artifacts.map(item => [item.name, item.version]), artifactOnlyPackages.map(item => [item.name, item.version]));
  assert.equal(result.runId, '123456'); assert.equal(result.runAttempt, '1');
  assert.equal(f.events.filter(event => event === 'source').length, 6);
  assert.equal(f.events.filter(event => event.startsWith('pack:')).length, 4); assert.equal(f.events.at(-1), 'tuple');
  for (const item of result.artifacts) assert.equal(item.sha256, createHash('sha256').update(f.payloads.get(item.name)).digest('hex'));
});
for (const [field, value] of Object.entries({ head: 'b'.repeat(40), remoteMain: 'b'.repeat(40), githubSha: 'b'.repeat(40),
  workflowSha: 'b'.repeat(40), githubActions: 'false',
  repository: 'foreign/repo', ref: 'refs/heads/foreign', workflowRef: `${repo}/.github/workflows/other.yml@refs/heads/main`,
  event: 'push', artifactsOnly: 'false', runAttempt: '2', runId: '123\n', platform: 'win32',
  nodeVersion: 'v22.23.2', npmVersion: '11.7.0', dirty: ' M packages/cli/src/index.ts', untracked: ['private.env'] })) {
  test(`artifact-only source rejects ${field} before preparing output`, async () => {
    const f = fixture(); f.snapshot[field] = value;
    await assert.rejects(() => qualifyArtifactsOnly(head, f.io)); assert.deepEqual(f.events, ['source']);
  });
}
test('all other scopes must be false, and only fixed generated release names are admitted', () => {
  for (let index = 0; index < 3; index++) {
    const snapshot = source(); snapshot.otherScopes[index] = 'true'; assert.throws(() => assertArtifactOnlySource(head, snapshot));
  }
  for (const untracked of [['release/private.env'], ['release/nested/filename'], ['release/foreign.tgz']]) {
    assert.throws(() => assertArtifactOnlySource(head, { ...source(), untracked }));
  }
  assert.doesNotThrow(() => assertArtifactOnlySource(head, { ...source(), untracked: ['release/artifact-qualification.json', 'release/SHA256SUMS'] }));
  assert.throws(() => assertArtifactOnlySource(head + '\n', source()));
  assert.throws(() => assertArtifactOnlySource(head + String.fromCharCode(10), source()));
  assert.throws(() => assertArtifactOnlySource(head, { ...source(), runId: '123' + String.fromCharCode(10) }));
});
test('all manifests and new cohort edges are checked before the first directory or pack write', async () => {
  for (const change of ['version', 'provider', 'evidence']) {
    const f = fixture(), original = f.io.manifest;
    f.io.manifest = async item => { const value = await original(item); if (item.workspace === 'packages/cli') {
      if (change === 'version') value.version = '0.2.212';
      else value.dependencies[change === 'provider' ? artifactOnlyPackages[0].name : '@dharma-ai-labs/agent-fabric-evidence-reduction'] = 'foreign';
    } return value; };
    await assert.rejects(() => qualifyArtifactsOnly(head, f.io)); assert.deepEqual(f.events, ['source']);
  }
});
test('source changing after initial admission prevents any first package or tuple', async () => {
  const f = fixture(), original = f.io.verifySource; let reads = 0;
  f.io.verifySource = async expected => { if (++reads === 2) f.snapshot.remoteMain = 'b'.repeat(40); return original(expected); };
  await assert.rejects(() => qualifyArtifactsOnly(head, f.io)); assert.equal(f.events.filter(event => event.startsWith('pack:')).length, 0);
  assert.equal(f.tuple(), undefined);
});
for (const field of ['name', 'version', 'filename', 'integrity']) {
  test(`changed packed ${field} ends qualification without retry or tuple`, async () => {
    const f = fixture(), original = f.io.pack;
    f.io.pack = async item => ({ ...await original(item), [field]: 'foreign' });
    await assert.rejects(() => qualifyArtifactsOnly(head, f.io));
    assert.equal(f.events.filter(event => event.startsWith('pack:')).length, 1); assert.equal(f.tuple(), undefined);
  });
}
test('changed and oversized actual bytes are refused even if package metadata looks correct', async () => {
  for (const value of [Buffer.from('different'), Buffer.alloc(8 * 1024 * 1024 + 1), Buffer.alloc(0)]) {
    const f = fixture(); f.io.readArtifact = async () => value;
    await assert.rejects(() => qualifyArtifactsOnly(head, f.io)); assert.equal(f.tuple(), undefined);
  }
});
test('final source mismatch prevents a qualification tuple after local packs', async () => {
  const f = fixture(), original = f.io.verifySource; let reads = 0;
  f.io.verifySource = async expected => { if (++reads === 6) f.snapshot.remoteMain = 'b'.repeat(40); return original(expected); };
  await assert.rejects(() => qualifyArtifactsOnly(head, f.io)); assert.equal(f.events.filter(event => event.startsWith('pack:')).length, 4);
  assert.equal(f.tuple(), undefined);
});
test('same workflow opt-in cannot reach npm, Python or GitHub Release writes', () => {
  const workflow = parse(readFileSync(new URL('../.github/workflows/publish.yml', import.meta.url), 'utf8'));
  const job = workflow.jobs.publish, steps = job.steps;
  assert.deepEqual(workflow.permissions, { contents: 'write', 'id-token': 'write', attestations: 'write' });
  assert.equal(job.environment, 'npm');
  assert.deepEqual(workflow.on.workflow_dispatch.inputs.artifacts_only.type, 'boolean');
  assert.equal(workflow.on.workflow_dispatch.inputs.artifacts_only.default, false);
  const skip = "!(github.event_name == 'workflow_dispatch' && inputs.artifacts_only)";
  assert.equal(steps.find(step => step.name === 'Publish public workspaces').if, skip);
  assert.equal(steps.find(step => step.name === 'Publish GitHub Release').if, `startsWith(github.ref, 'refs/tags/') && ${skip}`);
  assert.equal(workflow.jobs['publish-python'].if, "vars.PYPI_PUBLISH_ENABLED == 'true' && !(github.event_name == 'workflow_dispatch' && (inputs.onboarding_only || inputs.contracts_only || inputs.device_maintenance_only || inputs.artifacts_only))");
  assert.equal(steps.find(step => step.name === 'Build release artifacts').if,
    "!(github.event_name == 'workflow_dispatch' && (inputs.contracts_only || inputs.artifacts_only))");
});
test('admission precedes npm ci and full checks precede four-pack, attestation and bounded retention', () => {
  const workflow = parse(readFileSync(new URL('../.github/workflows/publish.yml', import.meta.url), 'utf8'));
  const steps = workflow.jobs.publish.steps, at = name => steps.findIndex(step => step.name === name);
  assert(steps.findIndex(step => step.run === 'npm ci') > at('Validate publication scope'));
  assert(at('Qualify execution artifacts without publication') > steps.findIndex(step => step.run === 'npm run check'));
  assert(at('Attest release artifacts') > at('Qualify execution artifacts without publication'));
  assert(at('Retain qualified execution artifacts') > at('Attest release artifacts'));
  const validate = steps[at('Validate publication scope')];
  assert.match(validate.run, /"\$ARTIFACTS_ONLY"/); assert.match(validate.run, /qualify-artifacts-only.mjs --expected-head "\$EXPECTED_HEAD" --admission-only/);
  const qualify = steps[at('Qualify execution artifacts without publication')];
  assert.equal(qualify.if, "github.event_name == 'workflow_dispatch' && inputs.artifacts_only");
  assert.equal(qualify.env.EXPECTED_HEAD, '${{ inputs.expected_head }}');
  assert(!Object.hasOwn(qualify.env, 'NODE_AUTH_TOKEN'));
  const upload = steps[at('Retain qualified execution artifacts')];
  assert.equal(upload.uses, 'actions/upload-artifact@cf430e030ddbb5b0abf93d22962f4752f3646cd9');
  assert.equal(upload.if, qualify.if); assert.equal(upload.with.path, 'release/*');
  assert.equal(upload.with['retention-days'], 1); assert.equal(upload.with.overwrite, false);
  assert.equal(upload.with['include-hidden-files'], false); assert.equal(upload.with['if-no-files-found'], 'error');
  assert.equal(steps.find(step => step.uses?.startsWith('actions/setup-node@')).with['node-version'],
    "${{ inputs.artifacts_only && '22.22.3' || '22.22.0' }}");
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.match(manifest.scripts['pack:verify'], /scripts\/qualify-artifacts-only.test.mjs/);
});
