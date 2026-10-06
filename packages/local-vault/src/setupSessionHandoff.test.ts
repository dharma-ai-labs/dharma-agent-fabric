import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {mkdtemp, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';
import test from 'node:test';
import {DatabaseSync} from 'node:sqlite';
import {canonicalize, sha256, validateContract} from '@dharma-ai-labs/agent-fabric-contracts';
import {LocalVault, parseLocalCodexSetupSessionRequest, parseLocalCodexSetupSessionResult,
  type LocalCodexSetupSessionRequest, type LocalCodexSetupSessionResult} from './index.js';

const id = (n: number) => `${String(n).padStart(8, '0')}-1111-4111-8111-111111111111`;
const digest = `sha256:${'a'.repeat(64)}`;
const outcome: LocalCodexSetupSessionResult = {state: 'started', bindingId: id(9), sessionId: 'synthetic_session',
  sessionPid: 103, supervisorPid: 101, sessionStartTicks: '30', supervisorStartTicks: '10'};
async function fixture(run: (input: {root: string; key: Buffer; vault: LocalVault; request: LocalCodexSetupSessionRequest;
  leaseId: string}) => Promise<void>) {
  const root = await mkdtemp(resolve(tmpdir(), 'dharma-session-handoff-'));
  const key = randomBytes(32), vault = await LocalVault.open({root, masterKey: key}), now = Date.now();
  const claim = vault.claimCodexSetupOperation(id(1), digest);
  assert.equal(claim.state, 'acquired'); if (claim.state !== 'acquired') throw new Error('fixture_claim_missing');
  const request: LocalCodexSetupSessionRequest = {schema: 'dharma.local-codex-setup-session/v1', operationId: id(1),
    intentDigest: digest, organizationId: 'org_demo', membershipId: id(2), deviceId: id(3), workspaceId: id(4),
    repositoryBindingId: id(5), endpointId: id(6), provider: 'codex', origin: 'https://hq.example',
    repositoryFingerprint: digest, policyRevision: 'policy-v1', policyHash: digest, scopeDigest: digest,
    contractDigest: digest, name: 'implementer', workspaceRoot: resolve(root, 'source'),
    maximumCostCents: 1000, maximumTurnCostCents: 25,
    issuedAt: new Date(now - 1000).toISOString(), expiresAt: new Date(now + 60000).toISOString()};
  try {await run({root, key, vault, request, leaseId: claim.leaseId});}
  finally {vault.close(); await rm(root, {recursive: true, force: true});}
}

test('setup can durably request a standing session without creating a provider binding', async () => {
  await fixture(async f => {
    const stage = (f.vault as unknown as {stageCodexSetupSession?: unknown}).stageCodexSetupSession;
    assert.equal(typeof stage, 'function', 'actual encrypted standing-session handoff is absent');
    const submission = f.vault.stageCodexSetupSession(f.leaseId, digest, f.request);
    assert.equal(Object.isFrozen(submission), true); assert.deepEqual(Object.keys(submission), ['withdraw']);
    assert.deepEqual(f.vault.listPendingCodexSetupSessions(), [{operationId: id(1), intentDigest: digest}]);
    assert.deepEqual(f.vault.readCodexSetupSession(id(1), digest), {state: 'pending', request: f.request, result: null});
    const database = new DatabaseSync(resolve(f.root, 'vault.sqlite'));
    try {assert.equal(database.prepare('select count(*) as n from provider_session_bindings').get()!.n, 0);}
    finally {database.close();}
    assert.equal((await readFile(resolve(f.root, 'vault.sqlite'))).includes(Buffer.from(f.request.workspaceRoot)), false);
  });
});

test('request schema and runtime parser agree on the current host and reject private and foreign scope', async () => {
  await fixture(async f => {
    const directory = resolve(import.meta.dirname, '../../../schemas'), schema = 'https://schemas.dharma-ai.io/local-codex-setup-session/v1';
    assert.equal((await validateContract(directory, schema, f.request)).ok, true);
    assert.deepEqual(parseLocalCodexSetupSessionRequest(f.request), f.request);
    for (const invalid of [{...f.request, token: 'private-canary'}, {...f.request, organizationId: 'org_other\n'},
      {...f.request, provider: 'claude'}, {...f.request, workspaceRoot: 'relative/source'},
      {...f.request, workspaceRoot: `${f.request.workspaceRoot}\0private`}, {...f.request, origin: 'https://hq.example/path'},
      {...f.request, maximumCostCents: 10001}]) {
      assert.equal((await validateContract(directory, schema, invalid)).ok, false);
      assert.throws(() => parseLocalCodexSetupSessionRequest(invalid), /setup_session_invalid/);
    }
    // Canonical paths, timestamp ordering and relational budgets are checked at
    // runtime in addition to the portable structural schema.
    assert.throws(() => parseLocalCodexSetupSessionRequest({...f.request, workspaceRoot: `${f.request.workspaceRoot}/../foreign`}), /setup_session_invalid/);
  });
});

test('standing acceptance and outcome are durable, bounded and immutable without another start', async () => {
  await fixture(async f => {
    const submission = f.vault.stageCodexSetupSession(f.leaseId, digest, f.request);
    const receiver = await LocalVault.open({root: f.root, masterKey: f.key});
    try {
      const acceptance = receiver.acceptCodexSetupSession(id(1), digest, sha256(canonicalize(f.request)));
      assert.ok(acceptance); assert.deepEqual(Object.keys(acceptance).sort(), ['record', 'request']);
      assert.equal(receiver.acceptCodexSetupSession(id(1), digest, sha256(canonicalize(f.request))), null);
      submission.withdraw(); assert.equal(receiver.readCodexSetupSession(id(1), digest)?.state, 'accepted');
      acceptance.record(outcome); acceptance.record(outcome);
      assert.throws(() => acceptance.record({...outcome, sessionPid: 104}), /setup_operation_conflict/);
      assert.throws(() => acceptance.record({...outcome, token: 'private-canary'} as never), /setup_session_invalid/);
      f.vault.close();
    } finally {receiver.close();}
    const recovered = await LocalVault.open({root: f.root, masterKey: f.key});
    try {
      assert.deepEqual(recovered.readCodexSetupSession(id(1), digest), {state: 'accepted', request: f.request, result: outcome});
      assert.deepEqual(recovered.listPendingCodexSetupSessions(), []);
      assert.equal(recovered.acceptCodexSetupSession(id(1), digest, sha256(canonicalize(f.request))), null);
    } finally {recovered.close();}
  });
});

test('an accepted but interrupted start is not replayed or invented as a successful outcome', async () => {
  await fixture(async f => {
    f.vault.stageCodexSetupSession(f.leaseId, digest, f.request);
    assert.ok(f.vault.acceptCodexSetupSession(id(1), digest, sha256(canonicalize(f.request))));
    f.vault.close();
    const recovered = await LocalVault.open({root: f.root, masterKey: f.key});
    try {
      assert.deepEqual(recovered.readCodexSetupSession(id(1), digest), {state: 'accepted', request: f.request, result: null});
      assert.equal(recovered.acceptCodexSetupSession(id(1), digest, sha256(canonicalize(f.request))), null);
    } finally {recovered.close();}
  });
});

test('withdrawal before acceptance preserves its operation fence and a sibling request', async () => {
  await fixture(async f => {
    const first = f.vault.stageCodexSetupSession(f.leaseId, digest, f.request);
    const claim = f.vault.claimCodexSetupOperation(id(7), digest);
    if (claim.state !== 'acquired') throw new Error('fixture_claim_missing');
    const other = {...f.request, operationId: id(7), workspaceId: id(8), name: 'reviewer'};
    f.vault.stageCodexSetupSession(claim.leaseId, digest, other);
    first.withdraw(); first.withdraw();
    assert.equal(f.vault.readCodexSetupSession(id(1), digest)?.state, 'withdrawn');
    assert.equal(f.vault.readCodexSetupSession(id(7), digest)?.state, 'pending');
    assert.equal(f.vault.acceptCodexSetupSession(id(1), digest, sha256(canonicalize(f.request))), null);
    assert.deepEqual(f.vault.readCodexSetupOperation(id(1), digest), {state: 'running', intentDigest: digest});
    f.vault.stageCodexSetupSession(f.leaseId, digest, f.request);
    assert.equal(f.vault.readCodexSetupSession(id(1), digest)?.state, 'withdrawn');
  });
});

test('changed request, foreign lease and foreign digest cannot replace admitted handoff', async () => {
  await fixture(async f => {
    f.vault.stageCodexSetupSession(f.leaseId, digest, f.request);
    assert.throws(() => f.vault.stageCodexSetupSession(f.leaseId, digest, {...f.request, membershipId: id(99)}), /setup_operation_conflict/);
    assert.throws(() => f.vault.stageCodexSetupSession(id(99), digest, f.request), /setup_operation_conflict/);
    assert.throws(() => f.vault.readCodexSetupSession(id(1), `sha256:${'b'.repeat(64)}`), /setup_operation_conflict/);
    assert.equal(f.vault.acceptCodexSetupSession(id(1), digest, `sha256:${'b'.repeat(64)}`), null);
    assert.equal(f.vault.readCodexSetupSession(id(1), digest)?.state, 'pending');
  });
});

for (const invalid of ['private-field', 'invalid-path', 'budget', 'getter', 'proxy', 'expiry'] as const) {
  test(`session handoff rejects ${invalid} before staging`, async () => {
    await fixture(async f => {
      let getters = 0;
      const value = invalid === 'private-field' ? {...f.request, token: 'private-canary'}
        : invalid === 'invalid-path' ? {...f.request, workspaceRoot: `${f.request.workspaceRoot}\0private`}
        : invalid === 'budget' ? {...f.request, maximumTurnCostCents: 1001}
        : invalid === 'getter' ? {...f.request, get name() {getters++; return f.request.name;}}
        : invalid === 'proxy' ? new Proxy(f.request, {get() {getters++; throw new Error('private-canary');}})
        : {...f.request, expiresAt: f.request.issuedAt};
      assert.throws(() => f.vault.stageCodexSetupSession(f.leaseId, digest, value as never), /setup_session_invalid/);
      assert.equal(getters, 0); assert.equal(f.vault.readCodexSetupSession(id(1), digest), null);
    });
  });
}

test('expired handoff cannot be staged or accepted and is not pending work', async t => {
  await fixture(async f => {
    f.vault.stageCodexSetupSession(f.leaseId, digest, f.request);
    t.mock.timers.enable({apis: ['Date'], now: Date.parse(f.request.expiresAt)});
    try {
      assert.equal(f.vault.acceptCodexSetupSession(id(1), digest, sha256(canonicalize(f.request))), null);
      assert.deepEqual(f.vault.listPendingCodexSetupSessions(), []);
      assert.throws(() => f.vault.stageCodexSetupSession(f.leaseId, digest, f.request), /setup_session_invalid/);
    } finally {t.mock.timers.reset();}
  });
});

test('scoped submission withdraws synchronously on abort without touching an accepted sibling', async () => {
  await fixture(async f => {
    const sibling = f.vault.claimCodexSetupOperation(id(7), digest);
    if (sibling.state !== 'acquired') throw new Error('fixture_claim_missing');
    const other = {...f.request, operationId: id(7), name: 'reviewer'};
    f.vault.stageCodexSetupSession(sibling.leaseId, digest, other);
    const accepted = f.vault.acceptCodexSetupSession(id(7), digest, sha256(canonicalize(other)));
    assert.ok(accepted); accepted.record(outcome);
    const controller = new AbortController();
    const scoped = await LocalVault.open({root: f.root, masterKey: f.key}, {signal: controller.signal, current: async () => true});
    try {
      await scoped.stageCodexSetupSession(f.leaseId, digest, f.request);
      controller.abort();
      assert.equal(f.vault.readCodexSetupSession(id(1), digest)?.state, 'withdrawn');
      assert.equal(f.vault.acceptCodexSetupSession(id(1), digest, sha256(canonicalize(f.request))), null);
      assert.deepEqual(f.vault.readCodexSetupSession(id(7), digest), {state: 'accepted', request: other, result: outcome});
    } finally {await scoped.close();}
  });
});

test('session request rejects coercible objects without invoking their private methods', () => {
  let called = 0;
  const privateValue = {toString() {called++; throw new Error('private-canary');}};
  for (const field of ['origin', 'issuedAt', 'expiresAt']) {
    assert.throws(() => parseLocalCodexSetupSessionRequest(Object.fromEntries([
      ...['schema', 'operationId', 'intentDigest', 'organizationId', 'membershipId', 'deviceId', 'workspaceId',
        'repositoryBindingId', 'endpointId', 'provider', 'origin', 'repositoryFingerprint', 'policyRevision',
        'policyHash', 'scopeDigest', 'contractDigest', 'name', 'workspaceRoot', 'maximumCostCents',
        'maximumTurnCostCents', 'issuedAt', 'expiresAt'].map(key => [key, key === field ? privateValue : null]),
    ])), /^Error: setup_session_invalid$/);
  }
  assert.equal(called, 0);
});

test('terminal original operation cannot admit a pending session request', async () => {
  await fixture(async f => {
    f.vault.stageCodexSetupSession(f.leaseId, digest, f.request);
    f.vault.finishCodexSetupOperation(f.leaseId, digest, {state: 'unconfirmed', code: 'setup_execution_unconfirmed'});
    assert.equal(f.vault.acceptCodexSetupSession(id(1), digest, sha256(canonicalize(f.request))), null);
    assert.equal(f.vault.readCodexSetupSession(id(1), digest)?.state, 'pending');
  });
});

test('accepted state cannot be downgraded to pending to obtain a second dispatch', async () => {
  await fixture(async f => {
    f.vault.stageCodexSetupSession(f.leaseId, digest, f.request);
    assert.ok(f.vault.acceptCodexSetupSession(id(1), digest, sha256(canonicalize(f.request))));
    const db = new DatabaseSync(resolve(f.root, 'vault.sqlite'));
    try {
      db.prepare("update codex_setup_sessions set state = 'pending' where operation_id = ?").run(id(1));
      assert.throws(() => f.vault.acceptCodexSetupSession(id(1), digest, sha256(canonicalize(f.request))), /setup_operation_integrity_failed/);
    } finally {
      // Restore only the exact synthetic field changed by this fixture, so
      // normal owner cleanup need not authenticate unknown tampered state.
      db.prepare("update codex_setup_sessions set state = 'accepted' where operation_id = ?").run(id(1)); db.close();
    }
  });
});

test('ciphertext transplant across original operation identities is refused', async () => {
  await fixture(async f => {
    f.vault.stageCodexSetupSession(f.leaseId, digest, f.request);
    const db = new DatabaseSync(resolve(f.root, 'vault.sqlite'));
    try {db.prepare('update codex_setup_sessions set operation_id = ? where operation_id = ?').run(id(8), id(1));}
    finally {db.close();}
    assert.throws(() => f.vault.readCodexSetupSession(id(8), digest), /setup_operation_integrity_failed/);
  });
});

for (const state of ['accepted', 'withdrawn'] as const) {
  test(`${state} disposition cannot be reset along with acceptance metadata to obtain new authority`, async () => {
    await fixture(async f => {
      const submission = f.vault.stageCodexSetupSession(f.leaseId, digest, f.request);
      if (state === 'accepted') assert.ok(f.vault.acceptCodexSetupSession(id(1), digest, sha256(canonicalize(f.request))));
      else submission.withdraw();
      const db = new DatabaseSync(resolve(f.root, 'vault.sqlite'));
      const original = db.prepare('select state, acceptance_hash from codex_setup_sessions where operation_id = ?').get(id(1))!;
      try {
        db.prepare("update codex_setup_sessions set state = 'pending', acceptance_hash = null where operation_id = ?").run(id(1));
        assert.throws(() => f.vault.acceptCodexSetupSession(id(1), digest, sha256(canonicalize(f.request))), /setup_operation_integrity_failed/);
        assert.throws(() => f.vault.readCodexSetupSession(id(1), digest), /setup_operation_integrity_failed/);
      } finally {
        db.prepare('update codex_setup_sessions set state = ?, acceptance_hash = ? where operation_id = ?')
          .run(original.state!, original.acceptance_hash!, id(1)); db.close();
      }
    });
  });
}

test('scope withdrawal during staging is cooperatively cleaned up by its original vault owner', async t => {
  await fixture(async f => {
    const controller = new AbortController();
    const scoped = await LocalVault.open({root: f.root, masterKey: f.key}, {signal: controller.signal, current: async () => true});
    const prepare = DatabaseSync.prototype.prepare;
    t.mock.method(DatabaseSync.prototype, 'prepare', function (this: DatabaseSync, sql: string) {
      const statement = prepare.call(this, sql), run = statement.run.bind(statement);
      if (sql.startsWith('insert into codex_setup_sessions')) statement.run = ((...args: any[]) => {
        const result = Reflect.apply(run, statement, args); controller.abort(); return result;
      }) as typeof statement.run;
      return statement;
    });
    try {
      await assert.rejects(scoped.stageCodexSetupSession(f.leaseId, digest, f.request), /vault_scope_unavailable/);
      assert.equal(f.vault.readCodexSetupSession(id(1), digest)?.state, 'withdrawn');
    } finally {t.mock.restoreAll(); await scoped.close();}
  });
});

test('scoped accepted recorder cannot commit an outcome after its owner withdraws', async () => {
  await fixture(async f => {
    f.vault.stageCodexSetupSession(f.leaseId, digest, f.request);
    const controller = new AbortController();
    const scoped = await LocalVault.open({root: f.root, masterKey: f.key}, {signal: controller.signal, current: async () => true});
    try {
      const acceptance = await scoped.acceptCodexSetupSession(id(1), digest, sha256(canonicalize(f.request)));
      assert.ok(acceptance); controller.abort();
      await assert.rejects(acceptance.record(outcome), /vault_scope_unavailable/);
      assert.equal(f.vault.readCodexSetupSession(id(1), digest)?.result, null);
    } finally {await scoped.close();}
  });
});

test('wrong encryption key and modified request context cannot disclose or accept handoff', async () => {
  await fixture(async f => {
    f.vault.stageCodexSetupSession(f.leaseId, digest, f.request);
    const wrong = await LocalVault.open({root: f.root, masterKey: randomBytes(32)});
    try {assert.throws(() => wrong.readCodexSetupSession(id(1), digest), /^Error: setup_operation_integrity_failed$/);}
    finally {wrong.close();}
    const db = new DatabaseSync(resolve(f.root, 'vault.sqlite'));
    try {
      db.prepare('update codex_setup_sessions set expires_at = ? where operation_id = ?').run(f.request.issuedAt, id(1));
      assert.throws(() => f.vault.readCodexSetupSession(id(1), digest), /^Error: setup_operation_integrity_failed$/);
    } finally {
      db.prepare('update codex_setup_sessions set expires_at = ? where operation_id = ?').run(f.request.expiresAt, id(1)); db.close();
    }
  });
});

test('session handoff denies ambient transactions without inventing durable acceptance', async () => {
  await fixture(async f => {
    f.vault.stageCodexSetupSession(f.leaseId, digest, f.request);
    const capture = f.vault.commitCapture({raw: {plaintext: Buffer.from('wrong hash'), kind: 'fixture', expectedContentId: digest},
      capsule: {plaintext: Buffer.from('{}'), trajectoryId: id(9), revision: 1, capsuleHash: digest},
      session: {sessionId: id(9), provider: 'codex', workspaceId: id(4), sourceLocator: '/synthetic', status: 'fixture', observedAt: new Date().toISOString()}});
    const failed = assert.rejects(capture, /Raw evidence content hash changed/);
    assert.throws(() => f.vault.acceptCodexSetupSession(id(1), digest, sha256(canonicalize(f.request))), /setup_operation_transaction_active/);
    await failed;
    assert.equal(f.vault.readCodexSetupSession(id(1), digest)?.state, 'pending');
  });
});

test('session outcome parser refuses raw diagnostics, hidden fields and invalid process attribution', () => {
  for (const value of [{...outcome, sessionPid: -1}, {...outcome, sessionStartTicks: '30\n'},
    {...outcome, error: 'private-canary'}, Object.defineProperty({...outcome}, 'private', {value: 'private-canary'}),
    {state: 'unconfirmed', code: 'private-canary'}]) assert.throws(() => parseLocalCodexSetupSessionResult(value), /setup_session_invalid/);
  assert.deepEqual(parseLocalCodexSetupSessionResult({state: 'unconfirmed', code: 'session_start_unconfirmed'}),
    {state: 'unconfirmed', code: 'session_start_unconfirmed'});
});
