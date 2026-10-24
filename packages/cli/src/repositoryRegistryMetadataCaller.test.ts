import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import test from 'node:test';
import ts from 'typescript';
import * as usage from './usage.js';

type Flags = Map<string, string | boolean>;
type Caller = (...args: any[]) => Promise<Record<string, any>>;

async function caller(name: string, dependencies: Record<string, unknown>): Promise<Caller> {
  const text = await readFile(fileURLToPath(new URL('../src/index.ts', import.meta.url)), 'utf8');
  const source = ts.createSourceFile('index.ts', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const names = name === 'run' ? ['parseCliOptions', 'canonicalEndpointRole', 'repositoriesList', 'run'] : ['canonicalEndpointRole', name];
  const functions = names.map(selected => {
    const found = source.statements.filter(node => ts.isFunctionDeclaration(node) && node.name?.text === selected);
    assert.equal(found.length, 1);
    return found[0]!.getText(source);
  });
  const compiled = ts.transpileModule(functions.join('\n'), {
    compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.None }, reportDiagnostics: true,
  });
  assert.equal(compiled.diagnostics?.filter(item => item.category === ts.DiagnosticCategory.Error).length, 0);
  // The dispatcher's pure usage text helpers come first; fixture dependencies stay authoritative.
  return runInNewContext(`${compiled.outputText}\n${name}`, { exports: {}, ...usage, ...dependencies }, {
    timeout: 1000, contextCodeGeneration: { strings: false, wasm: false },
  }) as Caller;
}

