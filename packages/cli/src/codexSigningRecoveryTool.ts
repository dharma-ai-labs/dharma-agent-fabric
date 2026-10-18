import {createHash} from 'node:crypto';
import {canonicalize} from '@dharma-ai-labs/agent-fabric-contracts';
import type {CodexAppServerTransport} from '@dharma-ai-labs/agent-fabric-provider-adapters/experimental/codex-session';

// A declaration is not authority. The original owner separately admits one
// operation, binds the actual native turn and rechecks every protected phase.
export const CODEX_SIGNING_RECOVERY_TOOL=Object.freeze({type:'function',name:'dharma_signing_recovery',
  description:'Request a separately authorized phase on the original owning-host signing-recovery operation. Browser consent/publication stay separate; trust installation is not readiness. No shell, enrollment or provider authority.',
  inputSchema:Object.freeze({type:'object',additionalProperties:false,properties:Object.freeze({
    operationId:Object.freeze({type:'string',format:'uuid'}),
    action:Object.freeze({enum:Object.freeze(['prepare','submit','progress','complete','status'])})}),
    required:Object.freeze(['operationId','action'])})});
export const CODEX_SIGNING_RECOVERY_TOOL_HASH='sha256:'+createHash('sha256')
  .update(canonicalize(CODEX_SIGNING_RECOVERY_TOOL)).digest('hex');

const declarations=new WeakMap<CodexAppServerTransport,Set<string>>();
export function recordNamedCodexRecoveryToolDeclaration(transport:CodexAppServerTransport,threadId:string){
  const threads=declarations.get(transport)??new Set<string>();threads.add(threadId);declarations.set(transport,threads);
}
/** Original verified start request only, not a claim about model-facing use. */
export function inspectNamedCodexRecoveryToolDeclaration(transport:CodexAppServerTransport,threadId:string){
  return declarations.get(transport)?.has(threadId)?CODEX_SIGNING_RECOVERY_TOOL_HASH:null;
}
