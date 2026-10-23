import assert from 'node:assert/strict';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { canonicalize, signCanonicalObject, type SessionQuestion } from '@dharma-ai-labs/agent-fabric-contracts';
import { LocalVault, type LocalProviderSessionBinding } from './index.js';

const uuid = (n: number) => `60000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const { privateKey, publicKey } = generateKeyPairSync('ed25519');

async function fixture(t: { after(fn: () => Promise<void>): void }, owner: LocalProviderSessionBinding['owner'] = 'cooperative_session') {
  const root = await mkdtemp(join(tmpdir(), 'dharma-offer-checkpoint-'));
  const masterKey = randomBytes(32), now = Date.now();
  const binding: LocalProviderSessionBinding = {
    schema: 'dharma.local-provider-session-binding/v1', owner,
    organizationId: 'org_offer_test', repositoryBindingId: uuid(1), workspaceId: uuid(2),
    endpointId: uuid(3), membershipId: uuid(4), deviceId: uuid(5), bindingId: uuid(6),
    provider: 'codex', sessionId: uuid(7), workspaceRoot: resolve(root, 'repo'),
    createdAt: new Date(now - 1000).toISOString(), expiresAt: new Date(now + 3600000).toISOString(),
    maximumProviderCostCents: 25,
  };
  const identity = { organizationId: binding.organizationId, repositoryBindingId: binding.repositoryBindingId,
    workspaceId: binding.workspaceId, endpointId: binding.endpointId, membershipId: binding.membershipId,
    deviceId: binding.deviceId, provider: binding.provider };
  let vault = await LocalVault.open({ root, masterKey }); vault.saveProviderSessionBinding(binding);
  t.after(async () => {vault.close(); await rm(root, { recursive: true, force: true });});
  const unsigned = {
    schema: 'dharma.session-question/v1' as const, questionId: uuid(10), taskId: uuid(11),
    organizationId: binding.organizationId, repositoryBindingId: binding.repositoryBindingId,
    source: { workspaceId: uuid(12), endpointId: uuid(13), membershipId: uuid(14), deviceId: uuid(15) },
    target: { workspaceId: binding.workspaceId, endpointId: binding.endpointId, membershipId: binding.membershipId,
      deviceId: binding.deviceId, bindingId: binding.bindingId, provider: binding.provider },
    category: 'architecture' as const, question: 'Retain this bounded private question, not an execution permission.',
    authority: { mode: 'read_only' as const, readPaths: ['.'] as ['.'], network: 'deny' as const, maximumProviderCostCents: 25 },
    createdAt: new Date(now - 1000).toISOString(), expiresAt: new Date(now + 60000).toISOString(),
    nonce: uuid(16), signerKeyVersion: 'offer-test',
  };
  const sign = (value = unsigned): SessionQuestion => ({ ...value, signature: signCanonicalObject(value, privateKey) });
  const verifier = {version: 'offer-test', publicKeyPem: publicKey.export({type: 'spki', format: 'pem'}).toString()};
  return { root, masterKey, binding, identity, unsigned, sign, verifier, get vault() {return vault;},
    reopen: async () => {vault.close(); vault = await LocalVault.open({ root, masterKey });} };
}

test('durable signed offer survives reopen as recovery-required, never execution authority', async t => {
  const f = await fixture(t), question = f.sign();
  const hash = await f.vault.stageProviderSessionOfferCheckpoint(f.binding.bindingId, f.identity, question, f.verifier);
  assert.match(hash, /^sha256:[a-f0-9]{64}$/);
  assert.equal(await f.vault.stageProviderSessionOfferCheckpoint(f.binding.bindingId, f.identity, question, f.verifier), hash);
  await f.reopen();
  assert.deepEqual(await f.vault.readProviderSessionOfferCheckpoint(f.binding.bindingId, f.identity, question.questionId, f.verifier),
    {state: 'recovery_required', questionId: question.questionId, offerHash: hash, question});
  const digest = hash.slice('sha256:'.length);
  const files = [join(f.root, 'vault.sqlite'), join(f.root, 'blobs', digest.slice(0, 2), `${digest}.blob`)];
  for (const path of files) assert.equal((await readFile(path)).includes(Buffer.from(question.question)), false);
});

test('one unsettled question per binding; duplicate immutable offer is idempotent', async t => {
  const f = await fixture(t), first = f.sign(), second = f.sign({...f.unsigned, questionId: uuid(20)});
  const results = await Promise.allSettled([
    f.vault.stageProviderSessionOfferCheckpoint(f.binding.bindingId, f.identity, first, f.verifier),
    f.vault.stageProviderSessionOfferCheckpoint(f.binding.bindingId, f.identity, second, f.verifier),
  ]);
  assert.equal(results.filter(x => x.status === 'fulfilled').length, 1);
  assert.equal(results.filter(x => x.status === 'rejected').length, 1);
  const winner = results[0].status === 'fulfilled' ? first : second;
  const changed = f.sign({...f.unsigned, questionId: winner.questionId, question: 'Different immutable content.'});
  await assert.rejects(f.vault.stageProviderSessionOfferCheckpoint(f.binding.bindingId, f.identity, changed, f.verifier), /offer_conflict/);
});

test('settlement requires the exact acknowledged durable reply, then never rewinds a settled offer', async t => {
  const f = await fixture(t), question = f.sign();
  const hash = await f.vault.stageProviderSessionOfferCheckpoint(f.binding.bindingId, f.identity, question, f.verifier);
  const reply = await f.vault.stageProviderSessionReply(f.binding.bindingId, f.identity, question.questionId, Buffer.from('existing completion bytes'));
  assert.throws(() => f.vault.settleProviderSessionOfferCheckpoint(f.binding.bindingId, f.identity, question.questionId, hash, reply), /offer_reply_unconfirmed/);
  f.vault.acknowledgeProviderSessionReply(f.binding.bindingId, f.identity, question.questionId, reply);
  assert.throws(() => f.vault.settleProviderSessionOfferCheckpoint(f.binding.bindingId, f.identity, question.questionId, `sha256:${'0'.repeat(64)}`, reply), /offer_conflict/);
  assert.throws(() => f.vault.settleProviderSessionOfferCheckpoint(f.binding.bindingId, f.identity, question.questionId, hash, `sha256:${'0'.repeat(64)}`), /offer_reply_unconfirmed/);
  f.vault.settleProviderSessionOfferCheckpoint(f.binding.bindingId, f.identity, question.questionId, hash, reply);
  f.vault.settleProviderSessionOfferCheckpoint(f.binding.bindingId, f.identity, question.questionId, hash, reply);
  await f.reopen();
  assert.deepEqual(await f.vault.readProviderSessionOfferCheckpoint(f.binding.bindingId, f.identity, question.questionId, f.verifier),
    {state: 'settled', questionId: question.questionId, offerHash: hash, question: null});
  await assert.rejects(f.vault.stageProviderSessionOfferCheckpoint(f.binding.bindingId, f.identity, question, f.verifier), /offer_settled/);
  await f.vault.stageProviderSessionOfferCheckpoint(f.binding.bindingId, f.identity, f.sign({...f.unsigned, questionId: uuid(20)}), f.verifier);
});

test('atomic offer acknowledgment and settlement survive reopen and are idempotent', async t => {
  const f = await fixture(t), question = f.sign();
  const offerHash = await f.vault.stageProviderSessionOfferCheckpoint(f.binding.bindingId, f.identity, question, f.verifier);
  const completionHash = await f.vault.stageProviderSessionReply(f.binding.bindingId, f.identity, question.questionId,
    Buffer.from('synthetic acknowledged completion'));
  f.vault.acknowledgeProviderSessionOfferReply(f.binding.bindingId, f.identity, question.questionId, offerHash, completionHash);
  f.vault.acknowledgeProviderSessionOfferReply(f.binding.bindingId, f.identity, question.questionId, offerHash, completionHash);
  await f.reopen();
  assert.deepEqual(f.vault.listProviderSessionReplies(f.binding.bindingId, f.identity), []);
  assert.deepEqual(f.vault.listProviderSessionOfferCheckpoints(f.binding.bindingId, f.identity), []);
  assert.equal((await f.vault.readProviderSessionOfferCheckpoint(f.binding.bindingId, f.identity,
    question.questionId, f.verifier))?.state, 'settled');
});

test('an atomic settlement conflict rolls back acknowledgment and retains both pending records', async t => {
  const f = await fixture(t), question = f.sign();
  const offerHash = await f.vault.stageProviderSessionOfferCheckpoint(f.binding.bindingId, f.identity, question, f.verifier);
  const completionHash = await f.vault.stageProviderSessionReply(f.binding.bindingId, f.identity, question.questionId,
    Buffer.from('synthetic retained completion'));
  assert.throws(() => f.vault.acknowledgeProviderSessionOfferReply(f.binding.bindingId, f.identity,
    question.questionId, `sha256:${'0'.repeat(64)}`, completionHash), /offer_conflict/);
  await f.reopen();
  assert.deepEqual(f.vault.listProviderSessionReplies(f.binding.bindingId, f.identity), [{questionId: question.questionId, completionHash}]);
  assert.deepEqual(f.vault.listProviderSessionOfferCheckpoints(f.binding.bindingId, f.identity), [{questionId: question.questionId, offerHash}]);
  f.vault.acknowledgeProviderSessionOfferReply(f.binding.bindingId, f.identity, question.questionId, offerHash, completionHash);
  assert.deepEqual(f.vault.listProviderSessionOfferCheckpoints(f.binding.bindingId, f.identity), []);
});

test('atomic acknowledgment rejects foreign identity, revoked binding and absent offers without losing a reply', async t => {
  const f = await fixture(t), question = f.sign();
  const offerHash = await f.vault.stageProviderSessionOfferCheckpoint(f.binding.bindingId, f.identity, question, f.verifier);
  const completionHash = await f.vault.stageProviderSessionReply(f.binding.bindingId, f.identity, question.questionId,
    Buffer.from('synthetic scoped completion'));
  for (const field of Object.keys(f.identity)) {
    const identity = {...f.identity, [field]: field === 'provider' ? 'claude' : field === 'organizationId' ? 'org_foreign' : uuid(99)};
    assert.throws(() => f.vault.acknowledgeProviderSessionOfferReply(f.binding.bindingId, identity as typeof f.identity,
      question.questionId, offerHash, completionHash), /scope_mismatch/);
  }
  assert.throws(() => f.vault.acknowledgeProviderSessionOfferReply(f.binding.bindingId, f.identity,
    uuid(99), offerHash, completionHash), /reply_conflict/);
  assert.equal(f.vault.listProviderSessionReplies(f.binding.bindingId, f.identity).length, 1);
  f.vault.revokeProviderSessionBinding(f.binding.bindingId, f.identity);
  assert.throws(() => f.vault.acknowledgeProviderSessionOfferReply(f.binding.bindingId, f.identity,
    question.questionId, offerHash, completionHash), /binding_unavailable/);
});

test('all enrolled scope fields reject foreign access before returning encrypted content', async t => {
  const f = await fixture(t), question = f.sign();
  const hash = await f.vault.stageProviderSessionOfferCheckpoint(f.binding.bindingId, f.identity, question, f.verifier);
  for (const field of Object.keys(f.identity)) {
    const identity = {...f.identity, [field]: field === 'provider' ? 'claude' : field === 'organizationId' ? 'org_foreign' : uuid(99)};
    await assert.rejects(f.vault.readProviderSessionOfferCheckpoint(f.binding.bindingId, identity as typeof f.identity, question.questionId, f.verifier), /scope_mismatch/);
    await assert.rejects(f.vault.stageProviderSessionOfferCheckpoint(f.binding.bindingId, identity as typeof f.identity, question, f.verifier), /scope_mismatch/);
    assert.throws(() => f.vault.listProviderSessionOfferCheckpoints(f.binding.bindingId, identity as typeof f.identity), /scope_mismatch/);
    assert.throws(() => f.vault.settleProviderSessionOfferCheckpoint(f.binding.bindingId, identity as typeof f.identity, question.questionId, hash, hash), /scope_mismatch/);
  }
});

test('invalid signature, untrusted signer, foreign target, oversized input and expired offer cannot be staged', async t => {
  const f = await fixture(t);
  const cases = [
    {...f.sign(), question: 'forged'},
    f.sign({...f.unsigned, signerKeyVersion: 'unknown'}),
    f.sign({...f.unsigned, target: {...f.unsigned.target, deviceId: uuid(99)}}),
    f.sign({...f.unsigned, question: 'x'.repeat(17000)}),
    f.sign({...f.unsigned, expiresAt: new Date(Date.now() - 100).toISOString()}),
  ];
  for (const question of cases) await assert.rejects(
    f.vault.stageProviderSessionOfferCheckpoint(f.binding.bindingId, f.identity, question, f.verifier), /offer_invalid/);
  assert.equal(await f.vault.readProviderSessionOfferCheckpoint(f.binding.bindingId, f.identity, f.unsigned.questionId, f.verifier), null);
});

test('revocation blocks staging, reads and settlement without deleting evidence', async t => {
  const f = await fixture(t), question = f.sign();
  const hash = await f.vault.stageProviderSessionOfferCheckpoint(f.binding.bindingId, f.identity, question, f.verifier);
  f.vault.revokeProviderSessionBinding(f.binding.bindingId, f.identity);
  await assert.rejects(f.vault.stageProviderSessionOfferCheckpoint(f.binding.bindingId, f.identity, question, f.verifier), /binding_unavailable/);
  await assert.rejects(f.vault.readProviderSessionOfferCheckpoint(f.binding.bindingId, f.identity, question.questionId, f.verifier), /binding_unavailable/);
  assert.throws(() => f.vault.settleProviderSessionOfferCheckpoint(f.binding.bindingId, f.identity, question.questionId, hash, hash), /binding_unavailable/);
  assert.equal((await f.vault.getBlob(hash)).length > 0, true);
});

test('expired offers expose no question and remain unsettled rather than authorizing replay', async t => {
  const f = await fixture(t), question = f.sign();
  const hash = await f.vault.stageProviderSessionOfferCheckpoint(f.binding.bindingId, f.identity, question, f.verifier);
  t.mock.timers.enable({apis: ['Date'], now: Date.parse(question.expiresAt) + 1});
  assert.deepEqual(await f.vault.readProviderSessionOfferCheckpoint(f.binding.bindingId, f.identity, question.questionId, f.verifier),
    {state: 'expired', questionId: question.questionId, offerHash: hash, question: null});
  assert.deepEqual(f.vault.listProviderSessionOfferCheckpoints(f.binding.bindingId, f.identity), [{questionId: question.questionId, offerHash: hash}]);
  await assert.rejects(f.vault.stageProviderSessionOfferCheckpoint(f.binding.bindingId, f.identity, question, f.verifier), /offer_invalid/);
});

test('bridge-owned and expired bindings cannot use cooperative offer storage', async t => {
  const bridge = await fixture(t, 'dharma_bridge');
  await assert.rejects(bridge.vault.stageProviderSessionOfferCheckpoint(bridge.binding.bindingId, bridge.identity, bridge.sign(), bridge.verifier), /binding_unavailable/);
  assert.throws(() => bridge.vault.listProviderSessionOfferCheckpoints(bridge.binding.bindingId, bridge.identity), /binding_unavailable/);
  const f = await fixture(t), question = f.sign();
  const hash = await f.vault.stageProviderSessionOfferCheckpoint(f.binding.bindingId, f.identity, question, f.verifier);
  t.mock.timers.enable({apis: ['Date'], now: Date.parse(f.binding.expiresAt) + 1});
  await assert.rejects(f.vault.readProviderSessionOfferCheckpoint(f.binding.bindingId, f.identity, question.questionId, f.verifier), /binding_unavailable/);
  assert.throws(() => f.vault.settleProviderSessionOfferCheckpoint(f.binding.bindingId, f.identity, question.questionId, hash, hash), /binding_unavailable/);
});

test('caller mutation during encrypted write cannot replace the admitted snapshot or identity', async t => {
  const f = await fixture(t), question = f.sign(), original = structuredClone(question), identity = {...f.identity};
  const put = f.vault.putBlob.bind(f.vault);
  f.vault.putBlob = async (...args) => {
    question.question = 'mutated after entry'; question.target.deviceId = uuid(99); identity.organizationId = 'org_mutated';
    return put(...args);
  };
  await f.vault.stageProviderSessionOfferCheckpoint(f.binding.bindingId, identity, question, f.verifier);
  const read = await f.vault.readProviderSessionOfferCheckpoint(f.binding.bindingId, f.identity, original.questionId, f.verifier);
  assert.equal(read?.state, 'recovery_required'); assert.deepEqual(read?.question, original);
});

test('revocation after encrypted write retains evidence but does not publish a checkpoint', async t => {
  const f = await fixture(t), question = f.sign(), put = f.vault.putBlob.bind(f.vault);
  let stored = '';
  f.vault.putBlob = async (...args) => {
    stored = await put(...args); f.vault.revokeProviderSessionBinding(f.binding.bindingId, f.identity); return stored;
  };
  await assert.rejects(f.vault.stageProviderSessionOfferCheckpoint(f.binding.bindingId, f.identity, question, f.verifier), /binding_unavailable/);
  assert.equal((await f.vault.getBlob(stored)).length > 0, true);
});

test('missing signer on recovery and malformed IDs cannot release private question content', async t => {
  const f = await fixture(t), question = f.sign();
  await f.vault.stageProviderSessionOfferCheckpoint(f.binding.bindingId, f.identity, question, f.verifier);
  await assert.rejects(f.vault.readProviderSessionOfferCheckpoint(f.binding.bindingId, f.identity, question.questionId,
    {...f.verifier, version: 'revoked-version'}), /offer_integrity_failed/);
  for (const id of ['invalid', `${question.questionId}\n`, '']) {
    await assert.rejects(f.vault.readProviderSessionOfferCheckpoint(f.binding.bindingId, f.identity, id, f.verifier), /offer_invalid/);
    assert.throws(() => f.vault.settleProviderSessionOfferCheckpoint(f.binding.bindingId, f.identity, id,
      `sha256:${'a'.repeat(64)}`, `sha256:${'b'.repeat(64)}`), /offer_invalid/);
  }
});

test('separate vault handles atomically retain only one unsettled offer', async t => {
  const f = await fixture(t), second = await LocalVault.open({root: f.root, masterKey: f.masterKey});
  try {
    const results = await Promise.allSettled([
      f.vault.stageProviderSessionOfferCheckpoint(f.binding.bindingId, f.identity, f.sign(), f.verifier),
      second.stageProviderSessionOfferCheckpoint(f.binding.bindingId, f.identity, f.sign({...f.unsigned, questionId: uuid(20)}), f.verifier),
    ]);
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
    assert.equal(f.vault.listProviderSessionOfferCheckpoints(f.binding.bindingId, f.identity).length, 1);
    assert.deepEqual(second.listProviderSessionOfferCheckpoints(f.binding.bindingId, f.identity),
      f.vault.listProviderSessionOfferCheckpoints(f.binding.bindingId, f.identity));
  } finally { second.close(); }
});

test('scoped vault withdrawal fences all new checkpoint methods', async t => {
  const f = await fixture(t), controller = new AbortController(); let active = true;
  f.vault.close();
  const scoped = await LocalVault.open({root: f.root, masterKey: f.masterKey},
    {signal: controller.signal, current: async () => active});
  try {
    const question = f.sign();
    const hash = await scoped.stageProviderSessionOfferCheckpoint(f.binding.bindingId, f.identity, question, f.verifier);
    assert.equal((await scoped.listProviderSessionOfferCheckpoints(f.binding.bindingId, f.identity)).length, 1);
    active = false; controller.abort();
    await assert.rejects(scoped.stageProviderSessionOfferCheckpoint(f.binding.bindingId, f.identity, question, f.verifier), /scope/);
    await assert.rejects(scoped.readProviderSessionOfferCheckpoint(f.binding.bindingId, f.identity, question.questionId, f.verifier), /scope/);
    await assert.rejects(scoped.listProviderSessionOfferCheckpoints(f.binding.bindingId, f.identity), /scope/);
    await assert.rejects(scoped.settleProviderSessionOfferCheckpoint(f.binding.bindingId, f.identity, question.questionId, hash, hash), /scope/);
    await assert.rejects(scoped.acknowledgeProviderSessionOfferReply(f.binding.bindingId, f.identity, question.questionId, hash, hash), /scope/);
  } finally { await scoped.close(); }
});

test('verification-key input is captured before asynchronous writes and rejects private key material', async t => {
  const f = await fixture(t), put = f.vault.putBlob.bind(f.vault), key = {...f.verifier}, question = f.sign();
  f.vault.putBlob = async (...args) => {key.version = 'mutated'; key.publicKeyPem = 'invalid'; return put(...args);};
  await f.vault.stageProviderSessionOfferCheckpoint(f.binding.bindingId, f.identity, question, key);
  assert.equal((await f.vault.readProviderSessionOfferCheckpoint(f.binding.bindingId, f.identity, question.questionId, f.verifier))?.state, 'recovery_required');
  await assert.rejects(f.vault.readProviderSessionOfferCheckpoint(f.binding.bindingId, f.identity, question.questionId,
    {version: 'offer-test', publicKeyPem: privateKey.export({type: 'pkcs8', format: 'pem'}).toString()}),
  {message: 'provider_session_offer_invalid'});
});

test('expiry after encrypted staging retains evidence without publishing the checkpoint', async t => {
  const f = await fixture(t), question = f.sign(), put = f.vault.putBlob.bind(f.vault); let stored = '';
  f.vault.putBlob = async (...args) => {
    stored = await put(...args);
    t.mock.timers.enable({apis: ['Date'], now: Date.parse(question.expiresAt) + 1}); return stored;
  };
  await assert.rejects(f.vault.stageProviderSessionOfferCheckpoint(f.binding.bindingId, f.identity, question, f.verifier), /offer_invalid/);
  assert.deepEqual(f.vault.listProviderSessionOfferCheckpoints(f.binding.bindingId, f.identity), []);
  assert.equal((await f.vault.getBlob(stored)).length > 0, true);
});

test('revocation during decrypted read suppresses the question', async t => {
  const f = await fixture(t), question = f.sign();
  await f.vault.stageProviderSessionOfferCheckpoint(f.binding.bindingId, f.identity, question, f.verifier);
  const get = f.vault.getBlob.bind(f.vault);
  f.vault.getBlob = async (...args) => {
    const bytes = await get(...args); f.vault.revokeProviderSessionBinding(f.binding.bindingId, f.identity); return bytes;
  };
  await assert.rejects(f.vault.readProviderSessionOfferCheckpoint(f.binding.bindingId, f.identity, question.questionId, f.verifier), /binding_unavailable/);
});

test('concurrent settlement during read returns terminal metadata instead of stale question context', async t => {
  const f = await fixture(t), question = f.sign();
  const hash = await f.vault.stageProviderSessionOfferCheckpoint(f.binding.bindingId, f.identity, question, f.verifier);
  const reply = await f.vault.stageProviderSessionReply(f.binding.bindingId, f.identity, question.questionId, Buffer.from('retained completion'));
  f.vault.acknowledgeProviderSessionReply(f.binding.bindingId, f.identity, question.questionId, reply);
  const get = f.vault.getBlob.bind(f.vault);
  f.vault.getBlob = async (...args) => {
    const bytes = await get(...args);
    f.vault.settleProviderSessionOfferCheckpoint(f.binding.bindingId, f.identity, question.questionId, hash, reply); return bytes;
  };
  assert.deepEqual(await f.vault.readProviderSessionOfferCheckpoint(f.binding.bindingId, f.identity, question.questionId, f.verifier),
    {state: 'settled', questionId: question.questionId, offerHash: hash, question: null});
});

test('public verification keys accept canonical LF and Windows CRLF without accepting another key block', async t => {
  const f = await fixture(t), question = f.sign(), windowsKey = {...f.verifier,
    publicKeyPem: f.verifier.publicKeyPem.replaceAll('\n', '\r\n')};
  await f.vault.stageProviderSessionOfferCheckpoint(f.binding.bindingId, f.identity, question, windowsKey);
  assert.equal((await f.vault.readProviderSessionOfferCheckpoint(f.binding.bindingId, f.identity, question.questionId, windowsKey))?.state, 'recovery_required');
  await assert.rejects(f.vault.readProviderSessionOfferCheckpoint(f.binding.bindingId, f.identity, question.questionId,
    {...f.verifier, publicKeyPem: f.verifier.publicKeyPem + privateKey.export({type: 'pkcs8', format: 'pem'}).toString()}), /offer_invalid/);
});

for (const kind of ['raw-provider-turn', 'raw-provider-session']) {
  for (const settled of [false, true]) test(`raw-first ${kind} offer survives retention/reopen when ${settled ? 'settled' : 'unsettled'}`, async t => {
    const f = await fixture(t), question = f.sign(), raw = Buffer.from(canonicalize(question));
    const existing = await f.vault.putBlob(raw, kind);
    const hash = await f.vault.stageProviderSessionOfferCheckpoint(f.binding.bindingId, f.identity, question, f.verifier);
    assert.equal(hash, existing);
    const disposable = await f.vault.putBlob(Buffer.from(`unreferenced raw evidence ${kind} ${settled}`), kind);
    if (settled) {
      const completionBytes = Buffer.from('existing acknowledged completion');
      await f.vault.putBlob(completionBytes, kind);
      const completion = await f.vault.stageProviderSessionReply(f.binding.bindingId, f.identity, question.questionId, completionBytes);
      f.vault.acknowledgeProviderSessionReply(f.binding.bindingId, f.identity, question.questionId, completion);
      f.vault.settleProviderSessionOfferCheckpoint(f.binding.bindingId, f.identity, question.questionId, hash, completion);
    }
    const expiredNow = new Date(Date.now() + 31 * 86400000);
    assert.equal((await f.vault.enforceRawEvidenceRetention({retentionDays: 30, now: expiredNow})).deleted, 1);
    await assert.rejects(f.vault.getBlob(disposable));
    t.mock.timers.enable({apis: ['Date'], now: expiredNow.getTime()});
    await f.reopen();
    assert.deepEqual(await f.vault.getBlob(hash), raw);
  });
}
