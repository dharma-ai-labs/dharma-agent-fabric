// Runs `dharma hook claude <action>` for the 1.0.7-preview hooks with no shell syntax in the hook command, so the
// same command works under sh, Git Bash, Windows PowerShell 5.1 and pwsh. The hook JSON on stdin goes to the CLI.
// Always exits 0, so a hook never blocks a session or a prompt. The CLI's stderr is never shown.
// - inbox: a missing CLI, an older CLI without `hook claude`, or any failure prints nothing. Only the inbox output
//   is forwarded, and only when the CLI exited 0.
// - session-start: first exports the session id through CLAUDE_ENV_FILE, so later Bash calls know their own session
//   whatever happens next. Then a pending note goes under
//   DHARMA_HOME/session-messages/claude-session-start-failures/<session id>.json (schemas/claude-session-start-failure.v1),
//   so a hook that Claude Code kills at its timeout still leaves a trace. When the CLI recorded the session, the note is
//   removed and nothing is printed. Otherwise the note says why, and a systemMessage tells the user:
//   - a missing or older CLI: how to install or update it, at most once a day (the recovery needs a current CLI);
//   - anything else: the one-line recovery `dharma hook claude session-start --session-id <uuid>`, which holds no
//     folder name or other text from the hook input, so it runs the same in every shell.
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';

const action = process.argv[2];
const done = () => process.exit(0);
/** Under the 30 s SessionStart timeout in hooks.json, so the launcher reports a stalled CLI itself. */
const SESSION_START_DEADLINE_MS = 25_000;
/** The check for an older CLI, run only when no record followed; it ends well inside the 30 s timeout. */
const PROBE_MS = 3_000;
const SESSION_ID = /^[A-Za-z0-9_-]{1,128}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_STDIN = 1_048_576;
const INSTALL = 'npm install --global @dharma-ai-labs/agent-fabric';
const NOTICE_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** Whether a `dharma` command is on PATH: on Windows, cmd.exe reports a missing command only as a nonzero exit. */
function cliOnPath() {
  const names = process.platform === 'win32'
    ? (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean).map(extension => `dharma${extension}`)
    : ['dharma'];
  return (process.env.PATH || '').split(delimiter).filter(Boolean).some(directory => names.some(name => {
    try { return statSync(join(directory.replace(/^"(.*)"$/, '$1'), name)).isFile(); } catch { return false; }
  }));
}

