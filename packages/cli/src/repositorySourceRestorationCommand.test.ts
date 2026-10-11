import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import test from 'node:test';
import ts from 'typescript';

const text = await readFile(new URL('../src/index.ts', import.meta.url), 'utf8');
const source = ts.createSourceFile('index.ts', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const declaration = source.statements.filter(node => ts.isFunctionDeclaration(node) && node.name?.text === 'repositoryRestoreCommand');
assert.equal(declaration.length, 1);
const code = ts.transpileModule(declaration[0]!.getText(source), {
  compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.CommonJS },
}).outputText;

function fixture() {
  const calls: string[] = [];
  const workspace = { organizationId: 'org_fixture', workspaceId: 'workspace', repositoryBindingId: 'binding',
    repositoryAgentId: 'agent', accessMode: 'source_connected', path: '/synthetic',
    repositoryPackage: { generation: 18, pendingLocalOperationId: null as string | null } };
  const overrides: Record<string, unknown> = {};
  const defaults = {
    required: (flags: Map<string, unknown>, key: string) => { if (!flags.get(key)) throw new Error('missing_flag');return flags.get(key); },
    readDeviceConfig: async () => ({ organizationId: 'org_fixture' }), registry: async () => [workspace],
    relayProcessState: async () => { calls.push('relay-state');return 'stopped'; },
    resolve: (...args: string[]) => args.join('/'),
    loadVerifiedWorkspacePolicy: async () => { calls.push('policy');return { serverAuthorization: {} }; },
    assertWorkspaceAuthorizationCurrent: async () => { calls.push('authorization'); },
    loadDeviceEnrollmentAnchor: async () => { calls.push('protected-anchor');return { serverPublicKeyEd25519: 'public' }; },
    currentBootstrapHostScope: () => undefined, configPath: () => '/synthetic/device', protocolStatePath: () => '/synthetic/protocol',
    AgentFabricClient: { open: async () => { calls.push('client');return { openSession: async () => { calls.push('session'); } }; } },
    VERSION: 'fixture', createPublicKey: () => ({}), repositorySourceComparisonBaseline: () => null,
    collectRepositorySourceRestoration: async () => { calls.push('collect');return {
      snapshot: { manifest: { snapshotHash: 'snapshot' } }, expectedLatestSourceFingerprint: 'head',
      headCandidateId: 'rolled-back-head', headSnapshotHash: 'head-snapshot', operationId: 'operation',
      priorReleaseId: 'stable', priorGeneration: 17, assertCurrent: async () => { calls.push('recheck'); } }; },
    canonicalize: JSON.stringify, sha256: () => 'reviewed-plan', dharmaHome: () => '/synthetic/device',
    writeRepositoryPackageSnapshot: async () => { calls.push('snapshot-write'); },
    synchronizeRepositoryCandidate: async (input: Record<string, unknown>) => {
      calls.push('submit');assert.equal(input.initialRepository, false);assert.equal(input.expectedLatestSourceFingerprint, 'head');
      return { state: 'accepted', operationId: 'operation', candidateId: 'candidate', snapshotHash: 'snapshot', releaseId: null };
    },
    saveWorkspaceRecord: async (record: { repositoryPackage: Record<string, unknown> }) => {
      calls.push('registry-write');assert.equal(record.repositoryPackage.pendingLocalOperationId, 'operation');
    },
  };
  const run = (flags: Map<string, string | boolean>) => {
    const fn = runInNewContext(code + '\nrepositoryRestoreCommand', { exports: {}, ...defaults, ...overrides },
      { timeout: 1000, contextCodeGeneration: { strings: false, wasm: false } }) as (flags: Map<string, string | boolean>) => Promise<Record<string, unknown>>;
    return fn(flags);
  };
  const flags = (...entries: Array<[string, string | boolean]>) => new Map<string, string | boolean>([['workspace-id', 'workspace'], ...entries]);
  return { workspace, overrides, calls, run, flags };
}

test('restoration requires one explicit mode and rejects arbitrary/conflicting flags before access', async () => {
  for (const entries of [[], [['shell', true]], [['apply', true]], [['dry-run', true], ['apply', true]],
    [['dry-run', 'true']], [['dry-run', true], ['plan-hash', 'reviewed-plan']]] as Array<Array<[string, string | boolean]>>) {
    const f = fixture();
    await assert.rejects(f.run(f.flags(...entries)), /option_invalid/);
    assert.deepEqual(f.calls, []);
  }
});

test('restoration planning has no source, registry or activation writes', async () => {
  const f = fixture(), result = await f.run(f.flags(['dry-run', true]));
  assert.equal(result.planHash, 'reviewed-plan');assert.equal(result.activated, false);assert.equal(result.published, false);
  assert.equal(result.localMutation, false);assert.equal(result.serverSourceMutation, false);
  assert.ok(!f.calls.some(call => /write|submit|relay-state/.test(call)));
});

test('restoration submits only the reviewed plan through normal candidate gates without activation', async () => {
  const f = fixture(), result = await f.run(f.flags(['apply', true], ['plan-hash', 'reviewed-plan']));
  assert.equal(result.stage, 'repository_restoration_candidate_submitted');assert.equal(result.activated, false);
  assert.deepEqual(f.calls.slice(-6), ['authorization', 'relay-state', 'recheck', 'snapshot-write', 'submit', 'registry-write']);
});

test('terminal history collision and expired final conflict approval stop before any candidate writes', async () => {
  for (const reason of ['repository_source_restoration_operation_already_used', 'repository_source_resolution_expired_or_invalid']) {
    const f = fixture();
    f.overrides.collectRepositorySourceRestoration = async () => ({ snapshot: { manifest: { snapshotHash: 'snapshot' } },
      expectedLatestSourceFingerprint: 'head', headCandidateId: 'rolled-back-head', headSnapshotHash: 'head-snapshot',
      operationId: 'operation', priorReleaseId: 'stable', priorGeneration: 17,
      assertCurrent: async () => { throw new Error(reason); } });
    await assert.rejects(f.run(f.flags(['apply', true], ['plan-hash', 'reviewed-plan'])), new RegExp(reason));
    assert.ok(!f.calls.some(call => /write|submit/.test(call)));
  }
});

test('changed plan, revoked authorization, pending source and live/unknown relay cannot submit', async () => {
  for (const mode of ['changed-plan', 'revoked', 'pending', 'knowledge_only', 'running', 'unknown']) {
    const f = fixture();
    if (mode === 'revoked') f.overrides.assertWorkspaceAuthorizationCurrent = async () => { throw new Error('revoked'); };
    if (mode === 'pending') f.workspace.repositoryPackage.pendingLocalOperationId = 'other';
    if (mode === 'knowledge_only') f.workspace.accessMode = mode;
    if (mode === 'running' || mode === 'unknown') f.overrides.relayProcessState = async () => mode;
    await assert.rejects(f.run(f.flags(['apply', true], ['plan-hash', mode === 'changed-plan' ? 'changed' : 'reviewed-plan'])));
    assert.ok(!f.calls.some(call => /write|submit/.test(call)));
  }
});
