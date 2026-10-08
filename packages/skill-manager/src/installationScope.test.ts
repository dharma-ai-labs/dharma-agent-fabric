import assert from 'node:assert/strict';
import test from 'node:test';
import * as fs from 'node:fs/promises';
import * as syncFs from 'node:fs';
import * as crypto from 'node:crypto';
import * as path from 'node:path';
import * as util from 'node:util';
import * as asyncHooks from 'node:async_hooks';
import * as childProcess from 'node:child_process';
import {tmpdir} from 'node:os';
import {runInNewContext} from 'node:vm';
import ts from 'typescript';
import * as contracts from '@dharma-ai-labs/agent-fabric-contracts';
import * as policyModule from '@dharma-ai-labs/agent-fabric-policy';
import {calculateBundleHash, contentHash, getActiveSkillBundleAuthorization, installSkillBundle,
  readVerifiedRepositoryKnowledge, rollbackUnconfirmedSkillBundle, type SkillBundle} from './index.js';

async function fixture(t: {after(fn: () => Promise<void>): void}) {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'dharma-skill-install-scope-'));
  t.after(() => fs.rm(root, {recursive: true, force: true}));
  const source = path.join(root, 'source'), native = path.join(root, 'native');
  await fs.mkdir(path.join(source, 'skill'), {recursive: true});
  await fs.writeFile(path.join(source, 'skill/SKILL.md'), '# Logical job\nA retry preserves identity.');
  const server = crypto.generateKeyPairSync('ed25519'), device = crypto.generateKeyPairSync('ed25519');
  const workspaceId = crypto.randomUUID(), deviceId = crypto.randomUUID(), organizationAgentId = crypto.randomUUID();
  const base = {schema: 'dharma.skill-bundle/v2' as const, bundleId: crypto.randomUUID(), organizationId: 'org_synthetic',
    version: '1.0.0', operation: 'install' as const, skills: [{skillId: 'dharma-agent-fabric', version: '1.0.0',
      repository: 'https://example.invalid/synthetic.git', commit: 'a'.repeat(40), path: 'skill',
      contentHash: await contentHash(path.join(source, 'skill'))}], riskClass: 'R1' as const,
    targetSelectors: {organizationAgentIds: [organizationAgentId], deviceIds: [], workspaceIds: [workspaceId], providers: ['codex' as const]},
    activationPolicy: 'next_session' as const, rollbackBundleId: null, evaluationReceiptId: 'synthetic',
    createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString()};
  const bundleHash = calculateBundleHash(base);
  const bundle: SkillBundle = {...base, bundleHash, signature: contracts.signCanonicalObject({...base, bundleHash}, server.privateKey)};
  const input = {bundle, sourceDirectory: source, nativeSkillDirectory: native,
    policy: {organizationId: 'org_synthetic', skills: {automaticInstall: true}}, serverPublicKey: server.publicKey,
    devicePrivateKey: device.privateKey, deviceId, organizationAgentId, workspaceId, provider: 'codex' as const};
  let current = true;
  const hostScope = {signal: new AbortController().signal, current: async () => current};
  return {root, input, hostScope, withdraw: () => {current = false;}, native, server,
    pointer: path.join(native, '.dharma-managed/workspaces', workspaceId, 'ACTIVE_BUNDLE')};
}

// Execute the actual module; seams instrument only synthetic owned filesystem effects.
async function module(overrides: Record<string, unknown> = {}) {
  const dependency = async (name: string) => {
    const text = await fs.readFile(new URL(`../src/${name}.ts`, import.meta.url), 'utf8');
    const compiled = ts.transpileModule(text, {compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2023}});
    const exports: Record<string, any> = {};
    runInNewContext(compiled.outputText, {exports, Buffer, process, Date, AbortSignal, AbortController, setTimeout, clearTimeout,
      require: (id: string) => {
        if (id === 'node:fs/promises') return {...fs, ...overrides};
        if (id === 'node:fs') return syncFs;
        if (id === 'node:async_hooks') return asyncHooks;
        if (id === 'node:util') return util;
        if (id === 'node:crypto') return crypto;
        if (id === 'node:path') return path;
        if (id === 'node:child_process') return childProcess;
        if (id === '@dharma-ai-labs/agent-fabric-contracts') return contracts;
        if (id === '@dharma-ai-labs/agent-fabric-policy') return policyModule;
        if (id === './installationScope.js') return scope;
        throw new Error('unexpected synthetic dependency');
      }}, {timeout: 1000, contextCodeGeneration: {strings: false, wasm: false}});
    return exports;
  };
  let scope: Record<string, any> = {};
  try {scope = await dependency('installationScope');}
  catch (error) {if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;}
  return dependency('index');
}

