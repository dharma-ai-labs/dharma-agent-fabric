import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {mkdtemp, readdir, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';
import test from 'node:test';
import {LocalVault} from '@dharma-ai-labs/agent-fabric-local-vault';
import type {SecureSecretStore} from '@dharma-ai-labs/agent-fabric-secure-store';
import {prepareCodexBootstrapHost, type BootstrapHostScope} from './bootstrapHostScope.js';
import {createCodexSetupAdmission, type CodexSetupJournal} from './codexSetupAdmission.js';
import * as module from './codexSetupVaultJournal.js';

const id = (n: number) => `${String(n).padStart(8, '0')}-1111-4111-8111-111111111111`;
const hash = `sha256:${'a'.repeat(64)}`;
type OpenInput = {root: string; scope: BootstrapHostScope; store?: SecureSecretStore};
async function open(input: OpenInput): Promise<CodexSetupJournal & {close(): void}> {
  const method = (module as unknown as {openCodexSetupVaultJournal?: (input: OpenInput) => Promise<CodexSetupJournal & {close(): void}>}).openCodexSetupVaultJournal;
  assert.equal(typeof method, 'function', 'protected journal initializer is absent'); return method!(input);
}
async function fixture(operation: (root: string, prepared: ReturnType<typeof prepareCodexBootstrapHost>,
  store: SecureSecretStore, calls: string[]) => Promise<void>) {
  const root = await mkdtemp(resolve(tmpdir(), 'fabric-setup-journal-caller-')), calls: string[] = [];
  const key = randomBytes(32).toString('base64');
  const store: SecureSecretStore = {backend: 'linux-secret-service',
    async get() {calls.push('get'); return key;}, async put() {throw new Error('unexpected put');}, async delete() {throw new Error('unexpected delete');}};
  const now = Date.now();
  const prepared = prepareCodexBootstrapHost({workspace: root, current: async () => true, signal: new AbortController().signal,
    intent: {schema: 'dharma.codex-setup-intent/v1', operationId: id(1), setupReference: id(2), organizationId: 'org_demo',
      recipientMembershipId: id(3), origin: 'https://hq.example', hostContextId: id(4), repositoryFingerprint: hash,
      policyRevision: 'policy-v1', scopeDigest: hash, contractDigest: hash, issuedAt: new Date(now - 1000).toISOString(),
      expiresAt: new Date(now + 60_000).toISOString()}});
  try {await operation(root, prepared, store, calls);}
  finally {prepared.scope.close(); await rm(root, {recursive: true, force: true});}
}

test('protected journal initialization refuses closed owning scope before store or filesystem effects', async () => {
  await fixture(async (root, prepared, store, calls) => {
    prepared.scope.close();
    await assert.rejects(open({root, scope: prepared.scope, store}), {message: 'codex_setup_host_scope_unavailable'});
    assert.deepEqual(calls, []); assert.deepEqual(await readdir(root), []);
  });
});

test('protected journal initialization cannot open a database after withdrawal during key read', async () => {
  await fixture(async (root, prepared, store, calls) => {
    const read = store.get; store.get = async account => {const key = await read(account); prepared.scope.close(); return key;};
    await assert.rejects(open({root, scope: prepared.scope, store}), {message: 'vault_key_scope_unavailable'});
    assert.deepEqual(calls, ['get']); assert.deepEqual(await readdir(root), []);
  });
});

test('actual admission uses the scoped encrypted journal and reconciles without re-execution', async () => {
  await fixture(async (root, prepared, store) => {
    let journal = await open({root, scope: prepared.scope, store}), executions = 0;
    const binding = {connectionId: id(5), threadId: 'synthetic_thread', turnId: 'synthetic_turn', hostContextId: id(4)};
    const common = {...binding, intent: prepared.intent, current: async () => ({...binding, mode: 'setup' as const}),
      qualifyHost: async () => prepared.scope.current(),
      execute: async () => {executions++; return {state: 'completed', readinessReceiptId: id(6)};},
      verifyReadiness: async (receipt: string) => receipt === id(6)};
    const request = {...binding, callId: 'first', namespace: null, tool: 'dharma_setup_reference',
      arguments: {operationId: id(1), setupReference: id(2)}};
    delete (request as Partial<typeof request>).connectionId;
    delete (request as Partial<typeof request>).hostContextId;
    const first = createCodexSetupAdmission({...common, journal});
    try {assert.equal((await first.handler(request, {signal: prepared.scope.signal})).success, true);}
    finally {first.close(); await first.settled; journal.close();}
    journal = await open({root, scope: prepared.scope, store});
    const recovered = createCodexSetupAdmission({...common, journal});
    try {
      assert.equal((await recovered.handler({...request, callId: 'reconcile'}, {signal: prepared.scope.signal})).success, true);
      assert.equal(executions, 1);
    } finally {recovered.close(); await recovered.settled; journal.close();}
  });
});

test('initializer closes its acquired backend when scope withdraws after database opening', async t => {
  await fixture(async (root, prepared, store) => {
    const original = LocalVault.openSetupJournal; let closes = 0;
    t.mock.method(LocalVault, 'openSetupJournal', async (...args: Parameters<typeof original>) => {
      const backend = await original(...args); prepared.scope.close();
      return Object.freeze({...backend, close: () => {closes++; backend.close();}});
    });
    await assert.rejects(open({root, scope: prepared.scope, store}), {message: 'codex_setup_host_scope_unavailable'});
    assert.equal(closes, 1);
  });
});
