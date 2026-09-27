import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, createPublicKey, generateKeyPairSync, verify } from 'node:crypto';
import { mkdtemp, readFile, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test from 'node:test';
import { canonicalize, signCanonicalObject, verifyCanonicalObject } from '@dharma-ai-labs/agent-fabric-contracts';
import type { SecureSecretStore } from '@dharma-ai-labs/agent-fabric-relay-client';
import { connectDemoDevice, scopePath } from './demoEnrollment.js';
import { prepareDemoSigningUpgradeProof, readDemoSigningUpgradeContext } from './demoSigningUpgradeProof.js';
import { submitDemoSigningUpgradeProof } from './demoSigningUpgradeSubmission.js';
import { run } from './index.js';

const now = new Date('2026-09-27T10:00:00Z');
const repositoryId = '10000000-0000-4000-8000-000000000001';
const deviceId = '30000000-0000-4000-8000-000000000001';
const otherClient = '30000000-0000-4000-8000-000000000002';
const predecessorHash = `sha256:${'a'.repeat(64)}`;
const candidateHash = `sha256:${'b'.repeat(64)}`;
const cliVersion: string = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')).version;
const contractVersion: string = JSON.parse(await readFile(new URL('../package.json',
  import.meta.resolve('@dharma-ai-labs/agent-fabric-contracts')), 'utf8')).version;
const [major, minor, patch] = cliVersion.split('.').map(Number);
const uninstalledCliVersion = `${major}.${minor}.${patch! + 1}`;
function historicalHash(value: unknown): string {
  const ordered = (item: unknown): unknown => Array.isArray(item) ? item.map(ordered)
    : item && typeof item === 'object' ? Object.fromEntries(Object.entries(item)
      .sort(([a], [b]) => a.localeCompare(b)).map(([key, val]) => [key, ordered(val)])) : item;
  return `sha256:${createHash('sha256').update(JSON.stringify(ordered(value))).digest('hex')}`;
}
async function fixture(t: test.TestContext, preloaded = true) {
  t.mock.timers.enable({ apis: ['Date'], now });
  const signer = generateKeyPairSync('ed25519'), next = generateKeyPairSync('ed25519');
  const keyVersion = 'projects/test/locations/global/keyRings/demo/cryptoKeys/signing/cryptoKeyVersions/1';
  const successor = keyVersion.slice(0, -1) + '2';
  const publicKey = signer.publicKey.export({ format: 'jwk' }).x!;
  const body = { schema: 'dharma.server-signing-keyset/v1' as const, organizationId: 'org_fixture',
    generation: preloaded ? 2 : 1, keys: [
      { keyVersion, publicKeyEd25519: publicKey, status: 'active' as const,
        notBefore: '2026-09-27T08:00:00Z', notAfter: '2026-09-28T08:00:00Z' },
      { keyVersion: successor, publicKeyEd25519: next.publicKey.export({ format: 'jwk' }).x!, status: 'overlap' as const,
        notBefore: '2026-09-27T09:00:00Z', notAfter: '2026-10-20T08:00:00Z' },
    ], signedByKeyVersion: keyVersion, issuedAt: '2026-09-27T09:00:00Z', expiresAt: '2026-09-28T08:00:00Z' };
  if (!preloaded) body.keys = body.keys.slice(0, 1);
  const keyset = { ...body, signature: signCanonicalObject(body, signer.privateKey) };
  const values = new Map<string, string>();
  const store: SecureSecretStore = { backend: 'linux-secret-service',
    async get(account) { return values.get(account) ?? null; },
    async put(account, value) { values.set(account, value); },
    async delete(account) { values.delete(account); } };
  const stateRoot = await mkdtemp(resolve(tmpdir(), 'demo-upgrade-proof-'));
  const scope = { hqUrl: 'https://dharma.example', organizationId: 'org_fixture', repositoryId,
    normalizedRepository: 'github.com/example/private', installationId: '40000000-0000-4000-8000-000000000001', stateRoot };
  await connectDemoDevice({ ...scope, grant: 'A'.repeat(43), deviceName: 'Fixture device', platform: 'linux', maximumWaitMs: 1000 }, {
    store, sleep: async () => {}, fetcher: async resource => {
      const url = new URL(String(resource));
      return new Response(JSON.stringify(url.pathname.endsWith('/enrollments')
        ? { ok: true, status: 'pending', organizationId: scope.organizationId, repositoryId,
          deviceCode: 'B'.repeat(43), expiresAt: '2026-09-27T10:01:00Z',
          verificationUri: `${scope.hqUrl}/demo/fabric/approve?orgId=org_fixture&repositoryId=${repositoryId}&code=ABCDEF0123456789ABCD` }
        : url.pathname.endsWith('/poll') ? { ok: true, status: 'approved', deviceId, repositoryId,
          serverPublicKeyEd25519: publicKey, serverSigningKeyset: keyset }
        : { ok: true, organizationId: scope.organizationId, repositoryId, deviceId,
          normalizedRepository: scope.normalizedRepository, acceptedSequence: 1 }));
    },
  });
  const context = { schema: 'dharma.signing-upgrade-context/v1', organizationId: scope.organizationId, repositoryId,
    globalEpoch: 'fixture-epoch', predecessorHash, candidateHash, installedKeysetHash: historicalHash(keyset),
    baselineConsumers: [{ name: 'cli', version: '0.2.107' }, { name: 'contracts', version: '0.1.10' }],
    requiredConsumers: [{ name: 'cli', version: cliVersion }, { name: 'contracts', version: contractVersion }],
    requiredClientIds: [deviceId, otherClient], expiresAt: '2026-09-27T10:10:00Z' };
  const configPath = scopePath(scope, scope.hqUrl);
  const config = JSON.parse(await readFile(configPath, 'utf8'));
  return { scope, store, values, context, config, configPath, keyset };
}

test('prepares an original-client proof using the actual device and installed package versions without submission', async t => {
  const f = await fixture(t), before = JSON.stringify([...f.values]), disk = await readFile(f.configPath, 'utf8');
  const result = await prepareDemoSigningUpgradeProof(f.scope, f.context, 'client', { store: f.store, now });
  assert.equal(result.stage, 'proof_prepared');
  assert.equal(result.submitted, false);
  assert.ok(result.proof.schema === 'dharma.signing-client-upgrade-proof/v1');
  assert.equal(result.proof.principalId, deviceId);
  assert.equal(result.proof.cliVersion, cliVersion);
  assert.equal(result.proof.contractVersion, contractVersion);
  const { sourceHash, ...signed } = result.proof, { signature, ...unsigned } = signed;
  assert.equal(sourceHash, `sha256:${createHash('sha256').update(canonicalize(signed)).digest('hex')}`);
  assert.equal(verifyCanonicalObject(unsigned, signature, createPublicKey({
    key: { kty: 'OKP', crv: 'Ed25519', x: f.config.publicKeyEd25519 }, format: 'jwk' })), true);
  assert.equal(JSON.stringify([...f.values]), before);
  assert.equal(await readFile(f.configPath, 'utf8'), disk);
  assert.doesNotMatch(JSON.stringify(result), /privateJwk|privateKey|grant|authorization|accessToken/);
});

test('owner proof preparation remains unapproved and binds exact inventories for separate browser confirmation', async t => {
  const f = await fixture(t);
  const result = await prepareDemoSigningUpgradeProof(f.scope, f.context, 'owner', { store: f.store, now });
  assert.equal(result.proof.principalId, `owner:${deviceId}`);
  assert.ok(result.proof.schema === 'dharma.signing-consumer-approval/v1');
  assert.deepEqual(result.proof.requiredClientIds, f.context.requiredClientIds);
  assert.deepEqual(result.proof.baselineConsumers, f.context.baselineConsumers);
  assert.deepEqual(result.proof.requiredConsumers, f.context.requiredConsumers);
  assert.equal(result.submitted, false);
  assert.equal(result.browserApprovalRequired, true);
  assert.equal('confirmed' in result, false);
});

const faults: Array<[string, (value: Record<string, unknown>) => void]> = [
  ['foreign organization', v => { v.organizationId = 'org_other'; }],
  ['foreign repository', v => { v.repositoryId = '10000000-0000-4000-8000-000000000009'; }],
  ['unknown credential', v => { v.grant = 'A'.repeat(43); }],
  ['false installed versions', v => { v.cliVersion = '9.9.9'; }],
  ['missing original device', v => { v.requiredClientIds = [otherClient]; }],
  ['duplicate clients', v => { v.requiredClientIds = [deviceId, deviceId]; }],
  ['duplicate consumers', v => { v.requiredConsumers = [{ name: 'cli', version: cliVersion }, { name: 'cli', version: cliVersion }]; }],
  ['omitted consumer', v => { v.requiredConsumers = [{ name: 'cli', version: cliVersion }]; }],
  ['downgrade', v => { v.requiredConsumers = [{ name: 'cli', version: '0.2.106' }, { name: 'contracts', version: contractVersion }]; }],
  ['uninstalled required version', v => { v.requiredConsumers = [{ name: 'cli', version: uninstalledCliVersion }, { name: 'contracts', version: contractVersion }]; }],
  ['wrong preload hash', v => { v.installedKeysetHash = candidateHash; }],
  ['same candidate', v => { v.candidateHash = predecessorHash; }],
  ['expired', v => { v.expiresAt = now.toISOString(); }],
  ['unbounded proof', v => { v.expiresAt = '2026-09-28T10:00:00Z'; }],
  ['invalid timestamp', v => { v.expiresAt = 'later'; }],
];
for (const [label, mutate] of faults) test(`rejects ${label} without changing protected trust or device state`, async t => {
  const f = await fixture(t), before = JSON.stringify([...f.values]), disk = await readFile(f.configPath, 'utf8');
  const context = structuredClone(f.context); mutate(context);
  await assert.rejects(prepareDemoSigningUpgradeProof(f.scope, context, 'client', { store: f.store, now }), /Signing upgrade|Demo signing/);
  assert.equal(JSON.stringify([...f.values]), before);
  assert.equal(await readFile(f.configPath, 'utf8'), disk);
});

test('rejects invalid clock and mode', async t => {
  const f = await fixture(t);
  await assert.rejects(prepareDemoSigningUpgradeProof(f.scope, f.context, 'client', { store: f.store, now: new Date(NaN) }), /Signing upgrade/);
  await assert.rejects(prepareDemoSigningUpgradeProof(f.scope, f.context, 'admin' as 'client', { store: f.store, now }), /Signing upgrade/);
});

test('rejects a tampered device public key without creating a replacement identity', async t => {
  const f = await fixture(t), before = JSON.stringify([...f.values]);
  await writeFile(f.configPath, JSON.stringify({ ...f.config, publicKeyEd25519: 'A'.repeat(43) }));
  await assert.rejects(prepareDemoSigningUpgradeProof(f.scope, f.context, 'client', { store: f.store, now }), /protected device identity/);
  assert.equal(JSON.stringify([...f.values]), before);
});

test('expired protected trust requires browser re-enrollment, not a new upgrade proof', async t => {
  const f = await fixture(t), before = JSON.stringify([...f.values]);
  t.mock.timers.setTime(new Date('2026-09-28T09:00:00Z').getTime());
  const context = { ...f.context, expiresAt: '2026-09-28T09:10:00Z' };
  await assert.rejects(prepareDemoSigningUpgradeProof(f.scope, context, 'client', {
    store: f.store, now: new Date('2026-09-28T09:00:00Z') }), /browser|Signing upgrade|Demo signing/i);
  assert.equal(JSON.stringify([...f.values]), before);
});

test('caller context mutation while reading the secure store cannot change the signed candidate', async t => {
  const f = await fixture(t), context = structuredClone(f.context);
  const store: SecureSecretStore = { ...f.store, get: async account => {
    context.candidateHash = `sha256:${'c'.repeat(64)}`;
    return f.store.get(account);
  } };
  const result = await prepareDemoSigningUpgradeProof(f.scope, context, 'client', { store, now });
  assert.equal(result.proof.candidateHash, candidateHash);
});

test('bootstrap-only enrollment is not an installed preload proof', async t => {
  const f = await fixture(t, false);
  await assert.rejects(prepareDemoSigningUpgradeProof(f.scope, f.context, 'client', { store: f.store, now }), /original_preloaded_client_required/);
});

test('missing enrollment cannot create a replacement enrolled device', async t => {
  const f = await fixture(t), before = JSON.stringify([...f.values]);
  await unlink(f.configPath);
  await assert.rejects(prepareDemoSigningUpgradeProof(f.scope, f.context, 'client', { store: f.store, now }));
  assert.equal(JSON.stringify([...f.values]), before);
});

test('a missing OS device key cannot be replaced while preparing a proof', async t => {
  const f = await fixture(t);
  const keyAccount = [...f.values].find(([, value]) => {
    try { return typeof JSON.parse(value).d === 'string'; } catch { return false; }
  })?.[0];
  assert.ok(keyAccount);
  f.values.delete(keyAccount);
  const before = JSON.stringify([...f.values]), disk = await readFile(f.configPath, 'utf8');
  await assert.rejects(prepareDemoSigningUpgradeProof(f.scope, f.context, 'client', { store: f.store, now }), /existing_protected_state_required/);
  assert.equal(JSON.stringify([...f.values]), before);
  assert.equal(await readFile(f.configPath, 'utf8'), disk);
});

test('a missing protected signing anchor is not recreated from the device file', async t => {
  const f = await fixture(t), account = [...f.values.keys()].find(key => /^demo-signing-[0-9a-f]{32}$/.test(key));
  assert.ok(account);
  f.values.delete(account);
  const before = JSON.stringify([...f.values]), disk = await readFile(f.configPath, 'utf8');
  await assert.rejects(prepareDemoSigningUpgradeProof(f.scope, f.context, 'client', { store: f.store, now }), /existing_protected_state_required/);
  assert.equal(JSON.stringify([...f.values]), before);
  assert.equal(await readFile(f.configPath, 'utf8'), disk);
});

test('the second identity read cannot create a key after concurrent removal', async t => {
  const f = await fixture(t), account = [...f.values].find(([, value]) => {
    try { return typeof JSON.parse(value).d === 'string'; } catch { return false; }
  })?.[0];
  assert.ok(account);
  let reads = 0;
  const store: SecureSecretStore = { ...f.store, get: async key => {
    if (key === account && ++reads >= 2) return null;
    return f.store.get(key);
  } };
  const before = JSON.stringify([...f.values]), disk = await readFile(f.configPath, 'utf8');
  await assert.rejects(prepareDemoSigningUpgradeProof(f.scope, f.context, 'client', { store, now }), /existing_protected_state_required/);
  assert.equal(reads, 2);
  assert.equal(JSON.stringify([...f.values]), before);
  assert.equal(await readFile(f.configPath, 'utf8'), disk);
});

for (const kind of ['identity', 'anchor']) test(`fresh OS reads reject a removed ${kind} hidden by a process cache`, async t => {
  const f = await fixture(t), cached = new Map(f.values);
  const account = kind === 'anchor' ? [...f.values.keys()].find(key => /^demo-signing-[0-9a-f]{32}$/.test(key))
    : [...f.values].find(([, value]) => { try { return typeof JSON.parse(value).d === 'string'; } catch { return false; } })?.[0];
  assert.ok(account);
  f.values.delete(account);
  let freshReads = 0, cachedReads = 0;
  const store: SecureSecretStore = { ...f.store,
    get: async key => { cachedReads++; return cached.get(key) ?? null; },
    getFresh: async key => { freshReads++; return f.values.get(key) ?? null; } };
  const before = JSON.stringify([...f.values]), disk = await readFile(f.configPath, 'utf8');
  await assert.rejects(prepareDemoSigningUpgradeProof(f.scope, f.context, 'client', { store, now }), /existing_protected_state_required/);
  assert.ok(freshReads > 0);
  assert.equal(cachedReads, 0);
  assert.equal(JSON.stringify([...f.values]), before);
  assert.equal(await readFile(f.configPath, 'utf8'), disk);
});

test('a cached identity removed before its second fresh read cannot sign', async t => {
  const f = await fixture(t), account = [...f.values].find(([, value]) => {
    try { return typeof JSON.parse(value).d === 'string'; } catch { return false; }
  })?.[0];
  assert.ok(account);
  let reads = 0;
  const store: SecureSecretStore = { ...f.store, getFresh: async key => {
    if (key === account && ++reads >= 2) return null;
    return f.values.get(key) ?? null;
  } };
  const before = JSON.stringify([...f.values]);
  await assert.rejects(prepareDemoSigningUpgradeProof(f.scope, f.context, 'client', { store, now }), /existing_protected_state_required/);
  assert.equal(reads, 2);
  assert.equal(JSON.stringify([...f.values]), before);
});

test('the protected anchor removed after initial verification is checked again before signing', async t => {
  const f = await fixture(t), cached = new Map(f.values);
  const anchor = [...f.values.keys()].find(key => /^demo-signing-[0-9a-f]{32}$/.test(key));
  const identity = [...f.values].find(([, value]) => {
    try { return typeof JSON.parse(value).d === 'string'; } catch { return false; }
  })?.[0];
  assert.ok(anchor && identity);
  let reads = 0, writes = 0;
  const store: SecureSecretStore = { ...f.store, get: async key => cached.get(key) ?? null,
    getFresh: async key => {
      if (key === identity && ++reads === 2) f.values.delete(anchor);
      return f.values.get(key) ?? null;
    }, put: async () => { writes++; }, delete: async () => { writes++; } };
  await assert.rejects(prepareDemoSigningUpgradeProof(f.scope, f.context, 'client', { store, now }), /existing_protected_state_required/);
  assert.equal(reads, 3);
  assert.equal(writes, 0);
  assert.equal(f.values.has(anchor), false);
});

test('context expiring during secure-store reads cannot produce a signed proof', async t => {
  const f = await fixture(t);
  const store: SecureSecretStore = { ...f.store, get: async account => {
    t.mock.timers.setTime(now.getTime() + 11 * 60_000);
    return f.store.get(account);
  } };
  await assert.rejects(prepareDemoSigningUpgradeProof(f.scope, f.context, 'client', { store }), /context_expired_during_preparation/);
});

test('context reader accepts JSON and rejects empty, HTML and oversized files without exposing their contents', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'demo-upgrade-context-')), path = resolve(root, 'review.json');
  await writeFile(path, '{"fixture":true}');
  assert.deepEqual(await readDemoSigningUpgradeContext(path), { fixture: true });
  for (const content of ['', '<html>private-test-value</html>', ' '.repeat(32769)]) {
    await writeFile(path, content);
    await assert.rejects(readDemoSigningUpgradeContext(path), error => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /context_(size|json)_invalid/);
      assert.doesNotMatch(error.message, /private-test-value/);
      return true;
    });
  }
});

