import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import test from 'node:test';
import { signCanonicalObject } from '@dharma-ai-labs/agent-fabric-contracts';
import { verifyServerAuthorizedPolicy, type OrganizationPolicy } from '@dharma-ai-labs/agent-fabric-policy';
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

function customerAuthorizedPolicy(excludePaths: string[] = []): OrganizationPolicy {
  const keys = generateKeyPairSync('ed25519');
  const signedPolicy = {
    revision: 'rev_1',
    evidence: {
      automaticDisclosure: { mode: 'customer_authorized_content' as const, consentReceiptId: 'consent_org_test_20260812', allowedContentClasses: ['native_provider_payload' as const] },
      maximumCapsuleBytes: 100_000, maximumDailyUploadBytes: 1_000_000,
      maximumExpansionBytes: 100_000, excludePaths, pseudonymizeIdentity: true as const,
    },
  };
  const now = Date.now();
  const unsigned = {
    schema: 'dharma.workspace-policy-authorization/v1' as const, organizationId: 'org_test', workspaceId: 'workspace_test',
    policy: signedPolicy, issuedAt: new Date(now - 60_000).toISOString(), expiresAt: new Date(now + 3_600_000).toISOString(), keyVersion: 'test',
  };
  const authorizedPolicy: OrganizationPolicy = {
    ...policy,
    schema: 'dharma.organization-policy/v2',
    evidence: {
      ...policy.evidence,
      excludePaths,
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
  const publicJwk = keys.publicKey.export({ format: 'jwk' });
  return verifyServerAuthorizedPolicy({
    policy: authorizedPolicy, publicKeyEd25519: publicJwk.x!, organizationId: 'org_test', workspaceId: 'workspace_test',
    now: new Date(now),
  });
}

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
  assert.equal(capsule.automaticDisclosureMode, 'local_analysis');
  assert.equal(capsule.localAnalysis?.recordCount, 1);
  assert.equal(capsule.localAnalysis?.semanticReviewRecommended, false);
  assert.equal(capsule.redactionReceipt.consentReceiptId, null);
});

test('local analysis delivers failure and tool-discipline metadata without content excerpts', () => {
  const capsule = buildTrajectoryCapsule({
    organizationId: 'org_test', deviceId: 'device_test', workspaceId: 'workspace_test',
    policy,
    rawContentId: `sha256:${'7'.repeat(64)}`, rawBytes: 1_000,
    session: {
      provider: 'codex', sessionId: 'session_local_analysis', sourcePath: '/private/session.jsonl', workspace: '/repo',
      coverage: 'partial', startedAt: '2026-08-12T01:00:00.000Z', endedAt: '2026-08-12T01:00:02.000Z',
      records: [
        { native: { type: 'tool_call', arguments: { code: 'private source' } }, sourcePath: '/private/session.jsonl', line: 1, workspace: '/repo', timestamp: '2026-08-12T01:00:00.000Z', kind: 'tool_call' },
        { native: { type: 'runtime_error', message: 'confidential failure detail' }, sourcePath: '/private/session.jsonl', line: 2, workspace: '/repo', timestamp: '2026-08-12T01:00:02.000Z', kind: 'runtime_error' },
      ],
    },
  });
  const encoded = JSON.stringify(capsule);
  assert.equal(encoded.includes('private source'), false);
  assert.equal(encoded.includes('confidential failure detail'), false);
  assert.deepEqual(capsule.localAnalysis?.toolDiscipline, { calls: 1, results: 0, unmatchedCalls: 1, orphanResults: 0 });
  assert.equal(capsule.localAnalysis?.outcomeSignals.errorRecords, 1);
  assert.equal(capsule.localAnalysis?.durationMs, 2_000);
  assert.deepEqual(capsule.localAnalysis?.reasonCodes, ['runtime_failure_signal', 'tool_call_without_result', 'partial_evidence']);
  assert.equal(capsule.localAnalysis?.semanticReviewRecommended, true);
});

