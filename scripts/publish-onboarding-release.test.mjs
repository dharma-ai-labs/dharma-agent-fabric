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

test('CLI210 publishes only the reviewed bounded session diagnostic', () => {
  assert.deepEqual(approvedPackages.filter(item => !item.existingArtifact).map(item => [item.workspace, item.version]), [
    ['packages/cli', '0.2.210'],
  ]);
});

test('release preserves the three cryptographically reconciled runtime artifacts', () => {
  for (const [name, source, expected] of [
    ['agent-fabric-secure-store', '1b8483f59dc1ba9f7aa0aef78ca984f309714e61', 'sha512-n3nah4kTTqhx+VKdrT/zzomGo8yxCaW44y4JrlAb3G+DhOl802VUzwhniCU9eAXucvp4Uhu7VXMKmSkVYEHwGw=='],
    ['agent-fabric-relay-client', '1b8483f59dc1ba9f7aa0aef78ca984f309714e61', 'sha512-slzUPm+stPzF99vy6D0w2YWzT5wcDDq4zgJxq7JQBc/QB6v2JOPDK4t5NCIAeNW74E6W4J8qmJ6oGAvuKjxr4A=='],
    ['agent-fabric-local-vault', '51c3a9ae10f43ff80efa4b0b63212c8ef2b7a824', 'sha512-cPbjNh+//3PiibUDhMCNsQ8oTZmlRbd871aeIDpfnWwp6V5hiQ4NXFSjCVOEIwu4bHoM99AnZBI5dTuziHdbaQ=='],
  ]) {
    assert.deepEqual(approvedPackages.find(item => item.name === `@dharma-ai-labs/${name}`).existingArtifact,
      {source, integrity: expected});
  }
});

function provenanceFixture(item, packed, source = head) {
  const statement = {predicateType: 'https://slsa.dev/provenance/v1',
    subject: [{name: `pkg:npm/${item.name.replace('@', '%40')}@${item.version}`,
      digest: {sha512: Buffer.from(packed.integrity.replace(/^sha512-/, ''), 'base64').toString('hex')}}],
    predicate: {buildDefinition: {
      externalParameters: {workflow: {ref: 'refs/heads/main',
        repository: 'https://github.com/dharma-ai-labs/dharma-agent-fabric', path: '.github/workflows/publish.yml'}},
      resolvedDependencies: [{digest: {gitCommit: source},
        uri: 'git+https://github.com/dharma-ai-labs/dharma-agent-fabric@refs/heads/main'}],
    }}};
  return {attestations: [{bundle: {dsseEnvelope: {payload: Buffer.from(JSON.stringify(statement)).toString('base64')}}}]};
}

test('delayed provenance is read within the bound without retrying publication', async () => {
  assert.equal(typeof publisher.verifyPublishedProvenance, 'function');
  const item = approvedPackages.at(-1), packed = {integrity: 'sha512-YQ=='};
  let time = 0, reads = 0;
  await publisher.verifyPublishedProvenance(item, packed, head, async timeout => {
    assert.ok(timeout > 0 && timeout <= 30000); reads++;
    return time >= 180000 ? provenanceFixture(item, packed) : null;
  }, {now: () => time, sleep: async ms => {time += ms;}});
  assert.equal(reads, 7); assert.equal(time, 180000);
});

for (const defect of ['malformed', 'wrong-source', 'wrong-subject', 'denied']) {
  test(`provenance ${defect} fails immediately without retry`, async () => {
    const item = approvedPackages.at(-1), packed = {integrity: 'sha512-YQ=='};
    let reads = 0, sleeps = 0;
    await assert.rejects(publisher.verifyPublishedProvenance(item, packed, head, async () => {
      reads++;
      if (defect === 'denied') throw new Error('registry denied');
      if (defect === 'malformed') return {};
      return provenanceFixture(defect === 'wrong-subject' ? {...item, version: '9.9.9'} : item,
        packed, defect === 'wrong-source' ? 'b'.repeat(40) : head);
    }, {now: () => 0, sleep: async () => {sleeps++;}}));
    assert.equal(reads, 1); assert.equal(sleeps, 0);
  });
}

