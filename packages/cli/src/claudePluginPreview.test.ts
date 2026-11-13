import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

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

test('1.0.7-preview is a separate marketplace entry and the 1.0.6 entry is unchanged', () => {
  const plugins = json('.claude-plugin/marketplace.json').plugins as Array<Record<string, unknown>>;
  assert.equal(plugins.length, 2);
  const stable = plugins.find(item => item.name === 'dharma-agent-fabric')!;
  assert.equal(stable.version, '1.0.6');
  assert.equal(stable.source, './plugins/claude/dharma-agent-fabric');
  assert.equal(json('plugins/claude/dharma-agent-fabric/.claude-plugin/plugin.json').version, '1.0.6');
  assert.equal(existsSync(join(root, 'plugins/claude/dharma-agent-fabric/hooks')), false, '1.0.6 gets no hooks');
  const preview = plugins.find(item => item.name === 'dharma-agent-fabric-preview')!;
  assert.equal(preview.version, '1.0.7-preview');
  assert.equal(preview.source, `./${PREVIEW}`);
  assert.match(String(preview.description), /preview/i);
  assert.match(String(preview.description), /prototype/i);
  const manifest = json(`${PREVIEW}/.claude-plugin/plugin.json`);
  assert.equal(manifest.name, 'dharma-agent-fabric-preview');
  assert.equal(manifest.version, '1.0.7-preview');
  assert.equal(existsSync(join(root, PREVIEW, '.mcp.json')), false, 'the add-on does not duplicate the 1.0.6 MCP server');
});

test('the preview has exactly SessionStart and UserPromptSubmit hooks, guarded to exit 0 silently; no Stop hook', () => {
  const hooks = (json(`${PREVIEW}/hooks/hooks.json`).hooks ?? {}) as Record<string, Array<{ hooks: Array<Record<string, unknown>> }>>;
  assert.deepEqual(Object.keys(hooks).sort(), ['SessionStart', 'UserPromptSubmit']);
  const command = (event: string) => {
    assert.equal(hooks[event]!.length, 1);
    assert.equal(hooks[event]![0]!.hooks.length, 1);
    const hook = hooks[event]![0]!.hooks[0]!;
    assert.equal(hook.type, 'command');
    assert.ok(Number(hook.timeout) > 0 && Number(hook.timeout) <= 15);
    return String(hook.command);
  };
  const start = command('SessionStart');
  const inbox = command('UserPromptSubmit');
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
      const direct = spawnSync(process.execPath, [launcher, action], { encoding: 'utf8', input: '{}', env: env(missing) });
      assert.deepEqual([direct.status, direct.stdout, direct.stderr], [0, '', ''], `${action} launcher without the CLI`);
      for (const [shellName, shell] of shells) {
        for (const [cliName, cliDirectory] of [['missing', missing], ['older', older], ['not attached', notAttached]] as const) {
          const [file, args] = shell(command.replaceAll('${CLAUDE_PLUGIN_ROOT}', pluginRoot));
          const result = spawnSync(file, args, { encoding: 'utf8', input: '{}', env: env(cliDirectory) });
          assert.deepEqual([result.status, result.stdout, result.stderr], [0, '', ''], `${action} via ${shellName}, CLI ${cliName}`);
        }
      }
    }
    // The attached case: the inbox output reaches Claude, the CLI's stderr does not; SessionStart output never does.
    const attached = fakeCli(0, '{"hookSpecificOutput":{}}');
    try {
      for (const [action, expected] of [['inbox', '{"hookSpecificOutput":{}}'], ['session-start', '']]) {
        const result = spawnSync(process.execPath, [launcher, action!], { encoding: 'utf8', input: '{}', env: env(attached) });
        assert.deepEqual([result.status, result.stdout.trim(), result.stderr], [0, expected, ''], `${action} attached`);
      }
    } finally { rmSync(attached, { recursive: true, force: true }); }
  } finally {
    for (const directory of [missing, older, notAttached]) rmSync(directory, { recursive: true, force: true });
  }
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
