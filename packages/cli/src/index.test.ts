import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, stat, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import {
  activateAgyPlugin,
  actionDecisionCapabilityFreshUntil,
  canonicalFilesystemPath,
  installAvailableNativeAgentFabricBootstraps,
  assertCapsuleAuthorizedByCurrentPolicy,
  assertRecoveredTaskWorkspacePolicy,
  assertTaskWorkspacePolicy,
  assertTaskSkillPin,
  installNativeAgentFabricBootstrap,
  installRepositoryAgentFabricSkill,
  isDirectExecution,
  materializeWorkspacePolicy,
  applyServerEvidencePolicy,
  materializeInlineSkillFiles,
  nativeSkillDirectory,
  normalizeGitRemoteIdentity,
  postTaskOutcome,
  parseCliOptions,
  parseSelectedProviderIds,
  pathExistsOrThrow,
  portalUrl,
  rawLocalRetentionDays,
  recoverLegacySkillBundleIdAfterAuthorizationFailure,
  installedBundleIdForSkillPollAfterAuthorizationFailure,
  recoveredTaskPolicyWasSuperseded,
  relayProcessState,
  releaseDailyContentUpload,
  reserveDailyContentUpload,
  run,
  sourceRepositoryFingerprint,
  responseTextFromEvent,
  taskResponsePreview,
  taskReceiptSession,
  taskSkillPinFailureCode,
  verifyAgentFabricSkillInstallation,
  withWorkspacePolicyRefreshLock,
  withWorkspaceSkillActivationLock,
} from './index.js';
import type { SkillBundle } from '@dharma-ai-labs/agent-fabric-skill-manager';
import { canonicalize, signCanonicalObject } from '@dharma-ai-labs/agent-fabric-contracts';
import { buildTrajectoryCapsule } from '@dharma-ai-labs/agent-fabric-evidence-reduction';
import type { SecureSecretStore } from '@dharma-ai-labs/agent-fabric-relay-client';
import { CLI_USAGE } from './usage.js';
import {
  isSupportedNodeVersion,
  launchWithRuntime,
  nodeRuntimeCandidates,
  runtimeBootstrapHint,
} from './runtime-bootstrap.js';

const execFileAsync = promisify(execFile);

test('uses the production B2B portal and keeps hq-url as a compatibility alias', () => {
  assert.equal(portalUrl(new Map()), 'https://www.dharma-ai.io');
  assert.equal(portalUrl(new Map([['hq-url', 'https://legacy.example']])), 'https://legacy.example');
  assert.equal(portalUrl(new Map([
    ['hq-url', 'https://legacy.example'],
    ['portal-url', 'https://www.dharma-ai.io'],
  ])), 'https://www.dharma-ai.io');
});

test('posts action enforcement before a consequential task completion event', async () => {
  const events: string[] = [];
  const acknowledgement = {
    taskId: '11111111-1111-4111-8111-111111111111',
    endpointId: '22222222-2222-4222-8222-222222222222',
    actionDigest: `sha256:${'a'.repeat(64)}`,
    disposition: 'executed' as const,
    externalIdempotencyKeyHash: 'b'.repeat(64),
    resultDigest: `sha256:${'c'.repeat(64)}`,
    acknowledgedAt: new Date().toISOString(),
  };
  await postTaskOutcome({
    task: {
      taskId: acknowledgement.taskId,
      actionDecision: {
        id: '33333333-3333-4333-8333-333333333333',
        actionDigest: acknowledgement.actionDigest,
        receipt: {} as never,
        signature: 'signature',
        keyVersion: 'kms:test/1',
      },
    },
    receipt: { status: 'completed', actionAcknowledgement: acknowledgement },
    payload: { status: 'completed' },
    async postEnforcement(decisionId, body) {
      events.push(`enforcement:${decisionId}:${body.disposition}`);
    },
    async postEvent(taskId, eventType) {
      events.push(`event:${taskId}:${eventType}`);
    },
  });
  assert.deepEqual(events, [
    'enforcement:33333333-3333-4333-8333-333333333333:executed',
    'event:11111111-1111-4111-8111-111111111111:completed',
  ]);
});

test('fail-closed existence checks distinguish absence from unreadable state', async () => {
  assert.equal(await pathExistsOrThrow('/missing', async () => {
    throw Object.assign(new Error('missing'), { code: 'ENOENT' });
  }), false);
  await assert.rejects(pathExistsOrThrow('/unreadable', async () => {
    throw Object.assign(new Error('denied'), { code: 'EACCES' });
  }), /denied/);
});

test('canonical filesystem identities resolve links without rewriting filesystem case', async () => {
  const root = await mkdtemp(join(tmpdir(), 'fabric-canonical-path-'));
  const target = join(root, 'approved-policy.json');
  const alias = join(root, 'policy-link.json');
  await writeFile(target, '{}');
  if (process.platform !== 'win32') {
    await symlink(target, alias);
    assert.equal(await canonicalFilesystemPath(alias), await canonicalFilesystemPath(target));
  }
  assert.equal(await canonicalFilesystemPath(target), await realpath(target));
});

function memorySecureStore(): SecureSecretStore {
  const values = new Map<string, string>();
  return {
    backend: 'linux-secret-service',
    async get(account) { return values.get(account) ?? null; },
    async put(account, value) { values.set(account, value); },
    async delete(account) { values.delete(account); },
  };
}

function signedPolicyAuthorization(policy: Record<string, unknown>, organizationId = 'org_northstar', workspaceId = 'workspace-northstar') {
  const keys = generateKeyPairSync('ed25519');
  const sourceEvidence = policy.evidence && typeof policy.evidence === 'object' && !Array.isArray(policy.evidence)
    ? policy.evidence as Record<string, unknown> : {};
  const signedPolicy = {
    ...policy,
    evidence: {
      ...sourceEvidence,
      maximumExpansionBytes: sourceEvidence.maximumExpansionBytes ?? 100_000,
      excludePaths: sourceEvidence.excludePaths ?? ['**/.env', '**/*.key'],
      pseudonymizeIdentity: true,
    },
  };
  const unsigned = {
    schema: 'dharma.workspace-policy-authorization/v1', organizationId, workspaceId, policy: signedPolicy,
    issuedAt: new Date(Date.now() - 60_000).toISOString(), expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    keyVersion: 'test-key',
  };
  const publicJwk = keys.publicKey.export({ format: 'jwk' });
  return {
    envelope: { ...unsigned, signature: signCanonicalObject(unsigned, keys.privateKey) },
    publicKeyEd25519: publicJwk.x!,
  };
}

test('organization raw evidence retention is validated and defaults explicitly', () => {
  assert.equal(rawLocalRetentionDays({ retention: {} }), 30);
  assert.equal(rawLocalRetentionDays({ retention: { rawLocalDays: 7 } }), 7);
  assert.throws(() => rawLocalRetentionDays({ retention: { rawLocalDays: 0 } }), /between 1 and 3650/);
  assert.throws(() => rawLocalRetentionDays({ retention: { rawLocalDays: 1.5 } }), /between 1 and 3650/);
});

test('action-decision capability freshness never outlives its key or keyset', () => {
  const now = new Date('2026-08-17T20:00:00.000Z');
  const base = {
    schema: 'dharma.server-signing-keyset/v1' as const,
    organizationId: 'org_test', generation: 1, signedByKeyVersion: 'kms/1', signature: 'signature',
    issuedAt: new Date(now.getTime() - 60_000).toISOString(),
    expiresAt: new Date(now.getTime() + 10 * 60_000).toISOString(),
    keys: [{
      keyVersion: 'kms/1', publicKeyEd25519: 'public', status: 'active' as const,
      notBefore: new Date(now.getTime() - 60_000).toISOString(),
      notAfter: new Date(now.getTime() + 90_000).toISOString(),
    }],
  };
  assert.equal(
    actionDecisionCapabilityFreshUntil(base, ['kms/1'], now),
    new Date(now.getTime() + 90_000).toISOString(),
  );
  assert.throws(
    () => actionDecisionCapabilityFreshUntil({
      ...base,
      keys: [{ ...base.keys[0]!, notAfter: now.toISOString() }],
    }, ['kms/1'], now),
    /invalid_or_expired/,
  );
});

test('version is parser-safe structured output', async () => {
  const packageMetadata = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };
  assert.deepEqual(await run(['version']), { version: packageMetadata.version });
});

test('runtime bootstrap accepts supported LTS runtimes and rejects unsupported versions', () => {
  assert.equal(isSupportedNodeVersion('v18.19.1'), false);
  assert.equal(isSupportedNodeVersion('22.19.0'), false);
  assert.equal(isSupportedNodeVersion('v22.20.0'), true);
  assert.equal(isSupportedNodeVersion('24.15.0'), true);
  assert.equal(isSupportedNodeVersion('25.0.0'), false);
});

test('runtime bootstrap discovers explicit and local agent runtimes without duplicates', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dharma-runtime-bootstrap-'));
  const localNode = join(root, '.local', 'bin', 'node');
  await mkdir(join(root, '.local', 'bin'), { recursive: true });
  await writeFile(localNode, '#!/bin/sh\n');
  const candidates = nodeRuntimeCandidates({
    env: { PATH: join(root, '.local', 'bin'), DHARMA_NODE_BINARY: localNode },
    home: root,
    platform: 'linux',
    execPath: localNode,
  });
  const selectedCandidate = candidates[0];
  assert.ok(selectedCandidate);
  const [candidateMetadata, requestedMetadata] = await Promise.all([
    stat(selectedCandidate),
    stat(localNode),
  ]);
  assert.equal(candidateMetadata.dev, requestedMetadata.dev);
  assert.equal(candidateMetadata.ino, requestedMetadata.ino);
  assert.equal(new Set(candidates).size, candidates.length);
  assert.match(runtimeBootstrapHint({ DHARMA_NODE_BINARY: localNode }), /DHARMA_NODE_BINARY/);
});

