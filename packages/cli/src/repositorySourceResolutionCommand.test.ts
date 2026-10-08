import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import test from 'node:test';
import ts from 'typescript';
import { AgentFabricClient, loadOrCreateDeviceIdentity, saveDeviceConfig, saveDeviceEnrollmentAnchor } from '@dharma-ai-labs/agent-fabric-relay-client';
import type { SecureSecretStore } from '@dharma-ai-labs/agent-fabric-secure-store';

const text = await readFile(new URL('../src/index.ts', import.meta.url), 'utf8');
const source = ts.createSourceFile('index.ts', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const declarations = source.statements.filter(node => ts.isFunctionDeclaration(node)
  && node.name?.text === 'repositorySourceResolutionCommand');
assert.equal(declarations.length, 1);
const code = ts.transpileModule(declarations[0]!.getText(source), {
  compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.CommonJS },
}).outputText;

function fixture() {
  const calls: string[] = [];
  const workspace = { organizationId: 'org_fixture', workspaceId: 'workspace', repositoryBindingId: 'binding',
    repositoryAgentId: 'agent', accessMode: 'source_connected', path: '/synthetic',
    repositoryPackage: { state: 'published', publishedLocalSnapshotHash: 'baseline', pendingLocalOperationId: null as string | null } };
  const policy = { revision: 1 };
  const knowledge = { catalogBytes: Buffer.from('catalog'), manifestBytes: Buffer.from('manifest') };
  const local = { manifest: { snapshotHash: 'local' } };
  const proposed = { plan: { schema: 'fixture' }, planHash: 'plan-hash' };
  const overrides: Record<string, unknown> = {};
  const defaults = {
    required: (flags: Map<string, unknown>, key: string) => { if (!flags.get(key)) throw new Error('missing_flag');return flags.get(key); },
    readDeviceConfig: async () => ({ organizationId: 'org_fixture' }), registry: async () => [workspace],
    AgentFabricClient: { open: async (options: { readOnly?: boolean }) => {
      assert.equal(options.readOnly, true);calls.push('client');return { openSession: async () => { calls.push('session'); } };
    } },
    configPath: () => '/synthetic/device.json', protocolStatePath: () => '/synthetic/protocol.json',
    currentBootstrapHostScope: () => undefined, VERSION: 'fixture',
    fetchRepositorySourceAuthorization: async () => { calls.push('policy');return policy; },
    installedRepositoryKnowledge: async () => { calls.push('knowledge');return knowledge; },
    inventoryRepositoryPackage: async () => { calls.push('inventory');return local; },
    fetchPublishedRepositorySource: async () => { calls.push('published');return {}; },
    repositorySourceComparisonBaseline: () => 'baseline',
    readRepositoryPackageSnapshot: async () => { calls.push('baseline');return {}; },
    planRepositorySourceResolution: () => { calls.push('plan');return proposed; },
    reconcileRepositorySourceSnapshot: () => { calls.push('reconcile');return { manifest: { snapshotHash: 'resolved' } }; },
    readRepositorySourceResolutionPlan: async () => { calls.push('read-plan');return proposed; },
    saveRepositorySourceResolutionPlan: async () => { calls.push('save'); },
    activateRepositorySourceResolution: async () => { calls.push('activate'); },
    canonicalize: JSON.stringify,
  };
  const run = (flags: Map<string, string | boolean>) => {
    const fn = runInNewContext(code + '\nrepositorySourceResolutionCommand', { exports: {}, ...defaults, ...overrides },
      { timeout: 1000, contextCodeGeneration: { strings: false, wasm: false } }) as (flags: Map<string, string | boolean>) => Promise<Record<string, unknown>>;
    return fn(flags);
  };
  const flags = (...values: Array<[string, string | boolean]>) => new Map<string, string | boolean>([['workspace-id', 'workspace'], ...values]);
  return { calls, workspace, knowledge, local, overrides, run, flags };
}

test('source resolution defaults to a read-only plan; prepare and apply have distinct local effects', async () => {
  for (const mode of ['preview', 'prepare', 'apply']) {
    const f = fixture();
    const flags = mode === 'apply' ? f.flags(['apply', true], ['plan-hash', 'plan-hash'], ['choose-reviewed-local', true])
      : mode === 'prepare' ? f.flags(['prepare', true]) : f.flags(['json', true]);
    const result = await f.run(flags);
    assert.equal(result.serverMutation, true);
    assert.equal(result.protocolSessionCreated, true);
    assert.equal(result.serverSourceMutation, false);
    assert.equal(result.durableRelayStateMutation, false);
    assert.equal(result.published, false);
    assert.equal(result.localMutation, mode !== 'preview');
    assert.equal(f.calls.includes('save'), mode === 'prepare');
    assert.equal(f.calls.includes('activate'), mode === 'apply');
    assert.equal(f.calls.filter(call => call === 'inventory').length, 2);
  }
});

test('malformed or conflicting flags cannot open a client or write a plan', async () => {
  const invalid: Array<Array<[string, string | boolean]>> = [
    [['arbitrary', true]], [['prepare', 'true']], [['apply', false]], [['workspace-id', true]],
    [['dry-run', true], ['prepare', true]], [['apply', true]], [['plan-hash', 'hash']],
    [['choose-reviewed-local', true]], [['prepare', true], ['apply', true]],
  ];
  for (const args of invalid) {
    const f = fixture();
    await assert.rejects(f.run(f.flags(...args)), /option_/);
    assert.deepEqual(f.calls, []);
  }
});

