import { createActionDecisionPublicKeyResolver, type SessionQuestionVerifier } from '@dharma-ai-labs/agent-fabric-contracts';
import type { LocalProviderSessionIdentity, LocalVault, ScopedLocalVault } from '@dharma-ai-labs/agent-fabric-local-vault';
import { loadDeviceEnrollmentAnchor, recoverDeviceEnrollmentConsistency,
  type DeviceConfig, type SecureSecretStore } from '@dharma-ai-labs/agent-fabric-relay-client';
import { createSystemSecureStore } from '@dharma-ai-labs/agent-fabric-secure-store';

export function isNamedSessionOwnerReceipt(response: Record<string, unknown>, bindingId: string,
  identity: LocalProviderSessionIdentity, now = new Date()): boolean {
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  const value = response.registration as Record<string, unknown> | undefined;
  const fields = ['bindingId', 'workspaceId', 'endpointId', 'repositoryBindingId', 'membershipId', 'deviceId',
    'provider', 'mode', 'revision', 'state', 'leaseUntil', 'replay'];
  return Object.keys(response).sort().join(',') === 'correlationId,ok,organizationId,registration'
    && response.ok === true && response.organizationId === identity.organizationId
    && typeof response.correlationId === 'string' && uuid.test(response.correlationId)
    && Boolean(value) && Object.keys(value!).sort().join(',') === fields.sort().join(',')
    && value!.bindingId === bindingId && value!.mode === 'bridge_owned' && value!.state === 'attached'
    && value!.replay === false && Number.isInteger(value!.revision) && Number(value!.revision) >= 1
    && Number(value!.revision) <= 2147483647 && typeof value!.leaseUntil === 'string' && Number.isFinite(Date.parse(value!.leaseUntil))
    && Number.isFinite(now.getTime()) && Date.parse(value!.leaseUntil) > now.getTime()
    && Date.parse(value!.leaseUntil) <= now.getTime() + 120000
    && Object.entries(identity).filter(([key]) => key !== 'organizationId').every(([key, expected]) => value![key] === expected);
}

export function createNamedSessionTrust(input: {
  configPath: string;
  identity: Pick<DeviceConfig, 'organizationId' | 'deviceId' | 'publicKeyEd25519' | 'hqUrl'>;
  store?: SecureSecretStore;
  now?: () => Date;
}) {
  const now = input.now ?? (() => new Date());
  let trusted: DeviceConfig | null = null;
  const resolvePublicKey: SessionQuestionVerifier['resolvePublicKey'] = version => {
    const keyset = trusted?.serverSigningKeyset;
    return keyset ? createActionDecisionPublicKeyResolver(keyset, now())(version) : null;
  };
  return {
    resolvePublicKey,
    async refresh() {
      // Clear stale authority even when the protected read or transition fails.
      trusted = null;
      const protectedStore = input.store ?? await createSystemSecureStore();
      const store: SecureSecretStore = { backend: protectedStore.backend,
        get: account => protectedStore.getFresh ? protectedStore.getFresh(account) : protectedStore.get(account),
        put: (account, value) => protectedStore.put(account, value), delete: account => protectedStore.delete(account) };
      const config = await recoverDeviceEnrollmentConsistency({ configPath: input.configPath, store, now: now() });
      await loadDeviceEnrollmentAnchor({ config, store });
      if (['organizationId', 'deviceId', 'publicKeyEd25519', 'hqUrl'].some(key =>
        config[key as keyof DeviceConfig] !== input.identity[key as keyof typeof input.identity])) {
        throw new Error('named_session_trust_scope_mismatch');
      }
      const keyset = config.serverSigningKeyset;
      if (!keyset || keyset.organizationId !== config.organizationId
        || !keyset.keys.some(key => createActionDecisionPublicKeyResolver(keyset, now())(key.keyVersion))) {
        throw new Error('named_session_trust_invalid_or_expired');
      }
      trusted = config;
      return config;
    },
  };
}

export async function renewNamedSessionLifetime(input: {
  vault: LocalVault | ScopedLocalVault; bindingId: string; identity: LocalProviderSessionIdentity;
  trust: ReturnType<typeof createNamedSessionTrust>;
  authorize(): Promise<boolean>;
  now?: () => Date;
}) {
  await input.trust.refresh();
  const binding = await input.vault.getProviderSessionBinding(input.bindingId, input.identity);
  if (!binding || binding.owner !== 'dharma_bridge') throw new Error('named_session_binding_unavailable');
  const now = (input.now ?? (() => new Date()))();
  if (Date.parse(binding.expiresAt) - now.getTime() >= 86400000) return binding;
  if (!await input.authorize()) throw new Error('named_session_lifetime_not_authorized');
  // A network wait must not allow an expired or replaced enrollment to authorize renewal.
  await input.trust.refresh();
  return input.vault.renewProviderSessionBinding(input.bindingId, input.identity, binding.expiresAt,
    new Date(now.getTime() + 30 * 86400000).toISOString(), now);
}
