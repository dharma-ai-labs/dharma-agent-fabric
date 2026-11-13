import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { posix, resolve } from 'node:path';
import { test } from 'node:test';
import ts from 'typescript';
import { parseRelayRequest } from './protocol.js';

// Guard for issue #463: the device client and this gateway each keep their own idea of the signed
// routes, and nothing else ties them. This test reads the client SOURCE (no hand-copied route list),
// finds every `signedGet(` / `signedPost(` call, works out the paths that call can build, and feeds
// each one to `parseRelayRequest`. A call it cannot read fails the test with its file and line.

type Method = 'GET' | 'POST';
/** A node is a function or an object literal that is still to be read. */
type Value = string | number | URLSearchParams | ts.Node;
interface Scope {
  /** Parameter values while the guard reads the body of a called function. */
  env: Map<string, Value[]>;
  fn?: ts.Node;
  depth: number;
  parse(file: string): ts.SourceFile | undefined;
}
interface Site { file: string; line: number; method: Method; text: string; routes: string[] }
interface HandWritten { file: string; text: string; routes: string[]; why: string }

const SIGNED: Record<string, Method> = { signedGet: 'GET', signedPost: 'POST' };
const HASH = 'sha256:9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08';
const MESSAGE_ID = '2c9a5e7f-1b43-4d86-9a3c-0e6f8b4d7c52';

// Example values, by the name the client code uses (a variable, or the last part of `a.b.name`).
// A name listed here always wins over a declaration in the client. A name that is missing fails the
// guard, so a new route parameter needs one line here with a value in its real shape.
const EXAMPLES: Record<string, (string | number)[]> = {
  workspaceId: ['3f2b8c1e-9a47-4d2b-b6f1-0c5e7a9d4b21'],
  repositoryAgentId: ['7c1d4e9a-2b3f-4a6c-9e8d-1f0a2b3c4d5e'],
  candidateId: ['a4e1c7b2-5d38-4f9a-8c06-2e7b9d1f3a54'],
  questionId: ['0b9e6d3c-7a12-4c8f-a5e4-9d2c1b0f8e37'],
  requestId: ['d2a7f4c9-1e56-4b83-9f20-6c3e8a5b7d14'],
  taskId: ['5e8c2a1f-4b97-4d30-8a6c-7f1e9b2d0c43'],
  decisionId: ['9f3a6b0d-8c25-4e71-b4d9-3a7c5e1f2b68'],
  bundleId: ['c6d1e8f3-0a74-4b29-9c5e-8b2f4a7d1e90'],
  sessionId: ['e7b4d2a9-3c61-4f58-a0d7-4b8e6c1f9a25'],
  id: ['1a5f9c3e-6d82-4a07-8e4b-5c9d2f7a3b16'],
  messageId: [MESSAGE_ID],
  originalMessageId: [MESSAGE_ID],
  operationId: [HASH],
  sha256: [HASH],
  provider: ['codex', 'claude', 'agy', 'hermes'],
  category: ['release-notes', `a${'b'.repeat(63)}`],
  path: ['src/app/index.ts', 'docs/Release Notes/v1.2_final-draft.md', `${'a'.repeat(120)}/${'a'.repeat(120)}/b b b.md`],
  afterSequence: [0, Number.MAX_SAFE_INTEGER],
  fileIndex: [0, 511],
  chunkIndex: [0, 1023],
};

// Call sites the guard cannot read, with the routes they send written by hand. `text` is the exact
// source of the call (white space collapsed), so an edit to the call brings the failure back. An
// entry that no longer matches an unreadable call also fails.
const HAND_WRITTEN: HandWritten[] = [
  { file: 'packages/cli/src/signedRequestAdmission.ts', text: 'signedGet.call(fabric, route)', routes: [],
    why: 'Wraps fabric.signedGet in place. Each route comes from a caller of fabric.signedGet, which the guard reads.' },
  { file: 'packages/cli/src/signedRequestAdmission.ts', text: 'signedPost.call(fabric, route, body)', routes: [],
    why: 'Wraps fabric.signedPost in place. Each route comes from a caller of fabric.signedPost, which the guard reads.' },
];

// Client routes the gateway is known to reject, each with the issue that decides what happens to it.
// An entry has to go as soon as the gateway accepts its route or the client stops sending it.
const KNOWN_REJECTED: { method: Method; route: string; issue: string }[] = [
  { method: 'POST', route: '/agent-fabric/codex-task-exports', issue: 'https://github.com/dharma-ai-labs/dharma-agent-fabric/issues/464' },
];

