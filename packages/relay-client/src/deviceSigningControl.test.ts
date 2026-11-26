import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {mkdir,readdir,rm,writeFile} from 'node:fs/promises';
import {userInfo} from 'node:os';
import {dirname,resolve} from 'node:path';
import test from 'node:test';
import {canonicalize} from '@dharma-ai-labs/agent-fabric-contracts';
import * as relay from './index.js';

type Lease={controllerInstanceId:string;processIdentityDigest:string;leaseDigest:string;assertHeld():Promise<void>};
type Input={config:{hqUrl:string;organizationId:string;deviceId:string};timeoutMs?:number;hostScope?:{signal:AbortSignal;current():Promise<boolean>}};
function api(){
  const fn=(relay as unknown as Record<string,unknown>).withDeviceSigningControl;
  assert.equal(typeof fn,'function');
  return fn as <T>(input:Input,work:(lease:Lease)=>Promise<T>)=>Promise<T>;
}
const input=()=>({config:{hqUrl:'https://www.dharma-ai.io',organizationId:'org_fixture'+randomUUID().replaceAll('-',''),deviceId:randomUUID()}});

test('device signing control is exclusive across independent flows and reentrant only in its live async owner',async()=>{
  const run=api(),scope=input();let entered!:()=>void,finish!:()=>void;
  const started=new Promise<void>(r=>{entered=r;}),stop=new Promise<void>(r=>{finish=r;});
  let stale!:Lease;
  const held=run(scope,async lease=>{
    stale=lease;await lease.assertHeld();entered();
    const nested=await run(scope,async inner=>{assert.equal(inner.controllerInstanceId,lease.controllerInstanceId);await inner.assertHeld();return 'nested';});
    assert.equal(nested,'nested');await stop;
  });
  await started;
  await run({...scope,config:{...scope.config,deviceId:randomUUID()}},async lease=>{await lease.assertHeld();});
  await assert.rejects(run({...scope,timeoutMs:50},async()=>assert.fail('competing owner admitted')),/connection_anchor_busy/);
  finish();await held;await assert.rejects(stale.assertHeld(),/device_signing_control_unavailable/);
  await run(scope,async lease=>{assert.notEqual(lease.controllerInstanceId,stale.controllerInstanceId);await lease.assertHeld();});
});

test('cancelled or changed authority cannot enter signing control or retain it after work settles',async()=>{
  const run=api(),scope=input(),controller=new AbortController();let allowed=true,called=0;
  controller.abort();
  await assert.rejects(run({...scope,hostScope:{signal:controller.signal,current:async()=>true}},async()=>{called++;}));
  assert.equal(called,0);
  const live=new AbortController();
  await assert.rejects(run({...scope,hostScope:{signal:live.signal,current:async()=>allowed}},async lease=>{
    assert.match(lease.processIdentityDigest,/^sha256:[a-f0-9]{64}$/);assert.match(lease.leaseDigest,/^sha256:[a-f0-9]{64}$/);
    allowed=false;await assert.rejects(lease.assertHeld());
  }));
  await run(scope,async lease=>{await lease.assertHeld();});
});

test('expired async context cannot silently reenter a released control lease',async()=>{
  const run=api(),scope=input();let later!:()=>void;let detached!:Promise<unknown>;
  await run(scope,async()=>{detached=new Promise<void>(r=>{later=r;}).then(()=>run(scope,async()=>assert.fail('released context reused')));});
  later();await assert.rejects(detached,/device_signing_control_unavailable/);
});

