import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import test from 'node:test';
import ts from 'typescript';

type Acquire = (path: string, timeout: number, message: string) => Promise<() => Promise<void>>;

// Parse and execute the production helper; inject only OS boundaries, not lock logic.
async function acquire(overrides: Record<string, unknown> = {}): Promise<Acquire> {
  const text = await fs.readFile(fileURLToPath(new URL('../src/index.ts', import.meta.url)), 'utf8');
  const source = ts.createSourceFile('index.ts', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const nodes = source.statements.filter(node => ts.isFunctionDeclaration(node) && node.name?.text === 'acquirePidLock');
  assert.equal(nodes.length, 1);
  const compiled = ts.transpileModule(nodes[0]!.getText(source), {
    compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.None }, reportDiagnostics: true,
  });
  assert.equal(compiled.diagnostics?.filter(item => item.category === ts.DiagnosticCategory.Error).length, 0);
  return runInNewContext(`${compiled.outputText}\nacquirePidLock`, {
    ...fs, dirname, resolve, randomUUID, Date, setTimeout, process, ...overrides,
  }, { timeout: 1000, contextCodeGeneration: { strings: false, wasm: false } }) as Acquire;
}

function permissionError() {
  return Object.assign(new Error('Windows directory rename denied'), { code: 'EPERM' });
}

async function fixture() {
  const root = await fs.realpath(await fs.mkdtemp(resolve(tmpdir(), 'dharma-pid-lock-')));
  const lock = resolve(root, 'startup.lock');
  const recovery = `${lock}.recovery`;
  await fs.writeFile(lock, `${process.pid}\n`, { flag: 'wx' });
  return { root, lock, recovery, cleanup: () => fs.rm(root, { recursive: true, force: true }) };
}

function windowsRename(recovery: string) {
  return async (source: string, target: string) => {
    if (target === recovery && await fs.lstat(target).then(() => true, () => false)) throw permissionError();
    await fs.rename(source, target);
  };
}

test('Windows EPERM on an existing live recovery owner waits without overwriting either lock', async () => {
  const f = await fixture();
  let pending: Promise<unknown> | undefined;
  try {
    await fs.mkdir(f.recovery);
    await fs.writeFile(resolve(f.recovery, 'owner'), `${process.pid}\n`);
    const lock = await acquire({ process: { platform: 'win32', pid: process.pid, kill: process.kill.bind(process) },
      rename: windowsRename(f.recovery) });
    let state = 'waiting';
    pending = lock(f.lock, 500, 'lock timeout').then(async release => {
      state = 'acquired'; await release();
    }, error => { state = error.code || error.message; });
    await new Promise(done => setTimeout(done, 75));
    assert.equal(state, 'waiting');
    assert.equal(await fs.readFile(f.lock, 'utf8'), `${process.pid}\n`);
    assert.equal(await fs.readFile(resolve(f.recovery, 'owner'), 'utf8'), `${process.pid}\n`);
    await fs.rm(f.recovery, { recursive: true });
    await fs.unlink(f.lock);
    await pending;
    assert.equal(state, 'acquired');
  } finally { await pending; await f.cleanup(); }
});