class Unresolved extends Error {}
const brief = (node: ts.Node) => node.getText().replace(/\s+/g, ' ').slice(0, 100);
const lineOf = (node: ts.Node) => node.getSourceFile().getLineAndCharacterOfPosition(node.getStart()).line + 1;
const fail = (node: ts.Node, reason: string): never => {
  throw new Unresolved(`${reason} (${node.getSourceFile().fileName}:${lineOf(node)})`);
};
const product = <A, B, C>(left: A[], right: B[], join: (a: A, b: B) => C) => left.flatMap(a => right.map(b => join(a, b)));
const isNode = (value: Value): value is ts.Node => typeof value === 'object' && !(value instanceof URLSearchParams);
const outside = (scope: Scope): Scope => ({ ...scope, env: new Map(), fn: undefined, depth: scope.depth + 1 });
const texts = (values: Value[], node: ts.Node) => values.map(value => isNode(value)
  ? fail(node, `\`${brief(node)}\` is not text`) : String(value));
const binds = (name: ts.BindingName, text: string): boolean => ts.isIdentifier(name) ? name.text === text
  : name.elements.some(element => !ts.isOmittedExpression(element) && binds(element.name, text));
const isMemberName = (node: ts.Identifier) => (ts.isPropertyAccessExpression(node.parent) || ts.isPropertyAssignment(node.parent)
  || ts.isMethodDeclaration(node.parent) || ts.isMethodSignature(node.parent) || ts.isPropertySignature(node.parent))
  && node.parent.name === node;

/** The declaration a name refers to at its place of use, by the ordinary scope rules. */
function declarationOf(use: ts.Identifier): ts.Node | undefined {
  const among = (list: ts.VariableDeclarationList) => list.declarations.find(item => binds(item.name, use.text));
  for (let scope: ts.Node | undefined = use.parent; scope; scope = scope.parent) {
    let found: ts.Node | undefined;
    if (ts.isFunctionLike(scope)) found = scope.parameters.find(parameter => binds(parameter.name, use.text));
    else if (ts.isForStatement(scope) || ts.isForOfStatement(scope) || ts.isForInStatement(scope)) {
      if (scope.initializer && ts.isVariableDeclarationList(scope.initializer)) found = among(scope.initializer);
    }
    for (const statement of (scope as { statements?: readonly ts.Statement[] }).statements ?? []) {
      if (found) break;
      if (ts.isFunctionDeclaration(statement) && statement.name?.text === use.text) found = statement;
      else if (ts.isVariableStatement(statement)) found = among(statement.declarationList);
      else if (ts.isImportDeclaration(statement) && statement.importClause?.namedBindings
        && ts.isNamedImports(statement.importClause.namedBindings)) {
        found = statement.importClause.namedBindings.elements.find(element => element.name.text === use.text);
      }
    }
    if (found) return found;
  }
  return undefined;
}

/** Every value an expression in the client can take, with EXAMPLES standing in for run-time data. */
function evaluate(node: ts.Expression, scope: Scope): Value[] {
  if (scope.depth > 12) return fail(node, 'the route is built through too many calls for the guard to follow');
  if (ts.isStringLiteralLike(node)) return [node.text];
  if (ts.isNumericLiteral(node)) return [Number(node.text)];
  if (ts.isParenthesizedExpression(node) || ts.isNonNullExpression(node) || ts.isAsExpression(node)) return evaluate(node.expression, scope);
  if (ts.isTemplateExpression(node)) {
    return node.templateSpans.reduce((sofar, span) => product(sofar, texts(evaluate(span.expression, scope), span.expression),
      (left, right) => left + right + span.literal.text), [node.head.text]);
  }
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    return product(texts(evaluate(node.left, scope), node.left), texts(evaluate(node.right, scope), node.right), (left, right) => left + right);
  }
  if (ts.isConditionalExpression(node)) return [...evaluate(node.whenTrue, scope), ...evaluate(node.whenFalse, scope)];
  if (ts.isArrowFunction(node) || ts.isFunctionExpression(node) || ts.isObjectLiteralExpression(node)) return [node];
  if (ts.isIdentifier(node)) return named(node, scope);
  if (ts.isPropertyAccessExpression(node)) return member(node, scope);
  if (ts.isNewExpression(node)) return searchParams(node, scope);
  if (ts.isCallExpression(node)) return called(node, scope);
  return fail(node, `the guard cannot read \`${brief(node)}\``);
}

