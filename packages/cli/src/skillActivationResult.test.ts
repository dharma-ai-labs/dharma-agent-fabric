import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { Ajv2020 } from 'ajv/dist/2020.js';
import type { FormatsPlugin } from 'ajv-formats';
import { AgentFabricRequestError } from '@dharma-ai-labs/agent-fabric-relay-client';
import {
  nextSkillActivationResult, parseRelaySkillActivationState, readRelaySkillActivationState, relaySkillActivationPath,
  repositoryReadinessPendingCode, SkillActivationError, skillActivationErrorCode, type RelaySkillActivationState,
  type SkillActivationResult,
} from './skillActivationResult.js';

// G11 F14 (2026-11-06, endpoint 424a48bb): the relay caught every automatic preparation and
// activation error and only counted it, so setup ended with a bare shared_repository_pending.

const WORKSPACE = '5f0e7d0a-6a43-4c38-9d61-0c2b4cf0a9e1';
const ROLLOUT = '2b5bf2ac-0000-4000-8000-000000000001';
const BUNDLE = 'fbe79f65-0000-4000-8000-000000000002';

function state(providers: RelaySkillActivationState['providers']): RelaySkillActivationState {
  return {
    schema: 'dharma.relay-skill-activation/v1', workspaceId: WORKSPACE, updatedAt: '2026-11-06T06:30:00.000Z',
    counters: { preparationsCompleted: 0, preparationFailures: 2, activationsCompleted: 0, activationFailures: 5 },
    providers,
  };
}
const failed = (errorCode: string, at = '2026-11-06T06:30:00.000Z'): SkillActivationResult => ({
  at, outcome: 'failed', rolloutId: null, bundleId: null, errorCode,
});

test('an HQ rejection keeps its stable error code and never its message text', () => {
  const error = new AgentFabricRequestError(
    { error: { code: 'repository_package_access_denied', message: 'denied for token sk-live-secret' } }, 403, true);
  const code = skillActivationErrorCode(error, 'preparation');
  assert.equal(code, 'repository_package_access_denied');
  assert.doesNotMatch(code, /secret/);
});

test('an HQ rejection without a code reports its HTTP status', () => {
  assert.equal(skillActivationErrorCode(new AgentFabricRequestError(null, 503, false), 'preparation'), 'http_503');
  assert.equal(skillActivationErrorCode(new AgentFabricRequestError({ error: { message: 'down' } }, 502, false), 'preparation'),
    'http_502');
});

test('a coded local refusal reports its own code', () => {
  assert.equal(skillActivationErrorCode(new SkillActivationError('approval_required', 'R3 needs approval.'), 'activation'),
    'approval_required');
  assert.equal(skillActivationErrorCode(new SkillActivationError('repository_package_expired', 'expired'), 'preparation'),
    'repository_package_expired');
  assert.equal(skillActivationErrorCode(new Error('Skill bundle has expired.'), 'preparation'), 'skill_bundle_expired');
});

test('other failures report the stage and an errno code only', () => {
  assert.equal(skillActivationErrorCode(Object.assign(new Error('/home/user/secret path'), { code: 'EACCES' }), 'activation'),
    'install_failed:eacces');
  assert.equal(skillActivationErrorCode(new TypeError('fetch failed', { cause: Object.assign(new Error('x'), { code: 'ECONNREFUSED' }) }),
    'preparation'), 'preparation_failed:econnrefused');
  assert.equal(skillActivationErrorCode(new Error('Prepared skill tree does not match the signed content hash.'), 'activation'),
    'install_failed');
  assert.equal(skillActivationErrorCode('not an error', 'preparation'), 'preparation_failed');
});

test('an empty poll after an activation stays recorded as the installed release', () => {
  const activated: SkillActivationResult = { at: '2026-11-06T06:30:00.000Z', outcome: 'activated',
    rolloutId: ROLLOUT, bundleId: BUNDLE, errorCode: null };
  const empty: SkillActivationResult = { at: '2026-11-06T06:31:00.000Z', outcome: 'no_rollout',
    rolloutId: null, bundleId: null, errorCode: null };
  assert.deepEqual(nextSkillActivationResult(activated, empty),
    { at: '2026-11-06T06:31:00.000Z', outcome: 'up_to_date', rolloutId: ROLLOUT, bundleId: BUNDLE, errorCode: null });
  assert.deepEqual(nextSkillActivationResult(failed('approval_required'), empty), empty);
  assert.deepEqual(nextSkillActivationResult(undefined, empty), empty);
  const failure = failed('repository_package_access_denied', '2026-11-06T06:32:00.000Z');
  assert.deepEqual(nextSkillActivationResult(activated, failure), failure);
});

