import assert from 'node:assert/strict';
import {resolve} from 'node:path';
import test from 'node:test';
import * as cli from './index.js';
import {prepareCodexBootstrapHost} from './bootstrapHostScope.js';
import * as host from './bootstrapHostScope.js';
import {AgentFabricClient} from '@dharma-ai-labs/agent-fabric-relay-client';

const id = (n: number) => `${String(n).padStart(8, '0')}-1111-4111-8111-111111111111`;
const digest = `sha256:${'a'.repeat(64)}`;
async function fixture() {
  const now = Date.now();
  const contract = await cli.loadAgentFabricOnboardingContract();
  return {intent: {schema: 'dharma.codex-setup-intent/v1' as const, operationId: id(1), setupReference: id(2),
    organizationId: 'org_demo', recipientMembershipId: id(3), origin: 'https://hq.example',
    repositoryFingerprint: digest, policyRevision: 'policy-v1', scopeDigest: digest,
    contractDigest: `sha256:${contract.sha256}`, hostContextId: id(4),
    issuedAt: new Date(now - 1000).toISOString(), expiresAt: new Date(now + 60_000).toISOString()},
    workspace: resolve('nonexistent-synthetic-checkout'), signal: new AbortController().signal,
    current: async () => true, dryRun: true};
}
async function invoke(input: unknown): Promise<any> {
  const entry = (cli as unknown as {bootstrapFromCodexSetup?: (input: unknown) => Promise<unknown>}).bootstrapFromCodexSetup;
  assert.equal(typeof entry, 'function', 'official host-facing bootstrap entry is absent');
  return entry!(input);
}

test('official host entry refuses cancelled scope before selecting a checkout or protected store', async () => {
  const input = await fixture(); const aborted = new AbortController(); aborted.abort('private-abort-canary');
  await assert.rejects(invoke({...input, signal: aborted.signal}), {message: 'codex_setup_host_scope_unavailable'});
});

test('official host entry permanently refuses false, nonboolean and throwing live authority', async () => {
  for (const current of [async () => false, async () => 'true', async () => {throw new Error('private-scope-canary');}]) {
    await assert.rejects(invoke({...await fixture(), current}), {message: 'codex_setup_host_scope_unavailable'});
  }
});

test('official host entry refuses expired intent and model-selected flags', async () => {
  const input = await fixture();
  await assert.rejects(invoke({...input, intent: {...input.intent, expiresAt: input.intent.issuedAt}}),
    {message: 'codex_setup_host_scope_invalid'});
  await assert.rejects(invoke({...input, grant: 'private-grant-canary'}), {message: 'codex_setup_host_scope_invalid'});
});

test('official host entry checks live authority again while preparing the public plan', async () => {
  let calls = 0;
  await assert.rejects(invoke({...await fixture(), current: async () => ++calls === 1}),
    {message: 'codex_setup_host_scope_unavailable'});
  assert.ok(calls >= 2);
});

test('official host entry uses the real grant-free bootstrap planning branch without native effects', async () => {
  const input = await fixture();
  const plan = await invoke(input);
  assert.equal(plan.ok, true); assert.equal(plan.stage, 'plan'); assert.equal(plan.setupTransport, 'public_claim_v1');
  assert.equal(plan.effects, false); assert.equal(plan.grantRedeemed, false);
  assert.equal(plan.setupReference, input.intent.setupReference);
  assert.equal(plan.organizationId, input.intent.organizationId);
  assert.equal(JSON.stringify(plan).includes('private-'), false);
});

test('unfinished host execution refuses effects before checkout selection or authority consumption', async () => {
  const result = await invoke({...await fixture(), dryRun: false});
  assert.equal(result.ok, false);
  assert.equal(result.code, 'codex_setup_host_execution_unqualified');
  assert.equal(result.stage, 'host_setup_unavailable');
  assert.equal(result.effects, false);
  assert.equal(result.grantRedeemed, false);
});