test('signed installation refuses withdrawn host authority before filesystem effects', async t => {
  const f = await fixture(t); let effects = 0; f.withdraw();
  const api = await module({readdir: async (...args: Parameters<typeof fs.readdir>) => {effects++; return fs.readdir(...args);}});
  await assert.rejects(api.installSkillBundle({...f.input, hostScope: f.hostScope}), {message: 'skill_installation_scope_unavailable'});
  assert.equal(effects, 0); await assert.rejects(fs.lstat(f.native), {code: 'ENOENT'});
});

test('signed installation cannot write after its first metadata observation withdraws authority', async t => {
  const f = await fixture(t); let writes = 0;
  const api = await module({readdir: async (...args: Parameters<typeof fs.readdir>) => {
    try {return await fs.readdir(...args);} finally {f.withdraw();}
  }, mkdir: async (...args: Parameters<typeof fs.mkdir>) => {writes++; return fs.mkdir(...args);}});
  await assert.rejects(api.installSkillBundle({...f.input, hostScope: f.hostScope}), {message: 'skill_installation_scope_unavailable'});
  assert.equal(writes, 0); await assert.rejects(fs.lstat(f.pointer), {code: 'ENOENT'});
});

test('signed installation stops after a source hash read withdraws authority', async t => {
  const f = await fixture(t); let copies = 0;
  const api = await module({readFile: async (...args: Parameters<typeof fs.readFile>) => {
    const result = await fs.readFile(...args); if (String(args[0]).endsWith('SKILL.md')) f.withdraw(); return result;
  }, cp: async (...args: Parameters<typeof fs.cp>) => {copies++; return fs.cp(...args);}});
  await assert.rejects(api.installSkillBundle({...f.input, hostScope: f.hostScope}), {message: 'skill_installation_scope_unavailable'});
  assert.equal(copies, 0); await assert.rejects(fs.lstat(f.pointer), {code: 'ENOENT'});
});

test('signed installation cannot publish receipt or pointer after a copy withdraws authority', async t => {
  const f = await fixture(t); let receiptWrites = 0;
  const api = await module({cp: async (...args: Parameters<typeof fs.cp>) => {const value = await fs.cp(...args); f.withdraw(); return value;},
    writeFile: async (...args: Parameters<typeof fs.writeFile>) => {
      if (/INSTALL_RECEIPT|ACTIVE_BUNDLE/.test(String(args[0]))) receiptWrites++; return fs.writeFile(...args);
    }});
  await assert.rejects(api.installSkillBundle({...f.input, hostScope: f.hostScope}), {message: 'skill_installation_scope_unavailable'});
  assert.equal(receiptWrites, 0); await assert.rejects(fs.lstat(f.pointer), {code: 'ENOENT'});
});

test('signed installation cannot activate after the provider callback withdraws authority', async t => {
  const f = await fixture(t); let receiptWrites = 0;
  const api = await module({writeFile: async (...args: Parameters<typeof fs.writeFile>) => {
    if (/INSTALL_RECEIPT|ACTIVE_BUNDLE/.test(String(args[0]))) receiptWrites++; return fs.writeFile(...args);
  }});
  await assert.rejects(api.installSkillBundle({...f.input, hostScope: f.hostScope, providerActivationCheck: async () => {
    f.withdraw(); return {name: 'provider:codex:activation', status: 'pass', details: null};
  }}), {message: 'skill_installation_scope_unavailable'});
  assert.equal(receiptWrites, 0); await assert.rejects(fs.lstat(f.pointer), {code: 'ENOENT'});
});

test('signed installation retains the original endpoint despite input mutation after first await', async t => {
  const f = await fixture(t), supplied = {...f.input, hostScope: f.hostScope};
  const api = await module({readdir: async (...args: Parameters<typeof fs.readdir>) => {
    supplied.deviceId = '99999999-9999-4999-8999-999999999999'; return fs.readdir(...args);
  }});
  const receipt = await api.installSkillBundle(supplied);
  assert.equal(receipt.deviceId, f.input.deviceId); assert.equal(receipt.status, 'active');
});

