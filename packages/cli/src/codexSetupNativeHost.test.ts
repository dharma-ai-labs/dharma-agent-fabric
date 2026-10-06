import assert from 'node:assert/strict';
import {resolve} from 'node:path';
import test from 'node:test';
import type {CodexStdioTransport} from '@dharma-ai-labs/agent-fabric-provider-adapters/experimental/codex-transport';
import type {CodexToolHandler} from '@dharma-ai-labs/agent-fabric-provider-adapters/experimental/codex-session';
import {CODEX_SETUP_TOOL, type CodexSetupIntent, type CodexSetupJournal} from './codexSetupAdmission.js';
import {CODEX_PEER_TOOLS} from './codexPeerTools.js';
import type {BootstrapHostScope} from './bootstrapHostScope.js';
import * as native from './codexSetupNativeHost.js';

const id = (n: number) => `${String(n).padStart(8, '0')}-1111-4111-8111-111111111111`;
const workspace = resolve('synthetic-source');
type Input = {
  transport: CodexStdioTransport; workspace: string; name: string; intent: CodexSetupIntent;
  openJournal(scope: BootstrapHostScope): Promise<CodexSetupJournal & {close(): void | Promise<void>}>;
  signal: AbortSignal; maximumProviderCostCents: number;
  additionalFilesystemRules?: Readonly<Record<string, 'read' | 'deny'>>;
  current(): Promise<boolean>; reserve(operationId: string, cents: number): Promise<boolean>;
  execute: Parameters<typeof native.startCodexSetupNativeHost>[0]['execute'];
  verifyReadiness: Parameters<typeof import('./codexSetupAdmission.js').createCodexSetupAdmission>[0]['verifyReadiness'];
};
type Host = {threadId: string; turnId: string; close(): Promise<void>; settled: Promise<unknown>};
const open = (input: Input): Promise<Host> => {
  const method = (native as unknown as {startCodexSetupNativeHost?: (input: Input) => Promise<Host>}).startCodexSetupNativeHost;
  assert.equal(typeof method, 'function', 'native setup host registration is absent');
  return method!(input);
};
function fixture() {
  const now = Date.now(), lifetime = new AbortController(), client = new AbortController();
  const intent: CodexSetupIntent = {schema: 'dharma.codex-setup-intent/v1', operationId: id(1), setupReference: id(2),
    organizationId: 'org_demo', recipientMembershipId: id(3), origin: 'https://hq.example', hostContextId: id(4),
    repositoryFingerprint: `sha256:${'a'.repeat(64)}`, scopeDigest: `sha256:${'b'.repeat(64)}`,
    contractDigest: `sha256:${'c'.repeat(64)}`, policyRevision: 'policy-v1',
    issuedAt: new Date(now - 1000).toISOString(), expiresAt: new Date(now + 60_000).toISOString()};
  const calls: Array<{method: string; params: Record<string, unknown>}> = [];
  const listeners = new Set<(event: unknown) => void>();
  let handler: CodexToolHandler | undefined, allowed = true, reserved = 0, executions = 0, claims = 0, closes = 0;
  let result: unknown, digest = '', claimed = false, permission = true, network = false;
  const thread = {id: 'synthetic_thread', cwd: workspace, name: 'implementer', status: {type: 'idle'}};
  const emit = (event: unknown) => {for (const listener of [...listeners]) listener(event);};
  const transport: CodexStdioTransport = {
    signal: lifetime.signal,
    onNotification(listener) {listeners.add(listener); return () => {listeners.delete(listener);};},
    onToolCall(next) {assert.equal(handler, undefined); handler = next; return () => {handler = undefined;};},
    async close() {closes++; lifetime.abort();},
    async request(method, params) {
      calls.push({method, params});
      if (method === 'permissionProfile/list') return {data: [{id: 'dharma_bridge', allowed: permission}]};
      if (method === 'config/read') return {config: {permissions: {dharma_bridge: {
        filesystem: {':minimal': 'read', ':workspace_roots': {'.': 'read'}}, network: {enabled: network}}}}};
      if (method === 'thread/start' || method === 'thread/read') return {thread};
      if (method === 'thread/name/set' || method === 'turn/interrupt') return {};
      if (method === 'turn/start') return {turn: {id: 'synthetic_turn', status: 'inProgress'}};
      throw new Error('unexpected synthetic method');
    },
  };
  const journal: CodexSetupJournal = {
    async claim(_operation, next) {claims++; if (claimed) return result
      ? {state: 'terminal', intentDigest: digest, result} : {state: 'running', intentDigest: digest};
      claimed = true; digest = next; return {state: 'acquired', intentDigest: next, leaseId: id(5)};},
    async finish(_lease, next, accepted) {assert.equal(next, digest); result = accepted;},
  };
  const input: Input = {transport, workspace, name: 'implementer', intent,
    openJournal: async () => ({...journal, close() {}}), signal: client.signal,
    maximumProviderCostCents: 25, current: async () => allowed,
    reserve: async (operationId, cents) => {assert.equal(operationId, id(1)); assert.equal(cents, 25); reserved++; return true;},
    execute: async () => {executions++; return {state: 'completed', readinessReceiptId: id(6)};},
    verifyReadiness: async receipt => receipt === id(6)};
  const tool = (patch: Record<string, unknown> = {}) => {
    assert.ok(handler, 'native handler is not registered');
    return handler({threadId: 'synthetic_thread', turnId: 'synthetic_turn', callId: 'call_1', namespace: null,
      tool: 'dharma_setup_reference', arguments: {operationId: id(1), setupReference: id(2)}, ...patch}, {signal: lifetime.signal});
  };
  const complete = (threadId = 'synthetic_thread', turnId = 'synthetic_turn') => emit({method: 'turn/completed',
    params: {threadId, turn: {id: turnId, status: 'completed'}}});
  return {input, calls, transport, tool, complete, client, lifetime,
    allow(next: boolean) {allowed = next;}, profile(next: boolean) {permission = next;}, network(next: boolean) {network = next;},
    get counts() {return {reserved, executions, claims, closes, listeners: listeners.size, handler: Boolean(handler)};}};
}

