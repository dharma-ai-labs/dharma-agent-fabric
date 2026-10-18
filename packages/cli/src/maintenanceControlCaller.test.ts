import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {runInNewContext} from 'node:vm';
import test from 'node:test';
import ts from 'typescript';

async function source(){return ts.createSourceFile('index.ts',await readFile(fileURLToPath(new URL('../src/index.ts',import.meta.url)),'utf8'),ts.ScriptTarget.Latest,true);}
function compile(text:string){return ts.transpileModule(text.replaceAll('import.meta.url',JSON.stringify(import.meta.url)),
  {compilerOptions:{target:ts.ScriptTarget.ES2023,module:ts.ModuleKind.None}}).outputText;}
async function namedFixture(){
  const ast=await source(),node=ast.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text==='namedSessionCommand');assert(node);
  const events:string[]=[],workspaceId='33333333-3333-4333-8333-333333333333';
  const registration={name:'codex-fixture',enabled:false,bindingId:'binding',identity:{workspaceId,organizationId:'org_fixture',deviceId:'device',
    endpointId:'endpoint',repositoryBindingId:'repository'}};
  class TransportFailure extends Error {diagnostic={phase:'connect',osCode:'ENOENT'};}
  const globals:Record<string,unknown>={
    namedSessionReadinessDiagnosticRequested:()=>false,currentBootstrapHostScope:()=>undefined,currentAcceptedSetupSessionScope:()=>undefined,
    currentNamedSessionChildOwner:()=>undefined,process:{platform:'linux',kill:()=>{throw Object.assign(Error('absent'),{code:'ESRCH'});}},
    namedSessionPaths:()=>({root:'/owned/sessions/codex-fixture'}),dharmaHome:()=>'/owned',
    required:(flags:Map<string,string|boolean>,key:string)=>{if(!flags.has(key))throw Error('required');return String(flags.get(key));},
    acquireNamedSessionStartupAdmission:async()=>{events.push('admitted');return async()=>{events.push('released');};},
    registry:async()=>[{workspaceId,organizationId:'org_fixture',path:'/checkout'}],readDeviceConfig:async()=>({organizationId:'org_fixture',deviceId:'device'}),
    assertBootstrapHostSource:async()=>{},repositoryRoleScope:()=>({endpointId:'endpoint',repositoryBindingId:'repository'}),
    readNamedSession:async()=>registration,assertRelayAutostartPaused:async()=>{events.push('paused-proof');},
    relayProcessState:async()=>'stopped',relaySupervisorProcessState:async()=>'stopped',
    NamedSessionTransportFailure:TransportFailure,namedSessionRequest:async()=>{throw new TransportFailure();},
    reconcileStoppedNamedSessionLock:async()=>({ok:true}),resolve,
  };
  const run=runInNewContext(compile(node.getText(ast))+'\nnamedSessionCommand',globals) as (action:string,flags:Map<string,string|boolean>)=>Promise<unknown>;
  const flags=new Map<string,string|boolean>([['name',registration.name],['workspace-id',workspaceId],['registration-sha256','a'.repeat(64)],['lock-sha256','b'.repeat(64)],['apply',true]]);
  return{run,flags,events,globals};
}

test('actual stopped-lock caller holds home-wide startup admission until reconciliation settles',{timeout:5000},async()=>{
  const f=await namedFixture();let complete:(()=>void)|undefined;
  f.globals.reconcileStoppedNamedSessionLock=async(_input:unknown,deps:{assertTopology():Promise<void>;processState(pid:number):Promise<string>})=>{
    await deps.assertTopology();assert.equal(await deps.processState(987654),'stopped');
    await new Promise<void>(r=>{complete=r;});return{ok:true};
  };
  const result=f.run('reconcile-stopped-lock',f.flags);let failure:unknown;
  void result.catch(error=>{failure=error;});
  for(let n=0;n<1000&&!complete&&!failure;n++)await new Promise(r=>setTimeout(r,1));
  if(failure)throw failure;assert(complete,'bounded fixture admission did not settle');
  assert.deepEqual(f.events,['admitted','paused-proof']);complete();await result;
  assert.deepEqual(f.events,['admitted','paused-proof','released']);
});

test('actual stopped-lock caller refuses setup/peer contexts and malformed mutation options before admission',async()=>{
  for(const kind of ['host','peer','accepted','false-apply','unknown','conflict']){
    const f=await namedFixture();
    if(kind==='host')f.globals.currentBootstrapHostScope=()=>({});
    if(kind==='peer')f.globals.currentNamedSessionChildOwner=()=>({});
    if(kind==='accepted')f.globals.currentAcceptedSetupSessionScope=()=>({});
    if(kind==='false-apply')f.flags.set('apply','false');
    if(kind==='unknown')f.flags.set('force',true);
    if(kind==='conflict')f.flags.set('dry-run',true);
    await assert.rejects(f.run('reconcile-stopped-lock',f.flags),/named_session_stopped_lock_options_invalid/);assert.deepEqual(f.events,[]);
  }
});

test('actual stopped-lock caller rejects a listening owner and unknown or denied socket failures',async()=>{
  for(const kind of ['live','denied','unknown']){
    const f=await namedFixture();
    f.globals.namedSessionRequest=kind==='live'?async()=>({ok:true}):async()=>{throw Object.assign(Error('unconfirmed'),{code:kind==='denied'?'EACCES':'ECONNRESET'});};
    f.globals.reconcileStoppedNamedSessionLock=async(_input:unknown,deps:{assertTopology():Promise<void>})=>{await deps.assertTopology();throw Error('must not mutate');};
    await assert.rejects(f.run('reconcile-stopped-lock',f.flags),/named_session_stopped_lock_unconfirmed/);
    assert.deepEqual(f.events,['admitted','paused-proof','released']);
  }
});

test('actual autostart pause is plan-first, container-only and preserves the owning mutation admission',async()=>{
  const ast=await source(),nodes:ts.IfStatement[]=[];
  const visit=(n:ts.Node)=>{if(ts.isIfStatement(n)&&n.expression.getText(ast)==="command === 'relay' && subcommand === 'autostart'")nodes.push(n);ts.forEachChild(n,visit);};visit(ast);
  assert.equal(nodes.length,1);
  for(const mode of ['plan','apply','foreign','false-apply']){
    const events:string[]=[],flags=new Map<string,string|boolean>();if(mode!=='plan')flags.set('apply',mode==='false-apply'?'false':true);
    const globals={command:'relay',subcommand:'autostart',positional:['relay','autostart','pause'],flags,dharmaHome:()=>'/owned',
      withRelayStartupMutation:async(f:()=>Promise<unknown>)=>{events.push('lock');try{return await f();}finally{events.push('unlock');}},
      inspectOwnedRelayAutostart:async()=>({backend:mode==='foreign'?'systemd-user':'container-entrypoint'}),
      stopRelayAutostart:async()=>{events.push('pause');},assertRelayAutostartPaused:async()=>{events.push('proof');}};
    const run=runInNewContext(compile('async function run(){'+nodes[0]!.getText(ast)+'}')+'\nrun',globals) as()=>Promise<unknown>;
    if(mode==='foreign'||mode==='false-apply'){await assert.rejects(run());assert(!events.includes('pause'));}
    else{await run();assert.deepEqual(events,mode==='plan'?['lock','unlock']:['lock','pause','proof','unlock']);}
  }
});