test('runtime bootstrap ignores PATH-only executables and forwards argv and bootstrap state', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dharma-runtime-launch-'));
  const pathOnlyNode = join(root, 'node');
  const probe = join(root, 'probe.mjs');
  const output = join(root, 'result.json');
  await writeFile(pathOnlyNode, '#!/bin/sh\n');
  await writeFile(probe, `import { writeFileSync } from 'node:fs';\nwriteFileSync(process.env.OUTPUT_FILE, JSON.stringify({ args: process.argv.slice(2), bootstrapped: process.env.DHARMA_NODE_BOOTSTRAPPED }));\n`);
  const candidates = nodeRuntimeCandidates({ env: { PATH: root }, home: join(root, 'home'), execPath: '/missing/node' });
  assert.equal(candidates.includes(await realpath(pathOnlyNode)), false);
  const child = launchWithRuntime(process.execPath, probe, ['status', '--json'], { OUTPUT_FILE: output });
  assert.equal(child.status, 0);
  assert.deepEqual(JSON.parse(await readFile(output, 'utf8')), {
    args: ['status', '--json'],
    bootstrapped: '1',
  });
});

test('help is successful and direct basic commands keep stdout and stderr clean', async () => {
  assert.equal(String(await run(['--help'])), CLI_USAGE);
  const entrypoint = new URL('./index.js', import.meta.url);
  for (const argv of [['--help'], ['--version']]) {
    const result = await execFileAsync(process.execPath, [fileURLToPath(entrypoint), ...argv], { encoding: 'utf8' });
    assert.equal(result.stderr, '');
    assert.equal(result.stdout.includes('ExperimentalWarning'), false);
  }
  const bin = new URL('./bin.js', import.meta.url);
  const help = await execFileAsync(process.execPath, [fileURLToPath(bin), '--help'], { encoding: 'utf8' });
  assert.equal(help.stdout.trim(), CLI_USAGE);
  assert.equal(help.stderr, '');
});

test('global npm symlinks still execute the CLI entrypoint', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dharma-cli-entrypoint-'));
  const target = join(root, 'dist', 'index.js');
  const link = join(root, 'bin', 'dharma');
  await mkdir(join(root, 'dist'), { recursive: true });
  await mkdir(join(root, 'bin'), { recursive: true });
  await writeFile(target, '#!/usr/bin/env node\n');
  await symlink(target, link);
  assert.equal(isDirectExecution(link, pathToFileURL(target).href), true);
});

test('unknown commands fail as usage errors', async () => {
  await assert.rejects(() => run(['unknown']), /Usage:/);
});