test('native setup host registers only fixed tools and binds execution to verified original native turn', async () => {
  const f = fixture(), host = await open(f.input);
  try {
    assert.equal(host.threadId, 'synthetic_thread'); assert.equal(host.turnId, 'synthetic_turn');
    const start = f.calls.find(call => call.method === 'thread/start')!;
    assert.deepEqual(start.params.dynamicTools, [...CODEX_PEER_TOOLS, CODEX_SETUP_TOOL]);
    assert.equal(start.params.permissions, 'dharma_bridge'); assert.equal(start.params.approvalPolicy, 'never');
    assert.equal(f.counts.reserved, 1);
    assert.equal((await f.tool({turnId: 'foreign'})).success, false);
    assert.equal((await f.tool({tool: 'dharma_peer_ask', callId: 'peer'})).success, false);
    assert.equal(f.counts.claims, 0);
    assert.equal((await f.tool()).success, true); assert.equal(f.counts.executions, 1);
    f.complete('foreign', 'synthetic_turn');
    assert.equal((await f.tool({callId: 'reconcile'})).success, true); assert.equal(f.counts.executions, 1);
    f.complete(); await host.settled;
    assert.equal(f.counts.handler, false); assert.equal(f.counts.listeners, 0);
  } finally {await host.close();}
});

test('early native tool waits for the verified turn/start response rather than guessing turn identity', async () => {
  const f = fixture(), request = f.transport.request;
  let resolveTurn!: (value: unknown) => void, early!: ReturnType<CodexToolHandler>;
  let entered!: () => void; const started = new Promise<void>(done => {entered = done;});
  f.transport.request = async (method, params) => {
    if (method !== 'turn/start') return request(method, params);
    early = f.tool(); entered(); return new Promise(done => {resolveTurn = done;});
  };
  const opening = open(f.input); await started;
  assert.equal(f.counts.executions, 0); assert.equal(f.counts.claims, 0);
  resolveTurn({turn: {id: 'synthetic_turn', status: 'inProgress'}});
  const host = await opening;
  try {assert.equal((await early).success, true); assert.equal(f.counts.executions, 1);}
  finally {await host.close();}
});

test('unqualified or expanded setup profile prevents thread creation and model reservation', async () => {
  for (const changed of ['permission', 'network'] as const) {
    const f = fixture(); if (changed === 'permission') f.profile(false); else f.network(true);
    await assert.rejects(open(f.input), {message: 'codex_setup_native_profile_unavailable'});
    assert.equal(f.calls.some(call => call.method === 'thread/start'), false);
    assert.equal(f.counts.reserved, 0); assert.equal(f.counts.claims, 0);
  }
});

test('closed scope or denied budget never starts a model turn or claims setup authority', async () => {
  const closed = fixture(); closed.client.abort();
  await assert.rejects(open(closed.input), {message: 'codex_setup_host_scope_unavailable'});
  assert.equal(closed.calls.length, 0);
  const denied = fixture(); denied.input.reserve = async () => false;
  await assert.rejects(open(denied.input), {message: 'codex_setup_native_budget_unavailable'});
  assert.equal(denied.calls.some(call => call.method === 'turn/start'), false);
  assert.equal(denied.counts.claims, 0);
});