test('descriptor failures are classified without reflecting host-private diagnostics', async () => {
  const input = new Proxy(await fixture(), {ownKeys() {throw new Error('private-descriptor-canary');}});
  await assert.rejects(invoke(input), {message: 'codex_setup_host_scope_invalid'});
});

test('a clock-boundary denial permanently withdraws the host scope', async t => {
  const input = await fixture(); const scope = prepareCodexBootstrapHost(input).scope;
  const actual = Date.now();
  t.mock.method(Date, 'now', () => Date.parse(input.intent.issuedAt) - 1);
  assert.equal(await scope.current(), false);
  t.mock.method(Date, 'now', () => actual);
  assert.equal(await scope.current(), false);
  assert.equal(scope.signal.aborted, true);
});

test('host scope snapshots the selected intent and qualification callback', async () => {
  const input = await fixture(); const prepared = prepareCodexBootstrapHost(input);
  input.intent.organizationId = 'org_foreign'; input.current = async () => false;
  assert.equal(prepared.intent.organizationId, 'org_demo');
  assert.equal(prepared.flags.get('organization-id'), 'org_demo');
  assert.equal(await prepared.scope.current(), true);
});

test('a step does not return a protected result after mid-operation cancellation', async () => {
  const input = await fixture(); const abort = new AbortController();
  const scope = prepareCodexBootstrapHost({...input, signal: abort.signal}).scope;
  await assert.rejects(scope.step(async () => {abort.abort(); return 'private-result-canary';}),
    {message: 'codex_setup_host_scope_unavailable'});
  let effects = 0;
  await assert.rejects(scope.step(async () => {effects++;}), {message: 'codex_setup_host_scope_unavailable'});
  assert.equal(effects, 0);
});

test('expiry during qualification withdraws scope even if the clock subsequently recovers', async t => {
  const input = await fixture(); const actual = Date.now();
  let calls = 0;
  const scope = prepareCodexBootstrapHost({...input, current: async () => {
    if (++calls === 1) t.mock.method(Date, 'now', () => Date.parse(input.intent.expiresAt) + 1);
    return true;
  }}).scope;
  assert.equal(await scope.current(), false);
  t.mock.method(Date, 'now', () => actual);
  assert.equal(await scope.current(), false);
  assert.equal(calls, 1);
  assert.equal(scope.signal.aborted, true);
});

function contextApi() {
  const api = host as unknown as {
    runCodexBootstrapHost: (input: Awaited<ReturnType<typeof fixture>>, operation: (prepared: ReturnType<typeof prepareCodexBootstrapHost>) => Promise<unknown>) => Promise<unknown>;
    currentBootstrapHostScope: () => ReturnType<typeof prepareCodexBootstrapHost>['scope'] | undefined;
  };
  assert.equal(typeof api.runCodexBootstrapHost, 'function', 'owning operation has no lifetime-scoped continuation');
  assert.equal(typeof api.currentBootstrapHostScope, 'function');
  return api;
}

test('settling the owning operation withdraws its scope without changing the external host signal', async () => {
  const api = contextApi(); const input = await fixture();
  let saved: ReturnType<typeof prepareCodexBootstrapHost>['scope'] | undefined;
  const result = await api.runCodexBootstrapHost(input, async prepared => {
    saved = prepared.scope;
    assert.equal(api.currentBootstrapHostScope(), saved);
    assert.equal(await saved.current(), true);
    return 'public-result';
  });
  assert.equal(result, 'public-result');
  assert.equal(input.signal.aborted, false);
  assert.equal(saved!.signal.aborted, true);
  assert.equal(await saved!.current(), false);
  assert.equal(api.currentBootstrapHostScope(), undefined);
});

