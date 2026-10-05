import assert from 'node:assert/strict';
import test from 'node:test';
import * as relay from './index.js';
import type {DeviceConfig, SecureSecretStore, HostOperationScope} from './index.js';

const config: DeviceConfig = {schema: 'dharma.device-config/v1', organizationId: 'org_demo',
  hqUrl: 'https://hq.example', relayUrl: 'wss://relay.example', deviceId: '11111111-1111-4111-8111-111111111111',
  deviceName: 'Synthetic', platform: 'linux', publicKeyEd25519: 'a'.repeat(43), serverPublicKeyEd25519: 'b'.repeat(43),
  enrolledAt: '2026-10-05T22:00:00.000Z'};
const skill = {config, workspaceId: '22222222-2222-4222-8222-222222222222',
  organizationAgentId: '33333333-3333-4333-8333-333333333333', provider: 'codex' as const,
  bundleId: '44444444-4444-4444-8444-444444444444', receiptHash: `sha256:${'c'.repeat(64)}`,
  activatedAt: config.enrolledAt, expiresAt: null};
function fixture() {
  const values = new Map<string, string>(), calls: string[] = [];
  let allowed = true, after = () => {};
  const store: SecureSecretStore = {backend: 'linux-secret-service',
    async get(account) {calls.push('get'); const value = values.get(account) ?? null; after(); return value;},
    async getFresh(account) {calls.push('getFresh'); const value = values.get(account) ?? null; after(); return value;},
    async put(account, value) {calls.push('put'); values.set(account, value); after();},
    async delete(account) {calls.push('delete'); values.delete(account); after();}};
  const scope: HostOperationScope = {signal: new AbortController().signal, current: async () => allowed};
  return {values, calls, store, scope, allow(value: boolean) {allowed = value;}, after(fn: () => void) {after = fn;}};
}
const api = relay as unknown as Record<string, (input: Record<string, unknown>) => Promise<unknown>>;
const quota = {schema: 'dharma.evidence-quota-anchor/v1', day: '2026-10-05', totalBytes: 0,
  ledgerHash: 'd'.repeat(64), updatedAt: config.enrolledAt};
const operations: Array<[string, Record<string, unknown>]> = [
  ['loadOrganizationApiToken', {hqUrl: config.hqUrl, organizationId: config.organizationId}],
  ['saveOrganizationApiToken', {hqUrl: config.hqUrl, organizationId: config.organizationId, token: `dharma_org_${'e'.repeat(40)}`}],
  ['loadDeviceEnrollmentAnchor', {config}], ['saveDeviceEnrollmentAnchor', {config}],
  ['loadActiveSkillAuthorizationAnchor', skill], ['saveActiveSkillAuthorizationAnchor', skill],
  ['deleteActiveSkillAuthorizationAnchor', skill], ['loadEvidenceQuotaAnchor', {config}],
  ['saveEvidenceQuotaAnchor', {config, anchor: quota}],
];

test('every protected helper denies a withdrawn scope before its first store effect', async () => {
  for (const [name, input] of operations) {
    const f = fixture(); f.allow(false);
    await assert.rejects(api[name]!({...input, store: f.store, hostScope: f.scope}), {message: 'relay_host_scope_unavailable'}, name);
    assert.deepEqual(f.calls, [], name);
  }
});

test('protected helper writes retain a partial effect but do not read it back after withdrawal', async () => {
  for (const [name, input] of operations.filter(([name]) => name.startsWith('save'))) {
    const f = fixture(); f.after(() => f.allow(false));
    await assert.rejects(api[name]!({...input, store: f.store, hostScope: f.scope}), {message: 'relay_host_scope_unavailable'}, name);
    assert.deepEqual(f.calls, ['put'], name); assert.equal(f.values.size, 1, name);
  }
});

test('enrollment fallback cannot migrate after losing authority during its first read', async () => {
  const f = fixture(); f.after(() => f.allow(false));
  await assert.rejects(api.loadDeviceEnrollmentAnchor!({config, store: f.store, hostScope: f.scope}),
    {message: 'relay_host_scope_unavailable'});
  assert.deepEqual(f.calls, ['get']);
});

