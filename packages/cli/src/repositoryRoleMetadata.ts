import { types } from 'node:util';
import { createHash, randomUUID } from 'node:crypto';
import { canonicalize } from '@dharma-ai-labs/agent-fabric-contracts';

export type RepositoryRoleScope = {
  organizationId: string;
  workspaceId: string;
  repositoryBindingId: string;
  repositoryAgentId: string;
  endpointId: string;
  sourceFingerprint: string;
};
export type RepositoryRoleInput = {
  expectedRevision: number;
  roleName: string;
  questionCategories: string[];
  description: string;
};
export type RepositoryRoleTransport = {
  signedGet(route: string): Promise<Record<string, unknown>>;
  signedPost(route: string, body: unknown): Promise<Record<string, unknown>>;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$(?![\s\S])/i;
const CATEGORY = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$(?![\s\S])/;
const CONTROL = /[\u0000-\u001f\u007f]/;
const SECRET = /-----BEGIN[^\r\n]*PRIVATE KEY-----|\b(?:gh[pousr]_|github_pat_|sk_live_|sk_test_)[A-Za-z0-9_]{12,}|\bBearer\s+[A-Za-z0-9_.+-]{8,}|\b(?:password|api[_-]?key|access[_-]?token|client[_-]?secret)\s*[:=]\s*\S{8,}|[A-Za-z]:[\\/]|\/(?:home|Users)\//i;
type Kind = 'scope' | 'input' | 'response';
function invalid(kind: Kind): never { throw new Error(`Repository role ${kind} does not match the metadata contract.`); }

// Clone only bounded plain data before inspecting fields or invoking serialization.
function data(value: unknown, kind: Kind): unknown {
  let nodes = 0;
  const seen = new Set<object>();
  function visit(item: unknown, depth: number): unknown {
    if (++nodes > 4096 || depth > 8) invalid(kind);
    if (item === null || typeof item === 'boolean') return item;
    if (typeof item === 'string') { if (item.length > 2048) invalid(kind); return item; }
    if (typeof item === 'number') { if (!Number.isSafeInteger(item)) invalid(kind); return item; }
    if (typeof item !== 'object' || types.isProxy(item) || seen.has(item)) invalid(kind);
    const prototype = Object.getPrototypeOf(item);
    if (Array.isArray(item) ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) invalid(kind);
    if (Object.getOwnPropertyDescriptor(Object.prototype, 'toJSON') || Object.getOwnPropertyDescriptor(Array.prototype, 'toJSON')) invalid(kind);
    const descriptors = Object.getOwnPropertyDescriptors(item);
    if (Reflect.ownKeys(item).some(key => typeof key !== 'string')
      || Object.values(descriptors).some(descriptor => !Object.hasOwn(descriptor, 'value'))) invalid(kind);
    seen.add(item);
    try {
      if (Array.isArray(item)) {
        if (item.length > 50 || Object.keys(descriptors).length !== item.length + 1) invalid(kind);
        const result: unknown[] = [];
        for (let index = 0; index < item.length; index += 1) {
          const descriptor = descriptors[String(index)];
          if (!descriptor || !descriptor.enumerable) invalid(kind);
          result.push(visit(descriptor.value, depth + 1));
        }
        return result;
      }
      const result: Record<string, unknown> = Object.create(null);
      for (const [key, descriptor] of Object.entries(descriptors)) {
        if (!descriptor.enumerable || key.length > 128 || ['__proto__', 'constructor', 'prototype', 'toJSON'].includes(key)) invalid(kind);
        result[key] = visit(descriptor.value, depth + 1);
      }
      return result;
    } finally { seen.delete(item); }
  }
  const result = visit(value, 0);
  if (Buffer.byteLength(JSON.stringify(result), 'utf8') > 524288) invalid(kind);
  return result;
}
function fields(value: unknown, names: string[], kind: Kind, optional: string[] = []) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(kind);
  const result = value as Record<string, unknown>;
  if (names.some(name => !Object.hasOwn(result, name)) || Object.keys(result).some(name => !names.includes(name) && !optional.includes(name))) invalid(kind);
  return result;
}
function identifier(value: unknown, kind: Kind): string {
  if (typeof value !== 'string' || !UUID.test(value)) invalid(kind);
  return value.toLowerCase();
}
function scopeValue(value: RepositoryRoleScope): RepositoryRoleScope {
  const scope = fields(data(value, 'scope'), ['organizationId', 'workspaceId', 'repositoryBindingId', 'repositoryAgentId', 'endpointId', 'sourceFingerprint'], 'scope');
  if (typeof scope.organizationId !== 'string' || !/^[A-Za-z0-9_:-]{1,120}$(?![\s\S])/.test(scope.organizationId)
    || typeof scope.sourceFingerprint !== 'string' || !/^sha256:[a-f0-9]{64}$(?![\s\S])/.test(scope.sourceFingerprint)) invalid('scope');
  return { organizationId: scope.organizationId, sourceFingerprint: scope.sourceFingerprint,
    workspaceId: identifier(scope.workspaceId, 'scope'), endpointId: identifier(scope.endpointId, 'scope'),
    repositoryBindingId: identifier(scope.repositoryBindingId, 'scope'), repositoryAgentId: identifier(scope.repositoryAgentId, 'scope') };
}
function text(value: unknown, maximum: number, kind: Kind): string {
  if (typeof value !== 'string' || !value.length || value.length > maximum || value.trim() !== value || CONTROL.test(value) || SECRET.test(value)) invalid(kind);
  return value;
}
function categories(value: unknown, kind: Kind): string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 16
    || value.some(category => typeof category !== 'string' || category.length > 64 || !CATEGORY.test(category))
    || new Set(value).size !== value.length) invalid(kind);
  return [...value as string[]].sort();
}
function profile(value: Record<string, unknown>, kind: Kind) {
  return { roleName: text(value.roleName, 80, kind), description: text(value.description, 1024, kind), questionCategories: categories(value.questionCategories, kind) };
}
function inputValue(value: RepositoryRoleInput): RepositoryRoleInput {
  const input = fields(data(value, 'input'), ['expectedRevision', 'roleName', 'questionCategories', 'description'], 'input');
  if (!Number.isSafeInteger(input.expectedRevision) || Number(input.expectedRevision) < 0 || Number(input.expectedRevision) > 2147483646) invalid('input');
  return { expectedRevision: Number(input.expectedRevision), ...profile(input, 'input') };
}
function responseValue(value: unknown, scope: RepositoryRoleScope, operation: 'registration' | 'discovery') {
  const response = fields(data(value, 'response'), ['ok', 'organizationId', operation], 'response', ['correlationId']);
  if (response.ok !== true || response.organizationId !== scope.organizationId
    || ('correlationId' in response && (typeof response.correlationId !== 'string' || response.correlationId.length > 128 || CONTROL.test(response.correlationId)))) invalid('response');
  return response[operation];
}
function revision(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1 || Number(value) > 2147483647) invalid('response');
  return Number(value);
}
function canonicalProfile(value: Record<string, unknown>) {
  const result = profile(value, 'response');
  if (JSON.stringify(value.questionCategories) !== JSON.stringify(result.questionCategories)) invalid('response');
  return result;
}
function observation(scope: RepositoryRoleScope, operation: 'register' | 'discover', role: Record<string, unknown> | null, discovery: Record<string, unknown> | null) {
  return {
    schema: 'dharma.repository-role-metadata/v1' as const,
    organizationId: scope.organizationId,
    observationId: randomUUID(),
    observedAt: new Date().toISOString(),
    integrity: { kind: 'local_hash_not_signature', sha256: `sha256:${createHash('sha256').update(canonicalize({ scope, operation, role, discovery })).digest('hex')}` },
    scope,
    operation,
    stage: 'repository_role_observed',
    role,
    discovery,
    sharedRepositoryReady: false,
    communicationReady: false,
    sourceFingerprintVerified: false,
    currentAuthorizationVerified: false,
    contactAuthority: false,
    presence: 'unavailable',
    limitations: ['source_fingerprint_unavailable', 'current_authorization_not_independently_verified', 'presence_unavailable', 'contact_authority_unavailable'],
  };
}

