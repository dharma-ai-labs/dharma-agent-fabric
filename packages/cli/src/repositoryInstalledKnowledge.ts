import type { ProviderId } from '@dharma-ai-labs/agent-fabric-contracts';
import { validateRepositoryKnowledgeRetention } from './repositoryKnowledge.js';

type Bytes = { catalogBytes: Buffer; manifestBytes: Buffer };

// Installed-tree verification belongs to the loader; carrier authority still
// belongs to the server. Divergent claims at one generation must not be merged.
export async function selectInstalledRepositoryKnowledge(input: {
  organizationId: string; repositoryBindingId: string; repositoryAgentId: string;
  loadProvider: (provider: ProviderId) => Promise<Bytes | null>;
}): Promise<Bytes | null> {
  const generations = new Map<number, Bytes>();
  let latest = 0;
  for (const provider of ['codex', 'claude', 'agy', 'hermes'] as const) {
    const observed = await input.loadProvider(provider);
    if (!observed) continue;
    if (![observed.catalogBytes, observed.manifestBytes].every(bytes => Buffer.isBuffer(bytes) && bytes.length > 0 && bytes.length <= 262144)) {
      throw new Error('Installed repository knowledge byte limit exceeded.');
    }
    const bytes = { catalogBytes: Buffer.from(observed.catalogBytes), manifestBytes: Buffer.from(observed.manifestBytes) };
    const retained = validateRepositoryKnowledgeRetention({ identity: input, ...bytes });
    const previous = generations.get(retained.reference.generation);
    if (previous && (!previous.catalogBytes.equals(bytes.catalogBytes) || !previous.manifestBytes.equals(bytes.manifestBytes))) {
      throw new Error('Installed repository knowledge generation conflict.');
    }
    generations.set(retained.reference.generation, bytes);
    latest = Math.max(latest, retained.reference.generation);
  }
  return generations.get(latest) || null;
}
