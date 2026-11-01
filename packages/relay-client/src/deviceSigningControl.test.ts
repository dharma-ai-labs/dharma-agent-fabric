import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';
import test from 'node:test';
import type {SecureSecretStore} from '@dharma-ai-labs/agent-fabric-secure-store';
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

test('a signed request through the client queue reuses the signing control its caller holds',async t=>{
  // Otherwise a policy sync that holds the control would wait on its own lock until it timed out.
  const root=await mkdtemp(resolve(tmpdir(),'fabric-signing-nesting-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const values=new Map<string,string>();
  const store:SecureSecretStore={backend:'linux-secret-service',async get(account){return values.get(account)??null;},
    async put(account,value){values.set(account,value);},async delete(account){values.delete(account);}};
  const hqUrl='https://hq.example',organizationId='org_fixture'+randomUUID().replaceAll('-','');
  const identity=await relay.loadOrCreateDeviceIdentity({hqUrl,organizationId,store});
  const config:relay.DeviceConfig={schema:'dharma.device-config/v1',hqUrl,organizationId,deviceId:randomUUID(),deviceName:'Synthetic',
    platform:'linux',publicKeyEd25519:identity.publicKeyEd25519,serverPublicKeyEd25519:identity.publicKeyEd25519,
    relayUrl:'wss://relay.example',enrolledAt:new Date().toISOString()};
  const configPath=resolve(root,'device.json'),statePath=resolve(root,'state.json');
  await relay.saveDeviceConfig(configPath,config);await relay.saveDeviceEnrollmentAnchor({config,store});
  const client=await relay.AgentFabricClient.open({configPath,statePath,store,
    fetcher:async()=>new Response(JSON.stringify({ok:true}),{status:201})});
  await client.openSession();
  const reply=await api()({config:client.config},async lease=>{
    const response=await client.registerWorkspace({workspaceId:'fixture'});await lease.assertHeld();return response;});
  assert.equal(reply.ok,true);
});
