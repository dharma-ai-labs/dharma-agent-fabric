import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { readdirSync, renameSync, writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, resolve, sep } from 'node:path';
import { EventEmitter } from 'node:events';
import { Script } from 'node:vm';
import test from 'node:test';
import ts from 'typescript';
import { canonicalize, sha256, signCanonicalObject } from '@dharma-ai-labs/agent-fabric-contracts';
import { calculateBundleHash, type SkillBundle } from '@dharma-ai-labs/agent-fabric-skill-manager';
import { serializeSkillPreparationRecord } from './skillPreparationRecord.js';
import { skillPreparationScopeRoot, withSkillPreparationTransaction } from './skillPreparationTransaction.js';
import { prepareProvidersIndependently } from './skillPreparationPump.js';
import { withRepositoryRelayStage } from './repositoryRelaySupervisor.js';
import { currentBootstrapHostScope } from './bootstrapHostScope.js';

const WORKSPACE = '11111111-1111-4111-8111-111111111111';
type PublishInput = { home: string; workspaceId: string; provider: 'codex'; sourceRoot: string;
  recordBytes: string; expected: { organizationId: string; deviceId: string; repositoryAgentId: string;
    repositoryBindingId: string | null; policyHash: string; rolloutId: string; bundleId: string; bundleHash: string };
  assertCurrent: () => void; onCommitted: () => void };
async function publisher() {
  return (await import('./skillPreparationCache.js' as string) as {
    publishSkillPreparationCache: (input: PublishInput) => Promise<void>;
  }).publishSkillPreparationCache;
}
async function taker() {
  return (await import('./skillPreparationCache.js' as string) as {
    takeSkillPreparationCache: (input: Record<string, unknown>) => Promise<{ sourceRoot: string; record: Record<string, unknown> } | null>;
  }).takeSkillPreparationCache;
}
async function fixture(writePrepared = true) {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'af-cache-pointer-')));
  const sourceRoot = await withSkillPreparationTransaction({ home, workspaceId: WORKSPACE, provider: 'codex', assertCurrent: () => {} },
    scopeRoot => mkdtemp(join(scopeRoot, 'attempt-')));
  const scopeRoot = skillPreparationScopeRoot(home, WORKSPACE, 'codex');
  const keys = generateKeyPairSync('ed25519');
  const unsigned = { schema: 'dharma.skill-bundle/v2', bundleId: '44444444-4444-4444-8444-444444444444',
    organizationId: 'org_test', version: 'fixture', operation: 'clear', skills: [], riskClass: 'R0',
    targetSelectors: { organizationAgentIds: [], deviceIds: [], workspaceIds: [WORKSPACE], providers: ['codex'] },
    activationPolicy: 'next_session', rollbackBundleId: null,
    evaluationReceiptId: '55555555-5555-4555-8555-555555555555', createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 3600000).toISOString() };
  const signed = { ...unsigned, bundleHash: calculateBundleHash(unsigned as Omit<SkillBundle, 'signature' | 'bundleHash'>) };
  const bundle = { ...signed, signature: signCanonicalObject(signed, keys.privateKey) };
  const record = { schema: 'dharma.skill-preparation/v1', organizationId: 'org_test',
    deviceId: '33333333-3333-4333-8333-333333333333', workspaceId: WORKSPACE,
    repositoryAgentId: '22222222-2222-4222-8222-222222222222', repositoryBindingId: null,
    provider: 'codex', policyHash: sha256('fixture-policy'), rolloutId: 'fixture-rollout',
    bundle, repositoryPackage: null, preparedAt: new Date().toISOString(), activationAuthorized: false };
  const recordBytes = await serializeSkillPreparationRecord(record);
  if (writePrepared) await writeFile(join(sourceRoot, 'PREPARED.json'), recordBytes, { mode: 0o600, flag: 'wx' });
  const expected = { organizationId: record.organizationId, deviceId: record.deviceId,
    repositoryAgentId: record.repositoryAgentId, repositoryBindingId: record.repositoryBindingId,
    policyHash: record.policyHash, rolloutId: record.rolloutId, bundleId: bundle.bundleId, bundleHash: bundle.bundleHash };
  return { home, scopeRoot, sourceRoot, record, recordBytes, expected };
}

