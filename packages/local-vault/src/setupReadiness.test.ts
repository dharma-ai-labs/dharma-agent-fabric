import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {mkdtemp, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import test from 'node:test';
import {LocalVault, parseLocalCodexSetupReadiness, type LocalCodexSetupReadiness} from './index.js';

const id = (n: number) => `${String(n).padStart(8, '0')}-1111-4111-8111-111111111111`;
const digest = `sha256:${'a'.repeat(64)}`;
function observation(): LocalCodexSetupReadiness {
  const now = Date.now();
  return {schema: 'dharma.local-codex-setup-readiness/v1', operationId: id(1), organizationId: 'org_demo',
    membershipId: id(2), deviceId: id(3), workspaceId: id(4), repositoryBindingId: id(5), repositoryAgentId: id(6),
    endpointId: id(7), sessionBindingId: id(8), sessionId: 'synthetic_session', repositoryFingerprint: digest,
    policyRevision: 'policy-v1', policyHash: digest, manifestHash: digest, catalogHash: digest, bundleId: id(9),
    bundleHash: digest, activeReceiptHash: digest, roleRevision: 1, roleProfileHash: digest, nativeSkillHash: digest,
    contractDigest: digest, cliVersion: '0.2.153', relayPid: 123, relayPolledAt: new Date(now - 1000).toISOString(),
    startupBackend: 'systemd-user', firstLearning: 'no_eligible_history', verifiedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + 60_000).toISOString()};
}
async function fixture(run: (root: string, key: Buffer, vault: LocalVault) => Promise<void>) {
  const root = await mkdtemp(resolve(tmpdir(), 'fabric-setup-readiness-')), key = randomBytes(32);
  const vault = await LocalVault.open({root, masterKey: key});
  try {await run(root, key, vault);} finally {vault.close(); await rm(root, {recursive: true, force: true});}
}
function lease(vault: LocalVault, operationId = id(1)) {
  const claim = vault.claimCodexSetupOperation(operationId, digest);
  assert.equal(claim.state, 'acquired');
  if (claim.state !== 'acquired') throw new Error('fixture_claim_missing');
  return claim.leaseId;
}

test('actual encrypted readiness persistence creates a stable receipt and survives reopen', async () => {
  await fixture(async (root, key, vault) => {
    const leaseId = lease(vault), value = observation();
    const receipt = vault.recordCodexSetupReadiness(leaseId, digest, value);
    assert.match(receipt.receiptId, /^[a-f0-9-]{36}$/);
    assert.deepEqual(vault.recordCodexSetupReadiness(leaseId, digest, value), receipt);
    assert.deepEqual(vault.getCodexSetupReadiness(receipt.receiptId, id(1), digest), receipt);
    vault.finishCodexSetupOperation(leaseId, digest, {state: 'completed', readinessReceiptId: receipt.receiptId});
    vault.close();
    const reopened = await LocalVault.open({root, masterKey: key});
    try {
      assert.deepEqual(reopened.getCodexSetupReadiness(receipt.receiptId, id(1), digest), receipt);
      assert.equal(reopened.claimCodexSetupOperation(id(1), digest).state, 'terminal');
      const bytes = await readFile(resolve(root, 'vault.sqlite'));
      assert.equal(bytes.includes(Buffer.from('synthetic_session')), false);
      assert.equal(bytes.includes(Buffer.from(value.membershipId)), false);
      assert.equal(bytes.includes(Buffer.from(leaseId)), false);
    } finally {reopened.close();}
  });
});

test('readiness requires the original running operation and exact digest/lease', async () => {
  await fixture(async (_root, _key, vault) => {
    const value = observation();
    assert.throws(() => vault.recordCodexSetupReadiness(id(10), digest, value), /setup_operation_conflict/);
    const leaseId = lease(vault);
    assert.throws(() => vault.recordCodexSetupReadiness(id(10), digest, value), /setup_operation_conflict/);
    assert.throws(() => vault.recordCodexSetupReadiness(leaseId, `sha256:${'b'.repeat(64)}`, value), /setup_operation_conflict/);
    vault.finishCodexSetupOperation(leaseId, digest, {state: 'unconfirmed', code: 'setup_execution_unconfirmed'});
    assert.throws(() => vault.recordCodexSetupReadiness(leaseId, digest, value), /setup_operation_conflict/);
  });
});

test('concurrent readiness retries cannot replace the first immutable observation', async () => {
  await fixture(async (root, key, vault) => {
    const leaseId = lease(vault), value = observation(), receipt = vault.recordCodexSetupReadiness(leaseId, digest, value);
    const second = await LocalVault.open({root, masterKey: key});
    try {
      assert.deepEqual(second.recordCodexSetupReadiness(leaseId, digest, value), receipt);
      assert.throws(() => second.recordCodexSetupReadiness(leaseId, digest, {...value, manifestHash: `sha256:${'b'.repeat(64)}`}),
        /setup_readiness_conflict/);
      assert.deepEqual(second.getCodexSetupReadiness(receipt.receiptId, id(1), digest), receipt);
    } finally {second.close();}
  });
});

