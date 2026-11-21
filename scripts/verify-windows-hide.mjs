// Static guard: every Node.js child process started from repository code must
// pass `windowsHide: true`. Without it, a console child (PowerShell, cmd.exe,
// git, node) started by a process that has no console of its own opens a
// visible terminal window on Windows and takes focus.
//
// A call passes when one of its arguments is an object literal whose last spread
// or `windowsHide` member is `windowsHide: true`. A child_process function used
// as a value (passed as a dependency, stored, or re-exported) cannot be checked
// statically and is reported too; wrap it in a function that adds the option
// instead. The same holds for the module itself: it may be read from,
// destructured or loaded into a name, and any other use is reported.
import { readdirSync, readFileSync } from 'node:fs';
import { extname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

export const scannedRoots = ['apps', 'packages', 'plugins', 'scripts'];
const sourceExtensions = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.mjs', '.cjs']);
const skippedDirectories = new Set(['node_modules', 'dist', 'coverage', '.dharma-test']);
const childProcessModules = new Set(['child_process', 'node:child_process']);
const processFunctions = new Set(['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']);

// Release publishers whose exact text is pinned by SHA-256 in the publication
// workflows. They run only on Linux release runners, where windowsHide has no
// effect, and any edit changes the reviewed publisher pin.
export const pinnedPublishers = new Set([
  'scripts/publish-device-maintenance.mjs',
  'scripts/publish-security-recovery.mjs',
  'scripts/publish-signing-upgrade.mjs',
]);

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

const isWrapper = (node) => ts.isAwaitExpression(node) || ts.isParenthesizedExpression(node)
  || ts.isAsExpression(node) || ts.isNonNullExpression(node);

const unwrap = (node) => {
  let current = node;
  while (current && isWrapper(current)) current = current.expression;
  return current;
};

// The outermost `await`, parenthesis, `as` or `!` wrapped around `node`.
const outermost = (node) => {
  let current = node;
  while (current.parent && isWrapper(current.parent)) current = current.parent;
  return current;
};

const propertyName = (name) => (name && (ts.isIdentifier(name) || ts.isStringLiteralLike(name)) ? name.text : undefined);

// The last spread or `windowsHide` member of the literal decides: a spread or a
// duplicate after `windowsHide: true` can set the flag back to false.
const hasWindowsHide = (argument) => {
  const expression = unwrap(argument);
  if (expression && ts.isConditionalExpression(expression)) {
    return hasWindowsHide(expression.whenTrue) && hasWindowsHide(expression.whenFalse);
  }
  if (!expression || !ts.isObjectLiteralExpression(expression)) return false;
  const deciding = expression.properties.filter((property) => ts.isSpreadAssignment(property)
    || propertyName(property.name) === 'windowsHide').at(-1);
  return Boolean(deciding) && ts.isPropertyAssignment(deciding)
    && unwrap(deciding.initializer)?.kind === ts.SyntaxKind.TrueKeyword;
};

const calleeNamed = (node, name) => {
  const callee = unwrap(node);
  return Boolean(callee) && ((ts.isIdentifier(callee) && callee.text === name)
    || (ts.isPropertyAccessExpression(callee) && callee.name.text === name));
};
const isPromisify = (node) => calleeNamed(node, 'promisify');
const isCreateRequire = (node) => calleeNamed(node, 'createRequire');

// `mock.method(childProcess, 'spawn', replacement)` replaces the function in place.
// The replacement's own calls and every call made through the module are still checked.
const isMockMethodTarget = (node) => {
  const call = node.parent;
  if (!call || !ts.isCallExpression(call) || call.arguments[0] !== node) return false;
  const callee = call.expression;
  if (!ts.isPropertyAccessExpression(callee) || callee.name.text !== 'method') return false;
  return calleeNamed(callee.expression, 'mock');
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
  const requireSymbols = new Set(); // names bound to `createRequire(...)`
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

  // `require`, a name bound to `createRequire(...)`, or `createRequire(...)` itself.
  const isRequire = (callee) => {
    const expression = unwrap(callee);
    if (!expression) return false;
    if (ts.isIdentifier(expression)) return expression.text === 'require' || requireSymbols.has(symbolOf(expression));
    return ts.isCallExpression(expression) && isCreateRequire(expression.expression);
  };
  // `require('node:child_process')` or `await import('node:child_process')`.
  const isChildProcessLoad = (node) => {
    const expression = unwrap(node);
    if (!expression || !ts.isCallExpression(expression)) return false;
    const isDynamicImport = expression.expression.kind === ts.SyntaxKind.ImportKeyword;
    return (isDynamicImport || isRequire(expression.expression)) && isChildProcessSpecifier(expression.arguments[0]);
  };
  // The whole module: a namespace name or a load expression.
  const isModule = (node) => {
    const expression = unwrap(node);
    if (!expression) return false;
    if (ts.isIdentifier(expression)) return namespaceSymbols.has(symbolOf(expression));
    return isChildProcessLoad(expression);
  };

  const collectRequires = (node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      const initializer = unwrap(node.initializer);
      if (initializer && ts.isCallExpression(initializer) && isCreateRequire(initializer.expression)) {
        const symbol = symbolOf(node.name);
        if (symbol) requireSymbols.add(symbol);
      }
    }
    ts.forEachChild(node, collectRequires);
  };
  collectRequires(source);

  const bindPattern = (pattern) => {
    for (const element of pattern.elements) {
      const imported = propertyName(element.propertyName ?? element.name);
      if (ts.isIdentifier(element.name) && processFunctions.has(imported)) bindFunction(element.name, imported);
    }
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
      else if (ts.isObjectBindingPattern(node.name)) bindPattern(node.name);
    }
    ts.forEachChild(node, collect);
  };
  collect(source);

  // A process function is a bound name, a property or element read on the module,
  // `promisify(...)` of one, or a `||`, `??` or conditional with one as an operand.
  function processFunctionOf(node) {
    const expression = unwrap(node);
    if (!expression) return undefined;
    if (ts.isIdentifier(expression)) {
      const symbol = symbolOf(expression);
      return symbol ? functionSymbols.get(symbol) : undefined;
    }
    if (ts.isPropertyAccessExpression(expression)) {
      return processFunctions.has(expression.name.text) && isModule(expression.expression) ? expression.name.text : undefined;
    }
    if (ts.isElementAccessExpression(expression)) {
      if (!isModule(expression.expression)) return undefined;
      const key = expression.argumentExpression;
      if (!ts.isStringLiteralLike(key)) return 'child_process[computed]';
      return processFunctions.has(key.text) ? key.text : undefined;
    }
    if (ts.isCallExpression(expression) && isPromisify(expression.expression) && expression.arguments.length === 1) {
      return processFunctionOf(expression.arguments[0]);
    }
    if (ts.isBinaryExpression(expression) && (expression.operatorToken.kind === ts.SyntaxKind.BarBarToken
      || expression.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken)) {
      return processFunctionOf(expression.left) ?? processFunctionOf(expression.right);
    }
    if (ts.isConditionalExpression(expression)) {
      return processFunctionOf(expression.whenTrue) ?? processFunctionOf(expression.whenFalse);
    }
    return undefined;
  }

  // `const run = promisify(execFile)`, `const original = childProcess.spawn`,
  // `const run = probe || (await import('node:child_process')).spawnSync` and
  // `const { spawn } = childProcess` make `run`, `original` and `spawn` checked process functions too.
  const isAliasDeclaration = (node) => ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)
    && Boolean(node.initializer) && Boolean(processFunctionOf(node.initializer));
  const bindAliases = (node) => {
    if (isAliasDeclaration(node)) bindFunction(node.name, processFunctionOf(node.initializer));
    else if (ts.isVariableDeclaration(node) && ts.isObjectBindingPattern(node.name) && node.initializer
      && isModule(node.initializer)) bindPattern(node.name);
    ts.forEachChild(node, bindAliases);
  };
  bindAliases(source);

  const findings = [];
  const report = (node, name, kind) => {
    const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
    findings.push({ line: line + 1, name, kind, text: node.getText(source).split('\n')[0].trim().slice(0, 120) });
  };

  // The module may be read from (`childProcess.spawn`), destructured, or loaded
  // into a name. Any other use passes it on to code whose calls cannot be checked.
  const isCheckedModuleUse = (node, allowNamedBinding) => {
    const outer = outermost(node);
    const parent = outer.parent;
    if (!parent) return false;
    if ((ts.isPropertyAccessExpression(parent) || ts.isElementAccessExpression(parent)) && parent.expression === outer) return true;
    if (ts.isVariableDeclaration(parent) && parent.initializer === outer) {
      return ts.isObjectBindingPattern(parent.name) || (allowNamedBinding && ts.isIdentifier(parent.name));
    }
    return isMockMethodTarget(outer);
  };

  const visitExport = (node) => {
    const clause = node.exportClause;
    if (isChildProcessSpecifier(node.moduleSpecifier)) {
      if (!clause || ts.isNamespaceExport(clause)) {
        report(node, 'child_process', 'reference');
        return;
      }
      for (const element of clause.elements) {
        const exported = (element.propertyName ?? element.name).text;
        if (processFunctions.has(exported)) report(element, exported, 'reference');
      }
    } else if (!node.moduleSpecifier && clause && ts.isNamedExports(clause)) {
      for (const element of clause.elements) {
        const local = checker.getExportSpecifierLocalTargetSymbol(element);
        if (local && functionSymbols.has(local)) report(element, functionSymbols.get(local), 'reference');
        else if (local && namespaceSymbols.has(local)) report(element, 'child_process', 'reference');
      }
    }
  };

  const visit = (node) => {
    if (ts.isTypeNode(node) || isAliasDeclaration(node)) return;
    if (ts.isExportDeclaration(node)) {
      visitExport(node);
      return;
    }
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
      if (isChildProcessLoad(node)) {
        if (!isCheckedModuleUse(node, true)) report(node, 'child_process', 'reference');
        return;
      }
    }
    if (ts.isIdentifier(node) && !isDeclarationSite(node)) {
      const symbol = symbolOf(node);
      if (symbol && functionSymbols.has(symbol)) report(node, functionSymbols.get(symbol), 'reference');
      else if (symbol && namespaceSymbols.has(symbol) && !isCheckedModuleUse(node, false)) {
        report(node, 'child_process', 'reference');
      }
    } else if ((ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) && processFunctionOf(node)) {
      report(node, processFunctionOf(node), 'reference');
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
    const path = relative(repository, file).split(sep).join('/');
    if (pinnedPublishers.has(path)) continue;
    const text = readFileSync(file, 'utf8');
    if (!text.includes('child_process')) continue;
    for (const finding of findMissingWindowsHide(text, file)) findings.push({ file: path, ...finding });
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
