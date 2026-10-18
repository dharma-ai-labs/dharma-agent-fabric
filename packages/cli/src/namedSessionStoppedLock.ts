import {createHash} from 'node:crypto';
import {constants} from 'node:fs';
import {link,lstat,open,realpath,unlink} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import type {NamedSessionRegistration} from './namedSessionService.js';

const digest=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
const unavailable=()=>new Error('named_session_stopped_lock_unconfirmed');
interface Input {
  home:string; name:string; registration:NamedSessionRegistration;
  registrationSha256:string; lockSha256:string; apply:boolean;
}
interface Dependencies {
  assertTopology():Promise<void>;
  processState(pid:number):Promise<'stopped'|'running'|'unknown'>;
}

async function privateFile(path:string,uid:number,limit:number){
  const file=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  try{
    const stat=await file.stat({bigint:true});
    if(!stat.isFile()||Number(stat.uid)!==uid||(Number(stat.mode)&0o077)!==0||stat.size>BigInt(limit))throw unavailable();
    const bytes=await file.readFile();if(bytes.length>limit)throw unavailable();
    return{bytes,dev:stat.dev,ino:stat.ino};
  }finally{await file.close();}
}

/** Called only under the owning CLI's home-wide startup mutation admission. */
export async function reconcileStoppedNamedSessionLock(input:Input,deps:Dependencies){
  const uid=process.getuid?.()??-1;
  if(process.platform!=='linux'||uid<=0||resolve(input.home)!==input.home
    ||!/^[a-z][a-z0-9-]{0,47}$/.test(input.name)||input.registration.name!==input.name
    ||input.registration.enabled||input.registration.maintenanceFence
    ||![input.registrationSha256,input.lockSha256].every(v=>/^[a-f0-9]{64}$/.test(v)))throw unavailable();
  const root=join(input.home,'sessions',input.name),registrationPath=join(root,'registration.json'),lockPath=join(root,'service.lock');
  for(const path of[input.home,join(input.home,'sessions'),root]){
    const stat=await lstat(path);
    if(!stat.isDirectory()||stat.isSymbolicLink()||stat.uid!==uid||(stat.mode&0o077)!==0||await realpath(path)!==path)throw unavailable();
  }
  const verify=async()=>{
    await deps.assertTopology();
    const registration=await privateFile(registrationPath,uid,4096);
    if(digest(registration.bytes)!==input.registrationSha256
      ||JSON.stringify(JSON.parse(registration.bytes.toString('utf8')))!==JSON.stringify(input.registration))throw unavailable();
    const lock=await privateFile(lockPath,uid,64),text=lock.bytes.toString('utf8');
    if(digest(lock.bytes)!==input.lockSha256||!/^([1-9][0-9]*)\n?$/.test(text))throw unavailable();
    const pid=Number(text.trim());
    if(!Number.isSafeInteger(pid)||pid<=1||await deps.processState(pid)!=='stopped')throw unavailable();
    return{...lock,pid};
  };
  const before=await verify(),archiveName='service.lock.stopped.'+input.lockSha256;
  const receipt={ok:true,planned:!input.apply,name:input.name,workspaceId:input.registration.identity.workspaceId,
    bindingId:input.registration.bindingId,registrationSha256:input.registrationSha256,lockSha256:input.lockSha256,
    archive:archiveName,previousPid:before.pid,registrationChanged:false,budgetChanged:false,providerStarted:false,protectedStoreRead:false,
    ready:false,nativeContinuationAuthorized:false};
  if(!input.apply)return{...receipt,state:'stopped_lock_reconciliation_planned'};
  const current=await verify();
  if(current.dev!==before.dev||current.ino!==before.ino)throw unavailable();
  const archive=join(root,archiveName);
  try{await link(lockPath,archive);}
  catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;}
  const retained=await privateFile(archive,uid,64);
  if(retained.dev!==before.dev||retained.ino!==before.ino||digest(retained.bytes)!==input.lockSha256)throw unavailable();
  const archiveFile=await open(archive,constants.O_RDONLY|constants.O_NOFOLLOW);
  try{await archiveFile.sync();}finally{await archiveFile.close();}
  const directory=await open(root,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);
  try{await directory.sync();}finally{await directory.close();}
  const final=await verify();
  if(final.dev!==before.dev||final.ino!==before.ino)throw unavailable();
  await unlink(lockPath);
  const completedDirectory=await open(root,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);
  try{await completedDirectory.sync();}finally{await completedDirectory.close();}
  try{await lstat(lockPath);throw unavailable();}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
  if(digest((await privateFile(registrationPath,uid,4096)).bytes)!==input.registrationSha256)throw unavailable();
  return{...receipt,state:'stopped_lock_reconciled',planned:false};
}