for (const owner of ['absent', 'malformed', 'unreadable', 'symlink', 'owner_symlink'] as const) {
  test(`Windows EPERM with ${owner} recovery authority preserves records and fails closed`, async () => {
    const f = await fixture();
    try {
      const target = owner === 'symlink' ? resolve(f.root, 'unrelated') : f.recovery;
      if (owner !== 'absent') {
        await fs.mkdir(target);
        await fs.writeFile(resolve(target, 'owner'), owner === 'malformed' ? 'invalid\n' : `${process.pid}\n`);
      }
      if (owner === 'symlink') await fs.symlink(target, f.recovery, process.platform === 'win32' ? 'junction' : 'dir');
      if (owner === 'owner_symlink') {
        const receipt = resolve(f.root, 'unrelated-owner');
        await fs.writeFile(receipt, `${process.pid}\n`);
        await fs.unlink(resolve(target, 'owner'));
        await fs.symlink(receipt, resolve(target, 'owner'), 'file');
      }
      const denied = permissionError();
      const lock = await acquire({ process: { platform: 'win32', pid: process.pid, kill: process.kill.bind(process) },
        rename: async (source: string, destination: string) => {
          if (destination === f.recovery) throw denied;
          await fs.rename(source, destination);
        },
        readFile: async (path: string, encoding: 'utf8') => {
          if (owner === 'unreadable' && path === resolve(f.recovery, 'owner')) throw denied;
          return fs.readFile(path, encoding);
        } });
      await assert.rejects(lock(f.lock, 100, 'lock timeout'), error => error === denied);
      assert.equal(await fs.readFile(f.lock, 'utf8'), `${process.pid}\n`);
      if (owner !== 'absent') {
        assert.equal(await fs.readFile(resolve(target, 'owner'), 'utf8'), owner === 'malformed' ? 'invalid\n' : `${process.pid}\n`);
      }
      assert.equal((await fs.readdir(f.root)).some(name => name.includes('.candidate') || name.includes('.dead.')), false);
    } finally { await f.cleanup(); }
  });
}

test('Windows EPERM permits recovery of a valid dead recovery owner, not a live primary lock', async () => {
  const f = await fixture();
  try {
    await fs.mkdir(f.recovery);
    await fs.writeFile(resolve(f.recovery, 'owner'), '2147483647\n');
    const lock = await acquire({ process: { platform: 'win32', pid: process.pid, kill: (pid: number) => {
      if (pid === 2147483647) throw Object.assign(new Error('fixture dead owner'), { code: 'ESRCH' });
      return process.kill(pid, 0);
    } }, rename: windowsRename(f.recovery) });
    await assert.rejects(lock(f.lock, 100, 'lock timeout'), /lock timeout/);
    assert.equal(await fs.readFile(f.lock, 'utf8'), `${process.pid}\n`);
    await assert.rejects(fs.lstat(f.recovery), { code: 'ENOENT' });
  } finally { await f.cleanup(); }
});

test('POSIX EPERM is not converted to Windows recovery contention', async () => {
  const f = await fixture();
  try {
    await fs.mkdir(f.recovery);
    await fs.writeFile(resolve(f.recovery, 'owner'), `${process.pid}\n`);
    const denied = permissionError();
    const lock = await acquire({ process: { platform: 'linux', pid: process.pid, kill: process.kill.bind(process) },
      rename: async () => { throw denied; } });
    await assert.rejects(lock(f.lock, 100, 'lock timeout'), error => error === denied);
    assert.equal(await fs.readFile(resolve(f.recovery, 'owner'), 'utf8'), `${process.pid}\n`);
    assert.equal(await fs.readFile(f.lock, 'utf8'), `${process.pid}\n`);
  } finally { await f.cleanup(); }
});

test('Windows recovery publication tolerates repeated owner turnover within its deadline', async () => {
  const f = await fixture();
  let pending: Promise<void> | undefined;
  let releasePublication!: () => void;
  const publication = new Promise<void>(resolvePublication => { releasePublication = resolvePublication; });
  let fifthDenial!: () => void;
  const denialsObserved = new Promise<void>(resolveDenial => { fifthDenial = resolveDenial; });
  try {
    let attempts = 0; let clock = 0;
    const lock = await acquire({ Date: { now: () => clock },
      setTimeout: (done: () => void, milliseconds: number) => setImmediate(() => { clock += milliseconds; done(); }),
      process: { platform: 'win32', pid: process.pid, kill: process.kill.bind(process) },
      rename: async (source: string, target: string) => {
        if (target === f.recovery) {
          attempts++;
          if (attempts <= 5) {
            if (attempts === 5) fifthDenial();
            throw permissionError();
          }
          await publication;
        }
        await fs.rename(source, target);
      } });
    let state = 'waiting';
    pending = lock(f.lock, 500, 'lock timeout').then(async release => {
      state = 'acquired'; await release();
    }, error => { state = error.code || error.message; });
    await Promise.race([denialsObserved, pending.then(() => { throw new Error('lock settled before five denials'); })]);
    assert.equal(state, 'waiting', 'transient publication denial must not fail early or claim ownership');
    assert.equal(attempts, 5);
    assert.equal(await fs.readFile(f.lock, 'utf8'), `${process.pid}\n`);
    await fs.unlink(f.lock);
    releasePublication();
    await pending;
    assert.equal(state, 'acquired');
    assert.equal(attempts, 6);
    assert.ok(clock < 500, 'publication must still complete within the original deadline');
    assert.deepEqual(await fs.readdir(f.root), []);
  } finally { releasePublication(); await pending; await f.cleanup(); }
});

