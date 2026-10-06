import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {compileFunction} from 'node:vm';
import test from 'node:test';
import ts from 'typescript';
import {canonicalize} from '@dharma-ai-labs/agent-fabric-contracts';
import {currentBootstrapHostScope, inspectCodexBootstrapHostPreparation,
  prepareCodexBootstrapHost, runCodexBootstrapHostScope} from './bootstrapHostScope.js';
import {createCodexSetupAdmission} from './codexSetupAdmission.js';
import {originalCodexSetupSessionSender, withCodexSetupSessionSender} from './codexSetupSessionHandoff.js';
import {parseCliOptions} from './index.js';

const id = (n: number) => `${String(n).padStart(8, '0')}-1111-4111-8111-111111111111`;

// Actual CLI dispatcher; its effectful bootstrap boundary alone is synthetic.
async function fixture(dryRun = false) {
  const now = Date.now(), prepared = prepareCodexBootstrapHost({workspace: resolve('synthetic-source'),
    signal: new AbortController().signal, current: async () => true, dryRun,
    intent: {schema: 'dharma.codex-setup-intent/v1', operationId: id(1), setupReference: id(2),
      organizationId: 'org_demo', recipientMembershipId: id(3), origin: 'https://hq.example', hostContextId: id(4),
      repositoryFingerprint: `sha256:${'a'.repeat(64)}`, scopeDigest: `sha256:${'b'.repeat(64)}`,
      contractDigest: `sha256:${'c'.repeat(64)}`, policyRevision: 'policy-v1',
      issuedAt: new Date(now - 1000).toISOString(), expiresAt: new Date(now + 60_000).toISOString()}});
  const argv = ['bootstrap', ...[...prepared.flags].flatMap(([key, value]) =>
    value === true ? [`--${key}`] : [`--${key}`, String(value)])];
  const source = await readFile(new URL('../src/index.ts', import.meta.url), 'utf8');
  const ast = ts.createSourceFile('index.ts', source, ts.ScriptTarget.Latest, true);
  const matches = ast.statements.filter(node => ts.isFunctionDeclaration(node) && node.name?.text === 'run');
  assert.equal(matches.length, 1);
  const output = ts.transpileModule(matches[0]!.getText(ast), {compilerOptions: {
    target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.CommonJS}, reportDiagnostics: true});
  assert.equal(output.diagnostics?.filter(d => d.category === ts.DiagnosticCategory.Error).length, 0);
  let effects = 0;
  const dependencies = {parseCliOptions, currentBootstrapHostScope, inspectCodexBootstrapHostPreparation,
    originalCodexSetupSessionSender, canonicalize, USAGE: 'synthetic usage', VERSION: 'synthetic-version',
    bootstrap: async (flags: Map<string, string | boolean>, scope?: typeof prepared.scope) => {
      effects++; return {scopeMatched: scope === prepared.scope, flags: [...flags]};
    }};
  const run = compileFunction(`${output.outputText}\nreturn run;`, ['exports', ...Object.keys(dependencies)])(
    {}, ...Object.values(dependencies)) as (args: string[]) => Promise<unknown>;
  return {prepared, argv, run, get effects() {return effects;}};
}

for (const changed of ['command', 'help', 'version', 'recipient', 'source', 'extra', 'duplicate', 'grant', 'resume'] as const) {
  test(`scoped official dispatcher refuses ${changed} before any bootstrap boundary`, async () => {
    const f = await fixture(true);
    const argv = [...f.argv];
    if (changed === 'command') argv[0] = 'status';
    if (changed === 'help') argv.push('--help');
    if (changed === 'version') argv.push('--version');
    if (changed === 'recipient') argv[argv.indexOf('--setup-recipient-membership-id') + 1] = id(99);
    if (changed === 'source') argv[argv.indexOf('--workspace') + 1] = resolve('foreign-source');
    if (changed === 'extra') argv.push('unexpected-positional');
    if (changed === 'duplicate') argv.push('--organization-id', 'org_demo');
    if (changed === 'grant') argv.push('--grant', 'synthetic-not-a-real-grant');
    if (changed === 'resume') argv.push('--resume');
    try {
      await assert.rejects(runCodexBootstrapHostScope(f.prepared.scope, () => f.run(argv)),
        /codex_setup_host_command_mismatch/);
      assert.equal(f.effects, 0);
    } finally {f.prepared.scope.close();}
  });
}

test('scoped official dispatcher preserves exact grant-free dry-run without execution admission', async () => {
  const f = await fixture(true);
  try {
    const result = await runCodexBootstrapHostScope(f.prepared.scope, () => f.run(f.argv)) as {scopeMatched: boolean};
    assert.equal(result.scopeMatched, true); assert.equal(f.effects, 1);
  } finally {f.prepared.scope.close();}
});

test('scoped official dispatcher refuses a prepared scope without its private execution lease', async () => {
  const f = await fixture();
  try {
    await assert.rejects(runCodexBootstrapHostScope(f.prepared.scope, () => f.run(f.argv)), /setup_session_sender_unavailable/);
    assert.equal(f.effects, 0);
  } finally {f.prepared.scope.close();}
});

test('scoped official dispatcher carries only the original privately admitted execution into bootstrap', async () => {
  const f = await fixture(), binding = {connectionId: id(5), threadId: 'fixture_thread', turnId: 'fixture_turn', hostContextId: id(4)};
  let originalScopeMatched = false;
  const owner = createCodexSetupAdmission({...binding, intent: f.prepared.intent,
    current: async () => ({...binding, mode: 'setup'}), qualifyHost: async () => true,
    journal: {claim: async (_operation, intentDigest) => ({state: 'acquired', intentDigest, leaseId: id(6)}),
      read: async () => null, finish: async () => {}},
    execute: async (_intent, _signal, _current, lease) => {
      const result = await withCodexSetupSessionSender({scope: f.prepared.scope, lease,
        vault: {stageCodexSetupSession: async () => {throw new Error('unexpected fixture effect');},
          readCodexSetupSession: async () => null}}, () =>
        runCodexBootstrapHostScope(f.prepared.scope, () => f.run(f.argv))) as {scopeMatched: boolean};
      originalScopeMatched = result.scopeMatched;
      return {state: 'unconfirmed', code: 'setup_execution_unconfirmed'};
    }, verifyReadiness: async () => false});
  try {
    const result = await owner.handler({threadId: binding.threadId, turnId: binding.turnId, callId: 'fixture_call',
      namespace: null, tool: 'dharma_setup_reference', arguments: {operationId: id(1), setupReference: id(2)}},
      {signal: new AbortController().signal});
    await owner.settled; assert.equal(result.success, false); assert.equal(f.effects, 1);
    assert.equal(originalScopeMatched, true);
  } finally {owner.close(); await owner.settled; f.prepared.scope.close();}
});

test('scoped official dispatcher never falls back after the borrowed callback settles', async () => {
  const f = await fixture(true);
  try {
    // Capture a descendant's original ALS lifetime, not an unscoped caller.
    let descendant!: Promise<unknown>, release!: () => void;
    const wait = new Promise<void>(done => {release = done;});
    await runCodexBootstrapHostScope(f.prepared.scope, async () => {
      descendant = (async () => {await wait; return f.run(f.argv);})();
    });
    release(); await assert.rejects(descendant, /codex_setup_host_scope_unavailable/);
    assert.equal(f.effects, 0);
  } finally {f.prepared.scope.close();}
});
