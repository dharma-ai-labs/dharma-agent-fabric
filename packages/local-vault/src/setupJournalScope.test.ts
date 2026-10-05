import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {mkdtemp, readdir, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import test from 'node:test';
import {LocalVault, type LocalCodexSetupClaim, type LocalCodexSetupResult} from './index.js';

type Scope = {signal: AbortSignal; current(): Promise<boolean>};
type Journal = {claimCodexSetupOperation(id: string, digest: string): Promise<LocalCodexSetupClaim>;
  finishCodexSetupOperation(lease: string, digest: string, result: LocalCodexSetupResult): Promise<void>; close(): void};
const id = '11111111-1111-4111-8111-111111111111', digest = `sha256:${'a'.repeat(64)}`;
const receiptId = '22222222-2222-4222-8222-222222222222';
const currentScope = (): Scope => ({signal: new AbortController().signal, current: async () => true});
async function open(root: string, masterKey: Buffer, scope: Scope): Promise<Journal> {
  const method = (LocalVault as unknown as {openSetupJournal?: (options: {root: string; masterKey: Buffer}, scope: Scope) => Promise<Journal>}).openSetupJournal;
  assert.equal(typeof method, 'function', 'scoped setup-journal opening is absent');
  return method!({root, masterKey}, scope);
}
async function fixture(operation: (root: string, key: Buffer) => Promise<void>) {
  const root = await mkdtemp(resolve(tmpdir(), 'fabric-scoped-setup-journal-'));
  try {await operation(root, randomBytes(32));} finally {await rm(root, {recursive: true, force: true});}
}

test('setup journal refuses cancelled or withdrawn authority before creating its root', async () => {
  await fixture(async (root, key) => {
    for (const cancelled of [false, true]) {
      const abort = new AbortController(); if (cancelled) abort.abort();
      await assert.rejects(open(resolve(root, `journal-${cancelled}`), key,
        {signal: abort.signal, current: async () => cancelled}), {message: 'vault_setup_journal_scope_unavailable'});
    }
    assert.deepEqual(await readdir(root), []);
  });
});

test('setup journal closes an acquired database when opening loses authority', async () => {
  await fixture(async (root, key) => {
    let checks = 0;
    await assert.rejects(open(resolve(root, 'journal'), key,
      {signal: new AbortController().signal, current: async () => ++checks < 4}),
    {message: 'vault_setup_journal_scope_unavailable'});
    assert.equal(checks, 4);
    const database = new DatabaseSync(resolve(root, 'journal', 'vault.sqlite'));
    try {assert.equal(database.prepare('select count(*) as n from sqlite_master where type = ?').get('table')!.n, 0);}
    finally {database.close();}
  });
});

test('setup journal persists encrypted completion and rejects changed payload after restart', async () => {
  await fixture(async (root, key) => {
    let journal = await open(root, key, currentScope());
    try {
      assert.deepEqual(Object.keys(journal).sort(), ['claimCodexSetupOperation', 'close', 'finishCodexSetupOperation']);
      assert.equal(Object.isFrozen(journal), true);
      const acquired = await journal.claimCodexSetupOperation(id, digest); assert.equal(acquired.state, 'acquired');
      if (acquired.state !== 'acquired') throw new Error('fixture lease missing');
      const result = {state: 'completed' as const, readinessReceiptId: receiptId};
      await journal.finishCodexSetupOperation(acquired.leaseId, digest, result);
      await journal.finishCodexSetupOperation(acquired.leaseId, digest, result);
      journal.close();
      assert.equal((await readFile(resolve(root, 'vault.sqlite'))).includes(Buffer.from(receiptId)), false);
      journal = await open(root, key, currentScope());
      assert.deepEqual(await journal.claimCodexSetupOperation(id, digest), {state: 'terminal', intentDigest: digest, result});
      await assert.rejects(journal.claimCodexSetupOperation(id, `sha256:${'b'.repeat(64)}`), {message: 'setup_operation_conflict'});
    } finally {journal.close();}
    await assert.rejects(journal.claimCodexSetupOperation(id, digest), {message: 'vault_setup_journal_scope_unavailable'});
  });
});

test('a setup claim written before withdrawal remains running and cannot be recycled', async () => {
  await fixture(async (root, key) => {
    let checks = 0;
    const journal = await open(root, key, {signal: new AbortController().signal, current: async () => ++checks < 10});
    try {
      await assert.rejects(journal.claimCodexSetupOperation(id, digest), {message: 'vault_setup_journal_scope_unavailable'});
      assert.equal(checks, 10);
    } finally {journal.close();}
    const recovered = await open(root, key, currentScope());
    try {assert.deepEqual(await recovered.claimCodexSetupOperation(id, digest), {state: 'running', intentDigest: digest});}
    finally {recovered.close();}
  });
});

test('setup journal opens without retaining, pruning or backfilling unrelated evidence', async () => {
  await fixture(async (root, key) => {
    const vault = await LocalVault.open({root, masterKey: key});
    const plain = Buffer.from('synthetic raw evidence that setup must not delete');
    const blob = await vault.putBlob(plain, 'raw-provider-session');
    const database = new DatabaseSync(resolve(root, 'vault.sqlite'));
    let journal: Journal | undefined;
    try {
      database.prepare('update blobs set created_at = ? where content_id = ?').run('2000-01-01T00:00:00.000Z', blob);
      const before = database.prepare('select * from blobs').all();
      journal = await open(root, key, currentScope()); journal.close();
      assert.deepEqual(database.prepare('select * from blobs').all(), before);
      assert.deepEqual(await vault.getBlob(blob), plain);
      assert.equal(key.equals(Buffer.alloc(32)), false, 'closing journal must not wipe another vault owner key');
    } finally {journal?.close(); database.close(); vault.close();}
  });
});

test('setup journal snapshots root and key and exposes no capture or history capability', async () => {
  await fixture(async (root, key) => {
    const originalKey = Buffer.from(key), options = {root: resolve(root, 'intended'), masterKey: key};
    const method = (LocalVault as unknown as {openSetupJournal: (input: {root: string; masterKey: Buffer}, scope: Scope) => Promise<Journal>}).openSetupJournal;
    assert.equal(typeof method, 'function');
    const journal = await method(options, {signal: new AbortController().signal, current: async () => {
      options.root = resolve(root, 'foreign'); key.fill(0); return true;
    }});
    try {
      const acquired = await journal.claimCodexSetupOperation(id, digest);
      if (acquired.state !== 'acquired') throw new Error('fixture lease missing');
      await journal.finishCodexSetupOperation(acquired.leaseId, digest, {state: 'completed', readinessReceiptId: receiptId});
    } finally {journal.close();}
    assert.deepEqual(await readdir(root), ['intended']);
    const recovered = await open(resolve(root, 'intended'), originalKey, currentScope());
    try {assert.equal((await recovered.claimCodexSetupOperation(id, digest)).state, 'terminal');}
    finally {recovered.close();}
  });
});

test('closing a setup journal during qualification prevents even a database-access attempt', async t => {
  await fixture(async (root, key) => {
    let qualify = async () => true, release!: (value: boolean) => void, started!: () => void;
    const pending = new Promise<boolean>(done => {release = done;});
    const requested = new Promise<void>(done => {started = done;});
    const journal = await open(root, key, {signal: new AbortController().signal, current: () => qualify()});
    let databaseAccesses = 0; const original = LocalVault.prototype.claimCodexSetupOperation;
    t.mock.method(LocalVault.prototype, 'claimCodexSetupOperation', function (this: LocalVault, operationId: string, intentDigest: string) {
      databaseAccesses++; return original.call(this, operationId, intentDigest);
    });
    qualify = async () => {started(); return pending;};
    const result = journal.claimCodexSetupOperation(id, digest);
    const rejection = assert.rejects(result, {message: 'vault_setup_journal_scope_unavailable'});
    try {
      await requested; journal.close(); release(true); await rejection;
      assert.equal(databaseAccesses, 0);
    } finally {release(false); await Promise.allSettled([result]); journal.close();}
  });
});
