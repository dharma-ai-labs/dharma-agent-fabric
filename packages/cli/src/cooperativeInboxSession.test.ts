import assert from 'node:assert/strict';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { signCanonicalObject } from '@dharma-ai-labs/agent-fabric-contracts';
import { LocalVault, type LocalProviderSessionBinding } from '@dharma-ai-labs/agent-fabric-local-vault';
import { openCooperativeInboxSession } from './cooperativeInboxSession.js';
import { openCodexBoundSession } from './codexBoundSession.js';
import { openCooperativeInboxSession as publicConsumer } from './index.js';

const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const uuid = (last: number) => `50000000-0000-4000-8000-${String(last).padStart(12, '0')}`;

test('the owning runtime may import the cooperative consumer through the public package surface', () => {
  assert.equal(publicConsumer, openCooperativeInboxSession);
});

async function fixture(owner: 'cooperative_session' | 'dharma_bridge' = 'cooperative_session') {
  const root = await mkdtemp(join(tmpdir(), 'dharma-cooperative-'));
  const masterKey = randomBytes(32), now = new Date();
  const binding: LocalProviderSessionBinding = {
    schema: 'dharma.local-provider-session-binding/v1', owner,
    organizationId: 'org_test', repositoryBindingId: uuid(1), workspaceId: uuid(2), endpointId: uuid(3),
    membershipId: uuid(4), deviceId: uuid(5), bindingId: uuid(6), provider: 'codex', sessionId: uuid(7),
    workspaceRoot: resolve(root, 'repo'), createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + 3600000).toISOString(), maximumProviderCostCents: 25,
  };
  const identity = { organizationId: binding.organizationId, repositoryBindingId: binding.repositoryBindingId,
    workspaceId: binding.workspaceId, endpointId: binding.endpointId, membershipId: binding.membershipId,
    deviceId: binding.deviceId, provider: binding.provider };
  const vault = await LocalVault.open({ root, masterKey }); vault.saveProviderSessionBinding(binding);
  let context: { provider: 'codex'; sessionId: string; workspaceRoot: string; active: boolean } | null = {
    provider: 'codex', sessionId: binding.sessionId, workspaceRoot: binding.workspaceRoot, active: true,
  };
  const unsigned = { schema: 'dharma.session-question/v1', questionId: uuid(10), taskId: uuid(11),
    organizationId: binding.organizationId, repositoryBindingId: binding.repositoryBindingId,
    source: { workspaceId: uuid(12), endpointId: uuid(13), membershipId: uuid(14), deviceId: uuid(15) },
    target: { workspaceId: binding.workspaceId, endpointId: binding.endpointId, membershipId: binding.membershipId,
      deviceId: binding.deviceId, bindingId: binding.bindingId, provider: 'codex' },
    category: 'architecture', question: 'Which signed catalog applies?',
    authority: { mode: 'read_only', readPaths: ['.'], network: 'deny', maximumProviderCostCents: 25 },
    createdAt: now.toISOString(), expiresAt: new Date(now.getTime() + 60000).toISOString(),
    nonce: uuid(16), signerKeyVersion: 'test-key',
  };
  const question = { ...unsigned, signature: signCanonicalObject(unsigned, privateKey) };
  const actions: string[] = [], used = new Set<string>();
  let state = 'queued', answer: string | null = null, revision = 0, fail: string | null = null;
  let after: ((action: string) => void) | undefined, disclosed = true, reserved = true;
  const transport = { async signedPost(route: string, payload: unknown) {
    const body = payload as Record<string, unknown>, action = String(body.action);
    actions.push(action); after?.(action);
    if (fail === action) throw new Error('synthetic acknowledgement lost');
    const envelope = { ok: true, organizationId: binding.organizationId, correlationId: uuid(90) };
    if (route.endsWith('provider-sessions')) {
      if (action !== 'inspect') revision++;
      return { ...envelope, registration: revision === 0 ? null : {
        bindingId: binding.bindingId, workspaceId: binding.workspaceId, endpointId: binding.endpointId,
        repositoryBindingId: binding.repositoryBindingId, membershipId: binding.membershipId,
        deviceId: binding.deviceId, provider: 'codex', mode: 'cooperative', revision,
        state: action === 'detach' ? 'detached' : 'attached',
        leaseUntil: new Date(Date.now() + 60000).toISOString(), replay: false,
      } };
    }
    if (action === 'inbox') return { ...envelope, result: { offers: state === 'queued' ? [question] : [] } };
    if (action === 'accept') state = 'accepted';
    if (action === 'reply') { state = String(body.outcome); answer = state === 'answered' ? String(body.answer) : null; }
    if (action === 'read') return { ...envelope, result: {
      questionId: question.questionId, taskId: question.taskId, targetBindingId: binding.bindingId,
      state, answer, failureCode: state === 'failed' ? 'execution_failed' : null,
      replyReceiptHash: ['answered', 'failed'].includes(state) ? `sha256:${'a'.repeat(64)}` : null,
    } };
    return { ...envelope, result: { questionId: question.questionId, taskId: question.taskId,
      targetBindingId: binding.bindingId, state, replay: false } };
  } };
  let reserveCalls = 0;
  const input = { vault, bindingId: binding.bindingId, identity, channelTransport: transport,
    currentSession: async () => context,
    verifier: { resolvePublicKey: () => publicKey,
      consume: async (id: string) => { if (used.has(id)) return false; used.add(id); return true; } },
    authorizeContent: async () => disclosed,
    budget: { reserve: async () => { reserveCalls++; return reserved; } },
  };
  return { ...input, binding, root, masterKey, question, actions, used, input,
    setContext: (value: typeof context) => { context = value; }, getContext: () => context,
    setFail: (action: string | null) => { fail = action; }, onAction: (fn: typeof after) => { after = fn; },
    setDisclosure: (value: boolean) => { disclosed = value; }, setReservation: (value: boolean) => { reserved = value; },
    reserves: () => reserveCalls,
  };
}

