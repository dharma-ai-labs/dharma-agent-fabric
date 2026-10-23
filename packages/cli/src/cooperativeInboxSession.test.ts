import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { canonicalize, signCanonicalObject, validateContract, type SessionQuestion } from '@dharma-ai-labs/agent-fabric-contracts';
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
    remoteAnswer: () => answer,
    setRemoteAnswer: (value: string) => {state = 'answered'; answer = value;},
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
    assert.equal(reopened.listProviderSessionOfferCheckpoints(f.binding.bindingId, f.identity).length, 0);
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

test('the actual consumer journals the immutable signed offer before acceptance or computation', async () => {
  const f = await fixture(), owner = await openCooperativeInboxSession(f.input);
  let atAccept = false;
  f.onAction(action => {
    if (action !== 'accept') return;
    const entries = f.vault.listProviderSessionOfferCheckpoints(f.binding.bindingId, f.identity);
    assert.equal(entries.length, 1); assert.equal(entries[0]?.questionId, f.question.questionId);
    atAccept = true;
  });
  try {
    assert.equal((await owner.runNext(async offer => {
      assert.equal(atAccept, true);
      const stored = await f.vault.readProviderSessionOfferCheckpoint(f.binding.bindingId, f.identity,
        offer.questionId, {version: offer.signerKeyVersion, publicKeyPem: publicKey.export({type: 'spki', format: 'pem'}).toString()});
      assert.equal(stored?.state, 'recovery_required');
      assert.deepEqual(stored?.question, offer);
      return 'Use the approved catalog.';
    })).state, 'answered');
    assert.equal(f.vault.listProviderSessionOfferCheckpoints(f.binding.bindingId, f.identity).length, 0);
  } finally {await owner.close(); f.vault.close();}
});

test('uncertain acceptance survives vault reopen without another accept, reservation or computation', async () => {
  const f = await fixture(); f.setFail('accept');
  const owner = await openCooperativeInboxSession(f.input);
  try {
    await assert.rejects(owner.runNext(async () => {throw new Error('must not execute');}), /uncertain/);
  } finally {await owner.close(); f.vault.close();}
  const reopened = await LocalVault.open({root: f.root, masterKey: f.masterKey});
  f.setFail(null);
  const successor = await openCooperativeInboxSession({...f.input, vault: reopened});
  try {
    const before = f.actions.length;
    const result = await successor.runNext(async () => {throw new Error('must not execute');});
    assert.equal('questionId' in result && result.questionId, f.question.questionId);
    assert.equal(result.state, 'offer_recovery_required');
    assert.deepEqual(f.actions.slice(before), []);
    assert.equal(f.reserves(), 1); assert.equal(f.used.size, 0);
    assert.equal(JSON.stringify(result).includes(f.question.question), false);
  } finally {await successor.close(); reopened.close();}
});

test('lost owner after accepted computation remains recovery-required even if the remote inbox is empty', async () => {
  const f = await fixture(), owner = await openCooperativeInboxSession(f.input), context = f.getContext();
  let handlers = 0;
  try {
    await assert.rejects(owner.runNext(async () => {
      handlers++; f.setContext(null); return 'This uncommitted answer must not escape.';
    }), /owner_lost/);
  } finally {await owner.close(); f.vault.close();}
  const reopened = await LocalVault.open({root: f.root, masterKey: f.masterKey}); f.setContext(context);
  const successor = await openCooperativeInboxSession({...f.input, vault: reopened});
  try {
    assert.equal((await successor.runNext(async () => {handlers++; return 'Do not repeat.';})).state, 'offer_recovery_required');
    assert.equal(handlers, 1); assert.equal(f.reserves(), 1); assert.equal(f.used.size, 1);
    assert.equal(f.actions.filter(action => action === 'inbox').length, 1);
    assert.equal(f.actions.includes('reply'), false);
  } finally {await successor.close(); reopened.close();}
});

