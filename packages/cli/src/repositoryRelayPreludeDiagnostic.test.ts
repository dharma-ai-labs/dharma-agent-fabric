import assert from 'node:assert/strict';
import test from 'node:test';
import {currentRepositoryRelayFailure, runRegisteredRepositoryRelays,
  withRepositoryRelayStage, type RepositoryRelayStage} from './repositoryRelaySupervisor.js';

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
