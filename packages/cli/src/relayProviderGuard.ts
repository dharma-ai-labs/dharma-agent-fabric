import type { ProviderId } from '@dharma-ai-labs/agent-fabric-contracts';
import { providerCapabilityWithoutExecutable, providerProcessEnvironment, type ProviderAdapter } from '@dharma-ai-labs/agent-fabric-provider-adapters';
import { providerFirstOnPathUnsafe } from './repositoryLaunchers.js';

/** The activation result and task refusal the relay records for a provider it will not run. */
export const PROVIDER_UNSAFE_PATH = 'provider_unsafe_path';

type GuardOptions = { env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform };

/** Whether the first executable of `provider` on the PATH the relay runs providers with fails setup's rules. */
export function relayProviderUnsafePath(provider: ProviderId, options: GuardOptions = {}): Promise<boolean> {
  return providerFirstOnPathUnsafe(provider, { searchPath: providerProcessEnvironment(options.env ?? process.env).PATH,
    ...(options.platform ? { platform: options.platform } : {}) });
}

/**
 * The adapter's capability, unless its first executable on PATH is unsafe, such as another user's codex on a shared
 * host: then the capability of an absent executable, with nothing run, so the relay neither installs for it nor
 * reports it able to take tasks.
 */
export async function relayProviderCapability(adapter: ProviderAdapter, options: { platform?: NodeJS.Platform } = {}) {
  if (await relayProviderUnsafePath(adapter.providerId, options)) {
    return { unsafePath: true as const, capability: providerCapabilityWithoutExecutable(adapter.providerId) };
  }
  return { unsafePath: false as const, capability: await adapter.capability() };
}
