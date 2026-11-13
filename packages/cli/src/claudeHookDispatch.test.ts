import assert from 'node:assert/strict';
import test from 'node:test';
import { formatCommandOutput, run } from './index.js';

test('hook claude dispatch refuses unknown actions before reading stdin; an empty hook result prints nothing', async () => {
  await assert.rejects(run(['hook', 'claude', 'stop']), /claude_hook_command_invalid/);
  await assert.rejects(run(['hook', 'codex', 'inbox']), /claude_hook_command_invalid/);
  assert.equal(formatCommandOutput(''), '');
});

test('hook claude session-start and inbox accept --dry-run and return a plan without effects (AGENTS.md rule 8, R3)', async () => {
  const pick = (value: unknown, keys: string[]) =>
    Object.fromEntries(keys.map(key => [key, (value as Record<string, unknown>)[key]]));
  for (const action of ['session-start', 'inbox']) {
    assert.deepEqual(pick(await run(['hook', 'claude', action, '--dry-run']), ['ok', 'stage', 'effects', 'action']),
      { ok: true, stage: 'plan', effects: false, action });
  }
  await assert.rejects(run(['hook', 'claude', 'inbox', '--yes']), /claude_hook_command_invalid/, 'other flags stay refused');
});
