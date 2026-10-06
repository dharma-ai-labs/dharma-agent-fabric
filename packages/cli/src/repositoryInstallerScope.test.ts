import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as syncFs from 'node:fs';
import * as crypto from 'node:crypto';
import * as path from 'node:path';
import * as util from 'node:util';
import {tmpdir} from 'node:os';
import {runInNewContext} from 'node:vm';
import test from 'node:test';
import ts from 'typescript';
import {canonicalize} from '@dharma-ai-labs/agent-fabric-contracts';
import {currentBootstrapHostScope, runCodexBootstrapHost} from './bootstrapHostScope.js';
import * as authorization from './repositorySourceAuthorization.js';
import {loadAgentFabricOnboardingContract, installRepositoryAgentFabricSkill} from './index.js';
import {initializeRepositoryKnowledge, readRepositoryKnowledgeSource} from './repositoryKnowledge.js';
import {inventoryRepositoryPackage, writeRepositoryPackageSnapshot} from './repositoryPackage.js';

function input(workspace: string) {
  const id = (n: number) => `${String(n).padStart(8, '0')}-1111-4111-8111-111111111111`;
  const now = Date.now(), digest = `sha256:${'a'.repeat(64)}`;
  return {workspace, current: async () => true, signal: new AbortController().signal,
    intent: {schema: 'dharma.codex-setup-intent/v1' as const, operationId: id(1), setupReference: id(2),
      organizationId: 'org_demo', recipientMembershipId: id(3), origin: 'https://hq.example',
      repositoryFingerprint: digest, policyRevision: 'policy-v1', scopeDigest: digest, contractDigest: digest,
      hostContextId: id(4), issuedAt: new Date(now - 1000).toISOString(), expiresAt: new Date(now + 60_000).toISOString()}};
}
async function fixture(t: {after(fn: () => Promise<void>): void}) {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'dharma-installer-scope-'));
  t.after(() => fs.rm(root, {recursive: true, force: true}));
  await fs.mkdir(path.join(root, '.dharma'));
  const target = path.join(root, '.dharma', 'agent-fabric.json');
  await fs.writeFile(target, 'previous');
  return {root, target};
}
// Actual production module, real C-only files; instrument only owned IO boundaries.
async function module(overrides: Record<string, unknown> = {}) {
  const source = await fs.readFile(new URL('../src/repositoryInstallerFiles.ts', import.meta.url), 'utf8');
  const result = ts.transpileModule(source, {compilerOptions: {target: ts.ScriptTarget.ES2023,
    module: ts.ModuleKind.CommonJS}, reportDiagnostics: true});
  assert.equal(result.diagnostics?.filter(item => item.category === ts.DiagnosticCategory.Error).length, 0);
  const exports: Record<string, any> = {};
  runInNewContext(result.outputText, {exports, Buffer, Date, process, require: (name: string) => {
    if (name === 'node:fs') return syncFs;
    if (name === 'node:fs/promises') return {...fs, ...overrides};
    if (name === 'node:crypto') return crypto;
    if (name === 'node:path') return path;
    if (name === 'node:util') return util;
    if (name === './bootstrapHostScope.js') return {currentBootstrapHostScope};
    if (name === './repositorySourceAuthorization.js') return authorization;
    throw new Error('unexpected fixture dependency');
  }}, {timeout: 1000, contextCodeGeneration: {strings: false, wasm: false}});
  return exports;
}

