import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import * as fs from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';
import test from 'node:test';
import {AgentFabricClient, AgentFabricRequestError, loadOrCreateDeviceIdentity, saveDeviceConfig, saveDeviceEnrollmentAnchor,
  withDeviceSigningControl, type DeviceConfig} from '@dharma-ai-labs/agent-fabric-relay-client';
import type {SecureSecretStore} from '@dharma-ai-labs/agent-fabric-secure-store';
import {admitSignedRequests, withClientSigningControl} from './signedRequestAdmission.js';

// Owner re-review: a relay workspace loop's requests go through the admission line, so each one runs inside a hold of
// signing control that the line takes. That hold still makes at most one network send, while another client waits.

async function device(t: {after(fn: () => Promise<void>): void}) {
  const root = await fs.mkdtemp(resolve(tmpdir(), 'dharma-admission-one-send-'));
  t.after(() => fs.rm(root, {recursive: true, force: true}));
  const values = new Map<string, string>();
  const store: SecureSecretStore = {backend: 'linux-secret-service', async get(account) {return values.get(account) ?? null;},
    async put(account, value) {values.set(account, value);}, async delete(account) {values.delete(account);}};
  const hqUrl = 'https://hq.example', organizationId = 'org_a';
  const identity = await loadOrCreateDeviceIdentity({hqUrl, organizationId, store});
  const config: DeviceConfig = {schema: 'dharma.device-config/v1', hqUrl, organizationId, deviceId: randomUUID(),
    deviceName: 'Synthetic', platform: 'linux', publicKeyEd25519: identity.publicKeyEd25519,
    serverPublicKeyEd25519: identity.publicKeyEd25519, relayUrl: 'wss://relay.example', enrolledAt: new Date().toISOString()};
  const configPath = resolve(root, 'device.json'), statePath = resolve(root, 'state.json');
  await saveDeviceConfig(configPath, config);
  await saveDeviceEnrollmentAnchor({config, store});
  return {config, configPath, statePath, store};
}

/** The pid of a process that has exited, standing in for a command that left a kept request behind. */
async function exitedPid(): Promise<number> {
  const child = spawn(process.execPath, ['-e', ''], {stdio: 'ignore'});
  await new Promise(accept => child.once('exit', accept));
  return child.pid!;
}

const delay = (ms: number) => new Promise(accept => setTimeout(accept, ms));

/** Another client asks for signing control at each send, from outside any hold; each send records how many askers
 * from earlier sends still wait. A send that finds one waiting shares its hold with an earlier send. */
function waitingClient(config: {hqUrl: string; organizationId: string; deviceId: string}) {
  const waiting = new Set<number>();
  const behind: number[] = [];
  let asked = 0, stopped = false, wake: () => void = () => undefined;
  const asking = (async () => {
    for (;;) {
      await new Promise<void>(accept => {wake = accept;});
      if (stopped) return;
      const id = ++asked;
      waiting.add(id);
      void withDeviceSigningControl({config}, async () => {waiting.delete(id);});
    }
  })();
  return {
    behind,
    async send() {behind.push(waiting.size); wake(); await delay(25);},
    async stop() {stopped = true; wake(); await asking; await withDeviceSigningControl({config}, async () => undefined);},
  };
}

/** A kept request of a command that exited, recent enough to send as signed. */
function orphan(deviceId: string, ownerPid: number) {
  const id = randomUUID(), now = new Date().toISOString();
  return {sessionId: randomUUID(), nextSequence: 2, ownerPid, updatedAt: now,
    pending: {method: 'POST', pathname: '/api/v1/orgs/org_a/agent-fabric/workspaces', body: '{"workspaceId":"orphan"}', headers: {
      'content-type': 'application/json', 'idempotency-key': id, 'x-dharma-device-id': deviceId,
      'x-dharma-session-id': randomUUID(), 'x-dharma-message-id': id, 'x-dharma-timestamp': now,
      'x-dharma-nonce': 'orphan-nonce', 'x-dharma-sequence': '1', 'x-dharma-signature': 'orphan-signature'}}};
}

test('an admitted request makes at most one network send per hold of signing control while another client waits: own recovery and a full file', async t => {
  const d = await device(t);
  let down = false;
  let other: ReturnType<typeof waitingClient> | undefined;
  const fabric = admitSignedRequests(await AgentFabricClient.open({configPath: d.configPath, statePath: d.statePath, store: d.store,
    ownerKey: 'relay:workspace-a', fetcher: async url => {
      await other?.send();
      return down && String(url).endsWith('/agent-fabric/workspaces')
        ? new Response(JSON.stringify({ok: false, error: {code: 'upstream_unavailable', message: 'Try again.'}}), {status: 503})
        : new Response(JSON.stringify({ok: true}), {status: 201});
    }}));
  const waiter = waitingClient(d.config);
  other = waiter;
  const scenario = async (name: string, sends: number, work: () => Promise<unknown>) => {
    const from = waiter.behind.length;
    await work();
    await withDeviceSigningControl({config: d.config}, async () => undefined);
    const behind = waiter.behind.slice(from);
    assert.equal(behind.length, sends, `${name}: ${sends} sends`);
    assert.deepEqual(behind, behind.map(() => 0), `${name}: no send shares its hold with an earlier one`);
  };
  try {
    await fabric.openSession();
    // Own recovery: the loop's earlier kept call, then the caller's call.
    down = true;
    await assert.rejects(fabric.registerWorkspace({workspaceId: 'a'}), error => error instanceof AgentFabricRequestError && error.status === 503);
    down = false;
    await scenario('own recovery', 2, () => fabric.pollTask());
    // A full file of kept requests that commands which exited just now left: one is sent to make room, then the
    // caller's call, and the loop sends one more after its call, in a section of its own.
    const dead = await exitedPid();
    await fs.writeFile(d.statePath, JSON.stringify({schema: 'dharma.protocol-state/v1', sessionId: null, nextSequence: 1, pending: null,
      outboxes: Object.fromEntries(Array.from({length: 256}, (_, index) => [`cli:${dead}:x:${index}`, orphan(d.config.deviceId, dead)]))}));
    await scenario('full file', 3, () => fabric.registerWorkspace({workspaceId: 'b'}));
  } finally { await waiter.stop(); }
});