test('organization commands require environment credentials and explicit confirmation for mutations', async () => {
  const originalFetch = globalThis.fetch;
  const originalToken = process.env.DHARMA_ORG_API_TOKEN;
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  process.env.DHARMA_ORG_API_TOKEN = 'test-organization-token';
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    requests.push({ url: String(input), init });
    return new Response(JSON.stringify({ ok: true, agents: [{ id: 'agent-1' }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  try {
    const listed = await run([
      'agents', 'list', '--organization-id', 'org_northstar', '--hq-url', 'https://hq.example.com',
    ]) as Record<string, unknown>;
    assert.equal(listed.ok, true);
    assert.match(requests[0]!.url, /org_northstar\/agent-fabric\/agents$/);
    assert.equal((requests[0]!.init?.headers as Record<string, string>).authorization, 'Bearer test-organization-token');
    await assert.rejects(() => run([
      'agents', 'bind-runtime', '--organization-id', 'org_northstar', '--agent-id', 'agent-1',
      '--json-body', '{"endpointKind":"managed_runtime","managedAgentId":"managed-1","runtimeBindingId":"binding-1"}',
    ]), /requires --confirm/);
    await run([
      'agents', 'bind-runtime', '--organization-id', 'org_northstar', '--hq-url', 'https://hq.example.com',
      '--agent-id', 'agent-1',
      '--json-body', '{"endpointKind":"managed_runtime","managedAgentId":"managed-1","runtimeBindingId":"binding-1"}',
      '--confirm',
    ]);
    assert.match(requests[1]!.url, /agent-fabric\/agents\/agent-1\/endpoints$/);
    assert.deepEqual(JSON.parse(String(requests[1]!.init?.body)), {
      endpointKind: 'managed_runtime', managedAgentId: 'managed-1', runtimeBindingId: 'binding-1',
    });
    await assert.rejects(() => run([
      'experiments', 'run', '--organization-id', 'org_northstar', '--hq-url', 'https://hq.example.com',
      '--json-body', '{"trajectoryTarget":100}',
    ]), /requires --confirm/);
    await run([
      'experiments', 'run', '--organization-id', 'org_northstar', '--hq-url', 'https://hq.example.com',
      '--json-body', '{"trajectoryTarget":100,"scope":{"mode":"agents","organizationAgentIds":["agent-1"]}}', '--confirm',
    ]);
    assert.equal(requests[2]!.init?.method, 'POST');
    assert.match(String(requests[2]!.init?.body), /organizationAgentIds/);
    await assert.rejects(() => run([
      'remediations', 'act', '--organization-id', 'org_northstar', '--target-id', 'target-1', '--action', 'rollback',
    ]), /requires --confirm/);
    await run([
      'remediations', 'act', '--organization-id', 'org_northstar', '--hq-url', 'https://hq.example.com',
      '--target-id', 'target-1', '--action', 'approve', '--json-body', '{"establishAutoUpdatePolicy":true}', '--confirm',
    ]);
    assert.match(requests[3]!.url, /agent-fabric\/remediations\/target-1$/);
    assert.deepEqual(JSON.parse(String(requests[3]!.init?.body)), { establishAutoUpdatePolicy: true, action: 'approve' });
    const heldOutTrajectoryIds = Array.from({ length: 20 }, (_, index) => `trajectory-${index + 1}`);
    await run([
      'remediations', 'act', '--organization-id', 'org_northstar', '--hq-url', 'https://hq.example.com',
      '--target-id', 'target-2', '--action', 'run_backtest',
      '--json-body', JSON.stringify({ trajectoryIds: heldOutTrajectoryIds }), '--confirm',
    ]);
    assert.match(requests[4]!.url, /agent-fabric\/remediations\/target-2$/);
    assert.deepEqual(JSON.parse(String(requests[4]!.init?.body)), { trajectoryIds: heldOutTrajectoryIds, action: 'run_backtest' });
    await run([
      'remediations', 'act', '--organization-id', 'org_northstar', '--hq-url', 'https://hq.example.com',
      '--target-id', 'target-2', '--action', 'stage_evaluation',
      '--json-body', '{"endpointId":"11111111-1111-4111-8111-111111111111"}', '--confirm',
    ]);
    assert.deepEqual(JSON.parse(String(requests[5]!.init?.body)), {
      endpointId: '11111111-1111-4111-8111-111111111111', action: 'stage_evaluation',
    });
    const requestCountBeforeDryRun = requests.length;
    const dryRun = await run([
      'remediations', 'act', '--organization-id', 'org_northstar', '--hq-url', 'https://hq.example.com',
      '--target-id', 'target-2', '--action', 'stage_evaluation',
      '--endpoint-id', '11111111-1111-4111-8111-111111111111', '--dry-run',
    ]);
    assert.deepEqual(dryRun, {
      ok: true,
      planned: true,
      serverMutation: false,
      targetId: 'target-2',
      transition: {
        action: 'stage_evaluation',
        endpointId: '11111111-1111-4111-8111-111111111111',
      },
    });
    assert.equal(requests.length, requestCountBeforeDryRun);
    await assert.rejects(() => run([
      'remediations', 'act', '--organization-id', 'org_northstar', '--hq-url', 'https://hq.example.com',
      '--target-id', 'target-2', '--action', 'stage_evaluation',
      '--endpoint-id', '11111111-1111-1111-1111-11111111111-', '--dry-run',
    ]), /exact endpoint UUID/);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalToken === undefined) delete process.env.DHARMA_ORG_API_TOKEN;
    else process.env.DHARMA_ORG_API_TOKEN = originalToken;
  }
});

test('repository identity is credential-free and stable across Git transport forms', () => {
  assert.equal(
    normalizeGitRemoteIdentity('git@github.com:Dharma-AI-Labs/Northstar.git'),
    'github.com/dharma-ai-labs/northstar',
  );
  assert.equal(
    normalizeGitRemoteIdentity('https://oauth-token@github.com/dharma-ai-labs/northstar.git?ignored=1'),
    'github.com/dharma-ai-labs/northstar',
  );
  assert.equal(
    sourceRepositoryFingerprint('git@github.com:Dharma-AI-Labs/Northstar.git').fingerprint,
    sourceRepositoryFingerprint('https://token@github.com/dharma-ai-labs/northstar.git').fingerprint,
  );
  assert.throws(() => sourceRepositoryFingerprint(null), /--repository-key/);
  assert.throws(() => normalizeGitRemoteIdentity('file:///tmp/private-repo'), /explicit stable/);
});

test('CLI parser preserves repeated repository, key, and provider selections', () => {
  const parsed = parseCliOptions([
    'repositories', 'connect', '--repo', 'one', '--repo=two', '--repository-key', 'one=northstar-one',
    '--repository-key=two=northstar-two', '--provider', 'codex', '--provider=claude', '--non-interactive', '--json',
  ]);
  assert.deepEqual(parsed.positional, ['repositories', 'connect']);
  assert.deepEqual(parsed.repeated.get('repo'), ['one', 'two']);
  assert.deepEqual(parsed.repeated.get('repository-key'), ['one=northstar-one', 'two=northstar-two']);
  assert.deepEqual(parsed.repeated.get('provider'), ['codex', 'claude']);
  assert.equal(parsed.flags.get('non-interactive'), true);
  assert.deepEqual(parseSelectedProviderIds(parsed.repeated.get('provider') || []), ['codex', 'claude']);
  assert.deepEqual(parseSelectedProviderIds(['agy,codex', 'agy']), ['agy', 'codex']);
  assert.throws(() => parseSelectedProviderIds(['unsupported']), /codex, claude, or agy/);
});

test('workspace registration reuses a normalized repository identity across local paths', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dharma-repository-identity-'));
  const home = join(root, 'home');
  const first = join(root, 'machine-a');
  const second = join(root, 'machine-b');
  const unhosted = join(root, 'unhosted');
  await mkdir(home, { recursive: true });
  await writeFile(join(home, 'device.json'), JSON.stringify({
    organizationId: 'org_northstar',
    deviceId: 'device-northstar',
  }));
  for (const repository of [first, second, unhosted]) {
    await mkdir(repository);
    await execFileAsync('git', ['init', repository]);
  }
  await execFileAsync('git', ['-C', first, 'remote', 'add', 'origin', 'git@github.com:Dharma-AI-Labs/Northstar.git']);
  await execFileAsync('git', ['-C', second, 'remote', 'add', 'origin', 'https://token@github.com/dharma-ai-labs/northstar.git']);
  const previous = process.env.DHARMA_HOME;
  process.env.DHARMA_HOME = home;
  try {
    const left = await run(['workspace', 'add', first]) as Record<string, unknown>;
    const right = await run(['workspace', 'add', second]) as Record<string, unknown>;
    assert.notEqual(left.workspaceId, right.workspaceId);
    assert.equal(left.sourceFingerprint, right.sourceFingerprint);
    await assert.rejects(() => run(['workspace', 'add', unhosted]), /--repository-key/);
    const explicit = await run(['workspace', 'add', unhosted, '--repository-key', 'northstar/unhosted']) as Record<string, unknown>;
    assert.match(String(explicit.sourceFingerprint), /^sha256:[a-f0-9]{64}$/);
    const listed = await run(['repositories', 'list', '--verbose']) as { repositories: Array<Record<string, unknown>> };
    assert.equal(listed.repositories.length, 3);
    assert.equal(listed.repositories.every((entry) => entry.connected === false), true);
  } finally {
    if (previous === undefined) delete process.env.DHARMA_HOME;
    else process.env.DHARMA_HOME = previous;
  }
});

test('documented direct-sync commands enforce their required arguments', async () => {
  await assert.rejects(
    () => run(['workspace', 'sync', 'workspace-test', '--apply']),
    /Missing required option --policy-revision/,
  );
  await assert.rejects(
    () => run(['evidence', 'sync', '--workspace-id', 'workspace-test', '--policy', '.dharma/approved-policy.json']),
    /Missing required option --file/,
  );
});

test('status reports verified relay state and hides local identifiers by default', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dharma-cli-status-'));
  const previous = process.env.DHARMA_HOME;
  process.env.DHARMA_HOME = home;
  try {
    assert.equal(await relayProcessState(home), 'stopped');
    await mkdir(join(home, 'relay'), { recursive: true });
    await writeFile(join(home, 'relay', 'relay.pid'), `${process.pid}\n`);
    await writeFile(join(home, 'device.json'), JSON.stringify({
      organizationId: 'org_private', deviceId: 'device_private',
    }));
    const status = await run(['status']) as Record<string, unknown>;
    const version = await run(['version']) as Record<string, unknown>;
    assert.deepEqual(status, { version: version.version, enrolled: true, relay: 'running' });
    const diagnostic = await run(['status', '--verbose']) as Record<string, unknown>;
    assert.equal(diagnostic.organizationId, 'org_private');
    assert.equal(diagnostic.deviceId, 'device_private');
    assert.equal(diagnostic.home, home);
  } finally {
    if (previous === undefined) delete process.env.DHARMA_HOME;
    else process.env.DHARMA_HOME = previous;
  }
});

test('batch capture requires an explicit bound before touching the workspace', async () => {
  await assert.rejects(() => run(['evidence', 'capture-batch']), /requires --maximum-sessions or --session-ids-file/);
});

test('single capture selects an older session exactly and advances a changing session revision', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dharma-cli-capture-'));
  const home = join(root, 'home');
  const workspace = join(root, 'repo');
  const sessions = join(root, 'sessions');
  await mkdir(join(home, 'registry'), { recursive: true });
  await mkdir(workspace);
  await mkdir(sessions);
  const canonicalWorkspace = await realpath(workspace);
  const source = join(sessions, 'desktop.jsonl');
  const firstTurn = '019fcaab-6c8e-7432-bfb7-fc63efa3d728';
  const secondTurn = '019fcaac-6c8e-7432-bfb7-fc63efa3d729';
  const events = [
    { type: 'session_meta', payload: { cwd: canonicalWorkspace }, timestamp: '2026-08-12T01:00:00Z' },
    { type: 'turn_context', payload: { turn_id: firstTurn, cwd: canonicalWorkspace }, timestamp: '2026-08-12T01:00:01Z' },
    { type: 'event_msg', payload: { type: 'user_message', message: 'older task' }, timestamp: '2026-08-12T01:00:02Z' },
    { type: 'turn_context', payload: { turn_id: secondTurn, cwd: canonicalWorkspace }, timestamp: '2026-08-12T02:00:00Z' },
    { type: 'event_msg', payload: { type: 'user_message', message: 'newer task' }, timestamp: '2026-08-12T02:00:01Z' },
  ];
  await writeFile(source, events.map((value) => JSON.stringify(value)).join('\n'));
  const sourceHash = createHash('sha256').update(source).digest('hex');
  const selectedSessionId = `codex-${sourceHash.slice(0, 24)}:turn:${firstTurn}`;
  const allowlist = join(root, 'sessions.json');
  await writeFile(allowlist, JSON.stringify([selectedSessionId]));
  await writeFile(join(home, 'device.json'), JSON.stringify({
    hqUrl: 'https://www.dharma-ai.io', organizationId: 'org_test', deviceId: 'device_test',
    deviceName: 'test', platform: 'linux', publicKeyEd25519: 'test', serverPublicKeyEd25519: 'test',
    relayUrl: 'wss://relay.invalid', enrolledAt: '2026-08-12T00:00:00.000Z',
  }));
  await writeFile(join(home, 'registry', 'workspaces.json'), JSON.stringify([{
    workspaceId: 'workspace_test', organizationId: 'org_test', name: 'repo', path: canonicalWorkspace,
    routeHash: 'route', repositoryRemoteHash: null, defaultBranch: null, status: 'active',
  }]));
  const generated = await materializeWorkspacePolicy({ workspace, organizationId: 'org_test', revision: 'policy_test' });
  const policyPath = join(workspace, generated.relativePath);
  const previous = {
    home: process.env.DHARMA_HOME,
    allow: process.env.DHARMA_ALLOW_ENV_KEY,
    key: process.env.DHARMA_VAULT_KEY,
  };
  process.env.DHARMA_HOME = home;
  process.env.DHARMA_ALLOW_ENV_KEY = '1';
  process.env.DHARMA_VAULT_KEY = Buffer.alloc(32, 7).toString('base64');
  try {
    const first = await run([
      'evidence', 'capture', '--workspace', workspace, '--provider', 'codex', '--source-root', sessions,
      '--policy', policyPath, '--session-ids-file', allowlist,
    ]) as Record<string, unknown>;
    assert.match(String(first.sessionId), /^sha256:[a-f0-9]{64}$/);
    assert.equal(first.revision, 1);
    events.push(
      { type: 'turn_context', payload: { turn_id: firstTurn, cwd: canonicalWorkspace }, timestamp: '2026-08-12T03:00:00Z' },
      { type: 'event_msg', payload: { type: 'agent_message', message: 'older task completed later' }, timestamp: '2026-08-12T03:00:01Z' },
    );
    await writeFile(source, events.map((value) => JSON.stringify(value)).join('\n'));
    const second = await run([
      'evidence', 'capture', '--workspace', workspace, '--provider', 'codex', '--source-root', sessions,
      '--policy', policyPath, '--session-ids-file', allowlist,
    ]) as Record<string, unknown>;
    assert.equal(second.sessionId, first.sessionId);
    assert.equal(second.revision, 2);
    assert.equal(second.previousRevisionHash, first.capsuleHash);
    const retry = await run([
      'evidence', 'capture', '--workspace', workspace, '--provider', 'codex', '--source-root', sessions,
      '--policy', policyPath, '--session-ids-file', allowlist,
    ]) as Record<string, unknown>;
    assert.equal(retry.revision, 2);
    assert.equal(retry.capsuleHash, second.capsuleHash);
  } finally {
    if (previous.home === undefined) delete process.env.DHARMA_HOME; else process.env.DHARMA_HOME = previous.home;
    if (previous.allow === undefined) delete process.env.DHARMA_ALLOW_ENV_KEY; else process.env.DHARMA_ALLOW_ENV_KEY = previous.allow;
    if (previous.key === undefined) delete process.env.DHARMA_VAULT_KEY; else process.env.DHARMA_VAULT_KEY = previous.key;
  }
});

test('repository onboarding skill records scoped API metadata without local paths or credentials', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'dharma-repository-skill-'));
  const result = await installRepositoryAgentFabricSkill({
    workspace,
    hqUrl: 'https://www.dharma-ai.io',
    organizationId: 'org_northstar',
    workspaceId: 'workspace-northstar',
    policyRevision: 'policy-v1',
  });
  const skill = await readFile(join(workspace, result.skillPath), 'utf8');
  const connection = await readFile(join(workspace, result.connectionPath), 'utf8');
  assert.match(skill, /structured, task-bound handoff/);
  assert.match(skill, /local deterministic self-analysis/);
  assert.match(skill, /dharma skills verify --provider codex --workspace \./);
  assert.match(skill, /dharma skills verify --provider claude --workspace \./);
  assert.match(skill, /dharma skills verify --provider agy --workspace \./);
  assert.equal(skill.includes('<provider>'), false);
  assert.match(connection, /workspace-northstar/);
  assert.equal(connection.includes(workspace), false);
  assert.equal(/token|secret/i.test(connection), false);
  await installRepositoryAgentFabricSkill({
    workspace,
    hqUrl: 'https://www.dharma-ai.io',
    organizationId: 'org_northstar',
    workspaceId: 'workspace-northstar',
    policyRevision: 'policy-v2',
  });
  assert.match(await readFile(join(workspace, result.connectionPath), 'utf8'), /policy-v2/);
});

