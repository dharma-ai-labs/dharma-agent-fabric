import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {compileFunction} from 'node:vm';
import test from 'node:test';
import ts from 'typescript';
import {prepareCodexBootstrapHost} from './bootstrapHostScope.js';

// Actual declarations with explicitly synthetic provider/filesystem boundaries.
async function declaration(file: string, name: string, dependencies: Record<string, unknown>) {
  const source = await readFile(new URL(`../src/${file}`, import.meta.url), 'utf8');
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const matches = ast.statements.filter(node => ts.isFunctionDeclaration(node) && node.name?.text === name);
  assert.equal(matches.length, 1);
  const compiled = ts.transpileModule(matches[0]!.getText(ast), {compilerOptions: {
    target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.CommonJS}, reportDiagnostics: true});
  assert.equal(compiled.diagnostics?.filter(d => d.category === ts.DiagnosticCategory.Error).length, 0);
  return compileFunction(`${compiled.outputText}\nreturn ${name};`, ['exports', ...Object.keys(dependencies)])(
    {}, ...Object.values(dependencies)) as (input: Record<string, unknown>) => Promise<any>;
}

async function connectionFixture() {
  const signal = new AbortController(); let allowed = true, account = 'synthetic@example.test';
  let launches = 0, closes = 0, profileFails = false, filesystemFails = false;
  let launch: any, filesystem: any;
  const transport = {signal: new AbortController().signal,
    async request(method: string, params: unknown) {
      assert.equal(method, 'account/read'); assert.deepEqual(params, {refreshToken: false});
      return {account: {type: 'chatgpt', email: account}};
    }, async close() {closes++;}};
  const open = await declaration('codexSetupOwnedConnection.ts', 'openCodexSetupOwnedConnection', {
    process: {platform: 'linux', env: {SYNTHETIC_SECRET: 'must-not-be-forwarded'}}, resolve,
    homedir: () => resolve('synthetic-provider-parent'),
    namedCodexEnvironment: () => ({PATH: '/synthetic/public/bin', CODEX_HOME: resolve('synthetic-provider-private')}),
    namedCodexFilesystem: async (input: unknown) => {
      filesystem = input; if (filesystemFails) throw new Error('synthetic filesystem failure');
      return {peer: 'synthetic-readonly-profile', additionalFilesystemRules: {synthetic: 'deny'}};
    },
    openCodexAppServerTransport: async (input: unknown) => {launch = input; launches++; return transport;},
    verifyCodexSetupReadOnlyProfile: async (_transport: unknown, _workspace: string, scope: any) => {
      assert.equal(_transport, transport); await scope.step(async () => {if (profileFails) throw new Error('private vendor exception');});
    },
  });
  const input = {workspace: resolve('synthetic-source'), deviceHome: resolve('synthetic-device-private'),
    expectedAccountEmail: 'synthetic@example.test', signal: signal.signal, current: async () => allowed};
  return {open, input, signal, transport, setAllowed(value: boolean) {allowed = value;},
    setAccount(value: string) {account = value;}, failProfile() {profileFails = true;}, failFilesystem() {filesystemFails = true;},
    get counts() {return {launches, closes};}, get launch() {return launch;}, get filesystem() {return filesystem;}};
}

test('owning connection uses fixed official readonly launch and denies private roots', async () => {
  const f = await connectionFixture(), connection = await f.open({...f.input, command: 'foreign', transport: 'foreign'});
  assert.equal(connection.transport, f.transport); assert.equal(f.launch.command, 'codex');
  assert.equal(f.launch.environment.SYNTHETIC_SECRET, undefined);
  assert.deepEqual(f.filesystem.writeRoots, []); assert.ok(f.filesystem.privateRoots.includes(f.input.deviceHome));
  assert.ok(f.launch.argv.includes('apps._default.enabled=false'));
  assert.ok(f.launch.argv.includes('allow_login_shell=false'));
  assert.ok(f.launch.argv.includes('permissions.dharma_bridge.network={enabled=false}'));
  assert.equal(await connection.current(), true);
  f.setAccount('foreign@example.test'); assert.equal(await connection.current(), false);
  await connection.close(); await connection.close(); assert.equal(f.counts.closes, 1);
});
for (const cause of ['withdrawn', 'cancelled', 'filesystem'] as const) {
  test(`owning connection stops ${cause} before spawning`, async () => {
    const f = await connectionFixture();
    if (cause === 'withdrawn') f.setAllowed(false);
    if (cause === 'cancelled') f.signal.abort();
    if (cause === 'filesystem') f.failFilesystem();
    await assert.rejects(f.open(f.input)); assert.equal(f.counts.launches, 0);
  });
}
for (const cause of ['account', 'profile'] as const) {
  test(`owning connection closes its actual handle on ${cause} failure without exposing vendor details`, async () => {
    const f = await connectionFixture();
    if (cause === 'account') f.setAccount('foreign@example.test'); else f.failProfile();
    await assert.rejects(f.open(f.input), /^Error: codex_setup_owned_connection_unqualified$/);
    assert.deepEqual(f.counts, {launches: 1, closes: 1});
  });
}
test('owning connection cancellation cooperatively closes only its captured transport', async () => {
  const f = await connectionFixture(), connection = await f.open(f.input);
  f.signal.abort(); assert.equal(await connection.current(), false);
  await connection.close(); assert.equal(f.counts.closes, 1);
});

