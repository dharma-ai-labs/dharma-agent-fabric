import { types } from 'node:util';
import { McpServer, fromJsonSchema, type CallToolResult, type JsonSchemaType } from '@modelcontextprotocol/server';
import { canonicalize, sha256, validateSessionQuestionContract } from '@dharma-ai-labs/agent-fabric-contracts';
import questionSchema from './session-question.schema.json' with {type: 'json'};
import contract from './cooperative-session-tools-v1.schema.json' with {type: 'json'};

export interface CooperativeSessionMcpAnswer {
  questionId: string; taskId: string; nonce: string; offerHash: string; attemptId: string; answer: string;
}
export interface CooperativeSessionMcpConsumer {
  checkpoint(context: Readonly<{signal: AbortSignal}>): Promise<unknown>;
  submitAnswer(answer: CooperativeSessionMcpAnswer, context: Readonly<{signal: AbortSignal}>): Promise<unknown>;
}

const RESULT_SCHEMA = 'dharma.cooperative-session-tool-result/v1';
const signalAborted = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted')!.get!;
function response(value: Record<string, unknown>, isError = false): CallToolResult {
  return {content: [{type: 'text', text: JSON.stringify(value)}], structuredContent: value, isError};
}

function sdkSchema(kind: 'checkpointInput' | 'submitInput' | 'result') {
  const question: Record<string, unknown> = structuredClone(questionSchema);
  delete question.$id; delete question.$schema;
  function rebase(value: unknown, questionRefs: boolean): unknown {
    if (Array.isArray(value)) return value.map(item => rebase(item, questionRefs));
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key,
      key === '$ref' && typeof item === 'string'
        ? questionRefs && item.startsWith('#/') ? `#/$defs/sessionQuestion/${item.slice(2)}`
          : item === 'https://schemas.dharma-ai.io/session-question/v1' ? '#/$defs/sessionQuestion' : item
        : rebase(item, questionRefs)]));
  }
  const definitions: Record<string, unknown> = {...rebase(contract.$defs, false) as Record<string, unknown>, sessionQuestion: rebase(question, true)};
  return {$schema: contract.$schema, type: 'object', ...definitions[kind] as object, $defs: definitions} as JsonSchemaType;
}

