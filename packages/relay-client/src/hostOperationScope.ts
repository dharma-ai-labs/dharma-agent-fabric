import type {SecureSecretStore} from '@dharma-ai-labs/agent-fabric-secure-store';

/** Supplied by the owning host, never by a task, model argument or saved approval. */
export interface HostOperationScope {
  signal: AbortSignal;
  current(): Promise<boolean>;
}

export class HostOperationFence {
  readonly signal: AbortSignal;
  readonly #withdrawn = new AbortController();
  readonly #current: () => Promise<boolean>;
  readonly #stores = new WeakMap<SecureSecretStore, SecureSecretStore>();
  constructor(scope: HostOperationScope) {
    try {
      if (!(scope?.signal instanceof AbortSignal) || typeof scope.current !== 'function') throw new Error();
      this.signal = AbortSignal.any([scope.signal, this.#withdrawn.signal]);
      this.#current = scope.current.bind(scope);
    } catch {throw new Error('relay_host_scope_unavailable');}
  }
  withdraw() {this.#withdrawn.abort();}
  async assert() {
    let allowed = false;
    try {allowed = !this.signal.aborted && await this.#current() === true && !this.signal.aborted;} catch {}
    if (!allowed) {this.withdraw(); throw new Error('relay_host_scope_unavailable');}
  }
  async step<T>(operation: () => Promise<T>): Promise<T> {
    await this.assert();
    try {const value = await operation(); await this.assert(); return value;}
    catch (error) {await this.assert(); throw error;}
  }
  store(raw: SecureSecretStore): SecureSecretStore {
    const existing = this.#stores.get(raw); if (existing) return existing;
    const guarded: SecureSecretStore = {backend: raw.backend,
      get: account => this.step(() => raw.get(account)),
      getFresh: account => this.step(() => (raw.getFresh ?? raw.get).call(raw, account)),
      put: (account, value) => this.step(() => raw.put(account, value)),
      delete: account => this.step(() => raw.delete(account))};
    this.#stores.set(raw, guarded); this.#stores.set(guarded, guarded);
    return guarded;
  }
}
