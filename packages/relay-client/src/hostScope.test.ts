import assert from 'node:assert/strict';
import {mkdtemp, readFile, rm} from 'node:fs/promises';
import {readFileSync, readdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';
import test from 'node:test';
import {createServer} from 'node:http';
import {createHash, createPublicKey, verify} from 'node:crypto';
import {AgentFabricClient, loadOrCreateDeviceIdentity, saveDeviceConfig, saveDeviceEnrollmentAnchor,
  type DeviceConfig, type SecureSecretStore} from './index.js';

type Scope = {signal: AbortSignal; current(): Promise<boolean>};
type Open = Parameters<typeof AgentFabricClient.open>[0] & {hostScope: Scope};
const unavailable = {message: 'relay_host_scope_unavailable'};
async function fixture(t: {after(fn: () => Promise<void>): void}) {
  const root = await mkdtemp(resolve(tmpdir(), 'fabric-host-scope-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const values = new Map<string, string>(), storeCalls: string[] = [], requests: string[] = [];
  let onRead = () => {};
  const store: SecureSecretStore = {backend: 'linux-secret-service',
    async get(account) {storeCalls.push('get'); onRead(); return values.get(account) ?? null;},
    async put(account, value) {storeCalls.push('put'); values.set(account, value);},
    async delete(account) {storeCalls.push('delete'); values.delete(account);}};
  const identity = await loadOrCreateDeviceIdentity({hqUrl: 'https://hq.example', organizationId: 'org_demo', store});
  const config: DeviceConfig = {schema: 'dharma.device-config/v1', hqUrl: 'https://hq.example',
    organizationId: 'org_demo', deviceId: '11111111-1111-4111-8111-111111111111', deviceName: 'Synthetic',
    platform: 'linux', publicKeyEd25519: identity.publicKeyEd25519, serverPublicKeyEd25519: identity.publicKeyEd25519,
    relayUrl: 'wss://relay.example', enrolledAt: new Date().toISOString()};
  const configPath = resolve(root, 'device.json'), statePath = resolve(root, 'state.json');
  await saveDeviceConfig(configPath, config); await saveDeviceEnrollmentAnchor({config, store}); storeCalls.length = 0;
  const controller = new AbortController(); let allowed = true;
  const hostScope = {signal: controller.signal, current: async () => allowed};
  const fetcher: typeof fetch = async (url, options) => {
    requests.push(new URL(String(url)).pathname);
    return new Response(JSON.stringify({ok: true}), {status: 201});
  };
  const input: Open = {configPath, statePath, store, fetcher, hostScope};
  return {input, requests, storeCalls, controller, configPath, statePath, root, config,
    isAllowed() {return allowed;},
    dropIdentity() {values.delete(identity.account);},
    setAllowed(value: boolean) {allowed = value;}, setRead(fn: () => void) {onRead = fn;}};
}

test('scoped client refuses absent authority before protected-store access', async t => {
  const f = await fixture(t); f.setAllowed(false);
  await assert.rejects(AgentFabricClient.open(f.input), unavailable);
  assert.deepEqual(f.storeCalls, []); assert.deepEqual(f.requests, []);
});

test('scoped client refuses cancellation and private qualification exceptions', async t => {
  const f = await fixture(t); f.controller.abort('private-abort-canary');
  await assert.rejects(AgentFabricClient.open(f.input), unavailable);
  const input: Open = {...f.input, hostScope: {signal: new AbortController().signal,
    current: async () => {throw new Error('private-qualification-canary');}}};
  await assert.rejects(AgentFabricClient.open(input), unavailable);
  assert.deepEqual(f.storeCalls, []);
});

test('loss during a store read blocks subsequent identity reads and mutations', async t => {
  const f = await fixture(t); f.setRead(() => f.setAllowed(false));
  await assert.rejects(AgentFabricClient.open(f.input), unavailable);
  assert.deepEqual(f.storeCalls, ['get']); assert.deepEqual(f.requests, []);
});

test('withdrawn clients neither mutate protocol state nor regain authority for another turn', async t => {
  const f = await fixture(t); const client = await AgentFabricClient.open(f.input); await client.openSession();
  const before = await readFile(f.statePath, 'utf8'); const count = f.requests.length;
  f.setAllowed(false);
  await assert.rejects(client.registerWorkspace({workspaceId: 'synthetic'}), unavailable);
  f.setAllowed(true);
  await assert.rejects(client.registerWorkspace({workspaceId: 'synthetic'}), unavailable);
  assert.equal(await readFile(f.statePath, 'utf8'), before); assert.equal(f.requests.length, count);
});

test('cancelled response remains unacknowledged and preserves the pending request', async t => {
  const f = await fixture(t); let requestSignal: AbortSignal | null | undefined;
  f.input.fetcher = async (url, options) => {
    const path = new URL(String(url)).pathname; f.requests.push(path);
    if (path.endsWith('/workspaces')) {requestSignal = options?.signal; f.controller.abort();}
    return new Response(JSON.stringify({ok: true, private: 'private-response-canary'}), {status: 201});
  };
  const client = await AgentFabricClient.open(f.input); await client.openSession();
  await assert.rejects(client.registerWorkspace({workspaceId: 'synthetic'}), unavailable);
  assert.equal(requestSignal?.aborted, true);
  const persisted = await readFile(f.statePath, 'utf8');
  assert.match(JSON.parse(persisted).pending.pathname, /\/workspaces$/);
  assert.doesNotMatch(persisted, /private-response-canary/);
});

test('queued requests cannot dispatch after the active request loses authority', async t => {
  const f = await fixture(t);
  let release!: () => void, entered!: () => void;
  const blocked = new Promise<void>(done => {release = done;}), observed = new Promise<void>(done => {entered = done;});
  f.input.fetcher = async (url) => {
    const path = new URL(String(url)).pathname; f.requests.push(path);
    if (path.endsWith('/first')) {entered(); await blocked;}
    return new Response(JSON.stringify({ok: true}), {status: 201});
  };
  const client = await AgentFabricClient.open(f.input); await client.openSession();
  const first = client.signedPost('/agent-fabric/first', {});
  const second = client.signedPost('/agent-fabric/second', {});
  const settled = Promise.allSettled([first, second]);
  await observed; f.controller.abort(); release();
  const outcomes = await settled;
  assert.deepEqual(outcomes.map(result => result.status), ['rejected', 'rejected']);
  for (const result of outcomes) if (result.status === 'rejected') assert.equal(result.reason.message, unavailable.message);
  assert.equal(f.requests.filter(path => path.endsWith('/second')).length, 0);
});

test('scoped client refuses a changed enrolled identity before signing or dispatch', async t => {
  const f = await fixture(t); const client = await AgentFabricClient.open(f.input); await client.openSession();
  const before = await readFile(f.statePath, 'utf8'); const count = f.requests.length;
  client.config.organizationId = 'org_foreign';
  await assert.rejects(client.registerWorkspace({workspaceId: 'synthetic'}), unavailable);
  assert.equal(f.requests.length, count); assert.equal(await readFile(f.statePath, 'utf8'), before);
});

test('valid scoped client retains the ordinary signed protocol contract', async t => {
  const f = await fixture(t); let wire: RequestInit | undefined;
  f.input.fetcher = async (url, options) => {f.requests.push(new URL(String(url)).pathname); wire = options;
    return new Response(JSON.stringify({ok: true}), {status: 201});};
  const client = await AgentFabricClient.open(f.input); await client.openSession();
  assert.equal((await client.registerWorkspace({workspaceId: 'synthetic'})).ok, true);
  assert.equal(wire?.redirect, 'error'); assert.equal(wire?.signal?.aborted, false);
  const state = JSON.parse(await readFile(f.statePath, 'utf8'));
  assert.equal(state.pending, null); assert.equal(state.nextSequence, 3);
});

test('withdrawal during a temporary state write prevents publication and network admission', async t => {
  const f = await fixture(t);
  f.input.hostScope.current = async () => {
    for (const name of readdirSync(f.root).filter(name => name.endsWith('.tmp'))) {
      if (readFileSync(resolve(f.root, name), 'utf8').includes('during-scoped-persist')) f.setAllowed(false);
    }
    return f.isAllowed();
  };
  const client = await AgentFabricClient.open(f.input); await client.openSession();
  const before = await readFile(f.statePath, 'utf8'); const count = f.requests.length;
  await assert.rejects(client.signedPost('/agent-fabric/guard-state', {operation: 'during-scoped-persist'}), unavailable);
  assert.equal(await readFile(f.statePath, 'utf8'), before); assert.equal(f.requests.length, count);
  assert.equal(readdirSync(f.root).filter(name => name.endsWith('.tmp')).length, 0);
});

test('public device-config commit can carry the same current host authority', async t => {
  const f = await fixture(t); const before = await readFile(f.configPath, 'utf8'); f.setAllowed(false);
  const save = saveDeviceConfig as (path: string, config: DeviceConfig, scope?: Scope) => Promise<void>;
  await assert.rejects(save(f.configPath, {...f.config, deviceName: 'Unapproved'}, f.input.hostScope), unavailable);
  assert.equal(await readFile(f.configPath, 'utf8'), before);
});

test('a cancelled fetch error cannot disclose its private transport diagnostics', async t => {
  const f = await fixture(t);
  f.input.fetcher = async (url) => {
    if (new URL(String(url)).pathname.endsWith('/workspaces')) {
      f.controller.abort(); throw new Error('private-transport-canary');
    }
    return new Response(JSON.stringify({ok: true}), {status: 201});
  };
  const client = await AgentFabricClient.open(f.input); await client.openSession();
  await assert.rejects(client.registerWorkspace({workspaceId: 'synthetic'}), unavailable);
});

test('foreign direct responses are rejected before consuming their body', async t => {
  const f = await fixture(t); let parsed = 0;
  f.input.fetcher = async (url) => {
    const response = new Response(JSON.stringify({ok: true}), {status: 201});
    if (new URL(String(url)).pathname.endsWith('/workspaces')) {
      Object.defineProperty(response, 'redirected', {value: true});
      Object.defineProperty(response, 'json', {value: async () => {parsed++; throw new Error('private-foreign-body-canary');}});
    }
    return response;
  };
  const client = await AgentFabricClient.open(f.input); await client.openSession();
  await assert.rejects(client.registerWorkspace({workspaceId: 'synthetic'}), {message: 'relay_host_transport_response_invalid'});
  assert.equal(parsed, 0);
});

for (const phase of ['before_open', 'after_send'] as const) test(`WebSocket withdrawal ${phase} stops the owned connection`, async t => {
  const f = await fixture(t); delete f.input.fetcher;
  const original = Object.getOwnPropertyDescriptor(globalThis, 'WebSocket')!;
  let sent = 0, closed = 0;
  class Socket extends EventTarget {
    static CLOSING = 2; static CLOSED = 3;
    readyState = 0;
    constructor(_url: URL) {super(); queueMicrotask(() => {
      if (phase === 'before_open') f.setAllowed(false);
      this.readyState = 1; this.dispatchEvent(new Event('open'));
    });}
    send(frame: string) {
      sent++; f.controller.abort();
      const request = JSON.parse(frame);
      queueMicrotask(() => this.dispatchEvent(new MessageEvent('message', {data: JSON.stringify({
        requestId: request.requestId, status: 201, body: JSON.stringify({ok: true}),
      })})));
    }
    close() {closed++; this.readyState = Socket.CLOSED; this.dispatchEvent(new Event('close'));}
  }
  Object.defineProperty(globalThis, 'WebSocket', {...original, value: Socket});
  t.after(async () => {Object.defineProperty(globalThis, 'WebSocket', original);});
  const client = await AgentFabricClient.open(f.input);
  await assert.rejects(client.openSession(), unavailable);
  assert.equal(sent, phase === 'before_open' ? 0 : 1); assert.equal(closed, 1);
});

test('withdrawal while reading a direct response cancels its owned stream', async t => {
  const f = await fixture(t); let cancelled = false, pulled = 0, closing = false;
  let fallback: NodeJS.Timeout | undefined;
  t.after(async () => {if (fallback) clearTimeout(fallback);});
  f.input.fetcher = async (url) => {
    if (!new URL(String(url)).pathname.endsWith('/workspaces')) return new Response(JSON.stringify({ok: true}), {status: 201});
    const stream = new ReadableStream<Uint8Array>({pull(controller) {
      if (++pulled === 1) controller.enqueue(Buffer.from('{"ok":'));
      else if (!closing) {closing = true; fallback = setTimeout(() => {
        if (!cancelled) {controller.enqueue(Buffer.from('true}')); controller.close();}
      }, 25); f.controller.abort();}
    }, cancel() {cancelled = true; if (fallback) clearTimeout(fallback);}});
    return new Response(stream, {status: 201});
  };
  const client = await AgentFabricClient.open(f.input); await client.openSession();
  await assert.rejects(client.registerWorkspace({workspaceId: 'synthetic'}), unavailable);
  assert.equal(cancelled, true);
});

test('oversized scoped direct responses are rejected before parsing', async t => {
  const f = await fixture(t); let parsed = 0;
  f.input.fetcher = async (url) => {
    const response = new Response(JSON.stringify({ok: true}), {status: 201,
      headers: new URL(String(url)).pathname.endsWith('/workspaces') ? {'content-length': '5000001'} : {}});
    if (new URL(String(url)).pathname.endsWith('/workspaces')) Object.defineProperty(response, 'json', {
      value: async () => {parsed++; return {ok: true};}});
    return response;
  };
  const client = await AgentFabricClient.open(f.input); await client.openSession();
  await assert.rejects(client.registerWorkspace({workspaceId: 'synthetic'}), {message: 'relay_host_transport_response_invalid'});
  assert.equal(parsed, 0);
});

test('post-enrollment scoped opening never generates a replacement for a missing accepted key', async t => {
  const f = await fixture(t); f.dropIdentity();
  await assert.rejects(AgentFabricClient.open(f.input), {message: 'relay_host_device_identity_unavailable'});
  assert.equal(f.storeCalls.includes('put'), false); assert.deepEqual(f.requests, []);
});

test('real HTTP delivery with withdrawn authority stays pending rather than inventing an acknowledgement', async t => {
  const f = await fixture(t); const deliveries: Array<{path: string; signatureVerified: boolean}> = [];
  let publicKey: ReturnType<typeof createPublicKey>;
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const text = Buffer.concat(chunks).toString('utf8');
    const payload = Buffer.from(JSON.stringify({bodyHash: `sha256:${createHash('sha256').update(text).digest('hex')}`,
      deviceId: request.headers['x-dharma-device-id'], messageId: request.headers['x-dharma-message-id'],
      method: request.method, nonce: request.headers['x-dharma-nonce'], organizationId: 'org_demo', pathname: request.url,
      sequence: Number(request.headers['x-dharma-sequence']), sessionId: request.headers['x-dharma-session-id'],
      timestamp: request.headers['x-dharma-timestamp']}));
    const checked = verify(null, payload, publicKey, Buffer.from(String(request.headers['x-dharma-signature']), 'base64url'));
    deliveries.push({path: request.url!, signatureVerified: checked});
    if (request.url!.endsWith('/workspaces')) f.setAllowed(false);
    response.writeHead(201, {'content-type': 'application/json'}); response.end(JSON.stringify({ok: true}));
  });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  t.after(() => new Promise<void>((done, reject) => {
    server.close(error => error ? reject(error) : done()); server.closeAllConnections();
  }));
  const address = server.address(); assert.ok(address && typeof address === 'object');
  const origin = `http://127.0.0.1:${address.port}`;
  const identity = await loadOrCreateDeviceIdentity({hqUrl: origin, organizationId: 'org_demo', store: f.input.store});
  publicKey = createPublicKey({key: {kty: 'OKP', crv: 'Ed25519', x: identity.publicKeyEd25519}, format: 'jwk'});
  const config = {...f.config, hqUrl: origin, publicKeyEd25519: identity.publicKeyEd25519,
    serverPublicKeyEd25519: identity.publicKeyEd25519};
  await saveDeviceConfig(f.configPath, config); await saveDeviceEnrollmentAnchor({config, store: f.input.store});
  const client = await AgentFabricClient.open({...f.input, fetcher: fetch}); await client.openSession();
  await assert.rejects(client.registerWorkspace({workspaceId: 'synthetic'}), unavailable);
  assert.equal(deliveries.length, 2); assert.equal(deliveries.every(value => value.signatureVerified), true);
  assert.match(JSON.parse(await readFile(f.statePath, 'utf8')).pending.pathname, /\/workspaces$/);
  await assert.rejects(client.registerWorkspace({workspaceId: 'not-dispatched'}), unavailable);
  assert.equal(deliveries.length, 2);
});