export function createCooperativeSessionMcpHandlers(consumer: CooperativeSessionMcpConsumer | null) {
  if (!consumer || typeof consumer !== 'object' || types.isProxy(consumer)) unavailableConsumer();
  const checkpoint = Object.getOwnPropertyDescriptor(consumer, 'checkpoint');
  const submitAnswer = Object.getOwnPropertyDescriptor(consumer, 'submitAnswer');
  if (!checkpoint || !submitAnswer || !Object.hasOwn(checkpoint, 'value') || !Object.hasOwn(submitAnswer, 'value')
    || typeof checkpoint.value !== 'function' || typeof submitAnswer.value !== 'function'
    || types.isProxy(checkpoint.value) || types.isProxy(submitAnswer.value)) unavailableConsumer();
  const methods = {checkpoint: checkpoint.value as CooperativeSessionMcpConsumer['checkpoint'],
    submitAnswer: submitAnswer.value as CooperativeSessionMcpConsumer['submitAnswer']};
  let active = false, poisoned = false;

  async function invoke(kind: 'checkpoint' | 'submitAnswer', args: unknown, signal: AbortSignal): Promise<CallToolResult> {
    if (poisoned) return failure('unavailable');
    if (active) return failure('busy');
    let captured: Record<string, unknown>;
    try {
      captured = snapshot(args) as Record<string, unknown>;
      if (!captured || Array.isArray(captured) || typeof captured !== 'object'
        || !signal || typeof signal !== 'object' || types.isProxy(signal)
        || Object.getPrototypeOf(signal) !== AbortSignal.prototype) throw new Error();
      const signalFields = Object.getOwnPropertyDescriptors(signal);
      if (Reflect.ownKeys(signalFields).some(key => !Object.hasOwn(signalFields[key as keyof typeof signalFields]!, 'value'))) throw new Error();
      if (signalAborted.call(signal)) return failure('cancelled');
    } catch {return failure('input_invalid');}
    active = true;
    let dispatched = false;
    try {
      const parsed = await inputSchemas[kind]['~standard'].validate(captured);
      if (parsed.issues) return failure('input_invalid');
      if (signalAborted.call(signal)) return failure('cancelled');
      const context = Object.freeze({signal});
      dispatched = true;
      const raw = await (kind === 'checkpoint' ? Reflect.apply(methods.checkpoint, consumer, [context])
        : Reflect.apply(methods.submitAnswer, consumer, [Object.freeze(captured), context]));
      // Once invoked, an abort cannot prove that the retained consumer had no effect.
      if (signalAborted.call(signal)) {poisoned = true; return failure('delivery_unconfirmed');}
      let value: Record<string, unknown>;
      try {
        const result = snapshot(raw) as Record<string, unknown>;
        if (!result || Array.isArray(result) || typeof result !== 'object' || Object.hasOwn(result, 'schema')) throw new Error();
        value = {schema: RESULT_SCHEMA, ...result};
        if (Buffer.byteLength(JSON.stringify(value), 'utf8') > 16_384) throw new Error();
        const parsedOutput = await outputSchema['~standard'].validate(value);
        if (parsedOutput.issues || !(kind === 'checkpoint' ? CHECKPOINT_STATES : SUBMIT_STATES).includes(result.state as string)) throw new Error();
        if (kind === 'submitAnswer' && (result.questionId !== captured.questionId || result.taskId !== captured.taskId)) throw new Error();
        if (result.state === 'handed_off' && (!validateSessionQuestionContract(result.offer).ok
          || sha256(canonicalize(result.offer)) !== result.offerHash)) throw new Error();
      } catch {poisoned = true; return failure('delivery_unconfirmed');}
      if (signalAborted.call(signal)) {poisoned = true; return failure('delivery_unconfirmed');}
      return response(value);
    } catch (error) {
      const code = dispatched && signalAborted.call(signal) ? 'delivery_unconfirmed' : errorCode(error);
      if (dispatched && code !== 'busy') poisoned = true;
      return failure(code);
    } finally {active = false;}
  }
  return {checkpoint: (args: unknown, signal: AbortSignal) => invoke('checkpoint', args, signal),
    submitAnswer: (args: unknown, signal: AbortSignal) => invoke('submitAnswer', args, signal)};
}

function unavailableConsumer(): never {throw new Error('cooperative_mcp_consumer_unavailable');}
function failure(code: string): CallToolResult {return response({schema: RESULT_SCHEMA, state: 'error', code}, true);}

const CHECKPOINT_STATES = ['idle', 'budget_denied', 'handed_off', 'checkpoint_pending', 'offer_recovery_required',
  'reply_pending', 'reply_reconciled', 'reply_quarantined'];
const SUBMIT_STATES = ['answered', 'reply_pending'];
const ERROR_CODES: Record<string, string> = {
  cooperative_session_busy: 'busy', cooperative_session_handoff_pending: 'busy',
  cooperative_session_submission_invalid: 'submission_invalid', cooperative_session_submission_mismatch: 'submission_mismatch',
  cooperative_session_answer_invalid: 'answer_invalid', cooperative_session_signer_untrusted: 'signer_untrusted',
  cooperative_session_content_denied: 'content_blocked', provider_session_channel_input: 'content_blocked',
  cooperative_session_owner_lost: 'owner_lost', provider_session_channel_owner_lost: 'owner_lost',
  provider_session_channel_response: 'receipt_invalid', provider_session_channel_cancelled: 'cancelled',
  provider_session_channel_deadline: 'deadline', provider_session_channel_uncertain: 'delivery_unconfirmed',
  cooperative_session_failure_delivery_unconfirmed: 'delivery_unconfirmed',
  cooperative_session_unavailable: 'unavailable', cooperative_session_binding_unavailable: 'unavailable',
  cooperative_session_lease_unavailable: 'unavailable', provider_session_channel_unavailable: 'unavailable',
  provider_session_channel_closed: 'unavailable', provider_session_channel_revoked: 'unavailable',
};
function errorCode(error: unknown): string {
  if (!error || typeof error !== 'object' || types.isProxy(error) || !types.isNativeError(error)) return 'operation_unconfirmed';
  const message = Object.getOwnPropertyDescriptor(error, 'message');
  return message && Object.hasOwn(message, 'value') && typeof message.value === 'string'
    && Object.hasOwn(ERROR_CODES, message.value) ? ERROR_CODES[message.value]! : 'operation_unconfirmed';
}

