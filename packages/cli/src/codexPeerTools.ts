import type { CodexToolHandler } from '@dharma-ai-labs/agent-fabric-provider-adapters/experimental/codex-session';
import type { createProviderSessionChannel } from './providerSessionChannel.js';

const uuid = { type: 'string', format: 'uuid' };
const common = { taskId: uuid, targetBindingId: uuid };
export const CODEX_PEER_TOOLS = [
  { type: 'function', name: 'dharma_peer_ask', description:
    'Ask a specific same-repository peer session a bounded question tied to a task. Queued is delivery, not an answer. No broader permissions are granted.',
    inputSchema: { type: 'object', additionalProperties: false, properties: { ...common,
      category: { type: 'string', minLength: 1, maxLength: 64 }, question: { type: 'string', minLength: 1, maxLength: 2000 } },
    required: ['taskId', 'targetBindingId', 'category', 'question'] } },
  { type: 'function', name: 'dharma_peer_reply', description:
    'Read the durable answer to your task-bound peer question. Pending, failed, expired and unavailable are not successful execution.',
    inputSchema: { type: 'object', additionalProperties: false, properties: { ...common, questionId: uuid },
      required: ['taskId', 'targetBindingId', 'questionId'] } },
];

export function createCodexPeerToolHandler(input: {
  channel(): Pick<ReturnType<typeof createProviderSessionChannel>, 'ask' | 'read'>;
  maximumProviderCostCents: number;
  authorize(): Promise<boolean>;
  authorizeContent(content: string): Promise<boolean>;
}): CodexToolHandler {
  const id = (value: unknown): value is string => typeof value === 'string'
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$(?![\s\S])/i.test(value);
  const result = (success: boolean, value: unknown) => ({ success,
    contentItems: [{ type: 'inputText' as const, text: JSON.stringify(value) }] });
  return async params => {
    const deny = (code: string) => result(false, { code });
    const ask = params.tool === 'dharma_peer_ask', read = params.tool === 'dharma_peer_reply';
    if (Object.keys(params).some(key => !['threadId', 'turnId', 'callId', 'namespace', 'tool', 'arguments'].includes(key))
      || (!ask && !read) || params.namespace != null || !params.arguments || typeof params.arguments !== 'object'
      || Array.isArray(params.arguments)) return deny('codex_peer_tool_invalid');
    const args = params.arguments as Record<string, unknown>;
    const keys = ask ? ['taskId', 'targetBindingId', 'category', 'question'] : ['taskId', 'targetBindingId', 'questionId'];
    if (Object.keys(args).length !== keys.length || Object.keys(args).some(key => !keys.includes(key))
      || !id(args.taskId) || !id(args.targetBindingId)
      || (ask ? typeof args.category !== 'string' || args.category.length > 64 || !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$(?![\s\S])/.test(args.category)
        || typeof args.question !== 'string' || !args.question.trim() || args.question.length > 2000
        || /[\u0000-\u001f\u007f]/.test(args.question) : !id(args.questionId))) return deny('codex_peer_tool_invalid');
    if (!await input.authorize()) return deny('codex_peer_tool_not_authorized');
    try {
      const receipt = ask
        ? await input.channel().ask({ targetBindingId: args.targetBindingId, taskId: args.taskId,
          category: args.category as string, question: args.question as string,
          maximumProviderCostCents: input.maximumProviderCostCents })
        : await input.channel().read(args.questionId as string, args.taskId, args.targetBindingId);
      if (!await input.authorize()) return deny('codex_peer_tool_authority_changed');
      const answer = (receipt as Record<string, unknown>).answer;
      if (typeof answer === 'string' && !await input.authorizeContent(answer)) return deny('codex_peer_tool_content_blocked');
      return result(true, receipt);
    } catch (error) {
      // A timeout may have queued a question; never invent success or silently resend it.
      const reason = error instanceof Error ? error.message : '';
      if (/^provider_session_channel_(input|response|closed|owner_lost|unavailable|uncertain)$/.test(reason)) {
        return result(false, { code: 'codex_peer_tool_delivery_unconfirmed', reasonCode: reason });
      }
      return deny('codex_peer_tool_delivery_unconfirmed');
    }
  };
}
