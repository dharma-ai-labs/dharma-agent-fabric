import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import test from 'node:test';
import ts from 'typescript';
import { canonicalize, sha256 } from '@dharma-ai-labs/agent-fabric-contracts';
import { selectDeviceWorkspace, workspaceIdForDevice } from './onboardingWorkspace.js';
import { installRepositoryJoinConnection } from './repositoryJoinConnection.js';

type Row = Record<string, any>;
type Join = (flags: Map<string, string | boolean>, binding: string, fingerprint: string) => Promise<Row>;
const bindingId = '11111111-1111-4111-8111-111111111111';
const agentId = '22222222-2222-4222-8222-222222222222';
const endpointId = '33333333-3333-4333-8333-333333333333';
const fingerprint = `sha256:${'a'.repeat(64)}`;

async function fixture(t: test.TestContext) {
  const home = await fs.realpath(await fs.mkdtemp(resolve(tmpdir(), 'dharma-knowledge-join-')));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const workspace = resolve(home, 'joined-repositories', bindingId);
  const config = { organizationId: 'org_member', deviceId: 'device_member', hqUrl: 'https://fixture.invalid' };
  const flags = new Map<string, string | boolean>([
    ['organization-id', config.organizationId], ['policy-revision', 'policy_fixture'],
    ['provider', 'codex'], ['no-relay-daemon', true],
  ]);
  const rows: Row[] = [];
  const calls: string[] = [];
  const state = { registered: true, packageState: 'published', sharedReady: false,
    connectDenied: false, foreignBinding: false, policyDenied: false };
  const prohibited = async () => { calls.push('prohibited'); throw new Error('Git and source access are unavailable'); };
  const save = async (item: Row) => {
    const index = rows.findIndex(row => row.workspaceId === item.workspaceId);
    if (index < 0) rows.push(item); else rows[index] = item;
  };
  const dependencies: Row = {
    ...fs, resolve, createHash, canonicalize, sha256, workspaceIdForDevice, selectDeviceWorkspace,
    UUID_PATTERN: /^[0-9a-f-]{36}$/i,
    readDeviceConfig: async () => state.registered ? config : null,
    required: (input: Map<string, string | boolean>, key: string) => {
      const value = input.get(key); assert.equal(typeof value, 'string'); return value;
    },
    dharmaHome: () => home,
    writeJsonAtomic: async (path: string, value: unknown) => fs.writeFile(path, JSON.stringify(value)),
    registry: async () => rows,
    saveWorkspaceRecord: save,
    gitValue: prohibited, execFileAsync: prohibited, setupClaimSourceRegistration: prohibited,
    preflightBootstrapWorkspaceIdentity: prohibited, captureWorkspaceEvidence: prohibited,
    isLocalProviderId: (provider: string) => provider === 'codex',
    client: async () => ({
      connectRepositoryAgent: async (input: Row) => {
        calls.push('connect');
        assert.equal(input.sourceFingerprint, fingerprint);
        assert.equal(input.joinExistingBindingId, bindingId);
        assert.equal(input.defaultSourceRef, null);
        if (state.connectDenied) throw new Error('knowledge_membership_denied');
        return {
          repositoryAgent: { id: state.foreignBinding ? endpointId : bindingId,
            organization_agent_id: agentId, agent_key: `repo:${'b'.repeat(24)}`,
            control_branch: 'agents/knowledge-12345678' }, endpointId,
          repositoryPackage: { state: state.packageState, candidateId: bindingId,
            operationId: fingerprint, snapshotHash: fingerprint, sourceManifestHash: fingerprint,
            releaseId: state.packageState === 'published' ? bindingId : null,
            generation: 1, consolidationMode: 'initial_repository' }, endpointRole: null,
        };
      },
    }),
    syncWorkspacePolicy: async (_fabric: unknown, item: Row, revision: string, apply: boolean, providers: string[]) => {
      calls.push('signed_policy');
      assert.equal(revision, 'policy_fixture'); assert.equal(apply, true);
      assert.equal(providers.join(','), 'codex'); assert.equal(item.accessMode, 'knowledge_only');
      if (state.policyDenied) throw new Error('signed_policy_denied');
      return { ok: true, organizationId: config.organizationId, workspace: { id: item.workspaceId, status: 'active' } };
    },
    registerRepositoryRoleMetadata: async (_fabric: unknown, scope: Row, input: Row) => {
      calls.push('role'); assert.equal(scope.repositoryBindingId, bindingId);
      assert.equal(input.roleName, 'Knowledge collaborator'); return { role: { revision: 1 } };
    },
    selectedProviderAdapters: () => [{ capability: async () => ({ provider: 'codex', available: true }) }],
    receiptAwareProviderCapabilities: async (providers: unknown) => providers,
    installRepositoryJoinConnection: async (input: Parameters<typeof installRepositoryJoinConnection>[0]) => {
      calls.push('connection'); return installRepositoryJoinConnection(input);
    },
    loadAgentFabricOnboardingContract: async () => ({ markdown: '# Knowledge fixture\n' }),
    installAvailableNativeAgentFabricBootstraps: async () => {
      calls.push('bootstrap_fixture'); return { installed: [], failures: [] };
    },
    startRelayDaemon: async () => { throw new Error('no relay daemon permitted by fixture'); },
    installedRepositoryKnowledge: async () => state.sharedReady ? { verified: true } : null,
  };
  // Execute both actual callers and their pure scope validators. Server/policy,
  // provider and native boundaries are fixtures; connection files use real I/O.
  const source = ts.createSourceFile('index.ts', await fs.readFile(
    fileURLToPath(new URL('../src/index.ts', import.meta.url)), 'utf8'), ts.ScriptTarget.Latest, true);
  const names = ['joinExistingRepository', 'bindRepositoryAgent', 'reconcileWorkspaceRegistration',
    'canonicalRepositoryPackage', 'canonicalRepositoryPackagePolicyGeneration', 'canonicalEndpointRole',
    'repositoryRoleScope', 'repositorySharedReady'];
  const bodies = names.map(name => {
    const nodes = source.statements.filter(node => ts.isFunctionDeclaration(node) && node.name?.text === name);
    assert.equal(nodes.length, 1); return nodes[0]!.getText(source).replace(/^export\s+/, '');
  });
  const compiled = ts.transpileModule(bodies.join('\n'), { compilerOptions: {
    target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.None }, reportDiagnostics: true });
  assert.equal(compiled.diagnostics?.filter(row => row.category === ts.DiagnosticCategory.Error).length, 0);
  const actual = runInNewContext(`${compiled.outputText}\n({joinExistingRepository, bindRepositoryAgent})`, dependencies,
    { timeout: 1000, contextCodeGeneration: { strings: false, wasm: false } }) as {
      joinExistingRepository: Join; bindRepositoryAgent: (client: unknown, item: Row, binding: string) => Promise<Row>;
    };
  return { home, workspace, flags, config, rows, state, calls,
    run: () => actual.joinExistingRepository(flags, bindingId, fingerprint),
    bind: async (item: Row) => actual.bindRepositoryAgent(await dependencies.client(), item, bindingId),
    dependencies };
}

