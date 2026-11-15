import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import * as fs from 'node:fs/promises';
import {tmpdir, uptime} from 'node:os';
import {dirname, resolve} from 'node:path';
import test from 'node:test';
import {fileURLToPath} from 'node:url';
import {runInNewContext} from 'node:vm';
import ts from 'typescript';
import {acquireEnrollmentAnchorLock} from './enrollmentAnchorLock.js';
import {HostOperationFence} from './hostOperationScope.js';

const moduleUrl = new URL('./enrollmentAnchorLock.js', import.meta.url).href;
// The G11 hard reset left exactly this on disk: five NUL bytes.
const NUL_OWNER = Buffer.alloc(5);
// #484: a Windows host crash left the full six-byte length, all NUL.
const TORN_OWNER = Buffer.alloc(6);
// A PID that process.kill accepts and no process holds.
const DEAD_OWNER = '2147483647\n';
// Linux and macOS flush the lock folder once the lock is published and the mutex is gone; Windows cannot.
const FOLDER_FLUSH = process.platform === 'win32' ? [] : ['folder flush'];

async function fixture(t: {after(fn: () => Promise<void>): void}) {
  const root = await fs.realpath(await fs.mkdtemp(resolve(tmpdir(), 'fabric-anchor-corrupt-')));
  t.after(() => fs.rm(root, {recursive: true, force: true, maxRetries: 5}));
  return {root, path: resolve(root, 'anchor.lock')};
}
function child(script: string, ...args: string[]) {
  return new Promise<void>((accept, reject) => {
    const processChild = spawn(process.execPath, ['--input-type=module', '-e', script, ...args],
      {windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']});
    let errors = '';
    processChild.stderr.on('data', value => errors += String(value));
    processChild.on('error', reject);
    processChild.on('exit', code => code === 0 ? accept() : reject(Error(errors || `child exit ${code}`)));
  });
}
async function waitFor(path: string) {
  const deadline = Date.now() + 15_000;
  for (;;) {
    try {return await fs.readFile(path, 'utf8');}
    catch (error) {if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;}
    if (Date.now() > deadline) throw Error('child readiness timeout');
    await new Promise(accept => setTimeout(accept, 10));
  }
}
// Parse the production function so that its file boundary can be injected.
async function compiledAcquire(context: Record<string, unknown>) {
  const source = await fs.readFile(fileURLToPath(new URL('../src/enrollmentAnchorLock.ts', import.meta.url)), 'utf8');
  const ast = ts.createSourceFile('lock.ts', source, ts.ScriptTarget.Latest, true);
  const node = ast.statements.find(value => ts.isFunctionDeclaration(value) && value.name?.text === 'acquireEnrollmentAnchorLock')!;
  const compiled = ts.transpileModule(node.getText(ast).replace('export async', 'async'), {
    compilerOptions: {target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.None},
  }).outputText;
  return runInNewContext(compiled + '\nacquireEnrollmentAnchorLock',
    {...fs, dirname, randomUUID, process, Date, setTimeout, Error, ...context}) as typeof acquireEnrollmentAnchorLock;
}
// A holder that proves at release time that nothing evicted it.
const holderScript = `import {acquireEnrollmentAnchorLock} from ${JSON.stringify(moduleUrl)};
  import {readFile,writeFile,rename} from 'node:fs/promises';
  const [path,started,ready,releasePath]=process.argv.slice(1);
  await writeFile(started,'started');
  const release=await acquireEnrollmentAnchorLock(path);
  await writeFile(ready+'.pending',String(process.pid));
  await rename(ready+'.pending',ready);
  const deadline=Date.now()+30000;
  try {
    for(;;) {
      try {await readFile(releasePath);break;}
      catch(error) {if(error.code!=='ENOENT'||Date.now()>deadline)throw error;}
      await new Promise(resolve=>setTimeout(resolve,10));
    }
    await release.assertHeld();
  } finally {await release();}`;

// Records every file change the acquire makes to the lock or its mutex, and every retry wait.
function recordedChanges(path: string) {
  const changes: string[] = [];
  let waits = 0;
  return {changes, waits: () => waits, context: {
    link: async (candidate: string, destination: string) => {
      if (destination === path || destination === path + '.recovery') changes.push(`link ${destination}`);
      return fs.link(candidate, destination);
    },
    rename: async (from: string, to: string) => {changes.push(`rename ${from}`); return fs.rename(from, to);},
    unlink: async (name: string) => {
      if (name === path || name.startsWith(path + '.dead.')) changes.push(`unlink ${name}`);
      return fs.unlink(name);
    },
    setTimeout: (callback: () => void, delay: number) => {
      if (delay === 25) waits++;
      return setTimeout(callback, delay);
    },
  }};
}

// #484 scope: a lock whose contents cannot name an owner is not reclaimed. The acquire stops with
// connection_anchor_lock_invalid at once, and the lock keeps its file, contents and timestamp.
async function assertStopped(t: {after(fn: () => Promise<void>): void}, label: string, value: string | Buffer, mtime?: Date) {
  const f = await fixture(t), recorded = recordedChanges(f.path);
  await fs.writeFile(f.path, value);
  if (mtime) await fs.utimes(f.path, mtime, mtime);
  const before = await fs.stat(f.path, {bigint: true});
  const acquire = await compiledAcquire(recorded.context);
  await assert.rejects(acquire(f.path, undefined, 2000), /^Error: connection_anchor_lock_invalid$/, label);
  const after = await fs.stat(f.path, {bigint: true});
  assert.equal(after.ino, before.ino, label); assert.equal(after.dev, before.dev, label);
  assert.equal(after.mtimeNs, before.mtimeNs, label);
  assert.deepEqual(await fs.readFile(f.path), Buffer.from(value), label);
  assert.deepEqual(recorded.changes, [], `${label}: no link, rename or unlink`);
  assert.equal(recorded.waits(), 0, `${label}: no retry`);
  assert.deepEqual(await fs.readdir(f.root), ['anchor.lock'], label);
}

test('empty or unparseable lock contents stop the acquire and are never moved, removed or retried', async t => {
  const contents: Array<[string, string | Buffer]> = [['empty', ''], ['NUL', NUL_OWNER], ['text', 'corrupt-owner'],
    ['zero', '0\n'], ['negative', '-1\n'], ['pid then NUL', Buffer.from('1234\n\0\0\0')],
    ['above the kill range', '4294967296\n'], ['above safe integers', '99999999999999999999\n']];
  for (const [label, value] of contents) await assertStopped(t, label, value);
});

test('#484: a six-byte NUL lock with a timestamp before this boot keeps the stop', async t => {
  await assertStopped(t, 'prior boot', TORN_OWNER, new Date(Date.now() - uptime() * 1000 - 3_600_000));
});

test('#484: a six-byte NUL lock with a timestamp in this boot keeps the stop', async t => {
  await assertStopped(t, 'current boot', TORN_OWNER, new Date());
});

test('unavailable ownership evidence keeps the stop and leaves the lock alone', async t => {
  // Windows: an unreadable owner may be live, so the acquire waits and then reports busy.
  const windows = await fixture(t), denied = recordedChanges(windows.path);
  await fs.writeFile(windows.path, TORN_OWNER);
  const before = await fs.stat(windows.path, {bigint: true});
  const unreadable = await compiledAcquire({...denied.context,
    process: {platform: 'win32', pid: process.pid, kill: () => assert.fail('no liveness decision without a readable owner')},
    readFile: async (path: string, encoding: BufferEncoding) => {
      if (path === windows.path) throw Object.assign(Error('synthetic read denial'), {code: 'EPERM'});
      return fs.readFile(path, encoding);
    }});
  await assert.rejects(unreadable(windows.path, undefined, 150), /connection_anchor_busy/);
  assert.ok(denied.waits() > 0);
  assert.deepEqual(denied.changes, []);
  assert.equal((await fs.stat(windows.path, {bigint: true})).ino, before.ino);
  assert.deepEqual(await fs.readFile(windows.path), TORN_OWNER);
  assert.deepEqual(await fs.readdir(windows.root), ['anchor.lock']);
  // Any platform: lock metadata that cannot be read fails at once.
  const metadata = await fixture(t), blind = recordedChanges(metadata.path);
  await fs.writeFile(metadata.path, TORN_OWNER);
  const denial = Object.assign(Error('synthetic metadata denial'), {code: 'EACCES'});
  const unlisted = await compiledAcquire({...blind.context, lstat: async (path: string, options: {bigint: true}) => {
    if (path === metadata.path) throw denial;
    return fs.lstat(path, options);
  }});
  await assert.rejects(unlisted(metadata.path, undefined, 150), error => error === denial);
  assert.deepEqual(blind.changes, []); assert.equal(blind.waits(), 0);
  assert.deepEqual(await fs.readFile(metadata.path), TORN_OWNER);
  assert.deepEqual(await fs.readdir(metadata.root), ['anchor.lock']);
});

test('a live owner in this boot is left untouched by a contender', async t => {
  const f = await fixture(t), started = resolve(f.root, 'started'), ready = resolve(f.root, 'ready');
  const finish = resolve(f.root, 'finish');
  const holder = child(holderScript, f.path, started, ready, finish);
  holder.catch(() => undefined);
  try {
    const pid = await waitFor(ready), before = await fs.stat(f.path, {bigint: true});
    await assert.rejects(acquireEnrollmentAnchorLock(f.path, undefined, 150), /connection_anchor_busy/);
    const after = await fs.stat(f.path, {bigint: true});
    assert.equal(await fs.readFile(f.path, 'utf8'), `${pid}\n`);
    assert.equal(after.ino, before.ino); assert.equal(after.dev, before.dev);
    assert.equal((await fs.readdir(f.root)).some(name => name.includes('.dead.')), false);
  } finally {await fs.writeFile(finish, 'finish');}
  await holder;
  assert.deepEqual((await fs.readdir(f.root)).sort(), ['finish', 'ready', 'started']);
});

test('contending processes on one NUL lock all keep the stop, and none becomes a holder', async t => {
  const f = await fixture(t), trace = resolve(f.root, 'trace');
  await fs.writeFile(f.path, NUL_OWNER);
  const before = await fs.stat(f.path, {bigint: true});
  const script = `import {acquireEnrollmentAnchorLock} from ${JSON.stringify(moduleUrl)};
    import {appendFile} from 'node:fs/promises';
    const [path, trace] = process.argv.slice(1);
    let release;
    try {release = await acquireEnrollmentAnchorLock(path, undefined, 2000);}
    catch (error) {await appendFile(trace, 'stop:'+error.message+'\\n'); process.exit(0);}
    await appendFile(trace, 'enter\\n');
    await release();`;
  await Promise.all(['A', 'B', 'C', 'D'].map(() => child(script, f.path, trace)));
  assert.deepEqual((await fs.readFile(trace, 'utf8')).trim().split('\n'), Array(4).fill('stop:connection_anchor_lock_invalid'));
  assert.equal((await fs.stat(f.path, {bigint: true})).ino, before.ino);
  assert.deepEqual(await fs.readFile(f.path), NUL_OWNER);
  assert.deepEqual((await fs.readdir(f.root)).sort(), ['anchor.lock', 'trace']);
});

test('a lock published by another process during an acquire is never displaced', async t => {
  const f = await fixture(t), started = resolve(f.root, 'started'), ready = resolve(f.root, 'ready');
  const finish = resolve(f.root, 'finish');
  let holder: Promise<void> | undefined, holderPid = '', holderIno = 0n;
  const recorded = recordedChanges(f.path);
  // The read-only check saw no lock. Before this acquire takes the mutex, another process takes the lock.
  const acquire = await compiledAcquire({...recorded.context, link: async (candidate: string, destination: string) => {
    if (destination === f.path + '.recovery' && !holder) {
      holder = child(holderScript, f.path, started, ready, finish);
      holder.catch(() => undefined);
      holderPid = await waitFor(ready);
      holderIno = (await fs.stat(f.path, {bigint: true})).ino;
    }
    return recorded.context.link(candidate, destination);
  }});
  try {
    await assert.rejects(acquire(f.path, undefined, 300), /connection_anchor_busy/);
    assert.ok(holder, 'the replacement ran');
    assert.equal(await fs.readFile(f.path, 'utf8'), `${holderPid}\n`);
    assert.equal((await fs.stat(f.path, {bigint: true})).ino, holderIno);
    assert.equal(recorded.changes.some(change => change.startsWith('rename') || change.startsWith('unlink')), false);
    assert.equal((await fs.readdir(f.root)).some(name => name.includes('.dead.')), false);
  } finally {await fs.writeFile(finish, 'finish');}
  // The holder asserts at release that it still held the lock throughout.
  await holder;
  assert.deepEqual((await fs.readdir(f.root)).sort(), ['finish', 'ready', 'started']);
});

test('a torn lock that appears while the mutex is held is preserved, not reclaimed', async t => {
  const f = await fixture(t), recorded = recordedChanges(f.path);
  let replaced = false, tornIno = 0n;
  const acquire = await compiledAcquire({...recorded.context, link: async (candidate: string, destination: string) => {
    if (destination === f.path && !replaced) {
      replaced = true;
      await fs.writeFile(f.path, TORN_OWNER);
      tornIno = (await fs.stat(f.path, {bigint: true})).ino;
    }
    return recorded.context.link(candidate, destination);
  }});
  await assert.rejects(acquire(f.path, undefined, 2000), /^Error: connection_anchor_lock_invalid$/);
  assert.equal(replaced, true);
  assert.equal((await fs.stat(f.path, {bigint: true})).ino, tornIno);
  assert.deepEqual(await fs.readFile(f.path), TORN_OWNER);
  assert.deepEqual(recorded.changes, [`link ${f.path}.recovery`, `link ${f.path}`]);
  assert.equal(recorded.waits(), 0);
  assert.deepEqual(await fs.readdir(f.root), ['anchor.lock']);
});

test('a contender cannot publish while the inspector holds the mutex', async t => {
  const f = await fixture(t), started = resolve(f.root, 'started'), ready = resolve(f.root, 'ready');
  // Once the mutex is free either side may win, so the contender holds only briefly.
  const finish = resolve(f.root, 'finish');
  await fs.writeFile(finish, 'finish');
  let contender: Promise<void> | undefined;
  const acquire = await compiledAcquire({link: async (candidate: string, destination: string) => {
    if (destination === f.path && !contender) {
      await fs.access(f.path + '.recovery');
      contender = child(holderScript, f.path, started, ready, finish);
      contender.catch(() => undefined);
      await waitFor(started);
      await new Promise(accept => setTimeout(accept, 300));
      await assert.rejects(fs.readFile(ready), {code: 'ENOENT'});
      await assert.rejects(fs.readFile(f.path), {code: 'ENOENT'});
    }
    return fs.link(candidate, destination);
  }});
  const release = await acquire(f.path, undefined, 5000);
  try {
    assert.ok(contender);
    await release.assertHeld();
    assert.equal(await fs.readFile(f.path, 'utf8'), `${process.pid}\n`);
  } finally {await release();}
  await contender;
  await waitFor(ready);
  assert.deepEqual((await fs.readdir(f.root)).sort(), ['finish', 'ready', 'started']);
});

test('a NUL recovery mutex is an abandoned mutex: preserved and reported, not reclaimed', async t => {
  const f = await fixture(t), recovery = f.path + '.recovery';
  await fs.writeFile(recovery, NUL_OWNER);
  const before = await fs.stat(recovery, {bigint: true});
  await assert.rejects(acquireEnrollmentAnchorLock(f.path, undefined, 100), /connection_anchor_recovery_required/);
  const after = await fs.stat(recovery, {bigint: true});
  assert.equal(after.ino, before.ino); assert.equal(after.dev, before.dev);
  assert.deepEqual(await fs.readFile(recovery), NUL_OWNER);
  assert.deepEqual(await fs.readdir(f.root), ['anchor.lock.recovery']);
});

function recordedOpen(failure?: string) {
  const flushed = new Set<string>();
  return {flushed, open: async (path: string, ...rest: [string, number]) => {
    const handle = await fs.open(path, ...rest);
    return {
      writeFile: (data: string) => handle.writeFile(data),
      sync: async () => {
        if (failure) throw Object.assign(new Error('synthetic flush failure'), {code: failure});
        await handle.sync();
        if (!(await fs.stat(path)).isDirectory()) assert.equal(await fs.readFile(path, 'utf8'), `${process.pid}\n`);
        flushed.add(path);
      },
      close: () => handle.close(),
    };
  }};
}

test('owner contents reach disk before the lock or its mutex is linked into place', async t => {
  const f = await fixture(t), recorded = recordedOpen(), published: string[] = [];
  const acquire = await compiledAcquire({open: recorded.open, link: async (candidate: string, destination: string) => {
    assert.ok(recorded.flushed.has(candidate), 'an unflushed owner must never be published');
    published.push(destination);
    return fs.link(candidate, destination);
  }});
  const release = await acquire(f.path);
  await release();
  assert.deepEqual(published, [f.path + '.recovery', f.path]);
  assert.deepEqual(await fs.readdir(f.root), []);
});

test('a failed candidate flush is a typed error, publishes nothing and leaves nothing behind', async t => {
  const f = await fixture(t), recorded = recordedOpen('EIO');
  const acquire = await compiledAcquire({open: recorded.open, link: async () => assert.fail('nothing may be linked')});
  await assert.rejects(acquire(f.path, undefined, 100), (error: Error & {cause?: {code?: string}}) =>
    error.message === 'connection_anchor_lock_flush_failed' && error.cause?.code === 'EIO');
  assert.deepEqual(await fs.readdir(f.root), []);
  // Under a host scope the code is kept, not folded into connection_anchor_lock_unavailable.
  const scope = new HostOperationFence({signal: new AbortController().signal, current: async () => true});
  await assert.rejects(acquire(f.path, scope, 100), /^Error: connection_anchor_lock_flush_failed$/);
  assert.deepEqual(await fs.readdir(f.root), []);
});

test('an interrupted candidate write publishes nothing, leaves nothing behind and does not block the next acquire', async t => {
  const f = await fixture(t);
  const interrupted = await compiledAcquire({
    open: async (path: string, ...rest: [string, number]) => {
      const handle = await fs.open(path, ...rest);
      return {
        // Part of the owner reaches the file, then the write fails.
        writeFile: async (data: string) => {
          await handle.writeFile(data.slice(0, 2));
          throw Object.assign(new Error('synthetic interrupted write'), {code: 'ENOSPC'});
        },
        sync: () => assert.fail('a partly written candidate is never flushed as an owner'),
        close: () => handle.close(),
      };
    },
    link: async () => assert.fail('a partly written candidate is never published'),
  });
  await assert.rejects(interrupted(f.path, undefined, 100), {code: 'ENOSPC'});
  assert.deepEqual(await fs.readdir(f.root), []);
  const release = await acquireEnrollmentAnchorLock(f.path, undefined, 1000);
  try {assert.equal(await fs.readFile(f.path, 'utf8'), `${process.pid}\n`);}
  finally {await release();}
});

// Records every flush and every change to the recovery mutex, in the order they happen.
function recordedLockFiles(path: string, folderFailure?: string) {
  const events: string[] = [], recovery = path + '.recovery', folder = dirname(path);
  let opened = 0;
  return {events, opened: () => opened, context: {
    open: async (name: string, ...rest: [string, number]) => {
      const handle = await fs.open(name, ...rest);
      if (name !== folder) opened++;
      return {writeFile: (data: string) => handle.writeFile(data), close: () => handle.close(),
        sync: async () => {
          if (name !== folder) {events.push('flush'); return handle.sync();}
          events.push('folder flush');
          if (folderFailure) throw Object.assign(new Error('synthetic folder flush failure'), {code: folderFailure});
          return handle.sync();
        }};
    },
    link: async (candidate: string, destination: string) => {
      await fs.link(candidate, destination);
      if (destination === recovery) events.push('mutex link');
    },
    unlink: async (name: string) => {
      await fs.unlink(name);
      if (name === recovery) events.push('mutex unlink');
    },
  }};
}

test('nothing is flushed while the recovery mutex exists', async t => {
  const clean = await fixture(t), first = recordedLockFiles(clean.path);
  await (await (await compiledAcquire(first.context))(clean.path))();
  assert.deepEqual(first.events, ['flush', 'mutex link', 'mutex unlink', ...FOLDER_FLUSH]);
  const dead = await fixture(t), retried = recordedLockFiles(dead.path);
  await fs.writeFile(dead.path, DEAD_OWNER);
  await (await (await compiledAcquire(retried.context))(dead.path, undefined, 2000))();
  assert.deepEqual(retried.events, ['flush', 'mutex link', 'mutex unlink', 'mutex link', 'mutex unlink', ...FOLDER_FLUSH]);
  const torn = await fixture(t), stopped = recordedLockFiles(torn.path);
  await fs.writeFile(torn.path, NUL_OWNER);
  await assert.rejects((await compiledAcquire(stopped.context))(torn.path, undefined, 2000), /connection_anchor_lock_invalid/);
  assert.deepEqual(stopped.events, ['flush']);
});

test('a failed lock folder flush is a typed error and gives the lock up', {skip: process.platform === 'win32'}, async t => {
  const f = await fixture(t), recorded = recordedLockFiles(f.path, 'EIO');
  await assert.rejects((await compiledAcquire(recorded.context))(f.path, undefined, 1000),
    (error: Error & {cause?: {code?: string}}) => error.message === 'connection_anchor_lock_flush_failed' && error.cause?.code === 'EIO');
  assert.deepEqual(recorded.events, ['flush', 'mutex link', 'mutex unlink', 'folder flush']);
  assert.deepEqual(await fs.readdir(f.root), []);
});

test('a waiter held off by a live owner never creates the recovery mutex', async t => {
  const f = await fixture(t), recorded = recordedLockFiles(f.path);
  await fs.writeFile(f.path, `${process.pid}
`);
  const acquire = await compiledAcquire(recorded.context);
  await assert.rejects(acquire(f.path, undefined, 200), /connection_anchor_busy/);
  assert.deepEqual(recorded.events, ['flush']);
  assert.equal(await fs.readFile(f.path, 'utf8'), `${process.pid}
`);
  assert.deepEqual(await fs.readdir(f.root), ['anchor.lock']);
});

test('a waiter takes the recovery mutex once, after the live owner releases', async t => {
  const f = await fixture(t), recorded = recordedLockFiles(f.path);
  const holder = await acquireEnrollmentAnchorLock(f.path);
  const acquire = await compiledAcquire(recorded.context);
  const waiter = acquire(f.path, undefined, 5000);
  await new Promise(accept => setTimeout(accept, 150));
  await holder();
  const release = await waiter;
  await release.assertHeld();
  await release();
  assert.deepEqual(recorded.events, ['flush', 'mutex link', 'mutex unlink', ...FOLDER_FLUSH]);
  assert.deepEqual(await fs.readdir(f.root), []);
});

test('a lock that looks dead is left alone while another process holds the mutex', async t => {
  const f = await fixture(t), recovery = f.path + '.recovery';
  await fs.writeFile(f.path, DEAD_OWNER);
  await fs.writeFile(recovery, `${process.pid}
`);
  const before = await fs.stat(f.path, {bigint: true});
  await assert.rejects(acquireEnrollmentAnchorLock(f.path, undefined, 100), /connection_anchor_busy/);
  const after = await fs.stat(f.path, {bigint: true});
  assert.equal(after.ino, before.ino); assert.equal(after.dev, before.dev);
  assert.equal(await fs.readFile(f.path, 'utf8'), DEAD_OWNER);
  assert.deepEqual((await fs.readdir(f.root)).sort(), ['anchor.lock', 'anchor.lock.recovery']);
});

test('a waiter flushes one candidate however long it retries, and removes it when it gives up', async t => {
  for (const blocked of ['', '.recovery']) {
    const f = await fixture(t), recorded = recordedLockFiles(f.path);
    await fs.writeFile(f.path + blocked, `${process.pid}\n`);
    const acquire = await compiledAcquire(recorded.context);
    await assert.rejects(acquire(f.path, undefined, 200), /connection_anchor_busy/);
    assert.equal(recorded.opened(), 1, blocked);
    assert.equal(recorded.events.filter(event => event === 'flush').length, 1, blocked);
    assert.deepEqual(await fs.readdir(f.root), ['anchor.lock' + blocked]);
  }
});
