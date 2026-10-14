import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {compileFunction} from 'node:vm';
import test from 'node:test';
import ts from 'typescript';
import {sourceRepositoryFingerprint} from './index.js';
import {currentBootstrapHostScope, prepareCodexBootstrapHost, runCodexBootstrapHostScope} from './bootstrapHostScope.js';

const uuid = (n: number) => `${String(n).padStart(8, '0')}-1111-4111-8111-111111111111`;

async function fixture() {
  const source = await readFile(new URL('../src/index.ts', import.meta.url), 'utf8');
  const ast = ts.createSourceFile('index.ts', source, ts.ScriptTarget.Latest, true);
  const functions = ast.statements.filter(ts.isFunctionDeclaration);
  const calls: string[][] = [];
  const workspace = resolve('synthetic-requalification-source');
  const remote = 'https://github.com/example/requalification.git';
  const fingerprint = sourceRepositoryFingerprint(remote).fingerprint;
  const controller = new AbortController();
  const process_ = {getuid: () => 1000, cwd: () => workspace,
    env: {DHARMA_HOME: resolve('synthetic-device'), CODEX_HOME: resolve('synthetic-provider')}};
  const metadata = {dev: 1n, ino: 2n, size: 3n, mtimeNs: 4n, ctimeNs: 5n,
    isFile: () => true, isSymbolicLink: () => false};
  let foreignSource = false;
  const dependencies: Record<string, unknown> = {
    currentBootstrapHostScope, sourceRepositoryFingerprint, process: process_,
    providerProcessEnvironment: () => ({}),
    execFileAsync: async (command: string, argv: string[], options: {signal?: AbortSignal}) => {
      assert.equal(command, 'git');
      assert.equal(options.signal?.aborted, false);
      calls.push(argv);
      if (argv.join('\0') === ['-C', workspace, 'rev-parse', '--show-toplevel'].join('\0')) return {stdout: workspace};
      assert.deepEqual(argv, ['-C', workspace, 'config', '--get', 'remote.origin.url']);
      return {stdout: foreignSource ? 'https://github.com/foreign/repository.git' : remote};
    },
  };
  const compile = (text: string, name: string) => {
    const output = ts.transpileModule(text, {compilerOptions: {target: ts.ScriptTarget.ES2023,
      module: ts.ModuleKind.CommonJS}}).outputText;
    return compileFunction(`${output}\nreturn ${name};`, ['exports', ...Object.keys(dependencies)])
      ({}, ...Object.values(dependencies));
  };
  for (const name of ['gitValue', 'preflightBootstrapWorkspaceIdentity', 'readBootstrapSourceIdentityForRequalification']) {
    const declaration = functions.find(node => node.name?.text === name);
    if (declaration) dependencies[name] = compile(declaration.getText(ast).replace(/^export /, ''), name);
  }
  const ingress = functions.find(node => node.name?.text === 'codexPortalSetup')!;
  let callback: ts.Expression | undefined;
  const visit = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === 'current') callback = node.initializer;
    ts.forEachChild(node, visit);
  };
  visit(ingress);
  assert.ok(callback, 'exercise the actual public-ingress current callback');
  const now = Date.now();
  const intent = {schema: 'dharma.codex-setup-intent/v1' as const, operationId: uuid(1), setupReference: uuid(2),
    organizationId: 'org_fixture', recipientMembershipId: uuid(3), origin: 'https://hq.example',
    repositoryFingerprint: fingerprint, policyRevision: 'policy-v1', scopeDigest: fingerprint, contractDigest: fingerprint,
    hostContextId: uuid(4), issuedAt: new Date(now - 1000).toISOString(), expiresAt: new Date(now + 60_000).toISOString()};
  Object.assign(dependencies, {controller, prepared: {intent}, currentDirectory: workspace,
    environment: {home: process_.env.DHARMA_HOME, provider: process_.env.CODEX_HOME},
    file: 'synthetic-runtime.js', runtime: metadata, uid: 1000, home: process_.env.DHARMA_HOME,
    providerHome: process_.env.CODEX_HOME, workspace, lstat: async () => metadata, privateDirectory: async () => true});
  const current = compile(`const current = ${callback.getText(ast)};`, 'current') as () => Promise<boolean>;
  let requalifications = 0;
  const prepared = prepareCodexBootstrapHost({intent, workspace, signal: controller.signal,
    current: async () => ++requalifications <= 8 && await current()});
  return {prepared, calls, controller, current, requalifications: () => requalifications,
    foreignSource: () => {foreignSource = true;}};
}

test('actual ingress source requalification inside its original scope does not re-enter the scope', async () => {
  const f = await fixture();
  try {
    const result = await runCodexBootstrapHostScope(f.prepared.scope, () => f.current());
    assert.equal(result, true);
    assert.equal(f.requalifications(), 2, 'only the before/after scope fences qualify the source');
    assert.equal(f.calls.length, 6, 'three source observations each use the two fixed metadata commands');
  } finally {f.prepared.scope.close();}
});

test('actual ingress source requalification still rejects a changed repository and cancellation', async () => {
  for (const reason of ['repository', 'cancel'] as const) {
    const f = await fixture();
    if (reason === 'repository') f.foreignSource(); else f.controller.abort();
    await assert.rejects(runCodexBootstrapHostScope(f.prepared.scope, () => f.current()), /codex_setup_host_scope_unavailable/);
    assert.ok(f.requalifications() <= 1);
    if (reason === 'cancel') assert.equal(f.calls.length, 0);
  }
});
