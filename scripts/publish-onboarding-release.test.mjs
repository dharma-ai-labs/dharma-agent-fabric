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
const integrity = item => item.existingArtifact?.integrity || `sha512-${item.version}`;

test('frozen source requalification candidate admits only the bounded CLI200 release delta', () => {
  const root = join(import.meta.dirname, '..');
  const git = (...args) => execFileSync('git', args, {cwd: root, encoding: 'utf8'}).trim();
  const baseline = 'c45261f9bf28b7f19ffece0b1d50e88dd1048990';
  const reviewed = baseline;
  assert.equal(git('rev-parse', `${reviewed}^{tree}`), '77586a4cde50a6fcaf632ab73abcf01c30b0b6db');
  const baselineCliManifest = JSON.parse(git('show', `${baseline}:packages/cli/package.json`));
  const cliManifest = {...baselineCliManifest, version: '0.2.200'};
  const baselineLock = JSON.parse(git('show', `${baseline}:package-lock.json`));
  const lock = structuredClone(baselineLock); lock.packages['packages/cli'].version = '0.2.200';
  // Exercise committed candidate metadata, not a claim of clean release eligibility.
  const snapshot = {head: reviewed, ref: 'refs/heads/main', tree: git('rev-parse', `${baseline}^{tree}`),
    dirty: '', lifecycleLauncher: git('ls-tree', reviewed, 'packages/lifecycle-adapter/bin/run.mjs'),
    changed: git('diff', '--name-only', baseline, reviewed).split('\n').filter(Boolean), untracked: [],
    baselineManifest: JSON.parse(git('show', `${baseline}:package.json`)),
    manifest: JSON.parse(git('show', `${reviewed}:package.json`)), baselineCliManifest, cliManifest, baselineLock, lock};
  assert.doesNotThrow(() => assertSourceSnapshot(reviewed, snapshot));
  assert.doesNotThrow(() => assertSourceSnapshot(reviewed, { ...snapshot, changed: [
    'scripts/publish-onboarding-release.mjs', 'scripts/publish-onboarding-release.test.mjs',
    'packages/cli/package.json', 'package-lock.json'] }));
  for (const forbidden of ['packages/cli/src/unreviewed.ts', 'packages/secure-store/src/index.ts', '.github/workflows/publish.yml',
    'packages/task-runner/src/index.ts', 'packages/task-runner/src/index.test.ts', 'packages/task-runner/README.md',
    'packages/contracts/package.json', 'apps/relay-gateway/src/protocol.ts']) {
    assert.throws(() => assertSourceSnapshot(reviewed, {...snapshot, changed: [...snapshot.changed, forbidden]}),
      /unreviewed product source delta/);
  }
  assert.throws(() => assertSourceSnapshot(reviewed, {...snapshot, cliManifest: {...cliManifest, dependencies: {}}}), /CLI manifest delta/);
  const foreignLock = structuredClone(lock); foreignLock.packages['packages/cli'].dependencies = {};
  assert.throws(() => assertSourceSnapshot(reviewed, {...snapshot, lock: foreignLock}), /lockfile delta/);
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
  for (const item of approvedPackages.filter(item => item.existingArtifact)) {
    published.set(item.name, {name: item.name, version: item.version,
      dist: {integrity: integrity(item), attestations: {url: 'https://registry.npmjs.org/-/npm/v1/attestations/existing'}}});
  }
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

test('verifies the immutable dependency closure and publishes only CLI200', async () => {
  const { io, effects } = fixture();
  await publishBoundedRelease(head, io);
  assert.deepEqual(effects, [
    '@dharma-ai-labs/agent-fabric',
  ]);
  assert.deepEqual(approvedPackages.map((item) => [item.name, item.version]), [
    ['@dharma-ai-labs/agent-fabric-contracts', '0.1.16'],
    ['@dharma-ai-labs/agent-fabric-provider-adapters', '0.1.34'],
    ['@dharma-ai-labs/agent-fabric-task-runner', '0.1.36'],
    ['@dharma-ai-labs/agent-fabric-evidence-reduction', '0.2.33'],
    ['@dharma-ai-labs/agent-fabric-local-vault', '0.1.29'],
    ['@dharma-ai-labs/agent-fabric', '0.2.200'],
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

for (const defect of ['head', 'ref', 'tree', 'dirty', 'changed', 'untracked', 'manifest', 'lifecycleLauncher', 'cliManifest', 'lock']) {
  test(`source admission rejects changed ${defect}`, () => {
    const manifest = { scripts: {
      'pack:verify': 'node --test scripts/publish-workflow.test.mjs scripts/publish-onboarding-release.test.mjs scripts/verify-package-pins.test.mjs && node scripts/verify-package.mjs',
      'publish:onboarding': 'node scripts/publish-onboarding-release.mjs',
    } };
    const snapshot = { head, ref: 'refs/heads/main', tree: '77586a4cde50a6fcaf632ab73abcf01c30b0b6db',
      dirty: '', lifecycleLauncher: '100755 blob c7a500e580923098dff6121e1bf13a01f19b9b9d\tpackages/lifecycle-adapter/bin/run.mjs',
      changed: [], untracked: [], baselineManifest: structuredClone(manifest), manifest,
      baselineCliManifest: {name: '@dharma-ai-labs/agent-fabric', version: '0.2.188', dependencies: {}},
      cliManifest: {name: '@dharma-ai-labs/agent-fabric', version: '0.2.200', dependencies: {}},
      baselineLock: {packages: {'packages/cli': {version: '0.2.188'}}},
      lock: {packages: {'packages/cli': {version: '0.2.200'}}} };
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

test('uncertain CLI publication is not retried after its dependency is verified', async () => {
  const { io, effects } = fixture();
  io.publish = async (item) => {
    effects.push(item.name);
    if (item.name === '@dharma-ai-labs/agent-fabric') throw new Error('uncertain CLI publication');
  };
  const lookup = io.lookup;
  io.lookup = async (item, justPublished) => justPublished ? {name: item.name, version: item.version,
    dist: {integrity: integrity(item), attestations: {url: 'https://registry.npmjs.org/-/npm/v1/attestations/fixture'}}} : lookup(item);
  await assert.rejects(publishBoundedRelease(head, io), /uncertain CLI publication/);
  assert.deepEqual(effects, ['@dharma-ai-labs/agent-fabric']);
});

test('published vault requires its original immutable bytes and publisher without republishing', async () => {
  const vault = approvedPackages.find(item => item.name === '@dharma-ai-labs/agent-fabric-local-vault');
  assert.equal(vault.existingArtifact.source, 'bbaeecb75a3139c6a5b65b6dc0cd351fb10b872d');
  assert.equal(vault.existingArtifact.integrity,
    'sha512-h2Bq42d9cbGFiJzXjffI3fGoGnXEsJvmlyelr8vQHG2Ry1hyG+vTl0a6x9N658WGNpGB+hEgpN1AFunZjr7OHg==');
  const {io, effects, verified} = fixture();
  await publishBoundedRelease(head, io);
  assert.equal(verified.find(item => item.name === vault.name).source, vault.existingArtifact.source);
  assert.deepEqual(effects, ['@dharma-ai-labs/agent-fabric']);
  for (const missing of [true, false]) {
    const blocked = fixture();
    if (missing) {
      const lookup = blocked.io.lookup;
      blocked.io.lookup = async item => item.name === vault.name ? null : lookup(item);
    } else {
      const pack = blocked.io.pack;
      blocked.io.pack = async item => item.name === vault.name
        ? {integrity: 'changed-vault', filename: 'changed.tgz'} : pack(item);
    }
    await assert.rejects(publishBoundedRelease(head, blocked.io), /reconciled artifact/);
    assert.deepEqual(blocked.effects, []);
  }
});

test('already reconciled contracts require their exact original publication source', async () => {
  const {io, verified} = fixture();
  await publishBoundedRelease(head, io);
  assert.equal(verified.find(x => x.name === approvedPackages[0].name).source, existingContractsSource);
  assert.ok(verified.filter(x => x.name !== approvedPackages[0].name).every(x => x.source ===
    (approvedPackages.find(item => item.name === x.name).existingArtifact?.source || head)));
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

test('readback makes at most twelve reads with no unused final delay', async () => {
  assert.equal(typeof publisher.lookupPublishedArtifact, 'function');
  let time = 0;
  let reads = 0;
  const result = await publisher.lookupPublishedArtifact(async () => {reads++; return null;},
    {now: () => time, sleep: async ms => {time += ms;}});
  assert.equal(result, null);
  assert.equal(time, 330000);
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
