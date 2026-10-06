import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as syncFs from 'node:fs';
import * as crypto from 'node:crypto';
import * as os from 'node:os';
import * as path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import * as util from 'node:util';
import {runInNewContext} from 'node:vm';
import test from 'node:test';
import ts from 'typescript';
import * as contracts from '@dharma-ai-labs/agent-fabric-contracts';
import * as evidence from '@dharma-ai-labs/agent-fabric-evidence-reduction';
import * as setupReadiness from './setupReadiness.js';
import * as setupSessionHandoff from './setupSessionHandoff.js';

async function fixture(t: {after(fn: () => Promise<void>): void}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dharma-full-vault-scope-'));
  const key = crypto.randomBytes(32), controller = new AbortController(); let active = true;
  t.after(() => fs.rm(root, {recursive: true, force: true}));
  return {root, key, controller, scope: {signal: controller.signal, current: async () => active},
    withdraw: () => {active = false; controller.abort();}};
}

// Actual production module with real C-only files/SQLite; no credential-store access.
async function module(overrides: {fs?: Record<string, unknown>; crypto?: Record<string, unknown>; database?: typeof DatabaseSync} = {}) {
  const oldHead = process.env.DHARMA_FULL_VAULT_TEST_SOURCE_HEAD;
  if (oldHead && oldHead !== 'f9d37d1b94721a4a01e3c4716c2c316d822a0d24') throw new Error('fixture source not qualified');
  const source = oldHead ? execFileSync('git', ['show', `${oldHead}:packages/local-vault/src/index.ts`], {encoding: 'utf8'})
    : await fs.readFile(new URL('../src/index.ts', import.meta.url), 'utf8');
  const result = ts.transpileModule(source, {compilerOptions: {
    target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.CommonJS}, reportDiagnostics: true});
  assert.equal(result.diagnostics?.filter(item => item.category === ts.DiagnosticCategory.Error).length, 0);
  const exports: Record<string, any> = {};
  runInNewContext(result.outputText, {exports, Buffer, process, Date, AbortSignal, structuredClone,
    require: (name: string) => {
      if (name === 'node:crypto') return {...crypto, ...overrides.crypto};
      if (name === 'node:fs') return syncFs;
      if (name === 'node:fs/promises') return {...fs, ...overrides.fs};
      if (name === 'node:os') return os;
      if (name === 'node:path') return path;
      if (name === 'node:sqlite') return {DatabaseSync: overrides.database ?? DatabaseSync};
      if (name === 'node:util') return util;
      if (name === '@dharma-ai-labs/agent-fabric-contracts') return contracts;
      if (name === '@dharma-ai-labs/agent-fabric-evidence-reduction') return evidence;
      if (name === './setupReadiness.js') return setupReadiness;
      if (name === './setupSessionHandoff.js') return setupSessionHandoff;
      if (name === '@dharma-ai-labs/agent-fabric-secure-store') return {
        createSystemSecureStore: async () => {throw new Error('real credential access forbidden in fixture');},
      };
      throw new Error('unexpected fixture dependency');
    }}, {timeout: 1000, contextCodeGeneration: {strings: false, wasm: false}});
  return exports.LocalVault as {open(options: {root: string; masterKey: Buffer}, scope?: {signal: AbortSignal; current(): Promise<boolean>}): Promise<any>};
}

function capture() {
  const raw = Buffer.from('synthetic executed turn'), capsule = Buffer.from(JSON.stringify({contentIndex: []}));
  return {raw: {plaintext: raw, kind: 'raw-provider-turn', expectedContentId: contracts.sha256(raw)},
    capsule: {plaintext: capsule, trajectoryId: 'synthetic-trajectory', revision: 1, capsuleHash: contracts.sha256(capsule)},
    session: {sessionId: 'synthetic-session', provider: 'codex', workspaceId: 'synthetic-workspace',
      sourceLocator: 'synthetic-local-reference', status: 'observed', observedAt: new Date().toISOString()}};
}