async function actualEntry(overrides: Record<string, unknown> = {}, loadContract = loadAgentFabricOnboardingContract) {
  const source = await fs.readFile(new URL('../src/index.ts', import.meta.url), 'utf8');
  const parsed = ts.createSourceFile('index.ts', source, ts.ScriptTarget.ES2023, true);
  const declaration = parsed.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'installRepositoryAgentFabricSkill');
  assert.ok(declaration && ts.isFunctionDeclaration(declaration));
  const result = ts.transpileModule(declaration.getText(parsed), {compilerOptions: {target: ts.ScriptTarget.ES2023,
    module: ts.ModuleKind.CommonJS}, reportDiagnostics: true});
  assert.equal(result.diagnostics?.filter(item => item.category === ts.DiagnosticCategory.Error).length, 0);
  const exports: Record<string, any> = {}, installer = await module(overrides);
  runInNewContext(result.outputText, {exports, Buffer, Date, process, resolve: path.resolve,
    realpath: overrides.realpath || fs.realpath, mkdir: overrides.mkdir || fs.mkdir,
    currentBootstrapHostScope, validateRepositorySourceAuthorization: authorization.validateRepositorySourceAuthorization,
    assertRepositoryInstallerOwnership: installer.assertRepositoryInstallerOwnership,
    writeRepositoryInstallerFile: installer.writeRepositoryInstallerFile,
    captureRepositoryInstallerInput: installer.captureRepositoryInstallerInput,
    prepareRepositoryInstallerWorkspace: installer.prepareRepositoryInstallerWorkspace,
    loadAgentFabricOnboardingContract: loadContract, initializeRepositoryKnowledge, readRepositoryKnowledgeSource,
    inventoryRepositoryPackage, writeRepositoryPackageSnapshot},
  {timeout: 1000, contextCodeGeneration: {strings: false, wasm: false}});
  return exports.installRepositoryAgentFabricSkill as typeof installRepositoryAgentFabricSkill;
}
function connection(workspace: string) {
  return {workspace, hqUrl: 'https://hq.example', organizationId: 'org_demo', workspaceId: 'synthetic', policyRevision: 'policy-v1'};
}
test('installer scope refuses path inspection before any filesystem access', async t => {
  const f = await fixture(t); let stats = 0;
  const api = await module({lstat: async (...args: Parameters<typeof fs.lstat>) => {stats++; return fs.lstat(...args);}});
  await assert.rejects(runCodexBootstrapHost(input(f.root), async ({scope}) => {
    scope.close(); await api.checkedPath(f.root, f.target, 'file');
  }), {message: 'codex_setup_host_scope_unavailable'});
  assert.equal(stats, 0);
});
test('installer scope stops path traversal after one withdrawn metadata result', async t => {
  const f = await fixture(t); let stats = 0;
  await assert.rejects(runCodexBootstrapHost(input(f.root), async ({scope}) => {
    const api = await module({lstat: async (...args: Parameters<typeof fs.lstat>) => {
      stats++; const value = await fs.lstat(...args); scope.close(); return value;
    }});
    await api.checkedPath(f.root, f.target, 'file');
  }), {message: 'codex_setup_host_scope_unavailable'});
  assert.equal(stats, 1);
});
test('installer scope closes a marker handle acquired just before withdrawal without reading it', async t => {
  const f = await fixture(t), skill = path.join(f.root, '.agents', 'skills', 'dharma-agent-fabric');
  await fs.mkdir(skill, {recursive: true});
  await fs.writeFile(path.join(skill, '.dharma-agent-fabric.json'), JSON.stringify({managedBy: 'dharma-agent-fabric', workspaceId: 'synthetic'}));
  let reads = 0, closes = 0;
  await assert.rejects(runCodexBootstrapHost(input(f.root), async ({scope}) => {
    const api = await module({open: async (...args: Parameters<typeof fs.open>) => {
      const handle = await fs.open(...args), close = handle.close.bind(handle), read = handle.read.bind(handle);
      handle.close = async () => {closes++; return close();};
      handle.read = ((...values: any[]) => {reads++; return Reflect.apply(read, handle, values);}) as typeof handle.read;
      scope.close(); return handle;
    }});
    await api.assertRepositoryInstallerOwnership(f.root, 'synthetic');
  }), {message: 'codex_setup_host_scope_unavailable'});
  assert.equal(reads, 0); assert.equal(closes, 1);
});
test('installer scope closes its staging handle and preserves uncertain partial write without publication', async t => {
  const f = await fixture(t); let syncs = 0, renames = 0, closes = 0;
  await assert.rejects(runCodexBootstrapHost(input(f.root), async ({scope}) => {
    const api = await module({open: async (...args: Parameters<typeof fs.open>) => {
      const handle = await fs.open(...args), write = handle.writeFile.bind(handle), close = handle.close.bind(handle), sync = handle.sync.bind(handle);
      handle.writeFile = async (...values: Parameters<typeof handle.writeFile>) => {const value = await write(...values); scope.close(); return value;};
      handle.close = async () => {closes++; return close();};
      handle.sync = async () => {syncs++; return sync();};
      return handle;
    }, rename: async (...args: Parameters<typeof fs.rename>) => {renames++; return fs.rename(...args);}});
    await api.writeRepositoryInstallerFile(f.root, '.dharma/agent-fabric.json', 'candidate');
  }), {message: 'codex_setup_host_scope_unavailable'});
  assert.equal(await fs.readFile(f.target, 'utf8'), 'previous');
  assert.equal(syncs, 0); assert.equal(renames, 0); assert.equal(closes, 1);
  assert.equal((await fs.readdir(path.dirname(f.target))).filter(name => name.includes('.staging-')).length, 1);
});
test('installer scope records publication before withdrawal and never cleans the published destination', async t => {
  const f = await fixture(t); let unlinks = 0;
  await assert.rejects(runCodexBootstrapHost(input(f.root), async ({scope}) => {
    const api = await module({rename: async (...args: Parameters<typeof fs.rename>) => {
      await fs.rename(...args); scope.close();
    }, unlink: async (...args: Parameters<typeof fs.unlink>) => {unlinks++; return fs.unlink(...args);}});
    await api.writeRepositoryInstallerFile(f.root, '.dharma/agent-fabric.json', 'candidate');
  }), {message: 'codex_setup_host_scope_unavailable'});
  assert.equal(await fs.readFile(f.target, 'utf8'), 'candidate'); assert.equal(unlinks, 0);
});
test('installer scope snapshots expected bytes before path inspection yields', async t => {
  const f = await fixture(t), expected = Buffer.from('previous');
  const api = await module({lstat: async (...args: Parameters<typeof fs.lstat>) => {
    const value = await fs.lstat(...args); expected.fill(0); return value;
  }});
  await runCodexBootstrapHost(input(f.root), async () => {
    await api.writeRepositoryInstallerFile(f.root, '.dharma/agent-fabric.json', 'candidate', expected);
  });
  assert.equal(await fs.readFile(f.target, 'utf8'), 'candidate');
});
test('installer scope preserves a foreign staging replacement and reports uncertain cleanup', async t => {
  const f = await fixture(t); let foreignPath = '';
  const api = await module({open: async (...args: Parameters<typeof fs.open>) => {
    const handle = await fs.open(...args), close = handle.close.bind(handle);
    foreignPath = String(args[0]);
    handle.close = async () => {
      await close(); await fs.unlink(foreignPath); await fs.writeFile(foreignPath, 'foreign');
    }; return handle;
  }});
  await assert.rejects(runCodexBootstrapHost(input(f.root), async () => {
    await api.writeRepositoryInstallerFile(f.root, '.dharma/agent-fabric.json', 'candidate', Buffer.from('not previous'));
  }), {message: 'repository_installer_cleanup_unconfirmed'});
  assert.equal(await fs.readFile(foreignPath, 'utf8'), 'foreign');
  assert.equal(await fs.readFile(f.target, 'utf8'), 'previous');
});
test('installer scope never invokes an error code accessor or emits private filesystem diagnostics', async t => {
  const f = await fixture(t); let getters = 0;
  const api = await module({lstat: async () => {throw Object.defineProperty(new Error('private IO canary'), 'code', {
    get: () => {getters++; throw new Error('private getter canary');}});}});
  await assert.rejects(runCodexBootstrapHost(input(f.root), async () => {
    await api.checkedPath(f.root, f.target, 'file');
  }), {message: 'repository_installer_storage_unavailable'});
  assert.equal(getters, 0);
});