test('matching completion during turn/start response prevents later setup even if its handler arrived early', async () => {
  const f = fixture(), request = f.transport.request;
  let early!: ReturnType<CodexToolHandler>;
  f.transport.request = async (method, params) => {
    if (method !== 'turn/start') return request(method, params);
    early = f.tool(); f.complete(); return {turn: {id: 'synthetic_turn', status: 'inProgress'}};
  };
  const host = await open(f.input);
  try {await host.settled; assert.equal((await early).success, false); assert.equal(f.counts.executions, 0);}
  finally {await host.close();}
});

test('disconnect after bounded status withdraws a still-owned pending setup operation', async () => {
  const f = fixture(); let entered!: () => void, stopped = false, effects = 0;
  const running = new Promise<void>(done => {entered = done;});
  f.input.execute = async (_intent, signal, current) => {
    entered(); await new Promise<void>(done => {if (signal.aborted) done(); else signal.addEventListener('abort', () => done(), {once: true});});
    if (await current()) effects++; stopped = true; return {state: 'unconfirmed', code: 'setup_execution_unconfirmed'};
  };
  const host = await open(f.input);
  try {
    const response = f.tool(); await running;
    assert.equal((await response).success, false); assert.equal(stopped, false);
    f.lifetime.abort(); await host.settled;
    assert.equal(stopped, true); assert.equal(effects, 0); assert.equal(f.counts.handler, false);
  } finally {await host.close();}
});

test('invalid native turn response or private native failure does not disclose diagnostics or execute setup', async () => {
  for (const outcome of [async () => ({turn: {id: 'foreign/id'}}), async () => {throw new Error('native-private-canary');}]) {
    const f = fixture(), request = f.transport.request;
    f.transport.request = async (method, params) => method === 'turn/start' ? outcome() : request(method, params);
    await assert.rejects(open(f.input), {message: 'codex_setup_native_start_failed'});
    assert.equal(f.counts.claims, 0); assert.equal(f.counts.handler, false); assert.equal(f.counts.listeners, 0);
  }
});

test('native setup reservation requires literal true before model dispatch', async () => {
  const nonboolean = fixture();
  nonboolean.input.reserve = (async () => 'true') as unknown as Input['reserve'];
  await assert.rejects(open(nonboolean.input), {message: 'codex_setup_native_budget_unavailable'});
  assert.equal(nonboolean.calls.some(call => call.method === 'turn/start'), false);
});

test('profile changes during reservation are rejected before model dispatch', async () => {
  const changed = fixture();
  changed.input.reserve = async () => {changed.network(true); return true;};
  await assert.rejects(open(changed.input), {message: 'codex_setup_native_profile_unavailable'});
  assert.equal(changed.calls.some(call => call.method === 'turn/start'), false);
});

test('cancellation inside notification registration removes the acquired listener and never installs tools', async () => {
  const f = fixture(), register = f.transport.onNotification;
  f.transport.onNotification = listener => {const remove = register(listener); f.client.abort(); return remove;};
  await assert.rejects(open(f.input), {message: 'codex_setup_host_scope_unavailable'});
  assert.equal(f.counts.listeners, 0); assert.equal(f.counts.handler, false);
  assert.equal(f.counts.reserved, 0); assert.equal(f.counts.claims, 0);
});

test('original early-call arguments are immutable across the native response wait', async () => {
  const f = fixture(), request = f.transport.request;
  let early!: ReturnType<CodexToolHandler>;
  f.transport.request = async (method, params) => {
    if (method !== 'turn/start') return request(method, params);
    const args = {operationId: id(8), setupReference: id(2)};
    early = f.tool({arguments: args}); args.operationId = id(1);
    return {turn: {id: 'synthetic_turn', status: 'inProgress'}};
  };
  const host = await open(f.input);
  try {assert.equal((await early).success, false); assert.equal(f.counts.claims, 0);}
  finally {await host.close();}
});

test('withdrawal after native turn acquisition preserves exact owned-turn control for interruption', async () => {
  const f = fixture(), request = f.transport.request;
  f.transport.request = async (method, params) => {
    const response = await request(method, params);
    if (method === 'turn/start') f.client.abort();
    return response;
  };
  await assert.rejects(open(f.input), {message: 'codex_setup_host_scope_unavailable'});
  assert.deepEqual(f.calls.filter(call => call.method === 'turn/interrupt'), [{method: 'turn/interrupt',
    params: {threadId: 'synthetic_thread', turnId: 'synthetic_turn'}}]);
  assert.equal(f.counts.handler, false); assert.equal(f.counts.listeners, 0); assert.equal(f.counts.claims, 0);
});

