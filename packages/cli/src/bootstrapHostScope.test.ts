import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import test from 'node:test';
import ts from 'typescript';
import * as cli from './index.js';
import {prepareCodexBootstrapHost} from './bootstrapHostScope.js';
import * as host from './bootstrapHostScope.js';
import {AgentFabricClient} from '@dharma-ai-labs/agent-fabric-relay-client';
import {loadOrCreateVaultMasterKey} from '@dharma-ai-labs/agent-fabric-local-vault';

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

test('vault key access carries the closed owning context without opening a store', async () => {
  let reads = 0, outcome: PromiseSettledResult<Buffer>[] = [];
  const store = {backend: 'linux-secret-service' as const,
    async get() {reads++; return Buffer.alloc(32).toString('base64');},
    async put() {throw new Error('unexpected write');}, async delete() {throw new Error('unexpected delete');}};
  await assert.rejects(host.runCodexBootstrapHost(await fixture(), async prepared => {
    prepared.scope.close();
    outcome = await Promise.allSettled([loadOrCreateVaultMasterKey(store, host.currentBootstrapHostScope())]);
  }), {message: 'codex_setup_host_scope_unavailable'});
  assert.equal(outcome[0]?.status, 'rejected');
  if (outcome[0]?.status === 'rejected') assert.equal(outcome[0].reason.message, 'vault_key_scope_unavailable');
  assert.equal(reads, 0);
});

test('every CLI vault-key caller explicitly forwards the owning host scope', async () => {
  const text = await readFile(new URL('../src/index.ts', import.meta.url), 'utf8');
  const source = ts.createSourceFile('index.ts', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  let callers = 0, opened = 0, captures = 0;
  const visit = (node: ts.Node, owner = '') => {
    if (ts.isFunctionDeclaration(node)) owner = node.name?.text ?? owner;
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)
      && node.expression.text === 'loadOrCreateVaultMasterKey') {
      assert.equal(owner, 'openBootstrapVault', 'direct key callers must not bypass the scoped vault owner');
      callers++; assert.equal(node.arguments.length, 2);
      const store = node.arguments[0], scope = node.arguments[1];
      assert.ok(store && ts.isIdentifier(store) && store.text === 'undefined');
      assert.ok(scope && ts.isIdentifier(scope) && scope.text === 'scope');
    }
    if (ts.isVariableDeclaration(node) && owner === 'openBootstrapVault' && ts.isIdentifier(node.name)
      && node.name.text === 'scope') {
      captures++;
      const value = node.initializer;
      assert.ok(value && ts.isCallExpression(value) && ts.isIdentifier(value.expression)
        && value.expression.text === 'currentBootstrapHostScope' && value.arguments.length === 0);
    }
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'openBootstrapVault') opened++;
    ts.forEachChild(node, child => visit(child, owner));
  };
  visit(source); assert.equal(callers, 1); assert.equal(captures, 1); assert.equal(opened, 11);
});

test('receiver readiness forwards the owning scope into its journal self-test', async () => {
  const text = await readFile(new URL('../src/index.ts', import.meta.url), 'utf8');
  const source = ts.createSourceFile('index.ts', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const functions = source.statements.filter(ts.isFunctionDeclaration)
    .filter(node => node.name?.text === 'receiptAwareProviderCapabilities');
  assert.equal(functions.length, 1); let calls = 0;
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
      && node.expression.name.text === 'selfTest') {
      calls++; assert.equal(node.arguments.length, 1);
      const scope = node.arguments[0];
      assert.ok(scope && ts.isIdentifier(scope) && scope.text === 'hostScope');
    }
    ts.forEachChild(node, visit);
  };
  visit(functions[0]!); assert.equal(calls, 1);
});

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

function sourceCheck() {
  const check = (host as unknown as {assertBootstrapHostSource?: (workspace: string, fingerprint: string) => Promise<void>}).assertBootstrapHostSource;
  assert.equal(typeof check, 'function', 'host source binding is not enforced before enrollment');
  return check!;
}

