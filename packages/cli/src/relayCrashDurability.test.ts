import assert from 'node:assert/strict';
import {execFile, spawn, type ChildProcess} from 'node:child_process';
import {generateKeyPairSync, randomUUID} from 'node:crypto';
import * as fs from 'node:fs/promises';
import {createRequire} from 'node:module';
import {tmpdir} from 'node:os';
import {dirname, join, resolve} from 'node:path';
import test from 'node:test';
import {fileURLToPath} from 'node:url';
import {promisify} from 'node:util';
import {runInNewContext} from 'node:vm';
import {Ajv2020} from 'ajv/dist/2020.js';
import type {FormatsPlugin} from 'ajv-formats';
import ts from 'typescript';
import {signCanonicalObject} from '@dharma-ai-labs/agent-fabric-contracts';
import {applyServerEvidencePolicy, materializeWorkspacePolicy, run} from './index.js';
import {workspaceIdForDevice} from './onboardingWorkspace.js';
import {currentRelayChildFailure, relayChildExitReceipt, relayChildFailureCode, relayStartFailureReceipt} from './relayChildFailure.js';
import {superviseRelay} from './relaySupervisor.js';

const execFileAsync = promisify(execFile);
const bin = fileURLToPath(new URL('./bin.js', import.meta.url));
const NUL_STATE = Buffer.alloc(186);
const REPLAY_TEXT = 'Workspace authorization replay state is missing or invalid';

// Parse the private production declarations; inject only their file boundaries.
async function privateFunctions(names: string[], context: Record<string, unknown>) {
  const source = await fs.readFile(new URL('../src/index.ts', import.meta.url), 'utf8');
  const ast = ts.createSourceFile('index.ts', source, ts.ScriptTarget.Latest, true);
  const declarations = names.map(name => {
    const nodes = ast.statements.filter(node => ts.isFunctionDeclaration(node) && node.name?.text === name);
    assert.equal(nodes.length, 1); return nodes[0]!.getText(ast);
  });
  const output = ts.transpileModule(declarations.join('\n'), {compilerOptions: {
    target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.None}});
  return runInNewContext(`${output.outputText}\n({${names.join(',')}})`, {...fs, dirname, resolve, randomUUID, process,
    Date, structuredClone, exports: {}, currentBootstrapHostScope: () => undefined, ...context},
  {timeout: 1000}) as Record<string, (...args: any[]) => Promise<any>>;
}

async function failureReceiptValidator() {
  const url = new URL('./schemas/local-relay-child-failure.schema.json', import.meta.url);
  const ajv = new Ajv2020({strict: true, strictRequired: false});
  (createRequire(import.meta.url)('ajv-formats') as FormatsPlugin)(ajv);
  return ajv.compile(JSON.parse(await fs.readFile(url, 'utf8')));
}

async function temporaryRoot(t: {after(fn: () => Promise<void>): void}, prefix: string) {
  const root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), prefix)));
  t.after(() => fs.rm(root, {recursive: true, force: true, maxRetries: 5}));
  return root;
}

function recordedFiles(target: string, failures: {fileSync?: string; directorySync?: string} = {}) {
  const events: string[] = [];
  const label = (path: string) => path === dirname(target) ? 'directory' : 'temporary';
  return {events, overrides: {
    open: async (path: string, ...rest: [string, number]) => {
      const handle = await fs.open(path, ...rest), name = label(path);
      events.push(`open:${name}`);
      return {
        writeFile: async (data: string) => {events.push(`write:${name}`); return handle.writeFile(data);},
        sync: async () => {
          events.push(`sync:${name}`);
          const code = name === 'directory' ? failures.directorySync : failures.fileSync;
          if (code) throw Object.assign(new Error(`synthetic ${code}`), {code});
          return handle.sync();
        },
        close: async () => {events.push(`close:${name}`); return handle.close();},
      };
    },
    rename: async (from: string, to: string) => {events.push('rename'); return fs.rename(from, to);},
  }};
}

