import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {mkdtemp, mkdir, readFile, realpath, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname, resolve} from 'node:path';
import {promisify} from 'node:util';
import test from 'node:test';
import {assertPreservedEvidenceManifest, assertPreservedEvidenceProvider, preservedEvidenceProvider} from './verify-preserved-provider-edge.mjs';

const execute = promisify(execFile), sourceRoot = resolve(import.meta.dirname, '..');
const baseline = process.env.DHARMA_PACK_VERIFIER_BASELINE_SHA;
if (baseline && !/^[a-f0-9]{40}$/.test(baseline)) throw new Error('verifier_baseline_invalid');
const verifier = baseline
  ? (await execute('git', ['show', `${baseline}:scripts/verify-package.mjs`], {cwd: sourceRoot})).stdout
  : await readFile(new URL('./verify-package.mjs', import.meta.url));
const workspaces = ['contracts', 'secure-store', 'policy', 'provider-adapters', 'better-harness-bridge',
  'evidence-reduction', 'relay-client', 'local-vault', 'task-runner', 'skill-manager', 'sdk', 'cli'];
const required = ['LICENSE', 'THIRD_PARTY_NOTICES.md', 'LICENSES/Qoder-Better-Harness-MIT.txt',
  '.agents/plugins/marketplace.json', 'plugins/dharma-agent-fabric/.codex-plugin/plugin.json',
  'plugins/dharma-agent-fabric/.mcp.json', 'plugins/dharma-agent-fabric/skills/dharma-agent-fabric/SKILL.md',
  'packages/cli/dist/index.js', 'packages/provider-adapters/dist/knowledge-server.js',
  ...['trajectory-capsule', 'evidence-request', 'evidence-response'].map(name => `packages/cli/dist/schemas/${name}.schema.json`)];
const preservedEvidenceManifest = JSON.parse((await execute('git',
  ['show', `${preservedEvidenceProvider.evidence.sourceTree}:package.json`], {cwd: sourceRoot})).stdout);

for (const suffix of ['contracts', 'evidence-reduction', 'local-vault', 'policy', 'provider-adapters', 'relay-client', 'sdk', 'secure-store', 'skill-manager', 'task-runner', 'unknown', 'preserved-evidence', 'preserved-evidence-other-cohort']) {
  const preservedEdge = suffix.startsWith('preserved-evidence');
  for (const defect of suffix === 'unknown' ? ['undeclared'] : preservedEdge ? ['rewritten'] : ['missing', 'range']) {
    test(preservedEdge ? `official pack verifier rejects same-version evidence provider rewrite ${suffix.endsWith('other-cohort') ? 'in another CLI cohort' : 'before invoking npm'}`
      : `official pack verifier rejects CLI ${suffix} ${defect} before invoking npm`, async () => {
      const parent = await realpath(tmpdir()), root = await mkdtemp(resolve(parent, 'dharma-cli-pins-'));
      try {
        for (const path of required) {
          await mkdir(dirname(resolve(root, path)), {recursive: true});
          await writeFile(resolve(root, path), path === 'THIRD_PARTY_NOTICES.md' ? 'Better Harness MIT' : 'synthetic');
        }
        for (const workspace of workspaces) {
          const manifest = workspace === 'evidence-reduction' && preservedEdge ? structuredClone(preservedEvidenceManifest)
            : JSON.parse(await readFile(resolve(sourceRoot, 'packages', workspace, 'package.json'), 'utf8'));
          if (workspace === 'cli' && !preservedEdge) {
            const name = `@dharma-ai-labs/agent-fabric-${suffix}`;
            if (defect === 'undeclared') manifest.dependencies[name] = '0.0.1';
            else if (defect === 'missing') delete manifest.dependencies[name];
            else manifest.dependencies[name] = `^${manifest.dependencies[name]}`;
          }
          if (workspace === 'evidence-reduction' && preservedEdge) {
            manifest.dependencies['@dharma-ai-labs/agent-fabric-provider-adapters'] = '0.1.38';
          }
          if (workspace === 'cli' && preservedEdge) {
            manifest.version = '0.2.213';
            manifest.dependencies[preservedEvidenceManifest.name] = preservedEvidenceManifest.version;
          }
          if (workspace === 'cli' && suffix === 'preserved-evidence-other-cohort') manifest.version = '0.2.214';
          const path = resolve(root, 'packages', workspace, 'package.json');
          await mkdir(dirname(path), {recursive: true}); await writeFile(path, JSON.stringify(manifest));
        }
        await mkdir(resolve(root, 'scripts'), {recursive: true});
        await writeFile(resolve(root, 'scripts/verify.mjs'), verifier);
        for (const name of ['verify-preserved-provider-edge.mjs', 'preserved-evidence-provider-0.1.37.json']) {
          await writeFile(resolve(root, 'scripts', name), await readFile(resolve(sourceRoot, 'scripts', name)));
        }
        await assert.rejects(execute(process.execPath, [resolve(root, 'scripts/verify.mjs')], {
          cwd: root, timeout: 10_000, env: {...process.env, npm_execpath: resolve(root, 'must-not-execute.mjs')},
        }), error => error.code === 1 && error.stdout === ''
          && error.stderr.includes(preservedEdge ? 'preserved_evidence_manifest'
            : suffix === 'unknown' ? 'cli_runtime_package_unknown' : `cli_runtime_package_pin_invalid:${suffix}`)
          && !error.stderr.includes('MODULE_NOT_FOUND'));
      } finally {
        assert.equal(dirname(root), parent); assert.ok(root.startsWith(resolve(parent, 'dharma-cli-pins-')));
        await rm(root, {recursive: true, force: true});
      }
    });
  }
}

