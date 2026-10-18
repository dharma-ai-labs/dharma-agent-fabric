import { canonicalize, inspectSessionQuestionForBinding, type SessionQuestionVerifier } from '@dharma-ai-labs/agent-fabric-contracts';
import {createHash,randomUUID} from 'node:crypto';
import {types} from 'node:util';
import {isAbsolute,resolve} from 'node:path';
import type { LocalProviderSessionIdentity, LocalVault, ScopedLocalVault } from '@dharma-ai-labs/agent-fabric-local-vault';
import { CodexSessionAnswerTooLargeError, runCodexBridgeQuestion, runCodexLocalWork, type CodexSessionBudget, type CodexToolHandler, type CodexTurnEvidenceSink } from '@dharma-ai-labs/agent-fabric-provider-adapters/experimental/codex-session';
import type { CodexStdioTransport } from '@dharma-ai-labs/agent-fabric-provider-adapters/experimental/codex-transport';
import {attachCodexSigningRecoveryNativeHost,type CodexSigningRecoveryNativeInput} from './codexSigningRecoveryNativeHost.js';
import {CODEX_SIGNING_RECOVERY_TOOL_HASH} from './codexSigningRecoveryTool.js';

export type CodexBoundSigningRecoveryInput=Pick<CodexSigningRecoveryNativeInput,'operationId'|'signal'|'current'|'authorize'> & {
  recovery:Omit<CodexSigningRecoveryNativeInput['recovery'],'session'>;
};
function recoveryRequest(value:CodexBoundSigningRecoveryInput):CodexBoundSigningRecoveryInput{
  const snapshot=(item:unknown,allowed:string[],required:string[])=>{
    if(!item||typeof item!=='object'||Array.isArray(item)||types.isProxy(item))throw Error('codex_signing_recovery_input_invalid');
    const fields=Object.getOwnPropertyDescriptors(item);
    if(required.some(key=>!Object.hasOwn(fields,key))||Reflect.ownKeys(fields).some(key=>typeof key!=='string'||!allowed.includes(key)
      ||!fields[key]!.enumerable||!Object.hasOwn(fields[key]!,'value')))throw Error('codex_signing_recovery_input_invalid');
    return Object.fromEntries(Object.entries(fields).map(([key,field])=>[key,field.value]));
  };
  const keys=['operationId','signal','current','authorize','recovery'];
  const request=snapshot(value,keys,keys);
  request.recovery=snapshot(request.recovery,['configPath','source','store','fetcher','now'],['configPath','source']);
  return request as unknown as CodexBoundSigningRecoveryInput;
}
function recoverySourceSnapshot(value:unknown):Record<string,string|number>{
  const keys=['organizationId','workspaceId','repositoryBindingId','repositoryFingerprint','policyRevision','scopeDigest',
    'contractDigest','sourceGenerationId','sourceReceiptId','sourceRevision','sourcePolicyRevision','sourcePolicyHash'];
  if(!value||typeof value!=='object'||Array.isArray(value)||types.isProxy(value))throw Error('codex_signing_recovery_input_invalid');
  const fields=Object.getOwnPropertyDescriptors(value);
  if(Reflect.ownKeys(fields).length!==keys.length||Reflect.ownKeys(fields).some(key=>typeof key!=='string'||!keys.includes(key)
    ||!fields[key]!.enumerable||!Object.hasOwn(fields[key]!,'value')))throw Error('codex_signing_recovery_input_invalid');
  const output:Record<string,string|number>={};
  for(const key of keys){const item:unknown=fields[key]!.value;
    if(key==='sourceRevision'?typeof item!=='number'||!Number.isSafeInteger(item):typeof item!=='string'||item.length>512)
      throw Error('codex_signing_recovery_input_invalid');
    output[key]=item as string|number;
  }
  return output;
}

