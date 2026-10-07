import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import {EventEmitter} from 'node:events';
import {mkdtemp, realpath, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';
import test from 'node:test';
import {LocalVault, type LocalCodexSetupSessionRequest} from '@dharma-ai-labs/agent-fabric-local-vault';
import {receiveCodexSetupChildStart, runCodexSetupChildStartup, sendCodexSetupChildStart,
  type CodexSetupChildScope, type CodexSetupChildMessage} from './codexSetupChildStartup.js';
import {createNamedSessionChildOwner} from './namedSessionChildOwner.js';

const uuid = (n: number) => `${String(n).padStart(8, '0')}-1111-4111-8111-111111111111`;
const digest = `sha256:${'a'.repeat(64)}`;
const message: CodexSetupChildMessage = {schema: 'dharma.codex-setup-child-start/v1', operationId: uuid(1), intentDigest: digest};
async function fixture(t: {after(fn: () => Promise<void>): void}) {
  const root = await realpath(await mkdtemp(resolve(tmpdir(), 'dharma-child-start-'))), key = randomBytes(32);
  const vault = await LocalVault.open({root, masterKey: key}), controller = new AbortController();
  t.after(async () => {controller.abort(); vault.close(); key.fill(0); await rm(root, {recursive: true, force: true});});
  const claim = vault.claimCodexSetupOperation(uuid(1), digest);
  if (claim.state !== 'acquired') throw new Error('synthetic_claim_missing');
  const request: LocalCodexSetupSessionRequest = {schema: 'dharma.local-codex-setup-session/v1', operationId: uuid(1),
    intentDigest: digest, setupReference: uuid(2), senderPid: process.pid, senderStartTicks: '1', organizationId: 'org_demo',
    membershipId: uuid(3), deviceId: uuid(4), workspaceId: uuid(5), repositoryBindingId: uuid(6), endpointId: uuid(7), provider: 'codex',
    origin: 'https://hq.example', repositoryFingerprint: digest, policyRevision: 'policy-v1', policyHash: digest,
    scopeDigest: digest, contractDigest: digest, name: 'reviewer', workspaceRoot: root, maximumCostCents: 1000,
    maximumTurnCostCents: 25, issuedAt: new Date(Date.now() - 1000).toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString()};
  const submission = vault.stageCodexSetupSession(claim.leaseId, digest, request);
  const {canonicalize, sha256} = await import('@dharma-ai-labs/agent-fabric-contracts');
  const accept = () => vault.acceptCodexSetupSession(uuid(1), digest, sha256(canonicalize(request)))!;
  const input = {vault, message, name: request.name, workspaceId: request.workspaceId, signal: controller.signal, authorize: async () => true};
  return {vault, request, claim, controller, submission, accept, input};
}

test('child startup verifies encrypted acceptance and original running operation before and after effects', async t => {
  const f = await fixture(t); f.accept(); let effects = 0, retained!: CodexSetupChildScope;
  assert.equal(await runCodexSetupChildStartup(f.input, async scope => {
    retained = scope; assert.equal(scope.request.membershipId, f.request.membershipId);
    return scope.step(async () => {effects++; return 'synthetic-result';});
  }), 'synthetic-result');
  await assert.rejects(retained.step(async () => {effects++;}), /setup_child_unavailable/);
  assert.equal(effects, 1);
});

for (const change of ['absent', 'pending', 'withdrawn', 'completed-request', 'terminal-operation', 'name', 'workspace', 'policy', 'abort', 'expiry', 'future'] as const) {
  test(`child startup refuses ${change} without provider effects`, async t => {
    const f = await fixture(t); let effects = 0;
    if (change === 'withdrawn') f.submission.withdraw();
    else if (change !== 'pending') {
      const acceptance = f.accept();
      if (change === 'completed-request') acceptance.record({state: 'unconfirmed', code: 'session_start_unconfirmed'});
    }
    if (change === 'absent') f.input.message = {...message, operationId: uuid(99)};
    if (change === 'terminal-operation') f.vault.finishCodexSetupOperation(f.claim.leaseId, digest,
      {state: 'unconfirmed', code: 'setup_execution_unconfirmed'});
    if (change === 'name') f.input.name = 'foreign';
    if (change === 'workspace') f.input.workspaceId = uuid(99);
    if (change === 'policy') f.input.authorize = async () => false;
    if (change === 'abort') f.controller.abort();
    if (change === 'expiry' || change === 'future') t.mock.timers.enable({apis: ['Date'],
      now: Date.parse(change === 'expiry' ? f.request.expiresAt : f.request.issuedAt) + (change === 'expiry' ? 0 : -1)});
    await assert.rejects(runCodexSetupChildStartup(f.input, scope => scope.step(async () => {effects++;})), /setup_child_unavailable/);
    assert.equal(effects, 0);
  });
}

test('child startup rechecks encrypted disposition after the policy yield before dispatch', async t => {
  const f = await fixture(t), acceptance = f.accept(); let checks = 0, effects = 0;
  f.input.authorize = async () => {
    if (++checks === 2) acceptance.record({state: 'unconfirmed', code: 'session_start_unconfirmed'});
    return true;
  };
  await assert.rejects(runCodexSetupChildStartup(f.input, scope => scope.step(async () => {effects++;})), /setup_child_unavailable/);
  assert.equal(effects, 0);
});

test('child startup withholds an already-dispatched late result when its original operation becomes terminal', async t => {
  const f = await fixture(t); f.accept(); let effects = 0;
  await assert.rejects(runCodexSetupChildStartup(f.input, scope => scope.step(async () => {
    effects++; f.vault.finishCodexSetupOperation(f.claim.leaseId, digest, {state: 'unconfirmed', code: 'setup_execution_unconfirmed'});
    return 'synthetic-result';
  })), /setup_child_unavailable/);
  assert.equal(effects, 1, 'withheld result is not a rollback claim');
});

function ipc() {
  const emitter = new EventEmitter();
  return Object.assign(emitter, {connected: true, channel: {}}) as unknown as Parameters<typeof receiveCodexSetupChildStart>[0]['process'] & EventEmitter;
}

test('child IPC accepts one bounded message and never accepts a second receive', async () => {
  const process = ipc(), signal = new AbortController().signal;
  const waiting = receiveCodexSetupChildStart({process, signal}); process.emit('message', message);
  assert.deepEqual(await waiting, message);
  await assert.rejects(receiveCodexSetupChildStart({process, signal}), /setup_child_unavailable/);
  assert.equal(process.listenerCount('message'), 0); assert.equal(process.listenerCount('disconnect'), 0);
});

test('child IPC tolerates parent authorization beyond five seconds within the existing thirty-second bound', async t => {
  t.mock.timers.enable({apis: ['setTimeout']});
  const process = ipc(), signal = new AbortController().signal;
  let received = false;
  const waiting = receiveCodexSetupChildStart({process, signal}).then(value => {received = true; return value;});
  t.mock.timers.tick(6000);
  assert.equal(received, false);
  assert.equal(process.listenerCount('message'), 1);
  process.emit('message', message);
  assert.deepEqual(await waiting, message);
  assert.equal(process.listenerCount('message'), 0);
});

test('child IPC keeps the thirty-second ceiling and cannot wait beyond it', async t => {
  t.mock.timers.enable({apis: ['setTimeout']});
  const process = ipc(), signal = new AbortController().signal;
  const waiting = receiveCodexSetupChildStart({process, signal});
  const rejected = assert.rejects(waiting, /setup_child_unavailable/);
  t.mock.timers.tick(30_000);
  await rejected;
  assert.equal(process.listenerCount('message'), 0);
  await assert.rejects(receiveCodexSetupChildStart({process: ipc(), signal, waitMs: 30_001}), /setup_child_unavailable/);
});

for (const kind of ['disconnected', 'malformed', 'extra', 'accessor', 'timeout', 'abort', 'disconnect'] as const) {
  test(`child IPC rejects ${kind} and removes listeners`, async () => {
    const process = ipc(), controller = new AbortController();
    if (kind === 'disconnected') process.connected = false;
    const waiting = receiveCodexSetupChildStart({process, signal: controller.signal, waitMs: 1});
    if (kind === 'malformed') process.emit('message', 'synthetic-invalid');
    if (kind === 'extra') process.emit('message', {...message, grant: 'synthetic-rejected-field'});
    if (kind === 'accessor') process.emit('message', {...message, get operationId() {throw new Error('must not run');}});
    if (kind === 'abort') controller.abort();
    if (kind === 'disconnect') process.emit('disconnect');
    await assert.rejects(waiting, /setup_child_unavailable/);
    assert.equal(process.listenerCount('message'), 0); assert.equal(process.listenerCount('disconnect'), 0);
  });
}

test('standing sender uses the exact fresh IPC child, not a copied handle with its PID', async t => {
  const f = await fixture(t), owner = createNamedSessionChildOwner(f.controller.signal);
  await owner.run(async () => {
    const child = await owner.spawn(f.request.name, () => spawn(process.execPath,
      ['-e', 'process.on("message", value => {process.send({received: value});});'], {stdio: ['ignore', 'ignore', 'ignore', 'ipc']}));
    const receipt = new Promise<unknown>(done => child.once('message', done));
    const scope = {request: f.request, async step<T>(operation: () => Promise<T>) {return operation();}};
    await assert.rejects(sendCodexSetupChildStart({owner, child: {...child} as typeof child, scope}), /owner_unavailable/);
    await sendCodexSetupChildStart({owner, child, scope});
    assert.deepEqual(await receipt, {received: message});
    assert.equal(Object.keys(message).length, 3);
  });
});
