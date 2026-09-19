import { resolve } from 'node:path';
import { canonicalize, sha256, validateContract } from '@dharma-ai-labs/agent-fabric-contracts';
import type { SkillBundle } from '@dharma-ai-labs/agent-fabric-skill-manager';

// This validates a cache record, not signing, publication or installation authority.
export async function serializeSkillPreparationRecord(value: unknown): Promise<string> {
  const bytes = canonicalize(value) + '\n';
  if (Buffer.byteLength(bytes) > 3 * 1024 * 1024) throw new Error('Skill preparation metadata exceeds its byte limit.');
  const record = JSON.parse(bytes) as Record<string, unknown>;
  const valid = await validateContract(resolve(import.meta.dirname, 'schemas'),
    'https://schemas.dharma-ai.io/skill-preparation/v1', record);
  if (!valid.ok) throw new Error('Skill preparation record does not match its contract.');
  const bundle = record.bundle as SkillBundle;
  if (bundle.organizationId !== record.organizationId) throw new Error('Skill preparation organization mismatch.');
  for (const [selectors, target] of [[bundle.targetSelectors.organizationAgentIds, record.repositoryAgentId],
    [bundle.targetSelectors.deviceIds, record.deviceId], [bundle.targetSelectors.workspaceIds, record.workspaceId],
    [bundle.targetSelectors.providers, record.provider]] as const) {
    if (selectors.length && !selectors.includes(target as never)) throw new Error('Skill preparation target mismatch.');
  }
  if (record.repositoryPackage !== null) {
    const { envelope, index } = record.repositoryPackage as { envelope: Record<string, unknown>; index: Record<string, unknown> };
    const descriptor = envelope.descriptor as Record<string, unknown>;
    for (const key of ['organizationId', 'repositoryAgentId', 'repositoryBindingId']) {
      if (!record[key] || descriptor[key] !== record[key] || index[key] !== record[key]) {
        throw new Error('Skill preparation repository scope mismatch.');
      }
    }
    if (envelope.bundleId !== bundle.bundleId || envelope.bundleHash !== bundle.bundleHash
      || descriptor.transferIndexHash !== sha256(canonicalize(index))) {
      throw new Error('Skill preparation provenance mismatch.');
    }
  }
  return bytes;
}
