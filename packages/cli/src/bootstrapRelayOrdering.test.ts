import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {resolve} from 'node:path';
import {compileFunction} from 'node:vm';
import test from 'node:test';
import ts from 'typescript';

// Execute the actual post-enrollment caller with synthetic lifecycle boundaries.
// No fixture starts a daemon, accesses credentials, or contacts the platform.
async function fixture(options: {host?: boolean; noRelay?: boolean; withdraw?: boolean; conflict?: boolean; previousVersion?: string} = {}) {
  const baseline = process.env.DHARMA_BOOTSTRAP_ORDER_BASELINE_SHA;
  if (baseline && !/^[a-f0-9]{40}$/.test(baseline)) throw new Error('bootstrap_order_baseline_invalid');
  const source = baseline ? (await promisify(execFile)('git', ['show', `${baseline}:packages/cli/src/index.ts`], {
    cwd: resolve(import.meta.dirname, '../../..'), maxBuffer: 4 * 1024 * 1024,
  })).stdout : await readFile(new URL('../src/index.ts', import.meta.url), 'utf8');
  const ast = ts.createSourceFile('index.ts', source, ts.ScriptTarget.Latest, true);
  const declaration = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'bootstrap');
  assert.ok(declaration && ts.isFunctionDeclaration(declaration) && declaration.body);
  const statements = declaration.body.statements;
  const start = statements.findIndex(node => node.getText(ast).startsWith('const onboardFlags ='));
  const end = statements.findIndex(node => node.getText(ast).startsWith('const skill ='));
  assert.ok(start >= 0 && end > start);
  const effects: string[] = [];
  let enabled = false, withdrawn = false, running = false;
  const flags = new Map<string, string | boolean>([['complete', true], ['setup-reference', 'public-reference']]);
  if (options.noRelay) flags.set('no-relay-daemon', true);
  const step = async <T>(operation: () => Promise<T>) => {
    if (withdrawn) throw new Error('codex_setup_host_scope_unavailable');
    const result = await operation();
    if (withdrawn) throw new Error('codex_setup_host_scope_unavailable');
    return result;
  };
  const workspace = '/synthetic/repository', policyPath = workspace + '/.dharma/approved-policy.json';
  async function actual(name: string, dependencies: Record<string, unknown>, body?: string) {
    const node = ast.statements.find(value => ts.isFunctionDeclaration(value) && value.name?.text === name);
    assert.ok(node && ts.isFunctionDeclaration(node) && node.body);
    const compiled = ts.transpileModule(body ?? node.getText(ast), {compilerOptions: {
      target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.CommonJS}, reportDiagnostics: true});
    assert.equal(compiled.diagnostics?.filter(d => d.category === ts.DiagnosticCategory.Error).length, 0);
    return compileFunction(compiled.outputText.replaceAll('import.meta.url', '"file:///synthetic/index.js"')
      + `\nreturn ${name};`, ['exports', ...Object.keys(dependencies)])({}, ...Object.values(dependencies));
  }
  const startRelay = await actual('startRelayDaemon', {
    currentBootstrapHostScope: () => options.host === false ? undefined : {step, assert: async () => step(async () => {})},
    readDeviceConfig: async () => ({organizationId: 'org_demo', deviceId: 'device'}),
    loadOrganizationPolicy: async () => ({serverAuthorization: {workspaceId: 'workspace'}}),
    registry: async () => [{workspaceId: 'workspace', organizationId: 'org_demo', path: workspace}],
    resolve: (...parts: string[]) => parts.join('/'), assertBootstrapHostSource: async () => {},
    relayProcessState: async () => running ? 'running' : 'stopped',
    relaySupervisorProcessState: async () => running ? 'running' : 'stopped',
    relayAutostartStatus: async () => ({backend: 'container-entrypoint'}),
    startRelayAutostart: async () => {
      if (options.host !== false && !enabled) throw new Error('autostart_conflict: enabled owned startup required');
      effects.push('start'); running = true;
    },
    dharmaHome: () => '/synthetic/device', VERSION: 'test', Number, String,
    readFile: async (path: string) => path.endsWith('supervisor-workspace.json')
      ? JSON.stringify({pid: 101, version: 'test', standardRepositories: true, organizationId: 'org_demo', deviceId: 'device'})
      : path.endsWith('last-successful-poll.json') ? '{}' : '101',
    repositoryRelayObservationReady: () => true,
    waitForRelayReadiness: async (input: {processState(): Promise<string>}) => ({state: await input.processState()}),
  });
  const onboardDeclaration = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'onboard');
  assert.ok(onboardDeclaration && ts.isFunctionDeclaration(onboardDeclaration) && onboardDeclaration.body);
  const relayStatement = onboardDeclaration.body.statements.find(node => node.getText(ast).startsWith('const relay ='));
  assert.ok(relayStatement);
  const onboardRelay = await actual('onboard', {startRelayDaemon: startRelay, workspace,
    resolve: (...parts: string[]) => parts.join('/'), staged: async (_stage: string, run: () => Promise<unknown>) => run()},
    `async function onboard(flags: Map<string, unknown>){${relayStatement.getText(ast)};return relay;}`);
  const dependencies: Record<string, unknown> = {
    flags, hostScope: options.host === false ? undefined : {step}, step,
    hqUrl: 'https://hq.example', organizationId: 'org_demo', workspace: '/synthetic/repository',
    policyRevision: 'policy-v1', provider: 'codex', joinedBindingId: null, joinedFingerprint: null,
    repositorySelection: {}, config: {deviceId: 'device'}, organizationApiTokenStored: true, scopes: [], recipientApproval: {}, rebind: {},
    retryBootstrapOnboarding: async (run: () => Promise<unknown>) => run(),
    onboard: async (input: Map<string, unknown>) => {
      effects.push('onboard');
      assert.equal(input.has('setup-reference'), false);
      await onboardRelay(input);
      return {ok: true, stage: 'shared_repository_pending', workspaceId: 'workspace', sharedRepositoryReady: false};
    },
    installStableRepositoryLauncher: async () => {effects.push('launcher'); return {shell: '.dharma/bin/dharma'};},
    withOnboardingStage: async (_stage: unknown, _workspace: unknown, _resume: unknown, run: () => Promise<unknown>) => run(),
    withRelayStartupMutation: async (run: () => Promise<unknown>) => run(), dharmaHome: () => '/synthetic/device',
    relayAutostartStatus: async () => {
      if (options.conflict) throw new Error('autostart_conflict: foreign registration');
      if (options.previousVersion) return {state: 'enabled', backend: 'systemd-user', version: options.previousVersion};
      return {state: 'disabled', backend: null};
    },
    inspectOwnedRelayAutostart: async () => ({workspace, policy: policyPath, version: options.previousVersion}),
    readDeviceConfig: async () => ({organizationId: 'org_demo', deviceId: 'device'}),
    registry: async () => [{workspaceId: 'workspace', organizationId: 'org_demo', path: workspace}],
    selectDeviceWorkspace: () => ({workspaceId: 'workspace', organizationId: 'org_demo', path: workspace}),
    loadOrganizationPolicy: async () => ({serverAuthorization: {workspaceId: 'workspace'}}),
    loadVerifiedWorkspacePolicy: async () => ({}),
    enableRelayAutostart: async (input: {codexHome?: string}) => {
      if (options.previousVersion) throw new Error('relay_runtime_upgrade_required');
      assert.equal(input.codexHome, '/synthetic/native-codex');
      effects.push('enable'); enabled = true;
      if (options.withdraw) withdrawn = true;
      return {state: 'enabled', backend: 'systemd-user'};
    },
    startRelayDaemon: () => startRelay(policyPath),
    resolve: (...parts: string[]) => parts.join('/'), process: {platform: 'linux', env: {CODEX_HOME: '/synthetic/native-codex'}},
    VERSION: 'test', String, Map,
  };
  dependencies.assertBootstrapStartupAnchor = await actual('assertBootstrapStartupAnchor', dependencies);
  const block = statements.slice(start, end).map(node => node.getText(ast)).join('\n');
  const compiled = ts.transpileModule(`async function run(){${block}\nreturn {onboarded,autostart};}`, {
    compilerOptions: {target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.CommonJS}, reportDiagnostics: true,
  });
  assert.equal(compiled.diagnostics?.filter(d => d.category === ts.DiagnosticCategory.Error).length, 0);
  const run = compileFunction(compiled.outputText + '\nreturn run;', Object.keys(dependencies))(...Object.values(dependencies));
  return {run, effects, flags};
}

