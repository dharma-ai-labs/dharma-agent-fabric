import { loadOrCreateDeviceIdentity, normalizeHqUrl, type SecureSecretStore } from '@dharma-ai-labs/agent-fabric-relay-client';
import { createSystemSecureStore } from '@dharma-ai-labs/agent-fabric-secure-store';
import { loadDemoSigningTrust, type DemoDeviceScope } from './demoEnrollment.js';
import { createDemoTransportFetcher } from './demoTransportFetch.js';

function immutableIdentity(): never {
  throw Object.assign(new Error('Demo transport requires existing_protected_state_required. Preserve the original enrollment.'),
    { code: 'demo_transport_existing_protected_state_required' });
}

// Invoke within withDemoDeviceLock. Keep all config paths and private-key
// accounts on the original enrollment origin, even when HTTP moves elsewhere.
export async function createDemoDeviceTransport(input: DemoDeviceScope,
  deps: { store?: SecureSecretStore; fetcher?: typeof fetch } = {}) {
  const scope = structuredClone(input), enrollmentOrigin = normalizeHqUrl(scope.hqUrl);
  const store = deps.store ?? await createSystemSecureStore();
  const fresh = (account: string) => store.getFresh ? store.getFresh(account) : store.get(account);
  const readOnly: SecureSecretStore = { backend: store.backend, get: fresh, getFresh: fresh,
    async put() { immutableIdentity(); }, async delete() { immutableIdentity(); } };
  const identity = await loadOrCreateDeviceIdentity({ hqUrl: enrollmentOrigin,
    organizationId: `${scope.organizationId}:${scope.repositoryId}`, installationId: scope.installationId, store: readOnly });
  const operationStore: SecureSecretStore = { backend: store.backend, get: fresh, getFresh: fresh,
    async put(account, value) { if (account === identity.account) immutableIdentity(); await store.put(account, value); },
    async delete(account) { if (account === identity.account) immutableIdentity(); await store.delete(account); } };
  const initial = await loadDemoSigningTrust(scope, { store: operationStore });
  const fetcher = createDemoTransportFetcher({ store: operationStore, fetcher: deps.fetcher,
    loadBinding: async protectedStore => {
      const trust = await loadDemoSigningTrust(scope, { store: protectedStore });
      const currentIdentity = await loadOrCreateDeviceIdentity({ hqUrl: enrollmentOrigin,
        organizationId: `${scope.organizationId}:${scope.repositoryId}`,
        installationId: scope.installationId, store: protectedStore });
      if (trust.deviceId !== initial.deviceId || currentIdentity.publicKeyEd25519 !== identity.publicKeyEd25519) immutableIdentity();
      return { organizationId: scope.organizationId, repositoryId: scope.repositoryId,
        deviceId: trust.deviceId, installationId: scope.installationId,
        publicKeyEd25519: currentIdentity.publicKeyEd25519, enrollmentOrigin,
        protectedKeyset: trust.keyset, minimumPolicyRevision: 1 };
    } });
  return { store: operationStore, fetcher };
}
