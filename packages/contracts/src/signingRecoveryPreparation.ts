import {createHash,createPublicKey,diffieHellman,generateKeyPairSync,verify} from 'node:crypto';
import {types} from 'node:util';
import {canonicalize,validateTrustedServerSigningKeysetContract,verifyInitialServerSigningKeyset,type TrustedServerSigningKeyset} from './index.js';

interface DeviceSigningRecoveryPlanBase {
  planId:string;
  authority:'local_context_only_not_recovery_authorization'; preparedAt:string; expiresAt:string;
  origin:string; issuer:string; organizationId:string;
  recipientMembershipId:string; deviceId:string; installationId:string; workspaceId:string; publicKeyEd25519:string;
  repositoryFingerprint:string; policyRevision:string; scopeDigest:string; contractDigest:string; sourceSelectionDigest:string;
  previousAnchorHash:string; protectedConfigDigest:string; previousGeneration:number;
  previousKeysetHash:string; previousRootFingerprint:string;
}
export type DeviceSigningRecoveryLocalPlan = DeviceSigningRecoveryPlanBase & (
  {schema:'dharma.device-signing-recovery-plan/v1'; audience:'dharma.agent-fabric.signing-recovery/v1';
    nativeSessionBindingDigest:string; controllerBindingDigest?:never}
  | {schema:'dharma.device-signing-maintenance-plan/v1'; audience:'dharma.agent-fabric.signing-maintenance/v1';
    controllerBindingDigest:string; nativeSessionBindingDigest?:never});
export interface DeviceSigningRecoveryPreparation {
  schema:'dharma.device-signing-recovery-preparation/v1'|'dharma.device-signing-maintenance-preparation/v1'; purpose:'prepare_expired_signing_trust_recovery';
  method:'POST'; path:'/api/v1/agent-fabric/signing-recovery/preparations'; plan:DeviceSigningRecoveryLocalPlan;
  historicalKeysetCanonical:string; historicalRootPublicKey:string; credentialEncryptionPublicKey:string; nonce:string;
}
const DOMAIN='dharma.agent-fabric.device-signing-recovery-preparation-proof/v1';
const PLAN_KEYS=['schema','planId','authority','preparedAt','expiresAt','origin','issuer','audience','organizationId',
  'recipientMembershipId','deviceId','installationId','workspaceId','publicKeyEd25519','repositoryFingerprint','policyRevision',
  'scopeDigest','contractDigest','sourceSelectionDigest','nativeSessionBindingDigest','previousAnchorHash','protectedConfigDigest',
  'previousGeneration','previousKeysetHash','previousRootFingerprint'];
const KEYS=['schema','purpose','method','path','plan','historicalKeysetCanonical','historicalRootPublicKey','credentialEncryptionPublicKey','nonce'];
const HASH=/^sha256:[a-f0-9]{64}$(?![\s\S])/,UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$(?![\s\S])/;
const invalid=():never=>{throw Error('device_signing_recovery_preparation_invalid');};
function origin(value:unknown){
  if(!value||typeof value!=='object'||types.isProxy(value))return invalid();
  const fields=Object.getOwnPropertyDescriptors(value);
  const maintenance=fields.schema?.value==='dharma.device-signing-maintenance-plan/v1';
  const binding=maintenance?'controllerBindingDigest':'nativeSessionBindingDigest';
  return {maintenance,binding,keys:PLAN_KEYS.map(key=>key==='nativeSessionBindingDigest'?binding:key)};
}
const hash=(v:string|Buffer)=>'sha256:'+createHash('sha256').update(v).digest('hex');
function record(value:unknown,keys:string[]):Record<string,unknown>{
  if(!value||typeof value!=='object'||Array.isArray(value)||types.isProxy(value)
    ||![null,Object.prototype].includes(Object.getPrototypeOf(value))||Object.getOwnPropertySymbols(value).length)return invalid();
  const fields=Object.getOwnPropertyDescriptors(value);
  if(Object.keys(fields).sort().join('\0')!==[...keys].sort().join('\0'))return invalid();
  const result:Record<string,unknown>={};
  for(const key of keys){const f=fields[key];if(!f?.enumerable||!Object.hasOwn(f,'value'))return invalid();
    Object.defineProperty(result,key,{value:f.value,enumerable:true});}
  return result;
}
function bytes(value:unknown,size:number):Buffer{
  if(typeof value!=='string'||value.length!==Math.ceil(size*4/3)||!/^[A-Za-z0-9_-]+$(?![\s\S])/.test(value))return invalid();
  const b=Buffer.from(value,'base64url');if(b.length!==size||b.toString('base64url')!==value)return invalid();return b;
}
function timestamp(value:unknown):number{
  if(typeof value!=='string'||value.length>40)return invalid();const n=Date.parse(value);
  if(!Number.isFinite(n)||new Date(n).toISOString()!==value)return invalid();return n;
}
function plan(value:unknown,now:number):DeviceSigningRecoveryLocalPlan{
  const kind=origin(value),p=record(value,kind.keys);
  for(const [key,v]of Object.entries(p)){
    if(key==='previousGeneration'){if(!Number.isSafeInteger(v)||Number(v)<1)return invalid();}
    else if(typeof v!=='string'||v.length>256||/[\x00-\x1f\x7f]/.test(v))return invalid();
  }
  if(p.schema!==(kind.maintenance?'dharma.device-signing-maintenance-plan/v1':'dharma.device-signing-recovery-plan/v1')
    ||p.authority!=='local_context_only_not_recovery_authorization'
    ||p.audience!==(kind.maintenance?'dharma.agent-fabric.signing-maintenance/v1':'dharma.agent-fabric.signing-recovery/v1'))return invalid();
  const url=new URL(String(p.origin));
  if(url.protocol!=='https:'||url.username||url.password||url.origin!==p.origin||p.issuer!==p.origin)return invalid();
  for(const key of ['planId','recipientMembershipId','deviceId','installationId','workspaceId'])if(!UUID.test(String(p[key])))return invalid();
  for(const key of ['repositoryFingerprint','scopeDigest','contractDigest','sourceSelectionDigest',kind.binding,
    'previousAnchorHash','protectedConfigDigest','previousKeysetHash','previousRootFingerprint'])if(!HASH.test(String(p[key])))return invalid();
  if(!/^org_[A-Za-z0-9]+$(?![\s\S])/.test(String(p.organizationId))||!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$(?![\s\S])/.test(String(p.policyRevision)))return invalid();
  bytes(p.publicKeyEd25519,32);
  const issued=timestamp(p.preparedAt),expiry=timestamp(p.expiresAt);
  if(!Number.isFinite(now)||issued>now||expiry<=now||expiry<=issued||expiry-issued>900000)return invalid();
  return Object.freeze(p) as unknown as DeviceSigningRecoveryLocalPlan;
}

