import {createHash,createPrivateKey,createPublicKey,KeyObject,sign} from 'node:crypto';
import {types} from 'node:util';
import {canonicalize,deviceSigningRecoverySigningPayload,openDeviceSigningRecoveryDelivery,parseDeviceSigningRecoveryChallenge,
  type DeviceSigningRecoveryCandidate,type DeviceSigningRecoveryChallenge,type DeviceSigningRecoveryContext} from '@dharma-ai-labs/agent-fabric-contracts';
import {createSystemSecureStore} from '@dharma-ai-labs/agent-fabric-secure-store';
import {loadDeviceConfig,loadDeviceIdentity,type DeviceConfig} from './index.js';
import {HostOperationFence} from './hostOperationScope.js';
import {planDeviceSigningRecovery,type DeviceSigningRecoveryPlanInput} from './signingRecoveryPlan.js';

const PATH='/api/v1/agent-fabric/signing-recovery',MAX_BYTES=65536;
export type SigningRecoveryClientPhase='input'|'local_plan'|'identity'|'request'|'response'|'decryption'|'local_recheck'|'commit'|'confirmation';
export class SigningRecoveryClientError extends Error {
  readonly code='signing_recovery_delivery_failed';
  constructor(readonly phase:SigningRecoveryClientPhase,readonly httpStatus:number|null){super('signing_recovery_delivery_failed');this.name='SigningRecoveryClientError';}
}
export interface RecoverExpiredDeviceSigningTrustInput extends DeviceSigningRecoveryPlanInput {
  /** Owning-host memory from the matching approval handshake, never JSON/tool arguments. */
  challenge:unknown;
  encryptionKey:KeyObject;
  fetcher?:typeof fetch;
}
export interface SigningRecoveryAcceptedDelivery {
  challenge:DeviceSigningRecoveryChallenge;
  expected:DeviceSigningRecoveryContext;
  candidate:DeviceSigningRecoveryCandidate;
}
const fail=():never=>{throw Error('signing_recovery_delivery_failed');};
const hash=(value:string|Buffer)=>'sha256:'+createHash('sha256').update(value).digest('hex');
function record(value:unknown):Record<string,unknown>{
  if(!value||typeof value!=='object'||Array.isArray(value)||types.isProxy(value)
    ||![Object.prototype,null].includes(Object.getPrototypeOf(value))||Object.getOwnPropertySymbols(value).length)return fail();
  const fields=Object.getOwnPropertyDescriptors(value),result:Record<string,unknown>={};
  if(Object.keys(fields).length>64)return fail();
  for(const [name,field]of Object.entries(fields)){
    if(!field.enumerable||!Object.hasOwn(field,'value'))return fail();
    Object.defineProperty(result,name,{value:field.value,enumerable:true});
  }
  return result;
}
/** The challenge never supplies local identity/source/session expectations. */
export function checkedRecoveryHostContext(input:RecoverExpiredDeviceSigningTrustInput,
  plan:Awaited<ReturnType<typeof planDeviceSigningRecovery>>,now:number){
  const key=input.encryptionKey;
  if(types.isProxy(key)||!(key instanceof KeyObject)||key.type!=='private'||key.asymmetricKeyType!=='x25519')return fail();
  const publicKey=createPublicKey(key).export({format:'jwk'}).x;
  const value=record(input.challenge);
  const {schema:_schema,purpose:_purpose,method:_method,path:_path,nonce:_nonce,issuedAt:_issued,expiresAt:_expires,authenticator:_mac,...context}=value;
  void [_schema,_purpose,_method,_path,_nonce,_issued,_expires,_mac];
  const {schema:_planSchema,planId:_planId,authority:_authority,preparedAt:_preparedAt,expiresAt:planExpiry,...local}=plan;
  void [_planSchema,_planId,_authority,_preparedAt];
  const expected={...context,...local,credentialEncryptionPublicKey:publicKey} as unknown as DeviceSigningRecoveryContext;
  const challenge=parseDeviceSigningRecoveryChallenge(value,expected,now);
  if(Date.parse(challenge.expiresAt)>Date.parse(planExpiry)||challenge.candidateGeneration!==challenge.previousGeneration+1
    ||challenge.candidateRootFingerprint===challenge.previousRootFingerprint)return fail();
  return {challenge,expected};
}
async function responseBody(response:Response,signal:AbortSignal){
  if(!response.headers.get('content-type')?.toLowerCase().startsWith('application/json')
    ||Number(response.headers.get('content-length'))>MAX_BYTES||!response.body)return fail();
  const reader=response.body.getReader(),chunks:Uint8Array[]=[];let bytes=0;
  const cancel=()=>{void reader.cancel().catch(()=>{});};signal.addEventListener('abort',cancel,{once:true});
  try{
    if(signal.aborted)return fail();
    while(true){const next=await reader.read();if(next.done)break;bytes+=next.value.byteLength;if(bytes>MAX_BYTES)return fail();chunks.push(next.value);}
    if(signal.aborted)return fail();
    const value=record(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks))));
    if(Object.keys(value).sort().join('\0')!==['ok','delivery','clientTrustInstalled','nativeSessionBinding'].sort().join('\0')
      ||value.ok!==true||value.clientTrustInstalled!==false||value.nativeSessionBinding!=='device_attested_not_independently_observed')return fail();
    return value.delivery;
  }finally{signal.removeEventListener('abort',cancel);cancel();reader.releaseLock();}
}