for (const scoped of [true, false]) {
  test(`installer ${scoped ? 'scoped' : 'legacy'} collision never cleans a staging name it did not acquire`, async t => {
    const f = await fixture(t); let foreignPath = '', unlinks = 0;
    const api = await module({open: async (...args: Parameters<typeof fs.open>) => {
      foreignPath = String(args[0]);
      await fs.writeFile(foreignPath, 'foreign');
      throw Object.assign(new Error('synthetic staging collision'), {code: 'EEXIST'});
    }, unlink: async (...args: Parameters<typeof fs.unlink>) => {unlinks++; return fs.unlink(...args);}});
    const write = () => api.writeRepositoryInstallerFile(f.root, '.dharma/agent-fabric.json', 'candidate');
    await assert.rejects(scoped ? runCodexBootstrapHost(input(f.root), write) : write(),
      scoped ? {message: 'repository_installer_storage_unavailable'} : {code: 'EEXIST'});
    assert.equal(unlinks, 0);
    assert.equal(await fs.readFile(foreignPath, 'utf8'), 'foreign');
    assert.equal(await fs.readFile(f.target, 'utf8'), 'previous');
  });
}

for (const signed of [false, true]) {
  test(`installer scope recognizes ${signed ? 'signed' : 'generated'} ownership without rewriting it`, async t => {
    const f = await fixture(t), skill = path.join(f.root, '.agents', 'skills', 'dharma-agent-fabric');
    await fs.mkdir(skill, {recursive: true});
    const marker = path.join(skill, '.dharma-agent-fabric.json');
    const bytes = JSON.stringify(signed ? {bundleId: '33333333-3333-4333-8333-333333333333',
      skillId: 'dharma-agent-fabric', workspaceId: 'synthetic'} : {managedBy: 'dharma-agent-fabric', workspaceId: 'synthetic'});
    await fs.writeFile(marker, bytes);
    const api = await module();
    const actual = await runCodexBootstrapHost(input(f.root), () => api.assertRepositoryInstallerOwnership(f.root, 'synthetic'));
    assert.equal(actual, signed ? 'signed' : 'installer');
    await assert.rejects(runCodexBootstrapHost(input(f.root), () => api.assertRepositoryInstallerOwnership(f.root, 'foreign')),
      {message: 'Invalid or foreign repository skill ownership marker.'});
    assert.equal(await fs.readFile(marker, 'utf8'), bytes);
  });
}

