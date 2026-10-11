import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import test from 'node:test';
import ts from 'typescript';
import { loadDeviceEnrollmentAnchor, type SecureSecretStore } from '@dharma-ai-labs/agent-fabric-relay-client';

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
  let savedRecord: { repositoryPackage: Record<string, unknown> } | undefined;
  const defaults = {
    required: (flags: Map<string, unknown>, key: string) => { if (!flags.get(key)) throw new Error('missing_flag');return flags.get(key); },
    readDeviceConfig: async () => ({ organizationId: 'org_fixture' }), registry: async () => [workspace],
    relayProcessState: async () => { calls.push('relay-state');return 'stopped'; },
    relaySupervisorProcessState: async () => { calls.push('supervisor-state');return 'stopped'; },
    resolve: (...args: string[]) => args.join('/'),
    loadVerifiedWorkspacePolicy: async () => { calls.push('policy');return { serverAuthorization: {} }; },
    assertWorkspaceAuthorizationCurrent: async () => { calls.push('authorization'); },
    loadDeviceEnrollmentAnchor: async (input: { readOnly: boolean }) => {
      calls.push(input.readOnly ? 'protected-anchor-readonly' : 'protected-anchor');return { serverPublicKeyEd25519: 'public' };
    },
    currentBootstrapHostScope: () => undefined, configPath: () => '/synthetic/device', protocolStatePath: () => '/synthetic/protocol',
    AgentFabricClient: { open: async () => { calls.push('client');return { openSession: async () => { calls.push('session'); } }; } },
    VERSION: 'fixture', createPublicKey: () => ({}), repositorySourceComparisonBaseline: () => null,
    fetchRepositorySourceAuthorization: async () => ({ policy: { automaticValidatedPublication: true } }),
    validateRepositorySourceAuthorization: (value: unknown) => value,
    recoverRepositoryRestorationCandidate: async () => null,
    collectRepositorySourceRestoration: async () => { calls.push('collect');return {
      local: { manifest: { snapshotHash: 'local' } },
      snapshot: { manifest: { snapshotHash: 'snapshot' } }, expectedLatestSourceFingerprint: 'head',
      headCandidateId: 'rolled-back-head', headSnapshotHash: 'head-snapshot', operationId: 'operation',
      priorReleaseId: 'stable', priorGeneration: 17, assertCurrent: async () => { calls.push('recheck'); } }; },
    canonicalize: JSON.stringify, sha256: () => 'reviewed-plan', dharmaHome: () => '/synthetic/device',
    writeRepositoryPackageSnapshot: async (input: { snapshot: { manifest: { snapshotHash: string } }; candidateOnly: boolean }) => {
      assert.equal(input.candidateOnly, true);calls.push(`snapshot-write:${input.snapshot.manifest.snapshotHash}`);
    },
    synchronizeRepositoryCandidate: async (input: Record<string, unknown>) => {
      calls.push('submit');assert.equal(input.initialRepository, false);assert.equal(input.expectedLatestSourceFingerprint, 'head');
      return { state: 'accepted', operationId: 'operation', candidateId: 'candidate', snapshotHash: 'snapshot', releaseId: null };
    },
    saveWorkspaceRecord: async (record: { repositoryPackage: Record<string, unknown> }) => {
      calls.push('registry-write');savedRecord = record;
    },
  };
  const run = (flags: Map<string, string | boolean>) => {
    const fn = runInNewContext(code + '\nrepositoryRestoreCommand', { exports: {}, ...defaults, ...overrides },
      { timeout: 1000, contextCodeGeneration: { strings: false, wasm: false } }) as (flags: Map<string, string | boolean>) => Promise<Record<string, unknown>>;
    return fn(flags);
  };
  const flags = (...entries: Array<[string, string | boolean]>) => new Map<string, string | boolean>([['workspace-id', 'workspace'], ...entries]);
  return { workspace, overrides, calls, run, flags, saved: () => savedRecord };
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
  assert.ok(f.calls.includes('protected-anchor-readonly'));assert.ok(!f.calls.includes('protected-anchor'));
  assert.ok(!f.calls.some(call => /write|submit|relay-state/.test(call)));
});

