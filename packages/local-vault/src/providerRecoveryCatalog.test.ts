import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';
import test from 'node:test';
import {LocalVault,type LocalProviderSessionBinding} from './index.js';
import {validateContract} from '@dharma-ai-labs/agent-fabric-contracts';
import {fileURLToPath} from 'node:url';

const id=(n:number)=>`d2000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
test('the exact declared recovery-tool hash survives protected binding storage without changing legacy identities',async()=>{
  const root=await mkdtemp(resolve(tmpdir(),'fabric-recovery-catalog-')),key=randomBytes(32);
  const binding:LocalProviderSessionBinding={schema:'dharma.local-provider-session-binding/v1',owner:'dharma_bridge',
    organizationId:'org_fixture',workspaceId:id(1),repositoryBindingId:id(2),endpointId:id(3),membershipId:id(4),
    deviceId:id(5),bindingId:id(6),provider:'codex',sessionId:'original_native_thread',workspaceRoot:resolve(root,'source'),
    createdAt:new Date().toISOString(),expiresAt:new Date(Date.now()+3600000).toISOString(),maximumProviderCostCents:25};
  const identity={organizationId:binding.organizationId,workspaceId:binding.workspaceId,repositoryBindingId:binding.repositoryBindingId,
    endpointId:binding.endpointId,membershipId:binding.membershipId,deviceId:binding.deviceId,provider:binding.provider};
  let vault=await LocalVault.open({root,masterKey:key});
  try{
    vault.saveProviderSessionBinding(binding);
    assert.deepEqual(vault.getProviderSessionBinding(binding.bindingId,identity),binding);
    assert.equal(vault.readProviderSessionRecoveryDeclaration(binding.bindingId,identity),null);
    const declared={...binding,bindingId:id(7),sessionId:'separate_new_fixture_thread'};
    vault.saveProviderSessionBinding(declared);
    const toolHash='sha256:'+'a'.repeat(64);
    vault.saveProviderSessionRecoveryDeclaration(declared.bindingId,identity,toolHash);
    const original=vault.readProviderSessionRecoveryDeclaration(declared.bindingId,identity)!;
    assert.equal(original.toolHash,toolHash);
    assert.equal((await validateContract(fileURLToPath(new URL('../../../schemas/',import.meta.url)),
      'https://schemas.dharma-ai.io/provider-session-recovery-declaration/v1',original)).ok,true);
    vault.close();vault=await LocalVault.open({root,masterKey:key});
    assert.deepEqual(vault.getProviderSessionBinding(declared.bindingId,identity),declared);
    assert.deepEqual(vault.getProviderSessionBinding(binding.bindingId,identity),binding);
    assert.equal(vault.readProviderSessionRecoveryDeclaration(binding.bindingId,identity),null);
    assert.deepEqual(vault.readProviderSessionRecoveryDeclaration(declared.bindingId,identity),original);
    vault.saveProviderSessionRecoveryDeclaration(declared.bindingId,identity,toolHash);
    assert.deepEqual(vault.readProviderSessionRecoveryDeclaration(declared.bindingId,identity),original);
    assert.throws(()=>vault.saveProviderSessionRecoveryDeclaration(declared.bindingId,identity,'sha256:'+'b'.repeat(64)),/declaration_conflict/);
    assert.equal((await readFile(resolve(root,'vault.sqlite'))).includes(Buffer.from(toolHash)),false);
    for(const invalid of [null,undefined,'sha256:bad'])assert.throws(()=>vault.saveProviderSessionRecoveryDeclaration(declared.bindingId,identity,invalid as any),/declaration_invalid/);
    assert.throws(()=>vault.readProviderSessionRecoveryDeclaration(declared.bindingId,{...identity,membershipId:id(8)}),/scope_mismatch/);
    vault.revokeProviderSessionBinding(declared.bindingId,identity);
    assert.throws(()=>vault.readProviderSessionRecoveryDeclaration(declared.bindingId,identity),/declaration_unavailable/);
  }finally{vault.close();key.fill(0);await rm(root,{recursive:true,force:true});}
});
