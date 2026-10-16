import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import net, {type Socket} from 'node:net';
import {syncBuiltinESMExports} from 'node:module';
import test, {mock, type TestContext} from 'node:test';
import {namedSessionRequest} from './namedSessionService.js';
import {commandExitCode} from './index.js';
import {randomUUID} from 'node:crypto';
import {join} from 'node:path';
import {validateContract} from '@dharma-ai-labs/agent-fabric-contracts';
import {NamedSessionTransportFailure, namedSessionReadinessDiagnostic,
  namedSessionReadinessDiagnosticRequested} from './namedSessionTransportDiagnostic.js';

class FixtureSocket extends EventEmitter {
  readonly sent: string[] = [];
  timeoutMs = 0;
  destroyed = false;
  setTimeout(value: number) {this.timeoutMs = value; return this;}
  write(value: string) {this.sent.push(value); return true;}
  end() {return this;}
  destroy() {this.destroyed = true; return this;}
}

function fixture(t: TestContext, diagnostic = true) {
  const socket = new FixtureSocket();
  const factory = mock.method(net, 'createConnection', () => socket as unknown as Socket);
  syncBuiltinESMExports();
  t.after(() => {factory.mock.restore(); syncBuiltinESMExports();});
  const home = process.platform === 'win32' ? 'C:/dhr-ipc-fixture' : '/tmp/dhr-ipc-fixture';
  // The initial regression runs against the legacy three-argument implementation.
  const promise = Reflect.apply(namedSessionRequest, undefined,
    [home, 'owner', {action:'readiness'}, ...(diagnostic ? [{diagnostic:true}] : [])]) as Promise<Record<string, unknown>>;
  return {socket, promise, factory};
}

function diagnostic(reason: string, phase: string, osCode: string | null = null, remoteCode: string | null = null) {
  return {schema:'dharma.named-session-transport-diagnostic/v1',phase,reason,osCode,remoteCode};
}

for (const [code, reason] of [['ENOENT','socket_missing'],['ECONNREFUSED','connection_refused'],
  ['EACCES','permission_denied'],['EPERM','permission_denied'],['ECONNRESET','connection_reset']] as const) {
  test('diagnostic distinguishes '+code+' without returning private error details', async t => {
    const {socket,promise} = fixture(t);
    const failure = assert.rejects(promise, error => {
      assert(error instanceof Error);
      assert.equal(error.message,'named_session_unavailable');
      assert.deepEqual((error as Error & {diagnostic?:unknown}).diagnostic, diagnostic(reason,'connect',code));
      assert(!JSON.stringify(error).includes('PRIVATE_FIXTURE'));
      assert(!error.stack?.includes('PRIVATE_FIXTURE'));
      return true;
    });
    socket.emit('error',Object.assign(new Error('PRIVATE_FIXTURE'),{code,path:'PRIVATE_FIXTURE',syscall:'PRIVATE_FIXTURE'}));
    await failure;
    assert.equal(socket.destroyed,true);
  });
}

test('diagnostic does not modify the existing request or successful response', async t => {
  const {socket,promise} = fixture(t);
  socket.emit('connect');
  assert.deepEqual(socket.sent,['{"action":"readiness"}\n']);
  assert.equal(socket.timeoutMs,30000);
  const response = {ok:true,bindingId:'public-fixture'};
  socket.emit('data',Buffer.from(JSON.stringify(response)+'\n'));
  assert.deepEqual(await promise,response);
});

test('timeout and close remain distinct from connection refusal', async t => {
  const {socket,promise} = fixture(t);
  const failure = assert.rejects(promise,error => {
    assert.deepEqual((error as Error & {diagnostic?:unknown}).diagnostic,diagnostic('timeout','response'));
    return true;
  });
  socket.emit('connect');socket.emit('timeout');await failure;
});

test('close before any response is explicit without pretending the service exited', async t => {
  const {socket,promise} = fixture(t);
  const failure = assert.rejects(promise,error => {
    assert.deepEqual((error as Error & {diagnostic?:unknown}).diagnostic,diagnostic('connection_closed','response'));
    return true;
  });
  socket.emit('connect');socket.emit('close');await failure;
});

for (const [bytes,reason,phase] of [[Buffer.from('PRIVATE_FIXTURE\n'),'malformed_response','decode'],
  [Buffer.alloc(50001),'response_too_large','response']] as const) {
  test('diagnostic safely classifies '+reason, async t => {
    const {socket,promise} = fixture(t);
    const failure=assert.rejects(promise,error=>{
      assert.deepEqual((error as Error & {diagnostic?:unknown}).diagnostic,diagnostic(reason,phase));
      assert(!JSON.stringify(error).includes('PRIVATE_FIXTURE'));return true;
    });
    socket.emit('connect');socket.emit('data',bytes);await failure;
  });
}

for (const code of ['named_session_stopped','vault_api_unavailable','PRIVATE_FIXTURE']) {
  test('remote failure classification is closed for '+code, async t=>{
    const {socket,promise}=fixture(t);
    const failure=assert.rejects(promise,error=>{
      assert.deepEqual((error as Error & {diagnostic?:unknown}).diagnostic,
        diagnostic('remote_rejected','remote',null,code==='PRIVATE_FIXTURE'?null:code));
      assert(!JSON.stringify(error).includes('PRIVATE_FIXTURE'));return true;
    });
    socket.emit('connect');socket.emit('data',Buffer.from(JSON.stringify({ok:false,code,private:'PRIVATE_FIXTURE'})+'\n'));
    await failure;
  });
}

