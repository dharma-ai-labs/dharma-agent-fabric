import assert from 'node:assert/strict';
import test from 'node:test';
import {resolve} from 'node:path';
import {validateContract} from '@dharma-ai-labs/agent-fabric-contracts';
import {createCodexSetupAdmission, type CodexSetupIntent, type CodexSetupJournal} from './codexSetupAdmission.js';
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
  const journal: CodexSetupJournal = {
    claim: async (_operation, intentDigest) => { claims++; if (state === 'new') {state = 'running'; return {state: 'acquired', leaseId: id(5), intentDigest};}
      return state === 'running' ? {state: 'running', intentDigest} : {state: 'terminal', result: disposition, intentDigest}; },
    finish: async (_lease, _digest, result) => { state = 'terminal'; disposition = result; },
  };
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

test('raw runtime errors and unexpected output never cross the tool boundary', async () => {
  for (const runtime of [async () => {throw new Error('vendor-secret-canary');},
    async () => ({state: 'completed', readinessReceiptId: id(7), token: 'vendor-secret-canary'})]) {
    const f = fixture(); const input = {...f.input, execute: runtime};
    const result = await createCodexSetupAdmission(input).handler(f.params, {signal: f.signal.signal});
    assert.equal(result.success, false); assert.equal(JSON.stringify(result).includes('vendor-secret-canary'), false);
  }
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