test('installer scope refuses an unmanaged existing skill without creating a marker', async t => {
  const f = await fixture(t), skill = path.join(f.root, '.agents', 'skills', 'dharma-agent-fabric');
  await fs.mkdir(skill, {recursive: true});
  const existing = path.join(skill, 'SKILL.md'); await fs.writeFile(existing, 'user skill');
  const api = await module();
  await assert.rejects(runCodexBootstrapHost(input(f.root), () => api.assertRepositoryInstallerOwnership(f.root, 'synthetic')),
    /Refusing to replace an unmanaged repository skill/);
  assert.deepEqual(await fs.readdir(skill), ['SKILL.md']);
  assert.equal(await fs.readFile(existing, 'utf8'), 'user skill');
});

test('installer scope removes only its acquired staging inode after failed publication', async t => {
  const f = await fixture(t); let closes = 0, unlinks = 0;
  const api = await module({open: async (...args: Parameters<typeof fs.open>) => {
    const handle = await fs.open(...args), close = handle.close.bind(handle);
    handle.close = async () => {closes++; return close();}; return handle;
  }, rename: async () => {throw new Error('private rename canary');},
  unlink: async (...args: Parameters<typeof fs.unlink>) => {unlinks++; return fs.unlink(...args);}});
  await assert.rejects(runCodexBootstrapHost(input(f.root), () =>
    api.writeRepositoryInstallerFile(f.root, '.dharma/agent-fabric.json', 'candidate')),
  {message: 'repository_installer_storage_unavailable'});
  assert.equal(closes, 1); assert.equal(unlinks, 1);
  assert.deepEqual(await fs.readdir(path.dirname(f.target)), ['agent-fabric.json']);
  assert.equal(await fs.readFile(f.target, 'utf8'), 'previous');
});

