import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { RELAY_OPEN_FAILURE_CODES, relayOpenFailureRemedy, relayOpenFailureRemedyForHost as forHost } from './relayOpenFailure.js';

const windows = 'Device credentials cannot be read. If the Windows password was reset by an administrator, '
  + 'restore the previous password or re-enroll this device.';

test('Windows names the administrator password reset for an unreadable device identity or store', () => {
  for (const code of ['connection_identity_requires_recovery', 'connection_identity_store_unavailable']) {
    assert.equal(relayOpenFailureRemedy(code, 'win32'), windows);
    for (const platform of ['linux', 'darwin'] as const) {
      const remedy = relayOpenFailureRemedy(code, platform);
      assert.ok(remedy && !/Windows/.test(remedy), `${code} ${platform}`);
    }
  }
});

test('every open failure code has one bounded line and other codes have none', () => {
  for (const platform of ['win32', 'linux', 'darwin'] as const) {
    for (const code of [...RELAY_OPEN_FAILURE_CODES, 'connection_anchor_lock_unavailable', 'connection_anchor_lock_invalid']) {
      assert.match(relayOpenFailureRemedy(code, platform) ?? '', /^[^\n]{1,200}$/, `${code} ${platform}`);
    }
    for (const code of ['connection_anchor_busy', 'repository_relay_failed', undefined, 7, 'C:/Users/someone/.secret']) {
      assert.equal(relayOpenFailureRemedy(code, platform), undefined);
    }
  }
});

test('the relay guide names every open failure code and the Windows password reset loss', async () => {
  const guide = (await readFile(new URL('../../../docs/03-local-relay-and-vault.md', import.meta.url), 'utf8')).replace(/\s+/g, ' ');
  for (const code of [...RELAY_OPEN_FAILURE_CODES, 'connection_anchor_lock_unavailable', 'connection_anchor_lock_invalid']) {
    assert.ok(guide.includes(`\`${code}\``), code);
  }
  assert.match(guide, /Registration or a preserved profile path alone does not prove protected-store recovery[^.]*\. An administrator reset of a local Windows account's password, including a cloud console password reset[^.]*, makes the stored device credentials unrecoverable[^.]*\. Users must change their own password instead/);
});

test('the remedy follows the credential store backend, so WSL gets the Windows password reset text', async () => {
  let opened = 0;
  const store = (backend: 'windows-credential-manager' | 'macos-keychain' | 'linux-secret-service') =>
    async () => { opened++; return { backend }; };
  for (const code of ['connection_identity_requires_recovery', 'connection_identity_store_unavailable']) {
    // A Linux process on WSL uses the Windows vault through the interop bridge.
    assert.equal(await forHost(code, store('windows-credential-manager')), windows);
    for (const backend of ['linux-secret-service', 'macos-keychain'] as const) {
      const remedy = await forHost(code, store(backend));
      assert.ok(remedy && !/Windows/.test(remedy), `${code} ${backend}`);
    }
  }
  assert.equal(await forHost('connection_identity_store_busy', store('windows-credential-manager')),
    relayOpenFailureRemedy('connection_identity_store_busy', 'win32'));
  const before = opened;
  assert.equal(await forHost('repository_relay_failed', store('windows-credential-manager')), undefined);
  assert.equal(opened, before, 'a code without a remedy never opens the store');
  assert.equal(await forHost('connection_identity_requires_recovery', async () => { throw Error('no store'); }),
    relayOpenFailureRemedy('connection_identity_requires_recovery', process.platform));
});

// #484: a host crash left the signing-control lock torn, and status named the code with no next step.
// The relay never reclaims such a lock, so the remedy asks for owner-scoped reconciliation and grants nothing else.
const LOCK_INVALID_REMEDY = 'A device lock needs owner-scoped reconciliation. Stop the Dharma relay and have the device owner '
  + 'inspect the dharma-signing-controls-* or dharma-enrollment-locks-* lock, or contact support.';

test('an invalid device lock asks for owner reconciliation and never permits a destructive step', () => {
  for (const platform of ['win32', 'linux', 'darwin'] as const) {
    assert.equal(relayOpenFailureRemedy('connection_anchor_lock_invalid', platform), LOCK_INVALID_REMEDY, platform);
  }
  assert.match(LOCK_INVALID_REMEDY, /^[^\n]{1,200}$/);
  assert.doesNotMatch(LOCK_INVALID_REMEDY, /delete|remov|move|renam|renew|re-?enroll|login|sync|replay|retry/i);
});

test('the relay guide gives the same lock remedy and says the relay never reclaims the lock', async () => {
  const guide = (await readFile(new URL('../../../docs/03-local-relay-and-vault.md', import.meta.url), 'utf8')).replace(/\s+/g, ' ');
  assert.ok(guide.includes(LOCK_INVALID_REMEDY));
  assert.match(guide, /never deletes, renames or retries such a lock on its own/);
});

test('the lock remedy never opens the credential store', async () => {
  let opened = 0;
  const windowsStore = async () => { opened++; return { backend: 'windows-credential-manager' as const }; };
  assert.equal(await forHost('connection_anchor_lock_invalid', windowsStore), LOCK_INVALID_REMEDY);
  assert.equal(opened, 0, 'the lock remedy never opens the credential store');
});