test('both actual CLI commands expose a grant-free dry-run and enforce the current Git remote', async () => {
  const workspace = await mkdtemp(resolve(tmpdir(), 'demo-signing-command-'));
  execFileSync('git', ['init', workspace], { stdio: 'ignore' });
  execFileSync('git', ['-C', workspace, 'remote', 'add', 'origin', 'https://github.com/example/private.git']);
  const flags = ['--organization-id', 'org_fixture', '--repository-id', repositoryId,
    '--normalized-repository', 'github.com/example/private', '--workspace', workspace, '--dry-run'];
  for (const command of ['signing-client-proof', 'signing-owner-proof']) {
    const result = await run(['demo', command, ...flags]);
    assert.deepEqual(result, { ok: true, stage: 'demo_signing_proof_plan', organizationId: 'org_fixture',
      repositoryId, normalizedRepository: 'github.com/example/private', workspaceVerified: true, repositoryPackageState: 'not_connected' });
    assert.doesNotMatch(JSON.stringify(result), /signature|grant|privateKey|confirmed/);
    await assert.rejects(run(['demo', command, ...flags, '--normalized-repository', 'github.com/example/other']), /does not match/);
  }
  assert.equal((await run(['demo', 'signing-client-proof', ...flags, '--submit']) as { stage: string }).stage, 'demo_signing_proof_plan');
  await assert.rejects(run(['demo', 'signing-owner-proof', ...flags, '--submit']), /browser/i);
});