test('replay and protocol state reaches disk before the rename publishes it', async t => {
  const root = await temporaryRoot(t, 'dharma-durable-json-');
  const target = join(root, 'state', 'authorization.json');
  const files = recordedFiles(target);
  const {writeJsonAtomic} = await privateFunctions(['writeJsonAtomic'], files.overrides);
  await writeJsonAtomic!(target, {issuedAt: '0.2.214'});
  assert.deepEqual(files.events, ['open:temporary', 'write:temporary', 'sync:temporary', 'close:temporary', 'rename',
    'open:directory', 'sync:directory', 'close:directory']);
  assert.deepEqual(JSON.parse(await fs.readFile(target, 'utf8')), {issuedAt: '0.2.214'});
  assert.deepEqual(await fs.readdir(dirname(target)), ['authorization.json']);
});

test('a file flush failure leaves the previous state in place', async t => {
  const root = await temporaryRoot(t, 'dharma-durable-json-');
  const target = join(root, 'authorization.json');
  await fs.writeFile(target, '{"previous":true}\n');
  const files = recordedFiles(target, {fileSync: 'EIO'});
  const {writeJsonAtomic} = await privateFunctions(['writeJsonAtomic'], files.overrides);
  await assert.rejects(writeJsonAtomic!(target, {next: true}), {code: 'EIO'});
  assert.equal(files.events.includes('rename'), false);
  assert.equal(await fs.readFile(target, 'utf8'), '{"previous":true}\n');
});

test('a platform that cannot flush a directory still commits the state', async t => {
  const root = await temporaryRoot(t, 'dharma-durable-json-');
  const target = join(root, 'authorization.json');
  const files = recordedFiles(target, {directorySync: 'EPERM'});
  const {writeJsonAtomic} = await privateFunctions(['writeJsonAtomic'], files.overrides);
  await writeJsonAtomic!(target, {windows: true});
  assert.ok(files.events.includes('sync:directory'));
  assert.ok(files.events.includes('close:directory'));
  assert.deepEqual(JSON.parse(await fs.readFile(target, 'utf8')), {windows: true});
});

test('a NUL-filled replay state still refuses, and nothing repairs or removes it', async t => {
  const root = await temporaryRoot(t, 'dharma-nul-replay-');
  const statePath = join(root, 'state.json');
  await fs.writeFile(statePath, NUL_STATE);
  const {assertWorkspaceAuthorizationCurrent} = await privateFunctions(['assertWorkspaceAuthorizationCurrent'],
    {workspaceAuthorizationStatePath: () => statePath});
  for (const requireExisting of [true, false]) {
    await assert.rejects(assertWorkspaceAuthorizationCurrent!('0.2.214',
      {issuedAt: new Date().toISOString(), signature: '0.2.214'}, requireExisting), {message: new RegExp(REPLAY_TEXT)});
  }
  assert.deepEqual(await fs.readFile(statePath), NUL_STATE);
  assert.deepEqual(await fs.readdir(root), ['state.json']);
});

test('the supervisor reports each unexpected child exit and keeps restarting', async () => {
  const controller = new AbortController();
  const exits: unknown[] = [];
  const started: ChildProcess[] = [];
  let starts = 0;
  const options = {signal: controller.signal, wait: async () => {if (starts === 2) controller.abort();},
    onExit: async (exit: unknown) => {exits.push(exit); throw new Error('receipt storage unavailable');},
    start: () => {
      starts += 1;
      const child = spawn(process.execPath, ['-e', 'process.exit(2)'], {stdio: 'ignore'});
      started.push(child); return child;
    }};
  const result = await superviseRelay(options);
  assert.equal(starts, 2, 'a receipt failure must not stop supervision');
  assert.equal(result.restarts, 2);
  assert.deepEqual(exits, started.map(child => ({pid: child.pid, exitCode: 2, signal: null})));
});

test('a requested stop is not reported as a child failure', async () => {
  const controller = new AbortController();
  const exits: unknown[] = [];
  const options = {signal: controller.signal, onExit: (exit: unknown) => {exits.push(exit);},
    start: () => {
      const child = spawn(process.execPath, ['-e', 'console.log("ready"); setInterval(() => {}, 1000)'],
        {stdio: ['ignore', 'pipe', 'ignore']});
      child.stdout!.once('data', () => controller.abort());
      return child;
    }};
  await superviseRelay(options);
  assert.deepEqual(exits, []);
});

async function withHome<T>(home: string, operation: () => Promise<T>) {
  const previous = process.env.DHARMA_HOME;
  process.env.DHARMA_HOME = home;
  try {return await operation();}
  finally {if (previous === undefined) delete process.env.DHARMA_HOME; else process.env.DHARMA_HOME = previous;}
}

