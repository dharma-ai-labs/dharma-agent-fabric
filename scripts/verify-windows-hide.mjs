// Static guard: every Node.js child process started from repository code must
// pass `windowsHide: true`. Without it, a console child (PowerShell, cmd.exe,
// git, node) started by a process that has no console of its own opens a
// visible terminal window on Windows and takes focus.
//
// A call passes when one of its arguments is an object literal that contains
// `windowsHide: true`. A child_process function used as a value (passed as a
// dependency, stored, or re-exported) cannot be checked statically and is
// reported too; wrap it in a function that adds the option instead.
import { readdirSync, readFileSync } from 'node:fs';
import { extname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

export const scannedRoots = ['apps', 'packages', 'plugins', 'scripts'];
const sourceExtensions = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.mjs', '.cjs']);
const skippedDirectories = new Set(['node_modules', 'dist', 'coverage', '.dharma-test']);
const childProcessModules = new Set(['child_process', 'node:child_process']);
const processFunctions = new Set(['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']);

export function listSourceFiles(repository, roots = scannedRoots) {
  const files = [];
  const walk = (directory) => {
    let entries;
    try { entries = readdirSync(directory, { withFileTypes: true }); }
    catch (error) {
      if (error?.code === 'ENOENT') return;
      throw error;
    }
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!skippedDirectories.has(entry.name)) walk(path);
      } else if (entry.isFile() && sourceExtensions.has(extname(entry.name)) && !entry.name.endsWith('.d.ts')) {
        files.push(path);
      }
    }
  };
  for (const root of roots) walk(resolve(repository, root));
  return files;
}

const scriptKind = (fileName) => {
  const extension = extname(fileName);
  if (extension === '.tsx') return ts.ScriptKind.TSX;
  if (extension === '.ts' || extension === '.mts' || extension === '.cts') return ts.ScriptKind.TS;
  return ts.ScriptKind.JS;
};

// A one-file program: the checker resolves each identifier to its declaration,
// so a local name that shadows an imported one is not mistaken for it.
const singleFileProgram = (realName, sourceText) => {
  // A fixed POSIX name: the compiler host is asked for the normalized form of the root name.
  const fileName = `/scan${extname(realName)}`;
  const source = ts.createSourceFile(fileName, sourceText, ts.ScriptTarget.Latest, true, scriptKind(fileName));
  const options = { allowJs: true, noResolve: true, noLib: true, noEmit: true, types: [] };
  const host = ts.createCompilerHost(options, true);
  host.getSourceFile = (name) => (name === fileName ? source : undefined);
  host.fileExists = (name) => name === fileName;
  host.readFile = (name) => (name === fileName ? sourceText : undefined);
  host.getDefaultLibFileName = () => 'lib.d.ts';
  const program = ts.createProgram({ rootNames: [fileName], options, host });
  if (program.getSourceFile(fileName) !== source) throw new Error(`could not bind ${realName}`);
  return { source, checker: program.getTypeChecker() };
};

const isChildProcessSpecifier = (node) => Boolean(node) && ts.isStringLiteralLike(node) && childProcessModules.has(node.text);

const unwrap = (node) => {
  let current = node;
  while (current && (ts.isAwaitExpression(current) || ts.isParenthesizedExpression(current)
    || ts.isAsExpression(current) || ts.isNonNullExpression(current))) {
    current = current.expression;
  }
  return current;
};

// `require('node:child_process')` or `await import('node:child_process')`.
const isChildProcessLoad = (node) => {
  const expression = unwrap(node);
  if (!expression || !ts.isCallExpression(expression)) return false;
  const isRequire = ts.isIdentifier(expression.expression) && expression.expression.text === 'require';
  const isDynamicImport = expression.expression.kind === ts.SyntaxKind.ImportKeyword;
  return (isRequire || isDynamicImport) && isChildProcessSpecifier(expression.arguments[0]);
};

const propertyName = (name) => (name && (ts.isIdentifier(name) || ts.isStringLiteralLike(name)) ? name.text : undefined);

const hasWindowsHide = (argument) => {
  const expression = unwrap(argument);
  if (!expression || !ts.isObjectLiteralExpression(expression)) return false;
  return expression.properties.some((property) => ts.isPropertyAssignment(property)
    && propertyName(property.name) === 'windowsHide'
    && unwrap(property.initializer)?.kind === ts.SyntaxKind.TrueKeyword);
};

const isPromisify = (node) => {
  const callee = unwrap(node);
  return Boolean(callee) && ((ts.isIdentifier(callee) && callee.text === 'promisify')
    || (ts.isPropertyAccessExpression(callee) && callee.name.text === 'promisify'));
};

const isDeclarationSite = (node) => {
  const parent = node.parent;
  if (!parent) return false;
  if (ts.isImportSpecifier(parent) || ts.isImportClause(parent) || ts.isNamespaceImport(parent)) return true;
  if (ts.isBindingElement(parent)) return true;
  if (ts.isVariableDeclaration(parent) && parent.name === node) return true;
  if (ts.isParameter(parent) && parent.name === node) return true;
  if (ts.isPropertyAccessExpression(parent) && parent.name === node) return true;
  if (ts.isPropertyAssignment(parent) && parent.name === node) return true;
  return ts.isTypeQueryNode(parent) || ts.isQualifiedName(parent);
};