/** Internal orchestration used only by the typed owning-host library API. The
 * commit callback is constructed inside the relay, never accepted from a tool.
 * No retry, new identity, bearer credential or old-root self-approval exists. */
export async function retrieveSigningRecoveryDelivery(input:RecoverExpiredDeviceSigningTrustInput,
  apply:(delivery:SigningRecoveryAcceptedDelivery)=>Promise<DeviceConfig>){
  let phase:SigningRecoveryClientPhase='input',httpStatus:number|null=null;
  let response:Response|undefined;
  const fence=new HostOperationFence(input.hostScope),clock=input.now??Date.now;
  try{
    await fence.assert();
    phase='local_plan';const initial=await planDeviceSigningRecovery(input);
    const {challenge,expected}=checkedRecoveryHostContext(input,initial,clock());
    const raw=await fence.step(async()=>input.store??await createSystemSecureStore()),store=fence.store(raw);
    const config=await fence.step(()=>loadDeviceConfig(input.configPath));
    phase='identity';
    // One official existing-key read, forced fresh even on cached adapters.
    const identity=await loadDeviceIdentity({config,hostScope:input.hostScope,store:{...store,
      get:account=>(store.getFresh??store.get).call(store,account)}});
    let signature:string,deviceKey:KeyObject;
    try{
      deviceKey=createPrivateKey({format:'jwk',key:identity.privateJwk});
      if(createPublicKey(deviceKey).export({format:'jwk'}).x!==challenge.publicKeyEd25519)return fail();
      signature=sign(null,deviceSigningRecoverySigningPayload(challenge),deviceKey).toString('base64url');
    }finally{delete identity.privateJwk.d;}
    const url=initial.origin+PATH,remaining=Date.parse(challenge.expiresAt)-clock();if(remaining<=0)return fail();
    const signal=AbortSignal.any([fence.signal,AbortSignal.timeout(Math.max(1,Math.min(30000,remaining)))]);
    const body=JSON.stringify({schema:'dharma.device-signing-recovery-delivery-request/v1',action:'delivery',
      organizationId:challenge.organizationId,recoveryId:challenge.recoveryId,approvalId:challenge.approvalId,signature});
    const timestamp=new Date(clock()).toISOString();
    // Recovery transport IDs are not a connected relay or Codex session.
    // The persisted challenge fixes the body/message/nonce identity.
    const transport=Buffer.from(JSON.stringify({bodyHash:hash(body),deviceId:challenge.deviceId,messageId:challenge.approvalId,method:'POST',
      nonce:challenge.nonce,organizationId:challenge.organizationId,pathname:PATH,sequence:1,sessionId:challenge.recoveryId,timestamp}));
    const transportSignature=sign(null,transport,deviceKey).toString('base64url');
    phase='request';await fence.assert();
    response=await (input.fetcher??fetch)(url,{method:'POST',redirect:'error',credentials:'omit',
      headers:{'content-type':'application/json','cache-control':'no-store','x-dharma-device-id':challenge.deviceId,
        'x-dharma-session-id':challenge.recoveryId,'x-dharma-message-id':challenge.approvalId,'x-dharma-timestamp':timestamp,
        'x-dharma-sequence':'1','x-dharma-nonce':challenge.nonce,'x-dharma-signature':transportSignature},signal,body});
    httpStatus=response.status;await fence.assert();
    if(response.status!==200||response.redirected||(response.url&&response.url!==url)){
      void response.body?.cancel().catch(()=>{});return fail();
    }
    phase='response';const envelope=await responseBody(response,signal);await fence.assert();
    phase='decryption';const candidate=openDeviceSigningRecoveryDelivery(challenge,envelope,input.encryptionKey,expected,clock());
    phase='local_recheck';const fresh=await planDeviceSigningRecovery(input);
    const current=checkedRecoveryHostContext({...input,challenge},fresh,clock());
    if(canonicalize(current.expected)!==canonicalize(expected))return fail();
    phase='commit';const installed=await fence.step(()=>apply({challenge,expected,candidate}));
    phase='confirmation';
    if(installed.organizationId!==challenge.organizationId||installed.deviceId!==challenge.deviceId||installed.installationId!==challenge.installationId
      ||installed.serverPublicKeyEd25519!==candidate.rootPublicKey||canonicalize(installed.serverSigningKeyset)!==candidate.keysetCanonical)return fail();
    const finished=clock();if(!Number.isFinite(finished)||finished<Date.parse(challenge.issuedAt)
      ||finished>=Date.parse(installed.serverSigningKeyset!.expiresAt))return fail();
    await fence.assert();
    return Object.freeze({schema:'dharma.device-signing-recovery-completion/v1' as const,organizationId:installed.organizationId,
      deviceId:installed.deviceId,installationId:installed.installationId,workspaceId:challenge.workspaceId,
      recoveryId:challenge.recoveryId,approvalId:challenge.approvalId,generation:installed.serverSigningKeyset!.generation,
      keysetHash:hash(candidate.keysetCanonical),rootFingerprint:hash(Buffer.from(candidate.rootPublicKey,'base64url')),
      publicationArtifactHash:candidate.publication.artifactHash,observedAt:new Date(finished).toISOString(),
      connectionMode:installed.connectionMode??'manual',ready:false as const,disposition:'signing_trust_installed_not_onboarding_ready' as const});
  }catch{
    await fence.assert();throw new SigningRecoveryClientError(phase,httpStatus);
  }finally{void response?.body?.cancel().catch(()=>{});}
}
