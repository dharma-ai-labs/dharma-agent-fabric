import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { promisify } from 'node:util';
import test from 'node:test';
import { Ajv2020 } from 'ajv/dist/2020.js';
import type { FormatsPlugin } from 'ajv-formats';
import { FiniteLearningStudyLedger, planFiniteLearningStudy } from './finiteLearningStudy.js';

const execute = promisify(execFile);
const instant = Date.parse('2026-10-23T20:00:00.000Z');
const hash = (letter = 'a') => 'sha256:' + letter.repeat(64);
const identity = { organizationId: 'org-study', agentId: 'agent-fixture', endpointId: 'endpoint-fixture',
  deviceId: 'device-fixture', workspaceId: 'workspace-fixture', provider: 'codex', localAgentId: 'local-fixture' };
const config = () => ({ schema: 'dharma.finite-learning-study/v1' as const, studyId: 'study-fixture', identity: { ...identity },
  admissionReceiptHash: hash(), predecessorHash: hash('b'), batchSize: 100 as const, maxWindows: 1 as const,
  expiresAt: '2026-10-23T21:00:00.000Z', maximumCents: 50,
  phaseCaps: { analysis: 20, api_candidate: 30 } });
const completed = (n: number) => ({ identity: { ...identity }, trajectoryId: `trajectory-${String(n).padStart(3, '0')}`,
  state: 'completed', admissible: true, receiptHash: hash('c'), endedAt: '2026-10-23T19:00:00.000Z' });
const request = (windowHash: string) => ({ windowHash, phase: 'analysis', executor: 'local',
  idempotencyKey: 'analysis-key', payloadHash: hash('d'), maximumCents: 20 });

async function fixture(run: (ledger: FiniteLearningStudyLedger, path: string) => Promise<void> | void) {
  const root = await mkdtemp(join(tmpdir(), 'dharma-finite-study-'));
  const path = join(root, 'study.sqlite');
  const ledger = new FiniteLearningStudyLedger(path, config(), () => instant);
  try { await run(ledger, path); }
  finally { ledger.close(); await rm(root, { recursive: true, force: true }); }
}
function fill(ledger: FiniteLearningStudyLedger) {
  for (let n = 1; n <= 100; n++) ledger.recordCompleted(completed(n));
  return ledger.status().windowHash!;
}

test('finite study schema and no-write plan require exact identity, finite limits and bounded phases', async () => {
  const ajv = new Ajv2020({ strict: true, allErrors: true });
  (createRequire(import.meta.url)('ajv-formats') as FormatsPlugin)(ajv);
  const validate = ajv.compile(JSON.parse(await readFile(new URL('../../../schemas/finite-learning-study.schema.json', import.meta.url), 'utf8')));
  assert.equal(validate(config()), true);
  assert.equal(planFiniteLearningStudy(config()).configurationHash, planFiniteLearningStudy(config()).configurationHash);
  for (const patch of [{ maximumCents: 0 }, { maximumCents: 10001 }, { maxWindows: 2 }, { batchSize: 99 },
    { expiresAt: 'never' }, { expiresAt: '2026-02-30T21:00:00.000Z' }, { token: 'must-not-be-retained' },
    { phaseCaps: { rollout: 1 } }, { phaseCaps: {} },
    { studyId: 'study\n' }, { predecessorHash: hash('b') + '\n' },
    { identity: { ...identity, workspaceId: 'workspace\n' } },
    { identity: { ...identity, workspaceId: '' } }, { admissionReceiptHash: 'unverified-content' }]) {
    assert.equal(validate({ ...config(), ...patch }), false);
    assert.throws(() => planFiniteLearningStudy({ ...config(), ...patch }));
  }
  assert.throws(() => new FiniteLearningStudyLedger(':memory:', config()), /durable_path_required/);
  assert.throws(() => new FiniteLearningStudyLedger('relative.sqlite', config()), /durable_path_required/);
});

