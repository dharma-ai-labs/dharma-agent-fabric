import assert from 'node:assert/strict';
import test from 'node:test';
import { retryBootstrapOnboarding } from './index.js';
import { withOnboardingStage } from './onboardingStage.js';

const workspaceId = 'd651b3f9-8cee-47d4-a6b6-695994a065b1';
const resumeCommand = 'dharma onboard --resume --organization-id org_test --workspace . --policy-revision policy_test';

test('onboarding stage preserves a local failure and gives an exact resume command', async () => {
  const cause = new Error('Repository package traversal limit exceeded.');
  await assert.rejects(
    withOnboardingStage('local_skill_inventory', workspaceId, resumeCommand, async () => { throw cause; }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error.cause, cause);
      assert.match(error.message, /^agent_fabric_onboarding_local_skill_inventory:/);
      assert.match(error.message, new RegExp(`workspace_id: ${workspaceId}`));
      assert.ok(error.message.includes(`resume_command: ${resumeCommand}`));
      return true;
    },
  );
});

test('stage decoration keeps transient bootstrap retries and does not report false success', async () => {
  let attempts = 0;
  const value = await retryBootstrapOnboarding(
    () => withOnboardingStage('package_publication', workspaceId, resumeCommand, async () => {
      if (++attempts === 1) throw new Error('fetch failed');
      return { ok: true, candidateId: 'candidate_test' };
    }),
    { delaysMs: [0], wait: async () => undefined },
  );
  assert.equal(attempts, 2);
  assert.deepEqual(value, { ok: true, candidateId: 'candidate_test' });
});

test('nontransient onboarding errors do not retry', async () => {
  let attempts = 0;
  await assert.rejects(
    retryBootstrapOnboarding(
      () => withOnboardingStage('role_registration', workspaceId, resumeCommand, async () => {
        attempts += 1;
        throw new Error('Repository role belongs to a different member.');
      }),
      { delaysMs: [0, 0], wait: async () => undefined },
    ),
    /agent_fabric_onboarding_role_registration/,
  );
  assert.equal(attempts, 1);
});
