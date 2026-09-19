import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { parseSkillRolloutResponse } from './index.js';

for (const [name, response] of [
  ['missing success', { organizationId: 'org_test', rollout: null }],
  ['failed response', { ok: false, organizationId: 'org_test', rollout: null }],
  ['missing organization', { ok: true, rollout: null }],
  ['foreign organization', { ok: true, organizationId: 'org_other', rollout: null }],
  ['missing rollout', { ok: true, organizationId: 'org_test' }],
  ['undefined rollout', { ok: true, organizationId: 'org_test', rollout: undefined }],
  ['false rollout', { ok: true, organizationId: 'org_test', rollout: false }],
  ['zero rollout', { ok: true, organizationId: 'org_test', rollout: 0 }],
  ['empty string rollout', { ok: true, organizationId: 'org_test', rollout: '' }],
  ['array rollout', { ok: true, organizationId: 'org_test', rollout: [] }],
  ['empty rollout ID', { ok: true, organizationId: 'org_test', rollout: { id: '', bundle: {} } }],
  ['array bundle', { ok: true, organizationId: 'org_test', rollout: { id: 'rollout', bundle: [] } }],
  ['null bundle', { ok: true, organizationId: 'org_test', rollout: { id: 'rollout', bundle: null } }],
] as const) {
  test(`skill poll rejects ${name}`, () => assert.throws(() => parseSkillRolloutResponse(response, 'org_test')));
}

test('skill poll accepts explicit same-organization no-update only', () => {
  assert.equal(parseSkillRolloutResponse({ ok: true, organizationId: 'org_test', rollout: null }, 'org_test'), null);
});

test('skill poll retains package envelope for subsequent signature validation', () => {
  const rollout = { id: 'rollout', bundle: { bundleId: 'bundle' }, repositoryPackage: { schema: 'envelope' } };
  assert.equal(parseSkillRolloutResponse({ ok: true, organizationId: 'org_test', rollout }, 'org_test'), rollout);
});

test('actual skill synchronization parses the authenticated poll before no-update or materialization', async () => {
  const source = await readFile(new URL('../src/index.ts', import.meta.url), 'utf8');
  const sync = source.slice(source.indexOf('export async function prepareSkillUpdate('), source.indexOf('async function skillSync('));
  assert.match(sync, /const rollout = parseSkillRolloutResponse\(response, config\.organizationId\);/);
  assert.ok(sync.indexOf('await fabric.pollSkill(') < sync.indexOf('parseSkillRolloutResponse('));
  assert.ok(sync.indexOf('parseSkillRolloutResponse(') < sync.indexOf('if (!rollout)'));
  assert.ok(sync.indexOf('parseSkillRolloutResponse(') < sync.indexOf('verifySkillBundle('));
});
