import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import test from 'node:test';
import { signCanonicalObject, type TrustedServerSigningKeyset } from '@dharma-ai-labs/agent-fabric-contracts';
import type { SecureSecretStore } from '@dharma-ai-labs/agent-fabric-relay-client';
import { acceptDemoSigningKeysets, acceptDemoSigningUpdate, recoverDemoSigningEnrollment, resolveDemoSigningTrust } from './demoSigningTrust.js';

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

const expiredNow = new Date('2026-09-28T03:00:00.000Z');
function approval(f: ReturnType<typeof fixture>) {
  return { schema: 'dharma.demo-enrollment-approval/v1', organizationId: f.config.organizationId,
    repositoryId: f.config.repositoryId, participantId: '20000000-0000-4000-8000-000000000001',
    deviceId: f.config.deviceId, enrollmentId: '50000000-0000-4000-8000-000000000001',
    publicKeyEd25519: f.config.publicKeyEd25519, approvedAt: expiredNow.toISOString(),
    expiresAt: new Date(expiredNow.getTime() + 60_000).toISOString() };
}

test('browser re-enrollment archives expired trust and repairs an older disk binding on restart', async () => {
  const f = fixture();
  await resolveDemoSigningTrust(f.config, { store: f.store, now });
  const original = [...f.values.values()][0]!;
  const renewed = await recoverDemoSigningEnrollment(f.config,
    { serverPublicKeyEd25519: nextPublic, serverSigningKeyset: f.active }, approval(f), { store: f.store, now: expiredNow });
  assert.equal(renewed.enrolledAt, f.config.enrolledAt);
  assert.equal(renewed.nextSequence, f.config.nextSequence);
  assert.equal(renewed.serverPublicKeyEd25519, nextPublic);
  assert.ok([...f.values.values()].includes(original));
  assert.deepEqual(await resolveDemoSigningTrust(f.config, { store: f.store, now: expiredNow }), renewed);
  assert.doesNotMatch([...f.values.values()].join(''), /grant|privateJwk|privateKey|authorization/i);
});

test('re-enrollment of an expired legacy file labels its snapshot without treating it as prior protected authority', async () => {
  const f = fixture();
  const renewed = await recoverDemoSigningEnrollment(f.config,
    { serverPublicKeyEd25519: nextPublic, serverSigningKeyset: f.active }, approval(f), { store: f.store, now: expiredNow });
  assert.ok([...f.values.values()].some(value => value.includes('"previousWasProtected":false')));
  assert.deepEqual(await resolveDemoSigningTrust(f.config, { store: f.store, now: expiredNow }), renewed);
});

test('re-enrollment requires a fresh scoped approval and rejects credentials, old receipts and malformed candidates', async () => {
  for (const change of [null, { schema: 'legacy' }, { grant: 'never-persist' },
    { organizationId: 'org_foreign' }, { repositoryId: '10000000-0000-4000-8000-000000000099' },
    { deviceId: '30000000-0000-4000-8000-000000000099' }, { publicKeyEd25519: 'E'.repeat(43) },
    { approvedAt: now.toISOString() }, { approvedAt: new Date(expiredNow.getTime() + 60_000).toISOString() },
    { expiresAt: expiredNow.toISOString() }, { expiresAt: new Date(expiredNow.getTime() + 16 * 60_000).toISOString() }]) {
    const f = fixture();
    await resolveDemoSigningTrust(f.config, { store: f.store, now });
    const before = [...f.values.entries()];
    await assert.rejects(recoverDemoSigningEnrollment(f.config,
      { serverPublicKeyEd25519: nextPublic, serverSigningKeyset: f.active },
      change === null ? null : { ...approval(f), ...change }, { store: f.store, now: expiredNow }), /Demo signing/);
    assert.deepEqual([...f.values.entries()], before);
  }
  for (const trust of [{ serverPublicKeyEd25519: oldPublic, serverSigningKeyset: fixture().active },
    { serverPublicKeyEd25519: nextPublic, serverSigningKeyset: { ...fixture().active, signature: 'invalid' } },
    { serverPublicKeyEd25519: nextPublic, serverSigningKeyset: { ...fixture().active, generation: 1 } }]) {
    const f = fixture();
    await assert.rejects(recoverDemoSigningEnrollment(f.config, trust, approval(f), { store: f.store, now: expiredNow }), /Demo signing/);
    assert.equal(f.values.size, 0);
  }
});

