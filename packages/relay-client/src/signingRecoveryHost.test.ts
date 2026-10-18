import assert from 'node:assert/strict';
import {createHash,generateKeyPairSync,verify} from 'node:crypto';
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {basename,dirname,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {createServer,type Server} from 'node:http';
import type {AddressInfo} from 'node:net';
import test from 'node:test';
import {canonicalize,deviceSigningRecoveryPreparationSigningPayload,deviceSigningRecoverySigningPayload,
  parseDeviceSigningRecoveryPreparation,sealDeviceSigningRecoveryDelivery,signCanonicalObject,validateContract,
  type DeviceSigningRecoveryPreparation,type DeviceSigningRecoveryChallenge,type DeviceSigningRecoveryCandidate}
  from '@dharma-ai-labs/agent-fabric-contracts';
import * as relay from './index.js';
import type {DeviceConfig,SecureSecretStore} from './index.js';

const NOW=Date.parse('2030-01-01T00:00:00.000Z');
const id=(n:number)=>`c1000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const hash=(b:string|Buffer)=>'sha256:'+createHash('sha256').update(b).digest('hex');
const digest=(c:string)=>'sha256:'+c.repeat(64);
function api(){
  const names=['prepareOwnedSigningRecovery','submitOwnedSigningRecoveryPreparation','progressOwnedSigningRecoveryOffer',
    'completeOwnedSigningRecovery','inspectOwnedSigningRecovery','disposeOwnedSigningRecovery'] as const;
  const out:Record<string,(...input:any[])=>any>={};
  for(const name of names){const value=(relay as unknown as Record<string,unknown>)[name];assert.equal(typeof value,'function',name);out[name]=value as never;}
  return out;
}
async function fixture(){
  const old=generateKeyPairSync('ed25519'),next=generateKeyPairSync('ed25519'),device=generateKeyPairSync('ed25519');
  const pub=(p:typeof old)=>p.publicKey.export({format:'jwk'}).x!;
  const keyset=(p:typeof old,generation:number,issued:number,expiry:number)=>{
    const body={schema:'dharma.server-signing-keyset/v1' as const,organizationId:'org_fixture',generation,
      keys:[{keyVersion:'fixture-version-'+generation,publicKeyEd25519:pub(p),status:'active' as const,
        notBefore:new Date(issued).toISOString(),notAfter:new Date(expiry).toISOString()}],signedByKeyVersion:'fixture-version-'+generation,
      issuedAt:new Date(issued).toISOString(),expiresAt:new Date(expiry).toISOString()};
    return {...body,signature:signCanonicalObject(body,p.privateKey)};
  };
  const parent=resolve(tmpdir()),root=await mkdtemp(resolve(parent,'fabric-owned-recovery-')),configPath=resolve(root,'device.json');
  const config:DeviceConfig={schema:'dharma.device-config/v1',hqUrl:'https://www.dharma-ai.io',organizationId:'org_fixture',
    installationId:id(1),deviceId:id(2),deviceName:'Synthetic owned host',platform:'linux',publicKeyEd25519:pub(device),
    serverPublicKeyEd25519:pub(old),serverSigningKeyset:keyset(old,2,NOW-86400000,NOW-1000),
    relayUrl:'wss://relay.example.invalid',enrolledAt:'2029-12-01T00:00:00.000Z',connectionMode:'manual',
    setupClaimReference:id(3),setupClaimRepositoryFingerprint:digest('a')};
  const anchor={schema:'dharma.device-enrollment-anchor/v1',hqUrl:config.hqUrl,organizationId:config.organizationId,
    deviceId:config.deviceId,devicePublicKeyEd25519:config.publicKeyEd25519,serverPublicKeyEd25519:config.serverPublicKeyEd25519,
    serverSigningKeyset:config.serverSigningKeyset,enrolledAt:config.enrolledAt};
  const anchorAccount='device-enrollment-'+hash(`${config.hqUrl}:${config.organizationId}:${config.deviceId}`).slice(7,39);
  const identityAccount='device-key-'+hash(`${config.hqUrl}:${config.organizationId}:${config.installationId}`).slice(7,39);
  const privateIdentity=JSON.stringify(device.privateKey.export({format:'jwk'}));
  const values=new Map([[anchorAccount,JSON.stringify(anchor)],[identityAccount,privateIdentity]]),reads:string[]=[],writes:string[]=[];
  const store:SecureSecretStore={backend:'linux-secret-service',get:async name=>{reads.push(name);return values.get(name)??null;},
    getFresh:async name=>{reads.push(name);return values.get(name)??null;},put:async(name,value)=>{writes.push(name);values.set(name,value);},
    delete:async()=>{throw Error('FORBIDDEN_STORE_DELETE');}};
  const source={organizationId:config.organizationId,workspaceId:id(4),repositoryBindingId:id(5),repositoryFingerprint:digest('a'),
    policyRevision:'agent-fabric-policy-v1',scopeDigest:digest('b'),contractDigest:digest('c'),sourceGenerationId:id(6),
    sourceReceiptId:'repo_consent_'+id(6),sourceRevision:1,sourcePolicyRevision:'repository-source-'+id(6),sourcePolicyHash:digest('d')};
  const session={organizationId:config.organizationId,workspaceId:id(4),repositoryBindingId:id(5),endpointId:id(7),membershipId:id(8),deviceId:id(2),
    bindingId:id(9),provider:'codex' as const,sessionId:'fixture-owned-session',owner:'dharma_bridge' as const,
    createdAt:new Date(NOW-1000).toISOString(),expiresAt:new Date(NOW+900000).toISOString(),maximumProviderCostCents:4000};
  let clock=NOW,allowed=true,offered=false,registered=false,published=false,receiptLifetime=900000;
  let preparation:DeviceSigningRecoveryPreparation|undefined,challenge:DeviceSigningRecoveryChallenge|undefined;
  let handler:((path:string,init:RequestInit)=>Promise<Response>)|undefined;
  let offerTransform:((value:Record<string,unknown>)=>Record<string,unknown>)|undefined;
  const controller=new AbortController(),requests:Array<{path:string;body:Record<string,unknown>}>=[];
  const nextKeyset=keyset(next,3,NOW,NOW+86400000);
  const fetcher=(async(url:string|URL|Request,init?:RequestInit)=>{
    assert.equal(typeof url,'string');assert.ok(init);const address=new URL(String(url)),body=JSON.parse(String(init.body));
    assert.equal(address.origin,config.hqUrl);assert.equal(address.search,'');assert.equal(init.redirect,'error');assert.equal(init.credentials,'omit');
    const headers=new Headers(init.headers);assert.equal(headers.has('authorization'),false);assert.equal(headers.has('cookie'),false);
    assert.equal(init.method,'POST');assert.equal(headers.get('content-type'),'application/json');assert.equal(headers.get('cache-control'),'no-store');
    assert.equal(headers.get('x-dharma-device-id'),config.deviceId);assert.equal(headers.get('x-dharma-sequence'),'1');
    assert.equal(Number.isFinite(Date.parse(headers.get('x-dharma-timestamp')??'')),true);
    const transport=Buffer.from(JSON.stringify({bodyHash:hash(String(init.body)),deviceId:config.deviceId,
      messageId:headers.get('x-dharma-message-id'),method:'POST',nonce:headers.get('x-dharma-nonce'),organizationId:config.organizationId,
      pathname:address.pathname,sequence:1,sessionId:headers.get('x-dharma-session-id'),timestamp:headers.get('x-dharma-timestamp')}));
    assert.equal(verify(null,transport,device.publicKey,Buffer.from(headers.get('x-dharma-signature')??'','base64url')),true);
    if(body.schema==='dharma.device-signing-maintenance-context-request/v1'){
      assert.equal(address.pathname,'/api/v1/agent-fabric/signing-recovery/preparations');
      assert.equal(headers.get('x-dharma-message-id'),body.operationId);assert.equal(headers.get('x-dharma-session-id'),body.operationId);
      assert.equal(headers.get('x-dharma-nonce'),body.nonce);
    }else if(address.pathname.endsWith('/preparations')){
      assert.equal(headers.get('x-dharma-message-id'),body.preparation.plan.planId);
      assert.equal(headers.get('x-dharma-session-id'),body.preparation.plan.planId);assert.equal(headers.get('x-dharma-nonce'),body.preparation.nonce);
    }else if(address.pathname.includes('/offers/')){
      assert.equal(headers.get('x-dharma-session-id'),body.preparationId);assert.equal(headers.get('x-dharma-message-id'),body.requestId);
      assert.equal(headers.get('x-dharma-nonce'),body.nonce);
    }else{
      assert.equal(headers.get('x-dharma-session-id'),body.recoveryId);assert.equal(headers.get('x-dharma-message-id'),body.approvalId);
      assert.equal(headers.get('x-dharma-nonce'),challenge?.nonce);
    }
    requests.push({path:address.pathname,body});if(handler)return handler(address.pathname,init);
    if(address.pathname==='/api/v1/agent-fabric/signing-recovery/preparations'){
      preparation=parseDeviceSigningRecoveryPreparation(body.preparation,body.preparation.plan,clock);
      assert.equal(verify(null,deviceSigningRecoveryPreparationSigningPayload(preparation),device.publicKey,Buffer.from(body.signature,'base64url')),true);
      const {schema,planId,authority,preparedAt,expiresAt,...bound}=preparation.plan;void[schema,planId,authority,preparedAt,expiresAt];
      const maintenance=preparation.plan.schema==='dharma.device-signing-maintenance-plan/v1';
      assert.equal(body.schema,maintenance?'dharma.device-signing-maintenance-preparation-request/v1':'dharma.device-signing-recovery-preparation-request/v1');
      challenge={...bound,schema:maintenance?'dharma.device-signing-maintenance-challenge/v1':'dharma.device-signing-recovery-challenge/v1',purpose:'expired_signing_trust_reapproval',
        recoveryId:id(12),approvalId:id(13),credentialEncryptionPublicKey:preparation.credentialEncryptionPublicKey,candidateGeneration:3,
        candidateKeysetHash:hash(canonicalize(nextKeyset)),candidateRootFingerprint:hash(Buffer.from(pub(next),'base64url')),
        candidateKeyVersionFingerprint:hash(nextKeyset.signedByKeyVersion),method:'POST',path:'/api/v1/agent-fabric/signing-recovery',
        nonce:Buffer.alloc(32,7).toString('base64url'),authenticator:Buffer.alloc(32,8).toString('base64url'),
        issuedAt:new Date(clock).toISOString(),expiresAt:new Date(Math.min(clock+600000,NOW+receiptLifetime)).toISOString()};
      return Response.json({schema:'dharma.signing-recovery-preparation-receipt/v1',preparationId:planId,organizationId:config.organizationId,
        recipientMembershipId:session.membershipId,deviceId:config.deviceId,expiresAt:new Date(Math.min(Date.parse(String(expiresAt)),NOW+receiptLifetime)).toISOString(),state:'pending_browser_review',
        clientTrustInstalled:false,...(maintenance?{controllerBinding:'device_attested_not_native_authority',nativeContinuationAuthorized:false}
          :{nativeSessionBinding:'device_attested_not_verified'})});
    }
    assert.ok(preparation&&challenge);
    const common={schema:'dharma.device-signing-recovery-offer-response/v1',organizationId:config.organizationId,deviceId:config.deviceId,
      preparationId:preparation.plan.planId,ready:false,clientTrustInstalled:false};
    if(address.pathname.endsWith('/offers/read')){const value=!offered?{...common,state:'awaiting_browser_offer',deviceProofRegistered:false,
      expiresAt:new Date(Math.min(Date.parse(preparation.plan.expiresAt),NOW+receiptLifetime)).toISOString()}:{...common,state:registered?'pending_approval':'awaiting_device_proof',deviceProofRegistered:registered,
      expiresAt:challenge.expiresAt,challenge};return Response.json(offerTransform?offerTransform(value):value);}
    assert.equal(verify(null,deviceSigningRecoverySigningPayload(challenge),device.publicKey,Buffer.from(String(body.signature),'base64url')),true);
    if(address.pathname.endsWith('/offers/register')){
      registered=true;return Response.json({...common,schema:'dharma.device-signing-recovery-offer-registration-receipt/v1',
        recoveryId:challenge.recoveryId,approvalId:challenge.approvalId,state:'pending_approval',deviceProofRegistered:true,expiresAt:challenge.expiresAt});
    }
    assert.equal(address.pathname,'/api/v1/agent-fabric/signing-recovery');if(!published)return new Response(null,{status:409});
    const maintenance=preparation.plan.schema==='dharma.device-signing-maintenance-plan/v1';
    assert.equal(body.schema,maintenance?'dharma.device-signing-maintenance-delivery-request/v1':'dharma.device-signing-recovery-delivery-request/v1');
    const candidate:DeviceSigningRecoveryCandidate={schema:'dharma.device-signing-recovery-candidate/v1',organizationId:config.organizationId,
      recoveryId:challenge.recoveryId,approvalId:challenge.approvalId,keysetCanonical:canonicalize(nextKeyset),rootPublicKey:pub(next),
      publication:{schema:'dharma.signing-recovery-publication/v1',organizationId:config.organizationId,recoveryId:challenge.recoveryId,
        generation:3,artifactHash:digest('e'),publishedAt:new Date(clock).toISOString()}};
    return Response.json({ok:true,delivery:sealDeviceSigningRecoveryDelivery(challenge,candidate,clock),clientTrustInstalled:false,
      ...(maintenance?{controllerBinding:'device_attested_not_native_authority',nativeContinuationAuthorized:false}
        :{nativeSessionBinding:'device_attested_not_independently_observed'})});
  }) as typeof fetch;
  const input={configPath,source,session,hostBinding:{connectionId:id(10),hostContextId:id(11),threadId:session.sessionId,turnId:'fixture-original-turn'},
    hostScope:{signal:controller.signal,current:async()=>allowed},store,now:()=>clock,fetcher};
  await writeFile(configPath,JSON.stringify(config));
  return {root,input,config,configPath,privateIdentity,identityAccount,anchorAccount,values,reads,writes,requests,controller,
    offer:()=>{offered=true;},publish:()=>{published=true;},revoke:()=>{allowed=false;},clock:(at:number)=>{clock=at;},
    setHandler:(fn:NonNullable<typeof handler>)=>{handler=fn;},cleanup:async()=>{
      assert.equal(dirname(resolve(root)),parent);assert.ok(basename(root).startsWith('fabric-owned-recovery-'));await rm(root,{recursive:true,force:true});
    },setOfferTransform:(fn:NonNullable<typeof offerTransform>)=>{offerTransform=fn;},shortenReceipt:(ms:number)=>{receiptLifetime=ms;}};
}
const safe=(value:unknown)=>assert.doesNotMatch(JSON.stringify(value),/signature|authenticator|keysetCanonical|credentialEncryption|privateJwk|PRIVATE_CANARY/);

test('official maintenance context read signs only the fixed endpoint and returns exact current source without writes',async()=>{
  const f=await fixture();
  try{
    f.setHandler(async(_path,init)=>{
      const {schema,issuedAt,repositoryFingerprint,...selection}=JSON.parse(String(init.body));void[schema,issuedAt,repositoryFingerprint];
      return Response.json({...selection,schema:'dharma.device-signing-maintenance-context/v1',
        recipientMembershipId:f.input.session.membershipId,source:f.input.source,authority:'current_source_context_only_not_consent'});
    });
    const result=await relay.readOwnedSigningMaintenanceContext({...f.input,workspaceId:f.input.source.workspaceId,
      repositoryBindingId:f.input.source.repositoryBindingId,membershipId:f.input.session.membershipId,operationId:id(21)});
    assert.deepEqual(result.source,f.input.source);assert.equal(f.requests.length,1);
    assert.equal(f.reads.filter(name=>name===f.identityAccount).length,1);assert.deepEqual(f.writes,[]);
    assert.equal((await validateContract(resolve(import.meta.dirname,'../../../schemas'),
      'https://schemas.dharma-ai.io/device-signing-maintenance-context-request/v1',f.requests[0]!.body)).ok,true);
    assert.equal((await validateContract(resolve(import.meta.dirname,'../../../schemas'),
      'https://schemas.dharma-ai.io/device-signing-maintenance-context/v1',result)).ok,true);safe(result);
  }finally{await f.cleanup();}
});
for(const fault of ['device','member','source','nonce','expiry','extra','config','scope','http'] as const){
  test('maintenance context rejects '+fault+' without replacing credentials or retrying',async()=>{
    const f=await fixture();
    try{
      f.setHandler(async(_path,init)=>{
        const {schema,issuedAt,repositoryFingerprint,...selection}=JSON.parse(String(init.body));void[schema,issuedAt,repositoryFingerprint];
        const body={...selection,schema:'dharma.device-signing-maintenance-context/v1',recipientMembershipId:f.input.session.membershipId,
          source:f.input.source,authority:'current_source_context_only_not_consent'};
        if(fault==='device')body.deviceId=id(99);if(fault==='member')body.recipientMembershipId=id(99);
        if(fault==='source')body.source={...body.source,repositoryBindingId:id(99)};
        if(fault==='nonce')body.nonce=Buffer.alloc(32,3).toString('base64url');if(fault==='expiry')body.expiresAt=new Date(NOW).toISOString();
        if(fault==='extra')body.token='SYNTHETIC_PRIVATE_CANARY';if(fault==='scope')f.revoke();
        if(fault==='config')await writeFile(f.configPath,JSON.stringify({...f.config,deviceName:'Changed current config'}));
        return fault==='http'?new Response(null,{status:503}):Response.json(body);
      });
      await assert.rejects(relay.readOwnedSigningMaintenanceContext({...f.input,workspaceId:f.input.source.workspaceId,
        repositoryBindingId:f.input.source.repositoryBindingId,membershipId:f.input.session.membershipId,operationId:id(21)}),/owned_signing_recovery_failed/);
      assert.equal(f.requests.length,1);assert.deepEqual(f.writes,[]);assert.equal(f.values.get(f.identityAccount),f.privateIdentity);
    }finally{await f.cleanup();}
  });
}

test('maintenance host carries a distinct origin through preparation, offer, encrypted delivery and protected journal',async()=>{
  const fn=api(),f=await fixture();
  try{
    const {session,hostBinding,...base}=f.input;void hostBinding;
    const controller={schema:'dharma.device-trust-maintenance-owner/v1' as const,operationId:id(21),controllerInstanceId:id(22),
      processIdentityDigest:digest('e'),leaseDigest:digest('f'),registrationDigest:digest('a'),
      deviceId:session.deviceId,recipientMembershipId:session.membershipId,originalBindingId:session.bindingId,
      originalSessionId:session.sessionId,expiresAt:new Date(NOW+900000).toISOString()};
    const handle=await relay.prepareOwnedSigningMaintenance({...base,controller});
    const planned=await fn.inspectOwnedSigningRecovery!(handle);
    assert.equal(planned.authorityKind,'device_trust_maintenance');assert.equal(planned.nativeContinuationAuthorized,false);
    assert.equal((await validateContract(resolve(import.meta.dirname,'../../../schemas'),'https://schemas.dharma-ai.io/device-signing-maintenance-host-progress/v1',planned)).ok,true);
    assert.equal(f.reads.filter(x=>x===f.identityAccount).length,0);assert.deepEqual(f.writes,[]);
    await fn.submitOwnedSigningRecoveryPreparation!(handle);
    const p=f.requests[0]!.body.preparation as DeviceSigningRecoveryPreparation;
    assert.equal(p.plan.schema,'dharma.device-signing-maintenance-plan/v1');
    assert.equal('nativeSessionBindingDigest'in p.plan,false);
    f.offer();await fn.progressOwnedSigningRecoveryOffer!(handle);assert.deepEqual(f.writes,[]);
    f.publish();const result=await fn.completeOwnedSigningRecovery!(handle);
    assert.equal(result.state,'trust_installed');assert.equal(result.ready,false);assert.equal(result.nativeContinuationAuthorized,false);
    const installed=JSON.parse(await readFile(f.configPath,'utf8'));
    assert.equal(installed.serverSigningKeyset.generation,3);assert.equal(installed.deviceId,f.config.deviceId);
    assert.equal(f.values.get(f.identityAccount),f.privateIdentity);
    assert.ok(f.writes.every(key=>key===f.anchorAccount));safe(result);
    const count=f.requests.length;await assert.rejects(fn.completeOwnedSigningRecovery!(handle));assert.equal(f.requests.length,count);
  }finally{await f.cleanup();}
});
test('host plan returns only an opaque public handle, without private-key reads, network or writes',async()=>{
  const fn=api(),f=await fixture();try{const handle=await fn.prepareOwnedSigningRecovery!(f.input),summary=await fn.inspectOwnedSigningRecovery!(handle);
    assert.equal(f.requests.length,0);assert.equal(f.reads.filter(x=>x===f.identityAccount).length,0);assert.deepEqual(f.writes,[]);
    assert.equal(summary.state,'prepared');assert.equal(summary.ready,false);safe(handle);safe(summary);
    assert.equal((await validateContract(resolve(import.meta.dirname,'../../../schemas'),'https://schemas.dharma-ai.io/device-signing-recovery-host-progress/v1',summary)).ok,true);
  }finally{await f.cleanup();}
});
test('same owning host submits once, retains the private handshake, progresses proof and installs only explicitly',async()=>{
  const fn=api(),f=await fixture();try{const handle=await fn.prepareOwnedSigningRecovery!(f.input);
    const admitted=await fn.submitOwnedSigningRecoveryPreparation!(handle);assert.equal(admitted.state,'awaiting_browser_offer');safe(admitted);
    assert.equal(f.reads.filter(x=>x===f.identityAccount).length,1);assert.deepEqual(f.writes,[]);
    const waiting=await fn.progressOwnedSigningRecoveryOffer!(handle);assert.equal(waiting.state,'awaiting_browser_offer');
    f.offer();const pending=await fn.progressOwnedSigningRecoveryOffer!(handle);assert.equal(pending.state,'pending_approval');safe(pending);
    assert.deepEqual(f.writes,[]);assert.equal(JSON.parse(await readFile(f.configPath,'utf8')).serverSigningKeyset.generation,2);
    f.publish();const completed=await fn.completeOwnedSigningRecovery!(handle);safe(completed);assert.equal(completed.ready,false);
    const installed=JSON.parse(await readFile(f.configPath,'utf8'));assert.equal(installed.serverSigningKeyset.generation,3);assert.equal(installed.deviceId,f.config.deviceId);
    assert.equal(f.values.get(f.identityAccount),f.privateIdentity);assert.ok(f.writes.every(key=>key===f.anchorAccount));
    const before=f.requests.length;await assert.rejects(fn.completeOwnedSigningRecovery!(handle));assert.equal(f.requests.length,before);
    assert.equal((await fn.inspectOwnedSigningRecovery!(handle)).state,'trust_installed');
  }finally{await f.cleanup();}
});
test('serialized, copied, proxied or disposed handles carry no execution authority',async()=>{
  const fn=api(),f=await fixture();try{const handle=await fn.prepareOwnedSigningRecovery!(f.input);
    for(const forged of [JSON.parse(JSON.stringify(handle)),{...handle},new Proxy(handle,{})])await assert.rejects(fn.submitOwnedSigningRecoveryPreparation!(forged));
    fn.disposeOwnedSigningRecovery!(handle);await assert.rejects(fn.submitOwnedSigningRecoveryPreparation!(handle));assert.equal(f.requests.length,0);
    assert.equal(f.reads.filter(x=>x===f.identityAccount).length,0);
  }finally{await f.cleanup();}
});
test('changed original source, named session or host scope is rejected before a preparation signature',async()=>{
  const fn=api();for(const fault of ['source','session','scope','expiry']){const f=await fixture();try{
    const handle=await fn.prepareOwnedSigningRecovery!(f.input);if(fault==='source')f.input.source.sourceRevision++;
    if(fault==='session')f.input.session.bindingId=id(99);if(fault==='scope')f.revoke();if(fault==='expiry')f.clock(NOW+900000);
    await assert.rejects(fn.submitOwnedSigningRecoveryPreparation!(handle));assert.equal(f.requests.length,0);assert.equal(f.reads.filter(x=>x===f.identityAccount).length,0);
  }finally{await f.cleanup();}}
});
test('unconfirmed submission preserves its handle but cannot repeat the key read or authority request',async()=>{
  const fn=api(),f=await fixture();try{const handle=await fn.prepareOwnedSigningRecovery!(f.input);
    f.setHandler(async()=>new Response('PRIVATE_CANARY',{status:503}));await assert.rejects(fn.submitOwnedSigningRecoveryPreparation!(handle),error=>error instanceof Error&&!error.message.includes('PRIVATE_CANARY'));
    assert.equal((await fn.inspectOwnedSigningRecovery!(handle)).state,'submission_unconfirmed');const count=f.reads.filter(x=>x===f.identityAccount).length;
    await assert.rejects(fn.submitOwnedSigningRecoveryPreparation!(handle));assert.equal(f.requests.length,1);assert.equal(f.reads.filter(x=>x===f.identityAccount).length,count);
  }finally{await f.cleanup();}
});
test('concurrent submit is refused, and disposal bounds a noncooperative response without another request',async()=>{
  const fn=api(),f=await fixture();try{const handle=await fn.prepareOwnedSigningRecovery!(f.input);let entered!:()=>void;
    const reading=new Promise<void>(resolve=>{entered=resolve;});f.setHandler(async()=>new Response(new ReadableStream({pull(){entered();return new Promise(()=>{});},cancel(){return new Promise(()=>{});}}),
      {headers:{'content-type':'application/json'}}));const pending=fn.submitOwnedSigningRecoveryPreparation!(handle);await reading;
    await assert.rejects(fn.submitOwnedSigningRecoveryPreparation!(handle));fn.disposeOwnedSigningRecovery!(handle);
    await Promise.race([assert.rejects(pending),new Promise<never>((_,reject)=>setTimeout(()=>reject(Error('UNBOUNDED_HOST_CANCEL')),1000))]);
    assert.equal(f.requests.length,1);assert.deepEqual(f.writes,[]);
  }finally{await f.cleanup();}
});
test('receipt context, lifetime, shape and encoding failures stay unconfirmed and never progress',async()=>{
  const fn=api();for(const fault of ['context','expiry','extra','type','size','utf8','redirect','missing','installed','native']){const f=await fixture();try{
    const handle=await fn.prepareOwnedSigningRecovery!(f.input);f.setHandler(async(_path,init)=>{
      const p=JSON.parse(String(init.body)).preparation.plan;const value={schema:'dharma.signing-recovery-preparation-receipt/v1',preparationId:p.planId,
        organizationId:p.organizationId,recipientMembershipId:p.recipientMembershipId,deviceId:p.deviceId,expiresAt:p.expiresAt,state:'pending_browser_review',
        clientTrustInstalled:false,nativeSessionBinding:'device_attested_not_verified'};
      if(fault==='missing')Reflect.deleteProperty(value,'nativeSessionBinding');
      if(fault==='installed')value.clientTrustInstalled=true;if(fault==='native')value.nativeSessionBinding='verified';
      if(fault==='context')value.deviceId=id(99);if(fault==='expiry')value.expiresAt=new Date(NOW+1800000).toISOString();if(fault==='extra')Object.assign(value,{secret:'PRIVATE_CANARY'});
      if(fault==='type')return new Response(JSON.stringify(value),{headers:{'content-type':'application/jsonp'}});
      if(fault==='size')return new Response('x'.repeat(8193),{headers:{'content-type':'application/json'}});
      if(fault==='utf8')return new Response(new Uint8Array([255]),{headers:{'content-type':'application/json'}});
      const result=Response.json(value);if(fault==='redirect')Object.defineProperty(result,'redirected',{value:true});return result;
    });await assert.rejects(fn.submitOwnedSigningRecoveryPreparation!(handle));assert.equal((await fn.inspectOwnedSigningRecovery!(handle)).state,'submission_unconfirmed');
    await assert.rejects(fn.progressOwnedSigningRecoveryOffer!(handle));assert.equal(f.requests.length,1);assert.deepEqual(f.writes,[]);
  }finally{await f.cleanup();}}
});
test('progress and installation cannot precede their explicit separate phases',async()=>{
  const fn=api(),f=await fixture();try{const handle=await fn.prepareOwnedSigningRecovery!(f.input);
    await assert.rejects(fn.progressOwnedSigningRecoveryOffer!(handle));await assert.rejects(fn.completeOwnedSigningRecovery!(handle));assert.equal(f.requests.length,0);
    await fn.submitOwnedSigningRecoveryPreparation!(handle);await assert.rejects(fn.completeOwnedSigningRecovery!(handle));assert.equal(f.requests.length,1);assert.deepEqual(f.writes,[]);
  }finally{await f.cleanup();}
});

test('preparation consumes the actual server receipt envelope, not a fixture-only partial shape',async()=>{
  const fn=api(),f=await fixture();try{const handle=await fn.prepareOwnedSigningRecovery!(f.input);
    f.setHandler(async(_path,init)=>{const p=JSON.parse(String(init.body)).preparation.plan;
      return Response.json({schema:'dharma.signing-recovery-preparation-receipt/v1',preparationId:p.planId,organizationId:p.organizationId,
        recipientMembershipId:p.recipientMembershipId,deviceId:p.deviceId,expiresAt:p.expiresAt,state:'pending_browser_review',
        clientTrustInstalled:false,nativeSessionBinding:'device_attested_not_verified'});
    });assert.equal((await fn.submitOwnedSigningRecoveryPreparation!(handle)).state,'awaiting_browser_offer');assert.deepEqual(f.writes,[]);
  }finally{await f.cleanup();}
});

test('a current narrower server deadline is retained and expiry stops before another private read or request',async()=>{
  const fn=api(),f=await fixture();try{f.shortenReceipt(120000);const handle=await fn.prepareOwnedSigningRecovery!(f.input);
    const admitted=await fn.submitOwnedSigningRecoveryPreparation!(handle);assert.equal(admitted.expiresAt,new Date(NOW+120000).toISOString());
    const count=f.requests.length,reads=f.reads.filter(x=>x===f.identityAccount).length;f.clock(NOW+120000);
    await assert.rejects(fn.progressOwnedSigningRecoveryOffer!(handle));assert.equal(f.requests.length,count);
    assert.equal(f.reads.filter(x=>x===f.identityAccount).length,reads);assert.deepEqual(f.writes,[]);
  }finally{await f.cleanup();}
});

test('a later offer cannot extend the admitted server deadline before registering a proof',async()=>{
  const fn=api(),f=await fixture();try{f.shortenReceipt(120000);const handle=await fn.prepareOwnedSigningRecovery!(f.input);
    await fn.submitOwnedSigningRecoveryPreparation!(handle);f.offer();f.setOfferTransform(value=>({...value,expiresAt:new Date(NOW+900000).toISOString()}));
    await assert.rejects(fn.progressOwnedSigningRecoveryOffer!(handle));assert.equal(f.requests.some(x=>x.path.endsWith('/register')),false);assert.deepEqual(f.writes,[]);
  }finally{await f.cleanup();}
});

test('shortened receipt lifetime remains usable for proof and explicit confirmed installation',async()=>{
  const fn=api(),f=await fixture();try{f.shortenReceipt(120000);const handle=await fn.prepareOwnedSigningRecovery!(f.input);
    await fn.submitOwnedSigningRecoveryPreparation!(handle);f.offer();const pending=await fn.progressOwnedSigningRecoveryOffer!(handle);
    assert.equal(pending.expiresAt,new Date(NOW+120000).toISOString());f.publish();const result=await fn.completeOwnedSigningRecovery!(handle);
    assert.equal(result.state,'trust_installed');assert.equal(result.clientTrustInstalled,true);assert.equal(result.ready,false);
    assert.equal(result.expiresAt,new Date(NOW+120000).toISOString());safe(result);
  }finally{await f.cleanup();}
});

test('unpublished delivery is not retried or converted to consent and leaves original trust intact',async()=>{
  const fn=api(),f=await fixture();try{const handle=await fn.prepareOwnedSigningRecovery!(f.input);
    await fn.submitOwnedSigningRecoveryPreparation!(handle);f.offer();await fn.progressOwnedSigningRecoveryOffer!(handle);
    await assert.rejects(fn.completeOwnedSigningRecovery!(handle));assert.equal((await fn.inspectOwnedSigningRecovery!(handle)).state,'delivery_unconfirmed');
    const before=f.requests.length;f.publish();await assert.rejects(fn.completeOwnedSigningRecovery!(handle));assert.equal(f.requests.length,before);
    assert.deepEqual(f.writes,[]);assert.equal(JSON.parse(await readFile(f.configPath,'utf8')).serverSigningKeyset.generation,2);
  }finally{await f.cleanup();}
});

test('disposing delivery bounds noncooperative fetch and response reads without protected effects',async()=>{
  const fn=api();for(const fault of ['fetch','body']){const f=await fixture();try{const handle=await fn.prepareOwnedSigningRecovery!(f.input);
    await fn.submitOwnedSigningRecoveryPreparation!(handle);f.offer();await fn.progressOwnedSigningRecoveryOffer!(handle);
    let entered!:()=>void;const started=new Promise<void>(resolve=>{entered=resolve;});
    f.setHandler(async()=>{
      if(fault==='fetch'){entered();return new Promise(()=>{});}
      return new Response(new ReadableStream({pull(){entered();return new Promise(()=>{});},cancel(){return new Promise(()=>{});}}),
        {headers:{'content-type':'application/json'}});
    });const pending=fn.completeOwnedSigningRecovery!(handle);await started;fn.disposeOwnedSigningRecovery!(handle);
    await Promise.race([assert.rejects(pending),new Promise<never>((_,reject)=>setTimeout(()=>reject(Error('UNBOUNDED_DELIVERY_CANCEL')),1000))]);
    assert.deepEqual(f.writes,[]);assert.equal(JSON.parse(await readFile(f.configPath,'utf8')).serverSigningKeyset.generation,2);
  }finally{await f.cleanup();}}
});

test('changed challenge context cannot reach proof registration or delivery and cannot retry implicitly',async()=>{
  const fn=api();for(const field of ['deviceId','nativeSessionBindingDigest','credentialEncryptionPublicKey','previousKeysetHash']){
    const f=await fixture();try{const handle=await fn.prepareOwnedSigningRecovery!(f.input);await fn.submitOwnedSigningRecoveryPreparation!(handle);f.offer();
      f.setOfferTransform(value=>({...value,challenge:{...(value.challenge as object),[field]:field==='deviceId'?id(99):field==='credentialEncryptionPublicKey'?
        generateKeyPairSync('x25519').publicKey.export({format:'jwk'}).x:digest('f')}}));
      await assert.rejects(fn.progressOwnedSigningRecoveryOffer!(handle));assert.equal((await fn.inspectOwnedSigningRecovery!(handle)).state,'offer_unconfirmed');
      const count=f.requests.length;await assert.rejects(fn.progressOwnedSigningRecoveryOffer!(handle));await assert.rejects(fn.completeOwnedSigningRecovery!(handle));
      assert.equal(f.requests.length,count);assert.equal(f.requests.some(x=>x.path.endsWith('/register')),false);assert.deepEqual(f.writes,[]);
    }finally{await f.cleanup();}
  }
});

test('source and session withdrawal after preparation or proof prevents the next private-key read and request',async()=>{
  const fn=api();for(const phase of ['offer','delivery']){const f=await fixture();try{const handle=await fn.prepareOwnedSigningRecovery!(f.input);
    await fn.submitOwnedSigningRecoveryPreparation!(handle);if(phase==='delivery'){f.offer();await fn.progressOwnedSigningRecoveryOffer!(handle);f.publish();}
    const requests=f.requests.length,reads=f.reads.filter(x=>x===f.identityAccount).length;f.input.source.repositoryBindingId=id(99);
    await assert.rejects(phase==='offer'?fn.progressOwnedSigningRecoveryOffer!(handle):fn.completeOwnedSigningRecovery!(handle));
    assert.equal(f.requests.length,requests);assert.equal(f.reads.filter(x=>x===f.identityAccount).length,reads);assert.deepEqual(f.writes,[]);
  }finally{await f.cleanup();}}
});

test('only the owning-host opaque operations are public, not the raw challenge handoff',()=>{
  api();assert.equal('progressPreparedSigningRecoveryOfferForHost'in relay,false);
});

test('actual loopback HTTP carries signed preparation, proof and encrypted delivery in explicit separate phases',async()=>{
  const fn=api(),f=await fixture();let server:Server|undefined;
  try{
    const protocol=f.input.fetcher;
    server=createServer(async(request,response)=>{
      try{
        const chunks:Buffer[]=[];for await(const chunk of request)chunks.push(Buffer.from(chunk));
        const output=await protocol(f.config.hqUrl+request.url,{method:request.method,headers:request.headers as Record<string,string>,
          body:Buffer.concat(chunks).toString('utf8'),redirect:'error',credentials:'omit'});
        response.writeHead(output.status,Object.fromEntries(output.headers));response.end(Buffer.from(await output.arrayBuffer()));
      }catch{response.writeHead(500);response.end('fixture_failed');}
    });await new Promise<void>(resolve=>server!.listen(0,'127.0.0.1',resolve));
    const base='http://127.0.0.1:'+(server.address() as AddressInfo).port;
    // Only this synthetic transport fixture maps the pinned HTTPS target to a
    // private loopback HTTP server. It does not qualify production TLS/auth.
    f.input.fetcher=async(url,init)=>{const target=new URL(String(url));assert.equal(target.origin,f.config.hqUrl);
      const wire=await fetch(base+target.pathname,init);assert.equal(wire.url,base+target.pathname);assert.equal(wire.redirected,false);
      return new Response(wire.body,{status:wire.status,headers:wire.headers});};
    const handle=await fn.prepareOwnedSigningRecovery!(f.input);await fn.submitOwnedSigningRecoveryPreparation!(handle);
    f.offer();await fn.progressOwnedSigningRecoveryOffer!(handle);f.publish();const complete=await fn.completeOwnedSigningRecovery!(handle);
    assert.equal(complete.state,'trust_installed');assert.equal(complete.ready,false);assert.equal(f.requests.length,4);
    safe(complete);assert.equal(f.values.get(f.identityAccount),f.privateIdentity);fn.disposeOwnedSigningRecovery!(handle);
  }finally{if(server){server.closeAllConnections();await new Promise<void>((resolve,reject)=>server!.close(error=>error?reject(error):resolve()));}await f.cleanup();}
});
