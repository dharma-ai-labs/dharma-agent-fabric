import assert from 'node:assert/strict';
import {createHash,generateKeyPairSync,randomBytes,verify} from 'node:crypto';
import {mkdir,mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';
import test from 'node:test';
import {LocalVault,type LocalProviderSessionBinding} from '@dharma-ai-labs/agent-fabric-local-vault';
import {canonicalize,deviceSigningRecoveryPreparationSigningPayload,deviceSigningRecoverySigningPayload,
  parseDeviceSigningRecoveryPreparation,sealDeviceSigningRecoveryDelivery,signCanonicalObject,validateContract,
  type DeviceSigningRecoveryChallenge,type DeviceSigningRecoveryPreparation} from '@dharma-ai-labs/agent-fabric-contracts';
import type {DeviceConfig,SecureSecretStore} from '@dharma-ai-labs/agent-fabric-relay-client';
import {runDeviceSigningMaintenanceController} from './deviceSigningMaintenanceController.js';
import {saveNamedSession} from './namedSessionService.js';
import {withLegacySigningMaintenanceBoundary} from './legacySigningMaintenanceBoundary.js';

const id=(n:number)=>`de000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const hash=(value:string|Buffer)=>'sha256:'+createHash('sha256').update(value).digest('hex');
const digest=(c:string)=>'sha256:'+c.repeat(64);
const controlled=(input:Parameters<typeof runDeviceSigningMaintenanceController>[0])=>withLegacySigningMaintenanceBoundary({
  ...input,assertManagedCohort:async()=>digest('f')},
  legacyBoundary=>runDeviceSigningMaintenanceController({...input,legacyBoundary}));
async function fixture(){
  const root=await mkdtemp(resolve(tmpdir(),'dhr-maintenance-')),now=Date.now(),masterKey=randomBytes(32);
  const old=generateKeyPairSync('ed25519'),next=generateKeyPairSync('ed25519'),device=generateKeyPairSync('ed25519');
  const pub=(key:typeof old)=>key.publicKey.export({format:'jwk'}).x!;
  const keyset=(key:typeof old,generation:number,issued:number,expiry:number)=>{
    const body={schema:'dharma.server-signing-keyset/v1' as const,organizationId:'org_fixture',generation,
      keys:[{keyVersion:'fixture-'+generation,publicKeyEd25519:pub(key),status:'active' as const,notBefore:new Date(issued).toISOString(),notAfter:new Date(expiry).toISOString()}],
      signedByKeyVersion:'fixture-'+generation,issuedAt:new Date(issued).toISOString(),expiresAt:new Date(expiry).toISOString()};
    return {...body,signature:signCanonicalObject(body,key.privateKey)};
  };
  const config:DeviceConfig={schema:'dharma.device-config/v1',hqUrl:'https://www.dharma-ai.io',organizationId:'org_fixture',
    installationId:id(1),deviceId:id(2),deviceName:'Synthetic controller fixture',platform:'linux',publicKeyEd25519:pub(device),
    serverPublicKeyEd25519:pub(old),serverSigningKeyset:keyset(old,2,now-86400000,now-1000),
    setupClaimReference:id(3),setupClaimRepositoryFingerprint:digest('a'),relayUrl:'wss://relay.fixture.invalid',
    enrolledAt:new Date(now-86400000).toISOString(),connectionMode:'manual'};
  const workspace={organizationId:config.organizationId,workspaceId:id(4),repositoryBindingId:id(5),repositoryRemoteHash:digest('a'),path:resolve(root,'checkout')};
  const identity={organizationId:config.organizationId,workspaceId:id(4),repositoryBindingId:id(5),deviceId:id(2),membershipId:id(6),endpointId:id(7),provider:'codex' as const};
  const binding:LocalProviderSessionBinding={schema:'dharma.local-provider-session-binding/v1',...identity,bindingId:id(8),owner:'dharma_bridge',
    sessionId:'original-disabled-fixture-session',workspaceRoot:workspace.path,createdAt:new Date(now-10000).toISOString(),
    expiresAt:new Date(now+3600000).toISOString(),maximumProviderCostCents:25};
  const registration={schema:'dharma.named-session/v1' as const,name:'reviewer',bindingId:binding.bindingId,identity,maximumCostCents:100,maximumTurnCostCents:25,enabled:false};
  await mkdir(workspace.path);await saveNamedSession(root,registration);
  const vaultRoot=resolve(root,'vault'),vault=await LocalVault.open({root:vaultRoot,masterKey});vault.saveProviderSessionBinding(binding);vault.close();
  const configPath=resolve(root,'device.json');await writeFile(configPath,JSON.stringify(config));
  const anchorAccount='device-enrollment-'+hash(`${config.hqUrl}:${config.organizationId}:${config.deviceId}`).slice(7,39);
  const keyAccount='device-key-'+hash(`${config.hqUrl}:${config.organizationId}:${config.installationId}`).slice(7,39);
  const privateIdentity=JSON.stringify(device.privateKey.export({format:'jwk'}));
  const values=new Map([[keyAccount,privateIdentity],[anchorAccount,JSON.stringify({schema:'dharma.device-enrollment-anchor/v1',hqUrl:config.hqUrl,
    organizationId:config.organizationId,deviceId:config.deviceId,devicePublicKeyEd25519:config.publicKeyEd25519,
    serverPublicKeyEd25519:config.serverPublicKeyEd25519,serverSigningKeyset:config.serverSigningKeyset,enrolledAt:config.enrolledAt})]]);
  const writes:string[]=[],emitted:Record<string,unknown>[]=[],requests:string[]=[];
  const store:SecureSecretStore={backend:'linux-secret-service',get:async key=>values.get(key)??null,getFresh:async key=>values.get(key)??null,
    put:async(key,value)=>{writes.push(key);values.set(key,value);},delete:async()=>{throw Error('FORBIDDEN_DELETE');}};
  const source={organizationId:config.organizationId,workspaceId:id(4),repositoryBindingId:id(5),repositoryFingerprint:digest('a'),
    policyRevision:'agent-fabric-local-analysis-v1',scopeDigest:digest('b'),contractDigest:digest('c'),sourceGenerationId:id(9),
    sourceReceiptId:'repo_consent_'+id(9),sourceRevision:1,sourcePolicyRevision:'repository-source-'+id(9),sourcePolicyHash:digest('d')};
  let preparation:DeviceSigningRecoveryPreparation|undefined,challenge:DeviceSigningRecoveryChallenge|undefined,proofRegistered=false;
  const successor=keyset(next,3,now,now+86400000),abort=new AbortController();
  const fetcher=(async(url:string|URL|Request,init?:RequestInit)=>{
    assert.ok(init);const address=new URL(String(url)),body=JSON.parse(String(init.body)),headers=new Headers(init.headers);
    assert.equal(address.origin,config.hqUrl);assert.equal(init.redirect,'error');assert.equal(init.credentials,'omit');
    assert.equal(headers.has('authorization'),false);assert.equal(headers.has('cookie'),false);
    const transport=Buffer.from(JSON.stringify({bodyHash:hash(String(init.body)),deviceId:config.deviceId,messageId:headers.get('x-dharma-message-id'),
      method:'POST',nonce:headers.get('x-dharma-nonce'),organizationId:config.organizationId,pathname:address.pathname,sequence:1,
      sessionId:headers.get('x-dharma-session-id'),timestamp:headers.get('x-dharma-timestamp')}));
    assert.equal(verify(null,transport,device.publicKey,Buffer.from(headers.get('x-dharma-signature')??'','base64url')),true);
    requests.push(body.schema);
    if(body.schema==='dharma.device-signing-maintenance-context-request/v1'){
      const {schema,issuedAt,repositoryFingerprint,...selection}=body;void[schema,issuedAt,repositoryFingerprint];
      return Response.json({...selection,schema:'dharma.device-signing-maintenance-context/v1',recipientMembershipId:identity.membershipId,
        source,authority:'current_source_context_only_not_consent'});
    }
    if(body.schema==='dharma.device-signing-maintenance-preparation-request/v1'){
      preparation=parseDeviceSigningRecoveryPreparation(body.preparation,body.preparation.plan,now);
      assert.equal(verify(null,deviceSigningRecoveryPreparationSigningPayload(preparation),device.publicKey,Buffer.from(body.signature,'base64url')),true);
      const {schema,planId,authority,preparedAt,expiresAt,...scope}=preparation.plan;void[schema,planId,authority,preparedAt];
      challenge={...scope,schema:'dharma.device-signing-maintenance-challenge/v1',purpose:'expired_signing_trust_reapproval',recoveryId:id(11),approvalId:id(12),
        credentialEncryptionPublicKey:preparation.credentialEncryptionPublicKey,candidateGeneration:3,candidateKeysetHash:hash(canonicalize(successor)),
        candidateRootFingerprint:hash(Buffer.from(pub(next),'base64url')),candidateKeyVersionFingerprint:hash(successor.signedByKeyVersion),
        method:'POST',path:'/api/v1/agent-fabric/signing-recovery',nonce:Buffer.alloc(32,7).toString('base64url'),
        authenticator:Buffer.alloc(32,8).toString('base64url'),issuedAt:new Date(now).toISOString(),expiresAt:new Date(now+600000).toISOString()};
      return Response.json({schema:'dharma.signing-recovery-preparation-receipt/v1',organizationId:config.organizationId,deviceId:config.deviceId,
        recipientMembershipId:identity.membershipId,preparationId:preparation.plan.planId,expiresAt,state:'pending_browser_review',
        controllerBinding:'device_attested_not_native_authority',nativeContinuationAuthorized:false,clientTrustInstalled:false});
    }
    assert.ok(preparation&&challenge);
    const common={organizationId:config.organizationId,deviceId:config.deviceId,preparationId:preparation.plan.planId,
      expiresAt:challenge.expiresAt,clientTrustInstalled:false,ready:false};
    if(address.pathname.endsWith('/offers/read'))return Response.json({...common,schema:'dharma.device-signing-recovery-offer-response/v1',
      state:proofRegistered?'pending_approval':'awaiting_device_proof',deviceProofRegistered:proofRegistered,challenge});
    assert.equal(verify(null,deviceSigningRecoverySigningPayload(challenge),device.publicKey,Buffer.from(body.signature,'base64url')),true);
    if(address.pathname.endsWith('/offers/register')){proofRegistered=true;return Response.json({...common,
      schema:'dharma.device-signing-recovery-offer-registration-receipt/v1',recoveryId:challenge.recoveryId,approvalId:challenge.approvalId,
      state:'pending_approval',deviceProofRegistered:true});}
    assert.equal(body.schema,'dharma.device-signing-maintenance-delivery-request/v1');assert.equal(proofRegistered,true);
    // Synthetic server fixture stands in for separately recorded dual browser
    // consents/publication; this is not a live browser or OS-store receipt.
    const candidate={schema:'dharma.device-signing-recovery-candidate/v1' as const,organizationId:config.organizationId,
      recoveryId:challenge.recoveryId,approvalId:challenge.approvalId,keysetCanonical:canonicalize(successor),rootPublicKey:pub(next),
      publication:{schema:'dharma.signing-recovery-publication/v1' as const,organizationId:config.organizationId,recoveryId:challenge.recoveryId,
        generation:3,artifactHash:digest('e'),publishedAt:new Date(now).toISOString()}};
    return Response.json({ok:true,delivery:sealDeviceSigningRecoveryDelivery(challenge,candidate,now),clientTrustInstalled:false,
      controllerBinding:'device_attested_not_native_authority',nativeContinuationAuthorized:false});
  }) as typeof fetch;
  const input={home:root,configPath,name:'reviewer',workspaceId:workspace.workspaceId,operationId:id(10),apply:true,
    readWorkspace:async()=>workspace,processState:async()=>'stopped' as const,openVault:()=>LocalVault.open({root:vaultRoot,masterKey}),
    signal:abort.signal,frames:(async function*(){for(const action of ['progress','status','complete'])yield Buffer.from(JSON.stringify({schema:'dharma.device-signing-maintenance-control/v1',operationId:id(10),action})+'\n');})(),
    emit:(value:Record<string,unknown>)=>emitted.push(value),store,fetcher,now:()=>now};
  return {root,input,config,configPath,registration,requests,writes,emitted,values,keyAccount,anchorAccount,privateIdentity,abort,
    cleanup:()=>rm(root,{recursive:true,force:true})};
}
test('connected owning controller qualifies source, device proofs and encrypted installation without a native turn',async()=>{
  const f=await fixture();try{
    const result=await controlled(f.input);
    assert.equal(result.ok,true);assert.equal(result.ready,false);assert.equal(result.nativeContinuationAuthorized,false);
    assert.equal((result.progress as {state:string}).state,'trust_installed');
    assert.equal(JSON.parse(await readFile(f.configPath,'utf8')).serverSigningKeyset.generation,3);
    assert.equal(f.values.get(f.keyAccount),f.privateIdentity);assert.ok(f.writes.every(key=>key===f.anchorAccount));
    assert.equal(f.requests.length,5);assert.equal(f.emitted.length,3);
    assert.deepEqual(JSON.parse(await readFile(resolve(f.root,'sessions','reviewer','registration.json'),'utf8')),f.registration);
    for(const value of [...f.emitted,result]){
      const checked=await validateContract(resolve(import.meta.dirname,'../../../schemas'),'https://schemas.dharma-ai.io/device-signing-maintenance-controller-progress/v1',value);
      assert.equal(checked.ok,true,JSON.stringify(checked));
      assert.doesNotMatch(JSON.stringify(value),/signature|authenticator|privateJwk|keysetCanonical|PRIVATE_/);
    }
  }finally{await f.cleanup();}
});
test('sampled stopped state without the exclusive legacy boundary cannot open the vault or dispatch',async()=>{
  const f=await fixture();try{
    let opened=0;
    await assert.rejects(runDeviceSigningMaintenanceController({...f.input,openVault:async()=>{opened++;throw Error('FORBIDDEN_VAULT');}}),/exclusive_legacy_boundary_required/);
    assert.equal(opened,0);assert.deepEqual(f.requests,[]);assert.deepEqual(f.writes,[]);
  }finally{await f.cleanup();}
});
test('cancelled operation is consumed and cannot replay its source or private-key requests',async()=>{
  const f=await fixture();try{
    const frames=async function*(){yield Buffer.from(JSON.stringify({schema:'dharma.device-signing-maintenance-control/v1',operationId:id(10),action:'cancel'})+'\n');};
    const result=await controlled({...f.input,frames:frames()});assert.equal(result.state,'cancelled');
    const count=f.requests.length;assert.equal(count,2);assert.deepEqual(f.writes,[]);
    const repeated=await controlled({...f.input,frames:frames()});
    assert.equal(repeated.state,'unconfirmed');assert.equal(f.requests.length,count);assert.deepEqual(f.writes,[]);
  }finally{await f.cleanup();}
});
for(const action of ['arbitrary-shell','complete-with-extra','foreign-operation','oversized','truncated'])test('fixed controller rejects '+action+' without delivery',async()=>{
  const f=await fixture();try{
    const value={schema:'dharma.device-signing-maintenance-control/v1',operationId:action==='foreign-operation'?id(99):id(10),action:action==='complete-with-extra'?'complete':action};
    const bytes=action==='oversized'?'x'.repeat(513):JSON.stringify({...value,...(action==='complete-with-extra'?{command:'forbidden'}:{})});
    const frames=(async function*(){yield Buffer.from(bytes+(action==='truncated'?'':'\n'));})();
    const result=await controlled({...f.input,frames});
    assert.equal(result.state,'unconfirmed');assert.equal(f.requests.length,2);assert.deepEqual(f.writes,[]);
  }finally{await f.cleanup();}
});
