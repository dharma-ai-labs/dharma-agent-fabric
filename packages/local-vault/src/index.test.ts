import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
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

test('environment keys fail closed unless explicitly enabled', () => {
  const value = randomBytes(32).toString('base64');
  assert.throws(() => loadExplicitTestKey({ DHARMA_VAULT_KEY: value }));
  assert.equal(loadExplicitTestKey({ DHARMA_ALLOW_ENV_KEY: '1', DHARMA_VAULT_KEY: value }).length, 32);
});
