import { DatabaseSync } from 'node:sqlite';

// Reservations are retained after interruption: unknown provider cost is not zero.
export class NamedSessionBudget {
  #db: DatabaseSync;
  constructor(path: string, scope: string, maximumCents: number) {
    if (!scope || !Number.isSafeInteger(maximumCents) || maximumCents < 1 || maximumCents > 10000) {
      throw new Error('named_session_budget_invalid');
    }
    this.#db = new DatabaseSync(path);
    this.#db.exec(`pragma busy_timeout=5000;
      create table if not exists budget(scope text primary key, maximum_cents integer not null);
      create table if not exists reservations(request_id text primary key, cents integer not null, created_at text not null);
      create table if not exists work_receipts(request_id text primary key, state text not null,
        payload_hash text not null, updated_at text not null);`);
    this.#db.prepare('insert into budget(scope, maximum_cents) values (?, ?) on conflict do nothing').run(scope, maximumCents);
    const rows = this.#db.prepare('select scope, maximum_cents from budget').all();
    if (rows.length !== 1 || rows[0]!.scope !== scope || rows[0]!.maximum_cents !== maximumCents) {
      this.#db.close(); throw new Error('named_session_budget_conflict');
    }
  }
  status() {
    const cap = this.#db.prepare('select maximum_cents from budget').get()!;
    const used = this.#db.prepare('select coalesce(sum(cents), 0) as cents from reservations').get()!;
    return { maximumCents: Number(cap.maximum_cents), reservedCents: Number(used.cents), actualCents: null };
  }
  reserve(requestId: string, cents: number) {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(requestId) || !Number.isSafeInteger(cents) || cents < 1) return false;
    this.#db.exec('begin immediate');
    try {
      const used = this.status();
      if (this.#db.prepare('select 1 from reservations where request_id = ?').get(requestId)
        || used.reservedCents + cents > used.maximumCents) { this.#db.exec('commit'); return false; }
      this.#db.prepare('insert into reservations values (?, ?, ?)').run(requestId, cents, new Date().toISOString());
      this.#db.exec('commit'); return true;
    } catch (error) { this.#db.exec('rollback'); throw error; }
  }
  recoverInterruptedWork() {
    this.#db.prepare("update work_receipts set state='interrupted', updated_at=? where state='executing'")
      .run(new Date().toISOString());
  }
  beginWork(requestId: string, payloadHash: string) {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(requestId)) throw new Error('named_session_work_invalid');
    if (this.#db.prepare('select 1 from work_receipts where request_id=?').get(requestId)) {
      throw new Error('named_session_work_already_recorded');
    }
    this.#db.prepare("insert into work_receipts values (?, 'executing', ?, ?)")
      .run(requestId, payloadHash, new Date().toISOString());
  }
  finishWork(requestId: string, state: 'completed' | 'failed', payloadHash: string) {
    this.#db.prepare('update work_receipts set state=?, payload_hash=?, updated_at=? where request_id=?')
      .run(state, payloadHash, new Date().toISOString(), requestId);
  }
  lastWork() {
    const result = this.#db.prepare('select request_id, state, payload_hash, updated_at from work_receipts order by rowid desc limit 1').get();
    return result ? { workId: result.request_id, state: result.state, receiptHash: result.payload_hash, updatedAt: result.updated_at } : null;
  }
  close() { this.#db.close(); }
}
