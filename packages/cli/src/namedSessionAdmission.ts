import {randomUUID} from 'node:crypto';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$(?![\s\S])/i;

// The fence is checked in the same event-loop turn that admits local work or an inbox poll.
// It never expires automatically: only its owner can resume it, or stop the drained service.
export class NamedSessionAdmission {
  readonly #generation = randomUUID();
  #fenceId: string | null = null;
  #drained = false;
  #stopped = false;
  #transition: 'quiescing' | 'resuming' | 'stopping' | null = null;
  #pending = 0;
  #serial: Promise<void> = Promise.resolve();

  snapshot() {
    const state = this.#transition ?? (this.#fenceId ? this.#drained ? 'quiesced' as const : 'draining' as const : 'open' as const);
    return {generation:this.#generation, fenceId:this.#fenceId, state, pending:this.#pending};
  }

  enqueue<T>(operation: () => Promise<T>, settled: () => Promise<void> = async () => {}): Promise<T> {
    if (this.#stopped) return Promise.reject(new Error('named_session_stopped'));
    if (this.#fenceId) return Promise.reject(new Error('named_session_quiesced'));
    if (this.#pending >= 8) return Promise.reject(new Error('named_session_busy'));
    this.#pending++;
    const result = this.#serial.then(async () => {
      try {
        if (this.#stopped) throw new Error('named_session_stopped');
        return await operation();
      } finally {
        this.#pending--;
        await settled();
      }
    });
    this.#serial = result.then(() => undefined, () => undefined);
    return result;
  }

  #check(fenceId: string, generation: string) {
    if (!uuid.test(fenceId)) throw new Error('named_session_fence_invalid');
    if (generation !== this.#generation) throw new Error('named_session_generation_changed');
    if (this.#stopped) throw new Error('named_session_stopped');
    if (this.#transition) throw new Error('named_session_maintenance_busy');
  }

  async quiesce(fenceId: string, generation: string, persist: () => Promise<void> = async () => {}) {
    this.#check(fenceId, generation);
    if (this.#fenceId && this.#fenceId !== fenceId) throw new Error('named_session_fence_conflict');
    this.#fenceId = fenceId;
    await this.#serial;
    this.#check(fenceId, generation);
    if (this.#fenceId !== fenceId) throw new Error('named_session_fence_conflict');
    if (this.#pending !== 0) throw new Error('named_session_not_drained');
    this.#drained = true;
    this.#transition = 'quiescing';
    try {
      await persist();
      return {generation:this.#generation, fenceId, state:'quiesced' as const, pending:0};
    } finally { this.#transition = null; }
  }

  #checkDrained(fenceId: string, generation: string) {
    this.#check(fenceId, generation);
    if (this.#fenceId !== fenceId) throw new Error('named_session_fence_conflict');
    if (!this.#drained || this.#pending !== 0) throw new Error('named_session_not_drained');
  }

  async resume(fenceId: string, generation: string, persist: () => Promise<void> = async () => {}) {
    this.#checkDrained(fenceId, generation);
    this.#transition = 'resuming';
    try {
      await persist();
      this.#fenceId = null;
      this.#drained = false;
    } finally { this.#transition = null; }
  }

  async stopDrained(fenceId: string, generation: string, verifyDurablePause: () => Promise<void> = async () => {}) {
    this.#checkDrained(fenceId, generation);
    this.#transition = 'stopping';
    try {
      await verifyDurablePause();
      this.#stopped = true;
    } finally { this.#transition = null; }
  }

  stop() {
    if (this.#fenceId) throw new Error('named_session_fence_required');
    this.#stopped = true;
  }

  settled() { return this.#serial; }
}
