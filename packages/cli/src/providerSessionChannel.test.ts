import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import test from 'node:test';
import { signCanonicalObject, type SessionBindingScope } from '@dharma-ai-labs/agent-fabric-contracts';
import { createProviderSessionChannel } from './providerSessionChannel.js';

const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const uuid = (last: number) => `40000000-0000-4000-8000-${String(last).padStart(12, '0')}`;
const now = new Date('2026-09-26T05:00:00.000Z');
const scope: SessionBindingScope = {
  organizationId: 'org_test', repositoryBindingId: uuid(1), workspaceId: uuid(2), endpointId: uuid(3),
  membershipId: uuid(4), deviceId: uuid(5), bindingId: uuid(6), provider: 'codex',
  expiresAt: '2026-09-26T06:00:00.000Z', maximumProviderCostCents: 25,
};
function offer(change: Record<string, unknown> = {}) {
  const unsigned = {
    schema: 'dharma.session-question/v1', questionId: uuid(10), taskId: uuid(11),
    organizationId: scope.organizationId, repositoryBindingId: scope.repositoryBindingId,
    source: { workspaceId: uuid(12), endpointId: uuid(13), membershipId: uuid(14), deviceId: uuid(15) },
    target: { workspaceId: scope.workspaceId, endpointId: scope.endpointId, membershipId: scope.membershipId,
      deviceId: scope.deviceId, bindingId: scope.bindingId, provider: scope.provider },
    category: 'architecture', question: 'Which signed catalog applies?',
    authority: { mode: 'read_only', readPaths: ['.'], network: 'deny', maximumProviderCostCents: 25 },
    createdAt: now.toISOString(), expiresAt: '2026-09-26T05:15:00.000Z', nonce: uuid(16),
    signerKeyVersion: 'projects/test/locations/global/keyRings/af/cryptoKeys/questions/cryptoKeyVersions/1',
    ...change,
  };
  return { ...unsigned, signature: signCanonicalObject(unsigned, privateKey) };
}
function fixture() {
  let held = true, time = now, responseOverride: unknown;
  const calls: Array<{ route: string; body: Record<string, unknown> }> = [];
  let afterSend: (() => void) | undefined;
  const transport = { async signedPost(route: string, input: unknown) {
    const body = input as Record<string, unknown>;
    calls.push({ route, body }); afterSend?.();
    if (responseOverride instanceof Error) throw responseOverride;
    if (responseOverride) return responseOverride as Record<string, unknown>;
    if (route.endsWith('provider-sessions')) return { ok: true, organizationId: scope.organizationId, correlationId: uuid(90),
      registration: { bindingId: scope.bindingId, workspaceId: scope.workspaceId, endpointId: scope.endpointId,
        repositoryBindingId: scope.repositoryBindingId, membershipId: scope.membershipId, deviceId: scope.deviceId,
        provider: 'codex', mode: 'bridge_owned', revision: Number(body.expectedRevision) + 1,
        state: body.action === 'detach' ? 'detached' : 'attached', leaseUntil: '2026-09-26T05:01:00.000Z', replay: false } };
    const result = body.action === 'inbox' ? { offers: [offer()] } : {
      questionId: body.questionId || uuid(10), taskId: uuid(11), targetBindingId: body.targetBindingId || scope.bindingId,
      state: body.action === 'accept' ? 'accepted' : body.action === 'reply' ? body.outcome : 'queued', replay: false,
    };
    return { ok: true, organizationId: scope.organizationId, result, correlationId: uuid(90) };
  } };
  const channel = createProviderSessionChannel({ transport, scope, mode: 'bridge_owned', expectedRevision: 0,
    assertOwner: async () => held, now: () => time,
    verifier: { resolvePublicKey: () => publicKey }, authorizeContent: async () => true });
  return { channel, calls, setHeld: (value: boolean) => { held = value; },
    setTime: (value: Date) => { time = value; }, setResponse: (value: unknown) => { responseOverride = value; },
    onSend: (fn: () => void) => { afterSend = fn; } };
}