export async function registerRepositoryRoleMetadata(
  transport: RepositoryRoleTransport, scope: RepositoryRoleScope, input: RepositoryRoleInput,
) {
  const bound = scopeValue(scope), requested = inputValue(input);
  const response = await transport.signedPost('/agent-fabric/repository-roles', {
    workspaceId: bound.workspaceId, endpointId: bound.endpointId, ...requested, questionCategories: [...requested.questionCategories],
  });
  const registration = fields(responseValue(response, bound, 'registration'), ['role', 'revision', 'replay'], 'response');
  const role = fields(registration.role, ['organizationId', 'workspaceId', 'endpointId', 'repositoryBindingId', 'repositoryAgentId', 'roleName', 'questionCategories', 'description', 'revision'], 'response');
  for (const key of ['organizationId', 'workspaceId', 'endpointId', 'repositoryBindingId', 'repositoryAgentId'] as const) {
    if (role[key] !== bound[key]) invalid('response');
  }
  const accepted = { ...canonicalProfile(role), revision: revision(role.revision) };
  if (accepted.revision !== requested.expectedRevision + 1 || registration.revision !== accepted.revision
    || typeof registration.replay !== 'boolean'
    || JSON.stringify(accepted.questionCategories) !== JSON.stringify(requested.questionCategories)
    || accepted.roleName !== requested.roleName || accepted.description !== requested.description) invalid('response');
  return observation(bound, 'register', { ...role, ...accepted }, null);
}

