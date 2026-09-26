import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { resolve } from 'node:path';
import test from 'node:test';
import { signCanonicalObject, type SessionBindingScope } from '@dharma-ai-labs/agent-fabric-contracts';
import { runCodexBridgeQuestion, type CodexAppServerTransport } from './codexAppServerSession.js';

const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const scope: SessionBindingScope = {
  organizationId: 'org_test', repositoryBindingId: '40000000-0000-4000-8000-000000000001',
  workspaceId: '40000000-0000-4000-8000-000000000002',
  endpointId: '40000000-0000-4000-8000-000000000003',
  membershipId: '40000000-0000-4000-8000-000000000004',
  deviceId: '40000000-0000-4000-8000-000000000005',
  bindingId: '40000000-0000-4000-8000-000000000006',
  provider: 'codex', expiresAt: '2026-09-26T02:00:00.000Z', maximumProviderCostCents: 25,
};
const threadId = '40000000-0000-4000-8000-000000000007';

function question(change: Record<string, unknown> = {}) {
  const unsigned = {
    schema: 'dharma.session-question/v1',
    questionId: '40000000-0000-4000-8000-000000000010',
    taskId: '40000000-0000-4000-8000-000000000011',
    organizationId: scope.organizationId, repositoryBindingId: scope.repositoryBindingId,
    source: { workspaceId: '40000000-0000-4000-8000-000000000012',
      endpointId: '40000000-0000-4000-8000-000000000013',
      membershipId: '40000000-0000-4000-8000-000000000014',
      deviceId: '40000000-0000-4000-8000-000000000015' },
    target: { workspaceId: scope.workspaceId, endpointId: scope.endpointId,
      membershipId: scope.membershipId, deviceId: scope.deviceId, bindingId: scope.bindingId, provider: 'codex' },
    category: 'code-review', question: 'Which approved catalog applies?',
    authority: { mode: 'read_only', readPaths: ['.'], network: 'deny', maximumProviderCostCents: 25 },
    createdAt: '2026-09-26T00:00:00.000Z', expiresAt: '2026-09-26T00:05:00.000Z',
    nonce: '40000000-0000-4000-8000-000000000016', signerKeyVersion: 'test-v1',
    ...change,
  };
  return { ...unsigned, signature: signCanonicalObject(unsigned, privateKey) };
}

