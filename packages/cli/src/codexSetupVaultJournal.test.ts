import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve, sep} from 'node:path';
import test from 'node:test';
import {LocalVault} from '@dharma-ai-labs/agent-fabric-local-vault';
import {createCodexSetupAdmission, type CodexSetupIntent} from './codexSetupAdmission.js';
import {createCodexSetupVaultJournal} from './codexSetupVaultJournal.js';

const id = (n: number) => `${String(n).padStart(8, '0')}-1111-4111-8111-111111111111`;
const hash = `sha256:${'a'.repeat(64)}`;
const intent: CodexSetupIntent = {schema: 'dharma.codex-setup-intent/v1', operationId: id(1), setupReference: id(2),
  organizationId: 'org_demo', recipientMembershipId: id(3), origin: 'https://hq.example', hostContextId: id(4),
  repositoryFingerprint: hash, policyRevision: 'policy-v1', scopeDigest: hash, contractDigest: hash,
  issuedAt: '2026-10-05T18:00:00.000Z', expiresAt: '2026-10-05T18:15:00.000Z'};
const binding = {connectionId: id(5), threadId: 'synthetic_thread', turnId: 'synthetic_turn', hostContextId: id(4)};
const request = {threadId: binding.threadId, turnId: binding.turnId, callId: 'synthetic_call',
  tool: 'dharma_setup_reference', namespace: null, arguments: {operationId: id(1), setupReference: id(2)}};

for (const lostJournalAck of [false, true]) test(`admission reconciles reopened SQLite journal without re-execution (lostAck=${lostJournalAck})`, async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'fabric-setup-admission-db-')); const key = randomBytes(32);
  let vault = await LocalVault.open({root, masterKey: key}); let executions = 0;
  const signal = new AbortController().signal;
  const common = {intent, ...binding, now: () => Date.parse('2026-10-05T18:01:00.000Z'),
    current: async () => ({...binding, mode: 'setup' as const}), qualifyHost: async () => true,
    execute: async () => {executions++; return {state: 'completed', readinessReceiptId: id(6)};},
    verifyReadiness: async () => true};
  try {
    const journal = createCodexSetupVaultJournal(vault);
    if (lostJournalAck) {
      const finish = journal.finish;
      journal.finish = async (...args) => {await finish(...args); throw new Error('synthetic-lost-ack-canary');};
    }
    const first = createCodexSetupAdmission({...common, journal});
    const result = await first.handler(request, {signal});
    assert.equal(result.success, !lostJournalAck);
    assert.equal(JSON.stringify(result).includes('synthetic-lost-ack-canary'), false);
    first.close(); vault.close();
    vault = await LocalVault.open({root, masterKey: key});
    const reconciled = createCodexSetupAdmission({...common, journal: createCodexSetupVaultJournal(vault)});
    assert.equal((await reconciled.handler({...request, callId: 'reconcile'}, {signal})).success, true);
    assert.equal(executions, 1); reconciled.close();
  } finally {
    vault.close();
    if (!resolve(root).startsWith(`${resolve(tmpdir())}${sep}fabric-setup-admission-db-`)) throw new Error('fixture_cleanup_scope_invalid');
    await rm(root, {recursive: true, force: true});
  }
});
