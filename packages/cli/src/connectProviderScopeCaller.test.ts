import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import test from 'node:test';
import ts from 'typescript';
import { parseCliOptions, parseSelectedProviderIds } from './index.js';

// `dharma repositories connect --provider codex` was refused with
// repository_source_policy_authorization_required, rerun after the owner allowed it, and
// the repository agent ended up with codex, claude, agy and hermes endpoints. The connect
// registered codex only; the relay's policy refresh and the transmission refresh then
// registered every adapter, because neither knew which providers the connect selected.

type Row = Record<string, any>;
type Run = (...args: any[]) => Promise<any>;

const workspaceId = '11111111-1111-4111-8111-111111111111';
const organizationId = 'org_fixture';
const policyRevision = 'agent-fabric-policy-v1';
const LOCAL_PROVIDER_IDS = ['codex', 'claude', 'agy', 'hermes'];

// The actual source of the connect path and of both policy syncs that run without a
// provider list. Every network, enrollment and process boundary below them is injected.
const SOURCE_FUNCTIONS = ['repositoriesConnect', 'repositoryKeyAssignments', 'required', 'onboard',
  'registerWorkspaceBeforeRepositoryBind', 'syncWorkspacePolicy', 'refreshVerifiedWorkspacePolicyForTransmission'];
// Helpers the fix adds. They are compiled when the source has them, so this file also runs
// against the code before the fix and shows the selection being lost there.
const SCOPE_FUNCTIONS = ['connectedProviderScope', 'recordConnectedProviderScope'];

async function compile(dependencies: Row): Promise<Record<string, Run>> {
  const text = await readFile(fileURLToPath(new URL('../src/index.ts', import.meta.url)), 'utf8');
  const source = ts.createSourceFile('index.ts', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const nodes = source.statements.filter((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node)
    && [...SOURCE_FUNCTIONS, ...SCOPE_FUNCTIONS].includes(node.name?.text ?? ''));
  for (const name of SOURCE_FUNCTIONS) {
    assert.equal(nodes.filter(node => node.name?.text === name).length, 1, `${name} must resolve exactly once.`);
  }
  const compiled = ts.transpileModule(nodes.map(node => node.getText(source)).join('\n'), {
    compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.None },
    reportDiagnostics: true,
  });
  assert.equal(compiled.diagnostics?.filter(item => item.category === ts.DiagnosticCategory.Error).length, 0);
  return runInNewContext(`${compiled.outputText}\n({ ${SOURCE_FUNCTIONS.join(', ')} })`, dependencies, {
    timeout: 1000, contextCodeGeneration: { strings: false, wasm: false },
  }) as Record<string, Run>;
}

