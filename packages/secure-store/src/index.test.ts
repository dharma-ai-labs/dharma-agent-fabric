import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

test('WSL launches Windows Credential Manager through the interop bridge', () => {
  assert.deepEqual(secureStoreInternals.windowsCommandSpec('linux'), {
    command: '/init',
    prefixArgs: ['/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe'],
    timeoutMs: 15_000,
    retryAttempts: 2,
  });
  assert.deepEqual(secureStoreInternals.windowsCommandSpec('win32'), {
    command: 'powershell.exe',
    prefixArgs: [],
    timeoutMs: 5_000,
    retryAttempts: 3,
  });
});

test('secure-store bounds a stalled subprocess', async () => {
  const result = await secureStoreInternals.run(
    process.execPath,
    ['-e', 'setTimeout(() => {}, 2_000)'],
    undefined,
    25,
  );
  assert.equal(result.code, null);
  assert.equal(result.timedOut, true);
  assert.match(result.stderr, /timed out after 25 ms/);
});

test('secure-store retries transient WSL interop failures', async () => {
  let calls = 0;
  const result = await secureStoreInternals.withTransientWindowsRetry(async () => {
    calls += 1;
    if (calls < 3) return { code: 1, stdout: '', stderr: 'UtilAcceptVsock: accept4 failed 110' };
    return { code: 0, stdout: 'ok', stderr: '' };
  }, { attempts: 3, delayMs: 0 });
  assert.equal(calls, 3);
  assert.deepEqual(result, { code: 0, stdout: 'ok', stderr: '' });
});

test('Windows store applies the selected timeout and retry profile', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dharma-secure-store-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const attemptsPath = join(root, 'attempts');
  const script = `require('node:fs').appendFileSync(${JSON.stringify(attemptsPath)}, 'x'); setTimeout(() => {}, 2_000)`;
  const store = secureStoreInternals.windowsStore(undefined, {
    command: process.execPath,
    prefixArgs: ['-e', script, '--'],
    timeoutMs: 250,
    retryAttempts: 2,
  });

  await assert.rejects(() => store.get('bounded-profile'), /timed out after 250 ms/);
  assert.equal(await readFile(attemptsPath, 'utf8'), 'xx');
});

test('secure-store does not retry permanent failures', async () => {
  let calls = 0;
  const result = await secureStoreInternals.withTransientWindowsRetry(async () => {
    calls += 1;
    return { code: 1, stdout: '', stderr: 'Access denied' };
  }, { attempts: 3, delayMs: 0 });
  assert.equal(calls, 1);
  assert.equal(result.code, 1);
});

test('process cache avoids repeated operating-system reads during a relay lifetime', async () => {
  let reads = 0;
  const values = new Map([['device-key', 'secret']]);
  const store = secureStoreInternals.processCachedStore({
    backend: 'windows-credential-manager',
    async get(account) {
      reads += 1;
      await new Promise((accept) => setTimeout(accept, 5));
      return values.get(account) ?? null;
    },
    async put(account, secret) { values.set(account, secret); },
    async delete(account) { values.delete(account); },
  });

  assert.deepEqual(await Promise.all([store.get('device-key'), store.get('device-key')]), ['secret', 'secret']);
  assert.equal(await store.get('device-key'), 'secret');
  assert.equal(reads, 1);

  await store.put('device-key', 'rotated');
  assert.equal(await store.get('device-key'), 'rotated');
  assert.equal(reads, 1);

  await store.delete('device-key');
  assert.equal(await store.get('device-key'), null);
  assert.equal(reads, 2);
});