function submissionServer(f: Awaited<ReturnType<typeof fixture>>, options: {
  loseResponse?: boolean; loseStatus?: boolean; receipt?: (value: Record<string, unknown>) => Response;
  afterStatus?: () => void;
} = {}) {
  let sequence = f.config.nextSequence, posts = 0, lostStatus = false;
  const proofs: unknown[] = [], stored = new Set<string>(), calls: string[] = [];
  const fetcher: typeof fetch = async (resource, init) => {
    const url = new URL(String(resource)), headers = new Headers(init?.headers);
    calls.push(url.pathname);
    assert.equal(url.origin, f.scope.hqUrl);
    assert.equal(url.searchParams.get('orgId'), f.scope.organizationId);
    assert.equal(init?.redirect, 'error');
    assert.equal((init as { cache?: string })?.cache, 'no-store');
    assert.ok(init?.signal);
    assert.equal(headers.has('authorization'), false);
    assert.equal(headers.has('cookie'), false);
    const raw = String(init?.body || '');
    const payload = { bodyHash: `sha256:${createHash('sha256').update(raw).digest('hex')}`,
      deviceId, messageId: headers.get('x-dharma-message-id'), method: init?.method,
      nonce: headers.get('x-dharma-nonce'), organizationId: f.scope.organizationId,
      pathname: `${url.pathname}${url.search}`, sequence: Number(headers.get('x-dharma-sequence')),
      sessionId: headers.get('x-dharma-session-id'), timestamp: headers.get('x-dharma-timestamp') };
    assert.equal(verify(null, Buffer.from(JSON.stringify(payload)), createPublicKey({ key: {
      kty: 'OKP', crv: 'Ed25519', x: f.config.publicKeyEd25519 }, format: 'jwk' }),
      Buffer.from(headers.get('x-dharma-signature')!, 'base64url')), true);
    if (payload.sequence !== sequence) return Response.json({ ok: false,
      error: { code: 'demo_fabric_sequence_out_of_order', message: 'Sequence rejected.' } }, { status: 409 });
    sequence++;
    if (url.pathname.endsWith('/status')) {
      if (options.loseStatus && posts === 1 && !lostStatus) {
        lostStatus = true; throw new TypeError('Status response lost after proof recorded.');
      }
      options.afterStatus?.();
      return Response.json({ ok: true, organizationId: f.scope.organizationId, repositoryId, deviceId,
        normalizedRepository: f.scope.normalizedRepository, acceptedSequence: payload.sequence });
    }
    assert.equal(url.pathname, `/api/demo/fabric/repositories/${repositoryId}/signing-upgrade-sources`);
    assert.equal(headers.get('content-type'), 'application/json');
    posts++;
    const { proof } = JSON.parse(raw);
    proofs.push(proof);
    const duplicate = stored.has(proof.sourceHash); stored.add(proof.sourceHash);
    if (options.loseResponse && posts === 1) throw new TypeError('Response lost after write.');
    const receipt = { ok: true, organizationId: f.scope.organizationId, repositoryId, deviceId,
      sourceHash: proof.sourceHash, duplicate, correlationId: headers.get('x-dharma-correlation-id') };
    return options.receipt?.(receipt) ?? Response.json(receipt, { headers: {
      'x-dharma-correlation-id': String(receipt.correlationId) } });
  };
  return { fetcher, proofs, calls, stored };
}

