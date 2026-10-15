import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, randomBytes } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import test, { describe } from 'node:test';
import { canonicalize, signCanonicalObject } from '@dharma-ai-labs/agent-fabric-contracts';
import { LocalVault, type LocalProviderSessionBinding } from '@dharma-ai-labs/agent-fabric-local-vault';
import type { CodexStdioTransport } from '@dharma-ai-labs/agent-fabric-provider-adapters/experimental/codex-transport';
import { openCodexBoundSession, runCodexBoundSessionQuestion } from './codexBoundSession.js';
import { openCodexInboxSession } from './codexInboxSession.js';
import { reconcileProviderSessionReply } from './providerSessionReplyRecovery.js';
import { NamedPeerContentAuthorizationError } from './namedPeerContentAuthorization.js';
import { NamedSessionBudget } from './namedSessionBudget.js';

const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const ids = {
  repositoryBindingId: '40000000-0000-4000-8000-000000000001',
  workspaceId: '40000000-0000-4000-8000-000000000002',
  endpointId: '40000000-0000-4000-8000-000000000003',
  membershipId: '40000000-0000-4000-8000-000000000004',
  deviceId: '40000000-0000-4000-8000-000000000005',
  bindingId: '40000000-0000-4000-8000-000000000006',
  threadId: '40000000-0000-4000-8000-000000000007',
};

function signedQuestion(binding: LocalProviderSessionBinding, now: Date, questionId = '40000000-0000-4000-8000-000000000010') {
  const unsigned = {
    schema: 'dharma.session-question/v1', questionId,
    taskId: '40000000-0000-4000-8000-000000000011',
    organizationId: binding.organizationId, repositoryBindingId: binding.repositoryBindingId,
    source: { workspaceId: '40000000-0000-4000-8000-000000000012',
      endpointId: '40000000-0000-4000-8000-000000000013',
      membershipId: '40000000-0000-4000-8000-000000000014',
      deviceId: '40000000-0000-4000-8000-000000000015' },
    target: { workspaceId: binding.workspaceId, endpointId: binding.endpointId,
      membershipId: binding.membershipId, deviceId: binding.deviceId,
      bindingId: binding.bindingId, provider: binding.provider },
    category: 'code-review', question: 'Which catalog applies?',
    authority: { mode: 'read_only', readPaths: ['.'], network: 'deny', maximumProviderCostCents: 25 },
    createdAt: new Date(now.getTime() - 1_000).toISOString(),
    expiresAt: new Date(now.getTime() + 60_000).toISOString(),
    nonce: '40000000-0000-4000-8000-000000000016', signerKeyVersion: 'test-v1',
  };
  return { ...unsigned, signature: signCanonicalObject(unsigned, privateKey) };
}

function fakeTransport(binding: LocalProviderSessionBinding, options: { failedTurn?: boolean; closeFails?: boolean; silentTurn?: boolean; answer?: string;
  filesystemRules?: Record<string, string> } = {}) {
  const calls: string[] = [];
  const listeners = new Set<(event: unknown) => void>();
  let closed = false;
  const lifetime = new AbortController();
  const transport: CodexStdioTransport = {
    signal: lifetime.signal,
    onToolCall() { return () => {}; },
    onNotification(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    async close() {
      calls.push('close');
      lifetime.abort();
      if (options.closeFails) throw new Error('process_still_running');
      closed = true;
    },
    async request(method) {
      calls.push(method);
      if (method === 'permissionProfile/list') return { data: [{ id: 'dharma_bridge', allowed: true }] };
      if (method === 'config/read') return { config: { permissions: { dharma_bridge: {
        extends: null, workspace_roots: null,
        filesystem: { ':minimal': 'read', ...options.filesystemRules, ':workspace_roots': { '.': 'read' } },
        network: { enabled: false },
      } } } };
      if (method === 'thread/read') return { thread: { id: binding.sessionId,
        cwd: binding.workspaceRoot, status: { type: 'idle' } } };
      if (method === 'thread/resume') return { thread: { id: binding.sessionId,
        cwd: binding.workspaceRoot, status: { type: 'idle' } } };
      if (method === 'turn/start') {
        if (options.silentTurn) return { turn: { id: 'turn-1' } };
        queueMicrotask(() => {
          for (const listener of listeners) listener({ method: 'turn/completed', params: {
            threadId: binding.sessionId, turn: { id: 'turn-1',
              status: options.failedTurn ? 'failed' : 'completed',
              items: [{ type: 'agentMessage', phase: 'final_answer', text: options.answer ?? 'Catalog generation 13.' }],
            },
          } });
        });
        return { turn: { id: 'turn-1' } };
      }
      if (method === 'turn/interrupt') return {};
      throw new Error(`unexpected:${method}`);
    },
  };
  return { transport, calls, isClosed: () => closed };
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'dharma-bound-session-'));
  const now = new Date();
  const binding: LocalProviderSessionBinding = {
    schema: 'dharma.local-provider-session-binding/v1', owner: 'dharma_bridge',
    organizationId: 'org_test', repositoryBindingId: ids.repositoryBindingId,
    workspaceId: ids.workspaceId, endpointId: ids.endpointId,
    membershipId: ids.membershipId, deviceId: ids.deviceId,
    bindingId: ids.bindingId, provider: 'codex', sessionId: ids.threadId,
    workspaceRoot: resolve(root, 'repo'), createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + 3_600_000).toISOString(),
    maximumProviderCostCents: 25,
  };
  const identity = {
    organizationId: binding.organizationId, repositoryBindingId: binding.repositoryBindingId,
    workspaceId: binding.workspaceId, endpointId: binding.endpointId,
    membershipId: binding.membershipId, deviceId: binding.deviceId, provider: binding.provider,
  };
  const masterKey = randomBytes(32);
  const vault = await LocalVault.open({ root, masterKey });
  vault.saveProviderSessionBinding(binding);
  const used = new Set<string>();
  const verifier = {
    resolvePublicKey: (version: string) => version === 'test-v1' ? publicKey : null,
    consume: async (id: string) => { if (used.has(id)) return false; used.add(id); return true; },
  };
  return { vault, binding, identity, verifier, now, root, masterKey, budget: { reserve: async () => true } };
}

test('retained reply diagnostic preserves encrypted content and never admits provider work', async () => {
  const f = await fixture();
  const question = signedQuestion(f.binding, f.now), answer = 'Catalog generation 13.';
  const encryptedBytes = Buffer.from(canonicalize({
    schema: 'dharma.provider-session-completion/v1', organizationId: f.binding.organizationId,
    repositoryBindingId: f.binding.repositoryBindingId, membershipId: f.binding.membershipId,
    deviceId: f.binding.deviceId, workspaceId: f.binding.workspaceId, endpointId: f.binding.endpointId,
    questionId: question.questionId, taskId: question.taskId, bindingId: f.binding.bindingId,
    targetEndpointId: f.binding.endpointId, answer, answerHash: `sha256:${createHash('sha256').update(answer).digest('hex')}`,
  }));
  const hash = await f.vault.stageProviderSessionReply(f.binding.bindingId, f.identity, question.questionId, encryptedBytes);
  let reads = 0, replies = 0;
  try {
    const result = await reconcileProviderSessionReply({ ...f, bindingId: f.binding.bindingId, channel: {
      read: async () => { reads++; return { questionId: question.questionId, taskId: question.taskId,
        targetBindingId: f.binding.bindingId, state: 'accepted' as const, answer: null, failureCode: null,
        replyReceiptHash: null, correlationId: ids.threadId }; },
      reply: async () => { replies++; throw new NamedPeerContentAuthorizationError('private_local_path'); },
    } });
    assert.deepEqual(result, { state: 'reply_pending', questionId: question.questionId, taskId: question.taskId,
      completionHash: hash, reasonCode: 'content_or_contract_blocked', blocker: 'private_local_path' });
    assert.equal(reads, 1); assert.equal(replies, 1);
    assert.equal(JSON.stringify(result).includes(answer), false);
    assert.equal(f.vault.listProviderSessionReplies(f.binding.bindingId, f.identity).length, 1);
    assert.deepEqual(await f.vault.getBlob(hash), encryptedBytes);
  } finally { f.vault.close(); }
});