test('cooperative bindings cannot be driven by a bridge-owned app-server', async () => {
  const f = await fixture();
  let spawned = 0;
  try {
    await assert.rejects(openCodexBoundSession({ ...f.input,
      openTransport: async () => { spawned++; throw new Error('must not spawn'); } }), /binding_unavailable/);
    assert.equal(spawned, 0);
  } finally { f.vault.close(); }
});

test('cooperative close waits for deferred lease cleanup before reporting a closed consumer', async () => {
  const f = await fixture(), acquire = f.vault.tryAcquireProviderSessionLease.bind(f.vault);
  let ready!: () => void, finish!: () => void, settled = false, releases = 0;
  const entered = new Promise<void>(resolve => {ready = resolve;}), pending = new Promise<void>(resolve => {finish = resolve;});
  f.vault.tryAcquireProviderSessionLease = (...args) => {
    const lease = acquire(...args); if (!lease) return lease;
    return {assertHeld: lease.assertHeld, release: async () => {
      releases++; ready(); await pending; lease.release();
    }};
  };
  const owner = await openCooperativeInboxSession(f.input);
  const closing = owner.close().then(result => {settled = true; return result;});
  try {
    await entered; assert.equal(settled, false); assert.equal(releases, 1);
    finish(); assert.equal((await closing).consumerClosed, true);
    const lease = acquire(f.binding.bindingId, f.identity); assert.ok(lease); lease.release();
  } finally {finish(); await closing; await owner.close(); f.vault.close();}
});

test('cooperative failed asynchronous lease cleanup is not reported closed and can be retried', async () => {
  const f = await fixture(), acquire = f.vault.tryAcquireProviderSessionLease.bind(f.vault);
  let fail = true, releases = 0;
  f.vault.tryAcquireProviderSessionLease = (...args) => {
    const lease = acquire(...args); if (!lease) return lease;
    return {assertHeld: lease.assertHeld, release: async () => {
      releases++; if (fail) throw new Error('vault_cleanup_unconfirmed'); lease.release();
    }};
  };
  const owner = await openCooperativeInboxSession(f.input);
  try {
    await assert.rejects(owner.close(), {message: 'vault_cleanup_unconfirmed'});
    assert.equal(acquire(f.binding.bindingId, f.identity), null);
    fail = false; assert.equal((await owner.close()).consumerClosed, true); assert.equal(releases, 2);
    const lease = acquire(f.binding.bindingId, f.identity); assert.ok(lease); lease.release();
  } finally {fail = false; await owner.close(); f.vault.close();}
});

test('only the exact active cooperative session may attach; bridge bindings remain separate', async t => {
  for (const wrong of ['missing', 'inactive', 'thread', 'workspace', 'bridge'] as const) await t.test(wrong, async () => {
    const f = await fixture(wrong === 'bridge' ? 'dharma_bridge' : 'cooperative_session');
    if (wrong === 'missing') f.setContext(null);
    if (wrong === 'inactive') f.setContext({ ...f.getContext()!, active: false });
    if (wrong === 'thread') f.setContext({ ...f.getContext()!, sessionId: uuid(50) });
    if (wrong === 'workspace') f.setContext({ ...f.getContext()!, workspaceRoot: resolve(f.root, 'other') });
    try {
      await assert.rejects(openCooperativeInboxSession(f.input), /cooperative_session_(binding_unavailable|owner_lost)/);
      assert.equal(f.actions.length, 0);
      const lease = f.vault.tryAcquireProviderSessionLease(f.binding.bindingId, f.identity);
      assert.ok(lease); lease.release();
    } finally { f.vault.close(); }
  });
});

