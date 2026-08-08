import assert from 'node:assert/strict';
import test from 'node:test';
import type { OrganizationPolicy } from '@dharma-ai-labs/agent-fabric-policy';
import { buildTrajectoryCapsule } from './index.js';

const policy: OrganizationPolicy = {
  schema: 'dharma.organization-policy/v1', organizationId: 'org_test', revision: 'rev_1',
  evidence: {
    defaultMode: 'deep', registeredWorkspaceOnly: true, excludePaths: [], maximumCapsuleBytes: 100_000,
    maximumDailyUploadBytes: 1_000_000, maximumExpansionBytes: 100_000,
    pseudonymizeIdentity: true,
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
  assert.equal(encoded.includes('/repo'), false);
  assert.equal(capsule.redactionReceipt.classes.includes('local_path'), true);
  assert.ok(capsule.redactionReceipt.redactedValues >= 2);
  assert.equal(capsule.contentIndex[0]?.kind, 'raw-provider-turn');
  assert.equal(capsule.localEvidenceAvailable[0]?.kind, 'raw-provider-turn');
});

test('bounded expansion redacts Unix, Windows, and WSL-local paths when identity is pseudonymized', async () => {
  const { redactValue } = await import('./index.js');
  const stats = { classes: new Set<string>(), redactedValues: 0, excludedPaths: 0, inputBytes: 0, outputBytes: 0 };
  const raw = [
    '{"cwd":"/home/alice/company/private-repo"}',
    '{"cwd":"C:\\\\Users\\\\alice\\\\company\\\\private-repo"}',
    '{"cwd":"\\\\\\\\wsl.localhost\\\\Ubuntu\\\\home\\\\alice\\\\private-repo"}',
  ].join('\n');
  const redacted = String(redactValue(raw, stats, '', { pseudonymizeIdentity: true }));
  assert.equal(redacted.includes('/home/alice'), false);
  assert.equal(redacted.includes('C:\\\\Users'), false);
  assert.equal(redacted.includes('wsl.localhost'), false);
  assert.equal(stats.classes.has('local_path'), true);
  assert.equal(stats.redactedValues, 3);
});

test('identical source sessions produce an identical capsule revision hash', () => {
  const session = {
    provider: 'codex' as const,
    sessionId: 'session_retry',
    sourcePath: '/private/retry.jsonl',
    workspace: '/repo',
    coverage: 'observed' as const,
    startedAt: '2026-08-03T00:00:00.000Z',
    endedAt: '2026-08-03T00:00:01.000Z',
    records: [{
      native: { type: 'assistant_message', text: 'deterministic evidence' },
      sourcePath: '/private/retry.jsonl', line: 1, workspace: '/repo',
      timestamp: '2026-08-03T00:00:01.000Z', kind: 'assistant_message',
    }],
  };
  const input = {
    organizationId: 'org_test', deviceId: 'device_test', workspaceId: 'workspace_test', session,
    policy, rawContentId: `sha256:${'b'.repeat(64)}`, rawBytes: 100,
    rawKind: 'raw-provider-turn' as const,
  };
  const first = buildTrajectoryCapsule(input);
  const second = buildTrajectoryCapsule(input);
  assert.equal(first.createdAt, session.endedAt);
  assert.equal(second.capsuleHash, first.capsuleHash);
});

test('capsule removes NUL characters rejected by Postgres jsonb', () => {
  const session = {
    provider: 'codex' as const,
    sessionId: 'session_nul',
    sourcePath: '/private/nul.jsonl',
    workspace: '/repo',
    coverage: 'observed' as const,
    startedAt: '2026-08-03T00:00:00.000Z',
    endedAt: '2026-08-03T00:00:01.000Z',
    records: [{
      native: { type: 'assistant_message', text: 'before\u0000after' },
      sourcePath: '/private/nul.jsonl', line: 1, workspace: '/repo',
      timestamp: '2026-08-03T00:00:01.000Z', kind: 'assistant_message',
    }],
  };
  const capsule = buildTrajectoryCapsule({
    organizationId: 'org_test', deviceId: 'device_test', workspaceId: 'workspace_test', session,
    policy, rawContentId: `sha256:${'c'.repeat(64)}`, rawBytes: 12,
  });

  assert.equal(JSON.stringify(capsule).includes('\\u0000'), false);
  assert.equal(capsule.redactionReceipt.classes.includes('invalid_unicode_nul'), true);
});