test('reduced trajectory events retain only the active skill bundle UUID as provenance', () => {
  const bundleId = '77777777-7777-4777-8777-777777777777';
  const capsule = buildTrajectoryCapsule({
    organizationId: 'org_test', deviceId: 'device_test', workspaceId: 'workspace_test',
    policy, activeSkillBundleId: bundleId,
    rawContentId: `sha256:${'8'.repeat(64)}`, rawBytes: 100,
    session: {
      provider: 'codex', sessionId: 'session_bundle_bound', sourcePath: '/private/session.jsonl', workspace: '/repo',
      coverage: 'observed', startedAt: '2026-08-16T01:00:00.000Z', endedAt: '2026-08-16T01:00:01.000Z',
      records: [{ native: { type: 'agent_message', text: 'private' }, sourcePath: '/private/session.jsonl', line: 1, workspace: '/repo', timestamp: '2026-08-16T01:00:01.000Z', kind: 'agent_message' }],
    },
  });
  assert.equal(capsule.events[0]?.skillBundleId, bundleId);
  assert.equal(JSON.stringify(capsule).includes('private'), false);
  assert.throws(() => buildTrajectoryCapsule({
    organizationId: 'org_test', deviceId: 'device_test', workspaceId: 'workspace_test',
    policy, activeSkillBundleId: 'not-a-bundle-id',
    rawContentId: `sha256:${'8'.repeat(64)}`, rawBytes: 100,
    session: {
      provider: 'codex', sessionId: 'session_bundle_invalid', sourcePath: '/private/session.jsonl', workspace: '/repo',
      coverage: 'observed', startedAt: '2026-08-16T01:00:00.000Z', endedAt: '2026-08-16T01:00:01.000Z', records: [],
    },
  }), /bundle ID must be a UUID/);
});

test('local analysis recognizes Claude-native terminal failure signals', () => {
  const capsule = buildTrajectoryCapsule({
    organizationId: 'org_test', deviceId: 'device_test', workspaceId: 'workspace_test', policy,
    rawContentId: `sha256:${'5'.repeat(64)}`, rawBytes: 100,
    session: {
      provider: 'claude', sessionId: 'claude_failure', sourcePath: '/private/session.jsonl', workspace: '/repo',
      coverage: 'observed', startedAt: '2026-08-12T01:00:00.000Z', endedAt: '2026-08-12T01:00:01.000Z',
      records: [{
        native: { type: 'result', is_error: true, subtype: 'error_max_turns' },
        sourcePath: '/private/session.jsonl', line: 1, workspace: '/repo', timestamp: '2026-08-12T01:00:01.000Z', kind: 'result',
      }],
    },
  });
  assert.equal(capsule.localAnalysis?.outcomeSignals.errorRecords, 1);
  assert.equal(capsule.localAnalysis?.semanticReviewRecommended, true);
});

test('customer-authorized content includes redacted native payload under a consent receipt', () => {
  const authorizedPolicy = customerAuthorizedPolicy();
  const capsule = buildTrajectoryCapsule({
    organizationId: 'org_test', deviceId: 'device_test', workspaceId: 'workspace_test',
    policy: authorizedPolicy,
    rawContentId: `sha256:${'8'.repeat(64)}`, rawBytes: 2_000,
    session: {
      provider: 'codex', sessionId: 'session_authorized_content', sourcePath: '/private/session.jsonl', workspace: '/repo',
      coverage: 'observed', startedAt: '2026-08-12T02:00:00.000Z', endedAt: '2026-08-12T02:00:01.000Z',
      records: [{
        native: { type: 'user_message', text: 'Analyze checkout failure', cwd: '/home/alice/private-repo', authorization: 'Bearer secret-secret-secret' },
        sourcePath: '/private/session.jsonl', line: 1, workspace: '/repo', timestamp: '2026-08-12T02:00:00.000Z', kind: 'user_message',
      }],
    },
  });
  const encoded = JSON.stringify(capsule);
  assert.equal(capsule.automaticDisclosureMode, 'customer_authorized_content');
  assert.equal(capsule.redactionReceipt.consentReceiptId, 'consent_org_test_20260812');
  assert.equal(capsule.contentIndex[0]?.uploaded, false);
  assert.equal(capsule.redactionReceipt.classes.includes('customer_authorized_content'), true);
  assert.equal(capsule.redactionReceipt.classes.includes('automatic_content_omission'), false);
  assert.equal(encoded.includes('Analyze checkout failure'), true);
  assert.equal(encoded.includes('secret-secret-secret'), false);
  assert.equal(encoded.includes('/home/alice'), false);
  assert.equal(encoded.includes('[REDACTED:sensitive_field]'), true);
});