test('foreign context, modified metadata and transplanted readiness ciphertext are rejected', async () => {
  await fixture(async (root, _key, vault) => {
    const leaseId = lease(vault), receipt = vault.recordCodexSetupReadiness(leaseId, digest, observation());
    assert.equal(vault.getCodexSetupReadiness(id(20), id(1), digest), null);
    assert.throws(() => vault.getCodexSetupReadiness(receipt.receiptId, id(20), digest), /setup_readiness_scope_mismatch/);
    assert.throws(() => vault.getCodexSetupReadiness(receipt.receiptId, id(1), `sha256:${'b'.repeat(64)}`), /setup_readiness_scope_mismatch/);
    const db = new DatabaseSync(resolve(root, 'vault.sqlite'));
    try {
      db.prepare('update codex_setup_readiness set observation_hash = ? where receipt_id = ?')
        .run(`sha256:${'b'.repeat(64)}`, receipt.receiptId);
      assert.throws(() => vault.getCodexSetupReadiness(receipt.receiptId, id(1), digest), /setup_readiness_integrity_failed/);
      db.prepare('update codex_setup_readiness set observation_hash = ?, receipt_id = ?, operation_id = ?')
        .run(receipt.observationHash, id(21), id(20));
      assert.throws(() => vault.getCodexSetupReadiness(id(21), id(20), digest), /setup_readiness_integrity_failed/);
    } finally {db.close();}
  });
});

test('wrong encryption key cannot disclose readiness observations', async () => {
  await fixture(async (root, _key, vault) => {
    const leaseId = lease(vault), receipt = vault.recordCodexSetupReadiness(leaseId, digest, observation());
    vault.close();
    const other = await LocalVault.open({root, masterKey: randomBytes(32)});
    try {assert.throws(() => other.getCodexSetupReadiness(receipt.receiptId, id(1), digest), /setup_readiness_integrity_failed/);}
    finally {other.close();}
  });
});

test('receipt parser rejects private fields, getters, proxies, invalid bounds and missing gates', () => {
  const value = observation(); let getters = 0;
  const getter = {...value}; Object.defineProperty(getter, 'membershipId', {get() {getters++; return id(2);}, enumerable: true});
  const changes: unknown[] = [{...value, token: 'private-canary'}, {...value, nativeSkillHash: null},
    {...value, relayPid: 0}, {...value, roleRevision: 0}, {...value, startupBackend: 'unavailable'},
    {...value, firstLearning: 'pending'}, {...value, cliVersion: '0.2.153\n'},
    {...value, organizationId: 'foreign'}, {...value, sessionId: '/private/home'},
    {...value, [Symbol('private')]: 'private-canary'}, getter, new Proxy(value, {ownKeys() {throw new Error('must_not_run');}})];
  for (const raw of changes) assert.throws(() => parseLocalCodexSetupReadiness(raw), /setup_readiness_invalid/);
  assert.equal(getters, 0);
  assert.equal(Object.isFrozen(parseLocalCodexSetupReadiness(value)), true);
});

test('stale, future and expired observations cannot be persisted', async () => {
  await fixture(async (_root, _key, vault) => {
    const leaseId = lease(vault), value = observation(), now = Date.now();
    for (const offset of [-70_000, 70_000]) {
      const time = now + offset;
      assert.throws(() => vault.recordCodexSetupReadiness(leaseId, digest, {...value,
        verifiedAt: new Date(time).toISOString(), relayPolledAt: new Date(time - 1000).toISOString(),
        expiresAt: new Date(time + 60_000).toISOString()}), /setup_readiness_stale/);
    }
    assert.throws(() => parseLocalCodexSetupReadiness({...value,
      relayPolledAt: new Date(now - 70_000).toISOString()}), /setup_readiness_invalid/);
    assert.throws(() => parseLocalCodexSetupReadiness({...value, expiresAt: value.verifiedAt}), /setup_readiness_invalid/);
  });
});

test('readiness write fails before storage when SQLite durability is not qualified', async t => {
  await fixture(async (_root, _key, vault) => {
    const leaseId = lease(vault), value = observation(), prepare = DatabaseSync.prototype.prepare;
    t.mock.method(DatabaseSync.prototype, 'prepare', function (this: DatabaseSync, sql: string) {
      if (sql === 'pragma synchronous') return {get: () => ({synchronous: 1})} as never;
      return prepare.call(this, sql);
    });
    assert.throws(() => vault.recordCodexSetupReadiness(leaseId, digest, value), /setup_operation_durability_unqualified/);
    t.mock.restoreAll();
    assert.equal(vault.recordCodexSetupReadiness(leaseId, digest, value).observation.operationId, id(1));
  });
});

test('scoped readiness snapshots inputs before asynchronous admission and denies withdrawal', async () => {
  await fixture(async (root, key, vault) => {
    const leaseId = lease(vault), value = observation(); let mutate = false, current = true;
    const scoped = await LocalVault.open({root, masterKey: key}, {signal: new AbortController().signal,
      current: async () => {if (mutate) {value.manifestHash = `sha256:${'b'.repeat(64)}`;} return current;}});
    try {
      mutate = true;
      const receipt = await scoped.recordCodexSetupReadiness(leaseId, digest, value);
      assert.equal(receipt.observation.manifestHash, digest);
      current = false;
      await assert.rejects(scoped.getCodexSetupReadiness(receipt.receiptId, id(1), digest), /vault_scope_unavailable/);
      await assert.rejects(scoped.recordCodexSetupReadiness(leaseId, digest, value), /vault_scope_unavailable/);
      assert.equal(vault.getCodexSetupReadiness(receipt.receiptId, id(1), digest)!.observation.manifestHash, digest);
    } finally {await scoped.close();}
  });
});