test('in-session handler receives a verified bounded offer and returns an attributed immutable answer', async () => {
  const f = await fixture(), owner = await openCooperativeInboxSession(f.input);
  try {
    let handlers = 0;
    const result = await owner.runNext(async offer => {
      handlers++; assert.deepEqual(offer, f.question);
      assert.throws(() => { offer.taskId = uuid(50); }, TypeError);
      assert.throws(() => { offer.authority.readPaths.push('.'); }, TypeError);
      return 'Consult signed catalog generation 13; preserve its source references.';
    });
    assert.equal(result.state, 'answered'); assert.equal(handlers, 1);
    assert.equal(f.reserves(), 1); assert.equal(f.used.size, 1);
    assert.deepEqual(f.actions, ['inspect', 'attach', 'inbox', 'accept', 'reply']);
    assert.equal(f.vault.listProviderSessionReplies(f.binding.bindingId, f.identity).length, 0);
    const idle = await owner.runNext(async () => { throw new Error('must not execute'); });
    assert.equal(idle.state, 'idle');
  } finally { await owner.close(); f.vault.close(); }
});

test('budget denial neither accepts nor consumes nor invokes the chat handler', async () => {
  const f = await fixture(); f.setReservation(false);
  const owner = await openCooperativeInboxSession(f.input);
  try {
    assert.equal((await owner.runNext(async () => { throw new Error('must not execute'); })).state, 'budget_denied');
    assert.equal(f.actions.includes('accept'), false); assert.equal(f.used.size, 0);
  } finally { await owner.close(); f.vault.close(); }
});

test('owner changes during asynchronous budget or acceptance cannot reach the handler', async t => {
  for (const boundary of ['budget', 'accept'] as const) await t.test(boundary, async () => {
    const f = await fixture();
    const input = boundary === 'budget' ? { ...f.input, budget: { reserve: async () => {
      f.setContext({ ...f.getContext()!, sessionId: uuid(51) }); return true;
    } } } : f.input;
    if (boundary === 'accept') f.onAction(action => { if (action === 'accept') f.setContext(null); });
    const owner = await openCooperativeInboxSession(input);
    try {
      await assert.rejects(owner.runNext(async () => { throw new Error('must not execute'); }), /owner_lost/);
      assert.equal(f.actions.includes('reply'), false);
    } finally { await owner.close(); f.vault.close(); }
  });
});

test('loss of current session after computation suppresses disclosure', async () => {
  const f = await fixture(), owner = await openCooperativeInboxSession(f.input);
  try {
    await assert.rejects(owner.runNext(async () => { f.setContext(null); return 'An answer that must not escape.'; }), /owner_lost/);
    assert.equal(f.actions.includes('reply'), false);
  } finally { await owner.close(); f.vault.close(); }
});

test('lost answer acknowledgement is recovered from the vault without another handler or reservation', async () => {
  const f = await fixture(); f.setFail('reply');
  const owner = await openCooperativeInboxSession(f.input);
  let handlers = 0;
  try {
    assert.equal((await owner.runNext(async () => { handlers++; return 'Retain catalog generation 13.'; })).state, 'reply_pending');
    assert.equal(f.vault.listProviderSessionReplies(f.binding.bindingId, f.identity).length, 1);
  } finally { await owner.close(); f.vault.close(); }
  const reopened = await LocalVault.open({ root: f.root, masterKey: f.masterKey });
  f.setFail(null);
  const successor = await openCooperativeInboxSession({ ...f.input, vault: reopened });
  try {
    assert.equal((await successor.runNext(async () => { handlers++; throw new Error('must not rerun'); })).state, 'reply_reconciled');
    assert.equal(handlers, 1); assert.equal(f.reserves(), 1);
    assert.equal(reopened.listProviderSessionReplies(f.binding.bindingId, f.identity).length, 0);
  } finally { await successor.close(); reopened.close(); }
});

test('disclosure denial leaves encrypted completion pending instead of rerunning work', async () => {
  const f = await fixture(), owner = await openCooperativeInboxSession(f.input);
  try {
    const result = await owner.runNext(async () => { f.setDisclosure(false); return 'Retain the approved catalog.'; });
    assert.equal(result.state, 'reply_pending'); assert.equal(f.actions.includes('reply'), false);
    assert.equal(f.vault.listProviderSessionReplies(f.binding.bindingId, f.identity).length, 1);
  } finally { await owner.close(); f.vault.close(); }
});