function binding(root: string, number = 6) {
  const id = (n: number) => `40000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  return {schema: 'dharma.local-provider-session-binding/v1', owner: 'dharma_bridge',
    organizationId: 'org_synthetic', repositoryBindingId: id(1), workspaceId: id(2), endpointId: id(3),
    membershipId: id(4), deviceId: id(5), bindingId: id(number), provider: 'codex', sessionId: `synthetic-thread-${number}`,
    workspaceRoot: path.join(root, 'repo'), createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 86_400_000).toISOString(), maximumProviderCostCents: 25};
}

for (const boundary of ['before-read', 'after-read'] as const) {
  test(`full scoped completion readback withholds ${boundary} withdrawal without acquiring another lease`, async t => {
    const f = await fixture(t); let armed = false, reads = 0;
    class ReadbackDatabase extends DatabaseSync {
      prepare(sql: string) {
        const statement = super.prepare(sql), get = statement.get.bind(statement);
        if (sql === 'select * from codex_setup_operations where operation_id = ?') {
          statement.get = ((...args: any[]) => {
            const result = Reflect.apply(get, statement, args);
            if (armed) {reads++; if (boundary === 'after-read') f.withdraw();}
            return result;
          }) as typeof statement.get;
        }
        return statement;
      }
    }
    const api = await module({database: ReadbackDatabase});
    const vault = await api.open({root: f.root, masterKey: f.key}, f.scope);
    const operation = '11111111-1111-4111-8111-111111111111', digest = `sha256:${'a'.repeat(64)}`;
    const result = {state: 'completed', readinessReceiptId: '22222222-2222-4222-8222-222222222222'};
    try {
      const lease = await vault.claimCodexSetupOperation(operation, digest);
      assert.equal(lease.state, 'acquired'); await vault.finishCodexSetupOperation(lease.leaseId, digest, result);
      armed = true; if (boundary === 'before-read') f.withdraw();
      await assert.rejects(vault.readCodexSetupOperation(operation, digest), {message: 'vault_scope_unavailable'});
      assert.equal(reads, boundary === 'before-read' ? 0 : 1);
    } finally {await vault.close();}
    const reopened = await api.open({root: f.root, masterKey: f.key});
    try {assert.deepEqual(JSON.parse(JSON.stringify(await reopened.readCodexSetupOperation(operation, digest))),
      {state: 'terminal', intentDigest: digest, result});}
    finally {await reopened.close();}
  });
}

for (const rollback of [true, false]) {
  test(`full scoped lease release waits for ${rollback ? 'rolled-back' : 'committed'} capture before durable exact-holder cleanup`, async t => {
    const f = await fixture(t); let armed = false, ready!: () => void, finish!: () => void;
    const entered = new Promise<void>(resolve => {ready = resolve;}), pending = new Promise<void>(resolve => {finish = resolve;});
    const api = await module({fs: {open: async (...args: Parameters<typeof fs.open>) => {
      const handle = await fs.open(...args);
      if (!armed || !String(args[0]).endsWith('.tmp')) return handle;
      return {stat: handle.stat.bind(handle), sync: handle.sync.bind(handle), close: handle.close.bind(handle),
        writeFile: async (bytes: Uint8Array) => {await handle.writeFile(bytes); ready(); await pending;}};
    }}});
    const vault = await api.open({root: f.root, masterKey: f.key}, f.scope), record = binding(f.root);
    await vault.saveProviderSessionBinding(record);
    const lease = await vault.tryAcquireProviderSessionLease(record.bindingId, record); assert.ok(lease);
    armed = true;
    const work = vault.commitCapture(capture()); work.catch(() => undefined);
    await entered;
    const released = lease.release(), duplicate = lease.release();
    if (rollback) f.withdraw();
    try {
      finish();
      if (rollback) await assert.rejects(work, {message: 'vault_scope_unavailable'}); else await work;
      await released; await duplicate;
    } finally {finish(); await work.catch(() => undefined); await vault.close();}
    const db = new DatabaseSync(path.join(f.root, 'vault.sqlite'), {readOnly: true});
    try {assert.equal(db.prepare('select count(*) as n from provider_session_leases').get()!.n, 0);}
    finally {db.close();}
    const reopened = await api.open({root: f.root, masterKey: f.key},
      {signal: new AbortController().signal, current: async () => true});
    try {
      const next = await reopened.tryAcquireProviderSessionLease(record.bindingId, record);
      assert.ok(next); await next.release();
    } finally {await reopened.close();}
  });
}

test('full scoped failed lease release retains exact-holder ownership for close retry without touching a sibling', async t => {
  const f = await fixture(t); let fail = false, failures = 0;
  class OwnedDatabase extends DatabaseSync {
    prepare(sql: string) {
      const statement = super.prepare(sql), run = statement.run.bind(statement);
      if (sql.startsWith('delete from provider_session_leases')) {
        statement.run = ((...args: any[]) => {
          if (fail) {failures++; throw new Error('private lease delete canary');}
          return Reflect.apply(run, statement, args);
        }) as typeof statement.run;
      }
      return statement;
    }
  }
  const api = await module({database: OwnedDatabase}), vault = await api.open({root: f.root, masterKey: f.key}, f.scope);
  const own = binding(f.root), sibling = binding(f.root, 7);
  await vault.saveProviderSessionBinding(own);
  const other = await api.open({root: f.root, masterKey: f.key}); other.saveProviderSessionBinding(sibling);
  const lease = await vault.tryAcquireProviderSessionLease(own.bindingId, own), peer = other.tryAcquireProviderSessionLease(sibling.bindingId, sibling);
  assert.ok(lease); assert.ok(peer);
  try {
    fail = true;
    await assert.rejects(async () => lease.release(), {message: 'vault_cleanup_unconfirmed'});
    fail = false; f.withdraw(); await vault.close();
    assert.equal(await peer.assertHeld(), true); assert.equal(failures, 1);
    const db = new DatabaseSync(path.join(f.root, 'vault.sqlite'), {readOnly: true});
    try {assert.equal(db.prepare('select count(*) as n from provider_session_leases where binding_id = ?').get(own.bindingId)!.n, 0);}
    finally {db.close();}
  } finally {fail = false; await vault.close(); peer.release(); other.close();}
});

test('full legacy lease refuses transaction-local release and retains ownership through rollback', async t => {
  const f = await fixture(t); let armed = false, ready!: () => void, finish!: () => void;
  const entered = new Promise<void>(resolve => {ready = resolve;}), pending = new Promise<void>(resolve => {finish = resolve;});
  const api = await module({fs: {writeFile: async (...args: Parameters<typeof fs.writeFile>) => {
    const result = await fs.writeFile(...args);
    if (armed && String(args[0]).endsWith('.tmp')) {ready(); await pending;}
    return result;
  }}});
  const vault = await api.open({root: f.root, masterKey: f.key}), record = binding(f.root);
  vault.saveProviderSessionBinding(record);
  const lease = vault.tryAcquireProviderSessionLease(record.bindingId, record); assert.ok(lease);
  const payload = capture(); payload.raw.expectedContentId = contracts.sha256('synthetic different bytes');
  armed = true; const work = vault.commitCapture(payload); work.catch(() => undefined);
  await entered;
  try {
    assert.throws(() => lease.release(), {message: 'vault_cleanup_unconfirmed'});
    finish(); await assert.rejects(work, /Raw evidence content hash changed/);
  } finally {finish(); await work.catch(() => undefined); vault.close();}
  const db = new DatabaseSync(path.join(f.root, 'vault.sqlite'), {readOnly: true});
  try {assert.equal(db.prepare('select count(*) as n from provider_session_leases').get()!.n, 0);}
  finally {db.close();}
});

test('full scoped vault rejects proxy input without invoking traps and ignores byte-array species', async t => {
  const f = await fixture(t), api = await module(), vault = await api.open({root: f.root, masterKey: f.key}, f.scope);
  let traps = 0, species = 0;
  const payload = new Proxy({}, {ownKeys: () => {traps++; throw new Error('private proxy canary');}});
  const bytes = Buffer.from('synthetic byte input');
  Object.defineProperty(bytes, 'constructor', {get: () => {species++; throw new Error('private species canary');}});
  try {
    await assert.rejects(vault.recordSession(payload), {message: 'vault_input_invalid'});
    const id = await vault.putBlob(bytes, 'synthetic');
    assert.deepEqual(await vault.getBlob(id), Buffer.from('synthetic byte input'));
    assert.equal(traps, 0); assert.equal(species, 0);
  } finally {await vault.close();}
});

test('full scoped vault refuses initialization before even mkdir under withdrawn authority', async t => {
  const f = await fixture(t); let effects = 0, vault: any;
  const api = await module({fs: {mkdir: async (...args: Parameters<typeof fs.mkdir>) => {effects++; return fs.mkdir(...args);}}});
  f.withdraw();
  try {await assert.rejects(async () => {vault = await api.open({root: f.root, masterKey: f.key}, f.scope);}, {message: 'vault_scope_unavailable'});}
  finally {await vault?.close();}
  assert.equal(effects, 0);
});

test('full scoped vault refuses malformed scope without invoking its accessor', async t => {
  const f = await fixture(t); let getters = 0, effects = 0, vault: any;
  const api = await module({fs: {mkdir: async (...args: Parameters<typeof fs.mkdir>) => {effects++; return fs.mkdir(...args);}}});
  const scope = {get signal(): AbortSignal {getters++; throw new Error('private-scope-canary');}, current: async () => true};
  try {await assert.rejects(async () => {vault = await api.open({root: f.root, masterKey: f.key}, scope);}, {message: 'vault_scope_unavailable'});}
  finally {await vault?.close();}
  assert.equal(getters, 0); assert.equal(effects, 0);
});

test('full scoped vault retains original authority and refuses later sync database access', async t => {
  const f = await fixture(t), api = await module(), scope = f.scope;
  const vault = await api.open({root: f.root, masterKey: f.key}, scope);
  f.withdraw(); scope.current = async () => true; scope.signal = new AbortController().signal;
  try {await assert.rejects(async () => vault.stats(), {message: 'vault_scope_unavailable'});}
  finally {await vault.close();}
});

test('full scoped vault stops initialization after withdrawal at recovery read and closes owned database', async t => {
  const f = await fixture(t); let closes = 0, reads = 0, vault: any;
  class OwnedDatabase extends DatabaseSync {close() {closes++; return super.close();}}
  const api = await module({database: OwnedDatabase, fs: {readdir: async (...args: Parameters<typeof fs.readdir>) => {
    const result = await fs.readdir(...args); reads++; f.withdraw(); return result;
  }}});
  try {await assert.rejects(async () => {vault = await api.open({root: f.root, masterKey: f.key}, f.scope);}, {message: 'vault_scope_unavailable'});}
  finally {await vault?.close();}
  assert.equal(reads, 1); assert.equal(closes, 1);
});

test('full scoped vault stops encrypted blob publication after its directory yield', async t => {
  const f = await fixture(t); let armed = false, writes = 0;
  const api = await module({fs: {mkdir: async (...args: Parameters<typeof fs.mkdir>) => {
    const result = await fs.mkdir(...args); if (armed) f.withdraw(); return result;
  }, open: async (...args: Parameters<typeof fs.open>) => {if (armed) writes++; return fs.open(...args);},
  writeFile: async (...args: Parameters<typeof fs.writeFile>) => {if (armed) writes++; return fs.writeFile(...args);}}});
  const vault = await api.open({root: f.root, masterKey: f.key}, f.scope); armed = true;
  try {await assert.rejects(vault.putBlob(Buffer.from('synthetic forbidden publication'), 'synthetic'), {message: 'vault_scope_unavailable'});}
  finally {await vault.close();}
  assert.equal(writes, 0);
});

test('full scoped vault does not decrypt a read returned after withdrawal', async t => {
  const f = await fixture(t); let armed = false, decrypted = 0;
  const api = await module({fs: {readFile: async (...args: Parameters<typeof fs.readFile>) => {
    const result = await fs.readFile(...args); if (armed) f.withdraw(); return result;
  }}, crypto: {createDecipheriv: (...args: Parameters<typeof crypto.createDecipheriv>) => {decrypted++; return crypto.createDecipheriv(...args);}}});
  const vault = await api.open({root: f.root, masterKey: f.key}, f.scope);
  const hash = await vault.putBlob(Buffer.from('synthetic protected read'), 'synthetic'); armed = true;
  try {await assert.rejects(vault.getBlob(hash), {message: 'vault_scope_unavailable'});}
  finally {await vault.close();}
  assert.equal(decrypted, 0);
});

test('full scoped vault snapshots capture inputs and keeps encrypted full evidence and sync queue', async t => {
  const f = await fixture(t), input = capture(); let armed = false;
  const expected = input.raw.expectedContentId;
  const api = await module({fs: {mkdir: async (...args: Parameters<typeof fs.mkdir>) => {
    const result = await fs.mkdir(...args);
    if (armed) {input.raw.plaintext.fill(0); input.raw.expectedContentId = `sha256:${'0'.repeat(64)}`;}
    return result;
  }}});
  const vault = await api.open({root: f.root, masterKey: f.key}, f.scope); armed = true;
  try {
    const result = await vault.commitCapture(input); assert.equal(result.rawContentId, expected);
    await vault.queueCapsuleSync(input.capsule.trajectoryId, 1);
    assert.equal((await vault.listPendingCapsuleSyncs()).length, 1);
    assert.equal((await vault.stats()).sessions, 1);
    assert.equal((await vault.getBlob(expected)).toString(), 'synthetic executed turn');
  } finally {await vault.close();}
});

test('full scoped vault retains encrypted quarantine and rolled-back metadata after retention withdrawal', async t => {
  const f = await fixture(t); let armed = false, renamed: {from: string; to: string} | undefined;
  const api = await module({fs: {rename: async (from: string, to: string) => {
    await fs.rename(from, to); if (armed) {renamed = {from, to}; f.withdraw();}
  }}});
  const vault = await api.open({root: f.root, masterKey: f.key}, f.scope), bytes = Buffer.from('synthetic retained raw');
  const hash = await vault.putBlob(bytes, 'raw-provider-turn'); armed = true;
  try {await assert.rejects(vault.enforceRawEvidenceRetention({now: new Date(Date.now() + 40 * 86_400_000)}), {message: 'vault_scope_unavailable'});}
  finally {await vault.close();}
  assert.ok(renamed); assert.equal((await fs.readFile(renamed.to)).includes(bytes), false);
  const reopened = await api.open({root: f.root, masterKey: f.key});
  try {assert.deepEqual(await reopened.getBlob(hash), bytes);} finally {await reopened.close();}
});

test('full scoped vault close drains an owned pending read before closing its database', async t => {
  const f = await fixture(t); let armed = false, closes = 0, ready!: () => void, finish!: () => void;
  const pending = new Promise<void>(resolve => {finish = resolve;}), entered = new Promise<void>(resolve => {ready = resolve;});
  class OwnedDatabase extends DatabaseSync {close() {closes++; return super.close();}}
  const api = await module({database: OwnedDatabase, fs: {readFile: async (...args: Parameters<typeof fs.readFile>) => {
    const bytes = await fs.readFile(...args); if (armed) {ready(); await pending;} return bytes;
  }}});
  const vault = await api.open({root: f.root, masterKey: f.key}, f.scope), hash = await vault.putBlob(Buffer.from('synthetic pending read'), 'synthetic');
  armed = true; const read = vault.getBlob(hash); await entered;
  const closing = vault.close();
  try {assert.equal(closes, 0);} finally {finish(); await read.catch(() => undefined); await closing;}
  await assert.rejects(read, {message: 'vault_scope_unavailable'}); assert.equal(closes, 1);
});

test('full scoped vault rolls back capture and retains only encrypted interruption evidence', async t => {
  const f = await fixture(t); let armed = false, writes = 0, retainedPath = '';
  const api = await module({fs: {open: async (...args: Parameters<typeof fs.open>) => {
    const handle = await fs.open(...args);
    if (!armed || !String(args[0]).endsWith('.tmp')) return handle;
    retainedPath = String(args[0]);
    return {stat: handle.stat.bind(handle), sync: handle.sync.bind(handle), close: handle.close.bind(handle),
      writeFile: async (bytes: Uint8Array) => {await handle.writeFile(bytes); writes++; f.withdraw();}};
  }}});
  const vault = await api.open({root: f.root, masterKey: f.key}, f.scope), input = capture(); armed = true;
  try {await assert.rejects(vault.commitCapture(input), {message: 'vault_scope_unavailable'});}
  finally {await vault.close();}
  assert.equal(writes, 1); assert.equal((await fs.readFile(retainedPath)).includes(input.raw.plaintext), false);
  const db = new DatabaseSync(path.join(f.root, 'vault.sqlite'));
  try {assert.equal(db.prepare('select count(*) as n from capsules').get()!.n, 0);
    assert.equal(db.prepare('select count(*) as n from sessions').get()!.n, 0);}
  finally {db.close();}
});

test('full scoped vault never deletes a foreign replacement at an owned temporary name', async t => {
  const f = await fixture(t); let replacement = '', armed = false;
  const bytes = Buffer.from('synthetic duplicate file'), foreign = Buffer.from('synthetic unrelated replacement');
  const api = await module({fs: {open: async (...args: Parameters<typeof fs.open>) => {
    const handle = await fs.open(...args);
    if (!armed || !String(args[0]).includes('.incoming-')) return handle;
    const file = String(args[0]);
    return {stat: handle.stat.bind(handle), sync: handle.sync.bind(handle), write: handle.write.bind(handle),
      close: async () => {await handle.close(); await fs.rename(file, `${file}.retained`);
        await fs.writeFile(file, foreign, {mode: 0o600, flag: 'wx'}); replacement = file;}};
  }}});
  const vault = await api.open({root: f.root, masterKey: f.key}, f.scope);
  await vault.putBlob(bytes, 'synthetic'); const source = path.join(f.root, 'synthetic-source'); await fs.writeFile(source, bytes);
  armed = true;
  try {await assert.rejects(vault.putFile(source, 'synthetic'), {message: 'vault_cleanup_unconfirmed'});}
  finally {await vault.close();}
  assert.deepEqual(await fs.readFile(replacement), foreign);
});

test('full scoped vault refuses accessor payloads before executing user code or SQL', async t => {
  const f = await fixture(t), api = await module(), vault = await api.open({root: f.root, masterKey: f.key}, f.scope);
  let getters = 0;
  const session = {...capture().session, get sourceLocator() {getters++; return 'private-input-canary';}};
  try {
    await assert.rejects(vault.recordSession(session), {message: 'vault_input_invalid'});
    assert.equal(getters, 0); assert.equal((await vault.stats()).sessions, 0);
  } finally {await vault.close();}
});

test('full scoped vault lease withdrawal and cooperative release preserve a sibling holder', async t => {
  const f = await fixture(t), api = await module(), vault = await api.open({root: f.root, masterKey: f.key}, f.scope);
  const id = (n: number) => `40000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  const binding = {schema: 'dharma.local-provider-session-binding/v1', owner: 'dharma_bridge',
    organizationId: 'org_synthetic', repositoryBindingId: id(1), workspaceId: id(2), endpointId: id(3),
    membershipId: id(4), deviceId: id(5), bindingId: id(6), provider: 'codex', sessionId: 'synthetic-thread',
    workspaceRoot: path.join(f.root, 'repo'), createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 86_400_000).toISOString(), maximumProviderCostCents: 25};
  const sibling = {...binding, bindingId: id(7), sessionId: 'synthetic-sibling'};
  await vault.saveProviderSessionBinding(binding);
  const other = await api.open({root: f.root, masterKey: f.key}); other.saveProviderSessionBinding(sibling);
  const lease = await vault.tryAcquireProviderSessionLease(binding.bindingId, binding), siblingLease = other.tryAcquireProviderSessionLease(sibling.bindingId, sibling);
  assert.ok(lease); assert.ok(siblingLease); f.withdraw();
  try {
    await assert.rejects(lease.assertHeld(), {message: 'vault_scope_unavailable'});
    lease.release(); lease.release(); await vault.close();
    assert.equal(await siblingLease.assertHeld(), true);
  } finally {await vault.close(); siblingLease.release(); await other.close();}
});

test('full scoped vault genuinely expires raw evidence while retaining revised capsules and queue', async t => {
  const f = await fixture(t), api = await module(), vault = await api.open({root: f.root, masterKey: f.key}, f.scope);
  const input = capture(); input.capsule.plaintext = Buffer.from(JSON.stringify({
    trajectoryId: input.capsule.trajectoryId, revision: 1, capsuleHash: input.capsule.capsuleHash,
    contentIndex: [{contentId: input.raw.expectedContentId, availableLocally: true}], localEvidenceAvailable: []}));
  try {
    await vault.commitCapture(input);
    const result = await vault.enforceRawEvidenceRetention({now: new Date(Date.now() + 40 * 86_400_000)});
    assert.equal(result.deleted, 1);
    assert.equal((await vault.getLatestCapsule(input.capsule.trajectoryId)).revision, 2);
    assert.equal((await vault.listPendingCapsuleSyncs()).length, 1);
    await assert.rejects(vault.getBlob(input.raw.expectedContentId), {message: 'vault_storage_unavailable'});
  } finally {await vault.close();}
});
