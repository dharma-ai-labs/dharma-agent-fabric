import assert from 'node:assert/strict';
import {createHash,generateKeyPairSync,sign} from 'node:crypto';
import {resolve} from 'node:path';
import test from 'node:test';
import * as contracts from './index.js';

const now=Date.parse('2030-01-01T00:00:00.000Z'),id=(n:number)=>`b2000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const device=generateKeyPairSync('ed25519'),oldRoot=generateKeyPairSync('ed25519'),encryption=generateKeyPairSync('x25519');
const hash=(v:string|Buffer)=>'sha256:'+createHash('sha256').update(v).digest('hex');
const unsigned={schema:'dharma.server-signing-keyset/v1',organizationId:'org_fixture',generation:2,
  keys:[{keyVersion:'projects/test/locations/global/keyRings/fabric/cryptoKeys/server/cryptoKeyVersions/2',
    publicKeyEd25519:oldRoot.publicKey.export({format:'jwk'}).x!,status:'active',
    notBefore:'2029-11-30T00:00:00.000Z',notAfter:'2029-12-29T00:00:00.000Z'}],
  signedByKeyVersion:'projects/test/locations/global/keyRings/fabric/cryptoKeys/server/cryptoKeyVersions/2',
  issuedAt:'2029-12-01T00:00:00.000Z',expiresAt:'2029-12-29T00:00:00.000Z'};
const historicalKeysetCanonical=contracts.canonicalize({...unsigned,signature:sign(null,Buffer.from(contracts.canonicalize(unsigned)),oldRoot.privateKey).toString('base64url')});
const plan={schema:'dharma.device-signing-recovery-plan/v1',planId:id(1),authority:'local_context_only_not_recovery_authorization',
  preparedAt:new Date(now).toISOString(),expiresAt:new Date(now+600000).toISOString(),origin:'https://www.dharma-ai.io',
  issuer:'https://www.dharma-ai.io',audience:'dharma.agent-fabric.signing-recovery/v1',organizationId:'org_fixture',
  recipientMembershipId:id(2),deviceId:id(3),installationId:id(4),workspaceId:id(5),publicKeyEd25519:device.publicKey.export({format:'jwk'}).x!,
  repositoryFingerprint:hash('repo'),policyRevision:'agent-fabric-policy-v1',scopeDigest:hash('scope'),contractDigest:hash('contract'),
  sourceSelectionDigest:hash('source'),nativeSessionBindingDigest:hash('native'),previousAnchorHash:hash('anchor'),protectedConfigDigest:hash('config'),
  previousGeneration:2,previousKeysetHash:hash(historicalKeysetCanonical),previousRootFingerprint:hash(Buffer.from(oldRoot.publicKey.export({format:'jwk'}).x!,'base64url'))};
const preparation={schema:'dharma.device-signing-recovery-preparation/v1',purpose:'prepare_expired_signing_trust_recovery',
  method:'POST',path:'/api/v1/agent-fabric/signing-recovery/preparations',plan,historicalKeysetCanonical,
  historicalRootPublicKey:oldRoot.publicKey.export({format:'jwk'}).x!,credentialEncryptionPublicKey:encryption.publicKey.export({format:'jwk'}).x!,
  nonce:Buffer.alloc(32,9).toString('base64url')};
type Preparation=typeof preparation;
function api(){
  const value=contracts as unknown as Record<string,unknown>;
  for(const name of ['parseDeviceSigningRecoveryPreparation','deviceSigningRecoveryPreparationSigningPayload','verifyDeviceSigningRecoveryPreparationProof'])
    assert.equal(typeof value[name],'function','missing_public_preparation_API:'+name);
  return value as unknown as {parseDeviceSigningRecoveryPreparation(v:unknown,expected:typeof plan,at:number):Preparation;
    deviceSigningRecoveryPreparationSigningPayload(v:unknown):Buffer;
    verifyDeviceSigningRecoveryPreparationProof(v:unknown,signature:unknown,expected:typeof plan,at:number):boolean};
}
const proof=(v:unknown=preparation)=>sign(null,api().deviceSigningRecoveryPreparationSigningPayload(v),device.privateKey).toString('base64url');

test('preparation binds real device possession and historical public bytes, not approval or current trust',()=>{
  const result=api().parseDeviceSigningRecoveryPreparation(preparation,plan,now);
  assert.deepEqual(result,preparation);assert.ok(Object.isFrozen(result)&&Object.isFrozen(result.plan));
  assert.equal(api().verifyDeviceSigningRecoveryPreparationProof(preparation,proof(),plan,now),true);
  const wrong=sign(null,api().deviceSigningRecoveryPreparationSigningPayload(preparation),generateKeyPairSync('ed25519').privateKey).toString('base64url');
  assert.equal(api().verifyDeviceSigningRecoveryPreparationProof(preparation,wrong,plan,now),false);
});
for(const [field,value]of Object.entries({organizationId:'org_foreign',recipientMembershipId:id(9),deviceId:id(9),workspaceId:id(9),
  installationId:id(9),planId:id(9),origin:'https://foreign.example',issuer:'https://foreign.example',policyRevision:'foreign-v1',
  scopeDigest:hash('foreign'),contractDigest:hash('foreign'),nativeSessionBindingDigest:hash('foreign'),sourceSelectionDigest:hash('foreign'),
  previousAnchorHash:hash('foreign'),protectedConfigDigest:hash('foreign'),previousKeysetHash:hash('foreign'),previousRootFingerprint:hash('foreign'),previousGeneration:3})){
  test('preparation refuses changed local '+field,()=>{
    assert.equal(api().verifyDeviceSigningRecoveryPreparationProof({...preparation,plan:{...plan,[field]:value}},proof(),plan,now),false);
  });
}
test('preparation proof is separated from normal challenge, enrollment, method, path, encryption key and nonce',()=>{
  const signature=proof();
  for(const delta of [{schema:'dharma.setup-claim-challenge/v1'},{purpose:'expired_signing_trust_reapproval'},{method:'GET'},
    {path:'/api/v1/agent-fabric/signing-recovery'},{nonce:Buffer.alloc(32,8).toString('base64url')},
    {credentialEncryptionPublicKey:generateKeyPairSync('x25519').publicKey.export({format:'jwk'}).x!}])
    assert.equal(api().verifyDeviceSigningRecoveryPreparationProof({...preparation,...delta},signature,plan,now),false);
  assert.ok(api().deviceSigningRecoveryPreparationSigningPayload(preparation).toString().startsWith('dharma.agent-fabric.device-signing-recovery-preparation-proof/v1\0'));
});
test('preparation refuses expired/future/oversized and unauthenticated historical bytes',()=>{
  for(const at of [now-1,now+600000,NaN])assert.throws(()=>api().parseDeviceSigningRecoveryPreparation(preparation,plan,at));
  for(const delta of [{historicalKeysetCanonical:'x'.repeat(16385)},
    {historicalKeysetCanonical:preparation.historicalKeysetCanonical+' '},
    {historicalRootPublicKey:generateKeyPairSync('ed25519').publicKey.export({format:'jwk'}).x!},
    {historicalKeysetCanonical:contracts.canonicalize({...unsigned,signature:Buffer.alloc(64,7).toString('base64url')})}])
    assert.equal(api().verifyDeviceSigningRecoveryPreparationProof({...preparation,...delta},proof(),plan,now),false);
  const long={...plan,expiresAt:new Date(now+900001).toISOString()};
  assert.throws(()=>api().parseDeviceSigningRecoveryPreparation({...preparation,plan:long},long,now));
});
test('preparation rejects role/approval/credential fields, accessors, proxies and post-validation mutation',()=>{
  let evaluated=0;
  for(const value of [{...preparation,approved:true},{...preparation,token:'SYNTHETIC_NOT_REAL'},
    {...preparation,plan:{...plan,isAdmin:true}},{...preparation,get nonce(){evaluated++;return preparation.nonce;}},
    {...preparation,plan:new Proxy(plan,{get(){evaluated++;throw Error('getter');}})}])
    assert.throws(()=>api().parseDeviceSigningRecoveryPreparation(value,plan,now));
  assert.equal(evaluated,0);
  const raw=structuredClone(preparation),copy=api().parseDeviceSigningRecoveryPreparation(raw,plan,now);
  raw.plan.deviceId=id(9);assert.equal(copy.plan.deviceId,plan.deviceId);
});
test('public preparation shape agrees with versioned schema',async()=>{
  const schemas=resolve(import.meta.dirname,'../../../schemas');
  assert.equal((await contracts.validateContract(schemas,'https://schemas.dharma-ai.io/device-signing-recovery-preparation/v1',preparation)).ok,true);
  assert.equal((await contracts.validateContract(schemas,'https://schemas.dharma-ai.io/device-signing-recovery-preparation/v1',{...preparation,approved:true})).ok,false);
});
test('preparation rejects low-order encryption peers before a future root can be published',()=>{
  for(const point of [Buffer.alloc(32),Buffer.from([1,...Array(31).fill(0)])]){
    assert.throws(()=>api().parseDeviceSigningRecoveryPreparation({...preparation,credentialEncryptionPublicKey:point.toString('base64url')},plan,now));
  }
});
