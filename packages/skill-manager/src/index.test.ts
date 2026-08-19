import assert from 'node:assert/strict';
import { test } from 'node:test';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { signCanonicalObject } from '@dharma-ai-labs/agent-fabric-contracts';
import type { OrganizationPolicy } from '@dharma-ai-labs/agent-fabric-policy';
import { calculateBundleHash, contentHash, getActiveSkillBundleAuthorization, getExpiredSkillBundleAuthorizationForReplacement, getInstalledSkillBundleIdForRecovery, getLegacySkillBundleIdForUpgrade, installSkillBundle, rollbackUnconfirmedSkillBundle, verifySkillBundle, type SkillBundle } from './index.js';

const organizationAgentId = '11111111-1111-4111-8111-111111111111';

const policy: OrganizationPolicy = {
  schema: 'dharma.organization-policy/v1', organizationId: 'org_test', revision: '1',
  evidence: { defaultMode: 'deep', registeredWorkspaceOnly: true, excludePaths: [], maximumCapsuleBytes: 1, maximumDailyUploadBytes: 1, maximumExpansionBytes: 1 },
  tasks: {
    defaultNetwork: 'deny', defaultGit: 'task_branch', writePaths: [], requireLocalConfirmationFor: [],
    allowedCommands: {
      smokePass: { argv: [process.execPath, '-e', 'process.exit(0)'], timeoutSeconds: 5 },
      smokeFail: { argv: [process.execPath, '-e', 'process.exit(9)'], timeoutSeconds: 5 },
      smokeSlow: { argv: [process.execPath, '-e', 'setTimeout(() => process.exit(0), 700)'], timeoutSeconds: 5 },
    },
  },
  skills: { automaticInstall: true, automaticPromotionMaxRisk: 'R2', canaryPercent: 10 }, retention: {}, budgets: {},
};

test('legacy v1 bundle can identify itself only for a signed-server upgrade poll', async () => {
  const native = await mkdtemp(resolve(tmpdir(), 'fabric-legacy-skill-'));
  const workspaceId = 'workspace-legacy';
  const bundleId = randomUUID();
  const managed = resolve(native, '.dharma-managed', 'workspaces', workspaceId);
  const active = resolve(managed, 'active');
  await mkdir(active, { recursive: true });
  await writeFile(resolve(managed, 'ACTIVE_BUNDLE'), `${bundleId}\n`);
  await writeFile(resolve(active, 'BUNDLE.json'), JSON.stringify({ schema: 'dharma.skill-bundle/v1', bundleId }));
  await writeFile(resolve(active, 'AUTHORIZATION.json'), JSON.stringify({ schema: 'dharma.skill-bundle/v1', bundleId }));
  assert.equal(await getLegacySkillBundleIdForUpgrade({ nativeSkillDirectory: native, workspaceId }), bundleId);
  await writeFile(resolve(active, 'AUTHORIZATION.json'), JSON.stringify({ schema: 'dharma.skill-bundle/v2', bundleId }));
  assert.equal(await getLegacySkillBundleIdForUpgrade({ nativeSkillDirectory: native, workspaceId }), null);
});

test('legacy v1 installation without authorization metadata remains upgradeable', async () => {
  const native = await mkdtemp(resolve(tmpdir(), 'fabric-legacy-no-authorization-'));
  const workspaceId = 'workspace-legacy-no-authorization';
  const bundleId = randomUUID();
  const managed = resolve(native, '.dharma-managed', 'workspaces', workspaceId);
  const active = resolve(managed, 'active');
  await mkdir(active, { recursive: true });
  await writeFile(resolve(managed, 'ACTIVE_BUNDLE'), `${bundleId}\n`);
  await writeFile(resolve(active, 'BUNDLE.json'), JSON.stringify({ bundleId, workspaceId, skillIds: ['dharma-boundary'] }));
  assert.equal(await getLegacySkillBundleIdForUpgrade({ nativeSkillDirectory: native, workspaceId }), bundleId);
  assert.equal(await getInstalledSkillBundleIdForRecovery({ nativeSkillDirectory: native, workspaceId }), bundleId);
  await writeFile(resolve(active, 'BUNDLE.json'), JSON.stringify({ bundleId, workspaceId: 'another-workspace', skillIds: ['dharma-boundary'] }));
  assert.equal(await getLegacySkillBundleIdForUpgrade({ nativeSkillDirectory: native, workspaceId }), null);
  await assert.rejects(
    getInstalledSkillBundleIdForRecovery({ nativeSkillDirectory: native, workspaceId }),
    /recovery metadata is invalid/,
  );
});

