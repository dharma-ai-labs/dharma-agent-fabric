import {createHash,randomUUID} from 'node:crypto';
import {isAbsolute,resolve} from 'node:path';
import {canonicalize} from '@dharma-ai-labs/agent-fabric-contracts';
import type {LocalVault,ScopedLocalVault} from '@dharma-ai-labs/agent-fabric-local-vault';
import {loadDeviceConfig,loadDeviceEnrollmentAnchor,withDeviceSigningControl,readOwnedSigningMaintenanceContext,prepareOwnedSigningMaintenance,
  submitOwnedSigningRecoveryPreparation,progressOwnedSigningRecoveryOffer,completeOwnedSigningRecovery,
  inspectOwnedSigningRecovery,disposeOwnedSigningRecovery,OwnedSigningRecoveryError,
  type OwnedSigningRecoveryHandle,type SecureSecretStore,type DeviceConfig} from '@dharma-ai-labs/agent-fabric-relay-client';
import {readNamedSession} from './namedSessionService.js';
import type {LegacySigningMaintenanceBoundary} from './legacySigningMaintenanceBoundary.js';

interface Workspace {organizationId:string;workspaceId:string;repositoryBindingId:string;repositoryRemoteHash:string;path:string;}
interface Input {
  home:string;configPath:string;name:string;workspaceId:string;operationId?:string;apply:boolean;
  readWorkspace():Promise<Workspace|null>;
  processState():Promise<'running'|'stopped'|'unknown'>;
  openVault():Promise<LocalVault|ScopedLocalVault>;
  signal:AbortSignal;frames:AsyncIterable<Uint8Array>;emit(value:Record<string,unknown>):void;
  store?:SecureSecretStore;fetcher?:typeof fetch;now?:()=>number;
  legacyBoundary?:LegacySigningMaintenanceBoundary;
}
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$(?![\s\S])/;
const hash=(v:unknown)=>'sha256:'+createHash('sha256').update(canonicalize(v)).digest('hex');
const unavailable=(phase:string):never=>{throw Error('device_signing_maintenance_'+phase);};
const immutableDevice=(config:DeviceConfig)=>({hqUrl:config.hqUrl,organizationId:config.organizationId,deviceId:config.deviceId,
  installationId:config.installationId,publicKeyEd25519:config.publicKeyEd25519,setupClaimReference:config.setupClaimReference,
  setupClaimRepositoryFingerprint:config.setupClaimRepositoryFingerprint,relayUrl:config.relayUrl,enrolledAt:config.enrolledAt,
  connectionMode:config.connectionMode??'manual'});

async function next<T>(iterator:AsyncIterator<T>,signal:AbortSignal){
  if(signal.aborted)return unavailable('cancelled');let stop!:()=>void;
  const aborted=new Promise<never>((_,reject)=>{stop=()=>reject(Error('device_signing_maintenance_cancelled'));
    signal.addEventListener('abort',stop,{once:true});});
  try{return await Promise.race([iterator.next(),aborted]);}finally{signal.removeEventListener('abort',stop);}
}
async function* frames(input:AsyncIterable<Uint8Array>,signal:AbortSignal){
  const iterator=input[Symbol.asyncIterator]();let buffered=Buffer.alloc(0),count=0;
  try{
    for(;;){const item=await next(iterator,signal);if(item.done){if(buffered.length)return unavailable('input_invalid');return;}
      if(!(item.value instanceof Uint8Array)||item.value.byteLength>8192)return unavailable('input_invalid');
      buffered=Buffer.concat([buffered,item.value]);let end:number;
      while((end=buffered.indexOf(10))>=0){
        const line=buffered.subarray(0,end);buffered=buffered.subarray(end+1);
        if(!line.length)continue;if(line.length>512||++count>64)return unavailable('input_invalid');
        let value:unknown;
        try{value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(line));}catch{return unavailable('input_invalid');}
        if(!value||typeof value!=='object'||Array.isArray(value))return unavailable('input_invalid');
        const body=value as Record<string,unknown>;
        if(Object.keys(body).sort().join(',')!=='action,operationId,schema'||body.schema!=='dharma.device-signing-maintenance-control/v1'
          ||typeof body.operationId!=='string'||!UUID.test(body.operationId)
          ||!['progress','complete','status','cancel'].includes(String(body.action)))return unavailable('input_invalid');
        yield body as {operationId:string;action:'progress'|'complete'|'status'|'cancel'};
      }
      if(buffered.length>512)return unavailable('input_invalid');
    }
  }finally{void iterator.return?.().catch(()=>{});}
}