test('valid protected trust and modified disk bindings cannot be replaced through re-enrollment', async () => {
  const f = fixture();
  await resolveDemoSigningTrust(f.config, { store: f.store, now });
  const before = [...f.values.entries()];
  await assert.rejects(recoverDemoSigningEnrollment(f.config,
    { serverPublicKeyEd25519: nextPublic, serverSigningKeyset: f.active },
    { ...approval(f), approvedAt: now.toISOString(), expiresAt: new Date(now.getTime() + 60_000).toISOString() },
    { store: f.store, now }), /approval_must_follow_trust_expiry/);
  const altered = { ...f.config, enrolledAt: '2026-09-27T02:31:00Z' };
  await assert.rejects(recoverDemoSigningEnrollment(altered,
    { serverPublicKeyEd25519: nextPublic, serverSigningKeyset: f.active }, approval(f), { store: f.store, now: expiredNow }), /binding_mismatch/);
  assert.deepEqual([...f.values.entries()], before);
});

test('recipient approval cannot extend or rewrite a retained expired signing key', async () => {
  const f = fixture();
  const { signature: _signature, ...body } = f.active;
  const altered = { ...body, keys: body.keys.map(key => key.keyVersion === 'original'
    ? { ...key, notAfter: newExpiry } : key) };
  await assert.rejects(recoverDemoSigningEnrollment(f.config,
    { serverPublicKeyEd25519: nextPublic,
      serverSigningKeyset: { ...altered, signature: signCanonicalObject(altered, next.privateKey) } },
    approval(f), { store: f.store, now: expiredNow }), /retained_window_changed/);
  assert.equal(f.values.size, 0);
});

test('interrupted protected replacement resumes from confirmed history without extending old validity', async () => {
  for (const interruptedAt of ['before', 'after', 'removed']) {
    const f = fixture();
    await resolveDemoSigningTrust(f.config, { store: f.store, now });
    const original = [...f.values.values()][0]!;
    const store: SecureSecretStore = { ...f.store, async put(account, value) {
      if (!account.includes('-history-') && !account.endsWith('-recovery') && !account.includes('-approval-')) {
        if (interruptedAt === 'after') await f.store.put(account, value);
        if (interruptedAt === 'removed') await f.store.delete(account);
        throw new Error('interrupted anchor replacement');
      }
      await f.store.put(account, value);
    } };
    await assert.rejects(recoverDemoSigningEnrollment(f.config,
      { serverPublicKeyEd25519: nextPublic, serverSigningKeyset: f.active }, approval(f), { store, now: expiredNow }), /interrupted/);
    assert.ok([...f.values.values()].includes(original));
    if (interruptedAt === 'after') {
      const restored = await resolveDemoSigningTrust(f.config, { store: f.store, now: expiredNow });
      assert.equal(restored.serverPublicKeyEd25519, nextPublic);
      assert.equal(restored.serverSigningKeyset?.keys[0]?.notAfter, oldExpiry);
    } else {
      const restored = await recoverDemoSigningEnrollment(f.config,
        { serverPublicKeyEd25519: nextPublic, serverSigningKeyset: f.active }, approval(f), { store: f.store, now: expiredNow });
      assert.equal(restored.serverPublicKeyEd25519, nextPublic);
    }
  }
});

test('a missing active anchor cannot recover from changed approval, missing history or malformed journal', async () => {
  for (const fault of ['recipient', 'enrollment', 'expired', 'binding', 'history', 'approval_record', 'null_journal', 'invalid_journal']) {
    const f = fixture();
    await resolveDemoSigningTrust(f.config, { store: f.store, now });
    const [account] = [...f.values.keys()];
    const store: SecureSecretStore = { ...f.store, async put(key, value) {
      if (key === account) {
        await f.store.delete(key);
        throw new Error('interrupted anchor replacement');
      }
      await f.store.put(key, value);
    } };
    const trust = { serverPublicKeyEd25519: nextPublic, serverSigningKeyset: f.active };
    await assert.rejects(recoverDemoSigningEnrollment(f.config, trust, approval(f), { store, now: expiredNow }), /interrupted/);
    if (fault === 'history') f.values.delete([...f.values.keys()].find(key => key.includes('-history-'))!);
    if (fault === 'approval_record') f.values.delete([...f.values.keys()].find(key => key.includes('-approval-'))!);
    if (fault === 'null_journal') f.values.set(`${account}-recovery`, 'null');
    if (fault === 'invalid_journal') f.values.set(`${account}-recovery`, '{');
    const receipt = { ...approval(f), ...(fault === 'recipient'
      ? { participantId: '20000000-0000-4000-8000-000000000099' }
      : fault === 'enrollment' ? { enrollmentId: '50000000-0000-4000-8000-000000000099' } : {}) };
    const before = [...f.values.entries()];
    await assert.rejects(recoverDemoSigningEnrollment(
      { ...f.config, ...(fault === 'binding' ? { enrolledAt: '2026-09-27T02:31:00Z' } : {}) }, trust, receipt,
      { store: f.store, now: fault === 'expired' ? new Date(expiredNow.getTime() + 60_000) : expiredNow }), /Demo signing trust rejected/);
    assert.deepEqual([...f.values.entries()], before);
  }
});

