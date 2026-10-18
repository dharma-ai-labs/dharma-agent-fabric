import assert from 'node:assert/strict';
import {createHash,generateKeyPairSync,randomBytes} from 'node:crypto';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';
import test,{describe} from 'node:test';
import {signCanonicalObject} from '@dharma-ai-labs/agent-fabric-contracts';
import {LocalVault,type LocalProviderSessionBinding} from '@dharma-ai-labs/agent-fabric-local-vault';
import type {CodexToolHandler} from '@dharma-ai-labs/agent-fabric-provider-adapters/experimental/codex-session';
import type {CodexStdioTransport} from '@dharma-ai-labs/agent-fabric-provider-adapters/experimental/codex-transport';
import {openCodexBoundSession,openCodexSigningRecoveryOwner,type CodexBoundSigningRecoveryInput} from './codexBoundSession.js';
import {CODEX_SIGNING_RECOVERY_TOOL,CODEX_SIGNING_RECOVERY_TOOL_HASH} from './codexSigningRecoveryTool.js';

const id=(n:number)=>`d3000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const hash=(value:string)=>'sha256:'+createHash('sha256').update(value).digest('hex');
test('the fixed recovery declaration is deeply immutable and never embeds an operation or approval',()=>{
  assert.ok(Object.isFrozen(CODEX_SIGNING_RECOVERY_TOOL.inputSchema.properties.operationId));
  assert.ok(Object.isFrozen(CODEX_SIGNING_RECOVERY_TOOL.inputSchema.properties.action.enum));
  assert.match(CODEX_SIGNING_RECOVERY_TOOL_HASH,/^sha256:[a-f0-9]{64}$/);
  assert.equal(Object.hasOwn(CODEX_SIGNING_RECOVERY_TOOL.inputSchema.properties.operationId,'const'),false);
  assert.doesNotMatch(JSON.stringify(CODEX_SIGNING_RECOVERY_TOOL),/approved|grant|token|password/);
});
test('the official public surface exposes the purpose-limited recovery owner rather than the unrestricted bound owner',async()=>{
  const api=await import('./index.js');assert.equal(api.openCodexSigningRecoveryOwner,openCodexSigningRecoveryOwner);
  assert.equal(Object.hasOwn(api,'openCodexBoundSession'),false);
});

describe('original Linux bound-controller recovery adoption',{skip:process.platform!=='linux'},()=>{
async function fixture(catalog:string|null=CODEX_SIGNING_RECOVERY_TOOL_HASH){
  const root=await mkdtemp(resolve(tmpdir(),'fabric-original-controller-')),key=randomBytes(32),now=Date.now();
  const binding:LocalProviderSessionBinding={schema:'dharma.local-provider-session-binding/v1',owner:'dharma_bridge',
    organizationId:'org_fixture',workspaceId:id(1),repositoryBindingId:id(2),endpointId:id(3),membershipId:id(4),
    deviceId:id(5),bindingId:id(6),provider:'codex',sessionId:'original_native_thread',workspaceRoot:root,
    createdAt:new Date(now-1000).toISOString(),expiresAt:new Date(now+3600000).toISOString(),maximumProviderCostCents:25};
  const identity={organizationId:binding.organizationId,workspaceId:binding.workspaceId,repositoryBindingId:binding.repositoryBindingId,
    endpointId:binding.endpointId,membershipId:binding.membershipId,deviceId:binding.deviceId,provider:binding.provider};
  const vault=await LocalVault.open({root:resolve(root,'vault'),masterKey:key});vault.saveProviderSessionBinding(binding);
  if(catalog)vault.saveProviderSessionRecoveryDeclaration(binding.bindingId,identity,catalog);
  const old=generateKeyPairSync('ed25519'),device=generateKeyPairSync('ed25519');
  const publicKey=(pair:typeof old)=>pair.publicKey.export({format:'jwk'}).x!;
  const keyset={schema:'dharma.server-signing-keyset/v1',organizationId:binding.organizationId,generation:2,
    keys:[{keyVersion:'synthetic-old',publicKeyEd25519:publicKey(old),status:'active',notBefore:new Date(now-86400000).toISOString(),notAfter:new Date(now-1000).toISOString()}],
    signedByKeyVersion:'synthetic-old',issuedAt:new Date(now-86400000).toISOString(),expiresAt:new Date(now-1000).toISOString()};
  const config={schema:'dharma.device-config/v1',hqUrl:'https://www.dharma-ai.io',organizationId:binding.organizationId,
    installationId:id(7),deviceId:binding.deviceId,deviceName:'Synthetic original controller',platform:'linux',publicKeyEd25519:publicKey(device),
    serverPublicKeyEd25519:publicKey(old),serverSigningKeyset:{...keyset,signature:signCanonicalObject(keyset,old.privateKey)},
    relayUrl:'wss://relay.example.invalid',enrolledAt:new Date(now-172800000).toISOString(),connectionMode:'manual',
    setupClaimReference:id(8),setupClaimRepositoryFingerprint:'sha256:'+'a'.repeat(64)};
  const anchor={schema:'dharma.device-enrollment-anchor/v1',hqUrl:config.hqUrl,organizationId:config.organizationId,
    deviceId:config.deviceId,devicePublicKeyEd25519:config.publicKeyEd25519,serverPublicKeyEd25519:config.serverPublicKeyEd25519,
    serverSigningKeyset:config.serverSigningKeyset,enrolledAt:config.enrolledAt};
  const anchorAccount='device-enrollment-'+hash(`${config.hqUrl}:${config.organizationId}:${config.deviceId}`).slice(7,39);
  const reads:string[]=[],writes:string[]=[],requests:string[]=[],rpc:string[]=[],events=new Set<(value:unknown)=>void>();
  const lifetime=new AbortController(),scope=new AbortController();let handler:CodexToolHandler|undefined,state='idle',reserved=0,closes=0;
  const transport:CodexStdioTransport={signal:lifetime.signal,
    onToolCall(value){assert.equal(handler,undefined);handler=value;return()=>{handler=undefined;};},
    onNotification(value){events.add(value);return()=>{events.delete(value);};},
    async close(){closes++;lifetime.abort();},
    async request(method){rpc.push(method);
      if(method==='permissionProfile/list')return{data:[{id:'dharma_bridge',allowed:true}]};
      if(method==='config/read')return{config:{permissions:{dharma_bridge:{extends:null,workspace_roots:null,
        filesystem:{':minimal':'read',':workspace_roots':{'.':'read'}},network:{enabled:false}}}}};
      if(method==='thread/read')return{thread:{id:binding.sessionId,cwd:root,status:{type:state}}};
      throw Error('unexpected_native_request');
    }};
  const store={backend:'linux-secret-service' as const,
    async get(account:string){reads.push(account);return account===anchorAccount?JSON.stringify(anchor):null;},
    async put(account:string){writes.push(account);},async delete(account:string){writes.push(account);}};
  const configPath=resolve(root,'device.json');await writeFile(configPath,JSON.stringify(config));
  const recovery={configPath,source:{organizationId:binding.organizationId,workspaceId:binding.workspaceId,repositoryBindingId:binding.repositoryBindingId,
    repositoryFingerprint:config.setupClaimRepositoryFingerprint,policyRevision:'agent-fabric-policy-v1',scopeDigest:'sha256:'+'b'.repeat(64),
    contractDigest:'sha256:'+'c'.repeat(64),sourceGenerationId:id(9),sourceReceiptId:'repo_consent_'+id(9),sourceRevision:1,
    sourcePolicyRevision:'repository-source-'+id(9),sourcePolicyHash:'sha256:'+'d'.repeat(64)},store,
    fetcher:(async()=>{requests.push('unexpected');throw Error('no_live_http');}) as typeof fetch};
  const intent:CodexBoundSigningRecoveryInput={operationId:id(10),signal:scope.signal,recovery,current:async()=>true,
    authorize:async phase=>phase==='prepare'};
  const owner=await openCodexBoundSession({vault,bindingId:binding.bindingId,identity,openTransport:async()=>transport,
    verifier:{resolvePublicKey:()=>null,consume:async()=>false},budget:{reserve:async()=>{reserved++;return true;}}});
  const emit=(method:string)=>{state=method==='turn/started'?'active':'idle';for(const event of [...events])event({method,
    params:{threadId:binding.sessionId,turn:{id:'original_live_turn',status:state==='active'?'inProgress':'completed'}}});};
  const call=async(action:string)=>{assert.ok(handler);return handler({threadId:binding.sessionId,turnId:'original_live_turn',
    callId:'actual_call',namespace:null,tool:'dharma_signing_recovery',arguments:{operationId:id(10),action}},{signal:scope.signal});};
  return{root,key,vault,binding,identity,transport,intent,owner,reads,writes,requests,rpc,emit,call,scope,
    get reserved(){return reserved;},get closes(){return closes;},get handler(){return handler;},
    cleanup:async()=>{await owner.close();vault.close();key.fill(0);await rm(root,{recursive:true,force:true});}};
}

test('a legacy or unknown catalog is refused without native requests, journal claims, key reads or budget',async()=>{
  for(const catalog of [null,'sha256:'+'f'.repeat(64)]){
    const f=await fixture(catalog);try{
      const owner=f.owner;
      await assert.rejects(owner.beginSigningRecovery(f.intent),/catalog_unavailable/);
      assert.deepEqual(f.rpc,[]);assert.deepEqual(f.reads,[]);assert.equal(f.reserved,0);
    }finally{await f.cleanup().catch(()=>{});}
  }
});

test('the actual original bound controller derives identity, prepares through the real client and never dispatches a turn',async()=>{
  const f=await fixture();try{
    const host=await f.owner.beginSigningRecovery(f.intent);
    assert.deepEqual(f.reads,[]);assert.equal(f.reserved,0);
    await assert.rejects(f.owner.runQuestion({question:{}}),/recovery_only/);
    f.emit('turn/started');const response=await f.call('prepare');assert.equal(response.success,true);
    const value=JSON.parse(response.contentItems[0]!.type==='inputText'?response.contentItems[0]!.text:'null');
    assert.equal(value.threadId,f.binding.sessionId);assert.equal(value.turnId,'original_live_turn');assert.equal(value.ready,false);
    assert.equal(value.progress.state,'prepared');assert.ok(f.reads.length>0);assert.deepEqual(f.writes,[]);assert.deepEqual(f.requests,[]);
    assert.equal((await f.call('submit')).success,false);
    assert.equal(f.rpc.some(method=>/start|resume|fork|interrupt/.test(method)),false);
    f.emit('turn/completed');await host.settled;
    await assert.rejects(f.owner.runWork({workId:'not-a-new-grant',prompt:'Do work',maximumProviderCostCents:1}),/recovery_only/);
    await assert.rejects(f.owner.beginSigningRecovery({...f.intent,operationId:id(11)}),/owner_consumed/);
    assert.equal(f.vault.getProviderSessionBinding(f.binding.bindingId,f.identity)!.sessionId,f.binding.sessionId);
  }finally{await f.cleanup();}
});

test('durable admission cannot replay the operation after the original owner closes',async()=>{
  const f=await fixture();try{
    const host=await f.owner.beginSigningRecovery(f.intent);await host.close();await f.owner.close();
    const nextLifetime=new AbortController();let nextRpc=0;
    const next=await openCodexBoundSession({vault:f.vault,bindingId:f.binding.bindingId,identity:f.identity,
      openTransport:async()=>({...f.transport,signal:nextLifetime.signal,close:async()=>{nextLifetime.abort();},
        request:async()=>{nextRpc++;throw Error('must_not_reach_native');}}),
      verifier:{resolvePublicKey:()=>null,consume:async()=>false},budget:{reserve:async()=>false}});
    try{await assert.rejects(next.beginSigningRecovery(f.intent),/operation_consumed/);assert.equal(nextRpc,0);}
    finally{await next.close();}
    assert.deepEqual(f.reads,[]);assert.deepEqual(f.requests,[]);
  }finally{await f.cleanup();}
});

test('current source revocation and accessor-bearing inputs stop before a handler or protected effect',async()=>{
  const f=await fixture();let getters=0;try{
    const unsafe={...f.intent};Object.defineProperty(unsafe,'authorize',{enumerable:true,get(){getters++;return()=>true;}});
    await assert.rejects(f.owner.beginSigningRecovery(unsafe),/input_invalid/);assert.equal(getters,0);
    await assert.rejects(f.owner.beginSigningRecovery({...f.intent,current:async()=>false}),/scope_unavailable/);
    assert.equal(f.handler,undefined);assert.deepEqual(f.rpc,[]);assert.deepEqual(f.reads,[]);assert.equal(f.reserved,0);
  }finally{await f.cleanup();}
});

test('a private session selection cannot be supplied by the caller',async()=>{
  const f=await fixture();try{
    await assert.rejects(f.owner.beginSigningRecovery({...f.intent,recovery:{...f.intent.recovery,session:{sessionId:'foreign'}}} as any),/input_invalid/);
    assert.deepEqual(f.rpc,[]);assert.deepEqual(f.reads,[]);assert.equal(f.handler,undefined);
  }finally{await f.cleanup();}
});

test('revocation during awaited qualification is observed before durable admission or native metadata',async()=>{
  const f=await fixture();try{
    await assert.rejects(f.owner.beginSigningRecovery({...f.intent,current:async()=>{
      f.vault.revokeProviderSessionBinding(f.binding.bindingId,f.identity);return true;
    }}),/scope_unavailable/);
    assert.equal(f.handler,undefined);assert.deepEqual(f.rpc,[]);assert.deepEqual(f.reads,[]);
  }finally{await f.cleanup();}
});

test('close waits for pending qualification and cannot leave a late handler or released live owner',async()=>{
  const f=await fixture();let release!:()=>void,entered!:()=>void;
  const gate=new Promise<void>(done=>{release=done;}),arrived=new Promise<void>(done=>{entered=done;});
  try{
    const opening=f.owner.beginSigningRecovery({...f.intent,current:async()=>{entered();await gate;return true;}});
    const rejected=assert.rejects(opening,/scope_unavailable/);await arrived;
    await assert.rejects(f.owner.runQuestion({question:{}}),/busy/);
    let closed=false;const closing=f.owner.close().then(()=>{closed=true;});
    await Promise.resolve();assert.equal(closed,false);assert.equal(f.closes,0);
    release();await rejected;await closing;
    assert.equal(f.closes,1);assert.equal(f.handler,undefined);assert.deepEqual(f.rpc,[]);assert.deepEqual(f.reads,[]);
    const lease=f.vault.tryAcquireProviderSessionLease(f.binding.bindingId,f.identity);assert.ok(lease);lease.release();
  }finally{release?.();await f.cleanup();}
});

test('the public recovery owner refuses a legacy catalog before its transport factory and offers no peer/work turn',async()=>{
  const legacy=await fixture(null);try{
    let opened=0;
    await assert.rejects(openCodexSigningRecoveryOwner({vault:legacy.vault,bindingId:legacy.binding.bindingId,identity:legacy.identity,
      openTransport:async()=>{opened++;throw Error('must_not_open');}}),/catalog_unavailable/);
    assert.equal(opened,0);
  }finally{await legacy.cleanup();}
  const f=await fixture();try{
    await f.owner.close();const lifetime=new AbortController();
    const owner=await openCodexSigningRecoveryOwner({vault:f.vault,bindingId:f.binding.bindingId,identity:f.identity,
      openTransport:async()=>({...f.transport,signal:lifetime.signal,close:async()=>{lifetime.abort();}})});
    try{assert.deepEqual(Object.keys(owner).sort(),['assertActive','beginSigningRecovery','close']);
      const host=await owner.beginSigningRecovery(f.intent);await host.close();
      assert.deepEqual(f.reads,[]);assert.deepEqual(f.requests,[]);assert.equal(f.reserved,0);
    }finally{await owner.close();}
  }finally{await f.cleanup();}
});
});
