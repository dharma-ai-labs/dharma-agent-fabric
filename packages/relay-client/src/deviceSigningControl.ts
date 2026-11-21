import {AsyncLocalStorage} from 'node:async_hooks';
import {createHash,randomUUID} from 'node:crypto';
import {userInfo} from 'node:os';
import {resolve} from 'node:path';
import {performance} from 'node:perf_hooks';
import {canonicalize} from '@dharma-ai-labs/agent-fabric-contracts';
import {acquireEnrollmentAnchorLock,type EnrollmentAnchorLockRelease} from './enrollmentAnchorLock.js';
import {HostOperationFence,type HostOperationScope} from './hostOperationScope.js';

export interface DeviceSigningControlLease {
  readonly controllerInstanceId:string;
  readonly processIdentityDigest:string;
  readonly leaseDigest:string;
  assertHeld():Promise<void>;
}
interface Owner {namespace:string;active:boolean;lease:DeviceSigningControlLease;}
const owners=new AsyncLocalStorage<Owner>();
// #511: one relay process runs several workspace loops on one device. Their roots wait in one line per
// namespace in this process, in arrival order, so a sibling's long hold is a wait in line rather than a
// connection_anchor_busy after the lock wait. Only the root at the front of the line contends for the lock
// file, which still excludes every other process and still recovers a lock whose owner died.
const DEVICE_SIGNING_LINE_WAIT_MS=120_000;
const DEVICE_SIGNING_LOCK_WAIT_MS=10_000;
interface Line {tail:Promise<void>;waiting:number;}
const lines=new Map<string,Line>();
// A relay workspace loop has no host scope, so its stop signal reaches the line through this store. It only
// lets a root leave the line: a root with nobody ahead of it, and the lock file itself, behave as before.
const lineSignals=new AsyncLocalStorage<AbortSignal>();

/** Runs work so that a root signing-control wait inside it leaves the line when signal aborts. */
export function withDeviceSigningLineSignal<T>(signal:AbortSignal,work:()=>Promise<T>):Promise<T>{
  return lineSignals.run(signal,work);
}

/** Runs work outside any signing-control hold of its caller, so a signing-control call started in it, even one
 * that runs after the caller's hold has settled, takes control as a root. A relay loop's line signal still applies. */
export function outsideDeviceSigningControl<T>(work:()=>T):T{
  return owners.exit(work);
}

/** Roots taken by withSigningControlPerSend: their work may end the hold after one network send. */
const perSendRoots=new WeakSet<Owner>();
class SigningControlHandBack extends Error{constructor(){super('device_signing_control_hand_back');}}

/** Runs one signed request under device signing control so that each hold covers at most one network send. When the
 * request first sends another kept request, it hands the hold back (handBackDeviceSigningControl) and runs again in a
 * fresh hold, behind every root that waited meanwhile. Inside a caller's own hold it runs there, as
 * withDeviceSigningControl does, so a caller that holds control across several calls keeps it across their sends. */
export async function withSigningControlPerSend<T>(input:Parameters<typeof withDeviceSigningControl>[0],
  work:()=>Promise<T>):Promise<T>{
  if(owners.getStore())return withDeviceSigningControl(input,work);
  for(;;){
    try{return await withDeviceSigningControl(input,async()=>{perSendRoots.add(owners.getStore()!);return work();});}
    catch(error){if(!(error instanceof SigningControlHandBack))throw error;}
  }
}

/** Ends the current hold when it is a root of withSigningControlPerSend, whose work then runs again in a fresh hold.
 * In any other hold, or outside one, it returns and the caller goes on. */
export function handBackDeviceSigningControl():void{
  const owner=owners.getStore();
  if(owner?.active&&perSendRoots.has(owner))throw new SigningControlHandBack();
}

/** Resolves with this root's leave() once every root ahead of it has left. A root that gives up, at the
 * deadline, when its host scope is withdrawn or when its relay loop stops, leaves at once, so the roots
 * behind it keep their order. */
