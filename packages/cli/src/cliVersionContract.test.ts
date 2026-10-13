import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import test from 'node:test';
import {run} from './index.js';

test('actual CLI dispatcher version agrees with its published package manifest', async () => {
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.deepEqual(await run(['--version']), {version: manifest.version});
});
test('official CLI bin reports the same exact version before setup preparation', async () => {
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('./bin.js', import.meta.url)), '--version'],
    {encoding: 'utf8', timeout: 15000});
  assert.equal(result.status, 0); assert.deepEqual(JSON.parse(result.stdout), {version: manifest.version});
});
