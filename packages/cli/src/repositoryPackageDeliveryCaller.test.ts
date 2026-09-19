import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('skill sync statically negotiates and consumes the signed repository delivery protocol', async () => {
  const source = await readFile(new URL('../src/index.ts', import.meta.url), 'utf8');
  const preparation = source.slice(source.indexOf('export async function prepareSkillUpdate('), source.indexOf('async function skillSync('));
  const sync = source.slice(source.indexOf('async function activatePreparedSkillUpdate('), source.indexOf('async function relayStart('));
  assert.match(preparation, /repositoryPackageProtocol: 'dharma\.repository-package-envelope\/v1'/);
  assert.match(preparation, /await receiveRepositoryPackageDelivery\(/);
  assert.match(preparation, /\/repository-package`/);
  assert.match(preparation, /\$\{packageRoute\}\/index/);
  assert.match(preparation, /\$\{packageRoute\}\/chunks/);
  assert.ok(preparation.indexOf('await receiveRepositoryPackageDelivery(') < preparation.indexOf('await materializeInlineSkillFiles('));
  assert.match(sync, /await prepareSkillUpdate\(/);
  assert.match(sync, /repositoryDelivery\?\.assertCurrent\(\);\s*const receipt = await installSkillBundle/);
  assert.match(preparation, /await mkdir\(dirname\(target\),[^\n]+\);\s*assertCurrent\(\);\s*await writeFile/);
});
