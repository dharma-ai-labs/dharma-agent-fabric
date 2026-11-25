import assert from 'node:assert/strict';
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { readClaudeSessionStart, sessionNamesCommand, type SessionMessagingHost } from './sessionNames.js';

function repositoryRoot() {
  let directory = dirname(fileURLToPath(import.meta.url));
  while (!existsSync(join(directory, '.claude-plugin', 'marketplace.json'))) {
    const parent = dirname(directory);
    if (parent === directory) throw new Error('repository root not found');
    directory = parent;
  }
  return directory;
}
const root = repositoryRoot();
const read = (path: string) => readFileSync(join(root, path), 'utf8');
const json = (path: string) => JSON.parse(read(path)) as Record<string, unknown>;
const PREVIEW = 'plugins/claude/dharma-agent-fabric-preview';

test('1.0.7-preview is a separate marketplace entry beside the stable 1.0.8 entry', () => {
  const plugins = json('.claude-plugin/marketplace.json').plugins as Array<Record<string, unknown>>;
  assert.equal(plugins.length, 2);
  const stable = plugins.find(item => item.name === 'dharma-agent-fabric')!;
  assert.equal(stable.version, '1.0.8');
  assert.equal(stable.source, './plugins/claude/dharma-agent-fabric');
  assert.equal(json('plugins/claude/dharma-agent-fabric/.claude-plugin/plugin.json').version, '1.0.8');
  assert.equal(existsSync(join(root, 'plugins/claude/dharma-agent-fabric/hooks')), false, 'the stable plugin gets no hooks');
  const preview = plugins.find(item => item.name === 'dharma-agent-fabric-preview')!;
  assert.equal(preview.version, '1.0.7-preview');
  assert.equal(preview.source, `./${PREVIEW}`);
  assert.match(String(preview.description), /preview/i);
  assert.match(String(preview.description), /prototype/i);
  const manifest = json(`${PREVIEW}/.claude-plugin/plugin.json`);
  assert.equal(manifest.name, 'dharma-agent-fabric-preview');
  assert.equal(manifest.version, '1.0.7-preview');
  assert.match(String(manifest.description), /dharma-agent-fabric 1\.0\.6 or later/);
  assert.match(read(`${PREVIEW}/README.md`), /`dharma-agent-fabric` 1\.0\.6 or later/);
  assert.equal(existsSync(join(root, PREVIEW, '.mcp.json')), false, 'the add-on does not duplicate the stable MCP server');
});

test('the preview has exactly SessionStart and UserPromptSubmit hooks, guarded to exit 0 silently; no Stop hook', () => {
  const hooks = (json(`${PREVIEW}/hooks/hooks.json`).hooks ?? {}) as Record<string, Array<{ hooks: Array<Record<string, unknown>> }>>;
  assert.deepEqual(Object.keys(hooks).sort(), ['SessionStart', 'UserPromptSubmit']);
  const command = (event: string) => {
    assert.equal(hooks[event]!.length, 1);
    assert.equal(hooks[event]![0]!.hooks.length, 1);
    const hook = hooks[event]![0]!.hooks[0]!;
    assert.equal(hook.type, 'command');
    return String(hook.command);
  };
  const start = command('SessionStart');
  const inbox = command('UserPromptSubmit');
  // Live: two Claude Code windows started together, beside other plugins' SessionStart hooks, ran this hook for 10.7 s.
  // At 10 s Claude Code cancelled it and the session was never recorded. 30 s leaves room for a cold, busy machine.
  assert.equal(hooks.SessionStart![0]!.hooks[0]!.timeout, 30);
  const inboxTimeout = Number(hooks.UserPromptSubmit![0]!.hooks[0]!.timeout);
  assert.ok(inboxTimeout > 0 && inboxTimeout <= 15);
  assert.equal(start, 'node "${CLAUDE_PLUGIN_ROOT}/hooks/dharma-hook.mjs" session-start');
  assert.equal(inbox, 'node "${CLAUDE_PLUGIN_ROOT}/hooks/dharma-hook.mjs" inbox');
});