async function controllerFixture() {
  const now = Date.now(), id = (n: number) => `${String(n).padStart(8, '0')}-1111-4111-8111-111111111111`;
  let allowed = true, connections = 0, starts = 0, connectionCloses = 0, hostCloses = 0;
  let started: any, settle!: () => void, failStart = false, withdrawAfterStart = false, sourceMatches = true, contractMatches = true;
  const settled = new Promise<void>(done => {settle = done;});
  const connection = {transport: {original: true}, additionalFilesystemRules: {private: 'deny'},
    current: async () => allowed, close: async () => {connectionCloses++;}};
  const open = await declaration('index.ts', 'openCodexBootstrapNativeHost', {prepareCodexBootstrapHost,
    currentBootstrapHostScope: () => undefined,
    preflightBootstrapWorkspaceIdentity: async () => ({fingerprint: `sha256:${(sourceMatches ? 'a' : 'e').repeat(64)}`}),
    loadAgentFabricOnboardingContract: async () => ({sha256: (contractMatches ? 'c' : 'e').repeat(64)}),
    dharmaHome: () => resolve('synthetic-device-private'),
    openCodexSetupOwnedConnection: async () => {connections++; return connection;},
    startCodexBootstrapNativeHost: async (input: unknown) => {
      starts++; started = input; if (failStart) throw new Error('secret provider details');
      if (withdrawAfterStart) allowed = false;
      return {threadId: 'fixture-thread', turnId: 'fixture-turn', settled, close: async () => {hostCloses++; settle();}};
    }});
  const input = {workspace: resolve('synthetic-source'), name: 'implementer', signal: new AbortController().signal,
    current: async () => allowed, reserve: async () => true, maximumProviderCostCents: 25,
    expectedAccountEmail: 'synthetic@example.test', intent: {schema: 'dharma.codex-setup-intent/v1',
      operationId: id(1), setupReference: id(2), organizationId: 'org_demo', recipientMembershipId: id(3),
      hostContextId: id(4), origin: 'https://hq.example', repositoryFingerprint: `sha256:${'a'.repeat(64)}`,
      scopeDigest: `sha256:${'b'.repeat(64)}`, contractDigest: `sha256:${'c'.repeat(64)}`, policyRevision: 'policy-v1',
      issuedAt: new Date(now - 1000).toISOString(), expiresAt: new Date(now + 60_000).toISOString()}};
  return {open, input, connection, settle, get started() {return started;},
    setAllowed(value: boolean) {allowed = value;}, failStart() {failStart = true;}, withdrawAfterStart() {withdrawAfterStart = true;},
    failSource() {sourceMatches = false;}, failContract() {contractMatches = false;},
    get counts() {return {connections, starts, connectionCloses, hostCloses};}};
}
test('official controller carries only its owned connection and original budget into native composition', async () => {
  const f = await controllerFixture(), host = await f.open({...f.input, transport: {foreign: true}});
  assert.equal(f.started.transport, f.connection.transport); assert.equal(f.started.current, f.connection.current);
  assert.equal(f.started.reserve, f.input.reserve); assert.equal(f.started.maximumProviderCostCents, 25);
  assert.notEqual(f.started.intent, f.input.intent); assert.deepEqual(f.started.intent, f.input.intent);
  await host.close(); await host.settled;
  assert.deepEqual(f.counts, {connections: 1, starts: 1, connectionCloses: 1, hostCloses: 1});
});
test('terminal native turn releases its owning connection without caller cleanup', async () => {
  const f = await controllerFixture(), host = await f.open(f.input);
  f.settle(); await host.settled; assert.equal(f.counts.connectionCloses, 1);
});
for (const field of ['name', 'reserve', 'maximumProviderCostCents', 'intent'] as const) {
  test(`controller rejects invalid ${field} before connection effects`, async () => {
    const f = await controllerFixture();
    const changed = field === 'name' ? '../foreign' : field === 'reserve' ? undefined
      : field === 'maximumProviderCostCents' ? 0 : {...f.input.intent, setupReference: 'invalid'};
    await assert.rejects(f.open({...f.input, [field]: changed})); assert.equal(f.counts.connections, 0);
  });
}
test('controller refuses withdrawn scope before launching its native connection', async () => {
  const f = await controllerFixture(); f.setAllowed(false);
  await assert.rejects(f.open(f.input), /codex_setup_owned_start_unqualified/); assert.equal(f.counts.connections, 0);
});
for (const cause of ['source', 'contract'] as const) {
  test(`controller refuses mismatched ${cause} before any provider connection`, async () => {
    const f = await controllerFixture(); if (cause === 'source') f.failSource(); else f.failContract();
    await assert.rejects(f.open(f.input), /codex_setup_owned_start_unqualified/);
    assert.equal(f.counts.connections, 0);
  });
}
test('controller drains a captured connection after native startup failure', async () => {
  const f = await controllerFixture(); f.failStart();
  await assert.rejects(f.open(f.input), /^Error: codex_setup_owned_start_unqualified$/);
  assert.equal(f.counts.connectionCloses, 1);
});
test('controller drains both captured owners when authority withdraws during startup', async () => {
  const f = await controllerFixture(); f.withdrawAfterStart();
  await assert.rejects(f.open(f.input), /^Error: codex_setup_owned_start_unqualified$/);
  assert.equal(f.counts.connectionCloses, 1); assert.equal(f.counts.hostCloses, 1);
});
