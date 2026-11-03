import assert from 'node:assert/strict';
import {generateKeyPairSync, type JsonWebKey, type KeyObject} from 'node:crypto';
import {mkdtemp, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';
import test, {type TestContext} from 'node:test';
import {signCanonicalObject, type TrustedServerSigningKeyset} from '@dharma-ai-labs/agent-fabric-contracts';
import type {SecureSecretStore} from '@dharma-ai-labs/agent-fabric-secure-store';
import {AgentFabricClient, loadDeviceEnrollmentAnchor, loadOrCreateDeviceIdentity, recoverDeviceEnrollmentConsistency,
  verifyServerSigningKeysetSuccessor,
  saveDeviceConfig, saveDeviceEnrollmentAnchor, type DeviceConfig} from './index.js';

// C9: an interrupted keyset installation leaves the protected anchor one renewal
// ahead of device.json. Startup must complete it even after the old keyset expired,
// but only for a keyset signed by this device's pinned root at a higher generation.

const DAY = 24 * 60 * 60_000;

function memoryStore(): SecureSecretStore & {values: Map<string, string>} {
  const values = new Map<string, string>();
  return {backend: 'linux-secret-service', values,
    async get(account) {return values.get(account) ?? null;},
    async put(account, value) {values.set(account, value);},
    async delete(account) {values.delete(account);}};
}

function publicX(key: KeyObject) {return (key.export({format: 'jwk'}) as JsonWebKey).x!;}

function rootKeyset(input: {signer: {privateKey: KeyObject; publicKey: KeyObject}; generation: number;
  issuedAt: number; expiresAt: number; now: number}): TrustedServerSigningKeyset {
  const unsigned = {schema: 'dharma.server-signing-keyset/v1' as const, organizationId: 'org_a', generation: input.generation,
    keys: [{keyVersion: 'kms/1', publicKeyEd25519: publicX(input.signer.publicKey), status: 'active' as const,
      notBefore: new Date(input.now - 90 * DAY).toISOString(), notAfter: new Date(input.now + 300 * DAY).toISOString()}],
    signedByKeyVersion: 'kms/1', issuedAt: new Date(input.issuedAt).toISOString(), expiresAt: new Date(input.expiresAt).toISOString()};
  return {...unsigned, signature: signCanonicalObject(unsigned, input.signer.privateKey)};
}

async function interruptedInstall(t: TestContext, stored: TrustedServerSigningKeyset, anchored: TrustedServerSigningKeyset,
  root: string) {
  const home = await mkdtemp(resolve(tmpdir(), 'fabric-c9-recovery-'));
  t.after(() => rm(home, {recursive: true, force: true}));
  const store = memoryStore();
  const identity = await loadOrCreateDeviceIdentity({hqUrl: 'https://hq.example', organizationId: 'org_a', store});
  const configPath = resolve(home, 'device.json');
  const config: DeviceConfig = {schema: 'dharma.device-config/v1', hqUrl: 'https://hq.example', organizationId: 'org_a',
    deviceId: 'c72c7f13-e420-49f7-a818-c07f6f9d0915', deviceName: 'Test', platform: 'linux',
    publicKeyEd25519: identity.publicKeyEd25519, serverPublicKeyEd25519: root, serverSigningKeyset: stored,
    relayUrl: 'wss://relay.example', enrolledAt: new Date(Date.now() - 60 * DAY).toISOString()};
  await saveDeviceConfig(configPath, config);
  // The anchor is the write-ahead record: it was written, then the process stopped.
  await saveDeviceEnrollmentAnchor({config: {...config, serverSigningKeyset: anchored}, store});
  return {home, store, configPath, config, statePath: resolve(home, 'state.json')};
}

test('interrupted install, offline past the old expiry, then startup recovers the root-signed successor', async t => {
  const now = Date.now(), root = generateKeyPairSync('ed25519');
  // Generation 1 expired an hour ago. Generation 2 was issued a week later and is still current.
  const stored = rootKeyset({signer: root, generation: 1, issuedAt: now - 29 * DAY - 3_600_000, expiresAt: now - 3_600_000, now});
  const anchored = rootKeyset({signer: root, generation: 2, issuedAt: now - 22 * DAY, expiresAt: now + 7 * DAY, now});
  const f = await interruptedInstall(t, stored, anchored, publicX(root.publicKey));

  const recovered = await recoverDeviceEnrollmentConsistency({configPath: f.configPath, store: f.store, now: new Date(now)});
  assert.deepEqual(recovered.serverSigningKeyset, anchored);
  assert.equal(recovered.deviceId, f.config.deviceId, 'Recovery keeps the device id');
  assert.deepEqual(JSON.parse(await readFile(f.configPath, 'utf8')).serverSigningKeyset, anchored);
  assert.deepEqual((await loadDeviceEnrollmentAnchor({config: recovered, store: f.store})).serverSigningKeyset, anchored);
});

test('relay startup opens with the recovered successor after the old keyset expired', async t => {
  const now = Date.now(), root = generateKeyPairSync('ed25519');
  const stored = rootKeyset({signer: root, generation: 4, issuedAt: now - 29 * DAY - 3_600_000, expiresAt: now - 3_600_000, now});
  const anchored = rootKeyset({signer: root, generation: 5, issuedAt: now - 22 * DAY, expiresAt: now + 7 * DAY, now});
  const f = await interruptedInstall(t, stored, anchored, publicX(root.publicKey));
  const client = await AgentFabricClient.open({configPath: f.configPath, statePath: f.statePath, store: f.store,
    fetcher: async () => new Response(JSON.stringify({ok: true}), {status: 201})});
  assert.equal(client.config.serverSigningKeyset?.generation, 5);
  assert.equal(client.config.deviceId, f.config.deviceId);
});

for (const variant of ['different root', 'lower generation', 'equal generation', 'tampered signature'] as const) {
  test(`interrupted-install recovery rejects a ${variant} anchor keyset and changes nothing`, async t => {
    const now = Date.now(), root = generateKeyPairSync('ed25519'), other = generateKeyPairSync('ed25519');
    const stored = rootKeyset({signer: root, generation: 3, issuedAt: now - 29 * DAY - 3_600_000, expiresAt: now - 3_600_000, now});
    let anchored: TrustedServerSigningKeyset;
    if (variant === 'different root') {
      anchored = rootKeyset({signer: other, generation: 4, issuedAt: now - DAY, expiresAt: now + 20 * DAY, now});
    } else if (variant === 'lower generation') {
      anchored = rootKeyset({signer: root, generation: 2, issuedAt: now - DAY, expiresAt: now + 20 * DAY, now});
    } else if (variant === 'equal generation') {
      anchored = rootKeyset({signer: root, generation: 3, issuedAt: now - DAY, expiresAt: now + 20 * DAY, now});
    } else {
      const valid = rootKeyset({signer: root, generation: 4, issuedAt: now - DAY, expiresAt: now + 20 * DAY, now});
      anchored = {...valid, expiresAt: new Date(now + 25 * DAY).toISOString()};
    }
    const f = await interruptedInstall(t, stored, anchored, publicX(root.publicKey));
    const before = await readFile(f.configPath, 'utf8');
    await assert.rejects(recoverDeviceEnrollmentConsistency({configPath: f.configPath, store: f.store, now: new Date(now)}),
      /Interrupted server signing keyset installation could not be verified/);
    assert.equal(await readFile(f.configPath, 'utf8'), before);
  });
}

// C9-T1: the pinned-root fallback must still enforce the candidate's own time
// validity. The stored keyset is expired, so only the root path can admit it.
for (const variant of ['expired candidate', 'future-issued candidate', 'valid successor (control)'] as const) {
  test(`stored keyset expired: interrupted-install recovery handles a root-signed higher-generation ${variant}`, async t => {
    const now = Date.now(), root = generateKeyPairSync('ed25519');
    const stored = rootKeyset({signer: root, generation: 3, issuedAt: now - 29 * DAY - 3_600_000, expiresAt: now - 3_600_000, now});
    const anchored = variant === 'expired candidate'
      // Issued after the stored keyset and also expired before now.
      ? rootKeyset({signer: root, generation: 4, issuedAt: now - 20 * DAY, expiresAt: now - 30 * 60_000, now})
      : variant === 'future-issued candidate'
        // Ten minutes ahead: past the five-minute contract tolerance.
        ? rootKeyset({signer: root, generation: 4, issuedAt: now + 10 * 60_000, expiresAt: now + 20 * DAY, now})
        : rootKeyset({signer: root, generation: 4, issuedAt: now - DAY, expiresAt: now + 20 * DAY, now});
    const expected = {'expired candidate': 'expired', 'future-issued candidate': 'not_yet_valid'} as const;
    const f = await interruptedInstall(t, stored, anchored, publicX(root.publicKey));
    const verification = verifyServerSigningKeysetSuccessor(f.config, stored, anchored, new Date(now));
    const configBefore = await readFile(f.configPath, 'utf8');
    const protectedBefore = JSON.stringify([...f.store.values]);
    if (variant === 'valid successor (control)') {
      assert.deepEqual(verification, {ok: true});
      const recovered = await recoverDeviceEnrollmentConsistency({configPath: f.configPath, store: f.store, now: new Date(now)});
      assert.deepEqual(recovered.serverSigningKeyset, anchored);
      assert.equal(recovered.deviceId, f.config.deviceId);
      return;
    }
    assert.deepEqual(verification, {ok: false, reason: expected[variant]});
    await assert.rejects(recoverDeviceEnrollmentConsistency({configPath: f.configPath, store: f.store, now: new Date(now)}),
      /Interrupted server signing keyset installation could not be verified/);
    await assert.rejects(AgentFabricClient.open({configPath: f.configPath, statePath: f.statePath, store: f.store,
      fetcher: async () => {throw new Error('admission must not be attempted');}}),
    /Interrupted server signing keyset installation could not be verified/);
    assert.equal(await readFile(f.configPath, 'utf8'), configBefore, 'device.json is byte-identical');
    assert.equal(JSON.stringify([...f.store.values]), protectedBefore, 'The protected anchor and keys are byte-identical');
  });
}
