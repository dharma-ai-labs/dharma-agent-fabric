import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { validateContract } from '@dharma-ai-labs/agent-fabric-contracts';
import {enableRelayAutostart, inspectOwnedRelayAutostart} from './relayAutostart.js';

const modulePath = './relayRuntimeUpgrade.js';
const contents = (version: string) => ({ shell: `#!/bin/sh\nexec npm exec --yes -- @dharma-ai-labs/agent-fabric@${version} "$@"\n`,
  windows: `@echo off\r\nnpm exec --yes -- @dharma-ai-labs/agent-fabric@${version} %*\r\n` });

async function fixture(initialVersion = '0.2.116', targetVersion = '0.2.118') {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dharma-runtime-upgrade-')));
  const home = join(root, 'profile'), workspace = join(root, 'repo');
  await mkdir(join(workspace, '.dharma', 'bin'), { recursive: true });
  await mkdir(join(home, 'relay'), { recursive: true });
  const old = contents(initialVersion);
  await writeFile(join(workspace, '.dharma', 'bin', 'dharma'), old.shell);
  await writeFile(join(workspace, '.dharma', 'bin', 'dharma.cmd'), old.windows);
  const identity = { organizationId: 'org_synthetic', deviceId: '11111111-1111-4111-8111-111111111111',
    workspaceId: '22222222-2222-4222-8222-222222222222' };
  const calls: string[] = [];
  let version = initialVersion;
  const deps = {
    launcherContents: contents,
    assertStopped: async () => { calls.push('stopped'); },
    inspectStartup: async () => ({ version, workspace }),
    configureStartup: async (next: string) => { calls.push(`configure:${next}`); version = next; },
    start: async () => { calls.push('start'); },
    stop: async () => { calls.push('stop'); },
    verify: async (next: string, _since: string) => { calls.push(`verify:${next}`); },
  };
  return { input: { home, workspace, version: targetVersion, ...identity }, deps, calls, old };
}

test('runtime rollback restores the pre-upgrade Codex profile disposition, including an absent legacy context', async () => {
  const {upgradeRelayRuntime} = await import(modulePath);
  for (const original of [null, '/fixtures/existing-codex']) {
    const f = await fixture('0.2.175', '0.2.176');
    let codexHome: string | undefined = original ?? undefined, version = '0.2.175';
    const deps = {...f.deps,
      inspectStartup: async () => ({version, workspace: f.input.workspace, codexHome}),
      configureStartup: async (next: string, restore?: {codexHome: string | null}) => {
        version = next; codexHome = restore ? restore.codexHome ?? undefined : original ?? '/fixtures/selected-codex';
      },
    };
    assert.equal((await upgradeRelayRuntime(f.input, deps)).state, 'completed');
    assert.equal(codexHome, original ?? '/fixtures/selected-codex');
    const journal = JSON.parse(await readFile(join(f.input.home, 'relay', 'runtime-upgrade.json'), 'utf8'));
    assert.equal((await validateContract(join(import.meta.dirname, 'schemas'),
      'https://schemas.dharma-ai.io/local-relay-upgrade-journal/v2', journal)).ok, true);
    const rollback = await upgradeRelayRuntime({...f.input, rollback: true}, deps);
    assert.equal(rollback.state, 'rolled_back');
    assert.equal(codexHome, original ?? undefined);
    assert.equal(version, '0.2.175');
  }
});

test('runtime rollback restores the exact legacy Linux unit and receipt after adding a Codex context', {
  skip: process.platform !== 'linux',
}, async () => {
  const {upgradeRelayRuntime} = await import(modulePath);
  const f = await fixture('0.2.175', '0.2.176');
  const options = {home: f.input.home, userHome: f.input.home, workspace: f.input.workspace,
    launcher: join(f.input.workspace, '.dharma', 'bin', 'dharma'), policy: join(f.input.workspace, '.dharma', 'approved-policy.json'),
    version: '0.2.175', platform: 'linux' as const, run: async () => ({stdout: 'enabled\n'})};
  await enableRelayAutostart(options);
  const receiptPath = join(f.input.home, 'relay', 'autostart.json');
  const unitPath = join(f.input.home, '.config', 'systemd', 'user', 'dharma-agent-fabric.service');
  const receipt = await readFile(receiptPath, 'utf8'), unit = await readFile(unitPath, 'utf8');
  const deps = {...f.deps, inspectStartup: () => inspectOwnedRelayAutostart(options),
    configureStartup: (version: string, restore?: {codexHome: string | null}) => enableRelayAutostart({...options, version,
      ...(restore ? {restoreCodexHome: restore.codexHome} : {codexHome: '/fixtures/selected-codex'})}),
  };
  assert.equal((await upgradeRelayRuntime(f.input, deps)).state, 'completed');
  assert.match(await readFile(unitPath, 'utf8'), /CODEX_HOME/);
  assert.equal((await upgradeRelayRuntime({...f.input, rollback: true}, deps)).state, 'rolled_back');
  assert.equal(await readFile(receiptPath, 'utf8'), receipt);
  assert.equal(await readFile(unitPath, 'utf8'), unit);
});

