import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import test from 'node:test';
import { canonicalize, sha256 } from '@dharma-ai-labs/agent-fabric-contracts';
import { prepareGuidedRouteContext } from './guidedRouteContext.js';

const id = (n: number) => `79000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const now = new Date('2026-10-19T14:15:00Z');
const pair = generateKeyPairSync('ed25519');
const expected = { hqOrigin: 'https://www.dharma-ai.io', organizationId: 'org_fixture', recipientMembershipId: id(1),
  roleRevision: 7, policyRevision: 'fixture-policy-3', bindingId: id(2), provider: 'codex', clientPlatform: 'linux',
  clientTransport: 'named_session', sessionId: 'fixture-named-session',
  sourceFingerprint: 'sha256:' + '1'.repeat(64), manifestHash: 'sha256:' + '2'.repeat(64), catalogHash: 'sha256:' + '3'.repeat(64),
  publicKeyEd25519: pair.publicKey.export({ format: 'jwk' }).x!, enrollmentDeviceId: null as string | null };
function signed(patch: Record<string, unknown> = {}) {
  const body = { schema: 'dharma.guided-route-context/v1', contextId: id(3), organizationId: expected.organizationId,
    recipientMembershipId: expected.recipientMembershipId, hqOrigin: expected.hqOrigin, membershipStatus: 'active',
    roleRevision: 7, roleName: 'Reviewer', policyRevision: 'fixture-policy-3', provider: 'codex', deviceId: null,
    clientPlatform: 'linux', clientTransport: 'named_session',
    sessionId: expected.sessionId, issuedAt: now.toISOString(), expiresAt: new Date(now.getTime() + 60000).toISOString(),
    allowedModes: ['source_connected', 'knowledge_only'], bindings: [{ id: id(2), sourceFingerprint: 'sha256:' + '1'.repeat(64),
      packageState: 'published', manifestHash: 'sha256:' + '2'.repeat(64), catalogHash: 'sha256:' + '3'.repeat(64) }], ...patch };
  return { ...body, signature: sign(null, Buffer.from(canonicalize(body)), pair.privateKey).toString('base64url') };
}
const prepare = (context: unknown, mode = 'source_connected', changes = {}) => prepareGuidedRouteContext({
  context, expected: { ...expected, ...changes }, mode, nodeVersion: '22.22.3', interactive: true, now,
});

test('a verified named-session source context produces only a no-effect route plan', async () => {
  const result = await prepare(signed());
  assert.equal(result.ok, true); assert.equal(result.stage, 'plan'); assert.equal(result.effects, false);
  assert.equal(result.ready, false); assert.equal(result.enrollmentStarted, false);
  assert.equal(result.nextAction, 'existing_source_connected_setup');
  assert.equal(result.organizationId, expected.organizationId); assert.equal(result.bindingId, id(2));
  assert.equal(result.contextHash, sha256(canonicalize(signed())));
});
test('knowledge-only requires the existing same-device enrollment, not a first-run fallback', async () => {
  assert.equal((await prepare(signed(), 'knowledge_only')).code, 'guided_route_enrollment_required');
  const result = await prepare(signed({ deviceId: id(8) }), 'knowledge_only', { enrollmentDeviceId: id(8) });
  assert.equal(result.nextAction, 'existing_enrolled_knowledge_join'); assert.equal(result.effects, false);
  assert.equal(result.requiresSourceCheckout, false); assert.equal(result.initializesEmptyGit, true);
});
test('local role labels cannot replace the signed effective revision or active recipient', async () => {
  for (const context of [signed({ roleRevision: 8 }), signed({ membershipStatus: 'inactive' }),
    signed({ recipientMembershipId: id(9) }), signed({ organizationId: 'org_foreign' }),
    signed({ policyRevision: 'foreign-policy' })]) {
    const result = await prepare(context); assert.equal(result.ok, false); assert.equal(result.effects, false);
  }
});
test('binding, publication, mode and current named session must agree before presenting a route', async () => {
  for (const context of [signed({ bindings: [] }), signed({ bindings: [{ id: id(9), packageState: 'published' }] }),
    signed({ bindings: [{ id: id(2), packageState: 'pending' }] }), signed({ allowedModes: ['knowledge_only'] }),
    signed({ sessionId: 'foreign-session' }), signed({ provider: 'claude' })]) {
    assert.equal((await prepare(context)).ok, false);
  }
});
test('expiry, invalid signatures and unsigned extra authority fail without echoing private input', async () => {
  const context = signed();
  for (const value of [null, signed({ expiresAt: now.toISOString() }), signed({ issuedAt: new Date(now.getTime() + 1).toISOString() }),
    { ...context, roleName: 'Owner' }, signed({ token: 'synthetic-never-echo' }), signed({ ready: true }),
    signed({ signature: 'synthetic-never-echo' })]) {
    const result = await prepare(value); assert.equal(result.ok, false); assert.equal(result.effects, false);
    assert.equal(JSON.stringify(result).includes('synthetic-never-echo'), false);
  }
});
test('the selected contract cannot claim another provider, noninteractive or unsupported runtime qualification', async () => {
  for (const patch of [{ interactive: false }, { nodeVersion: '25.0.0' }]) {
    const result = await prepareGuidedRouteContext({ context: signed(), expected, mode: 'source_connected',
      nodeVersion: '22.22.3', interactive: true, now, ...patch });
    assert.equal(result.ok, false); assert.equal(result.effects, false);
  }
  assert.equal((await prepare(signed(), 'source_connected', { provider: 'gemini' })).ok, false);
  assert.equal((await prepare(signed(), 'source_connected', { clientPlatform: 'darwin' })).ok, false);
  assert.equal((await prepare(signed(), 'source_connected', { clientTransport: 'desktop_chat' })).ok, false);
  assert.equal((await prepare(signed({ clientTransport: 'desktop_chat' }))).ok, false);
});
test('an already enrolled knowledge device and selected package hashes cannot be substituted', async () => {
  for (const changes of [{ enrollmentDeviceId: id(9) }, { sourceFingerprint: 'sha256:' + '9'.repeat(64) },
    { manifestHash: 'sha256:' + '9'.repeat(64) }, { catalogHash: 'sha256:' + '9'.repeat(64) }]) {
    assert.equal((await prepare(signed({ deviceId: id(8) }), 'knowledge_only', { enrollmentDeviceId: id(8), ...changes })).ok, false);
  }
});
test('a wrong pin, excessive lifetime or duplicate catalog identity cannot produce a route plan', async () => {
  const other = generateKeyPairSync('ed25519').publicKey.export({ format: 'jwk' }).x!;
  assert.equal((await prepare(signed(), 'source_connected', { publicKeyEd25519: other })).ok, false);
  assert.equal((await prepare(signed({ expiresAt: new Date(now.getTime() + 300001).toISOString() }))).ok, false);
  const context = signed();
  assert.equal((await prepare(signed({ bindings: [context.bindings[0], context.bindings[0]] }))).ok, false);
});
test('reusing a public context produces only another no-effect plan, never a consumed grant or ready receipt', async () => {
  const context = signed(), first = await prepare(context), second = await prepare(context);
  assert.equal(first.ok, true); assert.equal(second.ok, true); assert.notEqual(first.operationId, second.operationId);
  assert.equal(first.contextHash, second.contextHash);
  for (const result of [first, second]) {
    assert.equal(result.authorityVerified, false); assert.equal(result.enrollmentStarted, false);
    assert.equal(result.effects, false); assert.equal(result.ready, false);
  }
});