function named(use: ts.Identifier, scope: Scope): Value[] {
  const bound = scope.env.get(use.text);
  if (bound) return bound;
  if (Object.hasOwn(EXAMPLES, use.text)) return EXAMPLES[use.text]!;
  const declaration = declarationOf(use);
  if (!declaration) return fail(use, `\`${use.text}\` has no example value in EXAMPLES and no declaration the guard can find`);
  return declared(declaration, use, scope.fn && declaration.pos >= scope.fn.pos && declaration.end <= scope.fn.end ? scope : outside(scope));
}

function declared(declaration: ts.Node, use: ts.Identifier, scope: Scope): Value[] {
  if (ts.isFunctionDeclaration(declaration)) return [declaration];
  if (ts.isParameter(declaration) && ts.isIdentifier(declaration.name)) return fromCallers(declaration, use, scope);
  if (ts.isImportSpecifier(declaration)) return imported(declaration, use, scope);
  if (ts.isVariableDeclaration(declaration) && ts.isIdentifier(declaration.name) && declaration.initializer
    && ts.isVariableDeclarationList(declaration.parent) && declaration.parent.flags & ts.NodeFlags.Const) {
    const values = evaluate(declaration.initializer, scope);
    return values.some(value => value instanceof URLSearchParams) ? withLaterSets(declaration, use, values, scope) : values;
  }
  return fail(use, `\`${use.text}\` has no example value in EXAMPLES and is not a const, a function or a relative import`);
}

/** `a.b.name`: an example for `name`, or a member of a route constant such as `ROUTES.send`. */
function member(node: ts.PropertyAccessExpression, scope: Scope): Value[] {
  const leaf = node.name.text;
  if (Object.hasOwn(EXAMPLES, leaf)) return EXAMPLES[leaf]!;
  let owners: Value[];
  try { owners = evaluate(node.expression, scope); } catch (error) {
    if (!(error instanceof Unresolved)) throw error;
    return fail(node, `\`${brief(node)}\` has no example value for \`${leaf}\` in EXAMPLES and is not a route constant`);
  }
  return owners.flatMap(owner => {
    const found = isNode(owner) && ts.isObjectLiteralExpression(owner) ? owner.properties.find(item => item.name
      && (ts.isIdentifier(item.name) || ts.isStringLiteral(item.name)) && item.name.text === leaf) : undefined;
    if (found && ts.isPropertyAssignment(found)) return evaluate(found.initializer, outside(scope));
    if (found && ts.isMethodDeclaration(found)) return [found];
    return fail(node, `\`${brief(node)}\` is not a member of a route constant`);
  });
}

function searchParams(node: ts.NewExpression, scope: Scope): Value[] {
  const [init] = node.arguments ?? [];
  if (!ts.isIdentifier(node.expression) || node.expression.text !== 'URLSearchParams' || (init && !ts.isObjectLiteralExpression(init))) {
    return fail(node, `the guard cannot read \`${brief(node)}\``);
  }
  let entries: [string, string][][] = [[]];
  for (const item of init?.properties ?? []) {
    const key = item.name && (ts.isIdentifier(item.name) || ts.isStringLiteral(item.name)) ? item.name.text : undefined;
    const values = key === undefined ? undefined : ts.isPropertyAssignment(item) ? evaluate(item.initializer, scope)
      : ts.isShorthandPropertyAssignment(item) ? named(item.name, scope) : undefined;
    if (key === undefined || !values) return fail(item, `the guard cannot read the query entry \`${brief(item)}\``);
    entries = product(entries, texts(values, item), (sofar, value) => [...sofar, [key, value] as [string, string]]);
  }
  return entries.map(list => new URLSearchParams(list));
}