test('local fence rejects another consumer and explicit retirement is terminal', async () => {
  const f = await fixture(), owner = await openCooperativeInboxSession(f.input);
  try {
    await assert.rejects(openCooperativeInboxSession(f.input), /lease_unavailable/);
    assert.equal((await owner.retire()).serverDetached, true);
    assert.equal(f.vault.getProviderSessionBinding(f.binding.bindingId, f.identity), null);
    await assert.rejects(owner.runNext(async () => 'No.'), /unavailable/);
  } finally { await owner.close(); f.vault.close(); }
});

test('a second question handler cannot overlap the current session turn', async () => {
  const f = await fixture(), owner = await openCooperativeInboxSession(f.input);
  let started!: () => void, finish!: () => void;
  const began = new Promise<void>(resolve => { started = resolve; });
  const gate = new Promise<void>(resolve => { finish = resolve; });
  const first = owner.runNext(async () => { started(); await gate; return 'Use the approved catalog.'; });
  await began;
  try {
    await assert.rejects(owner.runNext(async () => 'No.'), /busy/);
    finish(); assert.equal((await first).state, 'answered');
  } finally { finish(); await first.catch(() => undefined); await owner.close(); f.vault.close(); }
});

test('expiry during a reservation wait prevents acceptance and current-chat execution', async t => {
  const f = await fixture();
  f.question.expiresAt = new Date(Date.now() + 30000).toISOString();
  const { signature: _signature, ...unsigned } = f.question;
  f.question.signature = signCanonicalObject(unsigned, privateKey);
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const owner = await openCooperativeInboxSession({ ...f.input,
    budget: { reserve: async () => { t.mock.timers.tick(31000); return true; } },
  });
  try {
    await assert.rejects(owner.runNext(async () => { throw new Error('must not execute expired work'); }), /expired|unavailable/);
    assert.equal(f.actions.includes('accept'), false);
  } finally { await owner.close(); f.vault.close(); }
});

test('current-chat execution failure emits a typed failed receipt without disclosing exception text', async () => {
  const f = await fixture(), owner = await openCooperativeInboxSession(f.input);
  try {
    const result = await owner.runNext(async () => { throw new Error('private internal exception'); });
    assert.equal(result.state, 'failed');
    assert.equal(f.actions.includes('reply'), true);
    assert.equal(JSON.stringify(result).includes('private internal exception'), false);
  } finally { await owner.close(); f.vault.close(); }
});

test('close keeps the fence until the current handler settles and suppresses its answer', async () => {
  const f = await fixture(), owner = await openCooperativeInboxSession(f.input);
  let started!: () => void, finish!: () => void;
  const began = new Promise<void>(resolve => { started = resolve; });
  const gate = new Promise<void>(resolve => { finish = resolve; });
  const turn = owner.runNext(async () => { started(); await gate; return 'This answer must be withheld.'; });
  await began;
  const closing = owner.close();
  assert.equal(f.vault.tryAcquireProviderSessionLease(f.binding.bindingId, f.identity), null);
  finish();
  await assert.rejects(turn, /owner_lost/); await closing;
  assert.equal(f.actions.includes('reply'), false);
  const successor = f.vault.tryAcquireProviderSessionLease(f.binding.bindingId, f.identity);
  assert.ok(successor); successor.release(); f.vault.close();
});

test('revocation during replay claim prevents execution', async () => {
  const f = await fixture();
  const owner = await openCooperativeInboxSession({ ...f.input, verifier: { ...f.input.verifier,
    consume: async () => { f.vault.revokeProviderSessionBinding(f.binding.bindingId, f.identity); return true; },
  } });
  try {
    await assert.rejects(owner.runNext(async () => { throw new Error('must not execute'); }), /owner_lost/);
    assert.equal(f.actions.includes('reply'), false);
  } finally { await owner.close(); f.vault.close(); }
});

test('secret answers stay encrypted locally and are never transmitted', async () => {
  const f = await fixture(), owner = await openCooperativeInboxSession(f.input);
  try {
    const result = await owner.runNext(async () => 'api_key=synthetic-do-not-disclose');
    assert.equal(result.state, 'reply_pending'); assert.equal(f.actions.includes('reply'), false);
    assert.equal(JSON.stringify(result).includes('synthetic-do-not-disclose'), false);
  } finally { await owner.close(); f.vault.close(); }
});
