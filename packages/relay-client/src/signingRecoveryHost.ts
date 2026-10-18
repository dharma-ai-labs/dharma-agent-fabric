import {createHash,createPrivateKey,createPublicKey,generateKeyPairSync,randomBytes,sign,type KeyObject} from 'node:crypto';
import {types} from 'node:util';
import {canonicalize,deviceSigningRecoveryPreparationSigningPayload,parseDeviceSigningRecoveryPreparation,
  type DeviceSigningRecoveryPreparation,type DeviceSigningRecoveryChallenge} from '@dharma-ai-labs/agent-fabric-contracts';
import {createSystemSecureStore} from '@dharma-ai-labs/agent-fabric-secure-store';
import {loadDeviceConfig,loadDeviceIdentity,recoverExpiredDeviceSigningTrust} from './index.js';
import {SigningRecoveryClientError} from './signingRecoveryClient.js';
import {HostOperationFence} from './hostOperationScope.js';
import {planDeviceSigningRecovery,type DeviceSigningRecoveryPlanInput} from './signingRecoveryPlan.js';
import {progressPreparedSigningRecoveryOfferForHost,SigningRecoveryOfferClientError} from './signingRecoveryOfferClient.js';

export interface PrepareOwnedSigningRecoveryInput extends DeviceSigningRecoveryPlanInput {fetcher?:typeof fetch;}
export interface OwnedSigningRecoveryHandle {readonly schema:'dharma.owned-signing-recovery-handle/v1';readonly preparationId:string;}
export type OwnedSigningRecoveryState='prepared'|'awaiting_browser_offer'|'pending_approval'|'submission_unconfirmed'
  |'offer_unconfirmed'|'delivery_unconfirmed'|'failed'|'trust_installed';
export class OwnedSigningRecoveryError extends Error {
  readonly code='owned_signing_recovery_failed';
  constructor(readonly phase:string,readonly httpStatus:number|null=null){super('owned_signing_recovery_failed');this.name='OwnedSigningRecoveryError';}
}
interface State {
  input:PrepareOwnedSigningRecoveryInput;
  fence:HostOperationFence;
  abort:AbortController;
  preparation:DeviceSigningRecoveryPreparation;
  encryptionKey:KeyObject;
  challenge?:DeviceSigningRecoveryChallenge;
  state:OwnedSigningRecoveryState;
  busy:boolean;
  submitted:boolean;
  deliveryAttempted:boolean;
  expiresAt:string;
}
const states=new WeakMap<OwnedSigningRecoveryHandle,State>();
const PATH='/api/v1/agent-fabric/signing-recovery/preparations';
const hash=(value:string)=>'sha256:'+createHash('sha256').update(value).digest('hex');
const fail=(phase:string):never=>{throw new OwnedSigningRecoveryError(phase);};
function owned(handle:OwnedSigningRecoveryHandle):State {
  if(!handle||typeof handle!=='object'||types.isProxy(handle))return fail('handle');
  const state=states.get(handle);if(!state)return fail('handle');return state;
}
function summary(state:State){
  const plan=state.preparation.plan;
  return Object.freeze({schema:'dharma.device-signing-recovery-host-progress/v1' as const,
    organizationId:plan.organizationId,deviceId:plan.deviceId,preparationId:plan.planId,
    state:state.state,expiresAt:state.expiresAt,
    ...(state.challenge?{recoveryId:state.challenge.recoveryId,approvalId:state.challenge.approvalId}:{}),
    clientTrustInstalled:state.state==='trust_installed',ready:false as const,
    disposition:'owned_host_progress_not_onboarding_ready' as const});
}
async function recheck(state:State){
  await state.fence.assert();if(state.input.now!()>=Date.parse(state.expiresAt))return fail('expired');
  const fresh=await planDeviceSigningRecovery(state.input),plan=state.preparation.plan;
  const original={...fresh,planId:plan.planId,preparedAt:plan.preparedAt,expiresAt:plan.expiresAt};
  if(Date.parse(plan.expiresAt)>Date.parse(fresh.expiresAt)
    ||canonicalize(original)!==canonicalize(plan))return fail('local_recheck');
  const now=state.input.now!();parseDeviceSigningRecoveryPreparation(state.preparation,original,now);
  if(now>=Date.parse(state.expiresAt))return fail('expired');await state.fence.assert();
}
async function withAbort<T>(work:Promise<T>,signal:AbortSignal):Promise<T>{
  if(signal.aborted)return fail('cancelled');let stop!:()=>void;
  const aborted=new Promise<never>((_,reject)=>{stop=()=>reject(new OwnedSigningRecoveryError('cancelled'));signal.addEventListener('abort',stop,{once:true});});
  try{return await Promise.race([work,aborted]);}finally{signal.removeEventListener('abort',stop);}
}
async function receipt(response:Response,signal:AbortSignal){
  const length=response.headers.get('content-length');
  if(!/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type')??'')||!response.body
    ||length!==null&&(!/^\d+$/.test(length)||Number(length)>8192))return fail('receipt');
  const reader=response.body.getReader(),chunks:Uint8Array[]=[];let size=0;
  try{
    while(true){const next=await withAbort(reader.read(),signal);if(next.done)break;
      size+=next.value.byteLength;if(size>8192)return fail('receipt');chunks.push(next.value);}
    if(signal.aborted)return fail('cancelled');
    const value:unknown=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks)));
    if(!value||typeof value!=='object'||Array.isArray(value))return fail('receipt');
    return value as Record<string,unknown>;
  }finally{void reader.cancel().catch(()=>{});try{reader.releaseLock();}catch{/* Cancellation need not settle a non-cooperative stream. */}}
}