test('durable preparation pointer pins exact metadata and never authorizes activation', async () => {
  const f = await fixture(); let committed = false;
  try {
    await (await publisher())({ ...f, workspaceId: WORKSPACE, provider: 'codex', assertCurrent: () => {}, onCommitted: () => { committed = true; } });
    const pointer = JSON.parse(await readFile(join(f.scopeRoot, 'CURRENT.json'), 'utf8'));
    assert.equal(committed, true);
    assert.equal(pointer.schema, 'dharma.skill-preparation-pointer/v1');
    assert.equal(pointer.metadataHash, sha256(f.recordBytes));
    assert.equal(pointer.workspaceId, WORKSPACE);
    assert.equal(pointer.organizationId, 'org_test');
    assert.equal(pointer.activationAuthorized, false);
    assert.equal(await readFile(join(f.scopeRoot, pointer.sourceDirectory, 'PREPARED.json'), 'utf8'), f.recordBytes);
    assert.ok(!pointer.sourceDirectory.includes('/') && pointer.sourceDirectory.startsWith('attempt-'));
    assert.ok(!(await readdir(f.scopeRoot)).some(name => name.startsWith('.CURRENT-')));
  } finally { await rm(f.home, { recursive: true, force: true }); }
});

test('safe-boundary cache take validates scope and transfers a preparation only once', async () => {
  const f = await fixture();
  try {
    await (await publisher())({ ...f, workspaceId: WORKSPACE, provider: 'codex', assertCurrent: () => {}, onCommitted: () => {} });
    const input = { home: f.home, workspaceId: WORKSPACE, provider: 'codex', assertCurrent: () => {},
      organizationId: f.expected.organizationId, deviceId: f.expected.deviceId,
      repositoryAgentId: f.expected.repositoryAgentId, repositoryBindingId: f.expected.repositoryBindingId,
      policyHash: f.expected.policyHash };
    const taken = await (await taker())(input);
    assert.equal(taken?.sourceRoot, f.sourceRoot);
    assert.equal((taken?.record.bundle as { bundleId: string }).bundleId, f.expected.bundleId);
    assert.equal(await (await taker())(input), null);
  } finally { await rm(f.home, { recursive: true, force: true }); }
});

test('a valid stale-policy cache is a non-consuming miss, not activation authority', async () => {
  const f = await fixture();
  try {
    await (await publisher())({ ...f, workspaceId: WORKSPACE, provider: 'codex', assertCurrent: () => {}, onCommitted: () => {} });
    const pointerPath = join(f.scopeRoot, 'CURRENT.json');
    const pointerBytes = await readFile(pointerPath);
    let authorityChecks = 0;
    const result = await (await taker())({ home: f.home, workspaceId: WORKSPACE, provider: 'codex',
      ...f.expected, policyHash: sha256('renewed-fixture-policy'), assertCurrent: () => { authorityChecks++; } });
    assert.equal(result, null);
    assert.ok(authorityChecks >= 2, 'current authority must be rechecked before returning a miss');
    assert.deepEqual(await readFile(pointerPath), pointerBytes);
    assert.equal(await readFile(join(f.sourceRoot, 'PREPARED.json'), 'utf8'), f.recordBytes);
    assert.ok(!(await readdir(f.scopeRoot)).some(name => name.startsWith('.CONSUMING-')));
  } finally { await rm(f.home, { recursive: true, force: true }); }
});