test('a preexisting immutable offer blocks unrelated queued work without exposing its contents', async () => {
  const f = await fixture();
  await f.vault.stageProviderSessionOfferCheckpoint(f.binding.bindingId, f.identity, f.question as SessionQuestion,
    {version: 'test-key', publicKeyPem: publicKey.export({type: 'spki', format: 'pem'}).toString()});
  const owner = await openCooperativeInboxSession(f.input);
  try {
    const result = await owner.runNext(async () => {throw new Error('must not execute');});
    assert.equal(result.state, 'offer_recovery_required');
    assert.equal(f.reserves(), 0); assert.equal(f.used.size, 0);
    assert.deepEqual(f.actions, ['inspect', 'attach']);
    assert.equal(JSON.stringify(result).includes(f.question.question), false);
  } finally {await owner.close(); f.vault.close();}
});

for (const phase of ['inline', 'handed_off'] as const) test(`an actual ${phase} process crash retains the accepted offer without successor replay`, async () => {
  const f = await fixture(); f.vault.close();
  const source = `
    import {LocalVault} from '@dharma-ai-labs/agent-fabric-local-vault';
    import {createPublicKey} from 'node:crypto';
    const {openCooperativeInboxSession} = await import(${JSON.stringify(new URL('./cooperativeInboxSession.js', import.meta.url).href)});
    const binding = ${JSON.stringify(f.binding)}, identity = ${JSON.stringify(f.identity)};
    const {organizationId, ...registeredIdentity} = identity;
    const offer = ${JSON.stringify(f.question)}, publicKey = createPublicKey(${JSON.stringify(publicKey.export({type: 'spki', format: 'pem'}).toString())});
    const vault = await LocalVault.open({root: ${JSON.stringify(f.root)}, masterKey: Buffer.from(${JSON.stringify(f.masterKey.toString('base64'))}, 'base64')});
    const owner = await openCooperativeInboxSession({vault, bindingId: binding.bindingId, identity,
      currentSession: async () => ({provider: 'codex', sessionId: binding.sessionId, workspaceRoot: binding.workspaceRoot, active: true}),
      verifier: {resolvePublicKey: () => publicKey, consume: async () => true},
      authorizeContent: async () => true, budget: {reserve: async () => true},
      channelTransport: {signedPost: async (route, body) => {
        const envelope = {ok: true, organizationId: identity.organizationId, correlationId: ${JSON.stringify(uuid(90))}};
        if (body.action === 'inspect') return {...envelope, registration: null};
        if (body.action === 'attach') return {...envelope, registration: {...registeredIdentity, bindingId: binding.bindingId,
          mode: 'cooperative', revision: 1, state: 'attached', leaseUntil: new Date(Date.now()+60000).toISOString(), replay: false}};
        if (body.action === 'inbox') return {...envelope, result: {offers: [offer]}};
        if (body.action === 'accept') return {...envelope, result: {questionId: offer.questionId, taskId: offer.taskId,
          targetBindingId: binding.bindingId, state: 'accepted', replay: false}};
        throw new Error('Unexpected synthetic transport action');
      }}
    });
    ${phase === 'handed_off' ? 'await owner.checkpoint(); process.exit(77);' : 'await owner.runNext(async () => {process.exit(77);});'}
    throw new Error('Crash fixture did not reach the consumer callback');
  `;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', source],
    {cwd: resolve(import.meta.dirname, '../../..'), encoding: 'utf8', timeout: 30000});
  assert.equal(child.status, 77, child.stderr);
  const reopened = await LocalVault.open({root: f.root, masterKey: f.masterKey});
  const successor = await openCooperativeInboxSession({...f.input, vault: reopened});
  try {
    if (phase === 'handed_off') assert.equal(reopened.readProviderSessionOfferHandoff(f.binding.bindingId, f.identity,
      f.question.questionId)?.state, 'handed_off');
    assert.equal((await successor.runNext(async () => {throw new Error('must not recompute');})).state, 'offer_recovery_required');
    assert.equal(f.reserves(), 0); assert.equal(f.used.size, 0);
    assert.deepEqual(f.actions, ['inspect', 'attach']);
  } finally {await successor.close(); reopened.close();}
});

