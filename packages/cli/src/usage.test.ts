import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { commandExitCode, formatCommandOutput, run } from './index.js';
import * as usage from './usage.js';
import { CLI_USAGE } from './usage.js';

type UsageTable = Record<string, { synopsis: string; summary: string }>;

// Every route of the CLI dispatch table in index.ts: run() plus the organization, managed-evaluation,
// assistant and named-session sub-dispatchers. `capture` is the legacy alias of `evidence capture`;
// `help` and `version` are the global --help and --version.
const DISPATCHED_COMMANDS = [
  'bootstrap', 'setup codex', 'onboard', 'login', 'status', 'signing-recovery',
  'sessions start', 'sessions serve', 'sessions status', 'sessions readiness', 'sessions work', 'sessions stop',
  'sessions quiesce', 'sessions resume', 'sessions reconcile-stopped-lock', 'sessions audit',
  'demo connect', 'demo transport-connect', 'demo status', 'demo package', 'demo package-status', 'demo watch',
  'demo watch-enable', 'demo watch-status', 'demo watch-disable', 'demo role', 'demo peers', 'demo ask', 'demo reply',
  'demo inbox', 'demo ack', 'demo resume', 'demo signing-client-proof', 'demo signing-owner-proof',
  'providers list',
  'repositories discover', 'repositories connect', 'repositories list', 'repositories metadata', 'repositories status',
  'repositories snapshot', 'repositories source-resolve', 'repositories restore', 'repositories recover-installer',
  'repositories role-register', 'repositories role-discover', 'repositories ask', 'repositories reply',
  'workspace add', 'workspace sync', 'workspace recover-registry',
  'evidence preview', 'evidence capture', 'evidence capture-batch', 'evidence sync', 'evidence run-request',
  'relay container-entrypoint', 'relay probe', 'relay start', 'relay supervise', 'relay stop', 'relay upgrade',
  'relay autostart status', 'relay autostart pause', 'relay autostart disable',
  'assistant chat', 'assistant history', 'assistant status', 'assistant approve', 'assistant reject',
  'organization status', 'agents list', 'agents bind-runtime',
  'evaluations validate', 'evaluations launch', 'evaluations status', 'evaluations results',
  'experiments list', 'experiments run', 'failures list', 'remediations list', 'remediations act',
  'tasks list', 'tasks dispatch', 'tasks run-once', 'handoffs list', 'handoffs dispatch',
  'skills list', 'skills release', 'skills rollout', 'skills rollback', 'skills sync', 'skills status', 'skills verify',
  'usage list',
];
const ALIAS_OR_GLOBAL_COMMANDS = ['capture', 'help', 'version'];

