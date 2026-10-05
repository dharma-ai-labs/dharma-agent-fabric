import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {mkdtemp, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve, sep} from 'node:path';
import test from 'node:test';
import {DatabaseSync} from 'node:sqlite';
import {LocalVault} from './index.js';

const operation = '40000000-1111-4111-8111-111111111111';
const receipt = '50000000-1111-4111-8111-111111111111';
const digest = `sha256:${'a'.repeat(64)}`;
async function fixture() {
  const root = await mkdtemp(resolve(tmpdir(), 'fabric-setup-journal-'));
  const key = randomBytes(32);
  const vault = await LocalVault.open({root, masterKey: key});
  return {root, key, vault, cleanup: async () => {
    if (!resolve(root).startsWith(`${resolve(tmpdir())}${sep}fabric-setup-journal-`)) throw new Error('fixture_cleanup_scope_invalid');
    await rm(root, {recursive: true, force: true});
  }};
}

test('setup operation journal preserves a running fence across reopen and rejects changed intent', async () => {
  const f = await fixture(); let vault = f.vault;
  try {
    const first = vault.claimCodexSetupOperation(operation, digest);
    assert.equal(first.state, 'acquired'); assert.equal(first.intentDigest, digest);
    assert.deepEqual(vault.claimCodexSetupOperation(operation, digest), {state: 'running', intentDigest: digest});
    vault.close(); vault = await LocalVault.open({root: f.root, masterKey: f.key});
    assert.deepEqual(vault.claimCodexSetupOperation(operation, digest), {state: 'running', intentDigest: digest});
    assert.throws(() => vault.claimCodexSetupOperation(operation, `sha256:${'b'.repeat(64)}`), /setup_operation_conflict/);
  } finally {vault.close(); await f.cleanup();}
});

test('terminal setup receipt is encrypted, survives reopen and cannot be overwritten', async () => {
  const f = await fixture(); let vault = f.vault;
  try {
    const claim = vault.claimCodexSetupOperation(operation, digest); assert.equal(claim.state, 'acquired');
    if (claim.state !== 'acquired') throw new Error('fixture_claim_missing');
    const result = {state: 'completed' as const, readinessReceiptId: receipt};
    vault.finishCodexSetupOperation(claim.leaseId, digest, result);
    vault.finishCodexSetupOperation(claim.leaseId, digest, result);
    assert.throws(() => vault.finishCodexSetupOperation(claim.leaseId, digest,
      {state: 'completed', readinessReceiptId: '60000000-1111-4111-8111-111111111111'}), /setup_operation_conflict/);
    vault.close(); vault = await LocalVault.open({root: f.root, masterKey: f.key});
    assert.deepEqual(vault.claimCodexSetupOperation(operation, digest), {state: 'terminal', intentDigest: digest, result});
    assert.equal((await readFile(resolve(f.root, 'vault.sqlite'))).includes(Buffer.from(receipt)), false);
    assert.equal((await readFile(resolve(f.root, 'vault.sqlite'))).includes(Buffer.from(claim.leaseId)), false);
  } finally {vault.close(); await f.cleanup();}
});

test('two vault handles grant only one setup lease and refuse foreign lease completion', async () => {
  const f = await fixture(); const second = await LocalVault.open({root: f.root, masterKey: f.key});
  try {
    const first = f.vault.claimCodexSetupOperation(operation, digest);
    assert.equal(first.state, 'acquired');
    assert.deepEqual(second.claimCodexSetupOperation(operation, digest), {state: 'running', intentDigest: digest});
    assert.throws(() => second.finishCodexSetupOperation('70000000-1111-4111-8111-111111111111', digest,
      {state: 'completed', readinessReceiptId: receipt}), /setup_operation_conflict/);
  } finally {second.close(); f.vault.close(); await f.cleanup();}
});

test('private or malformed result cannot enter the setup journal', async () => {
  const f = await fixture();
  try {
    const claim = f.vault.claimCodexSetupOperation(operation, digest);
    if (claim.state !== 'acquired') throw new Error('fixture_claim_missing');
    for (const result of [{state: 'completed', readinessReceiptId: receipt, token: 'private-canary'},
      {state: 'completed', readinessReceiptId: 'private-canary'}, {state: 'failed', error: 'private-canary'}]) {
      assert.throws(() => f.vault.finishCodexSetupOperation(claim.leaseId, digest, result as never), /setup_operation_invalid/);
    }
    assert.deepEqual(f.vault.claimCodexSetupOperation(operation, digest), {state: 'running', intentDigest: digest});
  } finally {f.vault.close(); await f.cleanup();}
});