test('submits only an existing client proof and validates signed transport and exact receipt', async t => {
  const f = await fixture(t), server = submissionServer(f), before = JSON.stringify([...f.values]);
  const result = await submitDemoSigningUpgradeProof(f.scope, f.context, { store: f.store, fetcher: server.fetcher });
  assert.equal(result.stage, 'client_proof_recorded');
  assert.equal(result.submitted, true);
  assert.equal(result.activated, false);
  assert.equal(result.duplicate, false);
  assert.equal(result.deviceId, deviceId);
  assert.equal(server.proofs.length, 1);
  assert.equal(JSON.stringify([...f.values]), before);
  assert.doesNotMatch(JSON.stringify(result), /privateKey|privateJwk|signature|grant|confirmed/);
  await assert.rejects(readFile(`${f.configPath}.pending-signing-upgrade.json`), { code: 'ENOENT' });
});

test('lost response retries the same immutable proof with sequence reconciliation and duplicate receipt', async t => {
  const f = await fixture(t), server = submissionServer(f, { loseResponse: true });
  await assert.rejects(submitDemoSigningUpgradeProof(f.scope, f.context, { store: f.store, fetcher: server.fetcher }), /Response lost/);
  const pending = await readFile(`${f.configPath}.pending-signing-upgrade.json`, 'utf8');
  t.mock.timers.setTime(now.getTime() + 30_000);
  const result = await submitDemoSigningUpgradeProof(f.scope, f.context, { store: f.store, fetcher: server.fetcher });
  assert.equal(result.duplicate, true); assert.equal(result.resumed, true);
  assert.deepEqual(server.proofs[0], server.proofs[1]); assert.equal(server.stored.size, 1);
  assert.doesNotMatch(pending, /privateKey|privateJwk|grant|authorization/);
});

