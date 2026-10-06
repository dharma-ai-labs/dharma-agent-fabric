import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';
import test from 'node:test';
import {LocalVault, type LocalCodexSetupReadiness} from '@dharma-ai-labs/agent-fabric-local-vault';
import {prepareCodexBootstrapHost} from './bootstrapHostScope.js';
import {createCodexSetupReadinessOwner} from './codexSetupReadiness.js';

const id = (n: number) => `${String(n).padStart(8, '0')}-1111-4111-8111-111111111111`, hash = `sha256:${'a'.repeat(64)}`;
async function fixture(run: (f: {
  owner: ReturnType<typeof createCodexSetupReadinessOwner>; intent: ReturnType<typeof prepareCodexBootstrapHost>['intent'];
  lease: {leaseId: string; intentDigest: string}; scope: ReturnType<typeof prepareCodexBootstrapHost>['scope'];
  value: LocalCodexSetupReadiness; observations(): number;
  retained(): Readonly<LocalCodexSetupReadiness> | undefined;
  observedDigests(): Array<string | undefined>;
}) => Promise<void>) {
  const root = await mkdtemp(resolve(tmpdir(), 'fabric-readiness-owner-')), now = Date.now();
  const prepared = prepareCodexBootstrapHost({workspace: root, signal: new AbortController().signal, current: async () => true,
    intent: {schema: 'dharma.codex-setup-intent/v1', operationId: id(1), setupReference: id(2),
      organizationId: 'org_demo', recipientMembershipId: id(3), origin: 'https://hq.example',
      repositoryFingerprint: hash, policyRevision: 'policy-v1', scopeDigest: hash, contractDigest: hash,
      hostContextId: id(4), issuedAt: new Date(now - 1000).toISOString(), expiresAt: new Date(now + 600_000).toISOString()}});
  const value: LocalCodexSetupReadiness = {schema: 'dharma.local-codex-setup-readiness/v1',
    operationId: id(1), organizationId: 'org_demo', membershipId: id(3), deviceId: id(5), workspaceId: id(6),
    repositoryBindingId: id(7), repositoryAgentId: id(8), endpointId: id(9), sessionBindingId: id(10), sessionId: 'synthetic_session',
    repositoryFingerprint: hash, policyRevision: 'policy-v1', policyHash: hash, manifestHash: hash, catalogHash: hash,
    bundleId: id(11), bundleHash: hash, activeReceiptHash: hash, roleRevision: 1, roleProfileHash: hash,
    nativeSkillHash: hash, contractDigest: hash, cliVersion: '0.2.153', relayPid: 123,
    relayPolledAt: new Date(now - 500).toISOString(), startupBackend: 'systemd-user',
    firstLearning: 'no_eligible_history', verifiedAt: new Date(now).toISOString(), expiresAt: prepared.intent.expiresAt};
  const vault = await LocalVault.open({root: resolve(root, 'vault'), masterKey: randomBytes(32)}, prepared.scope);
  try {
    const claim = await vault.claimCodexSetupOperation(id(1), hash);
    if (claim.state !== 'acquired') throw new Error('fixture_claim_missing');
    let observations = 0, retained: Readonly<LocalCodexSetupReadiness> | undefined;
    const observedDigests: Array<string | undefined> = [];
    const owner = createCodexSetupReadinessOwner({intent: prepared.intent, workspace: root, scope: prepared.scope, vault,
      observe: async (_intent, _scope, historical, digest) => {observations++; retained = historical; observedDigests.push(digest); return {...value};}});
    await run({owner, intent: prepared.intent, lease: {leaseId: claim.leaseId, intentDigest: hash}, scope: prepared.scope,
      value, observations: () => observations, retained: () => retained, observedDigests: () => [...observedDigests]});
  } finally {prepared.scope.close(); await vault.close(); await rm(root, {recursive: true, force: true});}
}

test('owner persists a real receipt and verifies it by a separate fresh observation', async () => {
  await fixture(async f => {
    const result = await f.owner.record(f.lease);
    assert.equal(result.state, 'completed'); assert.equal(f.observations(), 1);
    assert.equal(f.retained(), undefined);
    assert.equal(await f.owner.verify(result.readinessReceiptId, f.intent, hash), true);
    assert.equal(f.observations(), 2);
    assert.equal(Object.isFrozen(f.retained()), true);
    assert.equal(f.retained()!.firstLearning, 'no_eligible_history');
    assert.equal(await f.owner.verify(id(99), f.intent, hash), false);
    assert.equal(await f.owner.verify(result.readinessReceiptId, f.intent, `sha256:${'b'.repeat(64)}`), false);
  });
});

test('readiness observer receives the exact original digest on record and independent verification', async () => {
  await fixture(async f => {
    const result = await f.owner.record(f.lease);
    assert.equal(await f.owner.verify(result.readinessReceiptId, f.intent, hash), true);
    assert.deepEqual(f.observedDigests(), [hash, hash]);
  });
});

