import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NamedSessionBudget } from './namedSessionBudget.js';

test('durable reservations enforce a cap across restart and duplicate IDs', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dharma-session-budget-'));
  let budget = new NamedSessionBudget(join(root, 'budget.sqlite'), 'scope-1', 50);
  assert.equal(budget.reserve('request-1', 25), true);
  assert.equal(budget.reserve('request-1', 25), false);
  assert.equal(budget.reserve('request-2', 30), false);
  budget.close();
  budget = new NamedSessionBudget(join(root, 'budget.sqlite'), 'scope-1', 50);
  assert.equal(budget.reserve('request-2', 25), true);
  assert.equal(budget.reserve('request-3', 1), false);
  assert.equal(budget.status().reservedCents, 50);
  budget.close();
  assert.throws(() => new NamedSessionBudget(join(root, 'budget.sqlite'), 'scope-1', 500), /budget_conflict/);
  assert.throws(() => new NamedSessionBudget(join(root, 'budget.sqlite'), 'foreign-scope', 50), /budget_conflict/);
});

test('restart records interrupted work without replay or releasing its reserved cost', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dharma-session-recovery-'));
  const path = join(root, 'budget.sqlite');
  let budget = new NamedSessionBudget(path, 'scope-1', 50);
  budget.beginWork('work-1', 'encrypted-intent-hash');
  assert.equal(budget.reserve('work-1', 25), true);
  budget.close();
  budget = new NamedSessionBudget(path, 'scope-1', 50);
  budget.recoverInterruptedWork();
  assert.equal(budget.lastWork()?.state, 'interrupted');
  assert.equal(budget.status().reservedCents, 25);
  assert.throws(() => budget.beginWork('work-1', 'changed-prompt'), /work_already_recorded/);
  budget.beginWork('work-2', 'new-intent');
  budget.finishWork('work-2', 'completed', 'encrypted-completion-hash');
  budget.recoverInterruptedWork();
  assert.equal(budget.lastWork()?.state, 'completed');
  budget.close();
});

test('exact-work audit lookup preserves reservations and never falls back to the latest work', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dharma-audit-budget-'));
  const budget = new NamedSessionBudget(join(root, 'budget.sqlite'), 'audit-scope', 50);
  try {
    budget.beginWork('older-work', 'sha256:' + 'a'.repeat(64));
    budget.reserve('older-work', 25);
    budget.finishWork('older-work', 'completed', 'sha256:' + 'b'.repeat(64));
    budget.beginWork('newer-work', 'sha256:' + 'c'.repeat(64));
    const reader = budget as unknown as {getWork(id: string): {workId: string; state: string; receiptHash: string} | null};
    const before = budget.status();
    assert.equal(reader.getWork('older-work')?.receiptHash, 'sha256:' + 'b'.repeat(64));
    assert.equal(reader.getWork('older-work')?.state, 'completed');
    assert.equal(reader.getWork('newer-work')?.state, 'executing');
    assert.equal(reader.getWork('absent-work'), null);
    assert.throws(() => reader.getWork('../foreign'), /named_session_work_invalid/);
    assert.deepEqual(budget.status(), before);
  } finally {budget.close();}
});
