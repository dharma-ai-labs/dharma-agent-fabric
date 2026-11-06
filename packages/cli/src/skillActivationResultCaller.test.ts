import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

// G11 F14 (2026-11-06): the relay's automatic activation caught every error and only counted it,
// so neither setup nor `dharma status` could say why the shared package never installed.

async function source() {
  return readFile(new URL('../src/index.ts', import.meta.url), 'utf8');
}

test('actual relay records each automatic activation result with a bounded error code', async () => {
  const text = await source();
  const relay = text.slice(text.indexOf('async function relayStart('), text.indexOf('export async function run('));
  const tick = relay.slice(relay.indexOf('performance.now() >= nextSkillActivationAt'), relay.indexOf('nextSkillActivationAt = performance.now() + 60_000;'));
  assert.ok(tick.length > 0);
  assert.doesNotMatch(tick, /\} catch \{\s*skillActivationFailures \+= 1;/, 'the error must not be discarded');
  assert.match(tick, /\} catch \(error\) \{[\s\S]*skillActivationFailures \+= 1;[\s\S]*skillActivationErrorCode\(error, stage\)/);
  assert.match(tick, /outcome: activating \? 'activated' : 'no_rollout'/);
  assert.match(tick, /nextSkillActivationResult\(/);
  // A receipt of 'failed' or 'rolled_back' must reach the catch above, not be recorded as activated.
  assert.match(tick, /const activated = await activatePreparedSkillUpdate\([^;]*\);\s*requireActiveSkillInstall\(activated\.status\);\s*skillActivationsCompleted \+= 1;/);
  const write = relay.slice(relay.indexOf('nextSkillActivationAt = performance.now() + 60_000;') - 600,
    relay.indexOf('nextSkillActivationAt = performance.now() + 60_000;'));
  assert.match(write, /writeJsonAtomic\(relaySkillActivationPath\(dharmaHome\(\), canonicalWorkspace\.workspaceId\)/);
  assert.match(write, /schema: 'dharma\.relay-skill-activation\/v1'/);
});

test('actual activation refuses an R3 or R4 bundle without approval before installing, with a code', async () => {
  const text = await source();
  const activation = text.slice(text.indexOf('async function activatePreparedSkillUpdate('), text.indexOf('async function skillSync('));
  const refusal = activation.indexOf("new SkillActivationError('approval_required'");
  assert.ok(refusal > 0);
  assert.ok(refusal < activation.indexOf('await installSkillBundle('));
  assert.ok(activation.indexOf('try {') < refusal, 'the prepared source must still be removed on refusal');
});

test('actual setup readiness wait explains a pending result from the relay record', async () => {
  const text = await source();
  const wait = text.slice(text.indexOf("withOnboardingStage('readiness', workspaceId, resumeCommand,"),
    text.indexOf("sharedRepositoryReady = repositoryReadiness.outcome === 'ready';"));
  assert.match(wait, /explainPending: async \(\) => repositoryReadinessPendingCode\(\s*await readRelaySkillActivationState\(dharmaHome\(\), workspaceId\), provider, waitStartedAt\)/);
  const result = text.slice(text.indexOf("repositoryReadiness?.outcome === 'blocked' ? 'shared_repository_blocked' : 'shared_repository_pending'") - 200,
    text.indexOf('export function summarizeBootstrapOrganizationApi('));
  assert.match(result, /code: repositoryReadiness\.code/);
});

test('actual diagnostic status shows each repository relay activation counters and last results', async () => {
  const text = await source();
  const status = text.slice(text.indexOf("if (command === 'status') {"), text.indexOf("if (command === 'assistant')"));
  assert.match(status, /skillActivation: await readRelaySkillActivationState\(dharmaHome\(\), row\.workspaceId\)/);
});