test('status replaces plain restarting with the current supervisor child failure', async t => {
  const home = await temporaryRoot(t, 'dharma-status-failure-');
  const receiptPath = join(home, 'relay', 'last-child-failure.json');
  await fs.mkdir(join(home, 'relay'));
  await fs.writeFile(join(home, 'relay', 'supervisor.pid'), `${process.pid}\n`);
  const at = new Date().toISOString();
  const receipt = {schema: 'dharma.local-relay-child-failure/v1', code: 'workspace_authorization_replay_state_invalid',
    at, pid: 4242, version: '0.2.214', workspaceId: null, supervisorPid: process.pid, exitCode: 2, signal: null};
  const reconnect = async () => withHome(home, async () => (await run(['status']) as {reconnect: unknown}).reconnect);
  assert.deepEqual(await reconnect(), {state: 'restarting', lastSuccessfulPollAt: null});
  await fs.writeFile(receiptPath, JSON.stringify(receipt));
  assert.deepEqual(await reconnect(), {state: 'failing', lastSuccessfulPollAt: null, lastFailure: {
    code: 'workspace_authorization_replay_state_invalid', at, exitCode: 2, signal: null}});
  for (const stale of [{...receipt, supervisorPid: process.pid + 1}, {...receipt, schema: 'foreign'},
    {...receipt, code: 'Free text with a token'}, {...receipt, at: 'not-a-time'}]) {
    await fs.writeFile(receiptPath, JSON.stringify(stale));
    assert.deepEqual(await reconnect(), {state: 'restarting', lastSuccessfulPollAt: null});
  }
  await fs.writeFile(receiptPath, NUL_STATE);
  assert.deepEqual(await reconnect(), {state: 'restarting', lastSuccessfulPollAt: null});
});

// The relay process is alive here, as on the wedged G11 device: only its session opens fail.
async function runningRelayHome(t: {after(fn: () => Promise<void>): void}) {
  const home = await temporaryRoot(t, 'dharma-status-open-failure-');
  const workspaceId = randomUUID(), repository = join(home, 'relay', 'repositories', workspaceId);
  const organizationId = 'org_test', deviceId = 'device_test', relayPid = join(home, 'relay', 'relay.pid');
  await fs.mkdir(repository, {recursive: true});
  await fs.writeFile(relayPid, `${process.pid}\n`);
  await fs.writeFile(join(home, 'relay', 'supervisor.pid'), `${process.pid}\n`);
  await fs.writeFile(join(home, 'relay', 'supervisor-workspace.json'), JSON.stringify({pid: process.pid, workspaceId}));
  await fs.writeFile(join(home, 'device.json'), JSON.stringify({organizationId, deviceId}));
  const {mtimeMs, ctimeMs} = await fs.stat(relayPid);
  const at = new Date().toISOString();
  const receipt = {schema: 'dharma.local-repository-relay-failure/v1', organizationId, deviceId, workspaceId,
    pid: process.pid, relayPidMtimeMs: mtimeMs, relayPidCtimeMs: ctimeMs, at, stage: 'session_open',
    category: 'unexpected', failureCode: 'connection_anchor_lock_invalid'};
  const reconnect = async () => withHome(home, async () => (await run(['status']) as {reconnect: {state: string}}).reconnect);
  return {home, workspaceId, repository, at, receipt, reconnect,
    writeReceipt: (value: unknown) => fs.writeFile(join(repository, 'last-failure.json'), JSON.stringify(value))};
}

test('status says failing while a running relay fails every session open', async t => {
  const f = await runningRelayHome(t);
  const version = (await withHome(f.home, () => run(['status'])) as {version: string}).version;
  const pollAt = new Date(Date.parse(f.at) - 60_000).toISOString();
  await fs.writeFile(join(f.home, 'relay', 'last-successful-poll.json'),
    JSON.stringify({at: pollAt, workspaceId: f.workspaceId, version}));
  assert.equal((await f.reconnect()).state, 'acknowledged_recently');
  await f.writeReceipt(f.receipt);
  assert.deepEqual(await f.reconnect(), {state: 'failing', lastSuccessfulPollAt: pollAt, lastFailure: {
    code: 'connection_anchor_lock_invalid', at: f.at, stage: 'session_open', category: 'unexpected'}});
});