test('registration, heartbeat and detach preserve scope and CAS without transmitting a chat locator', async () => {
  const f = fixture();
  const attached = await f.channel.attach();
  assert.equal(attached.revision, 1); assert.equal(attached.correlationId, uuid(90));
  assert.equal((await f.channel.heartbeat()).revision, 2);
  assert.equal((await f.channel.detach()).state, 'detached');
  assert.deepEqual(f.calls.map(call => call.body.expectedRevision), [0, 1, 2]);
  assert.ok(f.calls.every(call => !('sessionId' in call.body) && !('workspaceRoot' in call.body)));
  await assert.rejects(f.channel.attach(), /provider_session_channel_closed/);
});
test('inbox verifies signed offers and acceptance is not an answer', async () => {
  const f = fixture(); await f.channel.attach();
  const incoming = await f.channel.inbox(); assert.equal(incoming[0]?.target.bindingId, scope.bindingId);
  assert.equal((await f.channel.accept(uuid(10), uuid(11))).state, 'accepted');
  assert.equal((await f.channel.reply({ questionId: uuid(10), taskId: uuid(11), outcome: 'answered',
    answer: 'Use the canonical catalog.\nPreserve its references.', failureCode: null })).state, 'answered');
});
test('questions are directed to an explicit binding with a bounded cost ceiling', async () => {
  const f = fixture(); await f.channel.attach();
  const result = await f.channel.ask({ targetBindingId: uuid(20), taskId: uuid(11), category: 'architecture',
    question: 'Which catalog applies?', maximumProviderCostCents: 10 });
  assert.equal(result.state, 'queued'); assert.equal(result.targetBindingId, uuid(20));
  await assert.rejects(f.channel.ask({ targetBindingId: scope.bindingId, taskId: uuid(11), category: 'architecture',
    question: 'Which catalog applies?', maximumProviderCostCents: 26 }), /provider_session_channel_input/);
});
test('unattached, expired and detached presence cannot be described as available', async () => {
  const f = fixture(); await assert.rejects(f.channel.inbox(), /provider_session_channel_unavailable/);
  await f.channel.attach(); f.setTime(new Date('2026-09-26T05:01:01.000Z'));
  await assert.rejects(f.channel.inbox(), /provider_session_channel_unavailable/);
  await assert.rejects(f.channel.heartbeat(), /provider_session_channel_unavailable/);
});
test('revocation before and after a network wait stops use of the same channel', async () => {
  const before = fixture(); before.setHeld(false);
  await assert.rejects(before.channel.attach(), /provider_session_channel_owner_lost/); assert.equal(before.calls.length, 0);
  const after = fixture(); after.onSend(() => after.setHeld(false));
  await assert.rejects(after.channel.attach(), /provider_session_channel_owner_lost/);
  after.setHeld(true); await assert.rejects(after.channel.attach(), /provider_session_channel_closed/);
});
test('foreign identity, stale revision and unexpected response fields fail closed', async () => {
  for (const key of ['membershipId', 'deviceId', 'bindingId', 'repositoryBindingId', 'revision', 'extra']) {
    const f = fixture();
    f.setResponse({ ok: true, organizationId: scope.organizationId, correlationId: uuid(90), registration: {
      bindingId: scope.bindingId, workspaceId: scope.workspaceId, endpointId: scope.endpointId,
      repositoryBindingId: scope.repositoryBindingId, membershipId: scope.membershipId, deviceId: scope.deviceId,
      provider: 'codex', mode: 'bridge_owned', revision: 1, state: 'attached',
      leaseUntil: '2026-09-26T05:01:00.000Z', replay: false, [key]: key === 'revision' ? 4 : uuid(50),
    } });
    await assert.rejects(f.channel.attach(), /provider_session_channel_response/);
  }
});
test('foreign, expired, unsigned and duplicate inbox offers never become consumable', async () => {
  for (const offers of [[offer({ organizationId: 'org_foreign' })], [{ ...offer(), signature: 'bad' }],
    [offer({ expiresAt: '2026-09-26T04:59:00.000Z' })], [offer(), offer()]]) {
    const f = fixture(); await f.channel.attach();
    f.setResponse({ ok: true, organizationId: scope.organizationId, result: { offers }, correlationId: uuid(90) });
    await assert.rejects(f.channel.inbox(), /provider_session_channel_response/);
    assert.equal(f.calls.filter(call => call.body.action === 'accept').length, 0);
  }
});
test('ambiguous network delivery disables further operations instead of executing or retargeting', async () => {
  const f = fixture(); await f.channel.attach(); f.setResponse(new Error('socket-lost'));
  await assert.rejects(f.channel.accept(uuid(10), uuid(11)), /provider_session_channel_uncertain/);
  await assert.rejects(f.channel.inbox(), /provider_session_channel_closed/);
  assert.equal(f.calls.length, 2);
});
test('completed reads require an immutable receipt and a valid answer/failure distinction', async () => {
  const f = fixture(); await f.channel.attach();
  const result = { questionId: uuid(10), taskId: uuid(11), targetBindingId: uuid(20), state: 'answered',
    answer: 'The canonical catalog applies.', failureCode: null, replyReceiptHash: `sha256:${'a'.repeat(64)}` };
  f.setResponse({ ok: true, organizationId: scope.organizationId, result, correlationId: uuid(90) });
  assert.equal((await f.channel.read(uuid(10), uuid(11), uuid(20))).answer, result.answer);
  const bad = fixture(); await bad.channel.attach();
  bad.setResponse({ ok: true, organizationId: scope.organizationId, result: { ...result, replyReceiptHash: null }, correlationId: uuid(90) });
  await assert.rejects(bad.channel.read(uuid(10), uuid(11), uuid(20)), /provider_session_channel_response/);
});
test('content secrets and oversize inputs are rejected before transport', async () => {
  const f = fixture(); await f.channel.attach();
  for (const question of ['x'.repeat(2001), 'Bearer secret-secret-secret', 'Read\u0000this', 'é'.repeat(1700)]) {
    await assert.rejects(f.channel.ask({ targetBindingId: uuid(20), taskId: uuid(11), category: 'architecture', question,
      maximumProviderCostCents: 0 }), /provider_session_channel_input/);
  }
  assert.equal(f.calls.length, 1);
});

