import assert from 'node:assert/strict';
import {createHash, randomUUID} from 'node:crypto';
import test from 'node:test';
import type {SecureSecretStore} from '@dharma-ai-labs/agent-fabric-secure-store';
import {saveDeviceEnrollmentAnchor} from './index.js';

test('a shared Windows backend rejects a current or legacy anchor changed after local preflight', async () => {
  for (const changed of ['current', 'legacy']) {
    const config = {schema: 'dharma.device-config/v1' as const, hqUrl: 'https://cas.example',
      organizationId: 'org_' + randomUUID(), deviceId: randomUUID(), deviceName: 'Synthetic',
      platform: 'linux' as const, publicKeyEd25519: 'A'.repeat(43), serverPublicKeyEd25519: 'B'.repeat(43),
      relayUrl: 'wss://relay.example', enrolledAt: '2026-10-01T00:00:00.000Z'};
    const account = (parts: string[]) => 'device-enrollment-' + createHash('sha256').update(parts.join(':')).digest('hex').slice(0, 32);
    const current = account([config.hqUrl, config.organizationId, config.deviceId]);
    const legacy = account([config.hqUrl, config.organizationId]);
    const values = new Map<string, string>();
    let writes = 0;
    const concurrentWrite = () => values.set(changed === 'current' ? current : legacy, 'preserved competing anchor');
    const store: SecureSecretStore = {backend: 'windows-credential-manager',
      get: async key => values.get(key) ?? null, getFresh: async key => values.get(key) ?? null,
      put: async (key, bytes) => {concurrentWrite(); writes++; values.set(key, bytes);},
      delete: async () => {throw Error('unexpected delete');}};
    Object.assign(store, {compareAndPutEnrollmentAnchor: async (input: {
      account: string; legacyAccount: string; expectedCurrent: string | null; expectedLegacy: string | null; secret: string;
    }) => {
      concurrentWrite();
      if ((values.get(input.account) ?? null) !== input.expectedCurrent
        || (values.get(input.legacyAccount) ?? null) !== input.expectedLegacy) return false;
      writes++; values.set(input.account, input.secret); return true;
    }});
    const controller = new AbortController();
    await assert.rejects(saveDeviceEnrollmentAnchor({config, store, requireAbsent: true,
      hostScope: {signal: controller.signal, current: async () => true}}), /connection_existing_anchor_requires_recovery/);
    assert.equal(writes, 0);
    assert.deepEqual([...values], [[changed === 'current' ? current : legacy, 'preserved competing anchor']]);
  }
});

test('a conditional write retains its partial effect and denies later relay readback after scope withdrawal', async () => {
  const config = {schema: 'dharma.device-config/v1' as const, hqUrl: 'https://withdraw-cas.example',
    organizationId: 'org_' + randomUUID(), deviceId: randomUUID(), deviceName: 'Synthetic',
    platform: 'windows' as const, publicKeyEd25519: 'A'.repeat(43), serverPublicKeyEd25519: 'B'.repeat(43),
    relayUrl: 'wss://relay.example', enrolledAt: '2026-10-01T00:00:00.000Z'};
  const values = new Map<string, string>(), calls: string[] = [];
  let allowed = true;
  const store: SecureSecretStore = {backend: 'windows-credential-manager',
    get: async () => {throw Error('unexpected cached read');},
    getFresh: async key => {calls.push('fresh'); return values.get(key) ?? null;},
    put: async () => {throw Error('unexpected unconditional write');}, delete: async () => {},
    compareAndPutEnrollmentAnchor: async input => {calls.push('conditional');values.set(input.account,input.secret);
      allowed = false; return true;}};
  await assert.rejects(saveDeviceEnrollmentAnchor({config, store, requireAbsent: true,
    hostScope: {signal: new AbortController().signal, current: async () => allowed}}), /relay_host_scope_unavailable/);
  assert.deepEqual(calls, ['fresh', 'fresh', 'conditional']);
  assert.equal(values.size, 1);
});

test('host fencing snapshots conditional write inputs before an asynchronous authority check', async () => {
  const {HostOperationFence} = await import('./hostOperationScope.js');
  let entered!: () => void, resume!: () => void;
  const ready = new Promise<void>(accept => {entered = accept;});
  const released = new Promise<void>(accept => {resume = accept;});
  const seen: string[] = [];
  const store: SecureSecretStore = {backend: 'windows-credential-manager', get: async () => null,
    put: async () => {}, delete: async () => {},
    compareAndPutEnrollmentAnchor: async input => {seen.push(input.secret);return true;}};
  const fence = new HostOperationFence({signal: new AbortController().signal,
    current: async () => {entered();await released;return true;}});
  const input = {account: 'current', legacyAccount: 'legacy', expectedCurrent: null, expectedLegacy: null, secret: 'admitted'};
  const write = fence.store(store).compareAndPutEnrollmentAnchor!(input);
  await ready; input.secret = 'changed';resume();await write;
  assert.deepEqual(seen, ['admitted']);
});
