import assert from 'node:assert/strict';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { signCanonicalObject } from '@dharma-ai-labs/agent-fabric-contracts';
import { LocalVault, type LocalProviderSessionBinding } from '@dharma-ai-labs/agent-fabric-local-vault';
import { runOriginalSessionInboxOnce, type OriginalSessionContext } from './originalSessionHost.js';
import { runOriginalSessionInboxOnce as publicAdapter } from './index.js';

const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const uuid = (n: number) => `60000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

test('the native runtime can import the adapter through the public package surface', () => {
  assert.equal(publicAdapter, runOriginalSessionInboxOnce);
});

async function fixture(projectedWorkspace?: string) {
  const root = await mkdtemp(join(tmpdir(), 'dharma-original-host-'));
  const workspaceRoot = resolve(root, 'repo');
  const vault = await LocalVault.open({ root, masterKey: randomBytes(32) });
  const now = Date.now();
  const binding: LocalProviderSessionBinding = {
    schema: 'dharma.local-provider-session-binding/v1', owner: 'cooperative_session',
    organizationId: 'org_hq_fixture', repositoryBindingId: uuid(1), workspaceId: uuid(2),
    endpointId: uuid(3), membershipId: uuid(4), deviceId: uuid(5), bindingId: uuid(6),
    provider: 'codex', sessionId: uuid(7), workspaceRoot,
    createdAt: new Date(now).toISOString(), expiresAt: new Date(now + 3600000).toISOString(),
    maximumProviderCostCents: 25,
  };
  vault.saveProviderSessionBinding(binding);
  if (projectedWorkspace) {
    // Foreign-platform path fixtures project only the public binding view;
    // the real encrypted fixture and all file IO remain in the native temp root.
    const getBinding = vault.getProviderSessionBinding.bind(vault);
    binding.workspaceRoot = projectedWorkspace;
    vault.getProviderSessionBinding = (...args) => {
      const value = getBinding(...args);
      return value ? { ...value, workspaceRoot: projectedWorkspace } : null;
    };
  }
  const identity = { organizationId: binding.organizationId, repositoryBindingId: binding.repositoryBindingId,
    workspaceId: binding.workspaceId, endpointId: binding.endpointId, membershipId: binding.membershipId,
    deviceId: binding.deviceId, provider: binding.provider };
  let context: OriginalSessionContext | null = { ...identity, sessionId: binding.sessionId,
    workspaceRoot: binding.workspaceRoot, state: 'ready' };
  const unsigned = { schema: 'dharma.session-question/v1', questionId: uuid(10), taskId: uuid(11),
    organizationId: binding.organizationId, repositoryBindingId: binding.repositoryBindingId,
    source: { workspaceId: uuid(12), endpointId: uuid(13), membershipId: uuid(14), deviceId: uuid(15) },
    target: { workspaceId: binding.workspaceId, endpointId: binding.endpointId,
      membershipId: binding.membershipId, deviceId: binding.deviceId, bindingId: binding.bindingId, provider: 'codex' },
    category: 'architecture', question: 'Which signed catalog applies?',
    authority: { mode: 'read_only', readPaths: ['.'], network: 'deny', maximumProviderCostCents: 25 },
    createdAt: new Date(now).toISOString(), expiresAt: new Date(now + 60000).toISOString(),
    nonce: uuid(16), signerKeyVersion: 'fixture-key' };
  const question = { ...unsigned, signature: signCanonicalObject(unsigned, privateKey) };
  const actions: { action: string; body: Record<string, unknown> }[] = [], used = new Set<string>();
  let state = 'queued', answer: string | null = null, revision = 0;
  let failReply = false, allowed = true, budgetAllowed = true, hostHeld = false, releaseFails = false;
  let hostAnswers = 0, reservations = 0, hostReleases = 0;
  let afterAction: ((action: string) => void) | undefined;
  let onAnswer: (() => Promise<void>) | undefined;
  let answerPatch: Record<string, unknown> = {};
  const transport = { async signedPost(route: string, payload: unknown) {
    const body = payload as Record<string, unknown>, action = String(body.action);
    actions.push({ action, body }); afterAction?.(action);
    if (action === 'reply' && failReply) throw new Error('private transport diagnostic');
    const envelope = { ok: true, organizationId: identity.organizationId, correlationId: uuid(90) };
    if (route.endsWith('provider-sessions')) {
      if (action !== 'inspect') revision++;
      return { ...envelope, registration: revision === 0 ? null : {
        bindingId: binding.bindingId, workspaceId: binding.workspaceId, endpointId: binding.endpointId,
        repositoryBindingId: binding.repositoryBindingId, membershipId: binding.membershipId,
        deviceId: binding.deviceId, provider: 'codex', mode: 'cooperative', revision,
        state: 'attached', leaseUntil: new Date(Date.now() + 60000).toISOString(), replay: false } };
    }
    if (action === 'inbox') return { ...envelope, result: { offers: state === 'queued' ? [question] : [] } };
    if (action === 'accept') state = 'accepted';
    if (action === 'reply') { state = String(body.outcome); answer = String(body.answer); }
    if (action === 'read') return { ...envelope, result: {
      questionId: question.questionId, taskId: question.taskId, targetBindingId: binding.bindingId,
      state, answer, failureCode: state === 'failed' ? 'execution_failed' : null,
      replyReceiptHash: ['answered', 'failed'].includes(state) ? `sha256:${'a'.repeat(64)}` : null } };
    return { ...envelope, result: { questionId: question.questionId, taskId: question.taskId,
      targetBindingId: binding.bindingId, state, replay: false } };
  } };
  const host = { async tryAcquireCurrentDelivery() {
    if (hostHeld) return { state: 'busy' as const };
    if (context?.state !== 'ready') return { state: context?.state ?? 'stopped' };
    hostHeld = true;
    return { state: 'acquired' as const, lease: {
      assertHeld: async () => hostHeld,
      currentSession: async () => context,
      answerInCurrentSession: async () => {
        hostAnswers++; await onAnswer?.();
        return { sessionId: binding.sessionId, questionId: question.questionId, taskId: question.taskId,
          nonce: question.nonce, answer: 'Use signed catalog generation thirteen.', ...answerPatch };
      },
      release: async () => { hostReleases++; if (releaseFails) throw new Error('private cleanup diagnostic'); hostHeld = false; },
    } };
  } };
  const input = { vault, bindingId: binding.bindingId, identity, nativeSessionId: binding.sessionId,
    workspaceRoot: binding.workspaceRoot, host, channelTransport: transport,
    verifier: { resolvePublicKey: () => publicKey,
      consume: async (id: string) => { if (used.has(id)) return false; used.add(id); return true; } },
    authorizeContent: async () => allowed,
    budget: { reserve: async () => { reservations++; return budgetAllowed; } },
  };
  return { vault, binding, question, actions, used, host, input,
    setContext: (value: OriginalSessionContext | null) => { context = value; }, getContext: () => context!,
    counts: () => ({ hostAnswers, reservations, hostReleases, hostHeld }),
    setReplyFailure: (value: boolean) => { failReply = value; },
    setAllowed: (value: boolean) => { allowed = value; }, setBudget: (value: boolean) => { budgetAllowed = value; },
    setReleaseFailure: (value: boolean) => { releaseFails = value; },
    patchAnswer: (value: Record<string, unknown>) => { answerPatch = value; },
    afterAction: (fn: typeof afterAction) => { afterAction = fn; }, onAnswer: (fn: typeof onAnswer) => { onAnswer = fn; },
  };
}

test('metadata or MCP configuration alone cannot construct an original-session runtime', async () => {
  const f = await fixture();
  try {
    for (const host of [null, { session_id: f.binding.sessionId, cwd: f.binding.workspaceRoot }]) {
      const result = await runOriginalSessionInboxOnce({ ...f.input, host: host as never });
      assert.deepEqual(result, { state: 'not_supported', reason: 'current_session_delivery_api_unavailable' });
    }
    assert.equal(f.actions.length, 0); assert.equal(f.counts().hostAnswers, 0);
  } finally { f.vault.close(); }
});

test('Claude has an explicit unsupported consumer boundary, never a fresh-provider fallback', async () => {
  const f = await fixture();
  try {
    const result = await runOriginalSessionInboxOnce({ ...f.input, identity: { ...f.input.identity, provider: 'claude' } });
    assert.deepEqual(result, { state: 'not_supported', reason: 'provider_in_session_consumer_unavailable' });
    assert.equal(f.actions.length, 0); assert.equal(f.counts().hostReleases, 0);
  } finally { f.vault.close(); }
});

test('busy, pending human question, and stopped sessions defer before consumer effects', async t => {
  for (const state of ['busy', 'pending_user', 'stopped'] as const) await t.test(state, async () => {
    const f = await fixture(); f.setContext({ ...f.getContext(), state });
    try {
      assert.deepEqual(await runOriginalSessionInboxOnce(f.input), { state: 'deferred', reason: state });
      assert.equal(f.actions.length, 0); assert.equal(f.used.size, 0); assert.equal(f.counts().reservations, 0);
    } finally { f.vault.close(); }
  });
});

test('runtime owner, all seven worker-scope fields, and exact workspace must agree', async t => {
  for (const key of ['organizationId', 'repositoryBindingId', 'workspaceId', 'endpointId', 'membershipId',
    'deviceId', 'provider', 'sessionId', 'workspaceRoot'] as const) await t.test(key, async () => {
    const f = await fixture(); f.setContext({ ...f.getContext(), [key]: key === 'provider' ? 'claude' : 'foreign' });
    try {
      await assert.rejects(runOriginalSessionInboxOnce(f.input), /original_session_host/);
      assert.equal(f.actions.length, 0); assert.equal(f.counts().hostAnswers, 0);
      assert.equal(f.counts().hostReleases, 1);
    } finally { f.vault.close(); }
  });
});

test('a real cooperative consumer receives the exact nonce-bound answer in POSIX and Windows fixtures', async t => {
  for (const workspace of ['/qualified/original/repo', 'C:\\qualified\\original\\repo']) await t.test(workspace, async () => {
    const f = await fixture(workspace);
    try {
      assert.equal((await runOriginalSessionInboxOnce(f.input)).state, 'answered');
      assert.equal(f.counts().hostAnswers, 1); assert.equal(f.counts().hostReleases, 1);
      assert.equal(f.counts().hostHeld, false); assert.equal(f.used.size, 1);
      assert.deepEqual(f.actions.map(x => x.action), ['inspect', 'attach', 'inbox', 'accept', 'reply']);
      assert.equal(f.actions.at(-1)!.body.answer, 'Use signed catalog generation thirteen.');
      assert.equal(f.vault.listProviderSessionReplies(f.binding.bindingId, f.input.identity).length, 0);
    } finally { f.vault.close(); }
  });
});

test('foreign session, question, task, or nonce in host completion never becomes an answered reply', async t => {
  for (const key of ['sessionId', 'questionId', 'taskId', 'nonce']) await t.test(key, async () => {
    const f = await fixture(); f.patchAnswer({ [key]: uuid(99), answer: 'private-forged-answer' });
    try {
      assert.equal((await runOriginalSessionInboxOnce(f.input)).state, 'failed');
      assert.equal(f.actions.at(-1)!.body.outcome, 'failed');
      assert.equal(JSON.stringify(f.actions).includes('private-forged-answer'), false);
    } finally { f.vault.close(); }
  });
});

test('owner loss after computation suppresses any answer disclosure', async () => {
  const f = await fixture(); f.onAnswer(async () => { f.setContext(null); });
  try {
    await assert.rejects(runOriginalSessionInboxOnce(f.input), /original_session_host/);
    assert.equal(f.actions.some(x => x.action === 'reply'), false); assert.equal(f.counts().hostHeld, false);
  } finally { f.vault.close(); }
});

test('content and budget denials retain the existing consumer fences', async t => {
  for (const denial of ['content', 'budget'] as const) await t.test(denial, async () => {
    const f = await fixture(); if (denial === 'content') f.setAllowed(false); else f.setBudget(false);
    try {
      if (denial === 'content') await assert.rejects(runOriginalSessionInboxOnce(f.input), /original_session_host/);
      else assert.equal((await runOriginalSessionInboxOnce(f.input)).state, 'budget_denied');
      assert.equal(f.actions.some(x => x.action === 'accept'), false);
      assert.equal(f.used.size, 0); assert.equal(f.counts().hostAnswers, 0);
    } finally { f.vault.close(); }
  });
});

test('a lost reply acknowledgement is reconciled later without another answer or budget reservation', async () => {
  const f = await fixture(); f.setReplyFailure(true);
  try {
    assert.equal((await runOriginalSessionInboxOnce(f.input)).state, 'reply_pending');
    f.setReplyFailure(false);
    assert.equal((await runOriginalSessionInboxOnce(f.input)).state, 'reply_reconciled');
    assert.equal(f.counts().hostAnswers, 1); assert.equal(f.counts().reservations, 1);
  } finally { f.vault.close(); }
});

test('host delivery acquisition prevents overlap without starting another consumer', async () => {
  const f = await fixture(); let start!: () => void, finish!: () => void;
  const began = new Promise<void>(resolve => { start = resolve; });
  const gate = new Promise<void>(resolve => { finish = resolve; });
  f.onAnswer(async () => { start(); await gate; });
  const first = runOriginalSessionInboxOnce(f.input);
  try {
    await Promise.race([began, first.then(() => { throw new Error('original host handler was not entered'); })]);
    assert.deepEqual(await runOriginalSessionInboxOnce(f.input), { state: 'deferred', reason: 'busy' });
    finish(); assert.equal((await first).state, 'answered'); assert.equal(f.counts().hostAnswers, 1);
  } finally { finish(); await first.catch(() => undefined); f.vault.close(); }
});

test('unconfirmed host cleanup is not reported as success and does not replay delivery', async () => {
  const f = await fixture(); f.setReleaseFailure(true);
  try {
    await assert.rejects(runOriginalSessionInboxOnce(f.input), /original_session_host_cleanup_unconfirmed/);
    assert.equal(f.counts().hostAnswers, 1); assert.equal(f.counts().hostReleases, 1);
    assert.equal(f.actions.filter(x => x.action === 'reply').length, 1);
  } finally { f.vault.close(); }
});

test('runtime exception text and secret answers are not disclosed through the adapter', async t => {
  for (const mode of ['exception', 'secret'] as const) await t.test(mode, async () => {
    const f = await fixture();
    if (mode === 'exception') f.onAnswer(async () => { throw new Error('private-native-runtime-token'); });
    else f.patchAnswer({ answer: 'api_key=synthetic-private-native-runtime-token' });
    try {
      const result = await runOriginalSessionInboxOnce(f.input);
      assert.equal(result.state, mode === 'exception' ? 'failed' : 'reply_pending');
      assert.equal(JSON.stringify(result).includes('private-native-runtime-token'), false);
      assert.equal(JSON.stringify(f.actions).includes('private-native-runtime-token'), false);
    } finally { f.vault.close(); }
  });
});

test('expired, forged, cross-tenant and cross-recipient offers never execute in the original session', async t => {
  for (const mode of ['expired', 'signature', 'organization', 'member', 'endpoint'] as const) await t.test(mode, async () => {
    const f = await fixture();
    if (mode === 'expired') f.question.expiresAt = new Date(Date.now() - 1000).toISOString();
    if (mode === 'organization') f.question.organizationId = 'org_foreign_fixture';
    if (mode === 'member') f.question.target.membershipId = uuid(91);
    if (mode === 'endpoint') f.question.target.endpointId = uuid(92);
    const { signature: _signature, ...unsigned } = f.question;
    f.question.signature = signCanonicalObject(unsigned, privateKey);
    if (mode === 'signature') f.question.signature = signCanonicalObject({ ...unsigned, nonce: uuid(93) }, privateKey);
    try {
      await assert.rejects(runOriginalSessionInboxOnce(f.input), /original_session_host/);
      assert.equal(f.actions.some(x => x.action === 'accept'), false); assert.equal(f.counts().hostAnswers, 0);
    } finally { f.vault.close(); }
  });
});

test('replay rejection and a newly pending human question after acceptance suppress execution', async t => {
  for (const mode of ['replayed', 'pending_after_accept'] as const) await t.test(mode, async () => {
    const f = await fixture();
    if (mode === 'replayed') f.used.add(f.question.questionId);
    else f.afterAction(action => { if (action === 'accept') f.setContext({ ...f.getContext(), state: 'pending_user' }); });
    try {
      await assert.rejects(runOriginalSessionInboxOnce(f.input), /original_session_host/);
      assert.equal(f.counts().hostAnswers, 0); assert.equal(f.actions.some(x => x.action === 'reply'), false);
    } finally { f.vault.close(); }
  });
});

test('binding ownership and native thread identity must match before any network action', async t => {
  for (const mode of ['bridge', 'native_session'] as const) await t.test(mode, async () => {
    const f = await fixture(), getBinding = f.vault.getProviderSessionBinding.bind(f.vault);
    f.vault.getProviderSessionBinding = (...args) => {
      const value = getBinding(...args);
      return value ? { ...value, ...(mode === 'bridge' ? { owner: 'dharma_bridge' as const } : { sessionId: uuid(97) }) } : null;
    };
    try {
      await assert.rejects(runOriginalSessionInboxOnce(f.input), /original_session_host/);
      assert.equal(f.actions.length, 0); assert.equal(f.counts().hostAnswers, 0);
    } finally { f.vault.close(); }
  });
});

test('a malformed acquired host permit is released when cleanup remains possible', async () => {
  const f = await fixture(); let releases = 0;
  try {
    const host = { tryAcquireCurrentDelivery: async () => ({ state: 'acquired', lease: {
      release: async () => { releases++; },
    } }) };
    await assert.rejects(runOriginalSessionInboxOnce({ ...f.input, host: host as never }), /original_session_host/);
    assert.equal(releases, 1); assert.equal(f.actions.length, 0);
  } finally { f.vault.close(); }
});

test('expiry during reservation prevents native execution and acceptance', async t => {
  const f = await fixture();
  f.question.expiresAt = new Date(Date.now() + 30000).toISOString();
  const { signature: _signature, ...unsigned } = f.question;
  f.question.signature = signCanonicalObject(unsigned, privateKey);
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  try {
    await assert.rejects(runOriginalSessionInboxOnce({ ...f.input,
      budget: { reserve: async () => { t.mock.timers.tick(31000); return true; } },
    }), /original_session_host/);
    assert.equal(f.actions.some(x => x.action === 'accept'), false); assert.equal(f.counts().hostAnswers, 0);
  } finally { f.vault.close(); }
});

test('caller mutation cannot retarget the captured local worker scope during a turn', async () => {
  const f = await fixture(), args = { ...f.input };
  args.budget = { reserve: async () => {
    args.identity = { ...args.identity, organizationId: 'org_mutated_fixture', deviceId: uuid(98) };
    args.nativeSessionId = uuid(99); args.workspaceRoot = '/foreign/caller/workspace';
    return true;
  } };
  try {
    assert.equal((await runOriginalSessionInboxOnce(args)).state, 'answered');
    assert.equal(f.actions.at(-1)!.body.bindingId, f.binding.bindingId);
    assert.equal(f.actions.at(-1)!.body.workspaceId, f.binding.workspaceId);
    assert.equal(f.actions.at(-1)!.body.endpointId, f.binding.endpointId);
    assert.equal(f.actions.at(-1)!.body.repositoryBindingId, f.binding.repositoryBindingId);
    assert.equal(f.counts().hostAnswers, 1);
  } finally { f.vault.close(); }
});

test('host acquisition failures remain unconfirmed without leaking or retrying', async () => {
  const f = await fixture(); let calls = 0;
  try {
    await assert.rejects(runOriginalSessionInboxOnce({ ...f.input, host: {
      tryAcquireCurrentDelivery: async () => { calls++; throw new Error('private-acquire-token'); },
    } }), { message: 'original_session_host_acquisition_unconfirmed' });
    assert.equal(calls, 1); assert.equal(f.actions.length, 0);
  } finally { f.vault.close(); }
});
