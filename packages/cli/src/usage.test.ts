import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { run } from './index.js';
import { CLI_USAGE } from './usage.js';

test('help preserves named-session, signing and transport recovery command surfaces together', async () => {
  const help = await run(['--help']);
  assert.equal(help, CLI_USAGE);
  for (const command of ['sessions start', 'sessions status', 'sessions work', 'sessions stop',
    'demo signing-client-proof', 'demo signing-owner-proof', 'demo transport-connect', 'repositories source-resolve']) {
    assert.ok(CLI_USAGE.includes(command), `Missing command: ${command}`);
  }
});

test('source resolution dispatch rejects duplicate flags, extra positionals and valued switches before device access', async () => {
  for (const args of [
    ['repositories', 'source-resolve', 'extra'],
    ['repositories', 'source-resolve', '--prepare', '--prepare'],
    ['repositories', 'source-resolve', '--workspace-id', 'fixture', '--prepare=true'],
    ['repositories', 'source-resolve', '--workspace-id', 'fixture', '--unknown'],
  ]) await assert.rejects(run(args), /repository_source_resolution_option_invalid/);
});

test('runtime release identity matches the installed CLI package', async () => {
  const metadata = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.deepEqual(await run(['--version']), { version: metadata.version });
});
