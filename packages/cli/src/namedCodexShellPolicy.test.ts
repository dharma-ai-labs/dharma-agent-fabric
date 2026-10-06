import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';

async function launchArguments(file: string, declaration: string) {
  const text = await readFile(new URL(`../src/${file}`, import.meta.url), 'utf8');
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const functions = source.statements.filter(node => ts.isFunctionDeclaration(node) && node.name?.text === declaration);
  assert.equal(functions.length, 1);
  const argumentsFound: ts.ArrayLiteralExpression[] = [];
  function visit(node: ts.Node) {
    if (ts.isCallExpression(node) && node.expression.getText(source) === 'openCodexAppServerTransport') {
      const input = node.arguments[0];
      assert.ok(input && ts.isObjectLiteralExpression(input));
      const property = input.properties.find(item => ts.isPropertyAssignment(item) && item.name.getText(source) === 'argv');
      assert.ok(property && ts.isPropertyAssignment(property) && ts.isArrayLiteralExpression(property.initializer));
      argumentsFound.push(property.initializer);
    }
    ts.forEachChild(node, visit);
  }
  visit(functions[0]!);
  assert.equal(argumentsFound.length, 1);
  return argumentsFound[0]!.elements.filter(ts.isStringLiteral).map(item => item.text);
}

for (const [file, declaration] of [
  ['index.ts', 'namedSessionCommand'],
  ['codexSetupOwnedConnection.ts', 'openCodexSetupOwnedConnection'],
] as const) {
  test(`${declaration} enforces non-login tools without widening permission profiles`, async () => {
    const args = await launchArguments(file, declaration);
    const at = args.indexOf('allow_login_shell=false');
    assert.ok(at > 0, 'inherited pinned runtime must not be replaced by login-profile environment');
    assert.equal(args[at - 1], '-c');
    assert.ok(!args.includes('allow_login_shell=true'));
    assert.ok(args.includes('permissions.dharma_bridge.network={enabled=false}'));
    assert.ok(args.includes('default_permissions="dharma_bridge"'));
    assert.equal(args.at(-1), 'app-server');
    if (declaration === 'namedSessionCommand') assert.ok(args.includes('permissions.dharma_work.network={enabled=false}'));
  });
}
