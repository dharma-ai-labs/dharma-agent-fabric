import assert from 'node:assert/strict';
import {mkdtemp, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {runInNewContext} from 'node:vm';
import test from 'node:test';
import ts from 'typescript';
import {LocalVault} from '@dharma-ai-labs/agent-fabric-local-vault';
import {currentBootstrapHostScope, runCodexBootstrapHost} from './bootstrapHostScope.js';

function input() {
  const id = (n: number) => `${String(n).padStart(8, '0')}-1111-4111-8111-111111111111`;
  const now = Date.now(), digest = `sha256:${'a'.repeat(64)}`;
  return {workspace: process.cwd(), current: async () => true, signal: new AbortController().signal,
    intent: {schema: 'dharma.codex-setup-intent/v1' as const, operationId: id(1), setupReference: id(2),
      organizationId: 'org_demo', recipientMembershipId: id(3), origin: 'https://hq.example',
      repositoryFingerprint: digest, policyRevision: 'policy-v1', scopeDigest: digest, contractDigest: digest,
      hostContextId: id(4), issuedAt: new Date(now - 1000).toISOString(), expiresAt: new Date(now + 60_000).toISOString()}};
}
async function caller(loadVaultModule: () => Promise<unknown>) {
  const source = await readFile(new URL('../src/index.ts', import.meta.url), 'utf8');
  const ast = ts.createSourceFile('index.ts', source, ts.ScriptTarget.Latest, true);
  const nodes = ast.statements.filter(node => ts.isFunctionDeclaration(node) && node.name?.text === 'openBootstrapVault');
  assert.equal(nodes.length, 1, 'actual CLI scoped open owner missing');
  const result = ts.transpileModule(nodes[0]!.getText(ast), {compilerOptions: {
    target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.None}});
  return runInNewContext(`${result.outputText}\nopenBootstrapVault`, {loadVaultModule, currentBootstrapHostScope},
    {timeout: 1000, contextCodeGeneration: {strings: false, wasm: false}}) as
    (options: {root: string; rawLocalDays?: number}) => Promise<any>;
}
test('actual CLI full-vault callsites all use the single scoped owner', async () => {
  const source = await readFile(new URL('../src/index.ts', import.meta.url), 'utf8');
  const ast = ts.createSourceFile('index.ts', source, ts.ScriptTarget.Latest, true);
  const unscoped: string[] = [], owned: string[] = [];
  function visit(node: ts.Node, owner = '') {
    if (ts.isFunctionDeclaration(node)) owner = node.name?.text ?? owner;
    if (ts.isCallExpression(node) && node.expression.getText(ast) === 'LocalVault.open' && owner !== 'openBootstrapVault') {
      unscoped.push(owner);
    }
    if (ts.isCallExpression(node) && node.expression.getText(ast) === 'openBootstrapVault') owned.push(owner);
    ts.forEachChild(node, child => visit(child, owner));
  }
  visit(ast); assert.deepEqual(unscoped, []);
  // Keep both callsites explicit; neither may bypass openBootstrapVault or its key wipe/scope checks.
  assert.deepEqual(owned, ['superviseNamedSessions', 'startCodexBootstrapNativeHost', 'capture', 'namedSessionCommand', 'namedSessionCommand', 'evidenceSync',
    'processEvidenceRequest', 'syncSignedTaskTrajectory', 'stageSignedTaskTrajectoryRecovery',
    'finalizeRecoveredSignedTaskTrajectories', 'finalizeRecoveredSignedTaskTrajectories',
    'finalizeRecoveredSignedTaskTrajectories', 'finalizeRecoveredSignedTaskTrajectories', 'relayWorkspaceLoop']);
});

test('stopped maintenance recovery accessor reads only the exact existing provider binding', async () => {
  const source=await readFile(new URL('../src/index.ts',import.meta.url),'utf8');
  const ast=ts.createSourceFile('index.ts',source,ts.ScriptTarget.Latest,true);
  const callbacks:ts.ArrowFunction[]=[];
  const visit=(node:ts.Node)=>{
    if(ts.isPropertyAssignment(node)&&node.name.getText(ast)==='readBinding'&&ts.isArrowFunction(node.initializer))callbacks.push(node.initializer);
    ts.forEachChild(node,visit);
  };
  visit(ast);assert.equal(callbacks.length,1);
  const callback=callbacks[0]!, calls:ts.CallExpression[]=[];
  const scan=(node:ts.Node)=>{if(ts.isCallExpression(node))calls.push(node);ts.forEachChild(node,scan);};
  scan(callback);
  assert.deepEqual(calls.map(call=>call.expression.getText(ast)),
    ['openBootstrapVault','resolve','dharmaHome','vault.getProviderSessionBinding']);
  assert.deepEqual(calls.at(-1)!.arguments.map(value=>value.getText(ast)),['existing.bindingId','existing.identity']);
  const code=ts.transpileModule(callback.getText(ast),{compilerOptions:{target:ts.ScriptTarget.ES2023,module:ts.ModuleKind.None}});
  const expected={bindingId:'existing-public-binding',identity:{organizationId:'org_test'}};
  let opened=0,read=0;
  const invoke=runInNewContext(code.outputText,{existing:expected,vault:undefined,dharmaHome:()=>'/fixture',resolve:join,
    openBootstrapVault:async(options:unknown)=>{opened++;assert.deepEqual(JSON.parse(JSON.stringify(options)),{root:join('/fixture','vault')});
      return{getProviderSessionBinding:(id:unknown,identity:unknown)=>{read++;assert.equal(id,expected.bindingId);assert.equal(identity,expected.identity);return{id};}};}},
    {timeout:1000,contextCodeGeneration:{strings:false,wasm:false}}) as ()=>Promise<unknown>;
  assert.deepEqual(await invoke(),{id:expected.bindingId});assert.equal(opened,1);assert.equal(read,1);
});
test('actual CLI full-vault owner refuses closed scope before module or key access', async () => {
  let effects = 0;
  const open = await caller(async () => {effects++; throw new Error('private fixture');});
  await assert.rejects(runCodexBootstrapHost(input(), async ({scope}) => {
    scope.close(); await open({root: 'synthetic-root'});
  }), {message: 'codex_setup_host_scope_unavailable'});
  assert.equal(effects, 0);
});
test('actual CLI full-vault owner binds original scope, snapshots options and wipes only owned key', async () => {
  const options = {root: 'synthetic-root', rawLocalDays: 30}, key = Buffer.alloc(32, 7);
  let keyScope: unknown, openScope: unknown, observed: any;
  const f = input();
  const open = await caller(async () => {
    options.root = 'changed-root'; options.rawLocalDays = 1;
    return {loadOrCreateVaultMasterKey: async (_store: unknown, scope: unknown) => {keyScope = scope; return key;},
      LocalVault: {open: async (args: unknown, scope: unknown) => {observed = args; openScope = scope; return {close: async () => {}};}}};
  });
  await runCodexBootstrapHost(f, async ({scope}) => {
    await open(options); assert.equal(openScope, scope); assert.equal(keyScope, scope);
    assert.equal(observed.root, 'synthetic-root'); assert.equal(observed.rawLocalDays, 30);
  });
  assert.ok(key.equals(Buffer.alloc(32)));
});
test('actual CLI full-vault owner closes an acquired vault if returned after withdrawal', async () => {
  let closes = 0;
  await assert.rejects(runCodexBootstrapHost(input(), async ({scope}) => {
    const open = await caller(async () => ({loadOrCreateVaultMasterKey: async () => Buffer.alloc(32),
      LocalVault: {open: async () => {scope.close(); return {close: async () => {closes++;}};}}}));
    await open({root: 'synthetic-root'});
  }), {message: 'codex_setup_host_scope_unavailable'});
  assert.equal(closes, 1);
});

test('actual CLI full-vault owner reaches the real public encrypted vault under the same scope', async t => {
  const root = await mkdtemp(join(tmpdir(), 'bootstrap-full-vault-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const key = Buffer.alloc(32, 11), payload = Buffer.from('synthetic scoped full-vault evidence');
  const open = await caller(async () => ({LocalVault, loadOrCreateVaultMasterKey: async () => key}));
  await runCodexBootstrapHost(input(), async () => {
    const vault = await open({root});
    try {
      assert.ok(key.equals(Buffer.alloc(32)));
      const id = await vault.putBlob(payload, 'synthetic');
      assert.deepEqual(await vault.getBlob(id), payload);
      assert.deepEqual(await vault.stats(), {blobs: 1, capsules: 0, sessions: 0});
    } finally {await vault.close();}
  });
});