test('the scoped vault facade persists and atomically settles the actual consumer offer', async () => {
  const f = await fixture(); f.vault.close();
  const controller = new AbortController();
  const vault = await LocalVault.open({root: f.root, masterKey: f.masterKey},
    {signal: controller.signal, current: async () => !controller.signal.aborted});
  const owner = await openCooperativeInboxSession({...f.input, vault});
  try {
    assert.equal((await owner.runNext(async offer => {
      assert.equal((await vault.listProviderSessionOfferCheckpoints(f.binding.bindingId, f.identity))[0]?.questionId, offer.questionId);
      return 'Use the pinned catalog.';
    })).state, 'answered');
    assert.deepEqual(await vault.listProviderSessionOfferCheckpoints(f.binding.bindingId, f.identity), []);
    assert.deepEqual(await vault.listProviderSessionReplies(f.binding.bindingId, f.identity), []);
  } finally {await owner.close(); controller.abort(); await vault.close();}
});

test('a failed encrypted checkpoint write cannot reach acceptance, replay consumption or computation', async () => {
  const f = await fixture(), owner = await openCooperativeInboxSession(f.input);
  f.vault.stageProviderSessionOfferCheckpoint = async () => {throw new Error('synthetic durable write unconfirmed');};
  try {
    await assert.rejects(owner.runNext(async () => {throw new Error('must not execute');}), /durable write unconfirmed/);
    assert.equal(f.actions.includes('accept'), false); assert.equal(f.actions.includes('reply'), false);
    assert.equal(f.used.size, 0); assert.equal(f.reserves(), 1);
  } finally {await owner.close(); f.vault.close();}
});

interface SplitCheckpoint {
  state: string; offer: SessionQuestion; offerHash: string; attemptId: string;
}
interface SplitAnswer {
  questionId: string; taskId: string; nonce: string; offerHash: string; attemptId: string; answer: string;
}
function splitConsumer(owner: unknown) {
  const split = owner as {checkpoint(): Promise<SplitCheckpoint>; submitAnswer(value: SplitAnswer): Promise<{state: string}>};
  assert.equal(typeof split.checkpoint, 'function', 'actual consumer must expose checkpoint without invoking an answer callback');
  assert.equal(typeof split.submitAnswer, 'function', 'actual consumer must expose a separate later submission');
  return split;
}
function splitAnswer(checkpoint: SplitCheckpoint): SplitAnswer {
  return {questionId: checkpoint.offer.questionId, taskId: checkpoint.offer.taskId, nonce: checkpoint.offer.nonce,
    offerHash: checkpoint.offerHash, attemptId: checkpoint.attemptId, answer: 'Use the signed catalog.'};
}

for (const field of ['questionId', 'taskId', 'nonce', 'offerHash', 'attemptId', 'answer'] as const) {
  test(`later submission rejects accessor ${field} without invoking caller code or posting a reply`, async () => {
    const f = await fixture(), owner = await openCooperativeInboxSession(f.input);
    try {
      const split = splitConsumer(owner), checkpoint = await split.checkpoint(), answer = splitAnswer(checkpoint);
      const original = answer[field], actions = [...f.actions];
      let reads = 0;
      Object.defineProperty(answer, field, {enumerable: true, get() {reads++; return original;}});
      await assert.rejects(split.submitAnswer(answer), {message: 'cooperative_session_submission_invalid'});
      assert.equal(reads, 0); assert.deepEqual(f.actions, actions);
      assert.equal(f.reserves(), 1); assert.equal(f.used.size, 1);
      assert.equal(f.vault.listProviderSessionOfferCheckpoints(f.binding.bindingId, f.identity).length, 1);
    } finally {await owner.close(); f.vault.close();}
  });
}

