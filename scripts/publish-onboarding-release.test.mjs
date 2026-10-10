import assert from 'node:assert/strict';
import test from 'node:test';
import { approvedPackages, assertSourceSnapshot, assertProvenance, publishBoundedRelease } from './publish-onboarding-release.mjs';

const head = 'a'.repeat(40);
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

test('publishes precisely the approved four releases in dependency order', async () => {
  const { io, effects } = fixture();
  await publishBoundedRelease(head, io);
  assert.deepEqual(effects, approvedPackages.map((item) => item.name));
  assert.deepEqual(approvedPackages.map((item) => item.version), ['0.1.15', '0.1.9', '0.2.32', '0.2.179']);
});

for (const defect of ['source', 'name', 'version', 'integrity', 'provenance']) {
  test(`rejects ${defect} mismatch before any publication`, async () => {
    const { io, effects } = fixture();
    if (defect === 'source') io.verifySource = async () => { throw new Error('source mismatch'); };
    if (defect === 'name' || defect === 'version') {
      const original = io.manifest;
      io.manifest = async (item) => ({ ...await original(item), ...(item.version === '0.2.179' ? { [defect]: 'wrong' } : {}) });
    }
    if (defect === 'integrity' || defect === 'provenance') io.lookup = async (item) => item.version === '0.2.179'
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
  assert.equal(checked, 4);
  assert.deepEqual(effects, []);
});

test('publication failure is not replayed and later packages remain unpublished', async () => {
  const { io, effects } = fixture();
  io.publish = async (item) => { effects.push(item.name); throw new Error('uncertain publish'); };
  await assert.rejects(publishBoundedRelease(head, io));
  assert.equal(effects.length, 1);
});

for (const defect of ['head', 'ref', 'tree', 'dirty', 'changed', 'untracked', 'manifest']) {
  test(`source admission rejects changed ${defect}`, () => {
    const snapshot = { head, ref: 'refs/heads/main', tree: 'd80a643d2eedcacab3ffd0612fd9c8ee9af82389',
      dirty: '', changed: [], untracked: [], baselineManifest: { scripts: {} }, manifest: { scripts: {
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