/** Connected CLI owner. No provider transport, model turn, enrollment, password
 * input or service control is available here. The disabled original session is
 * an audit locator; a device-specific control lease, original encrypted binding
 * and durable operation claim fence this separate maintenance capability. */
export async function runDeviceSigningMaintenanceController(input:Input):Promise<Record<string,unknown>>{
  const clock=input.now??Date.now,config=await loadDeviceConfig(input.configPath);
  const registration=await readNamedSession(input.home,input.name),workspace=await input.readWorkspace();
  if(!registration||!workspace||!UUID.test(input.workspaceId)||registration.identity.workspaceId!==input.workspaceId
    ||![config.deviceId,config.installationId,config.setupClaimReference,workspace.repositoryBindingId].every(value=>typeof value==='string'&&UUID.test(value))
    ||!/^sha256:[a-f0-9]{64}$(?![\s\S])/.test(workspace.repositoryRemoteHash)
    ||workspace.workspaceId!==input.workspaceId||workspace.organizationId!==config.organizationId
    ||registration.identity.organizationId!==config.organizationId||registration.identity.deviceId!==config.deviceId
    ||registration.identity.repositoryBindingId!==workspace.repositoryBindingId||workspace.repositoryRemoteHash!==config.setupClaimRepositoryFingerprint
    ||!isAbsolute(workspace.path)||resolve(workspace.path)!==workspace.path)return unavailable('scope_unavailable');
  const state=await input.processState(),operationId=input.operationId??randomUUID();
  const trustExpiry=Date.parse(config.serverSigningKeyset?.expiresAt??'');
  const trustState=!Number.isFinite(trustExpiry)?'unavailable':trustExpiry<=clock()?'expired':'current';
  if(!UUID.test(operationId))return unavailable('operation_invalid');
  const summary={schema:'dharma.device-signing-maintenance-controller-progress/v1',operationId,
    organizationId:config.organizationId,deviceId:config.deviceId,workspaceId:input.workspaceId,bindingId:registration.bindingId,
    authorityKind:'device_trust_maintenance',nativeContinuationAuthorized:false,ready:false};
  if(!input.apply)return {...summary,ok:true,planned:true,protectedStoreQualified:false,currentSourceVerified:false,
    registrationDisabled:!registration.enabled,processState:state,trustState,clientTrustInstalled:false};
  if(!input.operationId||registration.enabled||state!=='stopped')return unavailable('quiescence_required');
  if(!input.legacyBoundary||!/^sha256:[a-f0-9]{64}$/.test(input.legacyBoundary.leaseDigest))return unavailable('exclusive_legacy_boundary_required');
  await input.legacyBoundary.assertHeld();
  if(trustState!=='expired')return unavailable('expired_trust_required');
  const abort=new AbortController(),started=clock(),deadline=started+900000;
  const signal=AbortSignal.any([input.signal,abort.signal]),timer=setTimeout(()=>abort.abort(),900000);timer.unref();
  let vault:LocalVault|ScopedLocalVault|undefined;
  try{return await withDeviceSigningControl({config,hostScope:{signal,current:async()=>!signal.aborted}},async control=>{
    vault=await input.openVault();
    const original=await vault.getProviderSessionBinding(registration.bindingId,registration.identity);
    if(!original||original.owner!=='dharma_bridge'||original.provider!=='codex'||original.workspaceRoot!==workspace.path
      ||!UUID.test(original.bindingId))return unavailable('binding_unavailable');
    const lease=await vault.tryAcquireProviderSessionLease(registration.bindingId,registration.identity);
    if(!lease)return unavailable('owner_busy');
    let handle:OwnedSigningRecoveryHandle|undefined;
    const valid=async()=>{
      if(signal.aborted||clock()<started||clock()>=deadline||!await lease.assertHeld())return false;
      await input.legacyBoundary!.assertHeld();
      await control.assertHeld();
      const current=await readNamedSession(input.home,input.name),selected=await input.readWorkspace();
      const fresh=await loadDeviceConfig(input.configPath),binding=await vault!.getProviderSessionBinding(registration.bindingId,registration.identity);
      return !signal.aborted&&canonicalize(current)===canonicalize(registration)&&canonicalize(selected)===canonicalize(workspace)
        &&canonicalize(immutableDevice(fresh))===canonicalize(immutableDevice(config))&&canonicalize(binding)===canonicalize(original)
        &&await input.processState()==='stopped'&&await lease.assertHeld();
    };
    const hostScope={signal,current:valid};
    const assert=async()=>{if(!await valid())return unavailable('scope_changed');};
    try{
      await assert();
      await loadDeviceEnrollmentAnchor({config,store:input.store,hostScope,readOnly:true});
      await assert();
      const claimed=await vault.claimCodexSetupOperation(operationId,hash({purpose:'dharma.device-trust-maintenance/v1',operationId,
        device:immutableDevice(config),registration,workspace,originalBinding:original}));
      if(claimed.state!=='acquired')return unavailable('operation_consumed');
      await assert();
      const context=await readOwnedSigningMaintenanceContext({configPath:input.configPath,workspaceId:input.workspaceId,
        repositoryBindingId:workspace.repositoryBindingId,membershipId:registration.identity.membershipId,operationId,hostScope,
        store:input.store,fetcher:input.fetcher,now:clock});
      await assert();
      handle=await prepareOwnedSigningMaintenance({configPath:input.configPath,source:context.source,hostScope,
        store:input.store,fetcher:input.fetcher,now:clock,controller:{schema:'dharma.device-trust-maintenance-owner/v1',operationId,
          controllerInstanceId:control.controllerInstanceId,processIdentityDigest:control.processIdentityDigest,
          leaseDigest:hash({deviceSigningControl:control.leaseDigest,legacyRuntimeBoundary:input.legacyBoundary!.leaseDigest}),
          registrationDigest:hash({registration,originalBinding:original}),deviceId:config.deviceId,recipientMembershipId:registration.identity.membershipId,
          originalBindingId:registration.bindingId,originalSessionId:original.sessionId,expiresAt:new Date(deadline).toISOString()}});
      const progress=await submitOwnedSigningRecoveryPreparation(handle);
      input.emit({...summary,ok:true,progress,recipientUrl:config.hqUrl+'/agent-fabric/signing-maintenance?orgId='
        +encodeURIComponent(config.organizationId)+'&preparationId='+encodeURIComponent(handle.preparationId)+'&kind=recipient'});
      for await(const request of frames(input.frames,signal)){
        await assert();if(request.operationId!==operationId)return unavailable('input_invalid');
        if(request.action==='cancel')return {...summary,ok:false,state:'cancelled',clientTrustInstalled:false};
        const current=request.action==='status'?await inspectOwnedSigningRecovery(handle)
          :request.action==='progress'?await progressOwnedSigningRecoveryOffer(handle):await completeOwnedSigningRecovery(handle);
        await assert();
        const selectedUrl=config.hqUrl+'/agent-fabric/signing-maintenance?orgId='+encodeURIComponent(config.organizationId)
          +'&preparationId='+encodeURIComponent(handle.preparationId)+'&recoveryId='+encodeURIComponent(current.recoveryId??'')
          +'&approvalId='+encodeURIComponent(current.approvalId??'');
        const view={...summary,ok:true,progress:current,...('recoveryId'in current?{ownerUrl:selectedUrl+'&kind=owner',
          recipientUrl:selectedUrl+'&kind=recipient'}:{})};
        if(current.state==='trust_installed')return view;
        input.emit(view);
      }
      return {...summary,ok:false,state:'closed_before_completion',reconcileBeforeRetry:true};
    }catch(error){
      const phase=error instanceof OwnedSigningRecoveryError?error.phase:'controller';
      const httpStatus=error instanceof OwnedSigningRecoveryError?error.httpStatus:null;
      return {...summary,ok:false,state:'unconfirmed',phase,httpStatus,reconcileBeforeRetry:true,
        ...(handle?{progress:await inspectOwnedSigningRecovery(handle).catch(()=>null)}:{})};
    }finally{if(handle)disposeOwnedSigningRecovery(handle);await lease.release();}
  });}finally{abort.abort();clearTimeout(timer);await vault?.close();}
}
