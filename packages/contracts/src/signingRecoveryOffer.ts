import {types} from 'node:util';
import {parseDeviceSigningRecoveryChallenge,type DeviceSigningRecoveryChallenge,type DeviceSigningRecoveryContext} from './signingRecovery.js';
import {parseDeviceSigningRecoveryPreparation,type DeviceSigningRecoveryLocalPlan} from './signingRecoveryPreparation.js';

export interface DeviceSigningRecoveryOfferSelection {organizationId:string;deviceId:string;preparationId:string;}
interface RequestBinding extends DeviceSigningRecoveryOfferSelection {requestId:string;nonce:string;issuedAt:string;expiresAt:string;method:'POST';}
export interface DeviceSigningRecoveryOfferReadRequest extends RequestBinding {
  schema:'dharma.device-signing-recovery-offer-read-request/v1';purpose:'read_prepared_recovery_offer';
  path:'/api/v1/agent-fabric/signing-recovery/offers/read';
}
export interface DeviceSigningRecoveryOfferRegistrationRequest extends RequestBinding {
  schema:'dharma.device-signing-recovery-offer-registration-request/v1';purpose:'register_prepared_recovery_proof';
  path:'/api/v1/agent-fabric/signing-recovery/offers/register';recoveryId:string;approvalId:string;signature:string;
}
interface ResponseBinding extends DeviceSigningRecoveryOfferSelection {
  schema:'dharma.device-signing-recovery-offer-response/v1';expiresAt:string;clientTrustInstalled:false;ready:false;
}
export type DeviceSigningRecoveryOfferResponse=ResponseBinding&(
  {state:'awaiting_browser_offer';deviceProofRegistered:false}
  |{state:'awaiting_device_proof';deviceProofRegistered:false;challenge:DeviceSigningRecoveryChallenge}
  |{state:'pending_approval';deviceProofRegistered:true;challenge:DeviceSigningRecoveryChallenge});
export interface DeviceSigningRecoveryOfferRegistrationReceipt extends DeviceSigningRecoveryOfferSelection {
  schema:'dharma.device-signing-recovery-offer-registration-receipt/v1';recoveryId:string;approvalId:string;
  state:'pending_approval';expiresAt:string;deviceProofRegistered:true;clientTrustInstalled:false;ready:false;
}
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$(?![\s\S])/;
const SELECTION=['organizationId','deviceId','preparationId'];
const READ_KEYS=['schema','purpose','method','path',...SELECTION,'requestId','nonce','issuedAt','expiresAt'];
const REGISTER_KEYS=[...READ_KEYS,'recoveryId','approvalId','signature'];
const RESPONSE_KEYS=['schema',...SELECTION,'expiresAt','state','deviceProofRegistered','clientTrustInstalled','ready'];
const RECEIPT_KEYS=['schema',...SELECTION,'recoveryId','approvalId','state','expiresAt','deviceProofRegistered','clientTrustInstalled','ready'];
const invalid=():never=>{throw Error('device_signing_recovery_offer_invalid');};
function record(value:unknown,keys?:string[]):Record<string,unknown>{
  if(!value||typeof value!=='object'||Array.isArray(value)||types.isProxy(value)
    ||![null,Object.prototype].includes(Object.getPrototypeOf(value))||Object.getOwnPropertySymbols(value).length)return invalid();
  const fields=Object.getOwnPropertyDescriptors(value),names=Object.keys(fields);
  if(names.length>64||keys&&names.sort().join('\0')!==[...keys].sort().join('\0'))return invalid();
  const result:Record<string,unknown>={};
  for(const name of names){const f=fields[name];if(!f?.enumerable||!Object.hasOwn(f,'value'))return invalid();
    Object.defineProperty(result,name,{value:f.value,enumerable:true});}
  return result;
}
function bytes(value:unknown,size:number){
  if(typeof value!=='string'||value.length!==Math.ceil(size*4/3)||!/^[A-Za-z0-9_-]+$(?![\s\S])/.test(value))return invalid();
  const decoded=Buffer.from(value,'base64url');if(decoded.length!==size||decoded.toString('base64url')!==value)return invalid();
}
function timestamp(value:unknown){
  if(typeof value!=='string'||value.length>40)return invalid();const at=Date.parse(value);
  if(!Number.isFinite(at)||new Date(at).toISOString()!==value)return invalid();return at;
}
function selection(body:Record<string,unknown>,expected:DeviceSigningRecoveryOfferSelection){
  const scope=record(expected,SELECTION);
  if(typeof body.organizationId!=='string'||body.organizationId.length>128||!/^org_[A-Za-z0-9]+$(?![\s\S])/.test(body.organizationId))return invalid();
  for(const key of ['deviceId','preparationId'])if(typeof body[key]!=='string'||!UUID.test(body[key]))return invalid();
  for(const key of SELECTION)if(body[key]!==scope[key])return invalid();
}
function request(value:unknown,expected:DeviceSigningRecoveryOfferSelection,now:number,registration:boolean){
  const body=record(value,registration?REGISTER_KEYS:READ_KEYS);
  for(const v of Object.values(body))if(typeof v!=='string'||v.length>256||/[\x00-\x1f\x7f]/.test(v))return invalid();
  selection(body,expected);
  if(body.schema!==(registration?'dharma.device-signing-recovery-offer-registration-request/v1':'dharma.device-signing-recovery-offer-read-request/v1')
    ||body.purpose!==(registration?'register_prepared_recovery_proof':'read_prepared_recovery_offer')||body.method!=='POST'
    ||body.path!==(registration?'/api/v1/agent-fabric/signing-recovery/offers/register':'/api/v1/agent-fabric/signing-recovery/offers/read')
    ||!UUID.test(String(body.requestId)))return invalid();
  bytes(body.nonce,32);const issued=timestamp(body.issuedAt),expires=timestamp(body.expiresAt);
  if(!Number.isFinite(now)||issued>now||expires<=now||expires<=issued||expires-issued>60000)return invalid();
  if(registration){for(const key of ['recoveryId','approvalId'])if(!UUID.test(String(body[key])))return invalid();bytes(body.signature,64);}
  return Object.freeze(body);
}

