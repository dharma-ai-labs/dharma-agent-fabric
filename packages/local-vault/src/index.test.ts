import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rename, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { canonicalize, sha256 } from '@dharma-ai-labs/agent-fabric-contracts';
import { LocalVault, loadExplicitTestKey, loadOrCreateVaultMasterKey } from './index.js';

test('vault encrypts content and verifies it on read', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dharma-vault-'));
  const vault = await LocalVault.open({ root, masterKey: randomBytes(32) });
  const secret = Buffer.from('test-secret-value', 'utf8');
  const contentId = await vault.putBlob(secret, 'provider-session');
  assert.deepEqual(await vault.getBlob(contentId), secret);
  const digest = contentId.slice('sha256:'.length);
  const stored = await readFile(join(root, 'blobs', digest.slice(0, 2), `${digest}.blob`));
  assert.equal(stored.includes(secret), false);
  vault.close();
});

test('vault streams large provider files without buffering the plaintext', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dharma-vault-'));
  const source = join(root, 'provider.jsonl');
  const plaintext = Buffer.alloc(4 * 1024 * 1024, 'x');
  await writeFile(source, plaintext);
  const vault = await LocalVault.open({ root: join(root, 'vault'), masterKey: randomBytes(32) });
  const stored = await vault.putFile(source, 'raw-provider-session');
  assert.equal(stored.bytes, plaintext.length);
  assert.deepEqual(await vault.getBlob(stored.contentId), plaintext);
  vault.close();
});

test('vault master key is generated once in the operating-system store', async () => {
  const values = new Map<string, string>();
  const store = {
    backend: 'linux-secret-service' as const,
    async get(account: string) { return values.get(account) ?? null; },
    async put(account: string, secret: string) { values.set(account, secret); },
    async delete(account: string) { values.delete(account); },
  };
  const first = await loadOrCreateVaultMasterKey(store);
  const second = await loadOrCreateVaultMasterKey(store);
  assert.equal(first.length, 32);
  assert.deepEqual(second, first);
});

test('vault accepts identical capsule retries and rejects revision drift', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dharma-vault-'));
  const vault = await LocalVault.open({ root, masterKey: randomBytes(32) });
  vault.recordCapsule('trajectory-1', 1, 'sha256:first', 'sha256:blob');
  assert.doesNotThrow(() => vault.recordCapsule('trajectory-1', 1, 'sha256:first', 'sha256:blob'));
  assert.throws(
    () => vault.recordCapsule('trajectory-1', 1, 'sha256:changed', 'sha256:other'),
    /revision hash conflict/,
  );
  vault.close();
});

test('vault resolves the latest capsule and records idempotent disclosure receipts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dharma-vault-'));
  const vault = await LocalVault.open({ root, masterKey: randomBytes(32) });
  const firstBlob = await vault.putBlob(Buffer.from(JSON.stringify({ revision: 1 })), 'trajectory-capsule');
  const secondBlob = await vault.putBlob(Buffer.from(JSON.stringify({ revision: 2 })), 'trajectory-capsule');
  vault.recordCapsule('trajectory-1', 1, `sha256:${'1'.repeat(64)}`, firstBlob);
  vault.recordCapsule('trajectory-1', 2, `sha256:${'2'.repeat(64)}`, secondBlob);
  assert.deepEqual(await vault.getLatestCapsule('trajectory-1'), { revision: 2 });
  assert.doesNotThrow(() => vault.recordDisclosure('response-1', `sha256:${'3'.repeat(64)}`, 42));
  assert.doesNotThrow(() => vault.recordDisclosure('response-1', `sha256:${'3'.repeat(64)}`, 42));
  vault.close();
});

