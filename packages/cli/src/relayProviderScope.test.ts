import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import * as cli from './index.js';

// F13 C1 (2026-11-06): setup under Claude Code onboarded only claude, but onboard's first learning sync
// and the relay registered and installed for every adapter, so only codex received bundle 3604b630 and
// setup still reported the shared repository ready.

const exported = cli as unknown as Record<string, any>;

async function source() {
  return readFile(new URL('../src/index.ts', import.meta.url), 'utf8');
}

function between(text: string, start: string, end: string) {
  const from = text.indexOf(start);
  assert.ok(from >= 0, `missing ${start}`);
  const to = text.indexOf(end, from);
  assert.ok(to > from, `missing ${end}`);
  return text.slice(from, to);
}

test('the relay serves only the onboarded providers plus any provider that already holds an installed bundle', () => {
  assert.equal(typeof exported.scopedRelayProviderIds, 'function');
  const scoped = exported.scopedRelayProviderIds as (providerIds: string[] | undefined, installed: string[]) => string[] | null;
  assert.equal(scoped(undefined, ['codex']), null, 'a record written before this field stays unfiltered');
  assert.deepEqual(scoped(['claude'], []), ['claude']);
  assert.deepEqual(scoped(['claude'], ['codex']), ['codex', 'claude'], 'an installed provider is still served for rollback and clear');
  assert.deepEqual(scoped(['claude'], ['claude']), ['claude']);
});

test('actual onboard records the selected providers on the workspace before the first learning sync', async () => {
  const text = await source();
  const onboard = between(text, 'async function onboard(flags', 'async function evidenceSync(');
  const recorded = onboard.indexOf('providerIds: recordedProviders');
  assert.ok(recorded > 0, 'onboard must save providerIds on the workspace record');
  assert.ok(recorded < onboard.indexOf("staged('first_learning_sync'"), 'the record must hold them before capture syncs policy');
  assert.match(text, /interface WorkspaceRecord \{[\s\S]*providerIds\?: ProviderId\[\];[\s\S]*\n\}/);
});

// PR #425 fix round 1 (2): onboard and join replaced providerIds, so setting up codex after claude in the same
// checkout dropped claude from the relay's release scope.
test('setting up a second provider in the same checkout keeps the first in providerIds', async () => {
  assert.equal(typeof exported.recordedProviderIds, 'function');
  const recorded = exported.recordedProviderIds as (existing: string[] | undefined, added: string[]) => string[];
  assert.deepEqual(recorded(recorded(undefined, ['claude']), ['codex']), ['claude', 'codex']);
  assert.deepEqual(recorded(['claude', 'codex'], ['claude']), ['claude', 'codex']);
  const text = await source();
  const onboard = between(text, 'async function onboard(flags', 'async function evidenceSync(');
  // Fix round 2 (1): a record without providers starts from the protected holders of its bundle.
  assert.match(onboard, /recordedProviders = providerIds && await setUpProviderIds\(registered, providerIds\);/);
  assert.doesNotMatch(onboard, /providerIds: providerIds\b/);
  const join = between(text, "const workspace = resolve(dharmaHome(), 'joined-repositories', bindingId);", "const roleInput = {");
  assert.match(join, /await setUpProviderIds\(item, \[provider\]\)/);
  const seed = between(text, 'async function setUpProviderIds(', 'async function relayProviderIds(');
  assert.match(seed, /recordedProviderIds\(workspace\.providerIds \?\? await protectedBundleHolders\(workspace\), added\)/);
  const relay = between(text, 'async function relayProviderIds(', 'export async function receiptAwareProviderCapabilities(');
  assert.match(relay, /await protectedBundleHolders\(workspace, workspace\.providerIds, onUnprotected\)/);
  assert.doesNotMatch(join, /providerIds: \[provider\]/);
});

