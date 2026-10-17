import assert from 'node:assert/strict';
import {createHash,generateKeyPairSync,sign} from 'node:crypto';
import {resolve} from 'node:path';
import test from 'node:test';
import * as contracts from './index.js';

const now=Date.parse('2030-01-01T00:00:00.000Z'),id=(n:number)=>`b3000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const hash=(v:string|Buffer)=>'sha256:'+createHash('sha256').update(v).digest('hex');
const device=generateKeyPairSync('ed25519'),root=generateKeyPairSync('ed25519'),encryption=generateKeyPairSync('x25519');
const at=(n=now)=>new Date(n).toISOString(),pub=root.publicKey.export({format:'jwk'}).x!;
const unsigned={schema:'dharma.server-signing-keyset/v1',organizationId:'org_fixture',generation:2,
  keys:[{keyVersion:'synthetic-history',publicKeyEd25519:pub,status:'active',notBefore:at(now-86400000),notAfter:at(now-1)}],
  signedByKeyVersion:'synthetic-history',issuedAt:at(now-86400000),expiresAt:at(now-1)};
const history=contracts.canonicalize({...unsigned,signature:sign(null,Buffer.from(contracts.canonicalize(unsigned)),root.privateKey).toString('base64url')});
const plan={schema:'dharma.device-signing-recovery-plan/v1',planId:id(1),authority:'local_context_only_not_recovery_authorization',
  preparedAt:at(),expiresAt:at(now+600000),origin:'https://www.dharma-ai.io',issuer:'https://www.dharma-ai.io',
  audience:'dharma.agent-fabric.signing-recovery/v1',organizationId:'org_fixture',recipientMembershipId:id(2),deviceId:id(3),
  installationId:id(4),workspaceId:id(5),publicKeyEd25519:device.publicKey.export({format:'jwk'}).x!,repositoryFingerprint:hash('repo'),
  policyRevision:'agent-fabric-policy-v1',scopeDigest:hash('scope'),contractDigest:hash('contract'),sourceSelectionDigest:hash('source'),
  nativeSessionBindingDigest:hash('native'),previousAnchorHash:hash('anchor'),protectedConfigDigest:hash('config'),previousGeneration:2,
  previousKeysetHash:hash(history),previousRootFingerprint:hash(Buffer.from(pub,'base64url'))};
const preparation={schema:'dharma.device-signing-recovery-preparation/v1',purpose:'prepare_expired_signing_trust_recovery',method:'POST',
  path:'/api/v1/agent-fabric/signing-recovery/preparations',plan,historicalKeysetCanonical:history,historicalRootPublicKey:pub,
  credentialEncryptionPublicKey:encryption.publicKey.export({format:'jwk'}).x!,nonce:Buffer.alloc(32,2).toString('base64url')};
const selection={organizationId:plan.organizationId,deviceId:plan.deviceId,preparationId:plan.planId};
const read={schema:'dharma.device-signing-recovery-offer-read-request/v1',purpose:'read_prepared_recovery_offer',method:'POST',
  path:'/api/v1/agent-fabric/signing-recovery/offers/read',...selection,requestId:id(6),nonce:Buffer.alloc(32,3).toString('base64url'),issuedAt:at(),expiresAt:at(now+60000)};
const register={...read,schema:'dharma.device-signing-recovery-offer-registration-request/v1',purpose:'register_prepared_recovery_proof',
  path:'/api/v1/agent-fabric/signing-recovery/offers/register',recoveryId:id(7),approvalId:id(8),signature:Buffer.alloc(64,4).toString('base64url')};
const {schema:_s,authority:_a,planId:_p,preparedAt:_at,expiresAt:_e,...binding}=plan;void[_s,_a,_p,_at,_e];
const challenge={...binding,schema:'dharma.device-signing-recovery-challenge/v1',purpose:'expired_signing_trust_reapproval',method:'POST',
  path:'/api/v1/agent-fabric/signing-recovery',recoveryId:register.recoveryId,approvalId:register.approvalId,
  credentialEncryptionPublicKey:preparation.credentialEncryptionPublicKey,candidateGeneration:3,candidateKeysetHash:hash('candidate'),
  candidateRootFingerprint:hash('new-root'),candidateKeyVersionFingerprint:hash('new-version'),nonce:Buffer.alloc(32,5).toString('base64url'),
  authenticator:Buffer.alloc(32,6).toString('base64url'),issuedAt:at(),expiresAt:plan.expiresAt};
const waiting={schema:'dharma.device-signing-recovery-offer-response/v1',...selection,expiresAt:plan.expiresAt,
  state:'awaiting_browser_offer',deviceProofRegistered:false,clientTrustInstalled:false,ready:false};
const offered={...waiting,state:'awaiting_device_proof',challenge};
const receipt={schema:'dharma.device-signing-recovery-offer-registration-receipt/v1',...selection,recoveryId:register.recoveryId,
  approvalId:register.approvalId,state:'pending_approval',expiresAt:challenge.expiresAt,deviceProofRegistered:true,clientTrustInstalled:false,ready:false};
type Parser=(...args:unknown[])=>unknown;
function api(name:string):Parser {const value=(contracts as unknown as Record<string,unknown>)[name];assert.equal(typeof value,'function','missing_public_offer_API:'+name);return value as Parser;}
const parseRead=(v:unknown=read,scope:unknown=selection,time=now)=>api('parseDeviceSigningRecoveryOfferReadRequest')(v,scope,time);
const parseRegister=(v:unknown=register,time=now)=>api('parseDeviceSigningRecoveryOfferRegistrationRequest')(v,selection,time);
const parseResponse=(v:unknown=offered,p:unknown=preparation,expected:unknown=plan,time=now)=>api('parseDeviceSigningRecoveryOfferResponse')(v,p,expected,time);

test('fixed read and registration requests are distinct frozen public contracts, not browser consent',()=>{
  assert.deepEqual(parseRead(),read);assert.deepEqual(parseRegister(),register);assert.ok(Object.isFrozen(parseRead()));
  assert.throws(()=>parseRead(register));assert.throws(()=>parseRegister(read));
  for(const field of ['organizationId','deviceId','preparationId'])assert.throws(()=>parseRead(read,{...selection,[field]:field==='organizationId'?'org_foreign':id(99)}));
});
test('request time is canonical, fresh, short lived and cannot silently accept a longer window',()=>{
  parseRead();
  for(const time of [now-1,now+60000,NaN])assert.throws(()=>parseRead(read,selection,time));
  for(const delta of [{expiresAt:at(now+60001)},{issuedAt:at(now+1)},{expiresAt:at(now)},
    {issuedAt:'2030-01-01T00:00:00+00:00'},{nonce:'x'.repeat(43)},{deviceId:id(3)+'\n'},{requestId:'not-uuid'}])assert.throws(()=>parseRead({...read,...delta}));
});
test('requests reject path/purpose substitution, proof corruption and extra authority or credential fields',()=>{
  parseRead();parseRegister();
  for(const delta of [{method:'GET'},{path:read.path+'?other=1'},{purpose:register.purpose},{approved:true},{token:'SYNTHETIC_CANARY'},
    {ownerMembershipId:id(2)},{intent:{}},{challenge}])assert.throws(()=>parseRead({...read,...delta}));
  for(const delta of [{signature:'x'.repeat(86)},{signature:register.signature+'\n'},{recoveryId:id(7)+'\n'},
    {path:read.path},{purpose:read.purpose},{intent:{approved:true}}])assert.throws(()=>parseRegister({...register,...delta}));
});
test('a pending response has no challenge and every response remains explicitly not ready',()=>{
  assert.deepEqual(parseResponse(waiting),waiting);assert.deepEqual(parseResponse(),offered);
  assert.ok(Object.isFrozen(parseResponse()));assert.throws(()=>parseResponse({...waiting,challenge}));
  for(const delta of [{ready:true},{clientTrustInstalled:true},{deviceProofRegistered:true},{state:'approved'},
    {signature:register.signature},{credential:'SYNTHETIC_CANARY'},{intent:{challenge}}])assert.throws(()=>parseResponse({...offered,...delta}));
});
test('the offered challenge must match all local preparation fields and the exact encryption key',()=>{
  parseResponse();
  for(const field of ['organizationId','recipientMembershipId','deviceId','workspaceId','installationId','publicKeyEd25519',
    'repositoryFingerprint','scopeDigest','contractDigest','sourceSelectionDigest','nativeSessionBindingDigest','previousAnchorHash',
    'protectedConfigDigest','previousKeysetHash','previousRootFingerprint','credentialEncryptionPublicKey']) {
    const value=field==='organizationId'?'org_foreign':field.endsWith('Id')?id(99)
      :['publicKeyEd25519','credentialEncryptionPublicKey'].includes(field)?Buffer.alloc(32,9).toString('base64url'):hash('changed');
    assert.throws(()=>parseResponse({...offered,challenge:{...challenge,[field]:value}}),field);
  }
  for(const delta of [{candidateGeneration:4},{candidateRootFingerprint:plan.previousRootFingerprint},
    {issuedAt:at(now-1)},{expiresAt:at(now+600001)}])assert.throws(()=>parseResponse({...offered,challenge:{...challenge,...delta}}));
});
test('response identifiers, registration state and bounded expiry cannot drift on retry',()=>{
  for(const delta of [{preparationId:id(99)},{deviceId:id(99)},{organizationId:'org_foreign'},
    {expiresAt:at(now+600001)},{expiresAt:at(now)},{state:'pending_approval'}])assert.throws(()=>parseResponse({...offered,...delta}));
  assert.deepEqual(parseResponse({...offered,state:'pending_approval',deviceProofRegistered:true}),{...offered,state:'pending_approval',deviceProofRegistered:true});
  const parse=api('parseDeviceSigningRecoveryOfferRegistrationReceipt');assert.deepEqual(parse(receipt,register,challenge.expiresAt,now),receipt);
  for(const delta of [{approvalId:id(99)},{recoveryId:id(99)},{expiresAt:at(now+600001)},{deviceProofRegistered:false},{ready:true}])
    assert.throws(()=>parse({...receipt,...delta},register,challenge.expiresAt,now));
});
test('public parsers never evaluate caller accessors/proxies and snapshot nested challenge data',()=>{
  let evaluated=0;
  for(const v of [{...read,get nonce(){evaluated++;return read.nonce;}},new Proxy(read,{get(){evaluated++;throw Error('getter');}})])assert.throws(()=>parseRead(v));
  for(const v of [{...offered,get challenge(){evaluated++;return challenge;}},{...offered,challenge:new Proxy(challenge,{get(){evaluated++;throw Error('getter');}})}])assert.throws(()=>parseResponse(v));
  const parseReceipt=api('parseDeviceSigningRecoveryOfferRegistrationReceipt');
  for(const v of [{...register,get organizationId(){evaluated++;return register.organizationId;}},
    new Proxy(register,{get(){evaluated++;throw Error('getter');}})])assert.throws(()=>parseReceipt(receipt,v,challenge.expiresAt,now));
  assert.equal(evaluated,0);
  const input=structuredClone(offered),parsed=parseResponse(input) as typeof offered;input.challenge.workspaceId=id(99);
  assert.equal(parsed.challenge.workspaceId,plan.workspaceId);assert.ok(Object.isFrozen(parsed.challenge));
});
test('all four wire shapes agree with separately versioned strict schemas',async()=>{
  const schemas=resolve(import.meta.dirname,'../../../schemas');
  for(const [name,value]of [['read-request',read],['registration-request',register],['response',waiting],['response',offered],
    ['registration-receipt',receipt]] as const){
    assert.equal((await contracts.validateContract(schemas,'https://schemas.dharma-ai.io/device-signing-recovery-offer-'+name+'/v1',value)).ok,true,name);
    assert.equal((await contracts.validateContract(schemas,'https://schemas.dharma-ai.io/device-signing-recovery-offer-'+name+'/v1',{...value,approved:true})).ok,false,name);
  }
});
