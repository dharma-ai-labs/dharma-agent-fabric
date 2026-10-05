import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import {createHash, generateKeyPairSync, randomUUID} from 'node:crypto';
import {dirname, resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {runInNewContext} from 'node:vm';
import test from 'node:test';
import ts from 'typescript';
import {assertPolicy, loadOrganizationPolicy} from '@dharma-ai-labs/agent-fabric-policy';
import {signCanonicalObject} from '@dharma-ai-labs/agent-fabric-contracts';
import {currentBootstrapHostScope, runCodexBootstrapHost} from './bootstrapHostScope.js';
import {writeBootstrapHostJson} from './bootstrapHostFiles.js';
import {applyServerEvidencePolicy, pathExistsOrThrow} from './index.js';

async function fixture(t: {after(fn: () => Promise<void>): void}) {
  const root = await fs.mkdtemp(resolve(tmpdir(), 'dharma-policy-scope-'));
  t.after(() => fs.rm(root, {recursive: true, force: true}));
  await fs.writeFile(resolve(root, 'package.json'), JSON.stringify({scripts: {test: 'node --test'}}));
  const now = Date.now(), digest = `sha256:${'a'.repeat(64)}`;
  const id = (n: number) => `${String(n).padStart(8, '0')}-1111-4111-8111-111111111111`;
  return {root, workspaceId: id(5), policyPath: resolve(root, '.dharma', 'approved-policy.json'),
    input: {workspace: root, current: async () => true, signal: new AbortController().signal,
      intent: {schema: 'dharma.codex-setup-intent/v1' as const, operationId: id(1), setupReference: id(2),
        organizationId: 'org_demo', recipientMembershipId: id(3), origin: 'https://hq.example',
        repositoryFingerprint: digest, policyRevision: 'policy-v1', scopeDigest: digest, contractDigest: digest,
        hostContextId: id(4), issuedAt: new Date(now - 1000).toISOString(), expiresAt: new Date(now + 60_000).toISOString()}}};
}

async function callers(root: string, overrides: Record<string, unknown> = {}) {
  const source = await fs.readFile(new URL('../src/index.ts', import.meta.url), 'utf8');
  const ast = ts.createSourceFile('index.ts', source, ts.ScriptTarget.Latest, true);
  const names = ['materializeWorkspacePolicy', 'workspaceAuthorizationStatePath', 'assertWorkspaceAuthorizationCurrent',
    'applyWorkspaceAuthorizationAtomically', 'newEvidenceUploadLedger', 'assertEvidenceLedger',
    'evidenceLedgerForPolicyActivation', 'pathExists', 'acquirePidLock', 'withFileLock', 'writeJsonAtomic'];
  const declarations = names.map(name => {
    const nodes = ast.statements.filter(node => ts.isFunctionDeclaration(node) && node.name?.text === name);
    assert.equal(nodes.length, 1); return nodes[0]!.getText(ast);
  });
  const output = ts.transpileModule(declarations.join('\n'), {compilerOptions: {
    target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.None}, reportDiagnostics: true});
  assert.equal(output.diagnostics?.filter(item => item.category === ts.DiagnosticCategory.Error).length, 0);
  return runInNewContext(`${output.outputText}\n({${names.join(',')}})`, {...fs, dirname, resolve, createHash, randomUUID,
    Buffer, process, Date, setTimeout, structuredClone, exports: {}, currentBootstrapHostScope,
    writeBootstrapHostJson, pathExistsOrThrow, assertPolicy, loadOrganizationPolicy, applyServerEvidencePolicy,
    dharmaHome: () => root, evidenceUploadLedgerPath: () => resolve(root, 'relay', 'evidence-upload-ledger.json'),
    ...overrides}, {timeout: 1000, contextCodeGeneration: {strings: false, wasm: false}}) as Record<string, (...args: any[]) => Promise<any>>;
}

function signed(workspaceId: string) {
  const keys = generateKeyPairSync('ed25519'), now = Date.now();
  const unsigned = {schema: 'dharma.workspace-policy-authorization/v1', organizationId: 'org_demo', workspaceId,
    policy: {revision: 'signed-test-policy', evidence: {automaticDisclosure: {mode: 'customer_authorized_content',
      consentReceiptId: 'synthetic-consent', allowedContentClasses: ['native_provider_payload']},
      maximumCapsuleBytes: 1000, maximumDailyUploadBytes: 10000, maximumExpansionBytes: 100,
      excludePaths: ['**/.env', '**/*.key'], pseudonymizeIdentity: true}},
    issuedAt: new Date(now - 1000).toISOString(), expiresAt: new Date(now + 60_000).toISOString(), keyVersion: 'synthetic'};
  return {envelope: {...unsigned, signature: signCanonicalObject(unsigned, keys.privateKey)},
    publicKey: keys.publicKey.export({format: 'jwk'}).x!};
}

test('policy scope refuses materialization and replay inspection before closed-owner reads', async t => {
  const f = await fixture(t); let reads = 0;
  const c = await callers(f.root, {readFile: async (...args: Parameters<typeof fs.readFile>) => {reads++; return fs.readFile(...args);}});
  for (const replay of [false, true]) {
    let result: PromiseSettledResult<unknown>[] = [];
    await assert.rejects(runCodexBootstrapHost(f.input, async ({scope}) => {
      scope.close(); result = await Promise.allSettled([replay
        ? c.assertWorkspaceAuthorizationCurrent!(f.workspaceId, {issuedAt: new Date().toISOString(), signature: 'synthetic'}, false)
        : c.materializeWorkspacePolicy!({workspace: f.root, organizationId: 'org_demo', revision: 'local'})]);
    }), {message: 'codex_setup_host_scope_unavailable'});
    assert.equal(result[0]?.status, 'rejected');
  }
  assert.equal(reads, 0); await assert.rejects(fs.lstat(f.policyPath), {code: 'ENOENT'});
});

test('policy scope cannot swallow cancellation in optional package inspection', async t => {
  const f = await fixture(t); let laterAccess = 0, returned = false;
  await assert.rejects(runCodexBootstrapHost(f.input, async ({scope}) => {
    const c = await callers(f.root, {readFile: async (...args: Parameters<typeof fs.readFile>) => {
      const value = await fs.readFile(...args); scope.close(); return value;
    }, access: async (...args: Parameters<typeof fs.access>) => {laterAccess++; return fs.access(...args);}});
    await c.materializeWorkspacePolicy!({workspace: f.root, organizationId: 'org_demo', revision: 'local'}); returned = true;
  }), {message: 'codex_setup_host_scope_unavailable'});
  assert.equal(returned, false); assert.equal(laterAccess, 0);
  await assert.rejects(fs.lstat(f.policyPath), {code: 'ENOENT'});
});

test('policy scope snapshots original materialization parameters before asynchronous reads', async t => {
  const f = await fixture(t), input = {workspace: f.root, organizationId: 'org_demo', revision: 'original'};
  let mutated = false;
  const c = await callers(f.root, {readFile: async (...args: Parameters<typeof fs.readFile>) => {
    const value = await fs.readFile(...args); if (!mutated) {mutated = true; input.organizationId = 'foreign'; input.revision = 'changed';}
    return value;
  }});
  await runCodexBootstrapHost(f.input, async () => {
    const result = await c.materializeWorkspacePolicy!(input);
    assert.equal(result.policy.organizationId, 'org_demo'); assert.equal(result.policy.revision, 'original');
  });
});

test('policy scope stops after native existing-policy load withdraws ownership', async t => {
  const f = await fixture(t), c = await callers(f.root);
  await c.materializeWorkspacePolicy!({workspace: f.root, organizationId: 'org_demo', revision: 'original'});
  let returned = false, laterDirectories = 0;
  await assert.rejects(runCodexBootstrapHost(f.input, async ({scope}) => {
    const bound = await callers(f.root, {mkdir: async (...args: Parameters<typeof fs.mkdir>) => {
      if (scope.signal.aborted) laterDirectories++; return fs.mkdir(...args);
    }, loadOrganizationPolicy: async (path: string) => {
      const value = await loadOrganizationPolicy(path); scope.close(); return value;
    }});
    await bound.materializeWorkspacePolicy!({workspace: f.root, organizationId: 'org_demo', revision: 'new'}); returned = true;
  }), {message: 'codex_setup_host_scope_unavailable'});
  assert.equal(returned, false); assert.equal(laterDirectories, 0);
  assert.equal((await loadOrganizationPolicy(f.policyPath)).revision, 'original');
});

test('policy scope preserves cancellation classification after replay-state read loss', async t => {
  const f = await fixture(t); let captured: unknown;
  await assert.rejects(runCodexBootstrapHost(f.input, async ({scope}) => {
    const c = await callers(f.root, {readFile: async () => {
      scope.close(); throw Object.assign(new Error('private-state-canary'), {code: 'ENOENT'});
    }});
    try {await c.assertWorkspaceAuthorizationCurrent!(f.workspaceId,
      {issuedAt: new Date().toISOString(), signature: 'synthetic'}, false);} catch (error) {captured = error; throw error;}
  }), {message: 'codex_setup_host_scope_unavailable'});
  assert.equal((captured as Error)?.message, 'codex_setup_host_scope_unavailable');
});

test('policy scope snapshots signed authorization before replay read', async t => {
  const f = await fixture(t), issuedAt = new Date().toISOString();
  const state = resolve(f.root, 'registry', 'workspace-authorizations', `${f.workspaceId}.json`);
  await fs.mkdir(dirname(state), {recursive: true}); await fs.writeFile(state, JSON.stringify({issuedAt, signature: 'original'}));
  const incoming = {issuedAt, signature: 'original'};
  const c = await callers(f.root, {readFile: async (...args: Parameters<typeof fs.readFile>) => {
    const value = await fs.readFile(...args); incoming.signature = 'changed'; return value;
  }});
  await runCodexBootstrapHost(f.input, () => c.assertWorkspaceAuthorizationCurrent!(f.workspaceId, incoming));
});

test('policy scope refuses unreadable path probes instead of creating replacement authority', async t => {
  const f = await fixture(t), c = await callers(f.root, {access: async () => {
    throw Object.assign(new Error('private-access-canary'), {code: 'EACCES'});
  }, pathExistsOrThrow: async () => {throw new Error('private-access-canary');}});
  await runCodexBootstrapHost(f.input, async () => {
    await assert.rejects(c.materializeWorkspacePolicy!({workspace: f.root, organizationId: 'org_demo', revision: 'local'}),
      (error: Error) => error.message === 'workspace_policy_materialization_failed' && error.cause === undefined);
  });
  await assert.rejects(fs.lstat(f.policyPath), {code: 'ENOENT'});
});

test('policy activation scope stops inner replay reads before ledger and policy writes', async t => {
  const f = await fixture(t), c = await callers(f.root);
  const generated = await c.materializeWorkspacePolicy!({workspace: f.root, organizationId: 'org_demo', revision: 'original'});
  const original = await fs.readFile(f.policyPath, 'utf8');
  const authorization = {issuedAt: new Date().toISOString(), signature: 'synthetic'};
  let laterReads = 0, laterAccess = 0;
  await assert.rejects(runCodexBootstrapHost(f.input, async ({scope}) => {
    const bound = await callers(f.root, {readFile: async (...args: Parameters<typeof fs.readFile>) => {
      if (scope.signal.aborted) laterReads++;
      if (String(args[0]).includes('workspace-authorizations')) {
        scope.close(); throw Object.assign(new Error('private-missing-state'), {code: 'ENOENT'});
      }
      return fs.readFile(...args);
    }, access: async (...args: Parameters<typeof fs.access>) => {
      if (scope.signal.aborted) laterAccess++; return fs.access(...args);
    }});
    await bound.applyWorkspaceAuthorizationAtomically!({workspaceId: f.workspaceId, authorization,
      policyPath: f.policyPath, policy: generated.policy});
  }), {message: 'codex_setup_host_scope_unavailable'});
  assert.equal(await fs.readFile(f.policyPath, 'utf8'), original);
  assert.equal(laterReads, 0); assert.equal(laterAccess, 0);
  const names = await fs.readdir(resolve(f.root, 'registry', 'workspace-authorizations'));
  assert.deepEqual(names, []);
});

test('current policy scope admits an actual signed envelope and persists replay and content ledgers', async t => {
  const f = await fixture(t), c = await callers(f.root), authorization = signed(f.workspaceId);
  await runCodexBootstrapHost(f.input, async () => {
    const result = await c.materializeWorkspacePolicy!({workspace: f.root, organizationId: 'org_demo', revision: 'local',
      workspaceId: f.workspaceId, serverPolicyAuthorization: authorization.envelope,
      serverPublicKeyEd25519: authorization.publicKey});
    assert.equal(result.policy.revision, 'signed-test-policy'); assert.equal(result.applied, true);
  });
  assert.equal((await loadOrganizationPolicy(f.policyPath)).serverAuthorization?.signature, authorization.envelope.signature);
  const state = JSON.parse(await fs.readFile(resolve(f.root, 'registry', 'workspace-authorizations', `${f.workspaceId}.json`), 'utf8'));
  assert.equal(state.signature, authorization.envelope.signature); assert.equal(state.contentLedgerInitialized, true);
  assert.equal(JSON.parse(await fs.readFile(resolve(f.root, 'relay', 'evidence-upload-ledger.json'), 'utf8')).totalBytes, 0);
});

test('policy scope rejects tampered or foreign envelopes without persisting authority', async t => {
  for (const foreign of [false, true]) {
    const f = await fixture(t), c = await callers(f.root), authorization = signed(f.workspaceId);
    const envelope = foreign ? {...authorization.envelope, organizationId: 'org_foreign'}
      : {...authorization.envelope, signature: 'tampered'};
    await runCodexBootstrapHost(f.input, async () => {
      await assert.rejects(c.materializeWorkspacePolicy!({workspace: f.root, organizationId: 'org_demo', revision: 'local',
        workspaceId: f.workspaceId, serverPolicyAuthorization: envelope, serverPublicKeyEd25519: authorization.publicKey}),
      {message: 'workspace_policy_materialization_failed'});
    });
    await assert.rejects(fs.lstat(f.policyPath), {code: 'ENOENT'});
    await assert.rejects(fs.lstat(resolve(f.root, 'registry')), {code: 'ENOENT'});
  }
});

test('policy scope dry-run verifies a signed envelope without creating any policy or ledger', async t => {
  const f = await fixture(t), c = await callers(f.root), authorization = signed(f.workspaceId);
  await runCodexBootstrapHost(f.input, async () => {
    const result = await c.materializeWorkspacePolicy!({workspace: f.root, organizationId: 'org_demo', revision: 'local',
      workspaceId: f.workspaceId, serverPolicyAuthorization: authorization.envelope,
      serverPublicKeyEd25519: authorization.publicKey, dryRun: true});
    assert.equal(result.policy.revision, 'signed-test-policy'); assert.equal(result.applied, false);
  });
  assert.deepEqual(await fs.readdir(f.root), ['package.json']);
});

test('policy activation scope preserves partial replay evidence but denies the next policy write', async t => {
  const f = await fixture(t), c = await callers(f.root), authorization = signed(f.workspaceId);
  await c.materializeWorkspacePolicy!({workspace: f.root, organizationId: 'org_demo', revision: 'original'});
  const original = await fs.readFile(f.policyPath, 'utf8');
  await assert.rejects(runCodexBootstrapHost(f.input, async ({scope}) => {
    const bound = await callers(f.root, {writeBootstrapHostJson: async (...args: Parameters<typeof writeBootstrapHostJson>) => {
      await writeBootstrapHostJson(...args);
      if (args[0].includes('workspace-authorizations')) scope.close();
    }});
    await bound.materializeWorkspacePolicy!({workspace: f.root, organizationId: 'org_demo', revision: 'local',
      workspaceId: f.workspaceId, serverPolicyAuthorization: authorization.envelope,
      serverPublicKeyEd25519: authorization.publicKey});
  }), {message: 'codex_setup_host_scope_unavailable'});
  assert.equal(await fs.readFile(f.policyPath, 'utf8'), original);
  const state = JSON.parse(await fs.readFile(resolve(f.root, 'registry', 'workspace-authorizations', `${f.workspaceId}.json`), 'utf8'));
  assert.equal(state.signature, authorization.envelope.signature);
  assert.deepEqual(await fs.readdir(resolve(f.root, 'registry', 'workspace-authorizations')), [`${f.workspaceId}.json`]);
});
