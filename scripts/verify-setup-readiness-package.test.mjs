import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {mkdtemp, mkdir, readFile, realpath, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname, resolve} from 'node:path';
import {promisify} from 'node:util';
import test from 'node:test';

const execute = promisify(execFile);
for (const defect of ['pin', 'missing-export', 'wrong-export']) {
  test(`packed readiness verifier rejects ${defect} before packing or importing`, async () => {
    const parent = await realpath(tmpdir()), root = await mkdtemp(resolve(parent, 'dharma-readiness-verifier-'));
    try {
      await mkdir(resolve(root, 'scripts'), {recursive: true});
      await mkdir(resolve(root, 'packages/local-vault'), {recursive: true});
      await mkdir(resolve(root, 'packages/cli'), {recursive: true});
      const name = '@dharma-ai-labs/agent-fabric-local-vault';
      const manifest = {name, version: '0.1.27', exports: {'./setup-readiness': './dist/setupReadiness.js'}};
      const cli = {dependencies: {[name]: defect === 'pin' ? '0.1.26' : '0.1.27'}};
      if (defect === 'missing-export') delete manifest.exports;
      if (defect === 'wrong-export') manifest.exports['./setup-readiness'] = './dist/index.js';
      await writeFile(resolve(root, 'packages/local-vault/package.json'), JSON.stringify(manifest));
      await writeFile(resolve(root, 'packages/cli/package.json'), JSON.stringify(cli));
      const source = await readFile(new URL('./verify-setup-readiness-package.mjs', import.meta.url));
      await writeFile(resolve(root, 'scripts/verify.mjs'), source);
      await assert.rejects(execute(process.execPath, [resolve(root, 'scripts/verify.mjs')], {
        cwd: root, timeout: 10_000, env: {...process.env, npm_execpath: resolve(root, 'must-not-execute.mjs')},
      }), error => error.code === 1 && error.stdout === '' && /setup_readiness_package_pin_invalid/.test(error.stderr)
        && !/MODULE_NOT_FOUND/.test(error.stderr));
    } finally {
      assert.equal(dirname(root), parent);
      assert.ok(root.startsWith(resolve(parent, 'dharma-readiness-verifier-')));
      await rm(root, {recursive: true, force: true});
    }
  });
}
