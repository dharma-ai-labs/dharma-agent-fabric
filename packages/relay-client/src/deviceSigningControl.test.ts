import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import test from 'node:test';
import * as relay from './index.js';

type Lease={controllerInstanceId:string;processIdentityDigest:string;leaseDigest:string;assertHeld():Promise<void>};
type Input={config:{hqUrl:string;organizationId:string;deviceId:string};timeoutMs?:number;hostScope?:{signal:AbortSignal;current():Promise<boolean>}};
function api(){
  const fn=(relay as unknown as Record<string,unknown>).withDeviceSigningControl;
  assert.equal(typeof fn,'function');
  return fn as <T>(input:Input,work:(lease:Lease)=>Promise<T>)=>Promise<T>;
}
const input=()=>({config:{hqUrl:'https://www.dharma-ai.io',organizationId:'org_fixture'+randomUUID().replaceAll('-',''),deviceId:randomUUID()}});

test('device signing control is exclusive across independent flows and reentrant only in its live async owner',async()=>{
  const run=api(),scope=input();let entered!:()=>void,finish!:()=>void;
  const started=new Promise<void>(r=>{entered=r;}),stop=new Promise<void>(r=>{finish=r;});
  let stale!:Lease;
  const held=run(scope,async lease=>{
    stale=lease;await lease.assertHeld();entered();
    const nested=await run(scope,async inner=>{assert.equal(inner.controllerInstanceId,lease.controllerInstanceId);await inner.assertHeld();return 'nested';});
    assert.equal(nested,'nested');await stop;
  });
  await started;
  await run({...scope,config:{...scope.config,deviceId:randomUUID()}},async lease=>{await lease.assertHeld();});
  await assert.rejects(run({...scope,timeoutMs:50},async()=>assert.fail('competing owner admitted')),/connection_anchor_busy/);
  finish();await held;await assert.rejects(stale.assertHeld(),/device_signing_control_unavailable/);
  await run(scope,async lease=>{assert.notEqual(lease.controllerInstanceId,stale.controllerInstanceId);await lease.assertHeld();});
});

test('cancelled or changed authority cannot enter signing control or retain it after work settles',async()=>{
  const run=api(),scope=input(),controller=new AbortController();let allowed=true,called=0;
  controller.abort();
  await assert.rejects(run({...scope,hostScope:{signal:controller.signal,current:async()=>true}},async()=>{called++;}));
  assert.equal(called,0);
  const live=new AbortController();
  await assert.rejects(run({...scope,hostScope:{signal:live.signal,current:async()=>allowed}},async lease=>{
    assert.match(lease.processIdentityDigest,/^sha256:[a-f0-9]{64}$/);assert.match(lease.leaseDigest,/^sha256:[a-f0-9]{64}$/);
    allowed=false;await assert.rejects(lease.assertHeld());
  }));
  await run(scope,async lease=>{await lease.assertHeld();});
});

test('expired async context cannot silently reenter a released control lease',async()=>{
  const run=api(),scope=input();let later!:()=>void;let detached!:Promise<unknown>;
  await run(scope,async()=>{detached=new Promise<void>(r=>{later=r;}).then(()=>run(scope,async()=>assert.fail('released context reused')));});
  later();await assert.rejects(detached,/device_signing_control_unavailable/);
});