test('legacy upgrade journals remain recoverable without inventing a provider context', async () => {
  const {upgradeRelayRuntime} = await import(modulePath);
  const f = await fixture();
  await upgradeRelayRuntime(f.input, f.deps);
  const path = join(f.input.home, 'relay', 'runtime-upgrade.json');
  const journal = JSON.parse(await readFile(path, 'utf8'));
  delete journal.previousCodexHome;
  journal.schema = 'dharma.local-relay-upgrade/v1';
  await writeFile(path, JSON.stringify(journal));
  assert.equal((await upgradeRelayRuntime({...f.input, rollback: true}, f.deps)).state, 'rolled_back');
});

test('legacy-journal rollback explicitly clears the current shell profile rather than inheriting it', async () => {
  const {upgradeRelayRuntime} = await import(modulePath);
  const f = await fixture('0.2.175', '0.2.176');
  let version = '0.2.175', codexHome: string | undefined;
  const restored: Array<string | null | undefined> = [];
  const deps = {...f.deps, inspectStartup: async () => ({version, workspace: f.input.workspace, codexHome}),
    configureStartup: async (next: string, restore?: {codexHome: string | null}) => {
      restored.push(restore?.codexHome);version = next;
      codexHome = restore ? restore.codexHome ?? undefined : '/fixtures/shell-selected-codex';
    },
  };
  await upgradeRelayRuntime(f.input, {...deps, configureStartup: async (next: string) => {version = next;}});
  const path = join(f.input.home, 'relay', 'runtime-upgrade.json');
  const journal = JSON.parse(await readFile(path, 'utf8'));
  delete journal.previousCodexHome;journal.schema = 'dharma.local-relay-upgrade/v1';
  await writeFile(path, JSON.stringify(journal));
  assert.equal((await upgradeRelayRuntime({...f.input, rollback: true}, deps)).state, 'rolled_back');
  assert.deepEqual(restored, [null]);assert.equal(codexHome, undefined);
});

test('upgrade recovery rejects malformed profile context and undeclared fields before owned controls', async () => {
  const {upgradeRelayRuntime} = await import(modulePath);
  for (const change of [{previousCodexHome: '/fixtures/../other'}, {previousCodexHome: '/private\nTOKEN=bad'},
    {previousCodexHome: '/'}, {environment: {OPENAI_API_KEY: 'CANARY_NOT_ALLOWED'}}]) {
    const f = await fixture();
    await upgradeRelayRuntime(f.input, f.deps);
    const path = join(f.input.home, 'relay', 'runtime-upgrade.json');
    const journal = JSON.parse(await readFile(path, 'utf8'));
    await writeFile(path, JSON.stringify({...journal, ...change}));
    const before = await readFile(path, 'utf8');
    const effects: string[] = [];
    await assert.rejects(upgradeRelayRuntime({...f.input, rollback: true}, {...f.deps,
      stop: async () => {effects.push('stop');}, configureStartup: async () => {effects.push('configure');}}), /journal_invalid/);
    assert.deepEqual(effects, []);assert.equal(await readFile(path, 'utf8'), before);
  }
});

test('a newer recovery manager rolls back an explicitly admitted interrupted journal without relabelling its version', async () => {
  const { upgradeRelayRuntime } = await import(modulePath);
  const f = await fixture('0.2.149', '0.2.151');
  await upgradeRelayRuntime(f.input, f.deps);
  const path = join(f.input.home, 'relay', 'runtime-upgrade.json');
  const journal = JSON.parse(await readFile(path, 'utf8'));
  await writeFile(path, JSON.stringify({ ...journal, state: 'installed' }));
  const deps = { ...f.deps, recoverableJournal: (version: string, previous: string) =>
    version === '0.2.151' && previous === '0.2.149' };
  const result = await upgradeRelayRuntime({ ...f.input, version: '0.2.152', rollback: true }, deps);
  assert.equal(result.state, 'rolled_back');
  assert.equal(result.version, '0.2.151');
  assert.equal(result.previousVersion, '0.2.149');
  assert.equal(result.enrollmentChanged, false);
  assert.equal(await readFile(join(f.input.workspace, '.dharma', 'bin', 'dharma'), 'utf8'), f.old.shell);
  const validation = await validateContract(join(import.meta.dirname, 'schemas'),
    'https://schemas.dharma-ai.io/local-relay-upgrade/v1', result);
  assert.equal(validation.ok, true);
});

