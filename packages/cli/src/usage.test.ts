import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { run } from './index.js';
import { CLI_USAGE } from './usage.js';

test('help preserves named-session, signing and transport recovery command surfaces together', async () => {
  const help = await run(['--help']);
  assert.equal(help, CLI_USAGE);
  for (const command of ['sessions start', 'sessions status', 'sessions work', 'sessions stop',
    'demo signing-client-proof', 'demo signing-owner-proof', 'demo transport-connect']) {
    assert.ok(CLI_USAGE.includes(command), `Missing command: ${command}`);
  }
});

test('runtime release identity matches the installed CLI package', async () => {
  const metadata = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.deepEqual(await run(['--version']), { version: metadata.version });
});
