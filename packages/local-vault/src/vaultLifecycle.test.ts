import assert from 'node:assert/strict';
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
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dharma-vault-lifecycle-'));
  const key = crypto.randomBytes(32), original = Buffer.from(key);
  t.after(() => fs.rm(root, {recursive: true, force: true}));
  return {root, key, original};
}

// Actual module, real SQLite and C-only files; instrument only owned resource boundaries.
async function module(overrides: {fs?: Record<string, unknown>; crypto?: Record<string, unknown>; database?: typeof DatabaseSync} = {}) {
  const source = await fs.readFile(new URL('../src/index.ts', import.meta.url), 'utf8');
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
        createSystemSecureStore: async () => {throw new Error('no real credential access in fixture');},
      };
      throw new Error('unexpected fixture dependency');
    }}, {timeout: 1000, contextCodeGeneration: {strings: false, wasm: false}});
  return exports.LocalVault as {open(options: {root: string; masterKey: Buffer; rawLocalDays?: number}): Promise<any>};
}

for (const phase of ['schema', 'recovery']) {
  test(`full vault closes its database after ${phase} initialization failure`, async t => {
    const f = await fixture(t); let closes = 0;
    class OwnedDatabase extends DatabaseSync {
      constructor(file: string) {super(file); instances.push({root: path.dirname(file), value: this, closed: false});}
      exec(sql: string) {
        if (phase === 'schema' && sql.includes('create table if not exists blobs')) throw new Error('synthetic-schema-failure');
        return super.exec(sql);
      }
      close() {closes++; const result = super.close(); instances.find(row => row.value === this)!.closed = true; return result;}
    }
    const api = await module({database: OwnedDatabase, fs: phase === 'recovery' ? {
      readdir: async () => {throw new Error('synthetic-recovery-failure');},
    } : undefined});
    try {
      await assert.rejects(api.open({root: f.root, masterKey: f.key}), new RegExp(`synthetic-${phase}-failure`));
      assert.equal(closes, 1);
    } finally {
      // Old-source red runs retain an owned handle; release only that fixture handle below.
      for (const db of instances) if (db.root === f.root && !db.closed) {db.value.close(); db.closed = true;}
    }
  });
}

const instances: Array<{root: string; value: DatabaseSync; closed: boolean}> = [];

test('full vault closes its database after invalid retention and preserves the input key', async t => {
  const f = await fixture(t); let closes = 0;
  class OwnedDatabase extends DatabaseSync {
    constructor(file: string) {super(file); instances.push({root: path.dirname(file), value: this, closed: false});}
    close() {closes++; const result = super.close(); instances.find(row => row.value === this)!.closed = true; return result;}
  }
  const api = await module({database: OwnedDatabase});
  try {
    await assert.rejects(api.open({root: f.root, masterKey: f.key, rawLocalDays: 0}), /retention/);
    assert.equal(closes, 1); assert.deepEqual(f.key, f.original);
  } finally {
    for (const db of instances) if (db.root === f.root && !db.closed) {db.value.close(); db.closed = true;}
  }
});

test('full vault snapshots the original key before filesystem preparation yields', async t => {
  const f = await fixture(t); let mutated = false;
  const api = await module({fs: {mkdir: async (...args: Parameters<typeof fs.mkdir>) => {
    if (!mutated) {mutated = true; f.key.fill(0);} return fs.mkdir(...args);
  }}});
  const vault = await api.open({root: f.root, masterKey: f.key});
  const content = Buffer.from('synthetic-original-key-capture');
  try {await vault.putBlob(content, 'synthetic');} finally {vault.close();}
  const reopened = await api.open({root: f.root, masterKey: f.original});
  try {assert.deepEqual(await reopened.getBlob(contracts.sha256(content)), content);} finally {reopened.close();}
});

test('full vault key ownership survives input mutation and closure leaves the caller key usable', async t => {
  const f = await fixture(t), api = await module();
  const vault = await api.open({root: f.root, masterKey: f.key});
  const content = Buffer.from('synthetic-after-open-key-snapshot');
  f.key.fill(0);
  try {await vault.putBlob(content, 'synthetic');} finally {vault.close();}
  const reopened = await api.open({root: f.root, masterKey: f.original});
  try {assert.deepEqual(await reopened.getBlob(contracts.sha256(content)), content);} finally {reopened.close();}
  assert.notDeepEqual(f.original, Buffer.alloc(32));
});