for (const shape of ['custom prototype', 'null prototype', 'array', 'symbol', 'hidden extra', 'hidden required'] as const) {
  test(`later submission rejects ${shape} DTOs without losing the durable handoff`, async () => {
    const f = await fixture(), owner = await openCooperativeInboxSession(f.input);
    try {
      const split = splitConsumer(owner), checkpoint = await split.checkpoint(), answer = splitAnswer(checkpoint);
      const actions = [...f.actions];
      if (shape === 'custom prototype') Object.setPrototypeOf(answer, {inheritedControl: 'not-authority'});
      if (shape === 'null prototype') Object.setPrototypeOf(answer, null);
      if (shape === 'array') Object.setPrototypeOf(answer, Array.prototype);
      if (shape === 'symbol') Object.defineProperty(answer, Symbol('extra'), {value: 'not-authority'});
      if (shape === 'hidden extra') Object.defineProperty(answer, 'extra', {value: 'not-authority'});
      if (shape === 'hidden required') Object.defineProperty(answer, 'answer', {value: answer.answer, enumerable: false});
      await assert.rejects(split.submitAnswer(answer), {message: 'cooperative_session_submission_invalid'});
      assert.deepEqual(f.actions, actions);
      assert.equal(f.vault.listProviderSessionOfferCheckpoints(f.binding.bindingId, f.identity).length, 1);
    } finally {await owner.close(); f.vault.close();}
  });
}

for (const shape of ['throwing accessor', 'proxy', 'revoked proxy'] as const) {
  test(`later submission sanitizes ${shape} before caller callbacks or protected effects`, async () => {
    const f = await fixture(), owner = await openCooperativeInboxSession(f.input);
    try {
      const split = splitConsumer(owner), checkpoint = await split.checkpoint();
      let answer = splitAnswer(checkpoint), callbacks = 0;
      const actions = [...f.actions], diagnostic = 'synthetic-private-diagnostic-must-not-escape';
      if (shape === 'throwing accessor') Object.defineProperty(answer, 'answer', {enumerable: true,
        get() {callbacks++; throw new Error(diagnostic);}});
      if (shape === 'proxy') answer = new Proxy(answer, {ownKeys() {callbacks++; throw new Error(diagnostic);}});
      if (shape === 'revoked proxy') {const proxy = Proxy.revocable(answer, {}); answer = proxy.proxy; proxy.revoke();}
      await assert.rejects(split.submitAnswer(answer), {message: 'cooperative_session_submission_invalid'});
      assert.equal(callbacks, 0); assert.deepEqual(f.actions, actions);
      assert.equal(f.vault.listProviderSessionOfferCheckpoints(f.binding.bindingId, f.identity).length, 1);
    } finally {await owner.close(); f.vault.close();}
  });
}

test('checkpoint durably hands off the immutable offer without computing or posting an answer', async () => {
  const f = await fixture(), owner = await openCooperativeInboxSession(f.input);
  try {
    const split = splitConsumer(owner), checkpoint = await split.checkpoint();
    assert.equal(checkpoint.state, 'handed_off'); assert.deepEqual(checkpoint.offer, f.question);
    assert.throws(() => {checkpoint.offer.authority.readPaths.push('.');}, TypeError);
    assert.deepEqual(f.actions, ['inspect', 'attach', 'inbox', 'accept']);
    assert.equal(f.reserves(), 1); assert.equal(f.used.size, 1);
    assert.equal((await split.submitAnswer(splitAnswer(checkpoint))).state, 'answered');
    assert.equal(f.actions.filter(x => x === 'reply').length, 1);
    assert.deepEqual(f.vault.listProviderSessionOfferCheckpoints(f.binding.bindingId, f.identity), []);
  } finally {await owner.close(); f.vault.close();}
});