/** Routes compared against `command`, `subcommand`, `positional[2]` or the session `action` in the dispatchers. */
function dispatchTable(source: string) {
  const ast = ts.createSourceFile('index.ts', source, ts.ScriptTarget.Latest, true);
  const refers = (node: ts.Node, name: string): boolean => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'String'
      && node.arguments.length === 1) return refers(node.arguments[0]!, name);
    if (name === 'positional[2]') return ts.isElementAccessExpression(node) && ts.isIdentifier(node.expression)
      && node.expression.text === 'positional' && ts.isNumericLiteral(node.argumentExpression)
      && node.argumentExpression.text === '2';
    return ts.isIdentifier(node) && node.text === name;
  };
  const equality: ts.SyntaxKind[] = [ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken];
  const literals = (node: ts.Node, name: string | undefined): string[] => {
    const found = new Set<string>();
    if (!name) return [];
    const visit = (child: ts.Node) => {
      if (ts.isBinaryExpression(child) && equality.includes(child.operatorToken.kind)) {
        if (refers(child.left, name) && ts.isStringLiteral(child.right)) found.add(child.right.text);
        if (refers(child.right, name) && ts.isStringLiteral(child.left)) found.add(child.left.text);
      }
      if (ts.isCallExpression(child) && ts.isPropertyAccessExpression(child.expression)
        && child.expression.name.text === 'includes' && ts.isArrayLiteralExpression(child.expression.expression)
        && child.arguments.length === 1 && refers(child.arguments[0]!, name)) {
        for (const element of child.expression.expression.elements) if (ts.isStringLiteral(element)) found.add(element.text);
      }
      ts.forEachChild(child, visit);
    };
    visit(node);
    return [...found];
  };
  const keys = new Set<string>(), commands = new Set<string>();
  const collect = (functionName: string, names: { command?: string; sub: string; third?: string }, fixed?: string) => {
    const declaration = ast.statements.find((node): node is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(node) && node.name?.text === functionName);
    assert.ok(declaration?.body, `Missing dispatcher ${functionName}`);
    type Scope = { command?: string; sub?: string };
    const record = (scope: Scope, node: ts.Node) => {
      for (const command of literals(node, names.command)) commands.add(command);
      if (!scope.command) return;
      for (const sub of literals(node, names.sub)) keys.add(`${scope.command} ${sub}`);
      if (scope.sub) for (const third of literals(node, names.third)) keys.add(`${scope.command} ${scope.sub} ${third}`);
    };
    const narrow = (scope: Scope, condition: ts.Expression): Scope => {
      const ownCommands = literals(condition, names.command), ownSubs = literals(condition, names.sub);
      if (ownCommands.length > 1) return {};
      return { command: ownCommands[0] ?? scope.command,
        sub: ownSubs.length === 1 ? ownSubs[0] : ownSubs.length ? undefined : scope.sub };
    };
    const visit = (node: ts.Node, scope: Scope): void => {
      if (ts.isIfStatement(node)) {
        const own = narrow(scope, node.expression);
        record(own, node.expression);
        visit(node.thenStatement, own);
        if (node.elseStatement) visit(node.elseStatement, scope);
      } else if (ts.isBinaryExpression(node) || ts.isCallExpression(node)) record(scope, node);
      else ts.forEachChild(node, child => visit(child, scope));
    };
    visit(declaration.body, { command: fixed });
  };
  collect('run', { command: 'command', sub: 'subcommand', third: 'positional[2]' });
  collect('runOrganizationCommand', { command: 'command', sub: 'subcommand' });
  collect('runManagedEvaluationCommand', { sub: 'subcommand' }, 'evaluations');
  collect('runAssistantCommand', { sub: 'subcommand' }, 'assistant');
  collect('namedSessionCommand', { sub: 'action' }, 'sessions');
  return { keys, commands };
}

async function withIsolatedHome<T>(operation: (home: string, requests: string[]) => Promise<T>): Promise<T> {
  const home = await mkdtemp(join(tmpdir(), 'dharma-command-help-'));
  const previous = process.env.DHARMA_HOME, originalFetch = globalThis.fetch, requests: string[] = [];
  process.env.DHARMA_HOME = home;
  globalThis.fetch = (async (input: string | URL | Request) => {
    requests.push(String(input instanceof Request ? input.url : input));
    throw new Error('network_forbidden_in_command_help_fixture');
  }) as typeof fetch;
  try { return await operation(home, requests); } finally {
    globalThis.fetch = originalFetch;
    if (previous === undefined) delete process.env.DHARMA_HOME; else process.env.DHARMA_HOME = previous;
  }
}

function runBin(argv: string[], home: string) {
  return spawnSync(process.execPath, [fileURLToPath(new URL('./bin.js', import.meta.url)), ...argv],
    { encoding: 'utf8', env: { ...process.env, DHARMA_HOME: home } });
}

