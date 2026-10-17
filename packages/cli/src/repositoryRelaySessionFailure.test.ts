import assert from 'node:assert/strict';
import test from 'node:test';
import {readFile} from 'node:fs/promises';
import {runInNewContext} from 'node:vm';
import ts from 'typescript';
import {AgentFabricRequestError} from '@dharma-ai-labs/agent-fabric-relay-client';
import {currentRepositoryRelayFailure,runRegisteredRepositoryRelays,withRepositoryRelayStage} from './repositoryRelaySupervisor.js';

async function observeOperation(run:()=>Promise<unknown>) {
  const controller=new AbortController(),events:unknown[]=[];let ticks=0;
  await runRegisteredRepositoryRelays({signal:controller.signal,
    list:async()=>[{workspaceId:'workspace_a',policyPath:'/a/.dharma/approved-policy.json'}],
    run,
    observe:event=>{events.push(event);},now:()=>0,
    wait:async()=>{await Promise.resolve();await Promise.resolve();if(++ticks===4)controller.abort();}});
  return events;
}
const observe=(error:unknown)=>observeOperation(()=>withRepositoryRelayStage('session_open',async()=>{throw error;}));
const cases:Array<[string,Error,string]>=[
  ['server authentication',new AgentFabricRequestError({error:{code:'denied',message:'PRIVATE_RESPONSE'}},403,true),'relay_authentication_rejected'],
  ['server request rejection',new AgentFabricRequestError({error:{code:'invalid',message:'PRIVATE_RESPONSE'}},409,true),'relay_request_rejected'],
  ['server availability',new AgentFabricRequestError({error:{code:'failed',message:'PRIVATE_RESPONSE'}},503,false),'relay_service_unavailable'],
  ['explicit signing expiry',new AgentFabricRequestError({error:{code:'agent_fabric_signing_expired',message:'PRIVATE_RESPONSE'}},503,false),'signing_trust_expired'],
  ['server throttling',new AgentFabricRequestError({error:{code:'limited',message:'PRIVATE_RESPONSE'}},429,false),'relay_rate_limited'],
  ['Windows protected store',Error('Windows Credential Manager failed: PRIVATE_STORE_DETAIL'),'secure_store_unavailable'],
  ['Linux protected store',Error('Linux Secret Service failed: PRIVATE_STORE_DETAIL'),'secure_store_unavailable'],
  ['anchor store',Error('connection_anchor_store_unavailable'),'secure_store_unavailable'],
  ['anchor operation',Error('Windows enrollment anchor operation unavailable or unconfirmed.'),'secure_store_unavailable'],
  ['enrollment binding',Error('Device configuration does not match the secure enrollment anchor. Run dharma login again.'),'enrollment_unconfirmed'],
  ['identity unavailable',Error('relay_host_device_identity_unavailable'),'enrollment_unconfirmed'],
  ['interrupted signing trust install',Error('Interrupted server signing keyset installation could not be verified. Run dharma login again.'),'enrollment_unconfirmed'],
  ['protocol state',Error('Relay protocol state is invalid; preserve the file for recovery and re-enroll if necessary.'),'protocol_state_invalid'],
  ['socket transport',Error('Relay connection failed.'),'relay_transport_unavailable'],
  ['socket timeout',Error('Relay response timed out.'),'relay_response_timeout'],
  ['socket close',Error('Relay closed before acknowledgement (1006).'),'relay_transport_unavailable'],
];
for(const[label,error,category]of cases)test(`session opening identifies ${label} without private detail`,async()=>{
  const events=await observe(error);
  assert.deepEqual(events,[{workspaceId:'workspace_a',code:'repository_relay_failed',stage:'session_open',category}]);
  assert(!JSON.stringify(events).includes('PRIVATE_'));
});
test('forged status and unknown messages remain unexpected',async()=>{
  assert.deepEqual(await observe(Object.assign(Error('PRIVATE_UNKNOWN'),{status:403})),
    [{workspaceId:'workspace_a',code:'repository_relay_failed',stage:'session_open',category:'unexpected'}]);
});
test('throwing error metadata cannot break failure observation',async()=>{
  const errors=[Error('PRIVATE_UNKNOWN'),new AgentFabricRequestError({},503,false)];
  Object.defineProperty(errors[0],'message',{get(){throw Error('PRIVATE_GETTER');}});
  Object.defineProperty(errors[1],'status',{get(){throw Error('PRIVATE_GETTER');}});
  for(const error of errors)assert.deepEqual(await observe(error),
    [{workspaceId:'workspace_a',code:'repository_relay_failed',stage:'session_open',category:'unexpected'}]);
});
for(const category of new Set(cases.map(row=>row[2])))test(`current-process readback accepts ${category} only in the bound context`,()=>{
  const at='2026-10-17T00:16:11.079Z',mtime=Date.parse(at)-1000;
  const receipt={schema:'dharma.local-repository-relay-failure/v1',organizationId:'org_a',deviceId:'device_a',workspaceId:'workspace_a',pid:50,relayPidMtimeMs:mtime,relayPidCtimeMs:mtime,at,stage:'session_open',category,raw:'PRIVATE_DETAIL'};
  const input={receipt,organizationId:'org_a',deviceId:'device_a',workspaceId:'workspace_a',pid:50,relayPidMtimeMs:mtime,relayPidCtimeMs:mtime,lastSuccessfulPollAt:null,now:Date.parse(at)+1000};
  assert.deepEqual(currentRepositoryRelayFailure(input),{at,stage:'session_open',category});
  assert.equal(currentRepositoryRelayFailure({...input,organizationId:'other'}),null);
  assert.equal(currentRepositoryRelayFailure({...input,deviceId:'other'}),null);
  assert.equal(currentRepositoryRelayFailure({...input,workspaceId:'other'}),null);
  assert.equal(currentRepositoryRelayFailure({...input,pid:51}),null);
  assert.equal(currentRepositoryRelayFailure({...input,receipt:{...receipt,category:[category]}}),null);
});

