import assert from 'node:assert/strict';
import { test } from 'node:test';
import { secureStoreInternals } from './index.js';

test('secure-store rejects unsafe account interpolation', async () => {
  const store = secureStoreInternals.windowsStore('does-not-run');
  await assert.rejects(() => store.get('bad; account'), /Invalid secure-store account/);
});

test('platform backends identify their security boundary', () => {
  assert.equal(secureStoreInternals.windowsStore().backend, 'windows-credential-manager');
  assert.equal(secureStoreInternals.linuxStore().backend, 'linux-secret-service');
  assert.equal(secureStoreInternals.macosStore().backend, 'macos-keychain');
});