test('journal opening receives the native owning scope and closes a post-acquisition denied backend once', async () => {
  const f = fixture(); let closes = 0;
  f.input.openJournal = async scope => {
    assert.equal(await scope.current(), true); f.client.abort();
    return {claim: async () => {throw new Error('unexpected claim');}, finish: async () => {throw new Error('unexpected finish');},
      close() {closes++;}};
  };
  await assert.rejects(open(f.input), {message: 'codex_setup_host_scope_unavailable'});
  assert.equal(closes, 1); assert.equal(f.calls.some(call => call.method === 'turn/start'), false);
});

test('terminal native turn closes its owning journal scope and backend before settlement', async () => {
  const f = fixture(), original = f.input.openJournal;
  let scope!: BootstrapHostScope, closes = 0;
  f.input.openJournal = async owning => {
    scope = owning; const backend = await original(owning);
    return {...backend, close() {closes++; backend.close();}};
  };
  const host = await open(f.input);
  try {
    assert.equal((await f.tool()).success, true); f.complete(); await host.settled;
    assert.equal(await scope.current(), false); assert.equal(closes, 1);
  } finally {await host.close();}
  assert.equal(closes, 1);
});

test('native settlement waits for asynchronous protected-vault closure and does not close it twice', async () => {
  const f = fixture(), original = f.input.openJournal;
  let entered!: () => void, release!: () => void, closes = 0, settled = false;
  const started = new Promise<void>(done => {entered = done;});
  const closure = new Promise<void>(done => {release = done;});
  f.input.openJournal = async scope => ({...await original(scope), close: async () => {
    closes++; entered(); await closure;
  }});
  const owner = await open(f.input);
  try {
    void owner.settled.then(() => {settled = true;});
    f.complete(); await started; await new Promise<void>(done => setImmediate(done));
    assert.equal(settled, false, 'native settlement is not proof of pending vault closure');
    assert.equal(closes, 1); release(); await owner.settled;
    await owner.close(); assert.equal(closes, 1);
  } finally {release(); await owner.close();}
});

test('asynchronous journal cleanup failure remains unconfirmed and does not expose private errors', async () => {
  const f = fixture(), original = f.input.openJournal; let closes = 0;
  f.input.openJournal = async scope => ({...await original(scope), close: async () => {
    closes++; throw new Error('private-vault-close-canary');
  }});
  const owner = await open(f.input); f.complete();
  await assert.rejects(owner.settled, {message: 'codex_setup_native_journal_close_unconfirmed'});
  await assert.rejects(owner.close(), {message: 'codex_setup_native_journal_close_unconfirmed'});
  assert.equal(closes, 1); assert.equal(f.counts.handler, false); assert.equal(f.counts.listeners, 0);
});

test('individual native tool cancellation withdraws the original scope and waits for its accepted executor to settle', async () => {
  const f = fixture(), original = f.input.openJournal, call = new AbortController();
  let owning!: BootstrapHostScope, handler!: CodexToolHandler, entered!: () => void, release!: () => void;
  let closed = 0, effects = 0, settled = false;
  const enteredExecution = new Promise<void>(done => {entered = done;});
  const wait = new Promise<void>(done => {release = done;});
  const register = f.transport.onToolCall;
  f.transport.onToolCall = next => {handler = next; return register(next);};
  f.input.openJournal = async scope => {
    owning = scope; const backend = await original(scope);
    return {...backend, close() {closed++; backend.close();}};
  };
  f.input.execute = async (_intent, _signal, _current, _lease, scope) => {
    assert.equal(scope, owning); entered(); await wait;
    await assert.rejects(scope.step(async () => {effects++;}), {message: 'codex_setup_host_scope_unavailable'});
    return {state: 'completed', readinessReceiptId: id(6)};
  };
  const owner = await open(f.input);
  try {
    const response = handler({threadId: 'synthetic_thread', turnId: 'synthetic_turn', callId: 'private_call',
      tool: 'dharma_setup_reference', namespace: null, arguments: {operationId: id(1), setupReference: id(2)}}, {signal: call.signal});
    await enteredExecution; call.abort();
    void owner.settled.then(() => {settled = true;});
    await new Promise<void>(done => setImmediate(done));
    assert.equal(owning.signal.aborted, true); assert.equal(settled, false); assert.equal(closed, 0);
    release(); assert.equal((await response).success, false); await owner.settled;
    assert.equal(closed, 1); assert.equal(effects, 0);
  } finally {release(); await owner.close();}
});
