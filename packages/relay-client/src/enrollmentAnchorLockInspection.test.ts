import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import * as fs from 'node:fs/promises';
import {basename, dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {runInNewContext} from 'node:vm';
import test from 'node:test';
import ts from 'typescript';
import type {acquireEnrollmentAnchorLock} from './enrollmentAnchorLock.js';
import {HostOperationFence} from './hostOperationScope.js';

async function inspectionFixture(input: {
  kind: 'primary' | 'recovery'; platform?: string; code?: string;
  releaseOnWait?: boolean; denyPublication?: boolean; denyLiveness?: boolean; withdrawOnWait?: boolean;
}) {
  const root = await fs.mkdtemp(resolve(import.meta.dirname, 'fixture-lock-inspection-'));
  const path = resolve(root, 'anchor.lock');
  const blocked = input.kind === 'recovery' ? path + '.recovery' : path;
  await fs.writeFile(blocked, '123\n');
  const denial = Object.assign(new Error('synthetic inspection denied'), {code: input.code ?? 'EPERM'});
  let clock = 0, deniedReads = 0, waits = 0, allowed = true;
  const effects: string[] = [];
  let withdrawnAt: number | null = null;
  let timerFailure: unknown;
  const source = await fs.readFile(fileURLToPath(new URL('../src/enrollmentAnchorLock.ts', import.meta.url)), 'utf8');
  const ast = ts.createSourceFile('lock.ts', source, ts.ScriptTarget.Latest, true);
  const declarations = ast.statements.filter(node => ts.isFunctionDeclaration(node)
    && node.name?.text === 'acquireEnrollmentAnchorLock');
  assert.equal(declarations.length, 1);
  const compiled = ts.transpileModule(declarations[0]!.getText(ast).replace('export async', 'async'), {
    compilerOptions: {target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.None}, reportDiagnostics: true,
  });
  assert.equal(compiled.diagnostics?.filter(item => item.category === ts.DiagnosticCategory.Error).length, 0);
  // All files are this fixture's own fresh directory. Process ownership and time are injected.
  const acquire = runInNewContext(compiled.outputText + '\nacquireEnrollmentAnchorLock', {
    ...fs, dirname, randomUUID, Error,
    process: {platform: input.platform ?? 'win32', pid: 456, getuid: () => 0,
      kill: () => {
        if (input.denyLiveness) throw denial;
        assert.fail('an unreadable owner must never reach a process-liveness decision');
      }},
    Date: {now: () => clock},
    mkdir: async (name: string, options: {recursive: true; mode: number}) => {
      effects.push('mkdir'); return fs.mkdir(name, options);
    },
    writeFile: async (name: string, value: string, options: {flag: string; mode: number}) => {
      effects.push('write'); return fs.writeFile(name, value, options);
    },
    unlink: async (name: string) => {effects.push('unlink'); return fs.unlink(name);},
    rename: async (from: string, to: string) => {effects.push('rename'); return fs.rename(from, to);},
    lstat: async (name: string, options: {bigint: true}) => {
      effects.push('metadata');
      const value = await fs.lstat(name, options);
      if (name !== root) return value;
      return {dev: value.dev, ino: value.ino, uid: 0n, mode: 0o40700n,
        isDirectory: () => true, isSymbolicLink: () => false};
    },
    readFile: async (name: string, encoding: BufferEncoding) => {
      effects.push('read');
      if (name === blocked && !input.denyLiveness) {deniedReads++; throw denial;}
      return fs.readFile(name, encoding);
    },
    link: async (candidate: string, destination: string) => {
      effects.push('link');
      if (input.denyPublication && destination === path + '.recovery') throw denial;
      return fs.link(candidate, destination);
    },
    setTimeout: (callback: () => void, delay: number) => {
      assert.equal(delay, 25); clock += delay; waits++;
      if (input.withdrawOnWait) {allowed = false; withdrawnAt = effects.length;}
      if (input.releaseOnWait && waits === 1) {
        void fs.unlink(blocked).then(callback, error => {timerFailure = error; callback();});
      } else callback();
      return 0;
    },
  }, {timeout: 1000, contextCodeGeneration: {strings: false, wasm: false}}) as typeof acquireEnrollmentAnchorLock;
  const scope = new HostOperationFence({signal: new AbortController().signal, current: async () => allowed});
  return {root, path, blocked, denial, acquire, scope,
    deniedReads: () => deniedReads, waits: () => waits,
    effectsAfterWithdrawal: () => effects.slice(withdrawnAt ?? effects.length),
    checkTimer: () => {if (timerFailure) throw timerFailure;},
    cleanup: async () => {
      assert.equal(dirname(root), import.meta.dirname);
      assert.ok(basename(root).startsWith('fixture-lock-inspection-'));
      await fs.rm(root, {recursive: true, force: true});
    }};
}

test('Windows unreadable owner inspection waits for release without inferring stale ownership', async () => {
  for (const kind of ['primary', 'recovery'] as const) {
    const f = await inspectionFixture({kind, releaseOnWait: true});
    try {
      const release = await f.acquire(f.path, undefined, 100);
      try {
        await release.assertHeld();
        assert.equal(f.deniedReads(), 1); assert.equal(f.waits(), 1);
        assert.equal(await fs.readFile(f.path, 'utf8'), '456\n');
      } finally {await release();}
      f.checkTimer(); assert.deepEqual(await fs.readdir(f.root), []);
    } finally {await f.cleanup();}
  }
});

test('persistent Windows inspection denial stays busy and preserves primary and recovery owners', async () => {
  for (const kind of ['primary', 'recovery'] as const) {
    const f = await inspectionFixture({kind});
    try {
      const before = await fs.stat(f.blocked, {bigint: true});
      await assert.rejects(f.acquire(f.path, undefined, 100), /connection_anchor_busy/);
      assert.ok(f.deniedReads() > 0); assert.equal(f.waits(), 4);
      assert.equal(await fs.readFile(f.blocked, 'utf8'), '123\n');
      const after = await fs.stat(f.blocked, {bigint: true});
      assert.equal(after.dev, before.dev); assert.equal(after.ino, before.ino);
      assert.deepEqual(await fs.readdir(f.root), [basename(f.blocked)]);
    } finally {await f.cleanup();}
  }
});

test('other permission and publication denials are not reclassified as Windows inspection contention', async () => {
  for (const input of [
    {platform: 'linux', code: 'EPERM'}, {platform: 'win32', code: 'EACCES'},
    {platform: 'win32', code: 'EPERM', denyPublication: true},
    {platform: 'win32', code: 'EPERM', denyLiveness: true},
  ]) {
    const f = await inspectionFixture({kind: 'recovery', ...input});
    try {
      await assert.rejects(f.acquire(f.path, undefined, 100), error => error === f.denial);
      assert.equal(f.waits(), 0);
      assert.equal(await fs.readFile(f.blocked, 'utf8'), '123\n');
      assert.deepEqual(await fs.readdir(f.root), [basename(f.blocked)]);
    } finally {await f.cleanup();}
  }
});

test('host withdrawal during an uninspectable-owner wait admits no subsequent filesystem step', async () => {
  const f = await inspectionFixture({kind: 'recovery', withdrawOnWait: true});
  try {
    await assert.rejects(f.acquire(f.path, f.scope, 100), /relay_host_scope_unavailable/);
    assert.equal(f.deniedReads(), 1); assert.equal(f.waits(), 1);
    assert.deepEqual(f.effectsAfterWithdrawal(), []);
    assert.equal(await fs.readFile(f.blocked, 'utf8'), '123\n');
    assert.deepEqual(await fs.readdir(f.root), [basename(f.blocked)]);
  } finally {await f.cleanup();}
});
