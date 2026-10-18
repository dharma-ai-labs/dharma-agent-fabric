import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdir,mkdtemp,readFile,realpath,rm,unlink,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';
import test from 'node:test';
import {saveNamedSession} from './namedSessionService.js';
import * as boundary from './legacySigningMaintenanceBoundary.js';

const id=(n:number)=>`df000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
async function fixture(){
  const home=await realpath(await mkdtemp(resolve(tmpdir(),'mb-')));
  await saveNamedSession(home,{schema:'dharma.named-session/v1',name:'reviewer',bindingId:id(1),enabled:false,maximumCostCents:100,maximumTurnCostCents:25,
    identity:{organizationId:'org_fixture',deviceId:id(2),membershipId:id(3),endpointId:id(4),workspaceId:id(5),repositoryBindingId:id(6),provider:'codex'}});
  return {home,name:'reviewer',signal:new AbortController().signal,assertManagedCohort:async()=>'sha256:'+'f'.repeat(64)};
}
test('held legacy startup locks exclude independent normal relay/supervisor acquisition for the whole maintenance window',async()=>{
  const f=await fixture();try{
    await boundary.withLegacySigningMaintenanceBoundary(f,async owned=>{
      await owned.assertHeld();assert.match(owned.leaseDigest,/^sha256:[a-f0-9]{64}$/);
      for(const method of ['acquireRelayProcessLease','acquireRelaySupervisorLease','acquireNamedSessionStartupAdmission']){
        const source=`const m=await import(${JSON.stringify(new URL('./index.js',import.meta.url).href)});try{await m.${method}(${JSON.stringify(f.home)});process.stdout.write('UNEXPECTED_START');process.exitCode=2;}catch{process.stdout.write('BLOCKED');}`;
        const result=await promisify(execFile)(process.execPath,['--input-type=module','-e',source],{windowsHide:true,timeout:15000});
        assert.equal(result.stdout,'BLOCKED');await owned.assertHeld();
      }
      const lock=resolve(f.home,'sessions','reviewer','service.lock');
      assert.equal((await readFile(lock,'utf8')).trim(),String(process.pid));
    });
    await assert.rejects(readFile(resolve(f.home,'relay','relay.pid.lock')),{code:'ENOENT'});
  }finally{await rm(f.home,{recursive:true,force:true});}
});

test('old, unknown or changed managed cohort cannot enter or retain maintenance authority',async()=>{
  const f=await fixture();try{
    let entered=false;
    await assert.rejects(boundary.withLegacySigningMaintenanceBoundary({...f,assertManagedCohort:async()=>{throw Error('OLD_COHORT');}},
      async()=>{entered=true;}),/OLD_COHORT/);assert.equal(entered,false);
    let digest='sha256:'+'a'.repeat(64);
    await assert.rejects(boundary.withLegacySigningMaintenanceBoundary({...f,assertManagedCohort:async()=>digest},async owned=>{
      digest='sha256:'+'b'.repeat(64);await owned.assertHeld();
    }),/legacy_signing_maintenance_boundary_unavailable/);
    await assert.rejects(readFile(resolve(f.home,'autostart-mutation.lock')),{code:'ENOENT'});
  }finally{await rm(f.home,{recursive:true,force:true});}
});
test('foreign or corrupt existing lock is preserved instead of recovered or silently accepted',async()=>{
  const f=await fixture();try{
    await mkdir(resolve(f.home,'relay'));const lock=resolve(f.home,'relay','relay.pid.lock');await writeFile(lock,'not-a-known-owner');
    let entered=false;await assert.rejects(boundary.withLegacySigningMaintenanceBoundary(f,async()=>{entered=true;}));
    assert.equal(entered,false);assert.equal(await readFile(lock,'utf8'),'not-a-known-owner');
  }finally{await rm(f.home,{recursive:true,force:true});}
});
test('changed registration or replaced lock withdraws authority and cleanup preserves the replacement',async()=>{
  const f=await fixture();try{
    const lock=resolve(f.home,'relay','relay.pid.lock');let retained:undefined|{assertHeld():Promise<void>};
    await assert.rejects(boundary.withLegacySigningMaintenanceBoundary(f,async owned=>{
      retained=owned;await unlink(lock);await writeFile(lock,'FOREIGN_REPLACEMENT');await owned.assertHeld();
    }));
    assert.equal(await readFile(lock,'utf8'),'FOREIGN_REPLACEMENT');await assert.rejects(retained!.assertHeld());
  }finally{await rm(f.home,{recursive:true,force:true});}
});
test('registration change and cancellation invalidate the held boundary without undoing another actor edits',async()=>{
  const f=await fixture();try{
    const path=resolve(f.home,'sessions','reviewer','registration.json'),original=JSON.parse(await readFile(path,'utf8'));
    await assert.rejects(boundary.withLegacySigningMaintenanceBoundary(f,async owned=>{
      await writeFile(path,JSON.stringify({...original,enabled:true}));await owned.assertHeld();
    }));
    assert.equal(JSON.parse(await readFile(path,'utf8')).enabled,true);
    await writeFile(path,JSON.stringify(original));const controller=new AbortController();
    await assert.rejects(boundary.withLegacySigningMaintenanceBoundary({...f,signal:controller.signal},async owned=>{
      controller.abort();await owned.assertHeld();
    }));
    await assert.rejects(readFile(resolve(f.home,'sessions','reviewer','service.lock')),{code:'ENOENT'});
  }finally{await rm(f.home,{recursive:true,force:true});}
});
