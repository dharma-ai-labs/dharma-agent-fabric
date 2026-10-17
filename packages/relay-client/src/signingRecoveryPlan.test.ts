import assert from 'node:assert/strict';
import {createHash, generateKeyPairSync} from 'node:crypto';
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {tmpdir} from 'node:os';
import test from 'node:test';
import {canonicalize, signCanonicalObject, validateContract, type TrustedServerSigningKeyset} from '@dharma-ai-labs/agent-fabric-contracts';
import * as relay from './index.js';
import type {DeviceConfig, SecureSecretStore} from './index.js';

const now = Date.parse('2026-10-17T10:00:00.000Z');
const id = (n: number) => `${String(n).padStart(8, '0')}-1111-4111-8111-111111111111`;
const digest = (letter: string) => `sha256:${letter.repeat(64)}`;
const hash = (value: unknown) => `sha256:${createHash('sha256').update(canonicalize(value)).digest('hex')}`;
const server = generateKeyPairSync('ed25519'), device = generateKeyPairSync('ed25519');
const pub = (key: typeof server) => key.publicKey.export({format: 'jwk'}).x!;
const keysetBody = {schema: 'dharma.server-signing-keyset/v1' as const, organizationId: 'org_synthetic', generation: 2,
  keys: [{keyVersion: 'kms/synthetic/versions/1', publicKeyEd25519: pub(server), status: 'active' as const,
    notBefore: '2026-09-17T19:08:56.457Z', notAfter: '2026-10-16T19:08:56.457Z'}],
  signedByKeyVersion: 'kms/synthetic/versions/1', issuedAt: '2026-09-17T19:08:56.457Z', expiresAt: '2026-10-16T19:08:56.457Z'};
const keyset: TrustedServerSigningKeyset = {...keysetBody, signature: signCanonicalObject(keysetBody, server.privateKey)};
const source = {organizationId: 'org_synthetic', workspaceId: id(4), repositoryBindingId: id(5),
  repositoryFingerprint: digest('a'), policyRevision: 'agent-fabric-policy-v1', scopeDigest: digest('b'), contractDigest: digest('c'),
  sourceGenerationId: id(6), sourceReceiptId: 'repo_consent_' + id(6), sourceRevision: 1,
  sourcePolicyRevision: 'repository-source-' + id(6), sourcePolicyHash: digest('d')};
const session = {organizationId: 'org_synthetic', workspaceId: id(4), repositoryBindingId: id(5),
  endpointId: id(7), membershipId: id(8), deviceId: id(2), bindingId: id(9), provider: 'codex',
  sessionId: 'native-thread-1', owner: 'dharma_bridge', createdAt: '2026-10-17T09:00:00.000Z',
  expiresAt: '2026-10-17T10:20:00.000Z', maximumProviderCostCents: 4000};
const hostBinding = {connectionId: id(10), hostContextId: id(11), threadId: session.sessionId, turnId: 'native-turn-1'};