interface CodexBoundSessionInput {
  vault: LocalVault | ScopedLocalVault;
  bindingId: string;
  identity: LocalProviderSessionIdentity;
  // The factory must close its child process before rejecting initialization.
  openTransport(): Promise<CodexStdioTransport>;
  verifier: SessionQuestionVerifier;
  budget: CodexSessionBudget;
  questionBudget?: CodexSessionBudget;
  localWriteRoots?: string[];
  additionalFilesystemRules?: Readonly<Record<string, 'read' | 'deny'>>;
  localToolHandler?: CodexToolHandler;
  // Only the inbox may use the held owner to report failure before closing it.
  retainTimedOutQuestion?: boolean;
}

export async function openCodexBoundSession(input: CodexBoundSessionInput) {
  const binding = await input.vault.getProviderSessionBinding(input.bindingId, input.identity);
  if (!binding || binding.provider !== 'codex' || binding.owner !== 'dharma_bridge') {
    throw new Error('codex_session_binding_unavailable');
  }
  if (process.platform !== 'linux') throw new Error('codex_session_sandbox_unqualified');
  const currentBinding = async () => {
    const current = await input.vault.getProviderSessionBinding(input.bindingId, input.identity);
    if (!current) throw new Error('codex_session_lease_unavailable');
    if (current.sessionId !== binding.sessionId || current.workspaceRoot !== binding.workspaceRoot
      || current.owner !== binding.owner || current.maximumProviderCostCents !== binding.maximumProviderCostCents) {
      throw new Error('codex_session_binding_unavailable');
    }
    return { ...current, threadId: current.sessionId };
  };
  const lease = await input.vault.tryAcquireProviderSessionLease(input.bindingId, input.identity);
  if (!lease) throw new Error('codex_session_lease_unavailable');
  const heldLease = lease;
  let transport: CodexStdioTransport;
  try { transport = await input.openTransport(); }
  catch (error) { await lease.release(); throw error; }
  let running = false;
  let closing = false;
  let closed = false;
  let shutdown: Promise<void> | null = null;
  const recoveryLifetime=new AbortController(),connectionId=randomUUID(),hostContextId=randomUUID();
  let recoveryHost:Awaited<ReturnType<typeof attachCodexSigningRecoveryNativeHost>>|undefined;
  let recoveryOpening:Promise<Awaited<ReturnType<typeof attachCodexSigningRecoveryNativeHost>>>|undefined;
  let recoveryOnly=false;

  async function close() {
    closing = true;
    recoveryLifetime.abort();
    if (closed) return;
    if (shutdown) return shutdown;
    shutdown = (async () => {
      if(recoveryOpening)await recoveryOpening.catch(()=>{});
      if(recoveryHost)await recoveryHost.close();
      // Never release the fence while a provider child could still accept turns.
      await transport.close();
      await heldLease.release();
      closed = true;
    })();
    try { await shutdown; }
    finally { shutdown = null; }
  }

  return {
    close,
    async assertActive() { return !closing && !closed && await heldLease.assertHeld(); },
    /** Trusted original-controller entry, never a peer/socket/model authority
     * object. This arms one already-declared tool; it never starts a turn. */
    async beginSigningRecovery(value:CodexBoundSigningRecoveryInput){
      if(closing||closed)throw Error('codex_session_closed');
      if(running)throw Error('codex_session_busy');
      if(recoveryOnly)throw Error('codex_signing_recovery_owner_consumed');
      running=true;
      const opening=(async()=>{
        const selected=await currentBinding();
        const catalog=await input.vault.readProviderSessionRecoveryDeclaration(selected.bindingId,input.identity);
        if(catalog?.toolHash!==CODEX_SIGNING_RECOVERY_TOOL_HASH)
          throw Error('codex_signing_recovery_catalog_unavailable');
        const request=recoveryRequest(value);
        const source=recoverySourceSnapshot(request.recovery.source);
        if(!(request.signal instanceof AbortSignal)||typeof request.current!=='function'||typeof request.authorize!=='function'
          ||typeof request.operationId!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{12}$(?![\s\S])/.test(request.operationId)
          ||typeof request.recovery.configPath!=='string'||!isAbsolute(request.recovery.configPath)
          ||resolve(request.recovery.configPath)!==request.recovery.configPath||/[\x00-\x1f\x7f]/.test(request.recovery.configPath)
          ||['organizationId','workspaceId','repositoryBindingId'].some(key=>source[key]!==selected[key as keyof typeof selected]))
          throw Error('codex_signing_recovery_input_invalid');
        const signal=AbortSignal.any([request.signal,recoveryLifetime.signal,transport.signal]);
        const session={organizationId:selected.organizationId,workspaceId:selected.workspaceId,repositoryBindingId:selected.repositoryBindingId,
          endpointId:selected.endpointId,membershipId:selected.membershipId,deviceId:selected.deviceId,bindingId:selected.bindingId,
          provider:selected.provider,owner:selected.owner,sessionId:selected.sessionId,createdAt:selected.createdAt,
          expiresAt:selected.expiresAt,maximumProviderCostCents:selected.maximumProviderCostCents};
        const current=request.current.bind(request),authorize=request.authorize.bind(request);
        const valid=async(native:Parameters<typeof current>[0])=>{
          if(closing||closed||signal.aborted||!await heldLease.assertHeld()||signal.aborted)return false;
          const fresh=await currentBinding();
          if(canonicalize(fresh)!==canonicalize(selected)||!await current(native))return false;
          return !closing&&!closed&&!signal.aborted&&await heldLease.assertHeld()
            &&canonicalize(await currentBinding())===canonicalize(selected)
            &&canonicalize(await input.vault.readProviderSessionRecoveryDeclaration(selected.bindingId,input.identity))===canonicalize(catalog)
            &&!signal.aborted;
        };
        if(!await valid(null))throw Error('codex_signing_recovery_scope_unavailable');
        recoveryOnly=true;
        // Reuse the encrypted original-operation journal with a separate purpose
        // digest. Leave the claim consumed: settlement is not readiness or a
        // safe basis for recycling an interrupted recovery operation.
        const digest='sha256:'+createHash('sha256').update('dharma.codex-signing-recovery-controller/v1\0'
          +canonicalize({operationId:request.operationId,session,source,configPathHash:'sha256:'+createHash('sha256')
            .update(request.recovery.configPath).digest('hex'),declaration:catalog})).digest('hex');
        const claimed=await input.vault.claimCodexSetupOperation(request.operationId,digest);
        if(claimed.state!=='acquired')throw Error('codex_signing_recovery_operation_consumed');
        if(!await valid(null))throw Error('codex_signing_recovery_scope_unavailable');
        const host=await attachCodexSigningRecoveryNativeHost({transport,workspace:selected.workspaceRoot,operationId:request.operationId,
          connectionId,hostContextId,signal,current:valid,authorize,additionalFilesystemRules:input.additionalFilesystemRules,
          recovery:{...request.recovery,source:source as unknown as typeof request.recovery.source,session}});
        recoveryHost=host;
        void host.settled.then(()=>{if(recoveryHost===host){recoveryHost=undefined;running=false;}},()=>{});
        return host;
      })();
      recoveryOpening=opening;
      try{return await opening;}catch(error){running=false;throw error;}
      finally{if(recoveryOpening===opening)recoveryOpening=undefined;}
    },
    async runWork(request: { workId: string; prompt: string; maximumProviderCostCents: number; timeoutMs?: number;
      onTurnEvidence?: CodexTurnEvidenceSink }) {
      if (closing) throw new Error('codex_session_closed');
      if (recoveryOnly) throw new Error('codex_session_recovery_only');
      if (running) throw new Error('codex_session_busy');
      running = true;
      try {
        const result = await runCodexLocalWork({ ...request, transport, binding: await currentBinding(),
          exclusiveLease: heldLease, budget: input.budget, writeRoots: input.localWriteRoots ?? [],
          toolHandler: input.localToolHandler, additionalFilesystemRules: input.additionalFilesystemRules });
        if (closing) throw new Error('codex_session_closed');
        return result;
      } catch (error) {
        if (!(error instanceof Error) || !['codex_session_budget_unavailable', 'codex_session_work_invalid'].includes(error.message)) {
          try { await close(); } catch { /* Retain the fence until shutdown is confirmed. */ }
        }
        throw error;
      } finally { running = false; }
    },
    async runQuestion(request: { question: unknown; now?: Date; timeoutMs?: number; repositoryContext?: string }) {
      if (closing) throw new Error('codex_session_closed');
      if (recoveryOnly) throw new Error('codex_session_recovery_only');
      if (running) throw new Error('codex_session_busy');
      running = true;
      let codexBinding: Awaited<ReturnType<typeof currentBinding>>;
      try {
        try { codexBinding = await currentBinding(); }
        catch (error) { try { await close(); } catch { /* Retain an unconfirmed owner fence. */ } throw error; }
        const inspected = inspectSessionQuestionForBinding(request.question, codexBinding,
          input.verifier, request.now ?? new Date());
        if (!inspected.ok) throw new Error(inspected.reason);
      } catch (error) {running = false; throw error;}
      try {
        const result = await runCodexBridgeQuestion({
          transport, binding: codexBinding, question: request.question,
          verifier: input.verifier, exclusiveLease: lease, budget: input.questionBudget ?? input.budget,
          now: request.now, timeoutMs: request.timeoutMs,
          repositoryContext: request.repositoryContext,
          additionalFilesystemRules: input.additionalFilesystemRules,
        });
        if (closing) throw new Error('codex_session_closed');
        return result;
      } catch (error) {
        // Retain only the authority needed for the inbox's bounded failure report.
        const reason = error instanceof Error ? error.message : '';
        if (!(input.retainTimedOutQuestion && reason === 'codex_session_turn_timeout')
          && !(error instanceof CodexSessionAnswerTooLargeError)
          && !['codex_session_budget_unavailable', 'replayed'].includes(reason)) {
          try { await close(); }
          catch { /* Keep the fence and disable dispatch until shutdown is confirmed. */ }
        }
        throw error;
      } finally { running = false; }
    },
  };
}

