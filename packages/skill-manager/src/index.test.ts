import assert from 'node:assert/strict';
import { test } from 'node:test';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { signCanonicalObject } from '@dharma-ai/agent-fabric-contracts';
import type { OrganizationPolicy } from '@dharma-ai/agent-fabric-policy';
import { calculateBundleHash, contentHash, installSkillBundle, type SkillBundle } from './index.js';

const policy: OrganizationPolicy = {
  schema: 'dharma.organization-policy/v1', organizationId: 'org_test', revision: '1',
  evidence: { defaultMode: 'deep', registeredWorkspaceOnly: true, excludePaths: [], maximumCapsuleBytes: 1, maximumDailyUploadBytes: 1, maximumExpansionBytes: 1 },
  tasks: {
    defaultNetwork: 'deny', defaultGit: 'task_branch', writePaths: [], requireLocalConfirmationFor: [],
    allowedCommands: {
      smokePass: { argv: [process.execPath, '-e', 'process.exit(0)'], timeoutSeconds: 5 },
      smokeFail: { argv: [process.execPath, '-e', 'process.exit(9)'], timeoutSeconds: 5 },
    },
  },
  skills: { automaticInstall: true, automaticPromotionMaxRisk: 'R2', canaryPercent: 10 }, retention: {}, budgets: {},
};

async function signedBundle(source: string, bundleId: string, privateKey: ReturnType<typeof generateKeyPairSync>['privateKey']): Promise<SkillBundle> {
  const skill = { skillId: 'dharma-boundary', version: '1.0.0', commit: 'abc123', contentHash: await contentHash(source), path: 'skill' };
  const base = {
    schema: 'dharma.skill-bundle/v1' as const, bundleId, organizationId: 'org_test', version: '1.0.0', skills: [skill],
    riskClass: 'R2' as const, targetSelectors: { providers: ['codex'] }, activationPolicy: 'next_session' as const,
    rollbackBundleId: null, evaluationReceiptId: 'eval-1', createdAt: new Date().toISOString(), expiresAt: null,
  };
  const bundleHash = calculateBundleHash(base);
  return { ...base, bundleHash, signature: signCanonicalObject({ ...base, bundleHash }, privateKey) };
}

test('verified skill activates and a failed canary restores the prior bundle', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'dharma-skill-'));
  const source = resolve(root, 'source', 'skill');
  const native = resolve(root, 'native');
  await mkdir(source, { recursive: true });
  await writeFile(resolve(source, 'SKILL.md'), '# Enforce evidence boundary\n');
  const server = generateKeyPairSync('ed25519');
  const device = generateKeyPairSync('ed25519');
  const first = await signedBundle(source, 'bundle-1', server.privateKey);
  const receipt = await installSkillBundle({ bundle: first, sourceDirectory: resolve(root, 'source'), nativeSkillDirectory: native, policy, serverPublicKey: server.publicKey, devicePrivateKey: device.privateKey, deviceId: 'device', workspaceId: 'workspace', provider: 'codex', smokeCommandId: 'smokePass' });
  assert.equal(receipt.status, 'active');
  assert.match(await readFile(resolve(native, '.dharma-managed/active/dharma-boundary/SKILL.md'), 'utf8'), /evidence boundary/);
  await writeFile(resolve(source, 'SKILL.md'), '# Broken candidate\n');
  const second = await signedBundle(source, 'bundle-2', server.privateKey);
  const rollback = await installSkillBundle({ bundle: second, sourceDirectory: resolve(root, 'source'), nativeSkillDirectory: native, policy, serverPublicKey: server.publicKey, devicePrivateKey: device.privateKey, deviceId: 'device', workspaceId: 'workspace', provider: 'codex', smokeCommandId: 'smokeFail' });
  assert.equal(rollback.status, 'rolled_back');
  assert.match(await readFile(resolve(native, '.dharma-managed/active/dharma-boundary/SKILL.md'), 'utf8'), /evidence boundary/);
  assert.equal((await readFile(resolve(native, '.dharma-managed/ACTIVE_BUNDLE'), 'utf8')).trim(), 'bundle-1');
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
  await assert.rejects(() => installSkillBundle({ bundle: signed, sourceDirectory: resolve(root, 'source'), nativeSkillDirectory: resolve(root, 'native'), policy, serverPublicKey: server.publicKey, devicePrivateKey: device.privateKey, deviceId: 'device', workspaceId: 'workspace', provider: 'codex' }), /require organization approval/);
});