test('stale policy cannot hide a foreign cache identity', async () => {
  const f = await fixture();
  try {
    await (await publisher())({ ...f, workspaceId: WORKSPACE, provider: 'codex', assertCurrent: () => {}, onCommitted: () => {} });
    const pointerPath = join(f.scopeRoot, 'CURRENT.json');
    const pointerBytes = await readFile(pointerPath);
    for (const [key, value] of Object.entries({ organizationId: 'org_foreign',
      deviceId: '66666666-6666-4666-8666-666666666666',
      repositoryAgentId: '77777777-7777-4777-8777-777777777777',
      repositoryBindingId: '88888888-8888-4888-8888-888888888888' })) {
      await assert.rejects((await taker())({ home: f.home, workspaceId: WORKSPACE, provider: 'codex',
        ...f.expected, [key]: value, policyHash: sha256('renewed-fixture-policy'), assertCurrent: () => {} }), /current scope mismatch/);
      assert.deepEqual(await readFile(pointerPath), pointerBytes);
    }
  } finally { await rm(f.home, { recursive: true, force: true }); }
});

test('stale policy cannot hide tampered cache metadata', async () => {
  const f = await fixture();
  try {
    await (await publisher())({ ...f, workspaceId: WORKSPACE, provider: 'codex', assertCurrent: () => {}, onCommitted: () => {} });
    const pointerPath = join(f.scopeRoot, 'CURRENT.json');
    const pointerBytes = await readFile(pointerPath);
    await writeFile(join(f.sourceRoot, 'PREPARED.json'), canonicalize({ ...f.record, rolloutId: 'tampered' }) + '\n');
    await assert.rejects((await taker())({ home: f.home, workspaceId: WORKSPACE, provider: 'codex',
      ...f.expected, policyHash: sha256('renewed-fixture-policy'), assertCurrent: () => {} }), /metadata hash mismatch/);
    assert.deepEqual(await readFile(pointerPath), pointerBytes);
  } finally { await rm(f.home, { recursive: true, force: true }); }
});

test('revocation or cancellation during stale-policy validation cannot become a miss', async () => {
  const f = await fixture();
  try {
    await (await publisher())({ ...f, workspaceId: WORKSPACE, provider: 'codex', assertCurrent: () => {}, onCommitted: () => {} });
    const pointerPath = join(f.scopeRoot, 'CURRENT.json');
    const pointerBytes = await readFile(pointerPath);
    for (const reason of ['revoked', 'expired', 'cancelled']) {
      let checks = 0;
      await assert.rejects((await taker())({ home: f.home, workspaceId: WORKSPACE, provider: 'codex',
        ...f.expected, policyHash: sha256('renewed-fixture-policy'),
        assertCurrent: () => { if (++checks === 2) throw new Error(`fixture ${reason}`); } }), new RegExp(reason));
      assert.equal(checks, 2);
      assert.deepEqual(await readFile(pointerPath), pointerBytes);
    }
  } finally { await rm(f.home, { recursive: true, force: true }); }
});

