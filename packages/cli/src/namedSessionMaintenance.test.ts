import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import test from 'node:test';
import {maintainNamedSession} from './namedSessionMaintenance.js';
import type {NamedSessionRegistration} from './namedSessionService.js';

function fixture() {
  const registration: NamedSessionRegistration = {schema:'dharma.named-session/v1', name:'reviewer',
    bindingId:randomUUID(), enabled:true, maximumCostCents:100, maximumTurnCostCents:25,
    identity:{organizationId:'org_test', repositoryBindingId:randomUUID(), workspaceId:randomUUID(),
      endpointId:randomUUID(), membershipId:randomUUID(), deviceId:randomUUID(), provider:'codex'}};
  const fenceId = randomUUID(), generation = randomUUID(), sessionId = randomUUID();
  const status: Record<string, unknown> = {ok:true, name:registration.name, bindingId:registration.bindingId,
    ...registration.identity, sessionId, admission:{generation, fenceId:null, pending:0, state:'open'}};
  const receipt: Record<string, unknown> = {ok:true, schema:'dharma.named-session-maintenance/v1', receiptId:randomUUID(),
    ...registration.identity, name:registration.name, bindingId:registration.bindingId, sessionId,
    action:'quiesce', fenceId, generation, state:'quiesced', pending:0, observedAt:new Date().toISOString()};
  return {registration, fenceId, generation, status, receipt};
}

for (const action of ['quiesce', 'resume', 'stop-drained'] as const) test(`maintenance ${action} binds the actual owner generation and scoped receipt`, async () => {
  const value = fixture(), requests: Record<string, unknown>[] = [];
  value.receipt.action = action;
  value.receipt.state = action === 'quiesce' ? 'quiesced' : action === 'resume' ? 'open' : 'stop_requested';
  const result = await maintainNamedSession({...value, action, request:async body => {
    requests.push(body); return requests.length === 1 ? value.status : value.receipt;
  }});
  assert.deepEqual(requests, [{action:'status'}, {action, fenceId:value.fenceId, generation:value.generation}]);
  assert.deepEqual(result, value.receipt);
});

test('a legacy service lacking a real admission fence is rejected before a control request', async () => {
  const value = fixture(), requests: Record<string, unknown>[] = [];
  delete value.status.admission;
  await assert.rejects(maintainNamedSession({...value, action:'quiesce', request:async body => {
    requests.push(body); return value.status;
  }}), /named_session_quiescence_not_supported/);
  assert.deepEqual(requests, [{action:'status'}]);
});

test('foreign owner, repository, member or device cannot authorize a maintenance request', async () => {
  for (const key of ['name','bindingId','organizationId','repositoryBindingId','membershipId','deviceId','workspaceId','endpointId']) {
    const value = fixture(); value.status[key] = key === 'name' ? 'foreign' : key === 'organizationId' ? 'org_foreign' : randomUUID();
    const requests: Record<string, unknown>[] = [];
    await assert.rejects(maintainNamedSession({...value, action:'quiesce', request:async body => {
      requests.push(body); return value.status;
    }}), /named_session_scope_mismatch/);
    assert.deepEqual(requests, [{action:'status'}]);
  }
});

test('invalid, stale, foreign or secret-bearing receipts never establish a drained boundary', async () => {
  for (const change of [
    {generation:randomUUID()}, {fenceId:randomUUID()}, {pending:1}, {state:'open'}, {action:'resume'},
    {deviceId:randomUUID()}, {sessionId:randomUUID()}, {membershipId:randomUUID()},
    {grant:'dhab_PRIVATE_TEST_GRANT'}, {observedAt:'invalid'}, {ok:false},
  ]) {
    const value = fixture();let requests = 0;
    await assert.rejects(maintainNamedSession({...value, action:'quiesce', request:async () =>
      ++requests === 1 ? value.status : {...value.receipt, ...change}}), /named_session_maintenance_scope_mismatch/);
    assert.equal(requests, 2);
  }
});

test('lost control responses are not retried or interpreted as successful drain', async () => {
  const value = fixture(); let calls = 0;
  await assert.rejects(maintainNamedSession({...value, action:'quiesce', request:async () => {
    if (++calls === 1) return value.status;
    throw Error('named_session_unavailable');
  }}), /named_session_unavailable/);
  assert.equal(calls, 2);
});
