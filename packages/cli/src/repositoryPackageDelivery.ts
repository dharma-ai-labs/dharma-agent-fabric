import type { KeyObject } from 'node:crypto';
import { types } from 'node:util';
import { fileURLToPath } from 'node:url';
import { validateContract, verifyCanonicalObject, type ProviderId } from '@dharma-ai-labs/agent-fabric-contracts';
import { verifySkillBundle, type SkillBundle } from '@dharma-ai-labs/agent-fabric-skill-manager';
import { validateRepositoryReleaseMetadata } from './repositoryReleaseMetadata.js';
import { createRepositoryPackageTransferReceiverV2, type RepositoryTransferIndexV2 } from './repositoryPackageTransfer.js';

const ROOT = '.agents/skills/dharma-agent-fabric';
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$(?![\s\S])/;
const schemas = fileURLToPath(new URL('./schemas/', import.meta.url));
type Row = Record<string, unknown>;
function requireFact(value: unknown): asserts value {
  if (!value) throw new Error('Repository package delivery is not authorized or does not match its signed contract.');
}

// Snapshot bounded metadata without invoking accessors, proxies or serialization hooks.
function snapshot(value: unknown): unknown {
  let nodes = 0, bytes = 0;
  const seen = new Set<object>();
  function visit(item: unknown, depth: number): unknown {
    requireFact(++nodes <= 20000 && depth <= 8);
    if (item === null || typeof item === 'boolean' || typeof item === 'number') {
      requireFact(typeof item !== 'number' || Number.isSafeInteger(item));
      bytes += 16; requireFact(bytes <= 1048576); return item;
    }
    if (typeof item === 'string') {
      requireFact(item.length <= 16384 && Buffer.from(item).toString('utf8') === item);
      bytes += Buffer.byteLength(item) + 2; requireFact(bytes <= 1048576); return item;
    }
    requireFact(item !== undefined && typeof item === 'object' && !types.isProxy(item) && !seen.has(item));
    requireFact(!Object.getOwnPropertyDescriptor(Object.prototype, 'toJSON')
      && !Object.getOwnPropertyDescriptor(Array.prototype, 'toJSON'));
    const array = Array.isArray(item), prototype = Object.getPrototypeOf(item);
    requireFact(array ? prototype === Array.prototype : prototype === Object.prototype || prototype === null);
    if (array) requireFact(item.length <= 516);
    const keys = Reflect.ownKeys(item);
    requireFact(keys.length <= (array ? 517 : 64) && keys.every(key => typeof key === 'string'));
    const descriptors = Object.getOwnPropertyDescriptors(item);
    requireFact(Object.values(descriptors).every(field => Object.hasOwn(field, 'value')));
    seen.add(item); bytes += 2;
    try {
      if (array) {
        requireFact(item.length <= 516 && Object.keys(descriptors).length === item.length + 1);
        return Array.from({ length: item.length }, (_, index) => {
          const field = descriptors[String(index)]; requireFact(field?.enumerable);
          return visit(field.value, depth + 1);
        });
      }
      requireFact(Object.keys(descriptors).length <= 64);
      const result: Row = {};
      for (const [key, field] of Object.entries(descriptors)) {
        requireFact(field.enumerable && key.length <= 128 && !['__proto__', 'constructor', 'prototype', 'toJSON'].includes(key));
        bytes += key.length + 4; requireFact(bytes <= 1048576);
        result[key] = visit(field.value, depth + 1);
      }
      return result;
    } finally { seen.delete(item); }
  }
  return visit(value, 0);
}
function timestamp(value: unknown): number {
  requireFact(typeof value === 'string');
  const milliseconds = Date.parse(value);
  requireFact(Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value);
  return milliseconds;
}

