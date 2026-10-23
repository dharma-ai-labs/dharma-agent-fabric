import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { isAbsolute } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Ajv2020 } from 'ajv/dist/2020.js';
import type { FormatsPlugin } from 'ajv-formats';
import { canonicalize, sha256 } from '@dharma-ai-labs/agent-fabric-contracts';

export interface LearningStudyIdentity {
  organizationId: string; agentId: string; endpointId: string; deviceId: string;
  workspaceId: string; provider: string; localAgentId: string;
}
export interface FiniteLearningStudyConfiguration {
  schema: 'dharma.finite-learning-study/v1'; studyId: string; identity: LearningStudyIdentity;
  admissionReceiptHash: string; predecessorHash: string; batchSize: 100; maxWindows: 1;
  expiresAt: string; maximumCents: number; phaseCaps: Record<string, number>;
}
interface Decision { ok: boolean; code: string; execute?: boolean; fence?: number; retained?: boolean }
const digest = (value: unknown) => sha256(canonicalize(value));
const id = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$(?![\s\S])/.test(value);
const hash = (value: unknown): value is string => typeof value === 'string' && /^sha256:[a-f0-9]{64}$(?![\s\S])/.test(value);
const cents = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
const timestamp = (value: unknown): number => {
  if (typeof value !== 'string') return Number.NaN;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value ? parsed : Number.NaN;
};
const ajv = new Ajv2020({ strict: true });
(createRequire(import.meta.url)('ajv-formats') as FormatsPlugin)(ajv);
const validate = ajv.compile(JSON.parse(readFileSync(
  new URL('./schemas/finite-learning-study.schema.json', import.meta.url), 'utf8')));

// This is accounting, not signature verification, source discovery or an API-effect runner.
// Callers must independently verify admission/receipts and use ONE canonical ledger for all executors.
export function planFiniteLearningStudy(input: unknown) {
  if (!validate(input) || !Number.isFinite(timestamp((input as FiniteLearningStudyConfiguration).expiresAt))) {
    throw new Error('finite_study_configuration_invalid');
  }
  const configuration = JSON.parse(canonicalize(input)) as FiniteLearningStudyConfiguration;
  return { configuration, configurationHash: digest(configuration), writes: false as const };
}

export class FiniteLearningStudyLedger {
  #db: DatabaseSync;
  #configuration: FiniteLearningStudyConfiguration;
  #configurationHash: string;
  #identity: string;
  #now: () => number;

