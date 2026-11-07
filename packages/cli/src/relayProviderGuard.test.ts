import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { claudeAdapter, codexAdapter } from '@dharma-ai-labs/agent-fabric-provider-adapters';

// PR #427 review (3x8=24): setup refused a host whose first codex on PATH belonged to another user, but #427 lets
// setup finish for claude and start the relay, and the relay probed and ran every adapter. The relay now checks
// each provider's first executable on its PATH with setup's rules before it runs it.

type Guard = {
  PROVIDER_UNSAFE_PATH: string;
  relayProviderUnsafePath(provider: string, options?: { env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform }): Promise<boolean>;
  relayProviderCapability(adapter: typeof codexAdapter, options?: { env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform }):
    Promise<{ unsafePath: boolean; capability: Awaited<ReturnType<typeof codexAdapter.capability>> }>;
};
const guard = async () => await import('./relayProviderGuard.js' as string) as Guard;

const exists = (path: string) => stat(path).then(() => true, () => false);

async function hostWithPath(build: (root: string) => Promise<string>, run: (root: string) => Promise<void>) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'fabric-relay-provider-guard-')));
  const saved = { PATH: process.env.PATH, HOME: process.env.HOME };
  try {
    process.env.PATH = await build(root);
    process.env.HOME = root;
    await run(root);
  } finally {
    process.env.PATH = saved.PATH;
    if (saved.HOME === undefined) delete process.env.HOME; else process.env.HOME = saved.HOME;
    await chmod(join(root, 'foreign'), 0o700).catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
}

// Each fixture executable leaves a marker when it runs, so a test sees whether the relay executed it.
const fixture = (root: string, name: string, version: string) =>
  `#!/bin/sh\n: > '${join(root, `${name}-ran`)}'\nprintf '${version}\\n'\n`;

test('relay never runs an unsafe codex earlier on PATH and reports provider_unsafe_path', { skip: process.platform !== 'linux' }, async () => {
  const { PROVIDER_UNSAFE_PATH, relayProviderCapability, relayProviderUnsafePath } = await guard();
  assert.equal(PROVIDER_UNSAFE_PATH, 'provider_unsafe_path');
  await hostWithPath(async root => {
    const foreign = join(root, 'foreign'), own = join(root, 'own');
    await mkdir(foreign, { mode: 0o700 }); await mkdir(own, { mode: 0o700 });
    await writeFile(join(foreign, 'codex'), fixture(root, 'foreign-codex', 'codex-cli 9.9.9'), { mode: 0o700 });
    await writeFile(join(own, 'codex'), fixture(root, 'own-codex', 'codex-cli 1.0.0'), { mode: 0o700 });
    // Another user's directory is the same to this check as one any user can write to.
    await chmod(foreign, 0o777);
    return `${foreign}:${own}`;
  }, async root => {
    assert.equal(await relayProviderUnsafePath('codex'), true);
    const probed = await relayProviderCapability(codexAdapter);
    assert.equal(probed.unsafePath, true);
    assert.equal(probed.capability.provider, 'codex');
    assert.equal(probed.capability.version, null);
    assert.equal(probed.capability.skillInstall, 'unavailable');
    assert.equal(probed.capability.taskExecution, 'unavailable');
    assert.equal(probed.capability.skillRollback, 'unavailable');
    assert.equal(await exists(join(root, 'foreign-codex-ran')), false, 'the unsafe codex must never be executed');
    // An unsafe first match is not skipped for a later one, as setup does not skip it.
    assert.equal(await exists(join(root, 'own-codex-ran')), false);
  });
});

test('relay still probes a safe claude on the launcher PATH when an unsafe codex comes first', { skip: process.platform !== 'linux' }, async () => {
  const { relayProviderCapability, relayProviderUnsafePath } = await guard();
  await hostWithPath(async root => {
    const foreign = join(root, 'foreign'), own = join(root, 'own');
    await mkdir(foreign, { mode: 0o700 }); await mkdir(own, { mode: 0o700 });
    await writeFile(join(foreign, 'codex'), fixture(root, 'foreign-codex', 'codex-cli 9.9.9'), { mode: 0o700 });
    await writeFile(join(own, 'claude'), fixture(root, 'own-claude', '2.0.0 (Claude Code)'), { mode: 0o700 });
    await chmod(foreign, 0o777);
    return `${foreign}:${own}`;
  }, async root => {
    assert.equal(await relayProviderUnsafePath('claude'), false);
    const probed = await relayProviderCapability(claudeAdapter);
    assert.equal(probed.unsafePath, false);
    assert.equal(probed.capability.version, '2.0.0 (Claude Code)');
    assert.equal(probed.capability.skillInstall, 'available');
    assert.equal(await exists(join(root, 'own-claude-ran')), true);
    assert.equal(await exists(join(root, 'foreign-codex-ran')), false);
  });
});