test('fresh native bootstrap registers its owned startup before starting a relay', async () => {
  const f = await fixture(); await f.run();
  assert.deepEqual(f.effects, ['onboard', 'launcher', 'enable', 'start']);
  assert.equal(f.flags.has('no-relay-daemon'), false, 'internal deferral must not change customer flags');
});

test('native bootstrap keeps explicit no-relay mode free of startup effects', async () => {
  const f = await fixture({noRelay: true}); await f.run();
  assert.deepEqual(f.effects, ['onboard', 'launcher']);
});

test('native bootstrap does not start after withdrawal during startup registration', async () => {
  const f = await fixture({withdraw: true});
  await assert.rejects(f.run(), /codex_setup_host_scope_unavailable/);
  assert.equal(f.effects.includes('start'), false);
});

test('native bootstrap preserves startup ownership conflicts without a fallback', async () => {
  const f = await fixture({conflict: true});
  await assert.rejects(f.run(), /autostart_conflict: foreign registration/);
  assert.equal(f.effects.includes('start'), false);
});

test('bootstrap rejects an older owned startup before replacing its managed launcher', async () => {
  const f = await fixture({previousVersion: '0.2.164'});
  await assert.rejects(f.run(), /relay_runtime_upgrade_required/);
  assert.deepEqual(f.effects, ['onboard'], 'the supported upgrade must retain the exact previous launcher pair');
});

test('explicit no-relay bootstrap does not try to upgrade or inspect startup', async () => {
  const f = await fixture({noRelay: true, conflict: true});
  await f.run();
  assert.deepEqual(f.effects, ['onboard', 'launcher']);
});

test('legacy unscoped onboarding retains its original relay-start order', async () => {
  const f = await fixture({host: false}); await f.run();
  assert.deepEqual(f.effects, ['onboard', 'start', 'launcher', 'enable']);
});
