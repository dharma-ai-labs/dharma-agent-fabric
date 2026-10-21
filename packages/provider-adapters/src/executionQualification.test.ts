import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import test from 'node:test';
import { executeProviderTask, reportedProviderExecutionQualification, type ProviderProcessRunner } from './index.js';

const hash = (value: string) => `sha256:${createHash('sha256').update(value).digest('hex')}`;
const qualification = () => ({
  organizationId: 'org_fixture', taskId: '00000000-0000-4000-8000-000000000001',
  inputSha256: hash('frozen-input'), candidateSha256: hash('candidate'),
  oracleReceiptSha256: hash('independent-oracle-receipt'),
  fileRootsSha256: null, skillRootsSha256: null, settingsSha256: null, contextSha256: null,
});
const base = {
  provider: 'codex' as const, workspace: resolve('synthetic-workspace'),
  instructions: 'private-instruction-canary', artifactContext: '\nprivate-artifact-canary',
  timeoutSeconds: 17, allowedCommandArgv: [['node', 'synthetic-test']], allowWrites: false,
};
const completed = { exitCode: 0, signal: null, timedOut: false,
  stdout: Buffer.from('private-output-canary'), stderr: Buffer.from('private-stderr-canary') };

test('execution qualification is opt-in and binds the exact invocation without changing it', async () => {
  const calls: Parameters<ProviderProcessRunner>[0][] = [];
  const runner: ProviderProcessRunner = async (call) => { calls.push(call); return completed; };
  const legacy = await executeProviderTask({ ...base, runner });
  const result = await executeProviderTask({ ...base, ...{ qualification: qualification() }, runner });
  assert.equal(Object.hasOwn(legacy, 'qualificationReceipt'), false);
  assert.deepEqual(calls[1], calls[0]);
  assert.equal(result.stdoutSha256, legacy.stdoutSha256);
  const receipt = Reflect.get(result, 'qualificationReceipt');
  assert.ok(receipt, 'requested qualification must return a receipt');
  assert.equal(receipt.schema, 'dharma.provider-execution-qualification/v1');
  assert.deepEqual(receipt.declared, qualification());
  assert.equal(receipt.invocation.runner, 'injected');
  assert.equal(receipt.invocation.stdinSha256, hash(base.instructions + base.artifactContext));
  assert.equal(receipt.invocation.argvSha256, hash(JSON.stringify(calls[1]!.argv)));
  assert.equal(receipt.invocation.workspaceSha256, hash(base.workspace));
  assert.equal(receipt.invocation.allowedCommandArgvSha256, hash(JSON.stringify(base.allowedCommandArgv)));
  assert.equal(receipt.invocation.timeoutMs, 17_000);
  assert.equal(receipt.outcome.stdoutSha256, result.stdoutSha256);
  assert.equal(receipt.outcome.stderrSha256, result.stderrSha256);
  assert.equal(receipt.outcome.exitCode, 0);
  assert.deepEqual(receipt.unverified, [
    'effective_model_and_settings', 'effective_file_roots', 'effective_skill_roots',
    'tool_policy_enforcement', 'fresh_context', 'independent_oracle_custody',
  ]);
  const serialized = JSON.stringify(receipt);
  for (const privateValue of [base.workspace, base.instructions, 'private-artifact-canary',
    'private-output-canary', 'private-stderr-canary', 'synthetic-test']) {
    assert.equal(serialized.includes(privateValue), false);
  }
});

test('execution qualification rejects malformed or executable declarations before dispatch', async () => {
  let dispatched = 0;
  let getterCalls = 0;
  const getter = Object.defineProperty(qualification(), 'inputSha256', {
    enumerable: true, get() { getterCalls++; return hash('unexpected'); },
  });
  const symbol = { ...qualification(), [Symbol('private')]: hash('unexpected') };
  for (const value of [null, [], { ...qualification(), inputSha256: 'private-key-canary' },
    { ...qualification(), inputSha256: hash('x').toUpperCase() },
    { ...qualification(), taskId: 'not-a-task' }, { ...qualification(), organizationId: 'bad\norg' },
    { ...qualification(), contextSha256: 'raw-context-canary' },
    { ...qualification(), toJSON: () => qualification() }, getter, symbol]) {
    await assert.rejects(executeProviderTask({ ...base,
      qualification: value as Parameters<typeof executeProviderTask>[0]['qualification'],
      runner: async () => { dispatched++; return completed; } }), /^Error: Provider execution qualification is invalid\.$/);
  }
  assert.equal(dispatched, 0);
  assert.equal(getterCalls, 0);
});

