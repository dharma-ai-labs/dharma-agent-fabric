import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { createWindowsFreshReader } from './windowsFreshRead.js';

async function fixture(t: TestContext, idleMs = 30_000) {
  const root = await mkdtemp(join(tmpdir(), 'dharma-read-broker-'));
  const counter = join(root, 'starts');
  const program = `
    require('node:fs').appendFileSync(${JSON.stringify(counter)}, 'x');
    require('node:readline').createInterface({input: process.stdin}).on('line', line => {
      const request = JSON.parse(line);
      if (request.account === 'stall') return;
      if (request.account === 'crash') process.exit(9);
      if (request.account === 'oversized') { process.stdout.write('x'.repeat(1_048_577)); return; }
      if (request.account === 'malformed') { process.stdout.write('not-json\\n'); return; }
      if (request.account === 'null-success') {
        process.stdout.write(JSON.stringify({id: request.id, status: 0, value: null}) + '\\n'); return;
      }
      const status = request.account === 'missing' ? 3 : 0;
      const id = request.account === 'forged' ? request.id + 1 : request.id;
      process.stdout.write(JSON.stringify({id, status, value: status === 3 ? null : request.account}) + '\\n');
    });
  `;
  const reader = createWindowsFreshReader({ command: process.execPath,
    prefixArgs: ['-e', program, '--'], timeoutMs: 2_500, retryAttempts: 1, idleMs });
  t.after(() => { reader.close(); return rm(root, { recursive: true, force: true }); });
  return { reader, starts: () => readFile(counter, 'utf8') };
}

test('fresh-reader serializes concurrent replies and preserves missing credentials', async (t) => {
  const f = await fixture(t);
  const accounts = Array.from({ length: 12 }, (_, i) => `account-${i}`);
  assert.deepEqual(await Promise.all(accounts.map(account => f.reader.read(account))), accounts);
  assert.equal(await f.reader.read('missing'), null);
  assert.equal(await f.starts(), 'x');
});

test('fresh-reader rejects unsafe accounts before starting any helper', async (t) => {
  const f = await fixture(t);
  await assert.rejects(f.reader.read('bad\naccount'), /Invalid secure-store account/);
  await assert.rejects(f.starts(), { code: 'ENOENT' });
});

test('fresh-reader times out closed and permits a later fresh recovery', async (t) => {
  const f = await fixture(t);
  await assert.rejects(f.reader.read('stall'), { code: 'read_timeout' });
  assert.equal(await f.reader.read('recovered'), 'recovered');
  assert.equal(await f.starts(), 'xx');
});

test('fresh-reader never treats a terminated helper as a missing credential', async (t) => {
  const f = await fixture(t);
  await assert.rejects(f.reader.read('crash'), { code: 'read_helper_exited' });
  assert.equal(await f.reader.read('recovered'), 'recovered');
});

test('fresh-reader rejects uncorrelated and oversized responses without exposing values', async (t) => {
  const f = await fixture(t);
  await assert.rejects(f.reader.read('forged'), { code: 'read_response_invalid' });
  await assert.rejects(f.reader.read('oversized'), { code: 'read_response_too_large' });
  assert.equal(await f.reader.read('recovered'), 'recovered');
});

test('fresh-reader retires only its idle helper and reopens on demand', async (t) => {
  const f = await fixture(t, 10);
  assert.equal(await f.reader.read('first'), 'first');
  await new Promise((accept) => setTimeout(accept, 80));
  assert.equal(await f.reader.read('second'), 'second');
  assert.equal(await f.starts(), 'xx');
});

test('fresh-reader rejects malformed JSON and an unexplained null success', async (t) => {
  const f = await fixture(t);
  await assert.rejects(f.reader.read('malformed'), { code: 'read_response_invalid' });
  await assert.rejects(f.reader.read('null-success'), { code: 'read_response_invalid' });
  assert.equal(await f.reader.read('recovered'), 'recovered');
});