test('signed installation emits fixed native failures without invoking error getters', async t => {
  const f = await fixture(t); let getters = 0;
  const failure = Object.defineProperty(new Error('private storage canary'), 'code', {get: () => {getters++; throw new Error('private getter canary');}});
  const api = await module({readdir: async () => {throw failure;}});
  await assert.rejects(api.installSkillBundle({...f.input, hostScope: f.hostScope}), {message: 'skill_installation_storage_unavailable'});
  assert.equal(getters, 0);
});

test('actual compiled signed installation returns a verified receipt under live host authority', async t => {
  const f = await fixture(t);
  const receipt = await installSkillBundle({...f.input, ...{hostScope: f.hostScope}});
  assert.equal(receipt.status, 'active'); assert.equal(receipt.deviceId, f.input.deviceId);
  assert.equal((await fs.readFile(f.pointer, 'utf8')).trim(), f.input.bundle.bundleId);
  const {signature, ...unsigned} = receipt;
  assert.equal(contracts.verifyCanonicalObject(unsigned, signature, crypto.createPublicKey(f.input.devicePrivateKey)), true);
});

async function knowledgeFixture(t: {after(fn: () => Promise<void>): void}) {
  const f = await fixture(t), relative = '.agents/skills/dharma-agent-fabric', source = path.join(f.input.sourceDirectory, relative);
  await fs.mkdir(path.dirname(source), {recursive: true});
  await fs.rename(path.join(f.input.sourceDirectory, 'skill'), source);
  await fs.mkdir(path.join(source, 'knowledge'));
  await fs.writeFile(path.join(source, 'knowledge/CATALOG.json'), '{"synthetic":"catalog"}');
  await fs.writeFile(path.join(source, 'MANIFEST.json'), '{"synthetic":"manifest"}');
  const {signature: _signature, bundleHash: _hash, ...base} = f.input.bundle;
  base.skills[0]!.path = relative;
  base.skills[0]!.contentHash = await contentHash(source);
  const bundleHash = calculateBundleHash(base);
  f.input.bundle = {...base, bundleHash, signature: contracts.signCanonicalObject({...base, bundleHash}, f.server.privateKey)};
  const receipt = await installSkillBundle(f.input);
  const readInput = {nativeSkillDirectory: f.native, workspaceId: f.input.workspaceId, provider: f.input.provider,
    organizationId: f.input.bundle.organizationId, organizationAgentId: f.input.organizationAgentId, deviceId: f.input.deviceId,
    serverPublicKey: f.input.serverPublicKey, devicePublicKey: crypto.createPublicKey(f.input.devicePrivateKey),
    expectedReceiptHash: receipt.receiptHash, hostScope: f.hostScope};
  return {...f, receipt, readInput};
}

test('all public managed-release readers refuse withdrawn authority before metadata access', async t => {
  const f = await knowledgeFixture(t); let reads = 0;
  const api = await module({lstat: async (...args: Parameters<typeof fs.lstat>) => {reads++; return fs.lstat(...args);},
    readdir: async (...args: Parameters<typeof fs.readdir>) => {reads++; return fs.readdir(...args);}});
  f.withdraw();
  for (const name of ['getActiveSkillBundleAuthorization', 'getExpiredSkillBundleAuthorizationForReplacement',
    'getInstalledSkillBundleIdForRecovery', 'getLegacySkillBundleIdForUpgrade', 'readVerifiedRepositoryKnowledge']) {
    await assert.rejects(api[name]({...f.readInput}), {message: 'skill_installation_scope_unavailable'}, name);
  }
  assert.equal(reads, 0); assert.equal((await fs.readFile(f.pointer, 'utf8')).trim(), f.input.bundle.bundleId);
});

test('verified reader closes a handle acquired immediately before withdrawal without reading it', async t => {
  const f = await knowledgeFixture(t); let closes = 0, reads = 0;
  const api = await module({open: async (...args: Parameters<typeof fs.open>) => {
    const handle = await fs.open(...args), close = handle.close.bind(handle), read = handle.read.bind(handle);
    handle.close = async () => {closes++; return close();};
    handle.read = ((...values: any[]) => {reads++; return Reflect.apply(read, handle, values);}) as typeof handle.read;
    f.withdraw(); return handle;
  }});
  await assert.rejects(api.readVerifiedRepositoryKnowledge(f.readInput), {message: 'skill_installation_scope_unavailable'});
  assert.equal(closes, 1); assert.equal(reads, 0);
});