test('dry-run reads the official legacy enrollment anchor in place without secure-store migration', async () => {
  const f = fixture(), writes: string[] = [];
  const config = { schema: 'dharma.device-config/v1' as const, hqUrl: 'https://fixture.example', organizationId: 'org_fixture',
    deviceId: '44444444-4444-4444-8444-444444444444', deviceName: 'Synthetic', platform: 'linux' as const,
    publicKeyEd25519: 'A'.repeat(43), serverPublicKeyEd25519: 'B'.repeat(43), relayUrl: 'wss://relay.example',
    enrolledAt: '2026-10-01T00:00:00.000Z' };
  const legacy = 'device-enrollment-' + createHash('sha256').update([config.hqUrl, config.organizationId].join(':')).digest('hex').slice(0, 32);
  const anchor = JSON.stringify({ schema: 'dharma.device-enrollment-anchor/v1', hqUrl: config.hqUrl,
    organizationId: config.organizationId, deviceId: config.deviceId, devicePublicKeyEd25519: config.publicKeyEd25519,
    serverPublicKeyEd25519: config.serverPublicKeyEd25519, enrolledAt: config.enrolledAt });
  const values = new Map([[legacy, anchor]]), before = new Map(values);
  const store: SecureSecretStore = { backend: 'linux-secret-service', get: async key => values.get(key) ?? null,
    getFresh: async key => values.get(key) ?? null,
    put: async (key, value) => { writes.push(key);values.set(key, value); }, delete: async key => { writes.push(key);values.delete(key); } };
  f.overrides.loadDeviceEnrollmentAnchor = async (input: { readOnly: boolean }) => loadDeviceEnrollmentAnchor({ config, store, readOnly: input.readOnly });
  await f.run(f.flags(['dry-run', true]));assert.deepEqual(values, before);assert.deepEqual(writes, []);
});

test('restoration submits only the reviewed plan through normal candidate gates without activation', async () => {
  const f = fixture(), result = await f.run(f.flags(['apply', true], ['plan-hash', 'reviewed-plan']));
  assert.equal(result.stage, 'repository_restoration_candidate_submitted');assert.equal(result.activated, false);
  assert.deepEqual(f.calls.slice(-10), ['authorization', 'supervisor-state', 'relay-state', 'recheck', 'supervisor-state', 'relay-state',
    'snapshot-write:local', 'snapshot-write:snapshot', 'submit', 'registry-write']);
  assert.equal(f.saved()?.repositoryPackage.localBaselineSnapshotHash, 'local');
  assert.equal(f.saved()?.repositoryPackage.pendingLocalSnapshotHash, 'local');
  assert.equal(f.saved()?.repositoryPackage.snapshotHash, 'snapshot');
});

test('published restoration keeps the actual local baseline rather than remote-only candidate content', async () => {
  const f = fixture();
  f.overrides.synchronizeRepositoryCandidate = async () => ({ state: 'published', operationId: 'operation',
    candidateId: 'candidate', snapshotHash: 'snapshot', releaseId: 'release' });
  await f.run(f.flags(['apply', true], ['plan-hash', 'reviewed-plan']));
  assert.equal(f.saved()?.repositoryPackage.localBaselineSnapshotHash, 'local');
  assert.equal(f.saved()?.repositoryPackage.publishedLocalSnapshotHash, 'local');
  assert.equal(f.saved()?.repositoryPackage.pendingLocalSnapshotHash, null);
});

