import assert from 'node:assert/strict';
import test from 'node:test';
import {resolve} from 'node:path';
import {validateContract} from '@dharma-ai-labs/agent-fabric-contracts';
import {assertCodexSetupExecutionLease, createCodexSetupAdmission, type CodexSetupExecutionLease,
  type CodexSetupIntent, type CodexSetupJournal} from './codexSetupAdmission.js';
import {CODEX_PEER_TOOLS} from './codexPeerTools.js';

const id = (n: number) => `${String(n).padStart(8, '0')}-1111-4111-8111-111111111111`;
const digest = `sha256:${'a'.repeat(64)}`;
const intent: CodexSetupIntent = {schema: 'dharma.codex-setup-intent/v1', operationId: id(1),
  setupReference: id(2), organizationId: 'org_demo', recipientMembershipId: id(3),
  origin: 'https://hq.example', repositoryFingerprint: digest, policyRevision: 'policy-v1',
  scopeDigest: digest, contractDigest: digest, hostContextId: id(4),
  issuedAt: '2026-10-05T18:00:00.000Z', expiresAt: '2026-10-05T18:15:00.000Z'};

function fixture() {
  let time = Date.parse('2026-10-05T18:01:00.000Z');
  let mode: 'setup' | 'work' | 'peer' = 'setup'; let qualified = true; let calls = 0; let claims = 0;
  let state: 'new' | 'running' | 'terminal' = 'new'; let disposition: unknown;
  const journal: CodexSetupJournal = Object.assign({
    claim: async (_operation: string, intentDigest: string) => { claims++; if (state === 'new') {state = 'running'; return {state: 'acquired' as const, leaseId: id(5), intentDigest};}
      return state === 'running' ? {state: 'running' as const, intentDigest} : {state: 'terminal' as const, result: disposition, intentDigest}; },
    finish: async (_lease: string, _digest: string, result: unknown) => { state = 'terminal'; disposition = result; },
  }, {
    read: async (_operation: string, intentDigest: string) => state === 'new' ? null
      : state === 'running' ? {state: 'running' as const, intentDigest}
      : {state: 'terminal' as const, intentDigest, result: disposition},
  });
  const active = {connectionId: id(6), threadId: 'synthetic_thread', turnId: 'synthetic_turn', hostContextId: id(4)};
  const input = {intent, ...active, now: () => time,
    current: async () => ({...active, mode}), qualifyHost: async () => qualified,
    journal, execute: async () => {calls++; return {state: 'completed', readinessReceiptId: id(7)};},
    verifyReadiness: async () => true};
  const signal = new AbortController();
  const params = {threadId: active.threadId, turnId: active.turnId, callId: 'synthetic_call', namespace: null,
    tool: 'dharma_setup_reference', arguments: {operationId: id(1), setupReference: id(2)}};
  return {input, params, signal, get calls() {return calls;}, get claims() {return claims;},
    mode: (value: typeof mode) => {mode = value;}, qualify: (value: boolean) => {qualified = value;},
    time: (value: number) => {time = value;}};
}

test('a journal without durable readback cannot claim or execute setup', () => {
  const f = fixture();
  const journal = {claim: f.input.journal.claim, finish: f.input.journal.finish};
  assert.throws(() => createCodexSetupAdmission({...f.input, journal: journal as CodexSetupJournal}),
    /^Error: codex_setup_intent_invalid$/);
  assert.equal(f.claims, 0); assert.equal(f.calls, 0);
});