test('workspace policy refreshes serialize before requesting a new signed authorization', async () => {
  const previous = process.env.DHARMA_HOME;
  const home = await mkdtemp(join(tmpdir(), 'dharma-policy-refresh-lock-'));
  process.env.DHARMA_HOME = home;
  const events: string[] = [];
  try {
    const first = withWorkspacePolicyRefreshLock('workspace-concurrent', async () => {
      events.push('first-start');
      await new Promise((accept) => setTimeout(accept, 40));
      events.push('first-end');
    });
    await new Promise((accept) => setTimeout(accept, 5));
    const second = withWorkspacePolicyRefreshLock('workspace-concurrent', async () => {
      events.push('second-start');
      events.push('second-end');
    });
    await Promise.all([first, second]);
    assert.deepEqual(events, ['first-start', 'first-end', 'second-start', 'second-end']);
  } finally {
    if (previous === undefined) delete process.env.DHARMA_HOME;
    else process.env.DHARMA_HOME = previous;
  }
});

test('task execution and skill synchronization share one workspace-provider activation lock', async () => {
  const previous = process.env.DHARMA_HOME;
  const home = await mkdtemp(join(tmpdir(), 'dharma-skill-activation-lock-'));
  process.env.DHARMA_HOME = home;
  const events: string[] = [];
  try {
    const task = withWorkspaceSkillActivationLock('workspace-concurrent', 'codex', async () => {
      events.push('task-start');
      await new Promise((accept) => setTimeout(accept, 40));
      events.push('task-end');
    });
    await new Promise((accept) => setTimeout(accept, 5));
    const sync = withWorkspaceSkillActivationLock('workspace-concurrent', 'codex', async () => {
      events.push('sync-start');
      events.push('sync-end');
    });
    await Promise.all([task, sync]);
    assert.deepEqual(events, ['task-start', 'task-end', 'sync-start', 'sync-end']);
  } finally {
    if (previous === undefined) delete process.env.DHARMA_HOME;
    else process.env.DHARMA_HOME = previous;
  }
});

test('skill synchronization falls back only for legacy v1 authorization metadata', async () => {
  const native = await mkdtemp(join(tmpdir(), 'dharma-skill-sync-legacy-only-'));
  const workspaceId = 'workspace-legacy-only';
  const bundleId = '11111111-1111-4111-8111-111111111111';
  const managed = join(native, '.dharma-managed', 'workspaces', workspaceId);
  const active = join(managed, 'active');
  await mkdir(active, { recursive: true });
  await writeFile(join(managed, 'ACTIVE_BUNDLE'), `${bundleId}\n`);
  await writeFile(join(active, 'BUNDLE.json'), JSON.stringify({ bundleId, workspaceId, skillIds: [] }));
  await writeFile(join(active, 'AUTHORIZATION.json'), JSON.stringify({
    schema: 'dharma.skill-bundle/v2', bundleId,
  }));
  const verificationError = new Error('current bundle verification failed');

  await assert.rejects(
    recoverLegacySkillBundleIdAfterAuthorizationFailure({
      nativeSkillDirectory: native,
      workspaceId,
      authorizationError: verificationError,
    }),
    verificationError,
  );

  await writeFile(join(active, 'AUTHORIZATION.json'), JSON.stringify({
    schema: 'dharma.skill-bundle/v1', bundleId,
  }));
  assert.equal(await recoverLegacySkillBundleIdAfterAuthorizationFailure({
    nativeSkillDirectory: native,
    workspaceId,
    authorizationError: verificationError,
  }), bundleId);
  assert.equal(await installedBundleIdForSkillPollAfterAuthorizationFailure({
    nativeSkillDirectory: native,
    workspaceId,
    authorizationError: verificationError,
  }), bundleId);
});

test('repository onboarding refuses to overwrite an unmanaged skill', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'dharma-repository-skill-unmanaged-'));
  const root = join(workspace, '.agents', 'skills', 'dharma-agent-fabric');
  await mkdir(root, { recursive: true });
  await writeFile(join(root, 'SKILL.md'), '# Customer-owned skill\n');
  await assert.rejects(() => installRepositoryAgentFabricSkill({
    workspace,
    hqUrl: 'https://www.dharma-ai.io',
    organizationId: 'org_northstar',
    workspaceId: 'workspace-northstar',
    policyRevision: 'policy-v1',
  }), /Refusing to replace an unmanaged repository skill/);
});

test('blank-slate onboarding creates a conservative executable workspace policy', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'dharma-policy-'));
  await mkdir(join(workspace, 'src'));
  await writeFile(join(workspace, 'package.json'), JSON.stringify({ scripts: {
    test: 'node --test', lint: 'eslint .', deploy: 'curl https://example.com',
  } }));
  const generated = await materializeWorkspacePolicy({
    workspace, organizationId: 'org_northstar', revision: 'policy-1',
  });
  assert.equal(generated.relativePath, '.dharma/approved-policy.json');
  assert.deepEqual(Object.keys(generated.policy.tasks.allowedCommands), ['repo.test', 'repo.lint']);
  assert.deepEqual(generated.policy.tasks.writePaths, ['src/**']);
  assert.equal(generated.policy.tasks.defaultNetwork, 'deny');
  assert.equal(generated.policy.skills.automaticPromotionMaxRisk, 'R2');
  assert.deepEqual(generated.policy.evidence.automaticDisclosure, { mode: 'local_analysis' });
  const persisted = JSON.parse(await readFile(join(workspace, generated.relativePath), 'utf8'));
  assert.equal(persisted.organizationId, 'org_northstar');
});

test('applies only a server-issued bounded content grant to the local workspace policy', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'dharma-server-policy-'));
  const secureStore = memorySecureStore();
  const previousHome = process.env.DHARMA_HOME;
  process.env.DHARMA_HOME = workspace;
  await writeFile(join(workspace, 'device.json'), JSON.stringify({
    schema: 'dharma.device-config/v1', hqUrl: 'https://www.dharma-ai.io', organizationId: 'org_northstar',
    deviceId: 'device-test', relayUrl: 'wss://relay.dharma-ai.io',
  }));
  const signed = signedPolicyAuthorization({
    revision: 'agent-fabric-content-11111111-1111-4111-8111-111111111111',
    evidence: {
      automaticDisclosure: { mode: 'customer_authorized_content', consentReceiptId: 'consent_11111111-1111-4111-8111-111111111111', allowedContentClasses: ['native_provider_payload'] },
      maximumCapsuleBytes: 500_000, maximumDailyUploadBytes: 50_000_000,
    },
  });
  const generated = await materializeWorkspacePolicy({
    workspace,
    organizationId: 'org_northstar',
    revision: 'portal-bootstrap',
    serverPolicyAuthorization: signed.envelope,
    serverPublicKeyEd25519: signed.publicKeyEd25519,
    workspaceId: 'workspace-northstar',
    secureStore,
  });
  if (previousHome === undefined) delete process.env.DHARMA_HOME; else process.env.DHARMA_HOME = previousHome;
  assert.equal(generated.policy.revision, 'agent-fabric-content-11111111-1111-4111-8111-111111111111');
  assert.deepEqual(generated.policy.evidence.automaticDisclosure, {
    mode: 'customer_authorized_content',
    consentReceiptId: 'consent_11111111-1111-4111-8111-111111111111',
    allowedContentClasses: ['native_provider_payload'],
  });
  assert.equal(generated.policy.evidence.maximumCapsuleBytes, 500_000);
  assert.equal(generated.policy.tasks.defaultNetwork, 'deny');
  assert.throws(() => applyServerEvidencePolicy(generated.policy, { ...signed.envelope, signature: 'tampered' }, signed.publicKeyEd25519, 'org_northstar', 'workspace-northstar'), /signature is invalid/);
});

test('server evidence updates preserve existing workspace command and write authority', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'dharma-existing-policy-'));
  const secureStore = memorySecureStore();
  const previousHome = process.env.DHARMA_HOME;
  process.env.DHARMA_HOME = workspace;
  await writeFile(join(workspace, 'device.json'), JSON.stringify({
    schema: 'dharma.device-config/v1', hqUrl: 'https://www.dharma-ai.io', organizationId: 'org_northstar',
    deviceId: 'device-test', relayUrl: 'wss://relay.dharma-ai.io',
  }));
  await mkdir(join(workspace, '.dharma'), { recursive: true });
  const initial = await materializeWorkspacePolicy({ workspace, organizationId: 'org_northstar', revision: 'initial' });
  initial.policy.tasks.allowedCommands['customer.check'] = { argv: ['node', '--check', 'src/index.js'], timeoutSeconds: 60 };
  initial.policy.tasks.writePaths = ['customer-src/**'];
  await writeFile(join(workspace, initial.relativePath), JSON.stringify(initial.policy));
  const signed = signedPolicyAuthorization({
    revision: 'agent-fabric-local-analysis-v2',
    evidence: { automaticDisclosure: { mode: 'local_analysis' }, maximumCapsuleBytes: 500_000, maximumDailyUploadBytes: 5_000_000 },
  });
  const updated = await materializeWorkspacePolicy({
    workspace, organizationId: 'org_northstar', revision: 'ignored', serverPolicyAuthorization: signed.envelope,
    serverPublicKeyEd25519: signed.publicKeyEd25519, workspaceId: 'workspace-northstar', secureStore,
  });
  if (previousHome === undefined) delete process.env.DHARMA_HOME; else process.env.DHARMA_HOME = previousHome;
  assert.deepEqual(updated.policy.tasks.allowedCommands['customer.check']?.argv, ['node', '--check', 'src/index.js']);
  assert.deepEqual(updated.policy.tasks.writePaths, ['customer-src/**']);
});

