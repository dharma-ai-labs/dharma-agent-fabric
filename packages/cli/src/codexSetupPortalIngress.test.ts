import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {posix} from 'node:path';
import {compileFunction} from 'node:vm';
import {spawnSync} from 'node:child_process';
import {EventEmitter} from 'node:events';
import test from 'node:test';
import ts from 'typescript';
import {commandExitCode, parseCliOptions} from './index.js';
import {canonicalize} from '@dharma-ai-labs/agent-fabric-contracts';

async function declaration(name: string, dependencies: Record<string, unknown>) {
  const source = await readFile(new URL('../src/index.ts', import.meta.url), 'utf8');
  const ast = ts.createSourceFile('index.ts', source, ts.ScriptTarget.Latest, true);
  const nodes = ast.statements.filter(node => ts.isFunctionDeclaration(node) && node.name?.text === name);
  assert.equal(nodes.length, 1);
  const output = ts.transpileModule(nodes[0]!.getText(ast), {compilerOptions: {
    target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.CommonJS}, reportDiagnostics: true});
  assert.equal(output.diagnostics?.filter(d => d.category === ts.DiagnosticCategory.Error).length, 0);
  return compileFunction(output.outputText.replaceAll('import.meta.url', '"file:///synthetic/index.js"')
    + `\nreturn ${name};`, ['exports', ...Object.keys(dependencies)])({}, ...Object.values(dependencies)) as (...args: any[]) => Promise<any>;
}

