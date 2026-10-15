import assert from 'node:assert/strict';
import {randomBytes,createHash} from 'node:crypto';
import {mkdtemp,readFile,rm,chmod,symlink,writeFile} from 'node:fs/promises';
import {hostname,tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import test from 'node:test';
import {LocalVault,type LocalProviderSessionBinding,type LocalProviderSessionIdentity,type LocalProviderSessionLease} from './index.js';

type Input={root:string;masterKey:Buffer;bindingId:string;identity:LocalProviderSessionIdentity;
  prior:{hostName:string;ownerPid:number;acquiredAt:string}};
type Access={binding:Readonly<LocalProviderSessionBinding>;tryAcquire():LocalProviderSessionLease|null;close():void};
const linux={skip:process.platform!=='linux'};
const deadPid=2147483647;
async function fixture(change:Partial<LocalProviderSessionBinding>={}){
  const root=await mkdtemp(join(tmpdir(),'dharma-owner-recovery-')),key=randomBytes(32);
  const binding:LocalProviderSessionBinding={schema:'dharma.local-provider-session-binding/v1',owner:'dharma_bridge',
    organizationId:'org_synthetic',repositoryBindingId:'40000000-0000-4000-8000-000000000001',
    workspaceId:'40000000-0000-4000-8000-000000000002',endpointId:'40000000-0000-4000-8000-000000000003',
    membershipId:'40000000-0000-4000-8000-000000000004',deviceId:'40000000-0000-4000-8000-000000000005',
    bindingId:'40000000-0000-4000-8000-000000000006',provider:'codex',sessionId:'synthetic-owner-thread',
    workspaceRoot:resolve(root,'repo'),createdAt:new Date().toISOString(),
    expiresAt:new Date(Date.now()+86400000).toISOString(),maximumProviderCostCents:25,...change};
  const identity={organizationId:binding.organizationId,repositoryBindingId:binding.repositoryBindingId,
    workspaceId:binding.workspaceId,endpointId:binding.endpointId,membershipId:binding.membershipId,
    deviceId:binding.deviceId,provider:binding.provider};
  const vault=await LocalVault.open({root,masterKey:key});vault.saveProviderSessionBinding(binding);
  const raw=await vault.putBlob(Buffer.from('expired-private-evidence-canary'),'raw-provider-turn');vault.close();
  await chmod(join(root,'vault.sqlite'),0o600);
  const db=new DatabaseSync(join(root,'vault.sqlite'));
  db.prepare('update blobs set created_at=? where content_id=?').run('2020-01-01T00:00:00Z',raw);
  const prior={hostName:hostname(),ownerPid:deadPid,acquiredAt:'2026-10-15T00:00:00Z'};
  db.prepare('insert into provider_session_leases values(?,?,?,?,?)').run(binding.bindingId,'synthetic-holder',prior.hostName,prior.ownerPid,prior.acquiredAt);
  db.close();
  const digest=raw.slice(7),blobPath=join(root,'blobs',digest.slice(0,2),digest+'.blob');
  const quarantine=blobPath+'.expired-2147483646-deadbeef';await writeFile(quarantine,'quarantine-canary');
  return{root,key,binding,identity,raw,blobPath,quarantine,prior,input:{root,masterKey:key,bindingId:binding.bindingId,identity,prior},
    cleanup:()=>rm(root,{recursive:true,force:true})};
}
function snapshot(root:string){
  const db=new DatabaseSync(join(root,'vault.sqlite'),{readOnly:true});
  try{
    const schema=db.prepare("select type,name,sql from sqlite_master where name not like 'sqlite_%' order by type,name").all();
    const tables=db.prepare("select name from sqlite_master where type='table' and name not like 'sqlite_%' and name!='provider_session_leases' order by name").all();
    const rows=Object.fromEntries(tables.map(row=>[String(row.name),db.prepare('select * from "'+String(row.name).replaceAll('"','""')+'" order by rowid').all()]));
    return createHash('sha256').update(JSON.stringify({schema,rows})).digest('hex');
  }finally{db.close();}
}
async function openRecovery(input:Input):Promise<Access>{
  if(process.env.DHARMA_OWNER_RECOVERY_BASELINE==='normal-open'){
    const vault=await LocalVault.open({root:input.root,masterKey:input.masterKey});
    return{binding:vault.getProviderSessionBinding(input.bindingId,input.identity)!,
      tryAcquire:()=>vault.tryAcquireProviderSessionLease(input.bindingId,input.identity),close:()=>vault.close()};
  }
  const api=LocalVault as unknown as {openExistingProviderSessionRecovery(options:Input):Promise<Access>};
  return api.openExistingProviderSessionRecovery(input);
}
test('lease-only open preserves expired evidence, quarantine and all unrelated tables/schema',linux,async()=>{
  const f=await fixture();let access:Access|undefined;
  try{
    const before=snapshot(f.root),bytes=await readFile(f.blobPath),q=await readFile(f.quarantine);
    access=await openRecovery(f.input);assert.equal(access.binding.sessionId,f.binding.sessionId);
    const lease=access.tryAcquire();assert(lease);assert.equal(await lease.assertHeld(),true);lease.release();
    assert.equal(await lease.assertHeld(),false);access.close();access=undefined;
    assert.equal(snapshot(f.root),before);assert.deepEqual(await readFile(f.blobPath),bytes);assert.deepEqual(await readFile(f.quarantine),q);
    const db=new DatabaseSync(join(f.root,'vault.sqlite'),{readOnly:true});
    try{assert.equal(db.prepare('select count(*) as n from provider_session_leases').get()!.n,0);}finally{db.close();}
    assert(f.key.some(b=>b!==0),'caller key must not be erased');
  }finally{access?.close();await f.cleanup();}
});
for(const change of [{hostName:'foreign-host'},{ownerPid:process.pid},{acquiredAt:'changed'}])
  test('rejects foreign, live or changed original lease '+JSON.stringify(change),linux,async()=>{
    const f=await fixture();try{await assert.rejects(openRecovery({...f.input,prior:{...f.prior,...change}}));}
    finally{await f.cleanup();}
  });
test('wrong binding identity and key cannot recover the lease',linux,async()=>{
  const f=await fixture();try{
    await assert.rejects(openRecovery({...f.input,identity:{...f.identity,deviceId:'40000000-0000-4000-8000-000000000099'}}));
    await assert.rejects(openRecovery({...f.input,masterKey:randomBytes(32)}));
  }finally{await f.cleanup();}
});
test('a replacement live/foreign lease after open fails atomic admission',linux,async()=>{
  const f=await fixture();let access:Access|undefined;
  try{
    access=await openRecovery(f.input);const db=new DatabaseSync(join(f.root,'vault.sqlite'));
    db.prepare('update provider_session_leases set host_name=?,owner_pid=? where binding_id=?').run('foreign-host',process.pid,f.binding.bindingId);db.close();
    assert.equal(access.tryAcquire(),null);
  }finally{access?.close();await f.cleanup();}
});
test('closing releases only the newly acquired holder and remains idempotent',linux,async()=>{
  const f=await fixture();let access:Access|undefined;
  try{access=await openRecovery(f.input);const lease=access.tryAcquire();assert(lease);access.close();access.close();
    const db=new DatabaseSync(join(f.root,'vault.sqlite'),{readOnly:true});
    try{assert.equal(db.prepare('select count(*) as n from provider_session_leases').get()!.n,0);}finally{db.close();}
  }finally{access?.close();await f.cleanup();}
});
test('a matching live original process is not a recoverable owner',linux,async()=>{
  const f=await fixture();try{
    const db=new DatabaseSync(join(f.root,'vault.sqlite'));
    db.prepare('update provider_session_leases set owner_pid=?').run(process.pid);db.close();
    await assert.rejects(openRecovery({...f.input,prior:{...f.prior,ownerPid:process.pid}}));
  }finally{await f.cleanup();}
});
test('expired, revoked and non-bridge bindings remain unavailable',linux,async()=>{
  for(const kind of ['expired','revoked','cooperative']){
    const f=await fixture(kind==='cooperative'?{owner:'cooperative_session'}:{});
    const now=Date.now;
    try{
      if(kind==='expired')Date.now=()=>Date.parse(f.binding.expiresAt)+1;
      if(kind==='revoked'){const db=new DatabaseSync(join(f.root,'vault.sqlite'));
        db.prepare('update provider_session_bindings set revoked_at=?').run(new Date().toISOString());db.close();}
      await assert.rejects(openRecovery(f.input));
    }finally{Date.now=now;await f.cleanup();}
  }
});
test('a later replacement holder is preserved by close',linux,async()=>{
  const f=await fixture();let access:Access|undefined;
  try{
    access=await openRecovery(f.input);const lease=access.tryAcquire();assert(lease);
    const db=new DatabaseSync(join(f.root,'vault.sqlite'));
    db.prepare('update provider_session_leases set holder_id=?,host_name=?').run('replacement-holder','foreign-host');db.close();
    access.close();const check=new DatabaseSync(join(f.root,'vault.sqlite'),{readOnly:true});
    try{assert.equal(check.prepare('select holder_id from provider_session_leases').get()!.holder_id,'replacement-holder');}finally{check.close();}
  }finally{access?.close();await f.cleanup();}
});
test('the narrow handle permits only one acquisition attempt',linux,async()=>{
  const f=await fixture();let access:Access|undefined;
  try{access=await openRecovery(f.input);const lease=access.tryAcquire();assert(lease);lease.release();assert.throws(()=>access!.tryAcquire(),/already_attempted/);}
  finally{access?.close();await f.cleanup();}
});
test('missing, symbolic, permissive database and pending rollback journal are rejected',linux,async()=>{
  for(const kind of ['missing','symlink','permissions','journal','wal-symlink']){
    const f=await fixture();try{
      const path=join(f.root,'vault.sqlite');
      if(kind==='missing')await rm(path);
      if(kind==='symlink'){await rm(path);await symlink(join(f.root,'absent'),path);}
      if(kind==='permissions')await chmod(path,0o644);
      if(kind==='journal')await writeFile(path+'-journal','unresolved-journal-canary');
      if(kind==='wal-symlink')await symlink(join(f.root,'absent'),path+'-wal');
      await assert.rejects(openRecovery(f.input));
      if(kind==='missing')await assert.rejects(readFile(path),{code:'ENOENT'});
    }finally{await f.cleanup();}
  }
});
test('non-Linux contexts fail before opening a database',{skip:process.platform==='linux'},async()=>{
  await assert.rejects(openRecovery({root:join(tmpdir(),'must-not-be-created'),masterKey:randomBytes(32),
    bindingId:'40000000-0000-4000-8000-000000000006',identity:{} as LocalProviderSessionIdentity,
    prior:{hostName:hostname(),ownerPid:deadPid,acquiredAt:new Date().toISOString()}}),/context_unqualified/);
});