  constructor(path: string, input: unknown, now: () => number = Date.now) {
    if (!isAbsolute(path) || path.includes('\0')) throw new Error('finite_study_durable_path_required');
    const plan = planFiniteLearningStudy(input);
    this.#configuration = plan.configuration;
    this.#configurationHash = plan.configurationHash;
    this.#identity = canonicalize(plan.configuration.identity);
    this.#now = now;
    this.#db = new DatabaseSync(path);
    try {
      this.#db.exec(`pragma busy_timeout=5000;
        create table if not exists finite_study(id integer primary key check(id=1), configuration_hash text not null,
          state text not null, reason text, last_observed integer not null, window_hash text);
        create table if not exists finite_trajectories(trajectory_id text primary key, receipt_hash text not null, ended_at text not null);
        create table if not exists finite_backlog(trajectory_id text primary key, receipt_hash text not null, ended_at text not null);
        create table if not exists finite_requests(fence integer primary key autoincrement, idempotency_key text unique not null,
          phase text unique not null, request_hash text not null, maximum_cents integer not null,
          state text not null, actual_cents integer, receipt_hash text);`);
      this.#transaction(() => {
        this.#db.prepare("insert into finite_study values(1, ?, 'collecting', null, 0, null) on conflict do nothing")
          .run(this.#configurationHash);
        const row = this.#row();
        if (row.configuration_hash !== this.#configurationHash) throw new Error('finite_study_configuration_conflict');
      });
    } catch (error) { this.#db.close(); throw error; }
  }

  #transaction<T>(operation: () => T): T {
    this.#db.exec('begin immediate');
    try { const value = operation(); this.#db.exec('commit'); return value; }
    catch (error) { this.#db.exec('rollback'); throw error; }
  }
  #row() { return this.#db.prepare('select * from finite_study where id=1').get()!; }
  #guard(): Decision | null {
    const row = this.#row(), now = this.#now();
    if (!Number.isSafeInteger(now) || now < Number(row.last_observed)) {
      this.#block('clock_regressed'); return { ok: false, code: 'clock_regressed' };
    }
    this.#db.prepare('update finite_study set last_observed=? where id=1').run(now);
    if (now >= Date.parse(this.#configuration.expiresAt)) {
      this.#db.prepare("update finite_study set state='stopped', reason='expired' where id=1").run();
      return { ok: false, code: 'expired' };
    }
    if (!['collecting', 'ready'].includes(String(row.state))) return { ok: false, code: String(row.state) };
    return null;
  }
  #block(reason: string) {
    this.#db.prepare("update finite_study set state='blocked', reason=? where id=1").run(reason);
  }
  status() {
    const row = this.#row();
    const cohort = this.#db.prepare('select trajectory_id, receipt_hash, ended_at from finite_trajectories order by trajectory_id').all()
      .map(record => ({ trajectoryId: String(record.trajectory_id), receiptHash: String(record.receipt_hash), endedAt: String(record.ended_at) }));
    const liability = this.#db.prepare('select coalesce(sum(coalesce(actual_cents,maximum_cents)),0) as cents from finite_requests').get()!;
    const pending = this.#db.prepare("select count(*) as count from finite_requests where state in ('reserved','unknown')").get()!;
    const backlog = this.#db.prepare('select count(*) as count from finite_backlog').get()!;
    return { state: String(row.state), reason: row.reason === null ? null : String(row.reason),
      configurationHash: this.#configurationHash, windowHash: row.window_hash === null ? null : String(row.window_hash),
      windowCount: row.window_hash === null ? 0 : 1, trajectoryCount: cohort.length, cohort,
      backlogCount: Number(backlog.count), liabilityCents: Number(liability.cents),
      maximumCents: this.#configuration.maximumCents, inFlight: Number(pending.count) };
  }

  recordCompleted(input: { identity: LearningStudyIdentity; trajectoryId: string; state: string;
    admissible: boolean; receiptHash: string; endedAt: string }): Decision {
    if (canonicalize(input.identity) !== this.#identity) return { ok: false, code: 'identity_mismatch' };
    if (input.state !== 'completed' || input.admissible !== true) return { ok: false, code: 'not_eligible' };
    if (!id(input.trajectoryId) || !hash(input.receiptHash) || !Number.isFinite(timestamp(input.endedAt))) {
      return { ok: false, code: 'invalid_trajectory' };
    }
    return this.#transaction(() => {
      const denied = this.#guard(); if (denied) return denied;
      if (timestamp(input.endedAt) > this.#now()) return { ok: false, code: 'future_trajectory' };
      const previous = this.#db.prepare(`select receipt_hash, ended_at from finite_trajectories where trajectory_id=?
        union all select receipt_hash, ended_at from finite_backlog where trajectory_id=?`).get(input.trajectoryId, input.trajectoryId);
      if (previous) {
        if (previous.receipt_hash !== input.receiptHash || previous.ended_at !== input.endedAt) {
          this.#block('trajectory_conflict'); return { ok: false, code: 'trajectory_conflict' };
        }
        return { ok: true, code: 'duplicate' };
      }
      if (this.#row().window_hash !== null) {
        // Retain one bounded next-batch backlog; excess remains at the source, never silently admitted.
        if (this.status().backlogCount >= 100) return { ok: false, code: 'backlog_capacity', retained: false };
        this.#db.prepare('insert into finite_backlog values(?,?,?)').run(input.trajectoryId, input.receiptHash, input.endedAt);
        return { ok: false, code: 'window_full', retained: true };
      }
      this.#db.prepare('insert into finite_trajectories values(?,?,?)').run(input.trajectoryId, input.receiptHash, input.endedAt);
      const snapshot = this.status();
      if (snapshot.trajectoryCount === 100) {
        const windowHash = digest({ configurationHash: this.#configurationHash, cohort: snapshot.cohort });
        this.#db.prepare("update finite_study set window_hash=?, state='ready' where id=1").run(windowHash);
        return { ok: true, code: 'window_sealed' };
      }
      return { ok: true, code: 'recorded' };
    });
  }

  reserve(input: { windowHash: string; phase: string; executor: string; idempotencyKey: string;
    payloadHash: string; maximumCents: number }): Decision {
    if (!hash(input.windowHash) || !hash(input.payloadHash) || !id(input.idempotencyKey)
      || !['local', 'roomote', 'gemini'].includes(input.executor)
      || !cents(input.maximumCents) || input.maximumCents < 1) return { ok: false, code: 'invalid_request' };
    return this.#transaction(() => {
      const requestHash = digest(input);
      const previous = this.#db.prepare('select * from finite_requests where idempotency_key=?').get(input.idempotencyKey);
      if (previous) return previous.request_hash === requestHash
        ? { ok: true, code: 'reconciled_request', execute: false, fence: Number(previous.fence) }
        : { ok: false, code: 'idempotency_conflict', execute: false };
      const denied = this.#guard(); if (denied) return denied;
      const snapshot = this.status();
      if (!snapshot.windowHash) return { ok: false, code: 'window_not_ready' };
      if (input.windowHash !== snapshot.windowHash) return { ok: false, code: 'window_mismatch' };
      const phaseCap = this.#configuration.phaseCaps[input.phase];
      if (!Object.hasOwn(this.#configuration.phaseCaps, input.phase)) return { ok: false, code: 'phase_not_admitted' };
      if (input.maximumCents > phaseCap!) return { ok: false, code: 'phase_budget' };
      if (this.#db.prepare('select 1 from finite_requests where phase=?').get(input.phase)) return { ok: false, code: 'phase_already_claimed' };
      if (snapshot.inFlight) return { ok: false, code: 'in_flight' };
      if (snapshot.liabilityCents + input.maximumCents > snapshot.maximumCents) return { ok: false, code: 'total_budget' };
      const inserted = this.#db.prepare(`insert into finite_requests(idempotency_key,phase,request_hash,maximum_cents,state)
        values(?,?,?,?,'reserved')`).run(input.idempotencyKey, input.phase, requestHash, input.maximumCents);
      return { ok: true, code: 'reserved', execute: true, fence: Number(inserted.lastInsertRowid) };
    });
  }

  settle(input: { idempotencyKey: string; fence: number; state: string; actualCents: number | null; receiptHash: string }): Decision {
    if (!id(input.idempotencyKey) || !Number.isSafeInteger(input.fence) || input.fence < 1 || !hash(input.receiptHash)
      || !['succeeded', 'failed', 'unknown'].includes(input.state)
      || (input.state === 'unknown' ? input.actualCents !== null : !cents(input.actualCents))) return { ok: false, code: 'invalid_settlement' };
    return this.#transaction(() => {
      const row = this.#db.prepare('select * from finite_requests where idempotency_key=?').get(input.idempotencyKey);
      if (!row) return { ok: false, code: 'request_missing' };
      if (Number(row.fence) !== input.fence) return { ok: false, code: 'fence_mismatch' };
      if (!['reserved', 'unknown'].includes(String(row.state))) return row.state === input.state
        && row.actual_cents === input.actualCents && row.receipt_hash === input.receiptHash
        ? { ok: true, code: 'duplicate_settlement', execute: false } : { ok: false, code: 'settlement_conflict' };
      this.#db.prepare('update finite_requests set state=?,actual_cents=?,receipt_hash=? where idempotency_key=?')
        .run(input.state, input.actualCents, input.receiptHash, input.idempotencyKey);
      if (input.state !== 'succeeded' || Number(input.actualCents) > Number(row.maximum_cents)
        || this.status().liabilityCents > this.#configuration.maximumCents) this.#block(input.state === 'unknown' ? 'unknown_liability' : 'failed_or_overrun');
      else if (Object.keys(this.#configuration.phaseCaps).every(phase =>
        this.#db.prepare("select 1 from finite_requests where phase=? and state='succeeded'").get(phase))
        && this.#row().state === 'ready') this.#db.prepare("update finite_study set state='complete' where id=1").run();
      return { ok: true, code: 'settled', execute: false };
    });
  }
  stop(reason: 'operator_stop' | 'validation_failed' | 'capability_denied') {
    if (!['operator_stop', 'validation_failed', 'capability_denied'].includes(reason)) throw new Error('finite_study_stop_invalid');
    this.#transaction(() => this.#db.prepare("update finite_study set state='stopped', reason=? where id=1").run(reason));
  }
  close() { this.#db.close(); }
}