test('unqualified native host cannot open or advertise a bridge-owned provider',
  { skip: process.platform === 'linux' }, async () => {
    const f = await fixture();
    let opened = false;
    try {
      await assert.rejects(openCodexBoundSession({ ...f, bindingId: f.binding.bindingId,
        openTransport: async () => { opened = true; return fakeTransport(f.binding).transport; } }),
      /codex_session_sandbox_unqualified/);
      assert.equal(opened, false);
      const lease = f.vault.tryAcquireProviderSessionLease(f.binding.bindingId, f.identity);
      assert.ok(lease);
      lease.release();
    } finally { f.vault.close(); }
  });

describe('qualified Linux retained Codex consumer', { skip: process.platform !== 'linux' }, () => {
test('retained owner passes trusted prepared rules through without accepting an altered denial', async () => {
  const expected = { '/opt/public-codex': 'read', '/private/codex': 'deny' } as const;
  for (const altered of [false, true]) {
    const f = await fixture();
    const remote = fakeTransport(f.binding, { filesystemRules: altered
      ? { ...expected, '/private/codex': 'read' } : expected });
    let reserved = false;
    const owner = await openCodexBoundSession({ ...f, bindingId: f.binding.bindingId,
      openTransport: async () => remote.transport, additionalFilesystemRules: expected,
      budget: { reserve: async () => { reserved = true; return true; } } });
    try {
      const result = owner.runQuestion({ question: signedQuestion(f.binding, f.now), now: f.now });
      if (altered) {
        await assert.rejects(result, /codex_session_profile_unavailable/);
        assert.equal(reserved, false);
        assert.equal(remote.calls.includes('turn/start'), false);
      } else {
        assert.equal((await result).providerThreadId, f.binding.sessionId);
        assert.equal(reserved, true);
      }
    } finally { await owner.close(); f.vault.close(); }
  }
});
test('retained provider and owner use the renewed deadline without replacing the conversation', async () => {
  const f = await fixture(), remote = fakeTransport(f.binding);
  const owner = await openCodexBoundSession({ ...f, bindingId: f.binding.bindingId, openTransport: async () => remote.transport });
  try {
    const later = new Date(Date.parse(f.binding.expiresAt) + 1000);
    f.vault.renewProviderSessionBinding(f.binding.bindingId, f.identity, f.binding.expiresAt,
      new Date(later.getTime() + 86400000).toISOString(), later);
    const result = await owner.runQuestion({ question: signedQuestion(f.binding, later), now: later });
    assert.equal(result.bindingId, f.binding.bindingId);
    assert.equal(result.providerThreadId, f.binding.sessionId);
    assert.equal(remote.calls.filter(call => call === 'turn/start').length, 1);
  } finally { await owner.close(); f.vault.close(); }
});
for (const scenario of ['current', 'denied', 'forged', 'expired'] as const) test('peer context is loaded lazily per offered question before acceptance: '
  + scenario, async () => {
  const deniedContext = scenario === 'denied';
  const f = await fixture(), remote = fakeTransport(f.binding);
  let offered = false, accepted = false, loads = 0, reserves = 0;
  let q = signedQuestion(f.binding, f.now), context = 'CURRENT_SIGNED_V8';
  if (scenario === 'forged') q = {...q, signature: 'invalid-fixture-signature'};
  if (scenario === 'expired') {
    const {signature: _signature, ...unsigned} = q;
    const expired = {...unsigned, expiresAt: new Date(f.now.getTime() - 1).toISOString()};
    q = {...expired, signature: signCanonicalObject(expired, privateKey)};
  }
  const prompts: string[] = [], contexts: unknown[] = [];
  const request = remote.transport.request.bind(remote.transport);
  remote.transport.request = async (method, params) => {
    if (method === 'turn/start') {
      prompts.push(JSON.stringify(params.input));
      contexts.push(params.additionalContext);
    }
    return request(method, params);
  };
  const channelTransport = {async signedPost(route: string, input: unknown) {
    const body = input as Record<string, unknown>;
    const envelope = {ok: true, organizationId: f.binding.organizationId, correlationId: ids.threadId};
    if (route.endsWith('provider-sessions')) return {...envelope, registration: {
      bindingId: f.binding.bindingId, workspaceId: f.binding.workspaceId, endpointId: f.binding.endpointId,
      repositoryBindingId: f.binding.repositoryBindingId, membershipId: f.binding.membershipId,
      deviceId: f.binding.deviceId, provider: 'codex', mode: 'bridge_owned', revision: 1, state: 'attached',
      leaseUntil: new Date(Date.now() + 60000).toISOString(), replay: false}};
    if (body.action === 'inbox') return {...envelope, result: {offers: offered && !accepted ? [q] : []}};
    if (body.action === 'accept') accepted = true;
    return {...envelope, result: {questionId: q.questionId, taskId: q.taskId,
      targetBindingId: f.binding.bindingId, state: body.action === 'reply' ? 'answered' : 'accepted', replay: false}};
  }};
  const inbox = await openCodexInboxSession({...f, bindingId: f.binding.bindingId, expectedRevision: 0,
    channelTransport, authorizeContent: async () => true,
    budget: {reserve: async () => {reserves++; return true;}}, openTransport: async () => remote.transport});
  const options = {loadRepositoryContext: async (offer: typeof q) => {
    assert.deepEqual(offer, q);
    assert.equal(accepted, false); loads++;
    if (deniedContext) throw new Error('synthetic_context_denied');
    return context;
  }};
  try {
    assert.equal((await Reflect.apply(inbox.runNext, inbox, [options])).state, 'idle');
    assert.equal(loads, 0); offered = true;
    if (scenario === 'forged' || scenario === 'expired') {
      await assert.rejects(Reflect.apply(inbox.runNext, inbox, [options]), /provider_session_channel_response/);
      assert.equal(loads, 0); assert.equal(reserves, 0); assert.equal(accepted, false); assert.equal(prompts.length, 0);
    } else if (deniedContext) {
      await assert.rejects(Reflect.apply(inbox.runNext, inbox, [options]), /synthetic_context_denied/);
      assert.equal(loads, 1); assert.equal(reserves, 0); assert.equal(accepted, false); assert.equal(prompts.length, 0);
    } else {
      assert.equal((await Reflect.apply(inbox.runNext, inbox, [options])).state, 'answered');
      assert.equal(loads, 1);
      assert.deepEqual(contexts[0], { dharma_signed_repository: { kind: 'untrusted', value: 'CURRENT_SIGNED_V8' } });
      assert.doesNotMatch(prompts[0]!, /CURRENT_SIGNED_V8/);
      context = 'CURRENT_SIGNED_V9'; accepted = false;
      q = signedQuestion(f.binding, f.now, '40000000-0000-4000-8000-000000000020');
      assert.equal((await Reflect.apply(inbox.runNext, inbox, [options])).state, 'answered');
      assert.equal(loads, 2);
      assert.deepEqual(contexts[1], { dharma_signed_repository: { kind: 'untrusted', value: 'CURRENT_SIGNED_V9' } });
      assert.doesNotMatch(prompts[1]!, /CURRENT_SIGNED_V8/);
    }
  } finally {await inbox.close(); f.vault.close();}
});

test('default inbox startup recovers the server revision with its retained local owner and no provider turn', async () => {
  const f = await fixture(), remote = fakeTransport(f.binding), actions: string[] = [];
  let reserves = 0;
  const transport = { async signedPost(_route: string, input: unknown) {
    const body = input as Record<string, unknown>; actions.push(String(body.action));
    if (body.action === 'attach') assert.equal(body.expectedRevision, 12);
    return { ok: true, organizationId: f.binding.organizationId, correlationId: ids.threadId, registration: {
      bindingId: f.binding.bindingId, workspaceId: f.binding.workspaceId, endpointId: f.binding.endpointId,
      repositoryBindingId: f.binding.repositoryBindingId, membershipId: f.binding.membershipId,
      deviceId: f.binding.deviceId, provider: 'codex', mode: 'bridge_owned',
      revision: body.action === 'inspect' ? 12 : 13, state: 'attached',
      leaseUntil: new Date(Date.now() + (body.action === 'inspect' ? -60_000 : 60_000)).toISOString(), replay: false } };
  } };
  const inbox = await openCodexInboxSession({ ...f, bindingId: f.binding.bindingId,
    channelTransport: transport, authorizeContent: async () => true,
    budget: { reserve: async () => { reserves += 1; return true; } }, openTransport: async () => remote.transport });
  try {
    assert.deepEqual(actions, ['inspect', 'attach']);
    assert.equal(reserves, 0); assert.equal(remote.calls.includes('turn/start'), false);
  } finally { await inbox.close(); f.vault.close(); }
});

test('new completed answer reports a fixed content blocker without upload or provider replay', async () => {
  const f = await fixture(), remote = fakeTransport(f.binding), question = signedQuestion(f.binding, f.now);
  let replies = 0, reserves = 0;
  const transport = { async signedPost(route: string, input: unknown) {
    const body = input as Record<string, unknown>;
    const envelope = { ok: true, organizationId: f.binding.organizationId, correlationId: ids.threadId };
    if (route.endsWith('provider-sessions')) return { ...envelope, registration: {
      bindingId: f.binding.bindingId, workspaceId: f.binding.workspaceId, endpointId: f.binding.endpointId,
      repositoryBindingId: f.binding.repositoryBindingId, membershipId: f.binding.membershipId,
      deviceId: f.binding.deviceId, provider: 'codex', mode: 'bridge_owned', revision: 1, state: 'attached',
      leaseUntil: new Date(Date.now() + 60_000).toISOString(), replay: false } };
    if (body.action === 'inbox') return { ...envelope, result: { offers: [question] } };
    if (body.action === 'reply') replies++;
    return { ...envelope, result: { questionId: question.questionId, taskId: question.taskId,
      targetBindingId: f.binding.bindingId, state: 'accepted', replay: false } };
  } };
  const inbox = await openCodexInboxSession({ ...f, bindingId: f.binding.bindingId, expectedRevision: 0,
    channelTransport: transport, authorizeContent: async (_content, kind) => {
      if (kind === 'answer') throw new NamedPeerContentAuthorizationError('private_local_path');
      return true;
    }, budget: { reserve: async () => { reserves++; return true; } }, openTransport: async () => remote.transport });
  try {
    const result = await inbox.runNext();
    assert.equal(result.state, 'reply_pending');
    assert.ok('blocker' in result && result.blocker === 'private_local_path');
    assert.ok('reasonCode' in result && result.reasonCode === 'content_or_contract_blocked');
    assert.ok('providerShutdownConfirmed' in result && result.providerShutdownConfirmed);
    assert.equal(replies, 0); assert.equal(reserves, 1); assert.equal(remote.isClosed(), true);
    assert.equal(remote.calls.filter(call => call === 'turn/start').length, 1);
    assert.equal(f.vault.listProviderSessionReplies(f.binding.bindingId, f.identity).length, 1);
    assert.equal(JSON.stringify(result).includes('Catalog generation 13.'), false);
    await assert.rejects(inbox.runNext(), /codex_inbox_session_unavailable/);
    assert.equal(reserves, 1);
  } finally { await inbox.close(); f.vault.close(); }
});

test('reopened inbox reconciles retained answers without executing or reserving another provider turn', async t => {
  for (const remoteState of ['accepted', 'answered', 'conflicting', 'expired', 'lost_reply', 'denied_policy'] as const) {
    await t.test(remoteState, async () => {
      const f = await fixture(), remote = fakeTransport(f.binding);
      const question = signedQuestion(f.binding, f.now);
      const answer = 'Catalog generation 13.';
      const completion = {
        schema: 'dharma.provider-session-completion/v1', organizationId: f.binding.organizationId,
        repositoryBindingId: f.binding.repositoryBindingId, membershipId: f.binding.membershipId,
        deviceId: f.binding.deviceId, workspaceId: f.binding.workspaceId, endpointId: f.binding.endpointId,
        questionId: question.questionId, taskId: question.taskId, bindingId: f.binding.bindingId,
        targetEndpointId: f.binding.endpointId, answer, answerHash: `sha256:${createHash('sha256').update(answer).digest('hex')}`,
      };
      const hash = await f.vault.stageProviderSessionReply(f.binding.bindingId, f.identity,
        question.questionId, Buffer.from(canonicalize(completion)));
      f.vault.close();
      f.vault = await LocalVault.open({ root: f.root, masterKey: f.masterKey });
      let replies = 0, reads = 0, reserves = 0;
      const transport = { async signedPost(route: string, input: unknown) {
        const body = input as Record<string, unknown>;
        const envelope = { ok: true, organizationId: f.binding.organizationId, correlationId: ids.threadId };
        if (route.endsWith('provider-sessions')) return { ...envelope, registration: {
          bindingId: f.binding.bindingId, workspaceId: f.binding.workspaceId, endpointId: f.binding.endpointId,
          repositoryBindingId: f.binding.repositoryBindingId, membershipId: f.binding.membershipId,
          deviceId: f.binding.deviceId, provider: 'codex', mode: 'bridge_owned',
          revision: Number(body.expectedRevision) + 1, state: body.action === 'detach' ? 'detached' : 'attached',
          leaseUntil: new Date(Date.now() + 60_000).toISOString(), replay: false } };
        if (body.action === 'reply') {
          replies += 1;
          assert.equal(body.answer, answer);
          if (remoteState === 'lost_reply') throw new Error('synthetic lost acknowledgement');
          return { ...envelope, result: { questionId: question.questionId, taskId: question.taskId,
            targetBindingId: f.binding.bindingId, state: 'answered', replay: false } };
        }
        assert.equal(body.action, 'read'); reads += 1;
        const state = remoteState === 'expired' ? 'expired'
          : ['accepted', 'lost_reply', 'denied_policy'].includes(remoteState) && replies === 0 ? 'accepted' : 'answered';
        return { ...envelope, result: { questionId: question.questionId, taskId: question.taskId,
          targetBindingId: f.binding.bindingId, state, failureCode: null,
          answer: state === 'answered' ? remoteState === 'conflicting' ? 'Different answer.' : answer : null,
          replyReceiptHash: state === 'answered' ? `sha256:${'a'.repeat(64)}` : null } };
      } };
      const inbox = await openCodexInboxSession({ ...f, bindingId: f.binding.bindingId, expectedRevision: 0,
        channelTransport: transport, authorizeContent: async () => remoteState !== 'denied_policy',
        budget: { reserve: async () => { reserves += 1; return true; } }, openTransport: async () => remote.transport });
      try {
        const result = await inbox.runNext();
        const remainsPending = ['conflicting', 'lost_reply', 'denied_policy'].includes(remoteState);
        assert.equal(result.state, remoteState === 'expired' ? 'reply_quarantined' : remainsPending ? 'reply_pending' : 'reply_reconciled');
        assert.equal(replies, ['accepted', 'lost_reply'].includes(remoteState) ? 1 : 0);
        assert.equal(reads, remoteState === 'accepted' ? 2 : 1);
        assert.equal(reserves, 0); assert.equal(remote.calls.includes('turn/start'), false);
        assert.equal(f.vault.listProviderSessionReplies(f.binding.bindingId, f.identity).length,
          remainsPending ? 1 : 0);
        assert.deepEqual(await f.vault.getBlob(hash), Buffer.from(canonicalize(completion)));
        if (remoteState === 'expired') {
          assert.equal(remote.isClosed(), false);
          assert.equal(await reconcileProviderSessionReply({ vault: f.vault, bindingId: f.binding.bindingId,
            identity: f.identity, channel: {
              read: async () => { throw new Error('expired reply must not be retried'); },
              reply: async () => { throw new Error('expired reply must not be published'); },
            } }), null);
          await inbox.close();
          f.vault.close();
          f.vault = await LocalVault.open({ root: f.root, masterKey: f.masterKey });
          assert.equal(f.vault.listProviderSessionReplies(f.binding.bindingId, f.identity).length, 0);
          assert.deepEqual(await f.vault.getBlob(hash), Buffer.from(canonicalize(completion)));
        }
      } finally { await inbox.close(); f.vault.close(); }
    });
  }
});

test('signed inbox dispatch retains the selected thread and publishes answers without reopening a worker', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const f = await fixture(), remote = fakeTransport(f.binding);
  let opens = 0, accepted = false, replyCalls = 0, failReply = false, heartbeats = 0, detaches = 0;
  let offered = signedQuestion(f.binding, f.now);
  const transport = { async signedPost(route: string, input: unknown) {
    const body = input as Record<string, unknown>;
    if (body.action === 'heartbeat') heartbeats += 1;
    if (body.action === 'detach') detaches += 1;
    if (route.endsWith('provider-sessions')) return { ok: true, organizationId: f.binding.organizationId,
      correlationId: ids.threadId, registration: { bindingId: f.binding.bindingId, workspaceId: f.binding.workspaceId,
        endpointId: f.binding.endpointId, repositoryBindingId: f.binding.repositoryBindingId,
        membershipId: f.binding.membershipId, deviceId: f.binding.deviceId, provider: 'codex', mode: 'bridge_owned',
        revision: Number(body.expectedRevision) + 1, state: body.action === 'detach' ? 'detached' : 'attached',
        leaseUntil: new Date(Date.now() + 60_000).toISOString(), replay: false } };
    if (body.action === 'inbox') return { ok: true, organizationId: f.binding.organizationId, correlationId: ids.threadId,
      result: { offers: accepted ? [] : [offered] } };
    if (body.action === 'accept') accepted = true;
    if (body.action === 'reply') { replyCalls += 1; if (failReply) throw new Error('synthetic-lost-reply'); }
    return { ok: true, organizationId: f.binding.organizationId, correlationId: ids.threadId,
      result: { questionId: offered.questionId, taskId: offered.taskId, targetBindingId: f.binding.bindingId,
        state: body.action === 'accept' ? 'accepted' : body.outcome, replay: false } };
  } };
  const inbox = await openCodexInboxSession({ ...f, bindingId: f.binding.bindingId, expectedRevision: 0,
    channelTransport: transport, authorizeContent: async () => true,
    openTransport: async () => { opens += 1; return remote.transport; } });
  try {
    assert.equal((await inbox.runNext()).state, 'answered');
    assert.equal((await inbox.runNext()).state, 'idle');
    assert.equal(opens, 1); assert.equal(replyCalls, 1);
    assert.equal(remote.calls.filter(method => method === 'turn/start').length, 1);
    assert.equal(remote.isClosed(), false);
    t.mock.timers.tick(20_000);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(heartbeats, 1); assert.equal(opens, 1);
    offered = signedQuestion(f.binding, f.now, '40000000-0000-4000-8000-000000000020');
    accepted = false; failReply = true;
    const pending = await inbox.runNext();
    assert.equal(pending.state, 'reply_pending');
    assert.ok('providerShutdownConfirmed' in pending && pending.providerShutdownConfirmed);
    assert.ok('reasonCode' in pending && pending.reasonCode === 'delivery_unconfirmed');
    assert.ok('completionHash' in pending);
    const checkpoint = JSON.parse((await f.vault.getBlob(pending.completionHash)).toString('utf8'));
    assert.equal(checkpoint.questionId, offered.questionId); assert.equal(checkpoint.bindingId, f.binding.bindingId);
    assert.equal(checkpoint.answer, 'Catalog generation 13.'); assert.equal(checkpoint.organizationId, f.binding.organizationId);
    assert.equal(opens, 1); assert.equal(replyCalls, 2);
    await assert.rejects(inbox.runNext(), /codex_inbox_session_unavailable/);
    assert.equal(remote.calls.filter(method => method === 'turn/start').length, 2);
    t.mock.timers.tick(40_000);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(heartbeats, 1);
  } finally { await inbox.close(); f.vault.close(); }
  assert.equal(remote.isClosed(), true);
  assert.equal(detaches, 0);
});

test('timed-out accepted peer turn reports failure without extending authority or replaying the provider', async t => {
 for (const scenario of ['reported', 'lost_ack', 'revoked', 'close_unconfirmed'] as const) await t.test(scenario, async t => {
  t.mock.timers.enable({apis: ['Date', 'setTimeout', 'setInterval']});
  const f = await fixture(), remote = fakeTransport(f.binding, {silentTurn: true, closeFails: scenario === 'close_unconfirmed'});
  if (scenario === 'revoked') {
    const put = f.vault.putBlob.bind(f.vault);
    f.vault.putBlob = async (bytes, purpose) => {
      const hash = await put(bytes, purpose);
      if (purpose === 'provider-session-failed-turn') f.vault.revokeProviderSessionBinding(f.binding.bindingId, f.identity);
      return hash;
    };
  }
  const question = signedQuestion(f.binding, f.now), replies: Record<string, unknown>[] = [];
  let accepted = false;
  const channelTransport = {async signedPost(route: string, input: unknown) {
    const body = input as Record<string, unknown>;
    if (route.endsWith('provider-sessions')) return {ok: true, organizationId: f.binding.organizationId,
      correlationId: ids.threadId, registration: {bindingId: f.binding.bindingId, workspaceId: f.binding.workspaceId,
        endpointId: f.binding.endpointId, repositoryBindingId: f.binding.repositoryBindingId,
        membershipId: f.binding.membershipId, deviceId: f.binding.deviceId, provider: 'codex', mode: 'bridge_owned',
        revision: Number(body.expectedRevision) + 1, state: 'attached', leaseUntil: new Date(Date.now() + 120_000).toISOString(), replay: false}};
    if (body.action === 'inbox') return {ok: true, organizationId: f.binding.organizationId,
      correlationId: ids.threadId, result: {offers: accepted ? [] : [question]}};
    if (body.action === 'accept') accepted = true;
    if (body.action === 'reply') {
      replies.push(body); assert.equal(body.answer, ''); assert.equal(body.failureCode, 'execution_failed');
      assert.equal(remote.isClosed(), false, 'bounded failure delivery must retain the original owner');
      if (scenario === 'lost_ack') throw new Error('synthetic lost failure acknowledgement');
    }
    return {ok: true, organizationId: f.binding.organizationId, correlationId: ids.threadId,
      result: {questionId: question.questionId, taskId: question.taskId, targetBindingId: f.binding.bindingId,
        state: body.action === 'accept' ? 'accepted' : body.outcome, replay: false}};
  }};
  const inbox = await openCodexInboxSession({...f, bindingId: f.binding.bindingId, expectedRevision: 0,
    channelTransport, authorizeContent: async () => true, openTransport: async () => remote.transport});
  try {
    const pending = inbox.runNext();
    // Observe the actual turn admission before advancing the unchanged deadline.
    for (let i = 0; i < 100 && !remote.calls.includes('turn/start'); i++) await new Promise(resolve => setImmediate(resolve));
    assert.ok(remote.calls.includes('turn/start')); await new Promise(resolve => setImmediate(resolve));
    t.mock.timers.tick(60_001);
    const result = await pending;
    assert.equal(result.state, ['lost_ack', 'revoked'].includes(scenario) ? 'failure_reply_pending' : 'failed');
    assert.ok('providerShutdownConfirmed' in result);
    assert.equal(result.providerShutdownConfirmed, scenario !== 'close_unconfirmed');
    assert.ok('failureEvidenceHash' in result && typeof result.failureEvidenceHash === 'string');
    const evidence = JSON.parse((await f.vault.getBlob(result.failureEvidenceHash)).toString());
    assert.equal(evidence.code, 'codex_session_turn_timeout'); assert.equal(evidence.questionId, question.questionId);
    assert.equal('answer' in evidence, false); assert.equal('signature' in evidence, false);
    assert.equal(replies.length, scenario === 'revoked' ? 0 : 1);
    assert.equal(remote.isClosed(), scenario !== 'close_unconfirmed');
    assert.equal(remote.calls.filter(x => x === 'turn/start').length, 1);
    assert.equal(remote.calls.filter(x => x === 'turn/interrupt').length, 1);
    await assert.rejects(inbox.runNext(), /codex_inbox_session_unavailable/);
  } finally {
    if (scenario === 'close_unconfirmed') await assert.rejects(inbox.close(), /process_still_running/);
    else await inbox.close();
    f.vault.close();
  }
 });
});

test('standalone timed-out owner still closes without inbox failure-delivery authority', async () => {
  const f = await fixture(), remote = fakeTransport(f.binding, {silentTurn: true});
  const owner = await openCodexBoundSession({...f, bindingId: f.binding.bindingId, openTransport: async () => remote.transport});
  try {
    await assert.rejects(owner.runQuestion({question: signedQuestion(f.binding, f.now), timeoutMs: 1}), /codex_session_turn_timeout/);
    assert.equal(remote.isClosed(), true);
    await assert.rejects(owner.runQuestion({question: signedQuestion(f.binding, f.now)}), /codex_session_closed/);
  } finally {await owner.close(); f.vault.close();}
});

test('oversized completed peer answer publishes only a validation failure and retains encrypted evidence', async t => {
  for (const scenario of ['accepted_failure', 'lost_failure_ack', 'server_denied_failure', 'revoked_before_failure'] as const) {
    await t.test(scenario, async () => {
      const f = await fixture(), answer = 'x'.repeat(2013), remote = fakeTransport(f.binding, { answer });
      const question = signedQuestion(f.binding, f.now), actions: string[] = [], sent: Record<string, unknown>[] = [];
      let reserves = 0, stagedAnswers = 0;
      const stageReply = f.vault.stageProviderSessionReply.bind(f.vault);
      f.vault.stageProviderSessionReply = async (...args) => {
        stagedAnswers += 1;
        return stageReply(...args);
      };
      if (scenario === 'revoked_before_failure') {
        const putBlob = f.vault.putBlob.bind(f.vault);
        f.vault.putBlob = async (bytes, purpose) => {
          const hash = await putBlob(bytes, purpose);
          if (purpose === 'provider-session-rejected-completion') {
            f.vault.revokeProviderSessionBinding(f.binding.bindingId, f.identity);
          }
          return hash;
        };
      }
      const transport = { async signedPost(route: string, input: unknown) {
        const body = input as Record<string, unknown>; actions.push(String(body.action));
        if (route.endsWith('provider-sessions')) return { ok: true, organizationId: f.binding.organizationId,
          correlationId: ids.threadId, registration: { bindingId: f.binding.bindingId, workspaceId: f.binding.workspaceId,
            endpointId: f.binding.endpointId, repositoryBindingId: f.binding.repositoryBindingId,
            membershipId: f.binding.membershipId, deviceId: f.binding.deviceId, provider: 'codex', mode: 'bridge_owned',
            revision: Number(body.expectedRevision) + 1, state: 'attached',
            leaseUntil: new Date(Date.now() + 60_000).toISOString(), replay: false } };
        if (body.action === 'inbox') return { ok: true, organizationId: f.binding.organizationId,
          correlationId: ids.threadId, result: { offers: [question] } };
        if (body.action === 'reply') {
          sent.push(body);
          assert.equal(remote.isClosed(), false, 'failure must use the still-held real owner');
          assert.equal(body.outcome, 'failed'); assert.equal(body.failureCode, 'validation_failed');
          assert.equal(body.answer, ''); assert.equal(JSON.stringify(body).includes(answer), false);
          if (scenario === 'lost_failure_ack') throw new Error('synthetic-unconfirmed-failure');
          if (scenario === 'server_denied_failure') throw new Error('synthetic-denied-authority');
        }
        return { ok: true, organizationId: f.binding.organizationId, correlationId: ids.threadId,
          result: { questionId: question.questionId, taskId: question.taskId, targetBindingId: f.binding.bindingId,
            state: body.action === 'accept' ? 'accepted' : body.outcome, replay: false } };
      } };
      const inbox = await openCodexInboxSession({ ...f, bindingId: f.binding.bindingId, expectedRevision: 0,
        channelTransport: transport, authorizeContent: async () => true,
        budget: { reserve: async () => { reserves += 1; return true; } }, openTransport: async () => remote.transport });
      try {
        const result = await inbox.runNext();
        assert.equal(result.state, scenario === 'accepted_failure' ? 'failed' : 'failure_reply_pending');
        assert.ok('rejectedCompletionHash' in result && typeof result.rejectedCompletionHash === 'string');
        const retained = JSON.parse((await f.vault.getBlob(result.rejectedCompletionHash)).toString());
        assert.equal(retained.questionId, question.questionId); assert.equal(retained.taskId, question.taskId);
        assert.equal(retained.bindingId, f.binding.bindingId); assert.equal(retained.result.answer, answer);
        assert.equal(retained.code, 'codex_session_answer_too_large');
        assert.equal(stagedAnswers, 0, 'rejected content cannot enter the answer retry queue');
        if (scenario === 'revoked_before_failure') {
          assert.throws(() => f.vault.listProviderSessionReplies(f.binding.bindingId, f.identity),
            /provider_session_binding_unavailable/);
        } else assert.equal(f.vault.listProviderSessionReplies(f.binding.bindingId, f.identity).length, 0);
        assert.equal(reserves, 1); assert.equal(sent.length, scenario === 'revoked_before_failure' ? 0 : 1);
        assert.equal(remote.calls.filter(method => method === 'turn/start').length, 1);
        assert.equal(remote.isClosed(), true);
        await assert.rejects(inbox.runNext(), /codex_inbox_session_unavailable/);
        assert.equal(actions.includes('detach'), false);
      } finally { await inbox.close(); f.vault.close(); }
    });
  }
});

test('completion recovery rejects corrupted contracts and foreign scope before requesting or executing work', async t => {
  for (const mutation of ['foreign', 'hash', 'extra', 'revoked'] as const) {
    await t.test(mutation, async () => {
      const f = await fixture(), question = signedQuestion(f.binding, f.now), answer = 'Saved answer.';
      const completion = { schema: 'dharma.provider-session-completion/v1', organizationId: f.binding.organizationId,
        repositoryBindingId: f.binding.repositoryBindingId, membershipId: f.binding.membershipId,
        deviceId: f.binding.deviceId, workspaceId: f.binding.workspaceId, endpointId: f.binding.endpointId,
        questionId: question.questionId, taskId: question.taskId, bindingId: f.binding.bindingId,
        targetEndpointId: f.binding.endpointId, answer, answerHash: `sha256:${createHash('sha256').update(answer).digest('hex')}`,
        ...(mutation === 'extra' ? { providerThread: 'must-not-be-shared' } : {}) };
      if (mutation === 'foreign') completion.organizationId = 'org_foreign';
      if (mutation === 'hash') completion.answerHash = `sha256:${'0'.repeat(64)}`;
      const hash = await f.vault.stageProviderSessionReply(f.binding.bindingId, f.identity,
        question.questionId, Buffer.from(canonicalize(completion)));
      if (mutation === 'revoked') f.vault.revokeProviderSessionBinding(f.binding.bindingId, f.identity);
      let requests = 0;
      try {
        await assert.rejects(reconcileProviderSessionReply({ vault: f.vault, bindingId: f.binding.bindingId,
          identity: f.identity, channel: {
            read: async () => { requests += 1; throw new Error('unexpected read'); },
            reply: async () => { requests += 1; throw new Error('unexpected reply'); },
          } }), /provider_session_(?:completion_(?:invalid|scope_mismatch)|binding_unavailable)/);
        assert.equal(requests, 0); assert.ok((await f.vault.getBlob(hash)).length > 0);
      } finally { f.vault.close(); }
    });
  }
});

test('signed inbox budget denial does not accept, execute, or replace the selected session', async () => {
  const f = await fixture(), remote = fakeTransport(f.binding);
  let accepts = 0;
  const transport = { async signedPost(route: string, input: unknown) {
    const body = input as Record<string, unknown>;
    if (route.endsWith('provider-sessions')) return { ok: true, organizationId: f.binding.organizationId,
      correlationId: ids.threadId, registration: { bindingId: f.binding.bindingId, workspaceId: f.binding.workspaceId,
        endpointId: f.binding.endpointId, repositoryBindingId: f.binding.repositoryBindingId,
        membershipId: f.binding.membershipId, deviceId: f.binding.deviceId, provider: 'codex', mode: 'bridge_owned',
        revision: Number(body.expectedRevision) + 1, state: body.action === 'detach' ? 'detached' : 'attached',
        leaseUntil: new Date(Date.now() + 60_000).toISOString(), replay: false } };
    if (body.action === 'accept') accepts += 1;
    return { ok: true, organizationId: f.binding.organizationId, correlationId: ids.threadId,
      result: { offers: [signedQuestion(f.binding, f.now)] } };
  } };
  const inbox = await openCodexInboxSession({ ...f, bindingId: f.binding.bindingId, expectedRevision: 0,
    budget: { reserve: async () => false }, channelTransport: transport, authorizeContent: async () => true,
    openTransport: async () => remote.transport });
  try {
    assert.equal((await inbox.runNext()).state, 'budget_denied');
    assert.equal((await inbox.runNext()).state, 'budget_denied');
    assert.equal(accepts, 0); assert.equal(remote.calls.includes('turn/start'), false);
    assert.equal(remote.isClosed(), false);
    const retired = await inbox.retire();
    assert.equal(retired.serverDetached, true); assert.equal(retired.providerClosed, true);
  } finally { await inbox.close(); f.vault.close(); }
});

test('an unaccepted question recovers its existing reservation only through a fresh acceptance', async () => {
  const f = await fixture(), question = signedQuestion(f.binding, f.now);
  const path = join(f.root, 'question-budget.sqlite');
  let budget = new NamedSessionBudget(path, 'question-recovery', 50);
  let accepts = 0, accepted = false;
  const remotes: ReturnType<typeof fakeTransport>[] = [];
  const channelTransport = { async signedPost(route: string, input: unknown) {
    const body = input as Record<string, unknown>;
    const envelope = { ok: true, organizationId: f.binding.organizationId, correlationId: ids.threadId };
    if (route.endsWith('provider-sessions')) return { ...envelope, registration: {
      bindingId: f.binding.bindingId, workspaceId: f.binding.workspaceId, endpointId: f.binding.endpointId,
      repositoryBindingId: f.binding.repositoryBindingId, membershipId: f.binding.membershipId,
      deviceId: f.binding.deviceId, provider: 'codex', mode: 'bridge_owned',
      revision: Number(body.expectedRevision) + 1, state: 'attached',
      leaseUntil: new Date(Date.now() + 60_000).toISOString(), replay: false } };
    if (body.action === 'inbox') return { ...envelope, result: { offers: accepted ? [] : [question] } };
    if (body.action === 'accept') {
      accepts++;
      if (accepts === 1) throw new Error('private-transport-error-must-not-be-exposed');
      assert.equal(accepted, false); accepted = true;
    }
    return { ...envelope, result: { questionId: question.questionId, taskId: question.taskId,
      targetBindingId: f.binding.bindingId, state: body.action === 'reply' ? 'answered' : 'accepted', replay: false } };
  } };
  const open = async () => {
    const remote = fakeTransport(f.binding); remotes.push(remote);
    const options = { ...f, bindingId: f.binding.bindingId, expectedRevision: 0,
      budget: { reserve: async (id: string, cents: number) => budget.reserve(id, cents) },
      questionBudget: { reserve: async (id: string, cents: number) => budget.reserveUnacceptedQuestion(id, cents) },
      channelTransport, authorizeContent: async () => true, openTransport: async () => remote.transport };
    return openCodexInboxSession(options);
  };
  let inbox = await open();
  try {
    await assert.rejects(inbox.runNext(), /provider_session_channel_uncertain/);
    assert.equal(accepted, false);
    assert.equal(remotes[0]!.calls.includes('turn/start'), false);
    assert.equal(budget.status().reservedCents, 25);
    await inbox.close(); budget.close();
    budget = new NamedSessionBudget(path, 'question-recovery', 50);
    inbox = await open();
    assert.equal((await inbox.runNext()).state, 'answered');
    assert.equal(accepts, 2);
    assert.equal(remotes.flatMap(remote => remote.calls).filter(call => call === 'turn/start').length, 1);
    assert.equal(budget.status().reservedCents, 25);
    assert.equal(budget.reserve(question.questionId, 25), true, 'a distinct local-work purpose needs its own reservation');
    assert.equal(budget.reserve(question.questionId, 25), false, 'local-work reservation replay stays forbidden');
    assert.equal(budget.status().reservedCents, 50);
  } finally { await inbox.close(); budget.close(); f.vault.close(); }
});

for (const lostAt of ['before_commit', 'after_commit'] as const) test(`HTTP acceptance loss ${lostAt} preserves cost and never repeats execution`, async () => {
  const f = await fixture(), question = signedQuestion(f.binding, f.now);
  const path = join(f.root, 'http-question-budget.sqlite');
  let budget = new NamedSessionBudget(path, 'http-question-recovery', 50);
  let accepted = false, accepts = 0;
  const remotes: ReturnType<typeof fakeTransport>[] = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
    const envelope = { ok: true, organizationId: f.binding.organizationId, correlationId: ids.threadId };
    const send = (value: unknown) => {response.setHeader('content-type', 'application/json');response.end(JSON.stringify(value));};
    assert.equal(body.bindingId, f.binding.bindingId);
    assert.equal(body.workspaceId, f.binding.workspaceId);
    if (request.url?.endsWith('provider-sessions')) {
      send({ ...envelope, registration: {
        bindingId: f.binding.bindingId, workspaceId: f.binding.workspaceId, endpointId: f.binding.endpointId,
        repositoryBindingId: f.binding.repositoryBindingId, membershipId: f.binding.membershipId,
        deviceId: f.binding.deviceId, provider: 'codex', mode: 'bridge_owned',
        revision: Number(body.expectedRevision) + 1, state: 'attached',
        leaseUntil: new Date(Date.now() + 60_000).toISOString(), replay: false } }); return;
    }
    if (body.action === 'inbox') {send({ ...envelope, result: { offers: accepted ? [] : [question] } });return;}
    if (body.action === 'accept') {
      accepts++;
      if (accepts === 1) {
        accepted = lostAt === 'after_commit';
        request.socket.destroy(); return;
      }
      assert.equal(accepted, false); accepted = true;
    }
    send({ ...envelope, result: { questionId: question.questionId, taskId: question.taskId,
      targetBindingId: f.binding.bindingId, state: body.action === 'reply' ? 'answered' : 'accepted', replay: false } });
  });
  await new Promise<void>(resolveListen => server.listen(0, '127.0.0.1', resolveListen));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const channelTransport = { async signedPost(route: string, body: unknown) {
    const response = await fetch(origin+route, {method: 'POST', body: JSON.stringify(body),
      headers: {'content-type': 'application/json'}, signal: AbortSignal.timeout(3000)});
    assert.equal(response.status, 200);return await response.json() as Record<string, unknown>;
  } };
  const open = async () => {
    const remote = fakeTransport(f.binding); remotes.push(remote);
    return openCodexInboxSession({...f, bindingId: f.binding.bindingId, expectedRevision: 0,
      budget: {reserve: async (id, cents) => budget.reserve(id, cents)},
      questionBudget: {reserve: async (id, cents) => budget.reserveUnacceptedQuestion(id, cents)},
      channelTransport, authorizeContent: async () => true, openTransport: async () => remote.transport});
  };
  let inbox = await open();
  try {
    await assert.rejects(inbox.runNext(), /provider_session_channel_uncertain/);
    assert.equal(remotes[0]!.calls.includes('turn/start'), false);
    assert.equal(budget.status().reservedCents, 25);
    await inbox.close();budget.close();
    budget = new NamedSessionBudget(path, 'http-question-recovery', 50);
    inbox = await open();
    assert.equal((await inbox.runNext()).state, lostAt === 'before_commit' ? 'answered' : 'idle');
    assert.equal(accepts, lostAt === 'before_commit' ? 2 : 1);
    assert.equal(remotes.flatMap(remote => remote.calls).filter(call => call === 'turn/start').length,
      lostAt === 'before_commit' ? 1 : 0);
    assert.equal(budget.status().reservedCents, 25);
  } finally {
    await inbox.close();budget.close();f.vault.close();
    server.closeAllConnections();await new Promise<void>(resolveClose => server.close(() => resolveClose()));
  }
});