test('a session open failure without a known code still reads as failing, with no free text', async t => {
  const f = await runningRelayHome(t);
  await f.writeReceipt({...f.receipt, failureCode: 'C:/Users/someone/.secret'});
  const reconnect = await f.reconnect();
  assert.deepEqual(reconnect, {state: 'failing', lastSuccessfulPollAt: null, lastFailure: {
    code: 'repository_relay_failed', at: f.at, stage: 'session_open', category: 'unexpected'}});
});

test('status drops the session open failure once it is no longer current', async t => {
  const f = await runningRelayHome(t);
  const repositoryPoll = join(f.repository, 'last-successful-poll.json');
  await f.writeReceipt(f.receipt);
  assert.equal((await f.reconnect()).state, 'failing');
  await fs.writeFile(repositoryPoll, JSON.stringify({at: new Date(Date.parse(f.at) + 1000).toISOString()}));
  assert.equal((await f.reconnect()).state, 'awaiting_acknowledgement');
  await fs.rm(repositoryPoll);
  for (const stale of [{...f.receipt, pid: process.pid + 1}, {...f.receipt, relayPidMtimeMs: 1},
    {...f.receipt, stage: 'task_poll'}]) {
    await f.writeReceipt(stale);
    assert.equal((await f.reconnect()).state, 'awaiting_acknowledgement');
  }
  await fs.writeFile(join(f.repository, 'last-failure.json'), NUL_STATE);
  assert.equal((await f.reconnect()).state, 'awaiting_acknowledgement');
});

test('status finds the failure under the workspace the loop used, not the supervisor alias', async t => {
  const f = await runningRelayHome(t);
  await f.writeReceipt(f.receipt);
  await fs.writeFile(join(f.home, 'relay', 'supervisor-workspace.json'),
    JSON.stringify({pid: process.pid, workspaceId: randomUUID()}));
  assert.equal((await f.reconnect()).state, 'failing');
});

test('status ignores a failure record outside a workspace directory', async t => {
  const f = await runningRelayHome(t);
  const outside = join(f.home, 'relay', 'repositories', 'outside');
  await fs.mkdir(outside);
  await fs.writeFile(join(outside, 'last-failure.json'), JSON.stringify({...f.receipt, workspaceId: 'outside'}));
  assert.equal((await f.reconnect()).state, 'awaiting_acknowledgement');
});

test('a session that opens again clears only its own session open failure', async t => {
  const f = await runningRelayHome(t), path = join(f.repository, 'last-failure.json');
  const {clearSessionOpenFailure} = await privateFunctions(['clearSessionOpenFailure'], {dharmaHome: () => f.home});
  await f.writeReceipt(f.receipt);
  assert.equal((await f.reconnect()).state, 'failing');
  await clearSessionOpenFailure!(f.workspaceId);
  await assert.rejects(fs.readFile(path), {code: 'ENOENT'});
  assert.equal((await f.reconnect()).state, 'awaiting_acknowledgement');
  await clearSessionOpenFailure!(f.workspaceId);
  await f.writeReceipt({...f.receipt, stage: 'task_poll'});
  await clearSessionOpenFailure!(f.workspaceId);
  assert.equal(JSON.parse(await fs.readFile(path, 'utf8')).stage, 'task_poll');
});

test('the repository failure receipt schema admits a code and refuses text', async t => {
  const f = await runningRelayHome(t);
  const ajv = new Ajv2020({strict: true, strictRequired: false});
  (createRequire(import.meta.url)('ajv-formats') as FormatsPlugin)(ajv);
  const validate = ajv.compile(JSON.parse(await fs.readFile(
    new URL('./schemas/local-repository-relay-failure.schema.json', import.meta.url), 'utf8')));
  const {failureCode: _unused, ...withoutCode} = f.receipt;
  assert.equal(validate(f.receipt), true, JSON.stringify(validate.errors));
  assert.equal(validate(withoutCode), true, JSON.stringify(validate.errors));
  for (const bad of [{...f.receipt, failureCode: 'C:/Users/someone/.secret'}, {...f.receipt, message: 'text'},
    {...f.receipt, stage: 'free text'}]) assert.equal(validate(bad), false);
});