test('wrong vault key cannot disclose a terminal setup receipt', async () => {
  const f = await fixture(); let vault = f.vault;
  try {
    const claim = vault.claimCodexSetupOperation(operation, digest);
    if (claim.state !== 'acquired') throw new Error('fixture_claim_missing');
    vault.finishCodexSetupOperation(claim.leaseId, digest, {state: 'completed', readinessReceiptId: receipt});
    vault.close(); vault = await LocalVault.open({root: f.root, masterKey: randomBytes(32)});
    assert.throws(() => vault.claimCodexSetupOperation(operation, digest), /^Error: setup_operation_integrity_failed$/);
  } finally {vault.close(); await f.cleanup();}
});

test('authenticated setup result cannot be transplanted to another operation row', async () => {
  const f = await fixture(); const db = new DatabaseSync(resolve(f.root, 'vault.sqlite'));
  try {
    const first = f.vault.claimCodexSetupOperation(operation, digest);
    const otherId = '80000000-1111-4111-8111-111111111111';
    const second = f.vault.claimCodexSetupOperation(otherId, digest);
    if (first.state !== 'acquired' || second.state !== 'acquired') throw new Error('fixture_claim_missing');
    f.vault.finishCodexSetupOperation(first.leaseId, digest, {state: 'completed', readinessReceiptId: receipt});
    db.prepare(`update codex_setup_operations set state = 'terminal',
      nonce = (select nonce from codex_setup_operations where operation_id = ?),
      tag = (select tag from codex_setup_operations where operation_id = ?),
      ciphertext = (select ciphertext from codex_setup_operations where operation_id = ?)
      where operation_id = ?`).run(operation, operation, operation, otherId);
    assert.throws(() => f.vault.claimCodexSetupOperation(otherId, digest), /^Error: setup_operation_integrity_failed$/);
    assert.equal(f.vault.claimCodexSetupOperation(operation, digest).state, 'terminal');
  } finally {db.close(); f.vault.close(); await f.cleanup();}
});

test('setup journal denies accessor-based and symbol-bearing input without invoking getters', async () => {
  const f = await fixture(); let getters = 0;
  try {
    const claim = f.vault.claimCodexSetupOperation(operation, digest);
    if (claim.state !== 'acquired') throw new Error('fixture_claim_missing');
    const accessor = {state: 'completed', get readinessReceiptId() {getters++; return receipt;}};
    assert.throws(() => f.vault.finishCodexSetupOperation(claim.leaseId, digest, accessor as never), /setup_operation_invalid/);
    const symbolic = {state: 'completed', readinessReceiptId: receipt, [Symbol('private')]: 'private-canary'};
    assert.throws(() => f.vault.finishCodexSetupOperation(claim.leaseId, digest, symbolic as never), /setup_operation_invalid/);
    assert.equal(getters, 0);
    assert.equal(f.vault.claimCodexSetupOperation(operation, digest).state, 'running');
  } finally {f.vault.close(); await f.cleanup();}
});

test('uncertain setup completion remains terminal across reopen and cannot become completed', async () => {
  const f = await fixture(); let vault = f.vault;
  try {
    const claim = vault.claimCodexSetupOperation(operation, digest);
    if (claim.state !== 'acquired') throw new Error('fixture_claim_missing');
    const result = {state: 'unconfirmed' as const, code: 'setup_execution_unconfirmed' as const};
    vault.finishCodexSetupOperation(claim.leaseId, digest, result);
    vault.close(); vault = await LocalVault.open({root: f.root, masterKey: f.key});
    assert.deepEqual(vault.claimCodexSetupOperation(operation, digest), {state: 'terminal', intentDigest: digest, result});
    assert.throws(() => vault.finishCodexSetupOperation(claim.leaseId, digest,
      {state: 'completed', readinessReceiptId: receipt}), /setup_operation_conflict/);
  } finally {vault.close(); await f.cleanup();}
});