/** `query.set(...)` and `if (...) query.set(...)` between the declaration of a query and its use. */
function withLaterSets(declaration: ts.VariableDeclaration, use: ts.Identifier, values: Value[], scope: Scope): Value[] {
  const name = (declaration.name as ts.Identifier).text;
  const statement = declaration.parent.parent as ts.Statement;
  const statements = (statement.parent as { statements?: readonly ts.Statement[] }).statements;
  if (!statements || declaration.getSourceFile() !== use.getSourceFile() || !values.every(value => value instanceof URLSearchParams)) {
    return fail(use, `the guard cannot follow the query \`${name}\` to this use`);
  }
  const touches = (node: ts.Node): boolean => (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression)
    && node.expression.text === name) || Boolean(ts.forEachChild(node, child => touches(child) || undefined));
  const setCall = (node: ts.Statement) => {
    const call = ts.isExpressionStatement(node) ? node.expression : undefined;
    const [key, value] = call && ts.isCallExpression(call) && ts.isPropertyAccessExpression(call.expression)
      && ts.isIdentifier(call.expression.expression) && call.expression.expression.text === name
      && call.expression.name.text === 'set' && call.arguments.length === 2 ? call.arguments : [];
    return key && value && ts.isStringLiteralLike(key) ? { key: key.text, value } : undefined;
  };
  let queries = values as URLSearchParams[];
  for (const later of statements.slice(statements.indexOf(statement) + 1)) {
    const reached = later.pos <= use.pos && use.end <= later.end;
    if (touches(later)) {
      const optional = ts.isIfStatement(later) && !later.elseStatement;
      const then = optional ? later.thenStatement : later;
      const change = reached ? undefined : setCall(ts.isBlock(then) && then.statements.length === 1 ? then.statements[0]! : then);
      if (!change) return fail(later, `the query \`${name}\` is changed in a way the guard does not model`);
      const changed = product(queries, texts(evaluate(change.value, scope), change.value), (query, value) => {
        const copy = new URLSearchParams(query);
        copy.set(change.key, value);
        return copy;
      });
      queries = optional ? [...queries, ...changed] : changed;
    }
    if (reached) break;
  }
  return queries;
}

function called(node: ts.CallExpression, scope: Scope): Value[] {
  const callee = node.expression;
  const [first] = node.arguments;
  if (ts.isIdentifier(callee) && (callee.text === 'encodeURIComponent' || callee.text === 'String') && first) {
    return texts(evaluate(first, scope), first).map(callee.text === 'String' ? String : encodeURIComponent);
  }
  if (callee.getText() === 'Object.freeze' && first) return evaluate(first, scope);
  return evaluate(callee, scope).flatMap(fn => {
    if (!isNode(fn) || !ts.isFunctionLike(fn)) return fail(node, `\`${brief(callee)}\` is not a function the guard can read`);
    const env = new Map<string, Value[]>();
    fn.parameters.forEach((parameter, index) => {
      const argument = node.arguments[index] ?? parameter.initializer;
      if (ts.isIdentifier(parameter.name) && argument) env.set(parameter.name.text, evaluate(argument, scope));
    });
    const inner: Scope = { ...scope, env, fn, depth: scope.depth + 1 };
    const body = (fn as ts.FunctionLikeDeclaration).body;
    if (body && !ts.isBlock(body)) return evaluate(body, inner);
    const returned: ts.Expression[] = [];
    const visit = (child: ts.Node): void => {
      if (ts.isFunctionLike(child)) return;
      if (ts.isReturnStatement(child) && child.expression) returned.push(child.expression);
      ts.forEachChild(child, visit);
    };
    if (body) ts.forEachChild(body, visit);
    if (!returned.length) return fail(node, `\`${brief(callee)}\` returns nothing the guard can read`);
    return returned.flatMap(expression => evaluate(expression, inner));
  });
}

/** A route that arrives as a parameter of a local function: the values its callers pass. */
function fromCallers(parameter: ts.ParameterDeclaration, use: ts.Identifier, scope: Scope): Value[] {
  const fn = parameter.parent;
  const holder = ts.isFunctionDeclaration(fn) ? fn
    : (ts.isArrowFunction(fn) || ts.isFunctionExpression(fn)) && ts.isVariableDeclaration(fn.parent) ? fn.parent : undefined;
  const statement = holder && (ts.isFunctionDeclaration(holder) ? holder : holder.parent.parent);
  const name = holder?.name;
  if (!statement || !name || !ts.isIdentifier(name) || !(statement.parent as { statements?: unknown }).statements) {
    return fail(use, `\`${use.text}\` has no example value in EXAMPLES and is a parameter of a function whose callers the guard cannot find`);
  }
  if (ts.canHaveModifiers(statement) && ts.getModifiers(statement)?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword)) {
    return fail(use, `\`${use.text}\` has no example value in EXAMPLES and is a parameter of the exported \`${name.text}\`, whose callers can be in any file`);
  }
  const values: Value[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && node.text === name.text && node !== name && !isMemberName(node)) {
      const call = node.parent;
      const argument = ts.isCallExpression(call) && call.expression === node
        ? call.arguments[fn.parameters.indexOf(parameter)] ?? parameter.initializer : undefined;
      if (!argument) return fail(node, `\`${name.text}\` is used as a value or without \`${use.text}\`, so the guard cannot see every route it sends`);
      values.push(...evaluate(argument, outside(scope)));
    }
    ts.forEachChild(node, visit);
  };
  visit(statement.parent);
  return values;
}