test('native filesystem PID lock serializes concurrent contenders and removes its own receipts', async () => {
  const f = await fixture();
  try {
    await fs.unlink(f.lock);
    const observations: string[] = [];
    const observe = (value: string) => {
      observations.push(value);
      if (observations.length > 120) observations.shift();
    };
    const label = (path: string) => path === f.recovery ? 'recovery'
      : path === resolve(f.recovery, 'owner') ? 'owner' : 'candidate';
    const lock = await acquire({
      rename: async (source: string, target: string) => {
        try { await fs.rename(source, target); observe(`rename:${label(target)}:ok`); }
        catch (error) { observe(`rename:${label(target)}:${(error as NodeJS.ErrnoException).code}`); throw error; }
      },
      lstat: async (path: string) => {
        try {
          const stat = await fs.lstat(path);
          observe(`lstat:${label(path)}:${stat.isSymbolicLink() ? 'symlink' : stat.isDirectory() ? 'directory' : 'file'}`);
          return stat;
        } catch (error) { observe(`lstat:${label(path)}:${(error as NodeJS.ErrnoException).code}`); throw error; }
      },
      readFile: async (path: string, encoding: 'utf8') => {
        try { const text = await fs.readFile(path, encoding); observe(`read:${label(path)}:ok`); return text; }
        catch (error) { observe(`read:${label(path)}:${(error as NodeJS.ErrnoException).code}`); throw error; }
      },
    });
    let active = 0; let maximum = 0; let completed = 0;
    const results = await Promise.allSettled(Array.from({ length: 20 }, async () => {
      const release = await lock(f.lock, 5000, 'lock timeout');
      try {
        active++; maximum = Math.max(maximum, active);
        await new Promise(done => setTimeout(done, 3));
        completed++;
      } finally { active--; await release(); }
    }));
    const failures = results.filter(result => result.status === 'rejected');
    assert.deepEqual(failures, [], `all contenders must finish before fixture cleanup; bounded fixture metadata: ${observations.join(',')}`);
    assert.equal(maximum, 1);
    assert.equal(completed, 20);
    assert.deepEqual(await fs.readdir(f.root), []);
  } finally { await f.cleanup(); }
});

test('Windows owner inspection denial retries only after recovery directory disappearance', async () => {
  const f = await fixture();
  try {
    await fs.mkdir(f.recovery);
    await fs.writeFile(resolve(f.recovery, 'owner'), `${process.pid}\n`);
    let inspected = false;
    const lock = await acquire({
      process: { platform: 'win32', pid: process.pid, kill: process.kill.bind(process) },
      rename: windowsRename(f.recovery),
      readFile: async (path: string, encoding: 'utf8') => {
        if (path === resolve(f.recovery, 'owner') && !inspected) {
          inspected = true;
          await fs.rm(f.recovery, { recursive: true });
          await fs.unlink(f.lock);
          throw permissionError();
        }
        return fs.readFile(path, encoding);
      },
    });
    const release = await lock(f.lock, 500, 'lock timeout');
    assert.equal(inspected, true);
    await release();
    assert.deepEqual(await fs.readdir(f.root), []);
  } finally { await f.cleanup(); }
});
