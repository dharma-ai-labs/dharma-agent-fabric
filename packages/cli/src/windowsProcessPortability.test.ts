import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('Windows paths never require process.getuid before the platform guard', async () => {
  const implementation = await readFile(new URL('../src/skillPreparationTransaction.ts', import.meta.url), 'utf8');
  const privatePath = implementation.slice(implementation.indexOf('export async function assertPrivatePath('),
    implementation.indexOf('async function preflightAncestors('));
  assert.ok(privatePath.indexOf("process.platform !== 'win32'") < privatePath.indexOf('process.getuid'));
  const fixture = await readFile(new URL('../src/skillPreparation.test.ts', import.meta.url), 'utf8');
  const getuid = fixture.indexOf('const getuid = process.getuid');
  assert.ok(getuid > fixture.lastIndexOf("process.platform !== 'win32'", getuid));
  if (process.platform === 'win32') assert.equal(process.getuid, undefined);
});