function imported(specifier: ts.ImportSpecifier, use: ts.Identifier, scope: Scope): Value[] {
  const from = specifier.parent.parent.parent.moduleSpecifier;
  const name = (specifier.propertyName ?? specifier.name).text;
  if (!ts.isStringLiteral(from) || !from.text.startsWith('.')) {
    return fail(use, `\`${use.text}\` is imported from a package; the guard follows relative imports only`);
  }
  const file = posix.join(posix.dirname(use.getSourceFile().fileName), from.text.replace(/\.js$/, '.ts'));
  for (const statement of scope.parse(file)?.statements ?? []) {
    const declaration = ts.isFunctionDeclaration(statement) && statement.name?.text === name ? statement
      : ts.isVariableStatement(statement) ? statement.declarationList.declarations.find(item => binds(item.name, name)) : undefined;
    if (declaration) return declared(declaration, use, outside(scope));
  }
  return fail(use, `\`${name}\` is not declared in ${file}`);
}

/** `signedGet` / `signedPost` as the name of an implementation or a type member, not as a call. */
function definesTransport(name: ts.Identifier): boolean {
  const parent = name.parent;
  if (ts.isPropertyAccessExpression(parent)) { // fabric.signedGet = route => ...
    return parent.name === name && ts.isBinaryExpression(parent.parent) && parent.parent.left === parent
      && parent.parent.operatorToken.kind === ts.SyntaxKind.EqualsToken;
  }
  if (ts.isBindingElement(parent)) return parent.name === name && !parent.propertyName;
  return (ts.isMethodDeclaration(parent) || ts.isMethodSignature(parent) || ts.isPropertySignature(parent)
    || ts.isPropertyAssignment(parent)) && parent.name === name;
}

/** `signedPost(route, body) { return inner.signedPost(route, body); }`: its callers are call sites too. */
function forwards(route: ts.Expression, method: string): boolean {
  const parameter = ts.isIdentifier(route) && !Object.hasOwn(EXAMPLES, route.text) ? declarationOf(route) : undefined;
  if (!parameter || !ts.isParameter(parameter) || parameter.parent.parameters[0] !== parameter) return false;
  const fn = parameter.parent;
  const name = ts.isMethodDeclaration(fn) ? fn.name : ts.isPropertyAssignment(fn.parent) ? fn.parent.name
    : ts.isBinaryExpression(fn.parent) && ts.isPropertyAccessExpression(fn.parent.left) ? fn.parent.left.name : undefined;
  return name !== undefined && ts.isIdentifier(name) && name.text === method;
}

function outermost(node: ts.Node): ts.Node {
  const parent = node.parent;
  return ts.isPropertyAccessExpression(parent) || (ts.isCallExpression(parent) && parent.expression === node) ? outermost(parent) : node;
}

