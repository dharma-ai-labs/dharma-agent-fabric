import { createHash } from 'node:crypto';
import { canonicalize } from '@dharma-ai-labs/agent-fabric-contracts';
import { inventoryRepositoryPackage, readRepositoryPackageSnapshot, readRepositorySourceBaselineSnapshot,
  writeRepositoryPackageSnapshot } from './repositoryPackage.js';
import { parseRepositorySourcePolicyResponse, validateRepositorySourceAuthorization, type RepositorySourceScope } from './repositorySourceAuthorization.js';
import type { RepositoryPackageSnapshot } from './repositoryPackage.js';
import { fetchPublishedRepositorySource } from './repositorySourceInventoryClient.js';
import { reconcileRepositorySourceSnapshot } from './repositorySourceReconciliation.js';

type SourceTransport = { signedGet(route: string): Promise<Record<string, unknown>> };
export type BoundRepositorySource = RepositorySourceScope & {
  repositoryBindingId: string;
  repositoryAgentId: string;
};

export function advanceRepositorySourceBaseline(record: {
  localBaselineSnapshotHash?: string | null;
  publishedLocalSnapshotHash?: string | null;
  pendingLocalSnapshotHash?: string | null;
  pendingLocalOperationId?: string | null;
}, receipt: { state: string; operationId: string }) {
  if (record.pendingLocalOperationId && record.pendingLocalOperationId !== receipt.operationId) {
    throw new Error('Repository source candidate receipt does not match the pending operation.');
  }
  const matchesPending = record.pendingLocalOperationId === receipt.operationId;
  const terminal = receipt.state === 'published' || receipt.state === 'blocked';
  const publishedLocalSnapshotHash = receipt.state === 'published' && matchesPending
    ? record.pendingLocalSnapshotHash ?? null : record.publishedLocalSnapshotHash ?? null;
  return {
    localBaselineSnapshotHash: receipt.state === 'blocked' && matchesPending
      ? publishedLocalSnapshotHash : record.localBaselineSnapshotHash ?? null,
    publishedLocalSnapshotHash,
    pendingLocalSnapshotHash: terminal ? null : record.pendingLocalSnapshotHash ?? null,
    pendingLocalOperationId: terminal ? null : record.pendingLocalOperationId ?? null,
  };
}

export async function recoverPublishedLocalSourceBaseline(input: BoundRepositorySource & {
  workspace: string;
  record: { state: string; snapshotHash?: string | null; pendingLocalOperationId?: string | null };
}): Promise<string | null> {
  const { record } = input;
  if (record.state !== 'published' || record.pendingLocalOperationId || !record.snapshotHash) return null;
  if (!HASH.test(record.snapshotHash)) throw new Error('Published repository source baseline hash is invalid.');
  let snapshot: RepositoryPackageSnapshot;
  try { snapshot = await readRepositoryPackageSnapshot(input.workspace, record.snapshotHash); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    if (error instanceof SyntaxError || error instanceof TypeError) {
      throw new Error('Published repository source baseline integrity failed.', { cause: error });
    }
    throw error;
  }
  const manifest = snapshot.manifest;
  if (manifest.organizationId !== input.organizationId || manifest.workspaceId !== input.workspaceId
    || manifest.sourceAuthorization?.repositoryBindingId !== input.repositoryBindingId
    || manifest.sourceAuthorization?.repositoryAgentId !== input.repositoryAgentId) {
    throw new Error('Published repository source baseline scope is invalid.');
  }
  return record.snapshotHash;
}
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$(?![\s\S])/i;
const HASH = /^sha256:[a-f0-9]{64}$(?![\s\S])/;

export async function fetchRepositorySourceAuthorization(transport: SourceTransport, scope: BoundRepositorySource) {
  if (typeof scope.organizationId !== 'string' || !scope.organizationId
    || [scope.workspaceId, scope.repositoryBindingId, scope.repositoryAgentId].some(value => typeof value !== 'string' || !UUID.test(value))) {
    throw new Error('Repository source read requires a complete bound identity.');
  }
  const response = await transport.signedGet(`/agent-fabric/repository-source-policy?workspaceId=${encodeURIComponent(scope.workspaceId)}`);
  return parseRepositorySourcePolicyResponse(response, scope, new Date());
}

