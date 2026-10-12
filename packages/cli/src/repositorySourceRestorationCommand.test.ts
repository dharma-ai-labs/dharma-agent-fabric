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
const saveDeclaration = source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'saveWorkspaceRecord');
assert.ok(saveDeclaration);
const saveCode = ts.transpileModule(saveDeclaration.getText(source), {
  compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.CommonJS },
}).outputText;

test('relay adopts a committed registry receipt before retryable marker failure, but never before a failed save', async () => {
  let poll: ts.IfStatement | undefined;
  const visit = (node: ts.Node) => {
    if (ts.isIfStatement(node) && node.expression.getText(source) === 'current && canonicalWorkspace.repositoryPackage') poll = node;
    ts.forEachChild(node, visit);
  };
  visit(source);assert.ok(poll);
  const pollCode = ts.transpileModule(`async function pollOnce(current: any) { ${poll.getText(source)} }`,
    { compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.CommonJS } }).outputText;
  for (const mode of ['marker-failed', 'save-failed', 'same'] as const) {
    const original = { workspaceId: 'workspace', organizationId: 'org_fixture', repositoryBindingId: 'binding', repositoryAgentId: 'agent',
      repositoryPackage: { state: 'processing', candidateId: 'candidate', operationId: 'operation', generation: 18 } };
    let records: unknown[] = [structuredClone(original)], saves = 0, checkpoints = 0, locked = false;
    const context = { exports: {}, structuredClone, canonicalize: JSON.stringify,
      canonicalWorkspace: structuredClone(original), publishedLocalSnapshotHash: null, repositorySourceWatcher: { invalidate: () => {} },
      advanceRepositorySourceBaseline: () => ({ publishedLocalSnapshotHash: 'local' }), repositorySourcePollInvalidatesWatcher: () => false,
      currentBootstrapHostScope: () => undefined, workspaceRegistryPath: () => '/synthetic/registry.json',
      dharmaHome: () => '/synthetic', resolve: (...args: string[]) => args.join('/'),
      acquirePidLock: async () => { locked = true;return async () => { locked = false; }; },
      readFile: async () => JSON.stringify(records), saveRegistry: async (next: unknown[]) => {
        assert.equal(locked, true);if (mode === 'save-failed') throw new Error('registry_failure');
        records = structuredClone(next);saves++;
      },
      checkpointRepositoryRestorationRegistry: async () => {
        assert.equal(locked, true);if (++checkpoints === 1 && mode === 'marker-failed') throw new Error('marker_failure');
      },
    };
    const run = runInNewContext(saveCode + '\n' + pollCode + '\npollOnce', context,
      { timeout: 1000, contextCodeGeneration: { strings: false, wasm: false } }) as (value: unknown) => Promise<void>;
    const current = { state: 'published', candidateId: 'candidate', operationId: 'operation', snapshotHash: 'snapshot', releaseId: 'release' };
    if (mode === 'same') await run(current);
    else await assert.rejects(run(current), mode === 'marker-failed' ? /marker_failure/ : /registry_failure/);
    assert.equal(locked, false);
    assert.equal(context.canonicalWorkspace.repositoryPackage.state, mode === 'save-failed' ? 'processing' : 'published');
    if (mode === 'marker-failed') { await run(current);assert.equal(checkpoints, 2);assert.equal(saves, 2); }
    if (mode === 'save-failed') { assert.equal(checkpoints, 0);assert.equal(saves, 0); }
  }
});

