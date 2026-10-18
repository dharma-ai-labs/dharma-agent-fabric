import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdir,mkdtemp,readFile,realpath,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {upgradeRelayRuntime} from './relayRuntimeUpgrade.js';
import {validateContract} from '@dharma-ai-labs/agent-fabric-contracts';
import {commandExitCode} from './index.js';

const modulePath='./relaySigningMaintenanceUpgrade.js';
const hash=(value:string)=>'sha256:'+createHash('sha256').update(value).digest('hex');
const contents=(version:string)=>({shell:`#!/bin/sh\n# verified ${version}\n`,windows:`@echo off\r\nrem verified ${version}\r\n`});
async function fixture(){
  const root=await realpath(await mkdtemp(join(tmpdir(),'relay-signing-maintenance-')));
  const home=join(root,'home'),workspace=join(root,'repo');
  await mkdir(join(workspace,'.dharma','bin'),{recursive:true});await mkdir(join(home,'relay'),{recursive:true});
  const input={home,workspace,organizationId:'org_fixture',deviceId:'11111111-1111-4111-8111-111111111111',
    workspaceId:'22222222-2222-4222-8222-222222222222',version:'0.2.211',trustGeneration:2};
  let version='0.2.207';const calls:string[]=[];const old=contents(version);
  for(const[name,value]of Object.entries({dharma:old.shell,'dharma.cmd':old.windows}))await writeFile(join(workspace,'.dharma','bin',name),value);
  const deps={assertStopped:async()=>{calls.push('stopped');},assertNamedDisabled:async()=>{calls.push('named-disabled');},
    assertStartupPaused:async()=>{calls.push('paused');},
    inspectStartup:async()=>({version,workspace}),configureStartup:async(next:string)=>{calls.push('configure:'+next);version=next;},
    stageStartup:async(next:string)=>{calls.push('stage:'+next);version=next;},
    launcherContents:contents,verifyPriorLaunchers:async(v:string,c:typeof old)=>JSON.stringify(c)===JSON.stringify(contents(v)),
    verifyRecoveryLaunchers:async(v:string,c:typeof old)=>JSON.stringify(c)===JSON.stringify(contents(v)),
    start:async()=>{calls.push('start');},stop:async()=>{calls.push('stop');},
    verify:async(v:string)=>{calls.push('verify:'+v);},assertRecoveredTrust:async(generation:number)=>{calls.push('trust:'+generation);}};
  return{input,deps,calls,old,currentVersion:()=>version};
}

test('expired-signing upgrade stages offline without inventing a successful poll or starting a receiver',async()=>{
  const {upgradeRelayForSigningMaintenance}=await import(modulePath);const f=await fixture();
  const result=await upgradeRelayForSigningMaintenance({...f.input,dryRun:false},f.deps);
  assert.equal(result.state,'staged');assert.equal(result.upgradeComplete,false);assert.equal(result.ready,false);
  assert.equal(result.runtimeObservation,'not_performed');assert.equal(result.nativeContinuationAuthorized,false);
  assert.equal(f.currentVersion(),f.input.version);assert(!f.calls.includes('start'));assert(!f.calls.some(v=>v.startsWith('trust:')||v.startsWith('verify:')));
  assert(f.calls.indexOf('stage:0.2.207')<f.calls.indexOf('stage:0.2.211'));
  await assert.rejects(readFile(join(f.input.home,'relay','runtime-upgrade.json')),/ENOENT/);
});

