import { canonicalize } from '@dharma-ai-labs/agent-fabric-contracts';
import { inventoryRepositoryPackage, writeRepositoryPackageSnapshot } from './repositoryPackage.js';
import { parseRepositorySourcePolicyResponse, validateRepositorySourceAuthorization, type RepositorySourceScope } from './repositorySourceAuthorization.js';
import type { RepositoryPackageSnapshot } from './repositoryPackage.js';

type SourceTransport = { signedGet(route: string): Promise<Record<string, unknown>> };
export type BoundRepositorySource = RepositorySourceScope & {
  repositoryBindingId: string;
  repositoryAgentId: string;
};
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

export async function scanRepositorySourceChanges(input: BoundRepositorySource & {
  workspace: string;
  transport: SourceTransport;
  watcher: RepositorySourceWatcher;
  monotonicNow?: () => number;
  loadRetainedKnowledge?: () => Promise<{ catalogBytes: Buffer; manifestBytes: Buffer } | null>;
  submitCandidate?: (snapshot: RepositoryPackageSnapshot) => Promise<Record<string, unknown>>;
}) {
  try {
    const authorization = await fetchRepositorySourceAuthorization(input.transport, input);
    const observed = input.loadRetainedKnowledge ? await input.loadRetainedKnowledge() : null;
    if (observed && ![observed.catalogBytes, observed.manifestBytes].every(bytes => Buffer.isBuffer(bytes) && bytes.length > 0 && bytes.length <= 262144)) {
      throw new Error('Verified repository knowledge byte limit exceeded.');
    }
    const retainedKnowledge = observed ? { catalogBytes: Buffer.from(observed.catalogBytes), manifestBytes: Buffer.from(observed.manifestBytes) } : null;
    const snapshot = await inventoryRepositoryPackage({ ...input, retainedKnowledge, sourceAuthorization: authorization });
    const fingerprint = snapshot.manifest.sourceFingerprint;
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
    const persisted = await writeRepositoryPackageSnapshot({ workspace: input.workspace, snapshot, candidateOnly: true });
    const candidate = input.submitCandidate ? await input.submitCandidate(snapshot) : null;
    input.watcher.complete(fingerprint);
    return { state: 'local_candidate_collected' as const, localMutation: true, sharedAuthority: 'pending' as const,
      snapshotId: snapshot.manifest.snapshotId, fingerprint, persisted, candidate };
  } catch (error) {
    input.watcher.invalidate();
    throw error;
  }
}
