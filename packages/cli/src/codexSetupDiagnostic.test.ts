import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readFile} from 'node:fs/promises';
import {compileFunction} from 'node:vm';
import test from 'node:test';
import ts from 'typescript';
import {Ajv2020} from 'ajv/dist/2020.js';
import {classifyCodexSetupFailure, reportCodexSetupFailure, type CodexSetupFailureDiagnostic} from './codexSetupDiagnostic.js';
import {withOnboardingStage} from './onboardingStage.js';

test('diagnostics retain a known stage and category but never the wrapped reason or command', async () => {
  let wrapped: unknown;
  try {await withOnboardingStage('named_session', 'synthetic-workspace', 'sensitive-command-placeholder',
    async () => {throw new Error('setup_session_start_unconfirmed');});} catch (error) {wrapped = error;}
  const diagnostic = classifyCodexSetupFailure(wrapped, 'bootstrap');
  assert.deepEqual(diagnostic, {schema: 'dharma.codex-setup-failure-diagnostic/v1',
    stage: 'named_session', category: 'setup_session_start_unconfirmed'});
  assert.ok(Object.isFrozen(diagnostic));
  assert.equal(JSON.stringify(diagnostic).includes('sensitive-command-placeholder'), false);
  assert.equal(JSON.stringify(diagnostic).includes('synthetic-workspace'), false);
});

test('unknown secret-bearing messages and causes only produce fixed unknown classifications', () => {
  const error = new Error('private-password-placeholder https://example.test/?token=private-token-placeholder',
    {cause: new Error('signature=private-signature-placeholder')});
  assert.deepEqual(classifyCodexSetupFailure(error, 'completion'), {
    schema: 'dharma.codex-setup-failure-diagnostic/v1', stage: 'completion', category: 'setup_runtime_unclassified'});
  assert.equal(classifyCodexSetupFailure(new Error('first_learning_pending'), 'completion').category, 'first_learning_pending');
});

test('diagnostics do not invoke accessors, proxies or cyclic causes', () => {
  let reads = 0;
  const accessor = Object.defineProperties({}, {message: {get() {reads++; throw new Error('private');}},
    cause: {get() {reads++; throw new Error('private');}}});
  const proxy = new Proxy({}, {getOwnPropertyDescriptor() {reads++; throw new Error('private');}});
  for (const value of [accessor, proxy]) assert.equal(classifyCodexSetupFailure(value, 'bootstrap').category, 'setup_runtime_unclassified');
  const cycle: {message: string; cause?: unknown} = {message: 'private'}; cycle.cause = cycle;
  assert.equal(classifyCodexSetupFailure(cycle, 'bootstrap').category, 'setup_runtime_unclassified');
  assert.equal(reads, 0);
});

test('an observer failure cannot replace the original execution failure', () => {
  assert.doesNotThrow(() => reportCodexSetupFailure(() => {throw new Error('observer failure');},
    new Error('setup_session_scope_changed'), 'bootstrap'));
});

test('async and thenable observer rejections cannot prevent cleanup under strict rejection handling', () => {
  const source = `import {reportCodexSetupFailure} from ${JSON.stringify(new URL('./codexSetupDiagnostic.js', import.meta.url).href)};
    for (const observer of [async () => {throw new Error('synthetic rejection');},
      () => ({then(_resolve, reject) {reject(new Error('synthetic rejection'));}}),
      () => Object.defineProperty({}, 'then', {get() {throw new Error('synthetic rejection');}})]) {
      reportCodexSetupFailure(observer, new Error('setup_session_scope_changed'), 'bootstrap');
    }
    await new Promise(resolve => setImmediate(resolve));
    console.log('cleanup-reached');`;
  assert.equal(execFileSync(process.execPath, ['--unhandled-rejections=strict', '--input-type=module', '-e', source],
    {encoding: 'utf8', timeout: 10000}).trim(), 'cleanup-reached');
});

test('actual bootstrap continuation reports fixed owner diagnostics while preserving its redacted error', async () => {
  const baseline = process.env.DHARMA_SETUP_DIAGNOSTIC_BASELINE;
  if (baseline && baseline !== '1b16513ed36984831f6467355c329618c5dc70ff') throw new Error('fixture_source_unqualified');
  const source = baseline ? execFileSync('git', ['show', `${baseline}:packages/cli/src/index.ts`], {encoding: 'utf8'})
    : await readFile(new URL('../src/index.ts', import.meta.url), 'utf8');
  const ast = ts.createSourceFile('index.ts', source, ts.ScriptTarget.Latest, true);
  const node = ast.statements.find(value => ts.isFunctionDeclaration(value) && value.name?.text === 'bootstrapFromCodexSetupScope');
  assert.ok(node);
  const code = ts.transpileModule(node.getText(ast), {compilerOptions: {target: ts.ScriptTarget.ES2023,
    module: ts.ModuleKind.CommonJS}}).outputText;
  const secret = 'private-grant-placeholder';
  const root = new Error('setup_session_scope_changed');
  const failure = new Error(`agent_fabric_onboarding_named_session: ${secret}`, {cause: root});
  const observations: Readonly<CodexSetupFailureDiagnostic>[] = [];
  const continuation = compileFunction(code+'\nreturn bootstrapFromCodexSetupScope;',
    ['exports', 'runCodexBootstrapHostScope', 'run', 'reportCodexSetupFailure'])({},
    async (_scope: unknown, operation: (value: unknown) => Promise<unknown>) => operation({flags: new Map()}),
    async () => {throw failure;}, reportCodexSetupFailure);
  await assert.rejects(continuation({}, (event: Readonly<CodexSetupFailureDiagnostic>) => observations.push(event)),
    {message: 'codex_setup_host_operation_failed'});
  assert.deepEqual(observations, [{schema: 'dharma.codex-setup-failure-diagnostic/v1',
    stage: 'named_session', category: 'setup_session_scope_changed'}]);
  assert.equal(JSON.stringify(observations).includes(secret), false);
});

test('runtime classifications agree with the closed schema and reject private fields', async () => {
  const schema = JSON.parse(await readFile(new URL('../../../schemas/codex-setup-failure-diagnostic.schema.json', import.meta.url), 'utf8'));
  const validate = new Ajv2020({strict: true}).compile(schema);
  for (const category of schema.properties.category.enum) {
    const event = classifyCodexSetupFailure(new Error(category), 'completion');
    assert.equal(event.category, category); assert.equal(validate(event), true);
  }
  for (const stage of schema.properties.stage.enum) {
    const event = classifyCodexSetupFailure(new Error(`agent_fabric_onboarding_${stage}: private-placeholder`),
      stage === 'completion' ? 'completion' : 'bootstrap');
    assert.equal(event.stage, stage); assert.equal(validate(event), true);
  }
  const event = classifyCodexSetupFailure(new Error('private-placeholder'), 'bootstrap');
  for (const delta of [{message: 'private'}, {cause: 'private'}, {token: 'private'}, {category: 'private'}, {stage: 'private'}]) {
    assert.equal(validate({...event, ...delta}), false);
  }
});