test('a replayed acceptance never authorizes another provider turn', async () => {
  const f = await fixture(), question = signedQuestion(f.binding, f.now), remote = fakeTransport(f.binding);
  let accepts = 0;
  const channelTransport = { async signedPost(route: string, input: unknown) {
    const body = input as Record<string, unknown>;
    const envelope = { ok: true, organizationId: f.binding.organizationId, correlationId: ids.threadId };
    if (route.endsWith('provider-sessions')) return { ...envelope, registration: {
      bindingId: f.binding.bindingId, workspaceId: f.binding.workspaceId, endpointId: f.binding.endpointId,
      repositoryBindingId: f.binding.repositoryBindingId, membershipId: f.binding.membershipId,
      deviceId: f.binding.deviceId, provider: 'codex', mode: 'bridge_owned',
      revision: Number(body.expectedRevision) + 1, state: 'attached',
      leaseUntil: new Date(Date.now() + 60_000).toISOString(), replay: false } };
    if (body.action === 'inbox') return { ...envelope, result: { offers: [question] } };
    if (body.action === 'accept') accepts++;
    return { ...envelope, result: { questionId: question.questionId, taskId: question.taskId,
      targetBindingId: f.binding.bindingId, state: body.action === 'reply' ? 'answered' : 'accepted', replay: true } };
  } };
  const inbox = await openCodexInboxSession({ ...f, bindingId: f.binding.bindingId, expectedRevision: 0,
    channelTransport, authorizeContent: async () => true, openTransport: async () => remote.transport });
  try {
    await assert.rejects(inbox.runNext(), /replayed/);
    assert.equal(accepts, 1); assert.equal(remote.calls.includes('turn/start'), false);
  } finally { await inbox.close(); f.vault.close(); }
});