test('expired v2 installation remains identifiable only for a replacement poll', async () => {
  const native = await mkdtemp(resolve(tmpdir(), 'fabric-expired-recovery-'));
  const workspaceId = 'workspace-expired-recovery';
  const bundleId = randomUUID();
  const managed = resolve(native, '.dharma-managed', 'workspaces', workspaceId);
  const active = resolve(managed, 'active');
  await mkdir(active, { recursive: true });
  await writeFile(resolve(managed, 'ACTIVE_BUNDLE'), `${bundleId}\n`);
  await writeFile(resolve(active, 'BUNDLE.json'), JSON.stringify({ bundleId, skillIds: [] }));
  await writeFile(resolve(active, 'AUTHORIZATION.json'), JSON.stringify({
    schema: 'dharma.skill-bundle/v2', bundleId, expiresAt: '2026-08-16T00:00:00.000Z',
  }));
  assert.equal(await getInstalledSkillBundleIdForRecovery({ nativeSkillDirectory: native, workspaceId }), bundleId);
});

test('expired replacement polling verifies the signed bundle, endpoint, and protected receipt', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'fabric-expired-authorization-'));
  const source = resolve(root, 'source', 'skill');
  const native = resolve(root, 'native');
  await mkdir(source, { recursive: true });
  await writeFile(resolve(source, 'SKILL.md'), '# Expired candidate\n');
  const server = generateKeyPairSync('ed25519');
  const device = generateKeyPairSync('ed25519');
  const deviceId = randomUUID();
  const workspaceId = randomUUID();
  const expiresAt = new Date(Date.now() + 30_000).toISOString();
  const bundle = await signedBundle(source, randomUUID(), server.privateKey, 'dharma-boundary', expiresAt);
  const receipt = await installSkillBundle({
    bundle, sourceDirectory: resolve(root, 'source'), nativeSkillDirectory: native, policy,
    serverPublicKey: server.publicKey, devicePrivateKey: device.privateKey, deviceId,
    organizationAgentId, workspaceId, provider: 'codex',
  });
  await assert.rejects(
    getActiveSkillBundleAuthorization({
      nativeSkillDirectory: native, workspaceId, provider: 'codex', organizationId: 'org_test',
      organizationAgentId, deviceId, serverPublicKey: server.publicKey, devicePublicKey: device.publicKey,
      expectedReceiptHash: receipt.receiptHash, now: new Date(Date.parse(expiresAt) + 1),
    }),
    /has expired/,
  );
  const expiredAuthorization = await getExpiredSkillBundleAuthorizationForReplacement({
    nativeSkillDirectory: native, workspaceId, provider: 'codex', organizationId: 'org_test',
    organizationAgentId, deviceId, serverPublicKey: server.publicKey, devicePublicKey: device.publicKey,
    expectedReceiptHash: receipt.receiptHash, now: new Date(Date.parse(expiresAt) + 1),
  });
  assert.equal(expiredAuthorization?.bundleId, bundle.bundleId);
  assert.equal(expiredAuthorization?.bundleHash, bundle.bundleHash);
  await assert.rejects(
    getExpiredSkillBundleAuthorizationForReplacement({
      nativeSkillDirectory: native, workspaceId, provider: 'codex', organizationId: 'org_test',
      organizationAgentId, deviceId, serverPublicKey: server.publicKey, devicePublicKey: device.publicKey,
      expectedReceiptHash: `sha256:${'0'.repeat(64)}`, now: new Date(Date.parse(expiresAt) + 1),
    }),
    /not the current protected authorization/,
  );
});

test('legacy v1 bundle cannot authorize installation or task execution', async () => {
  const server = generateKeyPairSync('ed25519');
  const source = await mkdtemp(resolve(tmpdir(), 'fabric-legacy-auth-'));
  await writeFile(resolve(source, 'SKILL.md'), '# Legacy bundle\n');
  const signed = await signedBundle(source, randomUUID(), server.privateKey);
  const { signature: _signature, bundleHash: _bundleHash, ...v2Unsigned } = signed;
  const v1Unsigned = { ...v2Unsigned, schema: 'dharma.skill-bundle/v1' };
  const bundleHash = calculateBundleHash(v1Unsigned as never);
  const v1Bundle = {
    ...v1Unsigned,
    bundleHash,
    signature: signCanonicalObject({ ...v1Unsigned, bundleHash }, server.privateKey),
  } as unknown as SkillBundle;

  assert.throws(
    () => verifySkillBundle(v1Bundle, server.publicKey),
    /schema is not authorized for installation or task execution/,
  );
});

async function signedBundle(
  source: string,
  bundleId: string,
  privateKey: ReturnType<typeof generateKeyPairSync>['privateKey'],
  skillId = 'dharma-boundary',
  expiresAt: string | null = null,
): Promise<SkillBundle> {
  const skill = { skillId, version: '1.0.0', repository: 'https://github.com/customer/agent-control.git', commit: 'abc123', contentHash: await contentHash(source), path: 'skill' };
  const base = {
    schema: 'dharma.skill-bundle/v2' as const, bundleId, organizationId: 'org_test', version: '1.0.0', operation: 'install' as const, skills: [skill],
    riskClass: 'R2' as const,
    targetSelectors: { organizationAgentIds: [organizationAgentId], deviceIds: [], workspaceIds: [], providers: ['codex'] as Array<'codex'> },
    activationPolicy: 'next_session' as const,
    rollbackBundleId: null, evaluationReceiptId: 'eval-1', createdAt: new Date().toISOString(), expiresAt,
  };
  const bundleHash = calculateBundleHash(base);
  return { ...base, bundleHash, signature: signCanonicalObject({ ...base, bundleHash }, privateKey) };
}