test('failed capture commit rolls back session metadata and removes newly written blobs', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dharma-vault-capture-'));
  const vault = await LocalVault.open({ root, masterKey: randomBytes(32) });
  const raw = Buffer.from('first raw evidence');
  const rawContentId = `sha256:${createHash('sha256').update(raw).digest('hex')}`;
  await vault.commitCapture({
    raw: { plaintext: raw, kind: 'raw-provider-turn', expectedContentId: rawContentId },
    capsule: {
      plaintext: Buffer.from('{"revision":1}'), trajectoryId: 'trajectory-atomic', revision: 1,
      capsuleHash: `sha256:${'1'.repeat(64)}`,
    },
    session: {
      sessionId: 'session-atomic', provider: 'codex', workspaceId: 'workspace-atomic',
      sourceLocator: '/private/source', status: 'partial', observedAt: '2026-08-12T00:00:00.000Z',
    },
  });
  const before = vault.stats();
  const changedRaw = Buffer.from('changed raw evidence');
  const changedRawContentId = `sha256:${createHash('sha256').update(changedRaw).digest('hex')}`;
  await assert.rejects(() => vault.commitCapture({
    raw: { plaintext: changedRaw, kind: 'raw-provider-turn', expectedContentId: changedRawContentId },
    capsule: {
      plaintext: Buffer.from('{"revision":1,"changed":true}'), trajectoryId: 'trajectory-atomic', revision: 1,
      capsuleHash: `sha256:${'2'.repeat(64)}`,
    },
    session: {
      sessionId: 'session-atomic-changed', provider: 'codex', workspaceId: 'workspace-atomic',
      sourceLocator: '/private/changed', status: 'partial', observedAt: '2026-08-12T00:01:00.000Z',
    },
  }), /revision hash conflict/);
  assert.deepEqual(vault.stats(), before);
  await assert.rejects(() => vault.getBlob(changedRawContentId), /ENOENT/);
  vault.close();
});

test('vault expires raw evidence, retains capsule history, and queues an unavailable revision', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dharma-vault-retention-'));
  const vault = await LocalVault.open({ root, masterKey: randomBytes(32) });
  const rawContentId = await vault.putBlob(Buffer.from('expired raw provider evidence'), 'raw-provider-turn');
  const capsuleBase = {
    trajectoryId: 'trajectory-retention', revision: 1, previousRevisionHash: null,
    contentIndex: [{ contentId: rawContentId, kind: 'raw-provider-turn', bytes: 29, uploaded: false, availableLocally: true }],
    localEvidenceAvailable: [{ contentId: rawContentId, kind: 'raw-provider-turn', bytes: 29 }],
    createdAt: '2026-01-01T00:00:00.000Z',
  };
  const capsule = { ...capsuleBase, capsuleHash: sha256(canonicalize(capsuleBase)) };
  const capsuleContentId = await vault.putBlob(Buffer.from(JSON.stringify(capsule)), 'trajectory-capsule');
  vault.recordCapsule('trajectory-retention', 1, capsule.capsuleHash, capsuleContentId);

  const result = await vault.enforceRawEvidenceRetention({
    retentionDays: 30,
    now: new Date(Date.now() + 31 * 86_400_000),
  });

  assert.equal(result.deleted, 1);
  await assert.rejects(() => vault.getBlob(rawContentId), /ENOENT/);
  assert.deepEqual(await vault.getBlob(capsuleContentId), Buffer.from(JSON.stringify(capsule)));
  const latest = await vault.getLatestCapsule<Record<string, unknown>>('trajectory-retention');
  assert.equal(latest.revision, 2);
  assert.equal(latest.previousRevisionHash, capsule.capsuleHash);
  assert.deepEqual(latest.localEvidenceAvailable, []);
  assert.equal((latest.contentIndex as Array<{ availableLocally: boolean }>)[0]?.availableLocally, false);
  const pending = await vault.listPendingCapsuleSyncs<Record<string, unknown>>();
  assert.equal(pending.length, 1);
  assert.equal(pending[0]?.trajectoryId, 'trajectory-retention');
  assert.equal(pending[0]?.revision, 2);
  vault.discardPendingCapsuleSync('trajectory-retention', 2, 'authorization_revoked');
  assert.deepEqual(await vault.listPendingCapsuleSyncs(), []);
  const database = new DatabaseSync(join(root, 'vault.sqlite'), { readOnly: true });
  const failure = database.prepare(`
    select trajectory_id, revision, reason from capsule_sync_failures
    where trajectory_id = ? and revision = ?
  `).get('trajectory-retention', 2) as Record<string, unknown>;
  assert.deepEqual({ ...failure }, {
    trajectory_id: 'trajectory-retention', revision: 2, reason: 'authorization_revoked',
  });
  database.close();
  vault.close();
});