test('full vault close is idempotent and forbids file-only reads or writes before IO', async t => {
  const f = await fixture(t); let reads = 0, stats = 0;
  const api = await module({fs: {readFile: async (...args: Parameters<typeof fs.readFile>) => {reads++; return fs.readFile(...args);},
    stat: async (...args: Parameters<typeof fs.stat>) => {stats++; return fs.stat(...args);}}});
  const vault = await api.open({root: f.root, masterKey: f.key}), content = Buffer.from('synthetic-closed-vault');
  const hash = await vault.putBlob(content, 'synthetic'); const source = path.join(f.root, 'source.txt');
  await fs.writeFile(source, content); vault.close();
  const before = {reads, stats};
  assert.doesNotThrow(() => vault.close());
  await assert.rejects(vault.getBlob(hash), {message: 'vault_closed'});
  await assert.rejects(vault.putFile(source, 'synthetic'), {message: 'vault_closed'});
  assert.deepEqual({reads, stats}, before); assert.deepEqual(f.key, f.original);
});

test('full vault does not decrypt after a pending read observes owner closure', async t => {
  const f = await fixture(t); let vault: any, closeDuringRead = false, returned = false;
  const api = await module({fs: {readFile: async (...args: Parameters<typeof fs.readFile>) => {
    const bytes = await fs.readFile(...args); if (closeDuringRead) vault.close(); return bytes;
  }}});
  vault = await api.open({root: f.root, masterKey: f.key});
  const hash = await vault.putBlob(Buffer.from('synthetic-closed-read'), 'synthetic');
  closeDuringRead = true;
  try {
    await assert.rejects((async () => {await vault.getBlob(hash); returned = true;})(), {message: 'vault_closed'});
    assert.equal(returned, false);
  } finally {if (!closeDuringRead) vault.close();}
});

test('full vault wipes only its owned in-memory key when it closes', async t => {
  const f = await fixture(t); const captured: Buffer[] = [];
  const api = await module({crypto: {createCipheriv: (...args: Parameters<typeof crypto.createCipheriv>) => {
    if (Buffer.isBuffer(args[1])) captured.push(args[1]); return crypto.createCipheriv(...args);
  }}});
  const vault = await api.open({root: f.root, masterKey: f.key});
  try {await vault.putBlob(Buffer.from('synthetic-key-release'), 'synthetic');} finally {vault.close();}
  assert.equal(captured.length, 1);
  assert.equal(captured.every(key => key.every(byte => byte === 0)), true);
  assert.equal(f.key.equals(f.original), true);
});

test('full vault reports unconfirmed initialization cleanup rather than masking it with vendor details', async t => {
  const f = await fixture(t);
  class OwnedDatabase extends DatabaseSync {
    exec(sql: string) {
      if (sql.includes('create table if not exists blobs')) throw new Error('private-schema-canary');
      return super.exec(sql);
    }
    close() {super.close(); throw new Error('private-close-canary');}
  }
  const api = await module({database: OwnedDatabase});
  await assert.rejects(api.open({root: f.root, masterKey: f.key}),
    (error: Error) => error.message === 'vault_open_cleanup_unconfirmed' && error.cause === undefined);
  assert.deepEqual(f.key, f.original);
});

test('full vault blocks SQL after unconfirmed close and retries only its own handle', async t => {
  const f = await fixture(t); let closes = 0, armed = false;
  class OwnedDatabase extends DatabaseSync {
    close() {
      closes++; if (armed && closes === 1) throw new Error('synthetic-close-not-confirmed');
      return super.close();
    }
  }
  const api = await module({database: OwnedDatabase}), vault = await api.open({root: f.root, masterKey: f.key});
  armed = true;
  try {
    assert.throws(() => vault.close(), /synthetic-close-not-confirmed/);
    assert.throws(() => vault.stats(), {message: 'vault_closed'});
    assert.doesNotThrow(() => vault.close()); assert.equal(closes, 2);
    assert.doesNotThrow(() => vault.close()); assert.equal(closes, 2);
    assert.deepEqual(f.key, f.original);
  } finally {vault.close();}
});

test('full vault preserves encrypted captures and original key across independent handles', async t => {
  const f = await fixture(t), api = await module();
  const first = await api.open({root: f.root, masterKey: f.key});
  const second = await api.open({root: f.root, masterKey: f.key});
  const content = Buffer.from('synthetic-independent-vault-handles');
  try {
    const hash = await first.putBlob(content, 'synthetic'); first.close();
    assert.deepEqual(await second.getBlob(hash), content);
    assert.equal(f.key.equals(f.original), true);
    const file = path.join(f.root, 'blobs', hash.slice(7, 9), `${hash.slice(7)}.blob`);
    assert.equal((await fs.readFile(file)).includes(content), false);
  } finally {first.close(); second.close();}
});