test('a lost final status keeps the recorded proof recoverable across the next invocation', async t => {
  const f = await fixture(t), server = submissionServer(f, { loseStatus: true });
  await assert.rejects(submitDemoSigningUpgradeProof(f.scope, f.context, { store: f.store, fetcher: server.fetcher }), /Status response lost/);
  assert.ok(await readFile(`${f.configPath}.pending-signing-upgrade.json`, 'utf8'));
  const result = await submitDemoSigningUpgradeProof(f.scope, f.context, { store: f.store, fetcher: server.fetcher });
  assert.equal(result.duplicate, true); assert.equal(result.resumed, true);
  assert.deepEqual(server.proofs[0], server.proofs[1]); assert.equal(server.stored.size, 1);
});

for (const status of [401, 403, 409, 500]) test(`HTTP ${status} cannot acknowledge a proof or expose provider text`, async t => {
  let requestedCorrelation = '';
  const f = await fixture(t), server = submissionServer(f, { receipt: value => {
    requestedCorrelation = String(value.correlationId);
    return Response.json({ ok: false,
    error: { code: 'demo_signing_source_rejected', message: 'private-provider-error-content' } },
    { status, headers: { 'x-dharma-correlation-id': requestedCorrelation } });
  } });
  const before = JSON.stringify([...f.values]);
  await assert.rejects(submitDemoSigningUpgradeProof(f.scope, f.context, { store: f.store, fetcher: server.fetcher }), error => {
    assert.ok(error instanceof Error); assert.doesNotMatch(error.message, /private-provider-error-content/);
    const details = error as Error & { stage: string; code: string; status: number; correlationId: string };
    assert.equal(details.stage, 'client_proof_submission'); assert.equal(details.code, 'demo_signing_source_rejected');
    assert.equal(details.status, status); assert.equal(details.correlationId, requestedCorrelation);
    assert.ok(error.message.includes(requestedCorrelation)); return true;
  });
  assert.equal(JSON.stringify([...f.values]), before);
  assert.ok(await readFile(`${f.configPath}.pending-signing-upgrade.json`, 'utf8'));
});