test('bound dispatch resolves one encrypted binding and releases a completed turn', async () => {
  const f = await fixture();
  const remote = fakeTransport(f.binding);
  try {
    const result = await runCodexBoundSessionQuestion({ ...f, bindingId: f.binding.bindingId,
      openTransport: async () => remote.transport, question: signedQuestion(f.binding, f.now) });
    assert.equal(result.answer, 'Catalog generation 13.');
    assert.equal(result.bindingId, f.binding.bindingId);
    assert.equal(remote.calls.includes('turn/start'), true);
    assert.equal(remote.isClosed(), true);
    const next = f.vault.tryAcquireProviderSessionLease(f.binding.bindingId, f.identity);
    assert.ok(next);
    next.release();
    const second = fakeTransport(f.binding);
    const followup = await runCodexBoundSessionQuestion({ ...f, bindingId: f.binding.bindingId,
      openTransport: async () => second.transport,
      question: signedQuestion(f.binding, f.now, '40000000-0000-4000-8000-000000000020') });
    assert.equal(followup.bindingId, result.bindingId);
    assert.equal(second.isClosed(), true);
  } finally { f.vault.close(); }
});

test('bound dispatch rejects a foreign identity before touching the provider', async () => {
  const f = await fixture();
  const remote = fakeTransport(f.binding);
  let opened = false;
  try {
    await assert.rejects(runCodexBoundSessionQuestion({ ...f, bindingId: f.binding.bindingId,
      identity: { ...f.identity, organizationId: 'org_foreign' },
      openTransport: async () => { opened = true; return remote.transport; },
      question: signedQuestion(f.binding, f.now) }), /scope_mismatch/);
    assert.equal(opened, false);
    assert.deepEqual(remote.calls, []);
  } finally { f.vault.close(); }
});