test('a fresh recipient approval resumes an abandoned missing-anchor write after its earlier approval expires', async () => {
  const f = fixture();
  await resolveDemoSigningTrust(f.config, { store: f.store, now });
  const [account, original] = [...f.values.entries()][0]!;
  const trust = { serverPublicKeyEd25519: nextPublic, serverSigningKeyset: f.active };
  const interrupted: SecureSecretStore = { ...f.store, async put(key, value) {
    if (key === account) {
      await f.store.delete(key);
      throw new Error('interrupted anchor replacement');
    }
    await f.store.put(key, value);
  } };
  const oldReceipt = approval(f);
  await assert.rejects(recoverDemoSigningEnrollment(f.config, trust, oldReceipt,
    { store: interrupted, now: expiredNow }), /interrupted/);
  const oldJournal = f.values.get(`${account}-recovery`)!;
  const afterApprovalExpiry = new Date(Date.parse(oldReceipt.expiresAt) + 1_000);
  const freshReceipt = { ...oldReceipt, enrollmentId: '50000000-0000-4000-8000-000000000002',
    approvedAt: afterApprovalExpiry.toISOString(),
    expiresAt: new Date(afterApprovalExpiry.getTime() + 60_000).toISOString() };
  const before = [...f.values.entries()];
  await assert.rejects(recoverDemoSigningEnrollment(f.config, trust, oldReceipt,
    { store: f.store, now: afterApprovalExpiry }), /approval_scope_or_expiry_invalid/);
  assert.deepEqual([...f.values.entries()], before);
  const renewed = await recoverDemoSigningEnrollment(f.config, trust, freshReceipt,
    { store: f.store, now: afterApprovalExpiry });
  assert.equal(renewed.deviceId, f.config.deviceId);
  assert.equal(renewed.enrolledAt, f.config.enrolledAt);
  assert.equal(renewed.nextSequence, f.config.nextSequence);
  assert.ok([...f.values.values()].includes(original));
  assert.equal(f.values.get(`${account}-approval-${oldReceipt.enrollmentId}`), oldJournal);
  assert.equal(f.values.size, 5, 'fresh receipt adds one immutable record, not another device or duplicate history');
  assert.deepEqual(await resolveDemoSigningTrust(f.config, { store: f.store, now: afterApprovalExpiry }), renewed);
});

test('renewing an interrupted approval preserves recipient scope, expiry, history and generation fencing', async () => {
  for (const fault of ['still_valid', 'early_approval', 'same_enrollment', 'organization', 'repository',
    'participant', 'device', 'key', 'missing_approval', 'corrupt_approval', 'missing_history',
    'corrupt_history', 'lower_generation', 'conflicting_generation']) {
    const f = fixture();
    await resolveDemoSigningTrust(f.config, { store: f.store, now });
    const [account] = [...f.values.keys()];
    const trust = { serverPublicKeyEd25519: nextPublic, serverSigningKeyset: f.active };
    const interrupted: SecureSecretStore = { ...f.store, async put(key, value) {
      if (key === account) {
        await f.store.delete(key);
        throw new Error('interrupted anchor replacement');
      }
      await f.store.put(key, value);
    } };
    const oldReceipt = approval(f);
    await assert.rejects(recoverDemoSigningEnrollment(f.config, trust, oldReceipt,
      { store: interrupted, now: expiredNow }), /interrupted/);
    const retryAt = fault === 'still_valid' ? new Date(expiredNow.getTime() + 1_000)
      : new Date(Date.parse(oldReceipt.expiresAt) + 1_000);
    const receipt = { ...oldReceipt, enrollmentId: '50000000-0000-4000-8000-000000000002',
      approvedAt: retryAt.toISOString(), expiresAt: new Date(retryAt.getTime() + 60_000).toISOString() };
    if (fault === 'early_approval') receipt.approvedAt = oldReceipt.expiresAt;
    if (fault === 'same_enrollment') receipt.enrollmentId = oldReceipt.enrollmentId;
    if (fault === 'organization') receipt.organizationId = 'org_foreign';
    if (fault === 'repository') receipt.repositoryId = '10000000-0000-4000-8000-000000000099';
    if (fault === 'participant') receipt.participantId = '20000000-0000-4000-8000-000000000099';
    if (fault === 'device') receipt.deviceId = '30000000-0000-4000-8000-000000000099';
    if (fault === 'key') receipt.publicKeyEd25519 = 'E'.repeat(43);
    const oldApprovalAccount = `${account}-approval-${oldReceipt.enrollmentId}`;
    const historyAccount = [...f.values.keys()].find(key => key.includes('-history-'))!;
    if (fault === 'missing_approval') f.values.delete(oldApprovalAccount);
    if (fault === 'corrupt_approval') f.values.set(oldApprovalAccount, '{}');
    if (fault === 'missing_history') f.values.delete(historyAccount);
    if (fault === 'corrupt_history') f.values.set(historyAccount, '{}');
    const candidate = fault === 'lower_generation' ? signed(2, f.active.keys, true)
      : fault === 'conflicting_generation' ? signed(3, [...f.active.keys].reverse(), true) : f.active;
    const before = [...f.values.entries()];
    await assert.rejects(recoverDemoSigningEnrollment(f.config,
      { ...trust, serverSigningKeyset: candidate }, receipt, { store: f.store, now: retryAt }),
    /Demo signing trust rejected/, fault);
    assert.deepEqual([...f.values.entries()], before, `${fault}: rejection cannot write protected state`);
  }
});