test('setup admission denies foreign context, peer/work turns and model-selected authority', async () => {
  const variations = [
    {threadId: 'foreign'}, {turnId: 'foreign'}, {tool: 'dharma_peer_ask'}, {namespace: 'foreign'},
    {command: '/init'}, {arguments: {operationId: id(1), setupReference: id(2), home: '/private'}},
    {arguments: {operationId: id(8), setupReference: id(2)}},
    {arguments: {operationId: id(1), setupReference: id(8)}}, {callId: 'bad\ncall'},
  ];
  for (const variation of variations) {
    const f = fixture(); const owner = createCodexSetupAdmission(f.input);
    const result = await owner.handler({...f.params, ...variation}, {signal: f.signal.signal});
    assert.equal(result.success, false); assert.equal(f.calls, 0); assert.equal(f.claims, 0);
  }
  for (const mode of ['work', 'peer'] as const) {
    const f = fixture(); f.mode(mode);
    assert.equal((await createCodexSetupAdmission(f.input).handler(f.params, {signal: f.signal.signal})).success, false);
    assert.equal(f.calls, 0); assert.equal(f.claims, 0);
  }
});

test('setup admission requires host qualification, live scope, signal and unexpired intent', async () => {
  for (const invalid of ['host', 'expiry', 'abort', 'signal'] as const) {
    const f = fixture(); const owner = createCodexSetupAdmission(f.input);
    if (invalid === 'host') f.qualify(false);
    if (invalid === 'expiry') f.time(Date.parse(intent.expiresAt));
    if (invalid === 'abort') f.signal.abort();
    assert.equal((await owner.handler(f.params, invalid === 'signal' ? undefined : {signal: f.signal.signal})).success, false);
    assert.equal(f.calls, 0); assert.equal(f.claims, 0);
  }
});

test('completion requires independent readiness verification; repeated operation does not execute twice', async () => {
  const f = fixture(); const owner = createCodexSetupAdmission(f.input);
  assert.equal((await owner.handler(f.params, {signal: f.signal.signal})).success, true);
  assert.equal((await owner.handler({...f.params, callId: 'another_call'}, {signal: f.signal.signal})).success, true);
  assert.equal(f.calls, 1);
  assert.equal((await owner.handler(f.params, {signal: f.signal.signal})).success, false);
  const denied = fixture(); denied.input.verifyReadiness = async () => false;
  const result = await createCodexSetupAdmission(denied.input).handler(denied.params, {signal: denied.signal.signal});
  assert.equal(result.success, false);
  assert.equal(JSON.stringify(result).includes('readinessReceiptId'), false);
});

test('the original lease and native-bound digest reach only trusted execution and readiness verification', async () => {
  const f = fixture(); let executionDigest = '', verificationDigest = '';
  const input = {...f.input,
    execute: async (_intent: Readonly<CodexSetupIntent>, _signal: AbortSignal, current: () => Promise<boolean>,
      lease: {readonly leaseId: string; readonly intentDigest: string}) => {
      assert.equal(await current(), true); assert.equal(Object.isFrozen(lease), true);
      assert.equal(lease.leaseId, id(5));
      assert.deepEqual(Object.keys(lease).sort(), ['intentDigest', 'leaseId']);
      executionDigest = lease.intentDigest;
      return {state: 'completed', readinessReceiptId: id(7)};
    },
    verifyReadiness: async (_receipt: string, _intent: Readonly<CodexSetupIntent>, intentDigest: string) => {
      verificationDigest = intentDigest; return true;
    }};
  const owner = createCodexSetupAdmission(input);
  const result = await owner.handler(f.params, {signal: f.signal.signal});
  assert.equal(result.success, true); assert.equal(executionDigest, owner.intentDigest);
  assert.equal(verificationDigest, owner.intentDigest); assert.notEqual(owner.intentDigest, intent.scopeDigest);
  assert.equal(JSON.stringify(result).includes(id(5)), false);
  assert.equal(JSON.stringify(result).includes(owner.intentDigest), false);
});

test('raw runtime errors and unexpected output never cross the tool boundary', async () => {
  for (const runtime of [async () => {throw new Error('vendor-secret-canary');},
    async () => ({state: 'completed', readinessReceiptId: id(7), token: 'vendor-secret-canary'})]) {
    const f = fixture(); const input = {...f.input, execute: runtime};
    const result = await createCodexSetupAdmission(input).handler(f.params, {signal: f.signal.signal});
    assert.equal(result.success, false); assert.equal(JSON.stringify(result).includes('vendor-secret-canary'), false);
  }
});

