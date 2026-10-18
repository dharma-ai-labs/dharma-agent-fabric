import assert from 'node:assert/strict';
import {mkdir,mkdtemp,realpath,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';
import test from 'node:test';
import {commandExitCode,run,relayProcessState,formatCommandOutput,deviceTrustMaintenanceProcessState} from './index.js';

const id=(n:number)=>`dc000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
test('maintenance completion signaling cannot turn an unfinished component or native readiness into success',()=>{
  const base={schema:'dharma.device-signing-maintenance-controller-progress/v1',nativeContinuationAuthorized:false,ready:false};
  assert.equal(commandExitCode(['signing-recovery','--apply'],{...base,ok:false,state:'unconfirmed'}),2);
  assert.equal(commandExitCode(['signing-recovery','--apply'],{...base,ok:true,planned:true}),2);
  assert.equal(commandExitCode(['signing-recovery','--apply'],{...base,ok:true,progress:{state:'trust_installed',clientTrustInstalled:true}}),0);
  assert.equal(commandExitCode(['signing-recovery'],{...base,ok:true,planned:true}),0);
  const text=formatCommandOutput({...base,ok:true,planned:true});
  assert.equal(text.trim().split('\n').length,1);assert.equal(JSON.parse(text).nativeContinuationAuthorized,false);
});

test('official maintenance plan is grant-free and needs no protected-store, provider or active native session',async()=>{
  const root=await realpath(await mkdtemp(resolve(tmpdir(),'mc-'))),prior=process.env.DHARMA_HOME;
  try{
    process.env.DHARMA_HOME=root;
    const workspace={organizationId:'org_fixture',workspaceId:id(1),repositoryBindingId:id(2),repositoryRemoteHash:'sha256:'+'a'.repeat(64),path:resolve(root,'checkout')};
    const identity={organizationId:'org_fixture',workspaceId:id(1),repositoryBindingId:id(2),deviceId:id(3),membershipId:id(4),endpointId:id(5),provider:'codex'};
    await mkdir(resolve(root,'sessions','codex-reviewer'),{recursive:true});
    await writeFile(resolve(root,'device.json'),JSON.stringify({schema:'dharma.device-config/v1',hqUrl:'https://www.dharma-ai.io',
      organizationId:'org_fixture',deviceId:id(3),deviceName:'Synthetic maintenance fixture',installationId:id(7),setupClaimReference:id(8),setupClaimRepositoryFingerprint:workspace.repositoryRemoteHash,
      platform:'linux',publicKeyEd25519:Buffer.alloc(32,7).toString('base64url'),serverPublicKeyEd25519:Buffer.alloc(32,8).toString('base64url'),
      relayUrl:'wss://relay.fixture.invalid',enrolledAt:'2026-10-01T00:00:00.000Z'}));
    await mkdir(resolve(root,'registry'));await writeFile(resolve(root,'registry','workspaces.json'),JSON.stringify([workspace]));
    await writeFile(resolve(root,'sessions','codex-reviewer','registration.json'),JSON.stringify({schema:'dharma.named-session/v1',name:'codex-reviewer',
      bindingId:id(6),identity,maximumCostCents:1000,maximumTurnCostCents:25,enabled:false}));
    const result=await run(['signing-recovery','--name','codex-reviewer','--workspace-id',id(1)]) as Record<string,unknown>;
    assert.equal(result.planned,true);assert.equal(result.protectedStoreQualified,false);assert.equal(result.currentSourceVerified,false);
    assert.equal(result.nativeContinuationAuthorized,false);assert.equal(result.ready,false);
    await mkdir(resolve(root,'relay'));await writeFile(resolve(root,'relay','relay.pid'),String(process.pid));
    assert.equal(await deviceTrustMaintenanceProcessState(root,'codex-reviewer'),'running');
    await writeFile(resolve(root,'relay','relay.pid'),'invalid');
    assert.equal(await deviceTrustMaintenanceProcessState(root,'codex-reviewer'),'unknown');
    await assert.rejects(run(['signing-recovery','--name','codex-reviewer','--workspace-id',id(1),'--grant','SYNTHETIC_NOT_SECRET']),/maintenance_options_invalid/);
  }finally{if(prior===undefined)delete process.env.DHARMA_HOME;else process.env.DHARMA_HOME=prior;await rm(root,{recursive:true,force:true});}
});

test('unknown PID-inspection errors cannot establish stopped runtime custody',async t=>{
  const root=await mkdtemp(resolve(tmpdir(),'fabric-maintenance-pid-'));
  try{
    await mkdir(resolve(root,'relay'));await writeFile(resolve(root,'relay','relay.pid'),'12345\n');
    t.mock.method(process,'kill',()=>{throw Object.assign(Error('synthetic inspection failure'),{code:'EACCES'});});
    assert.equal(await relayProcessState(root),'unknown');
  }finally{t.mock.restoreAll();await rm(root,{recursive:true,force:true});}
});
