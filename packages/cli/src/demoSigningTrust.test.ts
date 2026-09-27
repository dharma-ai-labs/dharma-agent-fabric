import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import test from 'node:test';
import { signCanonicalObject, type TrustedServerSigningKeyset } from '@dharma-ai-labs/agent-fabric-contracts';
import type { SecureSecretStore } from '@dharma-ai-labs/agent-fabric-relay-client';
import { acceptDemoSigningKeysets, acceptDemoSigningUpdate, resolveDemoSigningTrust } from './demoSigningTrust.js';

const now = new Date('2026-09-27T03:00:00.000Z');
const old = generateKeyPairSync('ed25519');
const next = generateKeyPairSync('ed25519');
const oldPublic = old.publicKey.export({ format: 'jwk' }).x!;
const nextPublic = next.publicKey.export({ format: 'jwk' }).x!;
const oldExpiry = '2026-09-27T23:00:00.000Z';
const newExpiry = '2026-10-20T23:00:00.000Z';
function signed(generation: number, keys: TrustedServerSigningKeyset['keys'], successor = false) {
  const body = { schema: 'dharma.server-signing-keyset/v1' as const, organizationId: 'org_fixture',
    generation, keys, signedByKeyVersion: successor ? 'successor' : 'original',
    issuedAt: '2026-09-27T02:00:00.000Z', expiresAt: successor ? newExpiry : oldExpiry };
  return { ...body, signature: signCanonicalObject(body, successor ? next.privateKey : old.privateKey) };
}
function fixture() {
  const initial = signed(1, [{ keyVersion: 'original', publicKeyEd25519: oldPublic,
    status: 'active', notBefore: '2026-09-01T00:00:00.000Z', notAfter: oldExpiry }]);
  const preload = signed(2, [...initial.keys, { keyVersion: 'successor', publicKeyEd25519: nextPublic,
    status: 'overlap', notBefore: '2026-09-27T02:00:00.000Z', notAfter: newExpiry }]);
  const active = signed(3, preload.keys.map(key => ({ ...key,
    status: key.keyVersion === 'successor' ? 'active' as const : 'overlap' as const })), true);
  const config = { schema: 'dharma.demo-device/v1' as const, hqUrl: 'https://dharma.example',
    organizationId: 'org_fixture', repositoryId: '10000000-0000-4000-8000-000000000001',
    normalizedRepository: 'github.com/example/private',
    installationId: '40000000-0000-4000-8000-000000000001',
    deviceId: '30000000-0000-4000-8000-000000000001', publicKeyEd25519: 'D'.repeat(43),
    enrolledAt: '2026-09-27T02:30:00.000Z', signedReady: true, nextSequence: 1,
    serverPublicKeyEd25519: oldPublic, serverSigningKeyset: initial };
  const values = new Map<string, string>();
  const store: SecureSecretStore = { backend: 'linux-secret-service',
    async get(account) { return values.get(account) ?? null; },
    async put(account, value) { values.set(account, value); },
    async delete(account) { values.delete(account); } };
  return { initial, preload, active, config, store, values };
}

test('Demo trust survives restart and original-key expiry only after a protected successor transition', async () => {
  const f = fixture();
  const updated = await acceptDemoSigningKeysets(f.config, [f.preload, f.active], { store: f.store, now });
  assert.equal(updated.serverSigningKeyset?.generation, 3);
  assert.equal(updated.serverPublicKeyEd25519, oldPublic);
  assert.equal(updated.serverSigningKeyset?.keys[0]?.notAfter, oldExpiry);
  const afterOriginalExpiry = new Date('2026-09-28T03:00:00.000Z');
  const restarted = await resolveDemoSigningTrust(updated, { store: f.store, now: afterOriginalExpiry });
  assert.deepEqual(restarted, updated);
  // Protected write-ahead storage recovers an interrupted disk replacement.
  const recovered = await resolveDemoSigningTrust(f.config, { store: f.store, now: afterOriginalExpiry });
  assert.equal(recovered.serverSigningKeyset?.generation, 3);
});

test('Demo trust rejects unknown signers, generation skips, changed old windows and revoked keys', async () => {
  for (const attack of ['unknown', 'skip', 'extend', 'shorten', 'remove', 'activate_without_preload']) {
    const f = fixture();
    let candidate = f.preload;
    if (attack === 'unknown') candidate = signed(2, f.active.keys, true);
    if (attack === 'skip') candidate = signed(4, f.preload.keys);
    if (attack === 'extend') candidate = signed(2, f.preload.keys.map(k => ({ ...k, notAfter: newExpiry })));
    if (attack === 'shorten') candidate = signed(2, f.preload.keys.map(k => ({ ...k,
      notAfter: k.keyVersion === 'original' ? '2026-09-27T22:00:00.000Z' : k.notAfter })));
    if (attack === 'remove') candidate = signed(2, f.preload.keys.slice(1), true);
    if (attack === 'activate_without_preload') candidate = signed(2, f.active.keys);
    await assert.rejects(acceptDemoSigningKeysets(f.config, [candidate], { store: f.store, now }), /Demo signing/);
    assert.equal((await resolveDemoSigningTrust(f.config, { store: f.store, now })).serverSigningKeyset?.generation, 1);
  }
});