function api() {
  const fn = (relay as unknown as Record<string, unknown>).planDeviceSigningRecovery;
  assert.equal(typeof fn, 'function', 'missing public read-only recovery plan');
  return fn as (input: Record<string, unknown>) => Promise<Record<string, unknown>>;
}
async function fixture(platform: DeviceConfig['platform'] = 'linux') {
  const root = await mkdtemp(resolve(tmpdir(), 'fabric-recovery-plan-'));
  assert.match(root, /^C:[\\/]/i);
  const configPath = resolve(root, 'device.json');
  const config: DeviceConfig = {schema: 'dharma.device-config/v1', hqUrl: 'https://www.dharma-ai.io', organizationId: source.organizationId,
    installationId: id(1), deviceId: id(2), deviceName: 'Synthetic', platform, publicKeyEd25519: pub(device),
    serverPublicKeyEd25519: pub(server), serverSigningKeyset: keyset, relayUrl: 'wss://relay.example',
    enrolledAt: '2026-10-01T00:00:00.000Z', connectionMode: 'manual', setupClaimReference: id(3), setupClaimRepositoryFingerprint: source.repositoryFingerprint};
  const anchor = {schema: 'dharma.device-enrollment-anchor/v1', hqUrl: config.hqUrl, organizationId: config.organizationId,
    deviceId: config.deviceId, devicePublicKeyEd25519: config.publicKeyEd25519,
    serverPublicKeyEd25519: config.serverPublicKeyEd25519, serverSigningKeyset: config.serverSigningKeyset, enrolledAt: config.enrolledAt};
  const account = 'device-enrollment-' + createHash('sha256').update(`${config.hqUrl}:${config.organizationId}:${config.deviceId}`).digest('hex').slice(0, 32);
  const values = new Map([[account, JSON.stringify(anchor)]]), calls: string[] = [];
  let allowed = true, afterRead = async () => {};
  const store: SecureSecretStore = {backend: platform === 'wsl' || platform === 'windows' ? 'windows-credential-manager' : 'linux-secret-service',
    get: async () => {throw Error('cached read forbidden');},
    getFresh: async key => {calls.push(key); const value = values.get(key) ?? null; await afterRead(); return value;},
    put: async () => {throw Error('unexpected protected write');}, delete: async () => {throw Error('unexpected delete');}};
  await writeFile(configPath, JSON.stringify(config));
  const input = {configPath, source: {...source}, session: {...session}, hostBinding: {...hostBinding}, store,
    hostScope: {signal: new AbortController().signal, current: async () => allowed}, now: () => now};
  return {root, configPath, config, anchor, account, values, calls, input,
    setAllowed(value: boolean) {allowed = value;}, after(fn: typeof afterRead) {afterRead = fn;},
    cleanup: () => rm(root, {recursive: true, force: true})};
}

test('read-only recovery plan derives exact local hashes from protected public state on Linux and WSL routes', async () => {
  for (const platform of ['linux', 'wsl'] as const) {
    const f = await fixture(platform);
    try {
      const before = await readFile(f.configPath, 'utf8'), plan = await api()(f.input);
      assert.equal(plan.schema, 'dharma.device-signing-recovery-plan/v1');
      assert.equal(plan.authority, 'local_context_only_not_recovery_authorization');
      assert.equal(plan.previousGeneration, 2); assert.equal(plan.previousKeysetHash, hash(keyset));
      assert.equal(plan.previousAnchorHash, hash(f.anchor)); assert.equal(plan.protectedConfigDigest, hash(f.config));
      assert.equal(plan.previousRootFingerprint, `sha256:${createHash('sha256').update(Buffer.from(pub(server), 'base64url')).digest('hex')}`);
      assert.equal(plan.recipientMembershipId, session.membershipId); assert.equal(plan.installationId, f.config.installationId);
      assert.equal(plan.workspaceId, source.workspaceId); assert.equal(plan.deviceId, f.config.deviceId);
      const expectedSource = 'dharma.agent-fabric.signing-recovery-source-selection/v1\0' + canonicalize({...source, setupClaimReference: f.config.setupClaimReference});
      assert.equal(plan.sourceSelectionDigest, `sha256:${createHash('sha256').update(expectedSource).digest('hex')}`);
      const expectedSession = 'dharma.agent-fabric.signing-recovery-native-session/v1\0' + canonicalize({session, hostBinding, installationId: f.config.installationId});
      assert.equal(plan.nativeSessionBindingDigest, `sha256:${createHash('sha256').update(expectedSession).digest('hex')}`);
      assert.equal(plan.preparedAt, new Date(now).toISOString());
      assert.equal(plan.expiresAt, new Date(now + 900_000).toISOString());
      assert.equal(await readFile(f.configPath, 'utf8'), before); assert.deepEqual(f.calls, [f.account]);
      assert.doesNotMatch(JSON.stringify(plan), /native-thread-1|native-turn-1|kms\/|private|device\.json/);
      const schemaDirectory = resolve(import.meta.dirname, '../../../schemas');
      assert.equal((await validateContract(schemaDirectory, 'https://schemas.dharma-ai.io/device-signing-recovery-plan/v1', plan)).ok, true);
    } finally {await f.cleanup();}
  }
});

for (const [field, value] of Object.entries({organizationId: 'org_foreign', deviceId: id(20), workspaceId: id(21), repositoryBindingId: id(22)})) {
  test(`recovery plan rejects foreign session ${field} without protected writes`, async () => {
    const f = await fixture();
    try {
      await assert.rejects(api()({...f.input, session: {...session, [field]: value}}), /^Error: signing_recovery_local_context_invalid$/);
      assert.equal(f.values.size, 1);
    } finally {await f.cleanup();}
  });
}