test('daily content disclosure ledger is durable, bounded, and idempotent by capsule hash', async () => {
  const previous = process.env.DHARMA_HOME;
  const home = await mkdtemp(join(tmpdir(), 'dharma-content-ledger-'));
  process.env.DHARMA_HOME = home;
  try {
    const secureStore = memorySecureStore();
    await writeFile(join(home, 'device.json'), JSON.stringify({ schema: 'dharma.device-config/v1',
      hqUrl: 'https://www.dharma-ai.io', organizationId: 'org_northstar', deviceId: 'device-ledger', relayUrl: 'wss://relay.dharma-ai.io' }));
    const signed = signedPolicyAuthorization({
      revision: 'content-v1',
      evidence: {
        automaticDisclosure: { mode: 'customer_authorized_content', consentReceiptId: 'consent-ledger', allowedContentClasses: ['native_provider_payload'] },
        maximumCapsuleBytes: 1_000, maximumDailyUploadBytes: 700, maximumExpansionBytes: 100,
      },
    });
    const generated = await materializeWorkspacePolicy({
      workspace: home, organizationId: 'org_northstar', revision: 'content', workspaceId: 'workspace-northstar',
      serverPolicyAuthorization: signed.envelope, serverPublicKeyEd25519: signed.publicKeyEd25519,
      secureStore,
    });
    const policy = generated.policy;
    const signCapsule = (unsigned: Record<string, unknown>) => ({
      ...unsigned,
      capsuleHash: `sha256:${createHash('sha256').update(canonicalize(unsigned)).digest('hex')}`,
    });
    const first = signCapsule({ automaticDisclosureMode: 'customer_authorized_content', text: 'x'.repeat(300) });
    const second = signCapsule({ automaticDisclosureMode: 'customer_authorized_content', text: 'y'.repeat(300) });
    await reserveDailyContentUpload(first, policy, secureStore);
    await reserveDailyContentUpload(first, policy, secureStore);
    await assert.rejects(() => reserveDailyContentUpload(second, policy, secureStore), /daily content upload limit/i);
    await releaseDailyContentUpload(first, policy, secureStore);
    await reserveDailyContentUpload(second, policy, secureStore);
  } finally {
    if (previous === undefined) delete process.env.DHARMA_HOME; else process.env.DHARMA_HOME = previous;
  }
});

test('content authorization upgrades an empty legacy ledger and resets a stale daily ledger', async () => {
  const previous = process.env.DHARMA_HOME;
  const home = await mkdtemp(join(tmpdir(), 'dharma-content-ledger-upgrade-'));
  process.env.DHARMA_HOME = home;
  try {
    const secureStore = memorySecureStore();
    await mkdir(join(home, 'relay'), { recursive: true });
    await writeFile(join(home, 'device.json'), JSON.stringify({ schema: 'dharma.device-config/v1',
      hqUrl: 'https://www.dharma-ai.io', organizationId: 'org_northstar', deviceId: 'device-upgrade', relayUrl: 'wss://relay.dharma-ai.io' }));
    const signed = signedPolicyAuthorization({
      revision: 'content-upgrade-v1',
      evidence: {
        automaticDisclosure: { mode: 'customer_authorized_content', consentReceiptId: 'consent-upgrade', allowedContentClasses: ['native_provider_payload'] },
        maximumCapsuleBytes: 1_000, maximumDailyUploadBytes: 10_000, maximumExpansionBytes: 100,
      },
    });
    const input = {
      workspace: home, organizationId: 'org_northstar', revision: 'content-upgrade', workspaceId: 'workspace-northstar',
      serverPolicyAuthorization: signed.envelope, serverPublicKeyEd25519: signed.publicKeyEd25519,
      secureStore,
    };
    const today = new Date().toISOString().slice(0, 10);
    await writeFile(join(home, 'relay', 'evidence-upload-ledger.json'), JSON.stringify({ day: today, totalBytes: 0, capsuleHashes: [] }));
    await materializeWorkspacePolicy(input);
    let ledger = JSON.parse(await readFile(join(home, 'relay', 'evidence-upload-ledger.json'), 'utf8'));
    assert.deepEqual(ledger, { schema: 'dharma.evidence-upload-ledger/v2', day: today, totalBytes: 0, capsuleHashes: [], capsuleBytes: {} });

    await writeFile(join(home, 'relay', 'evidence-upload-ledger.json'), JSON.stringify({ day: '2020-01-01', totalBytes: 100, capsuleHashes: ['legacy-entry'] }));
    await materializeWorkspacePolicy(input);
    ledger = JSON.parse(await readFile(join(home, 'relay', 'evidence-upload-ledger.json'), 'utf8'));
    assert.deepEqual(ledger, { schema: 'dharma.evidence-upload-ledger/v2', day: today, totalBytes: 0, capsuleHashes: [], capsuleBytes: {} });
  } finally {
    if (previous === undefined) delete process.env.DHARMA_HOME; else process.env.DHARMA_HOME = previous;
  }
});

test('content authorization rejects a non-empty legacy ledger for the current day', async () => {
  const previous = process.env.DHARMA_HOME;
  const home = await mkdtemp(join(tmpdir(), 'dharma-content-ledger-reject-'));
  process.env.DHARMA_HOME = home;
  try {
    const secureStore = memorySecureStore();
    await mkdir(join(home, 'relay'), { recursive: true });
    await writeFile(join(home, 'device.json'), JSON.stringify({ schema: 'dharma.device-config/v1',
      hqUrl: 'https://www.dharma-ai.io', organizationId: 'org_northstar', deviceId: 'device-reject', relayUrl: 'wss://relay.dharma-ai.io' }));
    await writeFile(join(home, 'relay', 'evidence-upload-ledger.json'), JSON.stringify({
      day: new Date().toISOString().slice(0, 10), totalBytes: 100, capsuleHashes: ['legacy-entry'],
    }));
    const signed = signedPolicyAuthorization({
      revision: 'content-reject-v1',
      evidence: {
        automaticDisclosure: { mode: 'customer_authorized_content', consentReceiptId: 'consent-reject', allowedContentClasses: ['native_provider_payload'] },
        maximumCapsuleBytes: 1_000, maximumDailyUploadBytes: 10_000, maximumExpansionBytes: 100,
      },
    });
    await assert.rejects(() => materializeWorkspacePolicy({
      workspace: home, organizationId: 'org_northstar', revision: 'content-reject', workspaceId: 'workspace-northstar',
      serverPolicyAuthorization: signed.envelope, serverPublicKeyEd25519: signed.publicKeyEd25519,
      secureStore,
    }), /Evidence upload ledger is invalid/);
  } finally {
    if (previous === undefined) delete process.env.DHARMA_HOME; else process.env.DHARMA_HOME = previous;
  }
});

test('deleting the advisory local quota ledger does not bypass the authoritative server quota', async () => {
  const previous = process.env.DHARMA_HOME;
  const home = await mkdtemp(join(tmpdir(), 'dharma-content-ledger-delete-'));
  process.env.DHARMA_HOME = home;
  try {
    const secureStore = memorySecureStore();
    await writeFile(join(home, 'device.json'), JSON.stringify({ schema: 'dharma.device-config/v1',
      hqUrl: 'https://www.dharma-ai.io', organizationId: 'org_northstar', deviceId: 'device-delete', relayUrl: 'wss://relay.dharma-ai.io' }));
    const signed = signedPolicyAuthorization({
      revision: 'content-delete-v1',
      evidence: {
        automaticDisclosure: { mode: 'customer_authorized_content', consentReceiptId: 'consent-ledger-delete', allowedContentClasses: ['native_provider_payload'] },
        maximumCapsuleBytes: 1_000, maximumDailyUploadBytes: 700, maximumExpansionBytes: 100,
      },
    });
    const input = {
      workspace: home, organizationId: 'org_northstar', revision: 'content-delete', workspaceId: 'workspace-northstar',
      serverPolicyAuthorization: signed.envelope, serverPublicKeyEd25519: signed.publicKeyEd25519,
      secureStore,
    };
    await materializeWorkspacePolicy(input);
    await unlink(join(home, 'relay', 'evidence-upload-ledger.json'));
    await materializeWorkspacePolicy(input);
    assert.equal(JSON.parse(await readFile(join(home, 'relay', 'evidence-upload-ledger.json'), 'utf8')).totalBytes, 0);
  } finally {
    if (previous === undefined) delete process.env.DHARMA_HOME; else process.env.DHARMA_HOME = previous;
  }
});

test('queued content must match the current signed consent and policy revision', async () => {
  const base = await materializeWorkspacePolicy({ workspace: await mkdtemp(join(tmpdir(), 'dharma-current-grant-')), organizationId: 'org_northstar', revision: 'local' });
  const signed = signedPolicyAuthorization({
    revision: 'content-v2',
    evidence: {
      automaticDisclosure: { mode: 'customer_authorized_content', consentReceiptId: 'consent-current', allowedContentClasses: ['native_provider_payload'] },
      maximumCapsuleBytes: 1_000, maximumDailyUploadBytes: 1_000, maximumExpansionBytes: 100,
    },
  });
  const policy = applyServerEvidencePolicy(base.policy, signed.envelope, signed.publicKeyEd25519, 'org_northstar', 'workspace-northstar');
  const current = { organizationId: 'org_northstar', workspaceId: 'workspace-northstar', automaticDisclosureMode: 'customer_authorized_content', events: [], redactionReceipt: { disclosureMode: 'customer_authorized_content', policyRevision: 'content-v2', consentReceiptId: 'consent-current' } };
  assert.doesNotThrow(() => assertCapsuleAuthorizedByCurrentPolicy(current, policy));
  assert.throws(() => assertCapsuleAuthorizedByCurrentPolicy({ ...current, redactionReceipt: { disclosureMode: 'customer_authorized_content', policyRevision: 'content-v1', consentReceiptId: 'consent-old' } }, policy), /no longer authorized/);
  assert.throws(() => assertCapsuleAuthorizedByCurrentPolicy(current, { ...policy, evidence: { ...policy.evidence, automaticDisclosure: { mode: 'local_analysis' } } }), /invalid|no longer authorized/);
});