test('bound dispatch rejects an invalid signature before opening the provider', async () => {
  const f = await fixture();
  let opened = false;
  try {
    await assert.rejects(runCodexBoundSessionQuestion({ ...f, bindingId: f.binding.bindingId,
      openTransport: async () => { opened = true; return fakeTransport(f.binding).transport; },
      question: { ...signedQuestion(f.binding, f.now), question: 'Changed after signing' } }),
    /signature_invalid/);
    assert.equal(opened, false);
    const next = f.vault.tryAcquireProviderSessionLease(f.binding.bindingId, f.identity);
    assert.ok(next);
    next.release();
  } finally { f.vault.close(); }
});

test('bound dispatch releases ownership after a safely cleaned-up transport startup failure', async () => {
  const f = await fixture();
  try {
    await assert.rejects(runCodexBoundSessionQuestion({ ...f, bindingId: f.binding.bindingId,
      openTransport: async () => { throw new Error('transport_start_failed_after_cleanup'); },
      question: signedQuestion(f.binding, f.now) }), /transport_start_failed_after_cleanup/);
    const next = f.vault.tryAcquireProviderSessionLease(f.binding.bindingId, f.identity);
    assert.ok(next);
    next.release();
  } finally { f.vault.close(); }
});

test('bound dispatch closes a failed provider before releasing ownership', async () => {
  const f = await fixture();
  const remote = fakeTransport(f.binding, { failedTurn: true });
  try {
    await assert.rejects(runCodexBoundSessionQuestion({ ...f, bindingId: f.binding.bindingId,
      openTransport: async () => remote.transport, question: signedQuestion(f.binding, f.now) }), /turn_failed/);
    assert.equal(remote.isClosed(), true);
    const next = f.vault.tryAcquireProviderSessionLease(f.binding.bindingId, f.identity);
    assert.ok(next);
    next.release();
  } finally { f.vault.close(); }
});

