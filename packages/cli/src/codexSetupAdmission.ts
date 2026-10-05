import {createHash} from 'node:crypto';
import {canonicalize} from '@dharma-ai-labs/agent-fabric-contracts';
import type {CodexToolHandler, CodexToolResult} from '@dharma-ai-labs/agent-fabric-provider-adapters/experimental/codex-session';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$(?![\s\S])/;
const nativeId = /^[A-Za-z0-9_-]{1,128}$(?![\s\S])/;
const hash = /^sha256:[a-f0-9]{64}$(?![\s\S])/;
export interface CodexSetupIntent {
  schema: 'dharma.codex-setup-intent/v1'; operationId: string; setupReference: string;
  organizationId: string; recipientMembershipId: string; origin: string; repositoryFingerprint: string;
  policyRevision: string; scopeDigest: string; contractDigest: string; hostContextId: string;
  issuedAt: string; expiresAt: string;
}
type PublicDisposition = {state: 'completed'; readinessReceiptId: string}
  | {state: 'unconfirmed'; code: 'setup_execution_unconfirmed'};
export interface CodexSetupJournal {
  /** Atomically deny changed payload/context; do not recycle an interrupted lease. */
  claim(operationId: string, digest: string): Promise<{state: 'acquired'; leaseId: string; intentDigest: string}
    | {state: 'running'; intentDigest: string} | {state: 'terminal'; result: unknown; intentDigest: string}>;
  finish(leaseId: string, digest: string, result: PublicDisposition): Promise<void>;
}
type Binding = {connectionId: string; threadId: string; turnId: string; hostContextId: string};
interface Input extends Binding {
  intent: CodexSetupIntent;
  now?: () => number;
  current(): Promise<Binding & {mode: 'setup' | 'work' | 'peer'}>;
  /** Must independently qualify the normal owning host, package and source scope. */
  qualifyHost(intent: Readonly<CodexSetupIntent>, signal: AbortSignal): Promise<boolean>;
  journal: CodexSetupJournal;
  /** Host selects all executable/home/store/source details; no model commands. */
  execute(intent: Readonly<CodexSetupIntent>, signal: AbortSignal): Promise<unknown>;
  verifyReadiness(receiptId: string, intent: Readonly<CodexSetupIntent>): Promise<boolean>;
}

export const CODEX_SETUP_TOOL = {type: 'function', name: 'dharma_setup_reference',
  description: 'Request the single host-admitted recipient-bound setup operation. Browser device approval remains required. No shell or broader permissions are granted.',
  inputSchema: {type: 'object', additionalProperties: false,
    properties: {operationId: {type: 'string', format: 'uuid'}, setupReference: {type: 'string', format: 'uuid'}},
    required: ['operationId', 'setupReference']}};

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function exact(value: Record<string, unknown>, keys: string[]) {
  return Object.keys(value).length === keys.length && Object.keys(value).every(key => keys.includes(key));
}
function disposition(value: unknown): PublicDisposition | null {
  const result = record(value);
  if (result?.state === 'completed' && exact(result, ['state', 'readinessReceiptId'])
    && typeof result.readinessReceiptId === 'string' && uuid.test(result.readinessReceiptId)) {
    return {state: 'completed', readinessReceiptId: result.readinessReceiptId};
  }
  if (result?.state === 'unconfirmed' && result.code === 'setup_execution_unconfirmed'
    && exact(result, ['state', 'code'])) return {state: 'unconfirmed', code: 'setup_execution_unconfirmed'};
  return null;
}

/** Admission component only. It is deliberately not registered on peer/work
 * sessions and supplies neither a bootstrap executor nor a journal backend. */