test('only the original admitted in-process lease authorizes its exact intent while execution is active', async () => {
  const f = fixture(); let retained: Readonly<CodexSetupExecutionLease> | undefined;
  const owner = createCodexSetupAdmission({...f.input, execute: async (accepted, _signal, _current, lease) => {
    retained = lease;
    await assertCodexSetupExecutionLease(lease, accepted);
    for (const copied of [{...lease}, new Proxy(lease, {})]) {
      await assert.rejects(assertCodexSetupExecutionLease(copied, accepted), /execution_lease_unavailable/);
    }
    await assert.rejects(assertCodexSetupExecutionLease(lease, {...accepted, policyRevision: 'foreign'}),
      /execution_lease_unavailable/);
    let getters = 0;
    await assert.rejects(assertCodexSetupExecutionLease(lease, {...accepted,
      get policyRevision() {getters++; return accepted.policyRevision;}}), /execution_lease_unavailable/);
    assert.equal(getters, 0);
    return {state: 'completed', readinessReceiptId: id(7)};
  }});
  assert.equal((await owner.handler(f.params, {signal: f.signal.signal})).success, true);
  assert.ok(retained);
  await assert.rejects(assertCodexSetupExecutionLease(retained, intent), /execution_lease_unavailable/);
});

test('execution lease loses authority after cancellation, even during asynchronous qualification', async () => {
  const f = fixture(); let delayed = false, entered!: () => void, release!: () => void;
  const started = new Promise<void>(done => {entered = done;});
  const finish = new Promise<void>(done => {release = done;});
  const owner = createCodexSetupAdmission({...f.input, responseWaitMs: 10,
    qualifyHost: async () => {if (delayed) {entered(); await finish;} return true;},
    execute: async (accepted, _signal, _current, lease) => {
      delayed = true;
      await assert.rejects(assertCodexSetupExecutionLease(lease, accepted), /execution_lease_unavailable/);
      return {state: 'unconfirmed', code: 'setup_execution_unconfirmed'};
    }});
  const operation = owner.handler(f.params, {signal: f.signal.signal});
  try {
    await started; owner.close(); release();
    assert.equal((await operation).success, false); await owner.settled;
  } finally {owner.close(); release(); await owner.settled;}
});

test('authority lost during operation withholds output without forgetting terminal effects', async () => {
  const f = fixture(); const input = {...f.input, execute: async () => {
    f.mode('peer'); return {state: 'completed', readinessReceiptId: id(7)};
  }};
  const owner = createCodexSetupAdmission(input);
  assert.equal((await owner.handler(f.params, {signal: f.signal.signal})).success, false);
  f.mode('setup');
  assert.equal((await owner.handler({...f.params, callId: 'reconcile'}, {signal: f.signal.signal})).success, true);
});

test('closing the setup gate prevents permission carryover and admission after close', async () => {
  const f = fixture(); const owner = createCodexSetupAdmission(f.input); owner.close();
  assert.equal((await owner.handler(f.params, {signal: f.signal.signal})).success, false);
  assert.equal(f.calls, 0);
});

test('intent schema and runtime deny credential fields, changed home and malformed binding', async () => {
  const schemas = resolve(import.meta.dirname, '../../../schemas');
  const schema = 'https://schemas.dharma-ai.io/codex-setup-intent/v1';
  assert.equal((await validateContract(schemas, schema, intent)).ok, true);
  const changes = [{token: 'secret-canary'}, {home: '/foreign'}, {command: '/init'}, {env: {TOKEN: 'secret-canary'}},
    {origin: 'https://user:password@hq.example'}, {origin: 'https://hq.example/foreign'},
    {organizationId: 'org_demo\n'}, {setupReference: `${id(2)}\n`}, {scopeDigest: 'invalid'}];
  for (const change of changes) {
    const f = fixture(); const changed = {...intent, ...change};
    assert.equal((await validateContract(schemas, schema, changed)).ok, false);
    assert.throws(() => createCodexSetupAdmission({...f.input, intent: changed}), /^Error: codex_setup_intent_invalid$/);
    assert.equal(f.calls, 0);
  }
  for (const change of [{expiresAt: intent.issuedAt}, {issuedAt: intent.expiresAt},
    {expiresAt: '2026-10-05T18:16:00.000Z'}]) {
    const f = fixture(); assert.throws(() => createCodexSetupAdmission({...f.input, intent: {...intent, ...change}}),
      /^Error: codex_setup_intent_invalid$/);
  }
});