for (const header of [null, 'malformed-private-value', otherClient])
  test('a missing or untrusted error correlation cannot attest a typed provider failure', async t => {
    let requestedCorrelation = '';
    const f = await fixture(t), server = submissionServer(f, { receipt: value => {
      requestedCorrelation = String(value.correlationId);
      return Response.json({ ok: false, error: { code: 'demo_signing_source_rejected',
        message: 'private-provider-error-content', correlationId: requestedCorrelation } },
      { status: 403, headers: header ? { 'x-dharma-correlation-id': header } : {} });
    } });
    await assert.rejects(submitDemoSigningUpgradeProof(f.scope, f.context, { store: f.store, fetcher: server.fetcher }), error => {
      assert.ok(error instanceof Error);
      const details = error as Error & { stage: string; code: string; status: number; correlationId: string };
      assert.equal(details.code, 'receipt_invalid'); assert.equal(details.correlationId, requestedCorrelation);
      assert.equal(details.stage, 'client_proof_submission'); assert.equal(details.status, 403);
      assert.doesNotMatch(error.message, /malformed-private-value|private-provider-error-content/);
      return true;
    });
    assert.ok(await readFile(`${f.configPath}.pending-signing-upgrade.json`, 'utf8'));
  });

for (const [label, mutate] of Object.entries({
  organization: (v: Record<string, unknown>) => { v.organizationId = 'org_foreign'; },
  repository: (v: Record<string, unknown>) => { v.repositoryId = otherClient; },
  device: (v: Record<string, unknown>) => { v.deviceId = otherClient; },
  source: (v: Record<string, unknown>) => { v.sourceHash = predecessorHash; },
  duplicate: (v: Record<string, unknown>) => { v.duplicate = 'yes'; },
  success: (v: Record<string, unknown>) => { v.ok = false; },
  correlation: (v: Record<string, unknown>) => { v.correlationId = otherClient; },
})) test(`does not acknowledge a mismatched ${label} receipt`, async t => {
  const f = await fixture(t), server = submissionServer(f, { receipt: value => {
    const correlation = String(value.correlationId); mutate(value);
    return Response.json(value, { headers: { 'x-dharma-correlation-id': correlation } });
  } });
  await assert.rejects(submitDemoSigningUpgradeProof(f.scope, f.context, { store: f.store, fetcher: server.fetcher }), /receipt/i);
  assert.ok(await readFile(`${f.configPath}.pending-signing-upgrade.json`, 'utf8'));
});