test('every command and subcommand in the CLI dispatch table has a COMMAND_USAGE entry', async () => {
  const { keys, commands } = dispatchTable(await readFile(new URL('../src/index.ts', import.meta.url), 'utf8'));
  for (const key of ['tasks run-once', 'handoffs dispatch', 'relay supervise', 'sessions serve', 'sessions quiesce',
    'sessions resume', 'repositories source-resolve', 'repositories restore', 'setup codex', 'relay autostart pause']) {
    assert.ok(keys.has(key), `Dispatch extraction missed ${key}`);
  }
  const unlisted = [...keys].filter(key => !DISPATCHED_COMMANDS.includes(key)
    && !DISPATCHED_COMMANDS.some(entry => entry.startsWith(`${key} `)));
  assert.deepEqual(unlisted, [], 'A dispatched route is missing from DISPATCHED_COMMANDS');
  assert.deepEqual([...commands].filter(command => !ALIAS_OR_GLOBAL_COMMANDS.includes(command)
    && !DISPATCHED_COMMANDS.some(entry => entry.split(' ')[0] === command)), []);

  const table = Reflect.get(usage, 'COMMAND_USAGE') as UsageTable | undefined;
  const documented = table && typeof table === 'object' ? Object.keys(table)
    : (/^Usage: dharma <([^>]+)>/.exec(CLI_USAGE)?.[1] ?? '').split('|');
  const undocumented = DISPATCHED_COMMANDS.filter(key => !documented.includes(key));
  assert.deepEqual(undocumented, [], `Dispatched commands without a usage entry: ${undocumented.join(', ')}`);
  assert.ok(table && typeof table === 'object', 'COMMAND_USAGE must be an exported table keyed by command');
  assert.deepEqual([...documented].sort(), [...DISPATCHED_COMMANDS].sort(), 'Usage entries must match dispatched commands');
  for (const [key, entry] of Object.entries(table)) {
    assert.ok(entry.synopsis === key || entry.synopsis.startsWith(`${key} `), `Synopsis must start with ${key}`);
    assert.ok(entry.summary.trim() && !/\n/.test(entry.summary) && !/\n/.test(entry.synopsis), `Usage for ${key} is one line`);
  }
  const listed = (/^Usage: dharma <([^>]+)> \[options\]/.exec(CLI_USAGE)?.[1] ?? '').split('|');
  assert.deepEqual(listed, Object.keys(table), 'The top-level usage line lists every usage entry');
  assert.equal(await run(['capture', '--help']), await run(['evidence', 'capture', '--help']));
  assert.match(String(await run(['capture', '--help'])), /^Usage: dharma evidence capture /);
});

/** True when the first `--apply` of a synopsis sits directly inside an optional `[...]` group. */
function offersOptionalApply(synopsis: string) {
  const groups: string[] = [];
  for (let index = 0; index < synopsis.length; index += 1) {
    const character = synopsis[index]!;
    if (character === '[' || character === '(') groups.push(character);
    else if (character === ']' || character === ')') groups.pop();
    else if (synopsis.startsWith('--apply', index) && !/[\w-]/.test(synopsis[index + '--apply'.length] ?? '')) {
      return groups.at(-1) === '[';
    }
  }
  return false;
}

test('a command whose --apply is optional states its default plan in its usage summary', () => {
  // Without --apply these handlers return a plan or dry run (for example namedSessionCommand for
  // sessions start/serve/stop/quiesce/resume), so a summary must not present the --apply effect as the default.
  const optional = Object.entries(usage.COMMAND_USAGE).filter(([, entry]) => offersOptionalApply(entry.synopsis));
  const keys = optional.map(([key]) => key);
  assert.ok(keys.includes('sessions serve') && keys.includes('signing-recovery'), 'Optional --apply detection');
  assert.ok(!keys.includes('repositories restore') && !keys.includes('repositories recover-installer'),
    'A required --dry-run | --apply choice is not an optional --apply');
  const unstated = optional.filter(([, entry]) => !/^Plans\b|; --apply \w/.test(entry.summary)).map(([key]) => key);
  assert.deepEqual(unstated, [], `Summaries that present the --apply effect as the default: ${unstated.join(', ')}`);
});

