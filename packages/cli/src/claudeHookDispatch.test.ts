import assert from 'node:assert/strict';
import test from 'node:test';
import { formatCommandOutput, run } from './index.js';

test('hook claude dispatch refuses unknown actions before reading stdin; an empty hook result prints nothing', async () => {
  await assert.rejects(run(['hook', 'claude', 'stop']), /claude_hook_command_invalid/);
  await assert.rejects(run(['hook', 'codex', 'inbox']), /claude_hook_command_invalid/);
  assert.equal(formatCommandOutput(''), '');
});