for (const [label, response] of [
  ['HTML', () => new Response('<html>private-error-content</html>', { headers: { 'content-type': 'text/html' } })],
  ['empty', () => Response.json({})],
  ['malformed', () => new Response('{', { headers: { 'content-type': 'application/json' } })],
  ['redirect', () => new Response('', { status: 302, headers: { location: 'https://foreign.example' } })],
  ['generic 404', () => Response.json({ error: 'missing' }, { status: 404 })],
  ['oversized', () => new Response(' '.repeat(8193), { headers: { 'content-type': 'application/json' } })],
] as const) test(`rejects ${label} without claiming submission success or exposing content`, async t => {
  const f = await fixture(t), server = submissionServer(f, { receipt: response });
  await assert.rejects(submitDemoSigningUpgradeProof(f.scope, f.context, { store: f.store, fetcher: server.fetcher }), error => {
    assert.ok(error instanceof Error); assert.doesNotMatch(error.message, /private-error-content/); return true;
  });
  assert.ok(await readFile(`${f.configPath}.pending-signing-upgrade.json`, 'utf8'));
});

test('tampered pending proof is preserved and cannot send a network request', async t => {
  const f = await fixture(t), server = submissionServer(f, { loseResponse: true });
  await assert.rejects(submitDemoSigningUpgradeProof(f.scope, f.context, { store: f.store, fetcher: server.fetcher }));
  const path = `${f.configPath}.pending-signing-upgrade.json`, pending = JSON.parse(await readFile(path, 'utf8'));
  pending.signature = 'A'.repeat(86); await writeFile(path, JSON.stringify(pending));
  const before = server.calls.length;
  await assert.rejects(submitDemoSigningUpgradeProof(f.scope, f.context, { store: f.store, fetcher: server.fetcher }), /pending|proof/i);
  assert.equal(server.calls.length, before); assert.equal((JSON.parse(await readFile(path, 'utf8'))).signature, pending.signature);
});