// Execute the emitted cache reader and safe-boundary callback, with synthetic
// authorization and delivery. This is an offline caller test, not live receipt proof.
async function runPolicyRefreshActivation(f: Awaited<ReturnType<typeof fixture>>, options: {
  denyFresh?: boolean; foreignDevice?: boolean; tamperMetadata?: boolean;
}, diagnostic: (message: string) => void) {
  await (await publisher())({ ...f, workspaceId: WORKSPACE, provider: 'codex', assertCurrent: () => {}, onCommitted: () => {} });
  if (options.tamperMetadata) await writeFile(join(f.sourceRoot, 'PREPARED.json'), f.recordBytes + ' ');
  const source = await readFile(new URL('./index.js', import.meta.url), 'utf8');
  diagnostic(`synthetic policy-refresh caller source=${sha256(await readFile(new URL('../src/index.ts', import.meta.url)))} emitted=${sha256(source)}`);
  const ast = ts.createSourceFile('index.js', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const functions = ast.statements.filter(ts.isFunctionDeclaration);
  const readers = functions.filter(node => node.name?.text === 'takeCachedSkillUpdate');
  const workers = functions.filter(node => node.name?.text === 'relayWorkspaceLoop');
  assert.equal(readers.length, 1); assert.equal(workers.length, 1);
  const callbacks: ts.ArrowFunction[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)
      && node.expression.text === 'withSkillPreparationTransaction') {
      const callback = node.arguments[1];
      if (callback && ts.isArrowFunction(callback) && callback.body.getText(ast).includes('const cached = await takeCachedSkillUpdate(')) {
        callbacks.push(callback);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(workers[0]!);
  assert.equal(callbacks.length, 1, 'unique production activation callback is required');
  let currentChecks = 0; let freshCalls = 0; let activations = 0;
  const policy = { fixture: 'renewed-signed-policy' };
  const config = { organizationId: f.expected.organizationId,
    deviceId: options.foreignDevice ? '99999999-9999-4999-8999-999999999999' : f.expected.deviceId,
    serverPublicKeyEd25519: 'synthetic-not-used-to-activate-cache' };
  const workspace = { workspaceId: WORKSPACE, repositoryAgentId: f.expected.repositoryAgentId,
    repositoryBindingId: f.expected.repositoryBindingId, path: f.home };
  const fabric = Object.freeze({ fixture: true });
  const fresh = Object.freeze({ fixture: 'fresh-authorized-preparation', policy, config, workspace, fabric });
  try {
    await new Script(`${readers[0]!.getText(ast)}\n(${callbacks[0]!.getText(ast)})();`).runInNewContext({
      Map, Error, canonicalize, sha256, canonicalWorkspace: workspace,
      provider: 'codex', policyPath: join(f.home, 'approved-policy.json'), fabric,
      skillPreparationsCompleted: 0, skillActivationsCompleted: 0,
      loadSkillSynchronizationPolicy: async () => ({ workspace, policy, config }),
      takeSkillPreparationCache: await taker(), dharmaHome: () => f.home,
      verifyServerAuthorizedPolicy: () => { currentChecks++; },
      prepareSkillUpdate: async (input: Record<string, unknown>) => {
        freshCalls++;
        assert.equal(input.automatic, true); assert.equal(input.fabric, fabric);
        assert.equal(input.workspaceId, WORKSPACE); assert.equal(input.provider, 'codex');
        if (options.denyFresh) throw new Error('fixture fresh preparation denied');
        return fresh;
      },
      activatePreparedSkillUpdate: async (input: { prepared: unknown }) => {
        assert.equal(input.prepared, fresh, 'stale cache must never become the activated preparation');
        activations++;
      },
      createPublicKey: () => { throw new Error('unexpected stale cache signature path'); },
      rm: () => { throw new Error('unexpected stale cache cleanup'); },
    });
    return { currentChecks, freshCalls, activations, error: null };
  } catch (error) {
    return { currentChecks, freshCalls, activations, error: error instanceof Error ? error.message : String(error) };
  }
}

test('actual relay activation prepares fresh under renewed policy after a valid cache miss', async t => {
  const f = await fixture();
  try {
    const result = await runPolicyRefreshActivation(f, {}, message => t.diagnostic(message));
    assert.equal(result.error, null); assert.ok(result.currentChecks >= 2);
    assert.equal(result.freshCalls, 1); assert.equal(result.activations, 1);
    await readFile(join(f.scopeRoot, 'CURRENT.json'));
  } finally { await rm(f.home, { recursive: true, force: true }); }
});

test('actual relay activation preserves fresh-preparation denial after a stale cache miss', async t => {
  const f = await fixture();
  try {
    const result = await runPolicyRefreshActivation(f, { denyFresh: true }, message => t.diagnostic(message));
    assert.match(result.error ?? '', /fresh preparation denied/);
    assert.equal(result.freshCalls, 1); assert.equal(result.activations, 0);
  } finally { await rm(f.home, { recursive: true, force: true }); }
});

test('actual relay activation never falls back after identity or integrity rejection', async t => {
  for (const options of [{ foreignDevice: true }, { tamperMetadata: true }]) {
    const f = await fixture();
    try {
      const result = await runPolicyRefreshActivation(f, options, message => t.diagnostic(message));
      assert.match(result.error ?? '', /current scope mismatch|metadata hash mismatch/);
      assert.equal(result.freshCalls, 0); assert.equal(result.activations, 0);
    } finally { await rm(f.home, { recursive: true, force: true }); }
  }
});

test('stop before pointer commit leaves no committed cache', async () => {
  const f = await fixture(); let committed = false;
  try {
    await assert.rejects((await publisher())({ ...f, workspaceId: WORKSPACE, provider: 'codex',
      assertCurrent: () => { throw new Error('fixture stopped'); }, onCommitted: () => { committed = true; } }), /stopped/);
    assert.equal(committed, false);
    await assert.rejects(readFile(join(f.scopeRoot, 'CURRENT.json')), { code: 'ENOENT' });
  } finally { await rm(f.home, { recursive: true, force: true }); }
});

test('stop after pointer rename retains the committed snapshot', async () => {
  const f = await fixture(); let committed = false;
  try {
    await assert.rejects((await publisher())({ ...f, workspaceId: WORKSPACE, provider: 'codex',
      assertCurrent: () => { if (committed) throw new Error('fixture stopped after commit'); },
      onCommitted: () => { committed = true; } }), /stopped after commit/);
    assert.equal(committed, true);
    assert.equal(JSON.parse(await readFile(join(f.scopeRoot, 'CURRENT.json'), 'utf8')).metadataHash, sha256(f.recordBytes));
    assert.equal(await readFile(join(f.sourceRoot, 'PREPARED.json'), 'utf8'), f.recordBytes);
  } finally { await rm(f.home, { recursive: true, force: true }); }
});

test('changed metadata or foreign workspace cannot publish a pointer', async () => {
  const f = await fixture();
  try {
    const publish = await publisher();
    await assert.rejects(publish({ ...f, workspaceId: WORKSPACE, provider: 'codex',
      recordBytes: canonicalize({ ...f.record, rolloutId: 'changed' }) + '\n', assertCurrent: () => {}, onCommitted: () => {} }), /metadata/);
    await assert.rejects(publish({ ...f, workspaceId: '66666666-6666-4666-8666-666666666666',
      provider: 'codex', assertCurrent: () => {}, onCommitted: () => {} }), /scope|workspace/);
    await assert.rejects(readFile(join(f.scopeRoot, 'CURRENT.json')), { code: 'ENOENT' });
  } finally { await rm(f.home, { recursive: true, force: true }); }
});

test('symlinked pointer does not modify its foreign target', async () => {
  const f = await fixture(); const foreign = await mkdtemp(join(tmpdir(), 'af-cache-foreign-'));
  try {
    const target = join(foreign, 'pointer.json'); await writeFile(target, 'preserve');
    await symlink(target, join(f.scopeRoot, 'CURRENT.json'));
    await assert.rejects((await publisher())({ ...f, workspaceId: WORKSPACE, provider: 'codex', assertCurrent: () => {}, onCommitted: () => {} }), /pointer|file/);
    assert.equal(await readFile(target, 'utf8'), 'preserve');
  } finally { await rm(f.home, { recursive: true, force: true }); await rm(foreign, { recursive: true, force: true }); }
});

// Synthetic development seam: execute the compiled production function, not its module
// initialization. Authorization, transport, vault and OS-lock boundaries are injected;
// this qualifies staging ownership only, never enrollment, native locking or live use.
async function runActualRelay(f: Awaited<ReturnType<typeof fixture>>, cycles: number,
  diagnostic: (message: string) => void, holdSourceScan = false) {
  const source = await readFile(new URL('./index.js', import.meta.url), 'utf8');
  diagnostic(`synthetic production-caller source=${sha256(await readFile(new URL('../src/index.ts', import.meta.url)))} emitted=${sha256(source)}`);
  const ast = ts.createSourceFile('index.js', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const declarations = ['openBootstrapVault', 'relayWorkspaceLoop'].map(name => {
    const matches = ast.statements.filter(node => ts.isFunctionDeclaration(node) && node.name?.text === name);
    assert.equal(matches.length, 1, `exact production ${name} declaration is required`);
    return matches[0]!.getText(ast);
  });
  const declaration = declarations.join('\n');
  const roots = [f.sourceRoot];
  for (let index = 1; index < cycles; index++) roots.push(await mkdtemp(join(f.scopeRoot, 'attempt-')));
  let preparedCount = 0; let flight: Promise<void> | undefined; let stopped = false;
  let vaultCloses = 0; let transportCalls = 0; let sourceScans = 0; let candidatePolls = 0;
  let releaseSourceScan: (() => void) | undefined;
  let elapsedMs = 0; let activations = 0;
  const events: string[] = [];
  const flags = new Map<string, string | boolean>([['policy', join(f.home, '.dharma', 'approved-policy.json')]]);
  if (!holdSourceScan) flags.set('once', true);
  const workspace = { path: f.home, workspaceId: WORKSPACE, organizationId: 'org_test',
    repositoryAgentId: f.record.repositoryAgentId, repositoryBindingId: '77777777-7777-4777-8777-777777777777' };
  const policy = { revision: 1, fixture: 'synthetic-staging-policy' };
  const processFixture = Object.assign(new EventEmitter(), { pid: 123 });
  const controller = new AbortController();
  const checkedPath = (path: string) => {
    const resolved = resolve(path); const local = relative(f.home, resolved);
    assert.ok(local !== '..' && !local.startsWith(`..${sep}`) && !resolve(local).startsWith(`${sep}${sep}`), 'foreign fixture filesystem path');
    assert.ok(resolved === f.home || resolved.startsWith(f.home + sep), 'fixture filesystem containment');
    return resolved;
  };
  const result = await new Script(`${declaration}\nrelayWorkspaceLoop(flags, signal, serialized);`, { filename: 'synthetic-relay-staging-fixture.js' }).runInNewContext({
    flags, process: processFixture, performance: { now: () => elapsedMs }, Date, Map, Promise, Number, Error,
    signal: controller.signal, serialized: (operation: () => Promise<unknown>) => operation(),
    readFile: (path: string, encoding: 'utf8') => readFile(checkedPath(path), encoding),
    waitForRelayRefresh: async () => {},
    VERSION: '0.2.102',
    resolve, mkdir: (path: string, options: Parameters<typeof mkdir>[1]) => mkdir(checkedPath(path), options),
    writeFile: (path: string, bytes: string, options: Parameters<typeof writeFile>[2]) => writeFile(checkedPath(path), bytes, options),
    rm: (path: string, options: Parameters<typeof rm>[1]) => rm(checkedPath(path), options),
    setTimeout, canonicalize, sha256,
    required: (options: Map<string, string | boolean>, name: string) => options.get(name),
    registry: async () => [workspace],
    loadOrganizationPolicy: async () => ({
      organizationId: workspace.organizationId,
      serverAuthorization: { workspaceId: workspace.workspaceId },
    }),
    loadVerifiedWorkspacePolicy: async () => policy,
    client: async () => Object.freeze({ fixture: true }), dharmaHome: () => f.home,
    acquireRelayProcessLease: async () => async () => {},
    RepositorySourceWatcher: class { invalidate() {} },
    BlockedRepositorySourceRetry: class { consider() { return false; } },
    currentBootstrapHostScope,
    loadVaultModule: async () => ({ LocalVault: { open: async () => ({ close: () => { vaultCloses++; } }) },
      loadOrCreateVaultMasterKey: async (_store: unknown, scope: unknown) => {
        assert.equal(scope, undefined, 'ordinary relay does not acquire host setup authority');
        return Buffer.alloc(32);
      } }),
    rawLocalRetentionDays: () => 1,
    providerAdapters: [{ providerId: 'codex', capability: async () => ({ skillInstall: 'available' }) }],
    isLocalProviderId: (provider: string) => provider === 'codex', prepareProvidersIndependently,
    withSkillPreparationTransaction: async (_input: unknown, operation: () => Promise<void>) => operation(),
    skillPreparationScopeRoot, serializeSkillPreparationRecord,
    publishSkillPreparationCache: await publisher(),
    prepareSkillUpdate: async () => {
      const sourceRoot = roots[preparedCount++]; assert.ok(sourceRoot, 'unexpected extra preparation');
      return { sourceRoot, config: { organizationId: 'org_test', deviceId: f.record.deviceId },
        workspace, policy, rollout: { id: f.record.rolloutId }, bundle: f.record.bundle,
        assertCurrent: () => { if (stopped) throw new Error('fixture stopped'); } };
    },
    startSkillPreparationPump: (input: { prepare: (assertRunning: () => void) => Promise<void> }) => {
      const assertRunning = () => { if (stopped) throw new Error('fixture stopped'); };
      flight = Promise.resolve().then(async () => { for (let index = 0; index < cycles; index++) await input.prepare(assertRunning); });
      return { requestStop: () => { stopped = true; }, stop: async () => { await flight; stopped = true; } };
    },
    withRepositoryRelayStage,
    deferUnavailableRelayRetention: async (operation: () => Promise<unknown>) => ({ state: 'completed', value: await operation() }),
    finalizeRecoveredSignedTaskTrajectories: async () => [], syncWorkspacePolicy: async () => {},
    pollRepositoryCandidate: async () => { candidatePolls++; return null; },
    scanRepositorySourceChanges: async () => {
      sourceScans++; events.push('scan-start');
      if (holdSourceScan) await new Promise<void>(accept => { releaseSourceScan = accept; });
      events.push('scan-end');
      return { state: 'fixture_unchanged', localMutation: false };
    },
    withWorkspaceSkillActivationLock: async () => {
      activations++; events.push(`activate-${activations}`);
      if (holdSourceScan && activations === 2) {
        controller.abort();
        releaseSourceScan?.();
      }
    },
    repositorySharedReady: async () => false,
    installedRepositoryKnowledge: async () => null, syncPendingRetentionCapsules: async () => 0,
    processEvidenceRequest: async () => ({}),
    executeOneTask: async () => {
      transportCalls++; events.push(`task-${transportCalls}`); await flight;
      if (holdSourceScan && transportCalls === 2) {
        assert.ok(releaseSourceScan, 'second task poll must run while source scan is pending');
        elapsedMs = 61_000;
      }
      return {};
    },
    writeJsonAtomic: async () => {},
  }) as Record<string, unknown>;
  assert.equal(vaultCloses, 1); assert.equal(transportCalls, holdSourceScan ? 2 : 1);
  assert.equal(sourceScans, 1, 'source scan must remain single-flight');
  assert.equal(candidatePolls, 1, 'candidate polling must wait until the in-flight scan is applied');
  assert.ok(events.indexOf('task-1') < events.indexOf('activate-1') && events.indexOf('activate-1') < events.indexOf('scan-start'),
    'signed activation must precede source publication at the safe task boundary');
  if (holdSourceScan) assert.ok(events.indexOf('scan-start') < events.indexOf('task-2')
    && events.indexOf('task-2') < events.indexOf('activate-2')
    && events.indexOf('activate-2') < events.indexOf('scan-end'),
  'task polling and signed activation must continue during source reconciliation');
  assert.equal(preparedCount, cycles, 'production staging callback must actually execute');
  assert.equal(processFixture.listenerCount('SIGINT'), 0); assert.equal(processFixture.listenerCount('SIGTERM'), 0);
  return { result, roots };
}

test('actual relay staging publishes a recoverable pointer without live dependencies', async t => {
  const f = await fixture(false);
  try {
    const { result } = await runActualRelay(f, 1, message => t.diagnostic(message));
    assert.equal(result.skillPreparationsCompleted, 1, 'baseline staging must succeed before recovery assertions');
    assert.equal(result.skillPreparationFailures, 0);
    const pointer = JSON.parse(await readFile(join(f.scopeRoot, 'CURRENT.json'), 'utf8'));
    assert.equal(pointer.sourceDirectory, f.sourceRoot.slice(f.scopeRoot.length + 1));
    assert.equal(pointer.activationAuthorized, false);
  } finally { await rm(f.home, { recursive: true, force: true }); }
});

test('actual relay continues task polling during a single in-flight source reconciliation', async t => {
  const f = await fixture(false);
  try {
    const { result } = await runActualRelay(f, 0, message => t.diagnostic(message), true);
    assert.equal(result.repositorySourceState, 'fixture_unchanged');
    assert.equal(result.repositorySourceFailures, 0);
  } finally { await rm(f.home, { recursive: true, force: true }); }
});

test('actual relay second preparation preserves the previous snapshot pending safe retention', async t => {
  const f = await fixture(false);
  try {
    const { result, roots } = await runActualRelay(f, 2, message => t.diagnostic(message));
    assert.equal(result.skillPreparationsCompleted, 2, 'both baseline callbacks must stage successfully');
    assert.equal(result.skillPreparationFailures, 0);
    await readFile(join(roots[0]!, 'PREPARED.json'), 'utf8');
    await readFile(join(roots[1]!, 'PREPARED.json'), 'utf8');
  } finally { await rm(f.home, { recursive: true, force: true }); }
});

test('fresh actual relay invocation leaves durable publication inspectable without inherited Map state', async t => {
  const f = await fixture(false);
  try {
    const first = await runActualRelay(f, 1, message => t.diagnostic(message));
    assert.equal(first.result.skillPreparationsCompleted, 1);
    assert.equal(first.result.skillPreparationFailures, 0);
    const restarted = await runActualRelay(f, 0, message => t.diagnostic(message));
    assert.equal(restarted.result.skillPreparationsCompleted, 0);
    assert.equal(restarted.result.skillPreparationFailures, 0);
    const pointer = JSON.parse(await readFile(join(f.scopeRoot, 'CURRENT.json'), 'utf8'));
    assert.equal(pointer.sourceDirectory, f.sourceRoot.slice(f.scopeRoot.length + 1));
    assert.equal(pointer.activationAuthorized, false);
  } finally { await rm(f.home, { recursive: true, force: true }); }
});

test('preparation cache rejects non-UTF8 metadata even when decoded text matches', async () => {
  const f = await fixture(); let committed = false;
  try {
    f.record.rolloutId = 'fixture-\uFFFD'; f.expected.rolloutId = f.record.rolloutId;
    f.recordBytes = await serializeSkillPreparationRecord(f.record);
    const expected = Buffer.from(f.recordBytes, 'utf8');
    const offset = expected.indexOf(Buffer.from('\uFFFD', 'utf8'));
    assert.ok(offset >= 0, 'fixture must include literal replacement-character bytes');
    const invalid = Buffer.concat([expected.subarray(0, offset), Buffer.from([255]), expected.subarray(offset + 3)]);
    assert.equal(invalid.toString('utf8'), f.recordBytes, 'decoded text alone must collide');
    assert.notDeepEqual(invalid, expected, 'persisted bytes must differ');
    await writeFile(join(f.sourceRoot, 'PREPARED.json'), invalid);
    await assert.rejects((await publisher())({ ...f, workspaceId: WORKSPACE, provider: 'codex',
      assertCurrent: () => {}, onCommitted: () => { committed = true; } }), /UTF|bytes|metadata/);
    assert.equal(committed, false);
    await assert.rejects(readFile(join(f.scopeRoot, 'CURRENT.json')), { code: 'ENOENT' });
  } finally { await rm(f.home, { recursive: true, force: true }); }
});

test('preparation cache rejects a replaced synced pointer before commit', async () => {
  const f = await fixture(); let committed = false; let substituted = false;
  try {
    await assert.rejects((await publisher())({ ...f, workspaceId: WORKSPACE, provider: 'codex',
      assertCurrent: () => {
        if (substituted) return;
        const temporary = readdirSync(f.scopeRoot).find(name => name.startsWith('.CURRENT-'));
        if (!temporary) return;
        const path = join(f.scopeRoot, temporary);
        renameSync(path, join(f.scopeRoot, 'fixture-original-synced-pointer.json'));
        writeFileSync(path, '{"fixture_substitution":true}\n', { mode: 0o600, flag: 'wx' });
        substituted = true;
      }, onCommitted: () => { committed = true; } }), /identity|changed|file|pointer/);
    assert.equal(substituted, true, 'fixture must reach the real post-sync pre-rename window');
    assert.equal(committed, false);
    await assert.rejects(readFile(join(f.scopeRoot, 'CURRENT.json')), { code: 'ENOENT' });
  } finally { await rm(f.home, { recursive: true, force: true }); }
});