test('execution qualification freezes declarations across asynchronous runner mutation', async () => {
  const declaration = qualification();
  const original = { ...declaration };
  const result = await executeProviderTask({ ...base, ...{ qualification: declaration },
    runner: async () => {
      declaration.candidateSha256 = hash('changed-after-admission');
      return completed;
    } });
  assert.deepEqual(Reflect.get(result, 'qualificationReceipt')?.declared, original);
});

test('execution qualification retains failed and timed-out outcomes without success inference', async () => {
  for (const outcome of [{ ...completed, exitCode: 1 }, { ...completed, exitCode: null, timedOut: true }]) {
    const result = await executeProviderTask({ ...base, ...{ qualification: qualification() },
      runner: async () => outcome });
    const receipt = Reflect.get(result, 'qualificationReceipt');
    assert.ok(receipt);
    assert.equal(receipt.outcome.exitCode, outcome.exitCode);
    assert.equal(receipt.outcome.timedOut, outcome.timedOut);
    assert.equal(receipt.outcome.failureCategory, result.failureCategory);
  }
  const rejection = new Error('synthetic-runner-rejected');
  await assert.rejects(executeProviderTask({ ...base, ...{ qualification: qualification() },
    runner: async () => { throw rejection; } }), (error) => error === rejection);
});

test('execution qualification schema rejects raw metadata and unsupported verified claims', async () => {
  const require = createRequire(import.meta.url);
  const Ajv = require('ajv/dist/2020').default;
  const schema = JSON.parse(await readFile(new URL('../../../schemas/provider-execution-qualification.schema.json', import.meta.url), 'utf8'));
  const validate = new Ajv({ strict: true }).compile(schema);
  const result = await executeProviderTask({ ...base, ...{ qualification: qualification() }, runner: async () => completed });
  const receipt = Reflect.get(result, 'qualificationReceipt');
  assert.ok(receipt);
  assert.equal(validate(receipt), true, JSON.stringify(validate.errors));
  for (const override of [{ privateKey: 'private-schema-canary' }, { unverified: [] },
    { observedAt: 'yesterday' }, { declared: { ...qualification(), freshContext: true } },
    { invocation: { ...receipt.invocation, rawArgv: ['private-argv-canary'] } }]) {
    assert.equal(validate({ ...receipt, ...override }), false);
  }
});

test('execution qualification preserves explicit unknowns even when all declaration pins are supplied', async () => {
  const declaration = { ...qualification(), fileRootsSha256: hash('declared-file-roots'),
    skillRootsSha256: hash('declared-skill-roots'), settingsSha256: hash('declared-settings'),
    contextSha256: hash('declared-context') };
  const result = await executeProviderTask({ ...base, qualification: declaration, runner: async () => completed });
  const receipt = result.qualificationReceipt!;
  assert.equal(receipt.unverified.length, 6);
  assert.equal(Object.isFrozen(receipt.unverified), true);
  const report = reportedProviderExecutionQualification(result, declaration);
  assert.ok(report);
  assert.deepEqual(report.declared, declaration);
  assert.notEqual(report, receipt);
  for (const mutate of [
    () => ({ ...receipt, outcome: { ...receipt.outcome, stdoutSha256: hash('other-output') } }),
    () => ({ ...receipt, unverified: [] }),
    () => ({ ...receipt, invocation: { ...receipt.invocation, timeoutMs: Infinity } }),
    () => ({ ...receipt, declared: { ...declaration, toJSON() { throw new Error('must-not-run'); } } }),
  ]) {
    assert.equal(reportedProviderExecutionQualification({ ...result,
      qualificationReceipt: mutate() as typeof receipt }, declaration), null);
  }
});

test('execution qualification supports all existing providers without launching them', async (t) => {
  for (const provider of ['codex', 'claude', 'agy', 'hermes'] as const) {
    await t.test(provider, async () => {
      let calls = 0;
      const result = await executeProviderTask({ ...base, provider, allowedCommandArgv: [],
        qualification: qualification(), runner: async (call) => {
          calls++;
          assert.equal(call.command, provider);
          assert.equal(call.cwd, base.workspace);
          return { ...completed, stdout: Buffer.from(provider === 'agy' ? '{"status":"SUCCESS"}' : 'synthetic-result') };
        } });
      assert.equal(calls, 1);
      assert.equal(result.exitCode, 0);
      assert.equal(result.qualificationReceipt?.invocation.provider, provider);
      assert.equal(result.qualificationReceipt?.invocation.runner, 'injected');
      assert.ok(reportedProviderExecutionQualification(result, qualification()));
    });
  }
});