test('journal rejects non-durable SQLite settings before acquiring or completing authority', async t => {
  const f = await fixture();
  try {
    const claim = f.vault.claimCodexSetupOperation(operation, digest);
    if (claim.state !== 'acquired') throw new Error('fixture_claim_missing');
    const prepare = DatabaseSync.prototype.prepare;
    const report = t.mock.method(DatabaseSync.prototype, 'prepare', function (this: DatabaseSync, sql: string) {
      if (sql === 'pragma synchronous') return {get: () => ({synchronous: 1})} as never;
      return prepare.call(this, sql);
    });
    assert.throws(() => f.vault.claimCodexSetupOperation('90000000-1111-4111-8111-111111111111', digest),
      /^Error: setup_operation_durability_unqualified$/);
    assert.throws(() => f.vault.finishCodexSetupOperation(claim.leaseId, digest,
      {state: 'completed', readinessReceiptId: receipt}), /^Error: setup_operation_durability_unqualified$/);
    report.mock.restore();
    assert.deepEqual(f.vault.claimCodexSetupOperation(operation, digest), {state: 'running', intentDigest: digest});
    assert.equal(f.vault.claimCodexSetupOperation('90000000-1111-4111-8111-111111111111', digest).state, 'acquired');
  } finally {t.mock.restoreAll(); f.vault.close(); await f.cleanup();}
});

function rejectedCapture(vault: LocalVault) {
  return assert.rejects(vault.commitCapture({
    raw: {plaintext: Buffer.from('synthetic capture with deliberate hash mismatch'), kind: 'fixture', expectedContentId: digest},
    capsule: {plaintext: Buffer.from('{}'), trajectoryId: receipt, revision: 1, capsuleHash: digest},
    session: {sessionId: receipt, provider: 'codex', workspaceId: operation,
      sourceLocator: '/synthetic', status: 'fixture', observedAt: '2026-10-05T18:00:00.000Z'},
  }), /^Error: Raw evidence content hash changed before vault commit\.$/);
}

test('journal denies claim inside a public capture transaction and admits it durably after rollback', async () => {
  const f = await fixture(); let vault = f.vault; let capture: Promise<void> | undefined;
  try {
    capture = rejectedCapture(vault);
    assert.throws(() => vault.claimCodexSetupOperation(operation, digest), /^Error: setup_operation_transaction_active$/);
    await capture;
    const claim = vault.claimCodexSetupOperation(operation, digest);
    if (claim.state !== 'acquired') throw new Error('fixture_claim_missing');
    vault.close(); vault = await LocalVault.open({root: f.root, masterKey: f.key});
    assert.deepEqual(vault.claimCodexSetupOperation(operation, digest), {state: 'running', intentDigest: digest});
    vault.finishCodexSetupOperation(claim.leaseId, digest, {state: 'completed', readinessReceiptId: receipt});
    vault.close(); vault = await LocalVault.open({root: f.root, masterKey: f.key});
    assert.equal(vault.claimCodexSetupOperation(operation, digest).state, 'terminal');
  } finally {await capture; vault.close(); await f.cleanup();}
});

test('journal denies finish inside a public capture transaction without losing its original fence', async () => {
  const f = await fixture(); let vault = f.vault; let capture: Promise<void> | undefined;
  try {
    const claim = vault.claimCodexSetupOperation(operation, digest);
    if (claim.state !== 'acquired') throw new Error('fixture_claim_missing');
    capture = rejectedCapture(vault);
    assert.throws(() => vault.finishCodexSetupOperation(claim.leaseId, digest,
      {state: 'completed', readinessReceiptId: receipt}), /^Error: setup_operation_transaction_active$/);
    await capture;
    vault.close(); vault = await LocalVault.open({root: f.root, masterKey: f.key});
    assert.deepEqual(vault.claimCodexSetupOperation(operation, digest), {state: 'running', intentDigest: digest});
    const result = {state: 'completed' as const, readinessReceiptId: receipt};
    vault.finishCodexSetupOperation(claim.leaseId, digest, result);
    vault.close(); vault = await LocalVault.open({root: f.root, masterKey: f.key});
    assert.deepEqual(vault.claimCodexSetupOperation(operation, digest), {state: 'terminal', intentDigest: digest, result});
  } finally {await capture; vault.close(); await f.cleanup();}
});