test('ordinary knowledge member joins without Git, source inventory, or a source-access grant', async t => {
  const f = await fixture(t), result = await f.run();
  assert.equal(result.ok, true); assert.equal(result.accessMode, 'knowledge_only');
  assert.equal(result.repositoryAgent.bindingId, bindingId);
  assert.equal(result.firstLearningEvidence.discovered, 0);
  assert.equal(result.firstLearningEvidence.disclosureReady, false);
  assert.equal(f.calls.includes('prohibited'), false);
  assert.equal(f.rows[0]!.defaultBranch, null);
  assert.equal(f.rows[0]!.repositoryRemoteHash, fingerprint);
  await assert.rejects(fs.stat(resolve(f.workspace, '.git')), { code: 'ENOENT' });
  const connection = JSON.parse(await fs.readFile(resolve(f.workspace, '.dharma/agent-fabric.json'), 'utf8'));
  assert.equal(connection.accessMode, 'knowledge_only');
  assert.equal(connection.organizationId, f.config.organizationId);
  assert.equal(connection.repositoryBindingId, bindingId);
  assert.doesNotMatch(JSON.stringify(result), /source-access-token|private-grant/);
  assert.ok(f.calls.indexOf('signed_policy') < f.calls.indexOf('connect'));
  assert.ok(f.calls.indexOf('connect') < f.calls.indexOf('connection'));
});

test('knowledge join resume preserves identity and existing Git metadata without invoking Git', async t => {
  const f = await fixture(t); await f.run();
  const marker = resolve(f.workspace, '.dharma/join-identity.json');
  const before = await fs.readFile(marker, 'utf8'), id = f.rows[0]!.workspaceId;
  await fs.mkdir(resolve(f.workspace, '.git'));
  await fs.writeFile(resolve(f.workspace, '.git/config'), '# retained legacy metadata\n');
  await f.run();
  assert.equal(await fs.readFile(marker, 'utf8'), before);
  assert.equal(await fs.readFile(resolve(f.workspace, '.git/config'), 'utf8'), '# retained legacy metadata\n');
  assert.equal(f.rows.length, 1); assert.equal(f.rows[0]!.workspaceId, id);
  assert.equal(f.calls.includes('prohibited'), false);
});

