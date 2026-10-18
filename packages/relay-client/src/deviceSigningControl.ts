import {AsyncLocalStorage} from 'node:async_hooks';
import {createHash,randomUUID} from 'node:crypto';
import {userInfo} from 'node:os';
import {resolve} from 'node:path';
import {performance} from 'node:perf_hooks';
import {canonicalize} from '@dharma-ai-labs/agent-fabric-contracts';
import {acquireEnrollmentAnchorLock} from './enrollmentAnchorLock.js';
import {HostOperationFence,type HostOperationScope} from './hostOperationScope.js';

export interface DeviceSigningControlLease {
  readonly controllerInstanceId:string;
  readonly processIdentityDigest:string;
  readonly leaseDigest:string;
  assertHeld():Promise<void>;
}
interface Owner {namespace:string;active:boolean;lease:DeviceSigningControlLease;}
const owners=new AsyncLocalStorage<Owner>();
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
  const timeout=input.timeoutMs??10000;
  if(!Number.isSafeInteger(timeout)||timeout<1||timeout>10000)return denied();
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
  const release=await acquireEnrollmentAnchorLock(path,fence,timeout);
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
  });}finally{owner.active=false;await release();}
}