async function waitInLine(namespace:string,deadline:number,fence:HostOperationFence|undefined):Promise<()=>void>{
  const line=lines.get(namespace)??{tail:Promise.resolve(),waiting:0};
  lines.set(namespace,line);
  const stop=line.waiting>0?lineSignals.getStore():undefined;
  const ahead=line.tail;let open!:()=>void,left=false;
  const leaving=new Promise<void>(accept=>{open=accept;});
  line.tail=ahead.then(()=>leaving);
  line.waiting++;
  const leave=()=>{
    if(left)return;left=true;open();
    if(--line.waiting===0&&lines.get(namespace)===line)lines.delete(namespace);
  };
  let timer:NodeJS.Timeout|undefined,onAbort:(()=>void)|undefined,onStop:(()=>void)|undefined;
  try{
    const outcome=await new Promise<'turn'|'deadline'|'withdrawn'|'stopped'>(accept=>{
      void ahead.then(()=>accept('turn'));
      timer=setTimeout(()=>accept('deadline'),Math.max(0,deadline-Date.now()));
      if(fence){onAbort=()=>accept('withdrawn');fence.signal.addEventListener('abort',onAbort,{once:true});
        if(fence.signal.aborted)accept('withdrawn');}
      if(stop){onStop=()=>accept('stopped');stop.addEventListener('abort',onStop,{once:true});
        if(stop.aborted)accept('stopped');}
    });
    if(outcome==='turn')return leave;
    if(outcome==='withdrawn')await fence!.assert();
    if(outcome==='stopped')stop!.throwIfAborted();
    throw Error('connection_anchor_busy');
  }catch(error){leave();throw error;}
  finally{clearTimeout(timer);if(onAbort)fence!.signal.removeEventListener('abort',onAbort);
    if(onStop)stop!.removeEventListener('abort',onStop);}
}
const hash=(v:unknown)=>'sha256:'+createHash('sha256').update(canonicalize(v)).digest('hex');
const denied=():never=>{throw Error('device_signing_control_unavailable');};

/** Serialization, not device, source, consent or task authority. Native turns,
 * ordinary signed transport and device maintenance use the same OS-user/device
 * namespace. Nested SDK calls reuse only their still-live async owner; a copied
 * descriptor or a detached callback cannot carry the lease after settlement. */
export async function withDeviceSigningControl<T>(input:{config:{hqUrl:string;organizationId:string;deviceId:string};
  hostScope?:HostOperationScope;timeoutMs?:number},work:(lease:DeviceSigningControlLease)=>Promise<T>):Promise<T>{
  const url=new URL(input.config.hqUrl),org=input.config.organizationId,device=input.config.deviceId;
  const loopback=['127.0.0.1','[::1]','localhost'].includes(url.hostname);
  if((url.protocol!=='https:'&&!(loopback&&url.protocol==='http:'))||url.origin!==input.config.hqUrl
    ||[org,device].some(value=>typeof value!=='string'||value.length<1||value.length>256||/[\x00-\x1f\x7f]/.test(value)))return denied();
  // An explicit timeoutMs bounds the whole wait, in line and for the lock. Without one, a root waits in
  // line for up to DEVICE_SIGNING_LINE_WAIT_MS and then for up to 10 s for the lock file.
  const timeout=input.timeoutMs??DEVICE_SIGNING_LOCK_WAIT_MS;
  if(!Number.isSafeInteger(timeout)||timeout<1||timeout>DEVICE_SIGNING_LOCK_WAIT_MS)return denied();
  const started=Date.now();
  const user=userInfo(),userHash=hash({home:user.homedir,user:user.username}).slice(7);
  const namespace=hash({origin:url.origin,organizationId:org,deviceId:device,user:userHash});
  const fence=input.hostScope?new HostOperationFence(input.hostScope):undefined;
  await fence?.assert();
  const parent=owners.getStore();
  if(parent){
    if(!parent.active||parent.namespace!==namespace)return denied();
    await parent.lease.assertHeld();
    const result=await work(parent.lease);await fence?.assert();await parent.lease.assertHeld();return result;
  }
  const root=process.platform==='win32'?resolve(user.homedir,'AppData','Local','Temp'):'/tmp';
  const path=resolve(root,'dharma-signing-controls-'+userHash.slice(0,32),namespace.slice(7)+'.lock');
  const explicit=input.timeoutMs!==undefined;
  const leaveLine=await waitInLine(namespace,started+(explicit?timeout:DEVICE_SIGNING_LINE_WAIT_MS),fence);
  let release:EnrollmentAnchorLockRelease;
  try{release=await acquireEnrollmentAnchorLock(path,fence,explicit?Math.max(1,started+timeout-Date.now()):timeout);}
  catch(error){leaveLine();throw error;}
  const controllerInstanceId=randomUUID(),owner:Owner={namespace,active:true,lease:undefined!};
  const processIdentityDigest=hash({schema:'dharma.signing-controller-process/v1',hostUser:userHash,
    pid:process.pid,processTimeOrigin:performance.timeOrigin,controllerInstanceId});
  owner.lease=Object.freeze({controllerInstanceId,processIdentityDigest,
    leaseDigest:hash({schema:'dharma.device-signing-control-lease/v1',namespace,controllerInstanceId,processIdentityDigest}),
    assertHeld:async()=>{
      if(!owner.active||owners.getStore()!==owner)return denied();
      await fence?.assert();await release.assertHeld();if(!owner.active)return denied();
    }});
  try{return await owners.run(owner,async()=>{
    await owner.lease.assertHeld();const result=await work(owner.lease);await owner.lease.assertHeld();return result;
  });}finally{owner.active=false;try{await release();}finally{leaveLine();}}
}
