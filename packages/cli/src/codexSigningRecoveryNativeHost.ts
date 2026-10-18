import {isAbsolute,resolve} from 'node:path';
import {types} from 'node:util';
import {verifyCodexSetupReadOnlyProfile,type CodexToolHandler,type CodexToolResult}
  from '@dharma-ai-labs/agent-fabric-provider-adapters/experimental/codex-session';
import type {CodexStdioTransport} from '@dharma-ai-labs/agent-fabric-provider-adapters/experimental/codex-transport';
import {CODEX_SIGNING_RECOVERY_TOOL} from './codexSigningRecoveryTool.js';
import {prepareOwnedSigningRecovery,submitOwnedSigningRecoveryPreparation,progressOwnedSigningRecoveryOffer,
  completeOwnedSigningRecovery,inspectOwnedSigningRecovery,disposeOwnedSigningRecovery,OwnedSigningRecoveryError,
  type PrepareOwnedSigningRecoveryInput,type OwnedSigningRecoveryHandle}
  from '@dharma-ai-labs/agent-fabric-relay-client';

type Action='prepare'|'submit'|'progress'|'complete';
type Binding=PrepareOwnedSigningRecoveryInput['hostBinding'];
type Progress=Awaited<ReturnType<typeof inspectOwnedSigningRecovery>>;
export interface CodexSigningRecoveryNativeInput {
  /** Original independently qualified transport, with no competing tool handler. */
  transport:CodexStdioTransport;
  workspace:string;
  operationId:string;
  connectionId:string;
  hostContextId:string;
  recovery:Omit<PrepareOwnedSigningRecoveryInput,'hostBinding'|'hostScope'>;
  signal:AbortSignal;
  /** Requalifies original connection/account, exclusive owner, source and turn. */
  current(binding:Readonly<Binding>|null):Promise<boolean>;
  /** Side-effect-free original-host decision, rechecked at every protected step.
   * In particular, completion needs separate current consent/publication evidence. */
  authorize(action:Action,progress:Readonly<Progress>|null,binding:Readonly<Binding>):Promise<boolean>;
  additionalFilesystemRules?:Readonly<Record<string,'read'|'deny'>>;
}
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$(?![\s\S])/;
const nativeId=/^[A-Za-z0-9_-]{1,128}$(?![\s\S])/;
const claimed=new WeakMap<CodexStdioTransport,Set<string>>();
function record(value:unknown):Record<string,unknown>|null{
  if(!value||typeof value!=='object'||Array.isArray(value)||types.isProxy(value))return null;
  const fields=Object.getOwnPropertyDescriptors(value);
  if(Reflect.ownKeys(fields).some(key=>typeof key!=='string'||!fields[key]!.enumerable||!Object.hasOwn(fields[key]!,'value')))return null;
  return Object.fromEntries(Object.entries(fields).map(([key,field])=>[key,field.value]));
}
const reject=():CodexToolResult=>({success:false,contentItems:[{type:'inputText',text:'{"code":"codex_signing_recovery_not_authorized"}'}]});

/** Opt-in on the original host BEFORE its already-admitted turn. This adapter
 * never starts/resumes a thread, reserves spend, interrupts a turn or closes a
 * provider. Tool definitions alone grant no recovery authority. */