export async function discoverRepositoryRoleMetadata(
  transport: RepositoryRoleTransport, scope: RepositoryRoleScope, category?: string,
) {
  const bound = scopeValue(scope);
  if (category !== undefined && (typeof category !== 'string' || category.length > 64 || !CATEGORY.test(category))) invalid('input');
  // signedGet binds the empty wire body and exact query. The server constructs
  // its separate protocol-receipt payload after verifying that signature.
  const route = `/agent-fabric/repository-roles?workspaceId=${encodeURIComponent(bound.workspaceId)}`
    + (category === undefined ? '' : `&category=${encodeURIComponent(category)}`);
  const response = await transport.signedGet(route);
  const discovery = fields(responseValue(response, bound, 'discovery'), ['organizationId', 'workspaceId', 'repositoryBindingId', 'repositoryAgentId', 'peers', 'limit', 'possiblyTruncated'], 'response');
  for (const key of ['organizationId', 'workspaceId', 'repositoryBindingId', 'repositoryAgentId'] as const) {
    if (discovery[key] !== bound[key]) invalid('response');
  }
  if (!Array.isArray(discovery.peers) || discovery.peers.length > 50 || discovery.limit !== 50
    || discovery.possiblyTruncated !== (discovery.peers.length === 50)) invalid('response');
  const endpoints = new Set<string>();
  const peers = discovery.peers.map(value => {
    const peer = fields(value, ['endpointId', 'workspaceId', 'provider', 'roleName', 'questionCategories', 'description', 'revision'], 'response');
    const endpointId = identifier(peer.endpointId, 'response'), workspaceId = identifier(peer.workspaceId, 'response');
    const accepted = canonicalProfile(peer);
    if (endpoints.has(endpointId) || typeof peer.provider !== 'string' || !['codex', 'claude', 'agy', 'hermes'].includes(peer.provider)
      || (endpointId === bound.endpointId && workspaceId !== bound.workspaceId)
      || (category !== undefined && !accepted.questionCategories.includes(category))) invalid('response');
    endpoints.add(endpointId);
    return { endpointId, workspaceId, provider: peer.provider, ...accepted, revision: revision(peer.revision) };
  });
  return observation(bound, 'discover', null, { peers, limit: 50, possiblyTruncated: discovery.possiblyTruncated,
    catalogComplete: !discovery.possiblyTruncated });
}