test('a changed context cannot silently replace an unresolved proof', async t => {
  const f = await fixture(t), server = submissionServer(f, { loseResponse: true });
  await assert.rejects(submitDemoSigningUpgradeProof(f.scope, f.context, { store: f.store, fetcher: server.fetcher }));
  const path = `${f.configPath}.pending-signing-upgrade.json`, before = await readFile(path, 'utf8'), calls = server.calls.length;
  await assert.rejects(submitDemoSigningUpgradeProof(f.scope, { ...f.context, candidateHash: predecessorHash.replace(/a/g, 'c') },
    { store: f.store, fetcher: server.fetcher }), /pending|proof/i);
  assert.equal(server.calls.length, calls); assert.equal(await readFile(path, 'utf8'), before);
});

test('expired or missing protected state blocks submission before networking', async t => {
  const f = await fixture(t), server = submissionServer(f), before = JSON.stringify([...f.values]);
  await assert.rejects(submitDemoSigningUpgradeProof(f.scope, { ...f.context, expiresAt: now.toISOString() },
    { store: f.store, fetcher: server.fetcher }));
  assert.equal(server.calls.length, 0); assert.equal(JSON.stringify([...f.values]), before);
  f.values.clear();
  await assert.rejects(submitDemoSigningUpgradeProof(f.scope, f.context, { store: f.store, fetcher: server.fetcher }));
  assert.equal(server.calls.length, 0); assert.equal(f.values.size, 0);
});

test('device removal during signed status cannot mint a replacement key or dispatch a proof', async t => {
  const f = await fixture(t), key = [...f.values].find(([, value]) => { try { return !!JSON.parse(value).d; } catch { return false; } })?.[0];
  assert.ok(key);
  let writes = 0;
  const store = { ...f.store, put: async () => { writes++; }, delete: async () => { writes++; } };
  const server = submissionServer(f, { afterStatus: () => { f.values.delete(key); } });
  await assert.rejects(submitDemoSigningUpgradeProof(f.scope, f.context, { store, fetcher: server.fetcher }));
  assert.equal(server.proofs.length, 0); assert.equal(writes, 0); assert.equal(f.values.has(key), false);
});

test('the anchor removed during the final envelope identity read is checked again before dispatch', async t => {
  const f = await fixture(t), anchor = [...f.values.keys()].find(key => /^demo-signing-[0-9a-f]{32}$/.test(key));
  const key = [...f.values].find(([, value]) => { try { return !!JSON.parse(value).d; } catch { return false; } })?.[0];
  assert.ok(anchor && key);
  let reads = 0, writes = 0;
  const store: SecureSecretStore = { ...f.store, getFresh: async account => {
    if (account === key && ++reads === 8) f.values.delete(anchor);
    return f.values.get(account) ?? null;
  }, put: async () => { writes++; }, delete: async () => { writes++; } };
  const server = submissionServer(f);
  await assert.rejects(submitDemoSigningUpgradeProof(f.scope, f.context, { store, fetcher: server.fetcher }));
  assert.equal(f.values.has(anchor), false); assert.equal(writes, 0); assert.equal(server.proofs.length, 0);
});

test('expired proof pending after a lost response remains preserved and does not retry', async t => {
  const f = await fixture(t), server = submissionServer(f, { loseResponse: true });
  await assert.rejects(submitDemoSigningUpgradeProof(f.scope, f.context, { store: f.store, fetcher: server.fetcher }));
  const path = `${f.configPath}.pending-signing-upgrade.json`, before = await readFile(path, 'utf8'), calls = server.calls.length;
  t.mock.timers.setTime(now.getTime() + 11 * 60_000);
  await assert.rejects(submitDemoSigningUpgradeProof(f.scope, f.context, { store: f.store, fetcher: server.fetcher }));
  assert.equal(server.calls.length, calls); assert.equal(await readFile(path, 'utf8'), before);
});