async function actualSessionPrelude(failAt?:'identity'|'handshake') {
  const source=await readFile(new URL('./index.js',import.meta.url),'utf8');
  const ast=ts.createSourceFile('index.js',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS);
  const fn=ast.statements.find(node=>ts.isFunctionDeclaration(node)&&node.name?.text==='relayWorkspaceLoop');
  assert(fn&&ts.isFunctionDeclaration(fn)&&fn.body);
  const statements=fn.body.statements;
  const at=statements.findIndex(node=>ts.isVariableStatement(node)&&node.declarationList.declarations.some(value=>value.name.getText(ast)==='fabric'));
  assert(at>=0);
  const declaration=statements[at];assert(declaration&&ts.isVariableStatement(declaration));
  const initialized=declaration.declarationList.declarations[0]!.initializer;
  assert(initialized&&ts.isAwaitExpression(initialized)&&ts.isCallExpression(initialized.expression));
  assert.equal(initialized.expression.expression.getText(ast),'withRepositoryRelayStage');
  assert.equal(initialized.expression.arguments[0]?.getText(ast),"'session_identity'");
  const handshake=statements[at+1];assert(handshake&&ts.isExpressionStatement(handshake));
  const scope={fixture:true},calls:string[]=[],instance={async openSession(version:string){
    calls.push('handshake');assert.equal(version,'fixture-version');
    if(failAt==='handshake')throw new AgentFabricRequestError({error:{code:'denied',message:'PRIVATE_HANDSHAKE'}},403,true);
  }};
  const probe=runInNewContext(`(async()=>{${declaration.getText(ast)}\n${handshake.getText(ast)}\nreturn fabric;})`,{
    withRepositoryRelayStage,VERSION:'fixture-version',configPath:()=>'/fixture/device.json',protocolStatePath:()=>'/fixture/protocol.json',
    currentBootstrapHostScope:()=>scope,isIsolatedDeviceSession:()=>true,
    AgentFabricClient:{async open(options:{configPath:string;statePath:string;hostScope:unknown;isolatedSession:boolean}){
      calls.push('identity');assert.equal(options.configPath,'/fixture/device.json');assert.equal(options.statePath,'/fixture/protocol.json');
      assert.equal(options.hostScope,scope);assert.equal(options.isolatedSession,true);
      if(failAt==='identity')throw Error('Windows Credential Manager failed: PRIVATE_IDENTITY');return instance;
    }},
  },{timeout:1000}) as ()=>Promise<unknown>;
  return{probe,calls,instance};
}
test('actual relay caller separates identity failure and never attempts handshake afterward',async()=>{
  const f=await actualSessionPrelude('identity');
  assert.deepEqual(await observeOperation(f.probe),[{workspaceId:'workspace_a',code:'repository_relay_failed',stage:'session_identity',category:'secure_store_unavailable'}]);
  assert.deepEqual(f.calls,['identity']);
});
test('actual relay caller attributes handshake failure after initialization',async()=>{
  const f=await actualSessionPrelude('handshake');
  assert.deepEqual(await observeOperation(f.probe),[{workspaceId:'workspace_a',code:'repository_relay_failed',stage:'session_open',category:'relay_authentication_rejected'}]);
  assert.deepEqual(f.calls,['identity','handshake']);
});
test('actual relay caller preserves host scope, isolated mode and exactly one handshake',async()=>{
  const f=await actualSessionPrelude();assert.equal(await f.probe(),f.instance);assert.deepEqual(f.calls,['identity','handshake']);
});
test('current-process parser admits identity-phase failure without private fields',()=>{
  const at='2026-10-17T00:16:11.079Z',mtime=Date.parse(at)-1000;
  const receipt={schema:'dharma.local-repository-relay-failure/v1',organizationId:'org_a',deviceId:'device_a',workspaceId:'workspace_a',pid:50,relayPidMtimeMs:mtime,relayPidCtimeMs:mtime,at,stage:'session_identity',category:'secure_store_unavailable',raw:'PRIVATE_DETAIL'};
  assert.deepEqual(currentRepositoryRelayFailure({receipt,organizationId:'org_a',deviceId:'device_a',workspaceId:'workspace_a',pid:50,relayPidMtimeMs:mtime,relayPidCtimeMs:mtime,lastSuccessfulPollAt:null,now:Date.parse(at)+1000}),
    {at,stage:'session_identity',category:'secure_store_unavailable'});
});
