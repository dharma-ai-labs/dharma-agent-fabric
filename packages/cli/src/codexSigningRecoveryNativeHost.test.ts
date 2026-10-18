import assert from 'node:assert/strict';
import {createHash,generateKeyPairSync} from 'node:crypto';
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {tmpdir} from 'node:os';
import test from 'node:test';
import {canonicalize,parseDeviceSigningRecoveryPreparation,sealDeviceSigningRecoveryDelivery,signCanonicalObject,validateContract,
  type DeviceSigningRecoveryPreparation,type DeviceSigningRecoveryChallenge,type DeviceSigningRecoveryCandidate}
  from '@dharma-ai-labs/agent-fabric-contracts';
import type {CodexStdioTransport} from '@dharma-ai-labs/agent-fabric-provider-adapters/experimental/codex-transport';
import type {CodexToolHandler} from '@dharma-ai-labs/agent-fabric-provider-adapters/experimental/codex-session';
import type {PrepareOwnedSigningRecoveryInput,SecureSecretStore} from '@dharma-ai-labs/agent-fabric-relay-client';
import * as cli from './index.js';

const NOW=Date.parse('2030-01-01T00:00:00.000Z');
const id=(n:number)=>`d1000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const hash=(value:string|Buffer)=>'sha256:'+createHash('sha256').update(value).digest('hex');
function api(){
  const value=(cli as unknown as Record<string,unknown>).attachCodexSigningRecoveryNativeHost;
  assert.equal(typeof value,'function','official native recovery ingress is missing');
  return value as (input:any)=>Promise<any>;
}
async function fixture(){
  const root=await mkdtemp(resolve(tmpdir(),'fabric-native-recovery-')),configPath=resolve(root,'device.json');
  const old=generateKeyPairSync('ed25519'),device=generateKeyPairSync('ed25519'),next=generateKeyPairSync('ed25519');
  const publicKey=(p:typeof old)=>p.publicKey.export({format:'jwk'}).x!;
  const body={schema:'dharma.server-signing-keyset/v1',organizationId:'org_fixture',generation:2,
    keys:[{keyVersion:'synthetic-old',publicKeyEd25519:publicKey(old),status:'active',
      notBefore:new Date(NOW-86400000).toISOString(),notAfter:new Date(NOW-1000).toISOString()}],
    signedByKeyVersion:'synthetic-old',issuedAt:new Date(NOW-86400000).toISOString(),expiresAt:new Date(NOW-1000).toISOString()};
  const config={schema:'dharma.device-config/v1',hqUrl:'https://www.dharma-ai.io',organizationId:'org_fixture',
    installationId:id(1),deviceId:id(2),deviceName:'Synthetic native ingress',platform:'linux',publicKeyEd25519:publicKey(device),
    serverPublicKeyEd25519:publicKey(old),serverSigningKeyset:{...body,signature:signCanonicalObject(body,old.privateKey)},
    relayUrl:'wss://relay.example.invalid',enrolledAt:'2029-12-01T00:00:00.000Z',connectionMode:'manual',
    setupClaimReference:id(3),setupClaimRepositoryFingerprint:'sha256:'+'a'.repeat(64)};
  const anchor={schema:'dharma.device-enrollment-anchor/v1',hqUrl:config.hqUrl,organizationId:config.organizationId,
    deviceId:config.deviceId,devicePublicKeyEd25519:config.publicKeyEd25519,serverPublicKeyEd25519:config.serverPublicKeyEd25519,
    serverSigningKeyset:config.serverSigningKeyset,enrolledAt:config.enrolledAt};
  const anchorAccount='device-enrollment-'+hash(`${config.hqUrl}:${config.organizationId}:${config.deviceId}`).slice(7,39);
  const identityAccount='device-key-'+hash(`${config.hqUrl}:${config.organizationId}:${config.installationId}`).slice(7,39);
  const values=new Map([[anchorAccount,JSON.stringify(anchor)],[identityAccount,JSON.stringify(device.privateKey.export({format:'jwk'}))]]);
  const reads:string[]=[],writes:string[]=[],requests:string[]=[],authorizations:string[]=[],rpc:string[]=[];
  const lifetime=new AbortController(),scope=new AbortController(),listeners=new Set<(event:unknown)=>void>();
  let handler:CodexToolHandler|undefined,allowed=true,permission=true,network=false,threadState='idle',clock=NOW;
  let offered=false,published=false,registered=false,preparation:DeviceSigningRecoveryPreparation|undefined,challenge:DeviceSigningRecoveryChallenge|undefined;
  const nextBody={...body,generation:3,signedByKeyVersion:'synthetic-new',issuedAt:new Date(NOW).toISOString(),
    expiresAt:new Date(NOW+86400000).toISOString(),keys:[{keyVersion:'synthetic-new',publicKeyEd25519:publicKey(next),
      status:'active' as const,notBefore:new Date(NOW).toISOString(),notAfter:new Date(NOW+86400000).toISOString()}]};
  const nextKeyset={...nextBody,signature:signCanonicalObject(nextBody,next.privateKey)};
  let phasePolicy=(phase:string)=>phase!=='complete',beforeKeyRead:(()=>void)|undefined,waitRead:((name:string)=>Promise<void>)|undefined;
  let fetchPolicy:((url:string,init:RequestInit)=>Promise<Response>)|undefined;
  const store:SecureSecretStore={backend:'linux-secret-service',get:async name=>{
    reads.push(name);await waitRead?.(name);if(name===identityAccount)beforeKeyRead?.();return values.get(name)??null;},
    getFresh:async name=>{reads.push(name);await waitRead?.(name);if(name===identityAccount)beforeKeyRead?.();return values.get(name)??null;},
    put:async(name,value)=>{writes.push(name);values.set(name,value);},delete:async()=>{throw Error('FORBIDDEN_STORE_DELETE');}};
  const source={organizationId:config.organizationId,workspaceId:id(4),repositoryBindingId:id(5),repositoryFingerprint:config.setupClaimRepositoryFingerprint,
    policyRevision:'agent-fabric-policy-v1',scopeDigest:'sha256:'+'b'.repeat(64),contractDigest:'sha256:'+'c'.repeat(64),
    sourceGenerationId:id(6),sourceReceiptId:'repo_consent_'+id(6),sourceRevision:1,sourcePolicyRevision:'repository-source-'+id(6),sourcePolicyHash:'sha256:'+'d'.repeat(64)};
  const session={organizationId:config.organizationId,workspaceId:id(4),repositoryBindingId:id(5),endpointId:id(7),membershipId:id(8),
    deviceId:id(2),bindingId:id(9),provider:'codex' as const,owner:'dharma_bridge' as const,sessionId:'synthetic_native_thread',
    createdAt:new Date(NOW-1000).toISOString(),expiresAt:new Date(NOW+60000).toISOString(),maximumProviderCostCents:25};
  const transport:CodexStdioTransport={signal:lifetime.signal,close:async()=>{throw Error('DO_NOT_STOP_CALLER_TRANSPORT');},
    onNotification:next=>{listeners.add(next);return()=>{listeners.delete(next);};},
    onToolCall:next=>{assert.equal(handler,undefined);handler=next;return()=>{handler=undefined;};},
    request:async(method,params)=>{
      rpc.push(method);
      if(method==='permissionProfile/list')return {data:[{id:'dharma_bridge',allowed:permission}]};
      if(method==='config/read')return {config:{permissions:{dharma_bridge:{filesystem:{':minimal':'read',':workspace_roots':{'.':'read'}},network:{enabled:network}}}}};
      if(method==='thread/read'){assert.equal(params.threadId,session.sessionId);assert.equal(params.includeTurns,false);
        return {thread:{id:session.sessionId,cwd:root,status:{type:threadState}}};}
      throw Error('NO_START_RESUME_FORK_OR_MODEL_REQUEST');
    }};
  const fetcher=(async(url:string|URL|Request,init?:RequestInit)=>{
    requests.push(String(url));if(fetchPolicy)return fetchPolicy(String(url),init!);
    const path=new URL(String(url)).pathname;assert.equal(new URL(String(url)).origin,config.hqUrl);
    const request=JSON.parse(String(init!.body));
    if(path.endsWith('/preparations')){
      preparation=parseDeviceSigningRecoveryPreparation(request.preparation,request.preparation.plan,clock);
      const {schema,planId,authority,preparedAt,expiresAt,...bound}=preparation.plan;void[schema,authority,preparedAt];
      challenge={...bound,schema:'dharma.device-signing-recovery-challenge/v1',purpose:'expired_signing_trust_reapproval',
        recoveryId:id(30),approvalId:id(31),credentialEncryptionPublicKey:preparation.credentialEncryptionPublicKey,candidateGeneration:3,
        candidateKeysetHash:hash(canonicalize(nextKeyset)),candidateRootFingerprint:hash(Buffer.from(publicKey(next),'base64url')),
        candidateKeyVersionFingerprint:hash(nextKeyset.signedByKeyVersion),method:'POST',path:'/api/v1/agent-fabric/signing-recovery',
        nonce:Buffer.alloc(32,7).toString('base64url'),authenticator:Buffer.alloc(32,8).toString('base64url'),
        issuedAt:new Date(clock).toISOString(),expiresAt};
      return Response.json({schema:'dharma.signing-recovery-preparation-receipt/v1',preparationId:planId,
        organizationId:config.organizationId,recipientMembershipId:session.membershipId,deviceId:config.deviceId,
        expiresAt,state:'pending_browser_review',clientTrustInstalled:false,nativeSessionBinding:'device_attested_not_verified'});
    }
    assert.ok(preparation&&challenge);
    const common={schema:'dharma.device-signing-recovery-offer-response/v1',organizationId:config.organizationId,deviceId:config.deviceId,
      preparationId:preparation.plan.planId,ready:false,clientTrustInstalled:false};
    if(path.endsWith('/offers/read'))return Response.json(!offered?{...common,state:'awaiting_browser_offer',deviceProofRegistered:false,
      expiresAt:preparation.plan.expiresAt}:{...common,state:registered?'pending_approval':'awaiting_device_proof',deviceProofRegistered:registered,
      expiresAt:challenge.expiresAt,challenge});
    if(path.endsWith('/offers/register')){registered=true;return Response.json({...common,
      schema:'dharma.device-signing-recovery-offer-registration-receipt/v1',recoveryId:challenge.recoveryId,approvalId:challenge.approvalId,
      state:'pending_approval',deviceProofRegistered:true,expiresAt:challenge.expiresAt});}
    assert.equal(path,'/api/v1/agent-fabric/signing-recovery');if(!published)return new Response(null,{status:409});
    const candidate:DeviceSigningRecoveryCandidate={schema:'dharma.device-signing-recovery-candidate/v1',organizationId:config.organizationId,
      recoveryId:challenge.recoveryId,approvalId:challenge.approvalId,keysetCanonical:canonicalize(nextKeyset),rootPublicKey:publicKey(next),
      publication:{schema:'dharma.signing-recovery-publication/v1',organizationId:config.organizationId,recoveryId:challenge.recoveryId,
        generation:3,artifactHash:'sha256:'+'e'.repeat(64),publishedAt:new Date(clock).toISOString()}};
    return Response.json({ok:true,delivery:sealDeviceSigningRecoveryDelivery(challenge,candidate,clock),clientTrustInstalled:false,
      nativeSessionBinding:'device_attested_not_independently_observed'});
  }) as typeof fetch;
  const recovery:Omit<PrepareOwnedSigningRecoveryInput,'hostScope'|'hostBinding'>={configPath,source,session,store,fetcher,now:()=>clock};
  const input={transport,workspace:root,recovery,operationId:id(10),hostContextId:id(11),connectionId:id(12),signal:scope.signal,
    current:async()=>allowed,authorize:async(phase:string)=>{authorizations.push(phase);return phasePolicy(phase);}};
  const emit=(method:string,turn='synthetic_original_turn',thread=session.sessionId)=>{
    if(thread===session.sessionId)threadState=method==='turn/started'?'active':'idle';
    for(const listener of [...listeners])listener({method,params:{threadId:thread,turn:{id:turn,status:method==='turn/started'?'inProgress':'completed'}}});
  };
  const call=async(action:string,patch:Record<string,unknown>={},signal=new AbortController().signal)=>{
    assert.ok(handler,'original handler is not registered');return handler({threadId:session.sessionId,turnId:'synthetic_original_turn',
      callId:'call_fixture',namespace:null,tool:'dharma_signing_recovery',arguments:{operationId:id(10),action},...patch},{signal});};
  await writeFile(configPath,JSON.stringify(config));
  return {root,input,emit,call,reads,writes,requests,authorizations,rpc,identityAccount,scope,lifetime,
    offer:()=>{offered=true;},publish:()=>{published=true;},configPath,
    revoke:()=>{allowed=false;},phasePolicy:(fn:typeof phasePolicy)=>{phasePolicy=fn;},network:(value:boolean)=>{network=value;},
    permission:(value:boolean)=>{permission=value;},clock:(value:number)=>{clock=value;},beforeKey:(fn:()=>void)=>{beforeKeyRead=fn;},
    waitRead:(fn:NonNullable<typeof waitRead>)=>{waitRead=fn;},
    dropAnchor:()=>{values.delete(anchorAccount);},
    fetchPolicy:(fn:NonNullable<typeof fetchPolicy>)=>{fetchPolicy=fn;},
    get handlers(){return {handler:!!handler,listeners:listeners.size};},
    cleanup:async()=>{assert.equal(resolve(root,'..'),resolve(tmpdir()));await rm(root,{recursive:true,force:true});}};
}
function content(result:any){const value=JSON.parse(result.contentItems[0].text);assert.doesNotMatch(JSON.stringify(value),/privateJwk|authenticator|credentialEncryption|signature|PRIVATE_CANARY/);return value;}

test('native ingress waits for a genuine turn event, then performs actual fenced preparation and submission',async()=>{
  const attach=api(),f=await fixture();let host:any;
  try{
    host=await attach(f.input);assert.equal(f.reads.length,0);assert.equal(f.requests.length,0);
    assert.equal((await f.call('prepare')).success,false);
    f.emit('turn/started');const prepared=await f.call('prepare');assert.equal(prepared.success,true);
    const value=content(prepared);assert.equal(value.turnId,'synthetic_original_turn');assert.equal(value.progress.state,'prepared');
    assert.equal(value.ready,false);assert.equal(f.reads.includes(f.identityAccount),false);
    const valid=await validateContract(resolve('schemas'),'https://schemas.dharma-ai.io/codex-signing-recovery-native-progress/v1',value);
    assert.equal(valid.ok,true,JSON.stringify(valid));
    const submitted=content(await f.call('submit'));assert.equal(submitted.progress.state,'awaiting_browser_offer');
    assert.equal(submitted.progress.clientTrustInstalled,false);assert.equal(f.requests.length,1);
    assert.equal(f.reads.filter(x=>x===f.identityAccount).length,1);
    assert.equal((await f.call('submit')).success,false);assert.equal(f.requests.length,1);
    f.emit('turn/completed');await host.settled;assert.deepEqual(f.handlers,{handler:false,listeners:0});
    assert.equal(f.rpc.some(x=>/start|resume|interrupt|fork/.test(x)),false);
  }finally{await host?.close();await f.cleanup();}
});

test('foreign turns, peer tools, changed IDs and extra authorization fields have no protected effect',async()=>{
  const attach=api(),f=await fixture();let host:any;
  try{
    host=await attach(f.input);f.emit('turn/started');
    for(const patch of [{turnId:'other_turn'},{threadId:'other_thread'},{tool:'dharma_peer_ask'},
      {arguments:{operationId:id(13),action:'prepare'}},{arguments:{operationId:id(10),action:'prepare',approved:true}},
      {arguments:{operationId:id(10),action:'shell'}},{namespace:'foreign'}])assert.equal((await f.call('prepare',patch)).success,false);
    assert.equal(f.reads.length,0);assert.equal(f.requests.length,0);
    f.emit('turn/completed','foreign_turn','foreign_thread');assert.equal((await f.call('prepare')).success,true);
  }finally{await host?.close();await f.cleanup();}
});

test('each protected phase needs current owning-host authorization, never a cached approval',async()=>{
  const attach=api(),f=await fixture();let host:any;
  try{
    host=await attach(f.input);f.emit('turn/started');assert.equal((await f.call('prepare')).success,true);
    f.phasePolicy(phase=>phase==='prepare');assert.equal((await f.call('submit')).success,false);
    assert.equal(f.reads.includes(f.identityAccount),false);assert.equal(f.requests.length,0);
    f.phasePolicy(()=>true);assert.equal((await f.call('submit')).success,true);
    f.phasePolicy(()=>false);assert.equal((await f.call('complete')).success,false);assert.equal(f.requests.length,1);
  }finally{await host?.close();await f.cleanup();}
});

test('scope revocation during an official device-key read prevents the network request',async()=>{
  const attach=api(),f=await fixture();let host:any;
  try{host=await attach(f.input);f.emit('turn/started');await f.call('prepare');f.beforeKey(f.revoke);
    assert.equal((await f.call('submit')).success,false);assert.equal(f.requests.length,0);
  }finally{await host?.close();await f.cleanup();}
});

test('a second native turn withdraws the adapter rather than carrying setup authority forward',async()=>{
  const attach=api(),f=await fixture();let host:any;
  try{host=await attach(f.input);f.emit('turn/started');await f.call('prepare');
    f.emit('turn/started','next_turn');await host.settled;assert.deepEqual(f.handlers,{handler:false,listeners:0});
    assert.equal(f.requests.length,0);
  }finally{await host?.close();await f.cleanup();}
});

test('native permission drift and expired source/session lifetime fail before private identity access',async()=>{
  const attach=api();for(const change of ['network','profile','expiry']){const f=await fixture();let host:any;
    try{host=await attach(f.input);f.emit('turn/started');await f.call('prepare');
      if(change==='network')f.network(true);if(change==='profile')f.permission(false);if(change==='expiry')f.clock(NOW+60001);
      assert.equal((await f.call('submit')).success,false);assert.equal(f.reads.includes(f.identityAccount),false);assert.equal(f.requests.length,0);
    }finally{await host?.close();await f.cleanup();}}
});

test('cancellation of an owned submission settles a noncooperative response without retry or secret output',async()=>{
  const attach=api(),f=await fixture();let host:any;let entered!:()=>void;const started=new Promise<void>(r=>{entered=r;});
  try{host=await attach(f.input);f.emit('turn/started');await f.call('prepare');
    f.fetchPolicy(async()=>{entered();return new Promise<Response>(()=>{});});
    const controller=new AbortController(),pending=f.call('submit',{},controller.signal);await started;controller.abort();
    const result=await pending;assert.equal(result.success,false);content(result);await host.settled;
    assert.equal(f.requests.length,1);assert.deepEqual(f.handlers,{handler:false,listeners:0});
  }finally{await host?.close();await f.cleanup();}
});

test('native ingress refuses cooperative/foreign bindings and unsafe profiles before registering a handler',async()=>{
  const attach=api();for(const change of ['owner','source','profile']){const f=await fixture();
    try{if(change==='owner')(f.input.recovery.session as any).owner='cooperative_session';
      if(change==='source')f.input.recovery.source.workspaceId=id(99);if(change==='profile')f.network(true);
      await assert.rejects(attach(f.input));assert.deepEqual(f.handlers,{handler:false,listeners:0});assert.equal(f.reads.length,0);
    }finally{await f.cleanup();}}
});

test('uncertain submission status retains the actual client disposition and cannot be silently replayed',async()=>{
  const attach=api(),f=await fixture();let host:any;
  try{host=await attach(f.input);f.emit('turn/started');await f.call('prepare');
    f.fetchPolicy(async()=>new Response(null,{status:500}));
    assert.equal((await f.call('submit')).success,false);
    assert.equal(content(await f.call('status')).progress.state,'submission_unconfirmed');
    assert.equal((await f.call('submit')).success,false);assert.equal(f.requests.length,1);
  }finally{await host?.close();await f.cleanup();}
});

test('non-string actions and accessor-bearing tool arguments are rejected without coercion or protected access',async()=>{
  const attach=api(),f=await fixture();let host:any;let coercions=0;
  try{host=await attach(f.input);f.emit('turn/started');
    const action={toString(){coercions++;return 'prepare';}};
    assert.equal((await f.call('prepare',{arguments:{operationId:id(10),action}})).success,false);
    const args={operationId:id(10),get action(){coercions++;return 'prepare';}};
    assert.equal((await f.call('prepare',{arguments:args})).success,false);
    assert.equal(coercions,0);assert.equal(f.reads.length,0);assert.equal(f.requests.length,0);
  }finally{await host?.close();await f.cleanup();}
});

test('closing waits for an already admitted noncooperative key read and permits no subsequent network effect',async()=>{
  const attach=api(),f=await fixture();let host:any,release!:()=>void,entered!:()=>void;
  const started=new Promise<void>(r=>{entered=r;}),blocked=new Promise<void>(r=>{release=r;});
  try{host=await attach(f.input);f.emit('turn/started');await f.call('prepare');
    f.waitRead(async name=>{if(name===f.identityAccount){entered();await blocked;}});
    const pending=f.call('submit');await started;
    assert.equal((await f.call('status')).success,false);
    let settled=false;const closing=host.close().then(()=>{settled=true;});
    await new Promise<void>(r=>setImmediate(r));assert.equal(settled,false);
    release();assert.equal((await pending).success,false);await closing;assert.equal(settled,true);
    assert.equal(f.requests.length,0);assert.deepEqual(f.handlers,{handler:false,listeners:0});
  }finally{release?.();await host?.close();await f.cleanup();}
});

test('a consumed operation cannot be reattached and a terminal event without a start cannot bind a later turn',async()=>{
  const attach=api(),f=await fixture();let host:any;
  try{host=await attach(f.input);f.emit('turn/started');await f.call('prepare');f.emit('turn/completed');await host.settled;
    await assert.rejects(attach(f.input));assert.deepEqual(f.handlers,{handler:false,listeners:0});
    host=await attach({...f.input,operationId:id(20)});f.emit('turn/completed');await host.settled;
    assert.deepEqual(f.handlers,{handler:false,listeners:0});
  }finally{await host?.close();await f.cleanup();}
});

test('failed preparation cannot repeat protected-anchor access inside the same native operation',async()=>{
  const attach=api(),f=await fixture();let host:any;
  try{host=await attach(f.input);f.emit('turn/started');f.dropAnchor();
    assert.equal((await f.call('prepare')).success,false);const reads=f.reads.length;assert.ok(reads>0);
    assert.equal((await f.call('prepare')).success,false);assert.equal(f.reads.length,reads);assert.equal(f.requests.length,0);
  }finally{await host?.close();await f.cleanup();}
});

test('all four phases connect to the actual client while owner publication admission and readiness stay separate',async()=>{
  const attach=api(),f=await fixture();let host:any;
  try{host=await attach(f.input);f.emit('turn/started');
    await f.call('prepare');await f.call('submit');f.offer();
    const pending=content(await f.call('progress'));assert.equal(pending.progress.state,'pending_approval');
    assert.equal((await f.call('complete')).success,false);assert.equal(f.writes.length,0);
    f.publish();f.phasePolicy(()=>true);
    const complete=content(await f.call('complete'));assert.equal(complete.progress.state,'trust_installed');
    assert.equal(complete.progress.clientTrustInstalled,true);assert.equal(complete.ready,false);
    assert.equal(complete.threadId,'synthetic_native_thread');assert.equal(complete.turnId,'synthetic_original_turn');
    assert.ok(f.writes.length>0);const installed=JSON.parse(await readFile(f.configPath,'utf8'));
    assert.equal(installed.serverSigningKeyset.generation,3);assert.equal(installed.deviceId,id(2));
    assert.equal(installed.installationId,id(1));assert.equal(installed.setupClaimReference,id(3));
    const count=f.requests.length;assert.equal((await f.call('complete')).success,false);assert.equal(f.requests.length,count);
  }finally{await host?.close();await f.cleanup();}
});
