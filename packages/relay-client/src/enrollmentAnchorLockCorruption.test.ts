import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import * as fs from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname, resolve} from 'node:path';
import test from 'node:test';
import {fileURLToPath} from 'node:url';
import {runInNewContext} from 'node:vm';
import ts from 'typescript';
import {acquireEnrollmentAnchorLock} from './enrollmentAnchorLock.js';

const moduleUrl = new URL('./enrollmentAnchorLock.js', import.meta.url).href;
// The G11 hard reset left exactly this on disk: five NUL bytes.
const NUL_OWNER = Buffer.alloc(5);

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

test('a lock whose contents cannot be an owner is quarantined and then acquired', async t => {
  const contents: Array<[string, string | Buffer]> = [['NUL', NUL_OWNER], ['empty', ''], ['text', 'corrupt-owner'],
    ['zero', '0\n'], ['negative', '-1\n'], ['pid then NUL', Buffer.from('1234\n\0\0\0')],
    ['above the kill range', '4294967296\n'], ['above safe integers', '99999999999999999999\n']];
  for (const [label, value] of contents) {
    const f = await fixture(t);
    await fs.writeFile(f.path, value);
    const release = await acquireEnrollmentAnchorLock(f.path, undefined, 2000);
    try {
      await release.assertHeld();
      assert.equal(await fs.readFile(f.path, 'utf8'), `${process.pid}\n`, label);
      assert.deepEqual(await fs.readdir(f.root), ['anchor.lock'], label);
    } finally {await release();}
    assert.deepEqual(await fs.readdir(f.root), [], label);
  }
});

