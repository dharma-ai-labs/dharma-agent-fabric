import { randomUUID } from 'node:crypto';
import { canonicalize, sha256 } from '@dharma-ai-labs/agent-fabric-contracts';
import { isSupportedNodeVersion } from './runtime-bootstrap.js';

export type GuidedEntryBlockedCode = 'guided_entry_interactive_required'
  | 'guided_entry_runtime_unsupported' | 'guided_entry_context_required';

/** Route discovery has no enrollment authority. A later authenticated driver
 * must resolve the recipient, assigned role and source/knowledge binding. */
export function blockedGuidedEntry(input: {
  cliVersion: string; nodeVersion: string; interactive: boolean; now?: Date;
}) {
  const now = input.now ?? new Date();
  if (!/^[0-9]+\.[0-9]+\.[0-9]+$/.test(input.cliVersion) || input.cliVersion.length > 32
    || !Number.isFinite(now.getTime())) throw new Error('guided_entry_input_invalid');
  const code: GuidedEntryBlockedCode = !isSupportedNodeVersion(input.nodeVersion)
    ? 'guided_entry_runtime_unsupported' : !input.interactive
      ? 'guided_entry_interactive_required' : 'guided_entry_context_required';
  const result = {
    schema: 'dharma.guided-entry/v1' as const,
    operationId: randomUUID(),
    organizationId: null,
    recipientMembershipId: null,
    roleRevision: null,
    repositoryBindingId: null,
    cliVersion: input.cliVersion,
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + 5 * 60_000).toISOString(),
    ok: false as const,
    stage: 'blocked' as const,
    code,
    effects: false as const,
    ready: false as const,
    enrollmentStarted: false as const,
    authorityVerified: false as const,
    nextAction: {
      kind: 'select_recipient_context_in_portal' as const,
      url: 'https://www.dharma-ai.io/portal?section=agent-fabric&tab=instructions',
    },
  };
  return { ...result, integrity: { kind: 'public_unkeyed_sha256' as const,
    hash: sha256(canonicalize(result)), authorizesEffects: false as const } };
}