test('missing provenance exhausts only bounded reads and cannot publish the next package', async () => {
  const {io, effects} = fixture();
  const original = io.verifyPublished;
  let reads = 0, time = 0;
  io.verifyPublished = async (item, packed, metadata, source) => {
    if (item.name !== '@dharma-ai-labs/agent-fabric') return original(item, packed, metadata, source);
    await publisher.verifyPublishedProvenance(item, packed, source, async () => {reads++; return null;},
      {now: () => time, sleep: async ms => {time += ms;}});
  };
  await assert.rejects(publishBoundedRelease(head, io), /published provenance not visible/);
  assert.equal(reads, 12); assert.equal(time, 330000);
  assert.deepEqual(effects, ['@dharma-ai-labs/agent-fabric']);
});

test('provenance arriving beyond the deadline cannot be accepted', async () => {
  const item = approvedPackages.at(-1), packed = {integrity: 'sha512-YQ=='};
  let time = 0, reads = 0, sleeps = 0;
  await assert.rejects(publisher.verifyPublishedProvenance(item, packed, head, async () => {
    reads++; time = 360001; return provenanceFixture(item, packed);
  }, {now: () => time, sleep: async () => {sleeps++;}}), /published provenance not visible/);
  assert.equal(reads, 1); assert.equal(sleeps, 0);
});

for (const name of ['agent-fabric-contracts', 'agent-fabric-secure-store', 'agent-fabric-relay-client', 'agent-fabric-local-vault',
  'agent-fabric-provider-adapters', 'agent-fabric-task-runner', 'agent-fabric-evidence-reduction']) {
  for (const defect of ['missing', 'changed']) {
    test(`reconciled ${name} ${defect} blocks every write and cannot be republished`, async () => {
      const {io, effects} = fixture();
      const lookup = io.lookup, pack = io.pack;
      if (defect === 'missing') io.lookup = async item => item.name === `@dharma-ai-labs/${name}` ? null : lookup(item);
      else io.pack = async item => item.name === `@dharma-ai-labs/${name}` ? {integrity: 'changed', filename: 'changed.tgz'} : pack(item);
      await assert.rejects(publishBoundedRelease(head, io), /reconciled artifact/);
      assert.deepEqual(effects, []);
    });
  }
}

test('CLI210 keeps all seven dependency packages immutable', () => {
  assert.deepEqual(approvedPackages.filter(item => item.existingArtifact).map(item => [item.workspace, item.version]), [
    ['packages/contracts', '0.1.16'], ['packages/provider-adapters', '0.1.36'],
    ['packages/task-runner', '0.1.38'], ['packages/evidence-reduction', '0.2.35'], ['packages/secure-store', '0.1.10'],
    ['packages/relay-client', '0.2.33'], ['packages/local-vault', '0.1.31'],
  ]);
});