test('installer scope reports unavailable owned staging cleanup without leaking the native error', async t => {
  const f = await fixture(t);
  const api = await module({unlink: async () => {throw new Error('private unlink canary');}});
  await assert.rejects(runCodexBootstrapHost(input(f.root), () =>
    api.writeRepositoryInstallerFile(f.root, '.dharma/agent-fabric.json', 'candidate', Buffer.from('wrong bytes'))),
  {message: 'repository_installer_cleanup_unconfirmed'});
  assert.equal(await fs.readFile(f.target, 'utf8'), 'previous');
  assert.equal((await fs.readdir(path.dirname(f.target))).filter(name => name.includes('.staging-')).length, 1);
});

test('actual installer entry refuses input accessors before workspace inspection', async t => {
  const f = await fixture(t), supplied = connection(f.root); let getters = 0, stats = 0;
  Object.defineProperty(supplied, 'organizationId', {get: () => {getters++; throw new Error('private entry input canary');}});
  const install = await actualEntry({lstat: async (...args: Parameters<typeof fs.lstat>) => {stats++; return fs.lstat(...args);}});
  await assert.rejects(runCodexBootstrapHost(input(f.root), () => install(supplied)),
    {message: 'repository_installer_input_invalid'});
  assert.equal(getters, 0); assert.equal(stats, 0); assert.equal(await fs.readFile(f.target, 'utf8'), 'previous');
});
test('actual installer entry freezes identity before canonical workspace resolution yields', async t => {
  const f = await fixture(t), supplied = connection(f.root);
  const install = await actualEntry({realpath: async (...args: Parameters<typeof fs.realpath>) => {
    const value = await fs.realpath(...args); supplied.organizationId = 'org_foreign'; return value;
  }});
  const actual = await runCodexBootstrapHost(input(f.root), () => install(supplied));
  assert.equal(actual.repositoryPackage.disposition, 'local_bootstrap_inventory');
  assert.equal(JSON.parse(await fs.readFile(f.target, 'utf8')).organizationId, 'org_demo');
  assert.match(await fs.readFile(path.join(f.root, '.agents/skills/dharma-agent-fabric/references/organization.md'), 'utf8'), /Organization: org_demo/);
});
test('actual installer entry freezes identity before asynchronous owner revalidation', async t => {
  const f = await fixture(t), supplied = connection(f.root), install = await actualEntry(); let armed = false;
  await runCodexBootstrapHost({...input(f.root), current: async () => {
    if (armed) supplied.organizationId = 'org_foreign'; return true;
  }}, () => {armed = true; return install(supplied);});
  assert.equal(JSON.parse(await fs.readFile(f.target, 'utf8')).organizationId, 'org_demo');
});
test('actual installer entry stops directory creation after its first mkdir withdraws authority', async t => {
  const f = await fixture(t); let directories = 0, contracts = 0;
  await assert.rejects(runCodexBootstrapHost(input(f.root), async ({scope}) => {
    const install = await actualEntry({mkdir: async (...args: Parameters<typeof fs.mkdir>) => {
      directories++; const value = await fs.mkdir(...args); scope.close(); return value;
    }}, async () => {contracts++; return loadAgentFabricOnboardingContract();});
    await install(connection(f.root));
  }), {message: 'codex_setup_host_scope_unavailable'});
  assert.equal(directories, 1); assert.equal(contracts, 0); assert.equal(await fs.readFile(f.target, 'utf8'), 'previous');
});
test('actual installer entry does not publish a skill after contract loading withdraws authority', async t => {
  const f = await fixture(t); let writes = 0;
  await assert.rejects(runCodexBootstrapHost(input(f.root), async ({scope}) => {
    const install = await actualEntry({open: async (...args: Parameters<typeof fs.open>) => {
      if (Number(args[1]) & syncFs.constants.O_CREAT) writes++; return fs.open(...args);
    }}, async () => {const value = await loadAgentFabricOnboardingContract(); scope.close(); return value;});
    await install(connection(f.root));
  }), {message: 'codex_setup_host_scope_unavailable'});
  assert.equal(writes, 0); assert.equal(await fs.readFile(f.target, 'utf8'), 'previous');
});
test('installer preparation does not invoke native error proxy traps', async t => {
  const f = await fixture(t); let traps = 0;
  const failure = new Proxy(new Error('private proxy canary'), {getOwnPropertyDescriptor: () => {traps++; throw new Error('private trap canary');}});
  const api = await module({lstat: async () => {throw failure;}});
  await assert.rejects(runCodexBootstrapHost(input(f.root), () => api.assertRepositoryInstallerOwnership(f.root, 'synthetic')),
    {message: 'repository_installer_storage_unavailable'});
  assert.equal(traps, 0);
});
test('actual compiled scoped installer prepares its generated directories and full unsigned package', async t => {
  const f = await fixture(t);
  const actual = await runCodexBootstrapHost(input(f.root), () => installRepositoryAgentFabricSkill(connection(f.root)));
  assert.equal(actual.repositoryPackage.disposition, 'local_bootstrap_inventory');
  assert.equal(actual.repositoryPackage.authority, 'local_inventory_not_signed');
  const root = path.join(f.root, '.agents/skills/dharma-agent-fabric');
  const marker = JSON.parse(await fs.readFile(path.join(root, '.dharma-agent-fabric.json'), 'utf8'));
  assert.deepEqual(marker, {managedBy: 'dharma-agent-fabric', workspaceId: 'synthetic'});
  assert.equal(JSON.parse(await fs.readFile(f.target, 'utf8')).organizationId, 'org_demo');
  assert.ok((await fs.readFile(path.join(root, 'SKILL.md'), 'utf8')).includes((await loadAgentFabricOnboardingContract()).markdown));
});