test('hostile responses and identifiers cannot invoke getters or coercion hooks', async () => {
  const f = fixture(); let invoked = 0;
  const hostile = { toString() { invoked += 1; return uuid(20); } };
  await assert.rejects(f.channel.ask({ targetBindingId: hostile as unknown as string, taskId: uuid(11),
    category: 'architecture', question: 'Which catalog?', maximumProviderCostCents: 0 }), /provider_session_channel_input/);
  const response = { ok: true, organizationId: scope.organizationId, correlationId: uuid(90) };
  Object.defineProperty(response, 'registration', { enumerable: true, get() { invoked += 1; return {}; } });
  f.setResponse(response);
  await assert.rejects(f.channel.attach(), /provider_session_channel_response/);
  assert.equal(invoked, 0);
});

test('malformed inbox disables the channel and never implicitly consumes another offer', async () => {
  const f = fixture(); await f.channel.attach();
  f.setResponse({ ok: true, organizationId: scope.organizationId, correlationId: uuid(90),
    result: { offers: [offer({ question: 'Bearer private-private-private' })] } });
  await assert.rejects(f.channel.inbox(), /provider_session_channel_response/);
  await assert.rejects(f.channel.inbox(), /provider_session_channel_closed/);
});

test('a lease that expires during acceptance cannot authorize a provider turn', async () => {
  const f = fixture(); await f.channel.attach();
  f.onSend(() => f.setTime(new Date('2026-09-26T05:01:01.000Z')));
  await assert.rejects(f.channel.accept(uuid(10), uuid(11)), /provider_session_channel_unavailable/);
});
