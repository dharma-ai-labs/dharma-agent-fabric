import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { secureStoreInternals } from './index.js';

test('container markers use only bounded regular-file metadata, not their contents', async () => {
  const paths: string[] = [];
  assert.equal(await secureStoreInternals.hasContainerMarker(async path => {
    paths.push(path);
    return { isFile: () => true, isSymbolicLink: () => path === '/.dockerenv' };
  }), true);
  assert.deepEqual(paths, ['/.dockerenv', '/run/.containerenv']);
  assert.equal(await secureStoreInternals.hasContainerMarker(async () => {
    throw Object.assign(new Error('absent'), { code: 'ENOENT' });
  }), false);
});

test('denied container-marker metadata fails closed without leaking the underlying error', async () => {
  await assert.rejects(() => secureStoreInternals.hasContainerMarker(async () => {
    throw Object.assign(new Error('synthetic-sensitive-detail'), { code: 'EACCES' });
  }), { message: 'Secure-store container boundary could not be determined.' });
});

test('WSL-kernel containers select Linux storage without invoking the host Windows bridge', async () => {
  assert.equal(await secureStoreInternals.isWsl({ platform: 'linux',
    readKernel: async () => 'Linux 6.18.33.2-microsoft-standard-WSL2',
    containerMarker: async () => true }), false);
});

test('genuine WSL retains Windows protection even when interop may be unavailable', async () => {
  assert.equal(await secureStoreInternals.isWsl({ platform: 'linux',
    readKernel: async () => 'Linux 6.18.33.2-microsoft-standard-WSL2',
    containerMarker: async () => false }), true);
});

test('ordinary Linux and Windows do not need a container boundary probe', async () => {
  const unexpectedProbe = async () => { throw new Error('unexpected container probe'); };
  assert.equal(await secureStoreInternals.isWsl({ platform: 'linux',
    readKernel: async () => 'Linux 6.8.0-generic', containerMarker: unexpectedProbe }), false);
  assert.equal(await secureStoreInternals.isWsl({ platform: 'win32',
    readKernel: async () => { throw new Error('unexpected kernel read'); },
    containerMarker: unexpectedProbe }), false);
});

test('uncertain WSL container boundary fails closed without selecting another store', async () => {
  await assert.rejects(() => secureStoreInternals.isWsl({ platform: 'linux',
    readKernel: async () => 'microsoft-standard-WSL2',
    containerMarker: async () => { throw new Error('boundary unavailable'); } }), /boundary unavailable/);
});

test('secure-store rejects unsafe account interpolation', async () => {
  const store = secureStoreInternals.windowsStore('does-not-run');
  await assert.rejects(() => store.get('bad; account'), /Invalid secure-store account/);
});

test('platform backends identify their security boundary', () => {
  assert.equal(secureStoreInternals.windowsStore().backend, 'windows-credential-manager');
  assert.equal(secureStoreInternals.linuxStore().backend, 'linux-secret-service');
  assert.equal(secureStoreInternals.macosStore().backend, 'macos-keychain');
});

test('Windows fresh reads reuse the helper but never cache a credential', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dharma-fresh-read-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const counter = join(root, 'starts');
  const valuePath = join(root, 'value');
  await writeFile(valuePath, 'original');
  const bridge = `
    const fs = require('node:fs');
    fs.appendFileSync(${JSON.stringify(counter)}, 'x');
    const valuePath = ${JSON.stringify(valuePath)};
    const value = () => fs.existsSync(valuePath) ? fs.readFileSync(valuePath, 'utf8') : null;
    let received = false;
    const lines = require('node:readline').createInterface({input: process.stdin});
    lines.on('line', raw => {
      received = true;
      const request = JSON.parse(raw);
      const current = value();
      process.stdout.write(JSON.stringify({id: request.id, status: current === null ? 3 : 0, value: current}) + '\\n');
    });
    lines.on('close', () => {
      if (!received) { const current = value(); if (current === null) process.exitCode = 3;
        else process.stdout.write(current); }
    });
  `;
  const spec = { command: process.execPath, prefixArgs: ['-e', bridge, '--'],
    timeoutMs: 2_500, retryAttempts: 1, freshReadBroker: true };
  const store = secureStoreInternals.processCachedStore(secureStoreInternals.windowsStore(undefined, spec));
  assert.equal(await store.getFresh!('fresh-fixture'), 'original');
  await writeFile(valuePath, 'rotated\n"quoted"');
  assert.equal(await store.getFresh!('fresh-fixture'), 'rotated\n"quoted"');
  await rm(valuePath);
  assert.equal(await store.getFresh!('fresh-fixture'), null);
  assert.equal(await store.get('fresh-fixture'), null);
  assert.equal(await readFile(counter, 'utf8'), 'x');
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

test('fresh reads reconcile an authorization changed by another process', async () => {
  let current = 'bundle-a';
  let reads = 0;
  const store = secureStoreInternals.processCachedStore({
    backend: 'windows-credential-manager',
    async get() { reads += 1; return current; },
    async put(_account, secret) { current = secret; },
    async delete() { current = ''; },
  });

  assert.equal(await store.get('active-skill'), 'bundle-a');
  current = 'bundle-b';
  assert.equal(await store.get('active-skill'), 'bundle-a');
  assert.equal(await store.getFresh?.('active-skill'), 'bundle-b');
  assert.equal(await store.get('active-skill'), 'bundle-b');
  assert.equal(reads, 2);
});