test('the readiness wait reports the recorded reason for the waiting provider', () => {
  const since = Date.parse('2026-11-06T06:20:00.000Z');
  assert.equal(repositoryReadinessPendingCode(state({ codex: failed('repository_package_access_denied') }), 'codex', since),
    'repository_package_access_denied');
  assert.equal(repositoryReadinessPendingCode(state({ codex: failed('approval_required') }), 'codex', since), 'approval_required');
  assert.equal(repositoryReadinessPendingCode(state({ codex: { at: '2026-11-06T06:30:00.000Z', outcome: 'no_rollout',
    rolloutId: null, bundleId: null, errorCode: null } }), 'codex', since), 'rollout_not_offered');
  for (const outcome of ['activated', 'up_to_date'] as const) {
    assert.equal(repositoryReadinessPendingCode(state({ codex: { at: '2026-11-06T06:30:00.000Z', outcome,
      rolloutId: ROLLOUT, bundleId: BUNDLE, errorCode: null } }), 'codex', since),
    'installed_bundle_lacks_repository_knowledge');
  }
});

test('the readiness wait never reports a result older than the wait or for another provider', () => {
  const since = Date.parse('2026-11-06T06:40:00.000Z');
  assert.equal(repositoryReadinessPendingCode(state({ codex: failed('approval_required') }), 'codex', since),
    'skill_activation_not_observed');
  assert.equal(repositoryReadinessPendingCode(state({ claude: failed('approval_required', '2026-11-06T06:41:00.000Z') }),
    'codex', since), 'skill_activation_not_observed');
  assert.equal(repositoryReadinessPendingCode(null, 'codex', since), 'skill_activation_not_observed');
});

test('relay activation state parses only its own bounded workspace record', () => {
  const valid = state({ codex: failed('install_failed:eacces') });
  assert.deepEqual(parseRelaySkillActivationState(structuredClone(valid), WORKSPACE), valid);
  assert.equal(parseRelaySkillActivationState(valid, '00000000-0000-4000-8000-000000000000'), null);
  assert.equal(parseRelaySkillActivationState({ ...valid, schema: 'dharma.relay-skill-activation/v2' }, WORKSPACE), null);
  assert.equal(parseRelaySkillActivationState({ ...valid, providers: { codex: failed('has spaces: message') } }, WORKSPACE), null);
  assert.equal(parseRelaySkillActivationState({ ...valid, providers: { shell: failed('approval_required') } }, WORKSPACE), null);
  assert.equal(parseRelaySkillActivationState({ ...valid, counters: { ...valid.counters, activationFailures: -1 } }, WORKSPACE), null);
  assert.equal(parseRelaySkillActivationState([], WORKSPACE), null);
});

test('relay activation state is read from the per-workspace relay directory', async () => {
  const home = await mkdtemp(resolve(tmpdir(), 'fabric-skill-activation-'));
  try {
    assert.equal(await readRelaySkillActivationState(home, WORKSPACE), null);
    const path = relaySkillActivationPath(home, WORKSPACE);
    assert.equal(path, resolve(home, 'relay', 'repositories', WORKSPACE, 'skill-activation.json'));
    await mkdir(dirname(path), { recursive: true });
    const value = state({ codex: failed('approval_required') });
    await writeFile(path, JSON.stringify(value));
    assert.deepEqual(await readRelaySkillActivationState(home, WORKSPACE), value);
    await writeFile(path, '{not json');
    assert.equal(await readRelaySkillActivationState(home, WORKSPACE), null);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('the relay activation record matches its local schema and the parser agrees', async () => {
  const ajv = new Ajv2020({ strict: true, strictRequired: false });
  (createRequire(import.meta.url)('ajv-formats') as FormatsPlugin)(ajv);
  const validate = ajv.compile(JSON.parse(await readFile(
    new URL('./schemas/local-relay-skill-activation.schema.json', import.meta.url), 'utf8')));
  const valid = state({
    codex: failed(skillActivationErrorCode(Object.assign(new Error('x'), { code: 'EACCES' }), 'activation')),
    claude: { at: '2026-11-06T06:30:00.000Z', outcome: 'up_to_date', rolloutId: ROLLOUT, bundleId: BUNDLE, errorCode: null },
  });
  assert.equal(validate(valid), true, JSON.stringify(validate.errors));
  for (const invalid of [
    { ...valid, detail: 'free text' },
    { ...valid, updatedAt: '2026-11-06T06:30:00Z' },
    { ...valid, providers: { codex: { ...failed('approval_required'), errorCode: null } } },
    { ...valid, providers: { codex: { at: '2026-11-06T06:30:00.000Z', outcome: 'activated', rolloutId: ROLLOUT,
      bundleId: BUNDLE, errorCode: 'approval_required' } } },
    { ...valid, providers: { codex: failed('C:/Users/someone/.secret') } },
    { ...valid, providers: { shell: failed('approval_required') } },
  ]) {
    assert.equal(validate(invalid), false, JSON.stringify(invalid));
    assert.equal(parseRelaySkillActivationState(invalid, WORKSPACE), null, JSON.stringify(invalid));
  }
});
