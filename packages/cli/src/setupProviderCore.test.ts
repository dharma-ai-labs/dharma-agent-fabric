import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import * as cli from './index.js';

// F13 C1 (2026-11-06): setup under Claude Code onboarded only claude, but the relay launcher carried only the
// codex bin directory and setup reported the shared repository ready once any provider held the release, so only
// codex received bundle 3604b630 and setup still said ready. This is the core of PR #425; the relay keeps serving
// every adapter, as on main.

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
  const join = between(text, 'async function joinExistingRepository(', 'async function readDeviceConfig(');
  assert.match(join, /const sharedRepositoryReady = await setupProviderSharedReady\(item, provider\);/);
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
  assert.equal((bootstrap.match(/installStableRepositoryLauncher\(workspace, \[provider\]\)/g) || []).length, 2);
  const installer = between(text, 'async function installStableRepositoryLauncher(', "return { shell: '.dharma/bin/dharma', windows: '.dharma/bin/dharma.cmd' };");
  assert.match(installer, /for \(const provider of \[\.\.\.new Set\(\[\.\.\.holders, \.\.\.providers\]\)\]\)/);
  assert.match(installer, /protectedBundleHolders\(record\)/);
  assert.match(installer, /resolveRepositoryProviderDirectory\(\{provider, searchPath\}\)/);
  assert.match(installer, /providerDirectoriesInPathOrder\(/);
  const upgrade = between(text, 'async function relayUpgrade(', 'const upgrade=maintenance?');
  assert.match(upgrade, /for \(const item of launcherProviders\)/);
  assert.match(upgrade, /resolveRepositoryProviderDirectory\(\{provider: item, searchPath\}\)/);
  assert.match(upgrade, /await protectedBundleHolders\(selected\)/);
  const holders = between(text, 'async function protectedBundleHolders(', 'export async function receiptAwareProviderCapabilities(');
  assert.match(holders, /await providersHoldingInstalledBundle\(workspace\)/);
});

// The scoping half of PR #425 continues after GA. Until then the relay serves every adapter, as on main.
test('actual relay keeps serving every adapter and records no providers on the workspace', async () => {
  const text = await source();
  const relay = between(text, 'async function relayWorkspaceLoop(', 'export async function run(');
  assert.match(relay, /await prepareProvidersIndependently\(providerAdapters, assertRunning/);
  assert.match(relay, /for \(const adapter of providerAdapters\) \{/);
  assert.match(relay, /await syncWorkspacePolicy\(fabric, canonicalWorkspace, policy\.revision, true\);/);
  assert.doesNotMatch(between(text, 'interface WorkspaceRecord {', '\n}'), /providerIds/);
});