test('new dependency cohort advances versions without rewriting the preserved artifact or relying on its overridden edge', async () => {
  const root = JSON.parse(await readFile(resolve(sourceRoot, 'package.json'), 'utf8'));
  const lock = JSON.parse(await readFile(resolve(sourceRoot, 'package-lock.json'), 'utf8'));
  const evidence = JSON.parse(await readFile(resolve(sourceRoot, 'packages/evidence-reduction/package.json'), 'utf8'));
  assertPreservedEvidenceManifest(preservedEvidenceManifest);
  const provider = preservedEvidenceProvider.provider;
  const cli = JSON.parse(await readFile(resolve(sourceRoot, 'packages/cli/package.json'), 'utf8'));
  const lifecycle = JSON.parse(await readFile(resolve(sourceRoot, 'packages/lifecycle-adapter/package.json'), 'utf8'));
  const vault = JSON.parse(await readFile(resolve(sourceRoot, 'packages/local-vault/package.json'), 'utf8'));
  assert.equal(cli.version, '0.2.214');
  const cliSource = await readFile(resolve(sourceRoot, 'packages/cli/src/index.ts'), 'utf8');
  assert.ok(cliSource.includes(`const VERSION = '${cli.version}';`));
  assert.equal(evidence.version, '0.2.37');
  assert.equal(cli.dependencies[evidence.name], evidence.version);
  assert.equal(lifecycle.dependencies[evidence.name], evidence.version);
  assert.equal(vault.version, '0.1.34');
  assert.equal(vault.dependencies[evidence.name], evidence.version);
  assert.equal(cli.dependencies[vault.name], vault.version);
  assert.equal(evidence.dependencies[provider.name], '0.1.38');
  const artifact = lock.packages['packages/evidence-reduction/node_modules/' + provider.name];
  assert.equal(artifact, undefined);
  for (const [path, entry] of Object.entries(lock.packages)) {
    if (path.endsWith('/node_modules/' + provider.name)) assert.notEqual(entry.version, provider.version);
    if (path.endsWith('/node_modules/' + evidence.name)) assert.notEqual(entry.version, preservedEvidenceManifest.version);
  }
  assert.equal(root.overrides?.zod, '4.6.6');
  const copies = Object.entries(lock.packages).filter(([path]) => /(^|\/)node_modules\/zod$/.test(path));
  assert.ok(copies.length > 0);
  for (const [, copy] of copies) {
    assert.equal(copy.version, '4.6.6');
    assert.equal(copy.resolved, 'https://registry.npmjs.org/zod/-/zod-4.6.6.tgz');
    assert.equal(copy.integrity, 'sha512-4UmzQUF5fxvfcYHlbjBmejU+w+hbDnWFx4aS8kBx7nPBHcO2SqPbpAG8snbdg+Xse4pRefR98hgjFgIMCI/UhA==');
  }
});

test('one fixed preserved evidence/provider artifact edge is qualified without changing its manifest', async () => {
  const expected = preservedEvidenceProvider;
  const evidenceManifest = structuredClone(preservedEvidenceManifest);
  const installedManifest = JSON.parse((await execute('git', ['show', 'e7f2f69a6ab2a7805b55de7cc439bb7837db14eb:packages/provider-adapters/package.json'], {cwd: sourceRoot})).stdout);
  const value = {cliVersion: '0.2.213', providerVersion: '0.1.38', taskRunnerVersion: '0.1.40', relayClientVersion: '0.2.35',
    evidenceManifest, sourceTree: expected.evidence.sourceTree, worktreeChanges: '', untracked: '',
    lockEntry: {version: expected.provider.version, resolved: expected.provider.resolved, integrity: expected.provider.integrity},
    installedManifest, runtimeHashes: structuredClone(expected.provider.runtimeHashes)};
  assert.doesNotThrow(() => assertPreservedEvidenceProvider(value));
  for (const patch of [{cliVersion: '0.2.212'}, {providerVersion: '0.1.39'}, {taskRunnerVersion: '0.1.39'},
    {relayClientVersion: '0.2.34'}, {sourceTree: 'foreign'}, {worktreeChanges: 'src/index.ts'}, {untracked: 'src/foreign.ts'}]) {
    assert.throws(() => assertPreservedEvidenceProvider({...value, ...patch}));
  }
  for (const field of ['version', 'resolved', 'integrity']) {
    assert.throws(() => assertPreservedEvidenceProvider({...value, lockEntry: {...value.lockEntry, [field]: 'foreign'}}));
  }
  assert.throws(() => assertPreservedEvidenceProvider({...value, lockEntry: {...value.lockEntry, link: true}}));
  assert.throws(() => assertPreservedEvidenceProvider({...value, evidenceManifest: {...evidenceManifest, version: '0.2.37'}}));
  assert.throws(() => assertPreservedEvidenceProvider({...value, installedManifest: {...installedManifest, version: '0.1.38'}}));
  const changed = structuredClone(value); changed.runtimeHashes['dist/index.js'] = '0'.repeat(64);
  assert.throws(() => assertPreservedEvidenceProvider(changed), /installed_runtime/);
  const extra = structuredClone(value); extra.runtimeHashes['dist/foreign.js'] = '0'.repeat(64);
  assert.throws(() => assertPreservedEvidenceProvider(extra), /installed_runtime/);
  const missing = structuredClone(value); delete missing.runtimeHashes['dist/index.js'];
  assert.throws(() => assertPreservedEvidenceProvider(missing), /installed_runtime/);
});