async function activeBundle(
  nativeSkillDirectory: string,
  workspaceId: string,
  serverPublicKey: ReturnType<typeof generateKeyPairSync>['publicKey'],
  devicePublicKey: ReturnType<typeof generateKeyPairSync>['publicKey'],
  deviceId: string,
  provider: 'codex' | 'claude' | 'agy' = 'codex',
  expectedReceiptHash?: string,
) {
  const receipt = JSON.parse(await readFile(
    resolve(nativeSkillDirectory, '.dharma-managed', 'workspaces', workspaceId, 'active', 'INSTALL_RECEIPT.json'),
    'utf8',
  )) as { receiptHash: string };
  return getActiveSkillBundleAuthorization({
    nativeSkillDirectory, workspaceId, provider, organizationId: 'org_test', organizationAgentId, deviceId,
    serverPublicKey, devicePublicKey, expectedReceiptHash: expectedReceiptHash || receipt.receiptHash,
  });
}

test('verified skill activates and a failed canary restores the prior bundle', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'dharma-skill-'));
  const source = resolve(root, 'source', 'skill');
  const native = resolve(root, 'native');
  await mkdir(source, { recursive: true });
  await writeFile(resolve(source, 'SKILL.md'), '# Enforce evidence boundary\n');
  const server = generateKeyPairSync('ed25519');
  const device = generateKeyPairSync('ed25519');
  const deviceId = randomUUID();
  const workspaceId = randomUUID();
  const firstBundleId = randomUUID();
  const secondBundleId = randomUUID();
  const first = await signedBundle(source, firstBundleId, server.privateKey);
  const receipt = await installSkillBundle({ bundle: first, sourceDirectory: resolve(root, 'source'), nativeSkillDirectory: native, policy, serverPublicKey: server.publicKey, devicePrivateKey: device.privateKey, deviceId, organizationAgentId, workspaceId, provider: 'codex', smokeCommandId: 'smokePass' });
  assert.equal(receipt.status, 'active');
  const managed = resolve(native, '.dharma-managed', 'workspaces', workspaceId);
  assert.match(await readFile(resolve(managed, 'active/dharma-boundary/SKILL.md'), 'utf8'), /evidence boundary/);
  assert.match(await readFile(resolve(native, 'dharma-boundary/SKILL.md'), 'utf8'), /evidence boundary/);
  await writeFile(resolve(source, 'SKILL.md'), '# Broken candidate\n');
  const second = await signedBundle(source, secondBundleId, server.privateKey);
  const rollback = await installSkillBundle({ bundle: second, sourceDirectory: resolve(root, 'source'), nativeSkillDirectory: native, policy, serverPublicKey: server.publicKey, devicePrivateKey: device.privateKey, deviceId, organizationAgentId, workspaceId, provider: 'codex', smokeCommandId: 'smokeFail' });
  assert.equal(rollback.status, 'rolled_back');
  assert.match(await readFile(resolve(managed, 'active/dharma-boundary/SKILL.md'), 'utf8'), /evidence boundary/);
  assert.match(await readFile(resolve(native, 'dharma-boundary/SKILL.md'), 'utf8'), /evidence boundary/);
  assert.equal((await readFile(resolve(managed, 'ACTIVE_BUNDLE'), 'utf8')).trim(), firstBundleId);
});

test('provider activation check is signed into an active installation receipt', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'dharma-provider-activation-check-'));
  const source = resolve(root, 'source', 'skill');
  const native = resolve(root, 'native');
  await mkdir(source, { recursive: true });
  await writeFile(resolve(source, 'SKILL.md'), '# Provider-attested skill\n');
  const server = generateKeyPairSync('ed25519');
  const device = generateKeyPairSync('ed25519');
  const bundle = await signedBundle(source, randomUUID(), server.privateKey);
  const receipt = await installSkillBundle({
    bundle,
    sourceDirectory: resolve(root, 'source'),
    nativeSkillDirectory: native,
    policy,
    serverPublicKey: server.publicKey,
    devicePrivateKey: device.privateKey,
    deviceId: randomUUID(),
    organizationAgentId,
    workspaceId: randomUUID(),
    provider: 'codex',
    providerActivationCheck: async () => ({
      name: 'provider:agy:activation',
      status: 'pass',
      details: 'content-bound challenge verified',
    }),
  });

  assert.equal(receipt.status, 'active');
  assert.deepEqual(receipt.checks.at(-1), {
    name: 'provider:agy:activation',
    status: 'pass',
    details: 'content-bound challenge verified',
  });
});