test('customer-authorized content redacts every labeled-secret form rejected by HQ', () => {
  const capsule = buildTrajectoryCapsule({
    organizationId: 'org_test', deviceId: 'device_test', workspaceId: 'workspace_test',
    policy: customerAuthorizedPolicy(),
    rawContentId: `sha256:${'9'.repeat(64)}`, rawBytes: 2_000,
    session: {
      provider: 'codex', sessionId: 'session_labeled_secret', sourcePath: '/private/session.jsonl', workspace: '/repo',
      coverage: 'observed', startedAt: '2026-08-15T00:00:00.000Z', endedAt: '2026-08-15T00:00:01.000Z',
      records: [{
        native: {
          output: [{
            text: 'access_token: customer-value-with-markdown] refresh-token="second-value-123"',
          }],
        },
        sourcePath: '/private/session.jsonl', line: 1, workspace: '/repo',
        timestamp: '2026-08-15T00:00:00.000Z', kind: 'agent_message',
      }],
    },
  });
  const serialized = JSON.stringify(capsule.events);
  assert.equal(serialized.includes('customer-value-with-markdown'), false);
  assert.equal(serialized.includes('second-value-123'), false);
  assert.equal(capsule.redactionReceipt.classes.includes('authorization'), true);
});

test('customer-authorized content omits records that reference configured excluded paths', () => {
  const authorizedPolicy = customerAuthorizedPolicy(['private/**']);
  const capsule = buildTrajectoryCapsule({
    organizationId: 'org_test', deviceId: 'device_test', workspaceId: 'workspace_test', policy: authorizedPolicy,
    rawContentId: `sha256:${'7'.repeat(64)}`, rawBytes: 1_000,
    session: {
      provider: 'codex', sessionId: 'excluded_path', sourcePath: '/private/session.jsonl', workspace: '/repo',
      coverage: 'observed', startedAt: '2026-08-12T02:00:00.000Z', endedAt: '2026-08-12T02:00:01.000Z',
      records: [{
        native: { type: 'tool_result', source_path: 'private/customer-record.json', text: 'must not synchronize' },
        sourcePath: '/private/session.jsonl', line: 1, workspace: '/repo', timestamp: '2026-08-12T02:00:00.000Z', kind: 'tool_result',
      }],
    },
  });
  const encoded = JSON.stringify(capsule);
  assert.equal(encoded.includes('must not synchronize'), false);
  assert.equal(encoded.includes('customer-record.json'), false);
  assert.equal(capsule.redactionReceipt.excludedPaths, 1);
  assert.equal(encoded.includes('configured_excluded_path'), true);
});

