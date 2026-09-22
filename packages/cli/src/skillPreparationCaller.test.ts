import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('actual explicit skill sync consumes shared preparation before activation', async () => {
  const source = await readFile(new URL('../src/index.ts', import.meta.url), 'utf8');
  const activation = source.slice(source.indexOf('async function activatePreparedSkillUpdate('), source.indexOf('async function skillSync('));
  const sync = source.slice(source.indexOf('async function skillSync('), source.indexOf('async function installedRepositoryKnowledge('));
  assert.match(sync, /await prepareSkillUpdate\(/);
  assert.match(sync, /activatePreparedSkillUpdate\(/);
  assert.match(activation, /await installSkillBundle\(/);
});

test('actual relay starts independent staging and stops it before closing resources', async () => {
  const source = await readFile(new URL('../src/index.ts', import.meta.url), 'utf8');
  const relay = source.slice(source.indexOf('async function relayStart('), source.indexOf('export async function run('));
  assert.match(relay, /startSkillPreparationPump\(/);
  assert.ok(relay.indexOf('startSkillPreparationPump(') < relay.indexOf('await executeOneTask('));
  assert.match(relay, /await skillPreparationPump\.stop\(\);\s*vault\.close\(\)/);
  assert.doesNotMatch(relay, /await skillSync\(/);
});

test('actual provider staging uses independently isolated failures', async () => {
  const source = await readFile(new URL('../src/index.ts', import.meta.url), 'utf8');
  const relay = source.slice(source.indexOf('async function relayStart('), source.indexOf('export async function run('));
  assert.match(relay, /await prepareProvidersIndependently\(providerAdapters, assertRunning/);
});

test('actual relay consumes a verified cache only after an idle task boundary and falls back to fresh preparation', async () => {
  const source = await readFile(new URL('../src/index.ts', import.meta.url), 'utf8');
  const relay = source.slice(source.indexOf('async function relayStart('), source.indexOf('export async function run('));
  assert.ok(relay.indexOf('const result = await executeOneTask(') < relay.indexOf('await takeCachedSkillUpdate('));
  assert.match(relay, /const prepared = cached \|\| await prepareSkillUpdate\(/);
  assert.ok(relay.indexOf('await takeCachedSkillUpdate(') < relay.indexOf('await activatePreparedSkillUpdate('));
});

test('relay receipt attributes activation failures to a provider without raw error text', async () => {
  const source = await readFile(new URL('../src/index.ts', import.meta.url), 'utf8');
  const relay = source.slice(source.indexOf('async function relayStart('), source.indexOf('export async function run('));
  assert.match(relay, /skillActivationFailuresByProvider\[adapter\.providerId\]/);
  assert.match(relay, /skillActivationFailuresByProvider,/);
  assert.doesNotMatch(relay, /skillActivationFailureMessage/);
});