test('terminal submission survives a lost registry write and retries without restoration readmission or POST', async () => {
  for (const state of ['published', 'blocked'] as const) {
    const f = fixture();let checkpoint: Record<string, unknown> | null = null, writes = 0, submissions = 0;
    const candidate = { state, operationId: 'operation', candidateId: 'candidate', snapshotHash: 'snapshot',
      releaseId: state === 'published' ? 'release' : null };
    f.overrides.synchronizeRepositoryCandidate = async (input: { restoration: Record<string, unknown> }) => {
      submissions++;checkpoint = { ...input.restoration, candidate, sourceManifestHash: 'reviewed-plan' };return candidate;
    };
    f.overrides.recoverRepositoryRestorationCandidate = async () => checkpoint;
    f.overrides.readRepositoryPackageSnapshot = async (_path: string, hash: string) => ({ manifest: {
      snapshotHash: hash, organizationId: 'org_fixture', workspaceId: 'workspace', knowledge: { repositoryAgentId: 'agent' } } });
    f.overrides.saveWorkspaceRecord = async (record: typeof f.workspace) => {
      if (++writes === 1) throw new Error('simulated_registry_write_failure');
      Object.assign(f.workspace, record);
    };
    const flags = f.flags(['apply', true], ['plan-hash', 'reviewed-plan']);
    await assert.rejects(f.run(flags), /simulated_registry_write_failure/);
    f.overrides.collectRepositorySourceRestoration = async () => { throw new Error('operation_already_used'); };
    for (let replay = 0; replay < 2; replay++) {
      const result = await f.run(flags);
      assert.equal(result.stage, 'repository_restoration_candidate_recovered');
      assert.equal(result.serverSourceMutation, false);assert.equal(result.activated, false);
      assert.equal(f.workspace.repositoryPackage.pendingLocalOperationId, null);
      assert.equal((f.workspace.repositoryPackage as Record<string, unknown>).publishedLocalSnapshotHash,
        state === 'published' ? 'local' : null);
    }
    assert.equal(submissions, 1);
  }
});

test('recovery rejects unavailable CAS, revoked publication, or a restarted supervisor without registry mutation', async () => {
  for (const mode of ['cas', 'revoked', 'supervisor', 'registry']) {
    const f = fixture();
    f.overrides.recoverRepositoryRestorationCandidate = async () => ({ planHash: 'reviewed-plan',
      localSnapshotHash: 'local', baselineSnapshotHash: null, previousOperationId: mode === 'registry' ? 'different' : null,
      priorReleaseId: 'prior', sourceManifestHash: 'reviewed-plan',
      candidate: { state: 'published', operationId: 'operation', candidateId: 'candidate', snapshotHash: 'snapshot', releaseId: 'release' } });
    f.overrides.readRepositoryPackageSnapshot = async () => mode === 'cas' ? null : ({ manifest: {
      organizationId: 'org_fixture', workspaceId: 'workspace', knowledge: { repositoryAgentId: 'agent' } } });
    if (mode === 'revoked') f.overrides.fetchRepositorySourceAuthorization = async () => ({ policy: { automaticValidatedPublication: false } });
    let checks = 0;
    if (mode === 'supervisor') f.overrides.relaySupervisorProcessState = async () => ++checks === 1 ? 'stopped' : 'running';
    await assert.rejects(f.run(f.flags(['apply', true], ['plan-hash', 'reviewed-plan'])));
    assert.ok(!f.calls.some(call => /write|submit|collect/.test(call)));
  }
});

test('running or unknown supervisor, including a final-check restart, cannot write or submit', async () => {
  for (const state of ['running', 'unknown']) for (const stoppedChecks of [0, 1, 2]) {
    const f = fixture();let checks = 0;
    f.overrides.relaySupervisorProcessState = async () => ++checks <= stoppedChecks ? 'stopped' : state;
    await assert.rejects(f.run(f.flags(['apply', true], ['plan-hash', 'reviewed-plan'])), /requires_stopped_relay/);
    assert.ok(!f.calls.some(call => /write|submit/.test(call)));
  }
});

test('terminal history collision and expired final conflict approval stop before any candidate writes', async () => {
  for (const reason of ['repository_source_restoration_operation_already_used', 'repository_source_resolution_expired_or_invalid']) {
    const f = fixture();
    f.overrides.collectRepositorySourceRestoration = async () => ({ snapshot: { manifest: { snapshotHash: 'snapshot' } },
      local: { manifest: { snapshotHash: 'local' } },
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