test('recovery plan denies expired sessions, unrelated source, changed host thread and malformed data', async () => {
  for (const change of [
    {session: {...session, expiresAt: new Date(now).toISOString()}}, {session: {...session, maximumProviderCostCents: -1}},
    {session: {...session, provider: 'guessed_provider'}}, {source: {...source, repositoryFingerprint: digest('e')}},
    {source: {...source, sourceReceiptId: 'guessed'}}, {source: {...source, sourcePolicyRevision: 'guessed'}},
    {source: {...source, token: 'secret-input-canary'}}, {hostBinding: {...hostBinding, threadId: 'other-thread'}},
  ]) {
    const f = await fixture();
    try {
      await assert.rejects(api()({...f.input, ...change}), /^Error: signing_recovery_local_context_invalid$/);
      assert.deepEqual(f.calls, []);
    }
    finally {await f.cleanup();}
  }
});

test('recovery plan does not migrate a legacy anchor, read a private key or replace absent identity', async () => {
  const f = await fixture();
  try {
    const legacy = 'device-enrollment-' + createHash('sha256').update(`${f.config.hqUrl}:${f.config.organizationId}`).digest('hex').slice(0, 32);
    f.values.delete(f.account); f.values.set(legacy, JSON.stringify(f.anchor));
    const plan = await api()(f.input);
    assert.equal(plan.previousAnchorHash, hash(f.anchor));
    assert.deepEqual(f.calls, [f.account, legacy]); assert.deepEqual([...f.values.keys()], [legacy]);
    f.values.clear(); f.calls.length = 0;
    await assert.rejects(api()(f.input), /^Error: signing_recovery_local_context_invalid$/);
    assert.deepEqual(f.calls, [f.account, legacy]); assert.equal(f.values.size, 0);
  } finally {await f.cleanup();}
});

test('recovery plan checks cancellation and scope withdrawal before exposing any local result', async () => {
  const f = await fixture();
  try {
    f.setAllowed(false);
    await assert.rejects(api()(f.input), /^Error: relay_host_scope_unavailable$/); assert.deepEqual(f.calls, []);
    f.setAllowed(true); f.after(async () => f.setAllowed(false));
    await assert.rejects(api()(f.input), /^Error: relay_host_scope_unavailable$/); assert.deepEqual(f.calls, [f.account]);
  } finally {await f.cleanup();}
});

test('recovery plan refuses altered or still-live old trust and preserves the existing configuration', async () => {
  for (const altered of ['signature', 'anchor', 'unexpired', 'installation'] as const) {
    const f = await fixture();
    try {
      const config = structuredClone(f.config), anchor = structuredClone(f.anchor);
      if (altered === 'signature') {config.serverSigningKeyset!.signature = 'A'.repeat(86); anchor.serverSigningKeyset = config.serverSigningKeyset;}
      if (altered === 'anchor') anchor.deviceId = id(20);
      if (altered === 'installation') delete config.installationId;
      await writeFile(f.configPath, JSON.stringify(config)); f.values.set(f.account, JSON.stringify(anchor));
      await assert.rejects(api()({...f.input, ...(altered === 'unexpired' ? {
        now: () => Date.parse(keyset.expiresAt) - 1000,
        session: {...session, createdAt: '2026-10-01T00:00:00.000Z', expiresAt: '2026-10-18T00:00:00.000Z'},
      } : {})}),
        /^Error: signing_recovery_local_context_invalid$/);
      if (altered === 'unexpired') assert.deepEqual(f.calls, [f.account]);
      assert.deepEqual(JSON.parse(await readFile(f.configPath, 'utf8')), config);
    } finally {await f.cleanup();}
  }
});