function fixture() {
  const calls: string[] = [];
  const row = {
    organizationId: 'org_fixture', workspaceId: '11111111-1111-4111-8111-111111111111', name: 'private label',
    path: '/source/product', repositoryRemoteHash: `sha256:${'a'.repeat(64)}`,
    repositoryBindingId: '22222222-2222-4222-8222-222222222222', repositoryAgentId: '33333333-3333-4333-8333-333333333333', endpointId: '44444444-4444-4444-8444-444444444444',
    repositoryRole: { revision: 7, profileHash: 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' },
    repositoryPackage: { state: 'published', sourcePolicyGenerationId: '55555555-5555-4555-8555-555555555555' },
    privateKey: 'SECRET_KEY_SENTINEL', token: 'SECRET_TOKEN_SENTINEL',
    credentialPath: '/private/store', controlBranch: 'private-branch',
  };
  let rows = [row, { ...row, workspaceId: '66666666-6666-4666-8666-666666666666', path: '/source/product-sibling' }];
  const forbidden = (label: string) => async () => { calls.push(label); throw new Error(`forbidden_${label}`); };
  const dependencies = {
    UUID_PATTERN: /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    resolve: posix.resolve,
    realpath: async (path: string) => { calls.push('realpath'); return path; },
    registry: async () => { calls.push('registry'); return rows; },
    currentBootstrapHostScope: () => undefined,
    repositorySharedReady: forbidden('readiness'),
    installedRepositoryKnowledge: forbidden('knowledge'),
    readDeviceConfig: forbidden('device_config'),
    enrolledDeviceIdentity: forbidden('device_key'),
    loadDeviceEnrollmentAnchor: forbidden('anchor'),
    client: forbidden('client'),
    relayProcessState: forbidden('relay'),
    receiptAwareProviderCapabilities: forbidden('provider'),
    inspectCodexBootstrapHostPreparation: forbidden('bootstrap_preparation'),
    readFile: forbidden('private_read'), writeFile: forbidden('write'), fetch: forbidden('network'),
  };
  return { row, calls, dependencies, setRows: (value: typeof rows) => { rows = value; } };
}

const flags = (extra: Array<[string, string | boolean]> = []): Flags => new Map([
  ['repo', '/source/product'], ...extra,
]);
const plain = (value: unknown) => JSON.parse(JSON.stringify(value));

test('exact repository metadata is unverified and never enters readiness, key, anchor, network or mutation paths', async () => {
  const f = fixture();
  const result = plain(await (await caller('repositoriesList', f.dependencies))(flags(), true));
  assert.equal(result.stage, 'repository_registry_metadata');
  assert.equal(result.authority, 'unverified_local_registry');
  assert.equal(result.readiness, 'not_checked');
  assert.equal(result.identityVerified, false);
  assert.deepEqual(result.repositories, [{
    organizationId: 'org_fixture', workspaceId: '11111111-1111-4111-8111-111111111111', repositoryBindingId: '22222222-2222-4222-8222-222222222222',
    repositoryAgentId: '33333333-3333-4333-8333-333333333333', endpointId: '44444444-4444-4444-8444-444444444444',
    registeredSourceFingerprint: `sha256:${'a'.repeat(64)}`, sourceFingerprintVerified: false,
    roleRevision: 7, sourcePolicyGenerationId: '55555555-5555-4555-8555-555555555555', repositoryPackageState: 'published',
    sharedRepositoryReady: null, readinessChecked: false,
  }]);
  assert.deepEqual(f.calls, ['registry', 'realpath']);
  const output = JSON.stringify(result);
  for (const excluded of ['SECRET_', '/private/store', 'private label', 'private-branch', '66666666-6666-4666-8666-666666666666', '/source/product']) {
    assert.equal(output.includes(excluded), false, excluded);
  }
});

test('metadata mode requires an exact repository before any registry or path read', async () => {
  for (const input of [new Map(), new Map([['repo', true]])]) {
    const f = fixture();
    await assert.rejects(() => (caller('repositoriesList', f.dependencies)).then(fn => fn(input, true)), /repository_metadata_scope_required/);
    assert.deepEqual(f.calls, []);
  }
});

test('metadata rejects legacy mode flags and mutation/unknown options before reading', async () => {
  for (const extra of [[['metadata-only', 'true']], [['apply', true]], [['grant', 'SECRET_GRANT']], [['json', 'false']]] as Array<Array<[string, string | boolean]>>) {
    const f = fixture();
    await assert.rejects(() => caller('repositoriesList', f.dependencies).then(fn => fn(flags(extra), true)), /repository_metadata_option_invalid/);
    assert.deepEqual(f.calls, []);
  }
});

test('exact source matching rejects prefix siblings and unregistered paths without readiness', async () => {
  const f = fixture();
  await assert.rejects(() => caller('repositoriesList', f.dependencies).then(fn => fn(flags([['repo', '/source/missing']]), true)), /not registered/);
  assert.deepEqual(f.calls, ['registry', 'realpath']);
});

test('metadata resolves a requested path alias against the canonical registered path without readiness', async () => {
  const f = fixture();
  const dependencies = { ...f.dependencies, realpath: async (path: string) => {
    f.calls.push('realpath');
    assert.equal(path, '/temporary-alias/product');
    return '/source/product';
  } };
  const result = plain(await (await caller('repositoriesList', dependencies))(
    flags([['repo', '/temporary-alias/product']]), true,
  ));
  assert.equal(result.repositories.length, 1);
  assert.equal(result.repositories[0].workspaceId, f.row.workspaceId);
  assert.equal(result.readiness, 'not_checked');
  assert.deepEqual(f.calls, ['registry', 'realpath']);
});

test('ambiguous same-path records cannot disclose multiple organizations', async () => {
  const f = fixture();
  f.setRows([f.row, { ...f.row, organizationId: 'org_other', workspaceId: '77777777-7777-4777-8777-777777777777' }]);
  await assert.rejects(() => caller('repositoriesList', f.dependencies).then(fn => fn(flags(), true)), /repository_metadata_scope_ambiguous/);
  const selected = plain(await (await caller('repositoriesList', f.dependencies))(flags([['workspace-id', '11111111-1111-4111-8111-111111111111']]), true));
  assert.deepEqual(selected.repositories.map((row: any) => row.organizationId), ['org_fixture']);
  assert.equal(f.calls.includes('readiness'), false);
});

test('metadata accepts canonical Windows path resolution without case-folding foreign paths', async () => {
  const f = fixture();
  f.setRows([{ ...f.row, path: 'C:\\Source\\Product' }]);
  const fn = await caller('repositoriesList', { ...f.dependencies,
    resolve: (path: string) => path,
    realpath: async (path: string) => path === 'c:\\source\\product' ? 'C:\\Source\\Product' : path,
  });
  assert.equal((await fn(flags([['repo', 'c:\\source\\product']]), true)).repositories.length, 1);
  await assert.rejects(() => fn(flags([['repo', 'C:\\Source\\Product-sibling']]), true), /not registered/);
  assert.equal(f.calls.includes('readiness'), false);
});

test('default repository list still performs the original installed-readiness check', async () => {
  const f = fixture();
  const fn = await caller('repositoriesList', { ...f.dependencies,
    repositorySharedReady: async () => { f.calls.push('readiness'); return true; },
  });
  const result = await fn(new Map([['repo', '/source/product']]));
  assert.equal(result.repositories[0].sharedRepositoryReady, true);
  assert.equal(result.stage, undefined);
  assert.deepEqual(f.calls, ['registry', 'realpath', 'readiness']);
});

test('metadata uses a distinct subcommand and rejects legacy flags before other command effects', async () => {
  for (const args of [['status'], ['repositories', 'status'], ['bootstrap'], ['login']]) {
    const f = fixture();
    await assert.rejects(() => caller('run', f.dependencies).then(fn => fn([...args, '--metadata-only', '--repo', '/source/product'])), /repository_metadata_command_invalid/);
    assert.deepEqual(f.calls, []);
  }
  const f = fixture();
  const result = await (await caller('run', f.dependencies))(['repositories', 'metadata', '--repo', '/source/product', '--json']);
  assert.equal(result.stage, 'repository_registry_metadata');
  assert.deepEqual(f.calls, ['registry', 'realpath']);
});

test('metadata cannot escape an admitted bootstrap callback or inspect its protected preparation', async () => {
  const f = fixture();
  const fn = await caller('run', { ...f.dependencies, currentBootstrapHostScope: () => ({ fixture: true }) });
  await assert.rejects(() => fn(['repositories', 'metadata', '--repo', '/source/product']), /repository_metadata_command_invalid/);
  assert.deepEqual(f.calls, []);
});

test('malformed selected registry fields cannot serialize nested secrets or coerced authority', async () => {
  const secret = { privateKey: 'SECRET_NESTED_SENTINEL' };
  const fields: Record<string, unknown>[] = [
    { organizationId: secret }, { organizationId: 'org_private\nSECRET' }, { workspaceId: secret },
    { repositoryBindingId: secret }, { repositoryBindingId: 'SECRET_NOT_A_UUID' },
    { repositoryAgentId: ['SECRET'] }, { endpointId: false }, { repositoryRemoteHash: secret },
    { repositoryRemoteHash: 'SECRET_NOT_A_FINGERPRINT' }, { repositoryRole: secret },
    ...[secret, '7', -1, 0, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1].map(revision => ({
      repositoryRole: { revision, profileHash: `sha256:${'b'.repeat(64)}` },
    })),
    { repositoryPackage: 'SECRET' }, { repositoryPackage: [] },
    { repositoryPackage: { state: secret } }, { repositoryPackage: { state: 'SECRET' } },
    { repositoryPackage: { state: 'published', sourcePolicyGenerationId: secret } },
  ];
  for (const invalid of fields) {
    const f = fixture();
    f.setRows([{ ...f.row, ...invalid } as any]);
    await assert.rejects(() => caller('repositoriesList', f.dependencies).then(fn => fn(flags(), true)), error => {
      assert.equal((error as Error).message, 'repository_metadata_record_invalid');
      assert.doesNotMatch((error as Error).message, /SECRET|privateKey/);
      return true;
    });
    assert.deepEqual(f.calls, ['registry', 'realpath']);
  }
});
