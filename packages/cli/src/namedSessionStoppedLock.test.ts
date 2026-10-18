import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {chmod,lstat,mkdir,mkdtemp,readFile,realpath,rename,symlink,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {reconcileStoppedNamedSessionLock} from './namedSessionStoppedLock.js';
import type {NamedSessionRegistration} from './namedSessionService.js';

const linux={skip:process.platform!=='linux'},sha=(v:Uint8Array)=>createHash('sha256').update(v).digest('hex');
async function fixture(){
  const home=await realpath(await mkdtemp(join(tmpdir(),'dharma-stopped-lock-')));await chmod(home,0o700);
  const name='codex-fixture',root=join(home,'sessions',name);await mkdir(root,{recursive:true,mode:0o700});await chmod(join(home,'sessions'),0o700);
  const registration:NamedSessionRegistration={schema:'dharma.named-session/v1',name,bindingId:'11111111-1111-4111-8111-111111111111',enabled:false,
    maximumCostCents:1000,maximumTurnCostCents:25,identity:{organizationId:'org_fixture',provider:'codex',
      repositoryBindingId:'22222222-2222-4222-8222-222222222222',workspaceId:'33333333-3333-4333-8333-333333333333',
      endpointId:'44444444-4444-4444-8444-444444444444',membershipId:'55555555-5555-4555-8555-555555555555',deviceId:'66666666-6666-4666-8666-666666666666'}};
  await writeFile(join(root,'registration.json'),JSON.stringify(registration)+'\n',{mode:0o600});
  const lock=join(root,'service.lock');await writeFile(lock,'987654\n',{mode:0o600});
  const input={home,name,registration,registrationSha256:sha(await readFile(join(root,'registration.json'))),lockSha256:sha(await readFile(lock)),apply:false};
  const deps={assertTopology:async()=>{},processState:async()=> 'stopped' as 'stopped'|'running'|'unknown'};
  return{home,root,lock,input,deps};
}

test('stopped-lock plan is inert and apply retains the exact original lock inode and registration',linux,async()=>{
  const f=await fixture(),before=await lstat(f.lock);const plan=await reconcileStoppedNamedSessionLock(f.input,f.deps);
  assert.equal(plan.state,'stopped_lock_reconciliation_planned');assert.equal((await lstat(f.lock)).ino,before.ino);
  await assert.rejects(lstat(join(f.root,plan.archive)),{code:'ENOENT'});
  const result=await reconcileStoppedNamedSessionLock({...f.input,apply:true},f.deps);
  assert.equal(result.state,'stopped_lock_reconciled');assert.equal((await lstat(join(f.root,result.archive))).ino,before.ino);
  assert.equal(result.registrationChanged,false);assert.equal(result.budgetChanged,false);assert.equal(result.protectedStoreRead,false);
  await assert.rejects(lstat(f.lock),{code:'ENOENT'});
});

for(const cause of ['enabled','wrong-registration','wrong-lock','running','unknown','unsafe-parent','foreign-topology','symlink','malformed']){
  test('stopped-lock reconciliation refuses '+cause+' without removing the lock',linux,async()=>{
    const f=await fixture();
    if(cause==='enabled')f.input.registration.enabled=true;
    if(cause==='wrong-registration')f.input.registrationSha256='0'.repeat(64);
    if(cause==='wrong-lock')f.input.lockSha256='0'.repeat(64);
    if(cause==='running'||cause==='unknown')f.deps.processState=async()=>cause;
    if(cause==='unsafe-parent')await chmod(f.root,0o755);
    if(cause==='foreign-topology')f.deps.assertTopology=async()=>{throw Error('foreign controller');};
    if(cause==='symlink'){await writeFile(join(f.root,'foreign'),'987654\n',{mode:0o600});
      f.input.name='linked';f.input.registration={...f.input.registration,name:'linked'};await symlink(f.root,join(f.home,'sessions','linked'));}
    if(cause==='malformed'){await writeFile(f.lock,'not-a-pid\n');f.input.lockSha256=sha(await readFile(f.lock));}
    await assert.rejects(reconcileStoppedNamedSessionLock({...f.input,apply:true},f.deps));assert.equal((await lstat(f.lock)).isFile(),true);
  });
}

test('a topology change after archive creation leaves the active lock intact',linux,async()=>{
  const f=await fixture();let checks=0;f.deps.assertTopology=async()=>{if(++checks===3)throw Error('topology changed');};
  await assert.rejects(reconcileStoppedNamedSessionLock({...f.input,apply:true},f.deps));
  assert.equal((await lstat(f.lock)).isFile(),true);
  assert.equal(sha(await readFile(join(f.root,'service.lock.stopped.'+f.input.lockSha256))),f.input.lockSha256);
});

test('a symbolic service lock and an existing foreign archive never admit reconciliation',linux,async()=>{
  for(const cause of ['symlink','archive']){
    const f=await fixture();
    if(cause==='symlink'){await rename(f.lock,join(f.root,'original'));await symlink(join(f.root,'original'),f.lock);}
    else await writeFile(join(f.root,'service.lock.stopped.'+f.input.lockSha256),'foreign\n',{mode:0o600});
    await assert.rejects(reconcileStoppedNamedSessionLock({...f.input,apply:true},f.deps));
    assert.equal(Boolean(await lstat(f.lock)),true);
  }
});

test('registration replacement or a newly live PID after planning cannot remove the active lock',linux,async()=>{
  for(const cause of ['registration','pid']){
    const f=await fixture();let n=0;
    f.deps.assertTopology=async()=>{if(++n===2&&cause==='registration')await writeFile(join(f.root,'registration.json'),'{}\n');};
    let pidChecks=0;if(cause==='pid')f.deps.processState=async()=>++pidChecks===1?'stopped':'running';
    await assert.rejects(reconcileStoppedNamedSessionLock({...f.input,apply:true},f.deps));assert.equal((await lstat(f.lock)).isFile(),true);
  }
});