test('99 does not seal; the 100th seals one immutable sorted cohort; duplicates and 200 cannot open another', async () => {
  await fixture(ledger => {
    for (let n = 1; n < 100; n++) assert.equal(ledger.recordCompleted(completed(n)).code, 'recorded');
    assert.equal(ledger.status().windowHash, null);
    assert.equal(ledger.reserve(request(hash())).code, 'window_not_ready');
    const sealed = ledger.recordCompleted(completed(100));
    assert.equal(sealed.code, 'window_sealed');
    const before = ledger.status();
    assert.equal(ledger.recordCompleted(completed(1)).code, 'duplicate');
    for (let n = 101; n <= 200; n++) assert.equal(ledger.recordCompleted(completed(n)).code, 'window_full');
    assert.deepEqual(ledger.status().cohort, before.cohort);
    assert.equal(ledger.status().windowHash, before.windowHash);
    assert.equal(ledger.status().backlogCount, 100);
    assert.equal(ledger.recordCompleted(completed(200)).code, 'duplicate');
    assert.deepEqual(ledger.recordCompleted(completed(201)), { ok: false, code: 'backlog_capacity', retained: false });
    assert.equal(before.trajectoryCount, 100);
    assert.equal(before.windowCount, 1);
    assert.equal(before.cohort[0]!.trajectoryId, 'trajectory-001');
  });
});

test('incomplete, excluded, future and foreign identity records cannot qualify a completed cohort', async () => {
  await fixture(ledger => {
    for (const patch of [{ state: 'running' }, { admissible: false }, { endedAt: '2026-10-23T20:00:00.001Z' },
      { identity: { ...identity, organizationId: 'other-customer' } },
      { identity: { ...identity, workspaceId: 'other-workspace' } },
      { identity: { ...identity, localAgentId: 'other-agent' } }]) {
      assert.equal(ledger.recordCompleted({ ...completed(1), ...patch }).ok, false);
    }
    assert.equal(ledger.status().trajectoryCount, 0);
    assert.equal(ledger.status().windowHash, null);
  });
});

test('same trajectory identity with changed provenance blocks rather than silently replacing evidence', async () => {
  await fixture(ledger => {
    ledger.recordCompleted(completed(1));
    assert.equal(ledger.recordCompleted({ ...completed(1), receiptHash: hash('e') }).code, 'trajectory_conflict');
    assert.equal(ledger.status().state, 'blocked');
    assert.equal(ledger.recordCompleted(completed(2)).ok, false);
    assert.equal(ledger.status().trajectoryCount, 1);
  });
});

test('three executor processes share one cohort, one phase claim and one in-flight reservation', async () => {
  await fixture(async (ledger, path) => {
    const source = `import {FiniteLearningStudyLedger} from ${JSON.stringify(new URL('./finiteLearningStudy.js', import.meta.url).href)};
      const ledger=new FiniteLearningStudyLedger(${JSON.stringify(path)},${JSON.stringify(config())},()=>${instant});
      for(let n=1;n<=100;n++)ledger.recordCompleted({...${JSON.stringify(completed(1))},trajectoryId:'trajectory-'+String(n).padStart(3,'0')});
      const result=ledger.reserve({...${JSON.stringify(request(''))},windowHash:ledger.status().windowHash,
        executor:process.argv[1],idempotencyKey:process.argv[1]+'-analysis-key'});
      ledger.close();process.stdout.write(JSON.stringify(result));`;
    const results = await Promise.all(['local', 'roomote', 'gemini'].map(async executor =>
      JSON.parse((await execute(process.execPath, ['--input-type=module', '-e', source, executor], { timeout: 15_000 })).stdout)));
    assert.equal(results.filter(result => result.ok && result.execute).length, 1);
    assert.equal(ledger.status().windowCount, 1);
    assert.equal(ledger.status().trajectoryCount, 100);
    assert.equal(ledger.status().liabilityCents, 20);
    assert.equal(ledger.status().inFlight, 1);
  });
});

test('explicit idempotency is durable across restart and changed bodies never replay effects', async () => {
  await fixture((ledger, path) => {
    const windowHash = fill(ledger), input = request(windowHash);
    const first = ledger.reserve(input); assert.equal(first.execute, true);
    const other = new FiniteLearningStudyLedger(path, config(), () => instant);
    try {
      const replay = other.reserve(input);
      assert.equal(replay.ok, true); assert.equal(replay.execute, false); assert.equal(replay.fence, first.fence);
      assert.equal(other.reserve({ ...input, payloadHash: hash('e') }).code, 'idempotency_conflict');
      assert.equal(other.status().liabilityCents, 20);
      assert.equal(other.status().inFlight, 1);
    } finally { other.close(); }
  });
});

