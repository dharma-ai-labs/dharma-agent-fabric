import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import ts from 'typescript';

type Key = 'command' | 'subcommand' | 'third';
type Alternative = Partial<Record<Key, string>>;

// Sub-dispatchers whose own comparisons define the reachable subcommands.
// `pairs` dispatchers compare both command and subcommand themselves.
const DELEGATES: Record<string, 'subcommands' | 'pairs'> = {
  namedSessionCommand: 'subcommands',
  runAssistantCommand: 'subcommands',
  runManagedEvaluationCommand: 'subcommands',
  runOrganizationCommand: 'pairs',
};

async function sourceFile() {
  const text = await readFile(fileURLToPath(new URL('../src/index.ts', import.meta.url)), 'utf8');
  return ts.createSourceFile('index.ts', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

function declaration(source: ts.SourceFile, name: string): ts.FunctionDeclaration {
  const matches = source.statements.filter((node): node is ts.FunctionDeclaration =>
    ts.isFunctionDeclaration(node) && node.name?.text === name && node.body !== undefined);
  assert.equal(matches.length, 1, name);
  return matches[0]!;
}

function unwrap(node: ts.Expression): ts.Expression {
  let current = node;
  while (ts.isParenthesizedExpression(current) || ts.isAsExpression(current) || ts.isNonNullExpression(current)) {
    current = current.expression;
  }
  return current;
}

function subject(node: ts.Expression, names: Record<string, Key>): Key | null {
  const value = unwrap(node);
  if (ts.isIdentifier(value)) return names[value.text] ?? null;
  if (ts.isCallExpression(value) && ts.isIdentifier(value.expression) && value.expression.text === 'String'
    && value.arguments.length === 1) return subject(value.arguments[0]!, names);
  if (ts.isElementAccessExpression(value) && ts.isIdentifier(value.expression) && value.expression.text === 'positional'
    && ts.isNumericLiteral(value.argumentExpression)) {
    return (['command', 'subcommand', 'third'] as const)[Number(value.argumentExpression.text)] ?? null;
  }
  return null;
}

function literals(node: ts.Expression): string[] | null {
  const value = unwrap(node);
  if (!ts.isArrayLiteralExpression(value) || !value.elements.every(ts.isStringLiteral)) return null;
  return value.elements.map(element => (element as ts.StringLiteral).text);
}

function merge(left: Alternative, right: Alternative): Alternative | null {
  const merged: Alternative = { ...left };
  for (const [key, value] of Object.entries(right) as Array<[Key, string]>) {
    if (merged[key] !== undefined && merged[key] !== value) return null;
    merged[key] = value;
  }
  return merged;
}

function product(left: Alternative[], right: Alternative[]): Alternative[] {
  return left.flatMap(a => right.map(b => merge(a, b)).filter((value): value is Alternative => value !== null));
}

// Disjunctive normal form of the command selectors in one condition. Anything
// that is not a positive selector comparison leaves the selectors unconstrained.
function alternatives(node: ts.Expression, names: Record<string, Key>): Alternative[] {
  const value = unwrap(node);
  if (ts.isBinaryExpression(value)) {
    if (value.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) {
      return product(alternatives(value.left, names), alternatives(value.right, names));
    }
    if (value.operatorToken.kind === ts.SyntaxKind.BarBarToken) {
      return [...alternatives(value.left, names), ...alternatives(value.right, names)];
    }
    if (value.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken) {
      for (const [side, other] of [[value.left, value.right], [value.right, value.left]] as const) {
        const key = subject(side, names);
        const literal = unwrap(other);
        if (key && ts.isStringLiteral(literal)) return [{ [key]: literal.text }];
      }
    }
    return [{}];
  }
  if (ts.isCallExpression(value) && ts.isPropertyAccessExpression(value.expression)
    && value.expression.name.text === 'includes' && value.arguments.length === 1) {
    const options = literals(value.expression.expression);
    const key = subject(value.arguments[0]!, names);
    if (options && key) return options.map(option => ({ [key]: option }));
  }
  return [{}];
}

function calledDelegates(node: ts.Node): string[] {
  const found = new Set<string>();
  const visit = (child: ts.Node) => {
    if (ts.isCallExpression(child) && ts.isIdentifier(child.expression) && DELEGATES[child.expression.text]) {
      found.add(child.expression.text);
    }
    ts.forEachChild(child, visit);
  };
  visit(node);
  return [...found];
}

// Every positive selector comparison anywhere in a sub-dispatcher.
function delegateSubcommands(source: ts.SourceFile, name: string): string[] {
  const names: Record<string, Key> = name === 'namedSessionCommand' ? { action: 'subcommand' } : { subcommand: 'subcommand' };
  const found = new Set<string>();
  const visit = (child: ts.Node) => {
    if (ts.isExpression(child)) {
      for (const alternative of alternatives(child, names)) if (alternative.subcommand) found.add(alternative.subcommand);
    }
    ts.forEachChild(child, visit);
  };
  visit(declaration(source, name).body!);
  return [...found];
}

function branchEntries(statements: readonly ts.Statement[], context: Alternative[], names: Record<string, Key>,
  delegated: (name: string, alternative: Alternative) => string[], entries: Set<string>) {
  for (const statement of statements) {
    if (ts.isBlock(statement)) branchEntries(statement.statements, context, names, delegated, entries);
    if (ts.isTryStatement(statement)) branchEntries(statement.tryBlock.statements, context, names, delegated, entries);
    if (!ts.isIfStatement(statement)) continue;
    const selected = product(context, alternatives(statement.expression, names));
    const delegates = calledDelegates(statement.thenStatement);
    for (const alternative of selected) {
      if (!alternative.command) continue;
      if (delegates.length) {
        for (const name of delegates) for (const entry of delegated(name, alternative)) entries.add(entry);
      } else {
        entries.add([alternative.command, alternative.subcommand, alternative.third].filter(Boolean).join(' '));
      }
    }
    // A delegated branch is fully described by its sub-dispatcher; its local result checks are not commands.
    const inner = ts.isBlock(statement.thenStatement) ? statement.thenStatement.statements : [statement.thenStatement];
    if (!delegates.length) branchEntries(inner, selected, names, delegated, entries);
    if (statement.elseStatement) branchEntries([statement.elseStatement], context, names, delegated, entries);
  }
}

async function dispatchTable(): Promise<string[]> {
  const source = await sourceFile();
  const names: Record<string, Key> = { command: 'command', subcommand: 'subcommand' };
  const organizationPairs = new Set<string>();
  branchEntries(declaration(source, 'runOrganizationCommand').body!.statements, [{}], names, () => [], organizationPairs);
  const delegated = (name: string, alternative: Alternative) => {
    if (DELEGATES[name] === 'pairs') {
      return [...organizationPairs].filter(entry => entry.split(' ')[0] === alternative.command
        && (!alternative.subcommand || entry.split(' ')[1] === alternative.subcommand));
    }
    return delegateSubcommands(source, name).map(subcommand => `${alternative.command} ${subcommand}`);
  };
  const entries = new Set<string>();
  branchEntries(declaration(source, 'run').body!.statements, [{}], names, delegated, entries);
  // A selector that only leads to a deeper selector (for example `relay autostart`) is not itself a command.
  return [...entries].filter(entry => ![...entries].some(other => other.startsWith(`${entry} `))).sort();
}

async function documentedCommands(): Promise<string[]> {
  const document = (await readFile(new URL('../../../docs/22-cli-command-contract.md', import.meta.url), 'utf8'))
    .replaceAll('\r\n', '\n');
  const commands = new Set<string>();
  for (const block of document.matchAll(/^```[a-z]*\n([\s\S]*?)^```$/gm)) {
    for (const line of block[1]!.split('\n')) {
      if (!line.startsWith('dharma ')) continue;
      const words: string[] = [];
      for (const word of line.slice('dharma '.length).trim().split(/\s+/)) {
        if (!/^[a-z][a-z0-9-]*$/.test(word)) break;
        words.push(word);
      }
      if (words.length) commands.add(words.join(' '));
    }
  }
  return [...commands].sort();
}

test('dispatch table extraction reaches top-level, nested and delegated command branches', async () => {
  const table = await dispatchTable();
  for (const command of ['bootstrap', 'status', 'setup codex', 'relay autostart status', 'relay autostart pause',
    'sessions readiness', 'sessions reconcile-stopped-lock', 'assistant approve', 'evaluations results',
    'tasks dispatch', 'tasks run-once', 'handoffs dispatch', 'demo transport-connect', 'repositories metadata',
    'evidence capture', 'capture']) {
    assert.ok(table.includes(command), `dispatch table extraction missed ${command}`);
  }
  for (const selector of ['relay autostart', 'relay', 'sessions', 'tasks release', 'remediations act stage_evaluation']) {
    assert.ok(!table.includes(selector), `dispatch table extraction invented ${selector}`);
  }
});

test('every dispatched CLI command is documented in the command contract', async () => {
  const documented = new Set(await documentedCommands());
  const undocumented = (await dispatchTable()).filter(command => !documented.has(command));
  assert.deepEqual(undocumented, [], `dispatched but not documented in docs/22-cli-command-contract.md: ${undocumented.join(', ')}`);
});

test('every command documented in the command contract is in the CLI dispatch table', async () => {
  const table = new Set(await dispatchTable());
  const unknown = (await documentedCommands()).filter(command => !table.has(command));
  assert.deepEqual(unknown, [], `documented but not dispatched: ${unknown.join(', ')}`);
});

const CLI_SOURCE = new URL('../src/', import.meta.url);
const REPOSITORY = new URL('../../../', import.meta.url);

async function repositoryText(path: string): Promise<string> {
  return (await readFile(new URL(path, REPOSITORY), 'utf8')).replaceAll('\r\n', '\n');
}

async function cliSourceFile(name: string): Promise<ts.SourceFile> {
  const text = await readFile(new URL(name, CLI_SOURCE), 'utf8');
  return ts.createSourceFile(name, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

// Prose only: fenced blocks removed, each paragraph on one line.
function proseParagraphs(document: string): string[] {
  return document.replace(/^```[^\n]*\n[\s\S]*?^```$/gm, '').split(/\n\s*\n/)
    .map(paragraph => paragraph.replace(/\s+/g, ' ').trim()).filter(Boolean);
}

function sentences(document: string): string[] {
  return proseParagraphs(document).flatMap(paragraph => paragraph.split(/(?<=[.:;])\s+/));
}

// Dispatched commands re-invoked through the CLI entry script: an argv array in
// which a non-literal entry expression is followed by the command words, such as
// `[fileURLToPath(import.meta.url), 'relay', 'start', '--policy', path]`. Provider
// binaries called with literal argv only (`hermes skills list`) do not match.
function argvEntries(node: ts.Node, commands: Set<string>): Set<string> {
  const found = new Set<string>();
  const visit = (child: ts.Node) => {
    if (ts.isArrayLiteralExpression(child)) {
      const words = child.elements.map(element => ts.isStringLiteral(element) ? element.text : null);
      for (let index = 1; index + 1 < words.length; index += 1) {
        const entry = `${words[index]} ${words[index + 1]}`;
        if (words[index - 1] === null && words[index] !== null && words[index + 1] !== null && commands.has(entry)) {
          found.add(entry);
        }
      }
    }
    ts.forEachChild(child, visit);
  };
  visit(node);
  return found;
}

function calledFunctions(node: ts.Node): Set<string> {
  const found = new Set<string>();
  const visit = (child: ts.Node) => {
    if (ts.isCallExpression(child) && ts.isIdentifier(child.expression)) found.add(child.expression.text);
    ts.forEachChild(child, visit);
  };
  visit(node);
  return found;
}

// The `run` branches that select a command positively, including enclosing family branches.
function commandBranches(statements: readonly ts.Statement[], context: Alternative[], target: Alternative,
  branches: ts.Statement[]) {
  const names: Record<string, Key> = { command: 'command', subcommand: 'subcommand' };
  for (const statement of statements) {
    if (ts.isBlock(statement)) commandBranches(statement.statements, context, target, branches);
    if (ts.isTryStatement(statement)) commandBranches(statement.tryBlock.statements, context, target, branches);
    if (!ts.isIfStatement(statement)) continue;
    const selected = product(context, alternatives(statement.expression, names));
    if (selected.some(alternative => alternative.command !== undefined && merge(alternative, target) !== null)) {
      branches.push(statement.thenStatement);
    }
    const inner = ts.isBlock(statement.thenStatement) ? statement.thenStatement.statements : [statement.thenStatement];
    commandBranches(inner, selected, target, branches);
    if (statement.elseStatement) commandBranches([statement.elseStatement], context, target, branches);
  }
}

// Every other dispatched entry a command can start: argv built in its dispatch
// branch or in any index.ts function that branch reaches through direct calls.
function launchedBy(source: ts.SourceFile, command: string, commands: Set<string>): Set<string> {
  const functions = new Map<string, ts.FunctionDeclaration[]>();
  for (const statement of source.statements) {
    if (!ts.isFunctionDeclaration(statement) || !statement.name || !statement.body) continue;
    functions.set(statement.name.text, [...(functions.get(statement.name.text) ?? []), statement]);
  }
  const [first, second, third] = command.split(' ');
  const target: Alternative = { command: first!, ...(second ? { subcommand: second } : {}), ...(third ? { third } : {}) };
  const branches: ts.Statement[] = [];
  commandBranches(declaration(source, 'run').body!.statements, [{}], target, branches);
  assert.ok(branches.length, `no dispatch branch selects ${command}`);
  const launched = new Set(branches.flatMap(branch => [...argvEntries(branch, commands)]));
  const queue = branches.flatMap(branch => [...calledFunctions(branch)]);
  const seen = new Set<string>();
  while (queue.length) {
    const name = queue.pop()!;
    if (seen.has(name)) continue;
    seen.add(name);
    for (const fn of functions.get(name) ?? []) {
      for (const entry of argvEntries(fn.body!, commands)) launched.add(entry);
      queue.push(...calledFunctions(fn.body!));
    }
  }
  launched.delete(command);
  return launched;
}

interface LaunchClaim { launchers: string[]; launched: string; prose: string }

// Clauses such as "`sessions start` launches `sessions serve`" or
// "`bootstrap` and `onboard` start `relay supervise`".
function launchClaims(document: string, commands: Set<string>): LaunchClaim[] {
  const claims: LaunchClaim[] = [];
  for (const paragraph of proseParagraphs(document)) {
    for (const clause of paragraph.split(/[.:;](?:\s|$)|,\s+(?:and|as do|while)\s+/)) {
      const match = /^(.*?)\b(?:launch|launches|run|runs|start|starts|spawn|spawns) `([^`]+)`/.exec(clause);
      if (!match || !commands.has(match[2]!)) continue;
      const launchers = [...match[1]!.matchAll(/`([^`]+)`/g)].map(found => found[1]!).filter(name => commands.has(name));
      claims.push({ launchers, launched: match[2]!, prose: clause });
    }
  }
  return claims;
}

// Launchers named in prose that are not dispatched commands, and the module that builds their argv.
const PROSE_LAUNCHERS: Array<[string, string]> = [
  ['owned startup entry', 'relayAutostart.ts'],
  ['container entrypoint', 'containerRelayLifecycle.ts'],
];

test('documented launches of internal CLI entries are the launches the source performs', async () => {
  const source = await sourceFile();
  const commands = new Set(await dispatchTable());
  const claims = launchClaims(await repositoryText('docs/22-cli-command-contract.md'), commands);
  for (const claim of claims) {
    for (const launcher of claim.launchers) {
      assert.ok(launchedBy(source, launcher, commands).has(claim.launched),
        `docs/22 says \`${launcher}\` starts \`${claim.launched}\`, but no code reached from its dispatch branch builds that argv: "${claim.prose}"`);
    }
    for (const [phrase, file] of PROSE_LAUNCHERS) {
      if (!claim.prose.includes(phrase)) continue;
      assert.ok(argvEntries(await cliSourceFile(file), commands).has(claim.launched),
        `docs/22 says the ${phrase} starts \`${claim.launched}\`, but ${file} never builds that argv`);
    }
  }
  const launchedEntries = new Set([...commands].flatMap(command => [...launchedBy(source, command, commands)]));
  assert.ok(launchedEntries.has('relay start') && launchedEntries.has('relay supervise'),
    'launch extraction missed the relay supervisor and receiver');
  for (const entry of launchedEntries) {
    assert.ok(claims.some(claim => claim.launched === entry && claim.launchers.some(launcher =>
      launchedBy(source, launcher, commands).has(entry))),
    `docs/22 does not say which command starts \`${entry}\``);
  }
});

// Option checks reachable only from bootstrap-host callbacks, not from a typed command.
const INTERNAL_OPTION_REFUSALS = new Set(['codex_setup_portal_command_mismatch', 'codex_setup_host_command_mismatch',
  'setup_session_scope_changed', 'setup_child_unavailable']);
// Typed commands whose fixed option set refuses `--json`, by refusal code.
const JSON_REFUSALS: Record<string, string> = {
  codex_setup_ingress_options_invalid: 'setup codex',
  named_session_audit_unavailable: 'sessions audit',
  named_session_diagnostic_invalid: 'sessions readiness --diagnostic',
  container_entrypoint_options_forbidden: 'relay container-entrypoint',
};

function thrownCodes(node: ts.Node): string[] {
  const codes: string[] = [];
  const visit = (child: ts.Node) => {
    if (ts.isThrowStatement(child)) {
      const thrown = unwrap(child.expression);
      if ((ts.isNewExpression(thrown) || ts.isCallExpression(thrown)) && ts.isIdentifier(thrown.expression)
        && thrown.expression.text === 'Error' && thrown.arguments?.[0] && ts.isStringLiteral(thrown.arguments[0])) {
        codes.push(thrown.arguments[0].text.split(/[:\s]/)[0]!);
      }
    }
    ts.forEachChild(child, visit);
  };
  visit(node);
  return codes;
}

function stringLiterals(node: ts.Node): Set<string> {
  const found = new Set<string>();
  const visit = (child: ts.Node) => {
    if (ts.isStringLiteral(child)) found.add(child.text);
    ts.forEachChild(child, visit);
  };
  visit(node);
  return found;
}

// Refusal codes of option checks that admit only a fixed set of flags, and whether that set admits `json`.
async function fixedOptionRefusals(): Promise<Map<string, boolean>> {
  const refusals = new Map<string, boolean>();
  const files = (await readdir(CLI_SOURCE)).filter(name => name.endsWith('.ts') && !name.endsWith('.test.ts'));
  for (const file of files) {
    const source = await cliSourceFile(file);
    const visit = (node: ts.Node, scope: ts.Node) => {
      const nextScope = ts.isFunctionLike(node) ? node : scope;
      if (ts.isIfStatement(node)
        && /\[\.\.\.(?:\w+\.)?flags(?:\.keys\(\))?\]|\bflags\.size\b/.test(node.expression.getText())) {
        const admitted = stringLiterals(node.expression);
        const referenced = new Set<string>();
        const names = (child: ts.Node) => {
          if (ts.isIdentifier(child)) referenced.add(child.text);
          ts.forEachChild(child, names);
        };
        names(node.expression);
        const declarations = (child: ts.Node) => {
          if (ts.isVariableDeclaration(child) && ts.isIdentifier(child.name) && referenced.has(child.name.text)
            && child.initializer) for (const literal of stringLiterals(child.initializer)) admitted.add(literal);
          ts.forEachChild(child, declarations);
        };
        declarations(nextScope);
        for (const code of thrownCodes(node.thenStatement)) {
          refusals.set(code, (refusals.get(code) ?? false) || admitted.has('json'));
        }
      }
      ts.forEachChild(node, child => visit(child, nextScope));
    };
    visit(source, source);
  }
  return refusals;
}

test('the command contract names every typed command whose fixed option set refuses --json', async () => {
  const refusals = await fixedOptionRefusals();
  assert.equal(refusals.get('device_signing_maintenance_options_invalid'), true, 'option-set extraction missed signing-recovery');
  const refusing = [...refusals].filter(([, admitsJson]) => !admitsJson).map(([code]) => code)
    .filter(code => !INTERNAL_OPTION_REFUSALS.has(code)).sort();
  assert.deepEqual(refusing, Object.keys(JSON_REFUSALS).sort(), 'the typed commands whose option set refuses --json changed');
  const modes = (await repositoryText('docs/22-cli-command-contract.md')).split(/^## /m)
    .find(section => section.startsWith('Human and machine modes'));
  assert.ok(modes, 'docs/22 has no Human and machine modes section');
  const rule = sentences(modes!).filter(sentence => sentence.includes('`--json`'));
  assert.ok(rule.length, 'docs/22 does not state the --json rule');
  assert.ok(!rule.some(sentence => /\baccepted\b/.test(sentence) && !/\breject/.test(sentence)),
    `docs/22 says --json is accepted without naming the commands that reject it: ${rule.join(' ')}`);
  for (const command of Object.values(JSON_REFUSALS)) {
    assert.ok(rule.some(sentence => /\breject/.test(sentence) && sentence.includes(`\`${command}\``)),
      `docs/22 does not say that \`${command}\` rejects --json`);
  }
});

// Documents that describe what the CLI prints and how it reaches conversations.
const CLI_DOCUMENTS = [
  'packages/cli/README.md',
  'docs/22-cli-command-contract.md',
  'docs/24-provider-session-routing.md',
  'docs/onboarding/customer-guide.md',
  'plugins/claude/dharma-agent-fabric/README.md',
  'plugins/claude/dharma-agent-fabric/skills/dharma-agent-fabric-setup/references/client-routes.md',
];

test('conversation denials are scoped to provider conversations because assistant chat continues control-agent ones', async () => {
  const source = await sourceFile();
  assert.ok((await dispatchTable()).includes('assistant chat'), 'assistant chat is not dispatched');
  const assistant = declaration(source, 'runAssistantCommand').body!.getText();
  assert.ok(assistant.includes("'session-id'") && assistant.includes('.submitControlAgentMessage('),
    'assistant chat no longer submits into an existing control-agent session');
  const catalog = JSON.parse(await repositoryText('plugins/dharma-agent-fabric/openai-app/mcp-tool-catalog.json')) as
    { tools: Array<{ name: string }> };
  assert.ok(catalog.tools.some(tool => tool.name === 'fabric_control_agent_send_message'),
    'the MCP catalog no longer has fabric_control_agent_send_message');
  for (const path of CLI_DOCUMENTS) {
    const document = await repositoryText(path);
    for (const sentence of sentences(document)) {
      if (/\bno\b[^.]*\bcommand\b[^.]*\battach/i.test(sentence)) {
        assert.match(sentence, /\bprovider (?:conversation|chat)/i,
          `${path} denies attachment to every conversation, but assistant chat continues control-agent sessions: "${sentence}"`);
        if (/\bMCP\b/.test(sentence)) {
          assert.ok(document.includes('`assistant chat`') && document.includes('`fabric_control_agent_'),
            `${path} denies CLI and MCP attachment without naming the control-agent exception`);
        }
      }
      assert.doesNotMatch(sentence, /\bonly retained conversations\b/i,
        `${path} calls named sessions the only retained conversations: "${sentence}"`);
    }
  }
});

test('no CLI document says every command prints JSON, because help prints text', async () => {
  const index = (await sourceFile()).getText();
  assert.match(index, /if \(flags\.has\('help'\) \|\| command === 'help'\) return USAGE;/);
  assert.match(index, /export function formatCommandOutput\(value:unknown\):string\{\s*if\(typeof value==='string'\)return value\+'\\n';/);
  for (const path of CLI_DOCUMENTS) {
    for (const sentence of sentences(await repositoryText(path))) {
      assert.doesNotMatch(sentence, /\bevery command\b[^.]*\bprints? JSON\b/i, `${path}: "${sentence}"`);
    }
  }
});
