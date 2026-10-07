import assert from 'node:assert/strict';
import {generateKeyPairSync, randomBytes} from 'node:crypto';
import {spawn} from 'node:child_process';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {canonicalize, sha256, signCanonicalObject} from '@dharma-ai-labs/agent-fabric-contracts';
import {verifyServerAuthorizedPolicy, type OrganizationPolicy} from '@dharma-ai-labs/agent-fabric-policy';
import {LocalVault, type LocalCodexSetupSessionRequest} from '@dharma-ai-labs/agent-fabric-local-vault';
import {applyServerEvidencePolicy, materializeWorkspacePolicy} from './index.js';
import {codexSetupSessionPolicyHash, consumeCodexSetupSessions} from './codexSetupSessionHandoff.js';
import {createNamedSessionChildOwner} from './namedSessionChildOwner.js';

async function fixture(run: (f: {initial: OrganizationPolicy; renewed: OrganizationPolicy;
  publicKey: string; verify(policy: OrganizationPolicy): void}) => Promise<void>) {
  const workspace = await mkdtemp(join(tmpdir(), 'af-session-policy-'));
  try {
    const generated = await materializeWorkspacePolicy({workspace, organizationId: 'org_test', revision: 'policy-test'});
    const keys = generateKeyPairSync('ed25519'), publicKey = keys.publicKey.export({format: 'jwk'}).x!;
    function authorize(offset: number) {
      const unsigned = {schema: 'dharma.workspace-policy-authorization/v1', organizationId: 'org_test', workspaceId: 'workspace-test',
        policy: {revision: 'policy-test', evidence: generated.policy.evidence}, keyVersion: 'test',
        issuedAt: new Date(Date.now() - 60_000 + offset).toISOString(), expiresAt: new Date(Date.now() + 3_600_000 + offset).toISOString()};
      return applyServerEvidencePolicy(structuredClone(generated.policy),
        {...unsigned, signature: signCanonicalObject(unsigned, keys.privateKey)}, publicKey, 'org_test', 'workspace-test');
    }
    const initial = authorize(0), renewed = authorize(1000);
    const verify = (policy: OrganizationPolicy) => {verifyServerAuthorizedPolicy({policy, publicKeyEd25519: publicKey,
      organizationId: 'org_test', workspaceId: 'workspace-test'});};
    await run({initial, renewed, publicKey, verify});
  } finally {await rm(workspace, {recursive: true, force: true});}
}

test('a fresh valid authorization renewal preserves the exact setup policy commitment', async () => {
  await fixture(async f => {
    f.verify(f.initial); f.verify(f.renewed);
    assert.notEqual(sha256(canonicalize(f.initial)), sha256(canonicalize(f.renewed)));
    assert.equal(codexSetupSessionPolicyHash(f.initial), codexSetupSessionPolicyHash(f.renewed));
  });
});

test('encrypted handoff accepts renewal during an owned synthetic child startup', async () => {
  await fixture(async f => {
    const root = await mkdtemp(join(tmpdir(), 'af-session-policy-vault-'));
    const vault = await LocalVault.open({root, masterKey: randomBytes(32)}), controller = new AbortController();
    const id = (n: number) => `${String(n).padStart(8, '0')}-1111-4111-8111-111111111111`, digest = `sha256:${'a'.repeat(64)}`;
    const claim = vault.claimCodexSetupOperation(id(1), digest); assert.equal(claim.state, 'acquired');
    if (claim.state !== 'acquired') throw new Error('fixture_claim_missing');
    let current = f.initial, effects = 0;
    const request: LocalCodexSetupSessionRequest = {schema: 'dharma.local-codex-setup-session/v1', operationId: id(1),
      intentDigest: digest, setupReference: id(2), senderPid: process.pid, senderStartTicks: '1',
      organizationId: 'org_test', membershipId: id(3), deviceId: id(4), workspaceId: id(5),
      repositoryBindingId: id(6), endpointId: id(7), provider: 'codex', origin: 'https://hq.example',
      repositoryFingerprint: digest, policyRevision: current.revision, policyHash: codexSetupSessionPolicyHash(current),
      scopeDigest: digest, contractDigest: digest, name: 'reviewer', workspaceRoot: root,
      maximumCostCents: 1000, maximumTurnCostCents: 25, issuedAt: new Date(Date.now() - 1000).toISOString(),
      expiresAt: new Date(Date.now() + 60000).toISOString()};
    const owner = createNamedSessionChildOwner(controller.signal);
    try {
      vault.stageCodexSetupSession(claim.leaseId, digest, request);
      await owner.run(async () => {
        await consumeCodexSetupSessions({vault, owner, signal: controller.signal,
          authorize: async candidate => {f.verify(current); return codexSetupSessionPolicyHash(current) === candidate.policyHash;},
          start: async scope => {
            await scope.step(async () => {current = f.renewed;});
            const child = await scope.step(() => owner.spawn(scope.request.name,
              () => spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {stdio: 'ignore'})));
            effects++;
            return {state: 'started', bindingId: id(8), sessionId: 'synthetic', sessionPid: child.pid!,
              supervisorPid: process.pid, sessionStartTicks: '1', supervisorStartTicks: '1'};
          }});
      });
      assert.equal(vault.readCodexSetupSession(id(1), digest)?.result?.state, 'started');
      assert.equal(effects, 1);
    } finally {controller.abort(); await owner.close(); vault.close(); await rm(root, {recursive: true, force: true});}
  });
});

for (const field of ['organization', 'revision', 'commands', 'writePaths', 'network', 'budgets', 'retention', 'disclosure', 'workspace', 'keyVersion']) {
  test(`setup policy commitment rejects changed ${field}, even with otherwise renewed authorization`, async () => {
    await fixture(async f => {
      const changed = structuredClone(f.renewed);
      if (field === 'organization') changed.organizationId = 'org_foreign';
      if (field === 'revision') changed.revision = 'policy-other';
      if (field === 'commands') changed.tasks.allowedCommands = {'forbidden.command': {argv: ['forbidden'], timeoutSeconds: 1}};
      if (field === 'writePaths') changed.tasks.writePaths = ['foreign/**'];
      if (field === 'network') changed.tasks.defaultNetwork = 'allowlisted_domains';
      if (field === 'budgets') changed.budgets = {maximumCostCents: 99999};
      if (field === 'retention') changed.retention = {rawLocalDays: 999};
      if (field === 'disclosure') changed.evidence.automaticDisclosure = {mode: 'metadata_only'};
      if (field === 'workspace') changed.serverAuthorization!.workspaceId = 'foreign-workspace';
      if (field === 'keyVersion') changed.serverAuthorization!.keyVersion = 'foreign-key';
      assert.notEqual(codexSetupSessionPolicyHash(f.initial), codexSetupSessionPolicyHash(changed));
    });
  });
}

test('a stable commitment is never a substitute for fresh signature, tenant and expiry verification', async () => {
  await fixture(async f => {
    for (const field of ['signature', 'expiry', 'future', 'workspace', 'missing']) {
      const changed = structuredClone(f.renewed);
      if (field === 'signature') changed.serverAuthorization!.signature = 'tampered';
      if (field === 'expiry') changed.serverAuthorization!.expiresAt = new Date(Date.now() - 1000).toISOString();
      if (field === 'future') changed.serverAuthorization!.issuedAt = new Date(Date.now() + 600_000).toISOString();
      if (field === 'workspace') changed.serverAuthorization!.workspaceId = 'foreign-workspace';
      if (field === 'missing') delete changed.serverAuthorization;
      assert.throws(() => f.verify(changed));
    }
  });
});