export async function attachCodexSigningRecoveryNativeHost(input:CodexSigningRecoveryNativeInput){
  const raw=record(input),recovery=record(raw?.recovery),source=record(recovery?.source),session=record(recovery?.session);
  if(!raw||!recovery||!source||!session||typeof raw.workspace!=='string'||!isAbsolute(raw.workspace)||resolve(raw.workspace)!==raw.workspace
    ||![raw.operationId,raw.connectionId,raw.hostContextId].every(value=>typeof value==='string'&&uuid.test(value))
    ||!(raw.signal instanceof AbortSignal)||typeof raw.current!=='function'||typeof raw.authorize!=='function'
    ||typeof recovery.configPath!=='string'||!isAbsolute(recovery.configPath)||session.provider!=='codex'||session.owner!=='dharma_bridge'
    ||typeof session.sessionId!=='string'||!nativeId.test(session.sessionId)
    ||['organizationId','workspaceId','repositoryBindingId'].some(key=>session[key]!==source[key]))throw Error('codex_signing_recovery_input_invalid');
  const {transport,workspace,operationId,connectionId,hostContextId}=input;
  const filesystem=Object.freeze({...input.additionalFilesystemRules});
  const snapshot={...recovery,source:Object.freeze({...source}),session:Object.freeze({...session})} as unknown as typeof input.recovery;
  const clock=snapshot.now??Date.now,started=clock(),expires=Math.min(started+900000,Date.parse(snapshot.session.expiresAt));
  if(!Number.isFinite(started)||!Number.isFinite(expires)||expires<=started)throw Error('codex_signing_recovery_input_invalid');
  const abort=new AbortController(),signal=AbortSignal.any([input.signal,transport.signal,abort.signal]);
  const current=input.current.bind(input),authorize=input.authorize.bind(input);
  let binding:Readonly<Binding>|null=null,handle:OwnedSigningRecoveryHandle|undefined,progress:Progress|null=null;
  let closed=false,busy=false,preparationAttempted=false,activeAction:Action|undefined;
  const callbacks=new Set<Promise<CodexToolResult>>();
  let unregister=()=>{},unsubscribe=()=>{},finish!:()=>void;
  const settled=new Promise<void>(resolve=>{finish=resolve;});
  const within=()=>{const at=clock();return Number.isFinite(at)&&at>=started&&at<expires;};
  const valid=async()=>!closed&&!signal.aborted&&within()&&await current(binding)===true&&!closed&&!signal.aborted&&within();
  const assert=async()=>{if(!await valid())throw Error('codex_signing_recovery_scope_unavailable');};
  const step=async<T>(operation:()=>Promise<T>)=>{await assert();const value=await operation();await assert();return value;};
  const native=async(active:boolean)=>{
    await verifyCodexSetupReadOnlyProfile(transport,workspace,{step},filesystem);
    const value=record(await step(()=>transport.request('thread/read',{threadId:snapshot.session.sessionId,includeTurns:false})));
    const thread=record(value?.thread),status=record(thread?.status);
    if(thread?.id!==snapshot.session.sessionId||thread?.cwd!==workspace||status?.type!==(active?'active':'idle'))throw Error('codex_signing_recovery_native_unavailable');
  };
  const withdraw=()=>{
    if(closed)return;closed=true;abort.abort();unregister();unsubscribe();clearTimeout(timer);
    signal.removeEventListener('abort',withdraw);
    if(handle)disposeOwnedSigningRecovery(handle);
    void Promise.allSettled([...callbacks]).then(()=>finish());
  };
  const timer=setTimeout(withdraw,Math.max(1,expires-started));timer.unref();
  const summary=()=>({schema:'dharma.codex-signing-recovery-native-progress/v1' as const,operationId,
    threadId:binding!.threadId,turnId:binding!.turnId,ready:false as const,progress});
  const result=():CodexToolResult=>({success:true,contentItems:[{type:'inputText',text:JSON.stringify(summary())}]});
  const hostScope={signal,current:async()=>await valid()&&binding!==null&&activeAction!==undefined
    &&await authorize(activeAction,progress,binding)===true&&await valid()};
  const handler:CodexToolHandler=(value,context)=>{
    const params=record(value),args=record(params?.arguments);
    if(!params||!args||!binding||closed||busy||!context||!(context.signal instanceof AbortSignal)||context.signal.aborted
      ||params.threadId!==binding.threadId||params.turnId!==binding.turnId||params.namespace!=null
      ||params.tool!=='dharma_signing_recovery'||typeof params.callId!=='string'||!nativeId.test(params.callId)
      ||Object.keys(args).sort().join(',')!=='action,operationId'||args.operationId!==operationId
      ||typeof args.action!=='string'||!['prepare','submit','progress','complete','status'].includes(args.action))return Promise.resolve(reject());
    busy=true;
    const action=args.action as Action|'status',cancel=()=>withdraw();
    context.signal.addEventListener('abort',cancel,{once:true});
    const work=(async():Promise<CodexToolResult>=>{
      try{
        await assert();await native(true);
        if(context.signal.aborted)return reject();
        if(action==='status')return result();
        if(await authorize(action,progress,binding!)!==true)return reject();
        await assert();activeAction=action;
        if(action==='prepare'){
          if(!handle){
            if(preparationAttempted)return reject();preparationAttempted=true;
            const prepared=await prepareOwnedSigningRecovery({...snapshot,hostBinding:binding!,hostScope});
            if(closed||signal.aborted){disposeOwnedSigningRecovery(prepared);throw Error('codex_signing_recovery_scope_unavailable');}
            handle=prepared;
          }
          progress=await inspectOwnedSigningRecovery(handle);
        }else{
          if(!handle)return reject();
          progress=action==='submit'?await submitOwnedSigningRecoveryPreparation(handle)
            :action==='progress'?await progressOwnedSigningRecoveryOffer(handle):await completeOwnedSigningRecovery(handle);
        }
        await assert();return result();
      }catch(error){
        if(handle&&!closed){try{progress=await inspectOwnedSigningRecovery(handle);}catch{progress=null;}}
        if(!await valid().catch(()=>false))withdraw();
        const httpStatus=error instanceof OwnedSigningRecoveryError&&Number.isInteger(error.httpStatus)
          &&Number(error.httpStatus)>=100&&Number(error.httpStatus)<=599?error.httpStatus:null;
        return {success:false,contentItems:[{type:'inputText',text:JSON.stringify({code:'codex_signing_recovery_failed',phase:action,httpStatus})}]};
      }finally{activeAction=undefined;busy=false;context.signal.removeEventListener('abort',cancel);}
    })();
    callbacks.add(work);void work.then(()=>callbacks.delete(work),()=>callbacks.delete(work));return work;
  };
  try{
    await assert();await native(false);
    const operations=claimed.get(transport)??new Set<string>();
    if(operations.has(operationId))throw Error('codex_signing_recovery_operation_consumed');
    operations.add(operationId);claimed.set(transport,operations);
    unregister=transport.onToolCall(handler);
    unsubscribe=transport.onNotification(value=>{
      const event=record(value),params=record(event?.params),turn=record(params?.turn);
      if(params?.threadId!==snapshot.session.sessionId||typeof turn?.id!=='string'||!nativeId.test(turn.id))return;
      if(event?.method==='turn/started'){
        if(binding){if(turn.id!==binding.turnId)withdraw();return;}
        if(turn.status!=='inProgress'){withdraw();return;}
        binding=Object.freeze({connectionId,hostContextId,threadId:snapshot.session.sessionId,turnId:turn.id});
      }else if(event?.method==='turn/completed'&&(!binding||turn.id===binding.turnId))withdraw();
    });
    signal.addEventListener('abort',withdraw,{once:true});if(signal.aborted)withdraw();
    await assert();
    return Object.freeze({operationId,tool:CODEX_SIGNING_RECOVERY_TOOL,settled,close:async()=>{withdraw();await settled;}});
  }catch{withdraw();await settled;throw Error('codex_signing_recovery_native_unavailable');}
}