async function signedWorkspace(t: {after(fn: () => Promise<void>): void}) {
  const root = await temporaryRoot(t, 'dharma-relay-nul-');
  const home = join(root, 'home'), workspace = join(root, 'repo');
  const organizationId = 'org_test', deviceId = 'device_test';
  const workspaceId = workspaceIdForDevice({organizationId, deviceId, path: workspace});
  const policyPath = join(workspace, '.dharma', 'approved-policy.json');
  const statePath = join(home, 'registry', 'workspace-authorizations', `${workspaceId}.json`);
  await fs.mkdir(dirname(statePath), {recursive: true});
  await fs.mkdir(dirname(policyPath), {recursive: true});
  const keys = generateKeyPairSync('ed25519'), now = Date.now();
  const publicKey = keys.publicKey.export({format: 'jwk'}).x!;
  const unsigned = {schema: 'dharma.workspace-policy-authorization/v1', organizationId, workspaceId,
    policy: {revision: 'signed-test-policy', evidence: {automaticDisclosure: {mode: 'customer_authorized_content',
      consentReceiptId: 'synthetic-consent', allowedContentClasses: ['native_provider_payload']},
    maximumCapsuleBytes: 1000, maximumDailyUploadBytes: 10000, maximumExpansionBytes: 100,
    excludePaths: ['**/.env', '**/*.key'], pseudonymizeIdentity: true}},
    issuedAt: new Date(now - 1000).toISOString(), expiresAt: new Date(now + 600_000).toISOString(), keyVersion: '0.2.214'};
  const {policy: base} = await withHome(home,
    () => materializeWorkspacePolicy({workspace, organizationId, revision: 'base'}));
  await fs.writeFile(policyPath, JSON.stringify(applyServerEvidencePolicy(base,
    {...unsigned, signature: signCanonicalObject(unsigned, keys.privateKey)}, publicKey, organizationId, workspaceId)));
  await fs.writeFile(join(home, 'device.json'), JSON.stringify({schema: 'dharma.device-config/v1',
    hqUrl: 'https://hq.example', organizationId, deviceId, deviceName: 'Synthetic device', platform: 'linux',
    publicKeyEd25519: 'A'.repeat(43), serverPublicKeyEd25519: publicKey, relayUrl: 'wss://relay.example',
    enrolledAt: '2026-10-01T00:00:00.000Z'}));
  await fs.writeFile(join(home, 'registry', 'workspaces.json'), JSON.stringify([
    {path: workspace, workspaceId, organizationId, repositoryRemoteHash: null, routeHash: 'sha256:synthetic'}]));
  await fs.writeFile(statePath, NUL_STATE);
  return {home, workspaceId, policyPath, statePath, env: {...process.env, DHARMA_HOME: home},
    receiptPath: join(home, 'relay', 'last-child-failure.json')};
}

test('relay start on a NUL-filled replay state leaves a stable receipt before the lease', async t => {
  const f = await signedWorkspace(t);
  const failed = await execFileAsync(process.execPath, [bin, 'relay', 'start', '--policy', f.policyPath],
    {env: f.env, timeout: 30_000}).then(() => null, (error: {code: number; stderr: string}) => error);
  assert.equal(failed?.code, 2);
  assert.match(failed?.stderr ?? '', new RegExp(REPLAY_TEXT));
  const text = await fs.readFile(f.receiptPath, 'utf8');
  const receipt = JSON.parse(text);
  assert.equal(receipt.schema, 'dharma.local-relay-child-failure/v1');
  assert.equal(receipt.code, 'workspace_authorization_replay_state_invalid');
  assert.equal(receipt.workspaceId, f.workspaceId);
  assert.equal(text.includes(REPLAY_TEXT), false, 'the receipt carries a code, never error text');
  const validate = await failureReceiptValidator();
  assert.equal(validate(receipt), true, JSON.stringify(validate.errors));
  await assert.rejects(fs.stat(join(f.home, 'relay', 'relay.pid')), {code: 'ENOENT'});
  assert.deepEqual(await fs.readFile(f.statePath), NUL_STATE);
});