test('fresh skill reads neither expose a result nor fallback to another store effect after withdrawal', async () => {
  const f = fixture();
  await relay.saveActiveSkillAuthorizationAnchor({...skill, store: f.store}); f.calls.length = 0;
  f.after(() => f.allow(false));
  await assert.rejects(api.loadActiveSkillAuthorizationAnchor!({...skill, fresh: true, store: f.store, hostScope: f.scope}),
    {message: 'relay_host_scope_unavailable'});
  assert.deepEqual(f.calls, ['getFresh']);
});

test('post-enrollment identity access refuses a missing key without replacement writes', async () => {
  const f = fixture(); assert.equal(typeof api.loadDeviceIdentity, 'function');
  await assert.rejects(api.loadDeviceIdentity!({config, store: f.store, hostScope: f.scope}),
    {message: 'relay_host_device_identity_unavailable'});
  assert.deepEqual(f.calls, ['get']); assert.equal(f.values.size, 0);
});

test('current scoped helpers keep compatible protected read/write behavior', async () => {
  const f = fixture(), common = {store: f.store, hostScope: f.scope};
  const token = `dharma_org_${'e'.repeat(40)}`;
  await api.saveOrganizationApiToken!({hqUrl: config.hqUrl, organizationId: config.organizationId, token, ...common});
  assert.equal(await api.loadOrganizationApiToken!({hqUrl: config.hqUrl, organizationId: config.organizationId, ...common}), token);
  const anchor = await api.saveDeviceEnrollmentAnchor!({config, ...common});
  assert.deepEqual(await api.loadDeviceEnrollmentAnchor!({config, ...common}), anchor);
  const active = await api.saveActiveSkillAuthorizationAnchor!({...skill, ...common});
  assert.deepEqual(await api.loadActiveSkillAuthorizationAnchor!({...skill, fresh: true, ...common}), active);
  await api.deleteActiveSkillAuthorizationAnchor!({...skill, ...common});
  assert.equal(await api.loadActiveSkillAuthorizationAnchor!({...skill, ...common}), null);
  await api.saveEvidenceQuotaAnchor!({config, anchor: quota, ...common});
  assert.deepEqual(await api.loadEvidenceQuotaAnchor!({config, ...common}), quota);
});

test('scoped malformed anchors do not expose protected serialized content in parser errors', async () => {
  for (const [save, load, input] of [
    ['saveDeviceEnrollmentAnchor', 'loadDeviceEnrollmentAnchor', {config}],
    ['saveActiveSkillAuthorizationAnchor', 'loadActiveSkillAuthorizationAnchor', skill],
    ['saveEvidenceQuotaAnchor', 'loadEvidenceQuotaAnchor', {config, anchor: quota}],
  ] as const) {
    const f = fixture(); await api[save]!({...input, store: f.store});
    for (const account of f.values.keys()) f.values.set(account, 'private-malformed-anchor-canary');
    await assert.rejects(api[load]!({...input, store: f.store, hostScope: f.scope}), error => {
      assert.ok(error instanceof Error);
      assert.doesNotMatch(error.message, /private-ma/);
      return true;
    });
  }
});

test('anchor reads retain their original scope when caller input changes during the store read', async () => {
  for (const [save, load, fields] of [
    ['saveDeviceEnrollmentAnchor', 'loadDeviceEnrollmentAnchor', {config}],
    ['saveEvidenceQuotaAnchor', 'loadEvidenceQuotaAnchor', {config, anchor: quota}],
  ] as const) {
    const f = fixture(); await api[save]!({...fields, store: f.store});
    for (const account of f.values.keys()) f.values.set(account, 'private-malformed-anchor-canary');
    const input: Record<string, unknown> = {...fields, store: f.store, hostScope: f.scope};
    f.after(() => {input.hostScope = undefined;});
    await assert.rejects(api[load]!(input), error => {
      assert.ok(error instanceof Error); assert.doesNotMatch(error.message, /private-ma/); return true;
    });
  }
});
