import { canonicalize } from '@dharma-ai-labs/agent-fabric-contracts';
import { containsDisallowedLocalPath, redactValue, referencesExcludedPath } from '@dharma-ai-labs/agent-fabric-evidence-reduction';
import { assertPolicy, type OrganizationPolicy } from '@dharma-ai-labs/agent-fabric-policy';
import { validateRepositorySourceAuthorization } from './repositorySourceAuthorization.js';
import type { BoundRepositorySource } from './repositorySourceSync.js';
import { providerSessionTextIsSafe } from './providerSessionChannel.js';

export type NamedPeerContentBlocker = 'text_contract_invalid' | 'foreign_policy' | 'private_local_path'
  | 'excluded_path' | 'redaction_required' | 'metadata_only' | 'source_authority_unavailable'
  | 'source_subtree_not_authorized' | 'authority_unavailable';

export class NamedPeerContentAuthorizationError extends Error {
  constructor(readonly blocker: NamedPeerContentBlocker) {
    super('provider_session_channel_input');
  }
}

// This authorizes bounded task-channel text, not native history or learning intake.
// Session ownership, signed offers, task/target scope and budgets remain the channel's responsibility.
export function createNamedPeerContentAuthorization(input: {
  scope: BoundRepositorySource;
  loadCurrentPolicy(): Promise<OrganizationPolicy>;
  loadCurrentSourceAuthorization(): Promise<unknown>;
  now?: () => Date;
  diagnostics?: boolean;
}) {
  function deny(blocker: NamedPeerContentBlocker): false {
    if (input.diagnostics) throw new NamedPeerContentAuthorizationError(blocker);
    return false;
  }
  return async (content: string, kind: 'question' | 'answer'): Promise<boolean> => {
    if (!['question', 'answer'].includes(kind) || !providerSessionTextIsSafe(content, kind === 'answer')) return deny('text_contract_invalid');
    try {
      const policy = await input.loadCurrentPolicy();
      assertPolicy(policy);
      if (policy.organizationId !== input.scope.organizationId) return deny('foreign_policy');
      if (containsDisallowedLocalPath(content)) return deny('private_local_path');
      if (referencesExcludedPath(content, policy.evidence.excludePaths, 'content')) return deny('excluded_path');
      if (canonicalize(redactValue(content, { classes: new Set<string>(), redactedValues: 0,
        excludedPaths: 0, inputBytes: 0, outputBytes: 0 })) !== canonicalize(content)) return deny('redaction_required');
      const mode = policy.evidence.automaticDisclosure?.mode;
      if (mode === 'customer_authorized_content') return true;
      // Explicit metadata-only/legacy policies are not silently upgraded.
      if (mode !== 'local_analysis') return deny('metadata_only');
      let source: ReturnType<typeof validateRepositorySourceAuthorization>;
      try {
        source = validateRepositorySourceAuthorization(await input.loadCurrentSourceAuthorization(),
          input.scope, (input.now || (() => new Date()))());
      } catch { return deny('source_authority_unavailable'); }
      // The current signed peer contract reads '.'. Subtree approval cannot authorize that sandbox.
      return source.policy.approvedRepositoryPaths.includes('.') || deny('source_subtree_not_authorized');
    } catch (error) {
      if (error instanceof NamedPeerContentAuthorizationError) throw error;
      return deny('authority_unavailable');
    }
  };
}