test('tasks run-once --help and -h print that command usage and exit 0 without running the task handler', async () => {
  await withIsolatedHome(async (home, requests) => {
    const policy = join(home, 'checkout', '.dharma', 'approved-policy.json');
    for (const argv of [['tasks', 'run-once', '--help'], ['tasks', 'run-once', '-h'],
      ['tasks', 'run-once', '--policy', policy, '--workspace-id', 'synthetic-workspace', '-h']]) {
      // Without the help guard the handler resolves --policy against the local registry and enrollment,
      // which this empty DHARMA_HOME cannot satisfy, so the call would reject instead of returning usage.
      const output = await run(argv);
      assert.equal(typeof output, 'string', argv.join(' '));
      assert.match(String(output), /^Usage: dharma tasks run-once --policy /, argv.join(' '));
      assert.notEqual(output, CLI_USAGE);
      assert.equal(commandExitCode(argv, output), 0);
      assert.equal(formatCommandOutput(output), `${String(output)}\n`);
    }
    const shipped = runBin(['tasks', 'run-once', '--help'], home);
    assert.equal(shipped.status, 0, shipped.stderr);
    assert.equal(shipped.stderr, '');
    assert.match(shipped.stdout, /^Usage: dharma tasks run-once --policy /);
    assert.equal(shipped.stdout, `${String(await run(['tasks', 'run-once', '--help']))}\n`);
    assert.deepEqual(requests, [], 'Command help must not touch the network');
    assert.deepEqual(await readdir(home), [], 'Command help must not create device, registry or vault state');
  });
});

test('unknown commands keep the full usage error and full help output', async () => {
  await withIsolatedHome(async (home, requests) => {
    for (const argv of [['unknown'], ['constructor'], ['tasks', 'unknown-subcommand']]) {
      await assert.rejects(run(argv), (error: unknown) => error instanceof Error && error.message === CLI_USAGE);
    }
    for (const argv of [['--help'], ['unknown', '--help'], ['constructor', '--help']]) {
      assert.equal(await run(argv), CLI_USAGE, argv.join(' '));
    }
    const failed = runBin(['unknown'], home);
    assert.equal(failed.status, 2);
    assert.equal(failed.stdout, '');
    assert.equal(failed.stderr, `${CLI_USAGE}\n`);
    for (const flag of ['--help', '-h']) {
      const help = runBin(['unknown', flag], home);
      assert.equal(help.status, 0, help.stderr);
      assert.equal(help.stdout, `${CLI_USAGE}\n`);
    }
    assert.deepEqual(requests, []);
    assert.deepEqual(await readdir(home), []);
  });
});

test('help preserves named-session, signing and transport recovery command surfaces together', async () => {
  const help = await run(['--help']);
  assert.equal(help, CLI_USAGE);
  for (const command of ['sessions start', 'sessions status', 'sessions work', 'sessions stop', 'sessions audit',
    'demo signing-client-proof', 'demo signing-owner-proof', 'demo transport-connect', 'repositories source-resolve']) {
    assert.ok(CLI_USAGE.includes(command), `Missing command: ${command}`);
  }
});

test('shipped CLI instructions describe the bounded exact-work audit', async () => {
  const readme = await readFile(new URL('../README.md', import.meta.url), 'utf8');
  assert.match(readme, /sessions audit --name NAME --workspace-id WORKSPACE_UUID --work-id WORK_UUID/);
  assert.match(readme, /does not export raw/);
});

test('source resolution dispatch rejects duplicate flags, extra positionals and valued switches before device access', async () => {
  for (const args of [
    ['repositories', 'source-resolve', 'extra'],
    ['repositories', 'source-resolve', '--prepare', '--prepare'],
    ['repositories', 'source-resolve', '--workspace-id', 'fixture', '--prepare=true'],
    ['repositories', 'source-resolve', '--workspace-id', 'fixture', '--unknown'],
  ]) await assert.rejects(run(args), /repository_source_resolution_option_invalid/);
});

test('runtime release identity matches the installed CLI package', async () => {
  const metadata = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.deepEqual(await run(['--version']), { version: metadata.version });
});