test('handed-off checkpoint retains the same exclusive lease and does not disclose or reserve twice', async () => {
  const f = await fixture(), owner = await openCooperativeInboxSession(f.input);
  try {
    const split = splitConsumer(owner); await split.checkpoint();
    await assert.rejects(openCooperativeInboxSession(f.input), /lease_unavailable/);
    const actions = f.actions.length, repeated = await split.checkpoint();
    assert.equal(repeated.state, 'checkpoint_pending');
    assert.equal(JSON.stringify(repeated).includes(f.question.question), false);
    assert.equal(f.actions.length, actions); assert.equal(f.reserves(), 1);
    await assert.rejects(owner.runNext(async () => {throw new Error('must not compute');}), /handoff_pending/);
  } finally {await owner.close(); f.vault.close();}
});

for (const field of ['questionId', 'taskId', 'nonce', 'offerHash', 'attemptId', 'nativeSessionId', 'workspaceRoot', 'provider'] as const) {
  test(`later submission rejects mismatched or extra ${field} before reply`, async () => {
    const f = await fixture(), owner = await openCooperativeInboxSession(f.input);
    try {
      const split = splitConsumer(owner), checkpoint = await split.checkpoint();
      const answer = {...splitAnswer(checkpoint), [field]: field === 'offerHash' ? `sha256:${'0'.repeat(64)}` : uuid(99)};
      await assert.rejects(split.submitAnswer(answer), /submission_(invalid|mismatch)/);
      assert.equal(f.actions.includes('reply'), false);
      assert.equal(f.vault.listProviderSessionOfferCheckpoints(f.binding.bindingId, f.identity).length, 1);
    } finally {await owner.close(); f.vault.close();}
  });
}

for (const change of ['session', 'workspace', 'inactive'] as const) {
  test(`later submission refuses lost ${change} ownership and retains the durable handoff`, async () => {
    const f = await fixture(), owner = await openCooperativeInboxSession(f.input);
    try {
      const split = splitConsumer(owner), checkpoint = await split.checkpoint();
      f.setContext({...f.getContext()!, ...(change === 'session' ? {sessionId: uuid(99)}
        : change === 'workspace' ? {workspaceRoot: resolve(f.root, 'other')} : {active: false})});
      await assert.rejects(split.submitAnswer(splitAnswer(checkpoint)), /owner_lost/);
      assert.equal(f.actions.includes('reply'), false);
      assert.equal(f.vault.listProviderSessionOfferCheckpoints(f.binding.bindingId, f.identity).length, 1);
    } finally {await owner.close(); f.vault.close();}
  });
}

test('expired split-phase work cannot post an answer or erase its offer', async t => {
  const f = await fixture(), owner = await openCooperativeInboxSession(f.input);
  try {
    const split = splitConsumer(owner), checkpoint = await split.checkpoint();
    t.mock.timers.enable({apis: ['Date'], now: Date.parse(f.question.expiresAt) + 1});
    await assert.rejects(split.submitAnswer(splitAnswer(checkpoint)), /expired|submission_mismatch/);
    assert.equal(f.actions.includes('reply'), false);
    assert.equal(f.vault.listProviderSessionOfferCheckpoints(f.binding.bindingId, f.identity).length, 1);
  } finally {await owner.close(); f.vault.close();}
});

test('a closed handoff cannot be answered by a reopened consumer or re-admitted as new work', async () => {
  const f = await fixture(), owner = await openCooperativeInboxSession(f.input);
  let checkpoint: SplitCheckpoint;
  try {checkpoint = await splitConsumer(owner).checkpoint();}
  finally {await owner.close(); f.vault.close();}
  const reopened = await LocalVault.open({root: f.root, masterKey: f.masterKey});
  const next = await openCooperativeInboxSession({...f.input, vault: reopened});
  try {
    const split = splitConsumer(next), before = f.actions.length;
    await assert.rejects(split.submitAnswer(splitAnswer(checkpoint!)), /submission_mismatch/);
    assert.equal(f.actions.length, before); assert.equal(f.reserves(), 1);
  } finally {await next.close(); reopened.close();}
});