test('verified reader closes a directory acquired immediately before withdrawal', async t => {
  const f = await knowledgeFixture(t); let closes = 0, reads = 0;
  const api = await module({opendir: async (...args: Parameters<typeof fs.opendir>) => {
    const dir = await fs.opendir(...args), close = dir.close.bind(dir), read = dir.read.bind(dir);
    dir.close = (async () => {closes++; return close();}) as typeof dir.close;
    dir.read = (async () => {reads++; return read();}) as typeof dir.read;
    f.withdraw(); return dir;
  }});
  await assert.rejects(api.readVerifiedRepositoryKnowledge(f.readInput), {message: 'skill_installation_scope_unavailable'});
  assert.equal(closes, 1); assert.equal(reads, 0);
});

test('scoped rollback stops after its first read withdraws authority and preserves the accepted release', async t => {
  const f = await knowledgeFixture(t), pointer = await fs.readFile(f.pointer); let writes = 0;
  const api = await module({readdir: async (...args: Parameters<typeof fs.readdir>) => {
    const result = await fs.readdir(...args); f.withdraw(); return result;
  }, rm: async (...args: Parameters<typeof fs.rm>) => {writes++; return fs.rm(...args);},
    rename: async (...args: Parameters<typeof fs.rename>) => {writes++; return fs.rename(...args);}});
  await assert.rejects(api.rollbackUnconfirmedSkillBundle({nativeSkillDirectory: f.native, workspaceId: f.input.workspaceId,
    receipt: f.receipt, hostScope: f.hostScope}), {message: 'skill_installation_scope_unavailable'});
  assert.equal(writes, 0); assert.deepEqual(await fs.readFile(f.pointer), pointer);
});

test('scoped recursive copy stops between files and preserves its partial staging evidence', async t => {
  const f = await knowledgeFixture(t); let copies = 0;
  // A fresh release identity avoids deleting the previously accepted immutable release.
  const {signature: _signature, bundleHash: _hash, ...base} = f.input.bundle; base.bundleId = crypto.randomUUID();
  const bundleHash = calculateBundleHash(base);
  const bundle = {...base, bundleHash, signature: contracts.signCanonicalObject({...base, bundleHash}, f.server.privateKey)};
  const pointer = await fs.readFile(f.pointer);
  const api = await module({cp: async (...args: Parameters<typeof fs.cp>) => {
    const result = await fs.cp(...args); copies++; f.withdraw(); return result;
  }});
  await assert.rejects(api.installSkillBundle({...f.input, bundle, hostScope: f.hostScope}), {message: 'skill_installation_scope_unavailable'});
  assert.equal(copies, 1); assert.deepEqual(await fs.readFile(f.pointer), pointer);
  const staging = path.join(f.native, '.dharma-managed/workspaces', f.input.workspaceId, 'releases', bundle.bundleId, 'dharma-agent-fabric');
  assert.ok((await fs.readdir(staging)).length > 0);
});

test('scoped input getters and proxies cannot execute before installation admission', async t => {
  const f = await fixture(t); let hooks = 0, effects = 0;
  const api = await module({readdir: async (...args: Parameters<typeof fs.readdir>) => {effects++; return fs.readdir(...args);}});
  const getter = Object.defineProperty({...f.input, hostScope: f.hostScope}, 'bundle', {get: () => {hooks++; throw new Error('private input canary');}});
  await assert.rejects(api.installSkillBundle(getter), {message: 'skill_installation_input_invalid'});
  const proxy = new Proxy(f.input.bundle, {ownKeys: () => {hooks++; throw new Error('private proxy canary');}});
  await assert.rejects(api.installSkillBundle({...f.input, bundle: proxy, hostScope: f.hostScope}), {message: 'skill_installation_input_invalid'});
  assert.equal(hooks, 0); assert.equal(effects, 0);
});

test('invalid explicit scope cannot downgrade installation to legacy authority', async t => {
  const f = await fixture(t), api = await module();
  for (const hostScope of [null, false, 0]) await assert.rejects(api.installSkillBundle({...f.input, hostScope}),
    {message: 'skill_installation_scope_unavailable'});
  await assert.rejects(fs.lstat(f.native), {code: 'ENOENT'});
});

