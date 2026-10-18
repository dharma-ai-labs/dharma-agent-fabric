import {createHash,createPrivateKey,createPublicKey,KeyObject,randomBytes,randomUUID,sign} from 'node:crypto';
import {types} from 'node:util';
import {canonicalize,deviceSigningRecoverySigningPayload,parseDeviceSigningRecoveryPreparation,
  parseDeviceSigningRecoveryOfferReadRequest,parseDeviceSigningRecoveryOfferRegistrationRequest,
  parseDeviceSigningRecoveryOfferResponse,parseDeviceSigningRecoveryOfferRegistrationReceipt,
  type DeviceSigningRecoveryLocalPlan,type DeviceSigningRecoveryOfferResponse} from '@dharma-ai-labs/agent-fabric-contracts';
import {createSystemSecureStore} from '@dharma-ai-labs/agent-fabric-secure-store';
import {loadDeviceConfig,loadDeviceIdentity} from './index.js';
import {HostOperationFence} from './hostOperationScope.js';
import {planDeviceSigningRecovery,type DeviceSigningRecoveryPlanInput} from './signingRecoveryPlan.js';

const READ='/api/v1/agent-fabric/signing-recovery/offers/read';
const REGISTER='/api/v1/agent-fabric/signing-recovery/offers/register';
const MAX_BYTES=65536;
export interface ProgressPreparedDeviceSigningRecoveryOfferInput extends DeviceSigningRecoveryPlanInput {
  /** The original owning-host preparation and ephemeral key, never tool arguments. */
  preparation:unknown;
  encryptionKey:KeyObject;
  fetcher?:typeof fetch;
}
export type SigningRecoveryOfferClientPhase='input'|'local_plan'|'identity'|'read'|'read_response'|'local_recheck'|'registration'|'receipt';
export class SigningRecoveryOfferClientError extends Error {
  readonly code='signing_recovery_offer_failed';
  constructor(readonly phase:SigningRecoveryOfferClientPhase,readonly httpStatus:number|null){
    super('signing_recovery_offer_failed');this.name='SigningRecoveryOfferClientError';
  }
}
const fail=():never=>{throw Error('signing_recovery_offer_failed');};
const hash=(value:string)=>'sha256:'+createHash('sha256').update(value).digest('hex');
function snapshot(value:unknown):Record<string,unknown>{
  if(!value||typeof value!=='object'||Array.isArray(value)||types.isProxy(value)
    ||![null,Object.prototype].includes(Object.getPrototypeOf(value))||Object.getOwnPropertySymbols(value).length)return fail();
  const fields=Object.getOwnPropertyDescriptors(value),out:Record<string,unknown>={};
  if(Object.keys(fields).length>64)return fail();
  for(const [key,field]of Object.entries(fields)){
    if(!field.enumerable||!Object.hasOwn(field,'value'))return fail();
    Object.defineProperty(out,key,{value:field.value,enumerable:true});
  }
  return out;
}
function checkedPreparation(input:ProgressPreparedDeviceSigningRecoveryOfferInput,fresh:DeviceSigningRecoveryLocalPlan,now:number){
  const body=snapshot(input.preparation),original=snapshot(body.plan);
  const expected={...fresh,planId:original.planId,preparedAt:original.preparedAt,expiresAt:original.expiresAt} as DeviceSigningRecoveryLocalPlan;
  const preparation=parseDeviceSigningRecoveryPreparation(body,expected,now);
  if(Date.parse(preparation.plan.expiresAt)>Date.parse(fresh.expiresAt))return fail();
  const key=input.encryptionKey;
  if(types.isProxy(key)||!(key instanceof KeyObject)||key.type!=='private'||key.asymmetricKeyType!=='x25519'
    ||createPublicKey(key).export({format:'jwk'}).x!==preparation.credentialEncryptionPublicKey)return fail();
  return preparation;
}
async function withAbort<T>(work:Promise<T>,signal:AbortSignal):Promise<T>{
  if(signal.aborted)return fail();
  let stop!:()=>void;
  const aborted=new Promise<never>((_,reject)=>{stop=()=>reject(Error('signing_recovery_offer_failed'));signal.addEventListener('abort',stop,{once:true});});
  try{return await Promise.race([work,aborted]);}finally{signal.removeEventListener('abort',stop);}
}
async function boundedJson(response:Response,signal:AbortSignal){
  const length=response.headers.get('content-length');
  if(!/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type')??'')||!response.body
    ||length!=null&&(!/^\d+$/.test(length)||Number(length)>MAX_BYTES))return fail();
  const reader=response.body.getReader(),chunks:Uint8Array[]=[];let size=0;
  try{
    while(true){const next=await withAbort(reader.read(),signal);if(next.done)break;
      size+=next.value.byteLength;if(size>MAX_BYTES)return fail();chunks.push(next.value);}
    if(signal.aborted)return fail();
    return snapshot(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks))));
  }finally{void reader.cancel().catch(()=>{});try{reader.releaseLock();}catch{/* A non-cooperative pending read retains its own lock. */}}
}
function publicSummary(response:DeviceSigningRecoveryOfferResponse){
  if(response.state==='awaiting_device_proof')return fail();
  return Object.freeze({schema:'dharma.device-signing-recovery-offer-progress/v1' as const,
    organizationId:response.organizationId,deviceId:response.deviceId,preparationId:response.preparationId,
    state:response.state,expiresAt:response.expiresAt,deviceProofRegistered:response.deviceProofRegistered,
    clientTrustInstalled:false as const,ready:false as const,
    ...('challenge'in response?{recoveryId:response.challenge.recoveryId,approvalId:response.challenge.approvalId}:{}),
    disposition:'awaiting_separate_browser_consent_not_onboarding_ready' as const});
}

