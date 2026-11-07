import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { RELAY_OPEN_FAILURE_CODES, relayOpenFailureRemedy } from './relayOpenFailure.js';

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
    for (const code of [...RELAY_OPEN_FAILURE_CODES, 'connection_anchor_lock_unavailable']) {
      assert.match(relayOpenFailureRemedy(code, platform) ?? '', /^[^\n]{1,200}$/, `${code} ${platform}`);
    }
    for (const code of ['connection_anchor_busy', 'repository_relay_failed', undefined, 7, 'C:/Users/someone/.secret']) {
      assert.equal(relayOpenFailureRemedy(code, platform), undefined);
    }
  }
});

test('the relay guide names every open failure code and the Windows password reset loss', async () => {
  const guide = (await readFile(new URL('../../../docs/03-local-relay-and-vault.md', import.meta.url), 'utf8')).replace(/\s+/g, ' ');
  for (const code of [...RELAY_OPEN_FAILURE_CODES, 'connection_anchor_lock_unavailable']) assert.ok(guide.includes(`\`${code}\``), code);
  assert.match(guide, /Registration or a preserved profile path alone does not prove protected-store recovery[^.]*\. An administrator reset of a local Windows account's password, including a cloud console password reset[^.]*, makes the stored device credentials unrecoverable[^.]*\. Users must change their own password instead/);
});