test('fresh approval may recover to a newer generation without reusing the abandoned pending generation', async () => {
  const f = fixture();
  await resolveDemoSigningTrust(f.config, { store: f.store, now });
  const [account] = [...f.values.keys()];
  const interrupted: SecureSecretStore = { ...f.store, async put(key, value) {
    if (key === account) {
      await f.store.delete(key);
      throw new Error('interrupted anchor replacement');
    }
    await f.store.put(key, value);
  } };
  const oldReceipt = approval(f);
  await assert.rejects(recoverDemoSigningEnrollment(f.config,
    { serverPublicKeyEd25519: nextPublic, serverSigningKeyset: f.active }, oldReceipt,
    { store: interrupted, now: expiredNow }), /interrupted/);
  const retryAt = new Date(Date.parse(oldReceipt.expiresAt) + 1_000);
  const renewed = await recoverDemoSigningEnrollment(f.config,
    { serverPublicKeyEd25519: nextPublic, serverSigningKeyset: signed(4, f.active.keys, true) },
    { ...oldReceipt, enrollmentId: '50000000-0000-4000-8000-000000000002',
      approvedAt: retryAt.toISOString(), expiresAt: new Date(retryAt.getTime() + 60_000).toISOString() },
    { store: f.store, now: retryAt });
  assert.equal(renewed.serverSigningKeyset?.generation, 4);
  assert.equal(renewed.nextSequence, f.config.nextSequence);
  assert.deepEqual(await resolveDemoSigningTrust(f.config, { store: f.store, now: retryAt }), renewed);
});

test('every protected recovery write must be confirmed before returning replacement trust', async () => {
  for (const phase of ['history', 'approval', 'journal', 'anchor']) {
    const f = fixture();
    await resolveDemoSigningTrust(f.config, { store: f.store, now });
    const [account, original] = [...f.values.entries()][0]!;
    const store: SecureSecretStore = { ...f.store, async put(key, value) {
      if ((phase === 'history' && key.includes('-history-'))
        || (phase === 'approval' && key.includes('-approval-'))
        || (phase === 'journal' && key.endsWith('-recovery'))
        || (phase === 'anchor' && key === account)) return;
      await f.store.put(key, value);
    } };
    await assert.rejects(recoverDemoSigningEnrollment(f.config,
      { serverPublicKeyEd25519: nextPublic, serverSigningKeyset: f.active }, approval(f), { store, now: expiredNow }), /write_not_confirmed/);
    assert.equal(f.values.get(account), original);
    await assert.rejects(resolveDemoSigningTrust(f.config, { store: f.store, now: expiredNow }), /expired/);
  }
});

test('a cached secure-store echo cannot substitute for confirmed OS storage', async () => {
  const f = fixture();
  const cache = new Map<string, string>();
  const store: SecureSecretStore = { ...f.store,
    async get(account) { return cache.get(account) ?? null; },
    async getFresh() { return null; },
    async put(account, value) { cache.set(account, value); } };
  await assert.rejects(resolveDemoSigningTrust(f.config, { store, now }), /write_not_confirmed/);
  await assert.rejects(recoverDemoSigningEnrollment(f.config,
    { serverPublicKeyEd25519: nextPublic, serverSigningKeyset: f.active }, approval(f), { store, now: expiredNow }), /write_not_confirmed/);
  assert.equal(f.values.size, 0);
});