/** Trusted owning-host input only, never a tool/CLI authority object. Planning
 * reads public config and its protected anchor, not the private device key. */
export async function prepareOwnedSigningRecovery(input:PrepareOwnedSigningRecoveryInput):Promise<OwnedSigningRecoveryHandle>{
  try{
    const original=new HostOperationFence(input.hostScope),abort=new AbortController();
    const scope={signal:AbortSignal.any([original.signal,abort.signal]),current:async()=>{await original.assert();return true;}};
    const captured={...input,now:input.now??Date.now,hostScope:scope};
    const fence=new HostOperationFence(scope),plan=await planDeviceSigningRecovery(captured);
    const config=await fence.step(()=>loadDeviceConfig(captured.configPath));
    if(hash(canonicalize(config))!==plan.protectedConfigDigest)return fail('local_plan');
    const key=generateKeyPairSync('x25519');
    const preparation=parseDeviceSigningRecoveryPreparation({schema:'dharma.device-signing-recovery-preparation/v1',
      purpose:'prepare_expired_signing_trust_recovery',method:'POST',path:PATH,plan,
      historicalKeysetCanonical:canonicalize(config.serverSigningKeyset),historicalRootPublicKey:config.serverPublicKeyEd25519,
      credentialEncryptionPublicKey:key.publicKey.export({format:'jwk'}).x,nonce:randomBytes(32).toString('base64url')},plan,captured.now());
    const handle=Object.freeze({schema:'dharma.owned-signing-recovery-handle/v1' as const,preparationId:plan.planId});
    const state:State={input:captured,fence,abort,preparation,encryptionKey:key.privateKey,state:'prepared',busy:false,submitted:false,
      deliveryAttempted:false,expiresAt:plan.expiresAt};
    await recheck(state);states.set(handle,state);return handle;
  }catch{return fail('prepare');}
}

/** One submission only. A lost response may have committed server state; it
 * never permits another request, key read or replacement preparation here. */
