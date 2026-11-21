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
import * as cli from './index.js';
import {createProviderSessionChannel} from './providerSessionChannel.js';
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

// Owner review: the total send count per hold of signing control is at most 1, including recovery and capacity
// pressure, on every path. These are the holds a caller takes itself around one signed call. The workspace policy sync
// takes its hold perSend, so its work runs again in a fresh hold for its own call. A hold taken without perSend keeps
// its work in that one hold, so the client adds no send of its own to it: after it sends its own earlier kept call, the
// caller's call fails with relay_retry_after_recovery and is sent on retry, in a hold of its own; in a full file it
// sends no orphan to make room, and the full file refuses the caller's call, as before. The CLI takes no such hold
// around a protocol-state request: the named session activation boundary takes none (see the tests below), and the
// device signing maintenance hold sends only its own maintenance requests, never a protocol-state request.
const callerHolds: ReadonlyArray<{site: string; perSend: boolean;
  hold: (config: DeviceConfig, work: () => Promise<unknown>) => Promise<unknown>}> = [
  {site: 'workspace policy sync (withClientSigningControl, perSend)', perSend: true,
    hold: (config, work) => withClientSigningControl({config}, work, {perSend: true})},
  {site: 'a hold taken with withClientSigningControl without perSend', perSend: false,
    hold: (config, work) => withClientSigningControl({config}, work)},
  {site: 'a hold taken with withDeviceSigningControl', perSend: false,
    hold: (config, work) => withDeviceSigningControl({config}, work)},
];

for (const {site, perSend, hold} of callerHolds) {
  test(`a caller-held hold around one signed call makes at most one network send while another client waits, own recovery and a full file: ${site}`, async t => {
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
    const inHold = async (name: string, workspaceId: string) => {
      const from = waiter.behind.length;
      const outcome = await hold(d.config, () => fabric.registerWorkspace({workspaceId}))
        .then(() => 'answered', (error: unknown) => error instanceof Error ? error.message : String(error));
      await withDeviceSigningControl({config: d.config}, async () => undefined);
      const behind = waiter.behind.slice(from);
      assert.deepEqual(behind, behind.map(() => 0), `${name}: no send shares its hold with an earlier one`);
      return {outcome, sends: behind.length};
    };
    try {
      await fabric.openSession();
      // A kept call of this client: its earlier registerWorkspace got no answer. The caller's call is another call.
      down = true;
      await assert.rejects(fabric.registerWorkspace({workspaceId: 'a'}), error => error instanceof AgentFabricRequestError && error.status === 503);
      down = false;
      if (perSend) assert.deepEqual(await inHold('own recovery', 'b'), {outcome: 'answered', sends: 2});
      else {
        assert.deepEqual(await inHold('own recovery', 'b'), {outcome: 'relay_retry_after_recovery', sends: 1},
          'own recovery: only the kept call is sent in the caller\'s hold');
        assert.deepEqual(await inHold('retry after recovery', 'b'), {outcome: 'answered', sends: 1});
      }
      // A full file of kept requests that commands which exited just now left, one of them due.
      const dead = await exitedPid();
      await fs.writeFile(d.statePath, JSON.stringify({schema: 'dharma.protocol-state/v1', sessionId: null, nextSequence: 1, pending: null,
        outboxes: Object.fromEntries(Array.from({length: 256}, (_, index) => [`cli:${dead}:x:${index}`, orphan(d.config.deviceId, dead)]))}));
      // perSend: an orphan makes room in a hold of its own, then the caller's call, then the loop sends one more after
      // its call, in a section of its own. Otherwise no orphan is sent in the caller's hold and the full file refuses.
      assert.deepEqual(await inHold('full file', 'c'), perSend ? {outcome: 'answered', sends: 3}
        : {outcome: 'relay_protocol_state_outbox_full', sends: 0});
    } finally { await waiter.stop(); }
  });
}

