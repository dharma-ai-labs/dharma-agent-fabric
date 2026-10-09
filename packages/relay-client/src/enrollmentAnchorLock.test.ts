import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp, readFile, readdir, rename, rm, writeFile} from 'node:fs/promises';
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
