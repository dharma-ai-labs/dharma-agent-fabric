import assert from 'node:assert/strict';
import test from 'node:test';
import type { OrganizationPolicy } from '@dharma-ai/agent-fabric-policy';
import { buildTrajectoryCapsule } from './index.js';

const policy: OrganizationPolicy = {
  schema: 'dharma.organization-policy/v1', organizationId: 'org_test', revision: 'rev_1',
  evidence: {
    defaultMode: 'deep', registeredWorkspaceOnly: true, excludePaths: [], maximumCapsuleBytes: 100_000,
    maximumDailyUploadBytes: 1_000_000, maximumExpansionBytes: 100_000,
  },
  tasks: { defaultNetwork: 'deny', defaultGit: 'task_branch', allowedCommands: {}, writePaths: [], requireLocalConfirmationFor: [] },
  skills: { automaticInstall: true, automaticPromotionMaxRisk: 'R2', canaryPercent: 10 },
  retention: {}, budgets: {},
};

test('capsule strips secrets and remains deterministic', () => {
  const session = {
    provider: 'codex' as const,
    sessionId: 'session_test',
    sourcePath: '/private/source.jsonl',
    workspace: '/repo',
    coverage: 'observed' as const,
    startedAt: '2026-08-03T00:00:00.000Z',
    endedAt: '2026-08-03T00:00:01.000Z',
    records: [{
      native: { type: 'user_message', cwd: '/repo', authorization: 'Bearer secret-secret-secret', text: 'token ghp_123456789012345678901234567890' },
      sourcePath: '/private/source.jsonl', line: 1, workspace: '/repo', timestamp: '2026-08-03T00:00:00.000Z', kind: 'user_message',
    }],
  };
  const capsule = buildTrajectoryCapsule({
    organizationId: 'org_test', deviceId: 'device_test', workspaceId: 'workspace_test', session,
    policy, rawContentId: `sha256:${'a'.repeat(64)}`, rawBytes: 100, rawKind: 'raw-provider-turn',
    createdAt: '2026-08-03T00:00:02.000Z',
  });
  const encoded = JSON.stringify(capsule);
  assert.equal(encoded.includes('secret-secret-secret'), false);
  assert.equal(encoded.includes('ghp_123'), false);
  assert.equal(encoded.includes('/private/source.jsonl'), false);
  assert.ok(capsule.redactionReceipt.redactedValues >= 2);
  assert.equal(capsule.contentIndex[0]?.kind, 'raw-provider-turn');
  assert.equal(capsule.localEvidenceAvailable[0]?.kind, 'raw-provider-turn');
});