test('concurrent calls retain one executor and cooperative abort does not invent termination', async () => {
  const f = fixture(); let release!: () => void; let entered!: () => void;
  const started = new Promise<void>(resolve => {entered = resolve;});
  const finish = new Promise<void>(resolve => {release = resolve;});
  let running = 0;
  const input = {...f.input, execute: async () => {running++; entered(); await finish;
    return {state: 'completed', readinessReceiptId: id(7)};}};
  const owner = createCodexSetupAdmission(input);
  const first = owner.handler(f.params, {signal: f.signal.signal}); await started;
  assert.equal(owner.pending, true);
  assert.equal((await owner.handler({...f.params, callId: 'concurrent'}, {signal: f.signal.signal})).success, false);
  owner.close(); assert.equal(owner.pending, true); assert.equal(running, 1);
  release(); assert.equal((await first).success, false); assert.equal(owner.pending, false);
});

test('lost journal acknowledgement leaves the operation unconfirmed and does not execute again', async () => {
  const f = fixture(); f.input.journal.finish = async () => {throw new Error('journal-secret-canary');};
  const owner = createCodexSetupAdmission(f.input);
  const result = await owner.handler(f.params, {signal: f.signal.signal});
  assert.equal(result.success, false); assert.equal(JSON.stringify(result).includes('journal-secret-canary'), false);
  assert.equal((await owner.handler({...f.params, callId: 'lost_ack'}, {signal: f.signal.signal})).success, false);
  assert.equal(f.calls, 1);
});

test('lost acknowledgement after durable completion recovers the same result without a second execution', async () => {
  const f = fixture(), finish = f.input.journal.finish;
  f.input.journal.finish = async (...args) => {await finish(...args); throw new Error('journal-secret-canary');};
  const owner = createCodexSetupAdmission(f.input);
  const result = await owner.handler(f.params, {signal: f.signal.signal});
  assert.equal(result.success, true);
  assert.deepEqual(JSON.parse(result.contentItems[0]!.text!), {operationId: id(1), state: 'completed', readinessReceiptId: id(7)});
  assert.equal(f.calls, 1); assert.equal(f.claims, 1);
  const again = await owner.handler({...f.params, callId: 'durable_readback'}, {signal: f.signal.signal});
  assert.equal(again.success, true); assert.equal(f.calls, 1);
  assert.equal(JSON.stringify([result, again]).includes('journal-secret-canary'), false);
});

for (const state of ['absent', 'running', 'foreign-digest', 'foreign-receipt', 'private-field', 'unreadable'] as const) {
  test(`durable completion readback withholds ${state} without replaying execution`, async () => {
    const f = fixture();
    f.input.journal.read = async (_operation, intentDigest) => {
      if (state === 'unreadable') throw new Error('readback-private-canary');
      if (state === 'absent') return null;
      if (state === 'running') return {state: 'running', intentDigest};
      return {state: 'terminal', intentDigest: state === 'foreign-digest' ? digest : intentDigest,
        result: {state: 'completed', readinessReceiptId: state === 'foreign-receipt' ? id(8) : id(7),
          ...(state === 'private-field' ? {token: 'readback-private-canary'} : {})}};
    };
    const owner = createCodexSetupAdmission(f.input);
    try {
      const first = await owner.handler(f.params, {signal: f.signal.signal});
      const repeated = await owner.handler({...f.params, callId: 'readback_retry'}, {signal: f.signal.signal});
      for (const result of [first, repeated]) {
        assert.equal(result.success, false);
        assert.equal(JSON.stringify(result).includes('readinessReceiptId'), false);
        assert.equal(JSON.stringify(result).includes('readback-private-canary'), false);
      }
      assert.equal(f.calls, 1);
    } finally {owner.close(); await owner.settled;}
  });
}

