import assert from 'node:assert/strict';
import { generateKeyPairSync, createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { signCanonicalObject } from '@dharma-ai-labs/agent-fabric-contracts';
import { applyServerEvidencePolicy, loadSkillSynchronizationPolicy, materializeWorkspacePolicy, run } from './index.js';
import { saveDeviceEnrollmentAnchor, type DeviceConfig, type SecureSecretStore } from '@dharma-ai-labs/agent-fabric-relay-client';

async function fixture() {
  const home = await mkdtemp(join(tmpdir(), 'af-skill-policy-'));
  const workspace = join(home, 'work');
  await mkdir(workspace);
  const generated = await materializeWorkspacePolicy({ workspace, organizationId: 'org_test', revision: 'policy-test' });
  const keys = generateKeyPairSync('ed25519');
  const publicKey = keys.publicKey.export({ format: 'jwk' }).x!;
  const unsigned = {
    schema: 'dharma.workspace-policy-authorization/v1', organizationId: 'org_test', workspaceId: 'workspace-test',
    policy: { revision: 'policy-test', evidence: generated.policy.evidence },
    issuedAt: new Date(Date.now() - 60_000).toISOString(), expiresAt: new Date(Date.now() + 3_600_000).toISOString(), keyVersion: 'test',
  };
  const authorization = { ...unsigned, signature: signCanonicalObject(unsigned, keys.privateKey) };
  const signedPolicy = applyServerEvidencePolicy(generated.policy, authorization, publicKey, 'org_test', 'workspace-test');
  const policyPath = join(workspace, '.dharma', 'approved-policy.json');
  await mkdir(join(home, 'registry', 'workspace-authorizations'), { recursive: true });
  await writeFile(join(home, 'registry', 'workspaces.json'), JSON.stringify([{
    workspaceId: 'workspace-test', organizationId: 'org_test', name: 'Test', path: workspace, status: 'active',
    routeHash: 'a'.repeat(64), repositoryRemoteHash: 'b'.repeat(64), repositoryAgentId: '11111111-1111-4111-8111-111111111111',
  }]));
  await writeFile(join(home, 'device.json'), JSON.stringify({
    schema: 'dharma.device-config/v1', organizationId: 'org_test', deviceId: '22222222-2222-4222-8222-222222222222',
    hqUrl: 'https://example.invalid', relayUrl: 'wss://example.invalid', serverPublicKeyEd25519: publicKey,
    publicKeyEd25519: publicKey, enrolledAt: new Date().toISOString(),
  }));
  const statePath = join(home, 'registry', 'workspace-authorizations', 'workspace-test.json');
  await writeFile(statePath, JSON.stringify({ issuedAt: authorization.issuedAt, signature: authorization.signature }));
  await writeFile(policyPath, JSON.stringify(signedPolicy));
  return { home, workspace, generated, keys, unsigned, authorization, signedPolicy, policyPath, statePath };
}

const cases = [
  { name: 'noncanonical policy path', expected: /Skill synchronization requires the canonical registered workspace policy path/, mutate: async (f: Awaited<ReturnType<typeof fixture>>) => {
    const other = join(f.home, 'other-policy.json');
    await writeFile(other, JSON.stringify(f.signedPolicy));
    return other;
  } },
  { name: 'unsigned local policy', expected: /Server workspace policy authorization is required/, mutate: async (f: Awaited<ReturnType<typeof fixture>>) => {
    await writeFile(f.policyPath, JSON.stringify(f.generated.policy));
  } },
  { name: 'tampered signature', expected: /signature is invalid/, mutate: async (f: Awaited<ReturnType<typeof fixture>>) => {
    await writeFile(f.policyPath, JSON.stringify({ ...f.signedPolicy, serverAuthorization: { ...f.authorization, signature: 'tampered' } }));
  } },
  { name: 'expired signed authorization', expected: /invalid or expired/, mutate: async (f: Awaited<ReturnType<typeof fixture>>) => {
    const expired = { ...f.unsigned, issuedAt: new Date(Date.now() - 120_000).toISOString(), expiresAt: new Date(Date.now() - 60_000).toISOString() };
    await writeFile(f.policyPath, JSON.stringify({ ...f.signedPolicy, serverAuthorization: { ...expired, signature: signCanonicalObject(expired, f.keys.privateKey) } }));
  } },
  { name: 'foreign enrolled organization', expected: /Skill policy does not match the enrolled organization and workspace/, mutate: async (f: Awaited<ReturnType<typeof fixture>>) => {
    const config = JSON.parse(await readFile(join(f.home, 'device.json'), 'utf8'));
    await writeFile(join(f.home, 'device.json'), JSON.stringify({ ...config, organizationId: 'org_foreign' }));
  } },
  { name: 'foreign signed workspace', expected: /invalid or expired/, mutate: async (f: Awaited<ReturnType<typeof fixture>>) => {
    const foreign = { ...f.unsigned, workspaceId: 'workspace-foreign' };
    await writeFile(f.policyPath, JSON.stringify({ ...f.signedPolicy, serverAuthorization: { ...foreign, signature: signCanonicalObject(foreign, f.keys.privateKey) } }));
  } },
  { name: 'replayed older authorization', expected: /older than the last accepted authorization/, mutate: async (f: Awaited<ReturnType<typeof fixture>>) => {
    await writeFile(f.statePath, JSON.stringify({ issuedAt: new Date(Date.now() - 30_000).toISOString(), signature: 'newer-accepted' }));
  } },
  ...[null, false, 0].map(value => ({ name: `invalid replay state ${JSON.stringify(value)}`,
    expected: /Workspace authorization replay state is missing or invalid/,
    mutate: async (f: Awaited<ReturnType<typeof fixture>>) => { await writeFile(f.statePath, JSON.stringify(value)); } })),
];

for (const scenario of cases) test(`actual skill sync rejects ${scenario.name} before transport or installation`, async () => {
  const f = await fixture();
  const path = await scenario.mutate(f) || f.policyPath;
  const previousHome = process.env.DHARMA_HOME, previousFetch = globalThis.fetch;
  const before = await readFile(f.policyPath), stateBefore = await readFile(f.statePath);
  let networkCalls = 0;
  process.env.DHARMA_HOME = f.home;
  globalThis.fetch = async () => { networkCalls += 1; throw new Error('unexpected_skill_network'); };
  try {
    await assert.rejects(() => run(['skills', 'sync', '--workspace-id', 'workspace-test', '--provider', 'codex', '--policy', path]), scenario.expected);
    assert.equal(networkCalls, 0);
    assert.deepEqual(await readFile(f.policyPath), before);
    assert.deepEqual(await readFile(f.statePath), stateBefore);
    assert.equal(createHash('sha256').update(before).digest('hex').length, 64);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousHome === undefined) delete process.env.DHARMA_HOME; else process.env.DHARMA_HOME = previousHome;
  }
});

