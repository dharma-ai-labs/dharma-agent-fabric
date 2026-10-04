import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { validateContract } from '@dharma-ai-labs/agent-fabric-contracts';

const modulePath = './relayRuntimeUpgrade.js';
const contents = (version: string) => ({ shell: `#!/bin/sh\nexec npm exec --yes -- @dharma-ai-labs/agent-fabric@${version} "$@"\n`,
  windows: `@echo off\r\nnpm exec --yes -- @dharma-ai-labs/agent-fabric@${version} %*\r\n` });

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dharma-runtime-upgrade-')));
  const home = join(root, 'profile'), workspace = join(root, 'repo');
  await mkdir(join(workspace, '.dharma', 'bin'), { recursive: true });
  await mkdir(join(home, 'relay'), { recursive: true });
  const old = contents('0.2.116');
  await writeFile(join(workspace, '.dharma', 'bin', 'dharma'), old.shell);
  await writeFile(join(workspace, '.dharma', 'bin', 'dharma.cmd'), old.windows);
  const identity = { organizationId: 'org_synthetic', deviceId: '11111111-1111-4111-8111-111111111111',
    workspaceId: '22222222-2222-4222-8222-222222222222' };
  const calls: string[] = [];
  let version = '0.2.116';
  const deps = {
    launcherContents: contents,
    assertStopped: async () => { calls.push('stopped'); },
    inspectStartup: async () => ({ version, workspace }),
    configureStartup: async (next: string) => { calls.push(`configure:${next}`); version = next; },
    start: async () => { calls.push('start'); },
    stop: async () => { calls.push('stop'); },
    verify: async (next: string, _since: string) => { calls.push(`verify:${next}`); },
  };
  return { input: { home, workspace, version: '0.2.118', ...identity }, deps, calls, old };
}

test('published command boundary identifies missing enrollment rather than an unknown command', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dharma-upgrade-empty-'));
  const result = spawnSync(process.execPath, [join(import.meta.dirname, 'index.js'), 'relay', 'upgrade', '--dry-run'],
    { encoding: 'utf8', env: { ...process.env, DHARMA_HOME: home } });
  assert.match(result.stderr, /relay_upgrade_enrollment_required/);
});

test('upgrade dry run changes no files and starts no process', async () => {
  const { upgradeRelayRuntime } = await import(modulePath);
  const f = await fixture();
  const result = await upgradeRelayRuntime({ ...f.input, dryRun: true }, f.deps);
  assert.equal(result.state, 'planned');
  assert.equal(await readFile(join(f.input.workspace, '.dharma', 'bin', 'dharma'), 'utf8'), f.old.shell);
  assert.deepEqual(f.calls, ['stopped']);
});

test('upgrade installs both launchers and startup then verifies the actual receiver', async () => {
  const { upgradeRelayRuntime } = await import(modulePath);
  const f = await fixture();
  const result = await upgradeRelayRuntime(f.input, f.deps);
  assert.equal(result.state, 'completed');
  assert.equal(result.enrollmentChanged, false);
  assert.match(await readFile(join(f.input.workspace, '.dharma', 'bin', 'dharma.cmd'), 'utf8'), /@0\.2\.118/);
  assert.deepEqual(f.calls, ['stopped', 'stopped', 'configure:0.2.118', 'start', 'verify:0.2.118']);
});

test('successive upgrades retain a completed journal across verified pinned Node directory changes', async () => {
  const { upgradeRelayRuntime } = await import(modulePath);
  const f = await fixture();
  const prior = (version: string) => ({ ...contents(version), shell: `# prior pinned Node\n${contents(version).shell}` });
  await writeFile(join(f.input.workspace, '.dharma', 'bin', 'dharma'), prior('0.2.116').shell);
  await writeFile(join(f.input.workspace, '.dharma', 'bin', 'dharma.cmd'), prior('0.2.116').windows);
  const seen: string[] = [];
  const deps = { ...f.deps, verifyPriorLaunchers: async (version: string, value: ReturnType<typeof contents>) => {
    seen.push(version);
    return value.shell === prior(version).shell && value.windows === prior(version).windows;
  } };
  assert.equal((await upgradeRelayRuntime(f.input, deps)).state, 'completed');
  assert.equal((await upgradeRelayRuntime({ ...f.input, version: '0.2.119' }, deps)).state, 'completed');
  assert.deepEqual(seen, ['0.2.116', '0.2.116']);
  assert.match(await readFile(join(f.input.workspace, '.dharma', 'bin', 'dharma'), 'utf8'), /@0\.2\.119/);
});

