import {canonicalize} from '@dharma-ai-labs/agent-fabric-contracts';
import {types} from 'node:util';
import {parseLocalCodexSetupReadiness, type LocalCodexSetupReadiness}
  from '@dharma-ai-labs/agent-fabric-local-vault/setup-readiness';
import type {ScopedLocalVault} from '@dharma-ai-labs/agent-fabric-local-vault';
import {prepareCodexBootstrapHost, type BootstrapHostScope} from './bootstrapHostScope.js';
import type {CodexSetupExecutionLease, CodexSetupIntent} from './codexSetupAdmission.js';

type Store = Pick<ScopedLocalVault, 'recordCodexSetupReadiness' | 'getCodexSetupReadiness'>;

/** Host-only persistence/verification. This is not a runtime observer and must
 * never be registered as a model/peer tool. Its observer must independently
 * read the signed package, protected identity and actual native runtime. */
export function createCodexSetupReadinessOwner(input: {
  intent: CodexSetupIntent; workspace: string; scope: BootstrapHostScope; vault: Store;
  observe(intent: Readonly<CodexSetupIntent>, scope: BootstrapHostScope): Promise<LocalCodexSetupReadiness>;
}) {
  const {scope, vault, observe} = input;
  const prepared = prepareCodexBootstrapHost({intent: input.intent, workspace: input.workspace,
    signal: scope.signal, current: () => scope.current()});
  const intent = prepared.intent;
  // The parent owns lifecycle withdrawal; the temporary validation scope adds
  // no independent operation or authority.
  prepared.scope.close();
  const sameIntent = (value: Readonly<CodexSetupIntent>) => canonicalize(value) === canonicalize(intent);
  const bound = (raw: unknown, requireRecent: boolean) => {
    const value = parseLocalCodexSetupReadiness(raw), now = Date.now();
    if (value.operationId !== intent.operationId || value.organizationId !== intent.organizationId
      || value.membershipId !== intent.recipientMembershipId || value.repositoryFingerprint !== intent.repositoryFingerprint
      || value.policyRevision !== intent.policyRevision || value.contractDigest !== intent.contractDigest
      || Date.parse(value.verifiedAt) < Date.parse(intent.issuedAt)
      || Date.parse(value.verifiedAt) > now || requireRecent && now - Date.parse(value.verifiedAt) > 60_000
      || Date.parse(value.expiresAt) > Date.parse(intent.expiresAt) || now >= Date.parse(value.expiresAt)) {
      throw new Error('setup_readiness_context_unconfirmed');
    }
    return value;
  };
  const stable = (value: LocalCodexSetupReadiness) => {
    const {verifiedAt: _verified, relayPolledAt: _poll, expiresAt: _expiry, ...identity} = value;
    return canonicalize(identity);
  };
  return Object.freeze({
    record: async (lease: Readonly<CodexSetupExecutionLease>) => {
      // Snapshot original lease strings before the first asynchronous check.
      if (!lease || typeof lease !== 'object' || types.isProxy(lease)) throw new Error('setup_readiness_lease_invalid');
      const fields = Object.getOwnPropertyDescriptors(lease);
      if (Reflect.ownKeys(fields).length !== 2 || !Object.hasOwn(fields.leaseId ?? {}, 'value')
        || !Object.hasOwn(fields.intentDigest ?? {}, 'value')
        || typeof fields.leaseId!.value !== 'string' || typeof fields.intentDigest!.value !== 'string') {
        throw new Error('setup_readiness_lease_invalid');
      }
      const leaseId = fields.leaseId!.value as string, intentDigest = fields.intentDigest!.value as string;
      const observation = await scope.step(async () => bound(await observe(intent, scope), true));
      const receipt = await scope.step(() => vault.recordCodexSetupReadiness(leaseId, intentDigest, observation));
      // Do not acknowledge a write solely from its return value.
      const persisted = await scope.step(() => vault.getCodexSetupReadiness(receipt.receiptId, intent.operationId, intentDigest));
      if (!persisted || persisted.observationHash !== receipt.observationHash
        || canonicalize(persisted.observation) !== canonicalize(observation)) throw new Error('setup_readiness_persistence_unconfirmed');
      return {state: 'completed' as const, readinessReceiptId: persisted.receiptId};
    },
    verify: async (receiptId: string, requested: Readonly<CodexSetupIntent>, intentDigest: string) => {
      try {
        await scope.assert();
        if (!sameIntent(requested)) return false;
        const receipt = await scope.step(() => vault.getCodexSetupReadiness(receiptId, intent.operationId, intentDigest));
        if (!receipt) return false;
        // A durable receipt is historical evidence. Its age is not current
        // liveness; only the separately observed runtime must be recent.
        const retained = bound(receipt.observation, false);
        const current = await scope.step(async () => bound(await observe(intent, scope), true));
        return stable(retained) === stable(current) && await scope.current();
      } catch {return false;}
    },
  });
}