test('failed provider activation check restores the prior signed bundle', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'dharma-provider-activation-rollback-'));
  const firstSourceRoot = resolve(root, 'first-source');
  const secondSourceRoot = resolve(root, 'second-source');
  const firstSource = resolve(firstSourceRoot, 'skill');
  const secondSource = resolve(secondSourceRoot, 'skill');
  const native = resolve(root, 'native');
  await mkdir(firstSource, { recursive: true });
  await mkdir(secondSource, { recursive: true });
  await writeFile(resolve(firstSource, 'SKILL.md'), '# First skill\n');
  await writeFile(resolve(secondSource, 'SKILL.md'), '# Second skill\n');
  const server = generateKeyPairSync('ed25519');
  const device = generateKeyPairSync('ed25519');
  const deviceId = randomUUID();
  const workspaceId = randomUUID();
  const firstBundle = await signedBundle(firstSource, randomUUID(), server.privateKey, 'first');
  const first = await installSkillBundle({
    bundle: firstBundle,
    sourceDirectory: firstSourceRoot,
    nativeSkillDirectory: native,
    policy,
    serverPublicKey: server.publicKey,
    devicePrivateKey: device.privateKey,
    deviceId,
    organizationAgentId,
    workspaceId,
    provider: 'codex',
  });
  assert.equal(first.status, 'active');
  const secondBundle = await signedBundle(secondSource, randomUUID(), server.privateKey, 'second');
  const second = await installSkillBundle({
    bundle: secondBundle,
    sourceDirectory: secondSourceRoot,
    nativeSkillDirectory: native,
    policy,
    serverPublicKey: server.publicKey,
    devicePrivateKey: device.privateKey,
    deviceId,
    organizationAgentId,
    workspaceId,
    provider: 'codex',
    providerActivationCheck: async () => ({
      name: 'provider:agy:activation',
      status: 'fail',
      details: 'activation token mismatch',
    }),
  });

  assert.equal(second.status, 'rolled_back');
  assert.deepEqual(second.checks.at(-1), {
    name: 'provider:agy:activation',
    status: 'fail',
    details: 'activation token mismatch',
  });
  assert.equal(await readFile(resolve(native, '.dharma-managed', 'workspaces', workspaceId, 'ACTIVE_BUNDLE'), 'utf8'), `${firstBundle.bundleId}\n`);
});

test('a server-rejected active receipt restores the prior local authorization', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'dharma-skill-server-reject-'));
  const source = resolve(root, 'source', 'skill');
  const native = resolve(root, 'native');
  await mkdir(source, { recursive: true });
  await writeFile(resolve(source, 'SKILL.md'), '# Prior release\n');
  const server = generateKeyPairSync('ed25519');
  const device = generateKeyPairSync('ed25519');
  const deviceId = randomUUID();
  const workspaceId = randomUUID();
  const prior = await signedBundle(source, randomUUID(), server.privateKey);
  await installSkillBundle({
    bundle: prior, sourceDirectory: resolve(root, 'source'), nativeSkillDirectory: native, policy,
    serverPublicKey: server.publicKey, devicePrivateKey: device.privateKey, deviceId,
    organizationAgentId, workspaceId, provider: 'codex',
  });
  await writeFile(resolve(source, 'SKILL.md'), '# Unconfirmed release\n');
  const unconfirmed = await signedBundle(source, randomUUID(), server.privateKey);
  const receipt = await installSkillBundle({
    bundle: unconfirmed, sourceDirectory: resolve(root, 'source'), nativeSkillDirectory: native, policy,
    serverPublicKey: server.publicKey, devicePrivateKey: device.privateKey, deviceId,
    organizationAgentId, workspaceId, provider: 'codex',
  });
  await rollbackUnconfirmedSkillBundle({ nativeSkillDirectory: native, workspaceId, receipt });
  const managed = resolve(native, '.dharma-managed', 'workspaces', workspaceId);
  assert.equal((await readFile(resolve(managed, 'ACTIVE_BUNDLE'), 'utf8')).trim(), prior.bundleId);
  assert.match(await readFile(resolve(managed, 'active/dharma-boundary/SKILL.md'), 'utf8'), /Prior release/);
  assert.match(await readFile(resolve(native, 'dharma-boundary/SKILL.md'), 'utf8'), /Prior release/);
  assert.deepEqual((await readdir(managed)).filter((name) => name.startsWith('.rollback-')), []);
});