test('generic completion status and incomplete runtime state cannot become readiness', async () => {
  await fixture(async f => {
    Object.assign(f.value, {relayPid: 0});
    await assert.rejects(f.owner.record(f.lease), /setup_readiness_invalid/);
  });
});

test('changed current identity, package, role, runtime or contract invalidates an existing receipt', async () => {
  await fixture(async f => {
    const result = await f.owner.record(f.lease), original = {...f.value};
    for (const delta of [{deviceId: id(30)}, {endpointId: id(30)}, {sessionId: 'different_session'},
      {manifestHash: `sha256:${'b'.repeat(64)}`}, {catalogHash: `sha256:${'b'.repeat(64)}`},
      {roleRevision: 2}, {policyHash: `sha256:${'b'.repeat(64)}`}, {contractDigest: `sha256:${'b'.repeat(64)}`},
      {relayPid: 456}, {cliVersion: '0.2.154'}]) {
      Object.assign(f.value, original, delta);
      assert.equal(await f.owner.verify(result.readinessReceiptId, f.intent, hash), false);
    }
    Object.assign(f.value, original);
    assert.equal(await f.owner.verify(result.readinessReceiptId, f.intent, hash), true);
  });
});

test('foreign recipient, source, policy or intent is denied without accepting copied readiness', async () => {
  await fixture(async f => {
    const result = await f.owner.record(f.lease), original = {...f.value};
    for (const delta of [{membershipId: id(30)}, {repositoryFingerprint: `sha256:${'b'.repeat(64)}`},
      {organizationId: 'org_foreign'}, {policyRevision: 'foreign-policy'}]) {
      Object.assign(f.value, original, delta);
      await assert.rejects(f.owner.record(f.lease), /setup_readiness_context_unconfirmed/);
      assert.equal(await f.owner.verify(result.readinessReceiptId, f.intent, hash), false);
    }
    Object.assign(f.value, original);
    assert.equal(await f.owner.verify(result.readinessReceiptId, {...f.intent, operationId: id(30)}, hash), false);
  });
});

test('withdrawing the original host denies both persistence and readiness exposure', async () => {
  await fixture(async f => {
    const result = await f.owner.record(f.lease), before = f.observations();
    f.scope.close();
    await assert.rejects(f.owner.record(f.lease), /codex_setup_host_scope_unavailable/);
    assert.equal(await f.owner.verify(result.readinessReceiptId, f.intent, hash), false);
    assert.equal(f.observations(), before);
  });
});

test('lease accessors are denied before observation or secret-bearing serialization', async () => {
  await fixture(async f => {
    let getters = 0;
    await assert.rejects(f.owner.record({get leaseId() {getters++; return f.lease.leaseId;}, intentDigest: hash}),
      /setup_readiness_lease_invalid/);
    assert.equal(getters, 0); assert.equal(f.observations(), 0);
  });
});

test('historical receipt requires fresh current state, not a newly written receipt', async t => {
  t.mock.timers.enable({apis: ['Date'], now: Date.now()});
  await fixture(async f => {
    const result = await f.owner.record(f.lease);
    t.mock.timers.tick(90_000);
    // Stale current observation is still denied, even with a genuine receipt.
    assert.equal(await f.owner.verify(result.readinessReceiptId, f.intent, hash), false);
    Object.assign(f.value, {verifiedAt: new Date().toISOString(), relayPolledAt: new Date().toISOString()});
    assert.equal(await f.owner.verify(result.readinessReceiptId, f.intent, hash), true);
    assert.notEqual(f.retained()!.verifiedAt, f.value.verifiedAt);
    // The original durable receipt is unchanged and idempotently reused.
    t.mock.timers.tick(510_000);
    Object.assign(f.value, {verifiedAt: new Date().toISOString(), relayPolledAt: new Date().toISOString()});
    assert.equal(await f.owner.verify(result.readinessReceiptId, f.intent, hash), false);
  });
});

test('historical receipt never admits a changed current binding after recovery delay', async t => {
  t.mock.timers.enable({apis: ['Date'], now: Date.now()});
  await fixture(async f => {
    const result = await f.owner.record(f.lease), original = {...f.value};
    t.mock.timers.tick(90_000);
    for (const delta of [{deviceId: id(30)}, {sessionId: 'foreign_session'}, {relayPid: 456},
      {manifestHash: `sha256:${'b'.repeat(64)}`}, {catalogHash: `sha256:${'b'.repeat(64)}`}, {roleRevision: 2}]) {
      Object.assign(f.value, original, delta, {verifiedAt: new Date().toISOString(), relayPolledAt: new Date().toISOString()});
      assert.equal(await f.owner.verify(result.readinessReceiptId, f.intent, hash), false);
    }
    Object.assign(f.value, original, {verifiedAt: new Date().toISOString(), relayPolledAt: new Date().toISOString()});
    assert.equal(await f.owner.verify(result.readinessReceiptId, f.intent, hash), true);
  });
});
