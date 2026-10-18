import assert from 'node:assert/strict';
import {createHash,createPublicKey,generateKeyPairSync,verify} from 'node:crypto';
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {basename,dirname,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {createServer} from 'node:http';
import test from 'node:test';
import {canonicalize,deviceSigningRecoverySigningPayload,signCanonicalObject,validateContract,
  parseDeviceSigningRecoveryOfferReadRequest,parseDeviceSigningRecoveryOfferRegistrationRequest,
  type DeviceSigningRecoveryChallenge} from '@dharma-ai-labs/agent-fabric-contracts';
import * as relay from './index.js';
import type {DeviceConfig,SecureSecretStore} from './index.js';

const NOW=Date.parse('2030-01-01T00:00:00.000Z');
const id=(n:number):`${string}-${string}-${string}-${string}-${string}`=>`c0000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const hash=(value:string|Buffer)=>'sha256:'+createHash('sha256').update(value).digest('hex');
const digest=(c:string)=>'sha256:'+c.repeat(64);
const READ='/api/v1/agent-fabric/signing-recovery/offers/read';
const REGISTER='/api/v1/agent-fabric/signing-recovery/offers/register';
function api(){
  const fn=(relay as unknown as Record<string,unknown>).progressPreparedDeviceSigningRecoveryOffer;
  assert.equal(typeof fn,'function','missing official prepared-offer client');
  return fn as (input:Record<string,unknown>)=>Promise<Record<string,unknown>>;
}
async function fixture(){
  const historical=generateKeyPairSync('ed25519'),device=generateKeyPairSync('ed25519'),encryption=generateKeyPairSync('x25519');
  const publicKey=(pair:typeof device)=>pair.publicKey.export({format:'jwk'}).x!;
  const oldBody={schema:'dharma.server-signing-keyset/v1' as const,organizationId:'org_fixture',generation:2,
    keys:[{keyVersion:'synthetic-version-2',publicKeyEd25519:publicKey(historical),status:'active' as const,
      notBefore:new Date(NOW-86400000).toISOString(),notAfter:new Date(NOW-1000).toISOString()}],
    signedByKeyVersion:'synthetic-version-2',issuedAt:new Date(NOW-86400000).toISOString(),expiresAt:new Date(NOW-1000).toISOString()};
  const keyset={...oldBody,signature:signCanonicalObject(oldBody,historical.privateKey)};
  const tempParent=resolve(tmpdir()),root=await mkdtemp(resolve(tempParent,'fabric-offer-client-')),configPath=resolve(root,'device.json');
  const config:DeviceConfig={schema:'dharma.device-config/v1',hqUrl:'https://www.dharma-ai.io',organizationId:'org_fixture',
    installationId:id(1),deviceId:id(2),deviceName:'Synthetic offer client',platform:'linux',publicKeyEd25519:publicKey(device),
    serverPublicKeyEd25519:publicKey(historical),serverSigningKeyset:keyset,relayUrl:'wss://relay.example.invalid',
    enrolledAt:'2029-12-01T00:00:00.000Z',connectionMode:'manual',setupClaimReference:id(3),setupClaimRepositoryFingerprint:digest('a')};
  const anchor={schema:'dharma.device-enrollment-anchor/v1',hqUrl:config.hqUrl,organizationId:config.organizationId,
    deviceId:config.deviceId,devicePublicKeyEd25519:config.publicKeyEd25519,serverPublicKeyEd25519:config.serverPublicKeyEd25519,
    serverSigningKeyset:keyset,enrolledAt:config.enrolledAt};
  const anchorAccount='device-enrollment-'+hash(`${config.hqUrl}:${config.organizationId}:${config.deviceId}`).slice(7,39);
  const identityAccount='device-key-'+hash(`${config.hqUrl}:${config.organizationId}:${config.installationId}`).slice(7,39);
  const privateIdentity=JSON.stringify(device.privateKey.export({format:'jwk'}));
  const values=new Map([[anchorAccount,JSON.stringify(anchor)],[identityAccount,privateIdentity]]),reads:string[]=[],writes:string[]=[];
  const store:SecureSecretStore={backend:'linux-secret-service',get:async name=>{reads.push(name);return values.get(name)??null;},
    getFresh:async name=>{reads.push(name);return values.get(name)??null;},put:async()=>{writes.push('put');throw Error('UNEXPECTED_STORE_WRITE');},
    delete:async()=>{writes.push('delete');throw Error('UNEXPECTED_STORE_DELETE');}};
  let allowed=true,clock=NOW;
  const controller=new AbortController();
  const source={organizationId:config.organizationId,workspaceId:id(4),repositoryBindingId:id(5),repositoryFingerprint:digest('a'),
    policyRevision:'agent-fabric-policy-v1',scopeDigest:digest('b'),contractDigest:digest('c'),sourceGenerationId:id(6),
    sourceReceiptId:'repo_consent_'+id(6),sourceRevision:1,sourcePolicyRevision:'repository-source-'+id(6),sourcePolicyHash:digest('d')};
  const session={organizationId:config.organizationId,workspaceId:id(4),repositoryBindingId:id(5),endpointId:id(7),membershipId:id(8),deviceId:id(2),
    bindingId:id(9),provider:'codex' as const,sessionId:'synthetic-native-session',owner:'dharma_bridge' as const,
    createdAt:new Date(NOW-1000).toISOString(),expiresAt:new Date(NOW+900000).toISOString(),maximumProviderCostCents:4000};
  const context={configPath,source,session,hostBinding:{connectionId:id(10),hostContextId:id(11),threadId:session.sessionId,turnId:'synthetic-native-turn'},
    hostScope:{signal:controller.signal,current:async()=>allowed},store,now:()=>clock};
  await writeFile(configPath,JSON.stringify(config));
  const plan=await relay.planDeviceSigningRecovery(context);
  const preparation={schema:'dharma.device-signing-recovery-preparation/v1',purpose:'prepare_expired_signing_trust_recovery',
    method:'POST',path:'/api/v1/agent-fabric/signing-recovery/preparations',plan,
    historicalKeysetCanonical:canonicalize(keyset),historicalRootPublicKey:config.serverPublicKeyEd25519,
    credentialEncryptionPublicKey:publicKey(encryption),nonce:Buffer.alloc(32,9).toString('base64url')};
  const {schema,planId,authority,preparedAt,expiresAt,...local}=plan;void[schema,planId,authority,preparedAt,expiresAt];
  const challenge:DeviceSigningRecoveryChallenge={...local,schema:'dharma.device-signing-recovery-challenge/v1',purpose:'expired_signing_trust_reapproval',
    recoveryId:id(12),approvalId:id(13),credentialEncryptionPublicKey:publicKey(encryption),candidateGeneration:3,
    candidateKeysetHash:digest('e'),candidateRootFingerprint:digest('f'),candidateKeyVersionFingerprint:digest('1'),
    method:'POST',path:'/api/v1/agent-fabric/signing-recovery',nonce:Buffer.alloc(32,7).toString('base64url'),
    authenticator:Buffer.alloc(32,8).toString('base64url'),issuedAt:new Date(NOW).toISOString(),expiresAt:new Date(NOW+600000).toISOString()};
  const binding={organizationId:config.organizationId,deviceId:config.deviceId,preparationId:plan.planId};
  const response={schema:'dharma.device-signing-recovery-offer-response/v1',...binding,expiresAt:challenge.expiresAt,
    state:'awaiting_device_proof',deviceProofRegistered:false,clientTrustInstalled:false,ready:false,challenge};
  const requests:Array<{url:string;init:RequestInit;body:Record<string,unknown>}>=[];
  const requestIds=new Set<string>(),nonces=new Set<string>();
  let handler:((url:string,init:RequestInit,body:Record<string,unknown>)=>Promise<Response>)|undefined;
  const fetcher=(async(url:string|URL|Request,init?:RequestInit)=>{
    assert.equal(typeof url,'string');assert.ok(init);assert.equal(init.redirect,'error');assert.equal(init.credentials,'omit');
    const address=new URL(String(url)),headers=new Headers(init.headers),body=JSON.parse(String(init.body));
    assert.equal(address.origin,config.hqUrl);assert.equal(headers.has('authorization'),false);assert.equal(headers.has('cookie'),false);
    assert.ok([READ,REGISTER].includes(address.pathname));assert.equal(address.search,'');
    const parsed=address.pathname===READ?parseDeviceSigningRecoveryOfferReadRequest(body,binding,clock)
      :parseDeviceSigningRecoveryOfferRegistrationRequest(body,binding,clock);
    assert.equal(headers.get('x-dharma-device-id'),config.deviceId);assert.equal(headers.get('x-dharma-session-id'),plan.planId);
    assert.equal(headers.get('x-dharma-message-id'),parsed.requestId);assert.equal(headers.get('x-dharma-nonce'),parsed.nonce);
    assert.equal(headers.get('x-dharma-timestamp'),parsed.issuedAt);assert.equal(headers.get('x-dharma-sequence'),'1');
    assert.ok(!requestIds.has(parsed.requestId));assert.ok(!nonces.has(parsed.nonce));requestIds.add(parsed.requestId);nonces.add(parsed.nonce);
    const payload=Buffer.from(JSON.stringify({bodyHash:hash(String(init.body)),deviceId:config.deviceId,messageId:parsed.requestId,method:'POST',
      nonce:parsed.nonce,organizationId:config.organizationId,pathname:address.pathname,sequence:1,sessionId:plan.planId,timestamp:parsed.issuedAt}));
    assert.equal(verify(null,payload,device.publicKey,Buffer.from(headers.get('x-dharma-signature')!,'base64url')),true);
    requests.push({url:String(url),init,body});
    if(handler)return handler(String(url),init,body);
    if(address.pathname===READ)return Response.json(response);
    assert.equal(body.recoveryId,challenge.recoveryId);assert.equal(body.approvalId,challenge.approvalId);
    assert.equal(verify(null,deviceSigningRecoverySigningPayload(challenge),device.publicKey,Buffer.from(String(body.signature),'base64url')),true);
    return Response.json({schema:'dharma.device-signing-recovery-offer-registration-receipt/v1',...binding,
      recoveryId:challenge.recoveryId,approvalId:challenge.approvalId,state:'pending_approval',expiresAt:challenge.expiresAt,
      deviceProofRegistered:true,clientTrustInstalled:false,ready:false});
  }) as typeof fetch;
  reads.length=0;
  return {root,config,configPath,values,identityAccount,privateIdentity,reads,writes,source,plan,preparation,challenge,response,requests,binding,
    input:{...context,preparation,encryptionKey:encryption.privateKey,fetcher},controller,clock:(at:number)=>{clock=at;},revoke:()=>{allowed=false;},
    setHandler:(next:NonNullable<typeof handler>)=>{handler=next;},cleanup:async()=>{
      assert.equal(dirname(resolve(root)),tempParent);assert.ok(basename(root).startsWith('fabric-offer-client-'));
      await rm(root,{recursive:true,force:true});
    }};
}

test('prepared offer read/proof registration uses one existing-key read, two fixed signed requests and no trust writes',async()=>{
  const fn=api(),f=await fixture();try{
    const before=await readFile(f.configPath,'utf8'),result=await fn(f.input);
    assert.equal(f.requests.length,2);assert.equal(f.reads.filter(x=>x===f.identityAccount).length,1);assert.deepEqual(f.writes,[]);
    assert.equal(await readFile(f.configPath,'utf8'),before);assert.equal(f.values.get(f.identityAccount),f.privateIdentity);
    assert.equal(result.state,'pending_approval');assert.equal(result.deviceProofRegistered,true);
    assert.equal(result.ready,false);assert.equal(result.clientTrustInstalled,false);assert.equal(result.preparationId,f.plan.planId);
    assert.doesNotMatch(JSON.stringify(result),/signature|authenticator|private|credentialEncryption|keysetCanonical|token/);
  }finally{await f.cleanup();}
});
test('awaiting browser and already registered offers stop after one request without approval or duplicate registration',async()=>{
  const fn=api();for(const state of ['awaiting_browser_offer','pending_approval']){
    const f=await fixture();try{
      const body={...f.response,state,deviceProofRegistered:state==='pending_approval'};
      if(state==='awaiting_browser_offer')delete (body as Partial<typeof body>).challenge;
      f.setHandler(async()=>Response.json(body));const result=await fn(f.input);
      assert.equal(result.state,state);assert.equal(f.requests.length,1);assert.deepEqual(f.writes,[]);
    }finally{await f.cleanup();}
  }
});
test('wrong local source, preparation, encryption key or expired scope fails before the existing device-key read or network',async()=>{
  const fn=api();for(const fault of ['source','plan','key','expired','getter','proxy']){
    const f=await fixture();try{
      let input:Record<string,unknown>={...f.input};
      if(fault==='source')input={...input,source:{...f.source,sourceRevision:2}};
      if(fault==='plan')input={...input,preparation:{...f.preparation,plan:{...f.plan,recipientMembershipId:id(99)}}};
      if(fault==='key')input={...input,encryptionKey:generateKeyPairSync('x25519').privateKey};
      if(fault==='expired')f.clock(Date.parse(f.plan.expiresAt));
      if(fault==='getter')input.preparation=Object.defineProperty({},'plan',{enumerable:true,get(){throw Error('UNEXPECTED_GETTER');}});
      if(fault==='proxy')input.preparation=new Proxy(f.preparation,{get(){throw Error('UNEXPECTED_PROXY');}});
      await assert.rejects(fn(input),/signing_recovery_offer_failed|host_operation/);
      assert.equal(f.reads.filter(x=>x===f.identityAccount).length,0);assert.equal(f.requests.length,0);assert.deepEqual(f.writes,[]);
    }finally{await f.cleanup();}
  }
});
test('foreign/tampered/unbounded read responses never reach proof registration',async()=>{
  const fn=api();for(const fault of ['org','device','preparation','encryption','policy','candidate','expiry','extra','mime','length','stream','redirect','origin','status']){
    const f=await fixture();try{
      f.setHandler(async()=>{
        const value=structuredClone(f.response);
        if(fault==='org')value.organizationId='org_foreign';if(fault==='device')value.deviceId=id(99);
        if(fault==='preparation')value.preparationId=id(99);if(fault==='encryption')value.challenge.credentialEncryptionPublicKey=Buffer.alloc(32,9).toString('base64url');
        if(fault==='policy')value.challenge.policyRevision='foreign-policy';if(fault==='candidate')value.challenge.candidateGeneration=9;
        if(fault==='expiry')value.expiresAt=new Date(NOW).toISOString();if(fault==='extra')Object.assign(value,{accessToken:'SYNTHETIC_CANARY'});
        if(fault==='mime')return new Response(JSON.stringify(value),{headers:{'content-type':'text/html'}});
        if(fault==='length')return new Response('{}',{headers:{'content-type':'application/json','content-length':'65537'}});
        if(fault==='stream')return new Response('x'.repeat(65537),{headers:{'content-type':'application/json'}});
        const result=Response.json(value,{status:fault==='status'?503:200});
        if(fault==='redirect')Object.defineProperty(result,'redirected',{value:true});
        if(fault==='origin')Object.defineProperty(result,'url',{value:'https://foreign.example/response'});
        return result;
      });
      await assert.rejects(fn(f.input),/signing_recovery_offer_failed/);assert.equal(f.requests.length,1);assert.deepEqual(f.writes,[]);
    }finally{await f.cleanup();}
  }
});
test('changed local state or withdrawn host scope after read prevents the proof POST',async()=>{
  const fn=api();for(const fault of ['config','source','withdraw']){
    const f=await fixture();try{
      f.setHandler(async()=>{
        if(fault==='config')await writeFile(f.configPath,JSON.stringify({...f.config,deviceName:'Changed host'}));
        if(fault==='source')f.source.sourceRevision=2;if(fault==='withdraw')f.revoke();
        return Response.json(f.response);
      });
      await assert.rejects(fn(f.input));assert.equal(f.requests.length,1);assert.deepEqual(f.writes,[]);
    }finally{await f.cleanup();}
  }
});
test('bad proof receipts and lost responses cannot report success or trigger an automatic retry',async()=>{
  const fn=api();for(const fault of ['foreign','renewed','ready','lost']){
    const f=await fixture();try{
      f.setHandler(async(url)=>{
        if(url.endsWith('/read'))return Response.json(f.response);
        const receipt={schema:'dharma.device-signing-recovery-offer-registration-receipt/v1',...f.binding,
          recoveryId:f.challenge.recoveryId,approvalId:f.challenge.approvalId,state:'pending_approval',expiresAt:f.challenge.expiresAt,
          deviceProofRegistered:true,clientTrustInstalled:false,ready:false};
        if(fault==='foreign')receipt.recoveryId=id(99);if(fault==='renewed')receipt.expiresAt=f.plan.expiresAt;
        if(fault==='ready')receipt.ready=true;
        return fault==='lost'?new Response(null,{status:503}):Response.json(receipt);
      });
      await assert.rejects(fn(f.input),/signing_recovery_offer_failed/);assert.equal(f.requests.length,2);assert.deepEqual(f.writes,[]);
    }finally{await f.cleanup();}
  }
});
test('host cancellation bounds a non-cooperative response stream without registration or a completed result',async()=>{
  const fn=api(),f=await fixture();try{
    let entered!:()=>void;const reading=new Promise<void>(resolve=>{entered=resolve;});
    f.setHandler(async()=>new Response(new ReadableStream({pull(){entered();return new Promise(()=>{});},cancel(){return new Promise(()=>{});}}),
      {headers:{'content-type':'application/json'}}));
    const pending=fn(f.input);await reading;f.controller.abort();
    await Promise.race([assert.rejects(pending),new Promise<never>((_,reject)=>setTimeout(()=>reject(Error('unbounded cancellation')),1000))]);
    assert.equal(f.requests.length,1);assert.deepEqual(f.writes,[]);
  }finally{await f.cleanup();}
});
test('public progress results have a strict versioned schema and cannot claim installed trust or readiness',async()=>{
  const fn=api(),f=await fixture();try{
    const result=await fn(f.input),schemas=resolve(import.meta.dirname,'../../../schemas');
    const schema='https://schemas.dharma-ai.io/device-signing-recovery-offer-progress/v1';
    assert.equal((await validateContract(schemas,schema,result)).ok,true);
    for(const delta of [{ready:true},{clientTrustInstalled:true},{signature:'SYNTHETIC_UNEXPECTED_PROOF'},{state:'awaiting_device_proof'}]){
      assert.equal((await validateContract(schemas,schema,{...result,...delta})).ok,false);
    }
    f.setHandler(async()=>{const waiting={...f.response,state:'awaiting_browser_offer',deviceProofRegistered:false};
      delete (waiting as Partial<typeof waiting>).challenge;return Response.json(waiting);});
    const waiting=await fn(f.input);assert.equal((await validateContract(schemas,schema,waiting)).ok,true);
    assert.equal((await validateContract(schemas,schema,{...waiting,deviceProofRegistered:true})).ok,false);
  }finally{await f.cleanup();}
});
test('synthetic loopback HTTP preserves the two signed fixed-purpose requests without weakening TLS settings',async()=>{
  const fn=api(),f=await fixture(),publicKey=createPublicKey({format:'jwk',key:{kty:'OKP',crv:'Ed25519',x:f.config.publicKeyEd25519}});
  const received:string[]=[];
  const server=createServer(async(request,response)=>{
    try{
      const chunks:Buffer[]=[];for await(const chunk of request)chunks.push(Buffer.from(chunk));
      const raw=Buffer.concat(chunks).toString('utf8'),body=JSON.parse(raw);
      const transport=Buffer.from(JSON.stringify({bodyHash:hash(raw),deviceId:f.config.deviceId,messageId:body.requestId,method:'POST',
        nonce:body.nonce,organizationId:f.config.organizationId,pathname:request.url,sequence:1,sessionId:f.plan.planId,timestamp:body.issuedAt}));
      assert.equal(verify(null,transport,publicKey,Buffer.from(String(request.headers['x-dharma-signature']),'base64url')),true);
      received.push(request.url!);let result:unknown;
      if(request.url===READ)result=f.response;
      else{
        assert.equal(request.url,REGISTER);assert.equal(verify(null,deviceSigningRecoverySigningPayload(f.challenge),publicKey,
          Buffer.from(body.signature,'base64url')),true);
        result={schema:'dharma.device-signing-recovery-offer-registration-receipt/v1',...f.binding,
          recoveryId:f.challenge.recoveryId,approvalId:f.challenge.approvalId,state:'pending_approval',expiresAt:f.challenge.expiresAt,
          deviceProofRegistered:true,clientTrustInstalled:false,ready:false};
      }
      response.writeHead(200,{'content-type':'application/json'});response.end(JSON.stringify(result));
    }catch{response.writeHead(400,{'content-type':'application/json'});response.end('{}');}
  });
  try{
    await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
    const address=server.address();assert.ok(address&&typeof address==='object');
    f.setHandler(async(url,init)=>fetch(`http://127.0.0.1:${address.port}${new URL(url).pathname}`,init).then(async response=>
      new Response(await response.arrayBuffer(),{status:response.status,headers:response.headers})));
    const result=await fn(f.input);assert.equal(result.state,'pending_approval');assert.deepEqual(received,[READ,REGISTER]);
    assert.deepEqual(f.writes,[]);
  }finally{await new Promise<void>(resolve=>server.close(()=>resolve()));await f.cleanup();}
});
test('a lost registration response is reconciled by a later explicit read, never an automatic proof replay',async()=>{
  const fn=api(),f=await fixture();try{
    let registrations=0,registered=false;
    f.setHandler(async(url)=>{
      if(url.endsWith('/read'))return Response.json({...f.response,state:registered?'pending_approval':'awaiting_device_proof',deviceProofRegistered:registered});
      registrations++;registered=true;return new Response(null,{status:503});
    });
    await assert.rejects(fn(f.input));assert.equal(f.requests.length,2);assert.equal(registrations,1);
    const result=await fn(f.input);assert.equal(result.state,'pending_approval');assert.equal(f.requests.length,3);
    assert.equal(registrations,1);assert.deepEqual(f.writes,[]);
  }finally{await f.cleanup();}
});
test('local scope changes during registration cannot return a completed progress receipt',async()=>{
  const fn=api(),f=await fixture();try{
    f.setHandler(async(url)=>{
      if(url.endsWith('/read'))return Response.json(f.response);
      f.source.sourceRevision++;
      return Response.json({schema:'dharma.device-signing-recovery-offer-registration-receipt/v1',...f.binding,
        recoveryId:f.challenge.recoveryId,approvalId:f.challenge.approvalId,state:'pending_approval',expiresAt:f.challenge.expiresAt,
        deviceProofRegistered:true,clientTrustInstalled:false,ready:false});
    });
    await assert.rejects(fn(f.input));assert.equal(f.requests.length,2);assert.deepEqual(f.writes,[]);
  }finally{await f.cleanup();}
});
test('a non-cooperative fetch stops on the existing host cancellation and never starts registration',async()=>{
  const fn=api(),f=await fixture();try{
    let entered!:()=>void;const admitted=new Promise<void>(resolve=>{entered=resolve;});
    f.setHandler(async()=>{entered();return new Promise(()=>{});});
    const pending=fn(f.input);await admitted;f.controller.abort();
    await Promise.race([assert.rejects(pending),new Promise<never>((_,reject)=>setTimeout(()=>reject(Error('unbounded fetch cancellation')),1000))]);
    assert.equal(f.requests.length,1);assert.deepEqual(f.writes,[]);
  }finally{await f.cleanup();}
});