export async function submitOwnedSigningRecoveryPreparation(handle:OwnedSigningRecoveryHandle){
  const state=owned(handle);if(state.busy||state.submitted||state.state!=='prepared')return fail('phase');
  state.busy=true;let phase='local_recheck',httpStatus:number|null=null,sent=false;
  try{
    await recheck(state);state.submitted=true;phase='identity';
    const raw=await state.fence.step(async()=>state.input.store??await createSystemSecureStore()),store=state.fence.store(raw);
    const config=await state.fence.step(()=>loadDeviceConfig(state.input.configPath));
    const identity=await loadDeviceIdentity({config,hostScope:state.input.hostScope,store:{...store,
      get:account=>(store.getFresh??store.get).call(store,account)}});
    let key:KeyObject;
    try{
      key=createPrivateKey({format:'jwk',key:identity.privateJwk});
      if(createPublicKey(key).export({format:'jwk'}).x!==state.preparation.plan.publicKeyEd25519)return fail('identity');
    }finally{delete identity.privateJwk.d;}
    await recheck(state);
    const preparation=state.preparation,plan=preparation.plan,clock=state.input.now!;
    const body=JSON.stringify({schema:'dharma.device-signing-recovery-preparation-request/v1',preparation,
      signature:sign(null,deviceSigningRecoveryPreparationSigningPayload(preparation),key).toString('base64url')});
    if(Buffer.byteLength(body)>32768)return fail('request');
    const at=clock(),remaining=Date.parse(plan.expiresAt)-at;if(!Number.isFinite(at)||remaining<=0)return fail('request');
    const signal=AbortSignal.any([state.fence.signal,AbortSignal.timeout(Math.max(1,Math.min(30000,remaining)))]),timestamp=new Date(at).toISOString();
    const transport=Buffer.from(JSON.stringify({bodyHash:hash(body),deviceId:plan.deviceId,messageId:plan.planId,method:'POST',
      nonce:preparation.nonce,organizationId:plan.organizationId,pathname:PATH,sequence:1,sessionId:plan.planId,timestamp}));
    phase='request';await state.fence.assert();sent=true;
    const url=plan.origin+PATH,request=(state.input.fetcher??fetch)(url,{method:'POST',redirect:'error',credentials:'omit',
      headers:{'content-type':'application/json','cache-control':'no-store','x-dharma-device-id':plan.deviceId,
        'x-dharma-session-id':plan.planId,'x-dharma-message-id':plan.planId,'x-dharma-timestamp':timestamp,
        'x-dharma-sequence':'1','x-dharma-nonce':preparation.nonce,'x-dharma-signature':sign(null,transport,key).toString('base64url')},body,signal});
    void request.then(response=>{if(signal.aborted)void response.body?.cancel().catch(()=>{});},()=>{});
    const response=await withAbort(request,signal);httpStatus=response.status;
    try{
      if(response.status!==200||response.redirected||response.url&&response.url!==url)return fail('response');
      phase='receipt';const value=await receipt(response,signal);
      const narrowed=typeof value.expiresAt==='string'?Date.parse(value.expiresAt):NaN;
      if(!Number.isFinite(narrowed)||new Date(narrowed).toISOString()!==value.expiresAt||narrowed<=clock()
        ||narrowed>Date.parse(plan.expiresAt))return fail('receipt');
      const expected={schema:'dharma.signing-recovery-preparation-receipt/v1',preparationId:plan.planId,organizationId:plan.organizationId,
        recipientMembershipId:plan.recipientMembershipId,deviceId:plan.deviceId,expiresAt:value.expiresAt,state:'pending_browser_review',
        clientTrustInstalled:false,nativeSessionBinding:'device_attested_not_verified'};
      if(canonicalize(value)!==canonicalize(expected))return fail('receipt');
      state.expiresAt=String(value.expiresAt);await recheck(state);state.state='awaiting_browser_offer';return summary(state);
    }finally{void response.body?.cancel().catch(()=>{});}
  }catch{state.state=sent?'submission_unconfirmed':'failed';throw new OwnedSigningRecoveryError(phase,httpStatus);}
  finally{state.busy=false;}
}

/** Explicit offer/proof step, not browser consent, publication or delivery. */
export async function progressOwnedSigningRecoveryOffer(handle:OwnedSigningRecoveryHandle){
  const state=owned(handle);if(state.busy||state.state!=='awaiting_browser_offer')return fail('phase');state.busy=true;
  try{
    await recheck(state);
    const result=await progressPreparedSigningRecoveryOfferForHost({...state.input,preparation:state.preparation,encryptionKey:state.encryptionKey},state.expiresAt);
    state.expiresAt=result.summary.expiresAt;await recheck(state);state.state=result.summary.state;state.challenge=result.challenge;return summary(state);
  }catch(error){state.state='offer_unconfirmed';throw new OwnedSigningRecoveryError(
    error instanceof SigningRecoveryOfferClientError?'offer_'+error.phase:'offer',error instanceof SigningRecoveryOfferClientError?error.httpStatus:null);
  }finally{state.busy=false;}
}

/** Explicit once-only delivery through the existing protected journal. No
 * browser consent or publication is synthesized, and installed trust is not readiness. */
export async function completeOwnedSigningRecovery(handle:OwnedSigningRecoveryHandle){
  const state=owned(handle);if(state.busy||state.deliveryAttempted||state.state!=='pending_approval'||!state.challenge)return fail('phase');state.busy=true;
  try{
    await recheck(state);state.deliveryAttempted=true;
    await recoverExpiredDeviceSigningTrust({...state.input,challenge:state.challenge,encryptionKey:state.encryptionKey});
    state.state='trust_installed';return summary(state);
  }catch(error){state.state=state.deliveryAttempted?'delivery_unconfirmed':'failed';throw new OwnedSigningRecoveryError(
    error instanceof SigningRecoveryClientError?'delivery_'+error.phase:'delivery',error instanceof SigningRecoveryClientError?error.httpStatus:null);
  }finally{state.busy=false;}
}

/** Snapshot only; it neither reauthorizes a phase nor claims current readiness. */
export async function inspectOwnedSigningRecovery(handle:OwnedSigningRecoveryHandle){return summary(owned(handle));}

/** Drops retained references and withdraws owned operations, not guaranteed
 * memory erasure, child-process termination or rollback of an admitted write. */
export function disposeOwnedSigningRecovery(handle:OwnedSigningRecoveryHandle):void{
  const state=owned(handle);state.abort.abort();states.delete(handle);
}
