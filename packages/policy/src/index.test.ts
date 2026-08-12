import assert from 'node:assert/strict';
import test from 'node:test';
import { assertPathWithinWorkspace, assertPolicy, resolveRegisteredCommand, type OrganizationPolicy } from './index.js';

const policy: OrganizationPolicy = {
  schema: 'dharma.organization-policy/v1',
  organizationId: 'org_test',
  revision: 'rev_1',
  evidence: {
    defaultMode: 'deep', registeredWorkspaceOnly: true, excludePaths: ['.env'],
    maximumCapsuleBytes: 1_000_000, maximumDailyUploadBytes: 5_000_000,
    maximumExpansionBytes: 1_000_000,
  },
  tasks: {
    defaultNetwork: 'deny', defaultGit: 'task_branch', writePaths: ['src/**'],
    requireLocalConfirmationFor: ['git.push'],
    allowedCommands: { test: { argv: ['npm', 'test'], timeoutSeconds: 600 } },
  },
  skills: { automaticInstall: true, automaticPromotionMaxRisk: 'R2', canaryPercent: 10 },
  retention: {}, budgets: {},
};

test('policy resolves only registered argv commands', () => {
  assertPolicy(policy);
  assert.deepEqual(resolveRegisteredCommand(policy, 'test').argv, ['npm', 'test']);
  assert.throws(() => resolveRegisteredCommand(policy, 'rm'));
});

test('policy forbids automatic authority promotion', () => {
  assert.throws(() => assertPolicy({
    ...policy,
    skills: { ...policy.skills, automaticPromotionMaxRisk: 'R4' },
  }));
});

test('policy rejects capsule sizes above the HQ persistence boundary', () => {
  assert.throws(() => assertPolicy({
    ...policy,
    evidence: { ...policy.evidence, maximumCapsuleBytes: 1_048_577 },
  }), /maximumCapsuleBytes/);
});

test('content disclosure requires an explicit customer consent receipt and class grant', () => {
  assert.throws(() => assertPolicy({
    ...policy,
    evidence: {
      ...policy.evidence,
      automaticDisclosure: { mode: 'customer_authorized_content' },
    },
  }), /consentReceiptId/);
  assert.doesNotThrow(() => assertPolicy({
    ...policy,
    evidence: {
      ...policy.evidence,
      automaticDisclosure: {
        mode: 'customer_authorized_content',
        consentReceiptId: 'consent_org_test_20260812',
        allowedContentClasses: ['native_provider_payload'],
      },
    },
  }));
});

test('workspace path checks reject traversal', () => {
  assert.match(assertPathWithinWorkspace('/repo', 'src/index.ts'), /repo/);
  assert.throws(() => assertPathWithinWorkspace('/repo', '../secret'));
});
