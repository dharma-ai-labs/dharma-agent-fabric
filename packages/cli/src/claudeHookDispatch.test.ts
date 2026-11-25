import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { formatCommandOutput, run } from './index.js';
import { readClaudeSessionStart } from './sessionNames.js';

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

// The SessionStart hook runs at every session start, often beside other plugins' hooks; the official bin answers
// `hook claude session-start` without loading the whole CLI, and a recorded session clears an earlier failure note.
test('dharma hook claude session-start through the official bin records the session and clears its failure note', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dharma-hook-bin-'));
  try {
    const sessionId = randomUUID();
    const note = join(home, 'session-messages', 'claude-session-start-failures', `${sessionId}.json`);
    await mkdir(dirname(note), { recursive: true });
    await writeFile(note, JSON.stringify({ schema: 'dharma.claude-session-start-failure/v1', sessionId, cwd: home,
      at: '2026-11-10T09:00:00.000Z', state: 'pending', reason: 'did_not_finish', recovery: '' }));
    const env = { ...process.env, DHARMA_HOME: home };
    delete env.CLAUDE_ENV_FILE;
    delete env.DHARMA_CLAUDE_SESSION_ID;
    const result = spawnSync(process.execPath, [fileURLToPath(new URL('./bin.js', import.meta.url)), 'hook', 'claude', 'session-start'],
      { encoding: 'utf8', input: JSON.stringify({ session_id: sessionId, cwd: home, hook_event_name: 'SessionStart' }), env,
        timeout: 30_000, windowsHide: true });
    assert.deepEqual([result.status, result.stdout], [0, ''], result.stderr);
    assert.equal((await readClaudeSessionStart(home, sessionId))?.cwd, home);
    await assert.rejects(stat(note), /ENOENT/, 'the failure note is gone once the session is recorded');
  } finally { await rm(home, { recursive: true, force: true }); }
});