test('unverified historical launchers leave the journal and current installation unchanged', async () => {
  const { upgradeRelayRuntime } = await import(modulePath);
  const f = await fixture();
  await upgradeRelayRuntime(f.input, f.deps);
  const path = join(f.input.home, 'relay', 'runtime-upgrade.json');
  const journal = JSON.parse(await readFile(path, 'utf8'));
  journal.previous.shell += '# unexpected command\n';
  const { createHash } = await import('node:crypto');
  journal.previousHash = `sha256:${createHash('sha256').update(JSON.stringify(journal.previous)).digest('hex')}`;
  await writeFile(path, JSON.stringify(journal));
  const before = await readFile(path, 'utf8');
  const current = await readFile(join(f.input.workspace, '.dharma', 'bin', 'dharma'), 'utf8');
  const deps = { ...f.deps, verifyPriorLaunchers: async () => false };
  await assert.rejects(upgradeRelayRuntime({ ...f.input, version: '0.2.119' }, deps), /journal_invalid/);
  assert.equal(await readFile(path, 'utf8'), before);
  assert.equal(await readFile(join(f.input.workspace, '.dharma', 'bin', 'dharma'), 'utf8'), current);
});

test('busy runtime blocks before any launcher or startup mutation', async () => {
  const { upgradeRelayRuntime } = await import(modulePath);
  const f = await fixture();
  f.deps.assertStopped = async () => { throw new Error('relay_upgrade_runtime_busy'); };
  await assert.rejects(upgradeRelayRuntime(f.input, f.deps), /runtime_busy/);
  assert.equal(await readFile(join(f.input.workspace, '.dharma', 'bin', 'dharma'), 'utf8'), f.old.shell);
  assert.deepEqual(f.calls, []);
});

test('foreign launcher contents are never overwritten', async () => {
  const { upgradeRelayRuntime } = await import(modulePath);
  const f = await fixture();
  await writeFile(join(f.input.workspace, '.dharma', 'bin', 'dharma'), '# custom launcher\n');
  await assert.rejects(upgradeRelayRuntime(f.input, f.deps), /launcher_conflict/);
  assert.equal(await readFile(join(f.input.workspace, '.dharma', 'bin', 'dharma'), 'utf8'), '# custom launcher\n');
});

test('failed new receiver restores and verifies the old version without reenrollment', async () => {
  const { upgradeRelayRuntime } = await import(modulePath);
  const f = await fixture();
  f.deps.verify = async (version: string) => { f.calls.push(`verify:${version}`);
    if (version === '0.2.118') throw new Error('not an acknowledged receiver'); };
  const result = await upgradeRelayRuntime(f.input, f.deps);
  assert.equal(result.state, 'rolled_back');
  assert.equal(result.ok, false);
  assert.equal(await readFile(join(f.input.workspace, '.dharma', 'bin', 'dharma'), 'utf8'), f.old.shell);
  assert.deepEqual(f.calls.slice(-5), ['stop', 'stopped', 'configure:0.2.116', 'start', 'verify:0.2.116']);
});

test('rollback failure is explicit and cannot report a healthy old receiver', async () => {
  const { upgradeRelayRuntime } = await import(modulePath);
  const f = await fixture();
  f.deps.verify = async () => { throw new Error('unreachable'); };
  const result = await upgradeRelayRuntime(f.input, f.deps);
  assert.equal(result.state, 'rollback_failed');
  assert.equal(result.ok, false);
});

test('another workspace startup cannot be redirected by upgrade', async () => {
  const { upgradeRelayRuntime } = await import(modulePath);
  const f = await fixture();
  f.deps.inspectStartup = async () => ({ version: '0.2.116', workspace: join(f.input.workspace, 'other') });
  await assert.rejects(upgradeRelayRuntime(f.input, f.deps), /workspace_conflict/);
  assert.deepEqual(f.calls, ['stopped']);
});

test('noncanonical workspace paths remain rejected without launcher or startup mutation', async () => {
  const { upgradeRelayRuntime } = await import(modulePath);
  const f = await fixture();
  const alias = join(f.input.home, 'repo-alias');
  await symlink(f.input.workspace, alias, process.platform === 'win32' ? 'junction' : 'dir');
  f.deps.inspectStartup = async () => ({ version: '0.2.116', workspace: alias });
  await assert.rejects(upgradeRelayRuntime({ ...f.input, workspace: alias }, f.deps), /launcher_conflict/);
  assert.equal(await readFile(join(f.input.workspace, '.dharma', 'bin', 'dharma'), 'utf8'), f.old.shell);
  assert.equal(await readFile(join(f.input.workspace, '.dharma', 'bin', 'dharma.cmd'), 'utf8'), f.old.windows);
  assert.deepEqual(f.calls, ['stopped']);
});