for (const change of ['abort', 'peer', 'expiry', 'policy'] as const) {
  test(`authority lost during durable readback withholds completion after ${change}`, async () => {
    const f = fixture(), read = f.input.journal.read;
    f.input.journal.read = async (...args) => {
      const result = await read(...args);
      if (change === 'abort') f.signal.abort();
      if (change === 'peer') f.mode('peer');
      if (change === 'expiry') f.time(Date.parse(intent.expiresAt));
      if (change === 'policy') f.qualify(false);
      return result;
    };
    const owner = createCodexSetupAdmission(f.input);
    try {
      const result = await owner.handler(f.params, {signal: f.signal.signal});
      assert.equal(result.success, false);
      assert.equal(JSON.stringify(result).includes('readinessReceiptId'), false);
      assert.equal(f.calls, 1);
    } finally {owner.close(); await owner.settled;}
  });
}

test('same operation with changed admitted policy cannot reuse another context journal', async () => {
  const f = fixture(); let admitted: string | undefined;
  const claim = f.input.journal.claim;
  f.input.journal.claim = async (operation, digest) => {
    if (admitted && digest !== admitted) throw new Error('journal_payload_mismatch');
    admitted = digest; return claim(operation, digest);
  };
  const first = createCodexSetupAdmission(f.input);
  assert.equal((await first.handler(f.params, {signal: f.signal.signal})).success, true);
  const changed = createCodexSetupAdmission({...f.input, intent: {...intent, policyRevision: 'policy-v2'}});
  assert.equal((await changed.handler(f.params, {signal: f.signal.signal})).success, false);
  assert.equal(f.calls, 1);
});

test('host-intent mutation does not expand a previously admitted operation', async () => {
  const f = fixture(); const mutable = {...intent};
  const owner = createCodexSetupAdmission({...f.input, intent: mutable}); mutable.setupReference = id(8);
  assert.equal((await owner.handler({...f.params, arguments: {operationId: id(1), setupReference: id(8)}},
    {signal: f.signal.signal})).success, false);
  assert.equal(f.calls, 0);
});

test('setup admission stays absent from the existing peer tool registry', () => {
  assert.deepEqual(CODEX_PEER_TOOLS.map(tool => tool.name), ['dharma_peer_ask', 'dharma_peer_reply']);
});

test('an unbound journal claim cannot admit execution or disclose readiness', async () => {
  const f = fixture();
  f.input.journal.claim = async () => ({state: 'acquired', leaseId: id(5), intentDigest: `sha256:${'b'.repeat(64)}`});
  const result = await createCodexSetupAdmission(f.input).handler(f.params, {signal: f.signal.signal});
  assert.equal(result.success, false); assert.equal(f.calls, 0);
});