test('the default plan and repeated staging preserve public bytes and never start a receiver',async()=>{
  const {upgradeRelayForSigningMaintenance}=await import(modulePath);const f=await fixture();
  const plan=await upgradeRelayForSigningMaintenance({...f.input,dryRun:true},f.deps);assert.equal(plan.state,'planned');
  assert.equal(f.currentVersion(),'0.2.207');assert(!f.calls.some(v=>v.startsWith('configure:')||v.startsWith('stage:')));
  await assert.rejects(readFile(join(f.input.home,'relay','signing-maintenance-upgrade.json')),/ENOENT/);
  const first=await upgradeRelayForSigningMaintenance(f.input,f.deps);
  const bytes=await readFile(join(f.input.home,'relay','signing-maintenance-upgrade.json'),'utf8');f.calls.length=0;
  const second=await upgradeRelayForSigningMaintenance(f.input,f.deps);
  assert.equal(second.upgradeId,first.upgradeId);assert.equal(second.state,'staged');
  assert.equal(await readFile(join(f.input.home,'relay','signing-maintenance-upgrade.json'),'utf8'),bytes);
  assert(!f.calls.some(v=>v==='start'||v.startsWith('configure:')||v.startsWith('stage:')));
});

test('a failed legacy rollback cannot be erased or retried by a new release',async()=>{
  const {upgradeRelayForSigningMaintenance}=await import(modulePath);const f=await fixture();
  const legacy=await upgradeRelayRuntime({...f.input,version:'0.2.209'}, {...f.deps,verify:async()=>{throw Error('expired signer');}});
  assert.equal(legacy.state,'rollback_failed');assert.equal(f.currentVersion(),'0.2.207');
  const path=join(f.input.home,'relay','runtime-upgrade.json'),bytes=await readFile(path,'utf8');f.calls.length=0;
  await assert.rejects(upgradeRelayForSigningMaintenance(f.input,f.deps),/prior_failure_custody_required/);
  await assert.rejects(upgradeRelayForSigningMaintenance({...f.input,previousUpgradeSha256:hash(bytes+'tampered')},f.deps),/prior_failure_custody_required/);
  assert.equal(await readFile(path,'utf8'),bytes);assert(!f.calls.some(v=>v.startsWith('configure:')||v.startsWith('stage:')||v==='start'));
  const staged=await upgradeRelayForSigningMaintenance({...f.input,previousUpgradeSha256:hash(bytes)},f.deps);
  assert.equal(staged.state,'staged');assert.equal(await readFile(path,'utf8'),bytes);
  assert.equal(await readFile(join(f.input.home,'relay',staged.priorJournalArchive),'utf8'),bytes);
});

test('changed or half-restored failed journals are refused before launcher or startup mutation',async()=>{
  const {upgradeRelayForSigningMaintenance}=await import(modulePath);
  for(const change of['launcher','context','state']){
    const f=await fixture();await upgradeRelayRuntime({...f.input,version:'0.2.209'},{...f.deps,verify:async()=>{throw Error('offline');}});
    const path=join(f.input.home,'relay','runtime-upgrade.json');let bytes=await readFile(path,'utf8');
    if(change==='launcher')await writeFile(join(f.input.workspace,'.dharma','bin','dharma'),contents('0.2.209').shell);
    if(change==='state'){const value=JSON.parse(bytes);value.state='installed';bytes=JSON.stringify(value);await writeFile(path,bytes,{mode:0o600});}
    f.calls.length=0;
    await assert.rejects(upgradeRelayForSigningMaintenance({...f.input,previousUpgradeSha256:hash(bytes)},
      {...f.deps,...(change==='context'?{inspectStartup:async()=>({version:'0.2.207',workspace:f.input.workspace,codexHome:'/different/profile'})}:{})}),
    /prior_failure_custody_required|launcher_conflict|context_conflict/);
    assert.equal(await readFile(path,'utf8'),bytes);assert(!f.calls.some(v=>v.startsWith('configure:')||v.startsWith('stage:')||v==='start'));
  }
});

test('finish requires recovered trust and a genuine current-version receiver verification',async()=>{
  const {upgradeRelayForSigningMaintenance}=await import(modulePath);const f=await fixture();
  await upgradeRelayForSigningMaintenance(f.input,f.deps);f.calls.length=0;
  await assert.rejects(upgradeRelayForSigningMaintenance({...f.input,finish:true},{...f.deps,assertRecoveredTrust:async()=>{throw Error('trust still expired');}}),/trust still expired/);
  assert(!f.calls.includes('start'));
  const result=await upgradeRelayForSigningMaintenance({...f.input,finish:true},f.deps);
  assert.equal(result.state,'completed');assert.equal(result.upgradeComplete,true);assert.equal(result.ready,false);
  assert(f.calls.indexOf('trust:2')<f.calls.indexOf('start'));assert(f.calls.includes('verify:0.2.211'));
  const ordinary=JSON.parse(await readFile(join(f.input.home,'relay','runtime-upgrade.json'),'utf8'));
  assert.equal(ordinary.state,'completed');assert.equal(ordinary.version,f.input.version);
});

