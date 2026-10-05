import assert from 'node:assert/strict';
import {resolve} from 'node:path';
import test from 'node:test';
import * as cli from './index.js';
import {prepareCodexBootstrapHost} from './bootstrapHostScope.js';

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
