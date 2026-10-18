import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {compileFunction} from 'node:vm';
import test from 'node:test';
import ts from 'typescript';

async function caller(overrides:Record<string,unknown>={}){
  const source=await readFile(new URL('../src/index.ts',import.meta.url),'utf8');
  const ast=ts.createSourceFile('index.ts',source,ts.ScriptTarget.Latest,true);
  const node=ast.statements.find(value=>ts.isFunctionDeclaration(value)&&value.name?.text==='namedSessionCommand')!;
  const compiled=ts.transpileModule(node.getText(ast),{compilerOptions:{target:ts.ScriptTarget.ES2023,module:ts.ModuleKind.CommonJS}});
  const calls:string[]=[],identity={organizationId:'org_fixture',deviceId:'device',workspaceId:'workspace',repositoryBindingId:'binding',endpointId:'endpoint'};
  let held=false,enabled=false;
  const deps:Record<string,unknown>={process:{platform:'linux',execPath:'/fixture/node',env:{},once:()=>{},removeListener:()=>{}},
    namedSessionReadinessDiagnosticRequested:()=>false,currentBootstrapHostScope:()=>undefined,
    currentAcceptedSetupSessionScope:()=>undefined,currentNamedSessionChildOwner:()=>undefined,
    dharmaHome:()=>'/fixture/home',required:(flags:Map<string,unknown>,name:string)=>flags.get(name),resolve,
    configPath:()=>'/fixture/home/device.json',
    namedSessionPaths:()=>({root:'/fixture/home/sessions/new-name'}),
    acquireNamedSessionStartupAdmission:async()=>{held=true;calls.push('acquire');return async()=>{assert.equal(held,true);held=false;calls.push('release');};},
    registry:async()=>[{path:'/fixture/repo',...identity}],readDeviceConfig:async()=>identity,
    assertBootstrapHostSource:async()=>{},repositoryRoleScope:()=>identity,
    readNamedSession:async()=>({identity,enabled:false}),verifyNamedSessionVisibleSkill:()=>{},
    verifyAgentFabricSkillInstallation:async()=>({}),repositorySharedReady:async()=>({}),
    namedSessionRequest:async()=>{throw Error('stopped');},
    saveNamedSession:async()=>{assert.equal(held,true);enabled=true;calls.push('enable');},
    fileURLToPath:()=>'/fixture/index.js',
    spawn:()=>{assert.equal(held,false,'parent must release before child can acquire');calls.push('spawn');return {on:()=>{},unref:()=>{}};},
    observeNamedSessionStartupChild:()=>({readFailure:()=>null,dispose:()=>calls.push('dispose')}),
    waitForNamedSessionStartup:async()=>{assert.equal(held,false);calls.push('wait');return {ok:true};},
    mkdir:async()=>{assert.equal(held,true);calls.push('mkdir');},
    openBootstrapVault:async()=>{assert.equal(held,true);calls.push('vault');throw Error('FIXTURE_VAULT_STOP');},
    namedSessionStartupPhaseError:(_phase:string,error:Error)=>error,...overrides};
  const run=compileFunction(compiled.outputText.replaceAll('import.meta.url','"file:///fixture/index.js"')+'\nreturn namedSessionCommand;',
    ['exports',...Object.keys(deps)])({},...Object.values(deps)) as (action:string,flags:Map<string,string|boolean>)=>Promise<unknown>;
  return {calls,run,enabled:()=>enabled,held:()=>held,flags:new Map<string,string|boolean>([['name','new-name'],['workspace-id','workspace'],['apply',true]])};
}

test('actual start and direct serve refuse maintenance contention before registration, spawn or vault',async()=>{
  for(const action of ['start','serve']){
    const f=await caller({acquireNamedSessionStartupAdmission:async()=>{throw Error('STARTUP_FENCED');},
      registry:async()=>{throw Error('REGISTRY_REACHED_BEFORE_FENCE');}});
    await assert.rejects(f.run(action,f.flags),/STARTUP_FENCED/);assert.deepEqual(f.calls,[]);
  }
});
test('actual start serializes disabled enablement and releases admission before child fork and wait',async()=>{
  const f=await caller();assert.deepEqual(await f.run('start',f.flags),{ok:true});
  assert.equal(f.enabled(),true);assert.equal(f.held(),false);
  assert.deepEqual(f.calls,['acquire','enable','release','spawn','wait','dispose']);
});
test('direct serve holds startup admission before private vault access and releases on failure',async()=>{
  const f=await caller();await assert.rejects(f.run('serve',f.flags),/FIXTURE_VAULT_STOP/);
  assert.deepEqual(f.calls,['acquire','mkdir','vault','release']);assert.equal(f.held(),false);
});
test('early scope failure releases startup admission without starting or touching the vault',async()=>{
  const f=await caller({registry:async()=>[]});await assert.rejects(f.run('start',f.flags),/named_session_scope_mismatch/);
  assert.deepEqual(f.calls,['acquire','release']);assert.equal(f.held(),false);
});
test('actual direct serve hands home-wide admission to its service lock before provider startup',async()=>{
  const effects:string[]=[];
  const f=await caller({openBootstrapVault:async()=>({close:async()=>{effects.push('vault-close');}}),
    acquirePidLock:async()=>{effects.push('service-lock');return async()=>{effects.push('service-release');};},
    assertNamedSessionStartupRegistration:()=>{effects.push('registration-recheck');},
    AgentFabricClient:{open:async()=>{assert.equal(f.held(),false);effects.push('provider-boundary');throw Error('FIXTURE_PROVIDER_STOP');}},
    namedSessionStartupPhaseError:(_phase:string,error:Error)=>error});
  await assert.rejects(f.run('serve',f.flags),/FIXTURE_PROVIDER_STOP/);
  assert.deepEqual(f.calls,['acquire','mkdir','release']);
  assert.deepEqual(effects,['service-lock','registration-recheck','provider-boundary','vault-close','service-release']);
});
test('a new-name start releases admission before spawn and direct child admission owns the next phase',async()=>{
  const f=await caller({readNamedSession:async()=>null});
  assert.deepEqual(await f.run('start',f.flags),{ok:true});assert.equal(f.enabled(),false);
  assert.deepEqual(f.calls,['acquire','release','spawn','wait','dispose']);
});
