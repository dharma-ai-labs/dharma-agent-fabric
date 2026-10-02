import assert from 'node:assert/strict';
import test from 'node:test';
import { run } from './index.js';

test('public container entrypoint command rejects a normal host process before storage or startup mutation', async () => {
  await assert.rejects(run(['relay', 'container-entrypoint']), /container_entrypoint_requires_pid1/);
});

test('container entrypoint rejects grant and policy arguments without reflecting private input', async () => {
  for (const flag of ['grant', 'policy', 'organization-id', 'no-relay-daemon']) {
    await assert.rejects(run(['relay', 'container-entrypoint', `--${flag}`, 'CANARY_PRIVATE_INPUT']), error => {
      assert.match(String(error), /container_entrypoint_options_forbidden/);
      assert.doesNotMatch(String(error), /CANARY_PRIVATE_INPUT/);
      return true;
    });
  }
});


test('container entrypoint dry-run describes its bounded prerequisite plan without starting a runtime', async () => {
  const value = await run(['relay', 'container-entrypoint', '--dry-run']);
  assert.equal(typeof value, 'object');
  const plan = value as Record<string, unknown>;
  assert.equal(plan.stage, 'container_entrypoint_plan');
  assert.equal(plan.started, false);
  assert.equal(plan.requiresPrivateSecretService, true);
  assert.equal(plan.requiresNonRootLinuxEntrypoint, true);
  assert.equal(plan.supportsDirectPid1, true);
  assert.equal(plan.supportsVerifiedDockerInitChild, true);
  assert.equal(plan.restartCoverage, 'container-entrypoint-only');
});
