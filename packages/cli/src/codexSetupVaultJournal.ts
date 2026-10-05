import type {LocalVault, ScopedCodexSetupJournal} from '@dharma-ai-labs/agent-fabric-local-vault';
import type {SecureSecretStore} from '@dharma-ai-labs/agent-fabric-secure-store';
import type {BootstrapHostScope} from './bootstrapHostScope.js';
import type {CodexSetupJournal} from './codexSetupAdmission.js';

export function createCodexSetupVaultJournal(vault: Pick<LocalVault,
  'claimCodexSetupOperation' | 'finishCodexSetupOperation'> | ScopedCodexSetupJournal): CodexSetupJournal {
  return {
    claim: async (operationId, intentDigest) => vault.claimCodexSetupOperation(operationId, intentDigest),
    finish: async (leaseId, intentDigest, result) => vault.finishCodexSetupOperation(leaseId, intentDigest, result),
  };
}

export async function openCodexSetupVaultJournal(input: {
  root: string; scope: BootstrapHostScope; store?: SecureSecretStore;
}): Promise<CodexSetupJournal & {close(): void}> {
  const {root, scope, store} = input;
  let backend: ScopedCodexSetupJournal | undefined, masterKey: Buffer | undefined;
  try {
    const vault = await scope.step(() => import('@dharma-ai-labs/agent-fabric-local-vault'));
    masterKey = await vault.loadOrCreateVaultMasterKey(store, scope);
    await scope.step(async () => {
      // Capture the owned handle before the host's post-open qualification.
      backend = await vault.LocalVault.openSetupJournal({root, masterKey: masterKey!}, scope);
    });
    return Object.freeze({...createCodexSetupVaultJournal(backend!), close: () => backend!.close()});
  } catch (error) {
    backend?.close();
    throw error;
  } finally {masterKey?.fill(0);}
}
