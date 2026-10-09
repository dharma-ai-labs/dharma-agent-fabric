import assert from 'node:assert/strict';
import {mkdtemp, readFile, readdir, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import test, {type TestContext} from 'node:test';
import {AgentFabricClient, loadDeviceConfig, loadOrCreateDeviceIdentity, saveDeviceConfig, saveDeviceConnectionPreference, saveDeviceEnrollmentAnchor,
  type DeviceConfig, type SecureSecretStore} from '@dharma-ai-labs/agent-fabric-relay-client';
import {automaticBootstrapResume, connectionPreference, readExistingDeviceConfig, resumeDeviceConnection} from './deviceConnection.js';

function admission(config: DeviceConfig) {
  return {ok: true, organizationId: config.organizationId, relayUrl: config.relayUrl,
    serverPublicKeyEd25519: config.serverPublicKeyEd25519, deviceAuthority: {schema: 'dharma.device-admission/v1',
      deviceId: config.deviceId, ownerMembershipId: '44444444-4444-4444-8444-444444444444', deviceStatus: 'active', memberStatus: 'active'}};
}

async function fixture(t: TestContext) {
  const home = await mkdtemp(join(tmpdir(), 'fabric-connection-matrix-'));
  t.after(() => rm(home, {recursive: true, force: true}));
  const values = new Map<string, string>();
  const writes: string[] = [], requests: Array<{path: string; headers: Headers; body: string}> = [];
  const store: SecureSecretStore = {backend: 'windows-credential-manager',
    get: async account => values.get(account) ?? null,
    put: async (account, value) => {writes.push(account); values.set(account, value);},
    delete: async account => {writes.push(account); values.delete(account);}};
  const installationId = '11111111-1111-4111-8111-111111111111';
  const identity = await loadOrCreateDeviceIdentity({hqUrl: 'https://hq.example', organizationId: 'org_fixture', installationId, store});
  const config: DeviceConfig = {schema: 'dharma.device-config/v1', hqUrl: 'https://hq.example', organizationId: 'org_fixture',
    deviceId: '22222222-2222-4222-8222-222222222222', installationId, deviceName: 'Synthetic', platform: 'windows',
    publicKeyEd25519: identity.publicKeyEd25519, serverPublicKeyEd25519: identity.publicKeyEd25519,
    relayUrl: 'wss://relay.example', enrolledAt: '2026-10-01T00:00:00.000Z', connectionMode: 'resume'};
  const configPath = join(home, 'device.json'), statePath = join(home, 'state.json'), installationPath = join(home, 'installation.json');
  await saveDeviceConfig(configPath, config);
  await saveDeviceEnrollmentAnchor({config, store});
  await writeFile(installationPath, JSON.stringify({schema: 'dharma.installation-identity/v1', installationId}));
  const state = JSON.stringify({schema: 'dharma.protocol-state/v1', sessionId: 'old', nextSequence: 7,
    pending: {method: 'POST', pathname: '/api/v1/orgs/org_fixture/agent-fabric/tasks/poll', body: '{}', headers: {}}});
  await writeFile(statePath, state);
  writes.length = 0;
  const fetcher = async (url: string | URL | Request, init?: RequestInit) => {
    requests.push({path: new URL(String(url)).pathname, headers: new Headers(init?.headers), body: String(init?.body)});
    return new Response(JSON.stringify(admission(config)), {status: 201});
  };
  const input = {config, configPath, statePath, installationPath, version: '0.1.177',
    openClient: () => AgentFabricClient.open({configPath, statePath, store, fetcher, readOnly: true})};
  return {home, values, writes, requests, store, config, configPath, statePath, installationPath, identity, state, fetcher, input};
}

test('restart, outage recovery, upgrade and concurrent probes reuse the original accepted identity', async t => {
  const f = await fixture(t), bytes = await readFile(f.configPath, 'utf8');
  const before = new Map(f.values);
  const first = await resumeDeviceConnection(f.input);
  const restarted = await resumeDeviceConnection({...f.input, version: '0.1.178'});
  const concurrent = await Promise.all(Array.from({length: 8}, () => resumeDeviceConnection(f.input)));
  for (const result of [first, restarted, ...concurrent]) {
    assert.equal(result.deviceId, f.config.deviceId);
    assert.equal(result.installationId, f.config.installationId);
    assert.equal(result.providerAuthentication, 'not_checked');
  }
  assert.equal(restarted.relayVersion, '0.1.178');
  assert.equal(f.requests.length, 10);
  for (const request of f.requests) {
    assert.ok(request.path.endsWith('/agent-fabric/sessions'));
    assert.equal(request.headers.get('x-dharma-device-id'), f.config.deviceId);
    assert.equal(JSON.parse(request.body).relayVersion.startsWith('0.1.'), true);
  }
  assert.equal(new Set(f.requests.map(request => request.headers.get('x-dharma-session-id'))).size, 10);
  assert.deepEqual(f.writes, []);
  assert.deepEqual(f.values, before);
  assert.equal(await readFile(f.configPath, 'utf8'), bytes);
  assert.equal(await readFile(f.statePath, 'utf8'), f.state, 'No sibling outbox replay or protocol write');
});

for (const state of ['missing', 'corrupt', 'locked'] as const) test(`${state} protected identity fails without enrollment or key writes`, async t => {
  const f = await fixture(t);
  const store: SecureSecretStore = {...f.store, get: state === 'locked'
    ? async () => {throw Error('private-credential-detail');}
    : async account => account === f.identity.account ? state === 'missing' ? null : '{broken' : f.store.get(account)};
  await assert.rejects(resumeDeviceConnection({...f.input,
    openClient: () => AgentFabricClient.open({configPath: f.configPath, statePath: f.statePath, store, fetcher: f.fetcher, readOnly: true})}),
    state === 'locked' ? /connection_identity_store_unavailable/ : /connection_identity_requires_recovery/);
  assert.deepEqual(f.writes, []);
  assert.deepEqual(f.requests, []);
  assert.equal(await readFile(f.statePath, 'utf8'), f.state);
});

for (const status of [401, 403, 409]) test(`current server authority rejection ${status} fails closed`, async t => {
  const f = await fixture(t);
  const rejected = async () => new Response(JSON.stringify({ok: false, error: {message: 'private-server-detail'}}), {status});
  await assert.rejects(resumeDeviceConnection({...f.input,
    openClient: () => AgentFabricClient.open({configPath: f.configPath, statePath: f.statePath, store: f.store, fetcher: rejected, readOnly: true})}),
    /connection_authority_rejected/);
  assert.deepEqual(f.writes, []);
  assert.equal(await readFile(f.statePath, 'utf8'), f.state);
});

test('temporary network failure preserves identity and the same invocation succeeds after connectivity returns', async t => {
  const f = await fixture(t), before = new Map(f.values);
  await assert.rejects(resumeDeviceConnection({...f.input,
    openClient: () => AgentFabricClient.open({configPath: f.configPath, statePath: f.statePath, store: f.store,
      fetcher: async () => {throw Error('fetch failed: private endpoint detail');}, readOnly: true})}), /connection_transport_unavailable/);
  const result = await resumeDeviceConnection(f.input);
  assert.equal(result.deviceId, f.config.deviceId);
  assert.deepEqual(f.values, before);
  assert.deepEqual(f.writes, []);
});

test('mismatched installation and changed enrollment during probe cannot report resumed', async t => {
  const f = await fixture(t);
  await writeFile(f.installationPath, JSON.stringify({schema: 'dharma.installation-identity/v1', installationId: '33333333-3333-4333-8333-333333333333'}));
  await assert.rejects(resumeDeviceConnection(f.input), /connection_installation_mismatch/);
  assert.deepEqual(f.requests, []);
  await writeFile(f.installationPath, JSON.stringify({schema: 'dharma.installation-identity/v1', installationId: f.config.installationId}));
  await assert.rejects(resumeDeviceConnection({...f.input, openClient: async () => ({config: f.config,
    openSession: async () => {await writeFile(f.configPath, JSON.stringify({...f.config, deviceId: 'changed'})); return admission(f.config);}})}), /connection_state_changed/);
  assert.deepEqual(f.writes, []);
});

test('expired or malformed cached signing trust cannot reconnect or refresh itself', async t => {
  const f = await fixture(t);
  const config = {...f.config, serverSigningKeyset: {schema: 'dharma.server-signing-keyset/v1',
    organizationId: f.config.organizationId, generation: 1, keys: [], signedByKeyVersion: 'old',
    issuedAt: '2026-10-01T00:00:00.000Z', expiresAt: '2026-10-02T00:00:00.000Z', signature: 'old'}} as DeviceConfig;
  await assert.rejects(resumeDeviceConnection({...f.input, config}), /connection_trust_requires_recovery/);
  assert.deepEqual(f.requests, []);
  assert.deepEqual(f.writes, []);
});

test('only ENOENT means absent; empty, invalid-schema, invalid preference and malformed config remain failures', async t => {
  const f = await fixture(t);
  assert.equal(await readExistingDeviceConfig(join(f.home, 'absent.json')), null);
  for (const [bytes, code] of [['', 'corrupt'], ['{broken', 'corrupt'], ['{}', 'invalid'],
    [JSON.stringify({...f.config, connectionMode: 'forever'}), 'invalid']] as const) {
    await writeFile(f.configPath, bytes);
    await assert.rejects(readExistingDeviceConfig(f.configPath), new RegExp(`connection_config_${code}`));
    assert.equal(await readFile(f.configPath, 'utf8'), bytes);
  }
});

test('unattended is explicit opt-in, absent preference is manual, and new bootstrap scope requires approval', async t => {
  const f = await fixture(t);
  assert.equal(connectionPreference(new Map()), undefined);
  assert.equal(connectionPreference(new Map([['unattended', true]])), 'resume');
  assert.equal(connectionPreference(new Map([['no-unattended', true]])), 'manual');
  assert.throws(() => connectionPreference(new Map([['unattended', 'true']])), /connection_options_invalid/);
  assert.throws(() => connectionPreference(new Map([['unattended', true], ['no-unattended', true]])), /connection_options_invalid/);
  assert.equal(automaticBootstrapResume(new Map([['complete', true]]), f.config), true);
  assert.equal(automaticBootstrapResume(new Map([['complete', true]]), {...f.config, connectionMode: undefined}), false);
  assert.equal(automaticBootstrapResume(new Map<string, string | boolean>([['setup-reference', 'reference'], ['complete', true]]), f.config), false);
  assert.throws(() => automaticBootstrapResume(new Map<string, string | boolean>([['complete', true], ['join-repository-binding-id', 'new']]), f.config), /connection_new_scope_requires_approval/);
});

test('actual default factory cannot accept a saved relay acknowledgement when protected HQ rejects authority', async t => {
  const f = await fixture(t);
  const config = {...f.config, relayUrl: 'wss://untrusted-relay.example'};
  await saveDeviceConfig(f.configPath, config);
  const relayCalls: string[] = [], hqCalls: Array<{url: string; redirect: RequestInit['redirect']; signal: AbortSignal | null | undefined}> = [];
  const originalOpen = AgentFabricClient.open, originalFetch = globalThis.fetch, OriginalWebSocket = globalThis.WebSocket;
  class UntrustedRelay {
    static CLOSING = 2;
    readyState = 1;
    message?: (event: {data: string}) => void;
    constructor(url: string | URL) {relayCalls.push(String(url));}
    addEventListener(type: string, callback: (event: {data: string}) => void) {
      if (type === 'open') queueMicrotask(() => callback({data: ''}));
      if (type === 'message') this.message = callback;
    }
    send(bytes: string) {
      const request = JSON.parse(bytes) as {requestId: string};
      this.message!({data: JSON.stringify({requestId: request.requestId, status: 201, body: JSON.stringify({ok: true})})});
    }
    close() {this.readyState = 3;}
  }
  AgentFabricClient.open = input => originalOpen({...input, store: f.store});
  globalThis.WebSocket = UntrustedRelay as unknown as typeof WebSocket;
  globalThis.fetch = async (url, init) => {
    hqCalls.push({url: String(url), redirect: init?.redirect, signal: init?.signal});
    return new Response(JSON.stringify({ok: false}), {status: 403});
  };
  try {
    await assert.rejects(resumeDeviceConnection({...f.input, config, openClient: undefined}), /connection_authority_rejected/);
    assert.equal(relayCalls.length, 0);
    assert.equal(hqCalls.length, 1);
    assert.equal(new URL(hqCalls[0]!.url).origin, f.config.hqUrl);
    assert.equal(hqCalls[0]!.redirect, 'error');
    assert.ok(hqCalls[0]!.signal instanceof AbortSignal);
    assert.deepEqual(f.writes, []);
    assert.equal(await readFile(f.statePath, 'utf8'), f.state);
    globalThis.fetch = async () => new Response(JSON.stringify(admission(f.config)), {status: 201});
    await assert.rejects(resumeDeviceConnection({...f.input, config, openClient: undefined}), /connection_authority_unconfirmed/,
      'Protected HQ must approve the same saved relay endpoint');
    await saveDeviceConfig(f.configPath, f.config);
    const admitted = await resumeDeviceConnection({...f.input, openClient: undefined});
    assert.equal(admitted.deviceId, f.config.deviceId);
    assert.equal(admitted.admissionTransport, 'anchored_hq_https');
    assert.equal(admitted.relayTransport, 'not_checked');
    assert.equal(relayCalls.length, 0);
    assert.deepEqual(f.writes, []);
  } finally {AgentFabricClient.open = originalOpen;globalThis.fetch = originalFetch;globalThis.WebSocket = OriginalWebSocket;}
});

test('default read-only factory accepts a validated legacy anchor without migration writes', async t => {
  const f = await fixture(t);
  const anchorEntry = [...f.values].find(([account]) => account.startsWith('device-enrollment-'))!;
  f.values.delete(anchorEntry[0]);
  const legacy = `device-enrollment-${createHash('sha256').update(`${f.config.hqUrl}:${f.config.organizationId}`).digest('hex').slice(0, 32)}`;
  f.values.set(legacy, anchorEntry[1]);
  const before = new Map(f.values), originalOpen = AgentFabricClient.open, originalFetch = globalThis.fetch;
  AgentFabricClient.open = input => originalOpen({...input, store: f.store});
  globalThis.fetch = f.fetcher;
  try {
    assert.equal((await resumeDeviceConnection({...f.input, openClient: undefined})).deviceId, f.config.deviceId);
    assert.deepEqual(f.values, before);
    assert.deepEqual(f.writes, []);
    assert.equal(await readFile(f.statePath, 'utf8'), f.state);
  } finally {AgentFabricClient.open = originalOpen; globalThis.fetch = originalFetch;}
});

test('an unguarded old session acknowledgement cannot establish current member authority', async t => {
  const f = await fixture(t);
  const before = await readFile(f.configPath, 'utf8');
  await assert.rejects(resumeDeviceConnection({...f.input, openClient: async () => ({config: f.config,
    openSession: async () => ({ok: true, organizationId: f.config.organizationId, relayUrl: f.config.relayUrl,
      serverPublicKeyEd25519: f.config.serverPublicKeyEd25519})})}), /connection_authority_unconfirmed/);
  assert.equal(await readFile(f.configPath, 'utf8'), before);
  assert.equal(await readFile(f.statePath, 'utf8'), f.state);
  assert.deepEqual(f.writes, []);
});

test('member, device, organization and endpoint substitutions cannot report resumed', async t => {
  const f = await fixture(t), accepted = admission(f.config);
  for (const response of [
    {...accepted, organizationId: 'org_other'}, {...accepted, relayUrl: 'wss://other-relay.example'},
    {...accepted, serverPublicKeyEd25519: 'Z'.repeat(43)},
    {...accepted, deviceAuthority: {...accepted.deviceAuthority, deviceId: '33333333-3333-4333-8333-333333333333'}},
    {...accepted, deviceAuthority: {...accepted.deviceAuthority, memberStatus: 'revoked'}},
    {...accepted, deviceAuthority: {...accepted.deviceAuthority, ownerMembershipId: null}},
    {...accepted, deviceAuthority: {...accepted.deviceAuthority, deviceStatus: 'revoked'}},
  ]) await assert.rejects(resumeDeviceConnection({...f.input,
    openClient: async () => ({config: f.config, openSession: async () => response})}), /connection_authority_unconfirmed/);
  assert.deepEqual(f.writes, []);
  assert.equal(await readFile(f.statePath, 'utf8'), f.state);
});

test('bound preference survives trust metadata updates and fails closed on corruption', async t => {
  const f = await fixture(t), configBytes = await readFile(f.configPath, 'utf8');
  await saveDeviceConnectionPreference({configPath: f.configPath, config: f.config, connectionMode: 'manual'});
  assert.equal((await loadDeviceConfig(f.configPath)).connectionMode, 'manual');
  assert.equal(await readFile(f.configPath, 'utf8'), configBytes, 'Preference does not rewrite trust metadata');
  const file = (await readdir(f.home)).find(name => name.startsWith('device.json.connection.'))!;
  const path = join(f.home, file), saved = JSON.parse(await readFile(path, 'utf8'));
  for (const [bytes, code] of [['{broken', 'corrupt'], [JSON.stringify({...saved, binding: '0'.repeat(64)}), 'invalid'],
    [JSON.stringify({...saved, connectionMode: 'forever'}), 'invalid']] as const) {
    await writeFile(path, bytes);
    await assert.rejects(readExistingDeviceConfig(f.configPath), new RegExp(`connection_preference_${code}`));
    assert.equal(await readFile(path, 'utf8'), bytes);
  }
  await writeFile(path, JSON.stringify(saved));
  await saveDeviceConfig(f.configPath, {...f.config, deviceId: '33333333-3333-4333-8333-333333333333', connectionMode: undefined});
  assert.equal((await loadDeviceConfig(f.configPath)).connectionMode, undefined, 'Another identity cannot reuse this preference');
  assert.deepEqual(f.writes, []);
});