/** Every signed call in `files`, with the routes it can send, and every call the guard could not read. */
function signedRoutes(input: { files: string[]; read(file: string): string | undefined; handWritten: HandWritten[] }) {
  const parsed = new Map<string, ts.SourceFile | undefined>();
  const parse = (file: string) => {
    if (!parsed.has(file)) {
      const text = input.read(file);
      parsed.set(file, text === undefined ? undefined : ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true));
    }
    return parsed.get(file);
  };
  const scope: Scope = { env: new Map(), depth: 0, parse };
  const sites: Site[] = [];
  const problems: string[] = [];
  const used = new Set<HandWritten>();
  const record = (name: ts.Identifier, file: string) => {
    const callee = ts.isPropertyAccessExpression(name.parent) && name.parent.name === name ? name.parent : name;
    const call = ts.isCallExpression(callee.parent) && callee.parent.expression === callee ? callee.parent : undefined;
    if (!call && definesTransport(name)) return;
    const node = call ?? outermost(name);
    const site = { file, line: lineOf(node), method: SIGNED[name.text]!, text: node.getText().replace(/\s+/g, ' ') };
    try {
      const route = call ? call.arguments[0] : undefined;
      if (!route) return fail(node, 'this is not a plain call with a route, so the guard cannot tell what it sends');
      sites.push({ ...site, routes: forwards(route, name.text) ? [] : texts(evaluate(route, scope), route) });
    } catch (error) {
      if (!(error instanceof Unresolved)) throw error;
      const entry = input.handWritten.find(item => item.file === file && item.text === site.text);
      if (entry) {
        used.add(entry);
        sites.push({ ...site, routes: entry.routes });
      } else problems.push(`${file}:${site.line} \`${site.text.slice(0, 100)}\`: ${error.message}`);
    }
  };
  for (const file of input.files) {
    const visit = (node: ts.Node): void => {
      if (ts.isTypeNode(node)) return;
      if (ts.isIdentifier(node) && Object.hasOwn(SIGNED, node.text)) record(node, file);
      ts.forEachChild(node, visit);
    };
    const source = /\bsigned(?:Get|Post)\b/.test(input.read(file) ?? '') ? parse(file) : undefined;
    if (source) visit(source);
  }
  for (const entry of input.handWritten) {
    if (!used.has(entry)) problems.push(`${entry.file} \`${entry.text}\`: this hand-written entry matches no call the guard cannot read; remove it`);
  }
  return { sites, problems };
}

const request = {
  requestId: '8eca231c-e9d2-40e5-bf9c-445ddfeee094',
  headers: {
    'content-type': 'application/json',
    'x-dharma-device-id': 'd327bcce-2314-4c92-a6b7-13ec5570c1ee',
    'x-dharma-session-id': '93d01b40-a824-4cb1-a8ff-aa8ec9819bb1',
    'x-dharma-message-id': '8eca231c-e9d2-40e5-bf9c-445ddfeee094',
    'x-dharma-timestamp': new Date().toISOString(), 'x-dharma-nonce': 'N0nc3_With-Enough_Entropy',
    'x-dharma-sequence': '1', 'x-dharma-signature': 'A'.repeat(86),
    'idempotency-key': '8eca231c-e9d2-40e5-bf9c-445ddfeee094',
  },
};