test('every hold of signing control the CLI takes itself is one the caller-held hold test covers', async () => {
  const dir = new URL('../src/', import.meta.url);
  const sites: string[] = [];
  for (const name of (await fs.readdir(dir)).filter(item => item.endsWith('.ts') && !item.endsWith('.test.ts')).sort()) {
    const text = await fs.readFile(new URL(name, dir), 'utf8');
    for (const match of text.matchAll(/\bwith(Client|Device)SigningControl\(/g)) {
      const call = text.slice(match.index, text.indexOf('\n\n', match.index));
      sites.push(`${name} ${match[0].slice(0, -1)}${/\{ ?perSend: true ?\}/.test(call.slice(0, 400)) ? ' perSend' : ''}`);
    }
  }
  // The device signing maintenance hold sends only its own maintenance requests; the only CLI hold around a
  // protocol-state request is the workspace policy sync, perSend. The named session activation boundary takes none.
  assert.deepEqual(sites, [
    'deviceSigningMaintenanceController.ts withDeviceSigningControl',
    'index.ts withClientSigningControl perSend',
  ],'a new hold of signing control needs a decision: perSend, or covered by the client\'s rule for a caller\'s own hold');
});

// Owner review: the total send count per hold of signing control is at most 1, including recovery and capacity
// pressure, on every path. A named session's work turn, readiness check and inbox poll run in its activation boundary
// and make several signed calls there. The boundary takes only the workspace skill activation lock, never a hold of
// signing control, so each signed call in it takes a hold of its own: the policy sync perSend, every other call through
// the admission line. A kept call or a full file is then sent in a hold of its own, and no call fails because of it.
type ActivationBoundary = <T>(workspaceId: string, operation: () => Promise<T>) => Promise<T>;
function activationBoundary(): ActivationBoundary {
  const value = (cli as unknown as Record<string, unknown>).withNamedSessionActivationBoundary;
  assert.equal(typeof value, 'function', 'the named session activation boundary is the exported withNamedSessionActivationBoundary');
  return value as ActivationBoundary;
}

async function namedSessionHome(t: {after(fn: () => Promise<void>): void}) {
  const home = await fs.mkdtemp(resolve(tmpdir(), 'dharma-admission-named-home-'));
  const previous = process.env.DHARMA_HOME;
  process.env.DHARMA_HOME = home;
  t.after(async () => {
    if (previous === undefined) delete process.env.DHARMA_HOME; else process.env.DHARMA_HOME = previous;
    await fs.rm(home, {recursive: true, force: true});
  });
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {status});

/** Records the hold of signing control each network send runs in: the fetcher runs inside that hold, so a nested
 * withDeviceSigningControl reuses it and returns its lease. */
function holdsOfSends(config: DeviceConfig) {
  const holds: string[] = [];
  return {holds, async record() {holds.push(await withDeviceSigningControl({config}, async lease => lease.controllerInstanceId));}};
}

test('the named session activation boundary is withNamedSessionActivationBoundary, which takes no hold of signing control', async () => {
  const text = await fs.readFile(new URL('../src/index.ts', import.meta.url), 'utf8');
  assert.match(text, /withActivationBoundary: \(operation, work\) => withNamedSessionActivationBoundary\(workspaceId, async \(\) => \{/,
    'the named session service runs its turns in the exported boundary');
  const start = text.indexOf('export function withNamedSessionActivationBoundary<T>(');
  assert.ok(start >= 0, 'the boundary is exported from index.ts');
  const rest = text.slice(start), end = rest.search(/\r?\n\}\r?\n/);
  assert.ok(end > 0, 'the boundary function ends');
  const boundary = rest.slice(0, end);
  assert.doesNotMatch(boundary, /SigningControl/, 'the boundary takes no hold of signing control');
  assert.match(boundary, /withWorkspaceSkillActivationLock\(workspaceId, 'codex', operation\)/);
});

test('a named session work turn in its activation boundary makes at most one network send per hold while another client waits: own recovery and a full file', async t => {
  const boundary = activationBoundary();
  const d = await device(t);
  await namedSessionHome(t);
  let down = false;
  let other: ReturnType<typeof waitingClient> | undefined;
  const sends = holdsOfSends(d.config);
  const fabric = admitSignedRequests(await AgentFabricClient.open({configPath: d.configPath, statePath: d.statePath, store: d.store,
    ownerKey: 'relay:workspace-a', fetcher: async url => {
      await sends.record();
      await other?.send();
      return down && String(url).endsWith('/agent-fabric/workspaces')
        ? json({ok: false, error: {code: 'upstream_unavailable', message: 'Try again.'}}, 503) : json({ok: true}, 201);
    }}));
  const workspaceId = randomUUID();
  // The shape of a repository-bound work turn: the lifetime check, the authority the repository context loads (the
  // policy sync in its own perSend hold, then the source policy), the work authorization, then a channel call.
  const workTurn = () => boundary(workspaceId, async () => {
    await fabric.signedPost('/agent-fabric/provider-sessions', {action: 'inspect'});
    await withClientSigningControl({config: d.config}, () => fabric.registerWorkspace({workspaceId}), {perSend: true});
    await fabric.signedGet('/agent-fabric/repository-source-authorization');
    await fabric.registerWorkspace({workspaceId});
    await fabric.signedPost('/agent-fabric/provider-session-questions', {action: 'reply'});
    return 'answered';
  });
  const waiter = waitingClient(d.config);
  other = waiter;
  // Every send runs in a hold of its own. Where only the turn's calls run, the waiting client also gets the control
  // between any two of them; in a full file the client's own orphan sends after its calls may come first in line.
  const turn = async (name: string, order = true) => {
    const from = waiter.behind.length, first = sends.holds.length;
    const outcome = await workTurn().catch((error: unknown) => error instanceof Error ? error.message : String(error));
    await withDeviceSigningControl({config: d.config}, async () => undefined);
    const behind = waiter.behind.slice(from), holds = sends.holds.slice(first);
    assert.equal(new Set(holds).size, holds.length, `${name}: every send runs in a hold of its own`);
    if (order) assert.deepEqual(behind, behind.map(() => 0), `${name}: the waiting client gets the control between sends`);
    return {outcome, sends: behind.length};
  };
  try {
    await fabric.openSession();
    // A kept call of this client: an earlier work authorization got no answer.
    down = true;
    await assert.rejects(fabric.registerWorkspace({workspaceId}), error => error instanceof AgentFabricRequestError && error.status === 503);
    down = false;
    assert.deepEqual(await turn('own recovery'), {outcome: 'answered', sends: 6}, 'own recovery: the kept call, then the five calls');
    assert.deepEqual(await turn('next turn'), {outcome: 'answered', sends: 5});
    // A full file of kept requests that commands which exited just now left, one of them due.
    const dead = await exitedPid();
    await fs.writeFile(d.statePath, JSON.stringify({schema: 'dharma.protocol-state/v1', sessionId: null, nextSequence: 1, pending: null,
      outboxes: Object.fromEntries(Array.from({length: 256}, (_, index) => [`cli:${dead}:x:${index}`, orphan(d.config.deviceId, dead)]))}));
    const full = await turn('full file', false);
    assert.equal(full.outcome, 'answered', 'full file: an orphan makes room in a hold of its own and every call is answered');
    assert.ok(full.sends >= 6, 'full file: the orphan sent to make room, then the five calls');
  } finally { await waiter.stop(); }
});

test('a kept call does not stop a named session: its inbox poll in the activation boundary is answered, in a hold of its own, and so is the next one', async t => {
  const boundary = activationBoundary();
  const d = await device(t);
  await namedSessionHome(t);
  let down = false;
  let other: ReturnType<typeof waitingClient> | undefined;
  const scope = {organizationId: d.config.organizationId, repositoryBindingId: randomUUID(), workspaceId: randomUUID(),
    endpointId: randomUUID(), membershipId: randomUUID(), deviceId: d.config.deviceId, bindingId: randomUUID(),
    provider: 'codex' as const, expiresAt: new Date(Date.now() + 3_600_000).toISOString(), maximumProviderCostCents: 0};
  const {expiresAt: _expiresAt, maximumProviderCostCents: _cost, organizationId: _organizationId, ...registered} = scope;
  const sends = holdsOfSends(d.config);
  const fabric = admitSignedRequests(await AgentFabricClient.open({configPath: d.configPath, statePath: d.statePath, store: d.store,
    ownerKey: 'relay:workspace-a', fetcher: async url => {
      await sends.record();
      await other?.send();
      const path = String(url);
      if (path.endsWith('/agent-fabric/workspaces')) {
        return down ? json({ok: false, error: {code: 'upstream_unavailable', message: 'Try again.'}}, 503) : json({ok: true}, 201);
      }
      if (path.endsWith('/agent-fabric/provider-sessions')) {
        return json({ok: true, organizationId: scope.organizationId, correlationId: randomUUID(), registration: {...registered,
          mode: 'bridge_owned', revision: 1, state: 'attached', leaseUntil: new Date(Date.now() + 60_000).toISOString(), replay: false}});
      }
      if (path.endsWith('/agent-fabric/provider-session-questions')) {
        return json({ok: true, organizationId: scope.organizationId, correlationId: randomUUID(), result: {offers: []}});
      }
      return json({ok: true}, 201);
    }}));
  const channel = createProviderSessionChannel({transport: fabric, scope, mode: 'bridge_owned', expectedRevision: 0,
    assertOwner: async () => true, verifier: {resolvePublicKey: () => null}, authorizeContent: async () => true});
  const waiter = waitingClient(d.config);
  other = waiter;
  const poll = async (name: string) => {
    const from = waiter.behind.length, first = sends.holds.length;
    const outcome = await boundary(scope.workspaceId, () => channel.inbox())
      .then(offers => offers.length === 0 ? 'answered' : 'offers', (error: unknown) => error instanceof Error ? error.message : String(error));
    await withDeviceSigningControl({config: d.config}, async () => undefined);
    const behind = waiter.behind.slice(from), holds = sends.holds.slice(first);
    assert.equal(new Set(holds).size, holds.length, `${name}: every send runs in a hold of its own`);
    assert.deepEqual(behind, behind.map(() => 0), `${name}: the waiting client gets the control between sends`);
    return {outcome, sends: behind.length};
  };
  try {
    await fabric.openSession();
    await channel.attach();
    // A kept call of this client: a work authorization outside the boundary got no answer, and that work failed.
    down = true;
    await assert.rejects(fabric.registerWorkspace({workspaceId: scope.workspaceId}),
      error => error instanceof AgentFabricRequestError && error.status === 503);
    down = false;
    assert.deepEqual(await poll('inbox after a kept call'), {outcome: 'answered', sends: 2},
      'the kept call is sent in a hold of its own, then the inbox poll in another');
    assert.deepEqual(await poll('next inbox'), {outcome: 'answered', sends: 1}, 'the channel stays open for the next iteration');
    // A full file of kept requests that commands which exited just now left, one of them due.
    const dead = await exitedPid();
    await fs.writeFile(d.statePath, JSON.stringify({schema: 'dharma.protocol-state/v1', sessionId: null, nextSequence: 1, pending: null,
      outboxes: Object.fromEntries(Array.from({length: 256}, (_, index) => [`cli:${dead}:x:${index}`, orphan(d.config.deviceId, dead)]))}));
    assert.equal((await poll('inbox in a full file')).outcome, 'answered');
    assert.equal((await poll('next inbox after a full file')).outcome, 'answered');
  } finally { await waiter.stop(); }
});
