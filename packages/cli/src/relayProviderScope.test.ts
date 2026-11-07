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
  const recorded = onboard.indexOf('providerIds: providerIds');
  assert.ok(recorded > 0, 'onboard must save providerIds on the workspace record');
  assert.ok(recorded < onboard.indexOf("staged('first_learning_sync'"), 'the record must hold them before capture syncs policy');
  assert.match(text, /interface WorkspaceRecord \{[\s\S]*providerIds\?: ProviderId\[\];[\s\S]*\n\}/);
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
  assert.match(relay, /prepareProvidersIndependently\(selectedProviderAdapters\(await relayProviderIds\(canonicalWorkspace\)\), assertRunning/);
  assert.match(relay, /for \(const adapter of selectedProviderAdapters\(await relayProviderIds\(canonicalWorkspace\)\)\) \{/);
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
  assert.equal((bootstrap.match(/installStableRepositoryLauncher\(workspace, provider\)/g) || []).length, 2);
  const installer = between(text, 'async function installStableRepositoryLauncher(', "return { shell: '.dharma/bin/dharma', windows: '.dharma/bin/dharma.cmd' };");
  assert.match(installer, /resolveRepositoryProviderDirectory\(\{provider, searchPath: providerProcessEnvironment\(process\.env\)\.PATH\}\)/);
  const upgrade = between(text, 'async function relayUpgrade(', 'const upgrade=maintenance?');
  assert.match(upgrade, /provider: parseSelectedProviderIds\(typeof flags\.get\('provider'\) === 'string'\s*\? \[String\(flags\.get\('provider'\)\)\] : \[\]\)\?\.\[0\] \?\? selected\.providerIds\?\.\[0\] \?\? providerHintFromEnvironment\(\) \?\? 'codex'/);
});
