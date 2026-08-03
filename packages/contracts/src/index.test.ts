import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import test from 'node:test';
import { canonicalize, signEnvelope, verifyEnvelope } from './index.js';

test('canonicalize sorts nested object keys but preserves arrays', () => {
  assert.equal(canonicalize({ z: 1, a: { d: 2, b: [3, 1] } }), '{"a":{"b":[3,1],"d":2},"z":1}');
});

test('signed envelopes verify and expire deterministically', () => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const now = new Date('2026-08-03T20:00:00.000Z');
  const signed = signEnvelope({
    schema: 'dharma.protocol-envelope/v1',
    messageId: randomUUID(),
    organizationId: 'org_test',
    deviceId: 'device_test',
    sessionId: 'session_test',
    sentAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + 60_000).toISOString(),
    sequence: 1,
    nonce: 'nonce',
    type: 'Heartbeat',
    payload: { status: 'online' },
  }, privateKey);

  assert.deepEqual(verifyEnvelope(signed, publicKey, now), { ok: true });
  assert.deepEqual(verifyEnvelope(signed, publicKey, new Date(now.getTime() + 60_001)), {
    ok: false,
    reason: 'expired',
  });
});