test('a lost split-phase reply ACK recovers the v2 completion without another reservation or computation', async () => {
  const f = await fixture(), owner = await openCooperativeInboxSession(f.input);
  try {
    const split = splitConsumer(owner), checkpoint = await split.checkpoint(); f.setFail('reply');
    assert.equal((await split.submitAnswer(splitAnswer(checkpoint))).state, 'reply_pending');
    const pending = f.vault.listProviderSessionReplies(f.binding.bindingId, f.identity)[0];
    assert.ok(pending);
    const completion = JSON.parse((await f.vault.getBlob(pending.completionHash)).toString('utf8'));
    assert.equal(completion.schema, 'dharma.provider-session-completion/v2');
    assert.equal(completion.offerHash, checkpoint.offerHash); assert.equal(completion.nonce, f.question.nonce);
    assert.equal(completion.attemptId, checkpoint.attemptId); assert.equal(completion.nativeSessionId, f.binding.sessionId);
    const schema = 'https://schemas.dharma-ai.io/provider-session-completion/v2', schemas = resolve(import.meta.dirname, 'schemas');
    assert.equal((await validateContract(schemas, schema, completion)).ok, true);
    for (const invalid of [{...completion, offerHash: 'invalid'}, {...completion, attemptId: 'invalid'},
      {...completion, nativeSessionId: 'line\nbreak'}, {...completion, nativeAuthority: true}]) {
      assert.equal((await validateContract(schemas, schema, invalid)).ok, false);
    }
  } finally {await owner.close(); f.vault.close();}
  const reopened = await LocalVault.open({root: f.root, masterKey: f.masterKey}); f.setFail(null);
  const next = await openCooperativeInboxSession({...f.input, vault: reopened});
  try {
    assert.equal((await next.runNext(async () => {throw new Error('must not recompute');})).state, 'reply_reconciled');
    assert.equal(f.reserves(), 1); assert.equal(f.used.size, 1);
    assert.deepEqual(reopened.listProviderSessionOfferCheckpoints(f.binding.bindingId, f.identity), []);
  } finally {await next.close(); reopened.close();}
});

test('a duplicate later answer cannot submit twice after successful settlement', async () => {
  const f = await fixture(), owner = await openCooperativeInboxSession(f.input);
  try {
    const split = splitConsumer(owner), checkpoint = await split.checkpoint(), answer = splitAnswer(checkpoint);
    assert.equal((await split.submitAnswer(answer)).state, 'answered');
    await assert.rejects(split.submitAnswer(answer), /submission_mismatch/);
    assert.equal(f.actions.filter(x => x === 'reply').length, 1); assert.equal(f.reserves(), 1);
  } finally {await owner.close(); f.vault.close();}
});

test('submission snapshots its answer before the asynchronous current-owner check', async () => {
  const f = await fixture(); let pause = false, release!: () => void;
  const gate = new Promise<void>(resolve => {release = resolve;});
  const owner = await openCooperativeInboxSession({...f.input, currentSession: async () => {
    if (pause) await gate; return f.getContext();
  }});
  try {
    const split = splitConsumer(owner), checkpoint = await split.checkpoint(), answer = splitAnswer(checkpoint);
    pause = true; const submission = split.submitAnswer(answer); answer.answer = 'Changed after invocation.';
    release(); assert.equal((await submission).state, 'answered');
    assert.equal(f.remoteAnswer(), 'Use the signed catalog.');
  } finally {release(); await owner.close(); f.vault.close();}
});

