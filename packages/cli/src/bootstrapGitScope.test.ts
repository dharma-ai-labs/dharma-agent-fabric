import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {readFile} from 'node:fs/promises';
import {runInNewContext} from 'node:vm';
import test from 'node:test';
import ts from 'typescript';
import {providerProcessEnvironment} from '@dharma-ai-labs/agent-fabric-provider-adapters';
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

async function caller(execFileAsync: (...args: any[]) => Promise<any>) {
  const source = await readFile(new URL('../src/index.ts', import.meta.url), 'utf8');
  const ast = ts.createSourceFile('index.ts', source, ts.ScriptTarget.Latest, true);
  const nodes = ast.statements.filter(node => ts.isFunctionDeclaration(node) && node.name?.text === 'gitValue');
  assert.equal(nodes.length, 1);
  const result = ts.transpileModule(nodes[0]!.getText(ast), {compilerOptions: {
    target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.None}, reportDiagnostics: true});
  assert.equal(result.diagnostics?.filter(item => item.category === ts.DiagnosticCategory.Error).length, 0);
  return runInNewContext(`${result.outputText}\ngitValue`, {execFileAsync, currentBootstrapHostScope,
    providerProcessEnvironment, process, structuredClone}, {timeout: 1000,
    contextCodeGeneration: {strings: false, wasm: false}}) as (workspace: string, argv: string[]) => Promise<string | null>;
}

test('Git source preflight refuses closed authority before launching a child', async () => {
  let launches = 0, result: PromiseSettledResult<unknown>[] = [];
  const git = await caller(async () => {launches++; return {stdout: 'synthetic-root'};});
  await assert.rejects(runCodexBootstrapHost(input(), async ({scope}) => {
    scope.close(); result = await Promise.allSettled([git(process.cwd(), ['rev-parse', '--show-toplevel'])]);
  }), {message: 'codex_setup_host_scope_unavailable'});
  assert.equal(result[0]?.status, 'rejected'); assert.equal(launches, 0);
});

test('Git source preflight withholds a result produced after cancellation', async () => {
  let result: PromiseSettledResult<unknown>[] = [];
  await assert.rejects(runCodexBootstrapHost(input(), async ({scope}) => {
    const git = await caller(async () => {scope.close(); return {stdout: 'synthetic-root'};});
    result = await Promise.allSettled([git(process.cwd(), ['rev-parse', '--show-toplevel'])]);
  }), {message: 'codex_setup_host_scope_unavailable'});
  assert.equal(result[0]?.status, 'rejected');
});

test('Git source preflight does not swallow cancellation as an absent remote', async () => {
  let result: PromiseSettledResult<unknown>[] = [];
  await assert.rejects(runCodexBootstrapHost(input(), async ({scope}) => {
    const git = await caller(async () => {scope.close(); throw new Error('private-child-canary');});
    result = await Promise.allSettled([git(process.cwd(), ['config', '--get', 'remote.origin.url'])]);
  }), {message: 'codex_setup_host_scope_unavailable'});
  assert.equal(result[0]?.status, 'rejected');
});

test('Git source preflight snapshots its argv before async qualification', async () => {
  const args = ['branch', '--show-current']; let launched: string[] | undefined;
  const f = input(); f.current = async () => {args.splice(0, args.length, 'arbitrary', 'changed'); return true;};
  const git = await caller(async (_command, argv) => {launched = argv; return {stdout: ' main\n'};});
  await runCodexBootstrapHost(f, async () => {
    args.splice(0, args.length, 'branch', '--show-current');
    assert.equal(await git(process.cwd(), args), 'main');
  });
  assert.deepEqual(Array.from(launched ?? []), ['-C', process.cwd(), 'branch', '--show-current']);
});

test('Git source preflight binds the child signal and bounded noninteractive options', async () => {
  let observed: Record<string, unknown> | undefined;
  const git = await caller(async (_command, _args, options) => {observed = options; return {stdout: 'synthetic-root'};});
  await runCodexBootstrapHost(input(), async ({scope}) => {
    await git(process.cwd(), ['rev-parse', '--show-toplevel']);
    assert.equal(observed?.signal, scope.signal); assert.equal(observed?.timeout, 10_000);
    assert.equal(observed?.maxBuffer, 65_536); assert.equal(observed?.windowsHide, true);
  });
});

test('Git source preflight preserves optional values and bounded legacy failure', async () => {
  const absent = await caller(async () => {throw new Error('synthetic-missing-value');});
  assert.equal(await absent(process.cwd(), ['config', '--get', 'remote.origin.url']), null);
  await runCodexBootstrapHost(input(), async () => {
    assert.equal(await absent(process.cwd(), ['config', '--get', 'remote.origin.url']), null);
  });
  const present = await caller(async () => ({stdout: ' synthetic-root\n'}));
  assert.equal(await present(process.cwd(), ['rev-parse', '--show-toplevel']), 'synthetic-root');
});

test('Git source preflight cancellation reaches only the owned synthetic child', async () => {
  // A C-only inert Node child, not Git/WSL or a native onboarding/provider process.
  let closed: Promise<void> | undefined, signal: AbortSignal | undefined;
  const run = promisify(execFile);
  const git = await caller(async (_command, _args, options) => {
    signal = options.signal;
    const child = run(process.execPath, ['-e', 'setTimeout(() => {}, 10000)'], options);
    closed = new Promise(resolve => child.child.once('close', () => resolve()));
    await child; return {stdout: ''};
  });
  await assert.rejects(runCodexBootstrapHost(input(), async ({scope}) => {
    const timer = setTimeout(() => scope.close(), 100);
    try {await git(process.cwd(), ['rev-parse', '--show-toplevel']);} finally {clearTimeout(timer);}
  }), {message: 'codex_setup_host_scope_unavailable'});
  assert.equal(signal?.aborted, true); assert.ok(closed);
  const timeout = AbortSignal.timeout(2000);
  await Promise.race([closed, new Promise((_, reject) => timeout.addEventListener('abort', () => reject(new Error('owned child close unconfirmed')), {once: true}))]);
});