test('setup callback returns bounded status while its owned operation remains fenced', async () => {
  const f = fixture(); let release!: () => void; let executions = 0;
  const completion = new Promise<void>(done => {release = done;});
  const input = {...f.input, responseWaitMs: 10, execute: async () => {
    executions++; await completion; return {state: 'completed', readinessReceiptId: id(7)};
  }};
  const owner = createCodexSetupAdmission(input as Parameters<typeof createCodexSetupAdmission>[0]);
  const first = owner.handler(f.params, {signal: f.signal.signal});
  let timeout: NodeJS.Timeout | undefined;
  try {
    const result = await Promise.race([first, new Promise<'missed_callback_boundary'>(done => {
      timeout = setTimeout(() => done('missed_callback_boundary'), 250);
    })]);
    assert.notEqual(result, 'missed_callback_boundary');
    if (result === 'missed_callback_boundary') throw new Error('fixture_response_missing');
    assert.equal(result.success, false);
    assert.equal(JSON.parse(result.contentItems[0]!.text).code, 'codex_setup_in_progress');
    assert.equal(owner.pending, true); assert.equal(executions, 1);
    const status = await owner.handler({...f.params, callId: 'poll_pending'}, {signal: f.signal.signal});
    assert.equal(JSON.parse(status.contentItems[0]!.text).code, 'codex_setup_in_progress');
    assert.equal(executions, 1);
    release(); await (owner as typeof owner & {settled: Promise<void>}).settled;
    assert.equal(owner.pending, false);
    assert.equal((await owner.handler({...f.params, callId: 'poll_completed'}, {signal: f.signal.signal})).success, true);
    assert.equal(executions, 1);
  } finally {if (timeout) clearTimeout(timeout); release(); await first; owner.close();}
});

for (const change of ['close', 'abort', 'peer', 'expiry', 'policy'] as const) {
  test(`bounded setup retains ownership but denies protected effects after ${change}`, async () => {
    const f = fixture(); let release!: () => void; let effects = 0; let executionSignal: AbortSignal | undefined;
    const finish = new Promise<void>(done => {release = done;});
    const owner = createCodexSetupAdmission({...f.input, responseWaitMs: 10,
      execute: async (_intent, signal, current) => {
        executionSignal = signal; await finish;
        if (!await current()) return {state: 'unconfirmed', code: 'setup_execution_unconfirmed'};
        effects++; return {state: 'completed', readinessReceiptId: id(7)};
      }});
    try {
      const result = await owner.handler(f.params, {signal: f.signal.signal});
      assert.equal(JSON.parse(result.contentItems[0]!.text).code, 'codex_setup_in_progress');
      assert.equal(owner.pending, true); assert.ok(executionSignal);
      if (change === 'close') owner.close();
      if (change === 'abort') f.signal.abort();
      if (change === 'peer') f.mode('peer');
      if (change === 'expiry') f.time(Date.parse(intent.expiresAt));
      if (change === 'policy') f.qualify(false);
      if (change === 'close' || change === 'abort') assert.equal(executionSignal.aborted, true);
      let settled = false;
      const observed = owner.settled.then(() => {settled = true;});
      await new Promise(done => setTimeout(done, 20));
      assert.equal(settled, false, 'a cancellation signal must not claim execution settlement');
      assert.equal(owner.pending, true); assert.equal(effects, 0);
      release(); await observed;
      assert.equal(owner.pending, false); assert.equal(effects, 0);
      const after = await owner.handler({...f.params, callId: 'after_change'}, {signal: f.signal.signal});
      assert.equal(after.success, false);
      assert.equal(JSON.stringify(after).includes('readinessReceiptId'), false);
    } finally {owner.close(); release(); await owner.settled;}
  });
}

test('slow host qualification returns bounded status and cannot admit execution after close', async () => {
  const f = fixture(); let release!: () => void;
  const qualified = new Promise<boolean>(done => {release = () => done(true);});
  const owner = createCodexSetupAdmission({...f.input, responseWaitMs: 10, qualifyHost: async () => qualified});
  try {
    const result = await owner.handler(f.params, {signal: f.signal.signal});
    assert.equal(JSON.parse(result.contentItems[0]!.text).code, 'codex_setup_in_progress');
    assert.equal(owner.pending, true); assert.equal(f.claims, 0); assert.equal(f.calls, 0);
    owner.close(); release(); await owner.settled;
    assert.equal(f.claims, 0); assert.equal(f.calls, 0); assert.equal(owner.pending, false);
  } finally {owner.close(); release(); await owner.settled;}
});