test('a failed finish preserves its attempt and cannot automatically resume or restart old expired services',async()=>{
  const {upgradeRelayForSigningMaintenance}=await import(modulePath);const f=await fixture();
  await upgradeRelayForSigningMaintenance(f.input,f.deps);f.calls.length=0;
  const failed=await upgradeRelayForSigningMaintenance({...f.input,finish:true},{...f.deps,verify:async()=>{throw Error('no current poll');}});
  assert.equal(failed.state,'finish_failed');assert.equal(failed.upgradeComplete,false);
  assert.equal(f.calls.filter(v=>v==='start').length,1);assert.equal(f.calls.filter(v=>v==='stop').length,1);
  await assert.rejects(upgradeRelayForSigningMaintenance({...f.input,finish:true},f.deps),/reconciliation_required/);
  assert.equal(f.calls.filter(v=>v==='start').length,1);
});

test('staging rejects active or enabled named sessions and never removes old service locks',async()=>{
  const {upgradeRelayForSigningMaintenance}=await import(modulePath);
  for(const boundary of['assertStopped','assertNamedDisabled']as const){const f=await fixture();
    await assert.rejects(upgradeRelayForSigningMaintenance(f.input,{...f.deps,[boundary]:async()=>{throw Error('not quiescent');}}),/not quiescent/);
    assert(!f.calls.some(v=>v==='start'||v.startsWith('configure:')||v.startsWith('stage:')));
    assert.equal(await readFile(join(f.input.workspace,'.dharma','bin','dharma'),'utf8'),f.old.shell);
  }
});

test('staging failure restores verified public files without opening protected stores or starting the old relay',async()=>{
  const {upgradeRelayForSigningMaintenance}=await import(modulePath);const f=await fixture();let failed=false;
  const result=await upgradeRelayForSigningMaintenance(f.input,{...f.deps,stageStartup:async(v:string)=>{
    if(!failed){failed=true;throw Error('configuration write failed');}return f.deps.stageStartup(v);}});
  assert.equal(result.state,'staging_reverted');assert.equal(result.upgradeComplete,false);
  assert.equal(f.currentVersion(),'0.2.207');assert.equal(await readFile(join(f.input.workspace,'.dharma','bin','dharma'),'utf8'),f.old.shell);
  assert(!f.calls.includes('start'));assert(!f.calls.some(v=>v.startsWith('trust:')));
});

test('stage and finish receipts and the persistent journal match their bounded contracts',async()=>{
  const {upgradeRelayForSigningMaintenance}=await import(modulePath);const f=await fixture();
  const schemaRoot=join(import.meta.dirname,'schemas');
  const staged=await upgradeRelayForSigningMaintenance(f.input,f.deps);
  const journal=JSON.parse(await readFile(join(f.input.home,'relay','signing-maintenance-upgrade.json'),'utf8'));
  assert.equal((await validateContract(schemaRoot,'https://schemas.dharma-ai.io/local-signing-maintenance-upgrade/v1',staged)).ok,true);
  assert.equal((await validateContract(schemaRoot,'https://schemas.dharma-ai.io/local-signing-maintenance-upgrade-journal/v1',journal)).ok,true);
  assert.equal((await validateContract(schemaRoot,'https://schemas.dharma-ai.io/local-signing-maintenance-upgrade/v1',{...staged,upgradeComplete:true})).ok,false);
  assert.equal((await validateContract(schemaRoot,'https://schemas.dharma-ai.io/local-signing-maintenance-upgrade-journal/v1',{...journal,password:'SYNTHETIC_FORBIDDEN'})).ok,false);
  const completed=await upgradeRelayForSigningMaintenance({...f.input,finish:true},f.deps);
  assert.equal((await validateContract(schemaRoot,'https://schemas.dharma-ai.io/local-signing-maintenance-upgrade/v1',completed)).ok,true);
});