// Read only own data descriptors. Validation/JSON serialization never sees caller callbacks.
function snapshot(value: unknown): unknown {
  let nodes = 0;
  const ancestors = new Set<object>();
  function visit(item: unknown, depth: number): unknown {
    if (++nodes > 1000 || depth > 8) throw new Error();
    if (item === null || typeof item === 'boolean') return item;
    if (typeof item === 'string') {if (item.length > 4096) throw new Error(); return item;}
    if (typeof item === 'number' && Number.isFinite(item)) return item;
    if (!item || typeof item !== 'object' || types.isProxy(item) || ancestors.has(item)) throw new Error();
    const array = Array.isArray(item), prototype = Object.getPrototypeOf(item);
    if (prototype !== (array ? Array.prototype : Object.prototype)) throw new Error();
    const keys = Reflect.ownKeys(item);
    if (keys.length > (array ? 1001 : 100) || keys.some(key => typeof key !== 'string')) throw new Error();
    ancestors.add(item);
    try {
      if (array) {
        const length = Object.getOwnPropertyDescriptor(item, 'length')!.value as number;
        if (length > 1000 || keys.length !== length + 1) throw new Error();
        const result: unknown[] = [];
        for (let index = 0; index < length; index++) {
          const descriptor = Object.getOwnPropertyDescriptor(item, String(index));
          if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) throw new Error();
          result.push(visit(descriptor.value, depth + 1));
        }
        return result;
      }
      const entries: Array<[string, unknown]> = [];
      for (const key of keys as string[]) {
        const descriptor = Object.getOwnPropertyDescriptor(item, key)!;
        if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) throw new Error();
        entries.push([key, visit(descriptor.value, depth + 1)]);
      }
      return Object.fromEntries(entries);
    } finally {ancestors.delete(item);}
  }
  return visit(value, 0);
}

function fixedSchema(kind: 'checkpointInput' | 'submitInput' | 'result') {
  const base = fromJsonSchema<Record<string, unknown>>(sdkSchema(kind));
  return {'~standard': {...base['~standard'], validate: async (value: unknown) => {
    try {
      const captured = snapshot(value) as Record<string, unknown>;
      // Match the retained consumer's UTF-16 length limit, including non-BMP answers.
      if (kind === 'submitInput' && typeof captured?.answer === 'string' && captured.answer.length > 2000) throw new Error();
      const parsed = await base['~standard'].validate(captured);
      if (!parsed.issues) return parsed;
    } catch { /* No original validation diagnostics cross the SDK boundary. */ }
    return {issues: [{message: kind === 'result' ? 'output_invalid' : 'input_invalid'}]};
  }}};
}
const inputSchemas = {checkpoint: fixedSchema('checkpointInput'), submitAnswer: fixedSchema('submitInput')};
const outputSchema = fixedSchema('result');

// The embedding owner injects and retains the consumer. This factory does not
// construct a native identity, acquire a runtime slot, or own consumer cleanup.
export function createCooperativeSessionMcpServer(consumer: CooperativeSessionMcpConsumer | null): McpServer {
  const handlers = createCooperativeSessionMcpHandlers(consumer);
  const server = new McpServer({name: 'dharma-cooperative-session', version: '1.0.0'}, {maxToolInputElements: 100});
  const annotations = {readOnlyHint: false, destructiveHint: false, openWorldHint: false};
  server.registerTool('cooperative_checkpoint', {
    description: 'Checkpoint one bounded offer in the consumer already retained by the embedding owner.',
    inputSchema: inputSchemas.checkpoint, outputSchema, annotations,
  }, async (args, context) => handlers.checkpoint(args, context.mcpReq.signal));
  server.registerTool('cooperative_submit_answer', {
    description: 'Submit one answer bound to the retained signed offer and its handoff attempt.',
    inputSchema: inputSchemas.submitAnswer, outputSchema, annotations,
  }, async (args, context) => handlers.submitAnswer(args, context.mcpReq.signal));
  return server;
}
