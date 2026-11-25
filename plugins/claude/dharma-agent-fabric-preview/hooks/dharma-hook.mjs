// Runs `dharma hook claude <action>` for the 1.0.7-preview hooks with no shell syntax in the hook command, so the
// same command works under sh, Git Bash, Windows PowerShell 5.1 and pwsh. The hook JSON on stdin goes to the CLI.
// Always exits 0, so a hook never blocks a session or a prompt. The CLI's stderr is never shown.
// - inbox: a missing CLI, an older CLI without `hook claude`, or any failure prints nothing. Only the inbox output
//   is forwarded, and only when the CLI exited 0.
// - session-start: before the CLI runs, a pending note goes under
//   DHARMA_HOME/session-messages/claude-session-start-failures/<session id>.json, so a hook that Claude Code kills
//   at its timeout still leaves a trace. When the CLI recorded the session, the note is removed and nothing is
//   printed. Otherwise the note says why, and a systemMessage tells the user, with the one-line recovery that
//   `dharma sessions attach` also prints.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const action = process.argv[2];
const done = () => process.exit(0);
/** Under the 30 s SessionStart timeout in hooks.json, so the launcher reports a stalled CLI itself. */
const SESSION_START_DEADLINE_MS = 25_000;
const SESSION_ID = /^[A-Za-z0-9_-]{1,128}$/;
const MAX_STDIN = 1_048_576;

/** Runs the CLI with `input` on its stdin (or this process's stdin piped through when `input` is null). */
function runCli(input, deadlineMs) {
  return new Promise(settle => {
    let child;
    try {
      // shell on Windows so dharma.cmd resolves; the arguments are fixed strings.
      child = spawn('dharma', ['hook', 'claude', action],
        { stdio: ['pipe', 'pipe', 'ignore'], shell: process.platform === 'win32', windowsHide: true });
    } catch {
      settle({ unavailable: true });
      return;
    }
    const output = [];
    const timer = deadlineMs ? setTimeout(() => { child.kill(); settle({ timedOut: true }); }, deadlineMs) : undefined;
    child.on('error', () => { clearTimeout(timer); settle({ unavailable: true }); });
    child.stdout.on('data', chunk => output.push(chunk));
    child.stdin.on('error', () => {});
    if (input === null) {
      process.stdin.on('error', () => {});
      process.stdin.pipe(child.stdin);
    } else child.stdin.end(input);
    child.on('close', code => { clearTimeout(timer); settle({ code, output: Buffer.concat(output) }); });
  });
}

/** The whole hook JSON, bounded in size and time. */
function readStdin() {
  return new Promise(settle => {
    const chunks = [];
    let size = 0;
    const finish = () => { clearTimeout(timer); settle(size > MAX_STDIN ? '' : Buffer.concat(chunks).toString('utf8')); };
    const timer = setTimeout(finish, 2_000);
    process.stdin.on('data', chunk => { chunks.push(chunk); size += chunk.length; if (size > MAX_STDIN) finish(); });
    process.stdin.once('end', finish);
    process.stdin.once('error', finish);
  });
}

function sessionOf(raw) {
  try {
    const value = JSON.parse(raw);
    if (value && typeof value === 'object' && typeof value.session_id === 'string' && SESSION_ID.test(value.session_id)
      && typeof value.cwd === 'string' && value.cwd) return { sessionId: value.session_id, cwd: value.cwd };
  } catch { /* not hook JSON */ }
  return null;
}

async function sessionStart() {
  const raw = await readStdin();
  const session = sessionOf(raw);
  // Without a session id there is nothing to record or check; the CLI ignores such input too.
  if (!session) { await runCli(raw); return done(); }
  const sessions = join(resolve(process.env.DHARMA_HOME || join(homedir(), '.dharma')), 'session-messages');
  const notePath = join(sessions, 'claude-session-start-failures', `${session.sessionId}.json`);
  const recovery = `echo '${JSON.stringify({ session_id: session.sessionId, cwd: session.cwd })}' | dharma hook claude session-start`;
  const note = (state, reason) => {
    try {
      mkdirSync(dirname(notePath), { recursive: true, mode: 0o700 });
      writeFileSync(notePath, `${JSON.stringify({ schema: 'dharma.claude-session-start-failure/v1', sessionId: session.sessionId,
        cwd: session.cwd, at: new Date().toISOString(), state, reason, recovery }, null, 2)}\n`, { mode: 0o600 });
    } catch { /* the systemMessage below still tells the user */ }
  };
  note('pending', 'did_not_finish');
  const result = await runCli(raw, SESSION_START_DEADLINE_MS);
  if (existsSync(join(sessions, 'claude-sessions', `${session.sessionId}.json`))) {
    try { rmSync(notePath, { force: true }); } catch { /* a stale note only adds a hint */ }
    return done();
  }
  const reason = result.timedOut ? 'timed_out' : result.unavailable ? 'cli_unavailable' : result.code === null ? 'cli_killed'
    : result.code !== 0 ? `cli_exit_${result.code}` : 'record_missing';
  note('failed', reason);
  const systemMessage = `Agent Fabric (preview): the SessionStart hook did not record this session (${reason}), so `
    + '`dharma sessions attach --provider claude --current` cannot find it. Restart this Claude Code session, or run: '
    + recovery;
  process.stdout.write(`${JSON.stringify({ systemMessage })}\n`, done);
}

async function inbox() {
  const result = await runCli(null);
  if (result.code === 0 && result.output.length > 0) process.stdout.write(result.output, done);
  else done();
}

if (action === 'session-start') sessionStart().catch(done);
else if (action === 'inbox') inbox().catch(done);
else done();