test('a different executor or key cannot repeat an already claimed phase or steal an in-flight stage', async () => {
  await fixture(ledger => {
    const windowHash = fill(ledger), input = request(windowHash), first = ledger.reserve(input);
    assert.equal(ledger.reserve({ ...input, executor: 'roomote', idempotencyKey: 'other-analysis' }).code, 'phase_already_claimed');
    assert.equal(ledger.reserve({ ...input, phase: 'api_candidate', idempotencyKey: 'candidate-key', maximumCents: 30 }).code, 'in_flight');
    assert.equal(ledger.settle({ idempotencyKey: input.idempotencyKey, fence: first.fence! + 1,
      state: 'succeeded', actualCents: 10, receiptHash: hash('e') }).code, 'fence_mismatch');
    assert.equal(ledger.status().liabilityCents, 20);
  });
});

test('phase and total caps include pending reservations; settlement frees only evidenced unused cost', async () => {
  await fixture(ledger => {
    const windowHash = fill(ledger), input = request(windowHash);
    assert.equal(ledger.reserve({ ...input, maximumCents: 21 }).code, 'phase_budget');
    assert.equal(ledger.reserve({ ...input, phase: 'rollout' }).code, 'phase_not_admitted');
    assert.equal(ledger.reserve({ ...input, windowHash: hash('f') }).code, 'window_mismatch');
    const first = ledger.reserve(input);
    assert.equal(ledger.settle({ idempotencyKey: input.idempotencyKey, fence: first.fence!, state: 'succeeded',
      actualCents: 10, receiptHash: hash('e') }).ok, true);
    const candidate = ledger.reserve({ ...input, phase: 'api_candidate', idempotencyKey: 'candidate-key', maximumCents: 30 });
    assert.equal(candidate.execute, true);
    assert.equal(ledger.status().liabilityCents, 40);
    assert.equal(ledger.settle({ idempotencyKey: 'candidate-key', fence: candidate.fence!, state: 'succeeded',
      actualCents: 25, receiptHash: hash('f') }).ok, true);
    assert.equal(ledger.status().state, 'complete');
    assert.equal(ledger.status().liabilityCents, 35);
    assert.equal(ledger.reserve({ ...input, idempotencyKey: 'fresh-analysis-key' }).ok, false);
  });
});

test('unknown cost survives restart and prevents all fresh work without manufacturing a zero receipt', async () => {
  await fixture((ledger, path) => {
    const windowHash = fill(ledger), first = ledger.reserve(request(windowHash));
    assert.equal(ledger.settle({ idempotencyKey: 'analysis-key', fence: first.fence!, state: 'unknown',
      actualCents: null, receiptHash: hash('e') }).ok, true);
    const restarted = new FiniteLearningStudyLedger(path, config(), () => instant);
    try {
      assert.equal(restarted.status().state, 'blocked');
      assert.equal(restarted.status().liabilityCents, 20);
      assert.equal(restarted.reserve({ ...request(windowHash), phase: 'api_candidate', idempotencyKey: 'candidate-key' }).ok, false);
      assert.equal(restarted.reserve(request(windowHash)).execute, false);
    } finally { restarted.close(); }
  });
});

test('aggregate study cap blocks an individually affordable phase after earlier settled costs', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dharma-study-total-'));
  const ledger = new FiniteLearningStudyLedger(join(root, 'study.sqlite'),
    { ...config(), phaseCaps: { analysis: 30, api_candidate: 30 } }, () => instant);
  try {
    const windowHash = fill(ledger), first = ledger.reserve({ ...request(windowHash), maximumCents: 30 });
    ledger.settle({ idempotencyKey: 'analysis-key', fence: first.fence!, state: 'succeeded', actualCents: 25, receiptHash: hash('e') });
    assert.equal(ledger.reserve({ ...request(windowHash), phase: 'api_candidate', idempotencyKey: 'candidate-key', maximumCents: 30 }).code, 'total_budget');
    assert.equal(ledger.status().liabilityCents, 25);
  } finally { ledger.close(); await rm(root, { recursive: true, force: true }); }
});

test('process death after committed reservation leaves a non-replayable durable liability', async () => {
  await fixture(async (ledger, path) => {
    const windowHash = fill(ledger);
    const source = `import {FiniteLearningStudyLedger} from ${JSON.stringify(new URL('./finiteLearningStudy.js', import.meta.url).href)};
      const ledger=new FiniteLearningStudyLedger(${JSON.stringify(path)},${JSON.stringify(config())},()=>${instant});
      ledger.reserve(${JSON.stringify(request(windowHash))});process.exit(73);`;
    await assert.rejects(execute(process.execPath, ['--input-type=module', '-e', source], { timeout: 15_000 }),
      (error: unknown) => (error as { code: number }).code === 73);
    assert.equal(ledger.status().inFlight, 1);
    assert.equal(ledger.status().liabilityCents, 20);
    assert.equal(ledger.reserve(request(windowHash)).execute, false);
    assert.equal(ledger.reserve({ ...request(windowHash), phase: 'api_candidate', idempotencyKey: 'candidate-key' }).code, 'in_flight');
  });
});

