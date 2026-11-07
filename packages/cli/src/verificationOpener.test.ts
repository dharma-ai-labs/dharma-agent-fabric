import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

// F13 C1 (2026-11-06): on WSL without wslu only xdg-open exists. It runs Chrome in the foreground,
// so the 10 s execFile timeout killed the wait and setup reported browserOpened false while Chrome ran.

type Opener = (attempts: Array<[string, string[]]>, options?: { settleMs?: number }) => Promise<boolean>;

async function opener(): Promise<Opener> {
  const modulePath: string = './verificationOpener.js';
  const loaded = await import(modulePath).catch(() => ({})) as { openWithFirstAvailableOpener?: Opener };
  assert.equal(typeof loaded.openWithFirstAvailableOpener, 'function');
  return loaded.openWithFirstAvailableOpener!;
}

const node = process.execPath;

test('an opener that keeps running in the foreground counts as opened once it has settled', async () => {
  const open = await opener();
  const started = Date.now();
  assert.equal(await open([[node, ['-e', 'setTimeout(() => {}, 30_000)']]], { settleMs: 300 }), true);
  assert.ok(Date.now() - started < 5_000, 'setup must not wait for the browser to exit');
});

test('an opener that exits non-zero inside the settle window falls through to the next one', async () => {
  const open = await opener();
  assert.equal(await open([[node, ['-e', 'process.exit(3)']]], { settleMs: 2_000 }), false);
  assert.equal(await open([[node, ['-e', 'process.exit(3)']], [node, ['-e', 'process.exit(0)']]], { settleMs: 2_000 }), true);
});

test('a missing opener is skipped without throwing', async () => {
  const open = await opener();
  assert.equal(await open([['dharma-no-such-opener-f13', ['https://example.invalid']]], { settleMs: 300 }), false);
  assert.equal(await open([['dharma-no-such-opener-f13', []], [node, ['-e', 'process.exit(0)']]], { settleMs: 300 }), true);
});

test('actual verification URL opener uses the detached opener', async () => {
  const text = await readFile(new URL('../src/index.ts', import.meta.url), 'utf8');
  const start = text.indexOf('async function openVerificationUri(');
  const body = text.slice(start, text.indexOf('export type ControlAgentCliClient', start));
  assert.match(body, /return openWithFirstAvailableOpener\(attempts\);/);
  assert.doesNotMatch(body, /execFileAsync\(command, argv, \{ timeout: 10_000 \}\)/);
});