/** At most one official read and one proof registration. This typed host API
 * never approves, publishes, installs trust, resumes a provider or retries. */
export async function progressPreparedDeviceSigningRecoveryOffer(input:ProgressPreparedDeviceSigningRecoveryOfferInput){
  return (await progressPreparedSigningRecoveryOfferForHost(input)).summary;
}

/** Same-package handoff only. The public entrypoint never returns the challenge. */
export async function progressPreparedSigningRecoveryOfferForHost(input:ProgressPreparedDeviceSigningRecoveryOfferInput,maximumExpiresAt?:string){
  const fence=new HostOperationFence(input.hostScope),clock=input.now??Date.now;
  let phase:SigningRecoveryOfferClientPhase='input',httpStatus:number|null=null;
  try{
    await fence.assert();phase='local_plan';
    const initial=await planDeviceSigningRecovery(input);
    const preparation=checkedPreparation(input,initial,clock()),plan=preparation.plan;
    const deadline=maximumExpiresAt===undefined?Date.parse(plan.expiresAt):Date.parse(maximumExpiresAt);
    if(!Number.isFinite(deadline)||deadline<=clock()||deadline>Date.parse(plan.expiresAt)
      ||maximumExpiresAt!==undefined&&new Date(deadline).toISOString()!==maximumExpiresAt)return fail();
    const raw=await fence.step(async()=>input.store??await createSystemSecureStore()),store=fence.store(raw);
    const config=await fence.step(()=>loadDeviceConfig(input.configPath));
    phase='identity';
    const identity=await loadDeviceIdentity({config,hostScope:input.hostScope,store:{...store,
      get:account=>(store.getFresh??store.get).call(store,account)}});
    let key:KeyObject;
    try{
      key=createPrivateKey({format:'jwk',key:identity.privateJwk});
      if(createPublicKey(key).export({format:'jwk'}).x!==plan.publicKeyEd25519)return fail();
    }finally{delete identity.privateJwk.d;}
    const selection={organizationId:plan.organizationId,deviceId:plan.deviceId,preparationId:plan.planId};
    const localRecheck=async()=>{
      phase='local_recheck';
      const fresh=await planDeviceSigningRecovery(input),current=checkedPreparation(input,fresh,clock());
      if(canonicalize(current)!==canonicalize(preparation)||clock()>=deadline)return fail();await fence.assert();
    };
    const frame=(registration:boolean,proof?:{recoveryId:string;approvalId:string;signature:string})=>{
      const at=clock(),until=Math.min(at+60000,Date.parse(plan.expiresAt),deadline);
      if(!Number.isFinite(at)||until<=at)return fail();
      const common={schema:registration?'dharma.device-signing-recovery-offer-registration-request/v1':'dharma.device-signing-recovery-offer-read-request/v1',
        purpose:registration?'register_prepared_recovery_proof':'read_prepared_recovery_offer',method:'POST',path:registration?REGISTER:READ,
        ...selection,requestId:randomUUID(),nonce:randomBytes(32).toString('base64url'),issuedAt:new Date(at).toISOString(),expiresAt:new Date(until).toISOString()};
      return registration?parseDeviceSigningRecoveryOfferRegistrationRequest({...common,...proof},selection,at)
        :parseDeviceSigningRecoveryOfferReadRequest(common,selection,at);
    };
    const send=async(payload:ReturnType<typeof frame>)=>{
      await fence.assert();const body=JSON.stringify(payload),url=plan.origin+payload.path;
      const remaining=Math.min(Date.parse(payload.expiresAt),Date.parse(plan.expiresAt),deadline)-clock();if(remaining<=0)return fail();
      const signal=AbortSignal.any([fence.signal,AbortSignal.timeout(Math.max(1,Math.min(30000,remaining)))]);
      const signed=Buffer.from(JSON.stringify({bodyHash:hash(body),deviceId:plan.deviceId,messageId:payload.requestId,method:'POST',
        nonce:payload.nonce,organizationId:plan.organizationId,pathname:payload.path,sequence:1,sessionId:plan.planId,timestamp:payload.issuedAt}));
      const request=(input.fetcher??fetch)(url,{method:'POST',redirect:'error',credentials:'omit',headers:{'content-type':'application/json',
        'cache-control':'no-store','x-dharma-device-id':plan.deviceId,'x-dharma-session-id':plan.planId,'x-dharma-message-id':payload.requestId,
        'x-dharma-timestamp':payload.issuedAt,'x-dharma-sequence':'1','x-dharma-nonce':payload.nonce,
        'x-dharma-signature':sign(null,signed,key).toString('base64url')},body,signal});
      void request.then(response=>{if(signal.aborted)void response.body?.cancel().catch(()=>{});},()=>{});
      const response=await withAbort(request,signal);httpStatus=response.status;
      try{
        if(response.status!==200||response.redirected||response.url&&response.url!==url)return fail();
        await fence.assert();return await boundedJson(response,signal);
      }finally{void response.body?.cancel().catch(()=>{});}
    };
    phase='read';const received=await send(frame(false));phase='read_response';
    const offer=parseDeviceSigningRecoveryOfferResponse(received,preparation,plan,clock());
    if(Date.parse(offer.expiresAt)>deadline)return fail();
    await localRecheck();
    if(offer.state!=='awaiting_device_proof')return {summary:publicSummary(offer),
      ...('challenge'in offer?{challenge:offer.challenge}:{})};
    const proof={recoveryId:offer.challenge.recoveryId,approvalId:offer.challenge.approvalId,
      signature:sign(null,deviceSigningRecoverySigningPayload(offer.challenge),key).toString('base64url')};
    phase='registration';const request=frame(true,proof);
    const response=await send(request);phase='receipt';
    const registered=parseDeviceSigningRecoveryOfferRegistrationReceipt(response,
      parseDeviceSigningRecoveryOfferRegistrationRequest(request,selection,clock()),offer.challenge.expiresAt,clock());
    await localRecheck();
    return {summary:publicSummary({...offer,state:registered.state,deviceProofRegistered:true,expiresAt:registered.expiresAt}),
      challenge:offer.challenge};
  }catch{
    await fence.assert();throw new SigningRecoveryOfferClientError(phase,httpStatus);
  }
}