test('foreign, knowledge-only and pending workspaces are rejected before any signed request', async () => {
  for (const mode of ['foreign', 'knowledge_only', 'pending', 'blocked']) {
    const f = fixture();
    if (mode === 'foreign') f.workspace.organizationId = 'org_other';
    if (mode === 'knowledge_only') f.workspace.accessMode = mode;
    if (mode === 'pending') f.workspace.repositoryPackage.pendingLocalOperationId = 'pending';
    if (mode === 'blocked') f.workspace.repositoryPackage.state = mode;
    await assert.rejects(f.run(f.flags(['prepare', true])), /workspace_not_authorized|publication_pending/);
    assert.deepEqual(f.calls, []);
  }
});

test('missing signed knowledge and policy, knowledge or source drift prevent preparation', async () => {
  for (const mode of ['missing', 'policy', 'knowledge', 'local']) {
    const f = fixture();let n = 0;
    if (mode === 'missing') f.overrides.installedRepositoryKnowledge = async () => null;
    if (mode === 'policy') f.overrides.fetchRepositorySourceAuthorization = async () => ({ revision: ++n });
    if (mode === 'knowledge') f.overrides.installedRepositoryKnowledge = async () => ({ ...f.knowledge,
      catalogBytes: Buffer.from(String(++n)) });
    if (mode === 'local') f.overrides.inventoryRepositoryPackage = async () => ({ manifest: { snapshotHash: String(++n) } });
    await assert.rejects(f.run(f.flags(['prepare', true])), /signed_knowledge_missing|policy_changed|knowledge_changed|local_changed/);
    assert.equal(f.calls.includes('save'), false);
    assert.equal(f.calls.includes('activate'), false);
  }
});

test('flags are captured before asynchronous work; callers cannot switch preview into mutation', async () => {
  const f = fixture(), flags = f.flags();
  f.overrides.readDeviceConfig = async () => { flags.set('prepare', true);return { organizationId: 'org_fixture' }; };
  assert.equal((await f.run(flags)).localMutation, false);
  assert.equal(f.calls.includes('save'), false);
});

test('actual command wiring cannot replay pending task polls in preview, prepare, apply or later validation failure', async t => {
  for (const mode of ['default', 'dry-run', 'prepare', 'apply', 'validation-failure']) {
    for (const protocol of ['absent', 'empty', 'existing', 'pending']) await t.test(`${mode}:${protocol}`, async t => {
    const f = fixture(), root = await mkdtemp(resolve(tmpdir(), 'source-resolution-command-wire-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const values = new Map<string, string>();
    const store: SecureSecretStore = { backend: 'linux-secret-service', get: async account => values.get(account) ?? null,
      put: async (account, value) => { values.set(account, value); }, delete: async account => { values.delete(account); } };
    const identity = await loadOrCreateDeviceIdentity({ hqUrl: 'https://hq.example', organizationId: 'org_fixture', store });
    const configPath = resolve(root, 'device.json'), statePath = resolve(root, 'protocol.json');
    const config = { schema: 'dharma.device-config/v1' as const, hqUrl: 'https://hq.example', organizationId: 'org_fixture',
      deviceId: 'c72c7f13-e420-49f7-a818-c07f6f9d0915', deviceName: 'Test', platform: 'linux' as const,
      publicKeyEd25519: identity.publicKeyEd25519, serverPublicKeyEd25519: identity.publicKeyEd25519,
      relayUrl: 'wss://relay.example', enrolledAt: new Date().toISOString() };
    await saveDeviceConfig(configPath, config);await saveDeviceEnrollmentAnchor({ config, store });
    const original = JSON.stringify({ schema: 'dharma.protocol-state/v1', sessionId: protocol === 'empty' ? null : 'retained-session',
      nextSequence: protocol === 'empty' ? 1 : 7,
      pending: protocol === 'pending' ? { method: 'POST', pathname: '/api/v1/orgs/org_fixture/agent-fabric/tasks/poll',
        body: '{"leaseSeconds":120}', headers: {} } : null });
    if (protocol !== 'absent') await writeFile(statePath, original);
    const requests: Array<{ method: string; path: string }> = [];
    f.overrides.AgentFabricClient = { open: async (options: Parameters<typeof AgentFabricClient.open>[0]) => {
      assert.equal(options.readOnly, true);
      return AgentFabricClient.open({ ...options, configPath, statePath, store, fetcher: async (url, init) => {
        requests.push({ method: String(init?.method), path: new URL(String(url)).pathname });
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      } });
    } };
    f.overrides.fetchRepositorySourceAuthorization = async (fabric: AgentFabricClient) => {
      await fabric.signedGet('/agent-fabric/repository-source-policy?workspaceId=fixture');return { revision: 1 };
    };
    if (mode === 'validation-failure') f.overrides.installedRepositoryKnowledge = async () => null;
    const flags = mode === 'apply' ? f.flags(['apply', true], ['plan-hash', 'plan-hash'], ['choose-reviewed-local', true])
      : mode === 'prepare' ? f.flags(['prepare', true]) : mode === 'dry-run' ? f.flags(['dry-run', true]) : f.flags();
    if (mode === 'validation-failure') await assert.rejects(f.run(flags), /signed_knowledge_missing/);
    else assert.equal((await f.run(flags)).durableRelayStateMutation, false);
    assert.deepEqual(requests.filter(request => request.method === 'POST').map(request => request.path),
      ['/api/v1/orgs/org_fixture/agent-fabric/sessions']);
    if (protocol === 'absent') await assert.rejects(readFile(statePath, 'utf8'), /ENOENT/);
    else assert.equal(await readFile(statePath, 'utf8'), original);
    assert.equal(requests.some(request => request.path.endsWith('/tasks/poll')), false);
  });
  }
});
