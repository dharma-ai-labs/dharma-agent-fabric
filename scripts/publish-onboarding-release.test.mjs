import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { approvedPackages, assertSourceSnapshot, assertProvenance, publishBoundedRelease } from './publish-onboarding-release.mjs';

const head = 'a'.repeat(40);

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
  const published = new Map();
  const io = {
    verifySource: async (expected) => { assert.equal(expected, head); },
    manifest: async (item) => ({ name: item.name, version: item.version }),
    pack: async (item) => ({ integrity: `sha512-${item.version}`, filename: `${item.version}.tgz` }),
    lookup: async (item) => published.get(item.name) || null,
    publish: async (item) => {
      effects.push(item.name);
      published.set(item.name, { name: item.name, version: item.version, dist: {
        integrity: `sha512-${item.version}`, attestations: { url: `https://registry.npmjs.org/-/npm/v1/attestations/${encodeURIComponent(item.name)}@${item.version}` },
      } });
    },
    verifyPublished: async () => {},
  };
  return { io, effects };
}

test('publishes precisely the approved CLI correction without republishing dependencies', async () => {
  const { io, effects } = fixture();
  await publishBoundedRelease(head, io);
  assert.deepEqual(effects, approvedPackages.map((item) => item.name));
  assert.deepEqual(approvedPackages.map((item) => [item.name, item.version]), [['@dharma-ai-labs/agent-fabric', '0.2.180']]);
});

for (const defect of ['source', 'name', 'version', 'integrity', 'provenance']) {
  test(`rejects ${defect} mismatch before any publication`, async () => {
    const { io, effects } = fixture();
    if (defect === 'source') io.verifySource = async () => { throw new Error('source mismatch'); };
    if (defect === 'name' || defect === 'version') {
      const original = io.manifest;
      io.manifest = async (item) => ({ ...await original(item), ...(item.version === '0.2.180' ? { [defect]: 'wrong' } : {}) });
    }
    if (defect === 'integrity' || defect === 'provenance') io.lookup = async (item) => item.version === '0.2.180'
      ? { name: item.name, version: item.version, dist: { integrity: defect === 'integrity' ? 'wrong' : `sha512-${item.version}` } } : null;
    await assert.rejects(publishBoundedRelease(head, io));
    assert.deepEqual(effects, []);
  });
}

test('matching existing integrity and provenance are verified, never republished', async () => {
  const { io, effects } = fixture();
  let checked = 0;
  io.lookup = async (item) => ({ name: item.name, version: item.version, dist: {
    integrity: `sha512-${item.version}`, attestations: { url: `https://registry.npmjs.org/-/npm/v1/attestations/${encodeURIComponent(item.name)}@${item.version}` },
  } });
  io.verifyPublished = async () => { checked++; };
  await publishBoundedRelease(head, io);
  assert.equal(checked, 1);
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
    const snapshot = { head, ref: 'refs/heads/main', tree: '06e98ae37ac6b83ce4d6f32f3b40fcd720134e95',
      dirty: '', lifecycleLauncher: '100755 blob c7a500e580923098dff6121e1bf13a01f19b9b9d\tpackages/lifecycle-adapter/bin/run.mjs',
      changed: [], untracked: [], baselineManifest: { scripts: {} }, manifest: { scripts: {
        'pack:verify': 'node --test scripts/publish-workflow.test.mjs scripts/publish-onboarding-release.test.mjs scripts/verify-package-pins.test.mjs && node scripts/verify-package.mjs',
        'publish:onboarding': 'node scripts/publish-onboarding-release.mjs',
      } } };
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
