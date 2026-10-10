import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile} from 'node:fs/promises';
import * as fs from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {runInNewContext} from 'node:vm';
import ts from 'typescript';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';
import test from 'node:test';
import {acquireEnrollmentAnchorLock} from './enrollmentAnchorLock.js';
import {HostOperationFence} from './hostOperationScope.js';

async function fixture() {
  const root = await mkdtemp(resolve(tmpdir(), 'fabric-anchor-lock-'));
  return {root, path: resolve(root, 'anchor.lock'), cleanup: () => rm(root, {recursive: true, force: true})};
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
const moduleUrl = new URL('./enrollmentAnchorLock.js', import.meta.url).href;

test('anchor lock excludes independent processes and releases only its own inode', async () => {
  const f = await fixture(), trace = resolve(f.root, 'trace');
  try {
    const script = `import {acquireEnrollmentAnchorLock} from ${JSON.stringify(moduleUrl)};
      import {appendFile} from 'node:fs/promises';
      const [path, trace, label] = process.argv.slice(1);
      const release = await acquireEnrollmentAnchorLock(path);
      try {
        await appendFile(trace, 'enter:'+label+'\\n');
        await new Promise(resolve => setTimeout(resolve, 100));
        await appendFile(trace, 'leave:'+label+'\\n');
      } finally {await release();}`;
    await Promise.all([child(script, f.path, trace, 'A'), child(script, f.path, trace, 'B')]);
    const lines = (await readFile(trace, 'utf8')).trim().split('\n');
    assert.equal(lines.length, 4);
    assert.equal(lines[1], lines[0]!.replace('enter:', 'leave:'));
    assert.equal(lines[3], lines[2]!.replace('enter:', 'leave:'));
    assert.notEqual(lines[0], lines[2]);
    assert.deepEqual(await readdir(f.root), ['trace']);
  } finally {await f.cleanup();}
});

test('anchor lock recovers a dead process without treating corrupt metadata as absence', async () => {
  const f = await fixture();
  try {
    await child(`import {acquireEnrollmentAnchorLock} from ${JSON.stringify(moduleUrl)};
      await acquireEnrollmentAnchorLock(process.argv[1]);`, f.path);
    const release = await acquireEnrollmentAnchorLock(f.path);
    await release();
    assert.deepEqual(await readdir(f.root), []);
    await writeFile(f.path, 'corrupt-owner');
    await assert.rejects(acquireEnrollmentAnchorLock(f.path, undefined, 100), /connection_anchor_lock_invalid/);
    assert.equal(await readFile(f.path, 'utf8'), 'corrupt-owner');
    assert.deepEqual(await readdir(f.root), ['anchor.lock']);
  } finally {await f.cleanup();}
});

test('anchor lock refuses live-owner contention and preserves its state', async () => {
  const f = await fixture();
  try {
    const release = await acquireEnrollmentAnchorLock(f.path);
    await assert.rejects(acquireEnrollmentAnchorLock(f.path, undefined, 80), /connection_anchor_busy/);
    assert.equal(await readFile(f.path, 'utf8'), `${process.pid}\n`);
    await Promise.all([release(), release()]);
    assert.deepEqual(await readdir(f.root), []);
  } finally {await f.cleanup();}
});

test('anchor lock cleanup preserves a replacement inode after host scope withdrawal', async () => {
  const f = await fixture(), controller = new AbortController();
  const fence = new HostOperationFence({signal: controller.signal, current: async () => true});
  try {
    const release = await acquireEnrollmentAnchorLock(f.path, fence);
    await rename(f.path, resolve(f.root, 'original'));
    await writeFile(f.path, 'foreign-owner');
    controller.abort();
    await assert.rejects(release(), /connection_anchor_lock_cleanup_unconfirmed/);
    assert.equal(await readFile(f.path, 'utf8'), 'foreign-owner');
  } finally {await f.cleanup();}
});

test('anchor lock checks a withdrawn host before filesystem admission', async () => {
  const f = await fixture(), controller = new AbortController();
  controller.abort();
  try {
    await assert.rejects(acquireEnrollmentAnchorLock(f.path,
      new HostOperationFence({signal: controller.signal, current: async () => true})), /relay_host_scope_unavailable/);
    assert.deepEqual(await readdir(f.root), []);
  } finally {await f.cleanup();}
});

test('actual anchor restoration preserves bytes across concurrent processes with different homes', async () => {
  const f = await fixture(), state = resolve(f.root, 'protected-synthetic.json'), trace = resolve(f.root, 'writes');
  const indexUrl = new URL('./index.js', import.meta.url).href;
  const config = {schema: 'dharma.device-config/v1', hqUrl: 'https://process-race.example',
    organizationId: 'org_' + f.root.split(/[\\/]/).at(-1), deviceId: '55555555-5555-4555-8555-555555555555',
    deviceName: 'Synthetic', platform: 'linux', serverPublicKeyEd25519: 'B'.repeat(43),
    relayUrl: 'wss://relay.example', enrolledAt: '2026-10-01T00:00:00.000Z'};
  try {
    const script = `import {saveDeviceEnrollmentAnchor} from ${JSON.stringify(indexUrl)};
      import {readFile, writeFile, appendFile} from 'node:fs/promises';
      import {resolve} from 'node:path';
      const [root, state, trace, label] = process.argv.slice(1);
      process.env.DHARMA_HOME = resolve(root, label+'-home');
      process.env.HOME = process.env.DHARMA_HOME;
      process.env.USERPROFILE = process.env.DHARMA_HOME;
      process.env.TMPDIR = resolve(root, label+'-temp');
      const config = ${JSON.stringify(config)};
      config.publicKeyEd25519 = label.repeat(43);
      const get = async account => {
        try {return JSON.parse(await readFile(state, 'utf8'))[account] ?? null;}
        catch(error) {if(error.code === 'ENOENT') return null; throw error;}
      };
      const store = {backend:'linux-secret-service', get, getFresh:get,
        put:async(account, value) => {
          await new Promise(resolve => setTimeout(resolve, 80));
          await writeFile(state, JSON.stringify({[account]:value}));
          await appendFile(trace, value+'\\n');
        }, delete:async() => {throw Error('unexpected delete');}};
      await writeFile(resolve(root,label+'.ready'), 'ready');
      const deadline = Date.now()+10000;
      while(true) {
        try {await readFile(resolve(root,'start')); break;}
        catch(error) {if(error.code !== 'ENOENT' || Date.now()>deadline) throw error;}
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      try {await saveDeviceEnrollmentAnchor({config,store,requireAbsent:true});}
      catch(error) {if(error.message !== 'connection_existing_anchor_requires_recovery') throw error;}`;
    const operations = [child(script, f.root, state, trace, 'A'), child(script, f.root, state, trace, 'C')];
    const deadline = Date.now() + 10000;
    while (!(await readdir(f.root)).includes('A.ready') || !(await readdir(f.root)).includes('C.ready')) {
      if (Date.now() > deadline) throw Error('child readiness timeout');
      await new Promise(resolvePromise => setTimeout(resolvePromise, 10));
    }
    await writeFile(resolve(f.root, 'start'), 'start');
    await Promise.all(operations);
    const writes = (await readFile(trace, 'utf8')).trim().split('\n');
    assert.equal(writes.length, 1);
    assert.equal(Object.values(JSON.parse(await readFile(state, 'utf8')))[0], writes[0]);
  } finally {await f.cleanup();}
});

test('abandoned or invalid recovery ownership preserves the mutex and primary lock', async () => {
  for (const kind of ['file', 'directory'] as const) {
    const f = await fixture(), recovery = f.path + '.recovery';
    try {
      await writeFile(f.path, '2147483647\n');
      if (kind === 'directory') await mkdir(recovery);
      const ownerPath = kind === 'file' ? recovery : resolve(recovery, 'owner');
      await writeFile(ownerPath, '2147483647\n');
      const before = await stat(recovery, {bigint: true});
      await assert.rejects(acquireEnrollmentAnchorLock(f.path, undefined, 100),
        kind === 'file' ? /connection_anchor_recovery_required/ : /connection_anchor_lock_invalid/);
      assert.equal(await readFile(f.path, 'utf8'), '2147483647\n');
      assert.equal(await readFile(ownerPath, 'utf8'), '2147483647\n');
      const after = await stat(recovery, {bigint: true});
      assert.equal(after.ino, before.ino);
      assert.equal(after.dev, before.dev);
      assert.deepEqual((await readdir(f.root)).sort(), ['anchor.lock', 'anchor.lock.recovery']);
    } finally {await f.cleanup();}
  }
});

test('a replacement process cannot publish during stale primary inspection and retains live ownership', async () => {
  const f = await fixture(), releaseOld = resolve(f.root, 'release-old'), releaseNew = resolve(f.root, 'release-new');
  const readyOld = resolve(f.root, 'old-ready'), readyNew = resolve(f.root, 'new-ready');
  const script = `import {acquireEnrollmentAnchorLock} from ${JSON.stringify(moduleUrl)};
    import {readFile,writeFile} from 'node:fs/promises';
    const [path,ready,releasePath]=process.argv.slice(1);
    const release=await acquireEnrollmentAnchorLock(path);
    await writeFile(ready,String(process.pid));
    const deadline=Date.now()+10000;
    try {
      while(true) {
        try {await readFile(releasePath);break;}
        catch(error) {if(error.code!=='ENOENT'||Date.now()>deadline)throw error;}
        await new Promise(resolve=>setTimeout(resolve,10));
      }
    } finally {await release();}`;
  const waitReady = async (path: string) => {
    const deadline = Date.now() + 10000;
    for (;;) {
      try {return await readFile(path, 'utf8');}
      catch (error) {if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || Date.now() > deadline) throw error;}
      await new Promise(resolvePromise => setTimeout(resolvePromise, 10));
    }
  };
  const oldOwner = child(script, f.path, readyOld, releaseOld);
  let newOwner: Promise<void> | undefined, interleaved = false;
  let releaseInspector: (() => Promise<void>) | undefined;
  try {
    await waitReady(readyOld);
    const source = await readFile(fileURLToPath(new URL('../src/enrollmentAnchorLock.ts', import.meta.url)), 'utf8');
    const ast = ts.createSourceFile('lock.ts', source, ts.ScriptTarget.Latest, true);
    const node = ast.statements.find(value => ts.isFunctionDeclaration(value) && value.name?.text === 'acquireEnrollmentAnchorLock')!;
    const compiled = ts.transpileModule(node.getText(ast).replace('export async', 'async'), {
      compilerOptions: {target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.None},
    }).outputText;
    // Control the stale read and the inspector's next retry, so the replacement
    // gets the next turn after mutex release. Both children run the real helper;
    // the preservation assertion below remains at the held-mutex boundary.
    const acquire = runInNewContext(compiled + '\nacquireEnrollmentAnchorLock', {...fs, dirname, randomUUID,
      process, Date, setTimeout: (callback: () => void, delay: number) => {
        if (interleaved && delay === 25) {void waitReady(readyNew).then(callback); return;}
        return setTimeout(callback, delay);
      }, readFile: async (path: string, encoding: string) => {
        const text = await readFile(path, encoding as BufferEncoding);
        if (path === f.path && !interleaved) {
          interleaved = true;
          await writeFile(releaseOld, 'release'); await oldOwner;
          newOwner = child(script, f.path, readyNew, releaseNew);
          newOwner.catch(() => undefined);
          await new Promise(resolvePromise => setTimeout(resolvePromise, 500));
          await assert.rejects(readFile(readyNew), {code: 'ENOENT'},
            'a replacement must wait while the stale inspector owns the recovery mutex');
        }
        return text;
      }}) as typeof acquireEnrollmentAnchorLock;
    await assert.rejects(async () => {releaseInspector = await acquire(f.path, undefined, 1500);}, /connection_anchor_busy/);
    const replacementPid = await waitReady(readyNew);
    assert.equal(await readFile(f.path, 'utf8'), replacementPid + '\n');
    assert.equal(interleaved, true);
    assert.equal((await readdir(f.root)).some(path => path.includes('.dead.')), false);
  } finally {
    await releaseInspector?.();
    await writeFile(releaseOld, 'release'); await oldOwner;
    if (newOwner) {await writeFile(releaseNew, 'release'); await newOwner;}
    await f.cleanup();
  }
});
