import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { approvedPackages, assertSourceSnapshot, assertProvenance, publishBoundedRelease } from './publish-onboarding-release.mjs';
import * as publisher from './publish-onboarding-release.mjs';

const head = 'a'.repeat(40);
const existingContractsSource = '6c7d48916de11ccc837933a7ef7e8d2600184b54';
const existingContractsIntegrity = 'sha512-ccumvrKW2MRxVobFxpmEYXzOdY7syggdPswC8BBuuLnnjSvOUz0tYtwZEaF7n1A4RK6yNuttmavZ/rCV5smtMQ==';
const integrity = item => item.name === '@dharma-ai-labs/agent-fabric-contracts' ? existingContractsIntegrity : `sha512-${item.version}`;

test('merged artifact correction is admitted without admitting further product changes', () => {
  const root = join(import.meta.dirname, '..');
  const git = (...args) => execFileSync('git', args, {cwd: root, encoding: 'utf8'}).trim();
  const baseline = 'bb072701c002bc1cdc68a4bec16fb6ea38d8dd7c';
  const reviewed = baseline;
  assert.equal(git('rev-parse', `${reviewed}^{tree}`), 'b6012b4a75c41996f9a5644857817a0d90ef1c29');
  // Exercise committed candidate metadata, not a claim of clean release eligibility.
  const snapshot = {head: reviewed, ref: 'refs/heads/main', tree: git('rev-parse', `${baseline}^{tree}`),
    dirty: '', lifecycleLauncher: git('ls-tree', reviewed, 'packages/lifecycle-adapter/bin/run.mjs'),
    changed: git('diff', '--name-only', baseline, reviewed).split('\n').filter(Boolean), untracked: [],
    baselineManifest: JSON.parse(git('show', `${baseline}:package.json`)),
    manifest: JSON.parse(git('show', `${reviewed}:package.json`))};
  assert.doesNotThrow(() => assertSourceSnapshot(reviewed, snapshot));
  assert.doesNotThrow(() => assertSourceSnapshot(reviewed, { ...snapshot, changed: [
    'scripts/publish-onboarding-release.mjs', 'scripts/publish-onboarding-release.test.mjs'] }));
  for (const forbidden of ['packages/cli/src/unreviewed.ts', 'packages/secure-store/src/index.ts', '.github/workflows/publish.yml',
    'packages/task-runner/src/index.ts', 'packages/task-runner/src/index.test.ts', 'packages/task-runner/README.md',
    'packages/contracts/package.json', 'package-lock.json', 'apps/relay-gateway/src/protocol.ts']) {
    assert.throws(() => assertSourceSnapshot(reviewed, {...snapshot, changed: [...snapshot.changed, forbidden]}),
      /unreviewed product source delta/);
  }
});

