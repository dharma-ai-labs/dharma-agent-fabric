import assert from 'node:assert/strict';
import {AsyncResource} from 'node:async_hooks';
import {execFileSync, spawn, type ChildProcess} from 'node:child_process';
import {EventEmitter} from 'node:events';
import {mkdtemp, readFile, realpath, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';
import {compileFunction} from 'node:vm';
import test from 'node:test';
import ts from 'typescript';
import {createNamedSessionChildOwner, currentNamedSessionChildOwner} from './namedSessionChildOwner.js';
import {watchOwnedChild} from './ownedChildLifecycle.js';

class FakeChild extends EventEmitter {
  pid = 101; exitCode: number | null = null; signalCode: string | null = null;
  signals: string[] = []; finishOnKill = true;
  kill(signal: string) {
    this.signals.push(signal);
    if (this.finishOnKill) queueMicrotask(() => this.finish());
    return true;
  }
  finish() {this.exitCode = 0; this.emit('exit', 0); this.emit('close', 0);}
  get handle() {return this as unknown as ChildProcess;}
}

test('standing owner serializes each name and refuses replacement of a still-live child', async () => {
  const owner = createNamedSessionChildOwner(new AbortController().signal), child = new FakeChild();
  let replacements = 0;
  await owner.run(async () => {
    assert.equal(currentNamedSessionChildOwner(), owner);
    await owner.spawn('reviewer', () => child.handle);
    await assert.rejects(owner.spawn('reviewer', () => {replacements++; return new FakeChild().handle;}), /still_running/);
  });
  assert.equal(replacements, 0); assert.deepEqual(child.signals, ['SIGTERM']);
  assert.equal(currentNamedSessionChildOwner(), undefined);
});

test('standing owner waits for confirmed errored-child exit before admitting its replacement', async () => {
  const owner = createNamedSessionChildOwner(new AbortController().signal), first = new FakeChild(), second = new FakeChild();
  first.finishOnKill = false; let replacements = 0;
  await owner.run(async () => {
    await owner.spawn('reviewer', () => first.handle); first.emit('error', new Error('synthetic send failure'));
    const replacing = owner.spawn('reviewer', () => {replacements++; return second.handle;});
    await Promise.resolve(); assert.equal(replacements, 0); assert.deepEqual(first.signals, ['SIGTERM']);
    first.finish(); await replacing;
  });
  assert.equal(replacements, 1); assert.deepEqual(second.signals, ['SIGTERM']);
});

test('standing owner rejects duplicate concurrent admission while prior stop is pending', async () => {
  const owner = createNamedSessionChildOwner(new AbortController().signal), first = new FakeChild(); first.finishOnKill = false;
  let spawns = 0;
  await owner.run(async () => {
    await owner.spawn('reviewer', () => first.handle); first.emit('error', new Error('synthetic failure'));
    const replacing = owner.spawn('reviewer', () => {spawns++; return new FakeChild().handle;});
    await assert.rejects(owner.spawn('reviewer', () => {spawns++; return new FakeChild().handle;}), /owner_conflict/);
    first.finish(); await replacing;
  });
  assert.equal(spawns, 1);
});

for (const action of ['abort', 'close'] as const) {
  test(`standing owner captures and drains a child when ${action} occurs inside synchronous spawn`, async () => {
    const signal = new AbortController(), owner = createNamedSessionChildOwner(signal.signal), child = new FakeChild();
    await assert.rejects(owner.run(() => owner.spawn('reviewer', () => {
      if (action === 'abort') signal.abort(); else void owner.close();
      return child.handle;
    })), /owner_unavailable/);
    assert.equal(child.exitCode, 0); assert.deepEqual(child.signals, ['SIGTERM']);
    await owner.close();
  });
}

test('standing owner does not adopt another owner child, and does not signal an unrelated handle', async () => {
  const first = createNamedSessionChildOwner(new AbortController().signal), child = new FakeChild(), unrelated = new FakeChild();
  const second = createNamedSessionChildOwner(new AbortController().signal);
  const outside = new AsyncResource('synthetic-unscoped-owner');
  await first.run(async () => {
    await first.spawn('reviewer', () => child.handle);
    await assert.rejects(outside.runInAsyncScope(() => second.run(() => second.spawn('reviewer', () => child.handle))), /owner_conflict/);
    assert.equal(child.signals.length, 0);
  });
  outside.emitDestroy();
  assert.deepEqual(unrelated.signals, []);
});

test('standing owner refuses late detached spawn after its operation has settled', async () => {
  const owner = createNamedSessionChildOwner(new AbortController().signal); let late!: () => Promise<ChildProcess>, effects = 0;
  await owner.run(async () => {late = () => owner.spawn('reviewer', () => {effects++; return new FakeChild().handle;});});
  await assert.rejects(late(), /owner_unavailable/); assert.equal(effects, 0);
});

test('standing owner releases admission after synchronous spawn failure without hiding uncertainty', async () => {
  const owner = createNamedSessionChildOwner(new AbortController().signal), child = new FakeChild();
  await owner.run(async () => {
    await assert.rejects(owner.spawn('reviewer', () => {throw new Error('synthetic spawn failure');}), /spawn failure/);
    await owner.spawn('reviewer', () => child.handle);
  });
  assert.equal(child.exitCode, 0);
});

test('standing owner reports unconfirmed exit instead of settling successfully', async t => {
  t.mock.timers.enable({apis: ['setTimeout']});
  const signal = new AbortController(), owner = createNamedSessionChildOwner(signal.signal), child = new FakeChild();
  child.finishOnKill = false;
  const running = owner.run(async () => {await owner.spawn('reviewer', () => child.handle); signal.abort();});
  const outcome = assert.rejects(running, /owned_child_stop_unconfirmed/);
  for (let i = 0; i < 12; i++) await Promise.resolve();
  t.mock.timers.tick(10_000);
  for (let i = 0; i < 12; i++) await Promise.resolve();
  t.mock.timers.tick(10_000);
  await outcome; assert.deepEqual(child.signals, ['SIGTERM', 'SIGKILL']); child.finish();
});

test('standing owner can recover an earlier stop failure only after actual exit is observed', async t => {
  t.mock.timers.enable({apis: ['setTimeout']});
  const owner = createNamedSessionChildOwner(new AbortController().signal), first = new FakeChild(), second = new FakeChild();
  first.finishOnKill = false;
  await owner.run(async () => {
    await owner.spawn('reviewer', () => first.handle); first.emit('error', new Error('synthetic error'));
    const replacement = owner.spawn('reviewer', () => second.handle);
    const failure = assert.rejects(replacement, /owned_child_stop_unconfirmed/);
    for (let i = 0; i < 12; i++) await Promise.resolve();
    t.mock.timers.tick(10_000);
    for (let i = 0; i < 12; i++) await Promise.resolve();
    t.mock.timers.tick(10_000); await failure;
    assert.deepEqual(second.signals, []);
    first.finish(); await owner.spawn('reviewer', () => second.handle);
  });
  assert.equal(second.exitCode, 0);
});

test('standing owner enforces the bounded live-child capacity without spawning a fifty-first child', async () => {
  const owner = createNamedSessionChildOwner(new AbortController().signal), children: FakeChild[] = []; let extra = 0;
  await owner.run(async () => {
    for (let i = 0; i < 50; i++) {
      const child = new FakeChild(); children.push(child); await owner.spawn(`session-${i}`, () => child.handle);
    }
    await assert.rejects(owner.spawn('session-overflow', () => {extra++; return new FakeChild().handle;}), /owner_capacity/);
  });
  assert.equal(extra, 0); assert.equal(children.filter(child => child.exitCode === 0).length, 50);
});

test('actual supervisor declaration drains its fresh C-only session child before returning', async t => {
  const root = await realpath(await mkdtemp(resolve(tmpdir(), 'dharma-standing-session-'))), signal = new AbortController();
  let child: ChildProcess | undefined;
  t.after(async () => {signal.abort(); if (child) await watchOwnedChild(child).stop({graceMs: 1000}); await rm(root, {recursive: true, force: true});});
  const baseline = process.env.DHARMA_SUPERVISOR_BASELINE_SHA;
  if (baseline && !/^[a-f0-9]{40}$/.test(baseline)) throw new Error('fixture_baseline_invalid');
  const source = baseline ? execFileSync('git', ['show', `${baseline}:packages/cli/src/index.ts`], {encoding: 'utf8'})
    : await readFile(new URL('../src/index.ts', import.meta.url), 'utf8');
  const ast = ts.createSourceFile('index.ts', source, ts.ScriptTarget.Latest, true);
  const functions = ast.statements.filter(node => ts.isFunctionDeclaration(node) && node.name?.text === 'superviseNamedSessions');
  assert.equal(functions.length, 1);
  const output = ts.transpileModule(functions[0]!.getText(ast), {compilerOptions: {
    target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.CommonJS}, reportDiagnostics: true});
  assert.equal(output.diagnostics?.filter(d => d.category === ts.DiagnosticCategory.Error).length, 0);
  const dependencies = {process: {platform: 'linux', stderr: {write: () => {}}}, createNamedSessionChildOwner,
    resolve, dharmaHome: () => root, setTimeout, clearTimeout,
    access: async () => {throw Object.assign(new Error('synthetic vault absent'), {code: 'ENOENT'});},
    readdir: async () => [{name: 'reviewer', isDirectory: () => true}],
    readNamedSession: async () => ({enabled: true, name: 'reviewer', identity: {workspaceId: 'synthetic_workspace'}}),
    namedSessionCommand: async (action: string, flags: Map<string, string | boolean>) => {
      assert.equal(action, 'start'); assert.equal(flags.get('name'), 'reviewer');
      assert.equal(flags.get('workspace-id'), 'synthetic_workspace'); assert.equal(flags.get('apply'), true);
      const owner = currentNamedSessionChildOwner();
      const start = () => spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {cwd: root, stdio: 'ignore'});
      child = owner ? await owner.spawn('reviewer', start) : start();
      signal.abort(); return {ok: true};
    }};
  const supervise = compileFunction(output.outputText + '\nreturn superviseNamedSessions;', ['exports', ...Object.keys(dependencies)])(
    {}, ...Object.values(dependencies));
  await supervise(signal.signal);
  assert.ok(child); assert.ok(child.exitCode !== null || child.signalCode !== null);
});