test('bound dispatch retains ownership if provider termination is unconfirmed', async () => {
  const f = await fixture();
  const remote = fakeTransport(f.binding, { failedTurn: true, closeFails: true });
  try {
    await assert.rejects(runCodexBoundSessionQuestion({ ...f, bindingId: f.binding.bindingId,
      openTransport: async () => remote.transport, question: signedQuestion(f.binding, f.now) }), /turn_failed/);
    assert.equal(f.vault.tryAcquireProviderSessionLease(f.binding.bindingId, f.identity), null);
  } finally { f.vault.close(); }
});

test('bound dispatch does not report success when provider shutdown is unconfirmed', async () => {
  const f = await fixture();
  const remote = fakeTransport(f.binding, { closeFails: true });
  try {
    await assert.rejects(runCodexBoundSessionQuestion({ ...f, bindingId: f.binding.bindingId,
      openTransport: async () => remote.transport, question: signedQuestion(f.binding, f.now) }), /process_still_running/);
    assert.equal(f.vault.tryAcquireProviderSessionLease(f.binding.bindingId, f.identity), null);
  } finally { f.vault.close(); }
});

test('live owner keeps the same loaded thread and lease across two questions', async () => {
  const f = await fixture();
  const remote = fakeTransport(f.binding);
  let opens = 0;
  try {
    const owner = await openCodexBoundSession({ ...f, bindingId: f.binding.bindingId,
      openTransport: async () => { opens++; return remote.transport; } });
    const first = await owner.runQuestion({ question: signedQuestion(f.binding, f.now) });
    assert.equal(remote.isClosed(), false);
    assert.equal(f.vault.tryAcquireProviderSessionLease(f.binding.bindingId, f.identity), null);
    const second = await owner.runQuestion({
      question: signedQuestion(f.binding, f.now, '40000000-0000-4000-8000-000000000020'),
    });
    assert.equal(second.bindingId, first.bindingId);
    assert.equal(opens, 1);
    assert.equal(remote.calls.filter(method => method === 'turn/start').length, 2);
    assert.equal(remote.calls.includes('thread/resume'), false);
    await owner.close();
    await owner.close();
    assert.equal(remote.calls.filter(method => method === 'close').length, 1);
    const next = f.vault.tryAcquireProviderSessionLease(f.binding.bindingId, f.identity);
    assert.ok(next);
    next.release();
    await assert.rejects(owner.runQuestion({ question: signedQuestion(f.binding, f.now) }), /session_closed/);
  } finally { f.vault.close(); }
});