test('official guarded registry save compares the current locked record before any outbox checkpoint', async () => {
  for (const mode of ['same', 'operation-changed', 'scope-changed', 'missing', 'checkpoint-failed']) {
    const expected = { workspaceId: 'workspace', organizationId: 'org_fixture', repositoryPackage: { operationId: 'previous' } };
    let records: Array<Record<string, unknown>> = [structuredClone(expected), { workspaceId: 'sibling', marker: 'preserve' }];
    const calls: string[] = [];let locked = false;
    const fn = runInNewContext(saveCode + '\nsaveWorkspaceRecord', { exports: {}, structuredClone,
      canonicalize: JSON.stringify, currentBootstrapHostScope: () => undefined, workspaceRegistryPath: () => '/synthetic/registry.json',
      acquirePidLock: async () => {
        calls.push('lock');locked = true;
        if (mode === 'operation-changed') records[0] = { ...expected, repositoryPackage: { operationId: 'newer' } };
        if (mode === 'scope-changed') records[0] = { ...expected, organizationId: 'org_other' };
        if (mode === 'missing') records = records.slice(1);
        return async () => { calls.push('release');locked = false; };
      },
      readFile: async () => { assert.equal(locked, true);calls.push('read-current');return JSON.stringify(records); },
      saveRegistry: async (next: typeof records) => { assert.equal(locked, true);calls.push('save');records = next; },
    }, { timeout: 1000, contextCodeGeneration: { strings: false, wasm: false } }) as
      (record: unknown, guard: { expected: unknown; beforeSave: () => Promise<void> }) => Promise<void>;
    const guard = { expected, beforeSave: async () => {
      assert.equal(locked, true);calls.push('checkpoint');
      if (mode === 'checkpoint-failed') throw new Error('checkpoint_failure');
    } };
    const updated = { ...expected, repositoryPackage: { operationId: 'recovered' } };
    if (mode === 'same') {
      await fn(updated, guard);
      assert.deepEqual(calls, ['lock', 'read-current', 'checkpoint', 'save', 'release']);
      assert.equal((records.find(row => row.workspaceId === 'workspace')!.repositoryPackage as Record<string, unknown>).operationId, 'recovered');
    } else {
      await assert.rejects(fn(updated, guard), mode === 'checkpoint-failed' ? /checkpoint_failure/ : /compare_and_swap_failed/);
      assert.ok(!calls.includes('save'));
      if (mode !== 'checkpoint-failed') assert.ok(!calls.includes('checkpoint'));
    }
    assert.equal(locked, false);assert.equal(records.find(row => row.workspaceId === 'sibling')!.marker, 'preserve');
  }
});

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
    fetchRepositorySourceAuthorization: async () => ({ generationId: 'current-generation', policy: { automaticValidatedPublication: true } }),
    validateRepositorySourceAuthorization: (value: unknown) => value,
    recoverRepositoryRestorationCandidate: async () => null,
    readRepositoryRestorationAttempt: async () => undefined,
    checkpointRepositoryRestorationCandidate: async (input: { recovered: { candidate: unknown } }) => {
      calls.push('outbox-write');return input.recovered.candidate;
    },
    checkpointRepositoryRestorationRegistry: async () => { calls.push('registry-checkpoint'); },
    collectRepositorySourceRestoration: async () => { calls.push('collect');return {
      local: { manifest: { snapshotHash: 'local' } },
      snapshot: { manifest: { snapshotHash: 'snapshot', sourceAuthorization: {
        generationId: 'current-generation', policy: { automaticValidatedPublication: true } } } }, expectedLatestSourceFingerprint: 'head',
      headCandidateId: 'rolled-back-head', headSnapshotHash: 'head-snapshot', operationId: 'operation',
      priorReleaseId: 'stable', priorGeneration: 17, assertCurrent: async () => { calls.push('recheck'); },
      assertLocalCurrent: async () => { calls.push('local-recheck'); } }; },
    canonicalize: JSON.stringify, sha256: () => 'reviewed-plan', dharmaHome: () => '/synthetic/device',
    writeRepositoryPackageSnapshot: async (input: { snapshot: { manifest: { snapshotHash: string } }; candidateOnly: boolean }) => {
      assert.equal(input.candidateOnly, true);calls.push(`snapshot-write:${input.snapshot.manifest.snapshotHash}`);
    },
    synchronizeRepositoryCandidate: async (input: Record<string, unknown>) => {
      calls.push('submit');assert.equal(input.initialRepository, false);assert.equal(input.expectedLatestSourceFingerprint, 'head');
      assert.equal((input.restoration as Record<string, unknown>).headCandidateId, 'rolled-back-head');
      return { state: 'accepted', operationId: 'operation', candidateId: 'candidate', snapshotHash: 'snapshot', releaseId: null };
    },
    saveWorkspaceRecord: async (record: { repositoryPackage: Record<string, unknown> }, guard?: {
      beforeSave?: () => Promise<void>; preparePackage?: () => Promise<Record<string, unknown>>;
      afterSave?: (record: unknown) => Promise<void>;
    }) => {
      await guard?.beforeSave?.();
      if (guard?.preparePackage) record = { ...record, repositoryPackage: await guard.preparePackage() };
      calls.push('registry-write');savedRecord = record;
      await guard?.afterSave?.(record);
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

test('explicit fencing is guarded metadata recovery, never a source upload or activation', async () => {
  const f = fixture();
  f.overrides.fenceRepositoryRestorationUpload = async (input: { expectedPreviousOperationId: string | null }) => {
    assert.equal(input.expectedPreviousOperationId, null);f.calls.push('fence');
    return { candidate: null, fence: { fenceId: 'terminal-fence' } };
  };
  f.overrides.checkpointRepositoryRestorationFence = async () => { f.calls.push('fence-checkpoint'); };
  const result = await f.run(f.flags(['apply', true], ['plan-hash', 'reviewed-plan'], ['fence-upload', true]));
  assert.equal(result.stage, 'repository_restoration_upload_fenced');assert.equal(result.activated, false);
  assert.equal(result.serverSourceMutation, false);
  assert.ok(f.calls.indexOf('fence-checkpoint') > f.calls.indexOf('fence'));
  assert.ok(!f.calls.some(call => /collect|submit|snapshot-write|outbox-write/.test(call)));
});

test('fencing refuses changed authority and running clients before checkpoint retirement', async () => {
  for (const mode of ['pending', 'revoked', 'restarted', 'candidate-won']) {
    const f = fixture();
    if (mode === 'pending') f.workspace.repositoryPackage.pendingLocalOperationId = 'existing';
    f.overrides.fenceRepositoryRestorationUpload = async () => {
      f.calls.push('fence');
      if (mode === 'revoked') f.overrides.fetchRepositorySourceAuthorization = async () => ({ generationId: 'changed', policy: {} });
      return { candidate: mode === 'candidate-won' ? { candidateId: 'existing' } : null,
        fence: mode === 'candidate-won' ? null : { fenceId: 'terminal' } };
    };
    let checks = 0;
    f.overrides.fetchRepositorySourceAuthorization = async () => ({ generationId: mode === 'revoked' && ++checks > 2 ? 'changed' : 'current-generation',
      policy: { automaticValidatedPublication: true } });
    let relayChecks = 0;
    if (mode === 'restarted') f.overrides.relayProcessState = async () => ++relayChecks > 2 ? 'running' : 'stopped';
    f.overrides.checkpointRepositoryRestorationFence = async () => { f.calls.push('fence-checkpoint'); };
    const run = f.run(f.flags(['apply', true], ['plan-hash', 'reviewed-plan'], ['fence-upload', true]));
    if (mode === 'candidate-won') assert.equal((await run).stage, 'repository_restoration_admission_found');
    else await assert.rejects(run, /workspace_not_authorized|policy_changed|requires_stopped_relay/);
    assert.equal(f.calls.includes('fence-checkpoint'), mode === 'revoked');assert.ok(!f.calls.includes('submit'));
  }
});

test('restoration planning has no source, registry or activation writes', async () => {
  const f = fixture(), result = await f.run(f.flags(['dry-run', true]));
  assert.equal(result.planHash, 'reviewed-plan');assert.equal(result.activated, false);assert.equal(result.published, false);
  assert.equal(result.localMutation, false);assert.equal(result.serverSourceMutation, false);
  assert.ok(f.calls.includes('protected-anchor-readonly'));assert.ok(!f.calls.includes('protected-anchor'));
  assert.ok(!f.calls.some(call => /write|submit|relay-state/.test(call)));
});

test('review regression: fresh registry CAS failure precedes every source write and admission', async () => {
  const f = fixture();
  f.overrides.saveWorkspaceRecord = async () => { throw new Error('workspace_registry_compare_and_swap_failed'); };
  await assert.rejects(f.run(f.flags(['apply', true], ['plan-hash', 'reviewed-plan'])), /compare_and_swap_failed/);
  assert.ok(!f.calls.some(call => /snapshot-write|submit/.test(call)));
});

test('review regression: recovery revalidates changed source authority inside the registry lock', async () => {
  const f = fixture();let locked = false;
  f.overrides.recoverRepositoryRestorationCandidate = async () => ({ planHash: 'reviewed-plan',
    localSnapshotHash: 'local', baselineSnapshotHash: null, previousOperationId: null,
    priorReleaseId: 'prior', sourceManifestHash: 'reviewed-plan',
    candidate: { state: 'published', operationId: 'operation', candidateId: 'candidate', snapshotHash: 'snapshot', releaseId: 'release' } });
  f.overrides.readRepositoryPackageSnapshot = async () => ({ manifest: {
    organizationId: 'org_fixture', workspaceId: 'workspace', knowledge: { repositoryAgentId: 'agent' },
    sourceAuthorization: { generationId: 'current-generation', policy: { automaticValidatedPublication: true } } } });
  f.overrides.fetchRepositorySourceAuthorization = async () => ({ generationId: locked ? 'replacement' : 'current-generation',
    policy: { automaticValidatedPublication: true } });
  f.overrides.saveWorkspaceRecord = async (_record: unknown, guard: { beforeSave?: () => Promise<void> }) => {
    locked = true;await guard.beforeSave?.();f.calls.push('registry-write');
  };
  await assert.rejects(f.run(f.flags(['apply', true], ['plan-hash', 'reviewed-plan'])), /policy_changed/);
  assert.ok(!f.calls.some(call => /outbox-write|registry-write/.test(call)));
});

test('review regression: final local currentness is checked after authority waits', async () => {
  const f = fixture();let stale = false;
  f.overrides.collectRepositorySourceRestoration = async () => ({
    local: { manifest: { snapshotHash: 'local' } }, snapshot: { manifest: { snapshotHash: 'snapshot',
      sourceAuthorization: { generationId: 'current-generation', policy: { automaticValidatedPublication: true } } } },
    expectedLatestSourceFingerprint: 'head', headCandidateId: 'rolled-back-head', headSnapshotHash: 'head-snapshot',
    operationId: 'operation', priorReleaseId: 'stable', priorGeneration: 17,
    assertCurrent: async () => { f.calls.push('recheck'); },
    assertLocalCurrent: async () => { if (stale) throw new Error('repository_source_restoration_workspace_changed'); },
  });
  let reads = 0;
  f.overrides.fetchRepositorySourceAuthorization = async () => {
    if (++reads >= 2) stale = true;
    return { generationId: 'current-generation', policy: { automaticValidatedPublication: true } };
  };
  await assert.rejects(f.run(f.flags(['apply', true], ['plan-hash', 'reviewed-plan'])), /workspace_changed/);
  assert.ok(!f.calls.some(call => /snapshot-write|submit/.test(call)));
});

test('review regression: a relay or supervisor restart during the final local scan prevents all source writes', async () => {
  for (const process of ['relay', 'supervisor'] as const) {
    const f = fixture();let restarted = false;
    f.overrides.relayProcessState = async () => process === 'relay' && restarted ? 'running' : 'stopped';
    f.overrides.relaySupervisorProcessState = async () => process === 'supervisor' && restarted ? 'running' : 'stopped';
    f.overrides.collectRepositorySourceRestoration = async () => ({
      local: { manifest: { snapshotHash: 'local' } }, snapshot: { manifest: { snapshotHash: 'snapshot',
        sourceAuthorization: { generationId: 'current-generation', policy: { automaticValidatedPublication: true } } } },
      expectedLatestSourceFingerprint: 'head', headCandidateId: 'rolled-back-head', headSnapshotHash: 'head-snapshot',
      operationId: 'operation', priorReleaseId: 'stable', priorGeneration: 17,
      assertCurrent: async () => {}, assertLocalCurrent: async () => { restarted = true; },
    });
    await assert.rejects(f.run(f.flags(['apply', true], ['plan-hash', 'reviewed-plan'])), /requires_stopped_relay/);
    assert.ok(!f.calls.some(call => /snapshot-write|submit|registry-write/.test(call)));
  }
});

test('review regression: admitted restoration reconciles historical authority after policy rollover without republishing', async () => {
  for (const state of ['accepted', 'processing', 'published', 'blocked'] as const) {
    const f = fixture();const historical = { generationId: 'admission-generation', policy: { automaticValidatedPublication: true } };
    f.overrides.recoverRepositoryRestorationCandidate = async () => ({ planHash: 'reviewed-plan',
      localSnapshotHash: 'local', baselineSnapshotHash: null, previousOperationId: null,
      priorReleaseId: 'prior', sourceManifestHash: 'reviewed-plan',
      candidate: { state, operationId: 'operation', candidateId: 'candidate', snapshotHash: 'snapshot',
        releaseId: state === 'published' ? 'release' : null } });
    f.overrides.readRepositoryPackageSnapshot = async () => ({ manifest: {
      organizationId: 'org_fixture', workspaceId: 'workspace', knowledge: { repositoryAgentId: 'agent' },
      sourceAuthorization: historical } });
    let historicalChecks = 0, currentChecks = 0;
    f.overrides.validateRepositorySourceAuthorization = (value: typeof historical, _scope: unknown, now?: Date) => {
      if (value.generationId === historical.generationId) { historicalChecks++;assert.equal(now, undefined); }
      else { currentChecks++;assert.ok(now); }
      return value;
    };
    const result = await f.run(f.flags(['apply', true], ['plan-hash', 'reviewed-plan']));
    assert.equal(result.stage, 'repository_restoration_candidate_recovered');assert.equal(result.serverSourceMutation, false);
    assert.equal(f.saved()?.repositoryPackage.sourcePolicyGenerationId, 'admission-generation');
    assert.ok(historicalChecks >= 2);assert.ok(currentChecks >= 3);
    assert.ok(!f.calls.some(call => /snapshot-write|submit|collect/.test(call)));
  }
});

test('review regression: an acknowledged fence survives a later source-policy rollover', async () => {
  const f = fixture();let changed = false;
  f.overrides.fetchRepositorySourceAuthorization = async () => ({ generationId: changed ? 'replacement' : 'current-generation',
    policy: { automaticValidatedPublication: true } });
  f.overrides.fenceRepositoryRestorationUpload = async () => { changed = true;return { candidate: null, fence: { fenceId: 'terminal' } }; };
  f.overrides.checkpointRepositoryRestorationFence = async () => { f.calls.push('fence-checkpoint'); };
  await assert.rejects(f.run(f.flags(['apply', true], ['plan-hash', 'reviewed-plan'], ['fence-upload', true])), /policy_changed/);
  assert.ok(f.calls.includes('fence-checkpoint'));assert.ok(!f.calls.includes('registry-write'));
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
  assert.deepEqual(f.calls.slice(-17), ['authorization', 'supervisor-state', 'relay-state', 'recheck', 'supervisor-state', 'relay-state', 'authorization', 'supervisor-state', 'relay-state',
    'local-recheck', 'supervisor-state', 'relay-state', 'snapshot-write:local', 'snapshot-write:snapshot', 'submit', 'registry-write', 'registry-checkpoint']);
  assert.equal(f.saved()?.repositoryPackage.localBaselineSnapshotHash, 'local');
  assert.equal(f.saved()?.repositoryPackage.pendingLocalSnapshotHash, 'local');
  assert.equal(f.saved()?.repositoryPackage.snapshotHash, 'snapshot');
  assert.equal(f.saved()?.repositoryPackage.sourcePolicyGenerationId, 'current-generation');
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

test('submission survives a lost registry write and recovery checkpoints before retrying the registry', async () => {
  for (const state of ['accepted', 'processing', 'published', 'blocked'] as const) {
    const f = fixture();let checkpoint: Record<string, unknown> | null = null, writes = 0, submissions = 0;
    const candidate = { state, operationId: 'operation', candidateId: 'candidate', snapshotHash: 'snapshot',
      releaseId: state === 'published' ? 'release' : null };
    f.overrides.synchronizeRepositoryCandidate = async (input: { restoration: Record<string, unknown> }) => {
      submissions++;checkpoint = { ...input.restoration, candidate, sourceManifestHash: 'reviewed-plan' };return candidate;
    };
    f.overrides.recoverRepositoryRestorationCandidate = async () => checkpoint;
    f.overrides.readRepositoryPackageSnapshot = async (_path: string, hash: string) => ({ manifest: {
      snapshotHash: hash, organizationId: 'org_fixture', workspaceId: 'workspace', knowledge: { repositoryAgentId: 'agent' },
      sourceAuthorization: { generationId: 'current-generation', policy: { automaticValidatedPublication: true } } } });
    f.overrides.saveWorkspaceRecord = async (record: typeof f.workspace, guard?: { beforeSave?: () => Promise<void>;
      preparePackage?: () => Promise<typeof record.repositoryPackage>; afterSave?: (record: unknown) => Promise<void> }) => {
      await guard?.beforeSave?.();
      if (guard?.preparePackage) record = { ...record, repositoryPackage: await guard.preparePackage() };
      f.calls.push('registry-write');
      if (++writes === 1) throw new Error('simulated_registry_write_failure');
      Object.assign(f.workspace, record);
      await guard?.afterSave?.(record);
    };
    const flags = f.flags(['apply', true], ['plan-hash', 'reviewed-plan']);
    await assert.rejects(f.run(flags), /simulated_registry_write_failure/);
    f.overrides.collectRepositorySourceRestoration = async () => { throw new Error('operation_already_used'); };
    for (let replay = 0; replay < 2; replay++) {
      const result = await f.run(flags);
      assert.equal(result.stage, 'repository_restoration_candidate_recovered');
      assert.equal(result.serverSourceMutation, false);assert.equal(result.activated, false);
      assert.deepEqual(f.calls.slice(-6), ['authorization', 'supervisor-state', 'relay-state', 'outbox-write', 'registry-write', 'registry-checkpoint']);
      assert.equal((f.workspace.repositoryPackage as Record<string, unknown>).sourcePolicyGenerationId, 'current-generation');
      assert.equal(f.workspace.repositoryPackage.pendingLocalOperationId,
        state === 'accepted' || state === 'processing' ? 'operation' : null);
      assert.equal((f.workspace.repositoryPackage as Record<string, unknown>).publishedLocalSnapshotHash,
        state === 'published' ? 'local' : null);
    }
    assert.equal(submissions, 1);
  }
});

test('recovery rejects unavailable CAS, revoked publication, or a restarted supervisor without registry mutation', async () => {
  for (const mode of ['cas', 'revoked', 'final-revoked', 'changed-generation', 'snapshot-generation', 'supervisor', 'registry']) {
    const f = fixture();
    f.overrides.recoverRepositoryRestorationCandidate = async () => ({ planHash: 'reviewed-plan',
      localSnapshotHash: 'local', baselineSnapshotHash: null, previousOperationId: mode === 'registry' ? 'different' : null,
      priorReleaseId: 'prior', sourceManifestHash: 'reviewed-plan',
      candidate: { state: 'published', operationId: 'operation', candidateId: 'candidate', snapshotHash: 'snapshot', releaseId: 'release' } });
    f.overrides.readRepositoryPackageSnapshot = async (_path: string, hash: string) => mode === 'cas' ? null : ({ manifest: {
      organizationId: 'org_fixture', workspaceId: 'workspace', knowledge: { repositoryAgentId: 'agent' },
      sourceAuthorization: { generationId: mode === 'snapshot-generation' && hash === 'local' ? 'foreign-generation' : 'current-generation',
        policy: { automaticValidatedPublication: true } } } });
    if (mode === 'revoked') f.overrides.fetchRepositorySourceAuthorization = async () => ({ policy: { automaticValidatedPublication: false } });
    let authorityChecks = 0;
    if (mode === 'final-revoked') f.overrides.assertWorkspaceAuthorizationCurrent = async () => {
      if (++authorityChecks > 1) throw new Error('revoked');
    };
    let sourceChecks = 0;
    if (mode === 'changed-generation') f.overrides.fetchRepositorySourceAuthorization = async () => ({
      generationId: ++sourceChecks === 1 ? 'current-generation' : 'replacement-generation', policy: { automaticValidatedPublication: true } });
    let checks = 0;
    if (mode === 'supervisor') f.overrides.relaySupervisorProcessState = async () => ++checks === 1 ? 'stopped' : 'running';
    await assert.rejects(f.run(f.flags(['apply', true], ['plan-hash', 'reviewed-plan'])));
    assert.ok(!f.calls.some(call => /write|submit|collect/.test(call)));
  }
});

test('running or unknown supervisor, including a final-check restart, cannot write or submit', async () => {
  for (const state of ['running', 'unknown']) for (const stoppedChecks of [0, 1, 2, 3]) {
    const f = fixture();let checks = 0;
    f.overrides.relaySupervisorProcessState = async () => ++checks <= stoppedChecks ? 'stopped' : state;
    await assert.rejects(f.run(f.flags(['apply', true], ['plan-hash', 'reviewed-plan'])), /requires_stopped_relay/);
    assert.ok(!f.calls.some(call => /write|submit/.test(call)));
  }
});

test('workspace authority superseded during final awaited reads cannot persist or submit restoration', async () => {
  const f = fixture();let superseded = false;
  f.overrides.assertWorkspaceAuthorizationCurrent = async () => {
    if (superseded) throw new Error('workspace_authorization_superseded');
  };
  f.overrides.collectRepositorySourceRestoration = async () => ({
    local: { manifest: { snapshotHash: 'local' } },
    snapshot: { manifest: { snapshotHash: 'snapshot', sourceAuthorization: {
      generationId: 'current-generation', policy: { automaticValidatedPublication: true } } } },
    expectedLatestSourceFingerprint: 'head', headCandidateId: 'rolled-back-head', headSnapshotHash: 'head-snapshot',
    operationId: 'operation', priorReleaseId: 'stable', priorGeneration: 17,
    assertCurrent: async () => { await Promise.resolve();superseded = true; },
  });
  await assert.rejects(f.run(f.flags(['apply', true], ['plan-hash', 'reviewed-plan'])), /workspace_authorization_superseded/);
  assert.ok(!f.calls.some(call => /write|submit/.test(call)));
});

test('source policy rollover during final awaited reads cannot write a stale pending outbox', async () => {
  const f = fixture();let changed = false;
  f.overrides.fetchRepositorySourceAuthorization = async () => ({
    generationId: changed ? 'replacement-generation' : 'current-generation', policy: { automaticValidatedPublication: true } });
  f.overrides.collectRepositorySourceRestoration = async () => ({
    local: { manifest: { snapshotHash: 'local' } },
    snapshot: { manifest: { snapshotHash: 'snapshot', sourceAuthorization: {
      generationId: 'current-generation', policy: { automaticValidatedPublication: true } } } },
    expectedLatestSourceFingerprint: 'head', headCandidateId: 'rolled-back-head', headSnapshotHash: 'head-snapshot',
    operationId: 'operation', priorReleaseId: 'stable', priorGeneration: 17,
    assertCurrent: async () => { await Promise.resolve();changed = true; },
  });
  await assert.rejects(f.run(f.flags(['apply', true], ['plan-hash', 'reviewed-plan'])), /policy_changed/);
  assert.ok(!f.calls.some(call => /write|submit/.test(call)));
});

test('matching pending restoration retries reconcile a later terminal receipt without fresh admission', async () => {
  for (const state of ['accepted', 'processing'] as const) {
    const f = fixture();f.workspace.repositoryPackage.pendingLocalOperationId = 'operation';
    Object.assign(f.workspace.repositoryPackage, { operationId: 'operation' });
    f.overrides.recoverRepositoryRestorationCandidate = async () => ({ planHash: 'reviewed-plan',
      localSnapshotHash: 'local', baselineSnapshotHash: null, previousOperationId: null,
      priorReleaseId: 'prior', sourceManifestHash: 'reviewed-plan',
      candidate: { state, operationId: 'operation', candidateId: 'candidate', snapshotHash: 'snapshot', releaseId: null } });
    f.overrides.readRepositoryPackageSnapshot = async () => ({ manifest: { organizationId: 'org_fixture', workspaceId: 'workspace',
      knowledge: { repositoryAgentId: 'agent' }, sourceAuthorization: {
        generationId: 'current-generation', policy: { automaticValidatedPublication: true } } } });
    const flags = f.flags(['apply', true], ['plan-hash', 'reviewed-plan']);
    assert.equal((await f.run(flags)).stage, 'repository_restoration_candidate_recovered');
    f.overrides.recoverRepositoryRestorationCandidate = async () => ({ planHash: 'reviewed-plan',
      localSnapshotHash: 'local', baselineSnapshotHash: null, previousOperationId: null,
      priorReleaseId: 'prior', sourceManifestHash: 'reviewed-plan',
      candidate: { state: 'published', operationId: 'operation', candidateId: 'candidate', snapshotHash: 'snapshot', releaseId: 'release' } });
    assert.equal((await f.run(flags)).stage, 'repository_restoration_candidate_recovered');
    assert.equal(f.saved()?.repositoryPackage.pendingLocalOperationId, null);
    assert.ok(!f.calls.includes('collect'));assert.ok(!f.calls.includes('submit'));
    f.workspace.repositoryPackage.pendingLocalOperationId = 'foreign-operation';
    const priorWrites = f.calls.filter(call => call.includes('write')).length;
    await assert.rejects(f.run(flags), /checkpoint_registry_changed/);
    assert.equal(f.calls.filter(call => call.includes('write')).length, priorWrites);
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

test('recovery validates a non-null comparison baseline before checkpoint or registry writes', async () => {
  for (const state of ['processing', 'published', 'blocked']) for (const mode of ['missing', 'foreign']) {
    const f = fixture();
    f.overrides.recoverRepositoryRestorationCandidate = async () => ({ planHash: 'reviewed-plan',
      localSnapshotHash: 'local', baselineSnapshotHash: 'baseline', previousOperationId: null,
      priorReleaseId: 'prior', sourceManifestHash: 'reviewed-plan', candidate: {
        state, operationId: 'operation', candidateId: 'candidate', snapshotHash: 'snapshot', releaseId: state === 'published' ? 'new-release' : null } });
    f.overrides.readRepositoryPackageSnapshot = async (_path: string, hash: string) => hash === 'baseline' && mode === 'missing' ? null : ({ manifest: {
      organizationId: hash === 'baseline' ? 'org_other' : 'org_fixture', workspaceId: 'workspace',
      knowledge: { repositoryAgentId: 'agent' }, sourceAuthorization: {
        generationId: 'current-generation', policy: { automaticValidatedPublication: true } } } });
    await assert.rejects(f.run(f.flags(['apply', true], ['plan-hash', 'reviewed-plan'])), /checkpoint_snapshot_invalid/);
    assert.ok(!f.calls.some(call => /write|submit/.test(call)));
  }
});

test('archived release identity cannot be recorded as a fresh or recovered restoration', async () => {
  for (const recovered of [false, true]) {
    const f = fixture();
    const candidate = { state: 'published', operationId: 'operation', candidateId: 'candidate', snapshotHash: 'snapshot', releaseId: 'stable' };
    f.overrides.synchronizeRepositoryCandidate = async () => candidate;
    if (recovered) f.overrides.recoverRepositoryRestorationCandidate = async () => ({
      planHash: 'reviewed-plan', localSnapshotHash: 'local', baselineSnapshotHash: null, previousOperationId: null,
      priorReleaseId: 'stable', sourceManifestHash: 'reviewed-plan', candidate });
    await assert.rejects(f.run(f.flags(['apply', true], ['plan-hash', 'reviewed-plan'])), /archived_release_reused/);
    assert.ok(!f.calls.includes('outbox-write'));assert.ok(!f.calls.includes('registry-write'));
  }
});

test('runtime restarted during final authority or registry-lock waits stops before protected writes', async () => {
  const f = fixture();let running = false, checks = 0;
  f.overrides.assertWorkspaceAuthorizationCurrent = async () => { if (++checks === 3) running = true; };
  f.overrides.relaySupervisorProcessState = async () => running ? 'running' : 'stopped';
  await assert.rejects(f.run(f.flags(['apply', true], ['plan-hash', 'reviewed-plan'])), /requires_stopped_relay/);
  assert.ok(!f.calls.some(call => /write|submit/.test(call)));
  const r = fixture();
  r.overrides.recoverRepositoryRestorationCandidate = async () => ({ planHash: 'reviewed-plan', localSnapshotHash: 'local',
    baselineSnapshotHash: null, previousOperationId: null, priorReleaseId: 'prior', sourceManifestHash: 'reviewed-plan',
    candidate: { state: 'processing', operationId: 'operation', candidateId: 'candidate', snapshotHash: 'snapshot', releaseId: null } });
  r.overrides.readRepositoryPackageSnapshot = async () => ({ manifest: { organizationId: 'org_fixture', workspaceId: 'workspace',
    knowledge: { repositoryAgentId: 'agent' }, sourceAuthorization: { generationId: 'current-generation', policy: { automaticValidatedPublication: true } } } });
  let restart = false;
  r.overrides.relaySupervisorProcessState = async () => restart ? 'running' : 'stopped';
  r.overrides.saveWorkspaceRecord = async (_record: unknown, guard: { beforeSave: () => Promise<void> }) => {
    restart = true;await guard.beforeSave();throw new Error('unexpected_registry_write');
  };
  await assert.rejects(r.run(r.flags(['apply', true], ['plan-hash', 'reviewed-plan'])), /requires_stopped_relay/);
  assert.ok(!r.calls.some(call => /write|submit/.test(call)));
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