test('relay probes a safe codex exactly as the adapter does', { skip: process.platform !== 'linux' }, async () => {
  const { relayProviderCapability } = await guard();
  await hostWithPath(async root => {
    const own = join(root, 'own');
    await mkdir(own, { mode: 0o700 });
    await writeFile(join(own, 'codex'), fixture(root, 'own-codex', 'codex-cli 1.0.0'), { mode: 0o700 });
    return own;
  }, async root => {
    const probed = await relayProviderCapability(codexAdapter);
    assert.equal(probed.unsafePath, false);
    assert.equal(await exists(join(root, 'own-codex-ran')), true);
    assert.deepEqual(probed.capability, await codexAdapter.capability());
    assert.equal(probed.capability.skillInstall, 'available');
  });
});

test('relay treats an unsafe provider as one whose executable is absent', { skip: process.platform !== 'linux' }, async () => {
  const { relayProviderCapability } = await guard();
  await hostWithPath(async root => {
    const foreign = join(root, 'foreign'), empty = join(root, 'empty');
    await mkdir(foreign, { mode: 0o700 }); await mkdir(empty, { mode: 0o700 });
    await writeFile(join(foreign, 'codex'), fixture(root, 'foreign-codex', 'codex-cli 9.9.9'), { mode: 0o700 });
    await writeFile(join(foreign, 'claude'), fixture(root, 'foreign-claude', '9.9.9'), { mode: 0o700 });
    await chmod(foreign, 0o777);
    return empty;
  }, async root => {
    const absent = { codex: await codexAdapter.capability(), claude: await claudeAdapter.capability() };
    process.env.PATH = join(root, 'foreign');
    for (const adapter of [codexAdapter, claudeAdapter]) {
      const probed = await relayProviderCapability(adapter);
      assert.equal(probed.unsafePath, true);
      assert.deepEqual(probed.capability, absent[adapter.providerId as 'codex' | 'claude']);
    }
    assert.equal(await exists(join(root, 'foreign-codex-ran')), false);
    assert.equal(await exists(join(root, 'foreign-claude-ran')), false);
  });
});

test('relay keeps setup scope: no protection check off Linux', async () => {
  const { relayProviderUnsafePath } = await guard();
  for (const platform of ['win32', 'darwin'] as const) {
    assert.equal(await relayProviderUnsafePath('codex', { env: { PATH: '/nonexistent-relay-guard' }, platform }), false);
  }
});

async function source() {
  return readFile(new URL('../src/index.ts', import.meta.url), 'utf8');
}

test('actual relay checks each provider before it probes, prepares, activates or runs a task for it', async () => {
  const text = await source();
  const relay = text.slice(text.indexOf('async function relayWorkspaceLoop('), text.indexOf('export async function run('));
  assert.ok(relay.length > 0);
  assert.ok(!/adapter\.capability\(\)/.test(relay), 'the relay must not probe an adapter without the check');
  const pump = relay.slice(relay.indexOf('startSkillPreparationPump({'), relay.indexOf('withSkillPreparationTransaction('));
  assert.match(pump, /const capability = \(await relayProviderCapability\(adapter\)\)\.capability;/);
  const tick = relay.slice(relay.indexOf('performance.now() >= nextSkillActivationAt'), relay.indexOf('nextSkillActivationAt = performance.now() + 60_000;'));
  assert.match(tick, /const probed = await relayProviderCapability\(adapter\);\s*if \(probed\.unsafePath\) \{ record\(\{ outcome: 'failed', errorCode: PROVIDER_UNSAFE_PATH \}\); continue; \}/);
  assert.ok(tick.indexOf('relayProviderCapability(adapter)') < tick.indexOf('prepareSkillUpdate('));
  // The relay's policy refresh publishes these capabilities, so HQ does not offer an unsafe provider tasks or releases.
  const policy = text.slice(text.indexOf('async function providerCapabilitiesForWorkspacePolicy('),
    text.indexOf('async function withWorkspacePolicySyncOrder<T>('));
  assert.match(policy, /\(await relayProviderCapability\(adapter\)\)\.capability/);
  assert.ok(!/adapter\.capability\(\)/.test(policy));
  const task = text.slice(text.indexOf('async function executeOneTask('), text.indexOf('receipt = await executeTask({'));
  const refusal = task.search(/if \(await relayProviderUnsafePath\(task\.target\.provider\)\) \{\s*await fabric\.postTaskEvent\(task\.taskId, 'failed', \{ phase: 'preflight', code: PROVIDER_UNSAFE_PATH \}\);/);
  assert.ok(refusal > 0, 'a task for an unsafe provider is refused before it runs');
  assert.ok(refusal < task.indexOf("postTaskEvent(task.taskId, 'started'"));
});