test('the next authorization read recovers a rollback interrupted between filesystem swaps', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'dharma-skill-interrupted-rollback-'));
  const source = resolve(root, 'source', 'skill');
  const native = resolve(root, 'native');
  await mkdir(source, { recursive: true });
  await writeFile(resolve(source, 'SKILL.md'), '# Durable active release\n');
  const server = generateKeyPairSync('ed25519');
  const device = generateKeyPairSync('ed25519');
  const workspaceId = randomUUID();
  const activeBundle = await signedBundle(source, randomUUID(), server.privateKey);
  await installSkillBundle({
    bundle: activeBundle, sourceDirectory: resolve(root, 'source'), nativeSkillDirectory: native, policy,
    serverPublicKey: server.publicKey, devicePrivateKey: device.privateKey, deviceId: randomUUID(),
    organizationAgentId, workspaceId, provider: 'codex',
  });
  const managed = resolve(native, '.dharma-managed', 'workspaces', workspaceId);
  const transaction = resolve(managed, '.rollback-interrupted-test');
  await mkdir(transaction, { recursive: true });
  await writeFile(resolve(transaction, 'ROLLBACK_RECOVERY.json'), JSON.stringify({
    schema: 'dharma.skill-rollback-recovery/v1',
    workspaceId,
    currentBundleId: activeBundle.bundleId,
    currentSkillIds: ['dharma-boundary'],
  }));
  await rename(resolve(managed, 'active'), resolve(transaction, 'backup-active'));
  await writeFile(resolve(native, 'dharma-boundary/SKILL.md'), '# Partially rolled back native state\n');

  assert.equal(await getInstalledSkillBundleIdForRecovery({ nativeSkillDirectory: native, workspaceId }), activeBundle.bundleId);
  assert.match(await readFile(resolve(managed, 'active/dharma-boundary/SKILL.md'), 'utf8'), /Durable active release/);
  assert.match(await readFile(resolve(native, 'dharma-boundary/SKILL.md'), 'utf8'), /Durable active release/);
  assert.deepEqual((await readdir(managed)).filter((name) => name.startsWith('.rollback-')), []);
});

test('receipt persistence failure restores the prior bundle before publishing activation', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'dharma-skill-receipt-failure-'));
  const source = resolve(root, 'source', 'skill');
  const native = resolve(root, 'native');
  await mkdir(source, { recursive: true });
  await writeFile(resolve(source, 'SKILL.md'), '# Prior durable release\n');
  const server = generateKeyPairSync('ed25519');
  const device = generateKeyPairSync('ed25519');
  const deviceId = randomUUID();
  const workspaceId = randomUUID();
  const prior = await signedBundle(source, randomUUID(), server.privateKey);
  await installSkillBundle({
    bundle: prior, sourceDirectory: resolve(root, 'source'), nativeSkillDirectory: native, policy,
    serverPublicKey: server.publicKey, devicePrivateKey: device.privateKey, deviceId,
    organizationAgentId, workspaceId, provider: 'codex',
  });

  await writeFile(resolve(source, 'SKILL.md'), '# Candidate with colliding receipt path\n');
  const candidate = await signedBundle(
    source,
    randomUUID(),
    server.privateKey,
    'INSTALL_RECEIPT.json',
  );
  await assert.rejects(
    installSkillBundle({
      bundle: candidate, sourceDirectory: resolve(root, 'source'), nativeSkillDirectory: native, policy,
      serverPublicKey: server.publicKey, devicePrivateKey: device.privateKey, deviceId,
      organizationAgentId, workspaceId, provider: 'codex',
    }),
    /EISDIR|illegal operation on a directory/,
  );

  const managed = resolve(native, '.dharma-managed', 'workspaces', workspaceId);
  assert.equal((await readFile(resolve(managed, 'ACTIVE_BUNDLE'), 'utf8')).trim(), prior.bundleId);
  assert.match(await readFile(resolve(managed, 'active/dharma-boundary/SKILL.md'), 'utf8'), /Prior durable/);
  assert.match(await readFile(resolve(native, 'dharma-boundary/SKILL.md'), 'utf8'), /Prior durable/);
  await assert.rejects(readFile(resolve(native, 'INSTALL_RECEIPT.json', 'SKILL.md')), /ENOENT/);
});

test('R3 bundles cannot install without explicit organization approval', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'dharma-skill-r3-'));
  const source = resolve(root, 'source', 'skill');
  await mkdir(source, { recursive: true });
  await writeFile(resolve(source, 'SKILL.md'), '# Elevated\n');
  const server = generateKeyPairSync('ed25519');
  const device = generateKeyPairSync('ed25519');
  const bundle = { ...(await signedBundle(source, randomUUID(), server.privateKey)), riskClass: 'R3' as const };
  const { signature: _old, bundleHash: _oldHash, ...unsigned } = bundle;
  const bundleHash = calculateBundleHash(unsigned);
  const signed = { ...unsigned, bundleHash, signature: signCanonicalObject({ ...unsigned, bundleHash }, server.privateKey) };
  await assert.rejects(() => installSkillBundle({ bundle: signed, sourceDirectory: resolve(root, 'source'), nativeSkillDirectory: resolve(root, 'native'), policy, serverPublicKey: server.publicKey, devicePrivateKey: device.privateKey, deviceId: randomUUID(), organizationAgentId, workspaceId: randomUUID(), provider: 'codex' }), /require organization approval/);
});

