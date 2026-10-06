import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {readFile} from 'node:fs/promises';
import {dirname, resolve} from 'node:path';
import test from 'node:test';
import {compileFunction} from 'node:vm';
import ts from 'typescript';

// The unchanged caller is compiled; only its OS/storage/service boundaries are
// synthetic. This does not qualify native Linux startup or client readiness.
async function fixture(serviceError?: string, service: 'relay' | 'session' = 'relay') {
  const source = await readFile(new URL('../src/index.ts', import.meta.url), 'utf8');
  const ast = ts.createSourceFile('index.ts', source, ts.ScriptTarget.Latest, true);
  const declarations = ast.statements.filter(node => ts.isFunctionDeclaration(node)
    && node.name?.text === 'relaySupervise');
  assert.equal(declarations.length, 1);
  const compiled = ts.transpileModule(declarations[0]!.getText(ast), {compilerOptions: {
    target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.CommonJS}, reportDiagnostics: true});
  assert.equal(compiled.diagnostics?.filter(d => d.category === ts.DiagnosticCategory.Error).length, 0);
  const events: string[] = [];
  const runtime = Object.assign(new EventEmitter(), {pid: 12345, env: {}, stderr: {write() {} }});
  let signal: AbortSignal | undefined;
  const dependencies: Record<string, unknown> = {
    resolve, dirname, AbortController, Error, Promise, process: runtime, VERSION: 'synthetic',
    required: (flags: Map<string, unknown>, name: string) => flags.get(name),
    readDeviceConfig: async () => ({organizationId: 'org_fixture', deviceId: 'own-device'}),
    registry: async () => [], selectDeviceWorkspace: () => ({workspaceId: 'own-workspace', path: resolve('fixture')}),
    dharmaHome: () => resolve('fixture', 'home'),
    acquireRelaySupervisorLease: async () => async () => {events.push('lease-released');},
    createDemoWatchHealthRecorder: () => ({available: () => true, record() {}, drain: async () => {events.push('health-drained');}}),
    writeJsonAtomic: async () => {events.push('binding-written');},
    runDemoSupervisor: async (options: {signal: AbortSignal}) => {signal = options.signal; return {};},
    superviseRelay: async () => {if (serviceError && service === 'relay') throw new Error(serviceError); return {restarts: 0};},
    superviseNamedSessions: async () => {if (serviceError && service === 'session') throw new Error(serviceError);},
    readFile: async () => JSON.stringify({pid: runtime.pid}),
    rm: async () => {events.push('binding-removed');},
  };
  const run = compileFunction(compiled.outputText.replaceAll('import.meta.url', '"file:///synthetic/index.js"')
    + '\nreturn relaySupervise;', ['exports', ...Object.keys(dependencies)])({}, ...Object.values(dependencies));
  return {run: () => run(new Map([['policy', resolve('fixture', '.dharma', 'approved-policy.json')]])),
    events, runtime, signal: () => signal};
}

test('actual supervisor caller preserves ownership records after an unconfirmed child stop', async () => {
  const f = await fixture('owned_child_stop_unconfirmed');
  await assert.rejects(f.run(), /^Error: relay_supervisor_child_stop_unconfirmed$/);
  assert.deepEqual(f.events, ['binding-written', 'health-drained']);
  assert.equal(f.signal()?.aborted, true);
  assert.equal(f.runtime.listenerCount('SIGTERM'), 0); assert.equal(f.runtime.listenerCount('SIGINT'), 0);
});

test('actual supervisor caller removes only its binding after confirmed service settlement', async () => {
  const f = await fixture();
  assert.equal((await f.run()).stopped, true);
  assert.deepEqual(f.events, ['binding-written', 'health-drained', 'binding-removed', 'lease-released']);
});

test('actual supervisor caller preserves ordinary service failure without turning it into success', async () => {
  const f = await fixture('synthetic_service_failure');
  await assert.rejects(f.run(), /^Error: synthetic_service_failure$/);
  assert.deepEqual(f.events, ['binding-written', 'health-drained', 'binding-removed', 'lease-released']);
});

test('actual supervisor caller preserves its binding and lease after unconfirmed named-session drain', async () => {
  const f = await fixture('owned_child_stop_unconfirmed', 'session');
  await assert.rejects(f.run(), /^Error: relay_supervisor_child_stop_unconfirmed$/);
  assert.deepEqual(f.events, ['binding-written', 'health-drained']);
  assert.equal(f.signal()?.aborted, true);
});
