import type {LocalVault} from '@dharma-ai-labs/agent-fabric-local-vault';
import type {CodexSetupJournal} from './codexSetupAdmission.js';

export function createCodexSetupVaultJournal(vault: Pick<LocalVault,
  'claimCodexSetupOperation' | 'finishCodexSetupOperation'>): CodexSetupJournal {
  return {
    claim: async (operationId, intentDigest) => vault.claimCodexSetupOperation(operationId, intentDigest),
    finish: async (leaseId, intentDigest, result) => vault.finishCodexSetupOperation(leaseId, intentDigest, result),
  };
}
