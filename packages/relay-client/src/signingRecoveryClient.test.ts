import assert from 'node:assert/strict';
import {createHash,generateKeyPairSync,verify} from 'node:crypto';
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';
import test from 'node:test';
import {canonicalize,deviceSigningRecoverySigningPayload,sealDeviceSigningRecoveryDelivery,signCanonicalObject,
  validateContract,type DeviceSigningRecoveryChallenge,type DeviceSigningRecoveryCandidate} from '@dharma-ai-labs/agent-fabric-contracts';
import * as relay from './index.js';
import type {DeviceConfig,SecureSecretStore} from './index.js';

const now=Date.parse('2030-01-01T00:00:00.000Z');
const id=(n:number)=>`b0000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const hash=(value:string|Buffer)=>'sha256:'+createHash('sha256').update(value).digest('hex');
const objectHash=(value:unknown)=>hash(canonicalize(value));
const digest=(c:string)=>'sha256:'+c.repeat(64);
function api(){const fn=(relay as unknown as Record<string,unknown>).recoverExpiredDeviceSigningTrust;
  assert.equal(typeof fn,'function','missing owning-host recovery completion API');return fn as (input:Record<string,unknown>)=>Promise<Record<string,unknown>>;}
async function fixture(){
  const old=generateKeyPairSync('ed25519'),next=generateKeyPairSync('ed25519'),device=generateKeyPairSync('ed25519'),encryption=generateKeyPairSync('x25519');
  const pub=(pair:typeof device)=>pair.publicKey.export({format:'jwk'}).x!;
  const keyset=(pair:typeof device,generation:number,issued:number,expiry:number)=>{
    const keyVersion='synthetic-version-'+generation;
    const body={schema:'dharma.server-signing-keyset/v1' as const,organizationId:'org_fixture',generation,
      keys:[{keyVersion,publicKeyEd25519:pub(pair),status:'active' as const,notBefore:new Date(issued).toISOString(),notAfter:new Date(expiry).toISOString()}],
      signedByKeyVersion:keyVersion,issuedAt:new Date(issued).toISOString(),expiresAt:new Date(expiry).toISOString()};
    return {...body,signature:signCanonicalObject(body,pair.privateKey)};
  };
  const root=await mkdtemp(resolve(tmpdir(),'fabric-recovery-client-')),configPath=resolve(root,'device.json');
  const config:DeviceConfig={schema:'dharma.device-config/v1',hqUrl:'https://www.dharma-ai.io',organizationId:'org_fixture',
    installationId:id(1),deviceId:id(2),deviceName:'Synthetic host',platform:'linux',publicKeyEd25519:pub(device),serverPublicKeyEd25519:pub(old),
    serverSigningKeyset:keyset(old,2,now-86400000,now-1000),relayUrl:'wss://relay.example',enrolledAt:'2029-12-01T00:00:00.000Z',
    connectionMode:'manual',setupClaimReference:id(3),setupClaimRepositoryFingerprint:digest('a')};
  const anchor={schema:'dharma.device-enrollment-anchor/v1',hqUrl:config.hqUrl,organizationId:config.organizationId,
    deviceId:config.deviceId,devicePublicKeyEd25519:config.publicKeyEd25519,serverPublicKeyEd25519:config.serverPublicKeyEd25519,
    serverSigningKeyset:config.serverSigningKeyset,enrolledAt:config.enrolledAt};
  const account='device-enrollment-'+hash(`${config.hqUrl}:${config.organizationId}:${config.deviceId}`).slice(7,39);
  const identityAccount='device-key-'+hash(`${config.hqUrl}:${config.organizationId}:${config.installationId}`).slice(7,39);
  const privateIdentity=JSON.stringify(device.privateKey.export({format:'jwk'}));
  const values=new Map([[account,JSON.stringify(anchor)],[identityAccount,privateIdentity]]),reads:string[]=[],writes:string[]=[],requests:RequestInit[]=[];
  let allowed=true,clock=now,handler:(request:RequestInit)=>Promise<Response>;
  const store:SecureSecretStore={backend:'linux-secret-service',get:async key=>{reads.push(key);return values.get(key)??null;},
    getFresh:async key=>{reads.push(key);return values.get(key)??null;},put:async(key,value)=>{writes.push(key);values.set(key,value);},
    delete:async()=>{throw Error('forbidden delete');}};
  const source={organizationId:config.organizationId,workspaceId:id(4),repositoryBindingId:id(5),repositoryFingerprint:digest('a'),
    policyRevision:'agent-fabric-policy-v1',scopeDigest:digest('b'),contractDigest:digest('c'),sourceGenerationId:id(6),
    sourceReceiptId:'repo_consent_'+id(6),sourceRevision:1,sourcePolicyRevision:'repository-source-'+id(6),sourcePolicyHash:digest('d')};
  const session={organizationId:config.organizationId,workspaceId:id(4),repositoryBindingId:id(5),endpointId:id(7),membershipId:id(8),deviceId:id(2),
    bindingId:id(9),provider:'codex' as const,sessionId:'native-thread-fixture',owner:'dharma_bridge' as const,createdAt:new Date(now-1000).toISOString(),
    expiresAt:new Date(now+900000).toISOString(),maximumProviderCostCents:4000};
  const input={configPath,source,session,hostBinding:{connectionId:id(10),hostContextId:id(11),threadId:session.sessionId,turnId:'native-turn-fixture'},
    hostScope:{signal:new AbortController().signal,current:async()=>allowed},store,now:()=>clock,
    fetcher:async(url:string|URL|Request,request?:RequestInit)=>{
      assert.equal(url,config.hqUrl+'/api/v1/agent-fabric/signing-recovery');requests.push(request!);return handler(request!);
    }};
  await writeFile(configPath,JSON.stringify(config));
  const plan=await relay.planDeviceSigningRecovery(input);reads.length=0;
  const {schema:_schema,planId:_planId,authority:_authority,preparedAt:_preparedAt,expiresAt:_expires,...context}=plan;
  void [_schema,_planId,_authority,_preparedAt,_expires];
  const nextKeyset=keyset(next,3,now,now+86400000);
  const challenge:DeviceSigningRecoveryChallenge={...context,schema:'dharma.device-signing-recovery-challenge/v1',purpose:'expired_signing_trust_reapproval',
    recoveryId:id(12),approvalId:id(13),credentialEncryptionPublicKey:pub(encryption),candidateGeneration:3,
    candidateKeysetHash:objectHash(nextKeyset),candidateRootFingerprint:hash(Buffer.from(pub(next),'base64url')),
    candidateKeyVersionFingerprint:hash(nextKeyset.signedByKeyVersion),method:'POST',path:'/api/v1/agent-fabric/signing-recovery',
    nonce:Buffer.alloc(32,7).toString('base64url'),authenticator:Buffer.alloc(32,8).toString('base64url'),
    issuedAt:new Date(now).toISOString(),expiresAt:new Date(now+600000).toISOString()};
  const candidate:DeviceSigningRecoveryCandidate={schema:'dharma.device-signing-recovery-candidate/v1',organizationId:config.organizationId,
    recoveryId:challenge.recoveryId,approvalId:challenge.approvalId,keysetCanonical:canonicalize(nextKeyset),rootPublicKey:pub(next),
    publication:{schema:'dharma.signing-recovery-publication/v1',organizationId:config.organizationId,recoveryId:challenge.recoveryId,
      generation:3,artifactHash:digest('e'),publishedAt:new Date(now).toISOString()}};
  const delivery=sealDeviceSigningRecoveryDelivery(challenge,candidate,now);
  const body={ok:true,delivery,clientTrustInstalled:false,nativeSessionBinding:'device_attested_not_independently_observed'};
  handler=async request=>{
    const value=JSON.parse(String(request.body));
    assert.deepEqual(Object.keys(value).sort(),['action','approvalId','organizationId','recoveryId','schema','signature']);
    assert.equal(value.action,'delivery');assert.equal(value.recoveryId,challenge.recoveryId);assert.equal(value.approvalId,challenge.approvalId);
    assert.equal(verify(null,deviceSigningRecoverySigningPayload(challenge),device.publicKey,Buffer.from(value.signature,'base64url')),true);
    const headers=new Headers(request.headers);
    assert.equal(headers.has('authorization'),false);assert.equal(request.redirect,'error');
    const transport=Buffer.from(JSON.stringify({bodyHash:hash(String(request.body)),deviceId:config.deviceId,messageId:challenge.approvalId,method:'POST',
      nonce:challenge.nonce,organizationId:config.organizationId,pathname:'/api/v1/agent-fabric/signing-recovery',sequence:1,
      sessionId:challenge.recoveryId,timestamp:new Date(now).toISOString()}));
    assert.equal(headers.get('x-dharma-device-id'),config.deviceId);assert.equal(headers.get('x-dharma-message-id'),challenge.approvalId);
    assert.equal(headers.get('x-dharma-session-id'),challenge.recoveryId);assert.equal(headers.get('x-dharma-nonce'),challenge.nonce);
    assert.equal(headers.get('x-dharma-sequence'),'1');assert.equal(headers.get('x-dharma-timestamp'),new Date(now).toISOString());
    assert.equal(headers.has('cookie'),false);
    assert.equal(verify(null,transport,device.publicKey,Buffer.from(headers.get('x-dharma-signature')!,'base64url')),true);
    assert.equal(request.credentials,'omit');return Response.json(body);
  };
  return {root,configPath,config,account,identityAccount,privateIdentity,values,reads,writes,requests,source,session,challenge,candidate,body,
    input:{...input,challenge,encryptionKey:encryption.privateKey},setHandler:(value:typeof handler)=>{handler=value;},
    revoke:()=>{allowed=false;},clock:(value:number)=>{clock=value;},cleanup:()=>rm(root,{recursive:true,force:true})};
}

test('owning host retrieves exact TLS-origin delivery, decrypts and commits without credentials or identity replacement',async()=>{
  const f=await fixture();try{
    const result=await api()(f.input),config=JSON.parse(await readFile(f.configPath,'utf8'));
    assert.equal(config.serverPublicKeyEd25519,f.candidate.rootPublicKey);assert.equal(config.deviceId,f.config.deviceId);
    assert.equal(f.values.get(f.identityAccount),f.privateIdentity);assert.equal(f.requests.length,1);
    assert.ok(f.writes.length===2&&f.writes.every(key=>key===f.account));
    assert.equal(f.reads.filter(key=>key===f.identityAccount).length,1);
    assert.equal(result.schema,'dharma.device-signing-recovery-completion/v1');assert.equal(result.ready,false);
    assert.equal(result.deviceId,f.config.deviceId);assert.equal(result.generation,3);
    assert.doesNotMatch(JSON.stringify(result),/private|signature|authenticator|keysetCanonical|token/);
    const schemas=resolve(import.meta.dirname,'../../../schemas');
    assert.equal((await validateContract(schemas,'https://schemas.dharma-ai.io/device-signing-recovery-completion/v1',result)).ok,true);
    assert.equal((await validateContract(schemas,'https://schemas.dharma-ai.io/device-signing-recovery-delivery-request/v1',JSON.parse(String(f.requests[0]!.body)))).ok,true);
    await assert.rejects(api()(f.input));assert.equal(f.requests.length,1);assert.equal(f.writes.length,2,'lost-return retry cannot repeat trust installation');
  }finally{await f.cleanup();}
});
test('oversized/mistyped response bodies and foreign response origins are denied before the journal',async()=>{
  for(const fault of ['header','stream','type','origin']){
    const f=await fixture();try{
      f.setHandler(async()=>{
        if(fault==='header')return new Response('{}',{headers:{'content-type':'application/json','content-length':'65537'}});
        if(fault==='stream')return new Response('x'.repeat(65537),{headers:{'content-type':'application/json'}});
        if(fault==='type')return new Response(JSON.stringify(f.body),{headers:{'content-type':'text/html'}});
        const response=Response.json(f.body);Object.defineProperty(response,'url',{value:'https://foreign.example/response'});return response;
      });
      await assert.rejects(api()(f.input));assert.equal(f.writes.length,0);assert.equal(f.requests.length,1);
    }finally{await f.cleanup();}
  }
});
test('withdrawal cancels the owned response body and reports no completed installation',async()=>{
  const f=await fixture();try{
    let cancelled=false;
    f.setHandler(async()=>{f.revoke();return new Response(new ReadableStream({cancel(){cancelled=true;}}),{headers:{'content-type':'application/json'}});});
    await assert.rejects(api()(f.input),/relay_host_scope_unavailable/);
    assert.equal(cancelled,true);assert.equal(f.writes.length,0);assert.equal(f.requests.length,1);
  }finally{await f.cleanup();}
});
test('foreign context, missing private key and wrong encryption identity stop before HTTP or protected writes',async()=>{
  for(const change of ['context','encryption','missing-device-key','withdrawn']){
    const f=await fixture();try{
      const input={...f.input};
      if(change==='context')input.challenge={...f.challenge,installationId:id(20)};
      if(change==='encryption')input.encryptionKey=generateKeyPairSync('x25519').privateKey;
      if(change==='missing-device-key')f.values.delete(f.identityAccount);
      if(change==='withdrawn')f.revoke();
      await assert.rejects(api()(input));assert.equal(f.requests.length,0);assert.equal(f.writes.length,0);
      assert.deepEqual(JSON.parse(await readFile(f.configPath,'utf8')),f.config);
    }finally{await f.cleanup();}
  }
});
test('response injection, transport errors, expiry and stale native context are sanitized and never retried or committed',async()=>{
  for(const change of ['credential','ciphertext','http','network','expiry','session','withdrawal']){
    const f=await fixture();try{
      f.setHandler(async()=>{
        if(change==='network')throw Error('SYNTHETIC_PRIVATE_RESPONSE');
        if(change==='http')return new Response('SYNTHETIC_PRIVATE_RESPONSE',{status:403});
        if(change==='expiry')f.clock(now+600000);
        if(change==='session')f.session.bindingId=id(20);
        if(change==='withdrawal')f.revoke();
        return Response.json(change==='credential'?{...f.body,token:'SYNTHETIC_PRIVATE_RESPONSE'}:
          change==='ciphertext'?{...f.body,delivery:{...f.body.delivery,ciphertext:'AAAA'}}:f.body);
      });
      await assert.rejects(api()(f.input),error=>error instanceof Error&&!error.message.includes('SYNTHETIC_PRIVATE_RESPONSE'));
      assert.equal(f.requests.length,1);assert.equal(f.writes.length,0);
      assert.deepEqual(JSON.parse(await readFile(f.configPath,'utf8')),f.config);
    }finally{await f.cleanup();}
  }
});