test('recovered task evidence distinguishes a superseded policy from the current revision', () => {
  const capsule = { redactionReceipt: { policyRevision: 'policy-v1' } } as never;
  assert.equal(recoveredTaskPolicyWasSuperseded(capsule, { revision: 'policy-v2' }), true);
  assert.equal(recoveredTaskPolicyWasSuperseded(capsule, { revision: 'policy-v1' }), false);
});

test('reduced capsules cannot disguise provider content as local analysis', async () => {
  const base = await materializeWorkspacePolicy({ workspace: await mkdtemp(join(tmpdir(), 'dharma-reduced-boundary-')), organizationId: 'org_northstar', revision: 'local' });
  const reduced = {
    organizationId: 'org_northstar', workspaceId: 'workspace-northstar', deviceId: '22222222-2222-4222-8222-222222222222',
    provider: 'codex', sessionId: `sha256:${'a'.repeat(64)}`, taskId: null,
    evidenceMode: base.policy.evidence.defaultMode, status: 'completed',
    coverage: { state: 'observed', admittedSessions: 1, excludedSessions: 0, missingFields: [] },
    automaticDisclosureMode: 'local_analysis', repoState: {}, skillState: {}, validationResults: [], contentIndex: [],
    events: [{
      schema: 'dharma.agent-event/v1', eventId: '33333333-3333-4333-8333-333333333333',
      organizationId: 'org_northstar', deviceId: '22222222-2222-4222-8222-222222222222', workspaceId: 'workspace-northstar',
      provider: 'codex', sessionId: `sha256:${'a'.repeat(64)}`, sequence: 0, occurredAt: '2026-08-12T00:00:00.000Z', kind: 'user_message', coverage: 'observed', contentRefs: [],
      payload: { nativeKind: 'user_message', recordBytes: 10, contentOmitted: true },
      source: { nativeEventId: null, sourceKind: 'user_message', localLocatorId: null }, skillBundleId: null, providerModel: null,
    }],
    localAnalysis: {
      schema: 'dharma.local-trajectory-analysis/v1', analyzer: 'deterministic', recordCount: 1,
      recordBytes: { total: 10, maximum: 10 }, eventKinds: { user_message: 1 },
      toolDiscipline: { calls: 0, results: 0, unmatchedCalls: 0, orphanResults: 0 },
      outcomeSignals: { errorRecords: 0, incomplete: false, coverage: 'observed' }, durationMs: 1,
      semanticReviewRecommended: false, reasonCodes: [],
    },
    redactionReceipt: { disclosureMode: 'local_analysis', policyRevision: base.policy.revision, consentReceiptId: null, disclosedClasses: ['local_deterministic_analysis'], excludedClasses: ['native_provider_payload'], classes: [] },
  };
  assert.doesNotThrow(() => assertCapsuleAuthorizedByCurrentPolicy(reduced, base.policy));
  const signedTaskBundleId = '44444444-4444-4444-8444-444444444444';
  const signedTask = {
    ...reduced,
    schema: 'dharma.trajectory-capsule/v3',
    taskId: '55555555-5555-4555-8555-555555555555',
    captureProvenance: {
      sourceClass: 'signed_task_execution',
      collectedAt: '2026-08-12T00:00:01.000Z',
      taskReceiptHash: `sha256:${'b'.repeat(64)}`,
    },
    events: reduced.events.map((event) => ({ ...event, skillBundleId: signedTaskBundleId })),
  };
  assert.doesNotThrow(() => assertCapsuleAuthorizedByCurrentPolicy(signedTask, base.policy));
  assert.throws(() => assertCapsuleAuthorizedByCurrentPolicy({
    ...signedTask,
    captureProvenance: { ...signedTask.captureProvenance, taskReceiptHash: null },
  }, base.policy), /unauthorized identity or policy metadata/i);
  assert.throws(() => assertCapsuleAuthorizedByCurrentPolicy({
    ...reduced,
    events: reduced.events.map((event) => ({ ...event, skillBundleId: '44444444-4444-4444-8444-444444444444' })),
  }, base.policy), /unauthorized event descriptors/i);
  assert.throws(() => assertCapsuleAuthorizedByCurrentPolicy({
    ...reduced,
    events: reduced.events.map((event) => ({ ...event, skillBundleId: 'forged-bundle' })),
  }, base.policy), /unauthorized event descriptors/i);
  assert.throws(() => assertCapsuleAuthorizedByCurrentPolicy({
    ...reduced,
    events: [{
      kind: 'user_message',
      payload: { nativeKind: 'user_message', recordBytes: 10, contentOmitted: true, nativeProviderPayload: 'private prompt' },
      source: { nativeEventId: null, sourceKind: 'user_message' },
    }],
  }, base.policy), /unauthorized provider content/i);
  assert.throws(() => assertCapsuleAuthorizedByCurrentPolicy({
    ...reduced,
    events: [{
      kind: 'user_message', payload: { nativeKind: 'private prompt', recordBytes: 10, contentOmitted: true },
      source: { nativeEventId: null, sourceKind: 'user_message' },
    }],
  }, base.policy), /unauthorized provider content/i);
  assert.throws(() => assertCapsuleAuthorizedByCurrentPolicy({
    ...reduced,
    contentIndex: [{ contentId: `sha256:${'a'.repeat(64)}`, kind: 'private prompt', bytes: 10, uploaded: false,
      availableLocally: true, mimeType: 'application/x-ndjson', normalizedPath: null }],
  }, base.policy), /unauthorized content descriptor/i);
  assert.throws(() => assertCapsuleAuthorizedByCurrentPolicy({
    ...reduced, repoState: { source: 'private code' },
  }, base.policy), /unauthorized auxiliary content/i);
  assert.throws(() => assertCapsuleAuthorizedByCurrentPolicy({
    ...reduced, localAnalysis: { ...reduced.localAnalysis, reasonCodes: ['secret=customer-token'] },
  }, base.policy), /invalid free-form analysis/i);
  assert.throws(() => assertCapsuleAuthorizedByCurrentPolicy({
    ...reduced,
    events: [{ ...reduced.events[0], providerModel: 'customer-secret-in-metadata' }],
  }, base.policy), /unauthorized event descriptors/i);
  assert.throws(() => assertCapsuleAuthorizedByCurrentPolicy({
    ...reduced,
    events: [{ ...reduced.events[0]!, source: { ...reduced.events[0]!.source, localLocatorId: 'customer-secret-in-metadata' } }],
  }, base.policy), /unauthorized event descriptors/i);
  assert.throws(() => assertCapsuleAuthorizedByCurrentPolicy({
    ...reduced, redactionReceipt: { ...reduced.redactionReceipt, classes: ['secret=customer-token'] },
  }, base.policy), /invalid redaction receipt classes/i);
  assert.throws(() => assertCapsuleAuthorizedByCurrentPolicy({
    ...reduced, coverage: { ...reduced.coverage, missingFields: ['customer-secret-in-metadata'] },
  }, base.policy), /unauthorized identity or policy metadata/i);
  assert.throws(() => assertCapsuleAuthorizedByCurrentPolicy({
    ...reduced, redactionReceipt: { ...reduced.redactionReceipt, disclosedClasses: ['customer-secret-in-metadata'] },
  }, base.policy), /invalid redaction receipt classes/i);
});

test('a generated reduced Claude task capsule passes the current authorization boundary', async () => {
  const base = await materializeWorkspacePolicy({
    workspace: await mkdtemp(join(tmpdir(), 'dharma-claude-reduced-')),
    organizationId: 'org_northstar',
    revision: 'local',
  });
  const capsule = buildTrajectoryCapsule({
    organizationId: 'org_northstar',
    deviceId: '22222222-2222-4222-8222-222222222222',
    workspaceId: 'workspace-northstar',
    policy: base.policy,
    taskId: '55555555-5555-4555-8555-555555555555',
    activeSkillBundleId: '44444444-4444-4444-8444-444444444444',
    activeSkillBundleActivatedAt: '2026-08-18T16:59:00.000Z',
    activeSkillBundleExpiresAt: '2026-08-19T17:00:00.000Z',
    activeSkillBundleVerifiedAt: '2026-08-18T17:00:00.000Z',
    captureProvenance: {
      sourceClass: 'signed_task_execution',
      collectedAt: '2026-08-18T17:00:01.000Z',
      taskReceiptHash: `sha256:${'b'.repeat(64)}`,
    },
    rawContentId: `sha256:${'c'.repeat(64)}`,
    rawBytes: 1_000,
    session: {
      provider: 'claude',
      sessionId: 'claude-native-session',
      sourcePath: '/private/claude.jsonl',
      workspace: '/repo',
      coverage: 'observed',
      startedAt: '2026-08-18T17:00:00.000Z',
      endedAt: '2026-08-18T17:00:01.000Z',
      records: [
        { native: { type: 'system' }, sourcePath: '/private/claude.jsonl', line: 1, workspace: '/repo', timestamp: '2026-08-18T17:00:00.000Z', kind: 'metadata' },
        { native: { type: 'rate_limit_event' }, sourcePath: '/private/claude.jsonl', line: 2, workspace: '/repo', timestamp: '2026-08-18T17:00:00.100Z', kind: 'metadata' },
        { native: { type: 'assistant' }, sourcePath: '/private/claude.jsonl', line: 3, workspace: '/repo', timestamp: '2026-08-18T17:00:00.200Z', kind: 'agent_message' },
      ],
    },
  });

  assert.doesNotThrow(() => assertCapsuleAuthorizedByCurrentPolicy(capsule as unknown as Record<string, unknown>, base.policy));
});

test('server withdrawal resets a workspace to local analysis without retaining a consent receipt', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'dharma-local-policy-'));
  const signed = signedPolicyAuthorization({
    revision: 'agent-fabric-local-analysis-v1',
    evidence: { automaticDisclosure: { mode: 'local_analysis' }, maximumCapsuleBytes: 1_048_576, maximumDailyUploadBytes: 50_000_000 },
  });
  const generated = await materializeWorkspacePolicy({
    workspace,
    organizationId: 'org_northstar',
    revision: 'content-policy-old',
    serverPolicyAuthorization: signed.envelope,
    serverPublicKeyEd25519: signed.publicKeyEd25519,
    workspaceId: 'workspace-northstar',
  });
  assert.equal(generated.policy.revision, 'agent-fabric-local-analysis-v1');
  assert.deepEqual(generated.policy.evidence.automaticDisclosure, { mode: 'local_analysis' });
});