test('accepted approval identities cannot be replayed with edited timestamps or a different recipient', async () => {
  const f = fixture();
  await resolveDemoSigningTrust(f.config, { store: f.store, now });
  const renewed = await recoverDemoSigningEnrollment(f.config,
    { serverPublicKeyEd25519: nextPublic, serverSigningKeyset: f.active }, approval(f), { store: f.store, now: expiredNow });
  const afterExpiry = new Date(Date.parse(newExpiry) + 60_000);
  const fourth = generateKeyPairSync('ed25519');
  const fourthPin = fourth.publicKey.export({ format: 'jwk' }).x!;
  const body = { schema: 'dharma.server-signing-keyset/v1' as const, organizationId: f.config.organizationId,
    generation: 4, signedByKeyVersion: 'fourth', issuedAt: afterExpiry.toISOString(),
    expiresAt: new Date(afterExpiry.getTime() + 86_400_000).toISOString(), keys: [{ keyVersion: 'fourth',
      publicKeyEd25519: fourthPin, status: 'active' as const, notBefore: afterExpiry.toISOString(),
      notAfter: new Date(afterExpiry.getTime() + 86_400_000).toISOString() }] };
  const trust = { serverPublicKeyEd25519: fourthPin,
    serverSigningKeyset: { ...body, signature: signCanonicalObject(body, fourth.privateKey) } };
  const before = [...f.values.entries()];
  for (const change of [{}, { participantId: '20000000-0000-4000-8000-000000000099',
    enrollmentId: '50000000-0000-4000-8000-000000000099' }]) {
    await assert.rejects(recoverDemoSigningEnrollment(renewed, trust,
      { ...approval(f), approvedAt: afterExpiry.toISOString(),
        expiresAt: new Date(afterExpiry.getTime() + 60_000).toISOString(), ...change },
      { store: f.store, now: afterExpiry }), /approval_replayed_or_conflicting/);
    assert.deepEqual([...f.values.entries()], before);
  }
});

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

test('an active generation cannot reactivate a retained old key without a new preload', async () => {
  const f = fixture();
  const active = await acceptDemoSigningKeysets(f.config, [f.preload, f.active], { store: f.store, now });
  const rollback = signed(4, f.preload.keys.map(k => ({ ...k,
    status: k.keyVersion === 'original' ? 'active' as const : 'overlap' as const })));
  await assert.rejects(acceptDemoSigningKeysets(active, [rollback], { store: f.store, now }), /Demo signing/);
});

test('a pending preload cannot be replaced by another preload', async () => {
  const f = fixture();
  const current = await acceptDemoSigningKeysets(f.config, [f.preload], { store: f.store, now });
  const third = generateKeyPairSync('ed25519');
  const repeated = signed(3, [...f.preload.keys, { ...f.preload.keys[1]!, keyVersion: 'third',
    publicKeyEd25519: third.publicKey.export({ format: 'jwk' }).x! }]);
  await assert.rejects(acceptDemoSigningKeysets(current, [repeated], { store: f.store, now }), /Demo signing/);
});

test('a restarted client activates only the successor recorded in protected preload state', async () => {
  const f = fixture();
  await acceptDemoSigningKeysets(f.config, [f.preload], { store: f.store, now });
  const restarted = await resolveDemoSigningTrust(f.config, { store: f.store, now });
  const activated = await acceptDemoSigningKeysets(restarted, [f.active], { store: f.store, now });
  assert.equal(activated.serverSigningKeyset?.generation, 3);
  const third = generateKeyPairSync('ed25519');
  const body = { ...f.active, generation: 4, keys: [...f.active.keys, { ...f.preload.keys[1]!,
    keyVersion: 'third', publicKeyEd25519: third.publicKey.export({ format: 'jwk' }).x! }] };
  const { signature: _signature, ...unsigned } = body;
  const preload = { ...unsigned, signature: signCanonicalObject(unsigned, next.privateKey) };
  const pending = await acceptDemoSigningKeysets(activated, [preload], { store: f.store, now });
  const wrong = signed(5, preload.keys.map(k => ({ ...k,
    status: k.keyVersion === 'original' ? 'active' as const : 'overlap' as const })));
  await assert.rejects(acceptDemoSigningKeysets(pending, [wrong], { store: f.store, now }), /Demo signing/);
});