test('owning setup refuses another checkout or fingerprint before enrollment', async () => {
  const api = contextApi(), check = sourceCheck(), input = await fixture();
  await assert.rejects(api.runCodexBootstrapHost(input, async () => {
    await assert.rejects(check(resolve('foreign-synthetic-checkout'), input.intent.repositoryFingerprint),
      {message: 'codex_setup_host_source_mismatch'});
  }), {message: 'codex_setup_host_scope_unavailable'});
  await assert.rejects(api.runCodexBootstrapHost(input, async () => {
    await assert.rejects(check(input.workspace, `sha256:${'b'.repeat(64)}`), {message: 'codex_setup_host_source_mismatch'});
  }), {message: 'codex_setup_host_scope_unavailable'});
});

test('owning setup accepts only its snapshotted source even if mutable flags change', async () => {
  const api = contextApi(), check = sourceCheck(), input = await fixture();
  await assert.rejects(api.runCodexBootstrapHost(input, async prepared => {
    const original = input.workspace;
    prepared.flags.set('workspace', resolve('foreign-synthetic-checkout'));
    input.workspace = resolve('another-synthetic-checkout');
    input.intent.repositoryFingerprint = `sha256:${'b'.repeat(64)}`;
    await check(original, prepared.intent.repositoryFingerprint);
    await assert.rejects(check(input.workspace, input.intent.repositoryFingerprint), {message: 'codex_setup_host_source_mismatch'});
  }), {message: 'codex_setup_host_scope_unavailable'});
});

test('source mismatch permanently withdraws subsequent protected operations', async () => {
  const api = contextApi(), check = sourceCheck(), input = await fixture();
  let effects = 0;
  await assert.rejects(api.runCodexBootstrapHost(input, async prepared => {
    await assert.rejects(check(input.workspace, `sha256:${'b'.repeat(64)}`), {message: 'codex_setup_host_source_mismatch'});
    await assert.rejects(prepared.scope.step(async () => {effects++;}), {message: 'codex_setup_host_scope_unavailable'});
  }), {message: 'codex_setup_host_scope_unavailable'});
  assert.equal(effects, 0);
});

test('capability projection cannot downgrade a closed scope into an ordinary unavailable receiver', async () => {
  const api = contextApi();
  let observed: PromiseSettledResult<unknown>[] = [];
  await assert.rejects(api.runCodexBootstrapHost(await fixture(), async prepared => {
    prepared.scope.close();
    observed = await Promise.allSettled([cli.receiptAwareProviderCapabilities([])]);
  }), {message: 'codex_setup_host_scope_unavailable'});
  assert.equal(observed[0]?.status, 'rejected');
  if (observed[0]?.status === 'rejected') assert.equal(observed[0].reason.message, 'codex_setup_host_scope_unavailable');
});

test('original native scope continuation preserves owner identity and immutable preparation through actual CLI planning', async () => {
  const input = await fixture(), prepared = prepareCodexBootstrapHost(input);
  prepared.flags.set('workspace', resolve('foreign-synthetic-checkout'));
  prepared.flags.delete('dry-run'); input.workspace = resolve('another-synthetic-checkout');
  input.intent.organizationId = 'org_foreign';
  try {
    await host.runCodexBootstrapHostScope(prepared.scope, async captured => {
      assert.equal(captured.scope, prepared.scope);
      assert.equal(host.currentBootstrapHostScope(), prepared.scope);
      assert.equal(captured.intent.organizationId, 'org_demo');
      assert.notEqual(captured.flags.get('workspace'), input.workspace);
      assert.equal(captured.flags.get('dry-run'), true);
      await host.assertBootstrapHostSource(String(captured.flags.get('workspace')), captured.intent.repositoryFingerprint);
    });
    const result = await cli.bootstrapFromCodexSetupScope(prepared.scope) as Record<string, unknown>;
    assert.equal(result.stage, 'plan'); assert.equal(result.effects, false); assert.equal(result.organizationId, 'org_demo');
    assert.equal(prepared.scope.signal.aborted, false, 'only the native owner may finish this live lifetime');
    assert.equal(host.currentBootstrapHostScope(), undefined);
  } finally {prepared.scope.close();}
  await assert.rejects(cli.bootstrapFromCodexSetupScope(prepared.scope), {message: 'codex_setup_host_scope_unavailable'});
});