test('failed owning operation closes authority and does not contaminate the following operation', async () => {
  const api = contextApi(); let saved: ReturnType<typeof prepareCodexBootstrapHost>['scope'] | undefined;
  await assert.rejects(api.runCodexBootstrapHost(await fixture(), async prepared => {
    saved = prepared.scope; throw new Error('synthetic-operation-failed');
  }), {message: 'synthetic-operation-failed'});
  assert.equal(saved!.signal.aborted, true);
  await api.runCodexBootstrapHost(await fixture(), async prepared => {
    assert.notEqual(prepared.scope, saved);
    assert.equal(await prepared.scope.current(), true);
  });
});

test('concurrent owning operations retain separate async scopes', async () => {
  const api = contextApi(); const seen = new Set<unknown>();
  await Promise.all([1, 2].map(async () => api.runCodexBootstrapHost(await fixture(), async prepared => {
    seen.add(prepared.scope);
    await new Promise<void>(done => setImmediate(done));
    assert.equal(api.currentBootstrapHostScope(), prepared.scope);
    assert.equal(await prepared.scope.current(), true);
  })));
  assert.equal(seen.size, 2);
});

test('detached continuation retains a closed scope rather than silently becoming unscoped', async () => {
  const api = contextApi(); let release!: () => void;
  const ready = new Promise<void>(done => {release = done;});
  let late!: Promise<void>; let effects = 0;
  await api.runCodexBootstrapHost(await fixture(), async prepared => {
    late = (async () => {
      await ready;
      const scope = api.currentBootstrapHostScope();
      assert.equal(scope, prepared.scope);
      await assert.rejects(scope!.step(async () => {effects++;}), {message: 'codex_setup_host_scope_unavailable'});
    })();
  });
  release(); await late; assert.equal(effects, 0);
});

test('nested setup cannot substitute a fresh authority into an existing owning operation', async () => {
  const api = contextApi(); let effects = 0;
  await api.runCodexBootstrapHost(await fixture(), async () => {
    await assert.rejects(api.runCodexBootstrapHost(await fixture(), async () => {effects++;}),
      {message: 'codex_setup_host_context_conflict'});
  });
  assert.equal(effects, 0);
});

test('scope methods cannot be replaced to transfer setup authority', async () => {
  const prepared = prepareCodexBootstrapHost(await fixture());
  assert.equal(Object.isFrozen(prepared.scope), true);
  assert.throws(() => {prepared.scope.current = async () => true;}, TypeError);
});

test('step requalifies on vendor failure before disclosing its diagnostic', async () => {
  let valid = true;
  const scope = prepareCodexBootstrapHost({...await fixture(), current: async () => valid}).scope;
  await assert.rejects(scope.step(async () => {valid = false; throw new Error('private-vendor-canary');}),
    {message: 'codex_setup_host_scope_unavailable'});
  assert.equal(scope.signal.aborted, true);
});

test('the real default relay probe passes the owning scope instead of opening an unscoped client', async t => {
  const api = contextApi(); const input = await fixture();
  const config = {organizationId: input.intent.organizationId, deviceId: id(8)};
  let observed: unknown;
  t.mock.method(AgentFabricClient, 'open', async (options: Parameters<typeof AgentFabricClient.open>[0]) => {
    observed = options.hostScope;
    return {config, async openSession() {return {ok: true};}};
  });
  await api.runCodexBootstrapHost(input, async prepared => {
    const result = await cli.probeRelayConnection();
    assert.equal(observed, prepared.scope);
    assert.equal(result.deviceId, config.deviceId);
  });
  assert.equal((observed as AbortSignal & {signal: AbortSignal}).signal.aborted, true);
});

test('the public host entry withholds active vendor diagnostics and closes scope on failure', async t => {
  const input = await fixture();
  const actual = Date.now(); let calls = 0;
  // Force a safe contract precondition to fail after host validation. No native
  // effects are allowed by the planning branch.
  input.intent.contractDigest = `sha256:${'b'.repeat(64)}`;
  input.current = async () => {calls++; return true;};
  await assert.rejects(invoke(input), {message: 'codex_setup_host_operation_failed'});
  assert.ok(calls > 1); assert.equal(input.signal.aborted, false);
  assert.ok(Date.now() >= actual);
});