test('a NUL lock left by a hard reset at the real signing path no longer blocks the device',async t=>{
  const run=api(),scope=input(),user=userInfo();
  const hash=(v:unknown)=>'sha256:'+createHash('sha256').update(canonicalize(v)).digest('hex');
  const userHash=hash({home:user.homedir,user:user.username}).slice(7);
  const namespace=hash({origin:scope.config.hqUrl,organizationId:scope.config.organizationId,deviceId:scope.config.deviceId,user:userHash});
  const root=process.platform==='win32'?resolve(user.homedir,'AppData','Local','Temp'):'/tmp';
  const path=resolve(root,'dharma-signing-controls-'+userHash.slice(0,32),namespace.slice(7)+'.lock');
  await mkdir(dirname(path),{recursive:true,mode:0o700});
  await writeFile(path,Buffer.alloc(5));
  t.after(()=>rm(path,{force:true}));
  assert.equal(await run(scope,async lease=>{await lease.assertHeld();return 'signed';}),'signed');
  assert.equal((await readdir(dirname(path))).some(name=>name.startsWith(namespace.slice(7))),false);
});

// #511: one relay process serves several workspace loops. Their waits for the device signing control
// queue inside the process, so a sibling's long hold is a wait in line and not a connection_anchor_busy.
const settle=(value:Promise<unknown>)=>value.then(result=>result,(error:Error)=>error.message);
const gate=()=>{let open!:()=>void;const promise=new Promise<void>(accept=>{open=accept;});return {promise,open};};
const delay=(ms:number)=>new Promise(accept=>setTimeout(accept,ms));

test('an in-process waiter queues behind a hold longer than the 10 s lock wait and is admitted after it',async()=>{
  const run=api(),scope=input(),held=gate(),released=gate();let holding=false;const order:string[]=[];
  const holder=run(scope,async()=>{holding=true;held.open();await released.promise;holding=false;order.push('holder');});
  await held.promise;
  const waiter=settle(run(scope,async lease=>{assert.equal(holding,false);await lease.assertHeld();order.push('waiter');return 'admitted';}));
  await delay(10_500);
  released.open();await holder;
  assert.equal(await waiter,'admitted');
  assert.deepEqual(order,['holder','waiter']);
});

test('in-process waiters enter signing control one at a time, in the order they arrived',async()=>{
  const run=api(),scope=input(),held=gate(),released=gate();let inside=0;const order:string[]=[];
  const holder=run(scope,async()=>{held.open();await released.promise;});
  await held.promise;
  const waiters:Promise<unknown>[]=[];
  for(const name of ['first','second','third']){
    waiters.push(settle(run(scope,async()=>{assert.equal(++inside,1);order.push(name);await delay(30);inside--;return name;})));
    await delay(40);
  }
  released.open();await holder;
  assert.deepEqual(await Promise.all(waiters),['first','second','third']);
  assert.deepEqual(order,['first','second','third']);
});

test('control: a waiter with an explicit timeout still gives up, and the waiter behind it keeps its place',async()=>{
  const run=api(),scope=input(),held=gate(),released=gate();
  const holder=run(scope,async()=>{held.open();await released.promise;});
  await held.promise;
  const impatient=settle(run({...scope,timeoutMs:50},async()=>assert.fail('admitted while held')));
  const patient=settle(run(scope,async()=>'admitted'));
  assert.equal(await impatient,'connection_anchor_busy');
  released.open();await holder;
  assert.equal(await patient,'admitted');
});

test('control: a waiter whose host scope is withdrawn leaves the line at once without holding up the rest',async()=>{
  const run=api(),scope=input(),held=gate(),released=gate(),controller=new AbortController();
  const holder=run(scope,async()=>{held.open();await released.promise;});
  await held.promise;
  const withdrawn=settle(run({...scope,hostScope:{signal:controller.signal,current:async()=>!controller.signal.aborted}},
    async()=>assert.fail('withdrawn waiter admitted')));
  const behind=settle(run(scope,async()=>'admitted'));
  await delay(20);const started=Date.now();controller.abort();
  assert.equal(await withdrawn,'relay_host_scope_unavailable');
  assert.ok(Date.now()-started<2_000);
  released.open();await holder;
  assert.equal(await behind,'admitted');
});

