import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { access, chmod, copyFile, cp, mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { createServer, type AddressInfo } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { signCanonicalObject } from '@dharma-ai-labs/agent-fabric-contracts';
import type { OrganizationPolicy } from '@dharma-ai-labs/agent-fabric-policy';
import {
  detectRegisteredCommandSandbox,
  executeTask,
  FileTaskReceiptStore,
  RegisteredCommandsRefusedError,
  type RegisteredCommandSandbox,
  type TaskEnvelope,
} from './index.js';

// Real-sandbox tests. They run only when DHARMA_SANDBOX_EXPECT is set:
//   usable  - this Linux host must give a usable sandbox, and every case below must hold;
//   refused - this host must refuse (CI turns user namespaces off for this run).
// Unset, the file skips: that happens on Windows, macOS and local runs. Set on a host that is
// not Linux, or set to `usable` on a host whose probe fails, the file fails instead of skipping.
// Every canary is synthetic. Nothing real is read or listed.

const expectation = process.env.DHARMA_SANDBOX_EXPECT ?? '';
// Registered command arguments cannot contain line breaks, so multi-line scripts are joined.
const oneLine = (script: string) => script.replace(/\s*\n\s*/g, ' ').trim();

async function exists(path: string) {
  return access(path).then(() => true, () => false);
}

async function repository(t: TestContext) {
  const root = await mkdtemp(resolve(tmpdir(), 'dharma-sandbox-it-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = resolve(root, 'workspace');
  await mkdir(resolve(workspace, 'reports'), { recursive: true });
  await writeFile(resolve(workspace, 'reports', '.keep'), '');
  await writeFile(resolve(workspace, 'package.json'), JSON.stringify({ name: 'sandbox-fixture', private: true,
    scripts: { probe: 'node -e "require(\'node:fs\').writeFileSync(\'reports/npm.txt\', \'npm ran\')"' } }));
  for (const argv of [['init', '-q'], ['config', 'user.email', 'test@dharma.ai'], ['config', 'user.name', 'Sandbox Fixture'],
    ['add', '.'], ['commit', '-qm', 'initial']]) {
    assert.equal(spawnSync('git', argv, { cwd: workspace, windowsHide: true }).status, 0, argv.join(' '));
  }
  const relayStateDirectory = resolve(root, 'state');
  await mkdir(relayStateDirectory, { recursive: true });
  return { root, workspace, relayStateDirectory };
}

function policyWith(commands: Record<string, { argv: string[]; timeoutSeconds: number }>): OrganizationPolicy {
  return {
    schema: 'dharma.organization-policy/v1', organizationId: 'org_test', revision: '1',
    evidence: { defaultMode: 'deep', registeredWorkspaceOnly: true, excludePaths: [], maximumCapsuleBytes: 1,
      maximumDailyUploadBytes: 1, maximumExpansionBytes: 1 },
    tasks: { defaultNetwork: 'deny', defaultGit: 'task_branch', writePaths: ['reports/**'], requireLocalConfirmationFor: [],
      allowedCommands: commands },
    skills: { automaticInstall: true, automaticPromotionMaxRisk: 'R2', canaryPercent: 10 }, retention: {}, budgets: {},
  };
}

function signedTask(commandIds: string[], timeoutSeconds = 30) {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const unsigned = {
    schema: 'dharma.task/v1' as const, taskId: randomUUID(), organizationId: 'org_test', workspaceId: 'workspace',
    taskType: 'external_request' as const, target: { deviceId: 'device', provider: 'codex' as const },
    skillBundle: null, instructions: 'Verify the repository.', requiredSkills: [],
    authority: { readPaths: ['.'], writePaths: ['reports/**'], commands: commandIds.map(commandId => ({ commandId })),
      network: 'deny', git: 'task_branch' as const },
    execution: { isolation: 'git_worktree' as const, timeoutSeconds, leaseSeconds: 60, maximumConcurrentAgents: 1 },
    acceptance: { commands: commandIds.map(commandId => ({ commandId })), requiredArtifacts: [] },
    budget: { mode: 'byok_local' as const, maximumDharmaCostCents: 0 },
    createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 120_000).toISOString(), nonce: randomUUID(),
  };
  return { task: { ...unsigned, signature: signCanonicalObject(unsigned, privateKey) } as TaskEnvelope, publicKey };
}

const providerResult = {
  provider: 'codex' as const, exitCode: 0, signal: null, timedOut: false, stdout: 'synthetic completion', stderr: '',
  stdoutSha256: `sha256:${'1'.repeat(64)}`, stderrSha256: `sha256:${'0'.repeat(64)}`,
};

// Runs inside the sandbox. Prints one JSON object of named checks. Arguments are paths and a
// synthetic sentinel only.
const CANARY_SCRIPT = `
const fs = require('node:fs'), net = require('node:net'), path = require('node:path'), cp = require('node:child_process');
const a = JSON.parse(process.argv[1]);
const readable = p => { try { fs.readFileSync(p); return true; } catch { return false; } };
const writable = p => { try { fs.writeFileSync(p, 'x'); return true; } catch { return false; } };
const environHas = value => {
  for (const pid of fs.readdirSync('/proc').filter(name => /^\\d+$/.test(name))) {
    try { if (fs.readFileSync('/proc/' + pid + '/environ').includes(value)) return true; } catch {}
  }
  return false;
};
const fds = fs.readdirSync('/proc/self/fd').map(Number).filter(fd => fd > 2).map(fd => {
  try { return fs.readlinkSync('/proc/self/fd/' + fd); } catch { return ''; }
}).filter(target => target.startsWith('socket:') || target.startsWith('/'));
const checks = {
  home_canary_unreadable: !readable(a.homeCanary),
  dharma_home_canary_unreadable: !readable(a.dharmaCanary),
  parent_sentinel_absent: !Object.values(process.env).includes(a.sentinel) && !environHas(a.sentinel),
  test_process_invisible: !fs.existsSync('/proc/' + a.testPid),
  root_write_denied: !writable('/sandbox-it-' + a.nonce),
  usr_write_denied: !writable('/usr/sandbox-it-' + a.nonce),
  workspace_write_denied: !writable(path.join(a.workspace, 'sandbox-it-' + a.nonce)),
  git_pointer_write_denied: !writable(path.join(a.worktree, '.git')),
  tmp_writable: writable('/tmp/sandbox-it-' + a.nonce),
  worktree_writable: writable(path.join(a.worktree, 'reports', 'inside.txt')),
  loopback_only: fs.readFileSync('/proc/net/dev', 'utf8').split('\\n').slice(2).map(line => line.split(':')[0].trim()).filter(Boolean).join(',') === 'lo',
  descriptors_closed: fds.length === 0,
  capabilities_dropped: /CapEff:\\s*0+\\n/.test(fs.readFileSync('/proc/self/status', 'utf8')),
  nested_userns_denied: !a.disableUserns || cp.spawnSync('/usr/bin/unshare', ['--user', 'true'], { windowsHide: true }).status !== 0,
  home_is_sandbox_home: process.env.HOME === '/dharma-sandbox/home' && fs.readdirSync(process.env.HOME).length === 0,
};
const socket = net.connect(a.port, '127.0.0.1');
const finish = reached => { checks.host_listener_unreachable = !reached; process.stdout.write(JSON.stringify(checks)); process.exit(0); };
socket.once('connect', () => finish(true));
socket.once('error', () => finish(false));
setTimeout(() => finish(false), 2000);
`;

if (!expectation) {
  test('real-sandbox tests', (t) => { t.skip('set DHARMA_SANDBOX_EXPECT to run real-sandbox tests'); });
} else if (expectation !== 'usable' && expectation !== 'refused') {
  test('DHARMA_SANDBOX_EXPECT is usable or refused', () => assert.fail(`unknown DHARMA_SANDBOX_EXPECT=${expectation}`));
} else if (process.platform !== 'linux') {
  test('real-sandbox tests need Linux', () => assert.fail(`DHARMA_SANDBOX_EXPECT=${expectation} is set on ${process.platform}`));
} else if (expectation === 'usable') {
  const probe = async (t: TestContext): Promise<Extract<RegisteredCommandSandbox, { usable: true }>> => {
    const { relayStateDirectory } = await repository(t);
    const sandbox = await detectRegisteredCommandSandbox({ relayStateDirectory });
    if (!sandbox.usable) assert.fail(`sandbox unusable: ${sandbox.reason}: ${sandbox.detail}`);
    return sandbox;
  };

  test('the live probe is usable on this host and passed every policy check', async (t) => {
    const sandbox = await probe(t);
    assert.equal(sandbox.policy, 'bwrap-policy/2');
    assert.match(sandbox.bwrapPath, /^\/(usr\/)?bin\/bwrap$/);
    assert.match(sandbox.bwrapSha256, /^sha256:[0-9a-f]{64}$/);
    process.stdout.write(`# sandbox ${JSON.stringify({ ...sandbox, layout: undefined })}\n`);
  });

  test('a registered command inside the sandbox cannot reach host secrets, writes, network or processes', async (t) => {
    const sandbox = await probe(t);
    const fixture = await repository(t);
    const nonce = randomUUID();
    const homeCanary = resolve(homedir(), `.dharma-sandbox-it-${nonce}`);
    await writeFile(homeCanary, 'synthetic home canary');
    t.after(() => rm(homeCanary, { force: true }));
    const dharmaCanary = resolve(fixture.relayStateDirectory, `canary-${nonce}`);
    await writeFile(dharmaCanary, 'synthetic dharma home canary');
    const server = createServer(socket => socket.end('reached'));
    await new Promise<void>(accept => server.listen(0, '127.0.0.1', accept));
    t.after(() => new Promise<void>(accept => server.close(() => accept())));
    const sentinel = `sandbox-it-sentinel-${nonce}`;
    process.env.SANDBOX_IT_SENTINEL = sentinel;
    t.after(() => { delete process.env.SANDBOX_IT_SENTINEL; });
    const { task, publicKey } = signedTask(['canary']);
    const worktree = resolve(fixture.relayStateDirectory, 'worktrees', task.taskId);
    const args = { homeCanary, dharmaCanary, sentinel, testPid: process.pid, nonce, workspace: fixture.workspace, worktree,
      port: (server.address() as AddressInfo).port, disableUserns: sandbox.disableUserns };
    const policy = policyWith({ canary: { argv: [process.execPath, '-e', oneLine(CANARY_SCRIPT), JSON.stringify(args)], timeoutSeconds: 30 } });
    const receipt = await executeTask({ task, policy, workspace: fixture.workspace, relayStateDirectory: fixture.relayStateDirectory,
      serverPublicKey: publicKey, receiptStore: new FileTaskReceiptStore(resolve(fixture.root, 'receipts')),
      registeredCommandSandbox: sandbox, providerExecutor: async () => providerResult });
    const result = receipt.commandResults.find(({ commandId }) => commandId === 'canary');
    assert.ok(result, JSON.stringify(receipt.commandResults.map(({ commandId, stderr }) => ({ commandId, stderr }))));
    assert.equal(result.exitCode, 0, result.stderr);
    const checks = JSON.parse(result.stdout) as Record<string, boolean>;
    assert.deepEqual(Object.entries(checks).filter(([, ok]) => !ok).map(([name]) => name), []);
    assert.equal(Object.keys(checks).length, 16);
    assert.equal(receipt.status, 'completed', receipt.commandResults.at(-1)?.stderr);
    assert.equal(result.stdout.includes('synthetic home canary'), false);
    assert.equal(await exists(`/tmp/sandbox-it-${nonce}`), false, 'the sandbox /tmp is not the host /tmp');
    assert.equal(await exists(resolve(fixture.workspace, `sandbox-it-${nonce}`)), false);
    assert.equal(await readFile(resolve(worktree, 'reports', 'inside.txt'), 'utf8'), 'x', 'the worktree write reached the host');
  });

  // The operator's approved policy and workspace launchers sit next to the repository, outside the
  // task worktree. The sandbox does not show them, so a command can neither read nor change them.
  const POLICY_WRITE_SCRIPT = oneLine(`
    const fs = require('node:fs'), path = require('node:path');
    const a = JSON.parse(process.argv[1]);
    const attempt = action => { try { action(); return true; } catch { return false; } };
    process.stdout.write(JSON.stringify({
      policy_visible: fs.existsSync(a.policy),
      launchers_visible: fs.existsSync(a.bin),
      policy_written: attempt(() => fs.writeFileSync(a.policy, 'rewritten')),
      policy_appended: attempt(() => fs.appendFileSync(a.policy, 'rewritten')),
      policy_removed: attempt(() => fs.rmSync(a.policy)),
      policy_replaced: attempt(() => fs.renameSync(a.policy + '.new', a.policy)),
      launcher_written: attempt(() => fs.writeFileSync(a.shell, 'rewritten')),
      launcher_mode_changed: attempt(() => fs.chmodSync(a.shell, 0o777)),
      windows_launcher_written: attempt(() => fs.writeFileSync(a.windows, 'rewritten')),
      launcher_added: attempt(() => fs.writeFileSync(path.join(a.bin, 'added'), 'x')),
      launchers_moved: attempt(() => fs.renameSync(a.bin, a.bin + '-moved')),
    }));`);

  test('a registered command cannot write the approved policy or the workspace launchers', async (t) => {
    const sandbox = await probe(t);
    const fixture = await repository(t);
    const dharma = resolve(fixture.workspace, '.dharma');
    const bin = resolve(dharma, 'bin');
    await mkdir(bin, { recursive: true });
    const files = {
      policy: resolve(dharma, 'approved-policy.json'),
      shell: resolve(bin, 'dharma'),
      windows: resolve(bin, 'dharma.cmd'),
    };
    await writeFile(files.policy, '{"synthetic":"approved policy"}\n', { mode: 0o600 });
    await writeFile(files.shell, '#!/bin/sh\necho synthetic launcher\n', { mode: 0o700 });
    await writeFile(files.windows, '@echo synthetic launcher\r\n', { mode: 0o600 });
    const before = await Promise.all(Object.values(files).map(async path => [await readFile(path), (await stat(path)).mode]));
    const { task, publicKey } = signedTask(['policy.write']);
    const policy = policyWith({ 'policy.write': { argv: [process.execPath, '-e', POLICY_WRITE_SCRIPT,
      JSON.stringify({ ...files, bin })], timeoutSeconds: 30 } });
    const receipt = await executeTask({ task, policy, workspace: fixture.workspace, relayStateDirectory: fixture.relayStateDirectory,
      serverPublicKey: publicKey, receiptStore: new FileTaskReceiptStore(resolve(fixture.root, 'receipts')),
      registeredCommandSandbox: sandbox, providerExecutor: async () => providerResult });
    const result = receipt.commandResults.find(({ commandId }) => commandId === 'policy.write');
    assert.ok(result, JSON.stringify(receipt.commandResults.map(({ commandId, stderr }) => ({ commandId, stderr }))));
    assert.equal(result.exitCode, 0, result.stderr);
    const attempts = JSON.parse(result.stdout) as Record<string, boolean>;
    assert.equal(Object.keys(attempts).length, 11);
    assert.deepEqual(Object.entries(attempts).filter(([, happened]) => happened).map(([name]) => name), []);
    assert.equal(receipt.status, 'completed', receipt.commandResults.at(-1)?.stderr);
    assert.deepEqual(await Promise.all(Object.values(files).map(async path => [await readFile(path), (await stat(path)).mode])), before,
      'the approved policy and the launchers are unchanged on the host');
    assert.deepEqual((await readdir(bin)).sort(), ['dharma', 'dharma.cmd']);
    assert.deepEqual((await readdir(dharma)).sort(), ['approved-policy.json', 'bin']);
    assert.equal(await exists(`${bin}-moved`), false);
  });

  test('npm run works inside the sandbox with the relay Node', async (t) => {
    const sandbox = await probe(t);
    const fixture = await repository(t);
    const { task, publicKey } = signedTask(['npm.probe']);
    const policy = policyWith({ 'npm.probe': { argv: ['npm', 'run', 'probe'], timeoutSeconds: 60 } });
    const receipt = await executeTask({ task, policy, workspace: fixture.workspace, relayStateDirectory: fixture.relayStateDirectory,
      serverPublicKey: publicKey, receiptStore: new FileTaskReceiptStore(resolve(fixture.root, 'receipts')),
      registeredCommandSandbox: sandbox, providerExecutor: async () => providerResult });
    assert.equal(receipt.status, 'completed', JSON.stringify(receipt.commandResults.map(({ commandId, stderr }) => ({ commandId, stderr }))));
    assert.equal(await readFile(resolve(fixture.relayStateDirectory, 'worktrees', task.taskId, 'reports', 'npm.txt'), 'utf8'), 'npm ran');
  });

  test('a relay Node installed in a general folder under the home shows only node and npm', async (t) => {
    // A copy of the relay Node laid out like a tarball unpacked into a per-user folder that also
    // holds share/ and state/ folders with a synthetic credential canary.
    const nonce = randomUUID();
    const prefix = resolve(homedir(), `.dharma-sandbox-it-prefix-${nonce}`);
    t.after(() => rm(prefix, { recursive: true, force: true }));
    const hostPrefix = dirname(dirname(await realpath(process.execPath)));
    await mkdir(resolve(prefix, 'bin'), { recursive: true });
    await copyFile(process.execPath, resolve(prefix, 'bin', 'node'));
    await chmod(resolve(prefix, 'bin', 'node'), 0o755);
    await cp(resolve(hostPrefix, 'lib', 'node_modules', 'npm'), resolve(prefix, 'lib', 'node_modules', 'npm'), { recursive: true });
    await symlink('../lib/node_modules/npm/bin/npm-cli.js', resolve(prefix, 'bin', 'npm'));
    await mkdir(resolve(prefix, 'share', 'tool'), { recursive: true });
    await mkdir(resolve(prefix, 'state'), { recursive: true });
    const shareCanary = resolve(prefix, 'share', 'tool', 'auth.json');
    const stateCanary = resolve(prefix, 'state', 'history');
    await writeFile(shareCanary, 'synthetic credential canary');
    await writeFile(stateCanary, 'synthetic history canary');
    const fixture = await repository(t);
    const sandbox = await detectRegisteredCommandSandbox({ relayStateDirectory: fixture.relayStateDirectory,
      execPath: resolve(prefix, 'bin', 'node') });
    if (!sandbox.usable) assert.fail(`sandbox unusable: ${sandbox.reason}: ${sandbox.detail}`);
    const script = `const fs = require('node:fs'); const a = JSON.parse(process.argv[1]);
      const readable = p => { try { fs.readFileSync(p); return true; } catch { return false; } };
      process.stdout.write(JSON.stringify({ share: readable(a.shareCanary), state: readable(a.stateCanary),
        listing: (() => { try { return fs.readdirSync(a.prefix).sort(); } catch { return []; } })() }));`;
    const { task, publicKey } = signedTask(['prefix', 'npm.probe']);
    const policy = policyWith({
      prefix: { argv: [resolve(prefix, 'bin', 'node'), '-e', oneLine(script), JSON.stringify({ shareCanary, stateCanary, prefix })], timeoutSeconds: 30 },
      'npm.probe': { argv: ['npm', 'run', 'probe'], timeoutSeconds: 60 },
    });
    const receipt = await executeTask({ task, policy, workspace: fixture.workspace, relayStateDirectory: fixture.relayStateDirectory,
      serverPublicKey: publicKey, receiptStore: new FileTaskReceiptStore(resolve(fixture.root, 'receipts')),
      registeredCommandSandbox: sandbox, providerExecutor: async () => providerResult });
    const result = receipt.commandResults.find(({ commandId }) => commandId === 'prefix');
    assert.ok(result, JSON.stringify(receipt.commandResults.map(({ commandId, stderr }) => ({ commandId, stderr }))));
    assert.equal(result.exitCode, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), { share: false, state: false, listing: ['bin', 'lib'] });
    assert.equal(receipt.status, 'completed', JSON.stringify(receipt.commandResults.map(({ commandId, stderr }) => ({ commandId, stderr }))));
    assert.equal(await readFile(resolve(fixture.relayStateDirectory, 'worktrees', task.taskId, 'reports', 'npm.txt'), 'utf8'), 'npm ran');
  });

  test('a timeout stops every process the command started, including a detached one', async (t) => {
    const sandbox = await probe(t);
    const fixture = await repository(t);
    const { task, publicKey } = signedTask(['spin']);
    const script = `
      const { spawn } = require('node:child_process');
      spawn(process.execPath, ['-e', "setInterval(() => require('node:fs').appendFileSync('reports/tick.txt', 'x'), 100)"],
        { detached: true, stdio: 'ignore', windowsHide: true }).unref();
      setInterval(() => {}, 1000);`;
    const policy = policyWith({ spin: { argv: [process.execPath, '-e', oneLine(script)], timeoutSeconds: 2 } });
    const receipt = await executeTask({ task, policy, workspace: fixture.workspace, relayStateDirectory: fixture.relayStateDirectory,
      serverPublicKey: publicKey, receiptStore: new FileTaskReceiptStore(resolve(fixture.root, 'receipts')),
      registeredCommandSandbox: sandbox, providerExecutor: async () => providerResult });
    assert.equal(receipt.commandResults.find(({ commandId }) => commandId === 'spin')?.timedOut, true);
    const tick = resolve(fixture.relayStateDirectory, 'worktrees', task.taskId, 'reports', 'tick.txt');
    const first = (await stat(tick)).size;
    assert.ok(first > 0, 'the detached process ran before the timeout');
    await new Promise(accept => setTimeout(accept, 1_500));
    assert.equal((await stat(tick)).size, first, 'nothing writes after the timeout');
  });

  test('relay Git still reports a write outside the signed paths after a sandboxed command', async (t) => {
    const sandbox = await probe(t);
    const fixture = await repository(t);
    const { task, publicKey } = signedTask(['escape']);
    const policy = policyWith({ escape: { argv: [process.execPath, '-e', "require('node:fs').writeFileSync('outside.txt', 'x')"], timeoutSeconds: 30 } });
    const receipt = await executeTask({ task, policy, workspace: fixture.workspace, relayStateDirectory: fixture.relayStateDirectory,
      serverPublicKey: publicKey, receiptStore: new FileTaskReceiptStore(resolve(fixture.root, 'receipts')),
      registeredCommandSandbox: sandbox, providerExecutor: async () => providerResult });
    assert.equal(receipt.status, 'failed');
    assert.match(receipt.commandResults.at(-1)?.stderr || '', /outside the signed task authority/);
  });

  // Host Git closed: relay Git after a sandboxed command runs no filter, hook or configuration the
  // command could have influenced. The command writes only inside reports/, which the task may write.
  // Each case changes the tracked reports/.keep so that relay Git has to look at its content.
  const WRITE_SCRIPT = oneLine(`
    const fs = require('node:fs'), path = require('node:path');
    for (const file of JSON.parse(process.argv[1])) {
      fs.mkdirSync(path.dirname(file.path), { recursive: true });
      fs.writeFileSync(file.path, file.content, { mode: file.mode ?? 0o644 });
    }`);
  type TaskFile = { path: string; content: string; mode?: number };

  async function runWritingTask(sandbox: RegisteredCommandSandbox, fixture: Awaited<ReturnType<typeof repository>>, files: TaskFile[]) {
    const { task, publicKey } = signedTask(['write']);
    const policy = policyWith({ write: { argv: [process.execPath, '-e', WRITE_SCRIPT, JSON.stringify(files)], timeoutSeconds: 30 } });
    return executeTask({ task, policy, workspace: fixture.workspace, relayStateDirectory: fixture.relayStateDirectory,
      serverPublicKey: publicKey, receiptStore: new FileTaskReceiptStore(resolve(fixture.root, 'receipts')),
      registeredCommandSandbox: sandbox, providerExecutor: async () => providerResult });
  }

  // A clean filter that writes a canary outside the worktree when Git runs it on the host.
  async function canaryFilter(fixture: Awaited<ReturnType<typeof repository>>, name: string) {
    const canary = resolve(fixture.root, `filter-${name}-ran`);
    const script = resolve(fixture.root, `filter-${name}.cjs`);
    await writeFile(script, `require("node:fs").writeFileSync(${JSON.stringify(canary)}, "ran"); process.stdin.pipe(process.stdout);\n`);
    return { canary, command: `'${process.execPath}' '${script}'` };
  }

  function git(cwd: string, argv: string[]) {
    assert.equal(spawnSync('git', argv, { cwd, windowsHide: true }).status, 0, argv.join(' '));
  }

  test('relay Git ignores a global Git configuration whose filter a task-written .gitattributes names', async (t) => {
    const sandbox = await probe(t);
    const fixture = await repository(t);
    const filter = await canaryFilter(fixture, 'globalx');
    // The relay user's global configuration, found through XDG_CONFIG_HOME, which the relay passes to Git.
    const configHome = resolve(fixture.root, 'xdg');
    await mkdir(resolve(configHome, 'git'), { recursive: true });
    await writeFile(resolve(configHome, 'git', 'config'), `[filter "globalx"]\n\tclean = ${filter.command}\n`);
    const previous = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = configHome;
    t.after(() => { if (previous === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = previous; });
    const receipt = await runWritingTask(sandbox, fixture, [
      { path: 'reports/.gitattributes', content: '* filter=globalx\n' },
      { path: 'reports/.keep', content: 'changed by the command\n' },
    ]);
    assert.equal(await exists(filter.canary), false, 'relay Git ran a filter from the global configuration');
    assert.equal(receipt.status, 'completed', JSON.stringify(receipt.commandResults.map(({ commandId, stderr }) => ({ commandId, stderr }))));
  });

  test('relay Git does not start a repository-configured filter that a task-written .gitattributes assigns', async (t) => {
    const sandbox = await probe(t);
    const fixture = await repository(t);
    const filter = await canaryFilter(fixture, 'repox');
    // The operator's repository defines the driver, as Git LFS does; only the task names it.
    git(fixture.workspace, ['config', 'filter.repox.clean', filter.command]);
    const receipt = await runWritingTask(sandbox, fixture, [
      { path: 'reports/.gitattributes', content: '* filter=repox\n' },
      { path: 'reports/.keep', content: 'changed by the command\n' },
    ]);
    assert.equal(await exists(filter.canary), false, 'relay Git ran a filter that the task assigned');
    assert.equal(receipt.status, 'completed', JSON.stringify(receipt.commandResults.map(({ commandId, stderr }) => ({ commandId, stderr }))));
  });

  test('relay Git does not run a hook the task wrote into the repository hooks path', async (t) => {
    const sandbox = await probe(t);
    const fixture = await repository(t);
    // A hooks path inside the worktree, as husky configures it.
    git(fixture.workspace, ['config', 'core.hooksPath', 'reports/hooks']);
    const canary = resolve(fixture.root, 'hook-ran');
    const hook = `#!${process.execPath}\nrequire("node:fs").writeFileSync(${JSON.stringify(canary)}, "ran");\n`;
    const receipt = await runWritingTask(sandbox, fixture, [
      ...['post-index-change', 'post-checkout', 'reference-transaction', 'pre-auto-gc'].map(name =>
        ({ path: `reports/hooks/${name}`, content: hook, mode: 0o755 })),
      // Rewriting a tracked file with its own content leaves only stale index stat data, which
      // `git diff` refreshes by writing the index.
      { path: 'reports/.keep', content: '' },
    ]);
    assert.equal(await exists(canary), false, 'relay Git ran a hook the task wrote');
    assert.equal(receipt.status, 'completed', JSON.stringify(receipt.commandResults.map(({ commandId, stderr }) => ({ commandId, stderr }))));
  });
} else {
  test('a host that restricts user namespaces refuses, and no command runs', async (t) => {
    const fixture = await repository(t);
    const sandbox = await detectRegisteredCommandSandbox({ relayStateDirectory: fixture.relayStateDirectory });
    assert.equal(sandbox.usable, false, 'the image let bubblewrap through on a restricted host');
    if (sandbox.usable) return;
    assert.equal(sandbox.reason, 'user_namespaces_unavailable', sandbox.detail);
    assert.match(sandbox.detail, /max_user_namespaces=0/, 'the detail names the host setting that refused');
    const marker = resolve(fixture.root, 'command-ran');
    const { task, publicKey } = signedTask(['marker']);
    const policy = policyWith({ marker: { argv: [process.execPath, '-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran')`], timeoutSeconds: 30 } });
    let providerCalls = 0;
    await assert.rejects(executeTask({ task, policy, workspace: fixture.workspace, relayStateDirectory: fixture.relayStateDirectory,
      serverPublicKey: publicKey, receiptStore: new FileTaskReceiptStore(resolve(fixture.root, 'receipts')),
      registeredCommandSandbox: sandbox, providerExecutor: async () => { providerCalls++; return providerResult; } }),
    (error: unknown) => error instanceof RegisteredCommandsRefusedError && error.reason === 'user_namespaces_unavailable');
    assert.equal(providerCalls, 0);
    assert.equal(await exists(marker), false);
    assert.equal(await exists(resolve(fixture.relayStateDirectory, 'worktrees', task.taskId)), false);
  });
}