const windows = process.platform === 'win32';
const systemRoot = process.env.SystemRoot ?? 'C:\\Windows';
const INSTALL = 'npm install --global @dharma-ai-labs/agent-fabric';
// A folder name a user may have, with every character that breaks or injects into shell quoting, and non-ASCII text.
// Windows forbids `"` in file names.
const HOSTILE_FOLDER = windows ? 'project \'$(x);& é 日本' : 'project \'"$(x);& é 日本';
const pick = (value: unknown, keys: string[]) =>
  Object.fromEntries(keys.map(key => [key, (value as Record<string, unknown>)[key]]));
const onPath = (name: string) => (process.env.PATH ?? '').split(delimiter).filter(Boolean).map(entry => join(entry, name))
  .find(path => existsSync(path));
/** What Claude Code sends each hook on stdin. */
const hookJson = (action: string, sessionId: string, cwd: string) => JSON.stringify(action === 'session-start'
  ? { session_id: sessionId, transcript_path: join(cwd, `${sessionId}.jsonl`), cwd, hook_event_name: 'SessionStart', source: 'startup' }
  : { session_id: sessionId, transcript_path: join(cwd, `${sessionId}.jsonl`), cwd, permission_mode: 'default',
    hook_event_name: 'UserPromptSubmit', prompt: 'hello' });
/** The installed CLI's install or update notice: never the session-start recovery, which that CLI cannot run. */
function cliNotice(result: SpawnSyncReturns<string>, kind: 'missing' | 'older', label: string) {
  assert.deepEqual([result.status, result.stderr], [0, ''], label);
  const message = String((JSON.parse(result.stdout) as Record<string, unknown>).systemMessage);
  if (kind === 'missing') {
    assert.match(message, /dharma CLI was not found/, label);
    assert.ok(message.includes(`\`${INSTALL}\``), label);
  } else {
    assert.match(message, /dharma CLI is too old/, label);
    assert.ok(message.includes(`\`${INSTALL}@latest\``), label);
  }
  assert.doesNotMatch(message, /hook claude session-start|--session-id/, label);
}
let schemaValidator: ((value: unknown) => boolean) | undefined;
/** The plugin writes the failure note and the CLI reads it, so both are checked against this one schema (AGENTS.md rule 5). */
function failureNoteSchema() {
  schemaValidator ??= new Ajv2020({ strict: true }).compile(JSON.parse(read('schemas/claude-session-start-failure.v1.schema.json')));
  return schemaValidator;
}