test('Demo trust distinguishes identical delivery from replayed or conflicting generations', async () => {
  const f = fixture();
  const updated = await acceptDemoSigningKeysets(f.config, [f.preload], { store: f.store, now });
  assert.deepEqual(await acceptDemoSigningKeysets(updated, [f.preload], { store: f.store, now }), updated);
  await assert.rejects(acceptDemoSigningKeysets(updated, [f.initial], { store: f.store, now }), /Demo signing/);
  const conflict = signed(2, [...f.preload.keys].reverse());
  await assert.rejects(acceptDemoSigningKeysets(updated, [conflict], { store: f.store, now }), /Demo signing/);
  await assert.rejects(resolveDemoSigningTrust({ ...updated, serverSigningKeyset: conflict },
    { store: f.store, now }), /Demo signing/);
});

test('Demo trust rejects expired anchors instead of manufacturing a renewal or fresh pin', async () => {
  const f = fixture();
  await resolveDemoSigningTrust(f.config, { store: f.store, now });
  const expired = new Date('2026-09-28T03:00:00.000Z');
  await assert.rejects(acceptDemoSigningKeysets(f.config, [f.preload, f.active],
    { store: f.store, now: expired }), /Demo signing.*browser/i);
  const empty = fixture();
  await assert.rejects(resolveDemoSigningTrust(empty.config, { store: empty.store, now: expired }), /Demo signing/);
  assert.equal(empty.values.size, 0);
});

test('Demo trust binds protected state to the approved identity, repository and original pin', async () => {
  const f = fixture();
  await resolveDemoSigningTrust(f.config, { store: f.store, now });
  await assert.rejects(resolveDemoSigningTrust({ ...f.config, serverPublicKeyEd25519: nextPublic },
    { store: f.store, now }), /Demo signing/);
  await assert.rejects(resolveDemoSigningTrust({ ...f.config, publicKeyEd25519: 'E'.repeat(43) },
    { store: f.store, now }), /Demo signing/);
  await assert.rejects(acceptDemoSigningKeysets(f.config,
    [{ ...f.preload, organizationId: 'org_foreign' }], { store: f.store, now }), /Demo signing/);
  await assert.rejects(acceptDemoSigningKeysets(f.config, new Array(21).fill(f.preload),
    { store: f.store, now }), /Demo signing/);
  const serialized = [...f.values.values()].join('');
  assert.doesNotMatch(serialized, /grant|privateJwk|privateKey|authorization/i);
});

test('Demo trust does not acknowledge a secure-store write that was not durably confirmed', async () => {
  const f = fixture();
  const store: SecureSecretStore = { ...f.store, async put() {} };
  await assert.rejects(resolveDemoSigningTrust(f.config, { store, now }), /confirm/i);
});

test('Demo signing update enforces its runtime schema, recipient scope and bounded response lifetime', async () => {
  const f = fixture();
  const value = { schema: 'dharma.demo-signing-update/v1', organizationId: f.config.organizationId,
    repositoryId: f.config.repositoryId, deviceId: f.config.deviceId, issuedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + 60_000).toISOString(), keysets: [f.preload, f.active] };
  for (const override of [{ schema: 'legacy' }, { grant: 'must-not-persist' },
    { organizationId: 'org_foreign' }, { repositoryId: '10000000-0000-4000-8000-000000000099' },
    { deviceId: '30000000-0000-4000-8000-000000000099' }, { expiresAt: now.toISOString() },
    { issuedAt: new Date(now.getTime() + 60_000).toISOString() },
    { expiresAt: new Date(now.getTime() + 6 * 60_000).toISOString() },
    { keysets: [] }, { keysets: [null] }, { keysets: new Array(21).fill(f.preload) }]) {
    await assert.rejects(acceptDemoSigningUpdate(f.config, { ...value, ...override }, { store: f.store, now }), /Demo signing/);
  }
  assert.equal(f.values.size, 0);
  const updated = await acceptDemoSigningUpdate(f.config, value, { store: f.store, now });
  assert.equal(updated.serverSigningKeyset?.generation, 3);
});

test('invalid late chain element cannot partially install an otherwise valid preload', async () => {
  const f = fixture();
  await assert.rejects(acceptDemoSigningKeysets(f.config, [f.preload, { ...f.active, signature: 'corrupt' }],
    { store: f.store, now }), /Demo signing/);
  const anchor = await resolveDemoSigningTrust(f.config, { store: f.store, now });
  assert.equal(anchor.serverSigningKeyset?.generation, 1);
});

test('Demo preload rejects a successor that is not yet valid or has no transition safety window', async () => {
  for (const change of [{ notBefore: '2026-09-27T04:00:00.000Z' },
    { notAfter: '2026-09-27T03:05:00.000Z' }]) {
    const f = fixture();
    const candidate = signed(2, f.preload.keys.map(k => k.keyVersion === 'successor' ? { ...k, ...change } : k));
    await assert.rejects(acceptDemoSigningKeysets(f.config, [candidate], { store: f.store, now }), /Demo signing/);
  }
});
