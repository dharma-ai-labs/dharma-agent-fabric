import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import test from 'node:test';
import { signCanonicalObject, validateContract } from '@dharma-ai-labs/agent-fabric-contracts';
import { calculateBundleHash, type SkillBundle } from '@dharma-ai-labs/agent-fabric-skill-manager';
import { saveDeviceEnrollmentAnchor, type AgentFabricClient, type DeviceConfig, type SecureSecretStore } from '@dharma-ai-labs/agent-fabric-relay-client';
import { applyServerEvidencePolicy, materializeWorkspacePolicy, prepareSkillUpdate } from './index.js';
import { serializeSkillPreparationRecord } from './skillPreparationRecord.js';
import { skillPreparationScopeRoot } from './skillPreparationTransaction.js';

const WORKSPACE = '11111111-1111-4111-8111-111111111111';
const AGENT = '22222222-2222-4222-8222-222222222222';
const DEVICE = '33333333-3333-4333-8333-333333333333';
const digest = (s: string) => 'sha256:' + createHash('sha256').update(s).digest('hex');

test('pending preparation contract accepts only bounded non-activating records', async () => {
  const f = await fixture();
  try {
    const record = { schema: 'dharma.skill-preparation/v1', organizationId: 'org_test',
      deviceId: DEVICE, workspaceId: WORKSPACE, repositoryAgentId: AGENT, repositoryBindingId: null, provider: 'codex',
      policyHash: digest('policy'), rolloutId: 'rollout', bundle: f.bundle,
      repositoryPackage: null, preparedAt: new Date().toISOString(), activationAuthorized: false };
    const validate = async (value: unknown) => (await validateContract(join(import.meta.dirname, 'schemas'),
      'https://schemas.dharma-ai.io/skill-preparation/v1', value)).ok;
    assert.equal(await validate(record), true);
    assert.deepEqual(JSON.parse(await serializeSkillPreparationRecord(record)), record);
    await assert.rejects(serializeSkillPreparationRecord({ ...record, organizationId: 'org_foreign' }), /organization mismatch/);
    await assert.rejects(serializeSkillPreparationRecord({ ...record, workspaceId: AGENT }), /target mismatch/);
    await assert.rejects(serializeSkillPreparationRecord({ ...record, rolloutId: 'x'.repeat(3 * 1024 * 1024) }), /byte limit/);
    for (const changes of [{ activationAuthorized: true }, { provider: 'unknown' }, { policyHash: 'not-a-hash' },
      { repositoryPackage: {} }, { preparedAt: 'not-a-date' }, { extra: 'not allowed' }]) {
      assert.equal(await validate({ ...record, ...changes }), false);
    }
  } finally { await rm(f.home, { recursive: true, force: true }); }
});
async function fixture() {
  const home = await mkdtemp(join(tmpdir(), 'af-preparation-'));
  const workspace = join(home, 'work');
  await mkdir(workspace);
  const keys = generateKeyPairSync('ed25519');
  const publicKey = keys.publicKey.export({ format: 'jwk' }).x!;
  const generated = await materializeWorkspacePolicy({ workspace, organizationId: 'org_test', revision: 'policy-test' });
  const unsigned = { schema: 'dharma.workspace-policy-authorization/v1', organizationId: 'org_test', workspaceId: WORKSPACE,
    policy: { revision: 'policy-test', evidence: generated.policy.evidence },
    issuedAt: new Date(Date.now() - 60_000).toISOString(), expiresAt: new Date(Date.now() + 3_600_000).toISOString(), keyVersion: 'fixture' };
  const authorization = { ...unsigned, signature: signCanonicalObject(unsigned, keys.privateKey) };
  const policy = applyServerEvidencePolicy(generated.policy, authorization, publicKey, 'org_test', WORKSPACE);
  const policyPath = join(workspace, '.dharma', 'approved-policy.json');
  await writeFile(policyPath, JSON.stringify(policy));
  await mkdir(join(home, 'registry', 'workspace-authorizations'), { recursive: true });
  await writeFile(join(home, 'registry', 'workspaces.json'), JSON.stringify([{ workspaceId: WORKSPACE, organizationId: 'org_test',
    name: 'Fixture', path: workspace, status: 'active', routeHash: 'a'.repeat(64), repositoryRemoteHash: 'b'.repeat(64), repositoryAgentId: AGENT }]));
  await writeFile(join(home, 'registry', 'workspace-authorizations', WORKSPACE + '.json'), JSON.stringify({ issuedAt: unsigned.issuedAt, signature: authorization.signature }));
  const config = { schema: 'dharma.device-config/v1', organizationId: 'org_test', deviceId: DEVICE, deviceName: 'Fixture', platform: 'linux',
    hqUrl: 'https://example.invalid', relayUrl: 'wss://example.invalid', publicKeyEd25519: publicKey,
    serverPublicKeyEd25519: publicKey, enrolledAt: new Date().toISOString() } as DeviceConfig;
  await writeFile(join(home, 'device.json'), JSON.stringify(config));
  const values = new Map<string, string>();
  const store: SecureSecretStore = { backend: 'linux-secret-service', get: async k => values.get(k) ?? null,
    put: async (k, v) => { values.set(k, v); }, delete: async k => { values.delete(k); } };
  await saveDeviceEnrollmentAnchor({ config, store });
  const text = '# Verifier\n';
  const unsignedBundle = { schema: 'dharma.skill-bundle/v2', bundleId: '44444444-4444-4444-8444-444444444444', organizationId: 'org_test',
    version: 'fixture', operation: 'install', riskClass: 'R0', activationPolicy: 'next_session', rollbackBundleId: null,
    evaluationReceiptId: '55555555-5555-4555-8555-555555555555', createdAt: new Date(Date.now() - 60_000).toISOString(), expiresAt: unsigned.expiresAt,
    targetSelectors: { organizationAgentIds: [AGENT], deviceIds: [DEVICE], workspaceIds: [WORKSPACE], providers: ['codex'] },
    skills: [{ skillId: 'verifier', version: 'fixture', repository: 'https://github.com/example/repository', commit: 'a'.repeat(40), path: 'skills/verifier',
      contentHash: digest('verifier/SKILL.md\0' + text + '\0'), files: [{ path: 'SKILL.md', contentBase64: Buffer.from(text).toString('base64'), sha256: digest(text) }] }] };
  const signed = { ...unsignedBundle, bundleHash: calculateBundleHash(unsignedBundle as Omit<SkillBundle, 'signature' | 'bundleHash'>) };
  const bundle = { ...signed, signature: signCanonicalObject(signed, keys.privateKey) } as SkillBundle;
  return { home, policyPath, store, values, bundle, keys, text };
}