test('expiry during durable reply staging suppresses disclosure and retains both records', async t => {
  const f = await fixture(), owner = await openCooperativeInboxSession(f.input);
  try {
    const split = splitConsumer(owner), checkpoint = await split.checkpoint();
    const original = f.vault.stageProviderSessionReply.bind(f.vault);
    f.vault.stageProviderSessionReply = async (...args) => {
      const hash = await original(...args);
      t.mock.timers.enable({apis: ['Date'], now: Date.parse(f.question.expiresAt) + 1}); return hash;
    };
    await assert.rejects(split.submitAnswer(splitAnswer(checkpoint)), /expired/);
    assert.equal(f.actions.includes('reply'), false);
    assert.equal(f.vault.listProviderSessionReplies(f.binding.bindingId, f.identity).length, 1);
    assert.equal(f.vault.listProviderSessionOfferCheckpoints(f.binding.bindingId, f.identity).length, 1);
  } finally {await owner.close(); f.vault.close();}
});

for (const field of ['taskId', 'nonce', 'attemptId', 'nativeSessionId', 'workspaceRootHash', 'offerHash'] as const) {
  test(`v2 durable recovery rejects mismatched ${field} before a read or upload`, async () => {
    const f = await fixture(), owner = await openCooperativeInboxSession(f.input);
    try {
      const split = splitConsumer(owner), checkpoint = await split.checkpoint(); f.setFail('reply');
      const original = f.vault.stageProviderSessionReply.bind(f.vault);
      f.vault.stageProviderSessionReply = async (binding, identity, question, bytes) => {
        const value = JSON.parse(Buffer.from(bytes).toString('utf8'));
        value[field] = field.endsWith('Hash') ? `sha256:${'0'.repeat(64)}` : uuid(99);
        return original(binding, identity, question, Buffer.from(canonicalize(value)));
      };
      assert.equal((await split.submitAnswer(splitAnswer(checkpoint))).state, 'reply_pending');
    } finally {await owner.close(); f.vault.close();}
    const reopened = await LocalVault.open({root: f.root, masterKey: f.masterKey}); f.setFail(null);
    const next = await openCooperativeInboxSession({...f.input, vault: reopened});
    try {
      const actions = f.actions.length;
      await assert.rejects(next.runNext(async () => {throw new Error('must not compute');}), /handoff_mismatch/);
      assert.equal(f.actions.length, actions); assert.equal(f.reserves(), 1);
      assert.equal(reopened.listProviderSessionReplies(f.binding.bindingId, f.identity).length, 1);
    } finally {await next.close(); reopened.close();}
  });
}

test('v2 recovery cannot re-upload accepted work after its signed expiry', async t => {
  const f = await fixture(), owner = await openCooperativeInboxSession(f.input);
  try {
    const split = splitConsumer(owner), checkpoint = await split.checkpoint(); f.setFail('reply');
    assert.equal((await split.submitAnswer(splitAnswer(checkpoint))).state, 'reply_pending');
  } finally {await owner.close(); f.vault.close();}
  t.mock.timers.enable({apis: ['Date'], now: Date.parse(f.question.expiresAt) + 1}); f.setFail(null);
  const reopened = await LocalVault.open({root: f.root, masterKey: f.masterKey});
  const next = await openCooperativeInboxSession({...f.input, vault: reopened});
  try {
    const before = f.actions.filter(x => x === 'reply').length;
    assert.equal((await next.runNext(async () => {throw new Error('must not compute');})).state, 'reply_pending');
    assert.equal(f.actions.filter(x => x === 'reply').length, before);
    assert.equal(reopened.listProviderSessionReplies(f.binding.bindingId, f.identity).length, 1);
  } finally {await next.close(); reopened.close();}
});

test('split-phase handoff and later submission use the actual scoped asynchronous vault facade', async () => {
  const f = await fixture(); f.vault.close(); const controller = new AbortController();
  const vault = await LocalVault.open({root: f.root, masterKey: f.masterKey},
    {signal: controller.signal, current: async () => !controller.signal.aborted});
  const owner = await openCooperativeInboxSession({...f.input, vault});
  try {
    const split = splitConsumer(owner), checkpoint = await split.checkpoint();
    assert.equal((await vault.readProviderSessionOfferHandoff(f.binding.bindingId, f.identity, checkpoint.offer.questionId))?.state, 'handed_off');
    assert.equal((await split.submitAnswer(splitAnswer(checkpoint))).state, 'answered');
    assert.deepEqual(await vault.listProviderSessionOfferCheckpoints(f.binding.bindingId, f.identity), []);
  } finally {await owner.close(); controller.abort(); await vault.close();}
});