test('customer-authorized content omits records with excluded paths in object property names', () => {
  const authorizedPolicy = customerAuthorizedPolicy(['**/.env']);
  const capsule = buildTrajectoryCapsule({
    organizationId: 'org_test', deviceId: 'device_test', workspaceId: 'workspace_test', policy: authorizedPolicy,
    rawContentId: `sha256:${'2'.repeat(64)}`, rawBytes: 1_000,
    session: {
      provider: 'codex', sessionId: 'excluded_property_name', sourcePath: '/private/session.jsonl', workspace: '/repo',
      coverage: 'observed', startedAt: '2026-08-12T02:00:00.000Z', endedAt: '2026-08-12T02:00:01.000Z',
      records: [{
        native: { type: 'tool_result', files: { '/repo/.env': 'must not synchronize' } },
        sourcePath: '/private/session.jsonl', line: 1, workspace: '/repo', timestamp: '2026-08-12T02:00:00.000Z', kind: 'tool_result',
      }],
    },
  });
  const encoded = JSON.stringify(capsule);
  assert.equal(encoded.includes('/repo/.env'), false);
  assert.equal(encoded.includes('must not synchronize'), false);
  assert.equal(capsule.redactionReceipt.excludedPaths, 1);
  assert.equal(encoded.includes('configured_excluded_path'), true);
});

test('secret-shaped property names and provider kinds never enter a capsule', () => {
  const authorizedPolicy = customerAuthorizedPolicy();
  const secret = `sk-${'A'.repeat(32)}`;
  const capsule = buildTrajectoryCapsule({
    organizationId: 'org_test', deviceId: 'device_test', workspaceId: 'workspace_test', policy: authorizedPolicy,
    rawContentId: `sha256:${'3'.repeat(64)}`, rawBytes: 1_000,
    session: {
      provider: 'codex', sessionId: 'secret_property_name', sourcePath: '/private/session.jsonl', workspace: '/repo',
      coverage: 'observed', startedAt: '2026-08-12T02:00:00.000Z', endedAt: '2026-08-12T02:00:01.000Z',
      records: [{
        native: { type: secret, [secret]: 'non-secret value' },
        sourcePath: '/private/session.jsonl', line: 1, workspace: '/repo', timestamp: '2026-08-12T02:00:00.000Z', kind: secret,
      }],
    },
  });
  const encoded = JSON.stringify(capsule);
  assert.equal(encoded.includes(secret), false);
  assert.equal(capsule.events[0]?.kind, 'unknown');
  assert.equal(capsule.events[0]?.payload.nativeKind, 'unknown');
  assert.equal(capsule.events[0]?.source.sourceKind, 'unknown');
  assert.deepEqual(capsule.localAnalysis?.eventKinds, { unknown: 1 });
  assert.equal(capsule.redactionReceipt.classes.includes('openai_key'), true);
});

test('deep provider records are conservatively omitted without overflowing traversal', () => {
  const authorizedPolicy = customerAuthorizedPolicy();
  let nested: Record<string, unknown> = { value: 'deep customer content' };
  for (let depth = 0; depth < 2_000; depth += 1) nested = { child: nested };
  const capsule = buildTrajectoryCapsule({
    organizationId: 'org_test', deviceId: 'device_test', workspaceId: 'workspace_test', policy: authorizedPolicy,
    rawContentId: `sha256:${'1'.repeat(64)}`, rawBytes: 50_000,
    session: {
      provider: 'codex', sessionId: 'deep_provider_record', sourcePath: '/private/session.jsonl', workspace: '/repo',
      coverage: 'observed', startedAt: '2026-08-12T02:00:00.000Z', endedAt: '2026-08-12T02:00:01.000Z',
      records: [{
        native: { type: 'tool_result', nested },
        sourcePath: '/private/session.jsonl', line: 1, workspace: '/repo', timestamp: '2026-08-12T02:00:00.000Z', kind: 'tool_result',
      }],
    },
  });
  const encoded = JSON.stringify(capsule);
  assert.equal(encoded.includes('deep customer content'), false);
  assert.equal(capsule.redactionReceipt.excludedPaths, 1);
  assert.equal(encoded.includes('configured_excluded_path'), true);
});