test('actual installer entry rejects an input proxy without invoking it or inspecting the workspace', async t => {
  const f = await fixture(t); let traps = 0, stats = 0;
  const supplied = new Proxy(connection(f.root), {ownKeys: () => {traps++; throw new Error('private input proxy canary');}});
  const install = await actualEntry({lstat: async (...args: Parameters<typeof fs.lstat>) => {stats++; return fs.lstat(...args);}});
  await assert.rejects(runCodexBootstrapHost(input(f.root), () => install(supplied)),
    {message: 'repository_installer_input_invalid'});
  assert.equal(traps, 0); assert.equal(stats, 0);
});

test('actual installer entry rejects invalid source authority before preparing directories', async t => {
  const f = await fixture(t); let stats = 0;
  const install = await actualEntry({lstat: async (...args: Parameters<typeof fs.lstat>) => {stats++; return fs.lstat(...args);}});
  await assert.rejects(runCodexBootstrapHost(input(f.root), () => install({...connection(f.root), sourceAuthorization: {}})),
    /Repository source authorization fields are invalid/);
  assert.equal(stats, 0); assert.deepEqual(await fs.readdir(f.root), ['.dharma']);
});

test('actual installer entry cannot prepare directories after canonical resolution withdraws authority', async t => {
  const f = await fixture(t); let directories = 0;
  await assert.rejects(runCodexBootstrapHost(input(f.root), async ({scope}) => {
    const install = await actualEntry({realpath: async (...args: Parameters<typeof fs.realpath>) => {
      const value = await fs.realpath(...args); scope.close(); return value;
    }, mkdir: async (...args: Parameters<typeof fs.mkdir>) => {directories++; return fs.mkdir(...args);}});
    await install(connection(f.root));
  }), {message: 'codex_setup_host_scope_unavailable'});
  assert.equal(directories, 0); assert.equal(await fs.readFile(f.target, 'utf8'), 'previous');
});

test('installer preparation rechecks a concurrent directory collision rather than trusting EEXIST', async t => {
  const f = await fixture(t); let directories = 0, contracts = 0;
  const install = await actualEntry({mkdir: async (...args: Parameters<typeof fs.mkdir>) => {
    directories++; await fs.writeFile(String(args[0]), 'foreign file');
    throw Object.assign(new Error('private collision canary'), {code: 'EEXIST'});
  }}, async () => {contracts++; return loadAgentFabricOnboardingContract();});
  await assert.rejects(runCodexBootstrapHost(input(f.root), () => install(connection(f.root))),
    {message: 'Invalid repository installer directory.'});
  assert.equal(directories, 1); assert.equal(contracts, 0);
  assert.equal(await fs.readFile(path.join(f.root, '.agents'), 'utf8'), 'foreign file');
  assert.equal(await fs.readFile(f.target, 'utf8'), 'previous');
});