test('server may withdraw content to metadata-only and dry-run does not mutate the workspace policy', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'dharma-metadata-policy-'));
  const policyPath = join(workspace, '.dharma', 'approved-policy.json');
  const signed = signedPolicyAuthorization({
    revision: 'agent-fabric-metadata-only-v1',
    evidence: { automaticDisclosure: { mode: 'metadata_only' }, maximumCapsuleBytes: 1_048_576, maximumDailyUploadBytes: 50_000_000 },
  });
  const generated = await materializeWorkspacePolicy({
    workspace, organizationId: 'org_northstar', revision: 'old', serverPolicyAuthorization: signed.envelope,
    serverPublicKeyEd25519: signed.publicKeyEd25519, workspaceId: 'workspace-northstar', dryRun: true,
  });
  assert.equal(generated.applied, false);
  assert.equal(generated.policy.evidence.automaticDisclosure?.mode, 'metadata_only');
  await assert.rejects(() => readFile(policyPath, 'utf8'), /ENOENT/);
});

test('materializes signed inline files without repository credentials and rejects traversal', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dharma-inline-skill-'));
  const content = Buffer.from('# Private remediation\n');
  const file = {
    path: 'SKILL.md',
    contentBase64: content.toString('base64'),
    sha256: `sha256:${createHash('sha256').update(content).digest('hex')}`,
  };
  const bundle = {
    operation: 'install',
    skills: [{ path: 'skills/remediation', files: [file] }],
  } as unknown as SkillBundle;
  assert.equal(await materializeInlineSkillFiles(bundle, root), true);
  assert.equal(await readFile(join(root, 'skills/remediation/SKILL.md'), 'utf8'), '# Private remediation\n');
  await assert.rejects(
    () => materializeInlineSkillFiles({ ...bundle, skills: [{ path: 'skills/remediation', files: [{ ...file, path: '../secret' }] }] } as unknown as SkillBundle, root),
    /path is invalid/,
  );
});

test('provider skill roots map to each host native discovery directory', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dharma-provider-skills-'));
  assert.equal(nativeSkillDirectory('codex', {}, home), join(home, '.codex', 'skills'));
  assert.equal(nativeSkillDirectory('claude', {}, home), join(home, '.claude', 'skills'));
  assert.equal(
    nativeSkillDirectory('agy', {}, home),
    join(home, '.gemini', 'antigravity-cli', 'plugins', 'dharma-agent-fabric', 'skills'),
  );
  assert.equal(nativeSkillDirectory('codex', { CODEX_HOME: join(home, 'custom-codex') }, home), join(home, 'custom-codex', 'skills'));
  assert.equal(nativeSkillDirectory('claude', { CLAUDE_CONFIG_DIR: join(home, 'custom-claude') }, home), join(home, 'custom-claude', 'skills'));
  assert.equal(
    nativeSkillDirectory('agy', { AGY_CONFIG_DIR: join(home, 'custom-agy') }, home),
    join(home, 'custom-agy', 'plugins', 'dharma-agent-fabric', 'skills'),
  );
});

test('native bootstrap installation makes the repository skill verifiable by Codex', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dharma-native-skill-'));
  const home = join(root, 'home');
  const workspace = join(root, 'repo');
  await mkdir(workspace, { recursive: true });
  await installRepositoryAgentFabricSkill({
    workspace,
    hqUrl: 'https://www.dharma-ai.io',
    organizationId: 'org_test',
    workspaceId: 'workspace_test',
    policyRevision: 'agent-fabric-policy-v1',
  });
  const installed = await installNativeAgentFabricBootstrap({
    provider: 'codex',
    workspace,
    workspaceId: 'workspace_test',
    organizationId: 'org_test',
    hqUrl: 'https://www.dharma-ai.io',
    home,
  });
  assert.equal(installed.verified, true);
  assert.equal(installed.activation, 'next_session');
  assert.match(await readFile(installed.skillPath, 'utf8'), /dharma skills verify --provider codex/);
  const verified = await verifyAgentFabricSkillInstallation({ provider: 'codex', workspace, home });
  assert.equal(verified.ready, true);
  assert.equal(verified.repositoryInstalled, true);
  assert.equal(verified.nativeInstalled, true);
});

test('native bootstrap installation refuses to overwrite an unmanaged provider skill', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dharma-native-skill-unmanaged-'));
  const home = join(root, 'home');
  const workspace = join(root, 'repo');
  const unmanaged = join(home, '.codex', 'skills', 'dharma-agent-fabric');
  await mkdir(unmanaged, { recursive: true });
  await mkdir(workspace, { recursive: true });
  await writeFile(join(unmanaged, 'SKILL.md'), '# Customer-owned skill\n');
  await assert.rejects(() => installNativeAgentFabricBootstrap({
    provider: 'codex',
    workspace,
    workspaceId: 'workspace_test',
    organizationId: 'org_test',
    hqUrl: 'https://www.dharma-ai.io',
    home,
  }), /Refusing to replace an unmanaged codex skill/);
});

test('Agy activation validates and registers the generated plugin before enabling it', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dharma-agy-plugin-'));
  const calls: Array<{ executable: string; argv: string[] }> = [];
  await activateAgyPlugin({
    home,
    env: {},
    execute: async (executable, argv) => { calls.push({ executable, argv }); },
  });
  const root = join(home, '.gemini', 'antigravity-cli', 'plugins', 'dharma-agent-fabric');
  assert.deepEqual(JSON.parse(await readFile(join(root, 'plugin.json'), 'utf8')), { name: 'dharma-agent-fabric' });
  assert.deepEqual(calls, [
    { executable: 'agy', argv: ['plugin', 'validate', root] },
    { executable: 'agy', argv: ['plugin', 'install', root] },
    { executable: 'agy', argv: ['plugin', 'enable', 'dharma-agent-fabric'] },
  ]);
});

test('native bootstrap installation isolates provider failures during onboarding', async () => {
  const result = await installAvailableNativeAgentFabricBootstraps({
    providers: [
      { provider: 'codex', skillInstall: 'available' },
      { provider: 'claude', skillInstall: 'unavailable' },
      { provider: 'agy', skillInstall: 'available' },
    ],
    workspace: '/workspace',
    workspaceId: 'workspace_test',
    organizationId: 'org_test',
    hqUrl: 'https://www.dharma-ai.io',
    install: async (input) => {
      if (input.provider === 'agy') throw new Error('Agy plugin registration failed.');
      return {
        provider: input.provider,
        nativeSkillDirectory: '/skills',
        skillPath: '/skills/SKILL.md',
        activation: 'next_session',
        verified: true,
      };
    },
  });
  assert.deepEqual(result.installed.map((item) => item.provider), ['codex']);
  assert.deepEqual(result.failures, [{
    provider: 'agy',
    code: 'native_skill_install_failed',
    message: 'Agy plugin registration failed.',
  }]);
});

test('evidence preview counts native turns without disclosing paths or prompt bodies', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dharma-cli-preview-'));
  const workspace = join(root, 'repo');
  const sessions = join(root, 'sessions');
  await mkdir(workspace);
  await mkdir(sessions);
  const canonicalWorkspace = await realpath(workspace);
  await writeFile(join(sessions, 'desktop.jsonl'), [
    { type: 'session_meta', payload: { cwd: canonicalWorkspace }, timestamp: '2026-08-03T01:00:00Z' },
    { type: 'turn_context', payload: { turn_id: '019fcaab-6c8e-7432-bfb7-fc63efa3d728', cwd: canonicalWorkspace }, timestamp: '2026-08-03T01:00:01Z' },
    { type: 'event_msg', payload: { type: 'user_message', message: 'private prompt body' }, timestamp: '2026-08-03T01:00:02Z' },
  ].map((value) => JSON.stringify(value)).join('\n'));
  const result = await run([
    'evidence', 'preview', '--workspace', workspace, '--provider', 'codex', '--source-root', sessions,
  ]) as Record<string, unknown>;
  const encoded = JSON.stringify(result);
  assert.equal(result.trajectoryCount, 1);
  assert.deepEqual(result.automaticDisclosure, {
    ready: false,
    reason: 'Add --policy <path> to calculate exact automatic-capsule bytes and content classes before sync.',
    disclosureClass: 'automatic_capsule',
    rawProviderBytesUploaded: 0,
    syncRequiresExplicitFlag: true,
  });
  assert.equal(encoded.includes(root), false);
  assert.equal(encoded.includes('private prompt body'), false);
});

test('task response preview extracts the final agent message and removes secrets', () => {
  const receipt = {
    taskId: 'task', status: 'completed' as const, worktree: '/private/worktree', branch: 'dharma/task/task',
    startedAt: '2026-08-04T00:00:00Z', completedAt: '2026-08-04T00:00:01Z',
    commandResults: [{
      commandId: 'provider.codex', exitCode: 0, signal: null, timedOut: false,
      stdout: [
        JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'First draft' } }),
        JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'Architecture summary. api_key=secret-secret-secret' } }),
      ].join('\n'),
      stderr: '', stdoutSha256: `sha256:${'1'.repeat(64)}`, stderrSha256: `sha256:${'0'.repeat(64)}`,
    }],
  };
  const preview = taskResponsePreview(receipt);
  assert.match(preview?.text || '', /Architecture summary/);
  assert.equal(preview?.text.includes('secret-secret-secret'), false);
  assert.ok((preview?.redactedValues || 0) >= 1);
});

test('provider response extraction recognizes the supported Agy success envelope', () => {
  assert.equal(
    responseTextFromEvent({ status: 'SUCCESS', response: 'dharma-agent-fabric' }),
    'dharma-agent-fabric',
  );
  assert.equal(responseTextFromEvent({ status: 'ERROR', response: 'ignored' }), null);
});