test('npm bin linking leaves a tracked executable launcher clean on Linux', { skip: process.platform !== 'linux' }, () => {
  const root = mkdtempSync(join(tmpdir(), 'dharma-bin-mode-'));
  const run = (file, args, cwd) => execFileSync(file, args, { cwd, encoding: 'utf8', timeout: 30_000, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  try {
    for (const mode of [0o644, 0o755]) {
      const cwd = join(root, String(mode));
      mkdirSync(join(cwd, 'packages', 'launcher'), { recursive: true });
      writeFileSync(join(cwd, 'package.json'), JSON.stringify({ name: 'fixture-root', private: true, workspaces: ['packages/*'] }));
      writeFileSync(join(cwd, 'packages/launcher/package.json'), JSON.stringify({ name: 'fixture-launcher', version: '1.0.0', bin: { 'fixture-launcher': 'run.mjs' } }));
      const launcher = join(cwd, 'packages/launcher/run.mjs');
      writeFileSync(launcher, '#!/usr/bin/env node\n');
      chmodSync(launcher, mode);
      writeFileSync(join(cwd, 'user.npmrc'), '');
      writeFileSync(join(cwd, 'global.npmrc'), '');
      run('git', ['init', '--quiet'], cwd);
      run('git', ['add', '.'], cwd);
      run('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--quiet', '-m', 'Fixture'], cwd);
      run('npm', ['install', '--ignore-scripts', '--offline', '--no-audit', '--no-fund', '--no-package-lock', '--registry=http://127.0.0.1:9', '--userconfig=' + join(cwd, 'user.npmrc'), '--globalconfig=' + join(cwd, 'global.npmrc')], cwd);
      const diff = run('git', ['diff', '--summary'], cwd);
      if (mode === 0o644) assert.equal(diff, 'mode change 100644 => 100755 packages/launcher/run.mjs');
      else assert.equal(diff, '');
      assert.equal(run('git', ['diff', '--numstat'], cwd), mode === 0o644 ? '0\t0\tpackages/launcher/run.mjs' : '');
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
function fixture() {
  const effects = [];
  const verified = [];
  const published = new Map();
  published.set(approvedPackages[0].name, {name: approvedPackages[0].name, version: approvedPackages[0].version,
    dist: {integrity: existingContractsIntegrity, attestations: {url: 'https://registry.npmjs.org/-/npm/v1/attestations/contracts'}}});
  const io = {
    verifySource: async (expected) => { assert.equal(expected, head); },
    manifest: async (item) => ({ name: item.name, version: item.version }),
    pack: async (item) => ({ integrity: integrity(item), filename: `${item.version}.tgz` }),
    lookup: async (item) => published.get(item.name) || null,
    publish: async (item) => {
      effects.push(item.name);
      published.set(item.name, { name: item.name, version: item.version, dist: {
        integrity: integrity(item), attestations: { url: `https://registry.npmjs.org/-/npm/v1/attestations/${encodeURIComponent(item.name)}@${item.version}` },
      } });
    },
    verifyPublished: async (item, _packed, _metadata, source) => { verified.push({name: item.name, source}); },
  };
  return { io, effects, verified };
}

test('publishes precisely the approved dependency closure before the CLI correction', async () => {
  const { io, effects } = fixture();
  await publishBoundedRelease(head, io);
  assert.deepEqual(effects, approvedPackages.slice(1).map((item) => item.name));
  assert.deepEqual(approvedPackages.map((item) => [item.name, item.version]), [
    ['@dharma-ai-labs/agent-fabric-contracts', '0.1.16'],
    ['@dharma-ai-labs/agent-fabric-provider-adapters', '0.1.34'],
    ['@dharma-ai-labs/agent-fabric-task-runner', '0.1.36'],
    ['@dharma-ai-labs/agent-fabric-evidence-reduction', '0.2.33'],
    ['@dharma-ai-labs/agent-fabric', '0.2.188'],
  ]);
});

for (const defect of ['source', 'name', 'version', 'integrity', 'provenance']) {
  test(`rejects ${defect} mismatch before any publication`, async () => {
    const { io, effects } = fixture();
    if (defect === 'source') io.verifySource = async () => { throw new Error('source mismatch'); };
    if (defect === 'name' || defect === 'version') {
      const original = io.manifest;
      io.manifest = async (item) => ({ ...await original(item), ...(item.name === '@dharma-ai-labs/agent-fabric' ? { [defect]: 'wrong' } : {}) });
    }
    if (defect === 'integrity' || defect === 'provenance') {
      const original = io.lookup;
      io.lookup = async (item) => item.name === '@dharma-ai-labs/agent-fabric'
        ? { name: item.name, version: item.version, dist: { integrity: defect === 'integrity' ? 'wrong' : integrity(item) } } : original(item);
    }
    await assert.rejects(publishBoundedRelease(head, io));
    assert.deepEqual(effects, []);
  });
}

test('matching existing integrity and provenance are verified, never republished', async () => {
  const { io, effects } = fixture();
  let checked = 0;
  io.lookup = async (item) => ({ name: item.name, version: item.version, dist: {
    integrity: integrity(item), attestations: { url: `https://registry.npmjs.org/-/npm/v1/attestations/${encodeURIComponent(item.name)}@${item.version}` },
  } });
  io.verifyPublished = async () => { checked++; };
  await publishBoundedRelease(head, io);
  assert.equal(checked, approvedPackages.length);
  assert.deepEqual(effects, []);
});

test('publication failure is not replayed and later packages remain unpublished', async () => {
  const { io, effects } = fixture();
  io.publish = async (item) => { effects.push(item.name); throw new Error('uncertain publish'); };
  await assert.rejects(publishBoundedRelease(head, io));
  assert.equal(effects.length, 1);
});

for (const defect of ['head', 'ref', 'tree', 'dirty', 'changed', 'untracked', 'manifest', 'lifecycleLauncher']) {
  test(`source admission rejects changed ${defect}`, () => {
    const manifest = { scripts: {
      'pack:verify': 'node --test scripts/publish-workflow.test.mjs scripts/publish-onboarding-release.test.mjs scripts/verify-package-pins.test.mjs && node scripts/verify-package.mjs',
      'publish:onboarding': 'node scripts/publish-onboarding-release.mjs',
    } };
    const snapshot = { head, ref: 'refs/heads/main', tree: 'b6012b4a75c41996f9a5644857817a0d90ef1c29',
      dirty: '', lifecycleLauncher: '100755 blob c7a500e580923098dff6121e1bf13a01f19b9b9d\tpackages/lifecycle-adapter/bin/run.mjs',
      changed: [], untracked: [], baselineManifest: structuredClone(manifest), manifest };
    assert.doesNotThrow(() => assertSourceSnapshot(head, snapshot));
    snapshot[defect] = ['changed', 'untracked'].includes(defect) ? ['packages/cli/other.js']
      : defect === 'manifest' ? { scripts: {} } : 'wrong';
    assert.throws(() => assertSourceSnapshot(head, snapshot));
  });
}

test('provenance rejects another source commit even when package bytes match', () => {
  const statement = { predicateType: 'https://slsa.dev/provenance/v1', subject: [], predicate: { buildDefinition: {
    externalParameters: { workflow: { ref: 'refs/heads/main', repository: 'https://github.com/dharma-ai-labs/dharma-agent-fabric', path: '.github/workflows/publish.yml' } },
    resolvedDependencies: [{ digest: { gitCommit: 'b'.repeat(40) } }],
  } } };
  const attestations = { attestations: [{ bundle: { dsseEnvelope: { payload: Buffer.from(JSON.stringify(statement)).toString('base64') } } }] };
  assert.throws(() => assertProvenance(approvedPackages[0], { integrity: 'sha512-YQ==' }, attestations, head), /publisher source mismatch/);
});

test('last-package preflight failure prevents every earlier dependency publication', async () => {
  const { io, effects } = fixture();
  const original = io.manifest;
  io.manifest = async (item) => ({ ...await original(item),
    ...(item.name === '@dharma-ai-labs/agent-fabric' ? {version: 'wrong'} : {}) });
  await assert.rejects(publishBoundedRelease(head, io), /approved package version mismatch/);
  assert.deepEqual(effects, []);
});

test('uncertain intermediate publication stops before later dependencies and CLI', async () => {
  const { io, effects } = fixture();
  io.publish = async (item) => {
    effects.push(item.name);
    if (effects.length === 2) throw new Error('uncertain second publication');
  };
  const lookup = io.lookup;
  io.lookup = async (item, justPublished) => justPublished ? {name: item.name, version: item.version,
    dist: {integrity: integrity(item), attestations: {url: 'https://registry.npmjs.org/-/npm/v1/attestations/fixture'}}} : lookup(item);
  await assert.rejects(publishBoundedRelease(head, io), /uncertain second publication/);
  assert.deepEqual(effects, approvedPackages.slice(1, 3).map((item) => item.name));
});

test('already reconciled contracts require their exact original publication source', async () => {
  const {io, verified} = fixture();
  await publishBoundedRelease(head, io);
  assert.equal(verified.find(x => x.name === approvedPackages[0].name).source, existingContractsSource);
  assert.ok(verified.filter(x => x.name !== approvedPackages[0].name).every(x => x.source === head));
});

test('missing known published contracts block all writes rather than republishing', async () => {
  const {io, effects} = fixture();
  io.lookup = async () => null;
  await assert.rejects(publishBoundedRelease(head, io), /reconciled artifact unavailable/);
  assert.deepEqual(effects, []);
});

test('changed known contracts bytes block all writes', async () => {
  const {io, effects} = fixture();
  const pack = io.pack;
  io.pack = async item => item.name === approvedPackages[0].name ? {integrity: 'changed', filename: 'changed.tgz'} : pack(item);
  await assert.rejects(publishBoundedRelease(head, io), /reconciled artifact integrity mismatch/);
  assert.deepEqual(effects, []);
});

test('readback permits delayed visibility with bounded read-only polling', async () => {
  assert.equal(typeof publisher.lookupPublishedArtifact, 'function');
  let time = 0;
  const timeouts = [];
  const metadata = {name: 'fixture'};
  const result = await publisher.lookupPublishedArtifact(async timeout => {
    timeouts.push(timeout);
    return time >= 180000 ? metadata : null;
  }, {now: () => time, sleep: async ms => {time += ms;}});
  assert.equal(result, metadata);
  assert.equal(time, 180000);
  assert.equal(timeouts.length, 7);
  assert.ok(timeouts.every(x => x > 0 && x <= 30000));
});

test('readback stops network admission at six minutes with no write retry', async () => {
  assert.equal(typeof publisher.lookupPublishedArtifact, 'function');
  let time = 0;
  let reads = 0;
  const result = await publisher.lookupPublishedArtifact(async () => {reads++; return null;},
    {now: () => time, sleep: async ms => {time += ms;}});
  assert.equal(result, null);
  assert.equal(time, 360000);
  assert.equal(reads, 12);
});

test('readback errors fail immediately rather than retrying denied or failed reads', async () => {
  assert.equal(typeof publisher.lookupPublishedArtifact, 'function');
  let reads = 0;
  let sleeps = 0;
  await assert.rejects(publisher.lookupPublishedArtifact(async () => {reads++; throw new Error('registry denied');},
    {now: () => 0, sleep: async () => {sleeps++;}}), /registry denied/);
  assert.equal(reads, 1);
  assert.equal(sleeps, 0);
});

test('readback rejects a response arriving after its admission budget', async () => {
  assert.equal(typeof publisher.lookupPublishedArtifact, 'function');
  let time = 0;
  let sleeps = 0;
  const result = await publisher.lookupPublishedArtifact(async () => {time = 360001; return {name: 'late'};},
    {now: () => time, sleep: async () => {sleeps++;}});
  assert.equal(result, null);
  assert.equal(sleeps, 0);
});

test('sub-millisecond readback budget admits no new network request', async () => {
  let time = 0;
  let clocks = 0;
  let reads = 0;
  let sleeps = 0;
  const result = await publisher.lookupPublishedArtifact(async () => {reads++; return null;}, {
    now: () => {if (clocks++ > 0 && time === 0) time = 359999.75; return time;},
    sleep: async ms => {sleeps++; time += ms;},
  });
  assert.equal(result, null);
  assert.equal(reads, 0);
  assert.equal(sleeps, 0);
});