function fixture(options: { active?: boolean; wrongResume?: boolean; failTurn?: boolean; emptyAnswer?: boolean;
  silentTurn?: boolean; profileDenied?: boolean; expandedProfile?: boolean; unknownProfileKey?: boolean;
  unknownNetworkKey?: boolean; activeAfterResume?: boolean; wrongWorkspace?: boolean;
  loadedEmpty?: boolean; unknownAfterResume?: boolean; wireDefaults?: boolean;
  socketExpansion?: boolean } = {}) {
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  const listeners = new Set<(event: unknown) => void>();
  const seen = new Set<string>();
  const emit = (event: unknown) => { for (const listener of listeners) listener(event); };
  const transport: CodexAppServerTransport = {
    onNotification(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    async request(method, params) {
      calls.push({ method, params });
      if (method === 'permissionProfile/list') return { data: [{ id: 'dharma_bridge', allowed: !options.profileDenied }] };
      if (method === 'config/read') return { config: { permissions: { dharma_bridge: {
        extends: null, workspace_roots: null,
        ...(options.wireDefaults ? { description: null } : {}),
        ...(options.unknownProfileKey ? { unrestricted: true } : {}),
        filesystem: { glob_scan_max_depth: null, ':minimal': 'read', ':workspace_roots': {
          '.': 'read', ...(options.expandedProfile ? { '..': 'read' } : {}),
        } },
        network: { enabled: false, domains: null, unix_sockets: null,
          ...(options.wireDefaults ? { enable_socks5: null, enable_socks5_udp: null,
            allow_upstream_proxy: null, dangerously_allow_non_loopback_proxy: null,
            dangerously_allow_all_unix_sockets: null, mode: null, allow_local_binding: null, mitm: null } : {}),
          ...(options.socketExpansion ? { dangerously_allow_all_unix_sockets: true } : {}),
          ...(options.unknownNetworkKey ? { fallbackAccess: true } : {}) },
      } } } };
      if (method === 'thread/read') return { thread: { id: threadId,
        cwd: options.wrongWorkspace ? resolve('other-repository') : workspaceRoot,
        status: { type: options.active ? 'active' : options.loadedEmpty ? 'idle' : 'notLoaded' } } };
      if (method === 'thread/resume') {
        if (options.loadedEmpty) throw new Error('no_rollout_before_first_turn');
        return { thread: { id: options.wrongResume ? 'foreign-thread' : threadId,
          cwd: workspaceRoot, status: { type: options.activeAfterResume ? 'active' : options.unknownAfterResume ? 'unknown' : 'idle' } } };
      }
      if (method === 'turn/start') {
        emit({ method: 'turn/completed', params: { threadId: 'foreign-thread',
          turn: { id: 'foreign-turn', status: 'completed', items: [{ type: 'agentMessage',
            phase: 'final_answer', text: 'Wrong recipient' }] } } });
        if (!options.silentTurn) queueMicrotask(() => emit({ method: 'turn/completed', params: { threadId,
          turn: { id: 'turn-1', status: options.failTurn ? 'failed' : 'completed',
            items: options.emptyAnswer ? [] : [{ type: 'agentMessage', phase: 'final_answer',
              text: 'Use signed catalog generation 13.' }] } } }));
        return { turn: { id: 'turn-1', status: 'inProgress' } };
      }
      if (method === 'turn/interrupt') return {};
      throw new Error(`Unexpected method ${method}`);
    },
  };
  return { transport, calls, verifier: {
    resolvePublicKey: (version: string) => version === 'test-v1' ? publicKey : null,
    consume: async (id: string) => { if (seen.has(id)) return false; seen.add(id); return true; },
  } };
}

const workspaceRoot = resolve('approved-repository');
const binding = { ...scope, owner: 'dharma_bridge' as const, threadId, workspaceRoot };
const exclusiveLease = { assertHeld: async () => true };
const budget = { reserve: async () => true };
const now = new Date('2026-09-26T00:01:00.000Z');

test('bridge asks only its explicit thread under restricted read-only authority', async () => {
  const f = fixture();
  const result = await runCodexBridgeQuestion({ transport: f.transport, binding, question: question(),
    verifier: f.verifier, exclusiveLease, budget, now, timeoutMs: 1_000 });
  assert.equal(result.answer, 'Use signed catalog generation 13.');
  assert.equal(result.bindingId, scope.bindingId);
  assert.equal(result.targetEndpointId, scope.endpointId);
  assert.deepEqual(f.calls.map(call => call.method), [
    'permissionProfile/list', 'config/read', 'thread/read', 'thread/resume', 'turn/start',
  ]);
  assert.deepEqual(f.calls[4]?.params, {
    threadId, input: [{ type: 'text', text: 'Repository question (code-review; task 40000000-0000-4000-8000-000000000011): Which approved catalog applies?\nAnswer only from authorized repository material. Do not modify files, use network access, or request broader permissions.' }],
    cwd: workspaceRoot, approvalPolicy: 'never', permissions: 'dharma_bridge',
  });
});

test('bridge rejects foreign scope, active owner, mismatched resume and duplicate without a turn', async () => {
  for (const [f, q, b] of [
    [fixture(), question({ organizationId: 'org_foreign' }), binding],
    [fixture({ active: true }), question(), binding],
    [fixture({ activeAfterResume: true }), question(), binding],
    [fixture({ unknownAfterResume: true }), question(), binding],
    [fixture({ wrongResume: true }), question(), binding],
    [fixture({ wrongWorkspace: true }), question(), binding],
    [fixture(), question(), { ...binding, owner: 'desktop' as const }],
  ] as const) {
    await assert.rejects(runCodexBridgeQuestion({ transport: f.transport, binding: b, question: q,
      verifier: f.verifier, exclusiveLease, budget, now, timeoutMs: 1_000 }));
    assert.equal(f.calls.some(call => call.method === 'turn/start'), false);
  }
  const f = fixture();
  await runCodexBridgeQuestion({ transport: f.transport, binding, question: question(),
    verifier: f.verifier, exclusiveLease, budget, now, timeoutMs: 1_000 });
  await assert.rejects(runCodexBridgeQuestion({ transport: f.transport, binding, question: question(),
    verifier: f.verifier, exclusiveLease, budget, now, timeoutMs: 1_000 }), /replayed/);
  assert.equal(f.calls.filter(call => call.method === 'turn/start').length, 1);
});

test('bridge does not manufacture an answer for failed or empty turns', async () => {
  for (const options of [{ failTurn: true }, { emptyAnswer: true }]) {
    const f = fixture(options);
    await assert.rejects(runCodexBridgeQuestion({ transport: f.transport, binding, question: question(),
      verifier: f.verifier, exclusiveLease, budget, now, timeoutMs: 1_000 }));
  }
});

test('bridge rejects a missing exclusive lease before touching the provider', async () => {
  const f = fixture();
  await assert.rejects(runCodexBridgeQuestion({ transport: f.transport, binding, question: question(),
    verifier: f.verifier, exclusiveLease: { assertHeld: async () => false }, budget, now, timeoutMs: 1_000 }),
  /codex_session_lease_unavailable/);
  assert.equal(f.calls.length, 0);
});

test('bridge denies absent or expanded permission profiles before a model turn', async () => {
  for (const options of [{ profileDenied: true }, { expandedProfile: true },
    { unknownProfileKey: true }, { unknownNetworkKey: true }, { socketExpansion: true }]) {
    const f = fixture(options);
    await assert.rejects(runCodexBridgeQuestion({ transport: f.transport, binding, question: question(),
      verifier: f.verifier, exclusiveLease, budget, now, timeoutMs: 1_000 }),
    /codex_session_profile_unavailable/);
    assert.equal(f.calls.some(call => call.method === 'turn/start'), false);
  }
});

test('restricted profile accepts serialized null defaults without allowing network expansion', async () => {
  const f = fixture({ wireDefaults: true });
  const result = await runCodexBridgeQuestion({ transport: f.transport, binding, question: question(),
    verifier: f.verifier, exclusiveLease, budget, now });
  assert.equal(result.answer, 'Use signed catalog generation 13.');
});

test('bridge requests interruption when the exact turn times out', async () => {
  const f = fixture({ silentTurn: true });
  await assert.rejects(runCodexBridgeQuestion({ transport: f.transport, binding, question: question(),
    verifier: f.verifier, exclusiveLease, budget, now, timeoutMs: 20 }), /codex_session_turn_timeout/);
  assert.deepEqual(f.calls.at(-1), { method: 'turn/interrupt', params: { threadId, turnId: 'turn-1' } });
});

test('bridge denies an unreserved provider turn', async () => {
  const f = fixture();
  await assert.rejects(runCodexBridgeQuestion({ transport: f.transport, binding, question: question(),
    verifier: f.verifier, exclusiveLease, budget: { reserve: async () => false }, now, timeoutMs: 1_000 }),
  /codex_session_budget_unavailable/);
  assert.equal(f.calls.some(call => call.method === 'turn/start'), false);
});

test('first question uses its already loaded empty thread without resuming a nonexistent rollout', async () => {
  const f = fixture({ loadedEmpty: true });
  await assert.rejects(runCodexBridgeQuestion({ transport: f.transport, binding, question: question(),
    verifier: f.verifier, exclusiveLease, budget: { reserve: async () => false }, now }), /codex_session_budget_unavailable/);
  assert.equal(f.calls.some(call => call.method === 'thread/resume'), false);
  assert.equal(f.calls.some(call => call.method === 'turn/start'), false);
});

test('bridge rechecks revocation after asynchronous budget reservation before consuming', async () => {
  const f = fixture();
  let held = true;
  let consumed = false;
  await assert.rejects(runCodexBridgeQuestion({ transport: f.transport, binding, question: question(),
    verifier: { ...f.verifier, consume: async () => { consumed = true; return true; } },
    exclusiveLease: { assertHeld: async () => held },
    budget: { reserve: async () => { held = false; return true; } }, now }), /lease_unavailable/);
  assert.equal(consumed, false);
  assert.equal(f.calls.some(call => call.method === 'turn/start'), false);
});

test('bridge rechecks revocation after asynchronous question claim before starting a turn', async () => {
  const f = fixture();
  let held = true;
  await assert.rejects(runCodexBridgeQuestion({ transport: f.transport, binding, question: question(),
    verifier: { ...f.verifier, consume: async () => { held = false; return true; } },
    exclusiveLease: { assertHeld: async () => held }, budget, now }), /lease_unavailable/);
  assert.equal(f.calls.some(call => call.method === 'turn/start'), false);
});

test('bridge withholds an answer when the binding is revoked while the turn executes', async () => {
  const f = fixture();
  let held = true;
  const transport = { ...f.transport, async request(method: string, params: Record<string, unknown>) {
    const result = await f.transport.request(method, params);
    if (method === 'turn/start') held = false;
    return result;
  } };
  await assert.rejects(runCodexBridgeQuestion({ transport, binding, question: question(),
    verifier: f.verifier, exclusiveLease: { assertHeld: async () => held }, budget, now }), /lease_unavailable/);
  assert.equal(f.calls.filter(call => call.method === 'turn/start').length, 1);
});