test('a supervised relay on a NUL-filled replay state shows the failure in status', async t => {
  const f = await signedWorkspace(t);
  const supervisor = spawn(process.execPath, [bin, 'relay', 'supervise', '--policy', f.policyPath],
    {env: f.env, stdio: 'ignore', detached: true});
  try {
    let receipt: {supervisorPid?: number; exitCode?: number; code?: string} | null = null;
    for (let attempt = 0; attempt < 300 && !receipt?.supervisorPid; attempt += 1) {
      receipt = await fs.readFile(f.receiptPath, 'utf8').then(value => JSON.parse(value)).catch(() => null);
      await new Promise(resolveWait => setTimeout(resolveWait, 100));
    }
    assert.equal(receipt?.supervisorPid, supervisor.pid);
    assert.equal(receipt?.code, 'workspace_authorization_replay_state_invalid');
    assert.equal(receipt?.exitCode, 2);
    const validate = await failureReceiptValidator();
    assert.equal(validate(receipt), true, JSON.stringify(validate.errors));
    const {stdout} = await execFileAsync(process.execPath, [bin, 'status'], {env: f.env, timeout: 30_000});
    const status = JSON.parse(stdout);
    assert.equal(status.reconnect.state, 'failing');
    assert.equal(status.reconnect.lastFailure.code, 'workspace_authorization_replay_state_invalid');
    await execFileAsync(process.execPath, [bin, 'relay', 'stop'], {env: f.env, timeout: 30_000});
    assert.deepEqual(await fs.readFile(f.statePath), NUL_STATE);
  } finally {
    if (supervisor.exitCode === null) supervisor.kill('SIGTERM');
  }
});

test('failure receipts keep stable codes and never store error text', () => {
  const canary = 'token-sk-private-canary C:\Users\private\secret.json';
  for (const [message, code] of [
    [`${REPLAY_TEXT}; apply a fresh server policy.`, 'workspace_authorization_replay_state_invalid'],
    ['Relay requires current enrollment.', 'relay_enrollment_missing'],
    ['Relay policy is not registered to this enrolled device.', 'relay_policy_not_registered'],
    ['Another relay process is already running for this device.', 'relay_lease_unavailable'],
    ['Cannot start a second relay while process state is unknown.', 'relay_lease_unavailable'],
    [canary, 'relay_start_failed'],
  ] as const) assert.equal(relayChildFailureCode(new Error(message)), code);
  const started = relayStartFailureReceipt({error: new Error(canary), pid: 10, version: '0.2.214', workspaceId: null});
  assert.equal(JSON.stringify(started).includes('canary'), false);
  const exit = {pid: 10, exitCode: 2, signal: null};
  const own = relayChildExitReceipt({previous: {...started, code: 'relay_lease_unavailable'}, exit, supervisorPid: 20, version: '0.2.214'});
  assert.equal(own.code, 'relay_lease_unavailable');
  assert.equal(own.supervisorPid, 20);
  for (const previous of [null, {...started, pid: 11}, {...started, code: canary}, {...started, schema: 'foreign'}]) {
    const generic = relayChildExitReceipt({previous, exit, supervisorPid: 20, version: '0.2.214'});
    assert.equal(generic.code, 'relay_child_exited');
    assert.equal(JSON.stringify(generic).includes('canary'), false);
  }
  assert.equal(relayChildExitReceipt({previous: {...started, pid: null}, exit: {pid: null, exitCode: null, signal: null},
    supervisorPid: 20, version: '0.2.214'}).code, 'relay_child_exited');
  assert.equal(currentRelayChildFailure(own, 0), null);
});

test('the failure receipt schema admits both receipt forms and refuses text or a half-stamped exit', async () => {
  const validate = await failureReceiptValidator();
  const version = '0.2.219', canary = 'token-sk-private-canary';
  const start = relayStartFailureReceipt({error: new Error(canary), pid: 10, version, workspaceId: null});
  const stamp = (exit: {pid: number | null; exitCode: number | null; signal: NodeJS.Signals | null}) =>
    relayChildExitReceipt({previous: start, exit, supervisorPid: 20, version});
  const stamped = stamp({pid: 10, exitCode: 2, signal: null});
  for (const receipt of [start, stamped, stamp({pid: 10, exitCode: null, signal: 'SIGKILL'}),
    stamp({pid: null, exitCode: null, signal: null})]) {
    assert.equal(validate(receipt), true, JSON.stringify(validate.errors));
  }
  const {exitCode: _exitCode, ...withoutExitCode} = stamped;
  for (const receipt of [{...start, message: canary}, {...start, code: canary}, {...start, at: 'not-a-time'},
    {...start, pid: null}, {...start, pid: 0}, {...start, version: canary}, {...start, code: 'relay_child_exited'},
    {...start, exitCode: 2}, {...start, signal: 'SIGTERM'}, {...stamped, supervisorPid: 0}, {...stamped, signal: canary},
    withoutExitCode]) assert.equal(validate(receipt), false, JSON.stringify(receipt));
});
