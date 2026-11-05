import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import test from 'node:test';
import {Ajv2020} from 'ajv/dist/2020.js';
import type {FormatsPlugin} from 'ajv-formats';
import {currentRepositoryRelayFailure, REPOSITORY_RELAY_FAILURE_CODES, REPOSITORY_RELAY_STAGES, repositoryRelayFailureReceipt,
  runRegisteredRepositoryRelays, withRepositoryRelayStage, type RepositoryRelayStage} from './repositoryRelaySupervisor.js';

for (const stage of ['session_open', 'vault_open']) {
  test(`current-process diagnostics retain ${stage} without private error text`, () => {
    const at = '2026-10-16T23:00:00.000Z', mtime = Date.parse(at) - 1000;
    const receipt = {schema:'dharma.local-repository-relay-failure/v1', organizationId:'org_a',
      deviceId:'device_a', workspaceId:'workspace_a', pid:50, relayPidMtimeMs:mtime,
      relayPidCtimeMs:mtime, at, stage, category:'unexpected', privateDetail:'must-not-leak'};
    assert.deepEqual(currentRepositoryRelayFailure({receipt, organizationId:'org_a',deviceId:'device_a',
      workspaceId:'workspace_a',pid:50,relayPidMtimeMs:mtime,relayPidCtimeMs:mtime,
      lastSuccessfulPollAt:null,now:Date.parse(at)+1000}), {at,stage,category:'unexpected'});
  });

  test(`${stage} remains a bounded failed worker, not a raw error or successful poll`, async () => {
    const controller = new AbortController(), events: unknown[] = [];
    let ticks = 0;
    await runRegisteredRepositoryRelays({signal:controller.signal,
      list:async()=>[{workspaceId:'workspace_a',policyPath:'/a/.dharma/approved-policy.json'}],
      run:()=>withRepositoryRelayStage(stage as RepositoryRelayStage,async()=>{throw Error('private-key-and-response-body');}),
      observe:event=>{events.push(event);},now:()=>0,
      wait:async()=>{await Promise.resolve();await Promise.resolve();if(++ticks===4)controller.abort();}});
    assert.deepEqual(events,[{workspaceId:'workspace_a',code:'repository_relay_failed',stage,category:'unexpected'}]);
    assert(!JSON.stringify(events).includes('private-key-and-response-body'));
  });
}

const lockCodes = ['connection_anchor_lock_invalid', 'connection_anchor_busy', 'connection_anchor_recovery_required',
  'connection_anchor_lock_unavailable', 'connection_anchor_lock_cleanup_unconfirmed', 'device_signing_control_unavailable'];

async function observedFailure(error: Error) {
  const controller = new AbortController(), events: unknown[] = [];
  let ticks = 0;
  await runRegisteredRepositoryRelays({signal:controller.signal,
    list:async()=>[{workspaceId:'workspace_a',policyPath:'/a/.dharma/approved-policy.json'}],
    run:()=>withRepositoryRelayStage('session_open',async()=>{throw error;}),
    observe:event=>{events.push(event);},now:()=>0,
    wait:async()=>{await Promise.resolve();await Promise.resolve();if(++ticks===4)controller.abort();}});
  return events;
}

for (const failureCode of lockCodes) {
  test(`the stage line names ${failureCode} instead of only unexpected`, async () => {
    assert.deepEqual(await observedFailure(Error(failureCode)), [{workspaceId:'workspace_a',
      code:'repository_relay_failed',stage:'session_open',category:'unexpected',failureCode}]);
  });
}

test('only an exact known code reaches the stage line, never a message that holds one', async () => {
  for (const message of ['connection_anchor_lock_invalid C:/Users/someone/.secret', 'connection_anchor_lock_invalid\n',
    'Connection_Anchor_Lock_Invalid', 'plain_lowercase_words', 'sk_live_token_value']) {
    const events = await observedFailure(Error(message));
    assert.deepEqual(events, [{workspaceId:'workspace_a',code:'repository_relay_failed',stage:'session_open',category:'unexpected'}]);
  }
});

test('the failure receipt reader returns a known code and drops any other value', () => {
  const at = '2026-10-16T23:00:00.000Z', mtime = Date.parse(at) - 1000;
  const receipt = {schema:'dharma.local-repository-relay-failure/v1', organizationId:'org_a',
    deviceId:'device_a', workspaceId:'workspace_a', pid:50, relayPidMtimeMs:mtime,
    relayPidCtimeMs:mtime, at, stage:'session_open', category:'unexpected'};
  const read = (value: unknown) => currentRepositoryRelayFailure({receipt:value,organizationId:'org_a',deviceId:'device_a',
    workspaceId:'workspace_a',pid:50,relayPidMtimeMs:mtime,relayPidCtimeMs:mtime,lastSuccessfulPollAt:null,now:Date.parse(at)+1000});
  const base = {at,stage:'session_open',category:'unexpected'};
  assert.deepEqual(read({...receipt,failureCode:'connection_anchor_lock_invalid'}),
    {...base,failureCode:'connection_anchor_lock_invalid'});
  for (const failureCode of ['C:/Users/someone/.secret', 'free text', 7, null]) {
    assert.deepEqual(read({...receipt,failureCode}), base);
  }
  assert.equal(read({...receipt,at:'Fri, 16 Oct 2026 22:00:00 GMT (C:/Users/someone/.secret)'}), null);
});

async function schema(name: string) {
  return JSON.parse(await readFile(new URL(`./schemas/${name}.schema.json`, import.meta.url), 'utf8'));
}
async function validator(name: string) {
  const ajv = new Ajv2020({strict: true, strictRequired: false});
  (createRequire(import.meta.url)('ajv-formats') as FormatsPlugin)(ajv);
  return ajv.compile(await schema(name));
}

test('the failure receipt schema lists exactly the stages and codes the relay writes', async () => {
  const {properties} = await schema('local-repository-relay-failure');
  assert.deepEqual(properties.stage.enum, [...REPOSITORY_RELAY_STAGES]);
  assert.deepEqual(properties.failureCode.enum, [...REPOSITORY_RELAY_FAILURE_CODES]);
});

test('receipts built from real relay events match the failure receipt schema', async () => {
  const validate = await validator('local-repository-relay-failure'), at = new Date().toISOString();
  const receipt = (event: unknown) => repositoryRelayFailureReceipt(event as Parameters<typeof repositoryRelayFailureReceipt>[0], {organizationId: 'org_a',
    deviceId: 'device_a', pid: 50, relayPidMtimeMs: 1.5, relayPidCtimeMs: 2.5}, at);
  for (const message of [...lockCodes, 'private-key-and-response-body']) {
    const [event] = await observedFailure(Error(message));
    const value = receipt(event);
    assert.equal(validate(value), true, JSON.stringify(validate.errors));
    assert.equal((value as {failureCode?: string}).failureCode, lockCodes.includes(message) ? message : undefined);
    assert.equal(value.workspaceId, 'workspace_a');
  }
  const [event] = await observedFailure(Error('connection_anchor_busy'));
  assert.equal(validate({...receipt(event), failureCode: 'C:/Users/someone/.secret'}), false);
  assert.equal(validate({...receipt(event), detail: 'free text'}), false);
});

test('the session open record matches its schema', async () => {
  const validate = await validator('local-repository-session-open');
  assert.equal(validate({at: new Date().toISOString()}), true, JSON.stringify(validate.errors));
  for (const value of [{}, {at: '2026-11-04T00:00:00Z'}, {at: '2026-11-04T00:00:00.000Z\n'},
    {at: new Date().toISOString(), detail: 'free text'}]) assert.equal(validate(value), false);
});