/** These fixed request frames authenticate no one by themselves. The server
 * must verify its device-bound transport and current immutable preparation. */
export function parseDeviceSigningRecoveryOfferReadRequest(value:unknown,expected:DeviceSigningRecoveryOfferSelection,now:number):DeviceSigningRecoveryOfferReadRequest{
  try{return request(value,expected,now,false) as unknown as DeviceSigningRecoveryOfferReadRequest;}catch{return invalid();}
}
export function parseDeviceSigningRecoveryOfferRegistrationRequest(value:unknown,expected:DeviceSigningRecoveryOfferSelection,now:number):DeviceSigningRecoveryOfferRegistrationRequest{
  try{return request(value,expected,now,true) as unknown as DeviceSigningRecoveryOfferRegistrationRequest;}catch{return invalid();}
}

/** Public pending challenge only. Local expectations come from the owning
 * host, never from the response. Neither this parser nor a self-signed new
 * candidate supplies recipient/owner consent or permission to install trust. */
export function parseDeviceSigningRecoveryOfferResponse(value:unknown,preparation:unknown,expectedPlan:DeviceSigningRecoveryLocalPlan,now:number):DeviceSigningRecoveryOfferResponse{
  try{
    const prepared=parseDeviceSigningRecoveryPreparation(preparation,expectedPlan,now),plan=prepared.plan;
    const outer=record(value),waiting=outer.state==='awaiting_browser_offer';
    const body=record(outer,waiting?RESPONSE_KEYS:[...RESPONSE_KEYS,'challenge']);
    selection(body,{organizationId:plan.organizationId,deviceId:plan.deviceId,preparationId:plan.planId});
    if(body.schema!=='dharma.device-signing-recovery-offer-response/v1'||body.clientTrustInstalled!==false||body.ready!==false
      ||!['awaiting_browser_offer','awaiting_device_proof','pending_approval'].includes(String(body.state))
      ||body.deviceProofRegistered!==(body.state==='pending_approval')||timestamp(body.expiresAt)<=now
      ||timestamp(body.expiresAt)>timestamp(plan.expiresAt))return invalid();
    if(waiting)return Object.freeze(body) as unknown as DeviceSigningRecoveryOfferResponse;
    const c=record(body.challenge);
    for(const v of Object.values(c))if(typeof v==='string'&&/[\x00-\x1f\x7f]/.test(v))return invalid();
    const {schema,planId,authority,preparedAt,expiresAt,...local}=plan;void[schema,planId,authority,preparedAt,expiresAt];
    const expected={...c,...local,credentialEncryptionPublicKey:prepared.credentialEncryptionPublicKey} as unknown as DeviceSigningRecoveryContext;
    const challenge=parseDeviceSigningRecoveryChallenge(c,expected,now);
    if(timestamp(challenge.issuedAt)<timestamp(plan.preparedAt)||timestamp(challenge.expiresAt)>timestamp(body.expiresAt)
      ||challenge.candidateGeneration!==plan.previousGeneration+1||challenge.candidateRootFingerprint===plan.previousRootFingerprint)return invalid();
    return Object.freeze({...body,challenge:Object.freeze(challenge)}) as unknown as DeviceSigningRecoveryOfferResponse;
  }catch{return invalid();}
}
export function parseDeviceSigningRecoveryOfferRegistrationReceipt(value:unknown,request:DeviceSigningRecoveryOfferRegistrationRequest,expectedExpiresAt:string,now:number):DeviceSigningRecoveryOfferRegistrationReceipt{
  try{
    const snapshot=record(request,REGISTER_KEYS);
    const scope={organizationId:snapshot.organizationId,deviceId:snapshot.deviceId,preparationId:snapshot.preparationId} as DeviceSigningRecoveryOfferSelection;
    const sent=parseDeviceSigningRecoveryOfferRegistrationRequest(snapshot,scope,now),body=record(value,RECEIPT_KEYS);
    selection(body,scope);
    if(body.schema!=='dharma.device-signing-recovery-offer-registration-receipt/v1'||body.state!=='pending_approval'
      ||body.recoveryId!==sent.recoveryId||body.approvalId!==sent.approvalId||body.deviceProofRegistered!==true
      ||body.clientTrustInstalled!==false||body.ready!==false||body.expiresAt!==expectedExpiresAt||timestamp(body.expiresAt)<=now)return invalid();
    return Object.freeze(body) as unknown as DeviceSigningRecoveryOfferRegistrationReceipt;
  }catch{return invalid();}
}
