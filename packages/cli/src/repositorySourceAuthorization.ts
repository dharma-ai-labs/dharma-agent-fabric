import { createHash } from 'node:crypto';
import { types } from 'node:util';
import { canonicalize } from '@dharma-ai-labs/agent-fabric-contracts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$(?![\s\S])/;
const CLASSES = ['approved_outputs', 'repository_content', 'repository_skills'] as const;
const SKILL_ROOTS = ['.agents/skills', '.claude/skills', '.codex/skills', 'skills'];
export type RepositorySourceClass = typeof CLASSES[number];
export interface RepositorySourceScope {
  organizationId: string;
  workspaceId: string;
  repositoryBindingId?: string | null;
  repositoryAgentId?: string | null;
}
export interface RepositorySourceAuthorization {
  schema: 'dharma.repository-source-authorization/v1';
  organizationId: string;
  workspaceId: string;
  repositoryBindingId: string;
  repositoryAgentId: string;
  revision: number;
  generationId: string;
  receiptId: string;
  policyRevision: string;
  policyHash: string;
  confirmedAt: string;
  policy: {
    action: 'authorize'; confirmed: true; requestId: string; repositoryBindingId: string; expectedRevision: number;
    allowedContentClasses: RepositorySourceClass[]; approvedRepositoryPaths: string[]; approvedOutputFolders: string[];
    automaticValidatedPublication: true; retentionDays: number; maximumFileBytes: number; maximumSnapshotBytes: number;
    maximumDailyUploadBytes: number; expiresAt: string | null;
  };
}
function invalid(reason: string): never { throw new Error(`Repository source authorization ${reason}.`); }
function data(value: unknown, seen = new Set<object>(), depth = 0, budget = { remaining: 2048 }): void {
  if (--budget.remaining < 0 || depth > 6) invalid('structure limit exceeded');
  if (value === null || typeof value === 'boolean') return;
  if (typeof value === 'string') { if (value.length > 1024) invalid('string limit exceeded'); return; }
  if (typeof value === 'number') { if (!Number.isSafeInteger(value)) invalid('number is invalid'); return; }
  if (!value || typeof value !== 'object' || seen.has(value)) invalid('must be bounded JSON data');
  if (types.isProxy(value)) invalid('proxy is invalid');
  if (Object.getOwnPropertyDescriptor(Object.prototype, 'toJSON') || Object.getOwnPropertyDescriptor(Array.prototype, 'toJSON')) {
    invalid('inherited serialization hooks are invalid');
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null && prototype !== Array.prototype) invalid('prototype is invalid');
  const fields = Object.getOwnPropertyDescriptors(value);
  if (Object.getOwnPropertySymbols(value).length || Object.values(fields).some(field => !Object.hasOwn(field, 'value'))) invalid('accessors are invalid');
  if (Array.isArray(value) && (value.length > 2048 || Object.keys(fields).length !== value.length + 1
    || Object.keys(fields).some(key => key !== 'length' && (!/^(?:0|[1-9][0-9]*)$/.test(key) || Number(key) >= value.length)))) {
    invalid('array is not canonical');
  }
  seen.add(value);
  for (const [key, field] of Object.entries(fields)) {
    if (Array.isArray(value) && key === 'length') continue;
    if (key.length > 100) invalid('field limit exceeded');
    data(field.value, seen, depth + 1, budget);
  }
  seen.delete(value);
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid('object is required');
  return value as Record<string, unknown>;
}
function exact(value: Record<string, unknown>, keys: string[]) {
  if (Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) invalid('fields are invalid');
}
function integer(value: unknown, minimum: number, maximum: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum || value > maximum) invalid('quantity is invalid');
  return value;
}
function uuid(value: unknown): string {
  if (typeof value !== 'string' || !UUID.test(value)) invalid('identity is invalid');
  return value;
}
function timestamp(value: unknown): number {
  if (typeof value !== 'string' || value.length > 40
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$(?![\s\S])/.test(value)
    || !Number.isFinite(Date.parse(value))) invalid('timestamp is invalid');
  return Date.parse(value);
}
export function repositorySourcePathSafe(path: string): boolean {
  return path.length >= 1 && path.length <= 250 && path.split('/').every(part =>
    /^[A-Za-z0-9._ -]{1,160}$(?![\s\S])/.test(part) && part !== '.' && part !== '..' && !/[. ]$/.test(part)
    && !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)
    && !/^(?:\.env.*|\.netrc|\.npmrc|\.pypirc|\.git|\.dharma|\.dharma-managed|\.dharma-activation-.*|\.codex-pr-worktrees|node_modules|dist|build|\.ssh|\.aws|\.gnupg|id_rsa|id_ed25519)$/i.test(part)
    && !/(?:^|[._ -])(?:secrets?|credentials?|passwords?|private[-_ ]?keys?|keystore)(?:[._ -]|$)/i.test(part)
    && !/\.(?:pem|key|p12|pfx|jks|kdbx)$/i.test(part))
    && !SKILL_ROOTS.some(root => path.toLowerCase() === `${root}/dharma-agent-fabric`
      || path.toLowerCase().startsWith(`${root}/dharma-agent-fabric/`));
}
function paths(value: unknown, maximum: number, root: boolean, minimum: number): string[] {
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum
    || value.some(path => typeof path !== 'string' || !(root && path === '.') && !repositorySourcePathSafe(path))
    || new Set(value).size !== value.length) invalid('path scope is invalid');
  const result = value as string[];
  if (JSON.stringify([...result].sort()) !== JSON.stringify(result)) invalid('path scope is not canonical');
  return [...result];
}