test('detached provider work retains the closed installation scope instead of falling back to legacy reads', async t => {
  for (const delay of [0, 400]) await t.test(`post-activation writes delayed ${delay}ms`, async t => {
    const f = await fixture(t); let slowWrites = false, late: Promise<unknown> | undefined;
    const api = await module({writeFile: async (...args: Parameters<typeof fs.writeFile>) => {
      if (slowWrites && delay) await new Promise(accept => setTimeout(accept, delay));
      return fs.writeFile(...args);
    }});
    let release!: () => void;
    const installationFinished = new Promise<void>(accept => {release = accept;});
    try {
      await api.installSkillBundle({...f.input, hostScope: f.hostScope, providerActivationCheck: async () => {
        slowWrites = true;
        late = installationFinished.then(() => api.contentHash(path.join(f.input.sourceDirectory, 'skill')));
        void late.catch(() => {});
        return {name: 'provider:codex:activation', status: 'pass', details: null};
      }});
    } finally {release();}
    assert.ok(late);
    await assert.rejects(late, {message: 'skill_installation_scope_unavailable'});
  });
});

test('scoped smoke execution is refused before any unqualified child launch', async t => {
  const f = await fixture(t), api = await module();
  await assert.rejects(api.installSkillBundle({...f.input, policy: {...f.input.policy, tasks: {}},
    smokeCommandId: 'unqualified', hostScope: f.hostScope}), {message: 'skill_installation_smoke_unqualified'});
  await assert.rejects(fs.lstat(f.pointer), {code: 'ENOENT'});
});

test('actual compiled scoped repository reader returns the receipt-pinned catalog and manifest', async t => {
  const f = await knowledgeFixture(t);
  const result = await readVerifiedRepositoryKnowledge(f.readInput);
  assert.ok(result); assert.equal(result.catalogBytes.toString('utf8'), '{"synthetic":"catalog"}');
  assert.equal(result.manifestBytes.toString('utf8'), '{"synthetic":"manifest"}');
  assert.equal(result.authorization.bundleId, f.input.bundle.bundleId);
});

test('actual compiled scoped rollback restores the prior independently verified receipt and content', async t => {
  const f = await knowledgeFixture(t), original = f.input.bundle;
  const source = path.join(f.input.sourceDirectory, original.skills[0]!.path);
  await fs.writeFile(path.join(source, 'SKILL.md'), '# Later approved synthetic procedure');
  const {signature: _signature, bundleHash: _hash, ...base} = original;
  base.bundleId = crypto.randomUUID(); base.skills = base.skills.map(skill => ({...skill}));
  base.skills[0]!.contentHash = await contentHash(source);
  const bundleHash = calculateBundleHash(base);
  const bundle = {...base, bundleHash, signature: contracts.signCanonicalObject({...base, bundleHash}, f.server.privateKey)};
  const receipt = await installSkillBundle({...f.input, bundle, hostScope: f.hostScope});
  assert.equal(receipt.previousBundleId, original.bundleId);
  await rollbackUnconfirmedSkillBundle({nativeSkillDirectory: f.native, workspaceId: f.input.workspaceId,
    receipt, hostScope: f.hostScope});
  assert.equal((await getActiveSkillBundleAuthorization(f.readInput))?.bundleId, original.bundleId);
  assert.equal(await fs.readFile(path.join(f.native, 'dharma-agent-fabric/SKILL.md'), 'utf8'), '# Logical job\nA retry preserves identity.');
});

test('actual compiled scoped clear preserves unrelated native files and publishes its verified receipt', async t => {
  const f = await knowledgeFixture(t), unrelated = path.join(f.native, 'unmanaged.md');
  await fs.writeFile(unrelated, 'user-owned synthetic notes');
  const {signature: _signature, bundleHash: _hash, ...original} = f.input.bundle;
  const base = {...original, bundleId: crypto.randomUUID(), operation: 'clear' as const, skills: []};
  const bundleHash = calculateBundleHash(base);
  const bundle = {...base, bundleHash, signature: contracts.signCanonicalObject({...base, bundleHash}, f.server.privateKey)};
  const receipt = await installSkillBundle({...f.input, bundle, hostScope: f.hostScope});
  assert.equal(receipt.status, 'active');
  assert.equal((await getActiveSkillBundleAuthorization({...f.readInput, expectedReceiptHash: receipt.receiptHash}))?.bundleId, bundle.bundleId);
  assert.equal(await fs.readFile(unrelated, 'utf8'), 'user-owned synthetic notes');
  await assert.rejects(fs.lstat(path.join(f.native, 'dharma-agent-fabric')), {code: 'ENOENT'});
});