test('a live owner on a recovered lock is never evicted by a contender', async t => {
  const f = await fixture(t), started = resolve(f.root, 'started'), ready = resolve(f.root, 'ready');
  const finish = resolve(f.root, 'finish');
  await fs.writeFile(f.path, NUL_OWNER);
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

test('contending processes on one NUL lock each own it alone', async t => {
  const f = await fixture(t), trace = resolve(f.root, 'trace');
  await fs.writeFile(f.path, NUL_OWNER);
  const script = `import {acquireEnrollmentAnchorLock} from ${JSON.stringify(moduleUrl)};
    import {appendFile} from 'node:fs/promises';
    const [path, trace, label] = process.argv.slice(1);
    const release = await acquireEnrollmentAnchorLock(path);
    try {
      await appendFile(trace, 'enter:'+label+'\\n');
      await new Promise(resolve => setTimeout(resolve, 50));
      await release.assertHeld();
      await appendFile(trace, 'leave:'+label+'\\n');
    } finally {await release();}`;
  await Promise.all(['A', 'B', 'C', 'D'].map(label => child(script, f.path, trace, label)));
  const lines = (await fs.readFile(trace, 'utf8')).trim().split('\n');
  assert.equal(lines.length, 8);
  for (let index = 0; index < lines.length; index += 2) {
    assert.match(lines[index]!, /^enter:/);
    assert.equal(lines[index + 1], lines[index]!.replace('enter:', 'leave:'));
  }
  assert.deepEqual(await fs.readdir(f.root), ['trace']);
});

test('a contender cannot publish while the inspector holds the mutex over a NUL lock', async t => {
  const f = await fixture(t), started = resolve(f.root, 'started'), ready = resolve(f.root, 'ready');
  // Once the mutex is free either side may win, so the contender holds only briefly.
  const finish = resolve(f.root, 'finish');
  await fs.writeFile(finish, 'finish');
  await fs.writeFile(f.path, NUL_OWNER);
  let contender: Promise<void> | undefined, inspected = false;
  const acquire = await compiledAcquire({readFile: async (path: string, encoding: BufferEncoding) => {
    const text = await fs.readFile(path, encoding);
    // Only the read under the mutex is paused. The read-only check before it holds nothing.
    const held = await fs.access(f.path + '.recovery').then(() => true, () => false);
    if (path === f.path && !inspected && held) {
      inspected = true;
      contender = child(holderScript, f.path, started, ready, finish);
      contender.catch(() => undefined);
      await waitFor(started);
      await new Promise(accept => setTimeout(accept, 300));
      await assert.rejects(fs.readFile(ready), {code: 'ENOENT'});
      assert.deepEqual(await fs.readFile(f.path), NUL_OWNER);
      await fs.access(f.path + '.recovery');
    }
    return text;
  }});
  const release = await acquire(f.path, undefined, 5000);
  try {
    assert.equal(inspected, true);
    await release.assertHeld();
    assert.equal(await fs.readFile(f.path, 'utf8'), `${process.pid}\n`);
  } finally {await release();}
  await contender;
  await waitFor(ready);
  assert.deepEqual((await fs.readdir(f.root)).sort(), ['finish', 'ready', 'started']);
});

test('a NUL recovery mutex is an abandoned mutex: preserved and reported, not reclaimed', async t => {
  const f = await fixture(t), recovery = f.path + '.recovery';
  await fs.writeFile(f.path, NUL_OWNER);
  await fs.writeFile(recovery, NUL_OWNER);
  const before = await fs.stat(recovery, {bigint: true});
  await assert.rejects(acquireEnrollmentAnchorLock(f.path, undefined, 100), /connection_anchor_recovery_required/);
  const after = await fs.stat(recovery, {bigint: true});
  assert.equal(after.ino, before.ino); assert.equal(after.dev, before.dev);
  assert.deepEqual(await fs.readFile(recovery), NUL_OWNER);
  assert.deepEqual(await fs.readFile(f.path), NUL_OWNER);
  assert.deepEqual((await fs.readdir(f.root)).sort(), ['anchor.lock', 'anchor.lock.recovery']);
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
        assert.equal(await fs.readFile(path, 'utf8'), `${process.pid}\n`);
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

test('a failed flush publishes nothing', async t => {
  const f = await fixture(t), recorded = recordedOpen('EIO');
  const acquire = await compiledAcquire({open: recorded.open, link: async () => assert.fail('nothing may be linked')});
  await assert.rejects(acquire(f.path, undefined, 100), {code: 'EIO'});
  assert.deepEqual((await fs.readdir(f.root)).filter(name => !name.endsWith('.candidate')), []);
});

// Records every flush and every change to the recovery mutex, in the order they happen.
function recordedLockFiles(path: string) {
  const events: string[] = [], recovery = path + '.recovery';
  let opened = 0;
  return {events, opened: () => opened, context: {
    open: async (name: string, ...rest: [string, number]) => {
      const handle = await fs.open(name, ...rest);
      opened++;
      return {writeFile: (data: string) => handle.writeFile(data), close: () => handle.close(),
        sync: async () => {events.push('flush'); await handle.sync();}};
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
  assert.deepEqual(first.events, ['flush', 'mutex link', 'mutex unlink']);
  const dead = await fixture(t), retried = recordedLockFiles(dead.path);
  await fs.writeFile(dead.path, NUL_OWNER);
  await (await (await compiledAcquire(retried.context))(dead.path, undefined, 2000))();
  assert.deepEqual(retried.events, ['flush', 'mutex link', 'mutex unlink', 'mutex link', 'mutex unlink']);
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
  assert.deepEqual(recorded.events, ['flush', 'mutex link', 'mutex unlink']);
  assert.deepEqual(await fs.readdir(f.root), []);
});

test('a lock that looks dead is left alone while another process holds the mutex', async t => {
  const f = await fixture(t), recovery = f.path + '.recovery';
  await fs.writeFile(f.path, NUL_OWNER);
  await fs.writeFile(recovery, `${process.pid}
`);
  const before = await fs.stat(f.path, {bigint: true});
  await assert.rejects(acquireEnrollmentAnchorLock(f.path, undefined, 100), /connection_anchor_busy/);
  const after = await fs.stat(f.path, {bigint: true});
  assert.equal(after.ino, before.ino); assert.equal(after.dev, before.dev);
  assert.deepEqual(await fs.readFile(f.path), NUL_OWNER);
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