test('signed target selectors reject installation for a different logical agent', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'dharma-skill-target-'));
  const source = resolve(root, 'source', 'skill');
  await mkdir(source, { recursive: true });
  await writeFile(resolve(source, 'SKILL.md'), '# Targeted boundary\n');
  const server = generateKeyPairSync('ed25519');
  const device = generateKeyPairSync('ed25519');
  const bundle = await signedBundle(source, randomUUID(), server.privateKey);
  await assert.rejects(() => installSkillBundle({
    bundle, sourceDirectory: resolve(root, 'source'), nativeSkillDirectory: resolve(root, 'native'), policy,
    serverPublicKey: server.publicKey, devicePrivateKey: device.privateKey, deviceId: randomUUID(),
    organizationAgentId: randomUUID(), workspaceId: randomUUID(), provider: 'codex',
  }), /not authorized for this repository agent/);
});

test('signed bundles fail closed on malformed or expired authorization windows', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'dharma-skill-expiry-'));
  const source = resolve(root, 'source', 'skill');
  await mkdir(source, { recursive: true });
  await writeFile(resolve(source, 'SKILL.md'), '# Expiring candidate\n');
  const server = generateKeyPairSync('ed25519');
  const current = await signedBundle(source, randomUUID(), server.privateKey);
  for (const expiresAt of ['not-a-date', '2026-08-16T11:59:59.000Z']) {
    const { signature: _signature, bundleHash: _bundleHash, ...unsigned } = { ...current, expiresAt };
    const bundleHash = calculateBundleHash(unsigned);
    const bundle = { ...unsigned, bundleHash, signature: signCanonicalObject({ ...unsigned, bundleHash }, server.privateKey) };
    assert.throws(
      () => verifySkillBundle(bundle, server.publicKey, new Date('2026-08-16T12:00:00.000Z')),
      /expiry is invalid|has expired/,
    );
  }
});

test('a bundle that expires during smoke validation is not activated', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'dharma-skill-expiry-race-'));
  const source = resolve(root, 'source', 'skill');
  const native = resolve(root, 'native');
  await mkdir(source, { recursive: true });
  await writeFile(resolve(source, 'SKILL.md'), '# Short-lived candidate\n');
  const server = generateKeyPairSync('ed25519');
  const device = generateKeyPairSync('ed25519');
  const workspaceId = randomUUID();
  const bundle = await signedBundle(
    source,
    randomUUID(),
    server.privateKey,
    'dharma-boundary',
    new Date(Date.now() + 500).toISOString(),
  );
  const receipt = await installSkillBundle({
    bundle,
    sourceDirectory: resolve(root, 'source'),
    nativeSkillDirectory: native,
    policy,
    serverPublicKey: server.publicKey,
    devicePrivateKey: device.privateKey,
    deviceId: randomUUID(),
    organizationAgentId,
    workspaceId,
    provider: 'codex',
    smokeCommandId: 'smokeSlow',
  });

  assert.equal(receipt.status, 'failed');
  assert.equal(receipt.checks.find((check) => check.name === 'authorization:activation-window')?.status, 'fail');
  await assert.rejects(
    readFile(resolve(native, '.dharma-managed', 'workspaces', workspaceId, 'ACTIVE_BUNDLE')),
    /ENOENT/,
  );
});

test('active bundle identity must match the installed release manifest', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'dharma-skill-pointer-'));
  const source = resolve(root, 'source', 'skill');
  const native = resolve(root, 'native');
  await mkdir(source, { recursive: true });
  await writeFile(resolve(source, 'SKILL.md'), '# Candidate provenance\n');
  const server = generateKeyPairSync('ed25519');
  const device = generateKeyPairSync('ed25519');
  const workspaceId = randomUUID();
  const deviceId = randomUUID();
  const bundle = await signedBundle(source, randomUUID(), server.privateKey);
  await installSkillBundle({
    bundle, sourceDirectory: resolve(root, 'source'), nativeSkillDirectory: native, policy,
    serverPublicKey: server.publicKey, devicePrivateKey: device.privateKey,
    deviceId, organizationAgentId, workspaceId, provider: 'codex',
  });
  const managed = resolve(native, '.dharma-managed', 'workspaces', workspaceId);
  await writeFile(resolve(managed, 'ACTIVE_BUNDLE'), `${randomUUID()}\n`);
  await assert.rejects(
    () => activeBundle(native, workspaceId, server.publicKey, device.publicKey, deviceId),
    /does not match the installed release manifest/,
  );
});

test('an active bundle pointer fails closed when its release manifest is missing', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'dharma-skill-missing-manifest-'));
  const native = resolve(root, 'native');
  const workspaceId = randomUUID();
  const managed = resolve(native, '.dharma-managed', 'workspaces', workspaceId);
  await mkdir(resolve(managed, 'active'), { recursive: true });
  await writeFile(resolve(managed, 'ACTIVE_BUNDLE'), `${randomUUID()}\n`);

  await assert.rejects(
    getInstalledSkillBundleIdForRecovery({ nativeSkillDirectory: native, workspaceId }),
    /Active bundle manifest is missing/,
  );
});

