import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { LocalVault, loadExplicitTestKey } from './index.js';

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

test('environment keys fail closed unless explicitly enabled', () => {
  const value = randomBytes(32).toString('base64');
  assert.throws(() => loadExplicitTestKey({ DHARMA_VAULT_KEY: value }));
  assert.equal(loadExplicitTestKey({ DHARMA_ALLOW_ENV_KEY: '1', DHARMA_VAULT_KEY: value }).length, 32);
});