for (const boundary of ['read', 'answer_authorization'] as const) {
  test(`v2 recovery cannot disclose an answer when signed expiry passes during ${boundary}`, async t => {
    const f = await fixture(), owner = await openCooperativeInboxSession(f.input);
    try {
      const split = splitConsumer(owner), checkpoint = await split.checkpoint(); f.setFail('reply');
      assert.equal((await split.submitAnswer(splitAnswer(checkpoint))).state, 'reply_pending');
    } finally {await owner.close(); f.vault.close();}
    const expire = () => t.mock.timers.enable({apis: ['Date'], now: Date.parse(f.question.expiresAt) + 1});
    if (boundary === 'read') f.onAction(action => {if (action === 'read') expire();});
    const reopened = await LocalVault.open({root: f.root, masterKey: f.masterKey}); f.setFail(null);
    const next = await openCooperativeInboxSession({...f.input, vault: reopened,
      authorizeContent: async (_content, kind) => {if (boundary === 'answer_authorization' && kind === 'answer') expire(); return true;}});
    try {
      const before = f.actions.filter(x => x === 'reply').length;
      assert.equal((await next.runNext(async () => {throw new Error('must not compute');})).state, 'reply_pending');
      assert.equal(f.actions.filter(x => x === 'reply').length, before);
      assert.equal(reopened.listProviderSessionReplies(f.binding.bindingId, f.identity).length, 1);
      assert.equal(reopened.listProviderSessionOfferCheckpoints(f.binding.bindingId, f.identity).length, 1);
    } finally {await next.close(); reopened.close();}
  });
}

test('a new split-phase answer cannot cross signed expiry during asynchronous disclosure authorization', async t => {
  const f = await fixture();
  const owner = await openCooperativeInboxSession({...f.input, authorizeContent: async (_content, kind) => {
    if (kind === 'answer') t.mock.timers.enable({apis: ['Date'], now: Date.parse(f.question.expiresAt) + 1});
    return true;
  }});
  try {
    const split = splitConsumer(owner), checkpoint = await split.checkpoint();
    assert.equal((await split.submitAnswer(splitAnswer(checkpoint))).state, 'reply_pending');
    assert.equal(f.actions.includes('reply'), false);
    assert.equal(f.vault.listProviderSessionReplies(f.binding.bindingId, f.identity).length, 1);
  } finally {await owner.close(); f.vault.close();}
});

test('an authoritative matching answered receipt after expiry reconciles without re-upload', async t => {
  const f = await fixture(), owner = await openCooperativeInboxSession(f.input);
  try {
    const split = splitConsumer(owner), checkpoint = await split.checkpoint(); f.setFail('reply');
    assert.equal((await split.submitAnswer(splitAnswer(checkpoint))).state, 'reply_pending');
  } finally {await owner.close(); f.vault.close();}
  f.setFail(null); f.setRemoteAnswer('Use the signed catalog.');
  t.mock.timers.enable({apis: ['Date'], now: Date.parse(f.question.expiresAt) + 1});
  const reopened = await LocalVault.open({root: f.root, masterKey: f.masterKey});
  const next = await openCooperativeInboxSession({...f.input, vault: reopened});
  try {
    const before = f.actions.filter(x => x === 'reply').length;
    assert.equal((await next.runNext(async () => {throw new Error('must not compute');})).state, 'reply_reconciled');
    assert.equal(f.actions.filter(x => x === 'reply').length, before);
    assert.deepEqual(reopened.listProviderSessionOfferCheckpoints(f.binding.bindingId, f.identity), []);
  } finally {await next.close(); reopened.close();}
});