function releaseSnapshot() {
  const root = join(import.meta.dirname, '..');
  const git = (...args) => execFileSync('git', args, {cwd: root, encoding: 'utf8'}).trim();
  const baseline = 'beda0e1416e7f965101618486a48f4a289cb4d7f';
  const reviewed = baseline;
  assert.equal(git('rev-parse', `${reviewed}^{tree}`), 'ff8d97ad604da6dc9ec63574ca27135d0285bcbc');
  const baselineCliManifest = JSON.parse(git('show', `${baseline}:packages/cli/package.json`));
  const cliManifest = structuredClone(baselineCliManifest); cliManifest.version = '0.2.210';
  for (const [name, version] of [['provider-adapters', '0.1.36'], ['task-runner', '0.1.38'], ['evidence-reduction', '0.2.35']]) {
    cliManifest.dependencies[`@dharma-ai-labs/agent-fabric-${name}`] = version;
  }
  const baselineRuntimeManifests = Object.fromEntries(['secure-store', 'relay-client', 'local-vault',
    'provider-adapters', 'task-runner', 'evidence-reduction', 'lifecycle-adapter'].map(name =>
    [`packages/${name}`, JSON.parse(git('show', `${baseline}:packages/${name}/package.json`))]));
  const runtimeManifests = structuredClone(baselineRuntimeManifests);
  runtimeManifests['packages/provider-adapters'].version = '0.1.36';
  for (const [name, version] of [['task-runner', '0.1.38'], ['evidence-reduction', '0.2.35']]) {
    runtimeManifests[`packages/${name}`].version = version;
    runtimeManifests[`packages/${name}`].dependencies['@dharma-ai-labs/agent-fabric-provider-adapters'] = '0.1.36';
  }
  runtimeManifests['packages/lifecycle-adapter'].dependencies['@dharma-ai-labs/agent-fabric-evidence-reduction'] = '0.2.35';
  const baselineLock = JSON.parse(git('show', `${baseline}:package-lock.json`));
  const lock = structuredClone(baselineLock); lock.packages['packages/cli'].version = '0.2.210';
  for (const [name, version] of [['provider-adapters', '0.1.36'], ['task-runner', '0.1.38'], ['evidence-reduction', '0.2.35']]) {
    lock.packages[`packages/${name}`].version = version;
    lock.packages['packages/cli'].dependencies[`@dharma-ai-labs/agent-fabric-${name}`] = version;
  }
  for (const name of ['task-runner', 'evidence-reduction']) {
    lock.packages[`packages/${name}`].dependencies['@dharma-ai-labs/agent-fabric-provider-adapters'] = '0.1.36';
  }
  lock.packages['packages/lifecycle-adapter'].dependencies['@dharma-ai-labs/agent-fabric-evidence-reduction'] = '0.2.35';
  const baselineCliSource = execFileSync('git', ['show', `${baseline}:packages/cli/src/index.ts`],
    {cwd: root, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024});
  // Historical guard fixtures must use their qualified artifact source, not
  // whichever unpublished CLI is currently being prepared in this checkout.
  const qualified209 = 'beda0e1416e7f965101618486a48f4a289cb4d7f';
  const historical = path => execFileSync('git', ['show', `${qualified209}:${path}`],
    {cwd: root, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024});
  const cliSource = historical('packages/cli/src/index.ts');
  // Exercise committed candidate metadata, not a claim of clean release eligibility.
  const snapshot = {head: reviewed, ref: 'refs/heads/main', tree: git('rev-parse', `${baseline}^{tree}`),
    dirty: '', lifecycleLauncher: git('ls-tree', reviewed, 'packages/lifecycle-adapter/bin/run.mjs'),
    changed: git('diff', '--name-only', baseline, reviewed).split('\n').filter(Boolean), untracked: [],
    baselineManifest: JSON.parse(git('show', `${baseline}:package.json`)),
    manifest: JSON.parse(git('show', `${reviewed}:package.json`)), baselineCliManifest, cliManifest, baselineLock, lock,
    baselineCliSource, cliSource, baselineRuntimeManifests, runtimeManifests,
    productSourceHashes:Object.fromEntries(Object.keys(publisher.approvedProductSourceHashes).map(path=>
      [path,publisher.sourceTextSha256(historical(path))]))};
  return snapshot;
}