test('live owner retains an empty session after budget denial without consuming the question', async () => {
  const f = await fixture();
  const remote = fakeTransport(f.binding);
  let permitted = false;
  try {
    const owner = await openCodexBoundSession({ ...f, bindingId: f.binding.bindingId,
      budget: { reserve: async () => permitted }, openTransport: async () => remote.transport });
    const question = signedQuestion(f.binding, f.now);
    await assert.rejects(owner.runQuestion({ question }), /budget_unavailable/);
    assert.equal(remote.isClosed(), false);
    assert.equal(remote.calls.includes('turn/start'), false);
    permitted = true;
    assert.equal((await owner.runQuestion({ question })).answer, 'Catalog generation 13.');
    await owner.close();
  } finally { f.vault.close(); }
});

test('live owner refuses overlapping questions without dispatching the second turn', async () => {
  const f = await fixture();
  const remote = fakeTransport(f.binding);
  let allowBudget!: (allowed: boolean) => void;
  const budget = new Promise<boolean>(resolveBudget => { allowBudget = resolveBudget; });
  try {
    const owner = await openCodexBoundSession({ ...f, bindingId: f.binding.bindingId,
      budget: { reserve: async () => budget }, openTransport: async () => remote.transport });
    const first = owner.runQuestion({ question: signedQuestion(f.binding, f.now) });
    await assert.rejects(owner.runQuestion({
      question: signedQuestion(f.binding, f.now, '40000000-0000-4000-8000-000000000020'),
    }), /session_busy/);
    allowBudget(true);
    await first;
    assert.equal(remote.calls.filter(method => method === 'turn/start').length, 1);
    await owner.close();
  } finally { f.vault.close(); }
});