// The child holds the same control from another process, through the real signing-control lock file.
function childHolder(scope:Input){
  const module=new URL('./index.js',import.meta.url).href;
  const child=spawn(process.execPath,['--input-type=module','-e',`import {withDeviceSigningControl} from ${JSON.stringify(module)};
await withDeviceSigningControl({config:JSON.parse(process.argv[1])},async()=>{process.stdout.write('held;');
await new Promise(accept=>process.stdin.once('data',accept));});process.stdout.write('released;');`,JSON.stringify(scope.config)],
  {stdio:['pipe','pipe','inherit'],windowsHide:true});
  let output='';const waiters:Array<()=>void>=[];
  child.stdout.on('data',chunk=>{output+=chunk;for(const wake of waiters.splice(0))wake();});
  const saw=async(text:string)=>{while(!output.includes(text))await new Promise<void>(wake=>waiters.push(wake));};
  const exited=new Promise<number|null>(accept=>child.once('exit',code=>accept(code)));
  return {child,saw,exited};
}

test('control: a holder in another process still excludes this one, and only for the lock wait',async()=>{
  const run=api(),scope=input(),other=childHolder(scope);
  try{
    await other.saw('held');
    assert.equal(await settle(run({...scope,timeoutMs:300},async()=>assert.fail('admitted while another process holds'))),
      'connection_anchor_busy');
    const waiting=settle(run(scope,async()=>'admitted'));
    await delay(200);other.child.stdin!.end('go');await other.saw('released');
    assert.equal(await waiting,'admitted');
    assert.equal(await other.exited,0);
  }finally{other.child.kill();}
});

test('control: a lock left by a killed holder process is still recovered',async()=>{
  const run=api(),scope=input(),other=childHolder(scope);
  try{await other.saw('held');}finally{other.child.kill('SIGKILL');}
  await other.exited;
  assert.equal(await run(scope,async lease=>{await lease.assertHeld();return 'signed';}),'signed');
});

// Review round 1 on #511: a relay loop that is told to stop leaves the line at once. Relay loops have no host
// scope, so their stop signal reaches the line through withDeviceSigningLineSignal.
function lineSignal(){
  const fn=(relay as unknown as Record<string,unknown>).withDeviceSigningLineSignal;
  assert.equal(typeof fn,'function','withDeviceSigningLineSignal is exported');
  return fn as <T>(signal:AbortSignal,work:()=>Promise<T>)=>Promise<T>;
}

test('a queued waiter whose relay loop stops leaves the line at once, never runs its work, and keeps the rest in order',async()=>{
  const run=api(),inLoop=lineSignal(),scope=input(),held=gate(),released=gate(),loop=new AbortController();let ran=0;
  const holder=run(scope,async()=>{held.open();await released.promise;});
  await held.promise;
  const stopped=inLoop(loop.signal,()=>run(scope,async()=>{ran++;})).then(()=>'admitted',(error:Error)=>error.name);
  const behind=settle(run(scope,async()=>'admitted'));
  await delay(20);const started=Date.now();loop.abort();
  assert.equal(await stopped,'AbortError');
  assert.ok(Date.now()-started<2_000);
  released.open();await holder;
  assert.equal(await behind,'admitted');
  assert.equal(ran,0);
});

test('a waiter whose relay loop has already stopped does not join a busy line',async()=>{
  const run=api(),inLoop=lineSignal(),scope=input(),held=gate(),released=gate(),loop=new AbortController();let ran=0;
  const holder=run(scope,async()=>{held.open();await released.promise;});
  await held.promise;loop.abort();
  const started=Date.now();
  assert.equal(await inLoop(loop.signal,()=>run(scope,async()=>{ran++;})).then(()=>'admitted',(error:Error)=>error.name),'AbortError');
  assert.ok(Date.now()-started<2_000);
  released.open();await holder;
  assert.equal(ran,0);
});

test('control: a stopping loop with nobody ahead of it still signs, as before the line existed',async()=>{
  const run=api(),inLoop=lineSignal(),scope=input(),loop=new AbortController();loop.abort();
  assert.equal(await inLoop(loop.signal,()=>run(scope,async lease=>{await lease.assertHeld();return 'signed';})),'signed');
});
