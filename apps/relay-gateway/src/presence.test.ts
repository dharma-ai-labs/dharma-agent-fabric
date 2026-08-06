import assert from 'node:assert/strict';
import { test } from 'node:test';
import { relayPresenceConfig, withTimeout } from './presence.js';

test('mandatory relay presence fails closed without Redis', () => {
  assert.throws(() => relayPresenceConfig({ AGENT_FABRIC_PRESENCE_REQUIRED: 'true' }), /REDIS_HOST/);
  assert.throws(() => relayPresenceConfig({
    AGENT_FABRIC_PRESENCE_REQUIRED: 'true', REDIS_HOST: '10.0.0.2', REDIS_TLS: 'true',
  }), /REDIS_CA_CERT/);
});

test('optional local relay can run without a presence service', () => {
  assert.deepEqual(relayPresenceConfig({}), { required: false, host: null, port: 6379, tls: false, ca: null });
});

test('presence operations fail closed within their deadline', async () => {
  await assert.rejects(
    withTimeout(new Promise(() => undefined), 5, 'presence_touch_timeout'),
    /presence_touch_timeout/,
  );
});