test('bounded status withholds readiness while independent verification is pending', async () => {
  const f = fixture(); let release!: () => void;
  const verified = new Promise<boolean>(done => {release = () => done(true);});
  let checks = 0;
  const owner = createCodexSetupAdmission({...f.input, responseWaitMs: 10,
    verifyReadiness: async () => {checks++; return verified;}});
  try {
    const result = await owner.handler(f.params, {signal: f.signal.signal});
    assert.equal(JSON.parse(result.contentItems[0]!.text).code, 'codex_setup_in_progress');
    assert.equal(JSON.stringify(result).includes('readinessReceiptId'), false);
    assert.equal(f.calls, 1); assert.equal(checks, 1); assert.equal(owner.pending, true);
    release(); await owner.settled;
    assert.equal((await owner.handler({...f.params, callId: 'verified_status'}, {signal: f.signal.signal})).success, true);
    assert.equal(f.calls, 1); assert.equal(checks, 2);
  } finally {owner.close(); release(); await owner.settled;}
});

test('host response budget is bounded and cannot be selected by model arguments', async () => {
  for (const responseWaitMs of [0, -1, 0.5, 900001, Number.NaN]) {
    const f = fixture();
    assert.throws(() => createCodexSetupAdmission({...f.input, responseWaitMs}), /^Error: codex_setup_intent_invalid$/);
    assert.equal(f.calls, 0); assert.equal(f.claims, 0);
  }
  const f = fixture(); const owner = createCodexSetupAdmission(f.input);
  assert.equal((await owner.handler({...f.params, arguments: {...f.params.arguments, responseWaitMs: 5000}},
    {signal: f.signal.signal})).success, false);
  assert.equal(f.calls, 0); assert.equal(f.claims, 0); owner.close();
});

test('setup boundary refuses getters, symbols and hidden fields without invoking accessors', async () => {
  let getters = 0;
  const f = fixture(); const owner = createCodexSetupAdmission(f.input);
  const args = {get operationId() {getters++; return id(1);}, setupReference: id(2)};
  assert.equal((await owner.handler({...f.params, arguments: args}, {signal: f.signal.signal})).success, false);
  const request = {...f.params, get arguments() {getters++; return f.params.arguments;}};
  assert.equal((await owner.handler(request, {signal: f.signal.signal})).success, false);
  assert.equal(f.claims, 0); assert.equal(f.calls, 0); owner.close();
  for (const result of [
    {get state() {getters++; return 'completed';}, readinessReceiptId: id(7)},
    {state: 'completed', readinessReceiptId: id(7), [Symbol('private')]: 'private-canary'},
    Object.defineProperty({state: 'completed', readinessReceiptId: id(7)}, 'private', {value: 'private-canary'}),
  ]) {
    const g = fixture(); const gate = createCodexSetupAdmission({...g.input, execute: async () => result});
    const response = await gate.handler(g.params, {signal: g.signal.signal});
    assert.equal(response.success, false); assert.equal(JSON.stringify(response).includes('private-canary'), false);
    gate.close(); await gate.settled;
  }
  assert.equal(getters, 0);
});

test('missing or foreign cancellation contexts fail closed without throwing or claiming a lease', async () => {
  for (const context of [{}, {signal: 'private-context-canary'}]) {
    const f = fixture(); const owner = createCodexSetupAdmission(f.input);
    const result = await owner.handler(f.params, context as never);
    assert.equal(JSON.parse(result.contentItems[0]!.text).code, 'codex_setup_not_authorized');
    assert.equal(JSON.stringify(result).includes('private-context-canary'), false);
    assert.equal(f.claims, 0); assert.equal(f.calls, 0); owner.close(); await owner.settled;
  }
});

test('policy revoked during independent readiness verification cannot disclose completion', async () => {
  const f = fixture();
  const owner = createCodexSetupAdmission({...f.input, verifyReadiness: async () => {f.qualify(false); return true;}});
  const result = await owner.handler(f.params, {signal: f.signal.signal});
  assert.equal(result.success, false);
  assert.equal(JSON.stringify(result).includes('readinessReceiptId'), false);
  owner.close(); await owner.settled;
});