test('installer preparation preserves signed ownership without creating unsigned reference directories', async t => {
  const f = await fixture(t), skill = path.join(f.root, '.agents/skills/dharma-agent-fabric');
  await fs.mkdir(skill, {recursive: true});
  const marker = JSON.stringify({bundleId: '33333333-3333-4333-8333-333333333333', skillId: 'dharma-agent-fabric', workspaceId: 'synthetic'});
  await fs.writeFile(path.join(skill, '.dharma-agent-fabric.json'), marker);
  let directories = 0;
  const api = await module({mkdir: async (...args: Parameters<typeof fs.mkdir>) => {directories++; return fs.mkdir(...args);}});
  const result = await runCodexBootstrapHost(input(f.root), () => api.prepareRepositoryInstallerWorkspace(f.root, 'synthetic')) as {ownership: string};
  assert.equal(result.ownership, 'signed'); assert.equal(directories, 0);
  assert.deepEqual(await fs.readdir(skill), ['.dharma-agent-fabric.json']);
  assert.equal(await fs.readFile(path.join(skill, '.dharma-agent-fabric.json'), 'utf8'), marker);
});

test('actual installer entry retains its approved source policy despite caller mutation during preparation', async t => {
  const f = await fixture(t), id = (n: number) => `${String(n).padStart(8, '0')}-1111-4111-8111-111111111111`;
  const policy = {action: 'authorize', confirmed: true, requestId: id(5), repositoryBindingId: id(6), expectedRevision: 0,
    allowedContentClasses: ['approved_outputs', 'repository_content', 'repository_skills'], approvedRepositoryPaths: ['README.md'],
    approvedOutputFolders: [], automaticValidatedPublication: true, retentionDays: 30, maximumFileBytes: 262144,
    maximumSnapshotBytes: 4194304, maximumDailyUploadBytes: 8388608, expiresAt: null};
  const sourceAuthorization = {schema: 'dharma.repository-source-authorization/v1', organizationId: 'org_demo',
    workspaceId: id(7), repositoryBindingId: id(6), repositoryAgentId: id(8), revision: 1, generationId: id(9),
    receiptId: `repo_consent_${id(9)}`, policyRevision: `repository-source-${id(9)}`, confirmedAt: '2026-09-18T08:00:00.000Z',
    policyHash: `sha256:${crypto.createHash('sha256').update(canonicalize(policy)).digest('hex')}`, policy};
  const supplied = {...connection(f.root), workspaceId: id(7), repositoryBindingId: id(6), repositoryAgentId: id(8), sourceAuthorization};
  await fs.writeFile(path.join(f.root, 'README.md'), '# Logical job');
  await fs.writeFile(path.join(f.root, 'unapproved.md'), 'Excluded synthetic fixture.');
  const install = await actualEntry({realpath: async (...args: Parameters<typeof fs.realpath>) => {
    const value = await fs.realpath(...args); policy.approvedRepositoryPaths.push('unapproved.md'); return value;
  }});
  const result = await runCodexBootstrapHost(input(f.root), () => install(supplied));
  assert.equal(result.knowledge?.disposition, 'initialized');
  const manifest = JSON.parse(await fs.readFile(path.join(f.root, '.agents/skills/dharma-agent-fabric/MANIFEST.json'), 'utf8'));
  assert.equal(manifest.schema, 'dharma.repository-package/v2');
  assert.ok(manifest.files.some((file: {path: string}) => file.path === 'README.md'));
  assert.ok(manifest.files.every((file: {path: string}) => file.path !== 'unapproved.md'));
  assert.equal(JSON.parse(await fs.readFile(f.target, 'utf8')).workspaceId, id(7));
});
