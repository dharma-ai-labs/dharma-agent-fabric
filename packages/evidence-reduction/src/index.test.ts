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
  assert.equal(capsule.redactionReceipt.disclosureClass, 'automatic_capsule');
  assert.equal(capsule.redactionReceipt.disclosedClasses.includes('event_kind'), true);
  assert.equal(capsule.redactionReceipt.excludedClasses.includes('prompt_text'), true);
  assert.deepEqual(capsule.events[0]?.payload, {
    nativeKind: 'user_message',
    recordBytes: Buffer.byteLength(JSON.stringify(session.records[0]!.native)),
    contentOmitted: true,
  });
  assert.equal(capsule.events[0]?.source.nativeEventId, null);
  assert.equal(capsule.events[0]?.providerModel, null);
});

test('automatic capsules allowlist metadata and omit Codex content-bearing fields', () => {
  const forbidden = {
    type: 'event_msg',
    role: 'user',
    message: 'Confidential customer prompt',
    base_instructions: { text: 'Private system instructions' },
    dynamic_tools: [{ input_schema: { secretShape: true } }],
    tool_input: { source: 'private source code' },
    tool_result: 'private tool output',
    model: 'private-model-name',
    approval_policy: 'never',
    sandbox_policy: { type: 'danger-full-access' },
    total_token_usage: { input_tokens: 900 },
    rate_limits: { primary: 10 },
    encrypted_content: 'opaque-private-reasoning',
    cwd: 'C:\\Users\\customer\\private-repo',
  };
  const capsule = buildTrajectoryCapsule({
    organizationId: 'org_test',
    deviceId: 'device_test',
    workspaceId: 'workspace_test',
    session: {
      provider: 'codex',
      sessionId: 'session_codex_shape',
      sourcePath: 'C:\\Users\\customer\\.codex\\session.jsonl',
      workspace: 'C:\\Users\\customer\\private-repo',
      coverage: 'observed',
      startedAt: '2026-08-12T00:00:00.000Z',
      endedAt: '2026-08-12T00:00:01.000Z',
      records: [{
        native: forbidden,
        sourcePath: 'C:\\Users\\customer\\.codex\\session.jsonl',
        line: 1,
        workspace: 'C:\\Users\\customer\\private-repo',
        timestamp: '2026-08-12T00:00:00.000Z',
        kind: 'user_message',
      }],
    },
    policy,
    rawContentId: `sha256:${'9'.repeat(64)}`,
    rawBytes: 50_000,
  });
  const encoded = JSON.stringify(capsule);
  for (const value of [
    'Confidential customer prompt', 'Private system instructions', 'secretShape',
    'private source code', 'private tool output', 'private-model-name',
    'input_tokens', 'rate_limits', 'opaque-private-reasoning', 'Users\\customer',
  ]) assert.equal(encoded.includes(value), false, `automatic capsule leaked ${value}`);
  assert.equal(capsule.contentIndex[0]?.uploaded, false);
  assert.equal(capsule.redactionReceipt.excludedClasses.includes('instruction_text'), true);
  assert.equal(capsule.redactionReceipt.excludedClasses.includes('tool_schema'), true);
  assert.equal(capsule.redactionReceipt.excludedClasses.includes('token_metadata'), true);
  assert.equal(capsule.redactionReceipt.excludedClasses.includes('rate_limit_metadata'), true);
  assert.equal(capsule.redactionReceipt.excludedClasses.includes('encrypted_reasoning'), true);
  assert.equal(capsule.redactionReceipt.excludedClasses.includes('execution_configuration'), true);
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

test('a changed session can produce a hash-linked next revision', () => {
  const session = {
    provider: 'codex' as const,
    sessionId: 'session_revision',
    sourcePath: '/private/revision.jsonl',
    workspace: '/repo',
    coverage: 'partial' as const,
    startedAt: '2026-08-03T00:00:00.000Z',
    endedAt: '2026-08-03T00:00:01.000Z',
    records: [{
      native: { type: 'assistant_message', text: 'first observation' },
      sourcePath: '/private/revision.jsonl', line: 1, workspace: '/repo',
      timestamp: '2026-08-03T00:00:01.000Z', kind: 'assistant_message',
    }],
  };
  const first = buildTrajectoryCapsule({
    organizationId: 'org_test', deviceId: 'device_test', workspaceId: 'workspace_test', session,
    policy, rawContentId: `sha256:${'d'.repeat(64)}`, rawBytes: 100,
  });
  const second = buildTrajectoryCapsule({
    organizationId: 'org_test', deviceId: 'device_test', workspaceId: 'workspace_test',
    session: { ...session, records: [...session.records, {
      ...session.records[0]!, native: { type: 'assistant_message', text: 'later observation' }, line: 2,
    }] },
    policy, rawContentId: `sha256:${'e'.repeat(64)}`, rawBytes: 200,
    revision: 2, previousRevisionHash: first.capsuleHash,
  });
  assert.equal(second.trajectoryId, first.trajectoryId);
  assert.equal(second.revision, 2);
  assert.equal(second.previousRevisionHash, first.capsuleHash);
  assert.notEqual(second.capsuleHash, first.capsuleHash);
  assert.throws(() => buildTrajectoryCapsule({
    organizationId: 'org_test', deviceId: 'device_test', workspaceId: 'workspace_test', session,
    policy, rawContentId: `sha256:${'f'.repeat(64)}`, rawBytes: 100, revision: 2,
  }), /requires the previous capsule hash/);
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