test('recovery plan preserves scope and budget in digests and never outlives the native session', async () => {
  const f = await fixture();
  try {
    const original = await api()(f.input);
    for (const change of [{maximumProviderCostCents: 0}, {endpointId: id(40)}, {membershipId: id(41)}]) {
      const changed = await api()({...f.input, session: {...session, ...change}});
      assert.notEqual(changed.nativeSessionBindingDigest, original.nativeSessionBindingDigest);
    }
    const changedPolicy = await api()({...f.input, source: {...source, sourceRevision: 2, sourcePolicyHash: digest('e')}});
    assert.notEqual(changedPolicy.sourceSelectionDigest, original.sourceSelectionDigest);
    const bound = await api()({...f.input, session: {...session, expiresAt: new Date(now + 1000).toISOString()}});
    assert.equal(bound.expiresAt, new Date(now + 1000).toISOString());
  } finally {await f.cleanup();}
});

test('recovery plan does not coerce quantities or evaluate untrusted accessors and proxies', async () => {
  const f = await fixture(); let reads = 0;
  try {
    const accessor = {...source};
    Object.defineProperty(accessor, 'sourcePolicyHash', {enumerable: true, get() {reads++; throw Error('secret-input-canary');}});
    const proxy = new Proxy({...source}, {ownKeys() {reads++; throw Error('secret-input-canary');}});
    for (const change of [{source: accessor}, {source: proxy}, {source: {...source, sourceRevision: '1'}},
      {session: {...session, maximumProviderCostCents: '4000'}}, {hostBinding: {...hostBinding, turnId: 'bad\n'}}]) {
      await assert.rejects(api()({...f.input, ...change}), /^Error: signing_recovery_local_context_invalid$/);
    }
    assert.equal(reads, 0); assert.deepEqual(f.calls, []);
  } finally {await f.cleanup();}
});

test('recovery plan returns no result after its time budget expires during a fresh store read', async () => {
  const f = await fixture(); let at = now;
  try {
    f.after(async () => {at = now + 900_000;});
    await assert.rejects(api()({...f.input, now: () => at}), /^Error: signing_recovery_local_context_invalid$/);
    assert.deepEqual(f.calls, [f.account]); assert.equal(f.values.size, 1);
  } finally {await f.cleanup();}
});

test('recovery plan snapshots source/session before the first asynchronous host authorization', async () => {
  const f = await fixture();
  try {
    let checks = 0;
    f.input.hostScope.current = async () => {if (++checks === 1) f.input.session.membershipId = id(50); return true;};
    assert.equal((await api()(f.input)).recipientMembershipId, session.membershipId);
  } finally {await f.cleanup();}
});

test('recovery plan sanitizes protected read failures and rejects unknown protected anchor fields', async () => {
  const f = await fixture();
  try {
    await assert.rejects(api()({...f.input, store: {...f.input.store, getFresh: async () => {throw Error('secret-store-canary');}}}),
      /^Error: signing_recovery_local_context_invalid$/);
    f.values.set(f.account, JSON.stringify({...f.anchor, token: 'secret-input-canary'}));
    await assert.rejects(api()(f.input), /^Error: signing_recovery_local_context_invalid$/);
  } finally {await f.cleanup();}
});

test('recovery plan requires the historical signer window, not merely another active key', async () => {
  const f = await fixture();
  try {
    const unsigned = {...keysetBody, keys: [{...keysetBody.keys[0]!, notAfter: '2026-10-15T00:00:00.000Z'},
      {...keysetBody.keys[0]!, keyVersion: 'kms/synthetic/versions/2'}]};
    const changed = {...unsigned, signature: signCanonicalObject(unsigned, server.privateKey)};
    const config = {...f.config, serverSigningKeyset: changed}, anchor = {...f.anchor, serverSigningKeyset: changed};
    await writeFile(f.configPath, JSON.stringify(config)); f.values.set(f.account, JSON.stringify(anchor));
    await assert.rejects(api()(f.input), /^Error: signing_recovery_local_context_invalid$/);
    assert.deepEqual(f.calls, [f.account]);
  } finally {await f.cleanup();}
});

test('recovery plan snapshots caller context and detects configuration replacement while reading the anchor', async () => {
  const f = await fixture();
  try {
    f.after(async () => {f.input.session.membershipId = id(30);});
    assert.equal((await api()(f.input)).recipientMembershipId, session.membershipId);
    f.input.session.membershipId = session.membershipId;
    f.after(async () => {await writeFile(f.configPath, JSON.stringify({...f.config, deviceId: id(31)}));});
    await assert.rejects(api()(f.input), /^Error: signing_recovery_local_context_invalid$/);
  } finally {await f.cleanup();}
});
