import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';

test('actual explicit skill sync consumes shared preparation before activation', async () => {
  const source = await readFile(new URL('../src/index.ts', import.meta.url), 'utf8');
  const activation = source.slice(source.indexOf('async function activatePreparedSkillUpdate('), source.indexOf('async function skillSync('));
  const sync = source.slice(source.indexOf('async function skillSync('), source.indexOf('async function installedRepositoryKnowledge('));
  assert.match(sync, /await prepareSkillUpdate\(/);
  assert.match(sync, /activatePreparedSkillUpdate\(/);
  assert.match(activation, /await installSkillBundle\(/);
});

test('actual relay starts independent staging and stops it before closing resources', async () => {
  const source = await readFile(new URL('../src/index.ts', import.meta.url), 'utf8');
  const relay = source.slice(source.indexOf('async function relayStart('), source.indexOf('export async function run('));
  assert.match(relay, /startSkillPreparationPump\(/);
  assert.ok(relay.indexOf("const result = await withRepositoryRelayStage('task_poll', () => serialized(") >= 0);
  assert.ok(relay.indexOf('startSkillPreparationPump(')
    < relay.indexOf("const result = await withRepositoryRelayStage('task_poll', () => serialized("));
  const tree = ts.createSourceFile('index.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const loop = tree.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'relayWorkspaceLoop');
  assert.ok(loop && ts.isFunctionDeclaration(loop) && loop.body);
  const awaitedCall = (statement: ts.Statement, receiver: string, method: string) => {
    if (!ts.isExpressionStatement(statement) || !ts.isAwaitExpression(statement.expression)) return false;
    const call = statement.expression.expression;
    return ts.isCallExpression(call) && call.arguments.length === 0 && ts.isPropertyAccessExpression(call.expression)
      && ts.isIdentifier(call.expression.expression) && call.expression.expression.text === receiver
      && call.expression.name.text === method;
  };
  const cleanup: ts.Block[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isTryStatement(node) && node.finallyBlock?.statements.some(statement => awaitedCall(statement, 'skillPreparationPump', 'stop'))) {
      cleanup.push(node.finallyBlock);
    }
    ts.forEachChild(node, visit);
  };
  visit(loop); assert.equal(cleanup.length, 1);
  const statements = cleanup[0]!.statements;
  const stopIndex = statements.findIndex(statement => awaitedCall(statement, 'skillPreparationPump', 'stop'));
  const closeIndex = statements.findIndex(statement => awaitedCall(statement, 'vault', 'close'));
  assert.ok(stopIndex >= 0); assert.equal(closeIndex, stopIndex + 1, 'the pump must settle before awaited vault closure');
  const signalCleanup = statements[closeIndex + 1];
  assert.ok(signalCleanup && ts.isExpressionStatement(signalCleanup) && ts.isCallExpression(signalCleanup.expression)
    && ts.isPropertyAccessExpression(signalCleanup.expression.expression)
    && signalCleanup.expression.expression.expression.getText(tree) === 'signal'
    && signalCleanup.expression.expression.name.text === 'removeEventListener');
  assert.doesNotMatch(relay, /await skillSync\(/);
});

test('actual provider staging uses independently isolated failures', async () => {
  const source = await readFile(new URL('../src/index.ts', import.meta.url), 'utf8');
  const relay = source.slice(source.indexOf('async function relayStart('), source.indexOf('export async function run('));
  assert.match(relay, /await prepareProvidersIndependently\(providerAdapters, assertRunning/);
});

test('actual relay consumes a verified cache only after an idle task boundary and falls back to fresh preparation', async () => {
  const source = await readFile(new URL('../src/index.ts', import.meta.url), 'utf8');
  const relay = source.slice(source.indexOf('async function relayStart('), source.indexOf('export async function run('));
  assert.ok(relay.indexOf("const result = await withRepositoryRelayStage('task_poll', () => serialized(") >= 0);
  assert.ok(relay.indexOf("const result = await withRepositoryRelayStage('task_poll', () => serialized(")
    < relay.indexOf('await takeCachedSkillUpdate('));
  assert.match(relay, /const prepared = cached \|\| await prepareSkillUpdate\(/);
  assert.ok(relay.indexOf('await takeCachedSkillUpdate(') < relay.indexOf('await activatePreparedSkillUpdate('));
});

test('relay receipt attributes activation failures to a provider without raw error text', async () => {
  const source = await readFile(new URL('../src/index.ts', import.meta.url), 'utf8');
  const relay = source.slice(source.indexOf('async function relayStart('), source.indexOf('export async function run('));
  assert.match(relay, /skillActivationFailuresByProvider\[adapter\.providerId\]/);
  assert.match(relay, /skillActivationFailuresByProvider,/);
  assert.doesNotMatch(relay, /skillActivationFailureMessage/);
});