// Structural provenance is not signing authority. The server must recheck the
// current grant before upload/publication; historical verification omits `now`.
export function validateRepositorySourceAuthorization(value: unknown, scope: RepositorySourceScope, now?: Date): RepositorySourceAuthorization {
  data(value);
  const body = record(value);
  exact(body, ['schema', 'organizationId', 'workspaceId', 'repositoryBindingId', 'repositoryAgentId', 'revision',
    'generationId', 'receiptId', 'policyRevision', 'policyHash', 'confirmedAt', 'policy']);
  if (body.schema !== 'dharma.repository-source-authorization/v1' || body.organizationId !== scope.organizationId
    || body.workspaceId !== scope.workspaceId || body.repositoryBindingId !== scope.repositoryBindingId
    || body.repositoryAgentId !== scope.repositoryAgentId) invalid('scope mismatch');
  uuid(body.workspaceId); uuid(body.repositoryBindingId); uuid(body.repositoryAgentId);
  const generation = uuid(body.generationId), revision = integer(body.revision, 1, 2147483646);
  if (body.receiptId !== `repo_consent_${generation}` || body.policyRevision !== `repository-source-${generation}`) invalid('receipt mismatch');
  const confirmed = timestamp(body.confirmedAt);
  const policy = record(body.policy);
  exact(policy, ['action', 'confirmed', 'requestId', 'repositoryBindingId', 'expectedRevision', 'allowedContentClasses',
    'approvedRepositoryPaths', 'approvedOutputFolders', 'automaticValidatedPublication', 'retentionDays',
    'maximumFileBytes', 'maximumSnapshotBytes', 'maximumDailyUploadBytes', 'expiresAt']);
  if (policy.action !== 'authorize' || policy.confirmed !== true || policy.repositoryBindingId !== body.repositoryBindingId
    || policy.expectedRevision !== revision - 1 || policy.automaticValidatedPublication !== true
    || JSON.stringify(policy.allowedContentClasses) !== JSON.stringify(CLASSES)) invalid('policy is invalid');
  uuid(policy.requestId);
  paths(policy.approvedRepositoryPaths, 64, true, 1); paths(policy.approvedOutputFolders, 32, false, 0);
  integer(policy.retentionDays, 1, 365);
  const maximumSnapshotBytes = integer(policy.maximumSnapshotBytes, 1, 4194304);
  integer(policy.maximumFileBytes, 1, Math.min(262144, maximumSnapshotBytes));
  integer(policy.maximumDailyUploadBytes, 1, 1073741824);
  if (policy.expiresAt !== null) {
    const expiry = timestamp(policy.expiresAt);
    if (new Date(expiry).toISOString() !== policy.expiresAt || expiry <= confirmed) invalid('policy expired or timestamp is invalid');
    if (now && expiry <= now.getTime()) invalid('policy expired');
  }
  if (now && (!Number.isFinite(now.getTime()) || confirmed > now.getTime() + 30000)) invalid('policy clock is invalid');
  const policyHash = `sha256:${createHash('sha256').update(canonicalize(policy)).digest('hex')}`;
  if (body.policyHash !== policyHash) invalid('policy hash mismatch');
  if (Buffer.byteLength(canonicalize(body)) > 32768) invalid('metadata limit exceeded');
  return structuredClone(body) as unknown as RepositorySourceAuthorization;
}

export function repositorySourcePathAllowed(authorization: RepositorySourceAuthorization, path: string, contentClass: RepositorySourceClass): boolean {
  if (!repositorySourcePathSafe(path) || !authorization.policy.allowedContentClasses.includes(contentClass)) return false;
  const roots = contentClass === 'repository_skills' ? SKILL_ROOTS
    : contentClass === 'approved_outputs' ? authorization.policy.approvedOutputFolders : authorization.policy.approvedRepositoryPaths;
  return roots.some(root => root === '.' || path === root || path.startsWith(`${root}/`));
}

export function parseRepositorySourcePolicyResponse(value: unknown, scope: RepositorySourceScope, now = new Date()): RepositorySourceAuthorization {
  data(value);
  const response = record(value), view = record(response.policy), current = record(view.current);
  if (response.ok !== true || response.organizationId !== scope.organizationId || view.organizationId !== scope.organizationId
    || view.repositoryBindingId !== scope.repositoryBindingId || view.repositoryAgentId !== scope.repositoryAgentId
    || current.active !== true || current.reason !== 'authorized') invalid('policy unavailable, inactive or foreign');
  return validateRepositorySourceAuthorization({ schema: 'dharma.repository-source-authorization/v1',
    organizationId: scope.organizationId, workspaceId: scope.workspaceId, repositoryBindingId: view.repositoryBindingId,
    repositoryAgentId: view.repositoryAgentId, revision: current.revision, generationId: current.generationId,
    receiptId: current.receiptId, policyRevision: current.policyRevision, policyHash: current.policyHash,
    confirmedAt: current.confirmedAt, policy: current.policy }, scope, now);
}