test('a stopped interrupted transaction restores mixed old and new launchers', async () => {
  const { upgradeRelayRuntime } = await import(modulePath);
  const f = await fixture();
  await upgradeRelayRuntime(f.input, f.deps);
  const path = join(f.input.home, 'relay', 'runtime-upgrade.json');
  const journal = JSON.parse(await readFile(path, 'utf8'));
  journal.state = 'installed';
  await writeFile(path, JSON.stringify(journal));
  await writeFile(join(f.input.workspace, '.dharma', 'bin', 'dharma'), f.old.shell);
  await assert.rejects(upgradeRelayRuntime(f.input, f.deps), /recovery_required/);
  const result = await upgradeRelayRuntime({ ...f.input, rollback: true }, f.deps);
  assert.equal(result.state, 'rolled_back');
  assert.equal(await readFile(join(f.input.workspace, '.dharma', 'bin', 'dharma.cmd'), 'utf8'), f.old.windows);
});

test('journal recovery rejects changed device, organization and undeclared credential fields', async () => {
  const { upgradeRelayRuntime } = await import(modulePath);
  for (const override of [{ deviceId: '33333333-3333-4333-8333-333333333333' },
    { organizationId: 'org_foreign' }, { grant: 'NEVER_PERSIST_THIS' }]) {
    const f = await fixture();
    await upgradeRelayRuntime(f.input, f.deps);
    const path = join(f.input.home, 'relay', 'runtime-upgrade.json');
    const journal = JSON.parse(await readFile(path, 'utf8'));
    await writeFile(path, JSON.stringify({ ...journal, ...override, state: 'installed' }));
    const before = await readFile(join(f.input.workspace, '.dharma', 'bin', 'dharma'), 'utf8');
    await assert.rejects(upgradeRelayRuntime({ ...f.input, rollback: true }, f.deps), /journal_invalid/);
    assert.equal(await readFile(join(f.input.workspace, '.dharma', 'bin', 'dharma'), 'utf8'), before);
  }
});

test('an ordinary downgrade requires explicit stored rollback, not an arbitrary old package', async () => {
  const { upgradeRelayRuntime } = await import(modulePath);
  const f = await fixture();
  await assert.rejects(upgradeRelayRuntime({ ...f.input, version: '0.2.115' }, f.deps), /downgrade_requires_rollback/);
  assert.deepEqual(f.calls, ['stopped']);
});

test('upgrade receipts match their runtime schema and cannot include credentials or signed-poll claims', async () => {
  const { upgradeRelayRuntime } = await import(modulePath);
  const f = await fixture();
  const receipt = await upgradeRelayRuntime(f.input, f.deps);
  const schemaRoot = join(import.meta.dirname, 'schemas');
  const id = 'https://schemas.dharma-ai.io/local-relay-upgrade/v1';
  assert.equal((await validateContract(schemaRoot, id, receipt)).ok, true);
  for (const override of [{ token: 'NEVER_PERSIST_THIS' }, { serverSignatureVerified: true },
    { state: 'planned', runtimeObservation: 'local_process_and_poll' }, { state: 'rollback_failed', ok: true }]) {
    assert.equal((await validateContract(schemaRoot, id, { ...receipt, ...override })).ok, false);
  }
  assert.doesNotMatch(await readFile(join(f.input.home, 'relay', 'runtime-upgrade.json'), 'utf8'), /grant|credential|token|password/i);
});

test('receiver health requires live process identities, matching versions and a fresh poll', async () => {
  const { relayRuntimeObservationReady } = await import(modulePath);
  const now = Date.now(), at = new Date(now - 1000).toISOString();
  const valid = { version: '0.2.118', workspaceId: 'workspace', since: new Date(now - 2000).toISOString(), now,
    supervisorPid: 123, relayPid: 456, supervisor: { pid: 123, version: '0.2.118', workspaceId: 'workspace' },
    lastPoll: { pid: 456, version: '0.2.118', workspaceId: 'workspace', at } };
  assert.equal(relayRuntimeObservationReady(valid), true);
  for (const override of [{ supervisorPid: 999 }, { relayPid: 999 }, { workspaceId: 'foreign' },
    { since: new Date(now).toISOString() }, { version: '0.2.119' }, { now: now + 400000 },
    { lastPoll: { ...valid.lastPoll, pid: undefined } }]) {
    assert.equal(relayRuntimeObservationReady({ ...valid, ...override }), false);
  }
  assert.equal(relayRuntimeObservationReady({ ...valid, lastPoll: { ...valid.lastPoll, pid: undefined },
    allowLegacyPoll: true }), true);
});
