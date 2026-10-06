import assert from 'node:assert/strict';
import {spawn, type ChildProcess} from 'node:child_process';
import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import test from 'node:test';
import {compileFunction} from 'node:vm';
import ts from 'typescript';
import {watchOwnedChild} from './ownedChildLifecycle.js';

// Compile the actual container caller. Linux controller/creation/storage
// attribution is synthetic; its directly spawned C-only children are real.
async function fixture() {
  const source = await readFile(new URL('../src/containerRelayLifecycle.ts', import.meta.url), 'utf8');
  const ast = ts.createSourceFile('containerRelayLifecycle.ts', source, ts.ScriptTarget.Latest, true);
  const functions = ['stopOwnedChild', 'runOwnedContainerEntrypoint'].map(name => {
    const nodes = ast.statements.filter(node => ts.isFunctionDeclaration(node) && node.name?.text === name);
    assert.equal(nodes.length, 1); return nodes[0]!.getText(ast);
  }).join('\n');
  const compiled = ts.transpileModule(functions, {compilerOptions: {
    target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.CommonJS}, reportDiagnostics: true});
  assert.equal(compiled.diagnostics?.filter(d => d.category === ts.DiagnosticCategory.Error).length, 0);
  const home = resolve('synthetic-home');
  const controller = {pid: 1, uid: 1000, startTicks: '1', argv: ['synthetic-node', 'synthetic-entry']};
  const records = new Map<string, unknown>();
  const children: ChildProcess[] = [];
  const abort = new AbortController();
  let initialIdentity = true, currentIdentity = true;
  let heartbeat = (_value: Record<string, unknown>) => {};
  const dependencies: Record<string, unknown> = {
    watchOwnedChild, process, JSON, Date, Boolean, Error, Promise,
    ownedController: async () => ({identity: controller}), canonicalEntrypoint: async () => 'synthetic-entry',
    ownUid: () => 1000, ownedIdentity: () => true, privateDirectory: async () => {},
    mkdir: async () => {}, join: resolve,
    privatePath: (_home: string, name: string) => name,
    privateJson: async (_options: unknown, name: string) => records.get(name) ?? null,
    writeFile: async (name: string, bytes: string) => {records.set(name, JSON.parse(bytes));},
    writePrivateJson: async (_options: unknown, name: string, value: Record<string, unknown>) => {
      records.set(name, value); if (name === 'container-heartbeat.json') heartbeat(value);
    },
    rm: async (name: string) => {records.delete(name);},
    containerEntrypointAvailable: async () => true,
    readConfiguration: async () => ({running: true, registration: {version: '0.2.153', policy: 'synthetic-policy'}}),
    registrationHash: () => 'synthetic-registration-hash',
    ownedChild: async (_options: unknown, pid: number, ticks: string | undefined) => {
      if (!(ticks ? currentIdentity : initialIdentity)) return null;
      return {pid, uid: 1000, parentPid: 1, startTicks: String(pid)};
    },
    wait: async () => new Promise<void>(done => setImmediate(done)),
    unavailable: () => new Error('container_startup_unavailable'),
  };
  const run = compileFunction(compiled.outputText.replaceAll('import.meta.url', '"file:///synthetic/index.js"')
    + '\nreturn runOwnedContainerEntrypoint;', ['exports', ...Object.keys(dependencies)])({}, ...Object.values(dependencies));
  const start = (spawned?: (child: ChildProcess) => void) => run({home, uid: 1000, signal: abort.signal,
    containerRuntime: {runtimeVersion: '0.2.153'}, consumerStoreReady: async () => true,
    spawnRelay: () => {
      const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {stdio: 'ignore'});
      children.push(child); spawned?.(child); return child;
    }, pollMs: 1, restartDelayMs: 0});
  return {start, children, records, abort,
    initialIdentity: (value: boolean) => {initialIdentity = value;},
    currentIdentity: (value: boolean) => {currentIdentity = value;},
    onHeartbeat: (handler: typeof heartbeat) => {heartbeat = handler;},
    cleanup: async () => {abort.abort(); for (const child of children) await watchOwnedChild(child).stop({graceMs: 1000});},
  };
}

test('actual container caller drains an errored live child before replacing it', async () => {
  const f = await fixture(); let firstError = false;
  const timer = setTimeout(() => f.abort.abort(), 5000);
  f.onHeartbeat(value => {
    if (value.lifecycle !== 'running') return;
    if (!firstError) {firstError = true; f.children[0]!.emit('error', new Error('SYNTHETIC_PROCESS_ERROR'));}
    else f.abort.abort();
  });
  try {
    const result = await f.start(() => {
      if (f.children.length > 1) assert.ok(f.children[0]!.exitCode !== null || f.children[0]!.signalCode !== null,
        'replacement cannot precede confirmed exit');
    });
    assert.equal(result.stopped, true); assert.equal(result.restarts, 1); assert.equal(f.children.length, 2);
    assert.ok(f.children.every(child => child.exitCode !== null || child.signalCode !== null));
    assert.equal(f.records.has('container-entrypoint.lock'), false);
  } finally {clearTimeout(timer); await f.cleanup();}
});

test('actual container caller drains its new spawn after initial attribution fails', async () => {
  const f = await fixture(); f.initialIdentity(false);
  try {
    await assert.rejects(f.start(), /^Error: container_startup_unavailable$/);
    assert.equal(f.children.length, 1);
    assert.ok(f.children[0]!.exitCode !== null || f.children[0]!.signalCode !== null);
    assert.equal(f.records.has('container-entrypoint.lock'), false);
  } finally {await f.cleanup();}
});

test('actual container caller preserves records and uncertainty when current attribution is lost', async () => {
  const f = await fixture(); let signals = 0;
  f.onHeartbeat(value => {
    if (value.lifecycle === 'running') {
      f.currentIdentity(false); f.children[0]!.emit('error', new Error('SYNTHETIC_PROCESS_ERROR'));
    }
  });
  let originalKill: ChildProcess['kill'] | undefined;
  try {
    await assert.rejects(f.start(child => {
      originalKill = child.kill.bind(child);
      child.kill = signal => {signals++; return originalKill!(signal);};
    }), /^Error: owned_child_stop_unconfirmed$/);
    assert.equal(f.children.length, 1); assert.equal(signals, 0);
    assert.equal(f.children[0]!.exitCode, null); assert.equal(f.children[0]!.signalCode, null);
    assert.equal(f.records.has('container-entrypoint.lock'), true);
    assert.equal(f.records.has('container-entrypoint.json'), true);
  } finally {
    // The test owns this exact original C-only spawn handle independently of
    // its synthetic Linux attribution. Restore its normal cleanup control.
    if (originalKill) f.children[0]!.kill = originalKill;
    await f.cleanup();
  }
});