for (const scenario of ['success', 'foreign selector', 'tampered tree', 'stop after poll', 'changed policy', 'no update'] as const) {
  test(`actual automatic preparation: ${scenario}`, async () => {
    const f = await fixture();
    const previous = process.env.DHARMA_HOME;
    process.env.DHARMA_HOME = f.home;
    let stopped = false, calls = 0;
    const baseline = new Map(f.values);
    const bundle = structuredClone(f.bundle);
    if (scenario === 'foreign selector') {
      bundle.targetSelectors.workspaceIds = ['foreign'];
      const { signature: _signature, bundleHash: _hash, ...unsigned } = bundle;
      bundle.bundleHash = calculateBundleHash(unsigned);
      const { signature: _unused, ...signed } = bundle;
      bundle.signature = signCanonicalObject(signed, f.keys.privateKey);
    }
    if (scenario === 'tampered tree') {
      bundle.skills[0]!.contentHash = digest('wrong');
      const { signature: _signature, bundleHash: _hash, ...unsigned } = bundle;
      bundle.bundleHash = calculateBundleHash(unsigned);
      const { signature: _unused, ...signed } = bundle;
      bundle.signature = signCanonicalObject(signed, f.keys.privateKey);
    }
    const fabric = { pollSkill: async (input: Record<string, unknown>) => {
      calls++; assert.equal(input.workspaceId, WORKSPACE); assert.equal(input.installedBundleId, null);
      if (scenario === 'stop after poll') stopped = true;
      if (scenario === 'changed policy') {
        const policy = JSON.parse(await readFile(f.policyPath, 'utf8')); policy.skills.canaryPercent = 25;
        await writeFile(f.policyPath, JSON.stringify(policy));
      }
      return { ok: true, organizationId: 'org_test', rollout: scenario === 'no update' ? null : { id: 'rollout', bundle } };
    }, signedGet: async () => { throw new Error('Unexpected package transport.'); } } as unknown as AgentFabricClient;
    try {
      const operation = () => prepareSkillUpdate({ workspaceId: WORKSPACE, provider: 'codex', policyPath: f.policyPath,
        fabric, store: f.store, automatic: true, assertRunning: () => { if (stopped) throw new Error('stopped fixture'); } });
      if (scenario === 'success') {
        const first = await operation(); const second = await operation();
        assert.ok(first && second);
        assert.notEqual(first.sourceRoot, second.sourceRoot);
        assert.equal(await readFile(join(first.sourceRoot, 'skills/verifier/SKILL.md'), 'utf8'), f.text);
        assert.equal((await stat(first.sourceRoot)).mode & 0o777, 0o700);
        assert.equal((await stat(join(first.sourceRoot, 'skills/verifier/SKILL.md'))).mode & 0o777, 0o600);
        await rm(first.sourceRoot, { recursive: true });
        assert.equal(await readFile(join(second.sourceRoot, 'skills/verifier/SKILL.md'), 'utf8'), f.text);
        await rm(second.sourceRoot, { recursive: true });
      } else if (scenario === 'no update') assert.equal(await operation(), null);
      else await assert.rejects(operation(), scenario === 'foreign selector' ? /does not target/ : scenario === 'tampered tree' ? /content hash/ : scenario === 'stop after poll' ? /stopped fixture/ : /scope or policy changed/);
      assert.equal(calls, scenario === 'success' ? 2 : 1);
      assert.deepEqual(f.values, baseline);
      const dirs = await readdir(join(f.home, 'relay/skill-pending-sources')).catch(e => { if (e.code === 'ENOENT') return []; throw e; });
      const reachedPreparation = ['success', 'tampered tree', 'changed policy'].includes(scenario);
      const scopeRoot = skillPreparationScopeRoot(f.home, WORKSPACE, 'codex');
      assert.deepEqual(dirs, reachedPreparation ? [basename(scopeRoot)] : []);
      if (reachedPreparation) {
        const scope = await lstat(scopeRoot);
        assert.equal(scope.isDirectory(), true);
        assert.equal(scope.isSymbolicLink(), false);
        if (process.platform !== 'win32') {
          const getuid = process.getuid;
          assert.equal(typeof getuid, 'function');
          assert.equal(scope.mode & 0o777, 0o700);
          assert.equal(scope.uid, getuid?.());
        }
        // Direct preparation does not publish; no attempt, pointer or metadata may remain.
        assert.deepEqual(await readdir(scopeRoot), []);
      }
    } finally {
      if (previous === undefined) delete process.env.DHARMA_HOME; else process.env.DHARMA_HOME = previous;
      await rm(f.home, { recursive: true, force: true });
    }
  });
}
