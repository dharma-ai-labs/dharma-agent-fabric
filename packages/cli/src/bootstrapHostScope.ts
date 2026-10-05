import {isAbsolute, resolve} from 'node:path';
import {AsyncLocalStorage} from 'node:async_hooks';
import type {CodexSetupIntent} from './codexSetupAdmission.js';

export interface CodexBootstrapHostInput {
  intent: Readonly<CodexSetupIntent>;
  workspace: string;
  signal: AbortSignal;
  /** The owning native host requalifies its binding, package and source policy. */
  current(): Promise<boolean>;
  dryRun?: boolean;
}
export interface BootstrapHostScope {
  signal: AbortSignal;
  current(): Promise<boolean>;
  assert(): Promise<void>;
  close(): void;
  step<T>(operation: () => Promise<T>): Promise<T>;
}

function plain(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  try {
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (Reflect.ownKeys(descriptors).some(key => typeof key !== 'string' || !Object.hasOwn(descriptors[key]!, 'value'))) return null;
    return Object.fromEntries(Object.entries(descriptors).map(([key, field]) => [key, field.value]));
  } catch {return null;}
}

export function prepareCodexBootstrapHost(input: CodexBootstrapHostInput) {
  const invalid = (): never => {throw new Error('codex_setup_host_scope_invalid');};
  const outer = plain(input), record = plain(outer?.intent);
  const keys = ['schema', 'operationId', 'setupReference', 'organizationId', 'recipientMembershipId', 'origin',
    'repositoryFingerprint', 'policyRevision', 'scopeDigest', 'contractDigest', 'hostContextId', 'issuedAt', 'expiresAt'];
  if (!outer || Object.keys(outer).some(key => !['intent', 'workspace', 'signal', 'current', 'dryRun'].includes(key))
    || !record || Object.keys(record).length !== keys.length || Object.keys(record).some(key => !keys.includes(key))
    || Object.values(record).some(value => typeof value !== 'string')
    || !(outer.signal instanceof AbortSignal) || typeof outer.current !== 'function'
    || typeof outer.workspace !== 'string' || !isAbsolute(outer.workspace) || resolve(outer.workspace) !== outer.workspace
    || outer.dryRun !== undefined && typeof outer.dryRun !== 'boolean') return invalid();
  const intent = Object.freeze({...record}) as unknown as Readonly<CodexSetupIntent>;
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$(?![\s\S])/;
  const hash = /^sha256:[a-f0-9]{64}$(?![\s\S])/;
  const issued = Date.parse(intent.issuedAt), expires = Date.parse(intent.expiresAt);
  let origin: URL; try {origin = new URL(intent.origin);} catch {return invalid();}
  if (intent.schema !== 'dharma.codex-setup-intent/v1'
    || ![intent.operationId, intent.setupReference, intent.recipientMembershipId, intent.hostContextId].every(value => uuid.test(value))
    || !/^org_[A-Za-z0-9]+$(?![\s\S])/.test(intent.organizationId)
    || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$(?![\s\S])/.test(intent.policyRevision)
    || ![intent.repositoryFingerprint, intent.scopeDigest, intent.contractDigest].every(value => hash.test(value))
    || origin.protocol !== 'https:' || origin.username || origin.password || origin.origin !== intent.origin
    || !Number.isFinite(issued) || !Number.isFinite(expires) || expires <= issued || issued > Date.now()
    || expires - issued > 900_000 || expires <= Date.now()
    || new Date(issued).toISOString() !== intent.issuedAt || new Date(expires).toISOString() !== intent.expiresAt) return invalid();
  const withdrawn = new AbortController();
  const signal = AbortSignal.any([outer.signal as AbortSignal, withdrawn.signal, AbortSignal.timeout(Math.max(1, expires - Date.now()))]);
  const requalify = outer.current as () => Promise<boolean>;
  const scope: BootstrapHostScope = {
    signal,
    async current() {
      if (signal.aborted || Date.now() < issued || Date.now() >= expires) {withdrawn.abort(); return false;}
      let valid = false;
      try {valid = await requalify() === true;} catch { /* Withhold host/private diagnostics. */ }
      valid = valid && !signal.aborted && Date.now() >= issued && Date.now() < expires;
      if (!valid) withdrawn.abort();
      return valid;
    },
    async assert() {if (!await scope.current()) throw new Error('codex_setup_host_scope_unavailable');},
    async step(operation) {
      await scope.assert();
      try {const result = await operation(); await scope.assert(); return result;}
      catch (error) {await scope.assert(); throw error;}
    },
    close() {withdrawn.abort();},
  };
  Object.freeze(scope);
  const flags = new Map<string, string | boolean>([
    ['portal-url', intent.origin], ['organization-id', intent.organizationId], ['workspace', outer.workspace],
    ['provider', 'codex'], ['complete', true], ['setup-reference', intent.setupReference],
    ['setup-recipient-membership-id', intent.recipientMembershipId], ['setup-scope-digest', intent.scopeDigest],
    ['setup-contract-digest', intent.contractDigest], ['policy-revision', intent.policyRevision],
  ]);
  if (outer.dryRun === true) flags.set('dry-run', true);
  return {intent, flags, scope};
}

const hostContext = new AsyncLocalStorage<Readonly<{scope: BootstrapHostScope; workspace: string; fingerprint: string}>>();

/** Closed descendants retain the closed scope, never a legacy unscoped fallback. */
export function currentBootstrapHostScope(): BootstrapHostScope | undefined {
  return hostContext.getStore()?.scope;
}

export async function assertBootstrapHostSource(workspace: string, fingerprint: string): Promise<void> {
  const owning = hostContext.getStore();
  if (!owning) return;
  await owning.scope.assert();
  if (workspace !== owning.workspace || fingerprint !== owning.fingerprint) {
    owning.scope.close();
    throw new Error('codex_setup_host_source_mismatch');
  }
}

export async function runCodexBootstrapHost<T>(input: CodexBootstrapHostInput,
  operation: (prepared: ReturnType<typeof prepareCodexBootstrapHost>) => Promise<T>): Promise<T> {
  if (hostContext.getStore()) throw new Error('codex_setup_host_context_conflict');
  const prepared = prepareCodexBootstrapHost(input);
  const owning = Object.freeze({scope: prepared.scope, workspace: String(prepared.flags.get('workspace')),
    fingerprint: prepared.intent.repositoryFingerprint});
  try {
    return await hostContext.run(owning, () => prepared.scope.step(() => operation(prepared)));
  } finally {prepared.scope.close();}
}
