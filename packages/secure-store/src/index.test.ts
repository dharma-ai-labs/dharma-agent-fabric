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

test('secure-store does not retry permanent failures', async () => {
  let calls = 0;
  const result = await secureStoreInternals.withTransientWindowsRetry(async () => {
    calls += 1;
    return { code: 1, stdout: '', stderr: 'Access denied' };
  }, { attempts: 3, delayMs: 0 });
  assert.equal(calls, 1);
  assert.equal(result.code, 1);
});