/** Runs the CLI with `input` on its stdin (or this process's stdin piped through when `input` is null). */
function runCli(args, input, deadlineMs, env = process.env) {
  return new Promise(settle => {
    let child;
    try {
      // shell on Windows so dharma.cmd resolves; the arguments are fixed strings and a checked UUID.
      child = spawn('dharma', args,
        { stdio: ['pipe', 'pipe', 'ignore'], shell: process.platform === 'win32', windowsHide: true, env });
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

/** Appends the session id to CLAUDE_ENV_FILE; true when it is there. The id matched SESSION_ID, so it is shell-safe. */
function exportSessionId(sessionId) {
  const file = process.env.CLAUDE_ENV_FILE;
  if (!file) return false;
  try { appendFileSync(file, `export DHARMA_CLAUDE_SESSION_ID=${sessionId}\n`); return true; } catch { return false; }
}

/** Whether this CLI has `hook claude session-start --session-id`, which the recovery needs. Only a clear refusal
 * counts as older: a probe that runs out of time says nothing. */
async function cliSupportsRecovery() {
  const result = await runCli(['hook', 'claude', 'session-start', '--session-id', '00000000-0000-4000-8000-000000000000',
    '--dry-run'], '', PROBE_MS);
  if (result.timedOut) return true;
  if (result.unavailable || result.code !== 0) return false;
  try {
    const plan = JSON.parse(result.output.toString('utf8'));
    return plan?.stage === 'plan' && plan?.action === 'session-start';
  } catch { return false; }
}

/** A missing or older CLI is reported at most once a day per reason, not at every session start. */
function noticeDue(path, reason) {
  try {
    const last = JSON.parse(readFileSync(path, 'utf8'));
    if (last?.reason === reason && Date.now() - Date.parse(last.at) < NOTICE_INTERVAL_MS) return false;
  } catch { /* no notice yet */ }
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(path, `${JSON.stringify({ reason, at: new Date().toISOString() })}\n`, { mode: 0o600 });
  } catch { /* shown again next time */ }
  return true;
}

function cliNotice(reason) {
  const what = reason === 'cli_missing' ? 'the dharma CLI was not found' : 'the dharma CLI is too old for this plugin';
  const step = reason === 'cli_missing' ? `Install it with \`${INSTALL}\`` : `Update it with \`${INSTALL}@latest\``;
  return `Agent Fabric (preview): ${what}, so this Claude Code session was not recorded and `
    + `\`dharma sessions attach --provider claude --current\` cannot find it. ${step}, then restart this Claude Code session. `
    + 'This notice is shown at most once a day.';
}

async function sessionStart() {
  const raw = await readStdin();
  const session = sessionOf(raw);
  // Without a session id there is nothing to record or check; the CLI ignores such input too.
  if (!session) { await runCli(['hook', 'claude', 'session-start'], raw); return done(); }
  // First, so later Bash calls name this session whatever happens below. The CLI then need not export it again.
  const exported = exportSessionId(session.sessionId);
  const env = { ...process.env };
  if (exported) delete env.CLAUDE_ENV_FILE;
  const sessions = join(resolve(process.env.DHARMA_HOME || join(homedir(), '.dharma')), 'session-messages');
  const notePath = join(sessions, 'claude-session-start-failures', `${session.sessionId}.json`);
  const note = (state, reason) => {
    try {
      mkdirSync(dirname(notePath), { recursive: true, mode: 0o700 });
      writeFileSync(notePath, `${JSON.stringify({ schema: 'dharma.claude-session-start-failure/v1', sessionId: session.sessionId,
        cwd: session.cwd, at: new Date().toISOString(), state, reason }, null, 2)}\n`, { mode: 0o600 });
    } catch { /* the systemMessage below still tells the user */ }
  };
  note('pending', 'did_not_finish');
  const result = cliOnPath() ? await runCli(['hook', 'claude', 'session-start'], raw, SESSION_START_DEADLINE_MS, env)
    : { unavailable: true };
  if (existsSync(join(sessions, 'claude-sessions', `${session.sessionId}.json`))) {
    try { rmSync(notePath, { force: true }); } catch { /* a stale note only adds a hint */ }
    return done();
  }
  const exit = `cli_exit_${result.code}`;
  const reason = result.timedOut ? 'timed_out' : result.unavailable ? 'cli_missing'
    : !(await cliSupportsRecovery()) ? 'cli_outdated' : result.code === null ? 'cli_killed'
    : result.code !== 0 ? (/^cli_exit_-?[0-9]{1,10}$/.test(exit) ? exit : 'cli_killed') : 'record_missing';
  note('failed', reason);
  if (reason === 'cli_missing' || reason === 'cli_outdated') {
    if (!noticeDue(join(sessions, 'claude-hook-cli-notice.json'), reason)) return done();
    return process.stdout.write(`${JSON.stringify({ systemMessage: cliNotice(reason) })}\n`, done);
  }
  const recovery = UUID.test(session.sessionId)
    ? `Restart this Claude Code session, or run this from this session's folder: dharma hook claude session-start --session-id ${session.sessionId}`
    : 'Restart this Claude Code session.';
  const systemMessage = `Agent Fabric (preview): the SessionStart hook did not record this session (${reason}), so `
    + `\`dharma sessions attach --provider claude --current\` cannot find it. ${recovery}`;
  process.stdout.write(`${JSON.stringify({ systemMessage })}\n`, done);
}

async function inbox() {
  const result = await runCli(['hook', 'claude', 'inbox'], null);
  if (result.code === 0 && result.output.length > 0) process.stdout.write(result.output, done);
  else done();
}

if (action === 'session-start') sessionStart().catch(done);
else if (action === 'inbox') inbox().catch(done);
else done();
