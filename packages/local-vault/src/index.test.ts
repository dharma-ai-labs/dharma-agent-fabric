import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
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

test('environment keys fail closed unless explicitly enabled', () => {
  const value = randomBytes(32).toString('base64');
  assert.throws(() => loadExplicitTestKey({ DHARMA_VAULT_KEY: value }));
  assert.equal(loadExplicitTestKey({ DHARMA_ALLOW_ENV_KEY: '1', DHARMA_VAULT_KEY: value }).length, 32);
});
