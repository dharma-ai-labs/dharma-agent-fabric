import assert from 'node:assert/strict';
import test from 'node:test';
import { generateKeyPairSync } from 'node:crypto';
import type { SkillBundle } from '@dharma-ai-labs/agent-fabric-skill-manager';
import { receiveRepositoryPackageDelivery } from './repositoryPackageDelivery.js';

test('delivery rejects oversized metadata before collecting its property descriptors', async () => {
  const original = Object.getOwnPropertyDescriptors;
  let oversizedReads = 0;
  Object.getOwnPropertyDescriptors = ((value: object) => {
    if (Array.isArray(value) ? value.length > 516 : Reflect.ownKeys(value).length > 64) oversizedReads++;
    return original(value);
  }) as typeof original;
  try {
    for (const envelope of [Object.fromEntries(Array.from({ length: 65 }, (_, index) => [`field${index}`, true])),
      Array.from({ length: 517 }, () => true)]) {
      await assert.rejects(receiveRepositoryPackageDelivery({
        envelope, bundle: null as unknown as SkillBundle, serverPublicKey: generateKeyPairSync('ed25519').publicKey,
        scope: { organizationId: 'org_preflight', repositoryBindingId: '', repositoryAgentId: '', deviceId: '', workspaceId: '', provider: 'codex' },
        fetchIndex: async () => { throw new Error('Unexpected network read.'); },
        fetchChunk: async () => { throw new Error('Unexpected network read.'); },
      }));
    }
    assert.equal(oversizedReads, 0);
  } finally { Object.getOwnPropertyDescriptors = original; }
});