test('clock regression durably blocks, and malformed settlement cannot discharge a reservation', async () => {
  await fixture((ledger, path) => {
    const windowHash = fill(ledger), first = ledger.reserve(request(windowHash));
    for (const patch of [{ state: 'unknown', actualCents: 0 }, { actualCents: -1 }, { actualCents: Number.NaN },
      { receiptHash: 'untrusted-text' }, { fence: 0 }]) {
      assert.equal(ledger.settle({ idempotencyKey: 'analysis-key', fence: first.fence!, state: 'succeeded',
        actualCents: 10, receiptHash: hash('e'), ...patch }).ok, false);
      assert.equal(ledger.status().liabilityCents, 20);
    }
    const regressed = new FiniteLearningStudyLedger(path, config(), () => instant - 1);
    try {
      assert.equal(regressed.recordCompleted(completed(101)).code, 'clock_regressed');
      assert.equal(ledger.status().state, 'blocked');
    } finally { regressed.close(); }
  });
});

test('overruns and failed receipts retain actual costs and stop rather than consuming an automatic retry', async () => {
  for (const outcome of [{ state: 'succeeded', actualCents: 51 }, { state: 'failed', actualCents: 7 }]) {
    await fixture(ledger => {
      const windowHash = fill(ledger), first = ledger.reserve(request(windowHash));
      ledger.settle({ idempotencyKey: 'analysis-key', fence: first.fence!, ...outcome, receiptHash: hash('e') });
      assert.equal(ledger.status().liabilityCents, outcome.actualCents);
      assert.equal(ledger.status().state, 'blocked');
      assert.equal(ledger.reserve({ ...request(windowHash), phase: 'api_candidate', idempotencyKey: 'candidate-key' }).ok, false);
    });
  }
});

test('absolute expiry and explicit stop persist, while in-flight costs cannot be erased by stopping', async () => {
  await fixture((ledger, path) => {
    const windowHash = fill(ledger); ledger.reserve(request(windowHash));
    const expired = new FiniteLearningStudyLedger(path, config(), () => Date.parse(config().expiresAt));
    try {
      assert.equal(expired.reserve({ ...request(windowHash), phase: 'api_candidate', idempotencyKey: 'candidate-key' }).code, 'expired');
      assert.equal(expired.status().state, 'stopped');
      assert.equal(expired.status().liabilityCents, 20);
      ledger.stop('operator_stop');
      assert.equal(ledger.status().liabilityCents, 20);
      assert.equal(ledger.recordCompleted(completed(101)).ok, false);
    } finally { expired.close(); }
  });
});

test('study identity, scope, budget and predecessor cannot be changed by reopening the same ledger', async () => {
  await fixture((_ledger, path) => {
    for (const patch of [{ studyId: 'another-study' }, { maximumCents: 500 }, { predecessorHash: hash('f') },
      { identity: { ...identity, agentId: 'other-worker' } }, { expiresAt: '2026-10-23T22:00:00.000Z' }]) {
      assert.throws(() => new FiniteLearningStudyLedger(path, { ...config(), ...patch }, () => instant), /configuration_conflict/);
    }
  });
});

test('terminal settlement repeats only its exact receipt; unknown settlement reconciliation never unblocks study', async () => {
  await fixture(ledger => {
    const windowHash = fill(ledger), input = request(windowHash), first = ledger.reserve(input);
    const settled = { idempotencyKey: input.idempotencyKey, fence: first.fence!, state: 'succeeded',
      actualCents: 10, receiptHash: hash('e') };
    ledger.settle({ ...settled, state: 'unknown', actualCents: null });
    assert.equal(ledger.settle(settled).ok, true);
    assert.equal(ledger.status().state, 'blocked');
    assert.equal(ledger.status().liabilityCents, 10);
    assert.equal(ledger.settle(settled).code, 'duplicate_settlement');
    assert.equal(ledger.settle({ ...settled, actualCents: 0 }).code, 'settlement_conflict');
    assert.equal(ledger.reserve({ ...input, phase: 'api_candidate', idempotencyKey: 'candidate-key' }).ok, false);
  });
});