test('active bundle authorization rejects locally rewritten release metadata', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'dharma-skill-forged-'));
  const source = resolve(root, 'source', 'skill');
  const native = resolve(root, 'native');
  await mkdir(source, { recursive: true });
  await writeFile(resolve(source, 'SKILL.md'), '# Candidate provenance\n');
  const server = generateKeyPairSync('ed25519');
  const device = generateKeyPairSync('ed25519');
  const workspaceId = randomUUID();
  const bundle = await signedBundle(source, randomUUID(), server.privateKey);
  const deviceId = randomUUID();
  await installSkillBundle({
    bundle, sourceDirectory: resolve(root, 'source'), nativeSkillDirectory: native, policy,
    serverPublicKey: server.publicKey, devicePrivateKey: device.privateKey,
    deviceId, organizationAgentId, workspaceId, provider: 'codex',
  });
  const active = resolve(native, '.dharma-managed', 'workspaces', workspaceId, 'active');
  const authorization = JSON.parse(await readFile(resolve(active, 'AUTHORIZATION.json'), 'utf8')) as SkillBundle;
  await writeFile(resolve(active, 'AUTHORIZATION.json'), `${JSON.stringify({ ...authorization, version: 'forged' })}\n`);
  await assert.rejects(
    () => activeBundle(native, workspaceId, server.publicKey, device.publicKey, deviceId),
    /signature is invalid|hash is invalid/,
  );
});

test('protected receipt hash rejects replay of a previously active installation', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'dharma-skill-replay-'));
  const source = resolve(root, 'source', 'skill');
  const native = resolve(root, 'native');
  await mkdir(source, { recursive: true });
  await writeFile(resolve(source, 'SKILL.md'), '# First active bundle\n');
  const server = generateKeyPairSync('ed25519');
  const device = generateKeyPairSync('ed25519');
  const deviceId = randomUUID();
  const workspaceId = randomUUID();
  const first = await signedBundle(source, randomUUID(), server.privateKey);
  const firstReceipt = await installSkillBundle({
    bundle: first, sourceDirectory: resolve(root, 'source'), nativeSkillDirectory: native, policy,
    serverPublicKey: server.publicKey, devicePrivateKey: device.privateKey, deviceId,
    organizationAgentId, workspaceId, provider: 'codex',
  });
  const managed = resolve(native, '.dharma-managed', 'workspaces', workspaceId);
  const savedFirst = resolve(root, 'saved-first');
  await cp(resolve(managed, 'active'), savedFirst, { recursive: true });
  await writeFile(resolve(source, 'SKILL.md'), '# Second active bundle\n');
  const second = await signedBundle(source, randomUUID(), server.privateKey);
  const secondReceipt = await installSkillBundle({
    bundle: second, sourceDirectory: resolve(root, 'source'), nativeSkillDirectory: native, policy,
    serverPublicKey: server.publicKey, devicePrivateKey: device.privateKey, deviceId,
    organizationAgentId, workspaceId, provider: 'codex',
  });
  assert.notEqual(firstReceipt.receiptHash, secondReceipt.receiptHash);
  await rm(resolve(managed, 'active'), { recursive: true, force: true });
  await cp(savedFirst, resolve(managed, 'active'), { recursive: true });
  await writeFile(resolve(managed, 'ACTIVE_BUNDLE'), `${first.bundleId}\n`);
  await assert.rejects(
    activeBundle(native, workspaceId, server.publicKey, device.publicKey, deviceId, 'codex', secondReceipt.receiptHash),
    /not the current protected authorization/,
  );
});

