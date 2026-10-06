import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {mkdtemp, mkdir, readFile, realpath, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname, resolve} from 'node:path';
import {promisify} from 'node:util';
import test from 'node:test';

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

for (const suffix of ['contracts', 'evidence-reduction', 'local-vault', 'policy', 'provider-adapters', 'relay-client', 'sdk', 'secure-store', 'skill-manager', 'task-runner', 'unknown']) {
  for (const defect of suffix === 'unknown' ? ['undeclared'] : ['missing', 'range']) {
    test(`official pack verifier rejects CLI ${suffix} ${defect} before invoking npm`, async () => {
      const parent = await realpath(tmpdir()), root = await mkdtemp(resolve(parent, 'dharma-cli-pins-'));
      try {
        for (const path of required) {
          await mkdir(dirname(resolve(root, path)), {recursive: true});
          await writeFile(resolve(root, path), path === 'THIRD_PARTY_NOTICES.md' ? 'Better Harness MIT' : 'synthetic');
        }
        for (const workspace of workspaces) {
          const manifest = JSON.parse(await readFile(resolve(sourceRoot, 'packages', workspace, 'package.json'), 'utf8'));
          if (workspace === 'cli') {
            const name = `@dharma-ai-labs/agent-fabric-${suffix}`;
            if (defect === 'undeclared') manifest.dependencies[name] = '0.0.1';
            else if (defect === 'missing') delete manifest.dependencies[name];
            else manifest.dependencies[name] = `^${manifest.dependencies[name]}`;
          }
          const path = resolve(root, 'packages', workspace, 'package.json');
          await mkdir(dirname(path), {recursive: true}); await writeFile(path, JSON.stringify(manifest));
        }
        await mkdir(resolve(root, 'scripts'), {recursive: true});
        await writeFile(resolve(root, 'scripts/verify.mjs'), verifier);
        await assert.rejects(execute(process.execPath, [resolve(root, 'scripts/verify.mjs')], {
          cwd: root, timeout: 10_000, env: {...process.env, npm_execpath: resolve(root, 'must-not-execute.mjs')},
        }), error => error.code === 1 && error.stdout === ''
          && error.stderr.includes(suffix === 'unknown' ? 'cli_runtime_package_unknown' : `cli_runtime_package_pin_invalid:${suffix}`)
          && !error.stderr.includes('MODULE_NOT_FOUND'));
      } finally {
        assert.equal(dirname(root), parent); assert.ok(root.startsWith(resolve(parent, 'dharma-cli-pins-')));
        await rm(root, {recursive: true, force: true});
      }
    });
  }
}
