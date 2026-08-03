import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import test from 'node:test';
import { canonicalize, signCanonicalObject, signEnvelope, verifyCanonicalObject, verifyEnvelope } from './index.js';

test('canonicalize sorts nested object keys but preserves arrays', () => {
  assert.equal(canonicalize({ z: 1, a: { d: 2, b: [3, 1] } }), '{"a":{"b":[3,1],"d":2},"z":1}');
});

test('canonical object signatures do not depend on object key order', () => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const signature = signCanonicalObject({ second: 2, first: 1 }, privateKey);
  assert.equal(verifyCanonicalObject({ first: 1, second: 2 }, signature, publicKey), true);
  assert.equal(verifyCanonicalObject({ first: 1, second: 3 }, signature, publicKey), false);
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
