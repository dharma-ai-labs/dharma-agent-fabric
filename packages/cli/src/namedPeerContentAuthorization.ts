import { canonicalize } from '@dharma-ai-labs/agent-fabric-contracts';
import { containsDisallowedLocalPath, redactValue, referencesExcludedPath } from '@dharma-ai-labs/agent-fabric-evidence-reduction';
import { assertPolicy, type OrganizationPolicy } from '@dharma-ai-labs/agent-fabric-policy';
import { validateRepositorySourceAuthorization } from './repositorySourceAuthorization.js';
import type { BoundRepositorySource } from './repositorySourceSync.js';
import { providerSessionTextIsSafe } from './providerSessionChannel.js';

// This authorizes bounded task-channel text, not native history or learning intake.
// Session ownership, signed offers, task/target scope and budgets remain the channel's responsibility.
export function createNamedPeerContentAuthorization(input: {
  scope: BoundRepositorySource;
  loadCurrentPolicy(): Promise<OrganizationPolicy>;
  loadCurrentSourceAuthorization(): Promise<unknown>;
  now?: () => Date;
}) {
  return async (content: string, kind: 'question' | 'answer'): Promise<boolean> => {
    if (!['question', 'answer'].includes(kind) || !providerSessionTextIsSafe(content, kind === 'answer')) return false;
    try {
      const policy = await input.loadCurrentPolicy();
      assertPolicy(policy);
      if (policy.organizationId !== input.scope.organizationId
        || containsDisallowedLocalPath(content)
        || referencesExcludedPath(content, policy.evidence.excludePaths, 'content')
        || canonicalize(redactValue(content, { classes: new Set<string>(), redactedValues: 0,
          excludedPaths: 0, inputBytes: 0, outputBytes: 0 })) !== canonicalize(content)) return false;
      const mode = policy.evidence.automaticDisclosure?.mode;
      if (mode === 'customer_authorized_content') return true;
      // Explicit metadata-only/legacy policies are not silently upgraded.
      if (mode !== 'local_analysis') return false;
      const source = validateRepositorySourceAuthorization(await input.loadCurrentSourceAuthorization(),
        input.scope, (input.now || (() => new Date()))());
      // The current signed peer contract reads '.'. Subtree approval cannot authorize that sandbox.
      return source.policy.approvedRepositoryPaths.includes('.');
    } catch { return false; }
  };
}