export function createCodexSetupAdmission(input: Input) {
  const now = input.now ?? Date.now;
  const invalid = (): never => {throw new Error('codex_setup_intent_invalid');};
  const value = record(input.intent); if (!value) return invalid();
  const keys = ['schema', 'operationId', 'setupReference', 'organizationId', 'recipientMembershipId', 'origin',
    'repositoryFingerprint', 'policyRevision', 'scopeDigest', 'contractDigest', 'hostContextId', 'issuedAt', 'expiresAt'];
  if (!exact(value, keys) || Object.values(value).some(item => typeof item !== 'string')) return invalid();
  const intent = Object.freeze({...input.intent});
  let origin: URL; try {origin = new URL(intent.origin);} catch {return invalid();}
  const issued = Date.parse(intent.issuedAt), expires = Date.parse(intent.expiresAt);
  const binding = Object.freeze({connectionId: input.connectionId, threadId: input.threadId,
    turnId: input.turnId, hostContextId: input.hostContextId});
  if (intent.schema !== 'dharma.codex-setup-intent/v1'
    || ![intent.operationId, intent.setupReference, intent.recipientMembershipId, intent.hostContextId,
      binding.connectionId].every(item => uuid.test(item))
    || ![binding.threadId, binding.turnId].every(item => nativeId.test(item))
    || binding.hostContextId !== intent.hostContextId
    || !/^org_[A-Za-z0-9]+$(?![\s\S])/.test(intent.organizationId)
    || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$(?![\s\S])/.test(intent.policyRevision)
    || ![intent.repositoryFingerprint, intent.scopeDigest, intent.contractDigest].every(item => hash.test(item))
    || origin.protocol !== 'https:' || origin.username || origin.password || origin.origin !== intent.origin
    || !Number.isFinite(issued) || !Number.isFinite(expires) || issued > now() || expires <= now()
    || expires - issued > 900_000 || expires <= issued
    || new Date(issued).toISOString() !== intent.issuedAt || new Date(expires).toISOString() !== intent.expiresAt) return invalid();
  const digest = `sha256:${createHash('sha256').update(canonicalize({intent, binding})).digest('hex')}`;
  const closed = new AbortController(); const calls = new Set<string>(); let pending = false;
  const deny = (code: string): CodexToolResult => ({success: false,
    contentItems: [{type: 'inputText', text: JSON.stringify({code})}]});
  const authorized = async (signal: AbortSignal) => {
    if (signal.aborted || closed.signal.aborted || now() < issued || now() >= expires) return false;
    const current = await input.current();
    return !signal.aborted && !closed.signal.aborted && now() >= issued && now() < expires
      && current.mode === 'setup' && Object.entries(binding).every(([key, item]) => current[key as keyof Binding] === item);
  };
  const expose = async (value: unknown, signal: AbortSignal): Promise<CodexToolResult> => {
    const result = disposition(value);
    if (!result || result.state !== 'completed' || !await authorized(signal)
      || !await input.verifyReadiness(result.readinessReceiptId, intent) || !await authorized(signal)) {
      return deny('codex_setup_execution_unconfirmed');
    }
    return {success: true, contentItems: [{type: 'inputText', text: JSON.stringify({
      operationId: intent.operationId, state: result.state, readinessReceiptId: result.readinessReceiptId})}]};
  };
  const handler: CodexToolHandler = async (params, context) => {
    const args = record(params.arguments);
    if (Object.keys(params).some(key => !['threadId', 'turnId', 'callId', 'namespace', 'tool', 'arguments'].includes(key))
      || params.tool !== 'dharma_setup_reference' || params.namespace != null
      || params.threadId !== binding.threadId || params.turnId !== binding.turnId
      || typeof params.callId !== 'string' || !nativeId.test(params.callId) || calls.has(params.callId)
      || calls.size >= 16 || !args || !exact(args, ['operationId', 'setupReference'])
      || args.operationId !== intent.operationId || args.setupReference !== intent.setupReference || !context) {
      return deny('codex_setup_not_authorized');
    }
    const signal = AbortSignal.any([context.signal, closed.signal]);
    try {
      if (!await authorized(signal) || !await input.qualifyHost(intent, signal) || !await authorized(signal)) {
        return deny('codex_setup_not_authorized');
      }
      calls.add(params.callId);
      if (pending) return deny('codex_setup_in_progress');
      pending = true;
      try {
        const claim = await input.journal.claim(intent.operationId, digest);
        if (claim.intentDigest !== digest || !await authorized(signal)) return deny('codex_setup_not_authorized');
        if (claim.state === 'running') return deny('codex_setup_in_progress');
        if (claim.state === 'terminal') return await expose(claim.result, signal);
        if (typeof claim.leaseId !== 'string' || !uuid.test(claim.leaseId)
          || !await input.qualifyHost(intent, signal) || !await authorized(signal)) {
          return deny('codex_setup_not_authorized');
        }
        // Keep the operation fenced until the executor actually settles. Abort
        // is cooperative: never declare child termination or replay on timeout.
        const executionSignal = AbortSignal.any([signal, AbortSignal.timeout(Math.max(1, expires - now()))]);
        if (!await authorized(executionSignal)) return deny('codex_setup_not_authorized');
        let result: PublicDisposition = {state: 'unconfirmed', code: 'setup_execution_unconfirmed'};
        try {result = disposition(await input.execute(intent, executionSignal)) ?? result;} catch { /* Never reflect runtime errors. */ }
        await input.journal.finish(claim.leaseId, digest, result);
        return await expose(result, executionSignal);
      } finally {pending = false;}
    } catch {return deny('codex_setup_execution_unconfirmed');}
  };
  return {handler, close: () => closed.abort(), get pending() {return pending;}, intentDigest: digest};
}