test('skill policy loader rejects authorization expiring during the secure enrollment read', async () => {
  const f = await fixture(), previousHome = process.env.DHARMA_HOME, OriginalDate = Date;
  const values = new Map<string, string>();
  let clock = OriginalDate.now(), advanceOnRead = false;
  class FixtureDate extends OriginalDate {
    constructor(value?: string | number) { super(value === undefined ? clock : value); }
    static now() { return clock; }
  }
  const store: SecureSecretStore = { backend: 'linux-secret-service',
    get: async account => { if (advanceOnRead) clock += 3_600_001; return values.get(account) ?? null; },
    put: async (account, value) => { values.set(account, value); },
    delete: async account => { values.delete(account); } };
  process.env.DHARMA_HOME = f.home;
  try {
    const config = JSON.parse(await readFile(join(f.home, 'device.json'), 'utf8')) as DeviceConfig;
    await saveDeviceEnrollmentAnchor({ config, store });
    globalThis.Date = FixtureDate as DateConstructor;
    advanceOnRead = true;
    await assert.rejects(() => loadSkillSynchronizationPolicy(f.policyPath, 'workspace-test', store), /invalid or expired/);
  } finally {
    globalThis.Date = OriginalDate;
    if (previousHome === undefined) delete process.env.DHARMA_HOME; else process.env.DHARMA_HOME = previousHome;
  }
});

test('skill policy loader accepts anchored signed scope without discarding local skill or command controls', async () => {
  const f = await fixture(), previousHome = process.env.DHARMA_HOME;
  const values = new Map<string, string>();
  const store: SecureSecretStore = { backend: 'linux-secret-service',
    get: async account => values.get(account) ?? null,
    put: async (account, value) => { values.set(account, value); },
    delete: async account => { values.delete(account); } };
  process.env.DHARMA_HOME = f.home;
  try {
    const config = JSON.parse(await readFile(join(f.home, 'device.json'), 'utf8')) as DeviceConfig;
    await saveDeviceEnrollmentAnchor({ config, store });
    f.signedPolicy.skills.automaticInstall = false;
    f.signedPolicy.tasks.allowedCommands['approved.smoke'] = { argv: ['node', '--version'], timeoutSeconds: 10 };
    await writeFile(f.policyPath, JSON.stringify(f.signedPolicy));
    const loaded = await loadSkillSynchronizationPolicy(f.policyPath, 'workspace-test', store);
    assert.equal(loaded.policy.skills.automaticInstall, false);
    assert.deepEqual(loaded.policy.tasks.allowedCommands['approved.smoke']?.argv, ['node', '--version']);
    assert.equal(loaded.enrollment.organizationId, 'org_test');
    const oldState = await readFile(f.statePath);
    const again = await loadSkillSynchronizationPolicy(f.policyPath, 'workspace-test', store);
    assert.deepEqual(again.policy, loaded.policy);
    assert.deepEqual(await readFile(f.statePath), oldState);
    await writeFile(join(f.home, 'device.json'), JSON.stringify({ ...config, enrolledAt: new Date(Date.now() - 60_000).toISOString() }));
    await assert.rejects(() => loadSkillSynchronizationPolicy(f.policyPath, 'workspace-test', store), /secure enrollment anchor/);
  } finally {
    if (previousHome === undefined) delete process.env.DHARMA_HOME; else process.env.DHARMA_HOME = previousHome;
  }
});
