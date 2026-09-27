import assert from 'node:assert/strict';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { signCanonicalObject, type TrustedServerSigningKeyset } from '@dharma-ai-labs/agent-fabric-contracts';
import { LocalVault, type LocalProviderSessionBinding } from '@dharma-ai-labs/agent-fabric-local-vault';
import { installTrustedServerSigningKeyset, saveDeviceConfig, saveDeviceEnrollmentAnchor,
  type DeviceConfig, type SecureSecretStore } from '@dharma-ai-labs/agent-fabric-relay-client';
import { createNamedSessionTrust, isNamedSessionOwnerReceipt, renewNamedSessionLifetime } from './namedSessionTrust.js';
import { createProviderSessionChannel } from './providerSessionChannel.js';

const uuid = (n: number) => `40000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'fabric-session-trust-'));
  let now = new Date();
  const first = generateKeyPairSync('ed25519'), second = generateKeyPairSync('ed25519');
  const firstPublic = first.publicKey.export({ format: 'jwk' }).x!;
  const secondPublic = second.publicKey.export({ format: 'jwk' }).x!;
  const notBefore = new Date(now.getTime() - 60_000).toISOString();
  const oldExpiry = new Date(now.getTime() + 2 * 86400000).toISOString();
  const newExpiry = new Date(now.getTime() + 10 * 86400000).toISOString();
  const initialUnsigned = { schema: 'dharma.server-signing-keyset/v1' as const, organizationId: 'org_test', generation: 1,
    keys: [{ keyVersion: 'kms/1', publicKeyEd25519: firstPublic, status: 'active' as const, notBefore, notAfter: oldExpiry }],
    signedByKeyVersion: 'kms/1', issuedAt: now.toISOString(), expiresAt: oldExpiry };
  const initial = { ...initialUnsigned, signature: signCanonicalObject(initialUnsigned, first.privateKey) };
  const rotatedUnsigned = { ...initialUnsigned, generation: 2, expiresAt: newExpiry,
    keys: [{ ...initialUnsigned.keys[0]!, status: 'overlap' as const },
      { keyVersion: 'kms/2', publicKeyEd25519: secondPublic, status: 'active' as const, notBefore, notAfter: newExpiry }] };
  const rotated: TrustedServerSigningKeyset = { ...rotatedUnsigned, signature: signCanonicalObject(rotatedUnsigned, first.privateKey) };
  const values = new Map<string, string>();
  const store: SecureSecretStore = { backend: 'linux-secret-service', get: async key => values.get(key) ?? null,
    put: async (key, value) => { values.set(key, value); }, delete: async key => { values.delete(key); } };
  const config: DeviceConfig = { schema: 'dharma.device-config/v1', hqUrl: 'https://hq.example', relayUrl: 'wss://relay.example',
    organizationId: 'org_test', deviceId: uuid(5), deviceName: 'test', platform: 'linux',
    publicKeyEd25519: firstPublic, serverPublicKeyEd25519: firstPublic, serverSigningKeyset: initial, enrolledAt: now.toISOString() };
  const configPath = join(root, 'device.json');
  await saveDeviceConfig(configPath, config); await saveDeviceEnrollmentAnchor({ config, store });
  const trust = createNamedSessionTrust({ configPath, identity: config, store, now: () => now });
  const vault = await LocalVault.open({ root: join(root, 'vault'), masterKey: randomBytes(32) });
  const binding: LocalProviderSessionBinding = { schema: 'dharma.local-provider-session-binding/v1', owner: 'dharma_bridge',
    organizationId: config.organizationId, deviceId: config.deviceId, membershipId: uuid(4), repositoryBindingId: uuid(1),
    workspaceId: uuid(2), endpointId: uuid(3), bindingId: uuid(6), provider: 'codex', sessionId: 'retained-thread',
    workspaceRoot: root, createdAt: now.toISOString(), expiresAt: oldExpiry, maximumProviderCostCents: 25 };
  vault.saveProviderSessionBinding(binding);
  return { root, trust, vault, binding, config, configPath, store, rotated, oldExpiry, newExpiry, second,
    setTime: (time: Date) => { now = time; }, now: () => now };
}

test('protected successor trust is refreshed while running and after original expiry on restart', async () => {
  const f = await fixture();
  try {
    await f.trust.refresh(); assert.ok(f.trust.resolvePublicKey('kms/1')); assert.equal(f.trust.resolvePublicKey('kms/2'), null);
    await installTrustedServerSigningKeyset({ configPath: f.configPath, candidate: f.rotated, store: f.store, now: f.now() });
    await f.trust.refresh(); assert.ok(f.trust.resolvePublicKey('kms/2'));
    f.setTime(new Date(Date.parse(f.oldExpiry) + 1000));
    const restarted = createNamedSessionTrust({ configPath: f.configPath, identity: f.config, store: f.store, now: f.now });
    await restarted.refresh(); assert.ok(restarted.resolvePublicKey('kms/2')); assert.equal(restarted.resolvePublicKey('kms/1'), null);
    await renewNamedSessionLifetime({ vault: f.vault, bindingId: f.binding.bindingId, identity: f.binding,
      trust: restarted, authorize: async () => true, now: f.now });
    const renewed = f.vault.getProviderSessionBinding(f.binding.bindingId, f.binding)!;
    assert.deepEqual({ ...renewed, expiresAt: f.binding.expiresAt }, f.binding);
    assert.ok(Date.parse(renewed.expiresAt) > f.now().getTime());
    assert.equal(f.rotated.keys[0]!.notAfter, f.oldExpiry);
  } finally { f.vault.close(); }
});

test('expired, foreign, unprotected and conflicting trust never renews local authority', async () => {
  for (const kind of ['expired', 'foreign', 'unprotected', 'deleted_after_cache', 'conflicting'] as const) {
    const f = await fixture();
    try {
      if (kind === 'expired') f.setTime(new Date(Date.parse(f.oldExpiry) + 1));
      if (kind === 'foreign') await saveDeviceConfig(f.configPath, { ...f.config, organizationId: 'org_foreign' });
      if (kind === 'unprotected') f.store.get = async () => null;
      if (kind === 'deleted_after_cache') { await f.trust.refresh(); f.store.getFresh = async () => null; }
      if (kind === 'conflicting') await saveDeviceConfig(f.configPath,
        { ...f.config, serverSigningKeyset: { ...f.rotated, generation: 1 } });
      await assert.rejects(renewNamedSessionLifetime({ vault: f.vault, bindingId: f.binding.bindingId, identity: f.binding,
        trust: f.trust, authorize: async () => true, now: f.now }));
      assert.deepEqual(f.vault.getProviderSessionBinding(f.binding.bindingId, f.binding), f.binding);
    } finally { f.vault.close(); }
  }
});

test('revoked standing policy and local binding cannot be renewed', async () => {
  const f = await fixture();
  try {
    f.setTime(new Date(Date.parse(f.oldExpiry) - 1000));
    await assert.rejects(renewNamedSessionLifetime({ vault: f.vault, bindingId: f.binding.bindingId, identity: f.binding,
      trust: f.trust, authorize: async () => false, now: f.now }), /not_authorized/);
    f.vault.revokeProviderSessionBinding(f.binding.bindingId, f.binding);
    await assert.rejects(renewNamedSessionLifetime({ vault: f.vault, bindingId: f.binding.bindingId, identity: f.binding,
      trust: f.trust, authorize: async () => true, now: f.now }), /binding_unavailable/);
  } finally { f.vault.close(); }
});

test('a retained channel consumes successor-signed offers after protected rotation and local deadline renewal', async () => {
  const f = await fixture();
  let revision = 0;
  const signedOffer = () => {
    const unsigned = { schema: 'dharma.session-question/v1', questionId: uuid(10), taskId: uuid(11),
      organizationId: f.binding.organizationId, repositoryBindingId: f.binding.repositoryBindingId,
      source: { workspaceId: uuid(12), endpointId: uuid(13), membershipId: uuid(14), deviceId: uuid(15) },
      target: { workspaceId: f.binding.workspaceId, endpointId: f.binding.endpointId, membershipId: f.binding.membershipId,
        deviceId: f.binding.deviceId, bindingId: f.binding.bindingId, provider: f.binding.provider },
      category: 'code-review', question: 'Is the logical job deduplicated?',
      authority: { mode: 'read_only', readPaths: ['.'], network: 'deny', maximumProviderCostCents: 25 },
      createdAt: f.now().toISOString(), expiresAt: new Date(f.now().getTime() + 60_000).toISOString(),
      nonce: uuid(16), signerKeyVersion: 'kms/2' };
    return { ...unsigned, signature: signCanonicalObject(unsigned, f.second.privateKey) };
  };
  const { schema: _schema, owner: _owner, sessionId: _session, workspaceRoot: _root, createdAt: _created, ...scope } = f.binding;
  const channel = createProviderSessionChannel({ scope, mode: 'bridge_owned', expectedRevision: 0,
    assertOwner: async () => Boolean(f.vault.getProviderSessionBinding(f.binding.bindingId, f.binding)),
    currentExpiresAt: () => f.vault.getProviderSessionBinding(f.binding.bindingId, f.binding)?.expiresAt ?? null,
    verifier: f.trust, authorizeContent: async () => true, now: f.now,
    transport: { async signedPost(_route, input) {
      await f.trust.refresh();
      const body = input as { action: string };
      return body.action === 'inbox'
        ? { ok: true, organizationId: f.binding.organizationId, correlationId: uuid(90), result: { offers: [signedOffer()] } }
        : { ok: true, organizationId: f.binding.organizationId, correlationId: uuid(90), registration: {
          bindingId: f.binding.bindingId, workspaceId: f.binding.workspaceId, endpointId: f.binding.endpointId,
          repositoryBindingId: f.binding.repositoryBindingId, membershipId: f.binding.membershipId, deviceId: f.binding.deviceId,
          provider: 'codex', mode: 'bridge_owned', revision: ++revision, state: 'attached', replay: false,
          leaseUntil: new Date(f.now().getTime() + 60_000).toISOString() } };
    } } });
  try {
    await channel.attach();
    await installTrustedServerSigningKeyset({ configPath: f.configPath, candidate: f.rotated, store: f.store, now: f.now() });
    assert.equal((await channel.inbox())[0]?.signerKeyVersion, 'kms/2');
    f.setTime(new Date(Date.parse(f.oldExpiry) + 1000));
    await renewNamedSessionLifetime({ vault: f.vault, bindingId: f.binding.bindingId, identity: f.binding,
      trust: f.trust, authorize: async () => true, now: f.now });
    await channel.reconnect();
    assert.equal((await channel.inbox())[0]?.target.bindingId, f.binding.bindingId);
  } finally { f.vault.close(); }
});

test('lifetime renewal requires the exact owner inspect receipt, not an HTTP success or presence assumption', async () => {
  const f = await fixture();
  const { schema: _schema, owner: _owner, sessionId: _session, workspaceRoot: _root, createdAt: _created,
    expiresAt: _expiry, maximumProviderCostCents: _cost, organizationId, ...identity } = f.binding;
  const receipt = { ok: true, organizationId, correlationId: uuid(90), registration: { ...identity,
    mode: 'bridge_owned', revision: 5, state: 'attached', leaseUntil: f.now().toISOString(), replay: false } };
  try {
    assert.equal(isNamedSessionOwnerReceipt(receipt, f.binding.bindingId, { ...identity, organizationId }), true);
    for (const change of [{ membershipId: uuid(99) }, { deviceId: uuid(99) }, { repositoryBindingId: uuid(99) },
      { state: 'detached' }, { mode: 'cooperative' }, { replay: true }, { revision: 0 }, { leaseUntil: 'invalid' },
      { leaseUntil: new Date(Date.now() + 86400000).toISOString() }, { extra: true }]) {
      assert.equal(isNamedSessionOwnerReceipt({ ...receipt, registration: { ...receipt.registration, ...change } },
        f.binding.bindingId, { ...identity, organizationId }), false);
    }
    assert.equal(isNamedSessionOwnerReceipt({ ...receipt, organizationId: 'org_foreign' }, f.binding.bindingId,
      { ...identity, organizationId }), false);
    assert.equal(isNamedSessionOwnerReceipt({ ok: true }, f.binding.bindingId, { ...identity, organizationId }), false);
  } finally { f.vault.close(); }
});