test('original native scope continuation refuses counterfeit authority without invoking it', async () => {
  let calls = 0;
  const original = prepareCodexBootstrapHost(await fixture());
  const counterfeit = {...original.scope, current: async () => {calls++; return true;},
    assert: async () => {calls++;}, step: async <T>(operation: () => Promise<T>) => {calls++; return operation();}};
  try {
    await assert.rejects(cli.bootstrapFromCodexSetupScope(counterfeit), {message: 'codex_setup_host_scope_invalid'});
    const proxy = new Proxy(original.scope, {get() {calls++; throw new Error('private-counterfeit');}});
    await assert.rejects(cli.bootstrapFromCodexSetupScope(proxy), {message: 'codex_setup_host_scope_invalid'});
    assert.equal(calls, 0);
  } finally {original.scope.close();}
});

test('original native scope continuation rejects nested and concurrent substitution', async () => {
  const original = prepareCodexBootstrapHost(await fixture());
  let entered!: () => void, release!: () => void;
  const ready = new Promise<void>(done => {entered = done;});
  const wait = new Promise<void>(done => {release = done;});
  const active = host.runCodexBootstrapHostScope(original.scope, async () => {
    await assert.rejects(cli.bootstrapFromCodexSetupScope(original.scope), {message: 'codex_setup_host_context_conflict'});
    entered(); await wait;
  });
  try {
    await ready;
    await assert.rejects(cli.bootstrapFromCodexSetupScope(original.scope), {message: 'codex_setup_host_context_conflict'});
    release(); await active;
    assert.equal(await original.scope.current(), true);
  } finally {release(); await active; original.scope.close();}
});

test('original native scope continuation keeps detached work subject to later owner withdrawal', async () => {
  const original = prepareCodexBootstrapHost(await fixture());
  let release!: () => void, late!: Promise<void>, effects = 0;
  const wait = new Promise<void>(done => {release = done;});
  await host.runCodexBootstrapHostScope(original.scope, async () => {
    late = (async () => {
      await wait;
      const scope = host.currentBootstrapHostScope(); assert.equal(scope, original.scope);
      await assert.rejects(scope!.step(async () => {effects++;}), {message: 'codex_setup_host_scope_unavailable'});
    })();
  });
  original.scope.close(); release(); await late; assert.equal(effects, 0);
});

test('original native scope continuation cannot borrow a scope still owned by another host run', async () => {
  const input = await fixture(); let exported: host.BootstrapHostScope | undefined;
  let entered!: () => void, release!: () => void;
  const ready = new Promise<void>(done => {entered = done;});
  const wait = new Promise<void>(done => {release = done;});
  const active = host.runCodexBootstrapHost(input, async prepared => {exported = prepared.scope; entered(); await wait;});
  try {
    await ready;
    await assert.rejects(cli.bootstrapFromCodexSetupScope(exported!), {message: 'codex_setup_host_context_conflict'});
    release(); await active;
  } finally {release(); await active;}
});

test('settled borrowed context cannot admit a detached effect while the original native owner is still live', async () => {
  const original = prepareCodexBootstrapHost(await fixture());
  let release!: () => void, late!: Promise<void>, effects = 0;
  const wait = new Promise<void>(done => {release = done;});
  await host.runCodexBootstrapHostScope(original.scope, async () => {
    late = (async () => {
      await wait;
      const scope = host.currentBootstrapHostScope(); assert.equal(scope, original.scope);
      await assert.rejects(scope!.step(async () => {effects++;}), {message: 'codex_setup_host_scope_unavailable'});
    })();
  });
  assert.equal(await original.scope.current(), true);
  release(); await late;
  assert.equal(effects, 0); assert.equal(original.scope.signal.aborted, true);
  await assert.rejects(cli.bootstrapFromCodexSetupScope(original.scope), {message: 'codex_setup_host_scope_unavailable'});
});