// Actual CLI composition; only filesystem, remote preparation and provider
// boundaries are synthetic. No enrolled client or model is used by these tests.
async function fixture() {
  const process_ = Object.assign(new EventEmitter(), {platform: 'linux', getuid: () => 1000,
    cwd: () => '/home/synthetic/source', env: {DHARMA_HOME: '/home/synthetic/device', CODEX_HOME: '/home/synthetic/provider'},
    stdin: {synthetic: true}});
  const reference = '11111111-1111-4111-8111-111111111111';
  const prepared = {initialUserPrompt: 'EXACT_PUBLIC_ORIGINAL', initialUserPromptSha256: 'a'.repeat(64),
    promptSha256: 'b'.repeat(64), binding: {recipientEmail: 'member@example.test', repositoryRemoteUrl: 'https://github.com/example/repository.git'},
    intent: {operationId: '22222222-2222-4222-8222-222222222222', setupReference: reference,
      organizationId: 'org_fixture', recipientMembershipId: '33333333-3333-4333-8333-333333333333',
      origin: 'https://hq.example', repositoryFingerprint: 'sha256:' + 'c'.repeat(64),
      scopeDigest: 'sha256:' + 'd'.repeat(64), contractDigest: 'sha256:' + 'e'.repeat(64),
      policyRevision: 'policy-v1', expiresAt: new Date(Date.now() + 60000).toISOString()}};
  const counts = {inputs: 0, preparations: 0, accounts: 0, accountCloses: 0, hosts: 0, closes: 0, reserves: 0, resumes: 0};
  let changed = false, denyBudget = false, failClose = false, failPreparation = false, foreignConfig = false;
  let changeOnAccountClose = false, harness = 'codex', sourceMatches = true;
  let revokeBeforeTurn = false, dispatched = 0;
  let completion: any = {operationId: prepared.intent.operationId, setupReference: reference,
    readinessReceiptId: '44444444-4444-4444-8444-444444444444'};
  let result: any = {ok: true, stage: 'complete', sharedRepositoryReady: true}, launched: any, resumed: Map<string, any> | undefined;
  const info = {isFile: () => true, isDirectory: () => true, isSymbolicLink: () => false,
    uid: 1000, mode: 0o700, dev: 1n, ino: 2n, size: 3n, mtimeNs: 4n, ctimeNs: 5n};
  const ingress = await declaration('codexPortalSetup', {
    process: process_, normalizeHqUrl: (value: string) => new URL(value).origin,
    required: (flags: Map<string, any>, key: string) => {if (!flags.get(key)) throw new Error('missing'); return flags.get(key);},
    readCodexSetupPublicStdin: async () => {counts.inputs++; return prepared.initialUserPrompt;},
    requestCodexSetupHostPreparation: async (input: any) => {
      counts.preparations++; assert.equal(input.initialUserPrompt, prepared.initialUserPrompt);
      if (failPreparation || revokeBeforeTurn && counts.preparations > 1) throw new Error('codex_setup_portal_preparation_unavailable'); return prepared;
    }, VERSION: 'synthetic-version', realpath: async (path: string) => path,
    dharmaHome: () => process_.env.DHARMA_HOME, fileURLToPath: () => '/synthetic/index.js',
    lstat: async () => ({...info, ino: changed ? 99n : 2n}),
    boundedInteger: (value: any, fallback: number, min: number, max: number) => {
      const n = value === undefined ? fallback : Number(value); if (!Number.isInteger(n) || n < min || n > max) throw new Error('invalid'); return n;
    }, isAbsolute: posix.isAbsolute, resolve: posix.resolve, homedir: () => '/home/synthetic',
    preflightBootstrapWorkspaceIdentity: async () => ({fingerprint: sourceMatches ? prepared.intent.repositoryFingerprint : 'foreign'}),
    detectBootstrapProvider: async () => harness,
    openCodexSetupOwnedConnection: async () => {counts.accounts++; return {accountEmail: 'provider@example.test', close: async () => {
      counts.accountCloses++; if (changeOnAccountClose) changed = true;
    }};},
    openCodexBootstrapFromPortalCommand: async (input: any) => {
      launched = input; counts.hosts++;
      if (!await input.reserve(prepared.intent.operationId, input.maximumProviderCostCents)) throw new Error('budget');
      dispatched++;
      return {threadId: 'owned_thread', turnId: 'owned_turn', settled: Promise.resolve(), verifiedCompletion: completion,
        close: async () => {counts.closes++; if (failClose) throw new Error('PRIVATE_VENDOR_FAILURE');}};
    },
    reserveCodexSetupLaunch: async (input: any) => {counts.reserves++; return !denyBudget && await input.current();},
    readDeviceConfig: async () => ({organizationId: 'org_fixture', hqUrl: 'https://hq.example',
      setupClaimReference: foreignConfig ? 'foreign' : reference, setupClaimRepositoryFingerprint: prepared.intent.repositoryFingerprint}),
    UUID_PATTERN: /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/,
    canonicalize, parseCliOptions, bootstrap: async (flags: Map<string, any>) => {counts.resumes++; resumed = flags; return result;},
  });
  const flags = new Map<string, any>([['stdin', true], ['portal-url', 'https://hq.example'], ['organization-id', 'org_fixture'],
    ['setup-reference', reference], ['workspace', '/home/synthetic/source']]);
  return {ingress, flags, counts, prepared, process: process_,
    changeRuntime: () => {changed = true;}, denyBudget: () => {denyBudget = true;}, failClose: () => {failClose = true;},
    failPreparation: () => {failPreparation = true;}, foreignConfig: () => {foreignConfig = true;}, setResult: (value: any) => {result = value;},
    changeOnAccountClose: () => {changeOnAccountClose = true;}, wrongHarness: () => {harness = 'unknown';},
    foreignSource: () => {sourceMatches = false;},
    setCompletion: (value: any) => {completion = value;},
    revokeBeforeTurn: () => {revokeBeforeTurn = true;}, get dispatched() {return dispatched;},
    get launched() {return launched;}, get resumed() {return resumed;}};
}
test('public dry-run prepares binding but launches no provider, reserves nothing and does not enroll', async () => {
  const f = await fixture(); f.flags.set('dry-run', true); const result = await f.ingress(f.flags);
  assert.equal(result.ok, true); assert.equal(result.effects, false); assert.equal(result.enrollmentChanged, false);
  assert.deepEqual(f.counts, {inputs: 1, preparations: 1, accounts: 0, accountCloses: 0, hosts: 0, closes: 0, reserves: 0, resumes: 0});
  assert.equal(f.process.listenerCount('SIGINT'), 0); assert.equal(f.process.listenerCount('SIGTERM'), 0);
});
test('changed source consent is rechecked at the turn boundary before reservation or model dispatch', async () => {
  const f = await fixture(); f.revokeBeforeTurn();
  const result = await f.ingress(f.flags);
  assert.equal(result.ok, false); assert.equal(f.counts.preparations, 2);
  assert.equal(f.counts.reserves, 0); assert.equal(f.dispatched, 0); assert.equal(f.counts.resumes, 0);
});
for (const cause of ['no-tool', 'concurrent-config', 'foreign-operation', 'foreign-reference', 'invalid-receipt'] as const) {
  test(`original host ${cause} cannot be attributed as completed by matching device config`, async () => {
    const f = await fixture();
    const proof = {operationId: f.prepared.intent.operationId, setupReference: f.prepared.intent.setupReference,
      readinessReceiptId: '44444444-4444-4444-8444-444444444444'};
    if (cause === 'foreign-operation') proof.operationId = proof.readinessReceiptId;
    if (cause === 'foreign-reference') proof.setupReference = proof.readinessReceiptId;
    if (cause === 'invalid-receipt') proof.readinessReceiptId = 'not-a-receipt';
    f.setCompletion(cause === 'no-tool' || cause === 'concurrent-config' ? undefined : proof);
    // Even an exact same-reference config written concurrently must not replace
    // proof from this owned original operation. No config mutation is replayed.
    const result = await f.ingress(f.flags);
    assert.equal(result.ok, false); assert.equal(f.counts.resumes, 0);
    assert.equal(result.code, 'codex_setup_ingress_readiness_unconfirmed');
  });
}
for (const reason of ['runtime-change', 'harness', 'repository'] as const) {
  test(`ingress requalifies ${reason} before native model dispatch`, async () => {
    const f = await fixture();
    if (reason === 'runtime-change') f.changeOnAccountClose();
    if (reason === 'harness') f.wrongHarness();
    if (reason === 'repository') f.foreignSource();
    const result = await f.ingress(f.flags);
    assert.equal(result.ok, false); assert.equal(result.code, 'codex_setup_ingress_context_unqualified');
    assert.equal(f.counts.hosts, 0); assert.equal(f.counts.reserves, 0); assert.equal(f.counts.resumes, 0);
    if (reason === 'runtime-change') assert.equal(f.counts.accountCloses, 1);
    else assert.equal(f.counts.accounts, 0);
  });
}
test('official ingress passes original prompt and independent binding into owned host, then reconciles only matching consumed setup', async () => {
  const f = await fixture(), result = await f.ingress(f.flags);
  assert.equal(result.ok, true); assert.equal(f.launched.initialUserPrompt, f.prepared.initialUserPrompt);
  assert.equal(f.launched.initialUserPromptBinding, f.prepared.binding);
  assert.equal(f.launched.expectedAccountEmail, 'provider@example.test');
  assert.notEqual(f.launched.expectedAccountEmail, f.prepared.binding.recipientEmail);
  assert.equal(f.counts.accounts, 1); assert.equal(f.counts.accountCloses, 1); assert.equal(f.counts.hosts, 1);
  assert.equal(f.counts.reserves, 1); assert.equal(f.counts.resumes, 1);
  assert.equal(f.resumed?.get('resume'), true);
  assert.equal(f.resumed?.has('setup-reference'), false); assert.equal(f.resumed?.has('grant'), false);
  assert.equal(f.resumed?.has('setup-recipient-membership-id'), false);
  assert.equal(result.portalIngress.hardInvoiceCapProven, false); assert.equal(result.portalIngress.actualUsd, null);
});
for (const reason of ['preparation', 'homes', 'budget', 'foreign-config', 'close', 'unready'] as const) {
  test(`official ingress never converts ${reason} into success or retries authority`, async () => {
    const f = await fixture();
    if (reason === 'preparation') f.failPreparation();
    if (reason === 'homes') f.process.env.DHARMA_HOME = '';
    if (reason === 'budget') f.denyBudget();
    if (reason === 'foreign-config') f.foreignConfig();
    if (reason === 'close') f.failClose();
    if (reason === 'unready') f.setResult({ok: false, stage: 'signed_package_pending'});
    const result = await f.ingress(f.flags); assert.equal(result.ok, false);
    assert.ok(f.counts.hosts <= 1); assert.ok(f.counts.resumes <= 1);
    if (reason !== 'unready') assert.equal(f.counts.resumes, 0);
    if (reason === 'preparation' || reason === 'homes') assert.equal(f.counts.accounts, 0);
    assert.equal(JSON.stringify(result).includes('PRIVATE_VENDOR_FAILURE'), false);
    assert.equal(f.process.listenerCount('SIGINT'), 0);
  });
}
test('actual CLI bin reaches public ingress and refuses extra authority options before stdin/network/provider', () => {
  const result = spawnSync(process.execPath, [new URL('./bin.js', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'),
    'setup', 'codex', '--stdin', '--grant', 'PUBLIC_TEST_NOT_A_GRANT'], {input: '', encoding: 'utf8', timeout: 15000});
  assert.equal(result.status, 2); assert.match(result.stderr, /codex_setup_ingress_options_invalid/);
  assert.equal(result.stdout, '');
});
test('setup ingress exit status requires complete shared readiness, not a terminal native turn', () => {
  const argv = ['setup', 'codex', '--stdin'];
  assert.equal(commandExitCode(argv, {ok: false, stage: 'setup_host_unconfirmed'}), 1);
  assert.equal(commandExitCode(argv, {ok: true, stage: 'pending', sharedRepositoryReady: false}), 1);
  assert.equal(commandExitCode(argv, {ok: true, stage: 'complete', sharedRepositoryReady: true}), 0);
  assert.equal(commandExitCode([...argv, '--dry-run'], {ok: true, stage: 'setup_host_plan', effects: false}), 0);
});

test('trusted completion composition exposes an original receipt only after independent readiness verification', async () => {
  let callbacks: any, verified = false;
  const start = await declaration('startCodexBootstrapNativeHost', {
    resolve: posix.resolve, dharmaHome: () => '/home/synthetic/device',
    runCodexBootstrapHostScope: async (scope: any, operation: any) => operation(scope),
    openBootstrapVault: async () => ({close: async () => {}}),
    createCodexBootstrapCompletionOwner: async () => ({verify: async () => verified}),
    reportCodexSetupFailure: () => {throw new Error('unexpected fixture error');},
    startCodexSetupNativeHost: async (input: any) => {
      callbacks = input; await input.openJournal({original: true});
      return {threadId: 'original_thread', turnId: 'original_turn', settled: Promise.resolve(), close: async () => {}};
    },
  });
  const host = await start({intent: {operationId: 'original-operation', setupReference: 'original-reference'}});
  await host.settled;
  assert.equal(host.verifiedCompletion, undefined, 'turn completion must not acknowledge a setup tool');
  assert.equal(await callbacks.verifyReadiness('receipt', {operationId: 'original-operation', setupReference: 'original-reference'}, 'digest'), false);
  assert.equal(host.verifiedCompletion, undefined);
  verified = true;
  assert.equal(await callbacks.verifyReadiness('receipt', {operationId: 'original-operation', setupReference: 'original-reference'}, 'digest'), true);
  assert.deepEqual(host.verifiedCompletion, {operationId: 'original-operation', setupReference: 'original-reference', readinessReceiptId: 'receipt'});
  assert.equal(Object.isFrozen(host.verifiedCompletion), true);
  verified = false;
  await callbacks.verifyReadiness('receipt', {operationId: 'original-operation', setupReference: 'original-reference'}, 'digest');
  assert.equal(host.verifiedCompletion, undefined, 'failed revalidation must withdraw an earlier acknowledgement');
});
