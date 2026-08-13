import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertPathWithinWorkspace,
  assertPolicy,
  resolveRegisteredCommand,
  verifyServerAuthorizedPolicy,
  type OrganizationPolicy,
} from './index.js';

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

test('content disclosure requires an explicit customer consent receipt, class grant, and verified signature', async () => {
  assert.throws(() => assertPolicy({
    ...policy,
    schema: 'dharma.organization-policy/v2',
    evidence: {
      ...policy.evidence,
      automaticDisclosure: { mode: 'customer_authorized_content' },
    },
  }), /consentReceiptId/);
  const { generateKeyPairSync } = await import('node:crypto');
  const { signCanonicalObject } = await import('@dharma-ai-labs/agent-fabric-contracts');
  const keys = generateKeyPairSync('ed25519');
  const unsigned = {
    schema: 'dharma.workspace-policy-authorization/v1' as const, organizationId: 'org_test', workspaceId: 'workspace_test',
    policy: { revision: 'rev_1', evidence: { automaticDisclosure: { mode: 'customer_authorized_content' as const, consentReceiptId: 'consent_org_test_20260812', allowedContentClasses: ['native_provider_payload' as const] }, maximumCapsuleBytes: 1_000_000, maximumDailyUploadBytes: 5_000_000, maximumExpansionBytes: 100_000, excludePaths: ['**/.env'], pseudonymizeIdentity: true as const } },
    issuedAt: '2026-08-12T00:00:00.000Z', expiresAt: '2026-08-13T00:00:00.000Z', keyVersion: 'test',
  };
  const authorizedPolicy: OrganizationPolicy = {
    ...policy,
    schema: 'dharma.organization-policy/v2',
    evidence: {
      ...policy.evidence,
      excludePaths: ['**/.env'],
      maximumExpansionBytes: 100_000,
      pseudonymizeIdentity: true,
      automaticDisclosure: {
        mode: 'customer_authorized_content',
        consentReceiptId: 'consent_org_test_20260812',
        allowedContentClasses: ['native_provider_payload'],
      },
    },
    serverAuthorization: {
      ...unsigned, signature: signCanonicalObject(unsigned, keys.privateKey),
    },
  };
  assert.throws(() => assertPolicy(authorizedPolicy), /cryptographic server authorization verification/);
  const publicJwk = keys.publicKey.export({ format: 'jwk' });
  assert.doesNotThrow(() => verifyServerAuthorizedPolicy({
    policy: authorizedPolicy,
    publicKeyEd25519: publicJwk.x!,
    organizationId: 'org_test',
    workspaceId: 'workspace_test',
    now: new Date('2026-08-12T12:00:00.000Z'),
  }));
  assert.doesNotThrow(() => assertPolicy(authorizedPolicy));
  authorizedPolicy.evidence.excludePaths.push('private/**');
  assert.throws(() => assertPolicy(authorizedPolicy), /current immutable cryptographic/);
});

test('v1 remains valid for local analysis but cannot carry content authorization', () => {
  assert.doesNotThrow(() => assertPolicy(policy));
  assert.throws(() => assertPolicy({
    ...policy,
    evidence: { ...policy.evidence, automaticDisclosure: { mode: 'local_analysis' } },
  }), /organization policy v2/);
  assert.throws(() => assertPolicy({
    ...policy,
    evidence: {
      ...policy.evidence,
      automaticDisclosure: {
        mode: 'customer_authorized_content',
        consentReceiptId: 'consent_test',
        allowedContentClasses: ['native_provider_payload'],
      },
    },
    serverAuthorization: { schema: 'dharma.workspace-policy-authorization/v1' } as NonNullable<OrganizationPolicy['serverAuthorization']>,
  }, { allowUnverifiedAuthorization: true }), /organization policy v2/);
});

test('workspace path checks reject traversal', () => {
  assert.match(assertPathWithinWorkspace('/repo', 'src/index.ts'), /repo/);
  assert.throws(() => assertPathWithinWorkspace('/repo', '../secret'));
});
