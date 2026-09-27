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
