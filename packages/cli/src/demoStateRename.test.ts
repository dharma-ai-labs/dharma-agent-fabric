import assert from 'node:assert/strict';
import { mkdtemp, readFile, rename, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test from 'node:test';
import { renameDemoStateFile } from './demoStateRename.js';

const denied = (code: string) => Object.assign(new Error('state rename denied'), { code });

for (const code of ['EPERM', 'EACCES', 'EBUSY']) {
  test(`Windows ${code} retries the same prepared file without deleting current state`, async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'dharma-demo-state-'));
    const source = resolve(root, 'prepared.tmp'), destination = resolve(root, 'device.json');
    await writeFile(source, 'new verified state');
    await writeFile(destination, 'prior verified state');
    let attempts = 0;
    const delays: number[] = [];
    await renameDemoStateFile(source, destination, { platform: 'win32',
      sleep: async delay => { delays.push(delay); },
      rename: async (from, to) => {
        assert.equal(from, source);
        assert.equal(to, destination);
        assert.equal(await readFile(source, 'utf8'), 'new verified state');
        assert.equal(await readFile(destination, 'utf8'), 'prior verified state');
        if (++attempts < 3) throw denied(code);
        await rename(from, to);
      } });
    assert.equal(attempts, 3);
    assert.deepEqual(delays, [25, 50]);
    assert.equal(await readFile(destination, 'utf8'), 'new verified state');
    await assert.rejects(readFile(source), { code: 'ENOENT' });
  });
}

test('persistent Windows denial preserves both files and throws the original bounded failure', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'dharma-demo-state-'));
  const source = resolve(root, 'prepared.tmp'), destination = resolve(root, 'device.json');
  await writeFile(source, 'new verified state');
  await writeFile(destination, 'prior verified state');
  const error = denied('EPERM');
  let attempts = 0;
  const delays: number[] = [];
  await assert.rejects(renameDemoStateFile(source, destination, { platform: 'win32',
    sleep: async delay => { delays.push(delay); },
    rename: async () => { attempts++; throw error; } }), failure => failure === error);
  assert.equal(attempts, 6);
  assert.deepEqual(delays, [25, 50, 100, 200, 400]);
  assert.equal(await readFile(source, 'utf8'), 'new verified state');
  assert.equal(await readFile(destination, 'utf8'), 'prior verified state');
});

for (const [platform, code] of [['linux', 'EPERM'], ['darwin', 'EACCES'], ['win32', 'EIO']] as const) {
  test(`${platform} ${code} fails immediately without retry or permission changes`, async () => {
    let attempts = 0, sleeps = 0;
    const error = denied(code);
    await assert.rejects(renameDemoStateFile('prepared.tmp', 'device.json', { platform,
      sleep: async () => { sleeps++; }, rename: async () => { attempts++; throw error; } }),
    failure => failure === error);
    assert.equal(attempts, 1);
    assert.equal(sleeps, 0);
  });
}

test('a stopped wait does not retry the prepared state or overwrite the destination', async () => {
  const stopped = new Error('retry wait stopped');
  let attempts = 0;
  await assert.rejects(renameDemoStateFile('prepared.tmp', 'device.json', { platform: 'win32',
    sleep: async () => { throw stopped; },
    rename: async () => { attempts++; throw denied('EBUSY'); } }), failure => failure === stopped);
  assert.equal(attempts, 1);
});