export async function receiveRepositoryPackageDelivery(input: {
  envelope: unknown;
  bundle: SkillBundle;
  serverPublicKey: KeyObject;
  scope: { organizationId: string; repositoryBindingId: string; repositoryAgentId: string;
    deviceId: string; workspaceId: string; provider: ProviderId };
  now?: () => Date;
  fetchIndex: () => Promise<unknown>;
  fetchChunk: (fileIndex: number, chunkIndex: number) => Promise<unknown>;
}) {
  const envelope = snapshot(input.envelope) as Row;
  const bundle = snapshot(input.bundle) as SkillBundle;
  const scope = snapshot(input.scope) as typeof input.scope;
  requireFact(envelope && typeof envelope === 'object' && !Array.isArray(envelope));
  requireFact((await validateContract(schemas, 'https://schemas.dharma-ai.io/repository-package-envelope/v1', envelope)).ok);
  requireFact((await validateContract(schemas, 'https://schemas.dharma-ai.io/skill-bundle/v2', bundle)).ok);
  const descriptor = envelope.descriptor as Row;
  const { signature, ...unsigned } = envelope;
  requireFact(typeof signature === 'string' && verifyCanonicalObject(unsigned, signature, input.serverPublicKey));
  requireFact(envelope.bundleId === bundle.bundleId && envelope.bundleHash === bundle.bundleHash
    && bundle.operation === 'install' && bundle.skills.length === 1 && bundle.skills[0]?.path === ROOT
    && bundle.skills[0].files === undefined && bundle.skills[0].commit === descriptor.gitCommit);
  requireFact([scope.repositoryBindingId, scope.repositoryAgentId, scope.deviceId, scope.workspaceId]
    .every(value => typeof value === 'string' && UUID.test(value)));
  requireFact(bundle.organizationId === scope.organizationId && descriptor.organizationId === scope.organizationId
    && descriptor.repositoryBindingId === scope.repositoryBindingId && descriptor.repositoryAgentId === scope.repositoryAgentId
    && bundle.targetSelectors.organizationAgentIds.includes(scope.repositoryAgentId));
  for (const [selectors, value] of [[bundle.targetSelectors.deviceIds, scope.deviceId],
    [bundle.targetSelectors.workspaceIds, scope.workspaceId], [bundle.targetSelectors.providers, scope.provider]] as const) {
    requireFact(selectors.length === 0 || selectors.includes(value as never));
  }
  requireFact(['codex', 'claude', 'agy', 'hermes'].includes(scope.provider));
  const created = timestamp(descriptor.createdAt), expires = timestamp(descriptor.expiresAt);
  const parentCreated = timestamp(bundle.createdAt);
  requireFact(expires > created && parentCreated <= created
    && (!bundle.expiresAt || expires <= timestamp(bundle.expiresAt)));
  const assertCurrent = () => {
    const now = (input.now || (() => new Date()))();
    const milliseconds = Date.prototype.getTime.call(now);
    requireFact(Number.isFinite(milliseconds) && parentCreated <= milliseconds && created <= milliseconds && expires > milliseconds);
    verifySkillBundle(bundle, input.serverPublicKey, now);
  };
  assertCurrent();
  const indexValue = await input.fetchIndex();
  assertCurrent();
  const index = snapshot(indexValue) as RepositoryTransferIndexV2;
  const receiver = createRepositoryPackageTransferReceiverV2(index, {
    organizationId: scope.organizationId, repositoryBindingId: scope.repositoryBindingId,
    repositoryAgentId: scope.repositoryAgentId, generation: descriptor.generation as number,
    releaseId: descriptor.releaseId as string, gitCommit: descriptor.gitCommit as string,
    expectedIndexHash: descriptor.transferIndexHash as string,
  });
  requireFact(index.files.length === descriptor.fileCount && index.totalBytes === descriptor.totalBytes);
  for (const [fileIndex, file] of index.files.entries()) {
    for (let chunkIndex = 0; chunkIndex < file.chunkHashes.length; chunkIndex++) {
      assertCurrent();
      const chunk = await input.fetchChunk(fileIndex, chunkIndex);
      assertCurrent(); receiver.accept(chunk);
    }
  }
  const files = receiver.finish(); requireFact(files);
  await validateRepositoryReleaseMetadata({ scope: {
    organizationId: scope.organizationId, repositoryBindingId: scope.repositoryBindingId, repositoryAgentId: scope.repositoryAgentId,
    generation: descriptor.generation as number, policyHash: descriptor.policyHash as string,
    sourceSnapshotHash: descriptor.sourceSnapshotHash as string, sourceManifestHash: descriptor.sourceManifestHash as string,
    sourceLocalCatalogHash: descriptor.sourceLocalCatalogHash as string, catalogHash: descriptor.catalogHash as string,
    manifestHash: descriptor.manifestHash as string,
  }, files });
  assertCurrent();
  return { files, bundle, envelope, index, assertCurrent };
}