test('frozen source admits only exact CLI210 pins and reviewed session diagnostic bytes', () => {
  const snapshot = releaseSnapshot(), reviewed = snapshot.head, baselineCliSource = snapshot.baselineCliSource;
  assert.doesNotThrow(() => assertSourceSnapshot(reviewed, snapshot));
  assert.doesNotThrow(() => assertSourceSnapshot(reviewed, { ...snapshot, changed: [
    'scripts/publish-onboarding-release.mjs', 'scripts/publish-onboarding-release.test.mjs',
    'packages/cli/package.json', 'package-lock.json', 'packages/cli/src/index.ts'] }));
  for (const forbidden of ['packages/cli/src/unreviewed.ts', 'packages/secure-store/src/index.ts', '.github/workflows/publish.yml',
    'packages/task-runner/src/index.ts', 'packages/task-runner/src/index.test.ts', 'packages/task-runner/README.md',
    'packages/contracts/package.json', 'apps/relay-gateway/src/protocol.ts',
    'packages/secure-store/package.json', 'packages/relay-client/package.json', 'packages/local-vault/package.json',
    'packages/provider-adapters/package.json', 'packages/task-runner/package.json',
    'packages/evidence-reduction/package.json', 'packages/lifecycle-adapter/package.json']) {
    assert.throws(() => assertSourceSnapshot(reviewed, {...snapshot, changed: [...snapshot.changed, forbidden]}),
      /unreviewed product source delta/);
  }
  assert.throws(() => assertSourceSnapshot(reviewed, {...snapshot, cliManifest: {...snapshot.cliManifest, dependencies: {}}}), /CLI manifest delta/);
  const foreignLock = structuredClone(snapshot.lock); foreignLock.packages['packages/cli'].dependencies = {};
  assert.throws(() => assertSourceSnapshot(reviewed, {...snapshot, lock: foreignLock}), /lockfile delta/);
  assert.throws(() => assertSourceSnapshot(reviewed, {...snapshot, cliSource: baselineCliSource}), /CLI source delta/);
  assert.throws(() => assertSourceSnapshot(reviewed, {...snapshot, cliSource: snapshot.cliSource + '\n// unrelated\n'}), /CLI source delta/);
  for (const baselineCliSource of ['', "const VERSION = '0.2.209';\nconst VERSION = '0.2.209';\n"]) {
    assert.throws(() => assertSourceSnapshot(reviewed, {...snapshot, baselineCliSource}), /CLI version anchor required/);
  }
});

test('historical CLI209 guard still rejects the newly prepared CLI210 bytes', () => {
  const snapshot=releaseSnapshot(), current=readFileSync(join(import.meta.dirname,'../packages/cli/src/index.ts'),'utf8');
  assert.throws(()=>assertSourceSnapshot(snapshot.head,{...snapshot,cliSource:current}),/CLI source delta/);
});

