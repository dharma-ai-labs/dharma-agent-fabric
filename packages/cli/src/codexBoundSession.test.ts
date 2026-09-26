import assert from 'node:assert/strict';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { signCanonicalObject } from '@dharma-ai-labs/agent-fabric-contracts';
import { LocalVault, type LocalProviderSessionBinding } from '@dharma-ai-labs/agent-fabric-local-vault';
import type { CodexStdioTransport } from '@dharma-ai-labs/agent-fabric-provider-adapters/experimental/codex-transport';
import { runCodexBoundSessionQuestion } from './codexBoundSession.js';

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

function fakeTransport(binding: LocalProviderSessionBinding, options: { failedTurn?: boolean; closeFails?: boolean } = {}) {
  const calls: string[] = [];
  const listeners = new Set<(event: unknown) => void>();
  let closed = false;
  const transport: CodexStdioTransport = {
    onNotification(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    async close() {
      calls.push('close');
      if (options.closeFails) throw new Error('process_still_running');
      closed = true;
    },
    async request(method) {
      calls.push(method);
      if (method === 'permissionProfile/list') return { data: [{ id: 'dharma_bridge', allowed: true }] };
      if (method === 'config/read') return { config: { permissions: { dharma_bridge: {
        extends: null, workspace_roots: null,
        filesystem: { ':minimal': 'read', ':workspace_roots': { '.': 'read' } },
        network: { enabled: false },
      } } } };
      if (method === 'thread/read') return { thread: { id: binding.sessionId,
        cwd: binding.workspaceRoot, status: { type: 'idle' } } };
      if (method === 'thread/resume') return { thread: { id: binding.sessionId,
        cwd: binding.workspaceRoot, status: { type: 'idle' } } };
      if (method === 'turn/start') {
        queueMicrotask(() => {
          for (const listener of listeners) listener({ method: 'turn/completed', params: {
            threadId: binding.sessionId, turn: { id: 'turn-1',
              status: options.failedTurn ? 'failed' : 'completed',
              items: [{ type: 'agentMessage', phase: 'final_answer', text: 'Catalog generation 13.' }],
            },
          } });
        });
        return { turn: { id: 'turn-1' } };
      }
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
  const vault = await LocalVault.open({ root, masterKey: randomBytes(32) });
  vault.saveProviderSessionBinding(binding);
  const used = new Set<string>();
  const verifier = {
    resolvePublicKey: (version: string) => version === 'test-v1' ? publicKey : null,
    consume: async (id: string) => { if (used.has(id)) return false; used.add(id); return true; },
  };
  return { vault, binding, identity, verifier, now, budget: { reserve: async () => true } };
}

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