test('actual content-transmission policy refresh probes the workspace provider scope, not every adapter', async () => {
  const text = await source();
  const refresh = between(text, 'async function refreshVerifiedWorkspacePolicyForTransmission(', 'export function assertCapsuleIntegrity(');
  assert.doesNotMatch(refresh, /providerCapabilitiesForWorkspacePolicy\(null\)/);
  assert.match(refresh, /providerCapabilitiesForWorkspacePolicy\(\s*scoped \? await relayProviderIds\(scoped\) : null\)/);
});

test('actual relay policy sync, preparation pump and activation loop use the workspace provider scope', async () => {
  const text = await source();
  const relay = between(text, 'async function relayWorkspaceLoop(', 'export async function run(');
  assert.match(relay, /await syncWorkspacePolicy\(fabric, canonicalWorkspace, policy\.revision, true,\s*await relayProviderIds\(canonicalWorkspace\)\)/);
  assert.match(relay, /prepareProvidersIndependently\(selectedProviderAdapters\(canonicalWorkspace\.providerIds \?\? null\), assertRunning/);
  assert.match(relay, /for \(const adapter of selectedProviderAdapters\(scopedProviders\)\) \{/);
  assert.doesNotMatch(relay, /prepareProvidersIndependently\(providerAdapters,/);
  assert.doesNotMatch(relay, /for \(const adapter of providerAdapters\)/);
});

test('setup readiness counts only a release installed for the provider it set up', async () => {
  assert.equal(typeof exported.setupProviderSharedReady, 'function');
  const ready = exported.setupProviderSharedReady as (item: unknown, provider: string,
    load: (workspace: unknown, provider: string) => Promise<unknown>) => Promise<boolean>;
  const codexOnly = async (_workspace: unknown, provider: string) => provider === 'codex' ? { catalogBytes: 1 } : null;
  assert.equal(await ready({}, 'claude', codexOnly), false);
  assert.equal(await ready({}, 'codex', codexOnly), true);
  assert.equal(await ready({}, 'claude', async () => { throw new Error('unreadable'); }), false);
  const text = await source();
  const wait = between(text, "withOnboardingStage('readiness', workspaceId, resumeCommand,", 'onProgress: progress =>');
  assert.match(wait, /ready: await setupProviderSharedReady\(current, provider\)/);
  const onboard = between(text, 'async function onboard(flags', 'async function evidenceSync(');
  assert.match(onboard, /staged\('readiness', async \(\) => providerIds\?\.length === 1\s*\? setupProviderSharedReady\(registered, providerIds\[0\]!\) : repositorySharedReady\(registered\)\)/);
});

test('the inner repository block agrees with the readiness wait it was returned with', () => {
  assert.equal(typeof exported.repositoryAfterReadiness, 'function');
  const after = exported.repositoryAfterReadiness as (onboarded: Record<string, unknown>,
    readiness: { outcome: string } | null) => Record<string, unknown>;
  const onboarded = { ok: true, stage: 'shared_repository_pending', sharedRepositoryReady: false, workspaceId: 'w',
    sharedRepository: { authority: 'local_inventory_not_signed', publication: 'published', activation: false } };
  assert.equal(after(onboarded, null), onboarded, 'without a wait the onboard result is returned unchanged');
  assert.deepEqual(after(onboarded, { outcome: 'ready' }), { ...onboarded, stage: 'ready', sharedRepositoryReady: true,
    sharedRepository: { authority: 'signed_repository_release', publication: 'published', activation: true } });
  assert.deepEqual(after(onboarded, { outcome: 'blocked' }), { ...onboarded, stage: 'shared_repository_blocked' });
  assert.deepEqual(after(onboarded, { outcome: 'pending' }), onboarded);
});

test('actual bootstrap returns the overlaid repository block', async () => {
  const text = await source();
  const result = between(text, "repositoryReadiness?.outcome === 'blocked' ? 'shared_repository_blocked' : 'shared_repository_pending'",
    'export function summarizeBootstrapOrganizationApi(');
  assert.match(result, /repository: repositoryAfterReadiness\(onboarded, repositoryReadiness\),/);
});

test('actual setup and relay upgrade put the set-up provider bin directory on the relay launcher PATH', async () => {
  const text = await source();
  const bootstrap = between(text, 'const {launcher, autostart} = flags.has(\'no-relay-daemon\')', 'let sharedRepositoryReady = onboarded.sharedRepositoryReady === true;');
  // Fix round 2 (2): the launcher carries the bin directory of every provider the record names, not only this one.
  assert.match(between(text, '// The launcher carries every provider the record names, so', 'const {launcher, autostart} ='),
    /const launcherProviders = recordedProviderIds\(\(await step\(\(\) => registry\(\)\)\)\s*\.find\(item => item\.workspaceId === onboarded\.workspaceId\)\?\.providerIds, \[provider\]\);/);
  assert.equal((bootstrap.match(/installStableRepositoryLauncher\(workspace, launcherProviders\)/g) || []).length, 2);
  const installer = between(text, 'async function installStableRepositoryLauncher(', "return { shell: '.dharma/bin/dharma', windows: '.dharma/bin/dharma.cmd' };");
  assert.match(installer, /for \(const provider of providers\)/);
  assert.match(installer, /resolveRepositoryProviderDirectory\(\{provider, searchPath\}\)/);
  assert.match(installer, /providerDirectoriesInPathOrder\(/);
  const upgrade = between(text, 'async function relayUpgrade(', 'const upgrade=maintenance?');
  assert.match(upgrade, /for \(const item of launcherProviders\)/);
  assert.match(upgrade, /resolveRepositoryProviderDirectory\(\{provider: item, searchPath\}\)/);
});

// PR #425 review (5): a provider kept only for rollback has no bin directory on the launcher PATH, and the relay
// skipped it as unavailable without a word, so its rollback and clear silently stopped.
test('actual relay activation records a scoped provider it cannot reach instead of skipping it silently', async () => {
  const text = await source();
  const relay = between(text, 'async function relayWorkspaceLoop(', 'export async function run(');
  assert.match(relay, /const scopedProviders = await relayProviderIds\(canonicalWorkspace, provider => \{[\s\S]{0,240}\}\);\s*for \(const adapter of selectedProviderAdapters\(scopedProviders\)\) \{/);
  assert.match(relay, /if \(capability\.skillInstall === 'unavailable'\) \{\s*(?:\/\/.*\s*)*if \(scopedProviders\) record\(\{ outcome: 'failed', errorCode: 'provider_unreachable' \}\);\s*continue;\s*\}/);
  const { parseRelaySkillActivationState } = await import('./skillActivationResult.js');
  assert.ok(parseRelaySkillActivationState({ schema: 'dharma.relay-skill-activation/v1', workspaceId: 'w', updatedAt: '2026-11-06T06:30:00.000Z',
    counters: { preparationsCompleted: 0, preparationFailures: 0, activationsCompleted: 0, activationFailures: 0 },
    providers: { codex: { at: '2026-11-06T06:30:00.000Z', outcome: 'failed', rolloutId: null, bundleId: null,
      errorCode: 'provider_unreachable' } } }, 'w'), 'setup and status can read the recorded reason');
});

test('actual upgrade and the relay share one reader of providers that hold an installed bundle', async () => {
  const text = await source();
  const relay = between(text, 'async function protectedBundleHolders(', 'async function setUpProviderIds(');
  assert.match(relay, /providersHoldingInstalledBundle\(workspace, skip\)/);
  const upgrade = between(text, 'async function relayUpgrade(', 'const upgrade=maintenance?');
  assert.match(upgrade, /await providersHoldingInstalledBundle\(selected\)/);
});

// PR #425 review round 2 (1): a provider kept only because it holds a bundle still got every new release, and the
// relay ran its executable from the user-manager PATH, where on the F13 host codex is another user's binary.
async function runRelayTick(scenario: { codexProtected: boolean; offer: 'install' | 'clear';
  previous?: Record<string, unknown>; holders?: string[]; providerIdsAfterStart?: string[] }) {
  const ts = (await import('typescript')).default;
  const { resolve } = await import('node:path');
  const { runInNewContext } = await import('node:vm');
  const { prepareProvidersIndependently } = await import('./skillPreparationPump.js');
  const { withRepositoryRelayStage } = await import('./repositoryRelaySupervisor.js');
  const { nextSkillActivationResult, relaySkillActivationPath, requireActiveSkillInstall, skillActivationErrorCode }
    = await import('./skillActivationResult.js');
  const text = await source();
  const ast = ts.createSourceFile('index.ts', text, ts.ScriptTarget.Latest, true);
  const declarations = ['relayWorkspaceLoop', 'relayProviderIds', 'protectedBundleHolders', 'scopedRelayProviderIds',
    'selectedProviderAdapters'].map(name => {
    const nodes = ast.statements.filter(node => ts.isFunctionDeclaration(node) && node.name?.text === name);
    assert.equal(nodes.length, 1, name);
    return nodes[0]!.getText(ast);
  });
  const output = ts.transpileModule(declarations.join('\n'), { compilerOptions: {
    target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.None } });
  const home = resolve('/fixture-home');
  const workspace = { workspaceId: '11111111-1111-4111-8111-111111111111', organizationId: 'org_test', path: resolve('/fixture-work'),
    accessMode: 'knowledge_only', providerIds: ['claude'], repositoryAgentId: '22222222-2222-4222-8222-222222222222' };
  const policyPath = resolve(workspace.path, '.dharma', 'approved-policy.json');
  const probed: string[] = [], pumped: string[] = [], polled: { provider: string; clearOnly: unknown }[] = [];
  const activated: string[] = [], synced: unknown[] = [], written: Record<string, any>[] = [];
  let pump: Promise<void> | undefined;
  let registryReads = 0;
  const adapter = (providerId: string) => ({ providerId,
    capability: async () => { probed.push(providerId); return { skillInstall: 'available' }; } });
  const offered = (provider: string) => ({ workspace, rollout: { id: `rollout-${provider}` }, sourceRoot: resolve(home, provider),
    bundle: { bundleId: `bundle-${provider}`, operation: provider === 'codex' ? scenario.offer : 'install' } });
  const context = {
    exports: {}, resolve, Date, Map, Promise, Number, Error, performance: { now: () => 0 }, process: { env: { PATH: '/fixture/bin' } },
    VERSION: '0.2.224', LOCAL_PROVIDER_IDS: ['codex', 'claude', 'agy', 'hermes'],
    providerAdapters: ['codex', 'claude', 'agy', 'hermes'].map(adapter),
    required: (flags: Map<string, unknown>, name: string) => flags.get(name),
    loadOrganizationPolicy: async () => ({ organizationId: 'org_test', serverAuthorization: { workspaceId: workspace.workspaceId } }),
    // Setup can record another provider after the relay read the row at start.
    registry: async () => registryReads++ && scenario.providerIdsAfterStart
      ? [{ ...workspace, providerIds: scenario.providerIdsAfterStart }] : [workspace],
    withRepositoryRelayStage,
    loadVerifiedWorkspacePolicyUnlessReplayAhead: async () => ({ revision: 'policy' }),
    loadVerifiedWorkspacePolicy: async () => ({ revision: 'policy' }),
    client: async () => ({ fixture: true }), relayAutostartReport: async () => ({}), dharmaHome: () => home,
    writeJsonAtomic: async (_path: string, value: Record<string, any>) => { written.push(value); },
    RepositorySourceWatcher: class { invalidate() {} }, BlockedRepositorySourceRetry: class { consider() { return false; } },
    openBootstrapVault: async () => ({ close: async () => {} }), rawLocalRetentionDays: () => 1,
    readRelaySkillActivationState: async () => scenario.previous ? { providers: { codex: scenario.previous } } : null,
    providersHoldingInstalledBundle: async (_workspace: unknown, skip: string[] = []) =>
      (scenario.holders ?? ['codex']).filter(provider => !skip.includes(provider)),
    providerProcessEnvironment: (env: Record<string, string>) => env,
    resolveRepositoryProviderDirectory: async (input: { provider: string }) => {
      if (input.provider === 'codex' && !scenario.codexProtected) throw new Error('relay_startup_codex_path_invalid');
      return undefined;
    },
    isLocalProviderId: () => true, prepareProvidersIndependently,
    withSkillPreparationTransaction: async (_input: unknown, operation: () => Promise<void>) => operation(),
    startSkillPreparationPump: (input: { prepare: (assertRunning: () => void) => Promise<void> }) => {
      pump = input.prepare(() => {});
      return { requestStop: () => {}, stop: async () => { await pump; } };
    },
    prepareSkillUpdate: async (input: { provider: string; assertRunning?: unknown; clearOnly?: unknown;
      onOfferIgnored?: () => void }) => {
      if (input.assertRunning) { pumped.push(input.provider); return null; }
      polled.push({ provider: input.provider, clearOnly: input.clearOnly });
      const prepared = offered(input.provider);
      // As the real preparation does, a clear-only poll ignores an offered install and says so.
      if (input.clearOnly && prepared.bundle.operation !== 'clear') { input.onOfferIgnored?.(); return null; }
      return prepared;
    },
    takeCachedSkillUpdate: async () => null,
    activatePreparedSkillUpdate: async (input: { provider: string }) => { activated.push(input.provider); return { status: 'active' }; },
    withWorkspaceSkillActivationLock: async (_workspaceId: string, _provider: string, operation: () => Promise<void>) => operation(),
    deferUnavailableRelayRetention: async (operation: () => Promise<unknown>) => ({ state: 'completed', value: await operation() }),
    finalizeRecoveredSignedTaskTrajectories: async () => [],
    syncWorkspacePolicy: async (...input: unknown[]) => { synced.push(input[4]); },
    executeOneTask: async () => { await pump; return {}; },
    readFile: async () => { throw Object.assign(new Error('absent'), { code: 'ENOENT' }); },
    waitForRelayRefresh: async () => {}, repositorySharedReady: async () => false,
    nextSkillActivationResult, relaySkillActivationPath, requireActiveSkillInstall, skillActivationErrorCode,
  };
  const compiled = runInNewContext(`${output.outputText}\n({relayWorkspaceLoop})`, context) as
    { relayWorkspaceLoop: (...input: unknown[]) => Promise<Record<string, unknown>> };
  await compiled.relayWorkspaceLoop(new Map<string, unknown>([['policy', policyPath], ['once', true]]),
    new AbortController().signal, (operation: () => Promise<unknown>) => operation());
  return { probed, pumped, polled, activated, synced, providers: written.at(-1)?.providers ?? {} };
}

test('actual relay never runs an unprotected holder executable and never gives it a new release', async () => {
  const run = await runRelayTick({ codexProtected: false, offer: 'install' });
  assert.deepEqual(run.synced, [['claude']], 'policy sync must not probe the unprotected codex');
  assert.deepEqual(run.pumped, ['claude'], 'background preparation is for the set-up provider only');
  assert.ok(!run.probed.includes('codex'), 'the other user codex must not be executed');
  assert.deepEqual(run.activated, ['claude']);
  assert.equal(run.providers.codex?.outcome, 'failed');
  assert.equal(run.providers.codex?.errorCode, 'provider_unsafe_path');
  assert.equal(run.providers.claude?.outcome, 'activated');
});

test('actual relay gives a protected holder only a clear, never a new release', async () => {
  const install = await runRelayTick({ codexProtected: true, offer: 'install' });
  assert.deepEqual(install.pumped, ['claude'], 'background preparation is for the set-up provider only');
  assert.deepEqual(install.polled, [{ provider: 'codex', clearOnly: true }, { provider: 'claude', clearOnly: false }]);
  assert.deepEqual(install.activated, ['claude'], 'the holder must not receive the new release');
  assert.equal(install.providers.codex?.outcome, 'failed');
  assert.equal(install.providers.codex?.errorCode, 'provider_not_set_up');
  const clear = await runRelayTick({ codexProtected: true, offer: 'clear' });
  assert.deepEqual(clear.activated, ['codex', 'claude'], 'rollback to the clear baseline still reaches the holder');
});

// PR #425 fix round 2 (1): an install dropped for a holder was recorded as no_rollout, which turned an earlier
// activated or up_to_date result into up_to_date, so status said the holder was current while it kept an old release.
test('actual relay reports a release withheld from a holder, never up to date', async () => {
  for (const outcome of ['activated', 'up_to_date']) {
    const previous = { at: '2026-11-05T06:30:00.000Z', outcome, rolloutId: null, bundleId: 'bundle-old', errorCode: null };
    const run = await runRelayTick({ codexProtected: true, offer: 'install', previous });
    assert.deepEqual(run.activated, ['claude'], outcome);
    assert.equal(run.providers.codex?.outcome, 'failed', outcome);
    assert.equal(run.providers.codex?.errorCode, 'provider_not_set_up', outcome);
    const { parseRelaySkillActivationState } = await import('./skillActivationResult.js');
    assert.ok(parseRelaySkillActivationState({ schema: 'dharma.relay-skill-activation/v1', workspaceId: 'w',
      updatedAt: '2026-11-06T06:30:00.000Z', counters: { preparationsCompleted: 0, preparationFailures: 0,
        activationsCompleted: 0, activationFailures: 0 }, providers: { codex: run.providers.codex } }, 'w'),
    'setup and status can read the recorded reason');
  }
  const current = await runRelayTick({ codexProtected: true, offer: 'clear',
    previous: { at: '2026-11-05T06:30:00.000Z', outcome: 'failed', rolloutId: null, bundleId: null, errorCode: 'provider_not_set_up' } });
  assert.equal(current.providers.codex?.outcome, 'activated', 'a clear the holder takes still reaches it');
});

// PR #425 fix round 3 (1): the relay read providerIds once at start, so `bootstrap --provider codex` after claude in
// the same checkout left the running relay on [claude]: codex held no bundle, was never polled or registered, and
// its setup readiness wait could not finish until the relay restarted.
test('actual running relay serves a provider set up after it started, without a restart', async () => {
  const run = await runRelayTick({ codexProtected: true, offer: 'install', holders: [],
    providerIdsAfterStart: ['claude', 'codex'] });
  assert.deepEqual(run.synced, [['codex', 'claude']], 'the policy refresh registers the newly set-up provider');
  assert.deepEqual(run.pumped.sort(), ['claude', 'codex'], 'background preparation includes the new provider');
  assert.deepEqual(run.polled, [{ provider: 'codex', clearOnly: false }, { provider: 'claude', clearOnly: false }]);
  assert.deepEqual(run.activated, ['codex', 'claude'], 'the new provider receives its release');
  assert.equal(run.providers.codex?.outcome, 'activated');
});

// PR #425 fix round 3 (1), case 2: onboard wrote approved-policy.json before it recorded providerIds, so an already
// running supervisor could start the new workspace's relay unscoped, serving and probing every adapter for its life.
test('actual onboard records the selected providers before the first policy sync writes the relay policy', async () => {
  const text = await source();
  const onboard = between(text, 'async function onboard(flags', 'async function evidenceSync(');
  const bind = onboard.indexOf('await registerWorkspaceBeforeRepositoryBind(fabric, registered, policyRevision, providerIds)');
  assert.ok(bind > 0, 'onboard registers the workspace before the repository bind');
  const saved = onboard.indexOf('await saveWorkspaceRecord(registered);');
  assert.ok(saved > 0 && saved < bind, 'providerIds must be saved before the sync that materializes the policy');
});

// PR #425 review round 4 (1): the relay saved its WorkspaceRecord snapshot without a guard, so a source-scan save
// after `bootstrap --provider codex` recorded codex wrote the relay's stale providerIds back and dropped codex.
async function relaySaveAfterSetup(call: string) {
  const ts = (await import('typescript')).default;
  const { mkdtemp, mkdir, readFile, rm, writeFile } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { resolve } = await import('node:path');
  const { runInNewContext } = await import('node:vm');
  const { canonicalize } = await import('@dharma-ai-labs/agent-fabric-contracts');
  const text = await source();
  const ast = ts.createSourceFile('index.ts', text, ts.ScriptTarget.Latest, true);
  const declarations = ['saveWorkspaceRecord', 'saveRegistry', 'workspaceRegistryPath'].map(name => {
    const nodes = ast.statements.filter(node => ts.isFunctionDeclaration(node) && node.name?.text === name);
    assert.equal(nodes.length, 1, name);
    return nodes[0]!.getText(ast);
  });
  const output = ts.transpileModule(declarations.join('\n'), { compilerOptions: {
    target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.None } });
  const home = await mkdtemp(resolve(tmpdir(), 'fabric-relay-provider-save-'));
  try {
    const path = resolve(home, 'registry', 'workspaces.json');
    await mkdir(resolve(home, 'registry'), { recursive: true });
    const started = { workspaceId: '11111111-1111-4111-8111-111111111111', organizationId: 'org_test',
      providerIds: ['claude'], repositoryPackage: { localBaselineSnapshotHash: 'sha256:old' } };
    await writeFile(path, JSON.stringify([started]));
    // The relay holds the row it read at start; setup then records codex on the stored row.
    const canonicalWorkspace = structuredClone(started);
    await writeFile(path, JSON.stringify([{ ...started, providerIds: ['claude', 'codex'] }]));
    canonicalWorkspace.repositoryPackage.localBaselineSnapshotHash = 'sha256:new';
    const context = { resolve, readFile, mkdir, canonicalize, structuredClone, JSON, Array, Error,
      dharmaHome: () => home, currentBootstrapHostScope: () => undefined,
      acquirePidLock: async () => async () => {},
      writeJsonAtomic: async (target: string, value: unknown) => writeFile(target, JSON.stringify(value)),
      canonicalWorkspace };
    await runInNewContext(`${output.outputText}\n(async () => { await ${call}; })()`, context);
    return JSON.parse(await readFile(path, 'utf8'))[0] as { providerIds?: string[];
      repositoryPackage: { localBaselineSnapshotHash: string } };
  } finally { await rm(home, { recursive: true, force: true }); }
}

test('actual relay saves after setup recorded a provider keep that provider', async () => {
  const text = await source();
  const relay = between(text, 'async function relayWorkspaceLoop(', 'export async function run(');
  const scan = between(relay, 'const applyReadySourceScan = async () => {', 'const consumeSourceScan = async');
  const recovery = between(relay, 'await recoverPublishedLocalSourceBaseline({', '} catch { repositorySourceBaselineAvailable = false; }');
  for (const [name, block] of [['source scan', scan], ['baseline recovery', recovery]] as const) {
    const calls = [...block.matchAll(/await (saveWorkspaceRecord\(canonicalWorkspace\b[^;]*\));/g)].map(match => match[1]!);
    assert.equal(calls.length, 1, `${name} saves the record once`);
    const stored = await relaySaveAfterSetup(calls[0]!);
    assert.deepEqual(stored.providerIds, ['claude', 'codex'], `${name} save must keep the provider setup recorded`);
    assert.equal(stored.repositoryPackage.localBaselineSnapshotHash, 'sha256:new', `${name} save still writes its change`);
  }
});