// This observes local immutable candidates only; it never grants publication or
// activates native skills. The caller polls serially with a monotonic clock.
export class RepositorySourceWatcher {
  #candidate: { fingerprint: string; since: number } | null = null;
  #completed: string | null = null;
  #lastTime = 0;
  readonly debounceMs: number;
  constructor(debounceMs = 15000) {
    if (!Number.isSafeInteger(debounceMs) || debounceMs < 1000 || debounceMs > 60000) throw new Error('Invalid repository source debounce.');
    this.debounceMs = debounceMs;
  }
  seed(fingerprint: string) {
    if (!HASH.test(fingerprint) || this.#candidate || this.#lastTime !== 0) {
      throw new Error('Invalid repository source baseline.');
    }
    this.#completed = fingerprint;
  }
  observe(fingerprint: string, now: number): 'unchanged' | 'debouncing' | 'stable' {
    if (!HASH.test(fingerprint) || !Number.isFinite(now) || now < this.#lastTime) {
      this.invalidate();
      throw new Error('Invalid repository source observation.');
    }
    this.#lastTime = now;
    if (fingerprint === this.#completed) { this.#candidate = null; return 'unchanged'; }
    if (this.#candidate?.fingerprint !== fingerprint) {
      this.#candidate = { fingerprint, since: now };
      return 'debouncing';
    }
    return now - this.#candidate.since >= this.debounceMs ? 'stable' : 'debouncing';
  }
  complete(fingerprint: string) {
    if (!this.#candidate || this.#candidate.fingerprint !== fingerprint
      || this.#lastTime - this.#candidate.since < this.debounceMs) throw new Error('Repository source completion conflicts with its observation.');
    this.#completed = fingerprint;
    this.#candidate = null;
  }
  invalidate() { this.#candidate = null; this.#completed = null; this.#lastTime = 0; }
}

export async function seedRepositorySourceWatcher(input: BoundRepositorySource & {
  workspace: string;
  publishedHash: string;
  localHash?: string | null;
  watcher: RepositorySourceWatcher;
}) {
  const snapshot = input.localHash
    ? await readRepositoryPackageSnapshot(input.workspace, input.localHash)
    : await readRepositorySourceBaselineSnapshot(input.workspace, input.publishedHash);
  const manifest = snapshot.manifest;
  if (manifest.organizationId !== input.organizationId || manifest.workspaceId !== input.workspaceId
    || manifest.sourceAuthorization?.repositoryBindingId !== input.repositoryBindingId
    || manifest.sourceAuthorization?.repositoryAgentId !== input.repositoryAgentId
    || !manifest.sourceFingerprint) throw new Error('Repository source baseline scope is invalid.');
  input.watcher.seed(manifest.sourceFingerprint);
}

export class BlockedRepositorySourceRetry {
  #attempted = new Set<string>();
  consider(candidateId: string, knowledge: { authority: 'locally_initialized_unsigned' }
    | { authority: 'unverified_prior_release_reference'; priorRelease: { catalogHash: string; manifestHash: string } } | undefined,
  installed: { catalogBytes: Buffer; manifestBytes: Buffer } | null): boolean {
    if (!candidateId || !knowledge || !installed) return false;
    const catalogHash = `sha256:${createHash('sha256').update(installed.catalogBytes).digest('hex')}`;
    const manifestHash = `sha256:${createHash('sha256').update(installed.manifestBytes).digest('hex')}`;
    if (knowledge.authority === 'unverified_prior_release_reference'
      && knowledge.priorRelease.catalogHash === catalogHash && knowledge.priorRelease.manifestHash === manifestHash) return false;
    const key = `${candidateId}:${catalogHash}:${manifestHash}`;
    if (this.#attempted.has(key)) return false;
    this.#attempted.add(key);
    return true;
  }
}

export async function scanRepositorySourceChanges(input: BoundRepositorySource & {
  workspace: string;
  transport: SourceTransport;
  watcher: RepositorySourceWatcher;
  monotonicNow?: () => number;
  loadRetainedKnowledge?: () => Promise<{ catalogBytes: Buffer; manifestBytes: Buffer } | null>;
  loadPublishedLocalBaseline?: () => Promise<RepositoryPackageSnapshot | null>;
  submitCandidate?: (snapshot: RepositoryPackageSnapshot,
    expectedLatestSourceFingerprint?: string) => Promise<Record<string, unknown>>;
}) {
  try {
    const authorization = await fetchRepositorySourceAuthorization(input.transport, input);
    const observed = input.loadRetainedKnowledge ? await input.loadRetainedKnowledge() : null;
    if (observed && ![observed.catalogBytes, observed.manifestBytes].every(bytes => Buffer.isBuffer(bytes) && bytes.length > 0 && bytes.length <= 262144)) {
      throw new Error('Verified repository knowledge byte limit exceeded.');
    }
    const retainedKnowledge = observed ? { catalogBytes: Buffer.from(observed.catalogBytes), manifestBytes: Buffer.from(observed.manifestBytes) } : null;
    const local = await inventoryRepositoryPackage({ ...input, retainedKnowledge, sourceAuthorization: authorization });
    const fingerprint = local.manifest.sourceFingerprint;
    if (!fingerprint) throw new Error('Governed repository source scan returned no fingerprint.');
    const state = input.watcher.observe(fingerprint, (input.monotonicNow || (() => performance.now()))());
    if (state !== 'stable') return { state, localMutation: false, sharedAuthority: 'pending' as const };
    const current = await fetchRepositorySourceAuthorization(input.transport, input);
    if (canonicalize(current) !== canonicalize(authorization)) throw new Error('Repository source policy changed during collection.');
    validateRepositorySourceAuthorization(current, input, new Date());
    if (input.loadRetainedKnowledge) {
      const next = await input.loadRetainedKnowledge();
      if (!!retainedKnowledge !== !!next || (retainedKnowledge && next
        && (!retainedKnowledge.catalogBytes.equals(next.catalogBytes) || !retainedKnowledge.manifestBytes.equals(next.manifestBytes)))) {
        throw new Error('Verified repository knowledge release changed during collection.');
      }
    }
    const published = input.loadPublishedLocalBaseline
      ? await fetchPublishedRepositorySource({ transport: input.transport, scope: input,
        authorization, local }) : null;
    const snapshot = input.loadPublishedLocalBaseline
      ? reconcileRepositorySourceSnapshot({ local,
        previousLocal: await input.loadPublishedLocalBaseline(), published }) : local;
    const persisted = await writeRepositoryPackageSnapshot({ workspace: input.workspace, snapshot: local,
      candidateOnly: true });
    if (published && snapshot.manifest.sourceFingerprint === published.sourceFingerprint) {
      input.watcher.complete(fingerprint);
      return { state: 'source_already_published' as const, localMutation: true,
        sharedAuthority: 'verified_existing' as const, snapshotId: snapshot.manifest.snapshotId,
        fingerprint, persisted, candidate: null };
    }
    if (snapshot.manifest.snapshotHash !== local.manifest.snapshotHash) {
      await writeRepositoryPackageSnapshot({ workspace: input.workspace, snapshot, candidateOnly: true });
    }
    const candidate = input.submitCandidate
      ? await input.submitCandidate(snapshot, published?.sourceFingerprint) : null;
    input.watcher.complete(fingerprint);
    return { state: 'local_candidate_collected' as const, localMutation: true, sharedAuthority: 'pending' as const,
      snapshotId: snapshot.manifest.snapshotId, fingerprint, persisted, candidate,
      submittedManifestHash: `sha256:${createHash('sha256').update(canonicalize(snapshot.manifest)).digest('hex')}` };
  } catch (error) {
    input.watcher.invalidate();
    throw error;
  }
}