test('signed clear baseline removes managed skills and preserves unmanaged provider skills', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'dharma-skill-clear-'));
  const source = resolve(root, 'source', 'skill');
  const native = resolve(root, 'native');
  await mkdir(source, { recursive: true });
  await mkdir(resolve(native, 'customer-skill'), { recursive: true });
  await writeFile(resolve(source, 'SKILL.md'), '# Managed boundary\n');
  await writeFile(resolve(native, 'customer-skill', 'SKILL.md'), '# Customer owned\n');
  const server = generateKeyPairSync('ed25519');
  const device = generateKeyPairSync('ed25519');
  const deviceId = randomUUID();
  const workspaceId = randomUUID();
  const installed = await signedBundle(source, randomUUID(), server.privateKey);
  await installSkillBundle({ bundle: installed, sourceDirectory: resolve(root, 'source'), nativeSkillDirectory: native, policy, serverPublicKey: server.publicKey, devicePrivateKey: device.privateKey, deviceId, organizationAgentId, workspaceId, provider: 'codex' });

  const clearBase = {
    schema: 'dharma.skill-bundle/v2' as const, bundleId: randomUUID(), organizationId: 'org_test', version: '0.0.0',
    operation: 'clear' as const, skills: [], riskClass: 'R0' as const,
    targetSelectors: { organizationAgentIds: [organizationAgentId], deviceIds: [], workspaceIds: [], providers: ['codex'] as Array<'codex'> },
    activationPolicy: 'immediate_safe_reload' as const, rollbackBundleId: null, evaluationReceiptId: 'baseline:no-managed-skills',
    createdAt: new Date().toISOString(), expiresAt: null,
  };
  const bundleHash = calculateBundleHash(clearBase);
  const clear = { ...clearBase, bundleHash, signature: signCanonicalObject({ ...clearBase, bundleHash }, server.privateKey) };
  const receipt = await installSkillBundle({ bundle: clear, sourceDirectory: resolve(root, 'empty'), nativeSkillDirectory: native, policy, serverPublicKey: server.publicKey, devicePrivateKey: device.privateKey, deviceId, organizationAgentId, workspaceId, provider: 'codex' });

  assert.equal(receipt.status, 'active');
  assert.equal(receipt.previousBundleId, installed.bundleId);
  await assert.rejects(readFile(resolve(native, 'dharma-boundary', 'SKILL.md')), /ENOENT/);
  assert.match(await readFile(resolve(native, 'customer-skill', 'SKILL.md'), 'utf8'), /Customer owned/);
  assert.equal((await readFile(resolve(native, '.dharma-managed', 'workspaces', workspaceId, 'ACTIVE_BUNDLE'), 'utf8')).trim(), clear.bundleId);
});

test('two repository workspaces retain independent active bundles and native skills', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'dharma-skill-multi-workspace-'));
  const native = resolve(root, 'native');
  const sourceA = resolve(root, 'source-a', 'skill');
  const sourceB = resolve(root, 'source-b', 'skill');
  await mkdir(sourceA, { recursive: true });
  await mkdir(sourceB, { recursive: true });
  await writeFile(resolve(sourceA, 'SKILL.md'), '# Garment evidence boundary\n');
  await writeFile(resolve(sourceB, 'SKILL.md'), '# Support authority boundary\n');
  const server = generateKeyPairSync('ed25519');
  const device = generateKeyPairSync('ed25519');
  const deviceId = randomUUID();
  const workspaceA = randomUUID();
  const workspaceB = randomUUID();
  const bundleA = await signedBundle(sourceA, randomUUID(), server.privateKey, 'garment-boundary');
  const bundleB = await signedBundle(sourceB, randomUUID(), server.privateKey, 'support-boundary');

  await installSkillBundle({
    bundle: bundleA, sourceDirectory: resolve(root, 'source-a'), nativeSkillDirectory: native,
    policy, serverPublicKey: server.publicKey, devicePrivateKey: device.privateKey,
    deviceId, organizationAgentId, workspaceId: workspaceA, provider: 'codex',
  });
  await installSkillBundle({
    bundle: bundleB, sourceDirectory: resolve(root, 'source-b'), nativeSkillDirectory: native,
    policy, serverPublicKey: server.publicKey, devicePrivateKey: device.privateKey,
    deviceId, organizationAgentId, workspaceId: workspaceB, provider: 'codex',
  });

  assert.equal((await activeBundle(native, workspaceA, server.publicKey, device.publicKey, deviceId))?.bundleId, bundleA.bundleId);
  assert.equal((await activeBundle(native, workspaceB, server.publicKey, device.publicKey, deviceId))?.bundleId, bundleB.bundleId);
  assert.match(await readFile(resolve(native, 'garment-boundary/SKILL.md'), 'utf8'), /Garment/);
  assert.match(await readFile(resolve(native, 'support-boundary/SKILL.md'), 'utf8'), /Support/);

  await writeFile(resolve(sourceA, 'SKILL.md'), '# Broken garment candidate\n');
  const brokenA = await signedBundle(sourceA, randomUUID(), server.privateKey, 'garment-boundary');
  const rollback = await installSkillBundle({
    bundle: brokenA, sourceDirectory: resolve(root, 'source-a'), nativeSkillDirectory: native,
    policy, serverPublicKey: server.publicKey, devicePrivateKey: device.privateKey,
    deviceId, organizationAgentId, workspaceId: workspaceA, provider: 'codex', smokeCommandId: 'smokeFail',
  });
  assert.equal(rollback.status, 'rolled_back');
  assert.equal((await activeBundle(native, workspaceA, server.publicKey, device.publicKey, deviceId))?.bundleId, bundleA.bundleId);
  assert.equal((await activeBundle(native, workspaceB, server.publicKey, device.publicKey, deviceId))?.bundleId, bundleB.bundleId);
  assert.match(await readFile(resolve(native, 'garment-boundary/SKILL.md'), 'utf8'), /Garment/);
  assert.match(await readFile(resolve(native, 'support-boundary/SKILL.md'), 'utf8'), /Support/);
});