test('vault returns only the requested immutable capsule revision', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dharma-vault-revision-'));
  const vault = await LocalVault.open({ root, masterKey: randomBytes(32) });
  for (const revision of [1, 2]) {
    const value = { trajectoryId: 'trajectory-versioned', revision };
    const blobContentId = await vault.putBlob(Buffer.from(JSON.stringify(value)), 'trajectory-capsule');
    vault.recordCapsule('trajectory-versioned', revision, `sha256:${String(revision).repeat(64)}`, blobContentId);
  }
  assert.deepEqual(await vault.getCapsule('trajectory-versioned', 1), {
    trajectoryId: 'trajectory-versioned', revision: 1,
  });
  await assert.rejects(() => vault.getCapsule('trajectory-versioned', 3), /not available in the local vault/);
  await assert.rejects(() => vault.getCapsule('trajectory-versioned', 0), /positive integer/);
  vault.close();
});

test('raw retention drains every expired batch and creates lookup indexes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dharma-vault-retention-'));
  const vault = await LocalVault.open({ root, masterKey: randomBytes(32) });
  const rawIds = [];
  for (const value of ['expired one', 'expired two', 'expired three']) {
    rawIds.push(await vault.putBlob(Buffer.from(value), 'raw-provider-session'));
  }
  const result = await vault.enforceRawEvidenceRetention({
    retentionDays: 30,
    now: new Date(Date.now() + 31 * 86_400_000),
    limit: 1,
  });
  assert.deepEqual({ examined: result.examined, deleted: result.deleted }, { examined: 3, deleted: 3 });
  for (const contentId of rawIds) await assert.rejects(() => vault.getBlob(contentId), /ENOENT/);
  vault.close();

  const database = new DatabaseSync(join(root, 'vault.sqlite'), { readOnly: true });
  const indexes = database.prepare(`select name from sqlite_master where type = 'index'`).all()
    .map((row) => (row as { name: string }).name);
  assert.ok(indexes.includes('blobs_raw_retention_idx'));
  assert.ok(indexes.includes('capsules_blob_content_id_idx'));
  assert.ok(indexes.includes('capsules_latest_revision_idx'));
  assert.ok(indexes.includes('capsule_content_refs_lookup_idx'));
  database.close();
});

test('raw retention rejects invalid policy bounds', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dharma-vault-retention-'));
  const vault = await LocalVault.open({ root, masterKey: randomBytes(32) });
  await assert.rejects(() => vault.enforceRawEvidenceRetention({ retentionDays: 0 }), /between 1 and 3650 days/);
  await assert.rejects(() => vault.enforceRawEvidenceRetention({ limit: 10_001 }), /between 1 and 10000/);
  vault.close();
});

test('vault recovers interrupted retention quarantine before enforcing policy', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dharma-vault-retention-recovery-'));
  const key = randomBytes(32);
  const vault = await LocalVault.open({ root, masterKey: key });
  const contentId = await vault.putBlob(Buffer.from('retained after interrupted transaction'), 'raw-provider-turn');
  vault.close();
  const digest = contentId.slice('sha256:'.length);
  const original = join(root, 'blobs', digest.slice(0, 2), `${digest}.blob`);
  const quarantine = `${original}.expired-test`;
  await rename(original, quarantine);
  const reopened = await LocalVault.open({ root, masterKey: key, rawLocalDays: 3_650 });
  assert.deepEqual(await reopened.getBlob(contentId), Buffer.from('retained after interrupted transaction'));
  reopened.close();
});

test('environment keys fail closed unless explicitly enabled', () => {
  const value = randomBytes(32).toString('base64');
  assert.throws(() => loadExplicitTestKey({ DHARMA_VAULT_KEY: value }));
  assert.equal(loadExplicitTestKey({ DHARMA_ALLOW_ENV_KEY: '1', DHARMA_VAULT_KEY: value }).length, 32);
});