test('cross-version recovery admission cannot authorize an upgrade, unknown pair, foreign scope or altered prior launcher', async () => {
  const { upgradeRelayRuntime } = await import(modulePath);
  for (const mode of ['upgrade', 'unknown', 'foreign', 'tampered', 'unapproved']) {
    const f = await fixture('0.2.149', '0.2.151');
    await upgradeRelayRuntime(f.input, f.deps);
    const path = join(f.input.home, 'relay', 'runtime-upgrade.json');
    const journal = JSON.parse(await readFile(path, 'utf8'));
    journal.state = 'installed';
    if (mode === 'unknown') journal.version = '0.2.150';
    if (mode === 'foreign') journal.organizationId = 'org_foreign';
    if (mode === 'tampered') journal.previous.shell += '# unexpected command\n';
    await writeFile(path, JSON.stringify(journal));
    const before = await readFile(path, 'utf8');
    const launcher = await readFile(join(f.input.workspace, '.dharma', 'bin', 'dharma'), 'utf8');
    const deps = { ...f.deps, recoverableJournal: (version: string, previous: string) =>
      mode !== 'unapproved' && version === '0.2.151' && previous === '0.2.149' };
    await assert.rejects(upgradeRelayRuntime({ ...f.input, version: '0.2.152', rollback: mode !== 'upgrade' }, deps),
      /journal_invalid/);
    assert.equal(await readFile(path, 'utf8'), before);
    assert.equal(await readFile(join(f.input.workspace, '.dharma', 'bin', 'dharma'), 'utf8'), launcher);
  }
});

test('validated rollback pauses an auto-restarting owned runtime before requiring it stopped', async () => {
  const { upgradeRelayRuntime } = await import(modulePath);
  const f = await fixture('0.2.149', '0.2.151');
  await upgradeRelayRuntime(f.input, f.deps);
  const path = join(f.input.home, 'relay', 'runtime-upgrade.json');
  const journal = JSON.parse(await readFile(path, 'utf8'));
  await writeFile(path, JSON.stringify({ ...journal, state: 'installed' }));
  let live = true;
  const calls: string[] = [];
  const deps = { ...f.deps,
    inspectStartup: async () => { calls.push('verified-startup'); return f.deps.inspectStartup(); },
    assertStopped: async () => { calls.push('assert-stopped'); if (live) throw new Error('relay_upgrade_runtime_busy'); },
    stop: async () => { calls.push('owned-pause-and-stop'); live = false; },
  };
  const result = await upgradeRelayRuntime({ ...f.input, rollback: true }, deps);
  assert.equal(result.state, 'rolled_back');
  assert.deepEqual(calls.slice(0, 3), ['verified-startup', 'owned-pause-and-stop', 'assert-stopped']);
});

test('rollback planning is read-only on a live runtime and invalid recovery never pauses it', async () => {
  const { upgradeRelayRuntime } = await import(modulePath);
  for (const invalid of [false, true]) {
    const f = await fixture('0.2.149', '0.2.151');
    await upgradeRelayRuntime(f.input, f.deps);
    const path = join(f.input.home, 'relay', 'runtime-upgrade.json');
    const journal = JSON.parse(await readFile(path, 'utf8'));
    await writeFile(path, JSON.stringify({ ...journal, state: 'installed',
      ...(invalid ? { organizationId: 'org_foreign' } : {}) }));
    const before = await readFile(path, 'utf8');
    let pauses = 0;
    const deps = { ...f.deps, assertStopped: async () => { throw new Error('relay_upgrade_runtime_busy'); },
      stop: async () => { pauses++; } };
    const input = { ...f.input, rollback: true, dryRun: true };
    if (invalid) await assert.rejects(upgradeRelayRuntime(input, deps), /journal_invalid/);
    else assert.equal((await upgradeRelayRuntime(input, deps)).state, 'planned');
    assert.equal(pauses, 0);
    assert.equal(await readFile(path, 'utf8'), before);
  }
});