// Owner re-review: the workspace policy sync holds signing control itself around one signed call (registerWorkspace),
// with the refresh lock inside. That hold also makes at most one network send: when the call first sends this client's
// earlier kept call, or an orphan that makes room in a full file, the hold ends there, and the sync takes control and
// the refresh lock again, in that order, before the caller's request is signed.
test('a hold a caller takes around one signed call, as the workspace policy sync does, makes at most one network send while another client waits: own recovery and a full file', async t => {
  const d = await device(t);
  let down = false;
  let other: ReturnType<typeof waitingClient> | undefined;
  const fabric = admitSignedRequests(await AgentFabricClient.open({configPath: d.configPath, statePath: d.statePath, store: d.store,
    ownerKey: 'relay:workspace-a', fetcher: async url => {
      await other?.send();
      return down && String(url).endsWith('/agent-fabric/workspaces')
        ? new Response(JSON.stringify({ok: false, error: {code: 'upstream_unavailable', message: 'Try again.'}}), {status: 503})
        : new Response(JSON.stringify({ok: true}), {status: 201});
    }}));
  // The sync's hold: signing control, then the refresh lock (here a plain in-process lock), around one call.
  const hold: (input: {config: DeviceConfig}, work: () => Promise<unknown>, options: {perSend: true}) => Promise<unknown>
    = withClientSigningControl;
  let lockHeld = false, lockTaken = 0;
  const policySync = (workspaceId: string) => hold({config: d.config}, async () => {
    assert.equal(lockHeld, false, 'the refresh lock is taken only inside signing control, once at a time');
    lockHeld = true;
    lockTaken += 1;
    try { return await fabric.registerWorkspace({workspaceId}); } finally { lockHeld = false; }
  }, {perSend: true});
  const waiter = waitingClient(d.config);
  other = waiter;
  const scenario = async (name: string, sends: number, work: () => Promise<unknown>) => {
    const from = waiter.behind.length;
    await work();
    await withDeviceSigningControl({config: d.config}, async () => undefined);
    const behind = waiter.behind.slice(from);
    assert.equal(behind.length, sends, `${name}: ${sends} sends`);
    assert.deepEqual(behind, behind.map(() => 0), `${name}: no send shares its hold with an earlier one`);
  };
  try {
    await fabric.openSession();
    // A kept call of this client: its earlier registerWorkspace got no answer. The sync's call is another call.
    down = true;
    await assert.rejects(fabric.registerWorkspace({workspaceId: 'a'}), error => error instanceof AgentFabricRequestError && error.status === 503);
    down = false;
    lockTaken = 0;
    await scenario('own recovery', 2, () => policySync('b'));
    assert.equal(lockTaken, 2, 'own recovery: the sync takes control and the refresh lock again for its own call');
    // A full file of kept requests that commands which exited just now left: one is sent to make room, then the
    // caller's call, and the loop sends one more after its call, in a section of its own.
    const dead = await exitedPid();
    await fs.writeFile(d.statePath, JSON.stringify({schema: 'dharma.protocol-state/v1', sessionId: null, nextSequence: 1, pending: null,
      outboxes: Object.fromEntries(Array.from({length: 256}, (_, index) => [`cli:${dead}:x:${index}`, orphan(d.config.deviceId, dead)]))}));
    lockTaken = 0;
    await scenario('full file', 3, () => policySync('c'));
    assert.equal(lockTaken, 2, 'full file: the sync takes control and the refresh lock again for its own call');
  } finally { await waiter.stop(); }
});

test('the workspace policy sync takes signing control so that its hold makes at most one network send', async () => {
  const text = await fs.readFile(new URL('../src/index.ts', import.meta.url), 'utf8');
  const order = text.slice(text.indexOf('async function withWorkspacePolicySyncOrder<T>('),
    text.indexOf('async function syncWorkspacePolicyHoldingRefreshLock('));
  assert.match(order, /withClientSigningControl\(\{ config: fabric\.config, hostScope: currentBootstrapHostScope\(\) \},\s*\(\) => withWorkspacePolicyRefreshLock\(workspaceId, operation\), \{ perSend: true \}\)/,
    'the sync holds control around one call per hold, and takes the refresh lock inside it again after a hand-back');
});
