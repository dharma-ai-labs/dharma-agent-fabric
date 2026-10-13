import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';
import test from 'node:test';

test('the full CLI suite keeps failed assertions in the bounded log tail', async () => {
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(manifest.scripts.test, 'node --test --test-reporter=spec dist/*.test.js');
  const root = await mkdtemp(resolve(tmpdir(), 'fabric-test-reporter-'));
  try {
    const file = resolve(root, 'synthetic-reporter.test.mjs');
    await writeFile(file, "import test from 'node:test'; import assert from 'node:assert/strict';\n"
      + "test('synthetic_failure_must_remain_visible', () => assert.equal(1, 2));\n"
      + "for (let n = 0; n < 100; n++) test('later_pass_' + n + '_' + 'x'.repeat(100), () => {});\n");
    const run = (reporter: string) => spawnSync(process.execPath, ['--test', `--test-reporter=${reporter}`, file], {
      cwd: root, encoding: 'utf8', timeout: 15_000, windowsHide: true, maxBuffer: 128 * 1024,
      env: process.platform === 'win32' ? {SystemRoot: process.env.SystemRoot, NO_COLOR: '1'} : {NO_COLOR: '1'},
    });
    const baseline = run('tap');
    assert.equal(baseline.error, undefined);
    assert.equal(baseline.status, 1);
    assert.doesNotMatch(`${baseline.stdout}\n${baseline.stderr}`.slice(-2048), /synthetic_failure_must_remain_visible/);
    const result = run('spec');
    assert.equal(result.error, undefined);
    assert.equal(result.status, 1, 'a failed assertion must still fail the process');
    const tail = `${result.stdout}\n${result.stderr}`.slice(-2048);
    assert.match(tail, /synthetic_failure_must_remain_visible/);
    assert.match(tail, /ERR_ASSERTION/);
    assert.match(tail, /tests 101/);
    assert.match(tail, /pass 100/);
    assert.match(tail, /fail 1/);
  } finally {
    assert.ok(root.startsWith(resolve(tmpdir(), 'fabric-test-reporter-')));
    await rm(root, {recursive: true, force: true});
  }
});