test('runtime admission rejects altered dependencies, added manifests and old nested store pins', () => {
  for (const path of ['packages/secure-store', 'packages/relay-client', 'packages/local-vault',
    'packages/provider-adapters', 'packages/task-runner', 'packages/evidence-reduction', 'packages/lifecycle-adapter']) {
    const snapshot = releaseSnapshot(); snapshot.runtimeManifests[path].version = '999.0.0';
    assert.throws(() => assertSourceSnapshot(snapshot.head, snapshot), /runtime manifest delta/);
  }
  const ranged = releaseSnapshot();
  ranged.runtimeManifests['packages/relay-client'].dependencies['@dharma-ai-labs/agent-fabric-secure-store'] = '^0.1.10';
  assert.throws(() => assertSourceSnapshot(ranged.head, ranged), /runtime manifest delta/);
  const added = releaseSnapshot(); added.runtimeManifests['packages/sdk'] = {};
  assert.throws(() => assertSourceSnapshot(added.head, added), /runtime manifest set/);
  const nested = releaseSnapshot();
  nested.lock.packages['packages/local-vault/node_modules/@dharma-ai-labs/agent-fabric-secure-store'] = {version: '0.1.8'};
  assert.throws(() => assertSourceSnapshot(nested.head, nested), /lockfile delta/);
  const stale = releaseSnapshot();
  stale.runtimeManifests['packages/task-runner'].dependencies['@dharma-ai-labs/agent-fabric-provider-adapters'] = '0.1.34';
  assert.throws(() => assertSourceSnapshot(stale.head, stale), /runtime manifest delta/);
  const lifecycle = releaseSnapshot();
  lifecycle.runtimeManifests['packages/lifecycle-adapter'].private = false;
  assert.throws(() => assertSourceSnapshot(lifecycle.head, lifecycle), /runtime manifest delta/);
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

test('verifies immutable dependencies before publishing only the CLI210 artifact', async () => {
  const { io, effects } = fixture();
  await publishBoundedRelease(head, io);
  assert.deepEqual(effects, [
    '@dharma-ai-labs/agent-fabric',
  ]);
  assert.deepEqual(approvedPackages.map((item) => [item.name, item.version]), [
    ['@dharma-ai-labs/agent-fabric-contracts', '0.1.16'],
    ['@dharma-ai-labs/agent-fabric-provider-adapters', '0.1.36'],
    ['@dharma-ai-labs/agent-fabric-task-runner', '0.1.38'],
    ['@dharma-ai-labs/agent-fabric-evidence-reduction', '0.2.35'],
    ['@dharma-ai-labs/agent-fabric-secure-store', '0.1.10'],
    ['@dharma-ai-labs/agent-fabric-relay-client', '0.2.33'],
    ['@dharma-ai-labs/agent-fabric-local-vault', '0.1.31'],
    ['@dharma-ai-labs/agent-fabric', '0.2.210'],
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

for (const defect of ['head', 'ref', 'tree', 'dirty', 'changed', 'untracked', 'manifest', 'lifecycleLauncher', 'cliManifest', 'lock', 'cliSource', 'runtimeManifests', 'baselineRuntimeManifests']) {
  test(`source admission rejects changed ${defect}`, () => {
    const snapshot = releaseSnapshot(); snapshot.head = head;
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

test('an already published exact provider is verified without republishing', async () => {
  const vault = approvedPackages.find(item => item.name === '@dharma-ai-labs/agent-fabric-provider-adapters');
  assert.equal(vault.existingArtifact.source, '3038b4f53afcfa2825025e51f09d834c937115d4');
  const {io, effects, verified} = fixture();
  const lookup = io.lookup;
  io.lookup = async item => item.name === vault.name ? {name: item.name, version: item.version,
    dist: {integrity: integrity(item), attestations: {url: 'https://registry.npmjs.org/-/npm/v1/attestations/existing'}}} : lookup(item);
  await publishBoundedRelease(head, io);
  assert.equal(verified.find(item => item.name === vault.name).source, vault.existingArtifact.source);
  assert.deepEqual(effects, ['@dharma-ai-labs/agent-fabric']);
  for (const defect of ['integrity', 'provenance']) {
    const blocked = fixture();
    const lookup = blocked.io.lookup;
    blocked.io.lookup = async item => item.name === vault.name ? {name: item.name, version: item.version,
      dist: {integrity: defect === 'integrity' ? 'changed' : integrity(item),
        attestations: {url: 'https://registry.npmjs.org/-/npm/v1/attestations/existing'}}} : lookup(item);
    if (defect === 'provenance') blocked.io.verifyPublished = async () => {throw new Error('wrong source');};
    await assert.rejects(publishBoundedRelease(head, blocked.io));
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


test('publication rejects altered, missing or extra product-source hashes',()=>{
  const snapshot=releaseSnapshot();
  for(const [file] of Object.entries(snapshot.productSourceHashes)){
    const hashes={...snapshot.productSourceHashes,[file]:'0'.repeat(64)};
    assert.throws(()=>assertSourceSnapshot(snapshot.head,{...snapshot,productSourceHashes:hashes}),/product source bytes/);
  }
  assert.throws(()=>assertSourceSnapshot(snapshot.head,{...snapshot,productSourceHashes:{}}),/product source bytes/);
  assert.throws(()=>assertSourceSnapshot(snapshot.head,{...snapshot,productSourceHashes:{...snapshot.productSourceHashes,foreign:'0'.repeat(64)}}),/product source bytes/);
});
test('source text hashes follow Git LF text without weakening byte checks',()=>{
  assert.equal(publisher.sourceTextSha256('line1\r\nline2\r\n'),publisher.sourceTextSha256('line1\nline2\n'));
  assert.notEqual(publisher.sourceTextSha256('line1\nline2\n'),publisher.sourceTextSha256('line1\nline3\n'));
});