test('live rollback rejects unavailable, foreign and tampered recovery before pausing or changing files', async () => {
  const { upgradeRelayRuntime } = await import(modulePath);
  for (const mode of ['missing', 'foreign-journal', 'foreign-startup', 'tampered-previous', 'tampered-current']) {
    const f = await fixture('0.2.149', '0.2.151');
    const path = join(f.input.home, 'relay', 'runtime-upgrade.json');
    if (mode !== 'missing') {
      await upgradeRelayRuntime(f.input, f.deps);
      const journal = JSON.parse(await readFile(path, 'utf8'));
      journal.state = 'installed';
      if (mode === 'foreign-journal') journal.deviceId = '33333333-3333-4333-8333-333333333333';
      if (mode === 'tampered-previous') journal.previous.shell += '# unapproved\n';
      await writeFile(path, JSON.stringify(journal));
    }
    if (mode === 'tampered-current') {
      await writeFile(join(f.input.workspace, '.dharma', 'bin', 'dharma'), '# unapproved\n');
    }
    const before = mode === 'missing' ? undefined : await readFile(path, 'utf8');
    const shell = await readFile(join(f.input.workspace, '.dharma', 'bin', 'dharma'), 'utf8');
    const windows = await readFile(join(f.input.workspace, '.dharma', 'bin', 'dharma.cmd'), 'utf8');
    const effects: string[] = [];
    const deps = { ...f.deps,
      assertStopped: async () => { throw new Error('relay_upgrade_runtime_busy'); },
      inspectStartup: async () => mode === 'foreign-startup'
        ? { version: '0.2.151', workspace: join(f.input.workspace, 'foreign') } : f.deps.inspectStartup(),
      stop: async () => { effects.push('stop'); },
      configureStartup: async () => { effects.push('configure'); },
      start: async () => { effects.push('start'); },
    };
    const code = mode === 'missing' ? /rollback_unavailable/ : mode === 'foreign-startup'
      ? /workspace_conflict/ : mode === 'tampered-current' ? /launcher_conflict/ : /journal_invalid/;
    await assert.rejects(upgradeRelayRuntime({ ...f.input, rollback: true }, deps), code);
    assert.deepEqual(effects, []);
    if (before === undefined) await assert.rejects(readFile(path), { code: 'ENOENT' });
    else assert.equal(await readFile(path, 'utf8'), before);
    assert.equal(await readFile(join(f.input.workspace, '.dharma', 'bin', 'dharma'), 'utf8'), shell);
    assert.equal(await readFile(join(f.input.workspace, '.dharma', 'bin', 'dharma.cmd'), 'utf8'), windows);
  }
});

test('rollback does not change launchers if the owned pause cannot prove a stopped runtime', async () => {
  const { upgradeRelayRuntime } = await import(modulePath);
  const f = await fixture('0.2.149', '0.2.151');
  await upgradeRelayRuntime(f.input, f.deps);
  const shell = await readFile(join(f.input.workspace, '.dharma', 'bin', 'dharma'), 'utf8');
  const calls: string[] = [];
  const deps = { ...f.deps, stop: async () => { calls.push('stop'); },
    assertStopped: async () => { calls.push('assert-stopped'); throw new Error('relay_upgrade_runtime_busy'); },
    configureStartup: async () => { calls.push('configure'); }, start: async () => { calls.push('start'); } };
  const result = await upgradeRelayRuntime({ ...f.input, rollback: true }, deps);
  assert.equal(result.state, 'rollback_failed');
  assert.equal(result.runtimeObservation, 'unconfirmed');
  assert.equal(result.ok, false);
  assert.deepEqual(calls, ['stop', 'assert-stopped']);
  assert.equal(await readFile(join(f.input.workspace, '.dharma', 'bin', 'dharma'), 'utf8'), shell);
});

test('a recovery control refusing a busy named session cannot pause, reconfigure or overwrite launchers', async () => {
  const { upgradeRelayRuntime } = await import(modulePath);
  const f = await fixture('0.2.149', '0.2.151');
  await upgradeRelayRuntime(f.input, f.deps);
  const shell = await readFile(join(f.input.workspace, '.dharma', 'bin', 'dharma'), 'utf8');
  const effects: string[] = [];
  const deps = { ...f.deps, stop: async () => { throw new Error('relay_upgrade_session_busy'); },
    configureStartup: async () => { effects.push('configure'); }, start: async () => { effects.push('start'); } };
  const result = await upgradeRelayRuntime({ ...f.input, rollback: true }, deps);
  assert.equal(result.state, 'rollback_failed');
  assert.equal(result.ok, false);
  assert.deepEqual(effects, []);
  assert.equal(await readFile(join(f.input.workspace, '.dharma', 'bin', 'dharma'), 'utf8'), shell);
});

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