/** What the gateway says to a correctly signed request for a client route: 'accepted' or its error. */
function gatewayVerdict(method: Method, route: string): string {
  // The client prefixes every route with /api/v1/orgs/<organizationId> (relay-client `#signedRequestWithSigningControl`).
  const pathname = `/api/v1/orgs/org_example${route}`;
  try {
    parseRelayRequest({ ...request, method, pathname, body: method === 'GET' ? '' : '{}' });
    return 'accepted';
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

function rejectedByGateway(sites: Site[], known: { method: Method; route: string }[] = []): string[] {
  const verdicts = new Map<string, string>();
  for (const site of sites) {
    for (const route of site.routes) {
      const key = `${site.method} ${route}`;
      if (known.some(entry => entry.method === site.method && entry.route === route)) continue;
      if (!verdicts.has(key)) verdicts.set(key, `${key} -> ${gatewayVerdict(site.method, route)} (${site.file}:${site.line})`);
    }
  }
  return [...verdicts.values()].filter(line => !line.includes(' -> accepted ('));
}

const repository = resolve(import.meta.dirname, '../../..');
const clientFiles = ['packages', 'apps'].flatMap(parent => readdirSync(resolve(repository, parent)).flatMap(name => {
  const source = `${parent}/${name}/src`;
  if (!existsSync(resolve(repository, source))) return [];
  return readdirSync(resolve(repository, source), { recursive: true, encoding: 'utf8' })
    .map(entry => `${source}/${entry.replaceAll('\\', '/')}`)
    .filter(file => file.endsWith('.ts') && !file.endsWith('.test.ts') && !file.endsWith('.d.ts'));
})).sort();
const client = signedRoutes({
  files: clientFiles,
  read: file => existsSync(resolve(repository, file)) ? readFileSync(resolve(repository, file), 'utf8') : undefined,
  handWritten: HAND_WRITTEN,
});

const fixture = (files: Record<string, string[]>, handWritten: HandWritten[] = []) => signedRoutes({
  files: Object.keys(files), read: file => files[file]?.join('\n'), handWritten,
});

test('the guard reads every signed call in the client source', () => {
  assert.deepEqual(client.problems, []);
  for (const [file, method, route] of [
    ['packages/relay-client/src/index.ts', 'POST', '/agent-fabric/sessions'],
    ['packages/relay-client/src/index.ts', 'GET', '/control-agent/sessions'],
    ['packages/cli/src/providerSessionChannel.ts', 'POST', '/agent-fabric/provider-sessions'],
  ]) {
    assert.ok(client.sites.some(site => site.file === file && site.method === method && site.routes.includes(route!)),
      `${method} ${route} was not found in ${file}: the guard is not reading the client source`);
  }
});

test('the gateway allowlist accepts every signed route the client source builds', () => {
  assert.deepEqual(rejectedByGateway(client.sites, KNOWN_REJECTED), []);
});

test('a known rejection is still sent by the client and still rejected by the gateway', () => {
  for (const { method, route, issue } of KNOWN_REJECTED) {
    assert.ok(client.sites.some(site => site.method === method && site.routes.includes(route)),
      `The client no longer sends ${method} ${route}. Remove it from KNOWN_REJECTED (${issue}).`);
    assert.equal(gatewayVerdict(method, route), 'route_not_allowed',
      `The gateway no longer rejects ${method} ${route} as before. Remove it from KNOWN_REJECTED (${issue}).`);
  }
});

test('the guard reads named route constants, and catches the session-messaging defect of 2026-11-13', () => {
  // The shape of the session-messaging client: routes kept in one constant, some built by a function.
  const { sites, problems } = fixture({
    'packages/cli/src/sessionMessageClient.ts': [
      'function messageRoute(messageId: string, leaf: string) {',
      "  if (!UUID.test(messageId)) throw new Error('session_message_id_invalid');",
      '  return `/agent-fabric/session-messages/${messageId}/${leaf}`;',
      '}',
      'export const SESSION_MESSAGE_ROUTES = Object.freeze({',
      "  attach: '/agent-fabric/session-names/attach',",
      "  directory: '/agent-fabric/session-names',",
      "  send: '/agent-fabric/session-messages',",
      "  poll: '/agent-fabric/session-messages/poll',",
      "  delivery: (messageId: string) => messageRoute(messageId, 'delivery'),",
      "  delivered: (messageId: string) => messageRoute(messageId, 'delivered'),",
      "  ack: (messageId: string) => messageRoute(messageId, 'ack'),",
      "  reply: (messageId: string) => messageRoute(messageId, 'reply'),",
      '});',
      'export const read = (transport: Transport, messageId: string) => transport.signedGet(SESSION_MESSAGE_ROUTES.delivery(messageId));',
      'export const send = (transport: Transport, body: unknown) => transport.signedPost(SESSION_MESSAGE_ROUTES.send, body);',
      'export const poll = (transport: Transport, body: unknown) => transport.signedPost(SESSION_MESSAGE_ROUTES.poll, body);',
      'export const delivered = (transport: Transport, messageId: string) => transport.signedPost(SESSION_MESSAGE_ROUTES.delivered(messageId), {});',
      'export const ack = (transport: Transport, messageId: string) => transport.signedPost(SESSION_MESSAGE_ROUTES.ack(messageId), {});',
      'export const reply = (transport: Transport, input: { originalMessageId: string }) =>',
      '  transport.signedPost(SESSION_MESSAGE_ROUTES.reply(input.originalMessageId), {});',
    ],
    'packages/cli/src/sessionNames.ts': [
      "import { SESSION_MESSAGE_ROUTES } from './sessionMessageClient.js';",
      'export const attach = (transport: Transport, body: unknown) => transport.signedPost(SESSION_MESSAGE_ROUTES.attach, body);',
      'export const directory = async (host: Host) => (await host.transport()).signedGet(SESSION_MESSAGE_ROUTES.directory);',
    ],
  });
  assert.deepEqual(problems, []);
  assert.deepEqual(sites.flatMap(site => site.routes.map(route => `${site.method} ${route}`)).sort(), [
    `GET /agent-fabric/session-messages/${MESSAGE_ID}/delivery`,
    'GET /agent-fabric/session-names',
    'POST /agent-fabric/session-messages',
    `POST /agent-fabric/session-messages/${MESSAGE_ID}/ack`,
    `POST /agent-fabric/session-messages/${MESSAGE_ID}/delivered`,
    `POST /agent-fabric/session-messages/${MESSAGE_ID}/reply`,
    'POST /agent-fabric/session-messages/poll',
    'POST /agent-fabric/session-names/attach',
  ]);
  // Before the allowlist had these eight routes (fixed in #460), each line below was a rejection.
  assert.deepEqual(rejectedByGateway(sites), []);
});

test('the guard reports a client route that the gateway allowlist does not have', () => {
  const { sites, problems } = fixture({ 'packages/cli/src/widgets.ts': [
    'export function listWidgets(fabric: Client, workspaceId: string) {',
    '  const query = new URLSearchParams({ workspaceId });',
    "  if (fabric.archived) query.set('archived', 'true');",
    '  return fabric.signedGet(`/agent-fabric/widgets?${query}`);',
    '}',
    "export const sendWidget = (fabric: Client, body: unknown) => fabric.signedPost('/agent-fabric/widgets', body);",
  ] });
  assert.deepEqual(problems, []);
  assert.deepEqual(rejectedByGateway(sites), [
    `GET /agent-fabric/widgets?workspaceId=${EXAMPLES.workspaceId![0]} -> route_not_allowed (packages/cli/src/widgets.ts:4)`,
    `GET /agent-fabric/widgets?workspaceId=${EXAMPLES.workspaceId![0]}&archived=true -> route_not_allowed (packages/cli/src/widgets.ts:4)`,
    'POST /agent-fabric/widgets -> route_not_allowed (packages/cli/src/widgets.ts:6)',
  ]);
  // The right route with the wrong method is a rejection too.
  assert.equal(gatewayVerdict('POST', '/agent-fabric/tasks/poll'), 'accepted');
  assert.equal(gatewayVerdict('GET', '/agent-fabric/tasks/poll'), 'route_not_allowed');
});

test('a signed call the guard cannot read fails with its file and line, unless its routes are written by hand', () => {
  const files = { 'packages/cli/src/widgets.ts': [
    'export function forward(fabric: Client, route: string) {',
    '  return fabric.signedPost(route, {});',
    '}',
    'export const readWidget = (fabric: Client, widgetId: string) =>',
    '  fabric.signedGet(`/agent-fabric/widgets/${encodeURIComponent(widgetId)}`);',
    'export const later = (fabric: Client) => setTimeout(fabric.signedGet, 1000);',
  ] };
  const { problems } = fixture(files);
  assert.equal(problems.length, 3);
  assert.match(problems[0]!, /^packages\/cli\/src\/widgets\.ts:2 `fabric\.signedPost\(route, \{\}\)`: `route` has no example value in EXAMPLES and is a parameter of the exported `forward`/);
  assert.match(problems[1]!, /^packages\/cli\/src\/widgets\.ts:5 .*`widgetId` has no example value in EXAMPLES/);
  assert.match(problems[2]!, /^packages\/cli\/src\/widgets\.ts:6 `fabric\.signedGet`: this is not a plain call with a route/);

  const byHand = [
    { file: 'packages/cli/src/widgets.ts', text: 'fabric.signedPost(route, {})', routes: ['/agent-fabric/tasks/poll'], why: 'test' },
    { file: 'packages/cli/src/widgets.ts', text: 'fabric.signedGet(`/agent-fabric/widgets/${encodeURIComponent(widgetId)}`)',
      routes: ['/agent-fabric/widgets/7'], why: 'test' },
    { file: 'packages/cli/src/widgets.ts', text: 'fabric.signedGet', routes: [], why: 'test' },
  ];
  const covered = fixture(files, byHand);
  assert.deepEqual(covered.problems, []);
  // Routes written by hand go through the allowlist like the routes read from the source.
  assert.deepEqual(rejectedByGateway(covered.sites), ['GET /agent-fabric/widgets/7 -> route_not_allowed (packages/cli/src/widgets.ts:5)']);

  const stale = fixture({ 'packages/cli/src/widgets.ts': ["export const poll = (fabric: Client) => fabric.signedPost('/agent-fabric/tasks/poll', {});"] }, byHand.slice(0, 1));
  assert.match(stale.problems.join('\n'), /^packages\/cli\/src\/widgets\.ts `fabric\.signedPost\(route, \{\}\)`: this hand-written entry matches no call/);
});
