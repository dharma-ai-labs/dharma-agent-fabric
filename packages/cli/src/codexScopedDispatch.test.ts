import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {runInNewContext} from 'node:vm';
import test from 'node:test';
import ts from 'typescript';

test('async scoped binding lookup reserves the local question turn before yielding', async () => {
  const source = await readFile(new URL('../src/codexBoundSession.ts', import.meta.url), 'utf8');
  const ast = ts.createSourceFile('codexBoundSession.ts', source, ts.ScriptTarget.Latest, true);
  const node = ast.statements.find(item => ts.isFunctionDeclaration(item) && item.name?.text === 'openCodexBoundSession');
  assert.ok(node);
  const result = ts.transpileModule(node.getText(ast).replace('export ', ''), {
    compilerOptions: {target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.None}});
  let reads = 0, release!: () => void, enter!: () => void;
  const gate = new Promise<void>(resolve => {release = resolve;}), entered = new Promise<void>(resolve => {enter = resolve;});
  const binding = {provider: 'codex', owner: 'dharma_bridge', sessionId: 'synthetic', workspaceRoot: 'synthetic',
    maximumProviderCostCents: 1};
  const open = runInNewContext(`${result.outputText}\nopenCodexBoundSession`, {
    // Control-flow fixture only: no Linux sandbox or provider execution claim.
    process: {platform: 'linux'}, inspectSessionQuestionForBinding: () => ({ok: true}),
    runCodexBridgeQuestion: async () => ({}), runCodexLocalWork: async () => ({}),
    CodexSessionAnswerTooLargeError: class extends Error {},
  }, {timeout: 1000, contextCodeGeneration: {strings: false, wasm: false}});
  const owner = await open({bindingId: 'synthetic', identity: {}, budget: {}, verifier: {},
    vault: {getProviderSessionBinding: async () => {
      reads++; if (reads > 1) {enter(); await gate;} return binding;
    }, tryAcquireProviderSessionLease: async () => ({assertHeld: async () => true, release: () => {}})},
    openTransport: async () => ({close: async () => {}})});
  let first: Promise<unknown> | undefined, second: PromiseSettledResult<unknown>[] = [];
  try {
    first = owner.runQuestion({question: {}}); await entered;
    const other = owner.runQuestion({question: {}});
    // Release after observing the second operation, without stranding fixture work on failure.
    await Promise.resolve(); release();
    second = await Promise.allSettled([other]); await first;
    assert.equal(second[0]?.status, 'rejected');
    if (second[0]?.status === 'rejected') assert.equal(second[0].reason.message, 'codex_session_busy');
    assert.equal(reads, 2);
  } finally {release(); await first?.catch(() => {}); await owner.close();}
});