export async function runCodexBoundSessionQuestion(input: CodexBoundSessionInput & {
  question: unknown;
  repositoryContext?: string;
  now?: Date;
  timeoutMs?: number;
}) {
  const binding = await input.vault.getProviderSessionBinding(input.bindingId, input.identity);
  if (!binding || binding.provider !== 'codex' || binding.owner !== 'dharma_bridge') {
    throw new Error('codex_session_binding_unavailable');
  }
  const codexBinding = { ...binding, threadId: binding.sessionId };
  const inspected = inspectSessionQuestionForBinding(input.question, codexBinding,
    input.verifier, input.now ?? new Date());
  if (!inspected.ok) throw new Error(inspected.reason);
  const owner = await openCodexBoundSession(input);
  try {
    const result = await owner.runQuestion(input);
    await owner.close();
    return result;
  } catch (error) {
    try { await owner.close(); }
    catch { /* Retain ownership if process termination cannot be confirmed. */ }
    throw error;
  }
}

/** Purpose-limited original-owner composition; it exposes no peer/write turn. */
export async function openCodexSigningRecoveryOwner(input:Pick<CodexBoundSessionInput,
  'vault'|'bindingId'|'identity'|'openTransport'|'additionalFilesystemRules'>){
  if(process.platform!=='linux')throw Error('codex_session_sandbox_unqualified');
  const catalog=await input.vault.readProviderSessionRecoveryDeclaration(input.bindingId,input.identity);
  if(catalog?.toolHash!==CODEX_SIGNING_RECOVERY_TOOL_HASH)throw Error('codex_signing_recovery_catalog_unavailable');
  const owner=await openCodexBoundSession({...input,verifier:{resolvePublicKey:()=>null,consume:async()=>false},
    budget:{reserve:async()=>false}});
  return Object.freeze({beginSigningRecovery:owner.beginSigningRecovery,assertActive:owner.assertActive,close:owner.close});
}