test('legacy callers keep the generic unavailable error without diagnostic fields', async t=>{
  const {socket,promise}=fixture(t,false);
  const failure=assert.rejects(promise,error=>{
    assert(error instanceof Error);assert.equal(error.message,'named_session_unavailable');
    assert.equal((error as Error & {diagnostic?:unknown}).diagnostic,undefined);return true;
  });
  socket.emit('error',Object.assign(new Error('PRIVATE_FIXTURE'),{code:'EACCES'}));await failure;
});

test('a failed readiness diagnostic cannot exit successfully',()=>{
  assert.equal(commandExitCode(['sessions','readiness','--diagnostic'],
    {ok:false,schema:'dharma.named-session-readiness-diagnostic/v1'}),2);
});

test('diagnostic success exit requires the actual readiness response, not an arbitrary ok flag',()=>{
  assert.equal(commandExitCode(['sessions','readiness','--diagnostic'],{ok:true}),2);
  assert.equal(commandExitCode(['sessions','readiness','--diagnostic'],
    {ok:true,schema:'dharma.named-session-readiness/v1'}),0);
});

test('diagnostic option is confined to readiness and cannot be combined with write options',()=>{
  const valid = new Map<string,string | boolean>([['name','owner'],['workspace-id',randomUUID()],['diagnostic',true]]);
  assert.equal(namedSessionReadinessDiagnosticRequested('readiness',valid),true);
  assert.equal(namedSessionReadinessDiagnosticRequested('start',new Map([['apply',true]])),false);
  for (const action of ['start','serve','work','stop','ask','read','quiesce','resume','audit']) {
    assert.throws(()=>namedSessionReadinessDiagnosticRequested(action,valid),/named_session_diagnostic_invalid/);
  }
  for (const [key,value] of [['apply',true],['prompt','PRIVATE_FIXTURE'],['endpoint','foreign'],['diagnostic','true']] as const) {
    assert.throws(()=>namedSessionReadinessDiagnosticRequested('readiness',new Map([...valid,[key,value]])),/named_session_diagnostic_invalid/);
  }
});

function scopeFixture() {
  return {name:'owner',bindingId:randomUUID(),identity:{organizationId:'org_synthetic',repositoryBindingId:randomUUID(),
    workspaceId:randomUUID(),endpointId:randomUUID(),membershipId:randomUUID(),deviceId:randomUUID(),provider:'codex' as const}};
}

test('local failure receipt is scoped, closed-schema and explicitly not native readiness',async()=>{
  const scope=scopeFixture(),failure=NamedSessionTransportFailure.fromSocket('connect',{code:'EACCES',private:'PRIVATE_FIXTURE'});
  const input={...scope,private:'PRIVATE_FIXTURE'};
  const report=namedSessionReadinessDiagnostic(input,failure);
  assert.equal(report.ok,false);assert.equal(report.localOnly,true);assert.equal(report.nativeReady,false);
  assert.equal(report.organizationId,scope.identity.organizationId);assert.equal(report.bindingId,scope.bindingId);
  assert(!JSON.stringify(report).includes('PRIVATE_FIXTURE'));
  const directory=join(import.meta.dirname,'../../../schemas'),id='https://schemas.dharma-ai.io/named-session-readiness-diagnostic/v1';
  assert.equal((await validateContract(directory,id,report)).ok,true);
  for(const changed of [{...report,nativeReady:true},{...report,private:'PRIVATE_FIXTURE'},
    {...report,diagnostic:{...report.diagnostic,path:'PRIVATE_FIXTURE'}}]) {
    assert.equal((await validateContract(directory,id,changed)).ok,false);
  }
});

test('failure receipt refuses missing or accessor-based identity without invoking getters',()=>{
  const scope=scopeFixture(),failure=new NamedSessionTransportFailure('response','timeout');let reads=0;
  assert.throws(()=>namedSessionReadinessDiagnostic({...scope,bindingId:'foreign'},failure),/diagnostic_scope_invalid/);
  const identity={...scope.identity};Object.defineProperty(identity,'endpointId',{get(){reads++;return randomUUID();}});
  assert.throws(()=>namedSessionReadinessDiagnostic({...scope,identity},failure),/diagnostic_scope_invalid/);
  assert.equal(reads,0);
});

test('socket diagnostics do not read getters or proxies on foreign error objects',()=>{
  let reads=0;const error={};Object.defineProperty(error,'code',{get(){reads++;return 'EACCES';}});
  const proxy=new Proxy({},{get(){reads++;throw new Error('PRIVATE_FIXTURE');},getOwnPropertyDescriptor(){reads++;throw new Error('PRIVATE_FIXTURE');}});
  for(const value of [error,proxy]) {
    const failure=NamedSessionTransportFailure.fromSocket('connect',value);
    assert.equal(failure.diagnostic.reason,'transport_error');assert.equal(failure.diagnostic.osCode,null);
  }
  assert.equal(reads,0);
});

test('a settled failure never reconnects or writes a late duplicate request',async t=>{
  const {socket,promise,factory}=fixture(t);
  const failure=assert.rejects(promise,/named_session_unavailable/);
  socket.emit('error',Object.assign(new Error('PRIVATE_FIXTURE'),{code:'ECONNREFUSED'}));await failure;
  socket.emit('connect');socket.emit('data',Buffer.from('{"ok":true}\n'));
  assert.equal(factory.mock.calls.length,1);assert.equal(socket.sent.length,0);
});