test('task response preview exposes bounded Agy success output', () => {
  const receipt = {
    taskId: 'task', status: 'completed' as const, worktree: '/private/worktree', branch: 'dharma/task/task',
    startedAt: '2026-08-16T00:00:00Z', completedAt: '2026-08-16T00:00:01Z',
    commandResults: [{
      commandId: 'provider.agy', exitCode: 0, signal: null, timedOut: false,
      stdout: JSON.stringify({ status: 'SUCCESS', response: 'Agy answer. api_key=secret-secret-secret' }),
      stderr: '', stdoutSha256: `sha256:${'1'.repeat(64)}`, stderrSha256: `sha256:${'0'.repeat(64)}`,
    }],
  };
  const preview = taskResponsePreview(receipt);
  assert.match(preview?.text || '', /Agy answer/);
  assert.equal(preview?.text.includes('secret-secret-secret'), false);
  assert.ok((preview?.redactedValues || 0) >= 1);
});

test('signed task receipt becomes a deterministic provider session for candidate evidence', () => {
  const task = {
    schema: 'dharma.task/v1' as const,
    taskId: '11111111-1111-4111-8111-111111111111', organizationId: 'org_test', workspaceId: 'workspace_test',
    taskType: 'evaluation_retest' as const,
    target: { deviceId: '22222222-2222-4222-8222-222222222222', provider: 'codex' as const },
    skillBundle: { bundleId: '77777777-7777-4777-8777-777777777777', bundleHash: `sha256:${'a'.repeat(64)}` },
    instructions: 'Evaluate the held-out case.', requiredSkills: [],
    authority: { readPaths: ['.'], writePaths: [], commands: [{ commandId: 'provider.codex' }], network: 'deny', git: 'read_only' as const },
    execution: { isolation: 'git_worktree' as const, timeoutSeconds: 60, leaseSeconds: 120, maximumConcurrentAgents: 1 },
    acceptance: { commands: [], requiredArtifacts: [] },
    budget: { mode: 'byok_local' as const, maximumDharmaCostCents: 0 },
    createdAt: '2026-08-16T01:00:00.000Z', expiresAt: '2026-08-16T01:05:00.000Z', nonce: 'nonce', signature: null,
  };
  const receipt = {
    taskId: task.taskId, status: 'completed' as const, worktree: '/private/worktree', branch: 'dharma/task/test',
    startedAt: '2026-08-16T01:00:01.000Z', completedAt: '2026-08-16T01:00:02.000Z',
    commandResults: [{
      commandId: 'provider.codex', exitCode: 0, signal: null, timedOut: false,
      stdout: 'bounded result', stderr: '',
      stdoutSha256: `sha256:${'1'.repeat(64)}`, stderrSha256: `sha256:${'0'.repeat(64)}`,
    }],
  };
  const session = taskReceiptSession(task, receipt, '/workspace');
  assert.equal(session.sessionId, `dharma-task-${task.taskId}`);
  assert.equal(session.endedAt, receipt.completedAt);
  assert.equal(session.records[0]?.native.taskId, task.taskId);
  assert.equal(session.records[0]?.kind, 'user_message');
  assert.equal(session.records[0]?.native.type, 'user_message');
  assert.equal(session.records[0]?.native.role, 'user');
  assert.equal(session.records[0]?.native.content, task.instructions);
  assert.equal(session.records[0]?.timestamp, receipt.startedAt);
  assert.equal(session.records[0]?.sourcePath, 'dharma-task-receipt');
  assert.equal(session.records[1]?.kind, 'agent_message');
  assert.equal(session.records[1]?.native.stdout, 'bounded result');
  assert.equal(JSON.stringify(session.records[0]?.native).includes('/workspace'), false);
  assert.equal(JSON.stringify(session.records[0]?.native).includes('/private/worktree'), false);
});

test('signed A2A task evidence records the same structured instructions sent to the provider', () => {
  const task = {
    schema: 'dharma.task/v1' as const,
    taskId: '11111111-1111-4111-8111-111111111112', organizationId: 'org_test', workspaceId: 'workspace_test',
    taskType: 'a2a_handoff' as const,
    target: { deviceId: '22222222-2222-4222-8222-222222222222', provider: 'agy' as const },
    skillBundle: { bundleId: '77777777-7777-4777-8777-777777777777', bundleHash: `sha256:${'a'.repeat(64)}` },
    source: { taskId: '00000000-0000-4000-8000-000000000001', endpointId: 'source-endpoint' },
    stateEnvelope: {
      intent: 'Resolve a bounded implementation question.',
      evidence_used: ['trace:example'],
      known_state: { finding: 'The failing check is isolated.' },
      unknown_or_missing_state: ['Deployment authority is not granted.'],
      allowed_next_actions: ['inspect'],
      blocked_actions: ['deploy'],
      decision_authority: 'read_only',
      tool_results: [],
    },
    evidenceReferences: [{
      trajectoryId: '33333333-3333-4333-8333-333333333333',
      revision: 1,
      capsuleHash: `sha256:${'b'.repeat(64)}`,
    }],
    instructions: 'Inspect the signed handoff and return a bounded recommendation.', requiredSkills: [],
    authority: { readPaths: ['.'], writePaths: [], commands: [{ commandId: 'provider.agy' }], network: 'deny', git: 'read_only' as const },
    execution: { isolation: 'git_worktree' as const, timeoutSeconds: 60, leaseSeconds: 120, maximumConcurrentAgents: 1 },
    acceptance: { commands: [], requiredArtifacts: [] },
    budget: { mode: 'byok_local' as const, maximumDharmaCostCents: 0 },
    createdAt: '2026-08-16T01:00:00.000Z', expiresAt: '2026-08-16T01:05:00.000Z', nonce: 'nonce', signature: null,
  };
  const receipt = {
    taskId: task.taskId, status: 'completed' as const, worktree: '/private/worktree', branch: 'dharma/task/test',
    startedAt: '2026-08-16T01:00:01.000Z', completedAt: '2026-08-16T01:00:02.000Z',
    commandResults: [{
      commandId: 'provider.agy', exitCode: 0, signal: null, timedOut: false,
      stdout: 'bounded result', stderr: '',
      stdoutSha256: `sha256:${'1'.repeat(64)}`, stderrSha256: `sha256:${'0'.repeat(64)}`,
    }],
  };
  const session = taskReceiptSession(task, receipt, '/workspace');
  const content = String(session.records[0]?.native.content);
  assert.match(content, /^Inspect the signed handoff/);
  assert.match(content, /<dharma_a2a_context>/);
  assert.match(content, /Deployment authority is not granted/);
  assert.match(content, /"blocked_actions": \[\n      "deploy"/);
  assert.equal(content.includes('/workspace'), false);
  assert.equal(content.includes('/private/worktree'), false);
});

test('task execution requires the signed bundle pin to match the active native bundle', () => {
  const pin = { bundleId: 'bundle-1', bundleHash: `sha256:${'a'.repeat(64)}` };
  const active = { bundleId: 'bundle-1', bundleHash: pin.bundleHash };
  assert.doesNotThrow(() => assertTaskSkillPin(pin, active));
  assert.doesNotThrow(() => assertTaskSkillPin(null, null));
  assert.throws(
    () => assertTaskSkillPin(pin, { ...active, bundleId: 'bundle-2' }),
    /does not match the active local bundle \(task=bundle-1, local=bundle-2\)/,
  );
  assert.throws(() => assertTaskSkillPin(undefined as never, active), /missing its signed/);
  assert.throws(() => assertTaskSkillPin({ ...pin, bundleHash: 'invalid' }, active), /hash is invalid/);
  assert.throws(
    () => assertTaskSkillPin(pin, { ...active, bundleHash: `sha256:${'b'.repeat(64)}` }),
    /hash does not match the active local bundle/,
  );
  assert.equal(taskSkillPinFailureCode(new Error('Task skill bundle does not match the active local bundle.')), 'skill_bundle_mismatch');
  assert.equal(taskSkillPinFailureCode(new Error('Task skill bundle hash is invalid.')), 'skill_bundle_hash_invalid');
});

test('recovered signed-task evidence is bound to its registered workspace policy', () => {
  const workspace = { workspaceId: 'workspace-a', organizationId: 'org-a' };
  assert.doesNotThrow(() => assertRecoveredTaskWorkspacePolicy({
    recoveryWorkspaceId: 'workspace-a',
    workspace,
    policy: { organizationId: 'org-a', serverAuthorization: undefined },
  }));
  assert.throws(() => assertRecoveredTaskWorkspacePolicy({
    recoveryWorkspaceId: 'workspace-b',
    workspace,
    policy: { organizationId: 'org-a', serverAuthorization: undefined },
  }), /does not match its registered workspace/);
  assert.throws(() => assertRecoveredTaskWorkspacePolicy({
    recoveryWorkspaceId: 'workspace-a',
    workspace,
    policy: { organizationId: 'org-b', serverAuthorization: undefined },
  }), /does not authorize its workspace/);
});

test('a signed task executes only under its own registered workspace policy', () => {
  const task = { organizationId: 'org-a', workspaceId: 'workspace-a' } as const;
  const workspace = { organizationId: 'org-a', workspaceId: 'workspace-a' };
  assert.doesNotThrow(() => assertTaskWorkspacePolicy({
    task,
    workspace,
    policy: { organizationId: 'org-a', serverAuthorization: undefined },
  }));
  assert.throws(() => assertTaskWorkspacePolicy({
    task,
    workspace,
    policy: { organizationId: 'org-a', serverAuthorization: { workspaceId: 'workspace-b' } as never },
  }), /does not match the signed task/);
  assert.throws(() => assertTaskWorkspacePolicy({
    task: { ...task, workspaceId: 'workspace-b' },
    workspace,
    policy: { organizationId: 'org-a', serverAuthorization: undefined },
  }), /does not match the signed task/);
});