async function fixture(t: test.TestContext) {
  const home = await realpath(await mkdtemp(resolve(tmpdir(), 'dharma-connect-scope-')));
  t.after(() => rm(home, { recursive: true, force: true }));
  const repo = resolve(home, 'repo');
  const rows: Row[] = [];
  // The provider list of every workspace registration this device sends, in order.
  const registrations: Array<string[] | null> = [];
  const fabric = { config: {} };
  const dependencies: Row = {
    resolve, dirname, basename, readFile, parseSelectedProviderIds,
    UUID_PATTERN: /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    isLocalProviderId: (value: string) => LOCAL_PROVIDER_IDS.includes(value),
    dharmaHome: () => home,
    writeJsonAtomic: async (path: string, value: unknown) => {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, `${JSON.stringify(value)}\n`);
    },
    realpath: async (path: string) => resolve(path),
    normalizeHqUrl: (value: string) => value,
    portalUrl: () => 'https://fixture.invalid',
    readDeviceConfig: async () => ({ organizationId, deviceId: 'device_fixture', hqUrl: 'https://fixture.invalid' }),
    currentBootstrapHostScope: () => null,
    inspectRegistryRecoveryFile: async () => ({ kind: 'valid' }),
    workspaceRegistryPath: () => resolve(home, 'registry', 'workspaces.json'),
    registry: async () => rows.map(row => ({ ...row })),
    preflightBootstrapWorkspaceIdentity: async () => ({ fingerprint: `sha256:${'e'.repeat(64)}` }),
    selectDeviceWorkspace: (records: Row[], input: Row) => records.find(row => row.path === input.path) ?? null,
    workspaceAdd: async (flags: Map<string, string | boolean>) => {
      rows.push({ workspaceId, organizationId, name: 'repo', path: String(flags.get('path')),
        routeHash: `sha256:${'a'.repeat(64)}`, repositoryRemoteHash: `sha256:${'e'.repeat(64)}`,
        defaultBranch: 'main', status: 'active' });
    },
    client: async () => fabric,
    relayAutostartReport: async () => ({}),
    withWorkspacePolicySyncOrder: async (_fabric: unknown, _workspaceId: string, operation: () => Promise<unknown>) =>
      operation(),
    providerCapabilitiesForWorkspacePolicy: async (providerIds: string[] | null) => {
      registrations.push(providerIds ? [...providerIds] : null);
      return [];
    },
    syncWorkspacePolicyHoldingRefreshLock: async () => ({ ok: true, organizationId,
      workspace: { id: workspaceId, status: 'active' }, localPolicy: { revision: policyRevision } }),
    reconcileWorkspaceRegistration: (_records: unknown, item: Row) => item,
    bindRepositoryAgent: async (item: Row) => ({ ...item,
      repositoryBindingId: '22222222-2222-4222-8222-222222222222',
      repositoryAgentId: '33333333-3333-4333-8333-333333333333' }),
    loadVerifiedWorkspacePolicy: async () => ({ organizationId, revision: policyRevision }),
    // The owner has not yet allowed this repository's source policy.
    fetchRepositorySourceAuthorization: async () => {
      throw new Error('repository_source_policy_authorization_required');
    },
    canonicalFilesystemPath: async (path: string) => path,
    loadOrganizationPolicy: async () => ({ organizationId, revision: policyRevision }),
  };
  const source = await compile(dependencies);
  const connect = async (...providers: string[]) => {
    const argv = ['repositories', 'connect', '--repo', repo, '--organization-id', organizationId,
      '--policy-revision', policyRevision, '--repository-key', 'fixture-repository',
      ...providers.flatMap(provider => ['--provider', provider])];
    const { flags, positional, repeated } = parseCliOptions(argv);
    // The same arguments the CLI dispatch passes for `repositories connect`.
    return JSON.parse(JSON.stringify(await source.repositoriesConnect!(flags, positional.slice(2),
      repeated.get('repo') || [], repeated.get('repository-key') || [], repeated.get('provider') || []))) as Row;
  };
  // What the running relay does every minute, and what each content transmission does first.
  const relayPolicyRefresh = () => source.syncWorkspacePolicy!(fabric, rows[0], policyRevision, true);
  const transmissionRefresh = () => source.refreshVerifiedWorkspacePolicyForTransmission!(
    resolve(repo, '.dharma', 'approved-policy.json'), workspaceId, fabric);
  return { home, registrations, connect, relayPolicyRefresh, transmissionRefresh };
}

test('after a refused connect that selected codex, the relay and transmission refreshes register codex only', async t => {
  const f = await fixture(t);
  const refused = await f.connect('codex');
  assert.equal(refused.ok, false);
  assert.equal(refused.repositories[0].stage, 'repository_source_authorization_required');
  await f.relayPolicyRefresh();
  await f.transmissionRefresh();
  // The rerun of the same command after the owner allows the source policy starts the same way.
  await f.connect('codex');
  await f.relayPolicyRefresh();
  assert.deepEqual(f.registrations, [['codex'], ['codex'], ['codex'], ['codex'], ['codex']]);
});

test('a later connect that selects another provider adds it to what the relay registers', async t => {
  const f = await fixture(t);
  await f.connect('codex');
  await f.connect('claude');
  await f.relayPolicyRefresh();
  assert.deepEqual(f.registrations, [['codex'], ['claude'], ['codex', 'claude']]);
});

test('a connect without --provider leaves the relay registering every adapter, as before', async t => {
  const f = await fixture(t);
  await f.connect();
  await f.relayPolicyRefresh();
  await f.transmissionRefresh();
  assert.deepEqual(f.registrations, [null, null, null]);
});

// A broken record must not stop the relay's policy refresh, so it falls back to the behaviour before this fix.
test('a recorded selection ignores unknown entries, and an unreadable one falls back to every adapter', async t => {
  const f = await fixture(t);
  await f.connect('codex');
  const [recorded] = await findScopeFiles(f.home);
  assert.ok(recorded, 'the connect records its provider selection under DHARMA_HOME');
  await writeFile(recorded, `${JSON.stringify(['codex', 'not-a-provider', 7])}\n`);
  await f.relayPolicyRefresh();
  await writeFile(recorded, '{not json');
  await f.relayPolicyRefresh();
  assert.deepEqual(f.registrations, [['codex'], ['codex'], null]);
});

async function findScopeFiles(home: string): Promise<string[]> {
  const found: string[] = [];
  const walk = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.name === `${workspaceId}.json`) found.push(path);
    }
  };
  await walk(home);
  return found;
}
