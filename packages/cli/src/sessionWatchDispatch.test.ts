import assert from 'node:assert/strict';
import test from 'node:test';
import { run } from './index.js';
import { CLI_USAGE } from './usage.js';

test('sessions watch is delivery-only: it skips the Linux and workspace gates and checks its own options first', async () => {
  await assert.rejects(run(['sessions', 'watch', '--provider', 'claude', '--allow-wake']), /session_watch_options_invalid/);
  await assert.rejects(run(['sessions', 'watch', '--provider', 'codex']), /session_watch_wake_consent_required/);
  assert.ok(CLI_USAGE.includes('sessions watch'));
});
