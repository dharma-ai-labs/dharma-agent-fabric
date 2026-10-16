import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import test from 'node:test';
import {maintainNamedSession, recoverStoppedNamedSession} from './namedSessionMaintenance.js';
import type {NamedSessionRegistration} from './namedSessionService.js';
import type {LocalProviderSessionBinding} from '@dharma-ai-labs/agent-fabric-local-vault';
import {validateContract} from '@dharma-ai-labs/agent-fabric-contracts';
import {join} from 'node:path';

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
    action:'quiesce', fenceId, generation, mode:'live', state:'quiesced', pending:0, automaticRestartEnabled:false, observedAt:new Date().toISOString()};
  return {registration, fenceId, generation, status, receipt};
}

for (const action of ['quiesce', 'resume', 'stop-drained'] as const) test(`maintenance ${action} binds the actual owner generation and scoped receipt`, async () => {
  const value = fixture(), requests: Record<string, unknown>[] = [];
  value.receipt.action = action;
  value.receipt.state = action === 'quiesce' ? 'quiesced' : action === 'resume' ? 'open' : 'stop_requested';
  value.receipt.automaticRestartEnabled = action === 'resume';
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
    {grant:'dhab_PRIVATE_TEST_GRANT'}, {observedAt:'invalid'}, {ok:false}, {automaticRestartEnabled:true},
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

function recoveryFixture() {
  const f=fixture(), registration={...f.registration, enabled:false,
    maintenanceFence:{fenceId:f.fenceId,generation:f.generation}};
  let current: NamedSessionRegistration | null=registration, writes=0, stateReads=0;
  const binding: LocalProviderSessionBinding={schema:'dharma.local-provider-session-binding/v1',
    ...registration.identity, bindingId:registration.bindingId, owner:'dharma_bridge', sessionId:String(f.receipt.sessionId),
    workspaceRoot:'/fixture/repo', createdAt:new Date().toISOString(), expiresAt:new Date(Date.now()+60000).toISOString(), maximumProviderCostCents:25};
  return {...f, registration, binding, writes:()=>writes, current:()=>current,
    input:{registration, fenceId:f.fenceId, workspace:'/fixture/repo', processState:async () => {stateReads++;return 'stopped' as const;},
      readRegistration:async () => current, readBinding:async () => binding,
      saveRegistration:async (value:NamedSessionRegistration) => {writes++;current=value;}},
    stateReads:()=>stateReads};
}

test('explicit stopped-owner recovery preserves binding and budgets and does not start a provider', async () => {
  const f=recoveryFixture(), receipt=await recoverStoppedNamedSession(f.input);
  assert.equal(receipt.mode,'stopped_recovery');assert.equal(receipt.state,'restart_permitted');
  assert.equal(receipt.interruptedWorkDisposition,'preserved_for_verified_start');
  assert.equal(receipt.sessionId,f.binding.sessionId);assert.equal(f.writes(),1);assert.equal(f.stateReads(),2);
  const {maintenanceFence:_fence,...base}=f.registration;
  assert.deepEqual(f.current(),{...base,enabled:true});
  assert.equal((await validateContract(join(import.meta.dirname,'schemas'),
    'https://schemas.dharma-ai.io/named-session-maintenance/v1',receipt)).ok,true);
});

test('unavailable live owner and unknown process state never clear a persisted fence', async () => {
  for(const state of ['running','unknown'] as const){const f=recoveryFixture();
    await assert.rejects(recoverStoppedNamedSession({...f.input,processState:async()=>state}),/named_session_owner_not_stopped/);
    assert.equal(f.writes(),0);assert.equal(f.current()?.enabled,false);
  }
  const f=recoveryFixture();let reads=0;
  await assert.rejects(recoverStoppedNamedSession({...f.input,processState:async()=>++reads===1?'stopped':'running'}),/named_session_owner_not_stopped/);
  assert.equal(f.writes(),0);
});

test('stopped recovery rejects wrong fence, foreign binding, changed disk scope and expired authority before writes', async () => {
  for(const kind of ['fence','binding','disk','expired'] as const){const f=recoveryFixture();
    const input={...f.input,...(kind==='fence'?{fenceId:randomUUID()}:{}),
      ...(kind==='binding'?{readBinding:async()=>({...f.binding,deviceId:randomUUID()})}:{}),
      ...(kind==='disk'?{readRegistration:async()=>({...f.registration,maximumCostCents:200})}:{}),
      ...(kind==='expired'?{readBinding:async()=>({...f.binding,expiresAt:new Date(0).toISOString()})}:{})};
    await assert.rejects(recoverStoppedNamedSession(input),/named_session_maintenance_/);assert.equal(f.writes(),0);
  }
});