test('provider record byte accounting matches JSON encoding without recursive serialization', () => {
  const native = {
    type: 'tool_result', ok: true, count: 12, nullable: null,
    nested: { label: 'customer content', values: [1, false, 'three'] },
  };
  const capsule = buildTrajectoryCapsule({
    organizationId: 'org_test', deviceId: 'device_test', workspaceId: 'workspace_test', policy: customerAuthorizedPolicy(),
    rawContentId: `sha256:${'2'.repeat(64)}`, rawBytes: 500,
    session: {
      provider: 'codex', sessionId: 'byte_accounting', sourcePath: '/private/session.jsonl', workspace: '/repo',
      coverage: 'observed', startedAt: '2026-08-12T02:00:00.000Z', endedAt: '2026-08-12T02:00:01.000Z',
      records: [{
        native, sourcePath: '/private/session.jsonl', line: 1, workspace: '/repo',
        timestamp: '2026-08-12T02:00:00.000Z', kind: 'tool_result',
      }],
    },
  });
  const expectedBytes = Buffer.byteLength(JSON.stringify(native));
  assert.equal(capsule.localAnalysis?.recordBytes.total, expectedBytes);
  assert.equal(capsule.localAnalysis?.recordBytes.maximum, expectedBytes);
  assert.equal(capsule.events[0]?.payload.recordBytes, expectedBytes);
});

test('customer-authorized content detects excluded paths inside serialized tool arguments', () => {
  const authorizedPolicy = customerAuthorizedPolicy(['.env', '**/*.key']);
  const capsule = buildTrajectoryCapsule({
    organizationId: 'org_test', deviceId: 'device_test', workspaceId: 'workspace_test', policy: authorizedPolicy,
    rawContentId: `sha256:${'4'.repeat(64)}`, rawBytes: 1_000,
    session: {
      provider: 'codex', sessionId: 'serialized_excluded_path', sourcePath: '/private/session.jsonl', workspace: '/repo',
      coverage: 'observed', startedAt: '2026-08-12T02:00:00.000Z', endedAt: '2026-08-12T02:00:01.000Z',
      records: [{
        native: { type: 'tool_call', arguments: '{"cmd":"cat .env"}', result: 'non-secret customer content' },
        sourcePath: '/private/session.jsonl', line: 1, workspace: '/repo', timestamp: '2026-08-12T02:00:00.000Z', kind: 'tool_call',
      }],
    },
  });
  const encoded = JSON.stringify(capsule);
  assert.equal(encoded.includes('non-secret customer content'), false);
  assert.equal(capsule.redactionReceipt.excludedPaths, 1);
});

