import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
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
