import {createHash,randomUUID} from 'node:crypto';
import {link,lstat,mkdir,readFile,readdir,realpath,unlink,writeFile} from 'node:fs/promises';
import {dirname,resolve,sep} from 'node:path';
import {canonicalize} from '@dharma-ai-labs/agent-fabric-contracts';
import {namedSessionPaths,readNamedSession} from './namedSessionService.js';

export interface LegacySigningMaintenanceBoundary {readonly leaseDigest:string;assertHeld():Promise<void>;}
const unavailable=():never=>{throw Error('legacy_signing_maintenance_boundary_unavailable');};
type Owned={path:string;dev:bigint;ino:bigint;bytes:string};
const hash=(value:unknown)=>'sha256:'+createHash('sha256').update(canonicalize(value)).digest('hex');

/** Cooperative exclusion for a verified current managed CLI cohort. Old lock
 * paths are held for compatibility, not as proof against archived binaries.
 * Never reclaim old locks, stop a process, enable a session or alter identity. */
export async function withLegacySigningMaintenanceBoundary<T>(input:{home:string;name:string;signal:AbortSignal;
  assertManagedCohort():Promise<string>},
  work:(boundary:LegacySigningMaintenanceBoundary)=>Promise<T>):Promise<T>{
  const home=resolve(input.home),owned:Owned[]=[],operationId=randomUUID();let active=true;
  const assertDirectory=async(path:string)=>{
    const info=await lstat(path);
    if(!info.isDirectory()||info.isSymbolicLink()||resolve(await realpath(path))!==path
      ||process.platform!=='win32'&&(info.uid!==process.getuid!()||(info.mode&0o022)!==0))return unavailable();
  };
  const snapshot=async()=>{
    input.signal.throwIfAborted();await assertDirectory(home);await assertDirectory(resolve(home,'sessions'));
    const entries=await readdir(resolve(home,'sessions'),{withFileTypes:true});
    const names=entries.filter(value=>/^[a-z][a-z0-9-]{0,47}$/.test(value.name)).map(value=>value.name).sort();
    if(names.length!==1||names[0]!==input.name)return unavailable();
    await assertDirectory(namedSessionPaths(home,input.name).root);
    const registration=await readNamedSession(home,input.name);
    if(!registration||registration.enabled)return unavailable();return canonicalize(registration);
  };
  const original=await snapshot();
  if(typeof input.assertManagedCohort!=='function')return unavailable();
  let cohortDigest:string|undefined;
  const paths=['autostart-mutation.lock','device.json.enrollment.lock','device.json.connection.lock','registry/workspaces.json.mutation.lock',
    'relay/supervisor.pid.lock','relay/relay.pid.lock','sessions/'+input.name+'/service.lock'].map(path=>resolve(home,path));
  const assertOwned=async(entry:Owned)=>{
    await assertDirectory(dirname(entry.path));const info=await lstat(entry.path,{bigint:true});
    if(!info.isFile()||info.isSymbolicLink()||info.dev!==entry.dev||info.ino!==entry.ino
      ||await readFile(entry.path,'utf8')!==entry.bytes)return unavailable();
  };
  const assertHeld=async()=>{
    if(!active||input.signal.aborted||await snapshot()!==original||owned.length!==paths.length)return unavailable();
    for(const entry of owned)await assertOwned(entry);
    const currentCohort=await input.assertManagedCohort();
    if(!/^sha256:[a-f0-9]{64}$/.test(currentCohort)||cohortDigest!==undefined&&currentCohort!==cohortDigest)return unavailable();
    cohortDigest=currentCohort;
    // Relay PID files name daemons, while the .lock paths above name their
    // mutually exclusive owner. Do not synthesize a running relay PID file.
    for(const name of ['relay/relay.pid','relay/supervisor.pid']){
      try{const text=(await readFile(resolve(home,name),'utf8')).trim(),pid=Number(text);
        if(!/^[1-9][0-9]*$/.test(text)||!Number.isSafeInteger(pid))return unavailable();
        try{process.kill(pid,0);return unavailable();}catch(error){if((error as NodeJS.ErrnoException).code!=='ESRCH')return unavailable();}
      }catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
    }
    input.signal.throwIfAborted();
  };
  let cleanupError=false;
  try{
    for(const path of paths){
      if(!path.startsWith(home+sep))return unavailable();
      await mkdir(dirname(path),{recursive:true,mode:0o700});await assertDirectory(dirname(path));
      const candidate=path+'.maintenance-'+operationId,bytes=process.pid+'\n';
      let candidateOwned:Owned|undefined;
      try{
        await writeFile(candidate,bytes,{flag:'wx',mode:0o600});
        const metadata=await lstat(candidate,{bigint:true});candidateOwned={path:candidate,dev:metadata.dev,ino:metadata.ino,bytes};
        await assertOwned(candidateOwned);input.signal.throwIfAborted();
        // link is the same atomic publication primitive used by the legacy
        // acquirePidLock. Existing or corrupt owners fail closed, no recovery.
        await link(candidate,path);owned.push({...candidateOwned,path});
      }finally{if(candidateOwned){await assertOwned(candidateOwned);await unlink(candidate);}}
    }
    await assertHeld();
    const lease=Object.freeze({leaseDigest:hash({schema:'dharma.legacy-signing-maintenance-boundary/v1',operationId,
      pid:process.pid,registrationDigest:hash(original),cohortDigest,
      paths:owned.map(entry=>({path:entry.path,dev:String(entry.dev),ino:String(entry.ino)}))}),assertHeld});
    const result=await work(lease);await assertHeld();return result;
  }finally{
    active=false;
    for(const entry of owned.reverse())try{await assertOwned(entry);await unlink(entry.path);}catch{cleanupError=true;}
    if(cleanupError)throw Error('legacy_signing_maintenance_cleanup_unconfirmed');
  }
}