test('customer-authorized content handles root globs, camelCase paths, and common credential fields', () => {
  const authorizedPolicy = customerAuthorizedPolicy(['**/*.key', '**/.env']);
  const capsule = buildTrajectoryCapsule({
    organizationId: 'org_test', deviceId: 'device_test', workspaceId: 'workspace_test', policy: authorizedPolicy,
    rawContentId: `sha256:${'6'.repeat(64)}`, rawBytes: 1_000,
    session: {
      provider: 'codex', sessionId: 'root_exclusions', sourcePath: '/private/session.jsonl', workspace: '/repo',
      coverage: 'observed', startedAt: '2026-08-12T02:00:00.000Z', endedAt: '2026-08-12T02:00:01.000Z',
      records: [
        {
          native: { type: 'tool_result', sourcePath: 'signing.key', text: 'must not synchronize' },
          sourcePath: '/private/session.jsonl', line: 1, workspace: '/repo', timestamp: '2026-08-12T02:00:00.000Z', kind: 'tool_result',
        },
        {
          native: { type: 'tool_result', clientSecret: 'client-secret-value', refreshToken: 'refresh-token-value', xApiKey: 'api-key-value' },
          sourcePath: '/private/session.jsonl', line: 2, workspace: '/repo', timestamp: '2026-08-12T02:00:01.000Z', kind: 'tool_result',
        },
      ],
    },
  });
  const encoded = JSON.stringify(capsule);
  assert.equal(encoded.includes('must not synchronize'), false);
  assert.equal(encoded.includes('client-secret-value'), false);
  assert.equal(encoded.includes('refresh-token-value'), false);
  assert.equal(encoded.includes('api-key-value'), false);
  assert.equal(capsule.redactionReceipt.excludedPaths, 1);
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

test('serialized payload, body, message, and content fields cannot hide excluded paths or secret fields', () => {
  const contentPolicy = customerAuthorizedPolicy(['**/.env', '**/*.key']);
  for (const field of ['payload', 'body', 'message', 'content']) {
    const capsule = buildTrajectoryCapsule({
      organizationId: 'org_test', deviceId: 'device_test', workspaceId: 'workspace_test', policy: contentPolicy,
      rawContentId: `sha256:${'9'.repeat(64)}`, rawBytes: 300,
      session: {
        provider: 'codex', sessionId: `serialized_secret_${field}`, sourcePath: '/private/source.jsonl', workspace: '/repo',
        coverage: 'observed', startedAt: '2026-08-03T00:00:00.000Z', endedAt: '2026-08-03T00:00:01.000Z',
        records: [{
          native: { type: 'tool_call', [field]: JSON.stringify({ path: '/repo/.env', credential: 'private-secret-value' }) },
          sourcePath: '/private/source.jsonl', line: 1, workspace: '/repo', timestamp: '2026-08-03T00:00:00.000Z', kind: 'tool_call',
        }],
      },
    });
    const encoded = JSON.stringify(capsule);
    assert.equal(encoded.includes('private-secret-value'), false, field);
    assert.equal(encoded.includes('/repo/.env'), false, field);
    assert.equal(capsule.redactionReceipt.excludedPaths, 1, field);
  }
});

test('bounded expansion redacts file URIs and local paths while preserving web URLs and semantic text', async () => {
  const { redactValue } = await import('./index.js');
  const stats = { classes: new Set<string>(), redactedValues: 0, excludedPaths: 0, inputBytes: 0, outputBytes: 0 };
  const raw = [
    'Review /home/alice/company/private-repo before release.',
    'Review C:\\\\Users\\\\alice\\\\company\\\\private-repo before release.',
    'Review \\\\wsl.localhost\\Ubuntu\\home\\alice\\private-repo before release.',
    'Do not publish file:///home/alice/company/private-repo or file:// by mistake.',
    'Keep https://dharma-ai.io/docs and vscode://settings intact.',
  ].join('\n');
  const redacted = String(redactValue(raw, stats, '', { pseudonymizeIdentity: true }));
  assert.equal(redacted.includes('/home/alice'), false);
  assert.equal(redacted.includes('C:\\\\Users'), false);
  assert.equal(redacted.includes('wsl.localhost'), false);
  assert.equal(redacted.includes('file://'), false);
  assert.equal(redacted.includes('Review [REDACTED:local_path] before release.'), true);
  assert.equal(redacted.includes('https://dharma-ai.io/docs'), true);
  assert.equal(redacted.includes('vscode://settings'), true);
  assert.equal(stats.classes.has('local_path'), true);
  assert.equal(stats.redactedValues, 5);
});

test('customer-authorized content never discloses local paths when identity pseudonymization is disabled', async () => {
  const { redactValue } = await import('./index.js');
  const stats = { classes: new Set<string>(), redactedValues: 0, excludedPaths: 0, inputBytes: 0, outputBytes: 0 };
  const redacted = redactValue({
    cwd: '/home/alice/company/private-repo',
    arguments: JSON.stringify({ command: 'cat /home/alice/company/private-repo/src/app.ts' }),
  }, stats, '', { pseudonymizeIdentity: false });
  const encoded = JSON.stringify(redacted);
  assert.equal(encoded.includes('/home/alice'), false);
  assert.equal(encoded.includes('[REDACTED:local_path]'), true);
  assert.equal(stats.classes.has('local_path'), true);
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