/** Only a device possession attestation. The server must independently load
 * current device/member/source and frozen history; a browser approval and an
 * actual native host fence remain separate. No root or grant is activated. */
export function parseDeviceSigningRecoveryPreparation(value:unknown,expected:DeviceSigningRecoveryLocalPlan,now:number):DeviceSigningRecoveryPreparation{
  try{
    const body=record(value,KEYS),p=plan(body.plan,now),scope=plan(expected,now);
    const kind=origin(scope);
    if(origin(p).maintenance!==kind.maintenance)return invalid();
    for(const key of kind.keys)if(p[key as keyof typeof p]!==scope[key as keyof typeof scope])return invalid();
    if(body.schema!==(kind.maintenance?'dharma.device-signing-maintenance-preparation/v1':'dharma.device-signing-recovery-preparation/v1')||body.purpose!=='prepare_expired_signing_trust_recovery'
      ||body.method!=='POST'||body.path!=='/api/v1/agent-fabric/signing-recovery/preparations')return invalid();
    bytes(body.nonce,32);bytes(body.credentialEncryptionPublicKey,32);
    // Reject unusable/low-order peers before any eventual publication. The
    // ephemeral probe is not a stored credential or an identity replacement.
    const probe=generateKeyPairSync('x25519');
    const shared=diffieHellman({privateKey:probe.privateKey,publicKey:createPublicKey({format:'jwk',
      key:{kty:'OKP',crv:'X25519',x:String(body.credentialEncryptionPublicKey)}})});
    shared.fill(0);
    const rootBytes=bytes(body.historicalRootPublicKey,32);
    if(hash(rootBytes)!==p.previousRootFingerprint||typeof body.historicalKeysetCanonical!=='string'
      ||Buffer.byteLength(body.historicalKeysetCanonical)>16384||hash(body.historicalKeysetCanonical)!==p.previousKeysetHash)return invalid();
    const parsedHistory:unknown=JSON.parse(body.historicalKeysetCanonical);
    if(!validateTrustedServerSigningKeysetContract(parsedHistory).ok||canonicalize(parsedHistory)!==body.historicalKeysetCanonical)return invalid();
    const history=parsedHistory as TrustedServerSigningKeyset,expiry=timestamp(history.expiresAt);
    if(history.organizationId!==p.organizationId||history.generation!==p.previousGeneration||expiry>now)return invalid();
    const root=createPublicKey({format:'jwk',key:{kty:'OKP',crv:'Ed25519',x:String(body.historicalRootPublicKey)}});
    if(!verifyInitialServerSigningKeyset(history,root,p.organizationId,new Date(expiry-1)).ok)return invalid();
    return Object.freeze({...body,plan:p}) as unknown as DeviceSigningRecoveryPreparation;
  }catch{return invalid();}
}
export function deviceSigningRecoveryPreparationSigningPayload(value:unknown):Buffer{
  try{
    const body=record(value,KEYS),kind=origin(body.plan),raw=record(body.plan,kind.keys);
    const at=timestamp(raw.preparedAt),checked=parseDeviceSigningRecoveryPreparation(body,raw as unknown as DeviceSigningRecoveryLocalPlan,at);
    return Buffer.from((kind.maintenance?'dharma.agent-fabric.device-signing-maintenance-preparation-proof/v1':DOMAIN)+'\0'+canonicalize(checked),'utf8');
  }catch{return invalid();}
}
export function verifyDeviceSigningRecoveryPreparationProof(value:unknown,signature:unknown,expected:DeviceSigningRecoveryLocalPlan,now:number):boolean{
  try{
    const body=parseDeviceSigningRecoveryPreparation(value,expected,now),proof=bytes(signature,64);
    return verify(null,deviceSigningRecoveryPreparationSigningPayload(body),createPublicKey({format:'jwk',
      key:{kty:'OKP',crv:'Ed25519',x:body.plan.publicKeyEd25519}}),proof);
  }catch{return false;}
}
