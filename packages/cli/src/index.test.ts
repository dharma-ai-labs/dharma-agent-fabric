import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import {
  activateAgyPlugin,
  assertCapsuleAuthorizedByCurrentPolicy,
  assertTaskSkillPin,
  installNativeAgentFabricBootstrap,
  installRepositoryAgentFabricSkill,
  isDirectExecution,
  materializeWorkspacePolicy,
  applyServerEvidencePolicy,
  materializeInlineSkillFiles,
  nativeSkillDirectory,
  rawLocalRetentionDays,
  relayProcessState,
  releaseDailyContentUpload,
  reserveDailyContentUpload,
  run,
  taskResponsePreview,
  taskSkillPinFailureCode,
  verifyAgentFabricSkillInstallation,
} from './index.js';
import type { SkillBundle } from '@dharma-ai-labs/agent-fabric-skill-manager';
import { canonicalize, signCanonicalObject } from '@dharma-ai-labs/agent-fabric-contracts';

const execFileAsync = promisify(execFile);

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

test('version is parser-safe structured output', async () => {
  assert.deepEqual(await run(['version']), { version: '0.1.10' });
});

test('help is successful and direct basic commands keep stdout and stderr clean', async () => {
  assert.match(String(await run(['--help'])), /^Usage: dharma/);
  const entrypoint = new URL('./index.js', import.meta.url);
  for (const argv of [['--help'], ['--version']]) {
    const result = await execFileAsync(process.execPath, [fileURLToPath(entrypoint), ...argv], { encoding: 'utf8' });
    assert.equal(result.stderr, '');
    assert.equal(result.stdout.includes('ExperimentalWarning'), false);
  }
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
    assert.deepEqual(status, { version: '0.1.10', enrolled: true, relay: 'running' });
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
    assert.equal(first.sessionId, selectedSessionId);
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
    assert.equal(second.sessionId, selectedSessionId);
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
  });
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
    serverPublicKeyEd25519: signed.publicKeyEd25519, workspaceId: 'workspace-northstar',
  });
  assert.deepEqual(updated.policy.tasks.allowedCommands['customer.check']?.argv, ['node', '--check', 'src/index.js']);
  assert.deepEqual(updated.policy.tasks.writePaths, ['customer-src/**']);
});

test('daily content disclosure ledger is durable, bounded, and idempotent by capsule hash', async () => {
  const previous = process.env.DHARMA_HOME;
  const home = await mkdtemp(join(tmpdir(), 'dharma-content-ledger-'));
  process.env.DHARMA_HOME = home;
  try {
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
    });
    const policy = generated.policy;
    const signCapsule = (unsigned: Record<string, unknown>) => ({
      ...unsigned,
      capsuleHash: `sha256:${createHash('sha256').update(canonicalize(unsigned)).digest('hex')}`,
    });
    const first = signCapsule({ automaticDisclosureMode: 'customer_authorized_content', text: 'x'.repeat(300) });
    const second = signCapsule({ automaticDisclosureMode: 'customer_authorized_content', text: 'y'.repeat(300) });
    await reserveDailyContentUpload(first, policy);
    await reserveDailyContentUpload(first, policy);
    await assert.rejects(() => reserveDailyContentUpload(second, policy), /daily content upload limit/i);
    await releaseDailyContentUpload(first, policy);
    await reserveDailyContentUpload(second, policy);
  } finally {
    if (previous === undefined) delete process.env.DHARMA_HOME; else process.env.DHARMA_HOME = previous;
  }
});

test('deleting an initialized content quota ledger fails closed on policy refresh', async () => {
  const previous = process.env.DHARMA_HOME;
  const home = await mkdtemp(join(tmpdir(), 'dharma-content-ledger-delete-'));
  process.env.DHARMA_HOME = home;
  try {
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
    };
    await materializeWorkspacePolicy(input);
    await unlink(join(home, 'relay', 'evidence-upload-ledger.json'));
    await assert.rejects(() => materializeWorkspacePolicy(input), /quota ledger is missing/i);
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
  const current = { automaticDisclosureMode: 'customer_authorized_content', events: [], redactionReceipt: { disclosureMode: 'customer_authorized_content', policyRevision: 'content-v2', consentReceiptId: 'consent-current' } };
  assert.doesNotThrow(() => assertCapsuleAuthorizedByCurrentPolicy(current, policy));
  assert.throws(() => assertCapsuleAuthorizedByCurrentPolicy({ ...current, redactionReceipt: { disclosureMode: 'customer_authorized_content', policyRevision: 'content-v1', consentReceiptId: 'consent-old' } }, policy), /no longer authorized/);
  assert.throws(() => assertCapsuleAuthorizedByCurrentPolicy(current, { ...policy, evidence: { ...policy.evidence, automaticDisclosure: { mode: 'local_analysis' } } }), /invalid|no longer authorized/);
});

test('reduced capsules cannot disguise provider content as local analysis', async () => {
  const base = await materializeWorkspacePolicy({ workspace: await mkdtemp(join(tmpdir(), 'dharma-reduced-boundary-')), organizationId: 'org_northstar', revision: 'local' });
  const reduced = {
    automaticDisclosureMode: 'local_analysis', repoState: {}, skillState: {}, validationResults: [], contentIndex: [],
    events: [{ payload: { nativeKind: 'user_message', recordBytes: 10, contentOmitted: true } }],
    redactionReceipt: { disclosureMode: 'local_analysis', consentReceiptId: null },
  };
  assert.doesNotThrow(() => assertCapsuleAuthorizedByCurrentPolicy(reduced, base.policy));
  assert.throws(() => assertCapsuleAuthorizedByCurrentPolicy({
    ...reduced,
    events: [{ payload: { nativeKind: 'user_message', recordBytes: 10, contentOmitted: true, nativeProviderPayload: 'private prompt' } }],
  }, base.policy), /unauthorized provider content/i);
  assert.throws(() => assertCapsuleAuthorizedByCurrentPolicy({
    ...reduced, repoState: { source: 'private code' },
  }, base.policy), /unauthorized auxiliary content/i);
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

test('Agy activation validates the generated plugin before enabling it', async () => {
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
    { executable: 'agy', argv: ['plugin', 'enable', 'dharma-agent-fabric'] },
  ]);
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

test('task execution requires the signed bundle pin to match the active native bundle', () => {
  const pin = { bundleId: 'bundle-1', bundleHash: `sha256:${'a'.repeat(64)}` };
  assert.doesNotThrow(() => assertTaskSkillPin(pin, 'bundle-1'));
  assert.doesNotThrow(() => assertTaskSkillPin(null, null));
  assert.throws(
    () => assertTaskSkillPin(pin, 'bundle-2'),
    /does not match the active local bundle \(task=bundle-1, local=bundle-2\)/,
  );
  assert.throws(() => assertTaskSkillPin(undefined as never, 'bundle-1'), /missing its signed/);
  assert.throws(() => assertTaskSkillPin({ ...pin, bundleHash: 'invalid' }, 'bundle-1'), /hash is invalid/);
  assert.equal(taskSkillPinFailureCode(new Error('Task skill bundle does not match the active local bundle.')), 'skill_bundle_mismatch');
  assert.equal(taskSkillPinFailureCode(new Error('Task skill bundle hash is invalid.')), 'skill_bundle_hash_invalid');
});