// R1: Claude Code on Windows without Git Bash runs hook commands in PowerShell, which rejects `&&` (5.1) and has no
// `command -v`. The hook command must be shell-neutral and exit 0 under every shell a runner has, with the real hook JSON
// Claude Code sends. The inbox hook stays silent when the CLI is missing, is an older CLI without `hook claude`, or the
// session is not attached. SessionStart with a missing or older CLI says once that the CLI must be installed or updated
// (the session-start recovery cannot work there), then stays silent on later starts.
test('hook commands need no POSIX shell, and with real hook JSON a missing or older CLI gets one install or update notice (R1)', () => {
  const hooks = json(`${PREVIEW}/hooks/hooks.json`).hooks as Record<string, Array<{ hooks: Array<{ command: string }> }>>;
  const commands = { 'session-start': hooks.SessionStart![0]!.hooks[0]!.command, inbox: hooks.UserPromptSubmit![0]!.hooks[0]!.command };
  for (const command of Object.values(commands)) assert.doesNotMatch(command, /&&|command -v|\/dev\/null|2>&1/, command);
  const pluginRoot = join(root, PREVIEW);
  const launcher = join(pluginRoot, 'hooks', 'dharma-hook.mjs');
  const work = mkdtempSync(join(tmpdir(), 'dharma-r1-'));
  const project = join(work, 'project');
  mkdirSync(project);
  let homes = 0;
  const newHome = () => join(work, `home-${homes++}`);
  // Only node, the fake CLI directory and (on Windows) System32: no Git Bash, no installed dharma.
  const env = (cliDirectory: string | null, home: string) => ({
    PATH: [cliDirectory, dirname(process.execPath), ...(windows ? [join(systemRoot, 'System32'),
      join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0')] : ['/usr/bin', '/bin'])].filter(Boolean).join(delimiter),
    CLAUDE_PLUGIN_ROOT: pluginRoot, DHARMA_HOME: home,
    ...(windows ? { SystemRoot: systemRoot, ComSpec: join(systemRoot, 'System32', 'cmd.exe'), PATHEXT: '.COM;.EXE;.BAT;.CMD' } : {}) });
  const fakeCli = (exitCode: number, stdout = '') => {
    const directory = mkdtempSync(join(work, 'fake-cli-'));
    if (windows) writeFileSync(join(directory, 'dharma.cmd'),
      `@echo off\r\n${stdout ? `echo ${stdout}\r\n` : ''}echo usage: dharma 1>&2\r\nexit /b ${exitCode}\r\n`);
    else writeFileSync(join(directory, 'dharma'),
      `#!/bin/sh\n${stdout ? `echo '${stdout}'\n` : ''}echo 'usage: dharma' >&2\nexit ${exitCode}\n`, { mode: 0o755 });
    return directory;
  };
  // Each shell runs the command as Claude Code does: ${CLAUDE_PLUGIN_ROOT} substituted, hook JSON on stdin.
  const gitBash = windows ? onPath('sh.exe') : undefined;
  const shells: Array<[string, (command: string) => [string, string[]]]> = windows
    ? [['powershell', command => [join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
      ['-NoProfile', '-NonInteractive', '-Command', command]]],
      ...(gitBash ? [['git-bash', (command: string) => [gitBash, ['-c', command]]] as [string, (command: string) => [string, string[]]]] : [])]
    : [['sh', command => ['/bin/sh', ['-c', command]]]];
  const missing = mkdtempSync(join(work, 'no-cli-'));
  const older = fakeCli(2);
  const notAttached = fakeCli(0);
  try {
    const runs: Array<[string, (input: string, cliDirectory: string, home: string) => SpawnSyncReturns<string>]> = [
      ['launcher', (input, cliDirectory, home) => spawnSync(process.execPath, [launcher, 'session-start'],
        { encoding: 'utf8', input, env: env(cliDirectory, home), windowsHide: true, timeout: 60_000 })],
      ...shells.map(([shellName, shell]) => [shellName, (input: string, cliDirectory: string, home: string) => {
        const [file, args] = shell(commands['session-start'].replaceAll('${CLAUDE_PLUGIN_ROOT}', pluginRoot));
        return spawnSync(file, args, { encoding: 'utf8', input, env: env(cliDirectory, home), windowsHide: true, timeout: 60_000 });
      }] as [string, (input: string, cliDirectory: string, home: string) => SpawnSyncReturns<string>])];
    for (const [runner, start] of runs) {
      for (const [kind, cliDirectory] of [['missing', missing], ['older', older]] as const) {
        const home = newHome();
        const first = start(hookJson('session-start', randomUUID(), project), cliDirectory, home);
        cliNotice(first, kind, `session-start via ${runner}, CLI ${kind}`);
        const again = start(hookJson('session-start', randomUUID(), project), cliDirectory, home);
        assert.deepEqual([again.status, again.stdout, again.stderr], [0, '', ''], `session-start via ${runner}, CLI ${kind}, not repeated`);
      }
    }
    const inboxRuns: Array<[string, (cliDirectory: string, home: string) => SpawnSyncReturns<string>]> = [
      ['launcher', (cliDirectory, home) => spawnSync(process.execPath, [launcher, 'inbox'], { encoding: 'utf8',
        input: hookJson('inbox', randomUUID(), project), env: env(cliDirectory, home), windowsHide: true })],
      ...shells.map(([shellName, shell]) => [shellName, (cliDirectory: string, home: string) => {
        const [file, args] = shell(commands.inbox.replaceAll('${CLAUDE_PLUGIN_ROOT}', pluginRoot));
        return spawnSync(file, args, { encoding: 'utf8', input: hookJson('inbox', randomUUID(), project), env: env(cliDirectory, home),
          windowsHide: true });
      }] as [string, (cliDirectory: string, home: string) => SpawnSyncReturns<string>])];
    for (const [runner, inbox] of inboxRuns) {
      for (const [cliName, cliDirectory] of [['missing', missing], ['older', older], ['not attached', notAttached]] as const) {
        const result = inbox(cliDirectory, newHome());
        assert.deepEqual([result.status, result.stdout, result.stderr], [0, '', ''], `inbox via ${runner}, CLI ${cliName}`);
      }
    }
    // The attached case: the inbox output reaches Claude, the CLI's stderr does not. Input without a session id
    // (nothing to record) still prints nothing from SessionStart.
    const attached = fakeCli(0, '{"hookSpecificOutput":{}}');
    for (const [action, input, expected] of [['inbox', hookJson('inbox', randomUUID(), project), '{"hookSpecificOutput":{}}'],
      ['session-start', '{}', '']]) {
      const result = spawnSync(process.execPath, [launcher, action!], { encoding: 'utf8', input, env: env(attached, newHome()),
        windowsHide: true });
      assert.deepEqual([result.status, result.stdout.trim(), result.stderr], [0, expected, ''], `${action} attached`);
    }
  } finally { rmSync(work, { recursive: true, force: true }); }
});

// A fake `dharma` that records which SessionStart notes existed while it ran, then acts as FAKE_MODE says:
// `old` is a CLI without `hook claude` (usage error, exit 2, for every hook command); `fail` exits 2; `silent` exits 0
// without a record (a CLI that swallowed its own error); `record` writes the record. Like the real CLI, it answers
// `--dry-run` with a plan and exports the session id when CLAUDE_ENV_FILE is set.
const FAKE_CLI = `import { appendFileSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const sessions = join(process.env.DHARMA_HOME, 'session-messages');
if (process.env.FAKE_MODE === 'old') { process.stderr.write('usage: dharma\\n'); process.exit(2); }
if (process.argv.includes('--dry-run')) {
  process.stdout.write(JSON.stringify({ ok: true, stage: 'plan', effects: false, action: 'session-start', writes: [] }) + '\\n');
  process.exit(0);
}
const input = JSON.parse(readFileSync(0, 'utf8'));
const notes = join(sessions, 'claude-session-start-failures');
let seen = [];
try { seen = readdirSync(notes).map(name => JSON.parse(readFileSync(join(notes, name), 'utf8'))); } catch {}
if (process.env.FAKE_SEEN) writeFileSync(process.env.FAKE_SEEN, JSON.stringify(seen));
if (process.env.FAKE_MODE === 'record') {
  mkdirSync(join(sessions, 'claude-sessions'), { recursive: true });
  writeFileSync(join(sessions, 'claude-sessions', input.session_id + '.json'), JSON.stringify({
    schema: 'dharma.claude-session-start/v1', sessionId: input.session_id, cwd: input.cwd, at: new Date().toISOString() }));
  if (process.env.CLAUDE_ENV_FILE) appendFileSync(process.env.CLAUDE_ENV_FILE, 'export DHARMA_CLAUDE_SESSION_ID=' + input.session_id + '\\n');
}
process.exit(process.env.FAKE_MODE === 'fail' ? 2 : 0);
`;

// Live: Claude Code cancelled this hook at its timeout, the launcher stayed silent, no record was written and
// `dharma sessions attach --current` later failed with a bare claude_current_session_unavailable. A SessionStart that
// leaves no record must say so (a systemMessage; still exit 0, so the session is never blocked) and leave a note,
// written before the CLI runs, that attach turns into the reason and a one-line recovery. The launcher exports the
// session id first, so attach names this session by id, never by the newest note in a shared folder.
test('a SessionStart the CLI does not record is reported, leaves a schema-valid note, exports the session id, and still exits 0', async () => {
  const pluginRoot = join(root, PREVIEW);
  const launcher = join(pluginRoot, 'hooks', 'dharma-hook.mjs');
  const validNote = failureNoteSchema;
  const work = mkdtempSync(join(tmpdir(), 'dharma-hook-start-'));
  try {
    const cwd = join(work, HOSTILE_FOLDER);
    const cli = join(work, 'cli');
    const missing = join(work, 'no-cli');
    for (const directory of [cwd, cli, missing]) mkdirSync(directory);
    writeFileSync(join(cli, 'fake.mjs'), FAKE_CLI);
    if (windows) writeFileSync(join(cli, 'dharma.cmd'), '@echo off\r\nnode "%~dp0fake.mjs" %*\r\nexit /b %ERRORLEVEL%\r\n');
    else writeFileSync(join(cli, 'dharma'), '#!/bin/sh\nexec node "$(dirname "$0")/fake.mjs" "$@"\n', { mode: 0o755 });
    const recovery = (id: string) => `dharma hook claude session-start --session-id ${id}`;
    let runs = 0;
    const start = (mode: string, options: { cliDirectory?: string; home?: string } = {}) => {
      const run = runs++;
      const home = options.home ?? join(work, `home-${run}`);
      const sessionId = randomUUID();
      const seen = join(work, `seen-${run}.json`);
      const envFile = join(work, `claude-env-${run}`);
      const result = spawnSync(process.execPath, [launcher, 'session-start'], { encoding: 'utf8', windowsHide: true, timeout: 60_000,
        input: hookJson('session-start', sessionId, cwd),
        env: { PATH: [options.cliDirectory ?? cli, dirname(process.execPath), ...(windows ? [join(systemRoot, 'System32')] : ['/usr/bin', '/bin'])]
          .join(delimiter), DHARMA_HOME: home, FAKE_MODE: mode, FAKE_SEEN: seen, CLAUDE_PLUGIN_ROOT: pluginRoot, CLAUDE_ENV_FILE: envFile,
        ...(windows ? { SystemRoot: systemRoot, ComSpec: join(systemRoot, 'System32', 'cmd.exe'), PATHEXT: '.COM;.EXE;.BAT;.CMD' } : {}) } });
      const notePath = join(home, 'session-messages', 'claude-session-start-failures', `${sessionId}.json`);
      const note = existsSync(notePath) ? JSON.parse(readFileSync(notePath, 'utf8')) as Record<string, unknown> : null;
      return { home, sessionId, result, note, exported: existsSync(envFile) ? readFileSync(envFile, 'utf8') : '',
        seen: existsSync(seen) ? JSON.parse(readFileSync(seen, 'utf8')) as Array<Record<string, unknown>> : null };
    };
    const noted = (run: ReturnType<typeof start>, reason: RegExp) => {
      assert.equal(run.result.status, 0, 'never blocks the session');
      assert.equal(run.result.stderr, '');
      assert.deepEqual({ ...(run.note ?? {}), at: undefined, reason: undefined }, { schema: 'dharma.claude-session-start-failure/v1',
        sessionId: run.sessionId, cwd, at: undefined, state: 'failed', reason: undefined });
      assert.match(String(run.note!.reason), reason);
      assert.equal(run.exported, `export DHARMA_CLAUDE_SESSION_ID=${run.sessionId}\n`, 'the session id is exported exactly once');
      assert.ok(validNote()(run.note), `the launcher's note matches the schema: ${JSON.stringify(run.note)}`);
    };
    const reported = (run: ReturnType<typeof start>, reason: RegExp) => {
      noted(run, reason);
      const message = String((JSON.parse(run.result.stdout) as Record<string, unknown>).systemMessage);
      assert.match(message, /SessionStart hook did not record this session/);
      assert.ok(message.endsWith(`run this from this session's folder: ${recovery(run.sessionId)}`), message);
      assert.match(message, /^[\x20-\x7e]*$/, 'ASCII only: no folder name or other untrusted text');
      assert.ok(!message.includes(cwd) && !message.includes('echo'), message);
    };
    const failed = start('fail');
    reported(failed, /^cli_exit_2$/);
    assert.deepEqual(failed.seen!.map(note => [note.sessionId, note.state, note.reason]),
      [[failed.sessionId, 'pending', 'did_not_finish']], 'the note exists before the CLI runs, so a hook killed at its timeout still leaves it');
    assert.ok(validNote()(failed.seen![0]), `the pending note matches the schema: ${JSON.stringify(failed.seen![0])}`);
    reported(start('silent'), /^record_missing$/);
    // A missing or older CLI cannot run the recovery: the notice says to install or update it, once a day.
    for (const [mode, kind, reason, cliDirectory] of [['missing', 'missing', /^cli_missing$/, missing],
      ['old', 'older', /^cli_outdated$/, cli]] as const) {
      const first = start(mode, { cliDirectory });
      noted(first, reason);
      cliNotice(first.result, kind, mode);
      const again = start(mode, { cliDirectory, home: first.home });
      noted(again, reason);
      assert.equal(again.result.stdout, '', `${mode}: the notice is not repeated at the next start`);
    }
    const recorded = start('record');
    assert.deepEqual([recorded.result.status, recorded.result.stdout, recorded.result.stderr], [0, '', '']);
    assert.equal(recorded.note, null, 'a recorded session leaves no note');
    assert.equal(recorded.exported, `export DHARMA_CLAUDE_SESSION_ID=${recorded.sessionId}\n`, 'exported once, not again by the CLI');
    // attach in that session (the exported id) reads the note: the stable code first, then why and the exact recovery.
    const host: SessionMessagingHost = { home: failed.home, cwd, env: { DHARMA_CLAUDE_SESSION_ID: failed.sessionId }, now: () => new Date(),
      device: async () => { throw new Error('device_must_not_be_read'); },
      transport: async () => { throw new Error('transport_must_not_open'); } };
    await assert.rejects(sessionNamesCommand('attach', new Map<string, string | boolean>([['provider', 'claude'], ['current', true],
      ['name', 'ops-claude'], ['yes', true]]), host), (error: unknown) => {
      const { message } = error as Error;
      assert.match(message, /^claude_current_session_unavailable: /);
      assert.match(message, /SessionStart hook/);
      assert.match(message, /cli_exit_2/);
      assert.ok(message.endsWith(recovery(failed.sessionId)), message);
      return true;
    });
  } finally { rmSync(work, { recursive: true, force: true }); }
});

// The recovery line is shown to the user and may be run by the agent after the user's yes. It holds a fixed command and
// a session id checked as a UUID, and the CLI takes the folder from where it runs, so no folder name is ever put inside
// shell quoting. It must work unchanged in every shell Claude Code may use.
test('the recovery line is ASCII with only a checked session id, and records the session from its folder under every shell', async () => {
  const work = mkdtempSync(join(tmpdir(), 'dharma-recovery-'));
  try {
    const folder = join(work, HOSTILE_FOLDER);
    const shim = join(work, 'bin');
    for (const directory of [folder, shim]) mkdirSync(directory);
    // An npm global install puts `dharma` (sh) and `dharma.cmd` beside each other; these run the built CLI.
    const bin = fileURLToPath(new URL('./bin.js', import.meta.url));
    const node = process.execPath;
    writeFileSync(join(shim, 'dharma'), `#!/bin/sh\nexec "${node.replaceAll('\\', '/')}" "${bin.replaceAll('\\', '/')}" "$@"\n`, { mode: 0o755 });
    if (windows) writeFileSync(join(shim, 'dharma.cmd'), `@"${node}" "${bin}" %*\r\n`);
    const ps51 = join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const pwsh = onPath(windows ? 'pwsh.exe' : 'pwsh');
    const gitBash = windows ? onPath('sh.exe') : undefined;
    const bash = windows ? undefined : ['/bin/bash', '/usr/bin/bash'].find(path => existsSync(path));
    type Shell = [string, (line: string) => [string, string[]]];
    const shells: Shell[] = windows
      ? [['cmd', line => [join(systemRoot, 'System32', 'cmd.exe'), ['/d', '/s', '/c', line]]],
        ['powershell 5.1', line => [ps51, ['-NoProfile', '-NonInteractive', '-Command', line]]],
        ...(pwsh ? [['pwsh 7', (line: string) => [pwsh, ['-NoProfile', '-NonInteractive', '-Command', line]]] as Shell] : []),
        ...(gitBash ? [['git-bash', (line: string) => [gitBash, ['-c', line]]] as Shell] : [])]
      : [['sh', line => ['/bin/sh', ['-c', line]]],
        ...(bash ? [['bash', (line: string) => [bash, ['-c', line]]] as Shell] : []),
        ...(pwsh ? [['pwsh 7', (line: string) => [pwsh, ['-NoProfile', '-NonInteractive', '-Command', line]]] as Shell] : [])];
    if (process.env.CI && windows) assert.ok(pwsh, 'the Windows runner has PowerShell 7');
    const inherited = (names: string[]) => Object.fromEntries(names.flatMap(name => process.env[name] ? [[name, process.env[name]!]] : []));
    for (const [shellName, shell] of shells) {
      const home = join(work, `home-${shellName.replaceAll(' ', '-')}`);
      const sessionId = randomUUID();
      // The line comes from the product: attach in a session whose hook exported its id but left no record.
      const host: SessionMessagingHost = { home, cwd: folder, env: { DHARMA_CLAUDE_SESSION_ID: sessionId }, now: () => new Date(),
        device: async () => { throw new Error('device_must_not_be_read'); },
        transport: async () => { throw new Error('transport_must_not_open'); } };
      const message = await sessionNamesCommand('attach', new Map<string, string | boolean>([['provider', 'claude'], ['current', true],
        ['name', 'ops-claude'], ['yes', true]]), host).then(() => '', (error: unknown) => (error as Error).message);
      const line = /run this from this session's folder: (.+)$/.exec(message)?.[1];
      assert.equal(line, `dharma hook claude session-start --session-id ${sessionId}`, message);
      assert.match(line!, /^[a-z -]+[0-9a-f-]{36}$/, 'letters, spaces, hyphens and the UUID only');
      const [file, args] = shell(line!);
      const result = spawnSync(file, args, { cwd: folder, encoding: 'utf8', windowsHide: true, timeout: 60_000, env: {
        PATH: [shim, dirname(node), ...(windows ? [join(systemRoot, 'System32'), dirname(ps51)] : ['/usr/bin', '/bin'])].join(delimiter),
        DHARMA_HOME: home,
        ...(windows ? { SystemRoot: systemRoot, ComSpec: join(systemRoot, 'System32', 'cmd.exe'), PATHEXT: '.COM;.EXE;.BAT;.CMD',
          ...inherited(['USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP', 'ProgramData', 'ProgramFiles']) }
          : inherited(['HOME', 'TMPDIR'])) } });
      assert.equal(result.status, 0, `${shellName}: ${result.stderr}`);
      assert.deepEqual(pick(JSON.parse(result.stdout), ['ok', 'stage', 'sessionId']), { ok: true, stage: 'recorded', sessionId }, shellName);
      const record = await readClaudeSessionStart(home, sessionId);
      assert.ok(record, `${shellName}: the session is recorded`);
      assert.equal(realpathSync.native(record.cwd), realpathSync.native(folder), `${shellName}: from the folder it ran in`);
    }
  } finally { rmSync(work, { recursive: true, force: true }); }
});

test('the name-session skill wraps the CLI and leaves the consent to the user', () => {
  const skill = read(`${PREVIEW}/skills/name-session/SKILL.md`).replaceAll('\r\n', '\n');
  const front = /^---\n([\s\S]*?)\n---\n/.exec(skill)?.[1] ?? '';
  assert.match(front, /^name: name-session$/m);
  assert.match(front, /^description: .+/m);
  assert.match(skill, /dharma sessions attach --provider claude --current --name <name> --dry-run/);
  assert.match(skill, /dharma sessions attach --provider claude --current --name <name> --yes/);
  assert.match(skill, /Any active member of/);
  assert.match(skill, /explicit/i);
  assert.match(skill, /untrusted/i);
  assert.doesNotMatch(skill, /Stop hook is/i);
  // F5: a double-quoted body lets the shell expand $(...) or backticks that a message asked for.
  assert.doesNotMatch(skill, /--body "/);
  assert.match(skill, /dharma msg reply --message <id> --body-file - <<'EOF'\n<text>\nEOF/);
  assert.match(skill, /dharma msg send --to <name> --body-file - <<'EOF'\n<text>\nEOF/);
});