test('local join readiness is not promoted to installed signed-package readiness', async t => {
  const f = await fixture(t); const pending = await f.run();
  assert.equal(pending.stage, 'shared_repository_pending'); assert.equal(pending.sharedRepositoryReady, false);
  f.state.sharedReady = true;
  const ready = await f.run();
  assert.equal(ready.stage, 'ready'); assert.equal(ready.sharedRepositoryReady, true);
});

test('knowledge join rejects missing enrollment and foreign organization before local writes', async t => {
  const f = await fixture(t); f.state.registered = false;
  await assert.rejects(f.run(), /repository_join_enrollment_required/);
  f.state.registered = true; f.flags.set('organization-id', 'org_foreign');
  await assert.rejects(f.run(), /repository_join_enrollment_required/);
  assert.deepEqual(f.calls, []);
  await assert.rejects(fs.stat(f.workspace), { code: 'ENOENT' });
});

test('knowledge join rejects a foreign marker or unowned nonempty workspace without modifying it', async t => {
  const f = await fixture(t);
  await fs.mkdir(resolve(f.workspace, '.dharma'), { recursive: true });
  const path = resolve(f.workspace, '.dharma/join-identity.json'), bytes = '{"organizationId":"org_foreign"}';
  await fs.writeFile(path, bytes);
  await assert.rejects(f.run(), /repository_join_workspace_identity_conflict/);
  assert.equal(await fs.readFile(path, 'utf8'), bytes); assert.deepEqual(f.calls, []);
  await fs.unlink(path);
  await assert.rejects(f.run(), /repository_join_workspace_not_empty/);
  assert.deepEqual(f.calls, []);
});

for (const failure of ['policyDenied', 'connectDenied', 'foreignBinding'] as const) {
  test(`knowledge join retains authorization and binding rejection: ${failure}`, async t => {
    const f = await fixture(t); f.state[failure] = true;
    await assert.rejects(f.run(), /signed_policy_denied|knowledge_membership_denied|repository_join_binding_mismatch/);
    assert.equal(f.calls.includes('connection'), false); assert.equal(f.calls.includes('bootstrap_fixture'), false);
    assert.equal(f.calls.includes('prohibited'), false);
    if (failure === 'policyDenied') assert.equal(f.calls.includes('connect'), false);
  });
}

test('knowledge join refuses an unavailable shared package before connection or native fixtures', async t => {
  const f = await fixture(t); f.state.packageState = 'accepted';
  const result = await f.run();
  assert.equal(result.ok, false); assert.equal(result.code, 'repository_join_package_unavailable');
  assert.equal(f.calls.includes('connection'), false); assert.equal(f.calls.includes('bootstrap_fixture'), false);
});

test('knowledge join cannot reuse a source-connected workspace record', async t => {
  const f = await fixture(t); await f.run(); f.rows[0]!.accessMode = 'source_connected'; f.calls.length = 0;
  await assert.rejects(f.run(), /repository_join_workspace_mode_conflict/);
  assert.deepEqual(f.calls, []);
});

test('knowledge-only rebinding skips Git while source-connected rebinding still reads its remote', async t => {
  const f = await fixture(t); await f.run();
  f.calls.length = 0;
  await f.bind(f.rows[0]!);
  assert.equal(f.calls.includes('prohibited'), false);
  let remoteReads = 0;
  f.dependencies.gitValue = async (path: string, args: string[]) => {
    remoteReads++; assert.equal(path, f.workspace); assert.equal(args.join(' '), 'config --get remote.origin.url');
    return 'https://github.com/fixture/fixture';
  };
  await f.bind({ ...f.rows[0], accessMode: 'source_connected' });
  assert.equal(remoteReads, 1);
});

test('knowledge join cannot install with an unsupported provider', async t => {
  const f = await fixture(t); f.flags.set('provider', 'unapproved_provider');
  await assert.rejects(f.run(), /repository_join_provider_invalid/);
  assert.deepEqual(f.calls, []);
});

test('knowledge join refuses a foreign connection on resume without overwriting it', async t => {
  const f = await fixture(t); await f.run();
  const path = resolve(f.workspace, '.dharma/agent-fabric.json');
  const bytes = JSON.stringify({ ...JSON.parse(await fs.readFile(path, 'utf8')), organizationId: 'org_foreign' });
  await fs.writeFile(path, bytes); f.calls.length = 0;
  await assert.rejects(f.run(), /repository_join_connection_scope_conflict/);
  assert.equal(await fs.readFile(path, 'utf8'), bytes);
  assert.equal(f.calls.includes('bootstrap_fixture'), false);
});
