import assert from 'node:assert/strict';
import test from 'node:test';
import { JobLedger } from '../src/jobs.ts';

test('first attempt applies one job and replay of that attempt does not apply again', () => {
  const ledger = new JobLedger();
  const job = { tenantId: 'synthetic-a', idempotencyKey: 'order-1', attemptId: 'attempt-1', amount: 10 };
  assert.equal(ledger.process(job).applied, true);
  assert.equal(ledger.process(job).applied, false);
  assert.equal(ledger.balance('synthetic-a'), 10);
});

test('a retry with a new attempt is the same logical job', () => {
  const ledger = new JobLedger();
  ledger.process({ tenantId: 'synthetic-a', idempotencyKey: 'order-1', attemptId: 'attempt-1', amount: 10 });
  const retry = ledger.process({ tenantId: 'synthetic-a', idempotencyKey: 'order-1', attemptId: 'attempt-2', amount: 10 });
  assert.equal(retry.applied, false);
  assert.equal(retry.balance, 10);
});

test('tenant-scoped idempotency keeps customers independent', () => {
  const ledger = new JobLedger();
  ledger.process({ tenantId: 'synthetic-a', idempotencyKey: 'order-1', attemptId: 'attempt-a', amount: 10 });
  assert.equal(ledger.process({ tenantId: 'synthetic-b', idempotencyKey: 'order-1', attemptId: 'attempt-b', amount: 20 }).applied, true);
  assert.equal(ledger.balance('synthetic-a'), 10);
  assert.equal(ledger.balance('synthetic-b'), 20);
});

test('invalid amounts produce no side effect', () => {
  const ledger = new JobLedger();
  assert.throws(() => ledger.process({ tenantId: 'synthetic-a', idempotencyKey: 'order-1', attemptId: 'attempt-1', amount: -1 }), /invalid_job/);
  assert.equal(ledger.balance('synthetic-a'), 0);
});