test('live owner rejects replay and tampering without discarding a healthy conversation', async () => {
  const f = await fixture();
  const remote = fakeTransport(f.binding);
  try {
    const owner = await openCodexBoundSession({ ...f, bindingId: f.binding.bindingId,
      openTransport: async () => remote.transport });
    const question = signedQuestion(f.binding, f.now);
    await owner.runQuestion({ question });
    await assert.rejects(owner.runQuestion({ question }), /replay/);
    await assert.rejects(owner.runQuestion({ question: { ...question, question: 'Tampered' } }), /signature_invalid/);
    assert.equal(remote.isClosed(), false);
    assert.equal(remote.calls.filter(method => method === 'turn/start').length, 1);
    await owner.close();
  } finally { f.vault.close(); }
});

test('live owner stops after local revocation before another provider turn', async () => {
  const f = await fixture();
  const remote = fakeTransport(f.binding);
  try {
    const owner = await openCodexBoundSession({ ...f, bindingId: f.binding.bindingId,
      openTransport: async () => remote.transport });
    f.vault.revokeProviderSessionBinding(f.binding.bindingId, f.identity);
    await assert.rejects(owner.runQuestion({ question: signedQuestion(f.binding, f.now) }), /lease_unavailable/);
    assert.equal(remote.isClosed(), true);
    assert.equal(remote.calls.includes('turn/start'), false);
  } finally { f.vault.close(); }
});

test('live owner closes a failed turn and retains fencing if shutdown is unconfirmed', async () => {
  const f = await fixture();
  const remote = fakeTransport(f.binding, { failedTurn: true, closeFails: true });
  try {
    const owner = await openCodexBoundSession({ ...f, bindingId: f.binding.bindingId,
      openTransport: async () => remote.transport });
    await assert.rejects(owner.runQuestion({ question: signedQuestion(f.binding, f.now) }), /turn_failed/);
    assert.equal(f.vault.tryAcquireProviderSessionLease(f.binding.bindingId, f.identity), null);
    await assert.rejects(owner.runQuestion({ question: signedQuestion(f.binding, f.now) }), /session_closed/);
    await assert.rejects(owner.close(), /process_still_running/);
  } finally { f.vault.close(); }
});

test('live owner refuses a foreign enrollment before opening the provider', async () => {
  const f = await fixture();
  let opened = false;
  try {
    await assert.rejects(openCodexBoundSession({ ...f, bindingId: f.binding.bindingId,
      identity: { ...f.identity, deviceId: '40000000-0000-4000-8000-000000000099' },
      openTransport: async () => { opened = true; return fakeTransport(f.binding).transport; } }), /scope_mismatch/);
    assert.equal(opened, false);
  } finally { f.vault.close(); }
});

test('closing a live owner during budget wait prevents consumption and a subsequent turn', async () => {
  const f = await fixture();
  const remote = fakeTransport(f.binding);
  let waiting!: () => void;
  let releaseBudget!: (value: boolean) => void;
  const entered = new Promise<void>(resolveEntered => { waiting = resolveEntered; });
  const budget = new Promise<boolean>(resolveBudget => { releaseBudget = resolveBudget; });
  let consumed = false;
  try {
    const owner = await openCodexBoundSession({ ...f, bindingId: f.binding.bindingId,
      verifier: { ...f.verifier, consume: async () => { consumed = true; return true; } },
      budget: { reserve: async () => { waiting(); return budget; } },
      openTransport: async () => remote.transport });
    const first = owner.runQuestion({ question: signedQuestion(f.binding, f.now) });
    const rejection = assert.rejects(first, /lease_unavailable/);
    await entered;
    await owner.close();
    releaseBudget(true);
    await rejection;
    assert.equal(consumed, false);
    assert.equal(remote.calls.includes('turn/start'), false);
    assert.equal(remote.isClosed(), true);
  } finally { f.vault.close(); }
});
});
