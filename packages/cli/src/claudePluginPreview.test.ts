import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { sessionNamesCommand, type SessionMessagingHost } from './sessionNames.js';

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

// R1: Claude Code on Windows without Git Bash runs hook commands in PowerShell, which rejects `&&` (5.1) and has no
// `command -v`. The hook command must be shell-neutral, and stay silent with exit 0 when the CLI is missing, is an older
// CLI without `hook claude`, or the session is not attached, under every shell a runner has.
test('hook commands need no POSIX shell: no &&, command -v or /dev/null, and the launcher exits 0 silently without the CLI (R1)', () => {
  const hooks = json(`${PREVIEW}/hooks/hooks.json`).hooks as Record<string, Array<{ hooks: Array<{ command: string }> }>>;
  const commands = { 'session-start': hooks.SessionStart![0]!.hooks[0]!.command, inbox: hooks.UserPromptSubmit![0]!.hooks[0]!.command };
  for (const command of Object.values(commands)) assert.doesNotMatch(command, /&&|command -v|\/dev\/null|2>&1/, command);
  const pluginRoot = join(root, PREVIEW);
  const launcher = join(pluginRoot, 'hooks', 'dharma-hook.mjs');
  const windows = process.platform === 'win32';
  const systemRoot = process.env.SystemRoot ?? 'C:\\Windows';
  // Only node, the fake CLI directory and (on Windows) System32: no Git Bash, no installed dharma.
  const env = (cliDirectory: string | null) => ({
    PATH: [cliDirectory, dirname(process.execPath), ...(windows ? [join(systemRoot, 'System32'),
      join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0')] : ['/usr/bin', '/bin'])].filter(Boolean).join(delimiter),
    CLAUDE_PLUGIN_ROOT: pluginRoot,
    ...(windows ? { SystemRoot: systemRoot, ComSpec: join(systemRoot, 'System32', 'cmd.exe'), PATHEXT: '.COM;.EXE;.BAT;.CMD' } : {}) });
  const fakeCli = (exitCode: number, stdout = '') => {
    const directory = mkdtempSync(join(tmpdir(), 'dharma-fake-cli-'));
    if (windows) writeFileSync(join(directory, 'dharma.cmd'),
      `@echo off\r\n${stdout ? `echo ${stdout}\r\n` : ''}echo usage: dharma 1>&2\r\nexit /b ${exitCode}\r\n`);
    else writeFileSync(join(directory, 'dharma'),
      `#!/bin/sh\n${stdout ? `echo '${stdout}'\n` : ''}echo 'usage: dharma' >&2\nexit ${exitCode}\n`, { mode: 0o755 });
    return directory;
  };
  // Each shell runs the command as Claude Code does: ${CLAUDE_PLUGIN_ROOT} substituted, hook JSON on stdin.
  const gitBash = windows
    ? (process.env.PATH ?? '').split(delimiter).map(entry => join(entry, 'sh.exe')).find(path => existsSync(path)) : undefined;
  const shells: Array<[string, (command: string) => [string, string[]]]> = windows
    ? [['powershell', command => [join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
      ['-NoProfile', '-NonInteractive', '-Command', command]]],
      ...(gitBash ? [['git-bash', (command: string) => [gitBash, ['-c', command]]] as [string, (command: string) => [string, string[]]]] : [])]
    : [['sh', command => ['/bin/sh', ['-c', command]]]];
  const missing = mkdtempSync(join(tmpdir(), 'dharma-no-cli-'));
  const older = fakeCli(2);
  const notAttached = fakeCli(0);
  try {
    for (const [action, command] of Object.entries(commands)) {
      // The launcher itself, with no shell at all.
      const direct = spawnSync(process.execPath, [launcher, action], { encoding: 'utf8', input: '{}', env: env(missing), windowsHide: true });
      assert.deepEqual([direct.status, direct.stdout, direct.stderr], [0, '', ''], `${action} launcher without the CLI`);
      for (const [shellName, shell] of shells) {
        for (const [cliName, cliDirectory] of [['missing', missing], ['older', older], ['not attached', notAttached]] as const) {
          const [file, args] = shell(command.replaceAll('${CLAUDE_PLUGIN_ROOT}', pluginRoot));
          const result = spawnSync(file, args, { encoding: 'utf8', input: '{}', env: env(cliDirectory), windowsHide: true });
          assert.deepEqual([result.status, result.stdout, result.stderr], [0, '', ''], `${action} via ${shellName}, CLI ${cliName}`);
        }
      }
    }
    // The attached case: the inbox output reaches Claude, the CLI's stderr does not; SessionStart output never does.
    const attached = fakeCli(0, '{"hookSpecificOutput":{}}');
    try {
      for (const [action, expected] of [['inbox', '{"hookSpecificOutput":{}}'], ['session-start', '']]) {
        const result = spawnSync(process.execPath, [launcher, action!], { encoding: 'utf8', input: '{}', env: env(attached), windowsHide: true });
        assert.deepEqual([result.status, result.stdout.trim(), result.stderr], [0, expected, ''], `${action} attached`);
      }
    } finally { rmSync(attached, { recursive: true, force: true }); }
  } finally {
    for (const directory of [missing, older, notAttached]) rmSync(directory, { recursive: true, force: true });
  }
});

// A fake `dharma` that records which SessionStart notes existed while it ran, then acts as FAKE_MODE says:
// `fail` exits 2, `silent` exits 0 without a record (a CLI that swallowed its own error), `record` writes the record.
const FAKE_CLI = `import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const sessions = join(process.env.DHARMA_HOME, 'session-messages');
const input = JSON.parse(readFileSync(0, 'utf8'));
const notes = join(sessions, 'claude-session-start-failures');
let seen = [];
try { seen = readdirSync(notes).map(name => JSON.parse(readFileSync(join(notes, name), 'utf8'))); } catch {}
if (process.env.FAKE_SEEN) writeFileSync(process.env.FAKE_SEEN, JSON.stringify(seen));
if (process.env.FAKE_MODE === 'record') {
  mkdirSync(join(sessions, 'claude-sessions'), { recursive: true });
  writeFileSync(join(sessions, 'claude-sessions', input.session_id + '.json'), JSON.stringify({
    schema: 'dharma.claude-session-start/v1', sessionId: input.session_id, cwd: input.cwd, at: new Date().toISOString() }));
}
process.exit(process.env.FAKE_MODE === 'fail' ? 2 : 0);
`;

// Live: Claude Code cancelled this hook at its timeout, the launcher stayed silent, no record was written and
// `dharma sessions attach --current` later failed with a bare claude_current_session_unavailable. A SessionStart that
// leaves no record must say so (a systemMessage; still exit 0, so the session is never blocked) and leave a note,
// written before the CLI runs, that attach turns into the reason and a one-line recovery.
test('a SessionStart the CLI does not record is reported, leaves a note for attach, and still exits 0', async () => {
  const pluginRoot = join(root, PREVIEW);
  const launcher = join(pluginRoot, 'hooks', 'dharma-hook.mjs');
  const windows = process.platform === 'win32';
  const systemRoot = process.env.SystemRoot ?? 'C:\\Windows';
  const work = mkdtempSync(join(tmpdir(), 'dharma-hook-start-'));
  try {
    const cwd = join(work, 'project');
    const cli = join(work, 'cli');
    const missing = join(work, 'no-cli');
    for (const directory of [cwd, cli, missing]) mkdirSync(directory);
    writeFileSync(join(cli, 'fake.mjs'), FAKE_CLI);
    if (windows) writeFileSync(join(cli, 'dharma.cmd'), '@echo off\r\nnode "%~dp0fake.mjs" %*\r\nexit /b %ERRORLEVEL%\r\n');
    else writeFileSync(join(cli, 'dharma'), '#!/bin/sh\nexec node "$(dirname "$0")/fake.mjs" "$@"\n', { mode: 0o755 });
    const recovery = (id: string) => `echo '${JSON.stringify({ session_id: id, cwd })}' | dharma hook claude session-start`;
    const start = (mode: string, cliDirectory = cli) => {
      const home = join(work, `home-${mode}`);
      const sessionId = randomUUID();
      const seen = join(work, `seen-${mode}.json`);
      const result = spawnSync(process.execPath, [launcher, 'session-start'], { encoding: 'utf8', windowsHide: true, timeout: 60_000,
        input: JSON.stringify({ session_id: sessionId, cwd, hook_event_name: 'SessionStart', source: 'startup' }),
        env: { PATH: [cliDirectory, dirname(process.execPath), ...(windows ? [join(systemRoot, 'System32')] : ['/usr/bin', '/bin'])]
          .join(delimiter), DHARMA_HOME: home, FAKE_MODE: mode, FAKE_SEEN: seen, CLAUDE_PLUGIN_ROOT: pluginRoot,
        ...(windows ? { SystemRoot: systemRoot, ComSpec: join(systemRoot, 'System32', 'cmd.exe'), PATHEXT: '.COM;.EXE;.BAT;.CMD' } : {}) } });
      const notePath = join(home, 'session-messages', 'claude-session-start-failures', `${sessionId}.json`);
      const note = existsSync(notePath) ? JSON.parse(readFileSync(notePath, 'utf8')) as Record<string, unknown> : null;
      return { home, sessionId, result, note,
        seen: existsSync(seen) ? JSON.parse(readFileSync(seen, 'utf8')) as Array<Record<string, unknown>> : null };
    };
    const reported = (run: ReturnType<typeof start>, reason: RegExp) => {
      assert.equal(run.result.status, 0, 'never blocks the session');
      assert.equal(run.result.stderr, '');
      const message = String((JSON.parse(run.result.stdout) as Record<string, unknown>).systemMessage);
      assert.match(message, /SessionStart hook did not record this session/);
      assert.ok(message.includes(recovery(run.sessionId)), message);
      assert.deepEqual({ ...(run.note ?? {}), at: undefined, reason: undefined }, { schema: 'dharma.claude-session-start-failure/v1',
        sessionId: run.sessionId, cwd, at: undefined, state: 'failed', reason: undefined, recovery: recovery(run.sessionId) });
      assert.match(String(run.note!.reason), reason);
    };
    const failed = start('fail');
    reported(failed, /^cli_exit_2$/);
    assert.deepEqual(failed.seen!.map(note => [note.sessionId, note.state]), [[failed.sessionId, 'pending']],
      'the note exists before the CLI runs, so a hook killed at its timeout still leaves it');
    reported(start('silent'), /^record_missing$/);
    reported(start('missing', missing), /^(cli_unavailable|cli_exit_\d+)$/);
    const recorded = start('record');
    assert.deepEqual([recorded.result.status, recorded.result.stdout, recorded.result.stderr], [0, '', '']);
    assert.equal(recorded.note, null, 'a recorded session leaves no note');
    // attach reads the note: the stable code first, then why and the exact one-line recovery.
    const host: SessionMessagingHost = { home: failed.home, cwd, env: {}, now: () => new Date(),
      device: async () => { throw new Error('device_must_not_be_read'); },
      transport: async () => { throw new Error('transport_must_not_open'); } };
    await assert.rejects(sessionNamesCommand('attach', new Map<string, string | boolean>([['provider', 'claude'], ['current', true],
      ['name', 'ops-claude'], ['yes', true]]), host), (error: unknown) => {
      const { message } = error as Error;
      assert.match(message, /^claude_current_session_unavailable: /);
      assert.match(message, /SessionStart hook/);
      assert.match(message, /cli_exit_2/);
      assert.ok(message.includes(recovery(failed.sessionId)), message);
      return true;
    });
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