export function findMissingWindowsHide(sourceText, fileName = 'source.ts') {
  const { source, checker } = singleFileProgram(fileName, sourceText);
  const functionSymbols = new Map(); // declaration symbol -> child_process function name
  const namespaceSymbols = new Set(); // declaration symbols bound to the whole module
  const symbolOf = (identifier) => {
    if (identifier.parent && ts.isShorthandPropertyAssignment(identifier.parent) && identifier.parent.name === identifier) {
      return checker.getShorthandAssignmentValueSymbol(identifier.parent);
    }
    return checker.getSymbolAtLocation(identifier);
  };
  const bindFunction = (identifier, name) => {
    const symbol = symbolOf(identifier);
    if (symbol) functionSymbols.set(symbol, name);
  };
  const bindNamespace = (identifier) => {
    const symbol = symbolOf(identifier);
    if (symbol) namespaceSymbols.add(symbol);
  };

  const collect = (node) => {
    if (ts.isImportDeclaration(node) && isChildProcessSpecifier(node.moduleSpecifier) && node.importClause) {
      const clause = node.importClause;
      if (clause.name) bindNamespace(clause.name);
      const bindings = clause.namedBindings;
      if (bindings && ts.isNamespaceImport(bindings)) bindNamespace(bindings.name);
      if (bindings && ts.isNamedImports(bindings)) {
        for (const element of bindings.elements) {
          const imported = (element.propertyName ?? element.name).text;
          if (processFunctions.has(imported)) bindFunction(element.name, imported);
        }
      }
    }
    if (ts.isVariableDeclaration(node) && node.initializer && isChildProcessLoad(node.initializer)) {
      if (ts.isIdentifier(node.name)) bindNamespace(node.name);
      else if (ts.isObjectBindingPattern(node.name)) {
        for (const element of node.name.elements) {
          const imported = propertyName(element.propertyName ?? element.name);
          if (ts.isIdentifier(element.name) && processFunctions.has(imported)) bindFunction(element.name, imported);
        }
      }
    }
    ts.forEachChild(node, collect);
  };
  collect(source);

  function processFunctionOf(node) {
    const expression = unwrap(node);
    if (!expression) return undefined;
    if (ts.isIdentifier(expression)) {
      const symbol = symbolOf(expression);
      return symbol ? functionSymbols.get(symbol) : undefined;
    }
    if (ts.isPropertyAccessExpression(expression) && ts.isIdentifier(expression.expression)
      && processFunctions.has(expression.name.text) && namespaceSymbols.has(symbolOf(expression.expression))) {
      return expression.name.text;
    }
    if (ts.isCallExpression(expression) && isPromisify(expression.expression) && expression.arguments.length === 1) {
      return processFunctionOf(expression.arguments[0]);
    }
    return undefined;
  }

  // `const run = promisify(execFile)` or `const original = childProcess.spawn`
  // makes `run` or `original` a checked process function too.
  const isAliasDeclaration = (node) => ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)
    && Boolean(node.initializer) && Boolean(processFunctionOf(node.initializer));
  const bindAliases = (node) => {
    if (isAliasDeclaration(node)) bindFunction(node.name, processFunctionOf(node.initializer));
    ts.forEachChild(node, bindAliases);
  };
  bindAliases(source);

  const findings = [];
  const report = (node, name, kind) => {
    const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
    findings.push({ line: line + 1, name, kind, text: node.getText(source).split('\n')[0].trim().slice(0, 120) });
  };

  const visit = (node) => {
    if (ts.isTypeNode(node) || isAliasDeclaration(node)) return;
    if (ts.isCallExpression(node)) {
      const name = processFunctionOf(node.expression);
      if (name) {
        if (!node.arguments.some(hasWindowsHide)) report(node, name, 'call');
        for (const argument of node.arguments) visit(argument);
        return;
      }
      if (isPromisify(node.expression) && node.arguments.length === 1 && processFunctionOf(node.arguments[0])) {
        // `promisify(execFile)` is checked where the promisified function is called.
        const parent = node.parent;
        const calledNow = parent && ts.isCallExpression(parent) && parent.expression === node;
        if (!calledNow) report(node, processFunctionOf(node.arguments[0]), 'reference');
        return;
      }
    }
    if (ts.isIdentifier(node) && !isDeclarationSite(node)) {
      const symbol = symbolOf(node);
      if (symbol && functionSymbols.has(symbol)) report(node, functionSymbols.get(symbol), 'reference');
    } else if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression)
      && processFunctions.has(node.name.text) && namespaceSymbols.has(symbolOf(node.expression))) {
      report(node, node.name.text, 'reference');
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return findings;
}

export function scanRepository(repository) {
  const findings = [];
  for (const file of listSourceFiles(repository)) {
    const text = readFileSync(file, 'utf8');
    if (!text.includes('child_process')) continue;
    for (const finding of findMissingWindowsHide(text, file)) {
      findings.push({ file: relative(repository, file).split(sep).join('/'), ...finding });
    }
  }
  return findings;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const findings = scanRepository(resolve(import.meta.dirname, '..'));
  for (const finding of findings) {
    process.stderr.write(`${finding.file}:${finding.line}: ${finding.kind} ${finding.name}: ${finding.text}\n`);
  }
  process.stdout.write(`${JSON.stringify({ ok: findings.length === 0, missing: findings.length })}\n`);
  if (findings.length > 0) process.exitCode = 1;
}