test('journal, launcher and original-history changes prevent finish before trust access or service start',async()=>{
  const {upgradeRelayForSigningMaintenance}=await import(modulePath);
  for(const change of['journal','launcher','legacy']){
    const f=await fixture();await upgradeRelayForSigningMaintenance(f.input,f.deps);
    if(change==='journal'){
      const path=join(f.input.home,'relay','signing-maintenance-upgrade.json');const body=JSON.parse(await readFile(path,'utf8'));
      body.deviceId='33333333-3333-4333-8333-333333333333';await writeFile(path,JSON.stringify(body),{mode:0o600});
    }else if(change==='launcher')await writeFile(join(f.input.workspace,'.dharma','bin','dharma'),contents('0.2.209').shell);
    else await writeFile(join(f.input.home,'relay','runtime-upgrade.json'),'{}',{mode:0o600});
    f.calls.length=0;await assert.rejects(upgradeRelayForSigningMaintenance({...f.input,finish:true},f.deps),/journal_unavailable|launcher_conflict|prior_journal_changed/);
    assert(!f.calls.some(v=>v==='start'||v.startsWith('trust:')));
  }
});

test('staging exit status cannot relabel an unfinished or failed finish as success',()=>{
  const base={schema:'dharma.local-signing-maintenance-upgrade/v1',ready:false,nativeContinuationAuthorized:false};
  const stage=['relay','upgrade','--stage-signing-maintenance','--apply'];
  const finish=['relay','upgrade','--finish-signing-maintenance','--apply'];
  assert.equal(commandExitCode(stage,{...base,state:'staged',upgradeComplete:false}),0);
  assert.equal(commandExitCode(finish,{...base,state:'staged',upgradeComplete:false}),2);
  assert.equal(commandExitCode(finish,{...base,state:'completed',upgradeComplete:true}),0);
  for(const state of['staging_failed','finish_failed','staging_reverted']){
    assert.equal(commandExitCode(stage,{...base,state,upgradeComplete:false}),2);
    assert.equal(commandExitCode(finish,{...base,state,upgradeComplete:false}),2);
  }
  assert.equal(commandExitCode(stage,{...base,state:'staged',upgradeComplete:false,ready:true}),2);
});

test('startup is paused and independently verified before either launcher can change',async()=>{
  const {upgradeRelayForSigningMaintenance}=await import(modulePath);const f=await fixture();
  const result=await upgradeRelayForSigningMaintenance(f.input,{...f.deps,
    stageStartup:async(v:string)=>{assert.equal(await readFile(join(f.input.workspace,'.dharma','bin','dharma'),'utf8'),
      v==='0.2.207'?f.old.shell:contents(f.input.version).shell);await f.deps.stageStartup(v);},
    assertStartupPaused:async()=>{f.calls.push('paused');assert(!f.calls.includes('start'));}});
  assert.equal(result.state,'staged');
  const firstPause=f.calls.indexOf('paused'),writeTarget=f.calls.indexOf('stage:0.2.211');
  assert(firstPause>=0&&firstPause<writeTarget);
});

test('unconfirmed pause cannot mutate launchers or open protected trust',async()=>{
  const {upgradeRelayForSigningMaintenance}=await import(modulePath);const f=await fixture();
  const result=await upgradeRelayForSigningMaintenance(f.input,{...f.deps,assertStartupPaused:async()=>{throw Error('pause not acknowledged');}});
  assert.equal(result.state,'staging_failed');assert.equal(await readFile(join(f.input.workspace,'.dharma','bin','dharma'),'utf8'),f.old.shell);
  assert(!f.calls.includes('start'));assert(!f.calls.some(v=>v.startsWith('trust:')));
});
